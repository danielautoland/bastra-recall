# bastra-recall

> A persistent teammate memory for any AI assistant — across every surface.
> Ein persistentes Teammate-Gedächtnis für jeden AI-Assistenten — über jede Oberfläche hinweg.

---

## 🇬🇧 English

**What it is** — A long-term memory for any AI assistant or agent: Claude (Code, Desktop, Web), ChatGPT (via Custom GPT Actions), Cursor, and anything else that speaks MCP or HTTP. Whenever you correct it, state a rule, or commit to a decision, it gets saved as a small note. In your next chat — days or weeks later, in any tool — the AI pulls those notes back automatically. No more repeating yourself. Everything stays on your own Mac as plain Markdown files (Obsidian-compatible). All your AI tools share the same memory at the same time.

**Status** — 🟢 Early alpha. M0 (eval) and M1 (read path) done, M2 (save path) functional, M3 reflex layer functional with two of four hooks live: `PreToolUse` (recall before each Write/Edit) and `SessionStart` (preload top memories at session open). Distribution and multi-surface are next. See [PLAN.md](./PLAN.md).

### Why

Working with an AI assistant over months means re-explaining the same things. Pitfalls it already learned in one project recur in the next. Stable preferences (*"give me a recommendation, not a 5-option menu"*) get forgotten between sessions. Project-specific facts get re-discovered every time.

Most AI tools have memory features, but they're **passive**: a static index file at best, no proactive recall, no cross-surface continuity.

The cost isn't just frustration — it's that the user ends up thinking *for* the AI. *"Wait, didn't we solve this last week?"* That's the bug.

### What bastra-recall does

A persistent memory layer that:

- **Saves autonomously** — when a lesson is learned (frustration, repeated correction, durable preference, finalized decision), the AI writes it to the vault without being asked. Trigger discipline ships as a Claude Code Skill; other clients are conditioned through their own system prompt or Custom GPT instructions.
- **Recalls before acting** — not only when the user prompts. The AI is instructed to query the vault before writing code, before plans, and at session start. The highest-weighted search field is `recall_when`, declared at save time.
- **Works across surfaces** — one local daemon serves all your AI tools at once: Claude Code (via MCP), Claude Desktop (via MCP), ChatGPT (via Custom GPT Actions over HTTP), Cursor, and anything else that speaks MCP or HTTP.
- **Plain markdown, Obsidian-compatible** — the vault is a folder of `.md` files with YAML frontmatter. Edit in Obsidian, in the AI, or by hand. Vaults on Google Drive / iCloud / Dropbox mounts are supported via automatic polling-mode in the file watcher.

### The single success metric

> **The user doesn't have to think for the AI anymore.**

If recurring mistakes still recur, if the user still has to re-state preferences each session — the project failed, regardless of how clean the architecture is.

### How it works

```
Vault (configurable, plain markdown + YAML frontmatter, Obsidian-compatible)
          │  chokidar (auto-polls on cloud-storage mounts)
          ▼
bastra-recall daemon (TypeScript / Node 20+, single local process)
  - In-memory BM25 index (MiniSearch) — recall_when×5, title×4, tags×3
  - Hybrid recall: BM25 + embeddings (Ollama or OpenAI) via RRF fusion
  - Tools: recall, load_memory, save_memory, find/read/save_document
  - Save path: validates frontmatter → writes file → force-reindexes
    (so a save and a recall in the same turn are consistent)
  - Transport: stdio MCP + HTTP REST (for non-MCP clients)
          │
          ▼
One daemon ↔ many AI clients
  - Claude Code / Desktop / Cursor → via thin MCP forwarder (stdio → HTTP)
  - ChatGPT Custom GPT, web apps, custom scripts → via REST /api/v1/*
  - All clients share the same vault, index, telemetry stream
```

Two reflex hooks ship with the daemon, both speaking to its loopback HTTP endpoint:

- **`PreToolUse`** (`bastra-recall-hook`) — fires before every `Write`/`Edit`/`MultiEdit`/`NotebookEdit`. Topic-detects from the tool intent and injects `<recall-hints>` as `additionalContext`.
- **`SessionStart`** (`bastra-recall-session-hook`) — fires on `startup`/`resume`/`clear`/`compact`. Preloads top user-prefs + cross-project rules + project-scoped memories as `<session-context>` so the AI knows who, what, and what-not from the first prompt.

