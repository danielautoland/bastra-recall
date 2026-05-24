# bastra-recall

## 🇬🇧 English

> A persistent teammate memory for any AI assistant — across every surface.

**What it is** — A long-term memory for any AI assistant or agent: Claude (Code, Desktop, Web), ChatGPT (via Custom GPT Actions), Cursor, and anything else that speaks MCP or HTTP. Whenever you correct it, state a rule, or commit to a decision, it gets saved as a small note. In your next chat — days or weeks later, in any tool — the AI pulls those notes back automatically. No more repeating yourself. Everything stays on your own Mac as plain Markdown files (Obsidian-compatible). All your AI tools share the same memory at the same time.

## 🇩🇪 Deutsch

> Ein persistentes Teammate-Gedächtnis für jeden AI-Assistenten — über jede Oberfläche hinweg.

**Was es ist** — Ein Langzeit-Gedächtnis für jeden AI-Assistenten oder Agent: Claude (Code, Desktop, Web), ChatGPT (via Custom GPT Actions), Cursor und alles andere, was MCP oder HTTP spricht. Sobald du etwas korrigierst, eine Regel aufstellst oder eine Entscheidung triffst, wird das als kleine Notiz gespeichert. In der nächsten Sitzung — Tage oder Wochen später, in jedem Tool — holt die AI diese Notizen automatisch wieder hervor. Schluss mit ewigem Wiederholen. Alles bleibt lokal auf deinem Mac als reine Markdown-Dateien (Obsidian-kompatibel). Alle deine AI-Tools teilen sich dasselbe Gedächtnis gleichzeitig.

**Status:** 🟢 Early alpha — M0 (eval) and M1 (read path) done, M2 (save path) functional, M3 reflex layer functional with two of four hooks live: `PreToolUse` (recall before each Write/Edit) and `SessionStart` (preload top memorys at session open). Distribution and multi-surface are next. See [PLAN.md](./PLAN.md).

---

## Why

Working with Claude over months means re-explaining the same things. CSS pitfalls Claude already learned in one project recur in the next. Stable preferences (*"give me a recommendation, not a 5-option menu"*) get forgotten between sessions. Project-specific facts get re-discovered every time.

Claude has memory features, but they're **passive**: a static index file at best, no proactive recall, no cross-surface continuity.

The cost isn't just frustration — it's that the user ends up thinking *for* Claude. *"Wait, didn't we solve this last week?"* That's the bug.

## What bastra-recall does

A persistent memory layer that:

- **Saves autonomously** — when a lesson is learned (frustration, repeated correction, durable preference, finalized decision), Claude writes it to the vault without being asked. Trigger discipline is shipped as a Claude Code Skill (see [packages/skill/SKILL.md](./packages/skill/SKILL.md)).
- **Recalls before acting** — not only when the user prompts. The Skill instructs Claude to query the vault before writing code, before plans, and at session start; the highest-weighted search field is `recall_when`, declared at save time.
- **Works across surfaces** — one local daemon serves Claude Code via MCP today; Claude Desktop and Claude.ai web (Custom Connector) are on the roadmap.
- **Plain markdown, Obsidian-compatible** — the vault is a folder of `.md` files with YAML frontmatter. Edit in Obsidian, in Claude, by hand. Vaults on Google Drive / iCloud / Dropbox mounts are supported via automatic polling-mode in the file watcher.

## The single success metric

> **The user doesn't have to think for Claude anymore.**

If recurring mistakes still recur, if the user still has to re-state preferences each session — the project failed, regardless of how clean the architecture is.

## How it works

```
Vault (configurable, plain markdown + YAML frontmatter, Obsidian-compatible)
          │  chokidar (auto-polls on cloud-storage mounts)
          ▼
bastra-recall daemon (TypeScript / Node 20+, single local process)
  - In-memory BM25 index (MiniSearch) — recall_when×5, title×4, tags×3
  - MCP tools today: recall, load_memory, save_memory
  - Save path: validates frontmatter → writes file → force-reindexes
    (so a save and a recall in the same turn are consistent)
  - Transport: stdio MCP → Claude Code (Desktop + web on roadmap)
          │
          ▼
Claude Code Skill (packages/skill/SKILL.md)
  - "USE PROACTIVELY when …" trigger description
  - Carries the save/recall trigger discipline into every session
  - Single-file install, no settings.json edits
```

