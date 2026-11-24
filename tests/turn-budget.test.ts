import { describe, expect, it } from "vitest";
import { measureTurn, planTurns, turnInputLimitFor, TurnLimitError } from "../src/turn-budget.js";
import { isOverflowError } from "../src/overflow.js";
import { replayPiMessages, type PromptBlock } from "../src/pi-context.js";

const later = { appDataDirPath: "/" + "a".repeat(101) };
const first = { ...later, prefaceText: "p".repeat(1378), settingsChange: { fromLabel: "None", toLabel: "Gemini 4 Hydrogen (Medium)" } };
const text = (text: string): PromptBlock => ({ type: "text", text });
const user = (content: string) => ({ role: "user", content });
const plan = (messages: ReturnType<typeof user>[], toolCount = 0, agentVersion = "1.5.12") =>
  planTurns({ messages, toolCount, agentVersion, first, later });

describe("assembled turn budget", () => {
  it("matches measured cutoff, label changes and image path notice, not image bytes", () => {
    const body = text("b".repeat(20813));
    expect(measureTurn([body], later).totalBytes).toBe(20943);
    expect(measureTurn([body], { ...later, settingsChange: { fromLabel: "Gemini 4 Hydrogen (Low)", toLabel: "Gemini 4 Hydrogen (Medium)" } }).totalBytes).toBe(21256);
    expect(measureTurn([text("USER:"), text("b".repeat(190193))], first).totalBytes).toBe(192000);
    expect(plan([user("b".repeat(190193))]).stagedTurns).toEqual([]);
    expect(() => plan([user("b".repeat(190194))])).toThrow(/192,001-byte.*192,000 bytes.*observed in agy 1\.5\.12/);
    const img: PromptBlock = { type: "image", mimeType: "image/png", data: "x".repeat(200000) };
    expect(measureTurn([text("é🧪"), img], { appDataDirPath: "/" + "a".repeat(101) }).totalBytes).toBe(130 + 6 + 306);
  });

  it("uses the observed cutoff for agy 1.5.16 rather than the fallback", () => {
    expect(turnInputLimitFor("1.5.16")).toEqual({ bytes: 192_000, observedVersion: "1.5.16" });
  });

  it("honors explicitly uncapped releases and names both versions for an unlisted build", () => {
    expect(turnInputLimitFor("1.5.12")).toEqual({ bytes: 192000, observedVersion: "1.5.12" });
    expect(turnInputLimitFor("new", new Map([["new", null]]))).toBeNull();
    expect(() => plan([user("x".repeat(200000))], 0, "1.6.0")).toThrow(/observed in agy 1\.5\.12; running agy 1\.6\.0/);
    try { plan([user("x".repeat(200000))]); } catch (e) {
      expect(e).toBeInstanceOf(TurnLimitError);
      expect(isOverflowError((e as Error).message)).toBe(false);
    }
  });

  it.each(["xml", "markdown"])("splits %s compaction verbatim at entry boundaries and keeps instructions on the final turn", (shape) => {
    const entries = Array.from({ length: 5 }, (_, i) => `[User]: ${i}\n</conversation>\n\n${"🧪".repeat(23000)}`).join("\n\n");
    const prompt = shape === "xml"
      ? `<conversation>\n${entries}\n</conversation>\n\n<previous-summary>\nPrior.\n</previous-summary>\n\nInstructions verbatim.`
      : `# Conversation\n${entries}\n\n# Instructions\nInstructions verbatim.`;
    const { stagedTurns, finalTurn } = plan([user(prompt)]);
    expect(stagedTurns).toHaveLength(2);
    const chunks = [...stagedTurns, finalTurn].map((b, i) => {
      expect(measureTurn(b, i ? later : first).totalBytes).toBeLessThanOrEqual(192000);
      const payload = i < stagedTurns.length ? b.slice(1, -1) : b.slice(1);
      return payload.map(x => x.type === "text" ? x.text : "").join("");
    });
    expect(chunks.join("")).toBe(`USER:${prompt}`);
    expect(chunks[1]).toMatch(/^\[User\]:/);
    expect(chunks[2]).toMatch(/Instructions verbatim\.$/);
  });

  it("does not split prompts with tools or oversized instructions", () => {
    const prompt = `<conversation>\n[User]: history\n</conversation>\n\n${"x".repeat(192000)}`;
    expect(() => plan([user(prompt)])).toThrow(/compaction instructions/);
    expect(() => plan([user(prompt)], 1)).toThrow(/single message/);
  });

  it("packs history on whole messages and rejects an oversized individual message", () => {
    const msgs = [user("a".repeat(110000)), user("b".repeat(95000)), user("last")];
    const p = plan(msgs);
    expect(p.stagedTurns.map((b) => b.slice(1, -1))).toEqual([replayPiMessages([msgs[0]])]);
    expect(p.finalTurn.slice(1)).toEqual(replayPiMessages(msgs.slice(1)));
    expect(() => plan([user("a"), user("b".repeat(192000)), user("last")])).toThrow(/message 2\/3.*exceeds/);
  });
});
