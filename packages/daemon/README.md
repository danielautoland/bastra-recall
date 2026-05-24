# @bastra-recall/daemon

MCP server over a markdown memory vault. Two tools: `recall(query, …)` and `load_memory(id)`.

This is the M1 read-path daemon — see [`../../PLAN.md`](../../PLAN.md) for the
overall project plan and milestone definitions, and
[`../../docs/architecture.md`](../../docs/architecture.md) for the architecture.

## What it does

- Watches a directory of `.md` files (your vault's `memorys/` folder).
- Parses YAML frontmatter against the schema in [`../../docs/memory-schema.md`](../../docs/memory-schema.md).
- Builds an in-memory BM25 index ([`minisearch`](https://github.com/lucaong/minisearch)) over title, summary, tags, `recall_when` patterns, topic_path and body. `recall_when` is weighted highest because it's authored exactly for triggering.
- Exposes `recall` and `load_memory` over the MCP stdio transport.

It does **not** save memorys yet — that's M2. It does **not** run hooks — that's M3.

## Install (Mac)

Requires Node 20+.

```bash
git clone https://github.com/danielautoland/bastra-recall.git
cd bastra-recall/packages/daemon
npm install
npm run build
```

## Configure Claude Code

Add to your `~/.claude.json`:

```json
{
  "mcpServers": {
    "bastra-recall": {
      "command": "node",
      "args": ["/absolute/path/to/bastra-recall/packages/daemon/dist/index.js"],
      "env": {
        "BASTRA_VAULT_PATH": "/absolute/path/to/your/Obsidian-vault/memorys"
      }
    }
  }
}
```

The `BASTRA_VAULT_PATH` is the **subfolder of your Obsidian vault that holds the memorys** — not the vault root. Restart Claude Code.

In a session, two new tools appear: `recall` and `load_memory`. Claude calls them autonomously when the CLAUDE.md instruction (see [`../../docs/triggers.md`](../../docs/triggers.md)) says so.

## Configure Claude Desktop

Open `~/Library/Application Support/Claude/claude_desktop_config.json` and add the same `mcpServers` block. Restart Claude Desktop.

## Verify it's running

In a fresh Claude Code session:

> "Was kannst du mir zu Scrollbars sagen?"

Claude should call `recall("scrollbar")` (visible in the tool-call sidebar) and respond with content from the matching memory.

If it doesn't call recall on its own, your CLAUDE.md isn't conditioning it — see [triggers.md](../../docs/triggers.md) for the instruction text.

## Dev workflow (in this sandbox or locally)

```bash
# point at the migration vault for dev:
npm run smoke           # runs scripts/smoke.ts against private/migration/memorys
npm run dev             # starts the MCP server with tsx (no compile step)
npm run check:types     # type-check only
```

## Configuration

| env var | required | default | meaning |
|---|---|---|---|
| `BASTRA_VAULT_PATH` | yes | — | absolute path to the directory holding `.md` memory files |
| `BASTRA_LOG_PATH` | no | `~/.bastra/logs` | where telemetry JSONL files are written (out-of-vault on purpose, so they're not indexed) |
| `BASTRA_TELEMETRY` | no | `on` | set to `off` to disable telemetry writes entirely |

### Telemetry

Every `recall`, `load_memory` and `save_memory` call appends one JSON line to `events-YYYY-MM-DD.jsonl` in the log dir. Each daemon process gets a fresh `session_id`; recalls get a `recall_id` and any `load_memory` / `save_memory` within 5 minutes references that id as `follows_recall`. That's enough to compute, after a dogfood week:

- recalls per session, hit counts, top-score distribution, latency p50/p95
- recall→load_memory follow-through rate (proxy for "was the hint useful?")
- saves per session, type/scope distribution, % overwrite vs. new
- save→follows_recall rate (was a duplicate-check done?)

Logs live outside the vault on purpose so the file watcher doesn't index them. Tail one to watch live: `tail -f ~/.bastra/logs/events-$(date +%F).jsonl`.

## Limitations (v0)

- BM25 only — no semantic embeddings. Queries that share intent but not keywords with a memory may rank that memory low. Embeddings are a v0.5 upgrade if dogfood reveals it's needed.
- Read-only. `save_memory` is M2, separately.
- No PreToolUse hooks. `recall` only fires when Claude calls it; conditioning happens via CLAUDE.md (M3 will add hook-triggered calls).
- Single-process, no daemon supervisor. Restart manually if it dies. `launchd` integration is post-MVP.

## Search ranking

Field boosts (in `src/search.ts`):

```
recall_when_flat: 5    ← authored for triggering, highest weight
title:            4
tags_flat:        3
topic_path_flat:  2
summary:          2
body:             1
```

Fuzzy distance 0.2, prefix matching enabled, `combineWith: "OR"` so partial query matches still surface candidates ranked by aggregate term scores.

## Schema reference

See [`../../docs/memory-schema.md`](../../docs/memory-schema.md) for the full memory frontmatter spec. The daemon enforces required fields via [`zod`](https://zod.dev) on load — files that fail validation are skipped with a warning to stderr.
