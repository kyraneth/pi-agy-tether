# Why restarting Pi can miss agy's prompt cache

Pi is the source of truth for the conversation. While the ACP session is warm, agy holds prior assistant replies, tool calls and tool results in their native roles. After Pi restarts, the tether opens a fresh ACP session and replays Pi's history using `session/prompt`. That interface does not import earlier assistant and tool turns in their original roles, so they are sent as labeled text; images remain ACP image blocks.

Pi still retains the conversation, but replay is a different input from the warm session, and Google does not expose the cache key. If cache reuse matters during a long conversation, keep Pi running. Do not assume a restored conversation will reuse the previous prompt cache.

## Linux memory guard

Three kernel OOM records showed agy at 8,394,956, 14,339,720 and 16,133,312 KiB anonymous RSS; one incident also took down the user systemd manager. The isolated Hydrogen reproduction used `systemd-run --user --scope -p MemoryMax=8G` to bound Pi, agy and MCP together. The host had 33,662,380 KiB free, 39,270,348 KiB available, and only 196 KiB swap free at baseline. 8 GiB was below the smallest observed agy victim and left over 24 GiB of then-free RAM outside the test scope.

With agy 1.5.16 and 60 offered tools, 30 sequential MCP tools across three user prompts (including ten ~30 KiB results) gave this RSS curve, in KiB:

| Assistant message | 1 | 6 | 11 | 16 | 21 | 26 | 33 | Peak |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| agy RSS | 217,052 | 230,596 | 241,900 | 243,208 | 244,012 | 247,736 | 248,636 | 251,520 |

The agy process holding the conversation accounted for most of the increase (anonymous RSS rose from 138,792 to 169,716 KiB). A second, startup-only catalog probe used `session/new` but sent no prompts. The main connection used one `session/new`, one setup marker prompt and three user prompts, with no tether replay, resending, or images. MCP peaked at 50,048 KiB. The matched Hydrogen stress test used one user prompt and 118 sequential results sized from a real tool-heavy workload, but with synthetic text: agy peaked at 234,400 KiB and ended at 200,284 KiB after 382 seconds. Context peaked at 512,487 tokens then dropped without tether replay; agy's internal conversation state changed. Neither run reproduced the multi-GiB spike. The historical kernel records identify the victim, not the code path causing the allocation.

### Why an ordinary session reached 8 GiB

In a scoped comparison, Pi 1.6.1 and agy 1.5.12 ran Neon at high effort with 60 active tools, an approximately 32 KB system prompt, and eight requested paged reads. There were no images or replay. With a small working directory the session finished. With the original large working directory it retired after six reads. A syscall trace of the old behavior confirmed that both agy's cold catalog probe and its conversation child enumerated 45,553 directories under that working directory, despite Pi owning all the tools. That exposure, not the catalog size alone, was necessary for reproduction. The resident growth was anonymous memory inside agy, not mapped files. The trace shows the recursive walk, not agy's internal allocator or what it retains.

| Trial | Peak observed RSS (KiB) | RssAnon at that sample (KiB) | RssFile (KiB) | RssShmem (KiB) |
| --- | ---: | ---: | ---: | ---: |
| Previous build, small directory | 270,696 | 154,100 | 116,596 | 0 |
| Previous build, original directory | 8,750,480 | 8,634,112 | 116,368 | 0 |
| Private agy workspace, same original Pi directory | 273,444 | 157,248 | 116,196 | 0 |

Pi still runs its tools in the original directory; the tether now gives agy a private directory for both the process cwd and ACP `session/new`. The native image tool still gets its own private staging directory. The candidate finished all eight reads without retirement.

### When the guard acts

- **Host:** Retire only when Linux `MemAvailable` is at or below **2,371,460 KiB** by default. This is the largest observed increase in the original-directory **RssAnon** over a window no longer than the **100 ms** polling interval plus the existing **2 s** SIGTERM-to-SIGKILL grace: 6,237,696 to 8,609,156 KiB over 2,015 ms. The poll matches the measurement cadence; the grace comes from process shutdown, not from a memory limit. This is a reserve against observed growth, not an RSS ceiling or a guaranteed worst case. The test scope's `MemoryMax` was separate: it used half of launch `MemAvailable`, rounded down so the host retained at least as much headroom as the experiment could use.
- **Cgroup v2:** Also retire if `memory.current` reaches a finite `memory.high` or `memory.max` configured for the child's group or an ancestor under `/sys/fs/cgroup`. These are kernel/admin settings in bytes; `max` means unlimited. Missing readings are not pressure evidence. This check does not subtract the host reserve from a smaller cgroup.
- **Override:** Set `PI_AGY_TETHER_MEMORY_GUARD` to an integer number of KiB to replace the host reserve, or to `off` to turn off both retirement checks without losing diagnostics. Unset/empty uses the default; invalid values also use the default and are called out by `/agy-doctor`.

A poll cannot stop a between-samples spike, enforce aggregate limits across Pi processes, or guarantee a retirement before the kernel enforces `memory.max`. Use a hard scope limit where containment matters. Other platforms retain signal reporting without the Linux sampler.

A guard event reports the applicable pressure, the shutdown signals it uses, and the last RSS breakdown. It is shown once, and the tether waits for the old child to exit before starting another. An interrupted prompt or tool is never automatically retried, and an old blocked tool call cannot be resumed. For an unexpected exit, the report includes the observed signal and last VmRSS, RssAnon, RssFile and RssShmem when available. `SIGKILL` becomes **likely out of memory** only if the child's local cgroup OOM-kill counter also increased; this can indicate a sibling kill and does not identify the victim PID.
