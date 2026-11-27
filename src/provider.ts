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
} from "./pi-context.js";
import {
  CliProcess,
  getCliLifecycleRevision,
  parkCliProcess,
  takeParkedCliProcess,
  type EpisodeSink,
} from "./cli-process.js";
import { assertImageSupport } from "./cli-catalog.js";
import { splitRefusedPrompt } from "./agent-recipe.js";
import { createEventBridge, PROVIDER_ID, unavailableUsage } from "./event-bridge.js";
import type { ToolDefinition } from "./mcp-config.js";
import type { HandoffResult } from "./handoff-broker.js";
import {
  EMPTY_CATALOG_FACT, GENERATION_CONTROLS_FACT, RESULT_FRAMING_FACT, TOOL_CATALOG_FACT,
  logTransportFact, resultLossNotices, strictTransport, transportNotice, type ResultLossNotice,
} from "./degradations.js";
import { TurnLimitError, type TurnPlan } from "./turn-budget.js";
import { allowSearchArgs, nativeSearchEnabled, type NativeSearchSurface } from "./native-search.js";

/** Extended stream options: Pi's SimpleStreamOptions plus host plumbing. */
export type StreamViaAcpOptions = SimpleStreamOptions & {
  cwd?: string;
  /** User-visible disclosure, not model content or a transcript message. */
  notify?: (message: string) => void;
  /** Record every result disclosure in Pi’s journal, including suppressed repeats. */
  recordResultNotice?: (notice: ResultLossNotice) => void;
  /** Journal-only diagnostic; never a screen notification. */
  recordUsageUnavailable?: () => void;
  search?: NativeSearchSurface;
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
    message.usage.totalTokens === 0 &&
    ["input", "output", "cacheRead", "cacheWrite"].every(
      (k) => message.usage[k] === 0 || message.usage[k] === null,
    )
  );
}

