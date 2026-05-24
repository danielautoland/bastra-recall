# Memory Schema

This schema defines how a single memory is stored. It must support four concrete jobs:

1. **Autonomous save** — Claude writes a memory without being asked, in the moment a lesson is learned.
2. **Pre-action recall** — Claude queries memorys *before* acting (e.g. before creating a new component), not only in response to user prompts.
3. **Cross-project graph traversal** — a CSS lesson from project A surfaces in project B when relevant.
4. **Obsidian compatibility** — plain markdown, YAML frontmatter, `[[wikilinks]]` so the same files browse cleanly in Obsidian.

## Storage layout

- Vault root: `~/nexus-vault/`
- Files: flat directory, one `.md` per memory. No nested folders — `topic_path` does the structuring.
- Filename = `id` + `.md`, slug-style (lowercase-kebab-case).
- Index: `~/.bastra/index.db` (SQLite, mirrors vault content).

Flat layout is deliberate. Folders force rigid hierarchy; the schema's `topic_path` and `tags` give a richer, multi-axis structure that Obsidian's graph view and tag pane already expose.

## Frontmatter

All fields below are required unless marked *optional*.

```yaml
---
id: css-input-focus-ring-stacking
title: "Don't stack focus styles on inputs"
type: lesson
summary: "Stacking ring + outline + custom :focus on nested inputs causes double focus rings. Use a single :focus-visible utility, no extra ring/outline."
topic_path: [css, input, focus]
tags: [css, input, focus-ring, ui-bug, antipattern]
scope: all-projects
recall_when:
  - creating new input component
  - writing input or form css
  - focus or accessibility styling
related: [css-effects-stacking-antipattern]
source: "carnexus, 2026-04-15 — Daniel flagged double rings for the 3rd time"
confidence: 0.95
created: 2026-04-15
updated: 2026-05-01
---
```

### Field semantics

#### `id` (string, required)
Slug, lowercase-kebab-case. Matches filename without `.md`. Stable — never rename without a `replaces` link from the new memory.

#### `title` (string, required)
Human-readable headline, 5-12 words. Shown in Stage-1 recall hint.

#### `type` (enum, required)
| value | meaning | example |
|---|---|---|
| `lesson` | Anti-pattern or correction learned from failure | "Don't stack focus styles" |
| `preference` | User's stable preference for how I work | "No 5-option plans, give recommendation + 1 question" |
| `project-fact` | Stable fact about a specific project | "carnexus uses Drizzle ORM" |
| `meta-working` | Fact about working with Claude itself | "Output quality drops with codebase size — split sessions" |
| `decision` | Architectural choice, with rationale | "Chose SQLite+FTS5 over Neo4j because…" |
| `workflow` | Process step to always follow | "Run `npm run check` before commit" |
| `reference` | Pointer to external resource (URL, dashboard, doc) | "Carnexus prod logs at …" |

Type drives default ranking weights and recall triggers (e.g., `preference` memorys get pulled on every session start, `lesson` only on contextual matches).

#### `summary` (string, required, ≤200 chars)
One dense line. This is what Claude sees in the Stage-1 recall hint — make every word count.

✅ `"Stacking ring + outline + custom :focus on nested inputs causes double focus rings. Use single :focus-visible, nothing extra."`

❌ `"Notes about input focus styling in carnexus."`

#### `topic_path` (array of strings, required)
Hierarchical, semantic. Reads as a path from broad to specific. Drives graph traversal — memorys sharing a prefix are weighted higher in recall.

Examples:
- `[css, input, focus]`
- `[claude-meta, communication, planning]`
- `[carnexus, schema, migration]`

Aim for 2-4 levels.

#### `tags` (array of strings, required, ≥1)
Flat, lowercase-kebab-case keywords. Used by FTS5 for keyword search. 3-7 tags. Avoid generic tags like `code`, `bug`, `note`.

#### `scope` (enum, required)
Where this memory applies:

- `all-projects` — universal (most lessons, preferences, claude-meta)
- `<project-name>` — limited to one project (e.g., `carnexus`)
- `user-preference` — about the user (overrides project context)
- `claude-meta` — about Claude as a tool (hits regardless of project)

The recall logic uses `scope` to decide whether a hit from project A is relevant to a query in project B.

