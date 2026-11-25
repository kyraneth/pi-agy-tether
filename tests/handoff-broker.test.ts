import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import {
  brokerSocketPath,
  registerHandoffTarget,
  startHandoffBroker,
  stopHandoffBroker,
  unregisterHandoffTarget,
} from "../src/handoff-broker.js";

async function invoke(payload: Record<string, unknown>): Promise<any> {
  const socketPath = brokerSocketPath()!;
  const secret = readFileSync(`${socketPath.replace(/handoff\.sock$/, "handoff.secret")}`, "utf8").trim();
  return await new Promise((resolve, reject) => {
    const socket = connect(socketPath, () => {
      socket.write(`${JSON.stringify({ ...payload, secret })}\n`);
    });
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const line = buffer.split("\n")[0];
      if (!line || !buffer.includes("\n")) return;
      socket.end();
      resolve(JSON.parse(line));
    });
    socket.on("error", reject);
  });
}

describe("handoff broker", () => {
  beforeEach(async () => {
    await stopHandoffBroker();
    await startHandoffBroker();
  });

  afterAll(async () => {
    await stopHandoffBroker();
  });

  it("creates a private socket and secret", () => {
    expect(brokerSocketPath()).toMatch(/handoff\.sock$/);
  });

  it("answers a tool call with the result Pi produced", async () => {
    registerHandoffTarget("sess-1", {
      onHandoffCall: (invocation) => {
        expect(invocation.name).toBe("read");
        expect(invocation.arguments).toEqual({ path: "seed.txt" });
        invocation.respond({ content: [{ type: "text", text: "seed=42" }] });
      },
    }, ["read"]);
    const result = await invoke({ type: "call", session: "sess-1", name: "read", arguments: { path: "seed.txt" } });
    expect(result).toEqual({ type: "result", content: [{ type: "text", text: "seed=42" }] });
  });

  it("refuses an invocation for a session Pi is not attached to", async () => {
    unregisterHandoffTarget("sess-1");
    const result = await invoke({ type: "call", session: "sess-9", name: "read", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not attached/);
  });

  it("refuses an undeclared name on the correct authenticated session", async () => {
    let invoked = false;
    registerHandoffTarget("scope", {
      onHandoffCall: (invocation) => {
        invoked = true;
        invocation.respond({ content: [{ type: "text", text: "unexpected" }] });
      },
    }, ["read"]);
    const result = await invoke({ type: "call", session: "scope", name: "foreign", arguments: {} });
    expect(invoked).toBe(false);
    expect(result.isError).toBe(true);
  });

  it("refuses a call without the secret", async () => {
    const socketPath = brokerSocketPath()!;
    const result = await new Promise<any>((resolve, reject) => {
      const socket = connect(socketPath, () => {
        socket.write(`${JSON.stringify({ type: "call", session: "sess-1", name: "read", arguments: {}, secret: "wrong" })}\n`);
      });
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        if (!buffer.includes("\n")) return;
        socket.end();
        resolve(JSON.parse(buffer.split("\n")[0]));
      });
      socket.on("error", reject);
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Unauthorized/);
  });
});
