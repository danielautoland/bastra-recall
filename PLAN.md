# bastra-recall — Plan v2

## Vision

A persistent, autonomous teammate-memory for Claude — across **every** Claude surface (Code, Desktop, Web, Co-work). The vault is plain markdown (Obsidian-compatible). Claude saves lessons as they're learned, without being asked, and recalls them *before* acting, not only when prompted.

The intent is not a tool the user invokes. The intent is a memory the user can mostly forget exists, because it just works.

## The single success metric

> **Daniel doesn't have to think for Claude anymore.**

Specifically:

- Recurring CSS mistakes don't recur.
- Stable preferences don't have to be re-stated each session.
- Project-specific facts don't have to be re-explained.
- The user's cognitive load drops.

Every design choice in this project is justified by whether it serves that metric. Elegance, completeness, feature-count are not.

## Core design choices (decided)

| | Choice | Source |
|---|---|---|
| Storage format | Plain markdown + YAML frontmatter, flat directory | `docs/memory-schema.md` |
| Index | SQLite + FTS5 (graph + keyword) | `docs/architecture.md` |
| Embeddings | Deferred to v0.5; FTS5 + `recall_when` patterns first | architecture |
| Architecture | Single local daemon, multi-surface (stdio + HTTP MCP) | architecture |
| Editor for humans | Obsidian.app | conscious choice |
| Save trigger | Autonomous, on strong signals (no user prompt needed) | `docs/triggers.md` |
| Recall trigger | Multiple hooks: SessionStart, UserPromptSubmit, **PreToolUse** | triggers |
| Vault path | `~/nexus-vault/` (configurable) | architecture |
| Distribution (v0) | Homebrew tap (Mac-first), npm fallback | architecture |
| Language | TypeScript / Node 20+ | architecture |
| License | MIT (public docs); private notes in gitignored `private/` | LICENSE |

## Milestones

Each milestone has hard pass/fail criteria. We do not advance until the previous one passes.

### M0 — Eval harness (½ day)

**Why this comes first:** the riskiest assumption in the whole project is *"FTS5 + recall_when patterns will retrieve the right memory under realistic queries"*. If that's wrong, embeddings move into v0 and the timeline shifts. We measure *before* we build.

**Deliverables:**
- 20 Q-A pairs based on Daniel's real-life scenarios (CSS lesson, preferences, project facts, workflows)
- A standalone Python or TS script that loads candidate memorys into a temporary SQLite+FTS5 DB and runs the recall logic from `architecture.md`
- A Recall@3 metric report

**Pass:** Recall@3 ≥ 0.7 on the test set, with median latency < 50 ms.
**Fail action:** add `bge-m3` local embeddings to the v0 stack; re-measure.

### M1 — Daemon + tools, read path (2-3 days)

**Scope:** the daemon comes up, indexes a vault, exposes `recall` and `load_memory` over both stdio and HTTP MCP. No save yet.

**Deliverables:**
- `bastra-recall` binary with subcommands: `serve`, `stdio`, `index`, `doctor`
- Vault watcher (chokidar)
- Initial vault populated with the six example memorys from `memory-schema.md`
- Claude Code config snippet to wire it as MCP server

**Pass:**
- Daniel can run a Claude Code session, ask *"baue mir ein Input"*, and the CSS-double-ring lesson appears in `<recall-hints>`
- Daemon survives restart, re-indexes a vault edited in Obsidian within 100 ms
- `doctor` reports green on a fresh install

### M2 — Save path + autonomous triggers (2-3 days)

**Scope:** the system can write back. Claude can call `save_memory` and the file appears in the vault. CLAUDE.md instruction conditions me to fire on strong signals.

**Deliverables:**
- `save_memory` tool with full schema validation
- Save-side CLAUDE.md instruction (the text from `triggers.md`)
- 1-line ack format implemented and visible in chat
- `save_log` records every save with trigger reason

**Pass:**
- In a real Claude Code session, when Daniel triggers a strong signal (frustration phrase + solution), Claude saves a `lesson` autonomously, surfaces a 1-line ack, and the file is in `~/nexus-vault/` with valid frontmatter
- False-save rate < 10% over 5 sessions

### M3 — PreToolUse hook + dogfood week

**Scope:** the "buildin"-feel hook. Claude recalls before its own Write/Edit actions, not only on user prompts.

**Deliverables:**
- `PreToolUse` hook on Write/Edit, posting to `/hook/pre-write`
- Topic-detection logic (regex/keyword for v0; AST in v0.5)
- One full week of Daniel using the system in real carnexus / new-project work
- Telemetry analysis at end of week

**Pass:**
- ≥ 1 concrete bug avoided that the user explicitly attributes to bastra-recall
- Token-overhead per prompt: median < 300 chars
- Hook latency p95 < 100 ms
- False-positive recall rate < 30 % (i.e. ≥ 70 % of hints with score ≥ 0.8 lead to actual `load_memory` calls)
- Daniel's subjective verdict: *"das funktioniert, ich vergesse, dass es da ist"*

If M3 doesn't pass cleanly, the project iterates on triggers and ranking before adding any new feature.

## Out of v0 (deliberately deferred)

Listed not to forget, but to make clear they're explicitly *not* in M0–M3:

- Embeddings (semantic recall) — only if M0 fails or M3 reveals miss patterns
- Codebase indexing (AST, topology, service-caller graphs) — separate project track
- Multi-Mac / multi-device sync — vault is a folder, defer to user's choice (iCloud / Dropbox / Git)
- Plugin-marketplace bundling — config-snippet works for v0 ergonomics
- Schema migration via LLM — ten of Daniel's own existing memorys, hand-migrated, suffice

## Open questions

To be resolved during M0/M1, not earlier:

1. **Project name registry.** `scope: carnexus` — free-form (typo risk) or registered (friction)? Default plan: free-form, with a one-time confirmation prompt the first time a new project name is used.
2. **Web/chat surface auth.** The Custom Connector → localhost path may need a token or HTTPS. Decide based on Anthropic's web-MCP requirements when M1 is shipped.
3. **Frustration-detection multilingual.** Daniel switches between German and English. The CLAUDE.md trigger phrases need both. Acceptable as part of M2.
4. **`recall_when` author burden.** Will Claude reliably populate good `recall_when` patterns at save time? If patterns are weak, recall fails. May need a "review your last 5 saves" workflow.

## What this branch contains

The current `claude/review-project-goals-YcyVe` branch holds the design refresh:
- `docs/memory-schema.md` — the schema
- `docs/architecture.md` — the daemon + storage + hybrid retrieval
- `docs/triggers.md` — save & recall heuristics
- `PLAN.md` (this file) — milestones, metric, decisions

No code yet. M0 starts after Daniel reviews and signs off.