Hooks: two reflex hooks ship with the daemon, both speaking to its loopback HTTP endpoint:
- **`PreToolUse`** (`bastra-recall-hook`) — fires before every `Write`/`Edit`/`MultiEdit`/`NotebookEdit`. Topic-detects from the tool intent and injects `<recall-hints>` as `additionalContext`.
- **`SessionStart`** (`bastra-recall-session-hook`) — fires on `startup`/`resume`/`clear`/`compact`. Preloads top user-prefs + cross-project rules + project-scoped memorys as `<session-context>` so the model knows who, what, and what-not from the first prompt.

`UserPromptSubmit` and `Stop` hooks remain queued for v0.5 once dogfood reveals where they'd close gaps. Telemetry (`scripts/stats.ts`) tracks per-hook latency, hint-quality, and follow-through (did the model actually `load_memory` after a hint).

Details: [docs/architecture.md](./docs/architecture.md), [docs/memory-schema.md](./docs/memory-schema.md), [docs/triggers.md](./docs/triggers.md).

## Memory shape

Each memory is a markdown file with structured frontmatter:

```yaml
---
id: css-input-focus-ring-stacking
title: "Don't stack focus styles on inputs"
type: lesson
summary: "Stacking ring + outline + custom :focus on nested inputs causes double focus rings. Use single :focus-visible."
topic_path: [css, input, focus]
tags: [css, input, focus-ring, ui-bug]
scope: all-projects
recall_when:
  - creating new input component
  - writing input or form css
  - focus or accessibility styling
related: [css-effects-stacking-antipattern]
source: "carnexus, recurring lesson"
confidence: 0.95
---
```

The `recall_when` field is the bridge between save and recall: when saving, Claude declares the contexts under which future-Claude should be reminded. See [docs/memory-schema.md](./docs/memory-schema.md) for full field semantics and six example memorys covering `lesson`, `preference`, `project-fact`, `meta-working`, `decision`, `workflow`.

## Quickstart (current — manual; brew + init coming)

Pre-requisites: Node 20+, Claude Code, an Obsidian vault (or any folder for `.md` files).

```bash
git clone https://github.com/danielautoland/bastra-recall.git
cd bastra-recall/packages/daemon
npm install
npm run build
```

Add the MCP server to Claude Code (`~/.claude.json`).

**Recommended (forwarder mode — shares one daemon across all sessions):**

```json
"bastra-recall": {
  "command": "node",
  "args": ["/abs/path/to/bastra-recall/packages/daemon/dist/mcp-forwarder.js"],
  "env": {
    "BASTRA_VAULT_PATH": "/abs/path/to/your/vault/memorys"
  }
}
```

The forwarder is a thin stdio-MCP wrapper that talks to a single local HTTP daemon (port 6723 by default). All MCP clients — Claude Code, Claude Desktop, Cursor, additional sessions — share the same vault state, embedding index, and telemetry. The forwarder auto-spawns the daemon on first run if no one is listening yet.

**Standalone mode (one MCP client only, no sharing):**

```json
"bastra-recall": {
  "command": "node",
  "args": ["/abs/path/to/bastra-recall/packages/daemon/dist/index.js"],
  "env": {
    "BASTRA_VAULT_PATH": "/abs/path/to/your/vault/memorys"
  }
}
```

Each session spawns its own embedded daemon. Simpler but loses cross-session vault consistency on cloud-storage mounts where the file watcher lags.

Activate the Skill (save/recall trigger discipline) and the reflex hooks (PreToolUse + SessionStart):

```bash
bash packages/skill/install.sh        # copies SKILL.md → ~/.claude/skills/bastra-recall/
bash packages/skill/install-hook.sh   # registers PreToolUse + SessionStart hooks in ~/.claude/settings.json
```

