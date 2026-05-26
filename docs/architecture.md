# Architecture

## Goal

Bastra.Recall is a local-first memory layer for AI assistants. It gives Claude Code, Claude Desktop, Cursor, ChatGPT Actions, and other MCP/HTTP clients one shared vault of durable lessons, preferences, project facts, decisions, workflows, bookmarks, and document sidecars.

The operating goal is simple: the user should not have to re-explain stable context. The assistant saves durable memories when a lesson or rule is learned, and recalls relevant memories before acting.

## Current Runtime Shape

```text
Markdown vault
  - recursive .md scan
  - YAML frontmatter + markdown body
  - Obsidian-compatible wikilinks
          |
          | Vault loader + chokidar watcher
          v
bastra-recall daemon (Node 20+, TypeScript)
  - in-memory MiniSearch BM25 index
  - optional in-memory EmbeddingIndex persisted at <vault>/.bastra/embeddings.json
  - optional Auto-Related enrichment via embedding similarity
  - local telemetry JSONL
  - HTTP REST on 127.0.0.1:6723
  - stdio MCP server
          |
          +--> direct stdio MCP clients
          |
          +--> mcp-forwarder stdio wrappers
          |      - auto-spawn or reuse one shared daemon
          |      - proxy MCP tool calls to HTTP REST
          |
          +--> hooks and non-MCP clients over HTTP
```

The vault is the source of truth. Search indexes, embedding vectors, telemetry, audit logs, and trash files are derived/runtime data under `.bastra/` or the user log directory.

## Vault Layer

`Vault` recursively scans the configured root from `BASTRA_VAULT_PATH` (legacy `NEXUS_VAULT_PATH` is still accepted). It loads only markdown files with a recognized `type` frontmatter value and silently ignores ordinary Obsidian notes.

Current write routing from `saveMemory`:

| Memory kind | Folder |
|---|---|
| `type: bookmark` | `bookmarks/` |
| `type: doc` | `dokumentationen/<scope>/` |
| `scope: user-preference` | `memories/user/` |
| `scope: all-projects` | `memories/all-projects/` |
| other scopes | `memories/projects/<scope>/` |

The scanner is recursive, so older flat vaults and hand-organized Obsidian folders continue to work.

The watcher uses `chokidar`. On paths that look like cloud-storage mounts (`CloudStorage`, `Dropbox`, `iCloud`), it switches to polling because native file events are unreliable there. Write paths call `vault.reindexFile(...)` after known writes so a save and a recall in the same turn stay consistent.

## Search And Recall

The current index is in-memory MiniSearch BM25, not SQLite/FTS5. The searched fields are:

- `recall_when` with the highest boost
- `title`
- `tags`
- `topic_path`
- `summary`
- markdown body

`recall(query, opts)` returns direct BM25 hits filtered by:

- `obsolete !== true`
- optional exact `scope`
- optional exact `type`
- `sensitivity !== private` unless `allow_private: true`

It then applies staleness reranking based on lifecycle fields such as `valid_until`, `expires_after_days`, and `last_reviewed_at`.

### Hybrid Recall

Embeddings are optional. `BASTRA_EMBEDDING_PROVIDER` controls the provider:

| Value | Behavior |
|---|---|
| `none` | disable embeddings |
| `ollama` | use local Ollama `/v1/embeddings` |
| `openai` | use OpenAI embeddings with `OPENAI_API_KEY` or `BASTRA_EMBEDDING_KEY` |
| unset + API key | use OpenAI for backwards compatibility |
| unset + no API key | BM25 only |

When an `EmbeddingIndex` is attached, `recallHybrid(...)` combines BM25 and vector rankings with Reciprocal Rank Fusion. Vectors are stored as base64-encoded floats in `<vault>/.bastra/embeddings.json`.

### Multi-Hop Recall

If `expand_hops: 1` is passed, recall adds one-hop neighbors from `frontmatter.related_via`. Those neighbors are filtered with the same obsolete/scope/type/sensitivity rules and receive a reduced score.

`RelatedEnricher` can maintain `related_via` automatically after embedding batches. It also appends an auto-managed Obsidian wikilink section to the memory body, bounded by marker comments so manual links and automatic links stay separate.

## Daemon And Transports

The main daemon is `packages/daemon/src/index.ts`.

It starts:

- one `Vault`
- one `SearchIndex`
- optional `EmbeddingIndex`
- optional `RelatedEnricher`
- one `Telemetry` instance
- HTTP REST server on `127.0.0.1:6723` by default
- stdio MCP server in the same process

HTTP can be disabled with `BASTRA_HTTP=off`. The port defaults to `6723` and can be changed with `BASTRA_HTTP_PORT` (legacy `NEXUS_HTTP_PORT` is accepted).

### MCP Forwarder

