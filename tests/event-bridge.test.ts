import { describe, expect, it } from "vitest";
import { acpUsage, createEventBridge, mapStopReason } from "../src/event-bridge.js";

const model = {
  id: "gemini-4-argon",
  provider: "pi-agy-tether",
  api: "pi-agy-tether",
} as any;

function fakeStream() {
  const events: any[] = [];
  return { events, push: (event: any) => events.push(event) };
}

describe("acpUsage", () => {
  it("removes the cached component from Pi's input count", () => {
    // ACP inputTokens already includes cache reads and writes.
    expect(
      acpUsage({ inputTokens: 1000, outputTokens: 50, cachedReadTokens: 800, cachedWriteTokens: 100 }),
    ).toMatchObject({ input: 100, output: 50, cacheRead: 800, cacheWrite: 100, totalTokens: 1050, present: true });
  });

  it.each([
    [4993, 4414, 5, 9412],
    [2139, 7358, 5, 9502],
    [4810, 3832, 108, 8750],
  ])("preserves uncached input %i when the measured agy terminal reports cache separately", (inputTokens, cachedReadTokens, outputTokens, totalTokens) => {
    expect(acpUsage({ inputTokens, cachedReadTokens, outputTokens, totalTokens })).toMatchObject({
      input: inputTokens, cacheRead: cachedReadTokens, totalTokens,
    });
  });

  it("counts thoughts as output and reports them as reasoning", () => {
    expect(acpUsage({ inputTokens: 10, outputTokens: 5, thoughtTokens: 7 })).toMatchObject({
      output: 12,
      reasoning: 7,
    });
  });

  it("never reports negative input", () => {
    expect(acpUsage({ inputTokens: 10, cachedReadTokens: 20 }).input).toBe(0);
  });

  it("marks absent usage as not present", () => {
    expect(acpUsage(undefined).present).toBe(false);
    expect(acpUsage({}).present).toBe(false);
  });
});

describe("mapStopReason", () => {
  it("maps agy's terminals to Pi's", () => {
    expect(mapStopReason("end_turn")).toBe("stop");
    expect(mapStopReason(undefined)).toBe("stop");
    expect(mapStopReason("max_tokens")).toBe("length");
    expect(mapStopReason("max_output_tokens")).toBe("length");
    expect(mapStopReason("cancelled")).toBe("aborted");
  });
});

describe("createEventBridge", () => {
  it("streams text blocks and ignores vendor transport updates", () => {
    const stream = fakeStream();
    const bridge = createEventBridge(stream as any, model);
    bridge.handleUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } });
    bridge.handleUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" } });
    // Tool/plan/command updates are agy's own surface, never Pi content.
    bridge.handleUpdate({ sessionUpdate: "tool_call", title: "run command" });
    bridge.handleUpdate({ sessionUpdate: "available_commands_update", availableCommands: [] });
    bridge.finalizeBlocks();

    const output = bridge.getOutput();
    expect(output.content).toEqual([{ type: "text", text: "Hello" }]);
    expect(stream.events.map((e) => e.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_delta",
      "text_end",
    ]);
  });

  it("keeps thinking and text blocks separate", () => {
    const bridge = createEventBridge(fakeStream() as any, model);
    bridge.handleUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "plan" } });
    bridge.handleUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } });
    bridge.finalizeBlocks();
    expect(bridge.getOutput().content).toEqual([
      { type: "thinking", thinking: "plan" },
      { type: "text", text: "done" },
    ]);
  });

  it("materializes a Pi tool call only from a broker handoff", () => {
    const bridge = createEventBridge(fakeStream() as any, model);
    bridge.pushToolCall({ id: "call-1", name: "read", arguments: { path: "seed.txt" } });
    const output = bridge.getOutput();
    expect(output.stopReason).toBe("toolUse");
    expect(output.content).toEqual([
      { type: "toolCall", id: "call-1", name: "read", arguments: { path: "seed.txt" } },
    ]);
  });

  it("keeps toolUse after the prompt terminal arrives", () => {
    const bridge = createEventBridge(fakeStream() as any, model);
    bridge.pushToolCall({ id: "call-1", name: "read", arguments: {} });
    // agy reports end_turn for the pause it took while Pi ran the tool.
    bridge.applyResult({ stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2 } });
    expect(bridge.getOutput().stopReason).toBe("toolUse");
    expect(bridge.getOutput().rawStopReason).toBe("end_turn");
  });

  it("applies usage and stop reason to the assistant message", () => {
    const bridge = createEventBridge(fakeStream() as any, model);
    bridge.handleUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } });
    bridge.applyResult({
      stopReason: "max_tokens",
      usage: { inputTokens: 1445, outputTokens: 6, thoughtTokens: 4 },
    });
    const output = bridge.getOutput();
    expect(output.stopReason).toBe("length");
    expect(output.usage).toMatchObject({ input: 1445, output: 10, reasoning: 4, totalTokens: 1455 });
  });
});
