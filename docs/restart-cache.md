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

The guard samples the agy child's RSS every 100 ms, matching the isolated sampling interval. The resident cutoff is 8 GiB less the measured full baseline scope peak of 443,527,168 bytes (433,132 KiB, rounded up), yielding 7,955,476 KiB. It also retires agy if host available memory is no longer above that measured full-scope reserve. This is a precaution based on the measured quiet and incident envelopes, not a prediction of an unobserved spike or a hard cap. On a memory-sensitive Linux host, use a hard cgroup limit in addition; a poll cannot stop a between-samples spike or enforce aggregate limits across separate Pi processes. Other platforms retain signal reporting but have no `/proc` sampler.

A guard event is shown once, retires the old process, and requires a new agy process and disclosed replay of Pi history to continue. The tether waits for the old child to exit before replacing it; an interrupted prompt or tool is never automatically run again. A previously blocked MCP call cannot be resumed; Pi retains its result. An unexpected signal reports the last observed RSS (or unavailable). `SIGKILL` becomes **likely out of memory** only if the child's Linux cgroup OOM-kill counter also increased; this can indicate a sibling kill and is not kernel confirmation of that particular PID.
