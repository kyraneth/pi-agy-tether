import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ChildProcess } from "node:child_process";

const guardEnv = "PI_AGY_TETHER_MEMORY_GUARD";
// See docs/restart-cache.md: the incident reproduction's largest observed
// increase in anonymous RSS during one sample + the existing kill grace.
const measuredReserveKiB = 2_371_460;
const sampleMs = 100; // same cadence as the recorded RSS curve
const cgroupRoot = "/sys/fs/cgroup";

function unsignedInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
const procNumber = (text: string | undefined, key: string) =>
  unsignedInteger(text?.match(new RegExp(`^${key}:?[ \\t]+(\\d+)\\b`, "m"))?.[1]);

function read(path: string): string | undefined {
  try { return readFileSync(path, "utf8"); }
  catch { return undefined; }
}

function guardConfig(raw = process.env[guardEnv]) {
  if (raw === "off") return { reserve: undefined, source: `${guardEnv}=off` };
  const override = unsignedInteger(raw);
  if (override !== undefined) return { reserve: override, source: `operator override ${guardEnv}` };
  const source = "measured anonymous RSS growth during one 100 ms sample + the existing 2 s kill grace (see docs/restart-cache.md)";
  return { reserve: measuredReserveKiB, source: raw ? `${source}; invalid ${guardEnv} ignored` : source };
}

const format = (value: number | undefined) => value === undefined ? "unavailable" : `${value.toLocaleString("en-US")} KiB`;

export function memoryGuardDoctor(): string {
  if (process.platform !== "linux") return "Memory guard: unsupported (requires Linux /proc).";
  const { reserve, source } = guardConfig();
  if (reserve === undefined) return `Memory guard: off (${source}); RSS diagnostics remain on.`;
  return `Memory guard: Linux MemAvailable ≤ ${format(reserve)} (${source}), or usage reaches an effective cgroup v2 memory.high or memory.max (kernel settings). No child RSS cutoff. Set ${guardEnv}=off or an integer KiB host reserve.`;
}

interface Rss {
  total?: number;
  anon?: number;
  file?: number;
  shmem?: number;
}

function rssDetail(rss: Rss | undefined): string {
  return `last observed RSS ${format(rss?.total)} (RssAnon ${format(rss?.anon)}, RssFile ${format(rss?.file)}, RssShmem ${format(rss?.shmem)})`;
}

export function killDetail(signal: NodeJS.Signals, rss?: Rss, oomCounterIncreased = false): string {
  const oom = signal === "SIGKILL" && oomCounterIncreased ? "; likely out of memory (cgroup OOM-kill counter increased)" : "";
  return `agy was killed (signal ${signal}; ${rssDetail(rss)}${oom})`;
}

function cgroupAncestors(dir: string | undefined): string[] {
  const dirs = [];
  for (; dir?.startsWith(`${cgroupRoot}/`); dir = dirname(dir)) dirs.push(dir);
  return dirs;
}

function cgroupPressure(dirs: string[]): string | undefined {
  for (const dir of dirs) {
    const max = unsignedInteger(read(join(dir, "memory.max"))?.trim()); // "max" means unlimited
    const high = unsignedInteger(read(join(dir, "memory.high"))?.trim());
    if (max === undefined && high === undefined) continue;
    const current = unsignedInteger(read(join(dir, "memory.current"))?.trim());
    if (current === undefined) continue;
    for (const [key, limit] of [["memory.max", max], ["memory.high", high]] as const)
      if (limit !== undefined && current >= limit)
        return `cgroup ${dir} usage ${current} bytes reached its ${key} of ${limit} bytes`;
  }
}

/** Linux-only, for this exact child. No sampler, read or retry survives exit. */
export function watchAgyMemory(proc: ChildProcess, guarded: (reason: string) => void) {
  const pid = process.platform === "linux" ? proc.pid : undefined;
  const readStatus = () => pid ? read(`/proc/${pid}/status`) : undefined;
  const toRss = (status: string): Rss => ({
    total: procNumber(status, "VmRSS"), anon: procNumber(status, "RssAnon"),
    file: procNumber(status, "RssFile"), shmem: procNumber(status, "RssShmem"),
  });
  const initial = readStatus();
  let lastRss = initial ? toRss(initial) : undefined;
  const group = pid ? read(`/proc/${pid}/cgroup`)?.match(/^0::(\/[^\n]*)$/m)?.[1] : undefined;
  const dir = group === undefined ? undefined : join(cgroupRoot, group);
  const dirs = cgroupAncestors(dir);
  // Use the local variant, not descendant counters. This still cannot name the victim.
  const eventFile = "memory.events";
  const events = dir ? join(dir, `${eventFile}.local`) : undefined;
  const oomBefore = events ? procNumber(read(events), "oom_kill") : undefined;
  const { reserve } = guardConfig();
  let oomObserved = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  proc.once("exit", (_code, signal) => {
    stop();
    if (signal === "SIGKILL" && events && oomBefore !== undefined) {
      const after = procNumber(read(events), "oom_kill");
      oomObserved = after !== undefined && after > oomBefore;
    }
  });
  proc.once("close", stop); // includes a failed spawn (no exit event)
  if (pid) {
    timer = setInterval(() => {
      const status = readStatus();
      if (!status) return;
      const rss = toRss(status);
      if (rss.total !== undefined) lastRss = rss; // preserve the last sample if the child is a zombie
      if (reserve === undefined || rss.total === undefined) return;
      const available = procNumber(read("/proc/meminfo"), "MemAvailable");
      const reason = available !== undefined && available <= reserve
        ? `host memory available ${format(available)} reached the ${format(reserve)} reserve`
        : cgroupPressure(dirs);
      if (reason) { stop(); guarded(`${reason}; ${rssDetail(lastRss)}`); }
    }, sampleMs);
    timer.unref();
  }
  return { describeKill: (signal: NodeJS.Signals) => killDetail(signal, lastRss, oomObserved) };
}
