import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APP_DATA_NAME,
  HOME_ENV,
  appDataDir,
  geminiDir,
  hostLoginPath,
  loginLinkPath,
  sessionDir,
  tetherHome,
} from "../src/data-dir.js";

describe("tether home", () => {
  it("honours the override", () => {
    expect(tetherHome()).toBe(process.env[HOME_ENV]);
  });

  it("falls back to the XDG data home", () => {
    const saved = process.env[HOME_ENV];
    const dataHome = mkdtempSync(join(tmpdir(), "pat-xdg-"));
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

  it("keeps a private gemini home instead of the official one", () => {
    expect(geminiDir()).toBe(join(tetherHome(), "gemini"));
    expect(appDataDir()).toBe(join(tetherHome(), "gemini", APP_DATA_NAME));
  });

  it("stages each session under the tether home", () => {
    expect(sessionDir("sess-1")).toBe(join(tetherHome(), "sessions", "sess-1"));
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
