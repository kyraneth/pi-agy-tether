/**
 * What the last ACP session established, for the `agy-cli` status command.
 *
 * The handshake is observed live; the proof records whether the marker
 * was verified here or reused for this client version, recipe format, and family.
 */

export interface CliStatus {
  binary?: string;
  agentVersion?: string;
  agentName?: string;
  agentProof?: "marker" | "cached";
  offeredModels?: string[];
  configured?: { model: string; effort: string };
  loginLinked?: boolean;
  lastRetirement?: string[];
  lastError?: string;
}

const status: CliStatus = {};

export function recordStatus(patch: Partial<CliStatus>): void {
  Object.assign(status, patch);
}

export function cliStatus(): CliStatus {
  return { ...status };
}

export function resetStatusForTests(): void {
  for (const key of Object.keys(status)) delete (status as any)[key];
}

/** One human-readable block for `agy-cli`. */
export function cliStatusLine(s: CliStatus = cliStatus()): string {
  const lines = [
    `binary: ${s.binary ?? "unknown"}`,
    `agy acp: ${s.agentVersion ?? "not observed in this Pi process yet"}`,
    `agent: ${s.agentName ?? "not observed"}${s.agentProof ? ` (${s.agentProof === "marker" ? "marker verified" : "cached proof"})` : ""}`,
    `offered models: ${s.offeredModels?.length ? s.offeredModels.join(", ") : "not observed"}`,
    `configured: ${s.configured ? `${s.configured.model} / effort ${s.configured.effort}` : "not observed"}`,
    `login: ${s.loginLinked ? "official login linked by reference" : "not observed"}`,
  ];
  if (s.lastRetirement?.length) lines.push(`last retirement: ${s.lastRetirement.join(", ")}`);
  if (s.lastError) lines.push(`last error: ${s.lastError}`);
  return lines.join("\n");
}
