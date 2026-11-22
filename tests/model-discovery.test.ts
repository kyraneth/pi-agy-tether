import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { FALLBACK_FAMILIES, agyFamilies, familyFor, setAgyCatalog } from "../src/cli-catalog.js";
import {
  readCachedFamilies,
  rememberOfferedFamilies,
  startupCatalog,
  writeCachedFamilies,
} from "../src/model-discovery.js";
import { catalogCachePath } from "../src/data-dir.js";

const offered = () =>
  ({
    models: {
      availableModels: [
        { modelId: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
        { modelId: "gemini-4-neon-low", name: "Gemini 4 Neon (Low)" },
        { modelId: "gemini-4-argon-low", name: "Gemini 4 Argon (Low)" },
        { modelId: "claude-opus-5-5-high", name: "Claude Opus 5.5 (High)" },
        { modelId: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
      ],
    },
    configOptions: [
      {
        id: "model",
        options: [
          { value: "gemini-4-neon", name: "Gemini 4 Neon" },
          { value: "gemini-4-argon", name: "Gemini 4 Argon" },
        ],
      },
    ],
  }) as const;

describe("offered-model cache", () => {
  it("round-trips the offered families", () => {
    const families = rememberOfferedFamilies(offered());
    expect(families.map((f) => f.id)).toEqual(["gemini-4-neon", "gemini-4-argon"]);
    const cached = readCachedFamilies();
    expect(cached?.map((f) => f.id)).toEqual(["gemini-4-neon", "gemini-4-argon"]);
    // Limits are agy's, attached from code rather than frozen into the cache.
    expect(cached?.find((f) => f.id === "gemini-4-neon")).toMatchObject({
      contextWindow: 1_048_576,
      maxTokens: 262_144,
    });
    const written = JSON.parse(readFileSync(catalogCachePath(), "utf-8"));
    expect(written.source).toBe("agy acp session/new");
    expect(written.families[0]).not.toHaveProperty("maxTokens");
  });

  it("contributes nothing from a missing, corrupt or unexpected file", () => {
    expect(readCachedFamilies()).toBeUndefined();

    const path = catalogCachePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{not json");
    expect(readCachedFamilies()).toBeUndefined();

    writeFileSync(path, JSON.stringify({ families: "nope" }));
    expect(readCachedFamilies()).toBeUndefined();

    writeFileSync(path, JSON.stringify({ families: [{ id: "claude-opus-5-5" }] }));
    expect(readCachedFamilies()).toBeUndefined();
  });

  it("ignores a cache that fell out of the Gemini-only rule", () => {
    writeCachedFamilies([
      ...FALLBACK_FAMILIES,
      { ...FALLBACK_FAMILIES[0]!, id: "claude-opus-5-5" },
    ]);
    expect(readCachedFamilies()?.map((f) => f.id)).not.toContain("claude-opus-5-5");
  });

  it("does not accumulate the unreported-limits note across reads", () => {
    const base = { ...FALLBACK_FAMILIES[0]!, id: "gemini-5-nova", name: "Gemini 5 Nova" };
    writeCachedFamilies([{ ...base, limitsReported: false }]);
    const first = readCachedFamilies()![0]!;
    writeCachedFamilies([first]);
    const second = readCachedFamilies()![0]!;
    expect(second.name).toBe("Gemini 5 Nova");
    expect(second.limitsReported).toBe(false);
  });

  it("updates the catalog in this process too", () => {
    rememberOfferedFamilies(offered());
    expect(familyFor("gemini-4-neon")).toBeDefined();
    expect(agyFamilies().map((f) => f.id)).toEqual(["gemini-4-neon", "gemini-4-argon"]);
    setAgyCatalog(FALLBACK_FAMILIES);
  });
});

describe("startup catalog", () => {
  it("uses the cache without asking agy again", async () => {
    rememberOfferedFamilies(offered());
    // A binary that cannot run proves the cache answered: a probe would fail.
    process.env.PI_AGY_TETHER_CLI = "/nonexistent/agy";
    const { families, image } = await startupCatalog();
    expect(families.map((f) => f.id)).toEqual(["gemini-4-neon", "gemini-4-argon"]);
    expect(image).toBeUndefined(); // Cached families do not vouch for this binary.
  });

  it("falls back to the three families when nothing can be read", async () => {
    process.env.PI_AGY_TETHER_CLI = "/nonexistent/agy";
    const { families } = await startupCatalog();
    expect(families.map((f) => f.id)).toEqual([
      "gemini-4-argon",
      "gemini-4-hydrogen",
      "gemini-3.8-flash",
    ]);
    // Nothing was learned, so nothing is cached and the next start tries again.
    expect(readCachedFamilies()).toBeUndefined();
  });
});
