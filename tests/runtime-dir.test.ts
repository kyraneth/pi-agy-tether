import { describe, expect, it } from "vitest";
import { existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { RUNTIME_FILE_MODE, cleanupRuntimeDir, runtimeDir, runtimeFile } from "../src/runtime-dir.js";

describe("runtime directory", () => {
  it("is private and owned by this process", () => {
    const dir = runtimeDir();
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(() => statSync(dir)).not.toThrow();
  });

  it("names files inside the private directory", () => {
    expect(dirname(runtimeFile("handoff.sock"))).toBe(runtimeDir());
  });

  it("cleans up", () => {
    const dir = runtimeDir();
    cleanupRuntimeDir();
    expect(existsSync(dir)).toBe(false);
  });

  it("uses a restrictive file mode for secrets", () => {
    expect(RUNTIME_FILE_MODE).toBe(0o600);
  });
});
