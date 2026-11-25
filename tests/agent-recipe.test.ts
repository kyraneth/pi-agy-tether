import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fallbackLogProblem,
  gatewayRefusalProblem,
  markerProblem,
  newMarker,
  recipePath,
  splitRefusedPrompt,
  writeAgentRecipe,
} from "../src/agent-recipe.js";

const mcpServer = {
  name: "pi",
  command: "/usr/bin/node",
  args: ["/pkg/mcp-schema-server.cjs", "/t/tools.json", "/t/handoff.sock", "sess-1", "/t/handoff.secret"],
};

function write(systemPrompt: string, marker = newMarker()) {
  const recipe = writeAgentRecipe({ sessionKey: randomUUID(), marker, systemPrompt, mcpServer });
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
    const { name, path, marker, text } = write("You are a coding assistant running inside pi.");
    expect(path).toBe(recipePath(name));
    expect(text).toContain(`name: ${name}`);
    expect(text).toContain("inheritMcp: false");
    expect(text).toContain("inheritCustomizations: false");
    expect(text).toContain("excludeDefaultComponents: true");
    expect(text).toContain("tools: []");
    expect(text).toContain(`Tether session marker: ${marker}`);
  });

  it("offers neither native tools nor an MCP server for a tool-less request", () => {
    const recipe = writeAgentRecipe({ sessionKey: randomUUID(), marker: newMarker(), systemPrompt: "Summarize." });
    const text = readFileSync(recipe.path, "utf8");
    expect(text).toContain("tools: []");
    expect(text).toContain("mcpServers: []");
    expect(text).toContain("Summarize.");
  });

  it("registers only the staged Pi tools as eager on the MCP server", () => {
    const recipe = writeAgentRecipe({
      sessionKey: randomUUID(),
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
    const recipe = writeAgentRecipe({
      sessionKey: randomUUID(),
      marker: newMarker(),
      systemPrompt: "prompt",
      mcpServer: { ...mcpServer, env: { PI_TETHER: "1" } },
    });
    const text = readFileSync(recipe.path, "utf8");
    expect(text).toContain("    env:\n      PI_TETHER: '1'");
  });

  it("carries Pi's prompt minus the refused lines, and returns them for the first turn", () => {
    const identity = "You are a coding assistant running inside pi, a coding agent harness.";
    const { text, preface } = write(`${identity}\n\nBody.`);
    expect(text).toContain("Body.");
    expect(text).not.toContain("running inside pi");
    expect(preface).toEqual([identity]);
    expect(text).toContain("Call Pi tools through the `pi` MCP server only");
  });
});

describe("private recipe ownership", () => {
  it("does not adopt or overwrite a directory it did not create", () => {
    const input = { sessionKey: randomUUID(), marker: newMarker(), systemPrompt: "first" };
    const recipe = writeAgentRecipe(input);
    expect(() => writeAgentRecipe({ ...input, systemPrompt: "second" })).toThrow(/EEXIST/);
    expect(readFileSync(recipe.path, "utf8")).toContain("\nfirst\n");
    recipe.dispose();
    expect(existsSync(recipe.path)).toBe(false);
  });
});

describe("markerProblem", () => {
  it("requires the marker alone, not a substring", () => {
    expect(markerProblem("PI_AGY_TETHER_abc123", "PI_AGY_TETHER_abc123")).toBeUndefined();
    expect(markerProblem("extra PI_AGY_TETHER_abc123", "PI_AGY_TETHER_abc123")).toMatch(/did not echo/);
  });

  it("reports the answer when the agent was not loaded", () => {
    expect(markerProblem("I am a different agent.", "PI_AGY_TETHER_abc123")).toMatch(
      /did not echo the exact session marker/,
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
