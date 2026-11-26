/**
 * ACP `session/update` → Pi's AssistantMessageEventStream.
 *
 * The bridge is the only writer of Pi's assistant message. It materializes
 * text and thinking blocks from agy's chunk updates, and materializes a Pi
 * `toolCall` only when the handoff broker surfaced one of Pi's own tools —
 * ACP `tool_call` updates for vendor tools never become Pi tool calls.
 */

import {
  calculateCost,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
} from "@earendil-works/pi-ai";

export const PROVIDER_ID = "pi-agy-tether";

/** ACP prompt terminal: `{stopReason, usage}`. */
export interface AcpPromptResult {
  stopReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedReadTokens?: number;
    cachedWriteTokens?: number;
    thoughtTokens?: number;
    totalTokens?: number;
  };
}

export interface EventBridge {
  handleUpdate(update: any): void;
  /** Materialize a Pi tool call backed by a blocked MCP invocation. */
  pushToolCall(call: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }): void;
  /** ACP occupancy, never spend. */
  contextTokens(): number | undefined;
  applyUsage(counts: ReturnType<typeof acpUsage>): void;
  /** Apply the prompt terminal, net of earlier Pi handoff usage. */
  applyResult(result: AcpPromptResult, counts?: ReturnType<typeof acpUsage>): void;
  /** Append a provider diagnostic as a text block (used for exit detail). */
  appendMarker(text: string): void;
  /** Close any open text/thinking block before `toolcall_end` or `done`. */
  finalizeBlocks(): void;
  getOutput(): AssistantMessage;
  started(): boolean;
}

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

/** ACP native usage → Pi usage. agy can report input with or without cache. */
export function acpUsage(u: AcpPromptResult["usage"]): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  totalTokens: number;
  present: boolean;
} {
  const cached = finite(u?.cachedReadTokens) ? u!.cachedReadTokens! : 0;
  const writes = finite(u?.cachedWriteTokens) ? u!.cachedWriteTokens! : 0;
  const input = finite(u?.inputTokens) ? u!.inputTokens! : 0;
  const completion = finite(u?.outputTokens) ? u!.outputTokens! : 0;
  const reasoning = finite(u?.thoughtTokens) ? u!.thoughtTokens! : 0;
  // When the terminal reconciles, its input excludes cache and its output
  // already includes thoughts. Keep the old fallback for other payloads.
  const cache = cached + writes;
  const inputIsUncached = u?.totalTokens === input + cache + completion;
  const output = inputIsUncached ? completion : completion + reasoning;
  const total = finite(u?.totalTokens) ? u!.totalTokens! : input + output;
  return {
    input: inputIsUncached ? input : Math.max(0, input - cache),
    output,
    cacheRead: cached,
    cacheWrite: writes,
    reasoning,
    totalTokens: total,
    present: finite(u?.inputTokens) && finite(u?.outputTokens) &&
      input + completion + cache + reasoning > 0,
  };
}

export function mapStopReason(reason: string | undefined): "stop" | "length" | "toolUse" | "aborted" {
  switch (reason) {
    case "max_tokens":
    case "max_output_tokens":
      return "length";
    case "cancelled":
      return "aborted";
    case "end_turn":
    default:
      return "stop";
  }
}

const UNAVAILABLE_COST = {
  input: null, output: null, cacheRead: null, cacheWrite: null, total: null, basis: "unavailable",
} as const;

// Pi 1.5/1.6 require number slots but have no unknown sentinel. Null retains an
// explicit unknown in JSON and does not poison Pi's numeric sums like NaN would.
// Keep the shape (including cost) and leave positive occupancy in totalTokens.
export function unavailableUsage(): AssistantMessage["usage"] {
  return {
    input: null, output: null, cacheRead: null, cacheWrite: null, totalTokens: 0,
    availability: "unavailable", cost: { ...UNAVAILABLE_COST },
  } as unknown as AssistantMessage["usage"];
}

