import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_NAME,
  fallbackLogProblem,
  gatewayRefusalProblem,
  markerProblem,
  newMarker,
  recipePath,
  removeAgentRecipe,
  splitRefusedPrompt,
  writeAgentRecipe,
} from "../src/agent-recipe.js";

const mcpServer = {
  name: "pi",
  command: "/usr/bin/node",
  args: ["/pkg/mcp-schema-server.cjs", "/t/tools.json", "/t/handoff.sock", "sess-1", "/t/handoff.secret"],
};

function write(cwd: string, systemPrompt: string, marker = newMarker()) {
  const recipe = writeAgentRecipe({ cwd, marker, systemPrompt, mcpServer });
  return { ...recipe, marker, text: readFileSync(recipe.path, "utf8") };
}

describe("splitRefusedPrompt", () => {
  it("takes the identity claim agy's gateway refuses out of the system prompt", () => {
    // Pi's default opening; agy answers it with RESOURCE_EXHAUSTED (429) as a
    // system instruction and answers it normally as user text.
    const line =
      "You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.";
    const { systemPrompt, preface } = splitRefusedPrompt(`${line}\nBe concise.`);
    expect(systemPrompt).toBe("Be concise.");
    expect(preface).toEqual([line]);
  });

  it("takes Pi's docs section out, verbatim, without its wrapper tags", () => {
    const { systemPrompt, preface } = splitRefusedPrompt(
      [
        "Read the tools.",
        "<docs>",
        "Read only when the user asks about the harness:",
        "- Main documentation: /pkg/README.md",
        "- Examples: /pkg/examples (extensions, SDK)",
        "</docs>",
        "Keep working.",
      ].join("\n"),
    );
    expect(systemPrompt).toBe("Read the tools.\nKeep working.");
    expect(preface).toEqual([
      "Read only when the user asks about the harness:",
      "- Main documentation: /pkg/README.md",
      "- Examples: /pkg/examples (extensions, SDK)",
    ]);
  });

  it("leaves ordinary prompt text untouched", () => {
    const text = "You are running inside pi.\nRun tests before committing.";
    const { systemPrompt, preface } = splitRefusedPrompt(text);
    expect(systemPrompt).toBe(text);
    expect(preface).toEqual([]);
  });

  it("finds both passages in a Pi-shaped prompt, in order", () => {
    const { systemPrompt, preface } = splitRefusedPrompt(
      [
        "You are a coding assistant running inside pi, a coding agent harness.",
        "Rules follow.",
        "<docs>",
        "- Main documentation: /pkg/README.md",
        "</docs>",
      ].join("\n"),
    );
    expect(systemPrompt).toBe("Rules follow.");
    expect(preface).toEqual([
      "You are a coding assistant running inside pi, a coding agent harness.",
      "- Main documentation: /pkg/README.md",
    ]);
  });
});

describe("writeAgentRecipe", () => {
  it("writes the explicit-only recipe with a mapping env", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pat-recipe-"));
    const { path, marker, text } = write(cwd, "You are a coding assistant running inside pi.");
    expect(path).toBe(recipePath(cwd));
    expect(text).toContain("name: pi-local-explicit");
    expect(text).toContain("inheritMcp: false");
    expect(text).toContain("inheritCustomizations: false");
    expect(text).toContain("excludeDefaultComponents: true");
    expect(text).toContain("tools: []");
    expect(text).toContain(`Tether session marker: ${marker}`);
  });

  it("offers neither native tools nor an MCP server for a tool-less request", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pat-recipe-"));
    const recipe = writeAgentRecipe({ cwd, marker: newMarker(), systemPrompt: "Summarize." });
    const text = readFileSync(recipe.path, "utf8");
    expect(text).toContain("tools: []");
    expect(text).toContain("mcpServers: []");
    expect(text).toContain("Summarize.");
  });

  it("registers only the staged Pi tools as eager on the MCP server", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pat-recipe-"));
    const recipe = writeAgentRecipe({
      cwd,
      marker: newMarker(),
      systemPrompt: "prompt",
      mcpServer,
      mcpToolNames: ["read", "image_tool"],
    });
    const text = readFileSync(recipe.path, "utf8");
    expect(text).toContain("\ntools: []\n");
    expect(text).toContain("    tools:\n      'read': { eager: true }\n      'image_tool': { eager: true }\n");
  });

  it("writes env entries as a YAML mapping, never a list", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pat-recipe-"));
    const recipe = writeAgentRecipe({
      cwd,
      marker: newMarker(),
      systemPrompt: "prompt",
      mcpServer: { ...mcpServer, env: { PI_TETHER: "1" } },
    });
    const text = readFileSync(recipe.path, "utf8");
    expect(text).toContain("    env:\n      PI_TETHER: '1'");
  });

  it("carries Pi's prompt minus the refused lines, and returns them for the first turn", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pat-recipe-"));
    const identity = "You are a coding assistant running inside pi, a coding agent harness.";
    const { text, preface } = write(cwd, `${identity}\n\nBody.`);
    expect(text).toContain("Body.");
    expect(text).not.toContain("running inside pi");
    expect(preface).toEqual([identity]);
    expect(text).toContain("Call Pi tools through the `pi` MCP server only");
  });
});

