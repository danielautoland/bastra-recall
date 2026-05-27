# Claude Code hooks for bastra-recall

bastra-recall ships **four** Claude-Code hook CLIs. They all read a Claude
Code hook payload from stdin, optionally call the daemon's `/hook/recall`
endpoint, and emit an `additionalContext` block (or `{}`) on stdout. Every
hook has a hard wall-clock budget (`BASTRA_HOOK_TIMEOUT_MS`, default 250 ms,
500 ms for SessionStart) and fails silently if the daemon is unreachable.

| Bin name                          | Event             | Trigger                  | Purpose                                                   |
| --------------------------------- | ----------------- | ------------------------ | --------------------------------------------------------- |
| `bastra-recall-session-hook`      | `SessionStart`    | every fresh session      | Preload user-preferences + active project context         |
| `bastra-recall-hook`              | `PreToolUse`      | `Write`/`Edit`/`MultiEdit`/`NotebookEdit` | Topic-aware recall before file mutations |
| `bastra-recall-prompt-hook`       | `UserPromptSubmit`| every user message       | Lookup-mode reflex (Issue #33)                            |
| `bastra-recall-todo-hook`         | `PreToolUse`      | `TodoWrite`              | Topology recall before multi-step plans (Issue #36)       |

## Activation snippet for `~/.claude/settings.json`

```json
{
  "hooks": {
    "SessionStart": [
      { "command": "bastra-recall-session-hook" }
    ],
    "UserPromptSubmit": [
      { "command": "bastra-recall-prompt-hook" }
    ],
    "PreToolUse": [
      { "matcher": "Write|Edit|MultiEdit|NotebookEdit", "command": "bastra-recall-hook" },
      { "matcher": "TodoWrite", "command": "bastra-recall-todo-hook" }
    ]
  }
}
```

The bins are installed by `npm install -g @bastra-recall/daemon` (or via the
Bastra Mac app's "install Claude Code hooks" action).

## Per-hook behavior

### `bastra-recall-prompt-hook` (Issue #33)

Detects retrieval prompts via DE + EN regex (e.g. `^such|finde|wo (ist|sind)`
/ `^find|search|where (is|are)`). On a match:

- POSTs the prompt verbatim to `/hook/recall` with `k=5`, score-floor `50`.
- Emits a `<recall-hints surface="claude-code" trigger="prompt-lookup">`
  block with an explicit "Use bastra-recall:recall (and find_document if
  pdf-likely) BEFORE conversation_search / web_search" instruction.

Non-retrieval prompts emit `{}` by default. Set
`BASTRA_PROMPT_HOOK_MODE=all` to also recall on generic prompts (only
score ≥ 100 hits surface — much higher noise gate).

Telemetry event: `prompt_hook_call` (`detected_mode`, `prompt_chars`, `hint_count`, …).

### `bastra-recall-todo-hook` (Issue #36)

Fires only on `PreToolUse` + `tool_name === "TodoWrite"`. Pulls the first
1–2 todo `content` strings as the query spine, plus the top-3 lowercased
tokens that appear in ≥ 2 todos as topic words. Stopwords (DE + EN) and
short tokens (< 3 chars) are filtered.

- POSTs to `/hook/recall` with `type=project-fact`, `k=5`, score-floor `50`.
- Skips silently (`{}`) when confidence is low (< 2 topic words AND query
  length < 10 chars).
- Emits a `<recall-hints surface="claude-code" trigger="todo-plan"
  topics="…">` block with a "Before starting these todos, load the
  project-facts above to understand current file layout / past decisions"
  instruction.

Telemetry event: `todo_hook_call` (`topic`, `todo_count`, `hit_count`, …).

## Environment overrides

| Env var                       | Default          | What it does                                                  |
| ----------------------------- | ---------------- | ------------------------------------------------------------- |
| `BASTRA_HTTP_URL`             | _none_           | Full daemon base URL (overrides host+port)                    |
| `BASTRA_HTTP_PORT`            | `6723`           | Daemon port on `127.0.0.1`                                    |
| `BASTRA_HOOK_TIMEOUT_MS`      | `250` / `500`    | Wall-clock budget for the hook (incl. network round-trip)     |
| `BASTRA_PROMPT_HOOK_MODE`     | `retrieval-only` | `retrieval-only` or `all` — only the prompt-hook reads this   |
| `BASTRA_TELEMETRY`            | `on`             | `off` to disable JSONL telemetry writes                       |
| `BASTRA_LOG_PATH`             | `~/.bastra/logs` | Telemetry log directory                                       |

All `BASTRA_*` vars accept a legacy `NEXUS_*` fallback for migration.
