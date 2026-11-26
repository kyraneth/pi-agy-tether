export const NATIVE_SEARCH_NOTICE = "agy may search the web itself; Pi sees the searches but not their results.";
export const NATIVE_SEARCH_NOTICE_ENTRY = "pi-agy-tether:native-search-notice";
export const NATIVE_SEARCH_ENTRY = "pi-agy-tether:native-search";

export interface NativeSearchQuery {
  id: string;
  acpSessionId: string;
  query: string | null;
  domain?: string;
}

export interface NativeSearchSurface {
  announce(): void;
  record(query: NativeSearchQuery): void;
}

export function nativeSearchEnabled(): boolean {
  return process.env.PI_AGY_TETHER_NATIVE_SEARCH === "1";
}

function nativeSearchArgs(event: any): { query: string; domain?: string } | undefined {
  const input = event?.rawInput ?? event?.args;
  if (typeof input?.query !== "string" || !input.query.trim()) return;
  return { query: input.query, ...(typeof input.domain === "string" ? { domain: input.domain } : {}) };
}

export function allowSearchArgs(event: unknown): boolean {
  return nativeSearchArgs(event) !== undefined;
}

/** Correlate calls at the ACP connection, including across Pi MCP handoffs. Never expose raw output. */
export function watchNativeSearch(record: NativeSearchSurface["record"]) {
  const pending = new Set<string>();
  const seen = new Set<string>();
  return (event: any, acpSessionId: string): void => {
    if (event?.sessionUpdate !== "tool_call" && event?.sessionUpdate !== "tool_call_update") return;
    const id = event.toolCallId;
    if (typeof id !== "string" || !id || seen.has(id)) return;
    if (event.name !== "search_web" && !pending.has(id)) return;
    const args = nativeSearchArgs(event);
    if (!args && event.status !== "completed" && event.status !== "failed" && event.status !== "cancelled") {
      pending.add(id);
      return;
    }
    pending.delete(id);
    seen.add(id);
    record({ id, acpSessionId, ...(args ?? { query: null }) });
  };
}

export function nativeSearchLabel(entry: NativeSearchQuery): string {
  const printable = (text: string) => JSON.stringify(text).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const query = entry.query === null ? "(query not exposed by ACP)" : printable(entry.query);
  return `[agy native search] ${query}${entry.domain ? ` (domain: ${printable(entry.domain)})` : ""}`;
}
