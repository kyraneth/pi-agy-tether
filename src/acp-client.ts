/**
 * The ACP (Agent Client Protocol) client for `agy acp`.
 *
 * Google's official client speaks JSON-RPC 2.0 over stdio. This module owns one
 * process connection: request/response correlation, `session/update`
 * notifications, and the server-initiated `session/request_permission` request.
 * It has no retry policy, no deadlines and no interpretation of the content; the
 * provider decides what a turn means.
 */

import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { isResponse, isServerRequest, parseFrame, type RpcMessage } from "./stream-parser.js";

export interface AcpHandlers {
  /** A `session/update` notification, already unwrapped. */
  onUpdate(update: any, params: any): void;
  /**
   * ACP asks the client whether the model may run one tool call. The answer is
   * the client's authority decision; the provider owns it.
   */
  onPermissionRequest(params: any): { outcome: "allowed" | "denied" } | Promise<{ outcome: "allowed" | "denied" }>;
  /** Protocol faults that no request is waiting for (bad frame, unknown method). */
  onDiagnostic(message: string, level: "warn" | "error"): void;
}

const { name, version } = createRequire(import.meta.url)("../package.json") as { name: string; version: string };
export const CLIENT_INFO = { name, version } as const;

/** ACP wire capability set: this client reads and writes Pi's side only. */
export const CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
} as const;

export class AcpClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  private readonly rl;
  private disposed = false;

  constructor(
    readonly proc: ChildProcess,
    private readonly handlers: AcpHandlers,
    private readonly describeKill = (signal: NodeJS.Signals) => `agy was killed (signal ${signal})`,
  ) {
    this.rl = createInterface({ input: proc.stdout! });
    this.rl.on("line", (line) => this.onLine(line));
    proc.stdin?.on("error", () => {
      /* the exit handler owns the diagnostic */
    });
    // A process that dies mid-request must reject every waiter, not hang them.
    proc.once("exit", (code, signal) =>
      this.dispose(
        signal ? this.describeKill(signal) : `agy acp exited (${code ?? "unknown"}) before answering`,
      ),
    );
    proc.once("error", (error) => this.dispose(`agy acp failed: ${error.message}`));
  }

  request(method: string, params: unknown): Promise<any> {
    if (this.disposed) return Promise.reject(new Error("ACP connection closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private record(dir: "out" | "in", message: unknown): void {
    const target = process.env.PI_AGY_TETHER_DUMP;
    if (!target) return;
    try {
      appendFileSync(`${target}/frames.jsonl`, `${JSON.stringify({ dir, message })}\n`);
    } catch {
      /* diagnostic only */
    }
  }

  private write(message: unknown): void {
    if (this.disposed) return;
    this.record("out", message);
    try {
      this.proc.stdin!.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.handlers.onDiagnostic(
        `agy stdin write failed: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  }

  private onLine(line: string): void {
    try {
      this.record("in", JSON.parse(line));
    } catch {
      this.record("in", { raw: line });
    }
    const frame = parseFrame(line);
    if ("fault" in frame) {
      this.handlers.onDiagnostic(`agy ACP frame: ${frame.fault}`, "warn");
      return;
    }
    if (isResponse(frame)) {
      const id = Number(frame.id);
      const waiter = this.pending.get(id);
      if (!waiter) {
        this.handlers.onDiagnostic(`agy answered unknown request id ${frame.id}`, "warn");
        return;
      }
      this.pending.delete(id);
      if (frame.error) {
        const message =
          typeof frame.error.message === "string"
            ? `${frame.error.message}${frame.error.code !== undefined ? ` (code ${frame.error.code})` : ""}`
            : "ACP request failed";
        waiter.reject(new Error(message));
      } else {
        waiter.resolve(frame.result ?? {});
      }
      return;
    }
    if (isServerRequest(frame)) {
      this.answer(frame as { id: number | string; method: string; params?: any });
      return;
    }
    if (frame.method === "session/update") {
      this.handlers.onUpdate(frame.params?.update, frame.params);
      return;
    }
    // A notification this client does not subscribe to is not turn content.
    this.handlers.onDiagnostic(
      `agy ACP notification ${String(frame.method)} ignored`,
      "warn",
    );
  }

  private answer(request: { id: number | string; method: string; params?: any }): void {
    if (request.method === "session/request_permission") {
      void Promise.resolve(this.handlers.onPermissionRequest(request.params))
        .then((decision) => {
          this.write(
            decision.outcome === "allowed"
              ? {
                  jsonrpc: "2.0",
                  id: request.id,
                  result: {
                    outcome: {
                      outcome: "selected",
                      optionId: (this.allowOption(request.params) ?? "allow"),
                    },
                  },
                }
              : { jsonrpc: "2.0", id: request.id, result: { outcome: { outcome: "cancelled" } } },
          );
        })
        .catch(() => {
          this.write({
            jsonrpc: "2.0",
            id: request.id,
            result: { outcome: { outcome: "cancelled" } },
          });
        });
      return;
    }
    this.handlers.onDiagnostic(`agy requested unsupported client method ${request.method}`, "warn");
    this.write({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: "Pi tether does not implement this client method" },
    });
  }

  /** The `allow_once` option agy actually offered, by id. */
  private allowOption(params: any): string | undefined {
    const options: any[] = Array.isArray(params?.options) ? params.options : [];
    return options.find((option) => option?.kind === "allow_once")?.optionId;
  }

  /** Reject every outstanding request: the connection is gone. */
  dispose(reason = "ACP connection closed"): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rl.close();
    for (const [, waiter] of this.pending) waiter.reject(new Error(reason));
    this.pending.clear();
  }
}
