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
  AGENT_NAME,
  fallbackLogProblem,
  gatewayRefusalProblem,
  markerProblem,
  newMarker,
  proofKey,
  removeAgentRecipe,
  writeAgentRecipe,
} from "./agent-recipe.js";
import { sessionDir, tetherHome } from "./data-dir.js";
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
import { rememberOfferedFamilies } from "./model-discovery.js";
import { recordStatus } from "./cli-status.js";
import {
  captureStderr,
  forceKillProcess,
  preparePrivateConfig,
  registerProcess,
  spawnAgy,
} from "./process-manager.js";
import {
  configureSession,
  desiredConfig,
  verifyPromptConfig,
  type SessionConfig,
} from "./thinking-config.js";
import type { PromptBlock } from "./pi-context.js";

/** What an attached episode receives. */
export interface EpisodeSink {
  onUpdate(update: any): void;
  /** The ACP prompt terminal (`{stopReason, usage}`). */
  onPromptResult(result: AcpPromptResult): void;
  onHandoffCall(invocation: HandoffInvocation): void;
  onClose(code: number | null): void;
  onFatal(message: string): void;
}

export interface OpenInput {
  cwd: string;
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
}

const lifecycle = createLifecycleRevision();
export const getCliLifecycleRevision = lifecycle.current;

const live = new Set<CliProcess>();
const parked = new Map<string, { cli: CliProcess; cause: string }>();

