/**
 * On-disk identity for this package. The tether never touches the official
 * client's own `~/.gemini` tree: it keeps its own gemini home and links the
 * existing login into it (src/login.ts).
 */

import { homedir } from "node:os";
import { join } from "node:path";

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
  return join(tetherHome(), "gemini");
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

/** Per-ACP-session staging (tool schema, log, MCP wiring). */
export function sessionDir(sessionId: string): string {
  return join(tetherHome(), "sessions", sessionId);
}

/** The offered-model cache written from agy's own `session/new` answer. */
export function catalogCachePath(): string {
  return join(tetherHome(), "models.json");
}

/** The existing official login, exactly as agy installed it. Never read/copied. */
export function hostLoginPath(): string {
  return join(homedir(), ".gemini", APP_DATA_NAME, "antigravity-oauth-token");
}

/** Where the private gemini home links the official login. */
export function loginLinkPath(): string {
  return join(appDataDir(), "antigravity-oauth-token");
}
