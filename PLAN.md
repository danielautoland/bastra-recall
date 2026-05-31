# Bastra.Recall Roadmap

## Product Bet

Bastra.Recall is a local-first memory layer for AI assistants. The user should
not have to re-state durable preferences, project facts, decisions, workflows,
or lessons across Claude Code, Claude Desktop, Cursor, ChatGPT Actions, and
other MCP/HTTP clients.

The single success metric:

> The user does not have to think for the AI anymore.

## Current Runtime

| Area | Current state |
|---|---|
| Storage | Plain markdown + YAML frontmatter, recursive Obsidian-compatible vault scan |
| Search | In-memory MiniSearch BM25, boosted `recall_when`, optional OpenAI/Ollama embeddings with RRF fusion |
| Daemon | Node 20+ TypeScript daemon with stdio MCP + loopback HTTP REST on `127.0.0.1:6723` |
| Multi-client | MCP forwarder auto-spawns/reuses one shared daemon so clients share one vault/index |
| Save path | `save_memory` validates and writes markdown, then force-reindexes the file |
| Claude Code reflex layer | Hooks for `SessionStart`, `UserPromptSubmit`, `PreToolUse` edits/todos/bash, `PostToolUse` bash failures, plus optional `Stop` save-eval |
| Distribution | `bastra install/uninstall/doctor/update`, Homebrew formula, double-click macOS installer, npm packaging in hardening |
| Human editor | Obsidian or any markdown editor; no hosted service required |

## Done

| Milestone | Result |
|---|---|
| M0 Recall eval | Own-trigger baseline passed on the dogfood vault; BM25 + authored `recall_when` was sufficient for v0 |
| M1 Read path | `recall` and `load_memory` work through MCP and REST |
| M2 Save path | `save_memory` writes schema-valid markdown and reindexes immediately |
| M3 Reflex layer | Claude Code hooks surface recall hints before action, failure, and stop moments |
| Multi-surface baseline | Claude Code, Claude Desktop, Cursor MCP registration via `bastra install` |

## Active Hardening

1. **Distribution confidence**
   - Publish npm packages with provenance.
   - Keep Homebrew formula and npm package layout aligned.
   - Ensure `Install Bastra.command` fails visibly when install or doctor fails.

2. **Public test fixtures**
   - Keep `fixtures/sample-vault` as a public smoke-test vault.
   - Gate CI on build, typecheck, tests, smoke, update-check tests, and pack dry-runs.

3. **Docs truth**
   - README, package README, hook docs, architecture docs, and OpenAPI spec must reflect the current code.
   - Historical design choices stay out of first-run docs unless clearly marked as historical.

4. **OSS trust**
   - Add security policy, dependency update config, dependency review, CodeQL, and OpenSSF Scorecard.
   - Keep contribution instructions lightweight but explicit.

## Next Product Work

| Priority | Work | Why it matters |
|---|---|---|
| P0 | `bastra doctor --fix` | Users should not manually patch missing hooks or stale paths. |
| P0 | Cursor Rules generation | Cursor currently gets MCP only; rules are needed for save/recall discipline. |
| P1 | OpenAPI spec + ChatGPT Actions guide | REST is implemented; hosted clients need copy-paste integration docs. |
| P1 | `bastra demo` / `bastra init --sample` | A new user needs a two-minute aha moment from a fresh clone. |
| P1 | Memory review CLI | Detect stale, duplicate, low-quality, or weak-`recall_when` memories. |
| P2 | Local telemetry dashboard | Make recall quality and hook follow-through visible without reading JSONL. |
| P2 | Importers | Convert existing `CLAUDE.md`, Cursor rules, and Obsidian notes into candidate memories. |
| P2 | Project topology refresh | Keep `project-fact` memories updated after completed features/refactors. |

## Deliberately Out Of Scope For Now

- Hosted sync service. Use iCloud, Google Drive, Dropbox, or git-backed vaults today.
- Browser-based vault editor. Markdown editors already solve this well.
- Moving core OSS functionality behind the Mac app. The OSS daemon must remain useful by itself.
