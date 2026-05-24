# Architecture

## Goal

A persistent teammate memory for Claude that:

- Works **across all Claude surfaces** Daniel uses (Claude Code, Claude Desktop, Claude.ai web/chat, Co-work). One vault, one index, one source of truth.
- **Saves autonomously** when a lesson is learned — without the user prompting.
- **Recalls before acting**, not only when the user asks.
- Stays **local-first, plain-markdown, Obsidian-compatible**.

## High-level shape

```
┌──────────────────────────────────────────────────────────────────────┐
│  Vault  (~/nexus-vault/)                                             │
│    Plain Markdown with YAML frontmatter (see memory-schema.md)       │
│    Editable in Obsidian, by Claude, by hand.                         │
└──────────────────────┬───────────────────────────────────────────────┘
                       │ chokidar file-watcher
                       ▼
┌──────────────────────────────────────────────────────────────────────┐
│  bastra-recall daemon  (single TypeScript process, always running)    │
│    - SQLite index (graph + FTS5)                                     │
│    - stdio MCP server   ←── Claude Code, Claude Desktop              │
│    - HTTP MCP server    ←── Claude.ai web (Custom Connector)         │
│    - REST endpoints     ←── hooks, CLI, future surfaces              │
└──────────────────────┬───────────────────────────────────────────────┘
                       │
   ┌───────────────────┼───────────────────┬─────────────────────┐
   ▼                   ▼                   ▼                     ▼
┌─────────────┐  ┌─────────────┐   ┌────────────────┐   ┌──────────────┐
│ Claude Code │  │ Claude      │   │ Claude.ai web  │   │ Co-work,     │
│   (CLI)     │  │ Desktop     │   │  (chat, proj.) │   │  future      │
│   stdio MCP │  │  stdio MCP  │   │   HTTP MCP     │   │  HTTP MCP    │
└─────────────┘  └─────────────┘   └────────────────┘   └──────────────┘
```

## Layers

### 1. Vault layer

- Path: `~/nexus-vault/` (configurable via `BASTRA_VAULT_PATH` env).
- Format: plain `.md` files, one memory per file. YAML frontmatter, markdown body, `[[wikilinks]]` for cross-references.
- Flat directory — no nested folders. The schema's `topic_path` provides the structuring axis.
- The vault is **the source of truth**. The SQLite index is a derived cache — losing it must never lose data.

This guarantees:
- Daniel can edit memorys in Obsidian directly. Watcher re-indexes within ~50ms.
- Memorys survive bastra-recall being uninstalled. They're just markdown.
- Cloud sync (iCloud, Dropbox, Syncthing, Git) works out of the box because it's a plain folder.

### 2. Index layer

SQLite at `~/.bastra/index.db`, with FTS5 enabled.

#### Tables

```sql
-- core memory record (mirrors frontmatter + body)
CREATE TABLE memorys (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  type          TEXT NOT NULL,
  summary       TEXT NOT NULL,
  scope         TEXT NOT NULL,
  source        TEXT,
  confidence    REAL DEFAULT 1.0,
  body_md       TEXT NOT NULL,
  file_path     TEXT NOT NULL,
  file_mtime    INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  obsolete      INTEGER DEFAULT 0
);

-- topic_path stored as a normalized path string ("/css/input/focus")
-- + a separate row per ancestor for prefix queries
CREATE TABLE memory_topics (
  memory_id     TEXT NOT NULL,
  topic_path    TEXT NOT NULL,           -- full path
  topic_prefix  TEXT NOT NULL,           -- ancestor for prefix matching
  PRIMARY KEY (memory_id, topic_prefix),
  FOREIGN KEY (memory_id) REFERENCES memorys(id) ON DELETE CASCADE
);

-- flat tags
CREATE TABLE memory_tags (
  memory_id     TEXT NOT NULL,
  tag           TEXT NOT NULL,
  PRIMARY KEY (memory_id, tag),
  FOREIGN KEY (memory_id) REFERENCES memorys(id) ON DELETE CASCADE
);

-- recall_when patterns
CREATE TABLE memory_recall_patterns (
  memory_id     TEXT NOT NULL,
  pattern       TEXT NOT NULL,
  FOREIGN KEY (memory_id) REFERENCES memorys(id) ON DELETE CASCADE
);

-- graph edges (typed, weighted)
CREATE TABLE memory_relations (
  from_id       TEXT NOT NULL,
  to_id         TEXT NOT NULL,
  relation      TEXT NOT NULL DEFAULT 'related',  -- related | replaces | superseded_by | derives-from
  weight        REAL DEFAULT 1.0,
  PRIMARY KEY (from_id, to_id, relation),
  FOREIGN KEY (from_id) REFERENCES memorys(id) ON DELETE CASCADE,
  FOREIGN KEY (to_id) REFERENCES memorys(id) ON DELETE CASCADE
);

-- FTS5 over searchable text
CREATE VIRTUAL TABLE memorys_fts USING fts5(
  memory_id UNINDEXED,
  title,
  summary,
  body_md,
  tags_flat,           -- space-joined tag list
  recall_patterns_flat,
  tokenize = 'porter unicode61'
);

-- telemetry
CREATE TABLE recall_log (
  ts                  TEXT NOT NULL,
  query               TEXT NOT NULL,
  context_json        TEXT,
  top_hits_json       TEXT NOT NULL,
  claude_loaded       INTEGER DEFAULT 0,
  surface             TEXT
);

CREATE TABLE save_log (
  ts                  TEXT NOT NULL,
  memory_id           TEXT NOT NULL,
  trigger             TEXT,
  was_autonomous      INTEGER NOT NULL,
  surface             TEXT
);
```

