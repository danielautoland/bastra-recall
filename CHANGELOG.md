# Changelog

All notable changes to bastra-recall are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.6.0-beta.1] — 2026-05-29

First public (pre-release) build. `0.x` signals the API may still change;
the `-beta` tag means it's feature-complete enough to use but may have rough
edges. Dogfooded daily against a real vault.

### Core
- **Memory vault** over plain markdown files with YAML frontmatter — your
  data stays as readable files you own.
- **Hybrid recall** — BM25 keyword search fused with optional embeddings
  (Ollama or OpenAI), with staleness ranking and a query cache.
- **Lean-by-default `recall`/`load_memory`** — `recall` returns slim
  candidates; `load_memory` fetches full content only for what you need
  (`verbosity:"full"` opts back in). ~32% smaller recall payloads.
- **`save_memory`** with typed entries (lesson, preference, decision,
  project-fact, …) and auto-related wikilink enrichment.
- **Documents** — `find_document` / `read_document` over PDFs, scans, notes.

### Daemon
- Single shared daemon (MCP over stdio + HTTP REST), spawned on demand by a
  forwarder so every AI client shares one vault/index — no N-copies sync bug.
- **Idle self-shutdown** (default 30 min, env-tunable) — keeps the process
  table clean; respawns on the next recall.
- Background update-check against GitHub releases.

### Reflex layer (hooks)
- SessionStart + PreToolUse hooks surface relevant memories automatically,
  before you write code or start a session.

### CLI & distribution
- `bastra install | uninstall | doctor | update` across Claude Code,
  Claude Desktop, and Cursor.
- Homebrew formula (head build) + double-click installer.

### Statusline
- Optional powerline-style statusline with a native `bastra` segment
  (live recall stats + vault size).

### Tooling
- CI (GitHub Actions): `npm ci` → build → type-check → test on a Node 20/22
  matrix, on every push and PR.

[0.6.0-beta.1]: https://github.com/n0mad-ai/bastra-recall/releases/tag/v0.6.0-beta.1
