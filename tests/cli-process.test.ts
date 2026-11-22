import { describe, expect, it } from "vitest";
import { CliProcess } from "../src/cli-process.js";

describe("eager MCP permission", () => {
  function decide(name: string, sessionId = "bound") {
    return CliProcess.prototype.decidePermission.call(
      { sessionId: "bound", input: { tools: [{ name: "read" }] } },
      { sessionId, toolCall: { name, args: { path: "file.txt" } } },
    ).outcome;
  }

  it("permits direct calls for the exact staged Pi tool in the current session", () => {
    expect(decide("mcp_pi_read")).toBe("allowed");
    expect(decide("mcp_pi_read", "other")).toBe("denied");
    expect(decide("mcp_pi_read_other")).toBe("denied");
    expect(decide("mcp_other_read")).toBe("denied");
  });
});
