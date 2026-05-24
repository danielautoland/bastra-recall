---
name: bastra-recall
description: Persistent teammate-memory for Claude across sessions. USE PROACTIVELY whenever the user (a) expresses repetition or frustration about a recurring issue ("wieder", "schon wieder", "wie oft", emphatic caps), (b) states an explicit durable rule ("immer X", "nie Y", "bei diesem Projekt …"), (c) corrects a recurring tendency in your behavior, (d) finalizes an architectural decision after weighing options, or (e) confirms a workflow ("lass uns das immer so machen"). Also USE before writing/editing code, before giving multi-step plans, and at session start — to recall stored lessons, preferences, and project facts via the bastra-recall MCP server.
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
| **Before a multi-step plan or recommendation** | `"giving plan/recommendation for <topic>"` — surfaces format preferences |
| **User prompt touches a stored topic** | the prompt itself, optionally with project context |
| **Before `save_memory`** | the title/topic — duplicate check |

What to do with hits (interpret the score):

- **Score ≥ ~100 with `recall_when` or title match** → call `load_memory(id)` and apply the lesson **before** writing code or responding. Never ignore a `lesson` hit at this band.
- **Score 30–100** → read the summary; load only if directly relevant.
- **Score < 30** → usually noise; skip unless the summary is a perfect topic match.

Idempotent: don't reload a memory you've already loaded this turn.

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

## Tone with the user

- If you load a memory and apply it, you don't need to mention it unless asked. Just behave correctly. Silence is the best compliment to a working memory.
- Never ask permission for a strong-signal save — that defeats the purpose.
- Never narrate "I'm going to call recall now" — just call it.
