/**
 * Tool-Handler — pure logic, transport-agnostic.
 *
 * Jeder Handler nimmt {deps, args} und liefert ein plain JSON-Objekt zurück
 * (oder wirft Error mit Message). Wrapping ist Aufgabe der Caller:
 *   - index.ts wrappt für MCP-stdio (content/isError)
 *   - http.ts wrappt für REST (status code + JSON body)
 *
 * Damit teilen sich beide Pfade dieselbe Validierung, Telemetry und
 * Vault-Mutation — kein doppelter Code, kein Drift.
 */
import { z } from "zod";
import { saveMemory, SaveMemoryInput, type Vault, type SearchIndex } from "@bastra-recall/core";
import { Telemetry, fireAndForget } from "./telemetry.js";

export interface ToolDeps {
  vault: Vault;
  search: SearchIndex;
  telemetry: Telemetry;
  vaultPath: string;
}

// ─── Zod-Schemas ────────────────────────────────────────────────

export const RecallArgs = z.object({
  query: z.string().min(1),
  k: z.number().int().min(1).max(20).optional(),
  scope: z.string().optional(),
  type: z.string().optional(),
  /**
   * Sensitivity-Filter (#58). Default `false` — externe MCP-Caller (Claude
   * Code, Cursor, …) sehen nie `sensitivity: private` Memories. Die Bastra-
   * Mac-App ruft mit `allow_private: true` und sieht den vollen Vault.
   */
  allow_private: z.boolean().optional(),
  /**
   * Multi-Hop-Recall (#30 / #51). Default `0`. Bei `1` liefert der Server
   * zusätzlich zu den direkten Treffern deren 1-Hop-Nachbarn (Memories,
   * die per `related_via` verbunden sind), mit reduziertem Score und
   * `hop: "1-hop"` im Result. Höhere Hop-Tiefen werden aktuell nicht
   * unterstützt — der Wert ist auf 0 oder 1 begrenzt.
   */
  expand_hops: z.number().int().min(0).max(1).optional(),
});

export const LoadMemoryArgs = z.object({
  id: z.string().min(1),
  /** Spiegelt `RecallArgs.allow_private` — verhindert dass externe Clients
   *  Private-Memories per ID-Enumeration laden. Default `false`. */
  allow_private: z.boolean().optional(),
});

export { SaveMemoryInput };

// ─── Recall ──────────────────────────────────────────────────────

export interface RecallResult {
  query: string;
  vault_size: number;
  hits: unknown[];
  recall_id: string;
  latency_ms: number;
}

export async function recallHandler(
  deps: ToolDeps,
  rawArgs: unknown,
): Promise<RecallResult> {
  const parsed = RecallArgs.safeParse(rawArgs);
  if (!parsed.success) throw new Error(parsed.error.message);

  const t0 = Date.now();
  const recallOpts = {
    k: parsed.data.k,
    scope: parsed.data.scope,
    type: parsed.data.type,
    allow_private: parsed.data.allow_private ?? false,
    expand_hops: parsed.data.expand_hops as 0 | 1 | undefined,
  };
  const hits = deps.search.hasEmbeddings()
    ? await deps.search.recallHybrid(parsed.data.query, recallOpts)
    : deps.search.recall(parsed.data.query, recallOpts);
  const latencyMs = Date.now() - t0;
  const recallId = deps.telemetry.newRecallId();
  fireAndForget(
    deps.telemetry.logRecall({
      recall_id: recallId,
      query: parsed.data.query,
      k: parsed.data.k ?? null,
      scope: parsed.data.scope ?? null,
      type: parsed.data.type ?? null,
      vault_size: deps.vault.size(),
      hit_count: hits.length,
      top_score: hits[0]?.score ?? null,
      hits: hits.map((h) => ({ id: h.id, score: h.score, type: h.type })),
      latency_ms: latencyMs,
    }),
  );

  return {
    query: parsed.data.query,
    vault_size: deps.vault.size(),
    hits,
    recall_id: recallId,
    latency_ms: latencyMs,
  };
}

