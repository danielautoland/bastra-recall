# Memory Schema

This schema defines one stored memory or document sidecar. Files are plain markdown with YAML frontmatter so they remain editable in Obsidian and by hand.

The schema supports:

1. autonomous saves when a durable lesson, preference, workflow, decision, or project fact is learned;
2. pre-action recall through `recall_when`;
3. cross-project reuse through scope, tags, topics, wikilinks, and `related_via`;
4. document and bookmark retrieval through the same vault/search layer;
5. local privacy controls through `sensitivity`.

## Storage Layout

The configured vault root comes from `BASTRA_VAULT_PATH` (legacy `NEXUS_VAULT_PATH` is accepted).

The vault scanner walks recursively and loads any `.md` file whose frontmatter has a recognized `type`. Ordinary Obsidian notes can live next to memories and are ignored.

Current write routing:

| Kind | Folder |
|---|---|
| user preferences | `memories/user/` |
| all-project memories | `memories/all-projects/` |
| project-scoped memories | `memories/projects/<scope>/` |
| bookmarks | `bookmarks/` |
| document sidecars | `dokumentationen/<scope>/` |

Legacy flat vaults still load because scanning is recursive and does not require files to be under those folders.

The active text index is in-memory MiniSearch/BM25. Optional embeddings are stored at `<vault>/.bastra/embeddings.json`. Audit logs and trash are stored under `<vault>/.bastra/`.

## Minimal Frontmatter

All normal memories and document sidecars share these required fields:

```yaml
---
id: css-input-focus-ring-stacking
title: "Don't stack focus styles on inputs"
type: lesson
summary: "Stacking ring + outline + custom :focus on nested inputs causes double focus rings. Use a single :focus-visible style."
topic_path: [css, input, focus]
tags: [css, input, focus-ring, ui-bug]
scope: all-projects
recall_when:
  - creating new input component
  - writing input or form css
  - focus or accessibility styling
related: [css-effects-stacking-antipattern]
related_via: []
sensitivity: team
source: "carnexus, recurring lesson"
confidence: 0.95
created: 2026-04-15
updated: 2026-05-01
---
```

The markdown body follows the frontmatter. For lessons, lead with the rule, then explain why it matters and how to apply it.

## Core Fields

| Field | Required | Meaning |
|---|---:|---|
| `id` | yes | Stable slug. Usually filename without `.md`. |
| `title` | yes | Human-readable title shown in recall hits. |
| `type` | yes | Memory/document kind. See type table below. |
| `summary` | yes | One dense sentence, max 400 characters. |
| `topic_path` | yes | Hierarchical topic path, e.g. `[bastra-recall, search, ranking]`. |
| `tags` | yes | Flat retrieval tags. At least one. |
| `scope` | yes | Applicability boundary, e.g. `all-projects`, `user-preference`, or a project name. |
| `recall_when` | yes | Concrete future contexts where this memory should surface. |
| `related` | no | Manual related memory ids. Body wikilinks are mirrored here by the save path. |
| `related_via` | no | Automatic related edges from embedding similarity. Defaults to `[]`. |
| `sensitivity` | no | `private`, `team`, or `public`. Defaults to `team`. |
| `source` | no | Provenance or reason this memory exists. |
| `confidence` | no | Number from `0` to `1`. Defaults to `1.0`. |
| `created` | yes | ISO date. Auto-set by save paths. |
| `updated` | yes | ISO date. Auto-set by save/update paths. |

## Types

Recognized `type` values:

| Type | Meaning |
|---|---|
| `lesson` | Anti-pattern or correction learned from failure |
| `preference` | Stable project-scoped or working preference |
| `project-fact` | Stable fact about a project or feature area |
| `meta-working` | Durable fact about how the assistant should work |
| `decision` | Committed design/product/architecture decision |
| `workflow` | Repeatable process or checklist |
| `reference` | Pointer to an external or internal resource |
| `user-preference` | Cross-project user preference |
| `bookmark` | Saved URL with bookmark metadata |
| `doc` | Document sidecar for file/document retrieval |

## Recall Fields

`recall_when` is the most important retrieval field. It is boosted above title, tags, topic path, summary, and body in the MiniSearch index. If embeddings are enabled, the same authored text also contributes to semantic recall because it is included in the embedding text.

Good values describe future actions:

```yaml
recall_when:
  - creating new input component
  - writing input or form css
  - focus or accessibility styling
```

Weak values are generic:

```yaml
recall_when:
  - css
  - frontend
```

The current matching stack is BM25 with prefix/fuzzy search, optionally fused with vector search through Reciprocal Rank Fusion. It is not SQLite/FTS5.

## Relationships

`related` is a manual list of memory ids. The save path also extracts `[[memory-id]]` wikilinks from the body and mirrors them into `related`, excluding links in the auto-related section.

`related_via` is maintained by the optional `RelatedEnricher`:

```yaml
related_via:
  - id: css-effects-stacking-antipattern
    reason: "cosine 0.812"
    score: 0.812
```

When recall is called with `expand_hops: 1`, one-hop `related_via` neighbors can be added to the result set with a reduced score.

The auto-related body section is managed between marker comments:

```markdown
## Auto-Related <!-- bastra:auto-related:start -->

- [[css-effects-stacking-antipattern]] (cosine 0.81)

<!-- bastra:auto-related:end -->
```

