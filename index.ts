/**
 * Pi extension entry point for pi-agy-tether.
 *
 * Registers a custom provider that routes LLM calls through Google's official
 * `agy acp` server (ACP / JSON-RPC over stdio), and gives agy Pi's tools through
 * the handoff broker so Pi remains the only tool executor and history owner.
 */

import { registerApiDispatch } from "pi-tether-core/register";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { streamViaAcp } from "./src/provider.js";
import { agyModels, setAgyCatalog } from "./src/cli-catalog.js";
import { probeStartup, startupCatalog } from "./src/model-discovery.js";
import { cliStatusLine, recordStatus } from "./src/cli-status.js";
import { addStartupNotice, takeStartupNotices } from "./src/startup-notices.js";
import { killAllProcesses, validateCliPresence } from "./src/process-manager.js";
import { startHandoffBroker, stopHandoffBroker } from "./src/handoff-broker.js";
import { cleanupRuntimeDir } from "./src/runtime-dir.js";
import { retireAllCliProcesses } from "./src/cli-process.js";
import { rewriteOverflowMessage } from "./src/overflow.js";
import { piContext } from "./src/pi-context.js";
import type { ToolDefinition } from "./src/mcp-config.js";
import { PROVIDER_ID } from "./src/event-bridge.js";

process.on("exit", killAllProcesses);
process.on("exit", () => void stopHandoffBroker());
process.on("exit", cleanupRuntimeDir);
process.on("beforeExit", () => {
  void retireAllCliProcesses("beforeExit");
});

/** The broker socket is started once, on the first request that needs tools. */
let handoffSocket: string | undefined;
let handoffSocketAttempted = false;
async function ensureHandoffSocket(): Promise<string> {
  if (handoffSocket) return handoffSocket;
  if (handoffSocketAttempted)
    throw new Error("agy tether handoff broker failed to start earlier in this process");
  handoffSocketAttempted = true;
  handoffSocket = await startHandoffBroker();
  return handoffSocket;
}

/** Deliver load-time configuration notices where the user can see them. */
function flushStartupNotices(ctx: unknown): void {
  const c = ctx as
    | { hasUI?: boolean; ui?: { notify?: (m: string, l: string) => void } }
    | undefined;
  for (const message of takeStartupNotices()) {
    if (c?.hasUI && c.ui?.notify)
      c.ui.notify(`pi-agy-tether: ${message}`, "warning");
    else console.warn(`[pi-agy-tether] ${message}`);
  }
}

export default async function (pi: ExtensionAPI) {
  pi.on("session_start", (_event: unknown, ctx: unknown) => flushStartupNotices(ctx));

  try {
    const binary = validateCliPresence();
    recordStatus({ binary });

    // Pi needs the rows before it lists or resolves a model, and agy keeps no
    // catalog on disk, so the first start asks the build once and later starts
    // read what it answered (src/model-discovery.ts).
    const startup = await startupCatalog();
    setAgyCatalog(startup.families);

    const streamFn = (
      model: Parameters<typeof streamViaAcp>[0],
      context: Parameters<typeof streamViaAcp>[1],
      options?: Parameters<typeof streamViaAcp>[2],
    ) =>
      streamViaAcp(model, context, {
        ...options,
        prepareMcp: async (effectiveContext) => {
          const toolDefs: ToolDefinition[] = piContext(effectiveContext).tools.map(
            (t: any) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.parameters,
            }),
          );
          return {
            tools: toolDefs,
            handoffSocket: toolDefs.length ? await ensureHandoffSocket() : "",
          };
        },
      });

    const providerConfig = (models: any[]) => ({
      baseUrl: "pi-agy-tether",
      apiKey: "unused",
      api: PROVIDER_ID,
      models,
      streamSimple: streamFn,
    });

    // Pi's provider catalog and its legacy api dispatch are separate registries;
    // print mode and nested agent loops take the second one.
    registerApiDispatch(PROVIDER_ID, streamFn);

    // Image input is Pi-visible model metadata, so it is declared from the
    // installed build's own ACP answer: text-only until that handshake says the
    // build accepts images.
    pi.registerProvider(PROVIDER_ID, providerConfig(agyModels({ images: startup.image })));
    if (startup.image === undefined) {
      void probeStartup(false).then(({ image }) => {
        if (image)
          pi.registerProvider(PROVIDER_ID, providerConfig(agyModels({ images: true })));
      });
    }

    // Pi's own overflow recovery needs its recognized prefix.
    (pi.on as any)("message_end", (event: any, ctx: any) =>
      rewriteOverflowMessage(
        event?.message ?? {},
        PROVIDER_ID,
        ctx?.model?.provider,
      ),
    );

    // Pi's cache refresher would send a real extra turn through agy; decline
    // refreshes for this provider only (other providers keep their decision).
    pi.on("cache_warming_decision", (_event, ctx) => {
      if (ctx.model?.provider === PROVIDER_ID) return { action: "stop" as const };
    });

    pi.registerCommand("agy-cli", {
      description:
        "Show the agy ACP session facts: client version, loaded agent marker, offered models, login link",
      handler: async (_args, ctx) => {
        ctx.ui.notify(cliStatusLine(), "info");
      },
    });

    pi.on("session_start", async () => {
      await retireAllCliProcesses("session_start");
    });
    const retire = async (event: { type: string }) => {
      await retireAllCliProcesses(event.type);
    };
    pi.on("model_select", retire);
    // Pi routes its tool-less summarization request through the provider.
    // The changed request opens a fresh agy session; once Pi commits its
    // summary, discard all ACP state and import only the compacted projection.
    pi.on("session_compact", retire);
    pi.on("session_tree", retire);
    pi.on("session_shutdown", async (event: { type: string }) => {
      await retire(event);
      await killAllProcesses();
      await stopHandoffBroker();
    });
  } catch (err) {
    addStartupNotice(
      err instanceof Error ? err.message : String(err),
    );
    flushStartupNotices(undefined);
    console.error(`[pi-agy-tether] Failed to register provider:`, err);
  }
}