#### Why SQLite + FTS5, not a graph DB

For the working scale (low thousands of memorys, kilobytes per memory), SQLite is faster, simpler, and more robust than Neo4j or Kuzu. Graph traversal is one recursive CTE away. We get:

- Embedded — no separate process to manage
- ACID — corruption-resistant
- FTS5 built-in — no separate search engine
- Battle-tested across every OS

A graph DB would add operational complexity for capability we don't need.

#### Why no embeddings in v0

`recall_when` patterns + FTS5 cover keyword and substring matching. Embeddings (e.g. `bge-m3` local, ~500 MB) become valuable when:

- Patterns can't anticipate all phrasings of a context, AND
- Keyword matching demonstrably misses real cases

We measure this in the Dogfood week. If recall accuracy < 70%, embeddings move into v0.5. Until then, the storage cost and install friction aren't justified.

### 3. Daemon layer

A single TypeScript process (`bastra-recall serve`) running as a user-level daemon.

#### Lifecycle

- Mac: launched via `launchd` plist at `~/Library/LaunchAgents/com.bastra-recall.daemon.plist`. Auto-starts at login, restarts on crash.
- Listens on `localhost:7891` (HTTP) for web/chat surfaces.
- Exposes stdio via a separate small wrapper binary (`bastra-recall-stdio`) that proxies stdin/stdout to a local socket — Claude Code and Desktop spawn this wrapper as their MCP server config.

This means: **one process holds the index in memory**, every surface talks to it, no duplication.

#### Tools exposed via MCP (same set on stdio and HTTP)

```typescript
// tool: recall
{
  query: string,                       // free-form query OR action context
  context?: {
    project?: string,                  // current project name
    surface?: string,                  // "claude-code" | "claude-desktop" | ...
    intent?: string,                   // "creating component" | "writing css" | …
  },
  k?: number,                          // top-k, default 3
  scope_filter?: string[],             // restrict to scopes
}
// returns: [{ id, title, summary, score, scope, topic_path }]

// tool: load_memory
{ id: string }
// returns: full memory (frontmatter + body)

// tool: save_memory
{
  title, type, summary, topic_path, tags, scope,
  recall_when: string[],
  body_md: string,
  related?: string[],
  source?: string,
  confidence?: number,
  trigger?: "user-explicit" | "autonomous-frustration" | "autonomous-resolution" | "autonomous-decision",
}
// returns: { id, file_path }

// tool: list_memorys
{ scope?: string, type?: string, tag?: string, limit?: number }
// returns: [{ id, title, summary, type, scope, updated_at }]

// tool: link_memorys
{ from: string, to: string, relation?: string, weight?: number }
// returns: { ok: true }

// tool: update_memory  (rare — for confidence bumps, obsolescence, supersedes)
{ id, patch: { confidence?, obsolete?, superseded_by?, ... } }
// returns: full updated memory
```

#### Trigger hooks (separate from MCP tools)

Hooks run as small shell scripts that POST to the daemon's REST endpoint. They're not exposed as MCP tools — they fire automatically on Claude Code events.

