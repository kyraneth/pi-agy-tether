import { describe, expect, it } from "vitest";
import { toHandoffResult } from "../src/provider.js";

describe("toHandoffResult", () => {
  it("sends a tool's text result as an MCP text block", () => {
    expect(
      toHandoffResult({ content: [{ type: "text", text: "seed=42" }] }),
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
      }),
    ).toEqual({
      content: [
        { type: "text", text: "captured" },
        { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      ],
    });
  });

  it("keeps the error flag and never returns an empty result", () => {
    expect(toHandoffResult({ content: [], isError: true })).toEqual({
      content: [{ type: "text", text: "" }],
      isError: true,
    });
  });
});
