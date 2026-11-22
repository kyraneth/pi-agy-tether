import { afterEach, describe, expect, it } from "vitest";
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
      { modelId: "claude-opus-5-5-low", name: "Claude Opus 5.5 (Low)" },
      { modelId: "claude-sonnet-5-5-high", name: "Claude Sonnet 5.5 (High)" },
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

  it("keeps only Gemini families", () => {
    const ids = familiesFromSessionNew(sessionNew()).map((f) => f.id);
    expect(ids.some((id) => id.startsWith("claude-"))).toBe(false);
    expect(ids.some((id) => id.startsWith("gpt-oss"))).toBe(false);
  });

  it("takes the family's own name, not the variant's", () => {
    const neon = familiesFromSessionNew(sessionNew()).find((f) => f.id === "gemini-4-neon")!;
    expect(neon.name).toBe("Gemini 4 Neon");
  });

  it("survives a session answer with no models", () => {
    expect(familiesFromSessionNew({})).toEqual([]);
    expect(familiesFromSessionNew(undefined)).toEqual([]);
    expect(familiesFromOffered([{ id: "claude-opus-5-5-high" }])).toEqual([]);
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
      "gemini-4-argon",
      "gemini-4-hydrogen",
      "gemini-3.8-flash",
    ]);
    expect(familyFor("gemini-4-hydrogen")).toMatchObject({
      contextWindow: 1_048_576,
      maxTokens: 262_144,
    });
  });

  it("registers whatever the discovered catalog says", () => {
    setAgyCatalog(familiesFromSessionNew(sessionNew()));
    expect(familyFor("gemini-4-neon")).toBeDefined();
    expect(familyFor("claude-opus-5-5")).toBeUndefined();
    expect(agyModels().map((row) => row.id)).toContain("gemini-4-neon");
  });

  it("advertises image input only when the build advertises it", () => {
    for (const row of agyModels()) expect(row.input).toEqual(["text"]);
    for (const row of agyModels({ images: true }, agyFamilies()))
      expect(row.input).toEqual(["text", "image"]);
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

  it("prices nothing, because the subscription bills", () => {
    for (const row of agyModels()) {
      expect(row.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    }
  });
});

describe("effort selection", () => {
  it("passes offered levels through", () => {
    const argon = familyFor("gemini-4-argon")!;
    const hydrogen = familyFor("gemini-4-hydrogen")!;
    expect(effortFor(argon, "low")).toBe("low");
    expect(effortFor(argon, "high")).toBe("high");
    expect(effortFor(hydrogen, "xhigh")).toBe("xhigh");
  });

  it("asks for no level when Pi turned reasoning off", () => {
    const argon = familyFor("gemini-4-argon")!;
    expect(effortFor(argon, "off")).toBeUndefined();
    expect(effortFor(argon, "minimal")).toBeUndefined();
    expect(effortFor(argon, undefined)).toBeUndefined();
  });

  it("refuses a level agy does not offer instead of clamping", () => {
    const argon = familyFor("gemini-4-argon")!;
    expect(() => effortFor(argon, "xhigh")).toThrow(/does not offer thinking level xhigh/);
    expect(() => effortFor(argon, "max")).toThrow(/agy offers low, medium, high/);
    // agy itself: 'Thinking level "high" is not offered for model "Orchestrator (Neon)"'.
    const orchestrator = familiesFromSessionNew(sessionNew()).find(
      (f) => f.id === "gemini-pro-orchestrator-neon",
    )!;
    expect(() => effortFor(orchestrator, "high")).toThrow(/does not offer thinking level high/);
  });
});
