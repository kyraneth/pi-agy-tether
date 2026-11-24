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

The tether discovers the **Gemini** families and thinking levels that agy advertises for your account. It does not register non-Gemini models, even if agy offers them. The list is cached for later starts and refreshed by new ACP sessions. If discovery fails and there's no usable cache, Pi shows a small fallback list; the selected model and requested effort are still verified against the live session before use.

Image input is enabled when the installed agy build advertises it.

## Verify the agent recipe

The tether checks that agy loaded the workspace recipe carrying Pi's instructions. It reuses a successful check for the same agy version and recipe format but still checks for fallback to agy's default agent in every session.

Use `PI_AGY_TETHER_VERIFY=always pi` to run the marker check on every new ACP session. This adds a model turn at startup.

## Known limits

- **Single-turn input limit.** agy 1.5.12 and 1.5.16 were both observed cutting off input after 192,000 bytes in one turn. The tether sends long conversation history and summaries across multiple turns. If a single oversized message cannot be split, the tether reports a clear error instead of letting agy silently drop part of it.
- **Restarting Pi can lose cache reuse.** While Pi stays open, follow-up turns reuse the live ACP session. After a restart, Pi restores the conversation, but agy receives the earlier assistant and tool turns as labeled text rather than native messages. That is not a warm cache resume. See [restart behavior](docs/restart-cache.md).
- **Tools still incur latency inside agy.** Pi executes the tools, but each call and result travels through agy's MCP handling before generation continues. Tool-heavy turns can take longer than with a direct provider.
- **One account.** The tether uses the official CLI's current login; it does not manage multiple accounts.
- **Workspace write required.** The tether writes the workspace agent recipe where the official CLI looks it up; a read-only workspace cannot start a session.

[Issues](https://github.com/kyraneth/pi-agy-tether/issues) · [Source and attribution](SOURCE.md) · [MIT License](LICENSE). Not affiliated with Google.
