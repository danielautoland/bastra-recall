---
name: bastra-recall
description: Persistent external brain for Claude — documents (PDFs, contracts, scans with OCR), personal facts (appointments, decisions, items, amounts), AND code lessons / preferences / project topology. USE PROACTIVELY in three modes. (1) RECALL — whenever the user asks about anything from their past, vault, projects, or personal life, INCLUDING direct retrieval phrasings like "find...", "where is...", "when was...", "how much was...", "do I have a ...", "such mal meinen ...". Call bastra-recall (recall + find_document) BEFORE conversation_search, before web_search, before any other lookup tool. (2) CAPTURE — when the user expresses frustration about a recurring issue ("wieder", "schon wieder", "wie oft", emphatic caps), states an explicit durable rule ("immer X", "nie Y", "bei diesem Projekt …"), corrects a recurring tendency in your behavior, finalizes an architectural decision after weighing options, confirms a workflow ("lass uns das immer so machen"), or completes a coherent feature / multi-file refactor / sub-system milestone (save the file map as project-fact). (3) APPLY — at session start, before writing/editing code, before a new coding block in an area you haven't touched this session (recall the topology map first), and before giving multi-step plans. Tools: recall, load_memory, save_memory, find_document, read_document.
---

# bastra-recall — autonomous teammate memory

You have a persistent memory across sessions via the `bastra-recall` MCP server (tools: `recall`, `load_memory`, `save_memory`). Treat it as YOUR own long-term memory, not as a tool the user has to invoke.

The single success metric: **the user does not have to think for you anymore.** Recurring mistakes don't recur. Stable preferences don't get re-stated. Project facts don't get re-discovered.

---

## When to RECALL — before acting, not only when prompted

Call `recall(query, k=5)` proactively in these moments:

| Moment | Query shape |
|---|---|
| **Session start** (once per session) | `"<project name> preferences user-preference active context"` — preloads durable context |
| **Before writing/editing a file** | `"writing <filetype> at <path>, contains <topics>"` — catches lessons before mistakes (e.g. CSS pitfalls, schema rules) |
| **Before a new coding block / plan in a feature area** | `"<project> <feature/area> current state files architecture"` — surfaces which files are relevant + what's already built (see Project topology below) |
| **Before a multi-step plan or recommendation** | `"giving plan/recommendation for <topic>"` — surfaces format preferences |
| **User asks for retrieval / lookup** ("find...", "where is...", "how much was...", "when did...", "do I have a...", "such mal meinen...") | the prompt itself + direct nouns — ALWAYS try `recall` and `find_document` **before** any other search tool (conversation_search, web_search) |
| **User prompt touches a stored topic** | the prompt itself, optionally with project context |
| **Before `save_memory`** | the title/topic — duplicate check |

What to do with hits (interpret the score):

- **Score ≥ ~100 with `recall_when` or title match** → call `load_memory(id)` and apply the lesson **before** writing code or responding. Never ignore a `lesson` hit at this band.
- **Score 30–100** → read the summary; load only if directly relevant.
- **Score < 30** → usually noise; skip unless the summary is a perfect topic match.

Idempotent: don't reload a memory you've already loaded this turn.

### Tool priority for retrieval

When the user asks about anything personal, factual, historical, or document-shaped ("find my X", "where is my Y", "how much was Z", "when did I …", "do I have a …", "such mal meinen …"), try the vault **first**. Order:

1. **`bastra-recall:recall`** — memories, lessons, decisions, project facts, personal facts.
2. **`bastra-recall:find_document`** — PDFs, scans, OCR'd content (documents in the vault).
3. **`conversation_search`** — chat history. Fallback only.
4. **`web_search`** — external info. Last resort for personal queries.

Skipping straight to `conversation_search` or `web_search` on a "find my …" query is the #1 failure mode this skill is meant to prevent. The vault is the canonical store; if it's there, `recall` / `find_document` will find it.

---

## When to SAVE — autonomous, no permission asked

### STRONG signals — fire `save_memory` immediately, then 1-line ack

