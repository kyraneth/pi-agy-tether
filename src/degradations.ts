import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tetherHome } from "./data-dir.js";

export const GENERATION_CONTROLS_FACT = "ACP does not carry Pi's temperature, maxTokens, or toolChoice.";
export const RESULT_FRAMING_FACT = "agy adds Created At and Completed At timestamps to Pi tool results.";
export const TOOL_CATALOG_FACT = "agy cannot verify the exact Pi tool catalog; it can omit or rewrite Pi declarations and add native tools.";
export const EMPTY_CATALOG_FACT = "agy cannot verify an empty tool catalog; native tools may still be offered.";

export function transportLogPath(): string {
  return join(tetherHome(), "transport.log");
}

const loggedFacts = new Set<string>();

export function logTransportFact(message: string): void {
  const path = transportLogPath();
  const key = `${path}\0${message}`;
  if (loggedFacts.has(key)) return;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
    loggedFacts.add(key);
  } catch {
    // Diagnostics must neither block inference nor fall back to the screen.
  }
}

export function transportDoctor(): string {
  return [
    `Strict mode: ${strictTransport() ? "on" : "off"}.`,
    "When present, agy moves Pi's ‘running inside Pi’ line and <docs> text to the first user prompt to work around the gateway.",
    TOOL_CATALOG_FACT, EMPTY_CATALOG_FACT, GENERATION_CONTROLS_FACT, RESULT_FRAMING_FACT,
    "agy cannot verify intact tool-result delivery. Known clipping is reported with byte counts; Pi keeps full results.",
    `Route diagnostics (when writable): ${transportLogPath()}`,
  ].join("\n");
}

// Scope one-time notices to Pi's session, not the disposable ACP connection.
const seenBySession = new Map<string, Set<string>>();

export function strictTransport(): boolean {
  return process.env.PI_AGY_TETHER_STRICT === "1";
}

export function rememberTransportNotice(sessionId: string, key: string): boolean {
  const seen = seenBySession.get(sessionId) ?? new Set<string>();
  if (seen.has(key)) return false;
  seen.add(key);
  seenBySession.set(sessionId, seen);
  return true;
}

export function transportNotice(
  sessionId: string | undefined,
  notify: ((message: string) => void) | undefined,
  message: string,
  once?: string,
): void {
  if (once && sessionId && !rememberTransportNotice(sessionId, once)) return;
  if (notify) notify(message);
  else console.warn(`[pi-agy-tether] ${message}`);
}

// Measured with single-text MCP read results on agy 1.5.12 and 1.5.16:
// 30,035 raw bytes were clipped on both; on 1.5.16, 10,162 raw + 78
// timestamp bytes fit, but 10,163 + 78 were clipped. The visible excerpt
// can be slightly smaller than the cap (e.g. 10,239 B).
const RENDERED_TEXT_LIMIT_BYTES = 10_240;
const OBSERVED_TIMESTAMP_BYTES = 78;
const measuredBuilds = new Set(["1.5.12", "1.5.16"]);
const formatBytes = new Intl.NumberFormat("en-US").format;

export type ResultLossNotice = { message: string; surface: "log" | "screen" };
export const RESULT_NOTICE_ENTRY = "pi-agy-tether:result-notice";

export function* resultLossNotices(
  version: string,
  tool: string,
  result: { content: ({ type: "text"; text: string } | { type: "image" })[]; isError?: boolean },
): Iterable<ResultLossNotice> {
  const causes: string[] = [];
  if (!measuredBuilds.has(version)) causes.push("unmeasured agy version");
  if (result.isError) causes.push("error result");
  if (result.content.some(block => block.type === "image")) causes.push("image result");
  else if (result.content.length !== 1) causes.push("non-single-text result");
  if (causes.length) {
    for (const cause of causes) {
      yield {
        surface: "log",
        message: `agy cannot verify intact delivery of ${tool} (${cause}); Pi kept the full result.`,
      };
    }
    return;
  }
  const block = result.content[0];
  if (block?.type !== "text") return;
  const bytes = Buffer.byteLength(block.text, "utf8");
  if (bytes + OBSERVED_TIMESTAMP_BYTES > RENDERED_TEXT_LIMIT_BYTES) {
    yield { surface: "screen", message: `agy clipped ${tool} from ${formatBytes(bytes)} to a ${formatBytes(RENDERED_TEXT_LIMIT_BYTES)}-byte limit; Pi kept the full result.` };
  }
}
