/**
 * Which model families agy offers this login, learned from agy itself.
 *
 * agy 1.5.12 keeps its model catalog in memory only: neither `agy models` nor a
 * real ACP `session/new` writes one to its data dir. The build does advertise the list on `session/new`,
 * so that answer is the source:
 *
 * - the first Pi start with no cache asks once (one short ACP handshake — no
 *   prompt, no tokens, the login only linked by reference) and writes what agy
 *   answered here;
 * - later starts read the cache, so they stay instant and work offline;
 * - every real ACP session refreshes it from its own `session/new`.
 *
 * A missing, unreadable or unexpected cache contributes nothing: the fallback
 * families are registered instead. This file is not a credential — it holds
 * model ids, names and effort levels.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { AcpClient, CLIENT_CAPABILITIES, CLIENT_INFO } from "./acp-client.js";
import {
  AGY_EFFORTS,
  FALLBACK_FAMILIES,
  familiesFromSessionNew,
  familyRow,
  setAgyCatalog,
  type AgyFamily,
  type OfferedFamily,
} from "./cli-catalog.js";
import { catalogCachePath, privateWorkspace } from "./data-dir.js";
import { linkHostLogin } from "./login.js";
import {
  forceKillProcess,
  registerProcess,
  spawnAcpProbe,
} from "./process-manager.js";

// v2 invalidates Gemini-only caches so upgrades rediscover every offered family.
const CACHE_VERSION = 2;

/** Read one cached entry as an offered family, or nothing if it is not one. */
function parseCached(entry: unknown): OfferedFamily | undefined {
  const raw = (entry ?? {}) as {
    id?: unknown;
    name?: unknown;
    effortLevels?: unknown;
  };
  if (typeof raw.id !== "string" || raw.id.length === 0) return undefined;
  const levels = Array.isArray(raw.effortLevels)
    ? raw.effortLevels.filter((level): level is string => typeof level === "string")
    : [];
  return {
    id: raw.id,
    name: typeof raw.name === "string" && raw.name.length > 0 ? raw.name : raw.id,
    effortLevels: AGY_EFFORTS.filter((level) => levels.includes(level)),
  };
}

/** The families the last session advertised, or nothing if the cache is unusable. */
export function readCachedFamilies(path = catalogCachePath()): AgyFamily[] | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { version?: unknown; families?: unknown };
    if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.families)) return undefined;
    const families = parsed.families
      .map(parseCached)
      .filter((family): family is OfferedFamily => family !== undefined)
      .map(familyRow);
    return families.length > 0 ? families : undefined;
  } catch {
    return undefined;
  }
}

/** Keep the offered list for the next start. Failing to write is not fatal. */
export function writeCachedFamilies(
  families: readonly AgyFamily[],
  path = catalogCachePath(),
): void {
  const payload = {
    version: CACHE_VERSION,
    source: "agy acp session/new",
    families: families.map(({ id, name, effortLevels }) => ({ id, name, effortLevels })),
  };
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } catch {
    /* a cache that cannot be written costs one probe on the next start */
  }
}

/** A cold catalog discovery also observes capabilities from its initialize. */
export async function probeStartup(catalog: boolean): Promise<{ families: AgyFamily[]; image?: boolean }> {
  let proc: ReturnType<typeof spawnAcpProbe> | undefined;
  let client: AcpClient | undefined;
  let image: boolean | undefined;
  try {
    // Only session/new needs authentication. Initialize is local.
    if (catalog) await linkHostLogin();
    const cwd = privateWorkspace("catalog");
    proc = spawnAcpProbe(cwd);
    registerProcess(proc);
    client = new AcpClient(proc, {
      onUpdate() {},
      onPermissionRequest: () => ({ outcome: "denied" }),
      onDiagnostic() {},
    });
    const initialized = await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: CLIENT_CAPABILITIES,
      clientInfo: CLIENT_INFO,
    });
    image = initialized?.agentCapabilities?.promptCapabilities?.image === true;
    const opened = catalog
      ? await client.request("session/new", { cwd, mcpServers: [] })
      : undefined;
    return { image, families: opened ? familiesFromSessionNew(opened) : [] };
  } catch {
    return { image, families: [] };
  } finally {
    client?.dispose();
    forceKillProcess(proc);
  }
}

/**
 * The catalog for this process: the cache, else one probe, else the fallback.
 * Never throws and never leaves the process without a catalog.
 */
export async function startupCatalog(): Promise<{ families: readonly AgyFamily[]; image?: boolean }> {
  const cached = readCachedFamilies();
  if (cached) return { families: cached };
  const { families, image } = await probeStartup(true);
  if (families.length) writeCachedFamilies(families);
  return { families: families.length ? families : FALLBACK_FAMILIES, image };
}

/**
 * Adopt one `session/new` answer: refresh the cache and the catalog that
 * `src/thinking-config.ts` validates against.
 */
export function rememberOfferedFamilies(opened: unknown): readonly AgyFamily[] {
  const families = familiesFromSessionNew(opened);
  if (families.length > 0) {
    setAgyCatalog(families);
    writeCachedFamilies(families);
  }
  return families.length > 0 ? families : FALLBACK_FAMILIES;
}
