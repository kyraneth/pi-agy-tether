import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proofKey, recipePath } from "../src/agent-recipe.js";
import { CliProcess } from "../src/cli-process.js";
import { spawnAgy } from "../src/process-manager.js";
import type { PromptBlock } from "../src/pi-context.js";

vi.mock("../src/login.js", () => ({ linkHostLogin: async () => undefined }));
vi.mock("../src/process-manager.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/process-manager.js")>(),
  spawnAgy: vi.fn(),
}));

const markerPrompt = [{ type: "text", text: "Reply with the tether session marker only." }];
const preface = "You are an assistant running inside Pi.\n  Read these docs verbatim.  ";
const realPrompt: PromptBlock[] = [{ type: "text", text: "USER:" }, { type: "text", text: "Hello" }];
const fallbackLine = 'Agent "pi-local-explicit" not found, falling back to default\n';
let cwd: string;
let version: string;
let outcome: "ok" | "mismatch" | "fallback-on-open" | "fallback-on-prompt";
let prompts: PromptBlock[][];
let recipe: string;
let live: CliProcess[];

function fakeAgy(input: Parameters<typeof spawnAgy>[0]): ReturnType<typeof spawnAgy> {
  recipe = readFileSync(recipePath(input.cwd), "utf8");
  const proc = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null, killed: false,
    kill() { proc.killed = true; proc.emit("exit", 0); return true; },
  });
  const frame = (message: object) => proc.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  proc.stdin.on("data", (data) => {
    const { method, id, params } = JSON.parse(data.toString());
    if (method === "initialize") frame({ id, result: { agentInfo: { version } } });
    else if (method === "session/new") {
      if (outcome === "fallback-on-open") writeFileSync(input.logFile, fallbackLine);
      frame({ id, result: { sessionId: "fake", configOptions: [
        { id: "model", currentValue: "gemini-4-hydrogen", options: [{ value: "gemini-4-hydrogen" }] },
        { id: "thought_level", currentValue: "high", options: [{ value: "high" }] },
      ] } });
    } else if (method === "session/prompt") {
      prompts.push(params.prompt);
      const isMarker = params.prompt.some((b: PromptBlock) => b.type === "text" && b.text === markerPrompt[0].text);
      if (!isMarker && outcome === "fallback-on-prompt") writeFileSync(input.logFile, fallbackLine);
      const text = isMarker && outcome !== "mismatch"
        ? recipe.match(/Tether session marker: (\w+)/)?.[1] : "OK";
      frame({ method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text } } } });
      frame({ id, result: { stopReason: "end_turn" } });
    } else throw new Error(`Unexpected fake ACP method ${method}`);
  });
  return proc as unknown as ReturnType<typeof spawnAgy>;
}

async function open() {
  const cli = await CliProcess.open({
    cwd, modelId: "gemini-4-hydrogen", thinkingLevel: "high",
    systemPrompt: "You are an assistant running inside Pi.\nKeep this.\n<docs>\n  Read these docs verbatim.  \n</docs>",
    tools: [], signature: "fake", handoffSocket: "",
  });
  live.push(cli);
  return cli;
}

function send(cli: CliProcess) {
  return new Promise<void>((resolve, reject) => {
    cli.attach({ onUpdate() {}, onHandoffCall() {}, onClose() {}, onPromptResult: () => resolve(), onFatal: (m) => reject(new Error(m)) });
    cli.sendPrompt(realPrompt);
  });
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pat-proof-"));
  version = "1.5.12";
  outcome = "ok";
  prompts = [];
  live = [];
  vi.mocked(spawnAgy).mockImplementation(fakeAgy);
});

afterEach(async () => {
  await Promise.all(live.map((cli) => cli.retire()));
  vi.unstubAllEnvs();
  rmSync(cwd, { recursive: true, force: true });
});

describe("versioned agent proof over ACP", () => {
  it("skips proof after a pass and verifies a different binary version", async () => {
    await (await open()).retire();
    expect(prompts).toEqual([markerPrompt]);
    await (await open()).retire();
    expect(prompts).toEqual([markerPrompt]);
    version = "1.5.13";
    await open();
    expect(prompts).toEqual([markerPrompt, markerPrompt]);
  });

  it("always verifies with the flag, and a failed forced proof invalidates the pass", async () => {
    await (await open()).retire();
    vi.stubEnv("PI_AGY_TETHER_VERIFY", "always");
    await (await open()).retire();
    expect(prompts).toEqual([markerPrompt, markerPrompt]);
    outcome = "mismatch";
    await expect(open()).rejects.toThrow(/did not echo/);
    vi.unstubAllEnvs();
    outcome = "ok";
    await open();
    expect(prompts).toEqual([markerPrompt, markerPrompt, markerPrompt, markerPrompt]);
  });

  it.each(["fallback-on-open", "fallback-on-prompt"] as const)("invalidates a cached pass on %s", async (when) => {
    await (await open()).retire();
    outcome = when;
    if (when === "fallback-on-open") {
      await expect(open()).rejects.toThrow(/falling back to default/);
      expect(prompts).toEqual([markerPrompt]);
    } else {
      const cli = await open();
      await expect(send(cli)).rejects.toThrow(/falling back to default/);
      await cli.retire();
      expect(prompts.at(-1)).not.toEqual(markerPrompt);
    }
    outcome = "ok";
    await open();
    expect(prompts.at(-1)).toEqual(markerPrompt);
  });

  it("opens and runs when the data home is read-only with no saved proof", async () => {
    const roHome = mkdtempSync(join(tmpdir(), "pat-ro-home-"));
    chmodSync(roHome, 0o500);
    vi.stubEnv("PI_AGY_TETHER_HOME", roHome);
    try {
      const cli = await open();
      expect(prompts).toEqual([markerPrompt]);
      await send(cli);
      await cli.retire();
      expect(readdirSync(roHome)).toEqual([]);
    } finally {
      chmodSync(roHome, 0o700);
      rmSync(roHome, { recursive: true, force: true });
    }
  });

  it("skips the marker when a read-only data home already holds the proof", async () => {
    const roHome = mkdtempSync(join(tmpdir(), "pat-ro-home-"));
    const key = proofKey(version);
    expect(key).toBeDefined();
    writeFileSync(join(roHome, `agent-proof-${key}`), "");
    chmodSync(roHome, 0o500);
    vi.stubEnv("PI_AGY_TETHER_HOME", roHome);
    try {
      await (await open()).retire();
      expect(prompts).toEqual([]);
    } finally {
      chmodSync(roHome, 0o700);
      rmSync(roHome, { recursive: true, force: true });
    }
  });

  it("moves refused lines verbatim to the first real prompt, with or without a marker", async () => {
    const first = [{ type: "text", text: preface }, ...realPrompt];
    for (const expectedMarker of [true, false]) {
      prompts = [];
      const cli = await open();
      expect(recipe).toContain("Keep this.");
      expect(recipe).not.toContain("running inside Pi");
      expect(recipe).not.toContain("Read these docs");
      await send(cli);
      await send(cli);
      expect(prompts).toEqual([...(expectedMarker ? [markerPrompt] : []), first, realPrompt]);
      await cli.retire();
    }
  });
});
