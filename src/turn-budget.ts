import { replayPiMessages, type PromptBlock } from "./pi-context.js";

// agy 1.5.12 and 1.5.16 both truncated assembled input after 192,000 bytes.
const OBSERVED_VERSION = "1.5.12";
const OBSERVED_BYTES = 192_000;
export const KNOWN_TURN_INPUT_LIMITS: ReadonlyMap<string, number | null> = new Map([
  [OBSERVED_VERSION, OBSERVED_BYTES],
  ["1.5.16", 192_000],
]);

export function turnInputLimitFor(version: string, limits = KNOWN_TURN_INPUT_LIMITS) {
  const bytes = limits.get(version);
  return bytes === null ? null : {
    bytes: bytes ?? OBSERVED_BYTES,
    observedVersion: bytes === undefined ? OBSERVED_VERSION : version,
  };
}

export interface TurnAssembly {
  appDataDirPath: string;
  prefaceText?: string;
  settingsChange?: { fromLabel: string; toLabel: string };
}

const bytes = (s: string) => Buffer.byteLength(s, "utf8");
const text = (text: string): PromptBlock => ({ type: "text", text });

export function measureTurn(blocks: readonly PromptBlock[], assembly: TurnAssembly) {
  let textBytes = 0;
  let imageLines = 0;
  let images = 0;
  for (const block of blocks) {
    // ACP text is concatenated without separators. Counting before agy's ANSI
    // stripping is conservative; the actual attachment binaries never count.
    if (block.type === "text") textBytes += bytes(block.text);
    else {
      images++;
      const ext = block.mimeType.split("/")[1]?.split(";")[0].trim() || "png";
      imageLines += bytes(assembly.appDataDirPath) + 91 + bytes(ext);
    }
  }
  // <USER_REQUEST>, <ADDITIONAL_METADATA> and timestamp; then optional
  // upload notice (header, count, path lines, footer) and settings notice.
  let framingBytes = 130 + bytes(assembly.prefaceText ?? "");
  if (images) framingBytes += 35 + String(images).length + imageLines + 74;
  if (assembly.settingsChange)
    framingBytes += 264 + bytes(assembly.settingsChange.fromLabel) + bytes(assembly.settingsChange.toLabel);
  return { totalBytes: textBytes + framingBytes, textBytes, framingBytes };
}

export class TurnLimitError extends Error {}

function assertFits(measured: ReturnType<typeof measureTurn>, limit: NonNullable<ReturnType<typeof turnInputLimitFor>>, version: string, reason?: string) {
  if (measured.totalBytes <= limit.bytes) return;
  const n = (value: number) => value.toLocaleString("en-US");
  const running = version === limit.observedVersion ? "" : `; running agy ${version}`;
  // Not a context-window overflow: asking Pi to auto-compact can loop here.
  throw new TurnLimitError(
    `pi-agy-tether refused to send a ${n(measured.totalBytes)}-byte turn ` +
    `(${n(measured.textBytes)} B prompt + ${n(measured.framingBytes)} B framing): ` +
    `agy truncates single-turn assembled input at ${n(limit.bytes)} bytes ` +
    `(observed in agy ${limit.observedVersion}${running})${reason ? ` (${reason})` : ""}.`,
  );
}

export function assertWithinTurnLimit(blocks: PromptBlock[], assembly: TurnAssembly, version: string) {
  const limit = turnInputLimitFor(version);
  if (limit) assertFits(measureTurn(blocks, assembly), limit, version);
}

function framed(blocks: PromptBlock[], index: number, total: number): PromptBlock[] {
  if (index === total) return [text(`[Pi tether context part ${total}/${total} (final). Combine all ${total} parts above in order and now follow the instructions below.]\n`), ...blocks];
  return [
    text(`[Pi tether context part ${index}/${total}. More context follows before the final request. Do not summarize, answer, or call tools yet; reply with only OK.]\n`),
    ...blocks,
    text(`\n[End of context part ${index}/${total}. Reply with only OK.]`),
  ];
}

/** Index where the verbatim instructions begin, if this is a Pi summary request. */
function instructionsAt(prompt: string): number | undefined {
  const xmlEnd = "\n</conversation>\n\n";
  const mdEnd = "\n\n# Instructions\n";
  if (prompt.startsWith("<conversation>\n")) {
    const end = prompt.lastIndexOf(xmlEnd);
    if (end < 0) return;
    const tail = end + xmlEnd.length;
    if (!prompt.startsWith("<previous-summary>\n", tail)) return tail;
    const summaryEnd = "\n</previous-summary>\n\n";
    const split = prompt.lastIndexOf(summaryEnd);
    if (split >= tail) return split + summaryEnd.length;
  } else if (prompt.startsWith("# Conversation\n")) {
    const end = prompt.lastIndexOf(mdEnd);
    if (end >= 0) return end + mdEnd.length;
  }
}