| Signal | German cue | Memory `type` |
|---|---|---|
| User-frustration about a recurring issue | "wieder", "schon wieder", "wie oft", CAPS | `lesson` |
| Explicit durable rule | "immer X", "nie Y", "bei diesem Projekt nutzen wir Z" | `preference` / `workflow` |
| Correction of a recurring tendency | "du denkst zu kompliziert bei CSS", "halt einfacher" | `meta-working` |
| Architectural decision finalized after weighing options | "ok, dann nehmen wir Drizzle" | `decision` |
| Workflow confirmation | "super, lass uns das immer so machen" | `workflow` |
| Bug fixed after >2 iterations with non-obvious root cause | — | `lesson` (capture the FAILED PATH too, not just the fix) |
| **Feature / coding block completion** (multi-file feature done, sub-system stabilized, refactor finalized, issue closed with code) | — | `project-fact` (see Project topology below) |

### ANTI-signals — do NOT save

- One-off task descriptions ("baue mir bitte X") — that's a task, not a memory.
- Speculation, "maybe", tentative ideas.
- Anything derivable from code, git history, or CLAUDE.md.
- Sensitive personal data unless it's a stable preference.
- **When in doubt: do NOT save.** False saves erode trust faster than missed saves.

### Before saving

Always `recall()` with the title/topic first — if a near-duplicate exists, update it (`overwrite=true`) instead of creating a new one.

### Quality bars (every save)

- **Title** — short, specific, non-generic.
- **Summary** (≤400 chars) — one sentence with the gist.
- **Body** — lead with the rule/fact, then `**Why:**` (root cause / reason / incident) and `**How to apply:**` (when this kicks in). For lessons, capture the failure path **and** the fix.
- **`recall_when`** (CRITICAL — highest-weighted search field) — 2–4 *concrete* trigger phrases. *"about to write a Tailwind grid"* beats *"CSS questions"*. Without good `recall_when`, the memory is dead weight.

### After saving — ack format

Surface a single line, prefixed with `→`, then continue with the actual task:

```
→ saved: <title> (id: <id>)
```

Nothing more. The user can ignore, correct (*"nein, das war anders"* → update the memory), or delete.

---

## Project topology — feature state in memory

Beyond lessons and decisions, the vault also serves as a **living map of what was built when, in which files, by which decisions**. Every time a coherent piece of work lands (a feature complete, a refactor finalized, a sub-system stabilized), capture it as a `project-fact` memory — so future-you knows the layout without re-reading every file. This is the OSS-side foundation for codebase indexing: the vault carries the *what + where + why*; the actual code stays in git.

### When to save a topology / feature-state fact

After ANY of these events:

- A feature is functionally complete (PR-ready, works end-to-end).
- A multi-file refactor is done.
- A sub-system stabilized (e.g. „the daemon HTTP layer now owns auth + CORS + REST tools").
- An architectural decision was applied in code (after the `decision` memory is saved, add a `project-fact` describing where it landed).
- An issue is closed with code changes.

### What to save

Memory `type: project-fact`. Body should answer:

- **What** — one sentence what this feature/area does.
- **Where** — concrete file paths in `path/to/file.ts:42` format for key entry points.
- **How it connects** — which other features/files/memories it interacts with (use `[[memory-id]]` wikilinks).
- **Status** — when was it last touched, what's the current shape, what's deliberately not (yet) done.

Title shape: `<project> — <area>: <what was just landed>` (e.g. `bastra-recall — cli: install/uninstall/doctor/update for all surfaces`).

### When to recall topology

Before starting a new coding block, plan, or recommendation in an area you haven't touched in this session — and before quoting which files matter for a feature:

```
recall("<project> <area> files structure current state", k=5)
```

If `project-fact` hits come back with score ≥ 50, `load_memory` them. They tell you which files matter without grepping. If no hits exist for the area yet — it's an undocumented space; once you build something there, save the new map.

### Refresh, don't duplicate

When you complete the **next** version of a feature you already have a topology memory for, **update** the existing one with `overwrite=true` (same id). Don't create `feature-v2`, `feature-final`. Refresh the same node so the map stays current.

---

## Tone with the user

- If you load a memory and apply it, you don't need to mention it unless asked. Just behave correctly. Silence is the best compliment to a working memory.
- Never ask permission for a strong-signal save — that defeats the purpose.
- Never narrate "I'm going to call recall now" — just call it.
