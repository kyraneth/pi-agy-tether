/**
 * Login handoff, the same pattern pi-muse-tether uses (src/settings.ts:16-30).
 *
 * agy owns its credential file. The tether links the existing login into its
 * private gemini home so the official client reads the file it already trusts,
 * and never reads, copies, prints or parses the bytes itself. A broken link is
 * a hard stop: there is no fallback credential path.
 */

import { mkdir, stat, lstat, readlink, symlink } from "node:fs/promises";
import { dirname } from "node:path";
import { hostLoginPath, loginLinkPath } from "./data-dir.js";

export interface LoginMetadata {
  inode: string;
  size: number;
  mtimeMs: number;
}

let linkFault: string | undefined;

export function assertLoginSafe(): void {
  if (linkFault) throw new Error(linkFault);
}

/**
 * Link `real` into the private gemini home and return the verification step the
 * caller repeats after the client has run. Metadata is reported, never edited:
 * the official client refreshing its own token is normal, not an incident.
 */
export async function linkHostLogin(
  real = hostLoginPath(),
  link = loginLinkPath(),
): Promise<() => Promise<{
  before: LoginMetadata;
  after: LoginMetadata;
  realMetadataChanged: boolean;
  symlinkIntact: boolean;
}> | undefined> {
  assertLoginSafe();
  try {
    await stat(real);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(
      code === "ENOENT"
        ? `agy login not found at ${real}. Run \`agy login\` with the official client first; the tether links that login and never creates one.`
        : `agy login is not readable at ${real} (${code ?? "unknown error"}). Fix the official login; the tether does not copy or repair credentials.`,
    );
  }
  await mkdir(dirname(link), { recursive: true, mode: 0o700 });
  let before = await stat(real);
  try {
    await symlink(real, link);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  return async () => {
    let intact = false;
    let missing = false;
    try {
      const privateState = await lstat(link);
      intact = privateState.isSymbolicLink() && (await readlink(link)) === real;
    } catch (error) {
      missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    }
    if (!intact) {
      linkFault = `agy login metadata symlink ${missing ? "missing" : "replaced"}; STOP, retain the private config and request account-owner review`;
      throw new Error(linkFault);
    }
    const after = await stat(real);
    const metadata = {
      before: {
        inode: String(before.ino),
        size: before.size,
        mtimeMs: before.mtimeMs,
      },
      after: {
        inode: String(after.ino),
        size: after.size,
        mtimeMs: after.mtimeMs,
      },
      realMetadataChanged:
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs,
      symlinkIntact: intact,
    };
    // A normal official-client refresh replaces the file. Report it; never
    // call it a credential incident and never repair it.
    before = after;
    return metadata;
  };
}

/** Test seam: a fault from a previous test must not outlive it. */
export function resetLoginFaultForTests(): void {
  linkFault = undefined;
}
