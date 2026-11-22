import { createRuntimeDirectory } from "pi-tether-core/runtime";
export { RUNTIME_FILE_MODE, HANDOFF_SOCKET_NAME } from "pi-tether-core/runtime";

const runtime = createRuntimeDirectory("pi-agy-");
export const { existingRuntimeDir, cleanupRuntimeDir, resetRuntimeDirForTests } =
  runtime;

/** Name the failing boundary without claiming an unrelated login is broken. */
export function runtimeDir(): string {
  try {
    return runtime.runtimeDir();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `agy tether runtime directory unavailable: ${detail}. Check TMPDIR and XDG_RUNTIME_DIR and the sandbox write grants.`,
      { cause: error },
    );
  }
}

export function runtimeFile(name: string): string {
  runtimeDir();
  return runtime.runtimeFile(name);
}