`bastra-recall-mcp` is a thin stdio MCP wrapper. It does not load the vault or hold an index. It:

1. probes `GET /health` on `BASTRA_DAEMON_URL` (default `http://127.0.0.1:6723`);
2. auto-spawns the daemon unless `BASTRA_FORWARDER_SPAWN=0`;
3. exposes MCP tools over stdio;
4. proxies each tool call to `/api/v1/<tool>`.

This lets multiple MCP clients share a single daemon, index, embedding queue, and telemetry stream.

## Tools

Core memory tools:

| Tool | Purpose |
|---|---|
| `recall` | Search memories by action context or natural-language query |
| `load_memory` | Load full frontmatter and body by id |
| `save_memory` | Write a new or overwritten memory markdown file and force reindex |

Document read tools:

| Tool | Purpose |
|---|---|
| `find_document` | Search `type: doc` sidecars |
| `read_document` | Load document sidecar metadata and extracted body |
| `open_document` | macOS-only open of the original file or sidecar |

Document write tools are gated by `BASTRA_DOCUMENT_WRITE=1`:

| Tool | Purpose |
|---|---|
| `save_document` | Copy or link an original file and write a retrievable sidecar |
| `recategorize_document` | Update title, tags, category, or folder metadata |
| `move_document` | Move sidecar and original file to another document folder |

The direct daemon only lists document write tools when the env flag is enabled. The forwarder may list them and let the daemon return the gate error on call.

## HTTP REST

The HTTP server binds to loopback only. Main endpoints:

| Endpoint | Method | Purpose |
|---|---|---|
| `/health` | `GET` | daemon health, version, vault size |
| `/hook/recall` | `POST` | Claude Code PreToolUse hook recall path |
| `/api/v1/recall` | `POST` | REST wrapper for `recall` |
| `/api/v1/load_memory` | `POST` | REST wrapper for `load_memory` |
| `/api/v1/save_memory` | `POST` | REST wrapper for `save_memory` |
| `/api/v1/find_document` | `POST` | REST wrapper for `find_document` |
| `/api/v1/read_document` | `POST` | REST wrapper for `read_document` |
| `/api/v1/open_document` | `POST` | REST wrapper for `open_document` |
| `/api/v1/save_document` | `POST` | gated document write |
| `/api/v1/recategorize_document` | `POST` | gated document write |
| `/api/v1/move_document` | `POST` | gated document write |

If `BASTRA_API_TOKEN` is set, `/api/v1/*` requires `Authorization: Bearer <token>`. Loopback callers bypass auth by default; set `BASTRA_AUTH_LOOPBACK_SKIP=0` to require the token even locally.

CORS defaults to `Access-Control-Allow-Origin: *` and can be restricted with `BASTRA_CORS_ORIGIN`.

## Hooks

Claude Code hooks call the loopback daemon and are designed to fail open so they do not block the assistant.

Current live hook binaries:

| Binary | Event | Purpose |
|---|---|---|
| `bastra-recall-hook` | `PreToolUse` | detect file/content topics before Write/Edit/MultiEdit/NotebookEdit and inject recall hints |
| `bastra-recall-session-hook` | `SessionStart` | preload user preferences, cross-project rules, and project memories at startup/resume/clear/compact |

Topic detection is deterministic and based on file extension, path segments, and content patterns. The hook sends a bounded natural-language query to `/hook/recall`.

## Privacy And Safety

- The daemon binds to `127.0.0.1`.
- The vault is plain local markdown.
- `sensitivity: private` memories are hidden from external MCP/REST callers unless an internal caller explicitly uses `allow_private: true`.
- `load_memory` also enforces the sensitivity filter, so direct id enumeration cannot load private memories.
- Telemetry is local JSONL and can be disabled with `BASTRA_TELEMETRY=off`.
- Save/delete/restore operations used by the Mac-app bridge can be recorded in `<vault>/.bastra/audit-log.ndjson`.
- Soft deletes move files to `<vault>/.bastra/trash/`.

## Stack Summary

| Layer | Current choice |
|---|---|
| Runtime | Node 20+, TypeScript, ESM |
| MCP | `@modelcontextprotocol/sdk` |
| Search | MiniSearch BM25 in memory |
| Embeddings | Optional OpenAI or Ollama provider, in-memory vectors with JSON persistence |
| Vault parsing | `gray-matter` + Zod frontmatter schema |
| File watching | `chokidar` with polling on cloud mounts |
| HTTP | Node `http` server |
| CLI/install adapters | Claude Code, Claude Desktop, Cursor |

## Historical Note

Early design docs described a SQLite/FTS5 index and HTTP MCP on port `7891`. That is not the current implementation. The current code uses MiniSearch/BM25, optional embeddings, REST on `127.0.0.1:6723`, and MCP stdio/forwarder transports.
