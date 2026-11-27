/**
 * On-disk identity for this package. The tether never touches the official
 * client's own `~/.gemini` tree: it keeps its own gemini home and links the
 * existing login into it (src/login.ts).
 *
 * Ephemeral state lives in the process's private runtime directory, which is
 * created on first use and removed on exit. The data home holds only
 * read-tolerant optional caches (the catalog and the agent proof); failing to
 * write them must never fail a turn.
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { existingRuntimeDir, runtimeDir } from "./runtime-dir.js";

/** Root of everything this package owns. Tests and proofs override it. */
export const HOME_ENV = "PI_AGY_TETHER_HOME";

export function tetherHome(): string {
  const override = process.env[HOME_ENV];
  if (override) return override;
  return join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "pi-agy-tether",
  );
}

/** The value agy's `--gemini-dir` receives: a private replacement for ~/.gemini. */
export function geminiDir(): string {
  return join(runtimeDir(), "gemini");
}

/**
 * agy's per-app data leaf. The official client uses `antigravity-cli` under the
 * gemini home; keeping the same leaf preserves the layout agy expects
 * (`<gemini-dir>/<app-data-dir>/settings.json` and the oauth token beside it).
 */
export const APP_DATA_NAME = "antigravity-cli";

export function appDataDir(): string {
  return join(geminiDir(), APP_DATA_NAME);
}

/** Reduce an id to characters that cannot escape or confuse a path. */
function safeFileSegment(value: string): string {
  const segment = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "session";
  return segment === "." || segment === ".." ? "session" : segment;
}

/** Per-ACP-session staging (tool schema, log) in the private runtime directory. */
export function sessionDir(sessionId: string): string {
  return join(runtimeDir(), "sessions", safeFileSegment(sessionId));
}

/** agy crawls its workspace even with only explicit tools. Pi owns user-file access. */
export function privateWorkspace(sessionId: string): string {
  const path = join(sessionDir(sessionId), "workspace");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

/** Existing per-session staging path without allocating a new runtime directory. */
export function existingSessionDir(sessionId: string): string | undefined {
  const base = existingRuntimeDir();
  return base ? join(base, "sessions", safeFileSegment(sessionId)) : undefined;
}

/** The offered-model cache written from agy's own `session/new` answer. */
export function catalogCachePath(): string {
  return join(tetherHome(), "models.json");
}

/** The cached proof for one agy version, recipe format, and family. Read-tolerant; writes are best-effort. */
export function agentProofPath(key: string): string {
  return join(tetherHome(), `agent-proof-${key}`);
}

/** The existing official login, exactly as agy installed it. Never read/copied. */
export function hostLoginPath(): string {
  return join(homedir(), ".gemini", APP_DATA_NAME, "antigravity-oauth-token");
}

/** Where the private gemini home links the official login. */
export function loginLinkPath(): string {
  return join(appDataDir(), "antigravity-oauth-token");
}