/** Take the largest useful slice, preferring serialized entries to lines to codepoints. */
function cutPrefix(prefix: string, budget: number): number {
  let end = 0, used = 0;
  for (const cp of prefix) {
    used += bytes(cp);
    if (used > budget) break;
    end += cp.length;
  }
  if (end === prefix.length || end === 0) return end;
  // Match against the full remainder so a boundary exactly at `end` counts.
  let boundary = 0;
  for (const match of prefix.matchAll(/\n\n(?=\[(?:User|Assistant|Assistant tool calls|Tool result)\]: )/g)) {
    if (match.index + 2 > end) break;
    boundary = match.index + 2;
  }
  if (boundary) return boundary;
  const candidate = prefix.slice(0, end);
  const paragraph = candidate.lastIndexOf("\n\n");
  return paragraph >= 0 ? paragraph + 2 : candidate.lastIndexOf("\n") + 1 || end;
}

export interface TurnPlan {
  stagedTurns: PromptBlock[][];
  finalTurn: PromptBlock[];
}

export function planTurns({ messages, toolCount, agentVersion, first, later }: {
  messages: any[];
  toolCount: number;
  agentVersion: string;
  first: TurnAssembly;
  later: TurnAssembly;
}): TurnPlan {
  const all = replayPiMessages(messages);
  const limit = turnInputLimitFor(agentVersion);
  const single = measureTurn(all, first);
  if (!limit || single.totalBytes <= limit.bytes) return { stagedTurns: [], finalTurn: all };
  const check = (blocks: PromptBlock[], assembly: TurnAssembly, reason: string) =>
    assertFits(measureTurn(blocks, assembly), limit, agentVersion, reason);
  const fits = (b: PromptBlock[], assembly: TurnAssembly) => measureTurn(b, assembly).totalBytes <= limit.bytes;

  const summary = toolCount === 0 && messages.length === 1 && messages[0].role === "user" && all.length === 2 && all[1].type === "text"
    ? all[1].text : undefined;
  const split = summary === undefined ? undefined : instructionsAt(summary);
  if (summary !== undefined && split !== undefined) {
    const prefix = "USER:" + summary.slice(0, split);
    const finalInstructions = text(summary.slice(split));
    for (let total = 2; ; total++) {
      check(framed([finalInstructions], total, total), later, "compaction instructions alone exceed one turn");
      const stagedTurns: PromptBlock[][] = [];
      let remaining = prefix;
      for (let index = 1; index < total; index++) {
        const assembly = index === 1 ? first : later;
        const room = limit.bytes - measureTurn(framed([], index, total), assembly).totalBytes;
        const cut = cutPrefix(remaining, room);
        if (!cut) {
          check(framed([text([...remaining][0] ?? "")], index, total), assembly, "no room for compaction context");
          break;
        }
        stagedTurns.push(framed([text(remaining.slice(0, cut))], index, total));
        remaining = remaining.slice(cut);
        const final = framed([text(remaining), finalInstructions], total, total);
        if (index === total - 1 && fits(final, later)) return { stagedTurns, finalTurn: final };
      }
    }
  }

  if (messages.length <= 1) assertFits(single, limit, agentVersion, "a single message cannot be split across turns");
  const groups = messages.map(m => replayPiMessages([m]));
  const last = groups.length - 1;
  for (let total = 2; ; total++) {
    const stagedTurns: PromptBlock[][] = [];
    let offset = 0;
    for (let index = 1; index < total && offset < last; index++) {
      const assembly = index === 1 ? first : later;
      const frame = (blocks: PromptBlock[]) => framed(blocks, index, total);
      const reason = `message ${offset + 1}/${groups.length} alone exceeds one turn`;
      check(frame(groups[offset]), assembly, reason);
      const chunk = [...groups[offset++]];
      while (offset < last && fits(frame([...chunk, ...groups[offset]]), assembly))
        chunk.push(...groups[offset++]);
      stagedTurns.push(frame(chunk));
      const final = framed(groups.slice(offset).flat(), total, total);
      if (index === total - 1 && fits(final, later)) return { stagedTurns, finalTurn: final };
    }
    check(framed(groups[last], total, total), later, `message ${last + 1}/${groups.length} alone exceeds one turn`);
  }
}
