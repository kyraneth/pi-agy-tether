import { projectionHash } from "pi-tether-core/request";

export { piContext } from "pi-tether-core/pi-context";

/** One ACP prompt content block. ACP defines text and image parts. */
export type PromptBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** Fingerprint exactly the import projection, not Pi-only representations. */
export function historyHash(messages: any[]): string {
  return projectionHash(replayPiMessages(messages));
}

/**
 * Import in order, including every image and tool result. Never replay
 * thinking: Pi owns history and a vendor signature cannot be reconstructed.
 *
 * This is the text agy receives for a fresh session. A parked session only
 * receives the delta after its acknowledged prefix.
 */
export function replayPiMessages(messages: any[]): PromptBlock[] {
  const blocks: PromptBlock[] = [];
  for (const message of messages) {
    blocks.push({
      type: "text",
      text:
        message.role === "toolResult"
          ? `TOOL RESULT (${message.toolName}, id=${message.toolCallId}, error=${!!message.isError}):`
          : `${message.role.toUpperCase()}:`,
    });
    const content =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : (message.content ?? []);
    for (const b of content) {
      if (b.type === "text") blocks.push({ type: "text", text: b.text });
      else if (b.type === "image" && typeof b.data === "string" && typeof b.mimeType === "string")
        blocks.push({ type: "image", data: b.data, mimeType: b.mimeType });
      else if (b.type === "toolCall")
        blocks.push({
          type: "text",
          text: `TOOL CALL ${b.name} id=${b.id}: ${JSON.stringify(b.arguments)}`,
        });
      else if (b.type === "thinking") continue;
    }
  }
  return blocks;
}