#### `recall_when` (array of strings, required, ≥1)
**The "buildin"-feel field.** Free-form natural-language patterns that describe contexts where this memory should be surfaced. The recall hook compares the current action context against these patterns (FTS5 matches, later embedding similarity).

Examples for a CSS-input-focus lesson:
- `creating new input component`
- `writing input or form css`
- `focus or accessibility styling`

Examples for a "no 5-option plans" preference:
- `presenting options to user`
- `proposing a plan`
- `before responding with multiple alternatives`

Without this field, Claude only recalls when the user prompt matches. With this field, Claude can recall before its *own* actions (PreToolUse hooks).

#### `related` (array of memory ids, optional)
Other memory ids this connects to. Graph edges. Used for "follow related" expansion during recall.

#### `source` (string, optional)
Provenance. Where/when this lesson was learned. Helps later sanity-checking: was this a one-off or a recurring pattern?

#### `confidence` (float 0–1, optional, default 1.0)
How sure are we this is a real, stable pattern? Lower for early-observation memorys; higher after re-confirmation. Decays slowly over time without re-confirmation.

#### `created`, `updated` (ISO date, required)
Auto-set by the save tool.

#### Optional evolution fields
- `obsolete: true` — pattern no longer applies
- `replaces: <id>` — supersedes another memory
- `superseded_by: <id>` — soft-replaced by a newer memory

#### Optional augmentation fields (added during migration, 2026-05-01)

These were introduced when migrating Daniel's existing carnexus memorys and proved useful enough to keep in the schema.

##### `affects_files` (array of strings, optional)
Concrete file paths this memory references. Used by the `PreToolUse` Write/Edit hook: when Claude is about to touch one of these files, this memory's relevance is boosted.

```yaml
affects_files:
  - frontend/src/components/shared/SwapCardToggle.js
  - frontend/src/styles/styleguide.css
```

##### `status` (string, optional)
For project-fact / decision memorys with state. Free-form short token, but conventional values:

| value | meaning |
|---|---|
| `stable` | well-established, unlikely to change |
| `in-progress` | actively being built |
| `partial` | partially implemented, some pieces still open |
| `planned` | spec exists, no implementation yet |
| `open` | known issue, not yet addressed |
| `removed-but-reversible` | feature was removed but the code path is preserved |

##### `issues` (array of strings, optional)
GitHub issue numbers this memory tracks (e.g., `["#262", "#159"]`). Useful for cross-referencing during planning.

The schema will continue to grow ad-hoc when real usage uncovers gaps. New fields should be added here in this doc with their semantics, not silently introduced into individual memorys.

## Body

Full markdown. Recommended structure:

```markdown
## Context
What was the situation, what triggered this lesson.

## What went wrong (or: what does the user want)
Concrete failure path, or concrete preference statement.

## The fix / rule
The actual lesson, code-level if relevant.

## Why
Root cause. Without this, the lesson is fragile — Claude reapplies the wrong fix to the next variant.

## See also
[[other-memory-id]] for related patterns.
```

Use `[[wikilinks]]` for cross-references — Obsidian renders them as graph edges automatically, AND the indexer parses them as additional `related` entries.

## Six example memorys

### 1. Lesson — CSS focus ring stacking

```yaml
---
id: css-input-focus-ring-stacking
title: "Don't stack focus styles on inputs"
type: lesson
summary: "Stacking ring + outline + custom :focus on nested inputs causes double focus rings. Use single :focus-visible, no extra ring/outline."
topic_path: [css, input, focus]
tags: [css, input, focus-ring, ui-bug, antipattern]
scope: all-projects
recall_when:
  - creating new input component
  - writing input or form css
  - focus or accessibility styling
  - tailwind ring utility on form elements
related: [css-effects-stacking-antipattern]
source: "carnexus, recurring — flagged 3+ times"
confidence: 0.95
created: 2026-04-15
updated: 2026-05-01
---
```

Body explains the bug, the fix, and the root cause (Tailwind's `ring` + an explicit `outline` + a wrapping component's own focus style all activate at once).

### 2. Preference — no 5-option plans

