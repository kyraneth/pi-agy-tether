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

Notional API-equivalent cost uses Pi's built-in Google, Anthropic, and OpenAI list rates, not subscription charges. Models without a first-party API list price, including Orchestrator and open-weight GPT-OSS, report $0.

**Third-party and open-source model terms.** Under Section 8 of the [Google Antigravity Additional Terms of Service](https://antigravity.google/terms), selecting a third-party or open-source model subjects you to that model's terms, including [Anthropic's Commercial Terms](https://www.anthropic.com/legal/commercial-terms) for Claude. Google [documents](https://antigravity.google/docs/models.md) that lightweight Gemini models can still coordinate in the background and that third-party models draw from a separate quota pool from Gemini.

## Verify the agent recipe

The tether checks that agy loaded the private recipe carrying Pi's instructions. It reuses a successful check for the same agy version, recipe format, and model family but still checks for fallback to agy's default agent in every session.

Use `PI_AGY_TETHER_VERIFY=always pi` to run the marker check on every new ACP session. This adds a model turn at startup.

## Known limits

- **Single-turn input limit.** agy 1.5.12 and 1.5.16 were both observed cutting off input after 192,000 bytes in one turn. The tether sends long conversation history and summaries across multiple turns. If one historical entry alone exceeds that limit, the tether refuses replay before inference and leaves the Pi journal intact. It never reruns the historical tool; use a provider that can restore the journal or curate a branch in Pi.
- **Restarting Pi can lose cache reuse.** While Pi stays open, follow-up turns reuse the live ACP session. After a restart, Pi restores the conversation, but agy receives the earlier assistant and tool turns as labeled text rather than native messages. That is not a warm cache resume. See [restart behavior](docs/restart-cache.md).
- **Tool results are not lossless.** agy adds timestamps and limits rendered single-text results to 10,240 bytes on the measured builds (1.5.12 and 1.5.16). The tether warns about these changes and also warns if a result can only be replayed as history text. Pi keeps the full result. Set `PI_AGY_TETHER_STRICT=1` to refuse unverified result delivery instead, without retrying the tool.
- **The effective tool catalog is not verifiable via ACP.** In one full-catalog measurement on agy 1.5.16, 54 of 60 Pi declarations reached the model. agy can also rewrite schemas or still offer native declarations. The recipe requests suppression of known native tools; Pi authorizes only exactly bound, declared Pi calls regardless. `PI_AGY_TETHER_STRICT=1` refuses an unverifiable catalog before inference.
- **Explicit generation controls.** ACP does not carry Pi's `temperature`, `maxTokens`, or `toolChoice`. The tether warns and continues by default; `PI_AGY_TETHER_STRICT=1` refuses before inference.
- **Gateway system-instruction workaround.** When Pi's “running inside Pi” line or `<docs>` section matches the workaround, the tether discloses their move to the first user prompt (without the docs delimiters). `PI_AGY_TETHER_STRICT=1` refuses instead of changing their role.
- **Tools still incur latency inside agy.** Pi executes the tools, but each call and result travels through agy's MCP handling before generation continues. Tool-heavy turns can take longer than with a direct provider.
- **One account.** The tether uses the official CLI's current login; it does not manage multiple accounts.
- **Private agent recipe.** Each ACP session stages a unique recipe in the tether's private Gemini home, not the workspace. Pi and ACP keep the caller's working directory.

[Issues](https://github.com/kyraneth/pi-agy-tether/issues) · [Source and attribution](SOURCE.md) · [MIT License](LICENSE). Not affiliated with Google.
