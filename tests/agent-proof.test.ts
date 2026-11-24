import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proofKey, recipePath } from "../src/agent-recipe.js";
import { CliProcess, retireAllCliProcesses, takeParkedCliProcess } from "../src/cli-process.js";
import { historyHash } from "../src/pi-context.js";
import { streamViaAcp } from "../src/provider.js";
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
let onStage: (() => void) | undefined;
let stageFault: "refusal" | "cancelled" | "rpc" | undefined;
let permissions: object[];
let cancels: number;

function fakeAgy(input: Parameters<typeof spawnAgy>[0]): ReturnType<typeof spawnAgy> {
  recipe = readFileSync(recipePath(input.cwd), "utf8");
  const proc = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null, killed: false,
    kill() { proc.killed = true; proc.emit("exit", 0); return true; },
  });
  const frame = (message: object) => proc.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  proc.stdin.on("data", (data) => {
    const { method, id, params, result } = JSON.parse(data.toString());
    if (id === "permission") { permissions.push(result); return; }
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
      const staged = params.prompt.some((b: PromptBlock) => b.type === "text" && b.text.includes("More context follows before the final request"));
      if (staged) {
        frame({ id: "permission", method: "session/request_permission", params: { sessionId: "fake", toolCall: { title: "MCP Tool" } } });
        onStage?.();
        if (stageFault === "rpc") { frame({ id, error: { message: "stage rejected" } }); return; }
      }
      const text = isMarker && outcome !== "mismatch"
        ? recipe.match(/Tether session marker: (\w+)/)?.[1]
        : staged ? (stageFault === "refusal" ? "RESOURCE_EXHAUSTED (429)" : "STAGED ACK") : "OK";
      frame({ method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
      frame({ method: "session/update", params: { update: { sessionUpdate: "usage_update", used: staged ? 500 : 1000 } } });
      if (!staged || stageFault !== "refusal") frame({ id, result: { stopReason: staged && stageFault === "cancelled" ? "cancelled" : "end_turn" } });
    } else if (method === "session/set_config_option") {
      frame({ id, result: { configOptions: [
        { id: "model", currentValue: "gemini-4-hydrogen", options: [{ value: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" }] },
        { id: "thought_level", currentValue: "high", options: [{ value: "high", name: "High" }] },
      ] } });
    } else if (method === "session/cancel") cancels++;
    else throw new Error(`Unexpected fake ACP method ${method}`);
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
  onStage = undefined;
  stageFault = undefined;
  permissions = [];
  cancels = 0;
  vi.mocked(spawnAgy).mockImplementation(fakeAgy);
});

afterEach(async () => {
  await retireAllCliProcesses("test_finished");
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

  it("refuses at the ACP boundary without sending any prompt or consuming the preface", async () => {
    await (await open()).retire();
    const cli = await open();
    prompts = [];
    expect(() => cli.sendPrompt([{ type: "text", text: "x".repeat(200000) }])).toThrow(/192,000/);
    expect(prompts).toEqual([]);
    await send(cli);
    expect(prompts[0]).toEqual([{ type: "text", text: preface }, ...realPrompt]);
  });

  const model = { id: "gemini-4-hydrogen", provider: "pi-agy-tether", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as any;
  const oversizedHistory = [{ role: "user", content: "a".repeat(100000) }, { role: "user", content: "b".repeat(100000) }];
  const run = (messages: any[], signal?: AbortSignal) =>
    streamViaAcp(model, { messages }, { cwd, reasoning: "high", sessionId: "pi", signal });

  it("stages history without leaking text, usage or permission, then checkpoints the final result", async () => {
    await (await open()).retire();
    prompts = [];
    const stream = run(oversizedHistory);
    const events = [];
    for await (const event of stream) events.push(event);
    const output = await stream.result();
    expect(prompts).toHaveLength(2);
    expect(permissions).toEqual([{ outcome: { outcome: "cancelled" } }]);
    expect(events.filter(e => e.type === "text_delta").map(e => e.delta)).toEqual(["OK"]);
    expect(output.usage.totalTokens).toBe(1000);
    expect(output.content).toEqual([{ type: "text", text: "OK" }]);
    const cli = takeParkedCliProcess("pi");
    expect(cli?.piHistory).toEqual({ length: 3, hash: historyHash([...oversizedHistory, output]) });
  });

  it("rejects an MCP handoff while staging instead of queuing it for Pi", async () => {
    const cli = await open();
    const respond = vi.fn();
    onStage = () => cli.onHandoffCall({ name: "read", piCallId: "fake-call", arguments: {}, respond });
    await cli.sendStagedPrompt([{ type: "text", text: "More context follows before the final request" }]);
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ isError: true }));
    expect(cli.hasPendingHandoffs).toBe(false);
  });

  it.each(["refusal", "cancelled", "rpc", "abort"] as const)("does not send the final turn after staged %s", async (fault) => {
    await (await open()).retire();
    prompts = [];
    const controller = new AbortController();
    if (fault === "abort") onStage = () => controller.abort();
    else stageFault = fault;
    const output = await run(oversizedHistory, controller.signal).result();
    expect(output.stopReason).toBe(fault === "abort" ? "aborted" : "error");
    expect(prompts).toHaveLength(1);
    expect(takeParkedCliProcess("pi")).toBeUndefined();
    if (fault === "refusal" || fault === "abort") expect(cancels).toBe(1);
  });

  it("re-parks an unchanged warm transcript on pre-send refusal and reuses it on retry", async () => {
    await (await open()).retire();
    prompts = [];
    const first = { role: "user", content: "hello" };
    const output = await run([first]).result();
    const huge = await run([first, output, { role: "user", content: "x".repeat(200000) }]).result();
    expect(huge.errorMessage).toMatch(/192,000 bytes/);
    expect(huge.content).toEqual([]);
    expect(prompts).toHaveLength(1);
    const retry = await run([first, output, huge, { role: "user", content: "small retry" }]).result();
    expect(retry.stopReason).toBe("stop");
    expect(prompts).toEqual([[{ type: "text", text: "USER:" }, { type: "text", text: "hello" }], [{ type: "text", text: "USER:" }, { type: "text", text: "small retry" }]]);
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