describe("removeAgentRecipe", () => {
  it("removes this session's recipe and the directories it created", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pat-recipe-"));
    const { path, marker } = write(cwd, "prompt");
    removeAgentRecipe(cwd, marker);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(cwd, ".agents"))).toBe(false);
  });

  it("keeps a workspace's own agents", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pat-recipe-"));
    const other = join(cwd, ".agents", "agents", "team-agent");
    mkdirSync(other, { recursive: true });
    const { marker } = write(cwd, "prompt");
    removeAgentRecipe(cwd, marker);
    expect(existsSync(join(other, "agent.md"))).toBe(false);
    expect(existsSync(other)).toBe(true);
  });

  it("keeps a recipe another Pi session rewrote", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pat-recipe-"));
    const { path } = write(cwd, "prompt", newMarker());
    removeAgentRecipe(cwd, "PI_AGY_TETHER_from_another_session");
    expect(existsSync(path)).toBe(true);
  });
});

describe("markerProblem", () => {
  it("accepts an answer that contains the marker", () => {
    expect(markerProblem("PI_AGY_TETHER_abc123", "PI_AGY_TETHER_abc123")).toBeUndefined();
  });

  it("reports the answer when the agent was not loaded", () => {
    expect(markerProblem("I am a different agent.", "PI_AGY_TETHER_abc123")).toMatch(
      /did not echo the pi-local-explicit session marker/,
    );
  });
});

describe("gatewayRefusalProblem", () => {
  it("names a gateway content refusal instead of a missing marker", () => {
    const text =
      "\n⚠ API error (attempt 1): RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).";
    expect(gatewayRefusalProblem(text)).toMatch(/refused this prompt with RESOURCE_EXHAUSTED/);
    expect(gatewayRefusalProblem(text)).toMatch(/not a quota or a Pi failure/);
  });

  it("stays quiet for ordinary answers and real quota errors", () => {
    expect(gatewayRefusalProblem("PI_AGY_TETHER_abc123")).toBeUndefined();
    expect(gatewayRefusalProblem("429 too many requests")).toBeUndefined();
  });
});

describe("fallbackLogProblem", () => {
  it("treats a missing log as no evidence", () => {
    expect(fallbackLogProblem(join(mkdtempSync(join(tmpdir(), "pat-log-")), "none.log"))).toBeUndefined();
  });

  it("reports agy's own fallback line", () => {
    const dir = mkdtempSync(join(tmpdir(), "pat-log-"));
    const log = join(dir, "agy.log");
    writeFileSync(log, 'I1118 01:00:00 server.go:1] Agent "pi-local-explicit" not found, falling back to default\n');
    expect(fallbackLogProblem(log)).toMatch(/refusing to run Pi's history on the default agent/);
  });

  it("stays quiet for an ordinary log", () => {
    const dir = mkdtempSync(join(tmpdir(), "pat-log-"));
    const log = join(dir, "agy.log");
    writeFileSync(log, "I1118 01:00:00 server.go:1] Auth succeeded\n");
    expect(fallbackLogProblem(log)).toBeUndefined();
  });
});

describe("agent name", () => {
  it("is the recipe directory the tether writes and asks for", () => {
    expect(AGENT_NAME).toBe("pi-local-explicit");
  });
});
