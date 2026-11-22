import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { MCP_SERVER_NAME, removeSessionFiles, sessionMcpServer, writeToolSchema } from "../src/mcp-config.js";
import { sessionDir } from "../src/data-dir.js";

const tools = [
  { name: "read", description: "Read file contents", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
  { name: "write", inputSchema: { type: "object" } },
];

describe("writeToolSchema", () => {
  it("writes the current request's tool surface privately", () => {
    const path = writeToolSchema("sess-a", tools);
    expect(path).toBe(`${sessionDir("sess-a")}/tools.json`);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(tools);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("keeps two sessions' surfaces apart", () => {
    writeToolSchema("sess-a", tools);
    writeToolSchema("sess-b", [tools[0]]);
    expect(JSON.parse(readFileSync(writeToolSchema("sess-a", tools), "utf8"))).toHaveLength(2);
    expect(JSON.parse(readFileSync(`${sessionDir("sess-b")}/tools.json`, "utf8"))).toHaveLength(1);
  });
});

describe("sessionMcpServer", () => {
  it("describes the schema-only server agy is given", () => {
    const entry = sessionMcpServer({
      toolsPath: "/t/tools.json",
      socketPath: "/t/handoff.sock",
      sessionId: "sess-a",
      secretPath: "/t/handoff.secret",
    });
    expect(entry.name).toBe(MCP_SERVER_NAME);
    expect(entry.name).toBe("pi");
    expect(entry.command).toBe(process.execPath);
    expect(entry.args?.slice(1)).toEqual(["/t/tools.json", "/t/handoff.sock", "sess-a", "/t/handoff.secret"]);
    expect(entry.args?.[0]).toMatch(/mcp-schema-server\.cjs$/);
  });
});

describe("removeSessionFiles", () => {
  it("removes the session's staging and tolerates absence", () => {
    writeToolSchema("sess-c", tools);
    removeSessionFiles("sess-c");
    expect(existsSync(sessionDir("sess-c"))).toBe(false);
    expect(() => removeSessionFiles("sess-c")).not.toThrow();
  });
});