// ─── Load Memory ─────────────────────────────────────────────────

export interface LoadMemoryResult {
  id: string;
  frontmatter: Record<string, unknown>;
  body: string;
  file_path: string;
}

export async function loadMemoryHandler(
  deps: ToolDeps,
  rawArgs: unknown,
): Promise<LoadMemoryResult> {
  const parsed = LoadMemoryArgs.safeParse(rawArgs);
  if (!parsed.success) throw new Error(parsed.error.message);

  const m = deps.search.loadFull(parsed.data.id);
  const hookHint = deps.telemetry.findHookHintFor(parsed.data.id);
  fireAndForget(
    deps.telemetry.logLoadMemory({
      id: parsed.data.id,
      found: !!m,
      follows_recall: deps.telemetry.recentRecallId(),
      from_hook_recall: hookHint?.recall_id ?? null,
      hook_hint_rank: hookHint?.rank ?? null,
    }),
  );

  if (!m) throw new Error(`memory not found: ${parsed.data.id}`);

  // Sensitivity-Filter (#58): externe Caller sehen Private-Memories
  // nicht — auch nicht über direkte ID-Lookups. Mac-App overridet mit
  // `allow_private: true`.
  const allowPrivate = parsed.data.allow_private ?? false;
  if (
    !allowPrivate &&
    (m.fm as { sensitivity?: string }).sensitivity === "private"
  ) {
    throw new Error(`memory not found: ${parsed.data.id}`);
  }

  return {
    id: m.fm.id,
    frontmatter: m.fm as unknown as Record<string, unknown>,
    body: m.body,
    file_path: m.filePath,
  };
}

// ─── Save Memory ─────────────────────────────────────────────────

export interface SaveMemoryResult {
  id: string;
  file_path: string;
  created: boolean;
}

export async function saveMemoryHandler(
  deps: ToolDeps,
  rawArgs: unknown,
): Promise<SaveMemoryResult> {
  const parsed = SaveMemoryInput.safeParse(rawArgs);
  if (!parsed.success) throw new Error(parsed.error.message);

  const result = await saveMemory(deps.vaultPath, parsed.data);
  // Don't trust the watcher on cloud-storage mounts — force-index now
  // so a follow-up recall() in the same session sees the new memory.
  await deps.vault.reindexFile(result.file_path);
  fireAndForget(
    deps.telemetry.logSaveMemory({
      id: result.id,
      type: parsed.data.type,
      scope: parsed.data.scope,
      title: parsed.data.title,
      tag_count: parsed.data.tags.length,
      recall_when_count: parsed.data.recall_when.length,
      body_chars: parsed.data.body.length,
      overwrite: parsed.data.overwrite ?? false,
      created: result.created,
      follows_recall: deps.telemetry.recentRecallId(),
    }),
  );

  return result;
}

