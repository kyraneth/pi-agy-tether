import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APP_DATA_NAME,
  HOME_ENV,
  agentProofPath,
  appDataDir,
  geminiDir,
  hostLoginPath,
  loginLinkPath,
  sessionDir,
  tetherHome,
} from "../src/data-dir.js";
import { cleanupRuntimeDir, resetRuntimeDirForTests, runtimeDir } from "../src/runtime-dir.js";

const tempDirs: string[] = [];

afterEach(() => {
  cleanupRuntimeDir();
  resetRuntimeDirForTests();
  for (const dir of tempDirs.splice(0)) {
    try {
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort test cleanup */
    }
  }
});

describe("tether home", () => {
  it("honours the override", () => {
    expect(tetherHome()).toBe(process.env[HOME_ENV]);
  });

  it("falls back to the XDG data home", () => {
    const saved = process.env[HOME_ENV];
    const dataHome = mkdtempSync(join(tmpdir(), "pat-xdg-"));
    tempDirs.push(dataHome);
    const savedData = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dataHome;
    delete process.env[HOME_ENV];
    try {
      expect(tetherHome()).toBe(join(dataHome, "pi-agy-tether"));
    } finally {
      process.env[HOME_ENV] = saved;
      process.env.XDG_DATA_HOME = savedData;
    }
  });

  it("keeps vendor state inside the private runtime directory", () => {
    expect(geminiDir()).toBe(join(runtimeDir(), "gemini"));
    expect(appDataDir()).toBe(join(runtimeDir(), "gemini", APP_DATA_NAME));
    expect(sessionDir("sess-1")).toBe(join(runtimeDir(), "sessions", "sess-1"));
    expect(geminiDir().startsWith(tetherHome())).toBe(false);
    expect(sessionDir("sess-1").startsWith(tetherHome())).toBe(false);
  });

  it("keeps the proof cache readable from a read-only home without moving session state back", () => {
    const roHome = mkdtempSync(join(tmpdir(), "pat-rohome-"));
    tempDirs.push(roHome);
    const key = "testkey";
    writeFileSync(join(roHome, `agent-proof-${key}`), "");
    chmodSync(roHome, 0o500);
    const saved = process.env[HOME_ENV];
    process.env[HOME_ENV] = roHome;
    try {
      expect(agentProofPath(key)).toBe(join(roHome, `agent-proof-${key}`));
      expect(sessionDir("sess-ro")).toBe(join(runtimeDir(), "sessions", "sess-ro"));
      expect(geminiDir()).toBe(join(runtimeDir(), "gemini"));
      expect(appDataDir()).toBe(join(runtimeDir(), "gemini", APP_DATA_NAME));
    } finally {
      process.env[HOME_ENV] = saved;
    }
  });

  it("names the unwritable runtime directory when no runtime location exists", () => {
    const roTmp = mkdtempSync(join(tmpdir(), "pat-notmp-"));
    tempDirs.push(roTmp);
    chmodSync(roTmp, 0o500);
    const savedTmp = process.env.TMPDIR;
    process.env.TMPDIR = roTmp;
    resetRuntimeDirForTests();
    try {
      expect(() => sessionDir("sess-none")).toThrow(roTmp);
      expect(() => geminiDir()).toThrow(roTmp);
    } finally {
      if (savedTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = savedTmp;
      resetRuntimeDirForTests();
    }
  });
});

describe("login paths", () => {
  it("links the official client's own token file", () => {
    expect(hostLoginPath()).toMatch(/\/\.gemini\/antigravity-cli\/antigravity-oauth-token$/);
    expect(loginLinkPath()).toBe(join(appDataDir(), "antigravity-oauth-token"));
    // The link must never point at the private tree it lives in.
    expect(loginLinkPath()).not.toBe(hostLoginPath());
  });
});
