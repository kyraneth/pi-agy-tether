/**
 * Pi extension entry point for pi-agy-tether.
 *
 * Registers a custom provider that routes LLM calls through Google's official
 * `agy acp` server (ACP / JSON-RPC over stdio), and gives agy Pi's tools through
 * the handoff broker so Pi remains the only tool executor and history owner.
 */

import { registerApiDispatch } from "pi-tether-core/register";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { streamViaAcp } from "./src/provider.js";
import { agyModels, setAgyCatalog } from "./src/cli-catalog.js";
import { probeStartup, startupCatalog } from "./src/model-discovery.js";
import { cliStatusLine, recordStatus } from "./src/cli-status.js";
import { killAllProcesses, validateCliPresence } from "./src/process-manager.js";
import { memoryGuardDoctor } from "./src/agy-memory.js";
import { startHandoffBroker, stopHandoffBroker } from "./src/handoff-broker.js";
import { cleanupRuntimeDir } from "./src/runtime-dir.js";
import { retireAllCliProcesses } from "./src/cli-process.js";
import { rewriteOverflowMessage } from "./src/overflow.js";
import { piContext } from "./src/pi-context.js";
import type { ToolDefinition } from "./src/mcp-config.js";
import { PROVIDER_ID } from "./src/event-bridge.js";
import { RESULT_NOTICE_ENTRY, strictTransport, transportDoctor, type ResultLossNotice } from "./src/degradations.js";
import {
  NATIVE_SEARCH_ENTRY, NATIVE_SEARCH_NOTICE, NATIVE_SEARCH_NOTICE_ENTRY, nativeSearchEnabled, nativeSearchLabel,
  type NativeSearchQuery, type NativeSearchSurface,
} from "./src/native-search.js";

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

/** Deliver actionable events in the UI, or to stderr without a UI. */
function notifyPi(ctx: { hasUI: boolean; ui: { notify: (message: string, type: "warning") => void } } | undefined, message: string): void {
  if (ctx?.hasUI) ctx.ui.notify(`pi-agy-tether: ${message}`, "warning");
  else console.warn(`[pi-agy-tether] ${message}`);
}

export default async function (pi: ExtensionAPI) {
  let notify: (message: string) => void = (message) => notifyPi(undefined, message);
  let recordResultNotice: ((notice: ResultLossNotice) => void) | undefined;
  let recordUsageUnavailable: (() => void) | undefined;
  let search: NativeSearchSurface | undefined;
  const displayNativeSearch = nativeSearchEnabled() && !strictTransport();
  if (displayNativeSearch) {
    pi.registerEntryRenderer(NATIVE_SEARCH_NOTICE_ENTRY, () => new Text(NATIVE_SEARCH_NOTICE, 1, 0));
    pi.registerEntryRenderer<NativeSearchQuery>(NATIVE_SEARCH_ENTRY, (entry) => entry.data ? new Text(nativeSearchLabel(entry.data), 1, 0) : undefined);
  }
  pi.on("session_start", (_event, ctx) => {
    notify = (message) => notifyPi(ctx, message);
    const sessionId = ctx.sessionManager.getSessionId();
    const entries = ctx.sessionManager.getEntries();
    if (displayNativeSearch) {
      let announced = entries.some(entry => entry.type === "custom" && entry.customType === NATIVE_SEARCH_NOTICE_ENTRY &&
        (entry.data as { sessionId?: string } | undefined)?.sessionId === sessionId);
      const surface: NativeSearchSurface = {
        announce() {
          if (search !== surface || announced) return;
          announced = true;
          pi.appendEntry(NATIVE_SEARCH_NOTICE_ENTRY, { sessionId, message: NATIVE_SEARCH_NOTICE });
          if (!ctx.hasUI) console.warn(NATIVE_SEARCH_NOTICE);
        },
        record(entry) {
          if (search !== surface) return;
          pi.appendEntry(NATIVE_SEARCH_ENTRY, entry);
          if (!ctx.hasUI) console.warn(nativeSearchLabel(entry));
        },
      };
      search = surface;
    }
    recordResultNotice = (notice) => pi.appendEntry(RESULT_NOTICE_ENTRY, { ...notice, sessionId });
    const usageEntry = "pi-agy-tether:usage-unavailable";
    let loggedUsage = entries.some(entry => entry.type === "custom" && entry.customType === usageEntry);
    recordUsageUnavailable = () => {
      if (loggedUsage) return;
      loggedUsage = true;
      pi.appendEntry(usageEntry, { message: "agy spend could not be attributed to a Pi assistant message. Usage and cost are unavailable; totalTokens is context occupancy." });
    };
  });

  pi.registerCommand("agy-doctor", {
    description: "Show agy transport, memory guard and diagnostic log settings",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`${transportDoctor()}\n${memoryGuardDoctor()}`, "info");
    },
  });

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
        notify,
        recordResultNotice,
        recordUsageUnavailable,
        search,
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

    if (process.env.PI_AGY_TETHER_IMAGE_TOOL === "1") {
      const { registerImageTool } = await import("./src/image-tool.js");
      registerImageTool(pi);
    }

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
    notify(err instanceof Error ? err.message : String(err));
    console.error(`[pi-agy-tether] Failed to register provider:`, err);
  }
}
