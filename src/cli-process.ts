import { createLifecycleRevision } from "pi-tether-core/lifecycle";
/**
 * One live `agy acp` connection that outlives a single Pi call.
 *
 * Pi owns the transcript; this connection caches the acknowledged prefix and
 * the vendor session that produced it. It stays alive:
 * - through a handoff: agy blocks inside a Pi MCP tool call, Pi's stream ends
 *   at `toolcall_end`, and the next Pi call answers the same blocked call;
 * - between turns: after the prompt terminal the process is parked and the next
 *   user message is sent to the same ACP session.
 *
 * Exactly one episode (one Pi call) is attached at a time. Updates that arrive
 * while nothing is attached are buffered and replayed to the next episode.
 * Permission requests are answered here, attached or not: agy must never wait
 * on one.
 */

import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { copyFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { AcpClient, CLIENT_CAPABILITIES, CLIENT_INFO } from "./acp-client.js";
import type { AcpPromptResult } from "./event-bridge.js";
import {
  fallbackLogProblem,
  gatewayRefusalProblem,
  markerProblem,
  newMarker,
  proofKey,
  writeAgentRecipe,
  type NativeTool,
} from "./agent-recipe.js";
import { agentProofPath, appDataDir, privateWorkspace, sessionDir } from "./data-dir.js";
import {
  MCP_SERVER_NAME,
  removeSessionFiles,
  sessionMcpServer,
  writeToolSchema,
  type ToolDefinition,
} from "./mcp-config.js";
import {
  handoffSecretFile,
  registerHandoffTarget,
  unregisterHandoffTarget,
  type HandoffInvocation,
  type HandoffResult,
} from "./handoff-broker.js";
import { linkHostLogin } from "./login.js";
import { assertImageSupport } from "./cli-catalog.js";
import { PromptUsage } from "./prompt-usage.js";
import { watchAgyMemory } from "./agy-memory.js";
import { acpUsage } from "./event-bridge.js";
import { rememberOfferedFamilies } from "./model-discovery.js";
import { recordStatus } from "./cli-status.js";
import {
  captureStderr,
  forceKillProcess,
  preparePrivateConfig,
  registerProcess,
  spawnAgy,
  stopProcess,
} from "./process-manager.js";
import {
  configureSession,
  desiredConfig,
  verifyPromptConfig,
  type ConfigOption,
} from "./thinking-config.js";
import type { PromptBlock } from "./pi-context.js";
import { watchNativeSearch, type NativeSearchSurface } from "./native-search.js";
import { assertHistoricalReplayFits, assertWithinTurnLimit, planTurns, type TurnAssembly } from "./turn-budget.js";

function modelLabel(options: readonly ConfigOption[] | undefined): string {
  const label = (id: string) => {
    const config = options?.find(o => o.id === id);
    return config?.options?.find(o => o.value === config.currentValue)?.name ?? config?.currentValue;
  };
  const model = label("model");
  const effort = label("thought_level");
  return model ? (effort ? `${model} (${effort})` : model) : "None";
}

function assemblyFor(path: string, fromLabel: string, toLabel: string, prefaceText?: string): TurnAssembly {
  return { appDataDirPath: path, prefaceText, settingsChange: fromLabel === toLabel ? undefined : { fromLabel, toLabel } };
}

function requestPrompt(client: AcpClient, sessionId: string, blocks: PromptBlock[], assembly: TurnAssembly, version: string, modelId: string): Promise<any> {
  assertWithinTurnLimit(blocks, assembly, version);
  assertImageSupport(modelId, blocks);
  const prompt = assembly.prefaceText ? [{ type: "text", text: assembly.prefaceText }, ...blocks] : blocks;
  return client.request("session/prompt", { sessionId, prompt });
}

/** What an attached episode receives. */
export interface EpisodeSink {
  onUpdate(update: any): void;
  /** The ACP prompt terminal (`{stopReason, usage}`). */
  onPromptResult(result: AcpPromptResult): void;
  onHandoffCall(invocation: HandoffInvocation): void;
  onClose(code: number | null, signal: NodeJS.Signals | null): void;
  onFatal(message: string): void;
}

export interface OpenInput {
  /** Private workspace for native image input/output; ordinary tools run in Pi. */
  imageWorkspace?: string;
  modelId: string;
  /** Pi's requested thinking level (`off`/`minimal` mean "no specific level"). */
  thinkingLevel?: string;
  /** Pi opted out of caching for a standalone, tool-less request. */
  oneShot?: boolean;
  /** Pi's system prompt, written into the agent recipe body. */
  systemPrompt: string;
  tools: readonly ToolDefinition[];
  signature: string;
  handoffSocket: string;
  signal?: AbortSignal;
  /** Cold Pi history, checked against the live build before recipe proof. */
  replayMessages?: readonly any[];
  nativeTool?: NativeTool;
  onNativeSearch?: NativeSearchSurface["record"];
  /** Authorize exact arguments for this native call when ACP asks. */
  allowNativeArgs?: (update: unknown) => boolean;
  /** Recognize a native tool's terminal failure during the marker turn. */
  preflightProblem?: (text: string) => string | undefined;
  /** An event that occurred between Pi provider episodes, not a session notice. */
  onProcessEvent?: (message: string) => void;
}

const lifecycle = createLifecycleRevision();
export const getCliLifecycleRevision = lifecycle.current;

const live = new Set<CliProcess>();
const parked = new Map<string, { cli: CliProcess; cause: string }>();

function checkFallback(logFile: string, proofPath: string | undefined): void {
  const problem = fallbackLogProblem(logFile);
  if (!problem) return;
  if (proofPath) {
    try {
      rmSync(proofPath, { force: true });
    } catch {
      /* disposable cache */
    }
  }
  throw new Error(problem);
}

export class CliProcess {
  readonly signature: string;
  readonly modelId: string;
  readonly agentVersion: string;
  readonly offeredModels: string[];
  readonly marker: string;
  readonly logFile: string;
  readonly toolsPath: string;
  readonly sessionKey: string;

  /** ACP session id (agy's own handle). */
  sessionId = "";
  piHistory: { length: number; hash: string } | undefined;
  retired = false;
  turnActive = false;
  exitCode: number | null = null;
  exitSignal: NodeJS.Signals | null = null;
  memoryRetirement?: string;

  private retirement?: Promise<void>;
  private sink: EpisodeSink | undefined;
  private promptInFlight = false;
  private stagedCapture: { text: string; fail: (message: string) => void } | undefined;
  private buffered: any[] = [];
  private handoffs: HandoffInvocation[] = [];
  private pending = new Map<string, HandoffInvocation>();
  private retiredReasons: string[] = [];
  private readonly getStderr: () => string;
  readonly describeKill: (signal: NodeJS.Signals) => string;

  private constructor(
    readonly proc: ChildProcess,
    private readonly client: AcpClient,
    readonly input: OpenInput,
    private firstPromptPreface: string[],
    private readonly proofPath: string | undefined,
    private readonly appDataDirPath: string,
    private currentModelLabel: string,
    private lastPromptLabel: string,
    init: {
      sessionKey: string;
      agentVersion: string;
      offeredModels: string[];
      marker: string;
      toolsPath: string;
      logFile: string;
      getStderr: () => string;
      describeKill: (signal: NodeJS.Signals) => string;
    },
  ) {
    this.sessionKey = init.sessionKey;
    this.agentVersion = init.agentVersion;
    this.offeredModels = init.offeredModels;
    this.marker = init.marker;
    this.toolsPath = init.toolsPath;
    this.logFile = init.logFile;
    this.getStderr = init.getStderr;
    this.describeKill = init.describeKill;
    this.signature = input.signature;
    this.modelId = input.modelId;
  }

  /**
   * Open a session: private config, login link and per-session agent recipe,
   * ACP initialize/new, model and effort with readback, and a marker turn
   * if this binary and recipe format have no saved proof.
   */
  static async open(input: OpenInput): Promise<CliProcess> {
    const sessionKey = randomUUID();
    const logFile = join(sessionDir(sessionKey), "agy.log");
    const marker = newMarker();
    let recipe: ReturnType<typeof writeAgentRecipe> | undefined;
    const cleanup = () => {
      recipe?.dispose();
      removeSessionFiles(sessionKey);
    };
    const { toolsPath, server, verifyLogin, ownedRecipe } = await (async () => {
      try {
        input.signal?.throwIfAborted();
        preparePrivateConfig();
        const verifyLogin = await linkHostLogin();
        input.signal?.throwIfAborted();
        const toolsPath = writeToolSchema(sessionKey, input.tools);
        const server = input.tools.length ? sessionMcpServer({
          toolsPath,
          socketPath: input.handoffSocket,
          sessionId: sessionKey,
          secretPath: handoffSecretFile(),
        }) : undefined;
        const ownedRecipe = recipe = writeAgentRecipe({
          sessionKey, marker, systemPrompt: input.systemPrompt, mcpServer: server,
          mcpToolNames: input.tools.map(({ name }) => name), nativeTool: input.nativeTool,
        });
        if (process.env.PI_AGY_TETHER_DUMP) {
          try {
            copyFileSync(ownedRecipe.path, join(process.env.PI_AGY_TETHER_DUMP, "agent.md"));
            copyFileSync(toolsPath, join(process.env.PI_AGY_TETHER_DUMP, "tools.json"));
          } catch {
            /* diagnostic only */
          }
        }
        return { toolsPath, server, verifyLogin, ownedRecipe };
      } catch (error) {
        cleanup();
        throw error;
      }
    })();
    let proc: ChildProcess;
    let cwd: string;
    try {
      input.signal?.throwIfAborted();
      cwd = input.imageWorkspace ?? privateWorkspace(sessionKey);
      proc = spawnAgy({
        cwd, sessionId: sessionKey, logFile, signal: input.signal,
        agentName: ownedRecipe.name,
      });
    } catch (error) {
      cleanup();
      throw error;
    }
    // A failed spawn emits close without exit. Don't remove a running child's files.
    proc.once("exit", cleanup);
    proc.once("close", cleanup);
    registerProcess(proc);
    const getStderr = captureStderr(proc);

    let phase: "open" | "ready" = "open";
    let preflightText = "";
    const preflightProblem = input.preflightProblem ?? gatewayRefusalProblem;
    let cancelTarget: string | undefined;
    const observeSearch = input.nativeTool === "search_web" && input.onNativeSearch
      ? watchNativeSearch(input.onNativeSearch) : undefined;
    let instance: CliProcess | undefined;
    let guardMessage: string | undefined;
    const memory = watchAgyMemory(proc, reason => {
      guardMessage = `agy memory guard retired the process: ${reason}. Termination uses SIGTERM (SIGKILL if needed). The next request starts a new agy and replays Pi history; no prompt or tool was retried.`;
      if (instance) instance.guardMemory(guardMessage);
      else {
        client.dispose(guardMessage);
        forceKillProcess(proc);
      }
    });
    const client = new AcpClient(proc, {
      onUpdate(update, params) {
        if (params?.sessionId && cancelTarget && params.sessionId !== cancelTarget) return;
        if (cancelTarget && !instance?.retired) observeSearch?.(update, cancelTarget);
        if (phase === "open") {
          if (
            update?.sessionUpdate === "agent_message_chunk" &&
            typeof update.content?.text === "string"
          ) {
            preflightText += update.content.text;
            // agy retries a gateway refusal for minutes with backoff. The
            // refusal is already visible in the stream, so stop waiting for a
            // marker that will never arrive instead of holding Pi's turn open.
            if (cancelTarget && preflightProblem(preflightText))
              client.notify("session/cancel", { sessionId: cancelTarget });
          }
          return;
        }
        instance?.routeUpdate(update);
      },
      onPermissionRequest(params) {
        // No instance yet (initialize time) means nothing of ours can be
        // authorized; deny by returning a cancelled outcome.
        return instance ? instance.decidePermission(params) : { outcome: "denied" };
      },
      onDiagnostic(message, level) {
        if (level === "error") instance?.diagnostic(message);
        else if (process.env.PI_AGY_TETHER_DEBUG === "1")
          console.error(`[pi-agy-tether] ${message}`);
      },
    }, memory.describeKill);

    const disposeOnFailure = async (error: unknown): Promise<never> => {
      client.dispose();
      await stopProcess(proc);
      const detail = guardMessage ?? (error instanceof Error ? error.message : String(error));
      const stderr = getStderr();
      throw new Error(stderr ? `${detail}: ${stderr}` : detail);
    };

    try {
      const initialized = await client.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: CLIENT_CAPABILITIES,
        clientInfo: CLIENT_INFO,
      });
      const reportedVersion = initialized?.agentInfo?.version;
      const agentVersion = typeof reportedVersion === "string" ? reportedVersion : "unknown";
      if (input.replayMessages)
        assertHistoricalReplayFits(input.replayMessages, { appDataDirPath: appDataDir() }, agentVersion);
      const key = proofKey(agentVersion, input.modelId, input.nativeTool);
      const proofPath = key ? agentProofPath(key) : undefined;

      const opened = await client.request("session/new", {
        cwd,
        mcpServers: server ? [server] : [],
        // Request suppression; ACP does not attest to the generated catalog.
        disableBuiltInTools: true,
        disable_built_in_tools: true,
      }).finally(() => checkFallback(logFile, proofPath));
      const sessionId = String(opened?.sessionId ?? "");
      if (!sessionId) throw new Error("agy session/new returned no sessionId");
      cancelTarget = sessionId;
      const offeredModels = (opened?.models?.availableModels ?? [])
        .map((m: any) => m?.modelId)
        .filter((id: unknown): id is string => typeof id === "string" && id.length > 0);
      // This answer is the newest statement of what agy offers: adopt it for
      // this process and keep it for the next start.
      rememberOfferedFamilies(opened);

      const verify = process.env.PI_AGY_TETHER_VERIFY === "always"
        || !proofPath || !existsSync(proofPath);
      const desired = desiredConfig(input.modelId, input.thinkingLevel);
      let options = opened?.configOptions;
      const set = async (configId: string, value: string) => options = (await client.request(
        "session/set_config_option", { sessionId, configId, value },
      ))?.configOptions;
      const path = appDataDir();
      let lastPromptLabel = "None";
      let applied = await configureSession(set, desired, options, verify && input.oneShot === true);

      // `session/new` succeeds even when agy silently loads its stock agent.
      if (verify) {
        try {
          const label = modelLabel(options);
          const preflight = await requestPrompt(client, sessionId,
            [{ type: "text", text: "Reply with the tether session marker only." }],
            assemblyFor(path, lastPromptLabel, label), agentVersion, input.modelId);
          lastPromptLabel = label;
          checkFallback(logFile, proofPath);
          const problem = preflightProblem(preflightText) ?? markerProblem(preflightText, marker);
          if (problem) throw new Error(problem);
          if (preflight?.stopReason === "cancelled")
            throw new Error("agy cancelled the agent marker turn");
          if (proofPath) {
            try {
              writeFileSync(proofPath, "", { mode: 0o600 });
            } catch {
              /* disposable cache: failing to persist the marker only costs a check next time */
            }
          }
        } catch (error) {
          if (proofPath) {
            try {
              rmSync(proofPath, { force: true });
            } catch {
              /* disposable cache */
            }
          }
          throw error;
        }
        if (applied.effort !== desired.effort) applied = await verifyPromptConfig(set, desired);
      }

      // Check the linked credential by metadata only before exposing the session.
      if (verifyLogin) await verifyLogin();
      input.signal?.throwIfAborted();
      if (proc.signalCode) throw new Error(memory.describeKill(proc.signalCode));
      if (proc.exitCode !== null) throw new Error("agy exited during session setup");
      instance = new CliProcess(proc, client, input, ownedRecipe.preface, proofPath, path, modelLabel(options), lastPromptLabel, {
        sessionKey,
        agentVersion,
        offeredModels,
        marker,
        toolsPath,
        logFile,
        getStderr,
        describeKill: memory.describeKill,
      });
      instance.sessionId = sessionId;
      phase = "ready";
      live.add(instance);
      if (server) registerHandoffTarget(sessionKey, instance, input.tools.map(({ name }) => name));
      recordStatus({
        agentVersion,
        agentName: ownedRecipe.name,
        agentProof: verify ? "marker" : "cached",
        offeredModels,
        configured: { model: input.modelId, effort: applied.effort ?? "unset" },
        loginLinked: true,
      });

      proc.once("exit", (code, signal) => instance?.handleExit(code, signal));
      proc.once("error", (error) => instance?.fatal(error.message));

      return instance;
    } catch (error) {
      return disposeOnFailure(error);
    }
  }

  get alive(): boolean {
    return !this.retired && this.exitCode === null && this.exitSignal === null;
  }

  get hasPendingHandoffs(): boolean {
    return this.pending.size > 0;
  }

  get turnInFlight(): boolean {
    return this.promptInFlight;
  }

  stderr(): string {
    return this.getStderr();
  }

  diagnostic(message: string): void {
    this.fatal(message);
  }

  fatal(message: string): void {
    if (this.stagedCapture) this.stagedCapture.fail(message);
    else this.sink?.onFatal(message);
  }

  private guardMemory(message: string): void {
    if (!this.alive) return;
    this.memoryRetirement = message;
    const awaitingPiTool = this.hasPendingHandoffs;
    void this.retire(["memory_guard"]);
    if (this.sink || this.stagedCapture) this.fatal(message);
    else this.input.onProcessEvent?.(awaitingPiTool
      ? `${message} In-flight tool results cannot resume their blocked call.` : message);
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.exitSignal = signal;
    live.delete(this);
    unregisterHandoffTarget(this.sessionKey);
    if (this.retired) return;
    for (const [, call] of this.pending)
      call.respond({
        content: [{ type: "text", text: "agy exited before Pi answered this tool call" }],
        isError: true,
      });
    this.pending.clear();
    if (this.sink) this.sink.onClose(code, signal);
    else if (signal && !this.stagedCapture) this.input.onProcessEvent?.(this.describeKill(signal));
  }

  /**
   * ACP asks whether the model may run one tool call. Pi's authority is the
   * broker: authorize only the exact declared Pi proxy on the active ACP
   * session. Recipe settings about what agy should offer are not authority.
   */
  decidePermission(params: any): { outcome: "allowed" | "denied" } {
    const name = params?.toolCall?.name;
    const allowed = !this.retired && !this.stagedCapture && this.promptInFlight &&
      params?.sessionId === this.sessionId &&
      ((this.input.nativeTool !== undefined && name === this.input.nativeTool &&
        this.input.allowNativeArgs?.(params.toolCall) === true) ||
        this.input.tools.some(tool => name === `mcp_${MCP_SERVER_NAME}_${tool.name}`));
    return { outcome: allowed ? "allowed" : "denied" };
  }

  attach(sink: EpisodeSink): void {
    this.sink = sink;
    const buffered = this.buffered.splice(0);
    for (const item of buffered) {
      if (item.type === "update") sink.onUpdate(item.update);
      else if (item.type === "result") sink.onPromptResult(item.result);
    }
    const handoffs = this.handoffs.splice(0);
    for (const call of handoffs) sink.onHandoffCall(call);
  }

  detach(): void {
    this.sink = undefined;
  }

  private routeUpdate(update: any): void {
    const staged = this.stagedCapture;
    if (staged) {
      if (update?.sessionUpdate === "agent_message_chunk" && typeof update.content?.text === "string") {
        staged.text += update.content.text;
        const problem = gatewayRefusalProblem(staged.text);
        if (problem) {
          this.cancel();
          staged.fail(problem);
        }
      }
      return;
    }
    if (this.sink) this.sink.onUpdate(update);
    else this.buffered.push({ type: "update", update });
  }

  private routeResult(result: AcpPromptResult): void {
    this.promptInFlight = false;
    this.turnActive = false;
    if (this.sink) this.sink.onPromptResult(result);
    else this.buffered.push({ type: "result", result });
  }

  /** Broker callback: a Pi tool call is blocked and waiting for Pi. */
  onHandoffCall(invocation: HandoffInvocation): void {
    if (!this.alive || this.stagedCapture || !this.promptInFlight) {
      invocation.respond({ content: [{ type: "text", text: "Pi is not accepting tool calls; tool not executed" }], isError: true });
      return;
    }
    this.pending.set(invocation.piCallId, invocation);
    if (this.sink) this.sink.onHandoffCall(invocation);
    else this.handoffs.push(invocation);
  }

  /** Answer a blocked MCP call with Pi's tool result. */
  deliverHandoffResult(piCallId: string, result: HandoffResult): boolean {
    const call = this.pending.get(piCallId);
    if (!call) return false;
    this.pending.delete(piCallId);
    call.respond(result);
    return true;
  }

  canContinueHandoff(ids: string[]): boolean {
    return (
      ids.length > 0 &&
      ids.every((id) => this.pending.has(id)) &&
      this.pending.size === ids.length
    );
  }

  /** Verify live model and effort before a new prompt; never trust a default. */
  async ensureConfigured(thinkingLevel: string | undefined): Promise<void> {
    let options: readonly ConfigOption[] | undefined;
    await verifyPromptConfig(async (configId, value) => options = (await this.client.request(
      "session/set_config_option", { sessionId: this.sessionId, configId, value },
    ))?.configOptions, desiredConfig(this.modelId, thinkingLevel));
    this.currentModelLabel = modelLabel(options);
  }

  private nextAssembly(): TurnAssembly {
    return assemblyFor(this.appDataDirPath, this.lastPromptLabel, this.currentModelLabel, this.firstPromptPreface.join("\n"));
  }

  planTurns(messages: any[], toolCount: number) {
    return planTurns({ messages, toolCount, agentVersion: this.agentVersion, first: this.nextAssembly(), later: { appDataDirPath: this.appDataDirPath } });
  }

  private startPrompt(blocks: PromptBlock[]): Promise<AcpPromptResult> {
    if (this.promptInFlight) throw new Error("agy session already has a prompt in flight");
    checkFallback(this.logFile, this.proofPath);
    const result = requestPrompt(this.client, this.sessionId, blocks, this.nextAssembly(), this.agentVersion, this.modelId);
    this.promptInFlight = true;
    this.turnActive = true;
    this.firstPromptPreface = [];
    this.lastPromptLabel = this.currentModelLabel;
    return result.finally(() => checkFallback(this.logFile, this.proofPath));
  }

  /** A hidden context-only turn. Never buffer updates or allow a tool handoff. */
  async sendStagedPrompt(blocks: PromptBlock[], signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.sink || this.promptInFlight || this.stagedCapture)
      throw new Error("agy must be idle before staging context");
    let fail!: (message: string) => void;
    const failed = new Promise<never>((_, reject) => { fail = message => reject(new Error(message)); });
    const abort = () => { this.cancel(); fail("Request aborted"); };
    this.stagedCapture = { text: "", fail };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const result = await Promise.race([failed, this.startPrompt(blocks)]);
      signal?.throwIfAborted();
      if (result.stopReason !== "end_turn")
        throw new Error(`agy did not finish the staged context turn (${result.stopReason ?? "missing stop reason"})`);
    } finally {
      signal?.removeEventListener("abort", abort);
      this.stagedCapture = undefined;
      this.promptInFlight = false;
      this.turnActive = false;
    }
  }

  private promptUsage?: PromptUsage;

  handoffUsage(contextTokens?: number) {
    return this.promptUsage?.handoff(contextTokens) ?? acpUsage(undefined);
  }

  terminalUsage(usage: AcpPromptResult["usage"], contextTokens?: number) {
    const counts = this.promptUsage?.terminal(usage, contextTokens) ?? acpUsage(usage);
    this.promptUsage = undefined;
    return counts;
  }

  /** Send the final prompt; results and updates route to the attached episode. */
  sendPrompt(blocks: PromptBlock[]): void {
    // Baseline after marker and staging: never charge their steps to Pi turns.
    this.promptUsage = PromptUsage.begin(this.appDataDirPath, this.sessionId, this.agentVersion);
    void this.startPrompt(blocks)
      .then((result) => {
        if (this.retired) return;
        this.routeResult(result ?? {});
      })
      .catch((error) => {
        this.promptInFlight = false;
        this.turnActive = false;
        if (this.retired) return;
        this.sink?.onFatal(error instanceof Error ? error.message : String(error));
      });
  }

  /** Ask agy to cancel the running turn; the prompt terminal follows. */
  cancel(): void {
    if (!this.alive) return;
    try {
      this.client.notify("session/cancel", { sessionId: this.sessionId });
    } catch {
      /* the process is already gone; exit handling owns the message */
    }
  }

  async retire(reasons: string[] = []): Promise<void> {
    if (this.retired) return this.retirement;
    this.retired = true;
    this.retiredReasons = reasons;
    recordStatus({ lastRetirement: reasons });
    live.delete(this);
    unregisterHandoffTarget(this.sessionKey);
    for (const [, call] of this.pending)
      call.respond({
        content: [
          {
            type: "text",
            text: "Pi tether retired the session before answering this tool call",
          },
        ],
        isError: true,
      });
    this.pending.clear();
    this.client.dispose("agy tether session retired");
    if (this.exitCode === null && this.exitSignal === null)
      this.retirement = stopProcess(this.proc);
    return this.retirement;
  }

  retirementReasons(): string[] {
    return [...this.retiredReasons];
  }
}

/**
 * Keep a warm connection for the session's next call. There is no expiry of
 * our own: the next turn's signature/history mismatch retires it, and Pi's
 * session lifecycle events retire it explicitly.
 */
export function parkCliProcess(
  piSessionId: string,
  cli: CliProcess,
  cause: string,
): void {
  takeParkedCliProcess(piSessionId);
  parked.set(piSessionId, { cli, cause });
}

export function takeParkedCliProcess(
  piSessionId: string,
): CliProcess | undefined {
  const entry = parked.get(piSessionId);
  if (!entry) return undefined;
  parked.delete(piSessionId);
  return entry.cli;
}

export async function retireAllCliProcesses(reason: string): Promise<void> {
  // Only a real teardown invalidates in-flight calls. An ordinary
  // session_start with nothing to retire must not abort the turn that follows.
  const before = live.size + parked.size;
  for (const key of [...parked.keys()]) {
    const entry = parked.get(key);
    parked.delete(key);
    if (!entry) continue;
    await entry.cli.retire([reason, entry.cause]);
  }
  const all = [...live];
  await Promise.all(all.map((cli) => cli.retire([reason])));
  if (before > 0) lifecycle.invalidate();
}
