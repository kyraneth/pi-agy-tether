import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ChildProcess } from "node:child_process";

// See docs/restart-cache.md: 8 GiB scope below the smallest incident's RSS,
// less the measured peak of an entire isolated full-tool run (443,527,168 B).
const normalScopePeakKiB = Math.ceil(443_527_168 / 1024);
const rssLimitKiB = 8 * 1024 * 1024 - normalScopePeakKiB;
// Same sampling resolution as the live RSS curve, not a claim to catch any spike.
const sampleMs = 100;
const procNumber = (text: string | undefined, key: string) => {
  const value = text?.match(new RegExp(`^${key}:?\\s+(\\d+)\\b`, "m"))?.[1];
  return value === undefined ? undefined : Number(value);
};

function read(path: string): string | undefined {
  try { return readFileSync(path, "utf8"); }
  catch { return undefined; }
}

export function memoryGuardDetail(rssKiB: number, availableKiB: number | undefined): string | undefined {
  if (rssKiB >= rssLimitKiB)
    return `RSS ${rssKiB.toLocaleString("en-US")} KiB reached its ${rssLimitKiB.toLocaleString("en-US")} KiB guard`;
  if (availableKiB !== undefined && availableKiB <= normalScopePeakKiB)
    return `only ${availableKiB.toLocaleString("en-US")} KiB of host memory available (child RSS ${rssKiB.toLocaleString("en-US")} KiB)`;
}

export function killDetail(signal: NodeJS.Signals, rssKiB?: number, oomCounterIncreased = false): string {
  const rss = rssKiB === undefined ? "unavailable" : `${rssKiB.toLocaleString("en-US")} KiB`;
  const oom = signal === "SIGKILL" && oomCounterIncreased ? "; likely out of memory (cgroup OOM-kill counter increased)" : "";
  return `agy was killed (signal ${signal}; last observed RSS ${rss}${oom})`;
}

/** Linux-only, for this exact child. No sampler, read or retry survives exit. */
export function watchAgyMemory(proc: ChildProcess, guarded: (reason: string) => void) {
  const pid = process.platform === "linux" ? proc.pid : undefined;
  const status = pid ? `/proc/${pid}/status` : undefined;
  let lastRss = status ? procNumber(read(status), "VmRSS") : undefined;
  const group = pid && read(`/proc/${pid}/cgroup`)?.match(/^0::(\/[^\n]+)$/m)?.[1];
  // Use the local variant of the kernel's memory.events file, not descendant counters.
  const eventFile = "memory.events";
  const events = group ? resolve(`/sys/fs/cgroup${group}`, `${eventFile}.local`) : undefined;
  const oomBefore = events && procNumber(read(events), "oom_kill");
  let oomObserved = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  proc.once("exit", (_code, signal) => {
    stop();
    if (signal === "SIGKILL" && events && typeof oomBefore === "number") {
      const after = procNumber(read(events), "oom_kill");
      oomObserved = after !== undefined && after > oomBefore;
    }
  });
  proc.once("close", stop); // includes a failed spawn (no exit event)
  if (status) {
    timer = setInterval(() => {
      const rss = procNumber(read(status), "VmRSS");
      if (rss === undefined) return;
      lastRss = rss;
      const reason = memoryGuardDetail(rss, procNumber(read("/proc/meminfo"), "MemAvailable"));
      if (reason) { stop(); guarded(reason); }
    }, sampleMs);
    timer.unref();
  }
  return { describeKill: (signal: NodeJS.Signals) => killDetail(signal, lastRss, oomObserved) };
}
