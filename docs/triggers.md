# Triggers — when to save, when to recall

Schema and storage are the foundation. The product is the **trigger logic**: when Claude saves without being asked, and when Claude recalls before acting.

If triggers fire reliably, the system feels built-in. If they don't, the system is just a folder.

---

## Save triggers — autonomous memorization

The goal: Daniel never has to say *"merk dir das"*. Claude detects memory-worthy moments and saves.

### Signals that a moment is memory-worthy

#### Strong signals (high precision)

| Signal | Example | Memory type |
|---|---|---|
| User expresses repetition or frustration about a recurring issue | *"WIEDER doppelte Focus-Ringe"*, *"das hatten wir schon"*, *"wie oft denn noch"* | `lesson` |
| User states an explicit, durable rule | *"immer X machen"*, *"nie Y"*, *"bei diesem Projekt nutzen wir Z"* | `preference` / `workflow` |
| User corrects a recurring tendency | *"du denkst zu kompliziert bei CSS"*, *"halt einfacher"* | `meta-working` |
| Architectural decision is finalized after weighing options | *"ok, dann nehmen wir Drizzle"* | `decision` |
| User confirms a workflow step works | *"super, lass uns das immer so machen"* | `workflow` |

These should fire `save_memory` **without further confirmation** — the user gets a 1-line ack only.

#### Weak signals (lower precision — propose, don't auto-save)

| Signal | Action |
|---|---|
| A bug got fixed after >2 iterations | Propose: *"→ ich würde das als Lesson speichern: …. Ok?"* |
| Discovery of a project-specific quirk | Propose, ask once |
| User tone is neutral but the context looks lesson-like | Default to skipping; over-saving is worse than under-saving for noise |

#### Anti-signals (do NOT save)

- One-off task descriptions (*"baue mir bitte X"*) — that's a task, not a memory
- Speculation or "maybe" statements
- Anything Daniel asks me to forget
- Sensitive personal data unless it's a stable preference

### What to capture in a save

Don't save just *the solution*. Save the **path** — what failed, why, what worked, why. This is what makes the memory useful next time.

Required:
- **What was the trigger** (frustration / rule / decision / iteration)
- **What was wrong** or **what is the rule**
- **What is the fix** or **what is the preference**
- **Why** — root cause if a lesson, rationale if a decision

Recall_when patterns are critical — the save is only as useful as the contexts under which it'll be re-surfaced. If I save a CSS lesson without `recall_when: ["creating new input"]`, I'll never recall it when I'm creating a new input.

### Save flow (autonomous)

```
1. Detect strong signal in current turn
2. Compose memory:
   - title, summary, type, topic_path, tags, scope, recall_when
   - body explaining context + fix + why
3. Call save_memory(payload, trigger="autonomous-frustration")
4. Surface 1-line ack to user:
     "→ saved: Don't stack focus styles on inputs (id: css-input-focus-ring-stacking)"
5. Continue with the actual task
```

The ack is short, single-line, prefixed with `→` so it's visually distinct. Daniel can ignore, correct (*"nein, das war anders"* → I update the memory), or delete.

### CLAUDE.md instruction — the save side

This is what conditions me to do the above. To be added to user-level `CLAUDE.md`:

```markdown
## bastra-recall — autonomous memory

You have a persistent memory via the `bastra-recall` MCP server. Treat it as your
own long-term memory, not a tool to be used on request.

**Save autonomously** when any of the following happens in a turn:

1. User expresses frustration about a recurring issue ("wieder", "schon wieder",
   emphatic caps, "wie oft"). Save a `lesson`. Trigger:
   `autonomous-frustration`.
2. User states an explicit, durable rule ("immer X", "nie Y", "bei diesem
   Projekt …"). Save a `preference` or `workflow`. Trigger: `autonomous-rule`.
3. We arrive at a working solution after multiple failed attempts. Save a
   `lesson` capturing the failure path AND the fix. Trigger:
   `autonomous-resolution`.
4. An architectural decision is finalized after discussion. Save a `decision`
   with the rationale. Trigger: `autonomous-decision`.

When saving:
- Always populate `recall_when` with 2-4 concrete contexts where future-you
  should be reminded. Without this the memory is dead weight.
- Surface a single-line ack: `→ saved: <title> (id: <id>)`. Nothing more.
- If unsure whether to save, default to NOT saving. False saves erode trust.
- Never ask permission for strong-signal saves — that defeats the purpose.
```

---

## Recall triggers — pre-action retrieval

The other half of "buildin"-feel: I query memory **before** I act, not only when prompted.

### Hook timing

| Hook | Fires on | What it queries | Why |
|---|---|---|---|
| `SessionStart` | New session in any surface | Preferences + active-project facts (scope: `user-preference`, `claude-meta`, current project) | Pre-load durable context once per session |
| `UserPromptSubmit` | Every user prompt | Query = the prompt + project context | Classic Stage-1 recall — "is there a memory about what user just said?" |
| `PreToolUse` (Write/Edit) | About to write/edit a file | Query = a summary of *what's about to be written* + project + topic detection from path/content | The critical hook: surfaces lessons before mistakes are made |
| `PreToolUse` (Bash with destructive intent) | About to run `rm`, `git push --force`, etc. | Query = the command + project | Surface workflow rules ("never push --force on main") |
| `Stop` | End of turn | Evaluate save-worthiness of the turn | Last-chance autonomous save |