`UserPromptSubmit` and `Stop` hooks remain queued for v0.5 once dogfood reveals where they'd close gaps. Telemetry (`scripts/stats.ts`) tracks per-hook latency, hint-quality, and follow-through (did the AI actually `load_memory` after a hint).

Details: [docs/architecture.md](./docs/architecture.md), [docs/memory-schema.md](./docs/memory-schema.md), [docs/triggers.md](./docs/triggers.md).

### Memory shape

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

The `recall_when` field is the bridge between save and recall: when saving, the AI declares the contexts under which future-sessions should be reminded. See [docs/memory-schema.md](./docs/memory-schema.md) for full field semantics and six example memories covering `lesson`, `preference`, `project-fact`, `meta-working`, `decision`, `workflow`.

### Install

Three paths, in order of friction. bastra-recall is self-contained: the daemon, the MCP server, the REST gateway, the `bastra` CLI, and the Skill all ship in this repo — nothing else needed for full vault functionality.

#### A) One double-click — easiest, for non-coders (rolling out)

1. Download **Install Bastra.command** from the latest GitHub release.
2. Double-click it in Finder.
3. Done. Restart Claude Code / Claude Desktop / Cursor.

The script installs Homebrew if it's missing, adds the bastra tap, installs `bastra-recall`, and runs `bastra install all` — no terminal knowledge required.

