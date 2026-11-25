import { afterEach, describe, expect, it } from "vitest";
import { getBuiltinModels as getModels } from "@earendil-works/pi-ai/providers/all";
import {
  FALLBACK_FAMILIES,
  agyFamilies,
  agyModels,
  effortFor,
  familiesFromOffered,
  familiesFromSessionNew,
  familyFor,
  setAgyCatalog,
  thinkingLevelMap,
} from "../src/cli-catalog.js";

/** The model options shape returned by ACP `session/new`. */
const sessionNew = () => ({
  models: {
    availableModels: [
      { modelId: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
      { modelId: "gemini-4-neon-xhigh", name: "Gemini 4 Neon (XHigh)" },
      { modelId: "gemini-4-neon-medium", name: "Gemini 4 Neon (Medium)" },
      { modelId: "gemini-4-neon-low", name: "Gemini 4 Neon (Low)" },
      { modelId: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)" },
      { modelId: "gemini-4-argon-high", name: "Gemini 4 Argon (High)" },
      { modelId: "gemini-4-argon-low", name: "Gemini 4 Argon (Low)" },
      { modelId: "gemini-4-hydrogen-high", name: "Gemini 4 Hydrogen (High)" },
      { modelId: "gemini-4-hydrogen-xhigh", name: "Gemini 4 Hydrogen (XHigh)" },
      { modelId: "gemini-4-hydrogen-medium", name: "Gemini 4 Hydrogen (Medium)" },
      { modelId: "gemini-4-hydrogen-low", name: "Gemini 4 Hydrogen (Low)" },
      { modelId: "gemini-pro-orchestrator-neon", name: "Orchestrator (Neon)" },
      { modelId: "gemini-pro-orchestrator-g1-pro", name: "Orchestrator (Argon)" },
      { modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
      { modelId: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
      { modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
      ...["opus", "sonnet"].flatMap((family) => ["low", "medium", "high"].map((effort) => ({
        modelId: `claude-${family}-5-5-${effort}`,
      }))),
      { modelId: "gemini-4-carbon-high" },
      { modelId: "gemini-pro-orchestrator" },
      { modelId: "gemini-pro-orchestrator-argon" },
      { modelId: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
    ],
  },
  configOptions: [
    {
      id: "model",
      options: [
        { value: "gemini-4-neon", name: "Gemini 4 Neon" },
        { value: "gemini-4-argon", name: "Gemini 4 Argon" },
        { value: "gemini-pro-orchestrator-neon", name: "Orchestrator (Neon)" },
        { value: "claude-opus-5-5", name: "Claude Opus 5.5" },
        { value: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
        { value: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
      ],
    },
    { id: "thought_level", options: [{ value: "low" }, { value: "high" }] },
  ],
});

afterEach(() => setAgyCatalog(FALLBACK_FAMILIES));

describe("agy's offered list", () => {
  it("groups per-effort variants into one family each", () => {
    const families = familiesFromSessionNew(sessionNew());
    expect(families.map((f) => f.id)).toEqual([
      "gemini-4-neon",
      "gemini-4-argon",
      "gemini-4-hydrogen",
      "gemini-pro-orchestrator-neon",
      "gemini-pro-orchestrator-g1-pro",
      "gemini-3.8-flash",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "gemini-4-carbon",
      "gemini-pro-orchestrator",
      "gemini-pro-orchestrator-argon",
      "gpt-oss-120b-medium",
    ]);
    expect(families.find((f) => f.id === "gemini-4-neon")!.effortLevels).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    // The Orchestrator family has one variant and agy refuses a level for it.
    expect(families.find((f) => f.id === "gemini-pro-orchestrator-neon")!.effortLevels).toEqual([]);
  });

  it("preserves fixed-effort IDs and groups adjustable third-party variants", () => {
    const families = familiesFromSessionNew(sessionNew());
    for (const id of ["claude-opus-5-5", "claude-sonnet-5-5"])
      expect(families.find(f => f.id === id)?.effortLevels).toEqual(["low", "medium", "high"]);
    const oss = families.find(f => f.id === "gpt-oss-120b-medium")!;
    expect(oss).toMatchObject({ name: "GPT-OSS 120B (Medium)", effortLevels: [] });
    expect(() => effortFor(oss, "high")).toThrow(/does not offer adjustable thinking levels/);
  });

  it("groups max effort and maps it only when advertised", () => {
    const session = sessionNew();
    session.models.availableModels.push({ modelId: "claude-opus-5-5-max", name: "Claude Opus 5.5 (Max)" });
    const opus = familiesFromSessionNew(session).find(f => f.id === "claude-opus-5-5")!;
    expect(opus.effortLevels).toEqual(["low", "medium", "high", "max"]);
    expect(thinkingLevelMap(opus).max).toBe("max");
    expect(familiesFromOffered([{ id: "claude-opus-5-5-max", name: "Claude Opus 5.5 (Max)" }])[0]?.name).toBe("Claude Opus 5.5");
  });

  it("takes the family's own name, not the variant's", () => {
    const neon = familiesFromSessionNew(sessionNew()).find((f) => f.id === "gemini-4-neon")!;
    expect(neon.name).toBe("Gemini 4 Neon");
  });

  it("survives a session answer with no models", () => {
    expect(familiesFromSessionNew({})).toEqual([]);
    expect(familiesFromSessionNew(undefined)).toEqual([]);
  });
});

describe("limits", () => {
  it("registers the numbers agy reports for the family", () => {
    const neon = familiesFromSessionNew(sessionNew()).find((f) => f.id === "gemini-4-neon")!;
    // agy reports 1,048,576 for Neon; Google's page says 512K. agy runs the turn.
    expect(neon).toMatchObject({
      contextWindow: 1_048_576,
      maxTokens: 262_144,
      limitsReported: true,
    });
    const argon = familiesFromSessionNew(sessionNew()).find((f) => f.id === "gemini-4-argon")!;
    expect(argon).toMatchObject({ contextWindow: 1_048_576, maxTokens: 65_536 });
    const orchestrator = familiesFromSessionNew(sessionNew()).find(
      (f) => f.id === "gemini-pro-orchestrator-neon",
    )!;
    expect(orchestrator).toMatchObject({ contextWindow: 1_048_576, maxTokens: 262_144 });
  });

  it("registers limits and vision for all observed families", () => {
    const families = familiesFromSessionNew(sessionNew());
    const lookup = (id: string) => families.find(f => f.id === id);
    for (const id of ["claude-opus-5-5", "claude-sonnet-5-5"])
      expect(lookup(id)).toMatchObject({ contextWindow: 1_000_000, maxTokens: 128_000, supportsImages: true });
    expect(lookup("gpt-oss-120b-medium")).toMatchObject({ contextWindow: 131_072, maxTokens: 32_768, supportsImages: false });
    for (const id of ["gemini-4-carbon", "gemini-pro-orchestrator", "gemini-pro-orchestrator-argon"])
      expect(lookup(id)).toMatchObject({ limitsReported: true, supportsImages: true });
  });

  it("still registers a family whose limits agy does not report, with the note", () => {
    const [nova] = familiesFromOffered([{ id: "gemini-5-nova-low", name: "Gemini 5 Nova (Low)" }]);
    expect(nova).toMatchObject({
      id: "gemini-5-nova",
      limitsReported: false,
      contextWindow: 1_048_576,
      maxTokens: 65_536,
    });
    expect(nova.name).toBe("Gemini 5 Nova");
    expect(agyModels({}, [nova])[0].name).toBe("Gemini 5 Nova (limits not reported)");
  });
});

describe("catalog rows", () => {
  it("starts on the three fallback families", () => {
    expect(agyFamilies().map((f) => f.id)).toEqual([
      "gemini-4-hydrogen",
      "gemini-4-neon",
      "claude-sonnet-5-5",
    ]);
    expect(familyFor("gemini-4-hydrogen")).toMatchObject({
      contextWindow: 1_048_576,
      maxTokens: 262_144,
    });
  });

  it("registers whatever the discovered catalog says", () => {
    setAgyCatalog(familiesFromSessionNew(sessionNew()));
    expect(familyFor("gemini-4-neon")).toBeDefined();
    expect(familyFor("claude-opus-5-5")).toBeDefined();
    expect(agyModels().map((row) => row.id)).toContain("gemini-4-neon");
  });

  it("advertises images only with build and family support", () => {
    const families = [...familiesFromSessionNew(sessionNew()), ...familiesFromOffered([{ id: "future" }])];
    for (const row of agyModels({}, families)) expect(row.input).toEqual(["text"]);
    const rows = agyModels({ images: true }, families);
    for (const id of ["gemini-4-neon", "claude-sonnet-5-5"])
      expect(rows.find(r => r.id === id)?.input).toEqual(["text", "image"]);
    for (const id of ["gpt-oss-120b-medium", "future"])
      expect(rows.find(r => r.id === id)?.input).toEqual(["text"]);
  });

  it("maps only the levels agy actually offers", () => {
    setAgyCatalog(familiesFromSessionNew(sessionNew()));
    const hydrogen = thinkingLevelMap(familyFor("gemini-4-hydrogen")!);
    expect(hydrogen.xhigh).toBe("xhigh");
    for (const family of agyFamilies()) {
      const map = thinkingLevelMap(family);
      // Unoffered levels stay unavailable rather than being clamped.
      expect(map.max).toBeNull();
      expect(map.off).toBeNull();
      if (!family.effortLevels.includes("low")) expect(map.low).toBeNull();
      if (!family.effortLevels.includes("xhigh")) expect(map.xhigh).toBeNull();
    }
  });

  it("does not offer thinking where agy offers no levels", () => {
    setAgyCatalog(familiesFromSessionNew(sessionNew()));
    const orchestrator = agyModels({}, [familyFor("gemini-pro-orchestrator-neon")!])[0];
    expect(orchestrator.reasoning).toBe(false);
    expect(orchestrator.thinkingLevelMap.high).toBeNull();
  });

  it("carries first-party list costs for known models and zero for unlisted ones", () => {
    const firstParty = new Map([...getModels("google"), ...getModels("anthropic"), ...getModels("openai")].map((m) => [m.id, m.cost]));
    setAgyCatalog(familiesFromSessionNew(sessionNew()));
    for (const row of agyModels()) {
      const expected = firstParty.get(row.id) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      expect(row.cost).toEqual(expected);
    }
    expect(agyModels().find((r) => r.id === "gemini-4-argon")!.cost.input).toBeGreaterThan(0);
    for (const id of ["claude-opus-5-5", "claude-sonnet-5-5"])
      expect(agyModels().find(r => r.id === id)?.cost.input).toBeGreaterThan(0);
    for (const id of ["gemini-pro-orchestrator-neon", "gpt-oss-120b-medium"])
      expect(agyModels().find(r => r.id === id)?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });
});

describe("effort selection", () => {
  it("passes offered levels through", () => {
    const argon = familiesFromSessionNew(sessionNew()).find(f => f.id === "gemini-4-argon")!;
    const hydrogen = familyFor("gemini-4-hydrogen")!;
    expect(effortFor(argon, "low")).toBe("low");
    expect(effortFor(argon, "high")).toBe("high");
    expect(effortFor(hydrogen, "xhigh")).toBe("xhigh");
  });

  it("asks for no level when Pi turned reasoning off", () => {
    const hydrogen = familyFor("gemini-4-hydrogen")!;
    expect(effortFor(hydrogen, "off")).toBeUndefined();
    expect(effortFor(hydrogen, "minimal")).toBeUndefined();
    expect(effortFor(hydrogen, undefined)).toBeUndefined();
  });

  it("refuses a level agy does not offer instead of clamping", () => {
    const argon = familiesFromSessionNew(sessionNew()).find(f => f.id === "gemini-4-argon")!;
    expect(() => effortFor(argon, "xhigh")).toThrow(/does not offer thinking level xhigh/);
    expect(() => effortFor(argon, "max")).toThrow(/agy offers low, medium, high/);
    // agy itself: 'Thinking level "high" is not offered for model "Orchestrator (Neon)"'.
    const orchestrator = familiesFromSessionNew(sessionNew()).find(
      (f) => f.id === "gemini-pro-orchestrator-neon",
    )!;
    expect(() => effortFor(orchestrator, "high")).toThrow(/does not offer adjustable thinking levels/);
  });
});
