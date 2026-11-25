/**
 * Model and effort configuration of a live ACP session.
 *
 * ACP reports the offered model families and thinking levels as config options
 * on `session/new`, `session/load` and `session/resume`. A
 * loaded session reporting `thought_level: medium` even though the original
 * session was set to `low`, so the tether never trusts a
 * default: it verifies live readback on every establishment and before each
 * new prompt. A warm effort write returns the model and effort together.
 */

import { effortFor, familyFor } from "./cli-catalog.js";

export interface ConfigOption {
  id: string;
  name?: string;
  category?: string;
  type?: string;
  currentValue?: string;
  options?: { value: string; name?: string }[];
}

export interface SessionConfig {
  family: string;
  /** Undefined when Pi asked for no specific level (`off`/`minimal`). */
  effort?: string;
  /** The option values the session actually ended up with, after readback. */
  readback: { model?: string; thought_level?: string };
}

export function desiredConfig(
  modelId: string,
  thinkingLevel: string | undefined,
): { family: string; effort?: string } {
  const family = familyFor(modelId);
  if (!family)
    throw new Error(
      `${modelId} is not a family agy advertises or this tether registers; refusing to guess a family or effort`,
    );
  return { family: family.id, effort: effortFor(family, thinkingLevel) };
}

function optionValue(
  options: readonly ConfigOption[] | undefined,
  id: string,
): string | undefined {
  return options?.find((o) => o.id === id)?.currentValue;
}

/**
 * Check the readback of `session/set_config_option`. A family or effort that
 * does not match what Pi asked for is a refusal, never a silent downgrade.
 */
export function assertConfigApplied(
  options: readonly ConfigOption[] | undefined,
  desired: { family: string; effort?: string },
): SessionConfig {
  const model = optionValue(options, "model");
  const thought_level = optionValue(options, "thought_level");
  if (model !== desired.family)
    throw new Error(
      `agy session config readback model=${model ?? "missing"} but Pi selected ${desired.family}; refusing the turn`,
    );
  if (desired.effort !== undefined && thought_level !== desired.effort)
    throw new Error(
      `agy session config readback thought_level=${thought_level ?? "missing"} but Pi selected ${desired.effort}; refusing the turn`,
    );
  return {
    family: desired.family,
    effort: desired.effort,
    readback: { model, thought_level },
  };
}

export type SetConfigOption = (id: string, value: string) => Promise<readonly ConfigOption[] | undefined>;

/** Establish a session based on the options returned by session/new. */
export async function configureSession(
  set: SetConfigOption,
  desired: { family: string; effort?: string },
  initial: readonly ConfigOption[] | undefined,
  marker: boolean,
): Promise<SessionConfig> {
  if (initial && !offeredValues(initial, "model").includes(desired.family))
    throw new Error(`agy does not offer model family ${desired.family} to this account; offered: ${offeredValues(initial, "model").join(", ") || "none"}`);
  let options = initial;
  if (optionValue(options, "model") !== desired.family)
    options = await set("model", desired.family);
  const offered = offeredValues(options, "thought_level");
  if (desired.effort !== undefined && options && !offered.includes(desired.effort))
    throw new Error(`agy does not offer thought_level ${desired.effort}; offered: ${offered.join(", ") || "none"}`);
  // Only the hidden proof turn can use low, and only when an explicit effort
  // will be restored and the selected family actually advertises low.
  const effort = marker && desired.effort !== undefined && offered.includes("low") ? "low" : desired.effort;
  if (effort !== undefined && optionValue(options, "thought_level") !== effort)
    options = await set("thought_level", effort);
  return assertConfigApplied(options, { ...desired, effort });
}

/** One live response must verify both fields, even when reasserting just one. */
export async function verifyPromptConfig(
  set: SetConfigOption,
  desired: { family: string; effort?: string },
): Promise<SessionConfig> {
  const options = desired.effort === undefined
    ? await set("model", desired.family)
    : await set("thought_level", desired.effort);
  return assertConfigApplied(options, desired);
}

/** Offered option values from an ACP config-option readback. */
export function offeredValues(
  options: readonly ConfigOption[] | undefined,
  id: string,
): string[] {
  return (options?.find((o) => o.id === id)?.options ?? [])
    .map((option) => option?.value)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}
