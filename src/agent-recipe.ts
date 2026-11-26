/**
 * The private agent agy is asked to load, and the marker that proves it
 * did.
 *
 * agy can return a successful `session/new` for an unknown agent while logging
 * `Agent "..." not found, falling back to default`. The
 * tether therefore does three things for every ACP session it opens:
 *
 *   1. writes an explicit-only recipe into the private Gemini home;
 *   2. asks the loaded agent to echo a per-session marker and refuses when the
 *      exact marker does not come back;
 *   3. refuses when the agy log reports the fallback.
 *
 * The recipe uses
 * `excludeDefaultComponents`, no inherited MCP or customizations, and either
 * the Pi MCP surface plus zero or one explicitly allowed native tool.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { geminiDir } from "./data-dir.js";

// Bump when agent discovery, format or binding instructions change.
const RECIPE_FORMAT = 4;

/** Private pass filename for the version reported by this binary's handshake. */
export type NativeTool = "generate_image" | "search_web";

export function proofKey(agentVersion: string, modelId: string, nativeTool?: NativeTool): string | undefined {
  if (!agentVersion.trim() || agentVersion === "unknown") return undefined;
  return createHash("sha256").update(JSON.stringify([agentVersion, RECIPE_FORMAT, modelId, ...(nativeTool ? [nativeTool] : [])])).digest("hex");
}

/** Per-session instruction marker; unique so a stale agent cannot answer it. */
export function newMarker(): string {
  return `PI_AGY_TETHER_${randomBytes(6).toString("hex")}`;
}

/**
 * Antigravity's gateway answers some system prompts with RESOURCE_EXHAUSTED
 * (429) instead of a completion, deterministically for the same prompt text.
 * The identical text can be answered when it arrives as a user message.
 * These passages are moved verbatim; the docs delimiters are omitted:
 *
 *  - the preamble sentence that claims the model is running inside Pi;
 *  - Pi's docs-pointer lines, which Pi renders as its `<docs>` section.
 *
 * `splitRefusedPrompt` takes those lines out of the system instruction
 * unchanged, and the tether sends them, unchanged, at the start of the first
 * real prompt of every new ACP session (src/cli-process.ts). Nothing else about the
 * prompt is rewritten, and no user message is touched.
 */
const INSIDE_PI = /\bYou are\s+(?:a|an)\s+[^.\n]*\brunning inside pi\b/i;
const DOCS_OPEN = /^<docs>$/;
const DOCS_CLOSE = /^<\/docs>$/;

export interface SplitPrompt {
  /** Pi's prompt with the refused lines removed. */
  systemPrompt: string;
  /** The exact refused lines, in their original order. */
  preface: string[];
  /** Structural labels for the Pi notice; never expose the instruction text. */
  changes: string[];
}

export function splitRefusedPrompt(text: string): SplitPrompt {
  const kept: string[] = [];
  const preface: string[] = [];
  let inDocs = false;
  let removedDocsMarkers = false;
  let movedDocs = false;
  let movedIdentity = false;
  for (const line of text.split("\n")) {
    if (!inDocs && DOCS_OPEN.test(line)) {
      inDocs = true;
      removedDocsMarkers = true;
      continue;
    }
    if (inDocs) {
      if (DOCS_CLOSE.test(line)) inDocs = false;
      else {
        preface.push(line);
        movedDocs = true;
      }
      continue;
    }
    if (INSIDE_PI.test(line)) {
      preface.push(line);
      movedIdentity = true;
    } else kept.push(line);
  }
  const changes = [];
  if (movedIdentity) changes.push('the "running inside Pi" line');
  if (movedDocs) changes.push("the lines inside <docs> (delimiters omitted)");
  else if (removedDocsMarkers) changes.push("the empty <docs> delimiters were omitted");
  return { systemPrompt: kept.join("\n"), preface, changes };
}

