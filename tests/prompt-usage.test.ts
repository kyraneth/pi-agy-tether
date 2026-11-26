import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { createEventBridge } from "../src/event-bridge.js";
import { PromptUsage } from "../src/prompt-usage.js";
import recording from "./fixtures/agy-1.5.16-usage.json";

const id = "54321000-0000-4000-a000-000000000001";
const model = {
  id: "gemini-4-hydrogen", provider: "pi-agy-tether",
  cost: { input: 1.5, output: 7.5, cacheRead: 0.075, cacheWrite: 0 },
} as any;

it("attributes recorded handoffs before MCP resumes and reconciles the ACP terminal without double counting", () => {
  const dir = mkdtempSync(join(tmpdir(), "agy-spend-fixture-"));
  mkdirSync(join(dir, "conversations"));
  const db = new DatabaseSync(join(dir, "conversations", `${id}.db`));
  try {
    db.exec("CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB)");
    const insert = db.prepare("INSERT INTO steps VALUES(?, 15, ?)");
    insert.run(recording.baselineIndex, Buffer.from([])); // prior marker, deliberately not a usage row
    const prompt = PromptUsage.begin(dir, id, "1.5.16");
    const terminal = recording.frames.at(-1)!.result!;
    const usage = recording.steps.map(({ idx, field9Hex }, i) => {
      const fields = Buffer.from(field9Hex, "hex");
      insert.run(idx, Buffer.concat([Buffer.from([0x4a, fields.length]), fields]));
      const bridge = createEventBridge({ push() {} }, model);
      const update = recording.frames[i].params!.update;
      bridge.handleUpdate(update);
      if (i < recording.steps.length - 1) {
        bridge.applyUsage(prompt.handoff(bridge.contextTokens()));
        bridge.pushToolCall({ id: String(i), name: "read", arguments: {} });
      } else bridge.applyResult(terminal, prompt.terminal(terminal.usage, bridge.contextTokens()));
      const actual = bridge.getOutput().usage;
      expect(actual.totalTokens).toBe(update.used);
      expect(actual.input).toBeGreaterThan(0);
      expect(actual.output).toBeGreaterThan(0);
      expect(actual.cost).toMatchObject({ basis: "API-equivalent", totalFromProvider: false });
      return actual;
    });
    expect(usage.map(u => [u.input, u.output, u.cacheRead])).toEqual([
      [2287, 98, 17021], [2244, 57, 17259], [2203, 36, 17454],
    ]);
    for (const [piKey, acpKey] of [
      ["input", "inputTokens"], ["output", "outputTokens"], ["cacheRead", "cachedReadTokens"],
      ["cacheWrite", "cachedWriteTokens"], ["reasoning", "thoughtTokens"],
    ] as const) expect(usage.reduce((n, u) => n + u[piKey]!, 0)).toBe(terminal.usage[acpKey]);
    expect(PromptUsage.begin(dir, id, "future").handoff(19406).present).toBe(false);
    const missing = PromptUsage.begin(dir, id, "1.5.16");
    expect(missing.handoff(19406).present).toBe(false);
    expect(missing.terminal(terminal.usage).present).toBe(false);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
