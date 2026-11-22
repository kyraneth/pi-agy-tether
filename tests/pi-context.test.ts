import { describe, expect, it } from "vitest";
import { historyHash, replayPiMessages } from "../src/pi-context.js";

describe("replayPiMessages", () => {
  it("imports roles, text and tool calls in order", () => {
    const blocks = replayPiMessages([
      { role: "user", content: "Read seed.txt" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Reading it." },
          { type: "toolCall", id: "call-1", name: "read", arguments: { path: "seed.txt" } },
        ],
      },
      { role: "toolResult", toolName: "read", toolCallId: "call-1", content: [{ type: "text", text: "seed=42" }] },
    ]);
    expect(blocks.map((b) => (b as any).text)).toEqual([
      "USER:",
      "Read seed.txt",
      "ASSISTANT:",
      "Reading it.",
      'TOOL CALL read id=call-1: {"path":"seed.txt"}',
      "TOOL RESULT (read, id=call-1, error=false):",
      "seed=42",
    ]);
  });

  it("imports images because the session may already contain them", () => {
    const blocks = replayPiMessages([
      { role: "user", content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] },
    ]);
    expect(blocks[1]).toEqual({ type: "image", data: "AAAA", mimeType: "image/png" });
  });

  it("never replays thinking", () => {
    const blocks = replayPiMessages([
      { role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "ok" }] },
    ]);
    expect(blocks.some((b) => b.type === "text" && b.text.includes("private"))).toBe(false);
  });
});

describe("historyHash", () => {
  it("is stable for the same projection", () => {
    const messages = [{ role: "user", content: "hi" }];
    expect(historyHash(messages)).toBe(historyHash([{ role: "user", content: "hi" }]));
  });

  it("changes when the projection changes", () => {
    expect(historyHash([{ role: "user", content: "hi" }])).not.toBe(
      historyHash([{ role: "user", content: "hi there" }]),
    );
  });
});