/** pi toolResult content → MCP tool result agy's blocked call receives. */
export function toHandoffResult(msg: any, modelId: string): HandoffResult {
  const content: HandoffResult["content"] = [];
  const raw = msg?.content;
  if (typeof raw === "string") {
    content.push({ type: "text", text: raw });
  } else if (Array.isArray(raw)) {
    assertImageSupport(modelId, raw);
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
const SIGNATURE_FIELDS = ["model", "systemPrompt", "cwd", "handoffSocket", "tools", "nativeTool"] as const;

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
    usage: unavailableUsage(),
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
  const strict = strictTransport();
  const notice = (message: string, once?: string) =>
    transportNotice(options?.sessionId, options?.notify, message, once);

  function failPiRequest(error: string, reason: "error" | "aborted" = "error") {
    endStreamWithError(stream, emptyMessage(model), error, reason);
  }

  debug("call", { aborted: options?.signal?.aborted, sessionId: options?.sessionId });
  if (options?.signal?.aborted) {
    failPiRequest("Request aborted", "aborted");
    return stream;
  }

  async function refuseBeforePrompt(message: string, reason: string): Promise<never> {
    const session = options?.sessionId;
    const parked = session ? takeParkedCliProcess(session) : undefined;
    if (parked?.hasPendingHandoffs) {
      parked.cancel();
      await parked.retire([reason]);
    } else if (parked && session) {
      parkCliProcess(session, parked, reason);
    }
    throw new Error(message);
  }

  async function runOnce(): Promise<void> {
    const nativeSearch = nativeSearchEnabled();
    if (strict && nativeSearch) await refuseBeforePrompt(
      "PI_AGY_TETHER_STRICT refuses agy native search. Unset PI_AGY_TETHER_NATIVE_SEARCH; no prompt was sent.",
      "strict_native_search",
    );
    // Model defaults live on the model. An explicit zero is still a control.
    const controls = ["temperature", "maxTokens", "toolChoice"] as const;
    const explicit = controls.filter(key => options?.[key] !== undefined);
    if (!strict) logTransportFact(GENERATION_CONTROLS_FACT);
    if (explicit.length) {
      const names = explicit.join(", ");
      if (strict) await refuseBeforePrompt(
        `agy cannot honor explicit generation controls: ${names}. No prompt was sent for this request. Remove the controls or use a provider that honors them.`,
        "unsupported_generation_controls",
      );
      // Only fields supplied in this request change the user's result.
      notice(`agy ignored explicit generation controls: ${names}.`, "generation-controls");
    }
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

    const systemPrompt = prepared.systemPrompt ?? "";
    const { changes, preface } = splitRefusedPrompt(systemPrompt);
    if (changes.length) {
      const detail = changes.join(" and ");
      if (strict) await refuseBeforePrompt(
        `agy cannot preserve the Pi system role without the gateway workaround: ${detail}. No prompt was sent. Use a provider that can preserve the system instruction.`,
        "system_role_changed",
      );
      logTransportFact(preface.length
        ? `agy moved Pi system lines to the first user prompt: ${detail}.`
        : `agy changed the Pi system prompt: ${detail}.`);
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
    const messages = prepared.messages as any[];
    const stale = cliSessionIsStale(messages);
    let delta = deltaMessages(messages);
    const signature = requestSignature([
      model.id,
      systemPrompt,
      cwd,
      handoffSocket ?? null,
      JSON.stringify(tools),
      ...(nativeSearch ? ["search_web"] : []),
    ]);

    // ---- 1. Reuse the session's parked connection when this call continues it
    let mode: "spawn" | "turn" | "handoff" = "spawn";
    let cli = piSessionId ? takeParkedCliProcess(piSessionId) : undefined;
    const guardRestart = !!cli?.memoryRetirement;
    if (cli?.memoryRetirement) {
      await cli.retire(["memory_guard"]);
      cli = undefined;
    }
    if (cli) {
      if (!cli.alive && delta.some(m => m?.role === "toolResult")) {
        // The parked child already reported its own signal event on screen.
        const detail = "agy exited before answering";
        await cli.retire(["exit_during_handoff"]);
        throw new Error(`${detail}. Pi retained the tool results; no tools were retried.`);
      }
      const checkpoint = cli.piHistory;
      const historyMatches = !!checkpoint && matchesPrefix(messages, checkpoint, historyHash);
      if (cli.alive && !stale && historyMatches && cli.signature === signature) {
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

    if (mode !== "handoff") {
      const constraint = prepared.tools?.length ? TOOL_CATALOG_FACT : EMPTY_CATALOG_FACT;
      if (strict) {
        if (cli && piSessionId) parkCliProcess(piSessionId, cli, "unverified_tool_catalog");
        throw new Error(`${constraint} No prompt was sent. Use a provider with an exact tool catalog.`);
      }
      logTransportFact(constraint);
    }

    // Without the blocked call, replay would be history text, not a tool response.
    const unboundResults = mode !== "handoff" && delta.some(m => m?.role === "toolResult");
    if (unboundResults) {
      if (strict) throw new Error("agy cannot verify intact tool-result delivery without the matching blocked call. Pi retained the results; no tools were retried.");
      if (!guardRestart)
        notice("agy lost the matching blocked call; returning Pi tool results as history text, not native tool responses. Pi retained the results.");
    }

    // Reject known text-only input before a recipe proof or warm config readback.
    if (mode !== "handoff") {
      try {
        for (const message of mode === "spawn" ? messages : delta)
          if (Array.isArray(message?.content)) assertImageSupport(model.id, message.content);
      } catch (error) {
        if (cli && piSessionId) parkCliProcess(piSessionId, cli, "image_input_refused");
        throw error;
      }
    }

    // ---- 2. Or open a fresh ACP session that imports Pi's full history
    if (!cli) {
      if (invalidated() || options?.signal?.aborted) {
        failPiRequest("Request aborted or invalidated by agy lifecycle", "aborted");
        return;
      }
      debug("opening");
      if (nativeSearch) options?.search?.announce();
      cli = await CliProcess.open({
        modelId: model.id,
        thinkingLevel: options?.reasoning,
        oneShot: tools.length === 0 && options?.cacheRetention === "none",
        systemPrompt,
        tools,
        signature,
        handoffSocket: handoffSocket!,
        signal: options?.signal,
        onProcessEvent: (message) => notice(message),
        replayMessages: messages,
        ...(nativeSearch ? { nativeTool: "search_web", allowNativeArgs: allowSearchArgs, onNativeSearch: options?.search?.record } : {}),
      });
      if (invalidated() || options?.signal?.aborted) {
        await cli.retire(["abort"]);
        failPiRequest("Request aborted or invalidated by agy lifecycle", "aborted");
        return;
      }
      debug("opened", { sessionId: cli.sessionId, models: cli.offeredModels.length });
    }

    const live = cli;
    let plan: TurnPlan | undefined;
    if (mode !== "handoff") {
      if (mode === "turn") {
        try {
          await live.ensureConfigured(options?.reasoning);
        } catch (error) {
          await live.retire(["config_readback"]);
          throw error;
        }
      }
      if (invalidated() || options?.signal?.aborted) {
        await live.retire(["abort"]);
        failPiRequest("Request aborted or invalidated by agy lifecycle", "aborted");
        return;
      }
      try {
        plan = live.planTurns(mode === "spawn" ? messages : delta, prepared.tools?.length ?? 0);
      } catch (error) {
        if (error instanceof TurnLimitError && mode === "turn" && piSessionId)
          parkCliProcess(piSessionId, live, "turn_limit_exceeded");
        else await live.retire(["turn_limit_exceeded"]);
        throw error;
      }
      try {
        for (const staged of plan.stagedTurns) {
          await live.sendStagedPrompt(staged, options?.signal);
          if (invalidated()) throw new Error("Staged context was invalidated by agy lifecycle");
        }
      } catch (error) {
        await live.retire(["staged_turn_failed"]);
        throw error;
      }
    }
    const bridge = createEventBridge(stream, model);
    let streamEnded = false;
    let finished = false;
    let aborted = false;
    let resolveFinished!: () => void;
    let abortHandler: (() => void) | undefined;
    const finishedPromise = new Promise<void>((r) => (resolveFinished = r));

    function finishEpisode() {
      if (finished) return;
      finished = true;
      if (abortHandler) options?.signal?.removeEventListener("abort", abortHandler);
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
        if (output.usage.input === null) options?.recordUsageUnavailable?.();
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
      const output = bridge.getOutput();
      if (output.usage.input === null) options?.recordUsageUnavailable?.();
      stream.push({ type: "done", reason, message: { ...output, stopReason: reason } });
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
        bridge.applyResult(result, live.terminalUsage(result.usage, bridge.contextTokens()));
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
        bridge.applyUsage(live.handoffUsage(bridge.contextTokens()));
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
      onClose(code, signal) {
        debug("close", code, signal, live.stderr());
        if (finished) return;
        const stderr = live.stderr();
        const message = signal
          ? live.describeKill(signal)
          : stderr
            ? `agy acp exited with code ${code}: ${stderr}`
            : `agy acp exited unexpectedly with code ${code}`;
        endWithError(message, "error", ["exit"]);
      },
      onFatal(message) {
        if (finished) return;
        if (live.memoryRetirement && piSessionId) parkCliProcess(piSessionId, live, "memory_guard");
        endWithError(message, aborted ? "aborted" : "error", ["episode_error"]);
      },
    };

    // ---- 3. Continue a parked connection: answer the blocked tool calls
    if (mode === "handoff") {
      // Validate the whole batch before answering any blocked tool call.
      let results: { id: string; tool: string; result: HandoffResult }[];
      try {
        results = delta
          .filter(m => m?.role === "toolResult")
          .map(m => ({ id: String(m.toolCallId ?? ""), tool: String(m.toolName ?? "tool"), result: toHandoffResult(m, model.id) }));
        if (strict) {
          live.cancel();
          const retained = results.map(({ tool }) => `Pi executed ${tool} and retained its result.`).join(" ");
          throw new Error(`agy ${live.agentVersion} cannot verify intact tool-result delivery. ${retained} No tool was retried. Use a provider with lossless tool results.`);
        }
      } catch (error) {
        await live.retire(["handoff_result_refused"]);
        throw error;
      }
      logTransportFact(RESULT_FRAMING_FACT);
      for (const { tool, result } of results) {
        for (const loss of resultLossNotices(live.agentVersion, tool, result)) {
          options?.recordResultNotice?.(loss);
          if (loss.surface === "screen") notice(loss.message);
          else logTransportFact(loss.message);
        }
      }
      const deliveries = results.map(({ id, result }) => live.deliverHandoffResult(id, result));
      if (!deliveries.every(Boolean)) {
        failPiRequest("agy tether could not match a Pi tool result to its blocked call");
        await live.retire(["handoff_unconfirmed"]);
        return;
      }
    }

    live.attach(sink);

    if (plan) {
      try {
        options?.signal?.throwIfAborted();
        live.sendPrompt(plan.finalTurn);
      } catch (error) {
        finishEpisode();
        await live.retire([plan.stagedTurns.length ? "staged_turn_failed" : "prompt_not_sent"]);
        throw error;
      }
    }

    if (options?.signal) {
      abortHandler = () => {
        if (finished) return;
        aborted = true;
        live.cancel();
        endWithError("Request aborted", "aborted", ["abort"]);
      };
      options.signal.addEventListener("abort", abortHandler, { once: true });
      if (options.signal.aborted) { abortHandler(); return; }
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
