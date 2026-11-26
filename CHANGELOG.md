# Changelog

## 0.1.4

- Enable `PI_AGY_TETHER_IMAGE_TOOL=1` to generate and edit images with `agy_generate_image`. Outputs stay in the Pi session’s artifact directory; reference images are staged without overwriting them.
- Enable `PI_AGY_TETHER_NATIVE_SEARCH=1` to let Antigravity search the web. Pi shows the opt-in once and displays each query, but search results stay inside Antigravity. Strict mode refuses native search.
- Attribute Antigravity’s reported token use to each Pi assistant message, including messages that end at a tool call. When usage cannot be attributed, leave it and cost unavailable rather than report zero. Displayed cost is an API-price equivalent, not an Antigravity subscription charge.
- Retire an Antigravity process that approaches the available memory budget. Interruptions are shown without retrying prompts or tools; the next request can restore history from Pi. Signal-exit messages distinguish measured memory evidence from an unexplained kill.
- Keep standing transport limitations in the tether log and `/agy-doctor`, not in routine notifications. Actual clips still show byte counts. A request that explicitly sets an unsupported generation control warns once per Pi session. Strict mode is unchanged.

## 0.1.3

- Discover every model family and thinking level Antigravity advertises for your account, including Gemini, Orchestrator, Claude, and GPT-OSS. Refresh old model lists, preserve fixed thinking settings, and show API-equivalent costs where list prices exist. Text-only models reject images instead of silently dropping them.
- Give each session its own private agent recipe without writing it in your project or changing the working directory.
- Stop before inference if a single history entry is too large to replay. Pi keeps the journal intact and does not rerun tools.
- Warn when Antigravity adds to or clips tool results, or when results can only be replayed as history text. Pi keeps the full results and does not retry tools.
- Warn when the effective tool list cannot be verified, when requested generation controls are ignored, or when system instructions move into the first user prompt. Only tools declared by Pi for the active session are authorized. Set `PI_AGY_TETHER_STRICT=1` to refuse these cases and unverified tool-result delivery instead.
- Report signal termination explicitly. The Antigravity client and tool server now report the installed tether version.

## 0.1.2

- Send long conversation history and summaries across multiple turns in the same session. If an oversized message cannot be split, show an error instead of silently losing part of the message.

## 0.1.1

- Report token usage from Antigravity in Pi. Where Gemini API list prices are available, Pi shows the equivalent API cost, not a charge to your subscription.
- Keep temporary session and Antigravity files in Pi’s runtime directory, so sessions can work when the data directory is read-only.

## 0.1.0 — First release

- Use Google's official `agy acp` in Pi with an existing official `agy login`. No API keys or separate account management.
- Discover the Gemini model families and thinking levels agy advertises to the account. Keep Pi's tools, transcript and compaction, including image blocks across restart.
- Reuse a successful agent proof per agy version and recipe format, while checking for agy's fallback every session. `PI_AGY_TETHER_VERIFY=always` runs the marker each time.
- Put the gateway-refused Pi preface verbatim at the start of the first real user prompt, never in the system instructions or marker turn.
- Warm sessions reuse the live ACP conversation. Disk resume replays Pi's history; it is not an agy cache-resume guarantee.
