import { afterEach, describe, expect, it, vi } from "vitest";
import { assertConfigApplied, configureSession, desiredConfig, verifyPromptConfig } from "../src/thinking-config.js";

import { FALLBACK_FAMILIES, familiesFromOffered, setAgyCatalog } from "../src/cli-catalog.js";

afterEach(() => setAgyCatalog(FALLBACK_FAMILIES));

const options = (model: string, level: string) => [
  { id: "model", currentValue: model },
  { id: "thought_level", currentValue: level },
];

describe("desiredConfig", () => {
  it("maps a Pi model and level to ACP option values", () => {
    expect(desiredConfig("claude-sonnet-5-5", "high")).toEqual({
      family: "claude-sonnet-5-5",
      effort: "high",
    });
  });

  it("leaves effort unset when Pi asked for no thinking level", () => {
    expect(desiredConfig("gemini-4-hydrogen", "off")).toEqual({
      family: "gemini-4-hydrogen",
      effort: undefined,
    });
  });

  it("refuses an unknown family", () => {
    expect(() => desiredConfig("gemini-5-nova", "low")).toThrow(
      /not a family agy advertises or this tether registers; refusing/,
    );
  });

  it("refuses an unsupported level", () => {
    expect(() => desiredConfig("gemini-4-hydrogen", "max")).toThrow(/does not offer thinking level max/);
  });

  it("configures GPT-OSS by exact fixed-effort ID", () => {
    const id = "gpt-oss-120b-medium";
    setAgyCatalog(familiesFromOffered([{ id }], new Map([[id, "GPT-OSS 120B (Medium)"]])));
    expect(desiredConfig(id, undefined)).toEqual({ family: id, effort: undefined });
    expect(() => desiredConfig(id, "medium")).toThrow(/does not offer adjustable thinking levels/);
  });
});

describe("live configuration", () => {
  const family = "gemini-4-hydrogen";
  const desired = { family, effort: "high" };
  const offered = (effort: string) => [
    { id: "model", currentValue: family, options: [{ value: family }] },
    { id: "thought_level", currentValue: effort, options: ["low", "medium", "high"].map((value) => ({ value })) },
  ];

  it("skips writes only for exact initial readback", async () => {
    const set = vi.fn().mockResolvedValue(offered("high"));
    await expect(configureSession(set, desired, offered("high"), false)).resolves.toMatchObject(desired);
    expect(set).not.toHaveBeenCalled();
    await expect(configureSession(set, desired, offered("medium"), false)).resolves.toMatchObject(desired);
    expect(set.mock.calls).toEqual([["thought_level", "high"]]);
  });

  it("uses offered low for the one-shot marker and verifies the restored user effort", async () => {
    const set = vi.fn().mockResolvedValueOnce(offered("low")).mockResolvedValueOnce(offered("high"));
    await expect(configureSession(set, desired, offered("high"), true)).resolves.toMatchObject({ effort: "low" });
    await expect(verifyPromptConfig(set, desired)).resolves.toMatchObject(desired);
    expect(set.mock.calls).toEqual([["thought_level", "low"], ["thought_level", "high"]]);
  });

  it("requires fresh confirmation of both fields on a warm turn", async () => {
    const set = vi.fn().mockResolvedValueOnce(options(family, "high"))
      .mockResolvedValueOnce(options("gemini-4-neon", "high"))
      .mockResolvedValueOnce(options(family, "medium"))
      .mockResolvedValueOnce(undefined);
    await expect(verifyPromptConfig(set, desired)).resolves.toMatchObject(desired);
    expect(set.mock.calls).toEqual([["thought_level", "high"]]);
    await expect(verifyPromptConfig(set, desired)).rejects.toThrow(/readback model=gemini-4-neon/);
    await expect(verifyPromptConfig(set, desired)).rejects.toThrow(/readback thought_level=medium/);
    await expect(verifyPromptConfig(set, desired)).rejects.toThrow(/readback model=missing/);
  });
});

describe("assertConfigApplied", () => {
  it("accepts a readback that matches the request", () => {
    expect(
      assertConfigApplied(options("gemini-4-argon", "low"), {
        family: "gemini-4-argon",
        effort: "low",
      }),
    ).toEqual({
      family: "gemini-4-argon",
      effort: "low",
      readback: { model: "gemini-4-argon", thought_level: "low" },
    });
  });

  it("refuses a silently different model", () => {
    expect(() =>
      assertConfigApplied(options("gemini-3.8-flash", "low"), {
        family: "gemini-4-argon",
        effort: "low",
      }),
    ).toThrow(/readback model=gemini-3.8-flash but Pi selected gemini-4-argon/);
  });

  it("refuses a silently different thought level", () => {
    // The probes observed a loaded session reporting medium after setting low.
    expect(() =>
      assertConfigApplied(options("gemini-4-argon", "medium"), {
        family: "gemini-4-argon",
        effort: "low",
      }),
    ).toThrow(/readback thought_level=medium but Pi selected low/);
  });

  it("ignores the thought level when no level was requested", () => {
    expect(
      assertConfigApplied(options("gemini-4-argon", "medium"), {
        family: "gemini-4-argon",
        effort: undefined,
      }).effort,
    ).toBeUndefined();
  });

  it("treats a missing option as a refusal", () => {
    expect(() => assertConfigApplied([], { family: "gemini-4-argon", effort: "low" })).toThrow(
      /readback model=missing/,
    );
  });
});