```yaml
---
id: pref-plan-format-recommendation-not-options
title: "Daniel wants recommendations, not 5-option menus"
type: preference
summary: "When proposing a plan, give 1 recommendation + the main tradeoff + 1 follow-up question. Not a 5-option list — that pushes the decision back."
topic_path: [claude-meta, communication, planning]
tags: [communication, plans, decisions, format]
scope: user-preference
recall_when:
  - proposing a plan
  - presenting options
  - before responding with multiple alternatives
  - architectural decision request
related: []
source: "stated explicitly 2026-05-01"
confidence: 1.0
created: 2026-05-01
updated: 2026-05-01
---
```

### 3. Project-fact — carnexus scale

```yaml
---
id: carnexus-large-codebase-multi-session
title: "Carnexus is large — single-session work often won't fit"
type: project-fact
summary: "Carnexus has many interconnected features. Plan multi-session work for any non-trivial feature; persist context between sessions via memorys."
topic_path: [carnexus, project-shape]
tags: [carnexus, codebase-size, sessions, context-management]
scope: carnexus
recall_when:
  - starting work on carnexus
  - planning a carnexus feature
  - estimating effort on carnexus
related: [meta-output-quality-vs-codebase-size]
source: "stated 2026-05-01"
confidence: 1.0
created: 2026-05-01
updated: 2026-05-01
---
```

### 4. Meta-working — output quality vs codebase size

```yaml
---
id: meta-output-quality-vs-codebase-size
title: "My output quality drops as codebase grows"
type: meta-working
summary: "On large codebases, even within context limits, my answers degrade. Mitigate by working in smaller scope per session and saving findings to memory."
topic_path: [claude-meta, performance, codebase-scale]
tags: [self-knowledge, context, quality, sessions]
scope: claude-meta
recall_when:
  - working in a large codebase
  - context approaching limits
  - long debugging session
  - quality of recent answers feels off
related: [carnexus-large-codebase-multi-session]
source: "Daniel observation 2026-05-01"
confidence: 0.85
created: 2026-05-01
updated: 2026-05-01
---
```

### 5. Decision — placeholder

```yaml
---
id: bastra-recall-storage-sqlite-fts5
title: "bastra-recall storage: SQLite + FTS5, embeddings later"
type: decision
summary: "Chose SQLite (graph) + FTS5 (keyword) for v0. Embeddings (bge-m3 local) deferred to v0.5 — only added if FTS5 misses too often."
topic_path: [bastra-recall, architecture, storage]
tags: [sqlite, fts5, embeddings, architecture]
scope: bastra-recall
recall_when:
  - storage choice question on bastra-recall
  - retrieval quality discussion
  - considering embeddings
related: []
source: "design discussion 2026-05-01"
confidence: 0.9
created: 2026-05-01
updated: 2026-05-01
---
```

### 6. Workflow — placeholder

```yaml
---
id: carnexus-pre-commit-npm-check
title: "Run `npm run check` before every commit on carnexus"
type: workflow
summary: "Carnexus's `npm run check` runs typecheck + lint + tests. Skip = broken main."
topic_path: [carnexus, workflow, commit]
tags: [carnexus, npm, ci, pre-commit]
scope: carnexus
recall_when:
  - about to commit on carnexus
  - finishing a carnexus task
  - before git commit on carnexus
related: []
source: "(placeholder — confirm with Daniel)"
confidence: 0.6
created: 2026-05-01
updated: 2026-05-01
---
```

## Validation rules

The save tool rejects any memory that:
- Lacks any required field
- Has empty `tags`, `topic_path`, or `recall_when`
- Has `summary` longer than 200 characters
- Has invalid `type` value
- Has invalid `scope` (must match enum or known project name)
- Has duplicate `id` in the vault
- References non-existent ids in `related`

A `bastra-recall lint` command runs these checks against the whole vault.

## Open questions for v0

1. **Project name registry.** Is `scope: carnexus` free-form, or registered? Free-form is easier; registered prevents typos. Likely: free-form, with a warning on first use of a new project name.
2. **`recall_when` matching.** v0: FTS5 substring match. v0.5: semantic (embeddings). Acceptable for v0?
3. **Auto-tagging on save.** Should the save tool suggest tags based on content, or require Claude to specify them every time? Likely: Claude proposes, save tool accepts as-is. Tag-discipline is on Claude.
