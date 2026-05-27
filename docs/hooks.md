# Hooks — Claude-Code reflex layer

bastra-recall ships a set of Claude-Code hooks that surface relevant vault
memories (lessons, decisions, project facts, user preferences) at the exact
moment Claude is about to act, fail, or stop. The agent reads the hook
output as `additionalContext` and can `load_memory(id)` the hits before
proceeding.

All hooks are **non-blocking**: they never set `block: true`. Worst case
they emit `{}` and Claude continues unaffected. They share three
discipline rules:

- Hard wall-clock budget (~250 ms for PreToolUse, ~1000 ms for Stop).
- Any failure path emits `{}` and exits 0.
- Telemetry is best-effort, never breaks the hook.

## Installed binaries

After `npm run build` the daemon package exposes these bin entries:

| Bin                                | Event                | Tool matcher |
|------------------------------------|----------------------|--------------|
| `bastra-recall-hook`               | `PreToolUse`         | Write/Edit/MultiEdit/NotebookEdit |
| `bastra-recall-session-hook`       | `SessionStart`       | — |
| `bastra-recall-bash-pre-hook`      | `PreToolUse`         | Bash (destructive/risky) |
| `bastra-recall-bash-fail-hook`     | `PostToolUse`        | Bash (non-zero exit) |
| `bastra-recall-stop-hook`          | `Stop`               | — |

## settings.json — minimal snippet

Add to `~/.claude/settings.json` or the project-local `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
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

If you also use the existing write/edit + session-start hooks, the full
shape looks like:

```json
{
  "hooks": {
    "SessionStart": [
      { "command": "bastra-recall-session-hook" }
    ],
    "PreToolUse": [
      { "matcher": "Write|Edit|MultiEdit|NotebookEdit", "command": "bastra-recall-hook" },
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

## Hook semantics

### Bash-Pre-Hook (`bastra-recall-bash-pre-hook`) — issue #34

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

### Bash-Fail-Hook (`bastra-recall-bash-fail-hook`) — issue #37

Fires on `PostToolUse` for Bash when `exit_code !== 0` (excluding 130 =
Ctrl-C). Extracts the command head + last interesting error lines,
recalls similar failure-mode memories, and emits
`<recall-hints surface="claude-code" trigger="bash-fail">`.

Throttled to one hint per 30 s per session (marker file in
`$TMPDIR/bastra-hook/fail-throttle-<session>.ts`). Skips its own
`bastra-recall-*` invocations to avoid loops.

Telemetry: `bash_fail_hook_call` with `exit_code, command_head, hit_count,
top_score, status`.

### Stop-Hook (`bastra-recall-stop-hook`) — issue #35

Fires on `Stop`. Reads the last ~30 transcript turns (from
`payload.transcript_path` or inline `payload.transcript`) and evaluates
three heuristics:

1. **frustration-density** — ≥3 cues (`wieder`, `schon wieder`,
   `wie oft`, CAPS-words, `fuck`, `verdammt`, `scheisse/scheiße`) in the
   last 10 user turns → suggests a `lesson` save.
2. **feature-completion** — `git commit` mention + ≥3 distinct file
   tokens in transcript → suggests a `project-fact` save.
3. **architecture-decision** — `ok dann | lass uns | entschieden |
   final | gehen wir mit` in last 5 user turns → suggests a `decision`
   save.

Output is one or more `<save-eval>` blocks suggesting title/type/body.
The hook **never calls `save_memory` itself** — only the agent does,
in the next turn, if it agrees with the suggestion.

Budget 1000 ms. Telemetry: `save_eval_call` with `heuristic,
suggested_count, turn_count, latency_ms_total`.
