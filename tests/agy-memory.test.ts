import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { killDetail, memoryGuardDoctor, watchAgyMemory } from "../src/agy-memory.js";

vi.mock("node:fs", () => ({ readFileSync: vi.fn() }));

const env = "PI_AGY_TETHER_MEMORY_GUARD";
const group = "/sys/fs/cgroup/fixture/pi.scope";
const eventFile = "memory.events";
const events = `${group}/${eventFile}.local`;
const ample = "MemAvailable: 25718132 kB\n";
const low = "MemAvailable: 2371460 kB\n"; // measured guard reserve from docs/restart-cache.md
const status = "VmRSS: 8069016 kB\nRssAnon: 7952648 kB\nRssFile: 116368 kB\nRssShmem: 0 kB\n";

function fixture(available = ample) {
  const files = new Map([
    ["/proc/61/status", status], ["/proc/61/cgroup", "0::/fixture/pi.scope\n"],
    ["/proc/meminfo", available], [events, "oom_kill 9\n"],
  ]);
  vi.mocked(readFileSync).mockImplementation(path => {
    const body = files.get(String(path));
    if (body === undefined) throw new Error("missing in fixture");
    return body;
  });
  const proc = Object.assign(new EventEmitter(), { pid: 61 }) as unknown as ChildProcess;
  const guard = vi.fn();
  const { describeKill } = watchAgyMemory(proc, guard);
  const tick = () => vi.advanceTimersToNextTimer();
  return { files, proc, guard, tick, describeKill };
}

beforeEach(() => {
  vi.stubGlobal("process", Object.create(process, { platform: { value: "linux" } }));
  vi.stubEnv(env, undefined);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("leaves multi-GiB agy alone with host headroom", () => {
  const { guard, tick } = fixture();
  tick();
  expect(guard).not.toHaveBeenCalled();
});

it("retires once on low host MemAvailable even with a small agy", () => {
  const { files, guard, tick } = fixture();
  tick();
  expect(guard).not.toHaveBeenCalled();
  files.set("/proc/meminfo", low);
  files.set("/proc/61/status", status.replace("8069016", "251520").replace("7952648", "135152"));
  tick();
  expect(guard).toHaveBeenCalledOnce();
  expect(guard).toHaveBeenCalledWith(expect.stringMatching(/host memory.*RssAnon 135,152 KiB.*RssFile 116,368 KiB.*RssShmem 0 KiB/));
  expect(vi.getTimerCount()).toBe(0);
});

it("also acts on a finite ancestor memory.high with ample host memory", () => {
  const { files, guard, tick } = fixture();
  files.set(group + "/memory.max", "max\n");
  files.set("/sys/fs/cgroup/fixture/memory.high", "10485760\n");
  files.set("/sys/fs/cgroup/fixture/memory.current", "10485759\n");
  tick();
  expect(guard).not.toHaveBeenCalled();
  files.set("/sys/fs/cgroup/fixture/memory.current", "10485760\n");
  tick();
  expect(guard).toHaveBeenCalledWith(expect.stringMatching(/\/fixture usage.*memory\.high.*10485760/));
});

it("acts on a finite memory.max even without host telemetry", () => {
  const { files, guard, tick } = fixture();
  files.delete("/proc/meminfo");
  files.set(group + "/memory.max", "10485760\n");
  files.set(group + "/memory.current", "10485760\n");
  tick();
  expect(guard).toHaveBeenCalledWith(expect.stringMatching(/pi\.scope usage.*memory\.max.*10485760/));
});

it("off disables both retirement conditions, not RSS and OOM evidence", () => {
  vi.stubEnv(env, "off");
  const { files, proc, guard, tick, describeKill } = fixture(low);
  files.set(group + "/memory.max", "10485760\n");
  files.set(group + "/memory.current", "10485760\n");
  tick();
  expect(guard).not.toHaveBeenCalled();
  expect(describeKill("SIGKILL")).not.toMatch(/likely out of memory/);
  files.set(events, "oom_kill 10\n");
  proc.emit("exit", null, "SIGKILL");
  expect(describeKill("SIGKILL")).toMatch(/SIGKILL.*RssAnon 7,952,648 KiB.*likely out of memory/);
  expect(vi.getTimerCount()).toBe(0);
});

it("uses an explicit KiB reserve and explains invalid configuration", () => {
  vi.stubEnv(env, "42");
  expect(memoryGuardDoctor()).toMatch(/42 KiB.*operator override/);
  const { files, guard, tick } = fixture(low);
  tick();
  expect(guard).not.toHaveBeenCalled();
  files.set("/proc/meminfo", "MemAvailable: 42 kB\n");
  tick();
  expect(guard).toHaveBeenCalledOnce();
  vi.stubEnv(env, "9e8");
  expect(memoryGuardDoctor()).toMatch(/2,371,460 KiB.*invalid/);
});

it("reports signals without attributing OOM without the appropriate evidence", () => {
  expect(killDetail("SIGKILL")).toMatch(/SIGKILL.*RSS unavailable/);
  expect(killDetail("SIGKILL")).not.toMatch(/likely out of memory/);
  expect(killDetail("SIGTERM", undefined, true)).not.toMatch(/likely out of memory/);
});