function yamlScalar(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export interface McpServerEntry {
  name: string;
  command: string;
  args: string[];
  /** Mapping, exactly the shape the qualified recipe used (`KEY: value`). */
  env?: Record<string, string>;
}

export interface RecipeInput {
  sessionKey: string;
  marker: string;
  /** Pi's own system prompt; replaces the vendor agent instructions. */
  systemPrompt: string;
  mcpServer?: McpServerEntry;
  nativeTool?: NativeTool;
  /** Pi's staged tool names, configured in the recipe (not the ACP transport entry). */
  mcpToolNames?: readonly string[];
}

export interface WrittenRecipe {
  name: string;
  path: string;
  dispose(): void;
  /** What the recipe body says, i.e. Pi's prompt minus the refused lines. */
  systemPrompt: string;
  /** The refused lines, unchanged, for the first prompt of the session. */
  preface: string[];
}

export function recipePath(name: string): string {
  return join(geminiDir(), "config", "agents", name, "agent.md");
}

/**
 * Write the recipe. The body is Pi's system prompt (the vendor's own prompt is
 * excluded by the frontmatter), followed by the tether's fixed instructions and
 * the marker sentence.
 */
export function writeAgentRecipe(input: RecipeInput): WrittenRecipe {
  const { systemPrompt, preface } = splitRefusedPrompt(input.systemPrompt);
  const name = `pi-session-${input.sessionKey}`;
  const path = recipePath(name);
  const server = input.mcpServer;
  const env = Object.entries(server?.env ?? {});
  const lines = [
    "---",
    `name: ${name}`,
    "description: Pi-owned model runtime with explicit-only MCP",
    "mainAgent: true",
    "subagent: false",
    "excludeDefaultComponents: true",
    "inheritMcp: false",
    "inheritCustomizations: false",
    `tools: [${input.nativeTool ?? ""}]`,
    "disabledTools: [list_resources, read_resource, manage_task]",
    "skills: []",
    "plugins: []",
    "agents: []",
    "commandExecutionPolicy: sandbox",
    ...(server ? [
      "mcpServers:",
      `  - name: ${yamlScalar(server.name)}`,
      `    command: ${yamlScalar(server.command)}`,
      "    args:",
      ...server.args.map((arg) => `      - ${yamlScalar(arg)}`),
      // Eager registration avoids the lazy spill-file detour. It does not
      // make the model-visible result lossless: agy still wraps and clips it.
      // Use its documented eager registration:
      // https://antigravity.google/docs/mcp/#configure-eager-tools
      ...(input.mcpToolNames?.length
        ? ["    tools:", ...input.mcpToolNames.map((name) => `      ${yamlScalar(name)}: { eager: true }`)]
        : []),
      ...(env.length
        ? ["    env:", ...env.map(([key, value]) => `      ${key}: ${yamlScalar(value)}`)]
        : []),
    ] : ["mcpServers: []"]),
    "---",
    systemPrompt,
    "",
    input.nativeTool === "search_web"
      ? `${server ? "Call Pi tools only through the `pi` MCP server. " : ""}Native search_web is permitted for the actual user request, never for a tether marker or a context-only turn. Do not use other native tools.`
      : server
        ? "Pi supplies and executes every tool. Call Pi tools through the `pi` MCP server only; do not use native task, resource, command or browser features."
        : input.nativeTool
          ? `The only tool you may use is the explicitly enabled native ${input.nativeTool}. Do not use native task, resource, command or browser features.`
          : "No tools are available for this request.",
    `Tether session marker: ${input.marker}. When asked to confirm which instructions are loaded, reply with exactly that marker and nothing else.`,
    "",
  ];
  const dir = dirname(path);
  mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
  mkdirSync(dir, { mode: 0o700 }); // exclusive: never adopt another session's directory
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Private runtime shutdown owns any remaining files. */
    }
  };
  try {
    writeFileSync(path, lines.join("\n"), { mode: 0o600, flag: "wx" });
  } catch (error) {
    dispose();
    throw error;
  }
  return { name, path, systemPrompt, preface, dispose };
}

/**
 * undefined when the agent answered with its marker; otherwise the reason the
 * session cannot be trusted with Pi's history.
 */
export function markerProblem(
  responseText: string,
  marker: string,
): string | undefined {
  if (responseText.trim() === marker) return undefined;
  const seen = responseText.trim().slice(0, 200);
  return `agy did not echo the exact session marker (got ${JSON.stringify(seen)}); cannot verify the requested agent was loaded`;
}

/**
 * agy reports a gateway content refusal in the same shape as a rate limit. It
 * is not a quota, not transient, and not something Pi should retry or compact
 * away, so the marker turn names it instead of reporting a missing marker.
 */
const GATEWAY_REFUSAL =
  /(?:RESOURCE_EXHAUSTED|A[Pp][Ii] error \(attempt \d+\):[^\n]*\b429\b)/;

export function gatewayRefusalProblem(text: string): string | undefined {
  if (!GATEWAY_REFUSAL.test(text)) return undefined;
  return `agy's gateway refused this prompt with RESOURCE_EXHAUSTED (429) instead of answering. That is a vendor content decision, not a quota or a Pi failure, and the tether does not retry it as transient. Rewording the refused instruction usually gets an answer.`;
}

const FALLBACK = /Agent\s+"[^"]*"\s+not found,\s*falling back to default/i;

/** The official log line that proves agy ignored the requested agent. */
export function fallbackLogProblem(logPath: string): string | undefined {
  let log: string;
  try {
    log = readFileSync(logPath, "utf8");
  } catch {
    return undefined; // no log yet is not evidence of a fallback
  }
  const line = log
    .split("\n")
    .find((candidate) => FALLBACK.test(candidate));
  return line
    ? `agy reported ${JSON.stringify(line.trim())}; refusing to run Pi's history on the default agent`
    : undefined;
}
