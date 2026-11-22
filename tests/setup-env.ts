/**
 * Clear this extension's own knobs before any test runs.
 *
 * Every `PI_AGY_TETHER_*` variable changes what the provider does. A host using
 * this extension passes settings into subprocesses, so the suite clears them
 * and gives each test fresh XDG/state/agent directories: a developer's real
 * tether home (private gemini home, linked login) must never leak in.
 */
import { beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "pat-test-state-"));
process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), "pat-test-data-"));
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pat-test-agent-"));

for (const key of Object.keys(process.env)) {
  if (key.startsWith("PI_AGY_TETHER_") || key.startsWith("PI_AGY_CLI_")) {
    delete process.env[key];
  }
}

beforeEach(() => {
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pat-test-agent-"));
  process.env.PI_AGY_TETHER_HOME = mkdtempSync(join(tmpdir(), "pat-test-home-"));
});