### Stage-1 recall hint format

When a hook finds matches, it injects this into Claude's context:

```
<recall-hints surface="claude-code" project="carnexus">
3 memorys may be relevant — call load_memory if needed before continuing:
- css-input-focus-ring-stacking (lesson, 0.94): Don't stack focus styles on inputs. Use single :focus-visible.
- pref-plan-format-recommendation-not-options (preference, 0.71): Daniel wants recommendation + 1 question, not 5-option menus.
- carnexus-large-codebase-multi-session (project-fact, 0.62): Carnexus is large — plan multi-session work.
</recall-hints>
```

Format rules:
- `<recall-hints>` block with surface + project attributes (Claude can self-locate)
- One memory per line: `id (type, score): summary`
- Score ≥ 0.5 only — below that is noise
- Max 3 hints — more = ignored
- Total ≤ 300 chars when possible

### CLAUDE.md instruction — the recall side

```markdown
## bastra-recall — using recall hints

When a `<recall-hints>` block appears in your context, it is not optional —
it is your own memory speaking.

For each hint with score ≥ 0.8: call `load_memory(id)` BEFORE you write code,
make a plan, or respond. Apply the lesson. The cost of ignoring a high-score
hint is repeating a known mistake.

For 0.5 ≤ score < 0.8: read the summary; load only if it seems directly
relevant to the current task.

Never ignore a `lesson` hint with score ≥ 0.8.

Never reload a memory you've already loaded this turn (idempotent).

If you load a memory and apply it, you don't need to mention it to the user
unless they ask. Just behave correctly.
```

### What a `PreToolUse` Write hook does

This is the cleverest hook because it operates on *Claude's intent*, not user prompts.

Pseudocode:
```
on PreToolUse(tool="Write" or "Edit"):
  # Extract intent from the tool args
  file_path = args.file_path
  content = args.content or args.new_string

  # Detect domain
  topics = detect_topics(file_path, content)
    # e.g., file ends in .tsx + content contains "<input" → ["css", "input", "react", "form"]
    # e.g., file in /api + content contains "POST" → ["api", "endpoint"]

  # Build action context
  context = {
    project: detect_project(cwd),
    intent: f"writing {file_extension} file at {file_path}, contains {top_topics}",
    topics: topics,
  }

  # Query daemon
  POST /hook/pre-write { context, k=3 }

  # Daemon does recall(query=intent, context=context, k=3)
  # If hits, daemon returns formatted <recall-hints> block
  # Hook prints it → Claude sees it before its Write tool actually runs
```

The detection is keyword-based in v0 (good enough for `<input`, `<button`, common CSS properties, etc.) and gets smarter in v0.5 (AST parsing).

### Concrete walkthrough — the CSS double-ring case

State: vault has `css-input-focus-ring-stacking` (the lesson from carnexus).

I'm working in a *new* project called `carview`. User says: *"Bau mir ein Login-Form mit zwei Inputs."*

```
1. UserPromptSubmit hook fires
   → recall("Login-Form mit zwei Inputs", { project: "carview" })
   → match score 0.71 (carnexus lesson, but scope=all-projects → applies)
   → injects hint into my context

2. I read the hint, decide to start writing
3. PreToolUse(Write) fires as I'm about to create LoginForm.tsx
   → recall(intent="writing tsx with <input>", topics=[css,input,form])
   → match score 0.94 (same lesson, much higher because intent=input)
   → injects refined hint with action-specific phrasing

4. I see "score 0.94 lesson" → call load_memory("css-input-focus-ring-stacking")
5. Read the body: don't stack ring + outline + custom focus
6. Write LoginForm.tsx with single :focus-visible utility, no extra ring/outline
7. No double-ring bug. Daniel doesn't have to flag it.

(In Daniel's view: nothing visible happened. That's the point. The bug
just doesn't appear, and a future PR review on the new project doesn't
re-litigate the lesson.)
```

This is the "real teammate" loop: I don't need to be reminded, because I check before I act.

---

## Tuning loop

Triggers will be wrong at first. The Dogfood week measures:

- **False-save rate** — saved memorys Daniel deletes within 7 days. Target < 10%.
- **Missed-save rate** — moments where Daniel says *"das hättest du speichern können"*. Target < 1 per session by week 2.
- **False-recall rate** — recall hints Claude doesn't load. Target: hints ≥ 0.8 should be loaded ≥ 80% of the time. (Logged in `recall_log.claude_loaded`.)
- **Missed-recall rate** — bugs/mistakes that recur and a relevant memory existed but didn't surface. This is the headline metric.

Trigger weights and thresholds are tuned from `recall_log` and `save_log` data, not by intuition.