export function createEventBridge(
  stream: Pick<AssistantMessageEventStream, "push">,
  model: Model<any>,
): EventBridge {
  let started = false;
  let textBlock: { index: number; text: string } | undefined;
  let thinkingBlock: { index: number; text: string } | undefined;
  let lastStepUsed: number | undefined;

  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: PROVIDER_ID as any,
    provider: model.provider,
    model: model.id,
    usage: unavailableUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };

  function start(): void {
    if (started) return;
    started = true;
    stream.push({ type: "start", partial: output });
  }

  function closeBlocks(): void {
    if (thinkingBlock) {
      stream.push({
        type: "thinking_end",
        contentIndex: thinkingBlock.index,
        content: thinkingBlock.text,
        partial: output,
      });
      thinkingBlock = undefined;
    }
    if (textBlock) {
      stream.push({
        type: "text_end",
        contentIndex: textBlock.index,
        content: textBlock.text,
        partial: output,
      });
      textBlock = undefined;
    }
  }

  function appendText(text: string): void {
    if (!text) return;
    start();
    if (thinkingBlock) {
      stream.push({
        type: "thinking_end",
        contentIndex: thinkingBlock.index,
        content: thinkingBlock.text,
        partial: output,
      });
      thinkingBlock = undefined;
    }
    if (!textBlock) {
      const index = output.content.length;
      output.content.push({ type: "text", text: "" } as TextContent);
      textBlock = { index, text: "" };
      stream.push({ type: "text_start", contentIndex: index, partial: output });
    }
    textBlock.text += text;
    (output.content[textBlock.index] as TextContent).text = textBlock.text;
    stream.push({
      type: "text_delta",
      contentIndex: textBlock.index,
      delta: text,
      partial: output,
    });
  }

  function appendThinking(text: string): void {
    if (!text) return;
    start();
    if (textBlock) {
      stream.push({
        type: "text_end",
        contentIndex: textBlock.index,
        content: textBlock.text,
        partial: output,
      });
      textBlock = undefined;
    }
    if (!thinkingBlock) {
      const index = output.content.length;
      output.content.push({ type: "thinking", thinking: "" } as ThinkingContent);
      thinkingBlock = { index, text: "" };
      stream.push({ type: "thinking_start", contentIndex: index, partial: output });
    }
    thinkingBlock.text += text;
    (output.content[thinkingBlock.index] as ThinkingContent).thinking = thinkingBlock.text;
    stream.push({
      type: "thinking_delta",
      contentIndex: thinkingBlock.index,
      delta: text,
      partial: output,
    });
  }

  function handleUpdate(update: any): void {
    if (!update || typeof update !== "object") return;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content?.type === "text" && typeof update.content.text === "string")
          appendText(update.content.text);
        return;
      case "agent_thought_chunk":
        if (update.content?.type === "text" && typeof update.content.text === "string")
          appendThinking(update.content.text);
        return;
      case "usage_update":
        // agy emits each inference step's total token count (`used`) before
        // tool_call and before the prompt terminal. Record it so toolUse turns
        // carry real per-step context tokens and the final assistant message
        // reports the last step's context rather than the multi-step sum.
        // It carries no spend counters on 1.5.16; the live prompt owner
        // separately attributes the spend at each Pi episode boundary.
        if (finite(update.used) && update.used > 0) {
          lastStepUsed = update.used;
          output.usage.totalTokens = update.used;
        }
        return;
      default:
        // user_message_chunk, tool_call, tool_call_update, plan,
        // available_commands_update, config_option_update, session_info_update:
        // transport state, never assistant content.
        return;
    }
  }

  function pushToolCall(call: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }): void {
    start();
    closeBlocks();
    const index = output.content.length;
    const toolCall: ToolCall = {
      type: "toolCall",
      id: call.id,
      name: call.name,
      arguments: call.arguments as any,
    };
    output.content.push(toolCall);
    stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
    stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: output });
    output.stopReason = "toolUse";
  }

  function applyUsage(counts: ReturnType<typeof acpUsage>): void {
    if (!counts.present) return;
    const { present: _, ...usage } = counts;
    Object.assign(output.usage, usage, {
      totalTokens: lastStepUsed ?? counts.totalTokens, availability: "reported",
    });
    if (model.cost && Object.values(model.cost).some(rate => typeof rate === "number" && rate > 0)) {
      calculateCost(model, output.usage);
      Object.assign(output.usage.cost, { basis: "API-equivalent" });
    }
  }

  function applyResult(result: AcpPromptResult, counts = acpUsage(result.usage)): void {
    start();
    applyUsage(counts);
    const mapped = mapStopReason(result.stopReason);
    // A handoff already claimed this episode: the turn continues in Pi.
    if (output.stopReason !== "toolUse") output.stopReason = mapped;
    output.rawStopReason = result.stopReason;
  }

  function appendMarker(text: string): void {
    appendText(`\n\n[agy tether] ${text}`);
  }

  return {
    handleUpdate,
    contextTokens: () => lastStepUsed,
    pushToolCall,
    applyUsage,
    applyResult,
    appendMarker,
    finalizeBlocks: closeBlocks,
    getOutput: () => output,
    started: () => started,
  };
}
