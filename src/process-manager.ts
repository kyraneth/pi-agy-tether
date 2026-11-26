/**
 * Spawning and guarding the official `agy acp` process.
 *
 * The tether never launches the user's production configuration: it always
 * passes a private `--gemini-dir`, its own `--app-data-dir` leaf, a private
 * log file and auto-update off. The only thing shared with the official client
 * is the login (src/login.ts).
 */

import spawn from "cross-spawn";
import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { APP_DATA_NAME, appDataDir, geminiDir, sessionDir } from "./data-dir.js";

/** Executable override for tests and the isolated proof. */
export const CLI_ENV = "PI_AGY_TETHER_CLI";

export function cliPathKey(env: NodeJS.ProcessEnv): string {
  if (process.platform !== "win32") return "PATH";
  return (
    Object.keys(env)
      .reverse()
      .find((key) => key.toUpperCase() === "PATH") ?? "Path"
  );
}

/** Resolve the executable the child receives, without running it. */
export function resolveCli(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[CLI_ENV];
  if (override) {
    accessSync(override, constants.X_OK);
    return realpathSync(override);
  }
  const windows = process.platform === "win32";
  const extensions = windows
    ? (env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  const directories = [
    ...(windows ? [process.cwd()] : []),
    ...(env[cliPathKey(env)] ?? "").split(windows ? ";" : delimiter),
  ];
  for (const extension of extensions) {
    for (const rawDirectory of directories) {
      const directory = /^".*"$/.test(rawDirectory)
        ? rawDirectory.slice(1, -1)
        : rawDirectory;
      const candidate = join(directory, `agy${extension}`);
      try {
        if (!windows) accessSync(candidate, constants.X_OK);
        if (statSync(candidate).isFile()) return realpathSync(candidate);
      } catch {
        // Missing, non-executable or inaccessible: try the next PATH entry.
      }
    }
  }
  throw new Error(
    `agy CLI not found on PATH. Install Google's Antigravity CLI or set ${CLI_ENV}.`,
  );
}

/** Startup validation: fail loudly at load time, not on the first turn. */
export function validateCliPresence(): string {
  return resolveCli();
}

/**
 * The child environment. API-key routes are removed so the tether runs on the
 * linked subscription login it was asked to use, and agy's own updater stays
 * off (the tether never updates the official client behind the user's back).
 */
export function cliEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  delete next.GEMINI_API_KEY;
  delete next.GOOGLE_API_KEY;
  next.AGY_CLI_DISABLE_AUTO_UPDATE = "1";
  return next;
}

/**
 * The private app-data config agy reads. `toolPermission: strict` is what makes
 * agy ask before a Pi tool call runs, so the tether can answer that request
 * instead of the model executing it unobserved. Other keys agy wrote are kept.
 */
export function preparePrivateConfig(): string {
  const dir = appDataDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const settingsPath = join(dir, "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      settings = parsed as Record<string, unknown>;
  } catch {
    settings = {};
  }
  if (settings.toolPermission !== "strict") {
    settings.toolPermission = "strict";
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, {
      mode: 0o600,
    });
  }
  return settingsPath;
}

export interface SpawnInput {
  cwd: string;
  agentName: string;
  sessionId: string;
  /** Absolute path agy writes its own diagnostics to. */
  logFile: string;
  signal?: AbortSignal;
}

export function spawnAgy(input: SpawnInput): ChildProcess {
  const bin = resolveCli();
  mkdirSync(sessionDir(input.sessionId), { recursive: true, mode: 0o700 });
  const args = [
    ...acpArgs(),
    "--log-file",
    input.logFile,
    "--agent",
    input.agentName,
    "--include-default-customizations=false",
  ];
  const proc = spawn(bin, args, {
    cwd: input.cwd,
    env: cliEnvironment(),
    stdio: ["pipe", "pipe", "pipe"],
    signal: input.signal,
  });
  // The child keeps its own diagnostics; the tether only scans the log.
  void chmodSync;
  return proc;
}

/** The private-home part of every `agy acp` invocation. */
function acpArgs(): string[] {
  return ["acp", "--app-data-dir", APP_DATA_NAME, "--gemini-dir", geminiDir()];
}

/**
 * Handshake-only process: the same private home and environment, no agent, no
 * session. Used to ask the build what it advertises before Pi registers models
 * (src/prompt-capabilities.ts).
 */
export function spawnAcpProbe(): ChildProcess {
  return spawn(resolveCli(), acpArgs(), {
    env: cliEnvironment(),
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** Bounded stderr capture for error messages; never returned as model output. */
export function captureStderr(proc: ChildProcess): () => string {
  let buffer = "";
  proc.stderr?.setEncoding("utf8");
  proc.stderr?.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 16_384) buffer = buffer.slice(-16_384);
  });
  return () => buffer.trim();
}

const stopping = new WeakSet<ChildProcess>();

export function forceKillProcess(proc: ChildProcess | undefined): void {
  if (!proc || proc.exitCode !== null || proc.signalCode || stopping.has(proc)) return;
  stopping.add(proc);
  // `killed` means a signal was sent (including by spawn's AbortSignal),
  // not that agy exited. The existing escalation still has to be armed.
  if (!proc.killed) {
    try {
      proc.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  const timer = setTimeout(() => {
    if (proc.exitCode !== null || proc.signalCode) return;
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }, 2_000);
  timer.unref?.();
}

const liveProcesses = new Set<ChildProcess>();
export function registerProcess(proc: ChildProcess): void {
  liveProcesses.add(proc);
  proc.once("exit", () => liveProcesses.delete(proc));
}
export async function stopProcess(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode) return;
  // Observe exit before spawning a replacement or removing the runtime dir.
  const exited = proc.pid ? new Promise<void>(resolve => proc.once("exit", () => resolve())) : undefined;
  forceKillProcess(proc);
  await exited;
}

export async function killAllProcesses(): Promise<void> {
  await Promise.all([...liveProcesses].map(stopProcess));
}