Do not manually edit inside that section.

## Lifecycle And Ranking Fields

These optional fields affect staleness and recall ranking:

| Field | Meaning |
|---|---|
| `valid_until` | Explicit ISO date after which the memory expires |
| `expires_after_days` | Override for type-based expiration defaults |
| `last_reviewed_at` | ISO date of the last manual review |
| `stale_status` | Optional persisted status: `fresh`, `aging`, `stale`, `expired` |
| `obsolete` | If true, the memory is filtered out of normal recall |
| `replaces` | Memory id this one replaces |
| `superseded_by` | Newer memory that supersedes this one |

Staleness is computed lazily during recall. Stale and expired memories are downranked; obsolete memories are removed from normal search results.

## Privacy Field

`sensitivity` controls which callers can see a memory:

| Value | Meaning |
|---|---|
| `private` | Hidden from external MCP/REST callers unless `allow_private: true` |
| `team` | Default; visible to local AI tools |
| `public` | Safe for broader cross-surface exposure |

Both recall and direct load paths enforce this filter.

## Augmentation Fields

General optional fields:

| Field | Meaning |
|---|---|
| `affects_files` | Repo paths this memory applies to |
| `status` | Free-form state such as `stable`, `in-progress`, `planned`, `open` |
| `issues` | Related issue ids such as `#42` |

Bookmark-only fields:

| Field | Meaning |
|---|---|
| `url` | Saved URL |
| `categories` | Bookmark categories |
| `read_status` | `unread`, `read`, or `archived` |
| `og_image` | Open Graph image URL |
| `saved_at` | ISO timestamp |
| `source_app` | App/source that saved the bookmark |

Document-only fields:

| Field | Meaning |
|---|---|
| `original_path` | Original file path for the document |
| `linked_file` | If true, original remains outside the vault |
| `document_category` | `vertrag`, `rechnung`, `notiz`, `code`, `bild`, or `sonstiges` |
| `folder_path` | Folder path used by document tools |
| `needs_review` | Auto-inbox review flag |
| `ai_suggested_folder` | Suggested target folder for review UI |
| `content_hash` | SHA-256 content hash for duplicate detection |
| `content_size` | Original file size in bytes |
| `location` | Optional geo metadata: `{ lat, lon, place?, source? }` |

## Body

Recommended body for lessons:

```markdown
## Rule
State the rule or fix directly.

## Why
Explain the failure path and root cause.

## How to apply
Name the future situation where this should change behavior.

## See also
[[other-memory-id]]
```

Document sidecars usually store a short pointer to the original file plus extracted text:

```markdown
> Sidecar for `/path/to/original.pdf`.

## Extracted content

...
```

## Examples

### Lesson

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
related: []
related_via: []
sensitivity: team
source: "recurring UI bug"
confidence: 0.95
created: 2026-04-15
updated: 2026-05-01
---
```

### User Preference

```yaml
---
id: pref-plan-format-recommendation-not-options
title: "Prefer recommendations over option menus"
type: user-preference
summary: "When proposing a plan, give one recommendation, the main tradeoff, and at most one follow-up question."
topic_path: [user, communication, planning]
tags: [communication, plans, decisions]
scope: user-preference
recall_when:
  - proposing a plan
  - presenting options
  - architectural decision request
related: []
related_via: []
sensitivity: team
confidence: 1
created: 2026-05-01
updated: 2026-05-01
---
```

### Bookmark

```yaml
---
id: mcp-spec-bookmark
title: "Model Context Protocol specification"
type: bookmark
summary: "Reference bookmark for the MCP specification."
topic_path: [references, mcp]
tags: [mcp, protocol, reference]
scope: all-projects
recall_when:
  - checking MCP protocol details
related: []
related_via: []
sensitivity: public
url: "https://modelcontextprotocol.io/"
categories: [ai, protocol]
read_status: unread
saved_at: 2026-05-01T12:00:00.000Z
confidence: 1
created: 2026-05-01
updated: 2026-05-01
---
```

### Document Sidecar

```yaml
---
id: doc-contract-2026
title: "Contract 2026"
type: doc
summary: "vertrag: Contract 2026"
topic_path: [documents, contracts]
tags: [contract, 2026]
scope: documents
recall_when:
  - find document Contract 2026
  - contract 2026
related: []
related_via: []
sensitivity: team
original_path: "/Users/example/Documents/Contract 2026.pdf"
linked_file: false
document_category: vertrag
folder_path: contracts
confidence: 1
created: 2026-05-01
updated: 2026-05-01
---
```

## Validation Rules

The current Zod schema rejects files that have a recognized memory `type` but invalid frontmatter. Required validations include:

- non-empty `id`, `title`, `summary`, `scope`;
- `summary` length at most 400 characters;
- recognized `type`;
- non-empty `topic_path`, `tags`, and `recall_when`;
- `confidence` between `0` and `1`;
- valid enum values for `sensitivity`, `read_status`, and location source when present;
- positive integer lifecycle overrides where required.

Files without a recognized `type` are treated as ordinary notes and skipped, not as schema failures.

The save path rejects duplicate ids at the destination path unless `overwrite: true` is passed. It does not require `scope` to come from a registry.
