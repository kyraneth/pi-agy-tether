/**
 * Staging for the schema-only MCP server agy is given.
 *
 * agy never runs Pi's tools itself. It gets one MCP server named `pi` whose
 * `tools/list` is exactly the tools Pi's current request carries and whose
 * `tools/call` blocks on the local broker until Pi has executed the tool. The
 * schema is written per ACP session so two Pi sessions in one process can never
 * advertise each other's tool surface.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { existingSessionDir, sessionDir } from "./data-dir.js";
import type { McpServerEntry } from "./agent-recipe.js";

export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export interface SessionMcp {
  toolsPath: string;
  server: McpServerEntry;
}

const SERVER_PATH = fileURLToPath(new URL("./mcp-schema-server.cjs", import.meta.url));

export const MCP_SERVER_NAME = "pi";

export function writeToolSchema(
  sessionId: string,
  tools: readonly ToolDefinition[],
): string {
  const dir = sessionDir(sessionId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "tools.json");
  writeFileSync(path, JSON.stringify(tools, null, 1), { mode: 0o600 });
  return path;
}

/** The `mcpServers` entry handed to `session/new`. */
export function sessionMcpServer(input: {
  toolsPath: string;
  socketPath: string;
  sessionId: string;
  secretPath: string;
}): McpServerEntry {
  return {
    name: MCP_SERVER_NAME,
    command: process.execPath,
    args: [
      SERVER_PATH,
      input.toolsPath,
      input.socketPath,
      input.sessionId,
      input.secretPath,
    ],
    env: {},
  };
}

export function removeSessionFiles(sessionId: string): void {
  const dir = existingSessionDir(sessionId);
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* leftover staging is inert; the next spawn uses a fresh directory */
  }
}
