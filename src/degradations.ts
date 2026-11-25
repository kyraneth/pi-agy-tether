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

export type ResultLossNotice = { message: string; once?: string };
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
        once: `result-unverified:${cause}`,
        message: `agy cannot verify intact delivery of ${tool} (${cause}); Pi kept the full result.`,
      };
    }
    return;
  }
  const block = result.content[0];
  if (block?.type !== "text") return;
  const bytes = Buffer.byteLength(block.text, "utf8");
  if (bytes + OBSERVED_TIMESTAMP_BYTES > RENDERED_TEXT_LIMIT_BYTES) {
    yield { message: `agy clipped ${tool} from ${formatBytes(bytes)} to a ${formatBytes(RENDERED_TEXT_LIMIT_BYTES)}-byte limit; Pi kept the full result.` };
  }
}