// ─── MCP Tool-Definitionen ───────────────────────────────────────
// Single source of truth für die MCP-Tool-Liste (recall/load_memory/
// save_memory). Sowohl der embedded MCP-Server in index.ts als auch
// der HTTP-Forwarder mcp-forwarder.ts importieren das hier, damit Schema
// und Description nicht aus dem Sync geraten.

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const MEMORY_TOOL_DEFS: ToolDef[] = [
  {
    name: "recall",
    description:
      "Search the memory vault. Returns top-k matching memorys " +
      "(id, title, type, scope, summary, score). " +
      "\n\n" +
      "WHEN TO CALL (recall is part of acting, not a separate step):\n" +
      "- At session start (once): query for active-project + " +
      "user-preferences to load durable context.\n" +
      "- Before writing/editing a file: query with a description of " +
      "what you are about to write (e.g. 'creating React input with " +
      "focus styles'). This catches lessons before mistakes.\n" +
      "- Before giving a multi-step plan or recommendation: query for " +
      "preferences that shape format/scope.\n" +
      "- When the user's prompt touches a topic that may have a stored " +
      "lesson, decision, preference, or project-fact.\n" +
      "- Before save_memory: query to avoid creating a duplicate.\n" +
      "\n" +
      "WHAT TO DO WITH HITS:\n" +
      "- score >= ~100 with title/recall_when match: load_memory and " +
      "apply the lesson before acting.\n" +
      "- score 30-100: read the summary, load if directly relevant.\n" +
      "- score < 30: usually noise; skip unless the summary is a " +
      "perfect topic match.\n" +
      "Never ignore a `lesson` hit with strong recall_when match.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Natural-language query OR a description of what you are " +
            "about to do (e.g. 'creating new input component', " +
            "'about to give a multi-option plan').",
        },
        k: {
          type: "number",
          description: "Max results (default 5, range 1-20).",
        },
        scope: {
          type: "string",
          description:
            "Optional exact-match filter, e.g. 'carnexus', " +
            "'user-preference', 'all-projects'.",
        },
        type: {
          type: "string",
          description:
            "Optional exact-match filter on memory type, e.g. 'lesson', " +
            "'preference', 'project-fact'.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "load_memory",
    description:
      "Load the full content (frontmatter + body) of a single memory " +
      "by id. Use this after recall() returns a hint with a high score, " +
      "to read the full lesson before acting.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Memory id (the slug, no .md extension).",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "save_memory",
    description:
      "Persist a new memory into the vault as a markdown file with YAML " +
      "frontmatter. This is YOUR long-term memory — save autonomously " +
      "when a memory-worthy moment occurs, do not wait to be asked.\n" +
      "\n" +
      "STRONG SIGNALS — save without confirmation, then 1-line ack:\n" +
      "- User expresses repetition/frustration about a recurring issue " +
      "  ('wieder', 'schon wieder', 'wie oft', emphatic caps) → lesson\n" +
      "- User states an explicit durable rule ('immer X', 'nie Y', 'bei " +
      "  diesem Projekt nutzen wir Z') → preference / workflow\n" +
      "- User corrects a recurring tendency in your behavior → " +
      "  meta-working\n" +
      "- An architectural decision is finalized after weighing options " +
      "  → decision\n" +
      "- User confirms a workflow ('lass uns das immer so machen') → " +
      "  workflow\n" +
      "- A bug got fixed after >2 iterations with non-obvious root " +
      "  cause → lesson (capture the FAILED PATH too, not just the fix)\n" +
      "\n" +
      "ANTI-SIGNALS — do NOT save:\n" +
      "- One-off task descriptions ('baue mir bitte X') — that's a " +
      "  task, not a memory\n" +
      "- Speculation, 'maybe' statements, tentative ideas\n" +
      "- Anything derivable from code/git/CLAUDE.md\n" +
      "- Sensitive personal data (unless a stable preference)\n" +
      "- When unsure: default to NOT saving. False saves erode trust.\n" +
      "\n" +
      "BEFORE SAVING: call recall() with the title/topic to check for " +
      "an existing memory you should update (overwrite=true) instead " +
      "of creating a duplicate.\n" +
      "\n" +
      "QUALITY BARS:\n" +
      "- Title: short, specific, non-generic.\n" +
      "- Summary (<=400 chars): one sentence with the gist.\n" +
      "- Body: lead with the rule/fact, then **Why:** (root cause / " +
      "  reason / incident) and **How to apply:** (when this kicks in). " +
      "  For lessons, capture the failure path AND the fix.\n" +
      "- recall_when (CRITICAL — highest-weighted search field): 2-4 " +
      "  CONCRETE contexts/queries where future-you should be reminded. " +
      "  'about to write a Tailwind grid' beats 'CSS questions'. Without " +
      "  good recall_when, the memory is dead weight.\n" +
      "\n" +
      "AFTER SAVING: surface a single-line ack to the user, prefixed " +
      "with `→`: `→ saved: <title> (id: <id>)`. Nothing more.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short, specific title (becomes the slug/id).",
        },
        type: {
          type: "string",
          enum: [
            "lesson",
            "preference",
            "project-fact",
            "meta-working",
            "decision",
            "workflow",
            "reference",
            "user-preference",
          ],
          description:
            "Memory type. Use 'lesson' for fixes/gotchas, 'preference' " +
            "for project-scoped style choices, 'user-preference' for " +
            "the human's cross-project preferences, 'project-fact' for " +
            "non-derivable project state, 'decision' for committed " +
            "design decisions, 'workflow' for recurring procedures.",
        },
        summary: {
          type: "string",
          description:
            "One sentence (<=400 chars) capturing the gist — appears in " +
            "recall() hits.",
        },
        body: {
          type: "string",
          description:
            "Full markdown body. Lead with the rule/fact, then explain " +
            "*why* (the reason/incident) and *how to apply* (when this " +
            "kicks in). Wikilinks like [[other-memory-id]] are supported.",
        },
        topic_path: {
          type: "array",
          items: { type: "string" },
          description:
            "Hierarchical topic path, e.g. ['bastra-recall','search','ranking'].",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Flat tags for filtering, at least one.",
        },
        scope: {
          type: "string",
          description:
            "Project/area this memory belongs to, e.g. 'bastra-recall', " +
            "'carnexus', 'user-preference', 'all-projects'.",
        },
        recall_when: {
          type: "array",
          items: { type: "string" },
          description:
            "Trigger phrases — situations where this memory should " +
            "surface. Highest-weighted search field. Be specific: " +
            "'about to write a Tailwind grid', not 'CSS questions'.",
        },
        related: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional ids of related memories. Hinweis: `[[id]]`-Wikilinks " +
            "im body werden automatisch ins related[] gespiegelt — du musst " +
            "sie hier nicht doppelt aufzählen.",
        },
        sensitivity: {
          type: "string",
          enum: ["private", "team", "public"],
          description:
            "Wer darf das Memory sehen? Default 'team' (lokale KI-Tools). " +
            "'private' = nur Mac-App (für externe Caller nicht sichtbar).",
        },
        valid_until: {
          type: "string",
          description:
            "Explizites Ablaufdatum (YYYY-MM-DD). Überschreibt expires_after_days.",
        },
        expires_after_days: {
          type: "number",
          description:
            "Tage nach 'updated', ab denen das Memory altert/expires. " +
            "Überschreibt den Type-Default (lesson=180, decision=365, …).",
        },
        last_reviewed_at: {
          type: "string",
          description:
            "ISO-Datum des letzten 'noch aktuell'-Checks. Resetet Staleness.",
        },
        affects_files: {
          type: "array",
          items: { type: "string" },
          description:
            "Optionale Liste von Repo-Pfaden, die diese Lesson/Decision betrifft.",
        },
        issues: {
          type: "array",
          items: { type: "string" },
          description:
            "Optionale Liste verknüpfter Issue-IDs (z.B. '#42').",
        },
        source: {
          type: "string",
          description:
            "Optional provenance, e.g. 'Daniel, 2026-05-01 after retro'.",
        },
        confidence: {
          type: "number",
          description:
            "0-1, default 1. Lower if the lesson is tentative.",
        },
        id: {
          type: "string",
          description:
            "Optional explicit id/slug. Default: slugified title.",
        },
        overwrite: {
          type: "boolean",
          description:
            "If true, replace an existing memory with the same id. " +
            "Default false (errors on collision).",
        },
      },
      required: [
        "title",
        "type",
        "summary",
        "body",
        "topic_path",
        "tags",
        "scope",
        "recall_when",
      ],
    },
  },
];
