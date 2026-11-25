import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proofKey, recipePath } from "../src/agent-recipe.js";
import { CliProcess, retireAllCliProcesses, takeParkedCliProcess } from "../src/cli-process.js";
import { FALLBACK_FAMILIES, familyRow, setAgyCatalog } from "../src/cli-catalog.js";
import { agentProofPath } from "../src/data-dir.js";
import { historyHash } from "../src/pi-context.js";
import { streamViaAcp } from "../src/provider.js";
import { startHandoffBroker, stopHandoffBroker } from "../src/handoff-broker.js";
import { spawnAgy } from "../src/process-manager.js";
import type { PromptBlock } from "../src/pi-context.js";

vi.mock("../src/login.js", () => ({ linkHostLogin: async () => undefined }));
vi.mock("../src/process-manager.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/process-manager.js")>(),
  spawnAgy: vi.fn(),
}));

const hydrogen = "gemini-4-hydrogen";
const sonnet = "claude-sonnet-5-5";
const oss = "gpt-oss-120b-medium";
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
let blockRealPrompt: boolean;
let stageFault: "refusal" | "cancelled" | "rpc" | undefined;
let permissions: object[];
let cancels: number;
let killOnPrompt: boolean;

function fakeAgy(input: Parameters<typeof spawnAgy>[0]): ReturnType<typeof spawnAgy> {
  const loadedRecipe = readFileSync(recipePath(input.agentName), "utf8");
  recipe = loadedRecipe;
  const proc = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null, killed: false,
    kill() { proc.killed = true; proc.emit("exit", 0); return true; },
  });
  let model = hydrogen;
  const configOptions = () => [
    { id: "model", currentValue: model, options: [hydrogen, sonnet, oss].map(value => ({ value, name: value })) },
    ...(model === oss ? [] : [{ id: "thought_level", currentValue: "high", options: [{ value: "high" }] }]),
  ];
  const frame = (message: object) => proc.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  proc.stdin.on("data", (data) => {
    const { method, id, params, result } = JSON.parse(data.toString());
    if (id === "permission") { permissions.push(result); return; }
    if (method === "initialize") frame({ id, result: { agentInfo: { version } } });
    else if (method === "session/new") {
      if (outcome === "fallback-on-open") writeFileSync(input.logFile, fallbackLine);
      frame({ id, result: { sessionId: "fake", configOptions: configOptions() } });
    } else if (method === "session/prompt") {
      prompts.push(params.prompt);
      const isMarker = params.prompt.some((b: PromptBlock) => b.type === "text" && b.text === markerPrompt[0].text);
      if (!isMarker && killOnPrompt) {
        queueMicrotask(() => proc.emit("exit", null, "SIGKILL"));
        return;
      }
      if (!isMarker && blockRealPrompt) return;
      if (!isMarker && outcome === "fallback-on-prompt") writeFileSync(input.logFile, fallbackLine);
      const staged = params.prompt.some((b: PromptBlock) => b.type === "text" && b.text.includes("More context follows before the final request"));
      if (staged) {
        frame({ id: "permission", method: "session/request_permission", params: { sessionId: "fake", toolCall: { title: "MCP Tool" } } });
        onStage?.();
        if (stageFault === "rpc") { frame({ id, error: { message: "stage rejected" } }); return; }
      }
      const text = isMarker && outcome !== "mismatch"
        ? loadedRecipe.match(/Tether session marker: (\w+)/)?.[1]
        : staged ? (stageFault === "refusal" ? "RESOURCE_EXHAUSTED (429)" : "STAGED ACK") : "OK";
      frame({ method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
      frame({ method: "session/update", params: { update: { sessionUpdate: "usage_update", used: staged ? 500 : 1000 } } });
      if (!staged || stageFault !== "refusal") frame({ id, result: { stopReason: staged && stageFault === "cancelled" ? "cancelled" : "end_turn" } });
    } else if (method === "session/set_config_option") {
      if (params.configId === "model") model = params.value;
      frame({ id, result: { configOptions: configOptions() } });
    } else if (method === "session/cancel") cancels++;
    else throw new Error(`Unexpected fake ACP method ${method}`);
  });
  return proc as unknown as ReturnType<typeof spawnAgy>;
}

async function open(modelId = hydrogen, extra: Partial<Parameters<typeof CliProcess.open>[0]> = {}) {
  const cli = await CliProcess.open({
    cwd, modelId, thinkingLevel: modelId === oss ? undefined : "high",
    systemPrompt: "You are an assistant running inside Pi.\nKeep this.\n<docs>\n  Read these docs verbatim.  \n</docs>",
    tools: [], signature: "fake", handoffSocket: "", ...extra,
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
  blockRealPrompt = false;
  stageFault = undefined;
  permissions = [];
  cancels = 0;
  killOnPrompt = false;
  vi.mocked(spawnAgy).mockClear().mockImplementation(fakeAgy);
  setAgyCatalog([...FALLBACK_FAMILIES, familyRow({ id: oss, name: oss, effortLevels: [] })]);
});

afterEach(async () => {
  await retireAllCliProcesses("test_finished");
  await Promise.all(live.map((cli) => cli.retire()));
  await stopHandoffBroker();
  vi.unstubAllEnvs();
  setAgyCatalog(FALLBACK_FAMILIES);
  rmSync(cwd, { recursive: true, force: true });
});

describe("versioned agent proof over ACP", () => {
  it("leaves an existing workspace recipe byte-for-byte untouched", async () => {
    const path = join(cwd, ".agents", "agents", "pi-local-explicit", "agent.md");
    mkdirSync(join(path, ".."), { recursive: true });
    const bytes = Buffer.from("Existing recipe — leave exactly as is.\n");
    writeFileSync(path, bytes, { mode: 0o640 });
    const before = statSync(path);
    const cli = await open();
    await send(cli);
    await cli.retire();
    expect(readFileSync(path)).toEqual(bytes);
    const after = statSync(path);
    expect([after.ino, after.mode, after.mtimeMs]).toEqual([before.ino, before.mode, before.mtimeMs]);
  });
  it("isolates interleaved recipes and never creates workspace agent directories", async () => {
    const handoffSocket = await startHandoffBroker();
    const [first, second] = await Promise.all([
      open(hydrogen, { handoffSocket, systemPrompt: "first", tools: [{ name: "one", description: "one", inputSchema: {} }] }),
      open(hydrogen, { handoffSocket, systemPrompt: "second", tools: [{ name: "two", description: "two", inputSchema: {} }] }),
    ]);
    const [one, two] = vi.mocked(spawnAgy).mock.calls.map(([input]) => recipePath(input.agentName));
    expect(one).not.toBe(two);
    expect(readFileSync(one, "utf8")).toContain("\nfirst\n");
    expect(readFileSync(one, "utf8")).toContain("'one': { eager: true }");
    expect(readFileSync(two, "utf8")).toContain("\nsecond\n");
    expect(readFileSync(two, "utf8")).toContain("'two': { eager: true }");
    await second.retire();
    expect(existsSync(two)).toBe(false);
    expect(existsSync(one)).toBe(true);
    await first.retire();
    expect(existsSync(one)).toBe(false);
    expect(existsSync(join(cwd, ".agents"))).toBe(false);
  });

  it("does not follow workspace symlinks even on spawn and handshake failure", async () => {
    const outside = join(cwd, "outside-workspace");
    const sentinel = join(outside, "agents", "pi-local-explicit", "agent.md");
    mkdirSync(join(sentinel, ".."), { recursive: true });
    writeFileSync(sentinel, "untouched");
    symlinkSync(outside, join(cwd, ".agents"), "dir");
    vi.mocked(spawnAgy).mockImplementationOnce(() => { throw new Error("spawn failed"); });
    await expect(open()).rejects.toThrow("spawn failed");
    outcome = "fallback-on-open";
    await expect(open()).rejects.toThrow(/falling back/);
    expect(readFileSync(sentinel, "utf8")).toBe("untouched");
    for (const [input] of vi.mocked(spawnAgy).mock.calls)
      expect(existsSync(recipePath(input.agentName))).toBe(false);
  });

  it("skips proof after a pass and verifies a different binary version", async () => {
    await (await open()).retire();
    expect(prompts).toEqual([markerPrompt]);
    await (await open()).retire();
    expect(prompts).toEqual([markerPrompt]);
    version = "1.5.13";
    await open();
    expect(prompts).toEqual([markerPrompt, markerPrompt]);
  });

  it("never uses a passing Hydrogen proof to open Sonnet", async () => {
    await (await open()).retire();
    const hydrogenKey = proofKey(version, hydrogen)!;
    const sonnetKey = proofKey(version, sonnet)!;
    expect.soft(hydrogenKey).not.toBe(sonnetKey);
    outcome = "mismatch";
    await expect(open(sonnet)).rejects.toThrow(/did not echo/);
    expect(prompts).toEqual([markerPrompt, markerPrompt]);
    expect(existsSync(agentProofPath(sonnetKey))).toBe(false);
    expect(existsSync(agentProofPath(hydrogenKey))).toBe(true);
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
    const key = proofKey(version, hydrogen);
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
  const image = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };

  it("refuses an outgoing GPT-OSS image block without a session/prompt frame", async () => {
    const cli = await open(oss);
    prompts = [];
    expect(() => cli.sendPrompt([image])).toThrow(/gpt-oss-120b-medium.*text-only/);
    expect(prompts).toEqual([]);
  });

  it("refuses image-bearing history on a cold GPT-OSS turn before opening ACP", async () => {
    const output = await streamViaAcp({ ...model, id: oss }, {
      messages: [
        { role: "user", content: [image], timestamp: 0 },
        { role: "user", content: "What is 2+2?", timestamp: 1 },
      ],
    }, { cwd }).result();
    expect(output.errorMessage).toMatch(/gpt-oss-120b-medium.*text-only/);
    expect(spawnAgy).not.toHaveBeenCalled();
    expect(prompts).toEqual([]);
  });

  it("retires a blocked GPT-OSS tool call without delivering its image result", async () => {
    blockRealPrompt = true;
    const respond = vi.fn();
    const original = CliProcess.prototype.sendPrompt;
    const send = vi.spyOn(CliProcess.prototype, "sendPrompt").mockImplementation(function (this: CliProcess, blocks) {
      original.call(this, blocks);
      this.onHandoffCall({ name: "capture", piCallId: "fake-call", arguments: {}, respond });
    });
    try {
      const run = (messages: any[]) => streamViaAcp({ ...model, id: oss }, { messages }, { cwd, sessionId: "oss" }).result();
      const user = { role: "user", content: "Use the capture tool", timestamp: 0 };
      const assistant = await run([user]);
      expect(assistant.stopReason).toBe("toolUse");
      const result = await run([user, assistant, {
        role: "toolResult", toolCallId: "fake-call", toolName: "capture",
        content: [image], timestamp: 1, isError: false,
      }]);
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toMatch(/gpt-oss-120b-medium.*text-only/);
      expect(respond).toHaveBeenCalledExactlyOnceWith({
        content: [{ type: "text", text: "Pi tether retired the session before answering this tool call" }],
        isError: true,
      });
      expect(prompts).toHaveLength(2); // Marker and original user turn only.
      expect(takeParkedCliProcess("oss")).toBeUndefined();
    } finally {
      send.mockRestore();
    }
  });

  it.each([false, true])("handles the system role workaround with strict=%s", async (strict) => {
    vi.stubEnv("PI_AGY_TETHER_STRICT", strict ? "1" : "0");
    const notify = vi.fn();
    const user = { role: "user", content: "hello" };
    const system = "You are an assistant running inside Pi.\nKeep this.\n<docs>\n  Read these docs verbatim.  \n</docs>";
    const run = (messages: any[]) => streamViaAcp(model, { messages }, {
      cwd, sessionId: `system-role-${strict}`, notify,
      onPayload: () => ({ messages, system }),
    }).result();
    const output = await run([user]);
    if (strict) {
      expect(output.errorMessage).toMatch(/cannot preserve the Pi system role.*running inside Pi.*<docs>/);
      expect(spawnAgy).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    } else {
      expect(output.stopReason).toBe("stop");
      expect(prompts[1]?.[0]).toEqual({ type: "text", text: preface });
      expect(recipe).toContain("Keep this.");
      expect((await run([user, output, user])).stopReason).toBe("stop");
      expect(notify.mock.calls.flat().filter(m => m.includes("system lines"))).toEqual([
        'agy moved Pi system lines to the first user prompt: the "running inside Pi" line and the lines inside <docs> (delimiters omitted).',
      ]);
    }
  });

  it.each([false, true])("handles explicit generation controls with strict=%s", async (strict) => {
    vi.stubEnv("PI_AGY_TETHER_STRICT", strict ? "1" : "0");
    const notify = vi.fn();
    const user = { role: "user", content: "hello" };
    const options = {
      cwd, sessionId: `controls-${strict}`, notify,
      temperature: 0, maxTokens: 1, toolChoice: "none" as const,
    };
    const output = await streamViaAcp(model, { messages: [user] }, options).result();
    if (strict) {
      expect(output.errorMessage).toMatch(/cannot honor explicit generation controls: temperature, maxTokens, toolChoice/);
      expect(spawnAgy).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    } else {
      expect(output.stopReason).toBe("stop");
      const next = await streamViaAcp(model, { messages: [user, output, user] }, options).result();
      expect(next.stopReason).toBe("stop");
      expect(notify.mock.calls.flat().filter(m => m.includes("generation controls"))).toEqual([
        "agy ignored explicit generation controls: temperature, maxTokens, toolChoice.",
      ]);
    }
  });

  it.each([false, true])("handles unverifiable declarations after onPayload with strict=%s", async (strict) => {
    vi.stubEnv("PI_AGY_TETHER_STRICT", strict ? "1" : "0");
    const notify = vi.fn();
    const context = { messages: [{ role: "user", content: "hello" }] };
    const options = {
      cwd, sessionId: `catalog-${strict}`, notify,
      onPayload: () => ({ ...context, tools: [{ name: "read", parameters: { type: "object" } }] }),
    };
    const output = await streamViaAcp(model, context, options).result();
    if (strict) {
      expect(output.errorMessage).toMatch(/cannot verify the exact Pi tool catalog/);
      expect(spawnAgy).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    } else {
      expect(output.stopReason).toBe("stop");
      const second = await streamViaAcp(model, { messages: [] }, { ...options, onPayload: undefined }).result();
      expect(second.stopReason).toBe("stop");
      expect(notify).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/cannot verify the exact Pi tool catalog/));
      expect(recipe).toContain("disabledTools: [list_resources, read_resource, manage_task]");
    }
  });

  it("reports the signal rather than a null exit code if agy is killed", async () => {
    killOnPrompt = true;
    const output = await streamViaAcp(model, {
      messages: [{ role: "user", content: "hello" }],
    }, { cwd }).result();
    expect(output.errorMessage).toBe("agy was killed (signal SIGKILL)");
  });

  it.each([false, true])("handles a clipped UTF-8 result with strict=%s", async (strict) => {
    vi.stubEnv("PI_AGY_TETHER_STRICT", "0");
    blockRealPrompt = true;
    const respond = vi.fn();
    const notify = vi.fn();
    const original = CliProcess.prototype.sendPrompt;
    const send = vi.spyOn(CliProcess.prototype, "sendPrompt").mockImplementation(function (this: CliProcess, blocks) {
      original.call(this, blocks);
      this.onHandoffCall({ name: "read", piCallId: "read-call", arguments: {}, respond });
    });
    const cancel = new AbortController();
    try {
      const run = (messages: any[]) => streamViaAcp(model, { messages }, {
        cwd, sessionId: "clipped", notify, signal: cancel.signal,
      }).result();
      const user = { role: "user", content: "Read the fixture" };
      const assistant = await run([user]);
      expect(assistant.stopReason).toBe("toolUse");
      notify.mockClear(); // catalog notices belong to the initial prompt, not the handoff
      vi.stubEnv("PI_AGY_TETHER_STRICT", strict ? "1" : "0");
      const toolResult = { role: "toolResult", toolCallId: "read-call", toolName: "read",
        content: [{ type: "text", text: `${"ø".repeat(15017)}\n` }], isError: false };
      if (!strict) respond.mockImplementation(() => cancel.abort());
      const result = await run([user, assistant, toolResult]);
      if (strict) {
        expect(result.errorMessage).toMatch(/cannot verify intact tool-result delivery.*Pi executed read and retained its result/);
        expect(respond).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ isError: true }));
        expect(notify).not.toHaveBeenCalled();
      } else {
        expect(respond).toHaveBeenCalledExactlyOnceWith({ content: toolResult.content });
        expect(notify.mock.calls.flat()).toEqual([
          "agy adds Created At and Completed At timestamps to Pi tool results.",
          "agy clipped read from 30,035 to a 10,240-byte limit; Pi kept the full result.",
        ]);
      }
    } finally {
      send.mockRestore();
    }
  });

  it("shows unverified delivery once per cause per Pi session, without suppressing clipping", async () => {
    blockRealPrompt = true;
    const notify = vi.fn();
    const recordResultNotice = vi.fn();
    let respond: ReturnType<typeof vi.fn>;
    const original = CliProcess.prototype.sendPrompt;
    const send = vi.spyOn(CliProcess.prototype, "sendPrompt").mockImplementation(function (this: CliProcess, blocks) {
      original.call(this, blocks);
      this.onHandoffCall({ name: "read", piCallId: "read-call", arguments: {}, respond });
    });
    async function deliver(content: object[], isError = false, sessionId = "unverified") {
      const cancel = new AbortController();
      respond = vi.fn(() => cancel.abort());
      const run = (messages: any[]) => streamViaAcp(model, { messages }, {
        cwd, sessionId, notify, recordResultNotice, signal: cancel.signal,
      }).result();
      const user = { role: "user", content: "Read the fixture" };
      const assistant = await run([user]);
      expect(assistant.stopReason).toBe("toolUse");
      await run([user, assistant, { role: "toolResult", toolName: "read", toolCallId: "read-call", content, isError }]);
      expect(respond).toHaveBeenCalledOnce();
    }
    const plain = [{ type: "text", text: "fixture" }];
    const multipart = [...plain, ...plain];
    const clipped = [{ type: "text", text: "x".repeat(30035) }];
    const generic = () => notify.mock.calls.flat().filter(message => message.startsWith("agy cannot verify intact delivery"));
    try {
      for (let i = 0; i < 3; i++) {
        await deliver(plain, true);
        await deliver([image]);
        await deliver(multipart);
        await deliver(clipped);
      }
      version = "unmeasured";
      for (let i = 0; i < 3; i++) await deliver(plain);
      expect(generic()).toEqual(["error result", "image result", "non-single-text result", "unmeasured agy version"].map(
        cause => `agy cannot verify intact delivery of read (${cause}); Pi kept the full result.`,
      ));
      for (const message of generic()) {
        expect(recordResultNotice.mock.calls.filter(([loss]) => loss.message === message)).toHaveLength(3);
      }
      expect(notify.mock.calls.flat().filter(message => message.startsWith("agy clipped"))).toHaveLength(3);
      await deliver(plain, false, "another-session");
      expect(generic()).toHaveLength(5);
    } finally {
      send.mockRestore();
    }
  });

  it("refuses an oversized historical tool result before any marker or replay prompt", async () => {
    const user = { role: "user", content: "Read the fixture" };
    const assistant = { role: "assistant", provider: "other-provider", content: [{ type: "toolCall", id: "read-call", name: "read", arguments: { path: "fixture.txt" } }] };
    const toolResult = { role: "toolResult", toolCallId: "read-call", toolName: "read", content: [
      { type: "text", text: `HEAD\n${"ø".repeat(48000)}MID${"ø".repeat(48021)}\nTAIL` }, image,
    ] };
    const history = [user, assistant, toolResult, { role: "user", content: "OK — do not disclose this fixture marker" }];
    const before = JSON.stringify(history);
    const output = await streamViaAcp(model, { messages: history }, { cwd, sessionId: "cold-restart" }).result();
    expect(prompts).toEqual([]);
    expect(output.stopReason).toBe("error");
    expect(output.errorMessage).toMatch(/historical tool result.*No historical tool was replayed/i);
    expect(output.content).toEqual([]);
    expect(JSON.stringify(history)).toBe(before);
  });

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