function checkFallback(logFile: string, proofPath: string | undefined): void {
  const problem = fallbackLogProblem(logFile);
  if (!problem) return;
  if (proofPath) rmSync(proofPath, { force: true });
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

  private sink: EpisodeSink | undefined;
  private promptInFlight = false;
  private buffered: any[] = [];
  private handoffs: HandoffInvocation[] = [];
  private pending = new Map<string, HandoffInvocation>();
  private retiredReasons: string[] = [];
  private readonly getStderr: () => string;

  private constructor(
    readonly proc: ChildProcess,
    private readonly client: AcpClient,
    readonly input: OpenInput,
    private firstPromptPreface: string[],
    private readonly proofPath: string | undefined,
    init: {
      sessionKey: string;
      agentVersion: string;
      offeredModels: string[];
      marker: string;
      toolsPath: string;
      logFile: string;
      getStderr: () => string;
    },
  ) {
    this.sessionKey = init.sessionKey;
    this.agentVersion = init.agentVersion;
    this.offeredModels = init.offeredModels;
    this.marker = init.marker;
    this.toolsPath = init.toolsPath;
    this.logFile = init.logFile;
    this.getStderr = init.getStderr;
    this.signature = input.signature;
    this.modelId = input.modelId;
  }

  /**
   * Open a session: private config and login link, the workspace agent recipe,
   * ACP initialize/new, model and effort with readback, and a marker turn
   * if this binary and recipe format have no saved proof.
   */
  static async open(input: OpenInput): Promise<CliProcess> {
    const sessionKey = randomUUID();
    const toolsPath = writeToolSchema(sessionKey, input.tools);
    preparePrivateConfig();
    const verifyLogin = await linkHostLogin();
    const logFile = join(sessionDir(sessionKey), "agy.log");
    const marker = newMarker();
    const server = input.tools.length ? sessionMcpServer({
      toolsPath,
      socketPath: input.handoffSocket,
      sessionId: sessionKey,
      secretPath: handoffSecretFile(),
    }) : undefined;
    const recipe = writeAgentRecipe({
      cwd: input.cwd,
      marker,
      systemPrompt: input.systemPrompt,
      mcpServer: server,
      mcpToolNames: input.tools.map(({ name }) => name),
    });

    if (process.env.PI_AGY_TETHER_DUMP) {
      try {
        copyFileSync(recipe.path, join(process.env.PI_AGY_TETHER_DUMP, "agent.md"));
        copyFileSync(toolsPath, join(process.env.PI_AGY_TETHER_DUMP, "tools.json"));
      } catch {
        /* diagnostic only */
      }
    }
    const proc = spawnAgy({
      cwd: input.cwd,
      sessionId: sessionKey,
      logFile,
      signal: input.signal,
    });
    registerProcess(proc);
    const getStderr = captureStderr(proc);

    let phase: "open" | "ready" = "open";
    let preflightText = "";
    let cancelTarget: string | undefined;
    let instance: CliProcess | undefined;
    const client = new AcpClient(proc, {
      onUpdate(update) {
        if (phase === "open") {
          if (
            update?.sessionUpdate === "agent_message_chunk" &&
            typeof update.content?.text === "string"
          ) {
            preflightText += update.content.text;
            // agy retries a gateway refusal for minutes with backoff. The
            // refusal is already visible in the stream, so stop waiting for a
            // marker that will never arrive instead of holding Pi's turn open.
            if (cancelTarget && gatewayRefusalProblem(preflightText))
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
    });

    const disposeOnFailure = async (error: unknown): Promise<never> => {
      try {
        const keep = `${join(sessionDir(sessionKey), "failed.log")}`;
        writeFileSync(`${join(sessionDir(sessionKey), "failed.jsonl")}`,
          JSON.stringify({ error: error instanceof Error ? error.message : String(error), stderr: getStderr() }, null, 1));
        void keep;
        copyFileSync(logFile, join(tetherHome(), "failed-agy.log"));
      } catch {
        /* best-effort diagnostic */
      }
      client.dispose();
      forceKillProcess(proc);
      removeAgentRecipe(input.cwd, marker);
      removeSessionFiles(sessionKey);
      const detail = error instanceof Error ? error.message : String(error);
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
      const key = proofKey(agentVersion);
      const proofPath = key ? join(tetherHome(), `agent-proof-${key}`) : undefined;

      const opened = await client.request("session/new", {
        cwd: input.cwd,
        mcpServers: server ? [server] : [],
        // Proven probe parameter: never offer agy's own engine tools.
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
      const set = async (configId: string, value: string) => (await client.request(
        "session/set_config_option", { sessionId, configId, value },
      ))?.configOptions;
      let applied = await configureSession(set, desired, opened?.configOptions, verify && input.oneShot === true);

      // `session/new` succeeds even when agy silently loads its stock agent.
      if (verify) {
        try {
          const preflight = await client.request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: "Reply with the tether session marker only." }],
          });
          checkFallback(logFile, proofPath);
          const problem = gatewayRefusalProblem(preflightText) ?? markerProblem(preflightText, marker);
          if (problem) throw new Error(problem);
          if (preflight?.stopReason === "cancelled")
            throw new Error("agy cancelled the agent marker turn");
          if (proofPath) writeFileSync(proofPath, "", { mode: 0o600 });
        } catch (error) {
          if (proofPath) rmSync(proofPath, { force: true });
          throw error;
        }
        if (applied.effort !== desired.effort) applied = await verifyPromptConfig(set, desired);
      }

      instance = new CliProcess(proc, client, input, recipe.preface, proofPath, {
        sessionKey,
        agentVersion,
        offeredModels,
        marker,
        toolsPath,
        logFile,
        getStderr,
      });
      instance.sessionId = sessionId;
      phase = "ready";
      live.add(instance);
      if (server) registerHandoffTarget(sessionKey, instance);
      recordStatus({
        agentVersion,
        agentName: AGENT_NAME,
        agentProof: verify ? "marker" : "cached",
        offeredModels,
        configured: { model: input.modelId, effort: applied.effort ?? "unset" },
        loginLinked: true,
      });

      proc.once("exit", (code) => instance?.handleExit(code));
      proc.once("error", (error) => instance?.fatal(error.message));

      // Record the login link state for the caller's post-run check without
      // reading the credential. A refreshed token is metadata, not an incident.
      if (verifyLogin) await verifyLogin();
      return instance;
    } catch (error) {
      return disposeOnFailure(error);
    }
  }

  get alive(): boolean {
    return !this.retired && this.exitCode === null;
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
    this.sink?.onFatal(message);
  }

  fatal(message: string): void {
    this.sink?.onFatal(message);
  }

  private handleExit(code: number | null): void {
    this.exitCode = code;
    live.delete(this);
    unregisterHandoffTarget(this.sessionKey);
    if (this.retired) return;
    for (const [, call] of this.pending)
      call.respond({
        content: [{ type: "text", text: "agy exited before Pi answered this tool call" }],
        isError: true,
      });
    this.pending.clear();
    this.sink?.onClose(code);
  }

  /**
   * ACP asks whether the model may run one tool call. Pi's authority is the
   * broker: allow only a call whose tool is delivered to Pi's handoff, deny
   * everything else. Vendor tools are excluded by the agent recipe, so a denial
   * here is a safety net, not a normal path.
   */
  decidePermission(params: any): { outcome: "allowed" | "denied" } {
    const toolCall = params?.toolCall;
    const directPrefix = `mcp_${MCP_SERVER_NAME}_`;
    // Eager calls have a qualified name, but no ServerName in their arguments.
    if (typeof toolCall?.name === "string" && toolCall.name.startsWith(directPrefix)) {
      const name = toolCall.name.slice(directPrefix.length);
      return {
        outcome: params.sessionId === this.sessionId && this.input.tools.some((tool) => tool.name === name)
          ? "allowed" : "denied",
      };
    }
    const server = toolCall?.rawInput?.ServerName ?? toolCall?.args?.ServerName;
    if (server === MCP_SERVER_NAME) return { outcome: "allowed" };
    // Named MCP routing may arrive without a ServerName; the broker still
    // rejects an undeclared tool, so allow the exact Pi proxy by its title.
    if (typeof toolCall?.title === "string" && /MCP Tool/i.test(toolCall.title))
      return { outcome: "allowed" };
    return { outcome: "denied" };
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
  async ensureConfigured(thinkingLevel: string | undefined): Promise<SessionConfig> {
    return verifyPromptConfig(async (configId, value) => (await this.client.request(
      "session/set_config_option", { sessionId: this.sessionId, configId, value },
    ))?.configOptions, desiredConfig(this.modelId, thinkingLevel));
  }

  /** Send one prompt; results and updates route to the attached episode. */
  sendPrompt(blocks: PromptBlock[]): void {
    if (this.promptInFlight)
      throw new Error("agy session already has a prompt in flight");
    this.promptInFlight = true;
    this.turnActive = true;
    const prompt = this.firstPromptPreface.length
      ? [{ type: "text", text: this.firstPromptPreface.join("\n") }, ...blocks]
      : blocks;
    this.firstPromptPreface = [];
    void Promise.resolve()
      .then(() => {
        checkFallback(this.logFile, this.proofPath);
        return this.client.request("session/prompt", { sessionId: this.sessionId, prompt })
          .finally(() => checkFallback(this.logFile, this.proofPath));
      })
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
    if (this.retired) return;
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
    forceKillProcess(this.proc);
    removeAgentRecipe(this.input.cwd, this.marker);
    removeSessionFiles(this.sessionKey);
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
