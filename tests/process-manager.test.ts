import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";
import { killAllProcesses, registerProcess } from "../src/process-manager.js";

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
