# Why restarting Pi can miss agy's prompt cache

Pi is the source of truth for the conversation. While the ACP session is warm, agy holds prior assistant replies, tool calls and tool results in their native roles. After Pi restarts, the tether opens a fresh ACP session and replays Pi's history using `session/prompt`. That interface does not import earlier assistant and tool turns in their original roles, so they are sent as labeled text; images remain ACP image blocks.

Pi still retains the conversation, but replay is a different input from the warm session, and Google does not expose the cache key. If cache reuse matters during a long conversation, keep Pi running. Do not assume a restored conversation will reuse the previous prompt cache.
