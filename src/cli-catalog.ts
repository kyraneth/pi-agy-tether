/**
 * Register one Pi model per family advertised in ACP session/new. Adjustable
 * variants (such as gemini-4-neon-high) become thinking levels, not separate
 * model IDs. A literal match to an ACP model option takes precedence over
 * suffix parsing.
 *
 * Image input requires both known family support and the installed build's
 * ACP promptCapabilities.image declaration.
 */

import { getBuiltinModels as getModels } from "@earendil-works/pi-ai/providers/all";

/** agy's effort suffixes, in the order it lists them. */
export const AGY_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AgyEffort = (typeof AGY_EFFORTS)[number];

export interface AgyFamily extends ReportedLimits {
  id: string;
  name: string;
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
  supportsImages: boolean;
}

/**
 * Sources: the model catalog reported by agy 1.5.12, ACP usage_update
 * context sizes, and Pi's built-in Anthropic catalog for Claude 4.6.
 *
 * Google's model page says Neon's context is 512K; agy reports 1,048,576 and
 * agy is what runs the turn, so agy's number is the one registered.
 */
const GEMINI_LONG_OUTPUT = { contextWindow: 1_048_576, maxTokens: 262_144, supportsImages: true };
const GEMINI_SHORT_OUTPUT = { contextWindow: 1_048_576, maxTokens: 65_536, supportsImages: true };
const CLAUDE = { contextWindow: 1_000_000, maxTokens: 128_000, supportsImages: true };

const AGY_LIMITS = new Map<string, ReportedLimits>([
  ["gemini-4-neon", GEMINI_LONG_OUTPUT],
  ["gemini-4-carbon", GEMINI_LONG_OUTPUT],
  ["gemini-4-argon", GEMINI_SHORT_OUTPUT],
  ["gemini-4-hydrogen", GEMINI_LONG_OUTPUT],
  ["gemini-3.8-flash", GEMINI_SHORT_OUTPUT],
  ["gemini-pro-orchestrator-neon", GEMINI_LONG_OUTPUT],
  ["gemini-pro-orchestrator", GEMINI_LONG_OUTPUT],
  ["gemini-pro-orchestrator-argon", GEMINI_SHORT_OUTPUT],
  ["gemini-pro-orchestrator-g1-pro", GEMINI_SHORT_OUTPUT],
  ["claude-opus-5-5", CLAUDE],
  ["claude-sonnet-5-5", CLAUDE],
  ["claude-opus-4-6", CLAUDE],
  ["claude-sonnet-4-6", CLAUDE],
  ["gpt-oss-120b-medium", { contextWindow: 131_072, maxTokens: 32_768, supportsImages: false }],
]);

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
  supportsImages: false,
};

/** `Gemini 4 Neon (High)` → `Gemini 4 Neon`; the variant's own family name. */
function stripEffortSuffix(name: string | undefined, id: string): string {
  const stripped = name?.replace(/\s*\((low|medium|high|xhigh|max)\)$/i, "");
  return stripped && stripped.length > 0 ? stripped : id;
}

/** Attach agy's reported limits to one offered family. */
export function familyRow(offered: OfferedFamily): AgyFamily {
  const limits = AGY_LIMITS.get(offered.id);
  return {
    id: offered.id,
    name: offered.name,
    ...(limits ?? UNREPORTED_LIMITS),
    effortLevels: [...offered.effortLevels].sort(
      (a, b) => AGY_EFFORTS.indexOf(a) - AGY_EFFORTS.indexOf(b),
    ),
    limitsReported: limits !== undefined,
  };
}

/** Provisional choices only: live ACP readback still verifies availability. */
const FALLBACK: OfferedFamily[] = [
  { id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen", effortLevels: ["low", "medium", "high", "xhigh"] },
  { id: "gemini-4-neon", name: "Gemini 4 Neon", effortLevels: ["low", "medium", "high", "xhigh"] },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", effortLevels: ["low", "medium", "high"] },
];

export const FALLBACK_FAMILIES: readonly AgyFamily[] = FALLBACK.map(familyRow);

/**
 * Group agy's per-effort variant list into one row per family.
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
    // GPT-OSS's "-medium" is part of its literal model option, not an effort.
    const effort = familyNames.has(variant.id)
      ? undefined
      : AGY_EFFORTS.find((level) => variant.id.endsWith(`-${level}`));
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
      name: familyNames.get(id) || (entry.effortLevels.length ? stripEffortSuffix(entry.name, id) : entry.name || id),
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
      .filter((option: any) => typeof option?.value === "string" && option.value.length > 0)
      .map((option: any) => [option.value as string, typeof option.name === "string" ? option.name : ""]),
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

/** Do not send image blocks on the wire when this family cannot carry them. */
export function assertImageSupport(modelId: string, blocks: readonly { type?: unknown }[]): void {
  if (familyFor(modelId)?.supportsImages === false && blocks.some(b => b?.type === "image"))
    throw new Error(`pi-agy-tether refused to send image input to ${modelId}: this model is text-only and agy would drop or reject images.`);
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
  if (family.effortLevels.length === 0)
    throw new Error(`${family.id} does not offer adjustable thinking levels (fixed by agy); omit --thinking or use off.`);
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

function builtinModelCosts(): ReadonlyMap<string, typeof ZERO_COST> {
  const costs = new Map<string, typeof ZERO_COST>();
  for (const provider of ["google", "anthropic", "openai"] as const)
    for (const model of getModels(provider)) costs.set(model.id, model.cost);
  return costs;
}

/**
 * Rows for `pi.registerProvider`: first-party list rates are notional API
 * spend, not subscription charges. Unlisted families stay at zero.
 */
export function agyModels(
  options: { images?: boolean } = {},
  families: readonly AgyFamily[] = catalog,
): any[] {
  const costs = builtinModelCosts();
  return families.map((family) => ({
    id: family.id,
    // The reader picks from this name, and the row still has to carry a number
    // Pi can budget with, so the note lives here rather than in the cache.
    name: family.limitsReported ? family.name : `${family.name} (limits not reported)`,
    reasoning: family.effortLevels.length > 0,
    input: options.images === true && family.supportsImages ? ["text", "image"] : ["text"],
    cost: costs.get(family.id) ?? ZERO_COST,
    contextWindow: family.contextWindow,
    maxTokens: family.maxTokens,
    thinkingLevelMap: thinkingLevelMap(family),
  }));
}