| Event | Hook | Daemon endpoint | Purpose |
|---|---|---|---|
| `SessionStart` | `session-start.sh` | `POST /hook/session-start` | Inject session-start memorys (preferences, current project facts) |
| `UserPromptSubmit` | `user-prompt-submit.sh` | `POST /hook/user-prompt` | Stage-1 recall on user prompt |
| `PreToolUse` (Write/Edit) | `pre-write.sh` | `POST /hook/pre-write` | Stage-1 recall on the *content about to be written* (e.g. detect `<input` → recall input lessons) |
| `Stop` | `stop.sh` | `POST /hook/stop` | Evaluate whether the session contained a save-worthy moment; if so, prompt Claude to save in next turn |

The PreToolUse hook is what makes "buildin"-feel possible: I recall **before my own action**, not only on user input.

### 4. Surface adapters

| Surface | Transport | Setup |
|---|---|---|
| Claude Code | stdio MCP via wrapper | Add to `~/.claude.json` mcpServers: `bastra-recall: { command: "bastra-recall-stdio" }` |
| Claude Desktop | stdio MCP via wrapper | Same wrapper, configured in Desktop's MCP settings |
| Claude.ai (web/chat/projects) | HTTP MCP via Custom Connector | User adds a Custom Connector pointing to `http://localhost:7891/mcp`. Browser-extension or local proxy may be needed for HTTPS. |
| Co-work | HTTP MCP | Same as above |

The user's perspective: same tools (`recall`, `save_memory`, etc.) appear in every surface. Same vault. Same memory.

## Retrieval pipeline (recall)

When `recall(query, context)` is called:

```
1. Build candidate set
   a. FTS5 full-text query over (title, summary, body, tags, recall_patterns)
   b. Plus: any memory whose recall_when patterns substring-match query/context
   c. Plus: top neighbors of any candidate via memory_relations (1-hop graph expansion)
   → ~20-50 candidates

2. Score each candidate
   score = w_fts * fts_score
         + w_topic * topic_path_overlap(query_tokens, mem.topic_path)
         + w_recall_when * recall_pattern_match(context, mem.recall_when)
         + w_scope * scope_match(context.project, mem.scope)
         + w_recency * recency_decay(mem.updated_at)
         + w_confidence * mem.confidence
         - w_obsolete * mem.obsolete

3. Filter
   - Remove obsolete memorys (unless explicitly asked)
   - Apply scope filter (e.g., scope is "carnexus" but project is "carview" AND scope_match=0 → drop)
   - Drop below threshold (default 0.3)

4. Return top-k with scores
```

Weights start as constants, get tuned during the Dogfood week from `recall_log` data (which hits Claude actually loaded vs ignored).

## Save pipeline (autonomous)

See `triggers.md` for when. The mechanics:

```
1. Claude calls save_memory(payload)
2. Daemon validates against schema (memory-schema.md)
3. Daemon writes <id>.md to vault
4. chokidar fires → re-index
5. Daemon logs to save_log (ts, id, trigger, was_autonomous)
6. Daemon optionally returns "1-line ack" string for Claude to surface to user:
   "→ saved memory: <title>"
```

That ack string is what Daniel sees. It's the audit trail — the "I noticed this and remembered it" signal that builds trust in the system.

## Privacy

- Vault is local. Nothing leaves the Mac unless Daniel explicitly enables sync.
- The daemon binds to `localhost` only — no LAN exposure.
- Telemetry (`recall_log`, `save_log`) is local-only, never phoned home.
- Claude.ai web Connectors require HTTPS in many configs; a local mTLS or Tailscale-funnel option will be evaluated in v0.5.

## Stack summary

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript (Node 20+) | Matches MCP ecosystem; @modelcontextprotocol/sdk is first-class TS |
| DB | SQLite via `better-sqlite3` | Embedded, sync API, FTS5 built-in |
| HTTP | Hono | Tiny, fast, web-standard Request/Response, easy to test |
| File watcher | chokidar | Standard, robust on macOS |
| MCP server | `@modelcontextprotocol/sdk` | Official, supports both stdio and SSE/streaming HTTP |
| Markdown parser | `gray-matter` + `remark` | Frontmatter + AST for body manipulation |
| Process supervisor | `launchd` (Mac) | Native, restart-on-crash, auto-start at login |
| Distribution | Homebrew tap (Mac-first) | Daniel-relevant; npm package as fallback |

## Out of scope for v0

- Embeddings (semantic search) — moves to v0.5 if Dogfood data demands it
- Codebase indexing (AST, topology maps) — separate "Phase 2", not blocking memory MVP
- Multi-Mac sync — vault is a folder, deferred to user's choice (iCloud/Dropbox/Git)
- Web UI — Obsidian *is* the UI for browsing/editing
- Team-sharing, SaaS — only after solo dogfood proves value
