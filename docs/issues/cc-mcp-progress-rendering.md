# Claude Code: MCP `notifications/progress` arrive but are never rendered in the TUI

**Status:** draft — to post as a comment on [anthropics/claude-code#51713](https://github.com/anthropics/claude-code/issues/51713) (or as a new feature-request issue if preferred). Tested on Claude Code **2.1.152**, Opus 4.7, macOS.

---

## Repro

We wired up a long-running MCP tool that emits `notifications/progress` with `progressToken` matching the `_meta.progressToken` of the incoming `tools/call` request, one progress event per stage of the work (`query.parse`, `bm25.search`, `vector.search`, `rrf.fuse`, `hops.expand`, `staleness.rank`, `done`). Each notification follows the MCP spec exactly:

```json
{
  "method": "notifications/progress",
  "params": {
    "progressToken": 18,
    "progress": 4,
    "total": 8,
    "message": "vector.search · 102ms · Comparing semantics"
  }
}
```

Notifications are sent on the SAME stdio channel as the in-flight `tools/call` request, BEFORE the final tool response. We confirmed delivery via `~/Library/Caches/claude-cli-nodejs/.../mcp-logs-*/.jsonl` — every notification appears in CC's MCP debug log.

## What happens

**Two distinct failure modes:**

1. **Race-reject for fast tool calls.** Notifications that arrive at the MCP client AFTER the tool response are rejected with:
   ```
   Connection error: Received a progress notification for an unknown token:
   {"method":"notifications/progress","params":{"progress":5,"total":8,"message":"...","progressToken":18}}
   ```
   We worked around this server-side by `await`ing every `sendNotification(...)` call before continuing, which guarantees ordering for slow tools (>50 ms per stage). But for fast tools (sub-millisecond stages) the race re-emerges because notification-flush and response-flush can interleave on the stdio buffer.

2. **No rendering even when accepted.** Notifications that are NOT rejected (token still active) are also not rendered anywhere in the TUI. The collapsed tool-call display only ever shows:
   ```
   Calling <server> N times… (ctrl+o to expand)
     └ "<query arg>"
   ```
   The query-arg sub-line is from CC, not from us. We probed several content-shape variants of the eventual tool response (`structuredContent`, `_meta.summary`, multi-`text` content items) — none of them surface in the collapsed view either.

This is the regression flagged in [#51713](https://github.com/anthropics/claude-code/issues/51713) and seemingly the same surface as [#3174](https://github.com/anthropics/claude-code/issues/3174) (notifications/message not displayed).

## Why this matters

A retrieval/search/build/test tool that takes 100 ms–10 s with no visible progress feels broken. Built-in `Bash` streams its stdout live; MCP tools doing equivalent work cannot. The MCP spec gives us `notifications/progress` precisely for this and the SDK supports `sendNotification` — but the loop is broken at the TUI rendering stage.

## Concrete fix proposals

Listed easiest → most impactful:

1. **Stop dropping accepted notifications.** Render `params.message` (or `progress/total` as a bar) as a live-updating sub-line under `Calling <server>…`, replacing the static argument preview while the call is in flight. After completion, revert to the existing collapsed display.

2. **Stop racing-rejecting late notifications.** The `unknown token` rejection should at minimum be silent (not a stream-error log) for tokens that completed less than say 200 ms ago — the token's request just finished, the notifications were in flight on the wire. Currently it's noise and gives MCP authors the false signal that something is broken on their side.

3. **`_meta["anthropic/expandByDefault"]: true` tool annotation** as suggested in #51713 — lets long-running tools opt out of auto-collapse so their tool-result text streams visibly the way `Bash` output does.

4. **Render `_meta.summary` or `structuredContent` summary in the collapsed view.** Right now there is no way for the server to influence what shows under `Calling …`. A documented `_meta.summary` field that replaces the argument preview after completion would close the gap that #1 leaves for tools whose progress is best summarised AFTER the call (e.g. "23 hits in 138 ms").

## What this would unblock

Real MCP servers that today silently look frozen during multi-second work:
- Search / retrieval (our case)
- Build pipelines
- Test runners
- Long deploys / migrations
- LLM-on-LLM tools that internally call other models

## Logs (sanitized)

```
{"debug":"Connection error: Received a progress notification for an unknown token: {\"method\":\"notifications/progress\",\"params\":{\"progress\":5,\"total\":8,\"message\":\"0ms · rrf.fuse · Combining scores …\",\"progressToken\":19}}","timestamp":"2026-05-27T18:28:31.307Z","sessionId":"...","cwd":"..."}
{"debug":"Connection error: Received a progress notification for an unknown token: {\"method\":\"notifications/progress\",\"params\":{\"progress\":8,\"total\":8,\"message\":\"114ms · done · found it\",\"progressToken\":19}}","timestamp":"2026-05-27T18:28:31.307Z","sessionId":"...","cwd":"..."}
```

Across 20 parallel tool calls: 58/58 progress notifications received by CC, 58/58 rejected as `unknown token` — i.e. 0% delivered to the renderer, regardless of token-lifetime timing.

## Workaround (current state)

Out-of-band channel via a custom `statusLine` wrapper: the MCP server writes the final status to a file, the user's statusline script polls it (via `refreshInterval`) and renders the done-banner. This works but is ugly — requires users to install a wrapper, gives no live progress (only after the call), competes for statusline real-estate with the user's preferred statusline plugin, and obviously doesn't generalize across MCP servers.

A native CC fix per #1+#2 would let every MCP server that already complies with the MCP spec gain visible progress for free.

---

**TL;DR for Anthropic:** `notifications/progress` is in MCP spec, our server emits it correctly, CC receives it correctly, the renderer drops it. Two-line fix in the TUI renderer would unblock a whole class of MCP tools.
