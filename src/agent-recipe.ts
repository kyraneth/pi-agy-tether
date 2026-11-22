/**
 * The workspace-local agent agy is asked to load, and the marker that proves it
 * did.
 *
 * agy can return a successful `session/new` for an unknown agent while logging
 * `Agent "..." not found, falling back to default`. The
 * tether therefore does three things for every ACP session it opens:
 *
 *   1. writes the proven explicit-only recipe into the workspace
 *      (`.agents/agents/pi-local-explicit/agent.md`);
 *   2. asks the loaded agent to echo a per-session marker and refuses when the
 *      exact marker does not come back;
 *   3. refuses when the agy log reports the fallback.
 *
 * The recipe uses
 * `excludeDefaultComponents`, no inherited MCP or customizations, no vendor
 * tools, and one explicitly declared `pi` MCP server that only proxies to Pi.
 */

import { mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

export const AGENT_NAME = "pi-local-explicit";
export const AGENT_RELATIVE_PATH = join(
  ".agents",
  "agents",
  AGENT_NAME,
  "agent.md",
);

// Bump when the on-disk agent format or its binding instructions change.
const RECIPE_FORMAT = 1;

/** Private pass filename for the version reported by this binary's handshake. */
export function proofKey(agentVersion: string): string | undefined {
  if (!agentVersion.trim() || agentVersion === "unknown") return undefined;
  return createHash("sha256").update(JSON.stringify([agentVersion, RECIPE_FORMAT])).digest("hex");
}

/** Per-session instruction marker; unique so a stale agent cannot answer it. */
export function newMarker(): string {
  return `PI_AGY_TETHER_${randomBytes(6).toString("hex")}`;
}

/**
 * Antigravity's gateway answers some system prompts with RESOURCE_EXHAUSTED
 * (429) instead of a completion, deterministically for the same prompt text.
 * The identical text can be answered when it arrives as a user message.
 * These passages are moved, not rewritten:
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
}

export function splitRefusedPrompt(text: string): SplitPrompt {
  const kept: string[] = [];
  const preface: string[] = [];
  let inDocs = false;
  for (const line of text.split("\n")) {
    if (!inDocs && DOCS_OPEN.test(line)) {
      inDocs = true;
      continue;
    }
    if (inDocs) {
      if (DOCS_CLOSE.test(line)) inDocs = false;
      else preface.push(line);
      continue;
    }
    if (INSIDE_PI.test(line)) preface.push(line);
    else kept.push(line);
  }
  return { systemPrompt: kept.join("\n"), preface };
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
  cwd: string;
  marker: string;
  /** Pi's own system prompt; replaces the vendor agent instructions. */
  systemPrompt: string;
  mcpServer?: McpServerEntry;
  /** Pi's staged tool names, configured in the recipe (not the ACP transport entry). */
  mcpToolNames?: readonly string[];
}

export interface WrittenRecipe {
  path: string;
  /** What the recipe body says, i.e. Pi's prompt minus the refused lines. */
  systemPrompt: string;
  /** The refused lines, unchanged, for the first prompt of the session. */
  preface: string[];
}

export function recipePath(cwd: string): string {
  return join(cwd, AGENT_RELATIVE_PATH);
}

/**
 * Write the recipe. The body is Pi's system prompt (the vendor's own prompt is
 * excluded by the frontmatter), followed by the tether's fixed instructions and
 * the marker sentence.
 */
export function writeAgentRecipe(input: RecipeInput): WrittenRecipe {
  const { systemPrompt, preface } = splitRefusedPrompt(input.systemPrompt);
  const path = recipePath(input.cwd);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const server = input.mcpServer;
  const env = Object.entries(server?.env ?? {});
  const lines = [
    "---",
    `name: ${AGENT_NAME}`,
    "description: Pi-owned model runtime with explicit-only MCP",
    "mainAgent: true",
    "subagent: false",
    "excludeDefaultComponents: true",
    "inheritMcp: false",
    "inheritCustomizations: false",
    "tools: []",
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
      // agy 1.5.12's lazy call_mcp_tool spills text above 10,240 bytes.
      // Direct MCP calls kept the full Pi read usable in one model step, even
      // when agy still persisted a copy. Use its documented eager registration:
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
    server
      ? "Pi supplies and executes every tool. Call Pi tools through the `pi` MCP server only; do not use native task, resource, command or browser features."
      : "No tools are available for this request.",
    `Tether session marker: ${input.marker}. When asked to confirm which instructions are loaded, reply with exactly that marker and nothing else.`,
    "",
  ];
  writeFileSync(path, lines.join("\n"), { mode: 0o600 });
  return { path, systemPrompt, preface };
}

/** Remove this session's recipe; leaves anything the workspace already had. */
export function removeAgentRecipe(cwd: string, marker?: string): void {
  const path = recipePath(cwd);
  try {
    // Another Pi session in the same workspace may have rewritten it since.
    if (marker) {
      const current = readFileSync(path, "utf8");
      if (!current.includes(marker)) return;
    }
    rmSync(path, { force: true });
    // rmdir only succeeds on an empty directory, so a workspace that already
    // had its own agents keeps them; we remove only what this recipe created.
    let dir = dirname(path);
    while (dir !== cwd && dir.startsWith(cwd)) {
      try {
        rmdirSync(dir);
      } catch {
        break;
      }
      dir = dirname(dir);
    }
  } catch {
    /* a leftover directory is harmless; the next spawn rewrites the file */
  }
}

/**
 * undefined when the agent answered with its marker; otherwise the reason the
 * session cannot be trusted with Pi's history.
 */
export function markerProblem(
  responseText: string,
  marker: string,
): string | undefined {
  if (responseText.includes(marker)) return undefined;
  const seen = responseText.trim().slice(0, 200);
  return `agy did not echo the ${AGENT_NAME} session marker (got ${JSON.stringify(seen)}); the requested agent was not loaded`;
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
