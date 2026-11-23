/**
 * Which models this tether registers: the Gemini families agy itself offers,
 * with the limits agy itself reports.
 *
 * agy 1.5.12 does not persist its model catalog. Its own `v1internal:
 * fetchAvailableModels` table is held in memory for the process, and a copy of
 * `agy models`, a real ACP `session/new` and a fresh data dir leave only session
 * state behind. The offered list is read from
 * the build's ACP answer, and the limits come from that same catalog: context
 * 1,048,576 for every family, and the per-family output below.
 *
 * ACP advertises each family once per effort level (`gemini-4-neon-high`, ...),
 * so the rows are grouped: one Pi model per family, with the levels agy offers
 * for it in `thinkingLevelMap` — not one row per suffix plus a second,
 * contradictory effort selector.
 *
 * Only Gemini families offered by agy are registered.
 *
 * Image input is declared only when the installed build advertises
 * `promptCapabilities.image` in its ACP `initialize` answer; the rows are re-registered with images once
 * that handshake says so. Claiming vision for a build that does not advertise
 * it would let Pi send content the vendor drops silently.
 */

import { getBuiltinModels as getModels } from "@earendil-works/pi-ai/providers/all";

export type AgyEffort = "low" | "medium" | "high" | "xhigh";

/** agy's effort suffixes, in the order it lists them. */
export const AGY_EFFORTS: readonly AgyEffort[] = ["low", "medium", "high", "xhigh"];

export interface AgyFamily {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  /** Levels agy advertises for this family, in agy's order. */
  effortLevels: readonly AgyEffort[];
  /** False when agy lists the family without reporting its limits. */
  limitsReported: boolean;
}

/** A family as agy advertises it, before the limits are attached. */
export interface OfferedFamily {
  id: string;
  name: string;
  effortLevels: AgyEffort[];
}

interface ReportedLimits {
  contextWindow: number;
  maxTokens: number;
}

/**
 * The limits agy reports for the families it offers this login.
 *
 * Source: the model limits reported by agy 1.5.12. ACP's `usage_update`
 * also reports the context window as `size: 1048576`.
 *
 * Google's model page says Neon's context is 512K; agy reports 1,048,576 and
 * agy is what runs the turn, so agy's number is the one registered.
 */
const AGY_LIMITS: Record<string, ReportedLimits> = {
  "gemini-4-neon": { contextWindow: 1_048_576, maxTokens: 262_144 },
  "gemini-4-argon": { contextWindow: 1_048_576, maxTokens: 65_536 },
  "gemini-4-hydrogen": { contextWindow: 1_048_576, maxTokens: 262_144 },
  "gemini-3.8-flash": { contextWindow: 1_048_576, maxTokens: 65_536 },
  "gemini-pro-orchestrator-neon": { contextWindow: 1_048_576, maxTokens: 262_144 },
  "gemini-pro-orchestrator-g1-pro": { contextWindow: 1_048_576, maxTokens: 65_536 },
};

/**
 * Numbers for a family agy offers but reports no limits for. Pi needs a context
 * window and an output cap, so the row borrows the values agy reports for a
 * session (1,048,576) and the smallest output it reports for a Gemini family
 * (65,536), and the name says agy did not report them. Nothing is dropped and
 * nothing is claimed to be this family's own limit.
 */
const UNREPORTED_LIMITS: ReportedLimits = {
  contextWindow: 1_048_576,
  maxTokens: 65_536,
};

/** `Gemini 4 Neon (High)` → `Gemini 4 Neon`; the variant's own family name. */
function stripEffortSuffix(name: string | undefined, id: string): string {
  const stripped = name?.replace(/\s*\((low|medium|high|xhigh)\)$/i, "");
  return stripped && stripped.length > 0 ? stripped : id;
}

/** Attach agy's reported limits to one offered family. */
export function familyRow(offered: OfferedFamily): AgyFamily {
  const limits = AGY_LIMITS[offered.id];
  const reported = limits !== undefined;
  const resolved = limits ?? UNREPORTED_LIMITS;
  return {
    id: offered.id,
    name: offered.name,
    contextWindow: resolved.contextWindow,
    maxTokens: resolved.maxTokens,
    effortLevels: [...offered.effortLevels].sort(
      (a, b) => AGY_EFFORTS.indexOf(a) - AGY_EFFORTS.indexOf(b),
    ),
    limitsReported: reported,
  };
}

/**
 * The three families this tether registered before it read agy's list, kept for
 * when nothing can be read at all (no cache, no answer from the build).
 */
