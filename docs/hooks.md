# Claude Code hooks for bastra-recall

bastra-recall ships a set of Claude-Code hook CLIs that surface relevant vault
memories (lessons, decisions, project facts, user preferences) at the exact
moment Claude is about to act, fail, or stop. The agent reads the hook output
as `additionalContext` and can `load_memory(id)` the hits before proceeding.

All hooks are **non-blocking**: they never set `block: true`. Worst case they
emit `{}` and Claude continues unaffected. They share three discipline rules:

- Hard wall-clock budget (`BASTRA_HOOK_TIMEOUT_MS`, default 250 ms for
  PreToolUse / 500 ms for SessionStart / 1000 ms for Stop).
- Any failure path emits `{}` and exits 0.
- Telemetry is best-effort, never breaks the hook.

## Installed binaries

After `npm run build` the daemon package exposes these bin entries:

| Bin name                          | Event              | Matcher                                   | Purpose                                                   |
| --------------------------------- | ------------------ | ----------------------------------------- | --------------------------------------------------------- |
| `bastra-recall-session-hook`      | `SessionStart`     | — (every session)                         | Preload user-preferences + active project context         |
| `bastra-recall-hook`              | `PreToolUse`       | `Write`/`Edit`/`MultiEdit`/`NotebookEdit` | Topic-aware recall before file mutations (#20 #28 #32)    |
| `bastra-recall-prompt-hook`       | `UserPromptSubmit` | — (every user message)                    | Lookup-mode reflex (#33)                                  |
| `bastra-recall-todo-hook`         | `PreToolUse`       | `TodoWrite`                               | Topology recall before multi-step plans (#36)             |
| `bastra-recall-bash-pre-hook`     | `PreToolUse`       | `Bash` (destructive/risky)                | Safety recall before destructive shell ops (#34)          |
| `bastra-recall-bash-fail-hook`    | `PostToolUse`      | `Bash` (non-zero exit)                    | Lesson recall when a Bash command fails (#37)             |
| `bastra-recall-stop-hook`         | `Stop`             | —                                         | Autonomous save-eval at end of session (#35)              |

## Activation snippet for `~/.claude/settings.json`

Full shape with every hook enabled:

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
      { "matcher": "TodoWrite", "command": "bastra-recall-todo-hook" },
      { "matcher": "Bash", "command": "bastra-recall-bash-pre-hook" }
    ],
    "PostToolUse": [
      { "matcher": "Bash", "command": "bastra-recall-bash-fail-hook" }
    ],
    "Stop": [
      { "command": "bastra-recall-stop-hook" }
    ]
  }
}
```

The bins are installed by `npm install -g @bastra-recall/daemon` (or via the
Bastra Mac app's "install Claude Code hooks" action).

## Per-hook behavior

### `bastra-recall-prompt-hook` (#33)

Detects retrieval prompts via DE + EN regex (e.g. `^such|finde|wo (ist|sind)`
/ `^find|search|where (is|are)`). On a match:

- POSTs the prompt verbatim to `/hook/recall` with `k=5`, score-floor `50`.
- Emits a `<recall-hints surface="claude-code" trigger="prompt-lookup">`
  block with an explicit "Use bastra-recall:recall (and find_document if
  pdf-likely) BEFORE conversation_search / web_search" instruction.

Non-retrieval prompts emit `{}` by default. Set `BASTRA_PROMPT_HOOK_MODE=all`
to also recall on generic prompts (only score ≥ 100 hits surface — much
higher noise gate).

Telemetry event: `prompt_hook_call` (`detected_mode`, `prompt_chars`, `hint_count`, …).

### `bastra-recall-todo-hook` (#36)

Fires only on `PreToolUse` + `tool_name === "TodoWrite"`. Pulls the first 1–2
todo `content` strings as the query spine, plus the top-3 lowercased tokens
that appear in ≥ 2 todos as topic words. Stopwords (DE + EN) and short tokens
(< 3 chars) are filtered.

- POSTs to `/hook/recall` with `type=project-fact`, `k=5`, score-floor `50`.
- Skips silently (`{}`) when confidence is low (< 2 topic words AND query
  length < 10 chars).
- Emits a `<recall-hints surface="claude-code" trigger="todo-plan"
  topics="…">` block with a "Before starting these todos, load the
  project-facts above to understand current file layout / past decisions"
  instruction.

Telemetry event: `todo_hook_call` (`topic`, `todo_count`, `hit_count`, …).

### `bastra-recall-bash-pre-hook` (#34)

Matches the Bash command against a curated list of destructive and risky
patterns. On match it recalls relevant safety lessons / user-preferences
(`scope=all-projects`, score floor 50) and emits a
`<recall-hints surface="claude-code" trigger="bash-destructive">` block
warning Claude to stop and confirm with the user.

Destructive patterns (subset): `rm -rf`, `rm -r`, `rmdir`,
`git reset --hard`, `git checkout -- `, `git clean -f`, `git branch -D`,
`git push --force` / `--force-with-lease` / `-f`, `git commit --amend`,
`gh repo delete`, `gh release delete`, `npm uninstall` / `npm rm`,
`yarn remove`, `pnpm rm`, `DROP TABLE`, `DROP DATABASE`, `TRUNCATE`,
`docker rm`, `docker volume rm`, `kubectl delete`.

Risky patterns: `chmod -R`, `chown -R`, `find ... -exec rm`,
`>` overwrite-redirect.

Does **not** block. The agent decides whether to proceed.

Telemetry: `bash_hook_call` with `matched_pattern, severity, hit_count,
top_score, status`.

### `bastra-recall-bash-fail-hook` (#37)

Fires on `PostToolUse` for Bash when `exit_code !== 0` (excluding 130 =
Ctrl-C). Extracts the command head + last interesting error lines, recalls
similar failure-mode memories, and emits
`<recall-hints surface="claude-code" trigger="bash-fail">`.

Throttled to one hint per 30 s per session (marker file in
`$TMPDIR/bastra-hook/fail-throttle-<session>.ts`). Skips its own
`bastra-recall-*` invocations to avoid loops.

Telemetry: `bash_fail_hook_call` with `exit_code, command_head, hit_count,
top_score, status`.

### `bastra-recall-stop-hook` (#35)

Fires on `Stop`. Reads the last ~30 transcript turns (from
`payload.transcript_path` or inline `payload.transcript`) and evaluates
three heuristics:

1. **frustration-density** — ≥ 4 cues AND ≥ 2 explicit frustration words
   (`wieder`, `schon wieder`, `wie oft`, `fuck`, `verdammt`,
   `scheisse/scheiße`) in the last 10 user turns. CAPS words count as cues
   only when ≥ 5 chars or repeated in a turn and not a technical acronym
   (`SKILL`, `JSON`, `CLAUDE`, …); CAPS alone never triggers → suggests a
   `lesson` save.
2. **feature-completion** — `git commit` mentioned in a **user** turn + ≥ 5
   distinct repo-relative source-file tokens, at least one of which exists
   under the session cwd → suggests a `project-fact` save. Home/URL paths and
   non-source files (`.json`, `.yaml`, …) are filtered out.
3. **architecture-decision** — `ok dann | lass uns | entschieden | final |
   gehen wir mit` in last 5 user turns → suggests a `decision` save.

Output is one or more `<save-eval>` blocks suggesting title/type/body. The
hook **never calls `save_memory` itself** — only the agent does, in the next
turn, if it agrees with the suggestion.

Budget 1000 ms. Telemetry: `save_eval_call` with `heuristic, suggested_count,
turn_count, latency_ms_total`.

## Environment overrides

| Env var                       | Default          | What it does                                                  |
| ----------------------------- | ---------------- | ------------------------------------------------------------- |
| `BASTRA_HTTP_URL`             | _none_           | Full daemon base URL (overrides host+port)                    |
| `BASTRA_HTTP_PORT`            | `6723`           | Daemon port on `127.0.0.1`                                    |
| `BASTRA_HOOK_TIMEOUT_MS`      | `250` / `500` / `1000` | Wall-clock budget for the hook (incl. network round-trip) |
| `BASTRA_PROMPT_HOOK_MODE`     | `retrieval-only` | `retrieval-only` or `all` — only the prompt-hook reads this   |
| `BASTRA_TELEMETRY`            | `on`             | `off` to disable JSONL telemetry writes                       |
| `BASTRA_LOG_PATH`             | `~/.bastra/logs` | Telemetry log directory                                       |

All `BASTRA_*` vars accept a legacy `NEXUS_*` fallback for migration.
