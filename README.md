# pi-agy-tether

Use your Google Antigravity subscription in [Pi](https://pi.dev) through Google's official [Antigravity CLI](https://antigravity.google/docs/cli).

Pi owns the system prompt, tools, and conversation history. The tether starts `agy acp` using the [Agent Client Protocol](https://agentclientprotocol.com) to run the model. When the model asks to use a tool, the tether hands the call to Pi and returns the result to the same agy session.

## Install

You need Node.js 22 or newer, Pi 1.5.0 or newer, an Antigravity subscription, and the official `agy` executable on your `PATH`.

```sh
agy login
pi install npm:pi-agy-tether
```

Start Pi and choose a model from **pi-agy-tether** in `/model`. The official CLI manages your login; the tether links to its login file rather than copying it or asking for an API key. If your login expires, run `agy login` again.

## Models

The tether discovers every model family and thinking level that `agy` advertises for your account, including Gemini, Orchestrator, Claude Opus/Sonnet 5.5, and GPT-OSS 120B when your plan offers them. The list is cached for later starts and refreshed by new ACP sessions. If discovery fails without a usable cache, Pi shows a small fallback list; the selected model and effort are still verified against the live session before use.

Fixed-effort models such as Orchestrator and GPT-OSS 120B have no adjustable thinking selector. Image input is enabled only when both the installed `agy` build and the selected family support images. Text-only families refuse image-bearing turns rather than dropping attachments.

API-equivalent cost uses Pi's built-in first-party list rates (Google for Gemini), not subscription charges. On agy 1.5.16, ACP `usage_update.used` is context occupancy, and `session/prompt` returns cumulative spend only after the final tool handoff. For each Pi tool call, the tether reads agy's private conversation database read-only and checks the latest inference's count against the ACP update. The terminal gets only the spend not already attributed to tool calls. If the counts cannot be verified, usage is marked unavailable (`null`), not zero; `totalTokens` still carries occupancy for Pi's compaction. Models without list rates have unavailable cost even when token counts are known.

**Third-party and open-source model terms.** Under Section 8 of the [Google Antigravity Additional Terms of Service](https://antigravity.google/terms), selecting a third-party or open-source model subjects you to that model's terms, including [Anthropic's Commercial Terms](https://www.anthropic.com/legal/commercial-terms) for Claude. Google [documents](https://antigravity.google/docs/models.md) that lightweight Gemini models can still coordinate in the background and that third-party models draw from a separate quota pool from Gemini.

## Verify the agent recipe

The tether checks that agy loaded the private recipe carrying Pi's instructions. It reuses a successful check for the same agy version, recipe format, and model family but still checks for fallback to agy's default agent in every session.

Use `PI_AGY_TETHER_VERIFY=always pi` to run the marker check on every new ACP session. This adds a model turn at startup.

## Optional image tool

Start Pi with `PI_AGY_TETHER_IMAGE_TOOL=1` to register `agy_generate_image` (off by default). An isolated ACP session calls the native image tool without Pi's other tools. It returns a retained JPEG and an image Pi can show the model. `model` names the verified conversation model; agy 1.5.16 does not report the separate image backend through ACP, so `imageModel` is unknown.

For edits, pass `inputImages` with an earlier result path from the same Pi session, or place a JPEG, PNG, or WebP directly in that session's image artifact directory (`$PI_AGY_TETHER_HOME/artifacts/<SHA-256 of Pi session ID>`, underneath the usual tether data directory when not overridden). References are staged without overwriting them. Errors distinguish sign-in/consent, refusal, quota, missing image, and unconfirmed completion. Do not repeat an unconfirmed call automatically: agy may already have generated an image.

## Optional native web search

Set `PI_AGY_TETHER_NATIVE_SEARCH=1` to let agy use its own `search_web` alongside Pi tools (off by default). Pi discloses this once per session and displays each query as `[agy native search]`. Those entries are observations, not Pi tool calls. agy 1.5.16 does not expose successful search results through ACP; Pi does not read agy’s database. Verify citations separately rather than treating the model’s answer as primary evidence. Search can make multiple requests in one turn. Pi abort cancels and retires the local ACP process. Strict mode refuses this option. Deprecated native URL reading is not offered.

## Known limits

- **Single-turn input limit.** agy 1.5.12 and 1.5.16 were both observed cutting off input after 192,000 bytes in one turn. The tether sends long conversation history and summaries across multiple turns. If one historical entry alone exceeds that limit, the tether refuses replay before inference and leaves the Pi journal intact. It never reruns the historical tool; use a provider that can restore the journal or curate a branch in Pi.
- **Restarting Pi can lose cache reuse.** While Pi stays open, follow-up turns reuse the live ACP session. After a restart, Pi restores the conversation, but agy receives the earlier assistant and tool turns as labeled text rather than native messages. That is not a warm cache resume. See [restart behavior](docs/restart-cache.md).
- **Tool results are not lossless.** agy adds timestamps and limits rendered single-text results to 10,240 bytes on the measured builds (1.5.12 and 1.5.16). The tether warns with byte counts on a known clip, or when a result can only be replayed as history text. Other results may have unverifiable delivery, which goes to the log, not the screen. Pi keeps the full result. `PI_AGY_TETHER_STRICT=1` refuses unverified result delivery instead, without retrying the tool.
- **The effective tool catalog is not verifiable via ACP.** In one full-catalog measurement on agy 1.5.16, 54 of 60 Pi declarations reached the model. agy can also rewrite schemas or still offer native declarations. The tether cannot identify individual dropped declarations from this ACP build. The recipe requests suppression of known native tools; unless you enable native search, Pi authorizes only exactly bound, declared Pi calls. `PI_AGY_TETHER_STRICT=1` refuses an unverifiable catalog before inference.
- **Explicit generation controls.** ACP does not carry Pi's `temperature`, `maxTokens`, or `toolChoice`. When the request actually sets any of these, the tether warns once per Pi session and names only the ignored controls that were sent. `PI_AGY_TETHER_STRICT=1` refuses before inference.
- **Gateway system-instruction workaround.** When Pi's “running inside Pi” line or `<docs>` section matches the workaround, the tether moves the affected text into the first user prompt (without the docs delimiters). `PI_AGY_TETHER_STRICT=1` refuses instead of changing their role.
- **Usage and cost.** Pi displays Antigravity’s reported token use when it can attribute it to an assistant message. If it cannot, usage and cost are unavailable, not zero. Cost is an API-price equivalent, not a subscription charge.
- **Memory guard.** On Linux the tether retires agy under host or cgroup memory pressure, not because the child reaches a fixed size. If a turn is interrupted, it does not retry the prompt or rerun tools. A later request can restore Pi’s history. See [memory guard and overrides](docs/restart-cache.md#linux-memory-guard).
- **Tools still incur latency inside agy.** Pi executes the tools, but each call and result travels through agy's MCP handling before generation continues. Tool-heavy turns can take longer than with a direct provider.
- **One account.** The tether uses the official CLI's current login; it does not manage multiple accounts.
- **Private agent recipe.** Each ACP session stages a unique recipe in the tether's private Gemini home, not the workspace. Pi keeps the caller's working directory for tools; ACP runs in a private workspace so agy does not recursively scan the caller’s tree.

Run `/agy-doctor` for the standing route facts, strict-mode state, Linux memory guard configuration, and diagnostic log path. The tether records those facts as they apply in `transport.log` in `$PI_AGY_TETHER_HOME` (default `$XDG_DATA_HOME/pi-agy-tether`, falling back to `~/.local/share/pi-agy-tether`). They do not interrupt normal turns. Actionable events, including refusals and process failures, remain visible.

[Issues](https://github.com/kyraneth/pi-agy-tether/issues) · [Source and attribution](SOURCE.md) · [MIT License](LICENSE). Not affiliated with Google.