Then **restart Claude Code** — Skills and hooks are read at startup. Both hooks post to `http://127.0.0.1:6723/hook/recall` (port configurable via `BASTRA_HTTP_PORT`); if no daemon is reachable they silently no-op, so an unloaded MCP server never blocks Claude.

Re-run `install.sh` whenever `SKILL.md` changes; re-run `install-hook.sh` only if hook binary paths move. To remove the hooks again: `bash packages/skill/install-hook.sh --uninstall`.

A Homebrew tap and `bastra-recall init` are tracked as roadmap issues.

## REST API (for non-MCP clients)

The daemon exposes a REST API on `http://127.0.0.1:6723/api/v1/` covering every tool the MCP server offers. This is the integration point for clients that can't speak stdio-MCP — most notably **ChatGPT Custom GPT Actions**, which call HTTPS endpoints with an OpenAPI schema.

Endpoints (all `POST`, JSON body):

| Endpoint | Tool |
|---|---|
| `/api/v1/recall` | recall |
| `/api/v1/load_memory` | load_memory |
| `/api/v1/save_memory` | save_memory |
| `/api/v1/find_document` / `read_document` / `open_document` | document search |
| `/api/v1/save_document` / `recategorize_document` / `move_document` | document write (Pro) |

Auth and CORS:

- If `BASTRA_API_TOKEN` is set, the daemon requires `Authorization: Bearer <token>` on every `/api/v1/*` request.
- Loopback callers (`127.0.0.1`) bypass auth by default. Set `BASTRA_AUTH_LOOPBACK_SKIP=0` to require the token even locally.
- CORS is permissive by default (`Access-Control-Allow-Origin: *`). Restrict via `BASTRA_CORS_ORIGIN=https://your.host`.

To expose this API to a hosted client like ChatGPT, point a tunnel (Cloudflare Tunnel / ngrok / your own reverse proxy) at `127.0.0.1:6723` and configure the Custom GPT with the tunnel URL + your token. An OpenAPI 3.0 spec is tracked as a roadmap issue.

## Roadmap

Milestone-based, not phase-based. Each gate is a hard pass/fail.

| Milestone | Scope | Status |
|---|---|---|
| **M0** | Recall-quality eval on real vault | ✅ **Done** — Recall@1 98.3%, Recall@3 100%, MRR 0.992 across 59 memorys (own-trigger baseline). BM25 + `recall_when`-boost is sufficient; embeddings deferred. |
| **M1** | Daemon + read path (`recall`, `load_memory`) | ✅ **Done** — MCP server live, watcher works on cloud-storage mounts. |
| **M2** | Save path + autonomous-save triggers | 🟡 **Functional** — `save_memory` MCP tool live with force-reindex. Trigger discipline shipped as a Skill. False-save / missed-save metrics not yet collected. |
| **M0.5** | Stress-test recall (paraphrased / cross-memory / anti-hallucination) | ⏳ Open — see issues. |
| **M3** | Reflex layer: hooks for `SessionStart` / `UserPromptSubmit` / `PreToolUse` / `Stop` | 🟡 **Functional (PreToolUse + SessionStart)** — both ship and post to daemon's `/hook/recall`. Telemetry tracks follow-through (load_memory ↔ hint correlation). `UserPromptSubmit` and `Stop` queued for v0.5 once data shows where they'd help. |
| **Distribution** | Homebrew tap, `bastra-recall init`, npm package | ⏳ Open. |
| **Multi-surface** | HTTP transport for Claude.ai web (Custom Connector) | ⏳ Open. |

Out of v0: embeddings (deferred to v0.5 only if M0.5 fails), codebase indexing, multi-device sync, web UI, team-sharing, SaaS. See [PLAN.md](./PLAN.md).

## License

MIT — see [LICENSE](./LICENSE).

Public docs and code on this branch are published under the open license; private notes (in `private/`, gitignored) are not.

## Status & contact

Pre-alpha. See [PLAN.md](./PLAN.md). Issues and discussions welcome — early feedback shapes the design.

Built by [@danielautoland](https://github.com/danielautoland).