> **Status (today):** `distribution/Install Bastra.command` is ready in this repo. The Homebrew tap (`n0mad-ai/homebrew-tap`) it relies on is published as soon as [#3](https://github.com/n0mad-ai/bastra-recall/issues/3) closes. Until then, use path B.

#### B) One command — for developers

Pre-requisites: Node 20+, Git.

```bash
git clone https://github.com/n0mad-ai/bastra-recall.git
cd bastra-recall/packages/daemon
npm install
npm run build

node dist/cli.js install all       # registers with every supported AI client
node dist/cli.js doctor            # check status everywhere
node dist/cli.js uninstall all     # reverse everything
```

Adapter status:

| Surface | What gets installed | Status |
|---|---|---|
| `claude-desktop` | MCP server entry in `claude_desktop_config.json` | ✅ implemented |
| `claude-code` | MCP server in `.claude.json` + Skill in `.claude/skills/` + PreToolUse & SessionStart hooks in `.claude/settings.json` | ✅ implemented |
| `cursor` | MCP server entry in `.cursor/mcp.json` | ✅ implemented (Cursor Rules layer is a separate roadmap item) |

Every write is **idempotent** (re-runs are no-ops), **atomic** (tmp file + rename), **backed up** (timestamped `.bak-…` next to the original), and **parse-safe** (broken JSON aborts the run instead of corrupting it). Vault path resolves in this order: `--vault <path>` flag → `BASTRA_VAULT_PATH` env → auto-detect from an existing registration in `~/.claude.json` or `claude_desktop_config.json`. The CLI bails with a clear message if none of those produce a path.

Once the brew tap is live, this collapses to `bastra install all`.

#### C) Fully manual — fallback

Add the MCP server block to your client's config (`~/.claude.json` for Claude Code, `~/Library/Application Support/Claude/claude_desktop_config.json` for Claude Desktop, `~/.cursor/mcp.json` for Cursor).

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

For Claude Code, also drop the Skill + hooks by hand:

```bash
bash packages/skill/install.sh        # copies SKILL.md → ~/.claude/skills/bastra-recall/
bash packages/skill/install-hook.sh   # registers PreToolUse + SessionStart hooks in ~/.claude/settings.json
```

`bastra install claude-code` does both of these for you in path B. Re-run `install.sh` whenever `SKILL.md` changes; re-run `install-hook.sh` only if hook binary paths move. To remove the hooks again: `bash packages/skill/install-hook.sh --uninstall`.

### REST API (for non-MCP clients)

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

### Roadmap

Milestone-based, not phase-based. Each gate is a hard pass/fail.

| Milestone | Scope | Status |
|---|---|---|
| **M0** | Recall-quality eval on real vault | ✅ **Done** — Recall@1 98.3%, Recall@3 100%, MRR 0.992 across 59 memories (own-trigger baseline). BM25 + `recall_when`-boost is sufficient; embeddings deferred. |
| **M1** | Daemon + read path (`recall`, `load_memory`) | ✅ **Done** — MCP server live, watcher works on cloud-storage mounts. |
| **M2** | Save path + autonomous-save triggers | 🟡 **Functional** — `save_memory` MCP tool live with force-reindex. Trigger discipline shipped as a Skill. False-save / missed-save metrics not yet collected. |
| **M0.5** | Stress-test recall (paraphrased / cross-memory / anti-hallucination) | ⏳ Open — see issues. |
| **M3** | Reflex layer: hooks for `SessionStart` / `UserPromptSubmit` / `PreToolUse` / `Stop` | 🟡 **Functional (PreToolUse + SessionStart, 2 of 4)** — both live in production: `PreToolUse` injects `<recall-hints>` before every Write/Edit (2547 invocations over 22 days, 91.5% REQUIRED-band hits), `SessionStart` injects `<session-context>` at every new chat. `UserPromptSubmit` and `Stop` queued. |
| **Distribution** | Homebrew tap, `bastra` CLI, `Install Bastra.command`, npm package | 🟡 **Functional** — `bastra` CLI ships with adapters for every surface; Homebrew tap [n0mad-ai/homebrew-tap](https://github.com/n0mad-ai/homebrew-tap) published with a head-only formula; `distribution/Install Bastra.command` is the doubleclick wrapper. Open: end-to-end brew test, npm publish, GitHub release with the `.command` as an asset (#3). |
| **Multi-surface** | One install per AI client (MCP + Skill + Hooks where applicable) + REST gateway for non-MCP clients | 🟡 **Functional** — `bastra install` covers Claude Code (MCP + Skill + Hooks), Claude Desktop (MCP + Skill), Cursor (MCP). REST `/api/v1/*` enables ChatGPT Custom GPT Actions over HTTPS + tunnel. Open: OpenAPI 3.0 spec, Claude.ai web Custom Connector registration (#7). |

Out of v0: **codebase indexing**, **multi-device sync**. See [PLAN.md](./PLAN.md).

Multi-device today works via the OS-level sync of the vault folder (iCloud / Google Drive / Dropbox / Git) — the file watcher's polling mode handles the latency. A browser-based UI is not planned — Obsidian already provides a great Markdown editor for the vault.

### Bastra Mac App

A native macOS app is being built on top of bastra-recall — same vault, same daemon, just a graphical interface for people who don't want to live in the terminal. In development; a dedicated page with screenshots and updates will follow.

### License

MIT — see [LICENSE](./LICENSE).

Public docs and code on this branch are published under the open license; private notes (in `private/`, gitignored) are not.

### Status & contact

Pre-alpha. See [PLAN.md](./PLAN.md). Issues and discussions welcome — early feedback shapes the design.

Built by [@n0mad-ai](https://github.com/n0mad-ai).

---

## 🇩🇪 Deutsch

**Was es ist** — Ein Langzeit-Gedächtnis für jeden AI-Assistenten oder Agent: Claude (Code, Desktop, Web), ChatGPT (via Custom GPT Actions), Cursor und alles andere, was MCP oder HTTP spricht. Sobald du etwas korrigierst, eine Regel aufstellst oder eine Entscheidung triffst, wird das als kleine Notiz gespeichert. In der nächsten Sitzung — Tage oder Wochen später, in jedem Tool — holt die AI diese Notizen automatisch wieder hervor. Schluss mit ewigem Wiederholen. Alles bleibt lokal auf deinem Mac als reine Markdown-Dateien (Obsidian-kompatibel). Alle deine AI-Tools teilen sich dasselbe Gedächtnis gleichzeitig.

**Status** — 🟢 Frühes Alpha. M0 (Eval) und M1 (Read-Path) fertig, M2 (Save-Path) funktional, M3 Reflex-Layer funktional mit zwei von vier Hooks live: `PreToolUse` (Recall vor jedem Write/Edit) und `SessionStart` (Top-Memories beim Sitzungsstart vorladen). Distribution und Multi-Surface kommen als Nächstes. Siehe [PLAN.md](./PLAN.md).

### Warum

Wenn du Monate mit einem AI-Assistenten arbeitest, erklärst du dieselben Dinge immer wieder. Stolperfallen, die er in einem Projekt schon mal gelernt hat, kommen im nächsten zurück. Stabile Vorlieben (*"gib mir eine Empfehlung, kein 5-Optionen-Menü"*) sind zwischen Sitzungen vergessen. Projekt-spezifische Fakten werden jedes Mal neu entdeckt.

Die meisten AI-Tools haben zwar Memory-Features, aber die sind **passiv**: bestenfalls eine statische Index-Datei, kein proaktives Erinnern, keine Kontinuität über verschiedene Oberflächen hinweg.

Der Preis ist nicht nur Frust — sondern dass am Ende der User für die AI mitdenkt. *"Moment, das hatten wir doch letzte Woche schon gelöst?"* Genau das ist der Bug.

### Was bastra-recall macht

Eine persistente Gedächtnis-Schicht, die:

- **Autonom speichert** — wenn etwas gelernt wird (Frust, wiederholte Korrektur, dauerhafte Vorliebe, finale Entscheidung), schreibt die AI das ungefragt in den Vault. Die Trigger-Disziplin wird als Claude Code Skill ausgeliefert; andere Clients werden über ihren System-Prompt oder Custom-GPT-Instructions konditioniert.
- **Vor dem Handeln erinnert** — nicht erst auf User-Anfrage. Die AI wird angewiesen, den Vault vor dem Code-Schreiben, vor Plänen und beim Sitzungsstart abzufragen. Das höchstgewichtete Suchfeld ist `recall_when`, das beim Speichern deklariert wird.
- **Über alle Oberflächen hinweg funktioniert** — ein lokaler Daemon bedient alle deine AI-Tools gleichzeitig: Claude Code (via MCP), Claude Desktop (via MCP), ChatGPT (via Custom GPT Actions über HTTP), Cursor und alles weitere, was MCP oder HTTP spricht.
- **Reines Markdown, Obsidian-kompatibel** — der Vault ist ein Ordner mit `.md`-Dateien und YAML-Frontmatter. Bearbeitbar in Obsidian, durch die AI oder per Hand. Vaults auf Google Drive / iCloud / Dropbox werden über den automatischen Polling-Modus des File-Watchers unterstützt.

### Der einzige Erfolgs-Maßstab

> **Der User muss nicht mehr für die AI mitdenken.**

Wenn wiederkehrende Fehler weiter auftreten, wenn der User in jeder Sitzung dieselben Vorlieben wiederholen muss — dann ist das Projekt gescheitert, egal wie sauber die Architektur ist.

### Wie es funktioniert

```
Vault (konfigurierbar, reines Markdown + YAML-Frontmatter, Obsidian-kompatibel)
          │  chokidar (Auto-Polling auf Cloud-Storage-Mounts)
          ▼
bastra-recall Daemon (TypeScript / Node 20+, ein lokaler Prozess)
  - In-Memory BM25-Index (MiniSearch) — recall_when×5, title×4, tags×3
  - Hybrid Recall: BM25 + Embeddings (Ollama oder OpenAI) via RRF-Fusion
  - Tools: recall, load_memory, save_memory, find/read/save_document
  - Save-Path: validiert Frontmatter → schreibt Datei → erzwingt Reindex
    (sodass save und recall im selben Turn konsistent sind)
  - Transport: stdio-MCP + HTTP-REST (für Nicht-MCP-Clients)
          │
          ▼
Ein Daemon ↔ viele AI-Clients
  - Claude Code / Desktop / Cursor → über dünnen MCP-Forwarder (stdio → HTTP)
  - ChatGPT Custom GPT, Web-Apps, eigene Skripte → über REST /api/v1/*
  - Alle Clients teilen denselben Vault, Index und Telemetry-Stream
```

Zwei Reflex-Hooks liegen dem Daemon bei, beide sprechen seinen lokalen HTTP-Endpoint an:

- **`PreToolUse`** (`bastra-recall-hook`) — feuert vor jedem `Write`/`Edit`/`MultiEdit`/`NotebookEdit`. Erkennt das Thema aus dem Tool-Aufruf und injiziert `<recall-hints>` als `additionalContext`.
- **`SessionStart`** (`bastra-recall-session-hook`) — feuert bei `startup`/`resume`/`clear`/`compact`. Lädt Top-User-Präferenzen + projektübergreifende Regeln + projekt-spezifische Memories als `<session-context>` vor, damit die AI ab dem ersten Prompt weiß: wer, was, und was-nicht.

`UserPromptSubmit`- und `Stop`-Hooks bleiben in Warteschlange für v0.5 — sobald der Dogfood-Einsatz zeigt, wo sie Lücken schließen würden. Die Telemetrie (`scripts/stats.ts`) misst pro Hook Latenz, Hint-Qualität und Follow-Through (hat die AI nach einem Hint wirklich `load_memory` gemacht).

Details: [docs/architecture.md](./docs/architecture.md), [docs/memory-schema.md](./docs/memory-schema.md), [docs/triggers.md](./docs/triggers.md).

### Schema einer Erinnerung

Jede Memory ist eine Markdown-Datei mit strukturiertem Frontmatter:

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

Das `recall_when`-Feld ist die Brücke zwischen Save und Recall: beim Speichern deklariert die AI die Kontexte, in denen die spätere Sitzung daran erinnert werden soll. Siehe [docs/memory-schema.md](./docs/memory-schema.md) für die vollständige Feld-Semantik und sechs Beispiel-Memories für `lesson`, `preference`, `project-fact`, `meta-working`, `decision`, `workflow`.

### Installation

Drei Wege, nach Aufwand sortiert. bastra-recall ist eigenständig: Daemon, MCP-Server, REST-Gateway, `bastra`-CLI und Skill liegen alle in diesem Repo — mehr braucht es nicht für die volle Vault-Funktionalität.

#### A) Ein Doppelklick — am einfachsten, für Nicht-Coder (Rollout läuft)

1. Lade **Install Bastra.command** aus dem aktuellen GitHub-Release.
2. Doppelklick im Finder.
3. Fertig. Claude Code / Claude Desktop / Cursor neu starten.

Das Skript installiert bei Bedarf Homebrew, fügt den bastra-Tap hinzu, installiert `bastra-recall` und führt `bastra install all` aus — kein Terminal-Wissen nötig.

> **Status (heute):** `distribution/Install Bastra.command` liegt im Repo. Der Homebrew-Tap (`n0mad-ai/homebrew-tap`), den das Skript erwartet, wird mit Schließen von [#3](https://github.com/n0mad-ai/bastra-recall/issues/3) veröffentlicht. Bis dahin Pfad B nutzen.

#### B) Ein Befehl — für Entwickler

Voraussetzungen: Node 20+, Git.

```bash
git clone https://github.com/n0mad-ai/bastra-recall.git
cd bastra-recall/packages/daemon
npm install
npm run build

node dist/cli.js install all       # registriert bei jedem unterstützten AI-Client
node dist/cli.js doctor            # Status überall prüfen
node dist/cli.js uninstall all     # alles rückgängig machen
```

Adapter-Status:

| Surface | Was installiert wird | Status |
|---|---|---|
| `claude-desktop` | MCP-Server-Eintrag in `claude_desktop_config.json` | ✅ implementiert |
| `claude-code` | MCP-Server in `.claude.json` + Skill in `.claude/skills/` + PreToolUse- & SessionStart-Hooks in `.claude/settings.json` | ✅ implementiert |
| `cursor` | MCP-Server-Eintrag in `.cursor/mcp.json` | ✅ implementiert (Cursor-Rules-Layer separater Roadmap-Punkt) |

Jeder Write ist **idempotent** (Re-Runs sind No-Ops), **atomar** (Tmp-File + Rename), **gesichert** (timestamped `.bak-…` neben dem Original) und **parse-safe** (kaputtes JSON bricht den Lauf ab statt es zu zerstören). Vault-Pfad-Auflösung in dieser Reihenfolge: `--vault <pfad>`-Flag → `BASTRA_VAULT_PATH`-ENV → Auto-Detect aus bestehender Registrierung in `~/.claude.json` oder `claude_desktop_config.json`. Wenn nichts greift, bricht die CLI mit klarer Meldung ab.

Sobald der Brew-Tap live ist, verkürzt sich das zu `bastra install all`.

#### C) Komplett manuell — Fallback

MCP-Server-Block in die Client-Config eintragen (für Claude Code: `~/.claude.json`, für Claude Desktop: `~/Library/Application Support/Claude/claude_desktop_config.json`, für Cursor: `~/.cursor/mcp.json`).

**Empfohlen (Forwarder-Modus — ein Daemon für alle Sitzungen):**

```json
"bastra-recall": {
  "command": "node",
  "args": ["/abs/path/to/bastra-recall/packages/daemon/dist/mcp-forwarder.js"],
  "env": {
    "BASTRA_VAULT_PATH": "/abs/path/to/your/vault/memorys"
  }
}
```

Der Forwarder ist ein dünner stdio-MCP-Wrapper, der mit einem einzigen lokalen HTTP-Daemon spricht (Standard-Port 6723). Alle MCP-Clients — Claude Code, Claude Desktop, Cursor, weitere Sitzungen — teilen sich denselben Vault-State, Embedding-Index und Telemetry-Stream. Der Forwarder spawnt den Daemon beim ersten Start automatisch, falls noch keiner läuft.

**Standalone-Modus (nur ein MCP-Client, kein Sharing):**

```json
"bastra-recall": {
  "command": "node",
  "args": ["/abs/path/to/bastra-recall/packages/daemon/dist/index.js"],
  "env": {
    "BASTRA_VAULT_PATH": "/abs/path/to/your/vault/memorys"
  }
}
```

Für Claude Code zusätzlich Skill + Hooks manuell ablegen:

```bash
bash packages/skill/install.sh        # kopiert SKILL.md → ~/.claude/skills/bastra-recall/
bash packages/skill/install-hook.sh   # registriert PreToolUse + SessionStart-Hooks in ~/.claude/settings.json
```

`bastra install claude-code` aus Pfad B erledigt beides für dich. `install.sh` neu ausführen, wenn sich `SKILL.md` ändert; `install-hook.sh` nur, wenn sich Hook-Binärpfade verschieben. Hooks wieder entfernen: `bash packages/skill/install-hook.sh --uninstall`.

### REST API (für Nicht-MCP-Clients)

Der Daemon exponiert eine REST-API unter `http://127.0.0.1:6723/api/v1/`, die alle Tools des MCP-Servers abdeckt. Das ist der Integrationspunkt für Clients, die kein stdio-MCP sprechen können — allen voran **ChatGPT Custom GPT Actions**, die HTTPS-Endpoints mit OpenAPI-Schema aufrufen.

Endpoints (alle `POST`, JSON-Body):

| Endpoint | Tool |
|---|---|
| `/api/v1/recall` | recall |
| `/api/v1/load_memory` | load_memory |
| `/api/v1/save_memory` | save_memory |
| `/api/v1/find_document` / `read_document` / `open_document` | Document-Suche |
| `/api/v1/save_document` / `recategorize_document` / `move_document` | Document-Schreiben (Pro) |

Auth und CORS:

- Wenn `BASTRA_API_TOKEN` gesetzt ist, verlangt der Daemon `Authorization: Bearer <token>` bei jedem `/api/v1/*`-Aufruf.
- Loopback-Aufrufer (`127.0.0.1`) umgehen die Auth per Default. Mit `BASTRA_AUTH_LOOPBACK_SKIP=0` wird das Token auch lokal verlangt.
- CORS ist per Default permissiv (`Access-Control-Allow-Origin: *`). Einschränken mit `BASTRA_CORS_ORIGIN=https://dein.host`.

Um die API für einen gehosteten Client wie ChatGPT verfügbar zu machen: einen Tunnel (Cloudflare Tunnel / ngrok / eigener Reverse-Proxy) auf `127.0.0.1:6723` legen und im Custom GPT die Tunnel-URL + dein Token konfigurieren. Eine OpenAPI 3.0-Spec ist als Roadmap-Issue gelistet.

### Roadmap

Milestone-basiert, nicht Phasen-basiert. Jedes Gate ist hartes Pass/Fail.

| Milestone | Scope | Status |
|---|---|---|
| **M0** | Recall-Qualität auf echtem Vault evaluieren | ✅ **Fertig** — Recall@1 98.3%, Recall@3 100%, MRR 0.992 über 59 Memories (Own-Trigger-Baseline). BM25 + `recall_when`-Boost reicht; Embeddings zurückgestellt. |
| **M1** | Daemon + Read-Path (`recall`, `load_memory`) | ✅ **Fertig** — MCP-Server live, Watcher funktioniert auf Cloud-Storage-Mounts. |
| **M2** | Save-Path + autonome Save-Trigger | 🟡 **Funktional** — `save_memory` MCP-Tool live mit Force-Reindex. Trigger-Disziplin als Skill ausgeliefert. False-Save- / Missed-Save-Metriken noch nicht erhoben. |
| **M0.5** | Stresstest für Recall (paraphrasiert / cross-memory / anti-halluzination) | ⏳ Offen — siehe Issues. |
| **M3** | Reflex-Layer: Hooks für `SessionStart` / `UserPromptSubmit` / `PreToolUse` / `Stop` | 🟡 **Funktional (PreToolUse + SessionStart, 2 von 4)** — beide produktiv live: `PreToolUse` injiziert `<recall-hints>` vor jedem Write/Edit (2547 Aufrufe in 22 Tagen, 91,5% REQUIRED-Hits), `SessionStart` injiziert `<session-context>` bei jedem neuen Chat. `UserPromptSubmit` und `Stop` warten. |
| **Distribution** | Homebrew-Tap, `bastra`-CLI, `Install Bastra.command`, npm-Package | 🟡 **Funktional** — `bastra`-CLI mit Adaptern für jedes Surface; Homebrew-Tap [n0mad-ai/homebrew-tap](https://github.com/n0mad-ai/homebrew-tap) mit Head-only-Formula veröffentlicht; `distribution/Install Bastra.command` als Doppelklick-Wrapper. Offen: End-to-End-Brew-Test, npm publish, GitHub-Release mit der `.command`-Datei als Asset (#3). |
| **Multi-Surface** | Ein Install pro AI-Client (MCP + Skill + Hooks wo zutreffend) + REST-Gateway für Nicht-MCP-Clients | 🟡 **Funktional** — `bastra install` deckt Claude Code (MCP + Skill + Hooks), Claude Desktop (MCP + Skill), Cursor (MCP) ab. REST `/api/v1/*` ermöglicht ChatGPT Custom GPT Actions via HTTPS + Tunnel. Offen: OpenAPI 3.0-Spec, Claude.ai Web Custom Connector Registrierung (#7). |

Außerhalb von v0: **Codebase-Indexing**, **Multi-Device-Sync**. Siehe [PLAN.md](./PLAN.md).

Multi-Device funktioniert heute über OS-Level-Sync des Vault-Ordners (iCloud / Google Drive / Dropbox / Git) — der Polling-Modus des File-Watchers gleicht die Latenz aus. Ein Browser-basiertes UI ist nicht geplant — Obsidian liefert bereits einen sehr guten Markdown-Editor für den Vault.

### Bastra Mac App

Eine native macOS-App entsteht auf Basis von bastra-recall — selber Vault, selber Daemon, nur mit grafischer Oberfläche für Leute, die nicht im Terminal leben wollen. In Entwicklung; eine eigene Seite mit Screenshots und Updates folgt.

### Lizenz

MIT — siehe [LICENSE](./LICENSE).

Public Docs und Code auf diesem Branch laufen unter der Open License; private Notizen (in `private/`, gitignored) nicht.

### Status & Kontakt

Pre-Alpha. Siehe [PLAN.md](./PLAN.md). Issues und Diskussionen willkommen — frühes Feedback formt das Design.

Gebaut von [@n0mad-ai](https://github.com/n0mad-ai).
