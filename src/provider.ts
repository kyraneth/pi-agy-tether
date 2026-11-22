import { endStreamWithError } from "pi-tether-core/pi-stream";
import { requestSignature, matchesPrefix } from "pi-tether-core/request";
/**
 * Pi owns prompts, tools and history. agy is a disposable live transport.
 *
 * Reuse a parked ACP connection only while its acknowledged Pi history matches.
 * Every replacement imports the full Pi transcript. A Pi tool call runs through
 * the handoff broker: agy blocks inside the MCP call, Pi executes the tool, and
 * the next provider call answers that same blocked call on the same process.
 */

import {
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  piContext as normalizePiContext,
  historyHash,
  replayPiMessages,
} from "./pi-context.js";
import {
  CliProcess,
  getCliLifecycleRevision,
  parkCliProcess,
  takeParkedCliProcess,
  type EpisodeSink,
} from "./cli-process.js";
import { createEventBridge, PROVIDER_ID } from "./event-bridge.js";
import type { ToolDefinition } from "./mcp-config.js";
import type { HandoffResult } from "./handoff-broker.js";

/** Extended stream options: Pi's SimpleStreamOptions plus host plumbing. */
export type StreamViaAcpOptions = SimpleStreamOptions & {
  cwd?: string;
  /**
   * Build the Pi tool surface from the effective (post-hook) request. The
   * provider calls this after `onPayload` so a replacement tool set is what agy
   * is actually offered.
   */
  prepareMcp?: (
    context: { messages: any[]; systemPrompt?: string; tools?: any[] },
  ) => Promise<{ tools: readonly ToolDefinition[]; handoffSocket: string }>;
};

/** Messages after the last assistant turn: what this call adds. */
function deltaMessages(messages: any[]): any[] {
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }
  return messages.slice(lastAssistantIdx + 1);
}

/**
 * A parked agy session is stale when Pi's history moved on without it: an
 * assistant turn from another provider after — or with no — tether turn means
 * the vendor never saw that exchange. Reimport instead of continuing.
 */
function cliSessionIsStale(messages: any[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    return !(m?.provider === PROVIDER_ID || m?.api === PROVIDER_ID);
  }
  return false;
}

/** Pi can append this local failure after aborting a tool, without a vendor call. */
function isUnsentPiFailure(message: any): boolean {
  return (
    message?.role === "assistant" &&
    (message.provider === PROVIDER_ID || message.api === PROVIDER_ID) &&
    (message.stopReason === "error" || message.stopReason === "aborted") &&
    Array.isArray(message.content) &&
    message.content.length === 0 &&
    !!message.usage &&
    ["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every(
      (k) => message.usage[k] === 0,
    )
  );
}

/** pi toolResult content → MCP tool result agy's blocked call receives. */
export function toHandoffResult(msg: any): HandoffResult {
  const content: HandoffResult["content"] = [];
  const raw = msg?.content;
  if (typeof raw === "string") {
    content.push({ type: "text", text: raw });
  } else if (Array.isArray(raw)) {
    for (const block of raw) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string") {
        content.push({ type: "text", text: block.text });
      } else if (
        block.type === "image" &&
        typeof block.data === "string" &&
        typeof block.mimeType === "string"
      ) {
        content.push({ type: "image", data: block.data, mimeType: block.mimeType });
      } else {
        try {
          content.push({ type: "text", text: JSON.stringify(block) });
        } catch {
          /* unserializable block — skip */
        }
      }
    }
  } else if (raw != null) {
    try {
      content.push({ type: "text", text: JSON.stringify(raw) });
    } catch {
      /* skip */
    }
  }
  if (content.length === 0) content.push({ type: "text", text: "" });
  return msg?.isError ? { content, isError: true } : { content };
}

/** What a parked connection was asked for; a mismatch retires it. */
const SIGNATURE_FIELDS = ["model", "systemPrompt", "cwd", "handoffSocket", "tools"] as const;

function retireReasons(r: {
  stale: boolean;
  historyMatches: boolean;
  previous: string;
  next: string;
  turnActive: boolean;
}): string[] {
  const reasons: string[] = [];
  if (r.stale) reasons.push("staleHistory");
  if (!r.historyMatches) reasons.push("historyMismatch");
  if (r.previous !== r.next) {
    const a = JSON.parse(r.previous) as unknown[];
    const b = JSON.parse(r.next) as unknown[];
    SIGNATURE_FIELDS.forEach((name, i) => {
      if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) reasons.push(name);
    });
  }
  if (reasons.length === 0)
    reasons.push(r.turnActive ? "handoffDeltaNotContinuable" : "deltaShape");
  return reasons;
}

const debug = (...args: unknown[]) => {
  if (process.env.PI_AGY_TETHER_DEBUG === "1") console.error("[agy-debug]", ...args);
};

