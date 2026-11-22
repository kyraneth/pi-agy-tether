import { describe, expect, it } from "vitest";
import { OVERFLOW_PREFIX, isOverflowError, rewriteOverflowMessage } from "../src/overflow.js";

describe("isOverflowError", () => {
  it("recognizes overflow-shaped provider errors", () => {
    expect(isOverflowError("prompt is too long: 210000 tokens")).toBe(true);
    expect(isOverflowError("request exceeds the maximum context")).toBe(true);
  });

  it("never treats a rate limit as overflow", () => {
    // A 429 rewritten as overflow would compact instead of backing off.
    expect(isOverflowError("RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).")).toBe(false);
  });

  it("does not re-rewrite an already rewritten message", () => {
    expect(isOverflowError(`${OVERFLOW_PREFIX}: prompt is too long`)).toBe(false);
  });
});

const PROVIDER = "pi-agy-tether";

describe("rewriteOverflowMessage", () => {
  const assistant = {
    role: "assistant",
    provider: PROVIDER,
    stopReason: "error",
    errorMessage: "prompt is too long: 210000 tokens",
  };

  it("prefixes the message Pi recognizes", () => {
    const rewritten = rewriteOverflowMessage(assistant, PROVIDER);
    expect(rewritten?.message.errorMessage).toBe(`${OVERFLOW_PREFIX}: prompt is too long: 210000 tokens`);
  });

  it("leaves other providers' errors alone", () => {
    expect(
      rewriteOverflowMessage({ ...assistant, provider: "anthropic" }, PROVIDER, "anthropic"),
    ).toBeUndefined();
  });

  it("still rewrites when only the host context names this provider", () => {
    const { provider: _omitted, ...withoutProvider } = assistant;
    expect(rewriteOverflowMessage(withoutProvider, PROVIDER, PROVIDER)?.message.errorMessage).toContain(
      OVERFLOW_PREFIX,
    );
  });

  it("leaves non-error and non-assistant messages alone", () => {
    expect(rewriteOverflowMessage({ ...assistant, stopReason: "stop" }, PROVIDER)).toBeUndefined();
    expect(rewriteOverflowMessage({ ...assistant, role: "user" }, PROVIDER)).toBeUndefined();
  });

  it("never rewrites a 429", () => {
    expect(
      rewriteOverflowMessage(
        { ...assistant, errorMessage: "RESOURCE_EXHAUSTED (code 429): Resource has been exhausted" },
        PROVIDER,
      ),
    ).toBeUndefined();
  });
});
