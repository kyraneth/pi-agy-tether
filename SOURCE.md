# pi-agy-tether — source provenance

This package is a port of MIT-licensed [`pi-claude-tether`](https://github.com/kyraneth/pi-claude-tether) v0.12.1, which itself descends from `@saccolabs/pi-claude-cli` 0.10.0 and [rchern/pi-claude-cli](https://github.com/rchern/pi-claude-cli). The original copyright and license are retained verbatim in `LICENSE`.

The template's architecture is kept: Pi owns the system prompt, the tool surface and the history; one long-lived official CLI process per session serves follow-up turns; every tool executes in Pi; warm reuse is passive rather than periodic cache refreshing.

What changed for Antigravity:

- The transport is Google's official `agy acp` server (Agent Client Protocol over stdio) instead of `claude -p`.
- Driver modules are replaced: `acp-client.ts` (JSON-RPC framing, request/prompt waiters, permission answering), `cli-process.ts` (recipe → login link → spawn → `session/new` → marker check → per-turn config assertion), `event-bridge.ts` (ACP `session/update` → Pi assistant stream), `agent-recipe.ts` (the workspace agent that carries Pi's prompt), `thinking-config.ts` (model family + `thought_level`, with readback refusal).
- The tool handoff keeps the template's shape: a schema-only MCP server named `pi` advertises exactly the current request's tools, and each call blocks on the local socket for Pi to execute it.
- Not ported, because the driver does not have them: Claude account management and failover, usage-credit guard, CLI version/update policy, receipt confirmation taxonomies, rate-limit header forwarding, input envelopes and context-policy gates.
- Antigravity specifics: package identity `pi-agy-tether`, a private gemini home linked to the official login, a workspace agent recipe (`pi-local-explicit`) with `excludeDefaultComponents`/`inheritMcp: false`, a session marker check, and moving the two prompt passages agy's gateway refuses out of the system instruction into the first prompt of each session (see README and `src/agent-recipe.ts`).

Model registration follows agy's own answer instead of a fixed list: `cli-catalog.ts` groups the per-effort variants agy advertises on ACP `session/new` into one Pi row per Gemini family and attaches the limits agy reports for that family, and `model-discovery.ts` caches the offer in the tether's home (refreshed by every real session) so a start needs no extra handshake. Claude Opus/Sonnet 5.5 and GPT-OSS 120B are offered to the same client and deliberately not registered. Image input is declared from the installed build's own ACP `initialize` answer.
