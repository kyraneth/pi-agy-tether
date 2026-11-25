import { afterEach, describe, expect, it } from "vitest";
import { toHandoffResult } from "../src/provider.js";

import { FALLBACK_FAMILIES, familyRow, setAgyCatalog } from "../src/cli-catalog.js";

afterEach(() => setAgyCatalog(FALLBACK_FAMILIES));

const vision = "gemini-4-hydrogen";

describe("toHandoffResult", () => {
  it("sends a tool's text result as an MCP text block", () => {
    expect(
      toHandoffResult({ content: [{ type: "text", text: "seed=42" }] }, vision),
    ).toEqual({ content: [{ type: "text", text: "seed=42" }] });
  });

  it("sends a tool's image result as an MCP image block", () => {
    // The blocked call's result is what agy sees, so vision has to survive here.
    expect(
      toHandoffResult({
        content: [
          { type: "text", text: "captured" },
          { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
        ],
      }, vision),
    ).toEqual({
      content: [
        { type: "text", text: "captured" },
        { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      ],
    });
  });

  it("refuses an image-bearing tool result for a text-only model", () => {
    const id = "gpt-oss-120b-medium";
    setAgyCatalog([familyRow({ id, name: id, effortLevels: [] })]);
    expect(() => toHandoffResult({
      content: [
        { type: "text", text: "captured" },
        { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      ],
    }, id)).toThrow(/gpt-oss-120b-medium.*text-only/);
  });

  it("keeps the error flag and never returns an empty result", () => {
    expect(toHandoffResult({ content: [], isError: true }, vision)).toEqual({
      content: [{ type: "text", text: "" }],
      isError: true,
    });
  });
});