function emptyMessage(model: Model<any>): any {
  return {
    role: "assistant",
    content: [],
    api: PROVIDER_ID,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
  };
}

/** Stream a response from `agy acp` as an AssistantMessageEventStream. */
export function streamViaAcp(
  model: Model<any>,
  context: { messages: any[]; systemPrompt?: string; tools?: any[] },
  options?: StreamViaAcpOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const lifecycleRevision = getCliLifecycleRevision();
  const invalidated = () => lifecycleRevision !== getCliLifecycleRevision();

  function failPiRequest(error: string, reason: "error" | "aborted" = "error") {
    endStreamWithError(stream, emptyMessage(model), error, reason);
  }

  debug("call", { aborted: options?.signal?.aborted, sessionId: options?.sessionId });
  if (options?.signal?.aborted) {
    failPiRequest("Request aborted", "aborted");
    return stream;
  }

  async function runOnce(): Promise<void> {
    let prepared = normalizePiContext(context);

    // A payload hook is a mutating boundary: apply its replacement before the
    // prompt, signature and tool schema are built.
    if (options?.onPayload) {
      const replacement = await options.onPayload(
        {
          system: prepared.systemPrompt,
          messages: prepared.messages,
          tools: prepared.tools,
        },
        model,
      );
      if (replacement !== undefined) {
        const payload = replacement as any;
        if (!payload || typeof payload !== "object" || !Array.isArray(payload.messages))
          throw new Error("before_provider_request returned an invalid payload");
        prepared = normalizePiContext({
          systemPrompt: payload.systemPrompt ?? payload.system,
          messages: payload.messages,
          tools: payload.tools,
        });
      }
    }

    const cwd = options?.cwd ?? process.cwd();
    const piSessionId = options?.sessionId;
    debug("prepared", { messages: prepared.messages.length, level: options?.reasoning });
    const mcp = options?.prepareMcp
      ? await options.prepareMcp(prepared)
      : { tools: [] as readonly ToolDefinition[], handoffSocket: "" };
    const tools = mcp.tools;
    const handoffSocket = mcp.handoffSocket;
    if (tools.length > 0 && !handoffSocket) {
      failPiRequest("agy tether has no handoff broker socket; Pi tools cannot be proxied");
      return;
    }
    const systemPrompt = prepared.systemPrompt ?? "";
    const messages = prepared.messages as any[];
    const stale = cliSessionIsStale(messages);
    let delta = deltaMessages(messages);
    const signature = requestSignature([
      model.id,
      systemPrompt,
      cwd,
      handoffSocket ?? null,
      JSON.stringify(tools),
    ]);

    // ---- 1. Reuse the session's parked connection when this call continues it
    let mode: "spawn" | "turn" | "handoff" = "spawn";
    let cli = piSessionId ? takeParkedCliProcess(piSessionId) : undefined;
    if (cli) {
      const checkpoint = cli.piHistory;
      const historyMatches = !!checkpoint && matchesPrefix(messages, checkpoint, historyHash);
      if (!stale && historyMatches && cli.signature === signature) {
        if (checkpoint) delta = messages.slice(checkpoint.length).filter((m) => !isUnsentPiFailure(m));
        const toolResults = delta.filter((m) => m?.role === "toolResult");
        const users = delta.filter((m) => m?.role === "user");
        if (cli.turnInFlight) {
          const ids = toolResults.map((m) => String(m.toolCallId ?? ""));
          if (delta.every((m) => m?.role === "toolResult") && cli.canContinueHandoff(ids))
            mode = "handoff";
        } else if (delta.every((m) => m?.role === "user") && users.length > 0) {
          mode = "turn";
        }
      }
      if (mode === "spawn") {
        await cli.retire(
          retireReasons({
            stale,
            historyMatches,
            previous: cli.signature,
            next: signature,
            turnActive: cli.turnInFlight,
          }),
        );
        cli = undefined;
      }
    }

    // ---- 2. Or open a fresh ACP session that imports Pi's full history
    if (!cli) {
      if (invalidated() || options?.signal?.aborted) {
        failPiRequest("Request aborted or invalidated by agy lifecycle", "aborted");
        return;
      }
      debug("opening");
      cli = await CliProcess.open({
        cwd,
        modelId: model.id,
        thinkingLevel: options?.reasoning,
        oneShot: tools.length === 0 && options?.cacheRetention === "none",
        systemPrompt,
        tools,
        signature,
        handoffSocket: handoffSocket!,
        signal: options?.signal,
      });
      if (invalidated() || options?.signal?.aborted) {
        await cli.retire(["abort"]);
        failPiRequest("Request aborted or invalidated by agy lifecycle", "aborted");
        return;
      }
      debug("opened", { sessionId: cli.sessionId, models: cli.offeredModels.length });
      cli.sendPrompt(replayPiMessages(messages));
    }

    const live = cli;
    const bridge = createEventBridge(stream, model);
    let streamEnded = false;
    let finished = false;
    let aborted = false;
    let resolveFinished!: () => void;
    const finishedPromise = new Promise<void>((r) => (resolveFinished = r));

    function finishEpisode() {
      if (finished) return;
      finished = true;
      live.detach();
      resolveFinished();
    }

    function endWithError(
      message: string,
      reason: "error" | "aborted",
      retirement: string[],
    ) {
      if (finished) return;
      bridge.finalizeBlocks();
      const output = bridge.getOutput();
      if (!streamEnded) {
        streamEnded = true;
        endStreamWithError(
          stream,
          {
            ...output,
            content: output.content.length
              ? output.content
              : [{ type: "text" as const, text: `Error: ${message}` }],
          },
          message,
          reason,
        );
      }
      finishEpisode();
      void live.retire(retirement);
    }

    function endWithDone(reason: any) {
      if (finished) return;
      streamEnded = true;
      stream.push({ type: "done", reason, message: { ...bridge.getOutput(), stopReason: reason } });
      stream.end();
      finishEpisode();
      if (piSessionId) parkCliProcess(piSessionId, live, "idle");
      else void live.retire(["noPiSession"]);
    }

    const sink: EpisodeSink = {
      onUpdate(update) {
        if (finished) return;
        bridge.handleUpdate(update);
      },
      onPromptResult(result) {
        if (finished) return;
        debug("prompt result", result);
        bridge.applyResult(result);
        bridge.finalizeBlocks();
        const output = bridge.getOutput();
        if (output.stopReason === "toolUse") output.stopReason = "stop";
        const reason = aborted ? "aborted" : output.stopReason;
        live.piHistory = {
          length: messages.length + 1,
          hash: historyHash([...messages, output]),
        };
        endWithDone(reason);
      },
      onHandoffCall(invocation) {
        if (finished) return;
        if (aborted) {
          invocation.respond({
            content: [{ type: "text", text: "Pi aborted this turn; tool not executed" }],
            isError: true,
          });
          return;
        }
        bridge.pushToolCall({
          id: invocation.piCallId,
          name: invocation.name,
          arguments: invocation.arguments,
        });
        live.piHistory = {
          length: messages.length + 1,
          hash: historyHash([...messages, bridge.getOutput()]),
        };
        endWithDone("toolUse");
      },
      onClose(code) {
        debug("close", code, live.stderr());
        if (finished) return;
        const stderr = live.stderr();
        const message = stderr
          ? `agy acp exited with code ${code}: ${stderr}`
          : `agy acp exited unexpectedly with code ${code}`;
        endWithError(message, "error", ["exit"]);
      },
      onFatal(message) {
        if (finished) return;
        endWithError(message, aborted ? "aborted" : "error", ["episode_error"]);
      },
    };

    // ---- 3. Continue a parked connection: answer the blocked tool calls
    if (mode === "handoff") {
      const deliveries = delta
        .filter((m) => m?.role === "toolResult")
        .map((m) =>
          live.deliverHandoffResult(String(m.toolCallId ?? ""), toHandoffResult(m)),
        );
      if (!deliveries.every(Boolean)) {
        failPiRequest("agy tether could not match a Pi tool result to its blocked call");
        await live.retire(["handoff_unconfirmed"]);
        return;
      }
    }

    live.attach(sink);

    if (mode === "turn") {
      try {
        // Verify live model and effort on every new prompt.
        await live.ensureConfigured(options?.reasoning);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failPiRequest(message);
        await live.retire(["config_readback"]);
        return;
      }
      if (invalidated() || options?.signal?.aborted) {
        aborted = true;
        await live.retire(["abort"]);
        finishEpisode();
        failPiRequest("Request aborted", "aborted");
        return;
      }
      live.sendPrompt(
        delta.length
          ? replayPiMessages(delta)
          : [
              {
                type: "text",
                text: "Continue the existing conversation. Do not repeat completed tool actions.",
              },
            ],
      );
    }

    if (options?.signal) {
      options.signal.addEventListener(
        "abort",
        () => {
          if (finished) return;
          aborted = true;
          live.cancel();
          void live.retire(["abort"]);
          endWithError("Request aborted", "aborted", ["abort"]);
        },
        { once: true },
      );
      if (options.signal.aborted) {
        aborted = true;
        live.cancel();
        void live.retire(["abort"]);
        endWithError("Request aborted", "aborted", ["abort"]);
        return;
      }
    }

    await finishedPromise;
  }

  (async () => {
    try {
      await runOnce();
    } catch (error: any) {
      failPiRequest(
        options?.signal?.aborted
          ? "Request aborted"
          : (error?.message ?? "Unexpected error in streamViaAcp"),
        options?.signal?.aborted ? "aborted" : "error",
      );
    }
  })();

  return stream;
}
