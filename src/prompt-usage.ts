import { lstatSync } from "node:fs";
import { join } from "node:path";
import { acpUsage, type AcpPromptResult } from "./event-bridge.js";

type Counts = ReturnType<typeof acpUsage>;
const counters = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens"] as const;

/** Read only requested protobuf scalars / a nested message; never decode step content. */
function fields(bytes: Uint8Array, wanted: readonly number[]) {
  let i = 0;
  const take = (n: number) => {
    if (n < 0 || n > bytes.length - i) throw new Error("truncated protobuf");
    i += n;
  };
  function varint(): bigint {
    let value = 0n;
    // Protobuf uint64 wire format permits at most ten bytes.
    for (let shift = 0n; shift <= 63n; shift += 7n) {
      take(1);
      const byte = bytes[i - 1]!;
      value |= BigInt(byte & 127) << shift;
      if (byte < 128 && (shift < 63n || byte < 2)) return value;
    }
    throw new Error("malformed varint");
  }
  const out = new Map<number, number | Uint8Array>();
  while (i < bytes.length) {
    const tag = Number(varint());
    if (!Number.isSafeInteger(tag) || tag < 8) throw new Error("invalid protobuf tag");
    const wire = tag % 8;
    const field = (tag - wire) / 8;
    let value: number | Uint8Array | undefined;
    if (wire === 0) value = Number(varint());
    else if (wire === 2) {
      const n = Number(varint());
      take(n);
      value = bytes.subarray(i - n, i);
    } else if (wire === 1 || wire === 5) take(wire === 1 ? 8 : 4);
    else throw new Error("unknown protobuf wire type");
    if (wanted.includes(field)) {
      if (out.has(field) || value === undefined) throw new Error("invalid usage field");
      out.set(field, value);
    }
  }
  return out;
}

function stepUsage(metadata: Uint8Array): Counts {
  // agy 1.5.16 trajectory steps: LLM step (type 15), StepMetadata.usage (9).
  // These tags were reconciled with all live ACP prompt terminals, not guessed
  // from ratios or from the context-only `usage_update` token count.
  const bytes = fields(metadata, [9]).get(9);
  if (!(bytes instanceof Uint8Array)) throw new Error("no step usage");
  const tags = fields(bytes, [2, 3, 4, 5, 9]);
  const get = (tag: number) => {
    const value = tags.get(tag) ?? 0; // default scalar omitted by protobuf
    if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error("invalid token count");
    return value;
  };
  const input = get(2), output = get(3), cacheWrite = get(4), cacheRead = get(5), reasoning = get(9);
  const totalTokens = input + output + cacheRead + cacheWrite;
  if (!Number.isSafeInteger(totalTokens) || !totalTokens || reasoning > output) throw new Error("invalid step usage");
  return { input, output, cacheRead, cacheWrite, reasoning, totalTokens, present: true };
}

function readDatabase<T>(path: string, read: (db: import("node:sqlite").DatabaseSync) => T): T | undefined {
  try {
    // Never create a database or follow a redirected file. No daemon or open
    // SQLite connection is held across prompts, and no busy timeout is set.
    if (!lstatSync(path).isFile()) return;
    const sqlite = process.getBuiltinModule?.("node:sqlite") as typeof import("node:sqlite") | undefined;
    if (!sqlite) return;
    const db = new sqlite.DatabaseSync(path, { readOnly: true });
    try { return read(db); }
    finally { db.close(); }
  } catch {
    // An unavailable, changing or unknown vendor schema is not zero spend.
    return undefined;
  }
}

/** One ACP prompt spans N Pi tool-use episodes plus one terminal episode. */
export class PromptUsage {
  private attributed = acpUsage(undefined);
  private handoffs = 0;
  private lost = false;

  private constructor(private path?: string, private cursor?: number) {}

  static begin(path: string, sessionId: string, version: string): PromptUsage {
    if (version !== "1.5.16" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId))
      return new PromptUsage();
    const db = join(path, "conversations", `${sessionId}.db`);
    const cursor = readDatabase(db, connection => connection.prepare(
      "SELECT coalesce(max(idx), -1) AS cursor FROM steps WHERE step_type = 15",
    ).get()?.cursor);
    return new PromptUsage(db, typeof cursor === "number" ? cursor : undefined);
  }

  handoff(contextTokens?: number): Counts {
    this.handoffs++;
    const cursor = this.cursor;
    const step = this.path && cursor !== undefined && !this.lost && contextTokens
      ? readDatabase(this.path, connection => {
          // One atomic prefix read. If there were several inference steps (e.g.
          // native search before a Pi tool), include all since the last handoff.
          let latest: Counts | undefined;
          let end = cursor;
          const sum = acpUsage(undefined);
          for (const row of connection.prepare(
            "SELECT idx, metadata FROM steps WHERE step_type = 15 AND idx > ? ORDER BY idx",
          ).iterate(cursor)) {
            if (!(row.metadata instanceof Uint8Array) || typeof row.idx !== "number") return;
            latest = stepUsage(row.metadata);
            end = row.idx;
            for (const key of counters) sum[key] += latest[key];
          }
          if (latest?.totalTokens !== contextTokens) return;
          return { end, sum: { ...sum, present: true } };
        })
      : undefined;
    if (!step) {
      this.lost = true;
      return acpUsage(undefined);
    }
    this.cursor = step.end;
    for (const key of counters) this.attributed[key] += step.sum[key];
    return step.sum;
  }

  terminal(usage: AcpPromptResult["usage"], contextTokens?: number): Counts {
    const counts = acpUsage(usage);
    if (!this.handoffs) return counts;
    if (this.lost || !counts.present) return acpUsage(undefined);
    for (const key of counters) counts[key] -= this.attributed[key];
    if (counters.some(key => counts[key] < 0) || counts.reasoning > counts.output ||
        !counts.totalTokens || (contextTokens !== undefined && counts.totalTokens < contextTokens))
      return acpUsage(undefined);
    return counts;
  }
}
