import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { forceKillProcess, killAllProcesses, registerProcess } from "../src/process-manager.js";

it("escalates an abort whose SIGTERM was sent but did not stop the process", () => {
  vi.useFakeTimers();
  try {
    const kill = vi.fn();
    const proc = { killed: true, exitCode: null, signalCode: null, kill } as unknown as ChildProcess;
    forceKillProcess(proc);
    forceKillProcess(proc);
    vi.runAllTimers();
    expect(kill.mock.calls).toEqual([["SIGKILL"]]);
  } finally { vi.useRealTimers(); }
});

it("waits for vendor shutdown before allowing runtime cleanup", async () => {
  const child = spawn(process.execPath, ["-e", `
    process.on("SIGTERM", () => process.exit(0));
    process.stdin.resume();
    console.log("ready");
  `]);
  const exited = once(child, "exit");
  try {
    await once(child.stdout, "data");
    registerProcess(child);
    await killAllProcesses();
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  } finally {
    await exited;
  }
});