const FALLBACK: OfferedFamily[] = [
  { id: "gemini-4-argon", name: "Gemini 4 Argon", effortLevels: ["low", "medium", "high"] },
  { id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen", effortLevels: ["low", "medium", "high", "xhigh"] },
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", effortLevels: ["low", "medium", "high"] },
];

export const FALLBACK_FAMILIES: readonly AgyFamily[] = FALLBACK.map(familyRow);

/**
 * Group agy's per-effort variant list into one family per Gemini base id.
 *
 * `variants` is ACP `models.availableModels`; `familyNames` is the `model`
 * config option, which carries the family's own display name ("Gemini 4 Neon")
 * rather than the variant's ("Gemini 4 Neon (High)").
 */
export function familiesFromOffered(
  variants: readonly { id: string; name?: string }[],
  familyNames: ReadonlyMap<string, string> = new Map(),
): AgyFamily[] {
  const grouped = new Map<string, { name?: string; effortLevels: AgyEffort[] }>();
  for (const variant of variants) {
    // Claude Opus/Sonnet and GPT-OSS arrive in the same list; not ours.
    if (!variant.id.startsWith("gemini")) continue;
    const effort = AGY_EFFORTS.find((level) => variant.id.endsWith(`-${level}`));
    const id = effort
      ? variant.id.slice(0, -(effort.length + 1))
      : variant.id;
    const entry = grouped.get(id) ?? { effortLevels: [] };
    if (effort !== undefined && !entry.effortLevels.includes(effort))
      entry.effortLevels.push(effort);
    entry.name ??= variant.name;
    grouped.set(id, entry);
  }
  return [...grouped].map(([id, entry]) =>
    familyRow({
      id,
      name: familyNames.get(id) ?? stripEffortSuffix(entry.name, id),
      effortLevels: entry.effortLevels,
    }),
  );
}

/** The offered families in one ACP `session/new` result. */
export function familiesFromSessionNew(opened: unknown): AgyFamily[] {
  const result = (opened ?? {}) as {
    models?: { availableModels?: unknown };
    configOptions?: unknown;
  };
  const variants = Array.isArray(result.models?.availableModels)
    ? result.models.availableModels
        .map((entry: any) => ({
          id: typeof entry?.modelId === "string" ? entry.modelId : "",
          name: typeof entry?.name === "string" ? entry.name : undefined,
        }))
        .filter((entry) => entry.id.length > 0)
    : [];
  const modelOption = Array.isArray(result.configOptions)
    ? result.configOptions.find((option: any) => option?.id === "model")
    : undefined;
  const familyNames = new Map<string, string>(
    (Array.isArray(modelOption?.options) ? modelOption.options : [])
      .filter((option: any) => typeof option?.value === "string" && typeof option?.name === "string")
      .map((option: any) => [option.value as string, option.name as string]),
  );
  return familiesFromOffered(variants, familyNames);
}

/**
 * The catalog Pi has registered in this process. Starts as the fallback so a
 * turn that somehow runs before discovery still has an honest answer.
 */
let catalog: readonly AgyFamily[] = FALLBACK_FAMILIES;

export function setAgyCatalog(families: readonly AgyFamily[]): void {
  catalog = families.length > 0 ? families : FALLBACK_FAMILIES;
}

export function agyFamilies(): readonly AgyFamily[] {
  return catalog;
}

export function familyFor(modelId: string): AgyFamily | undefined {
  return catalog.find((family) => family.id === modelId);
}

/**
 * Pi thinking level → this family's offered effort. `off`/`minimal` mean "do
 * not ask for a level" (agy has no off switch), and a level agy does not offer
 * is a refusal rather than a silent downgrade.
 */
export function effortFor(
  family: AgyFamily,
  thinkingLevel: string | undefined,
): AgyEffort | undefined {
  if (thinkingLevel === undefined || thinkingLevel === "off" || thinkingLevel === "minimal")
    return undefined;
  if ((family.effortLevels as readonly string[]).includes(thinkingLevel))
    return thinkingLevel as AgyEffort;
  throw new Error(
    `${family.id} does not offer thinking level ${thinkingLevel}; agy offers ${family.effortLevels.join(", ")}. Choose one of those or a lower level; the tether does not clamp.`,
  );
}

/** Pi's per-model level map: only levels this family actually offers. */
export function thinkingLevelMap(
  family: AgyFamily,
): Record<string, string | null> {
  const map: Record<string, string | null> = {
    off: null,
    minimal: null,
    low: null,
    medium: null,
    high: null,
    xhigh: null,
    max: null,
  };
  for (const level of family.effortLevels) map[level] = level;
  return map;
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function builtinGoogleCosts(): ReadonlyMap<string, any> {
  try {
    return new Map(getModels("google").map((model) => [model.id, model.cost]));
  } catch {
    return new Map();
  }
}

/**
 * Rows for `pi.registerProvider`. Known Gemini models carry Pi's built-in
 * Google list rates so `calculateCost` reports notional API spend (matching
 * subscription-tether convention); unlisted families stay at zero rather than
 * guessing.
 */
export function agyModels(
  options: { images?: boolean } = {},
  families: readonly AgyFamily[] = catalog,
): any[] {
  const input: ("text" | "image")[] = options.images ? ["text", "image"] : ["text"];
  const costs = builtinGoogleCosts();
  return families.map((family) => ({
    id: family.id,
    // The reader picks from this name, and the row still has to carry a number
    // Pi can budget with, so the note lives here rather than in the cache.
    name: family.limitsReported ? family.name : `${family.name} (limits not reported)`,
    reasoning: family.effortLevels.length > 0,
    input,
    cost: costs.get(family.id) ?? ZERO_COST,
    contextWindow: family.contextWindow,
    maxTokens: family.maxTokens,
    thinkingLevelMap: thinkingLevelMap(family),
  }));
}
