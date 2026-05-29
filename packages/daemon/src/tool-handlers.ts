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
import {
  saveMemory,
  SaveMemoryInput,
  stripAutoRelatedSection,
  type Vault,
  type SearchIndex,
  type StageListener,
  type RecallStage,
  type RecallHit,
} from "@bastra-recall/core";
import { Telemetry, fireAndForget } from "./telemetry.js";
import { touchLoadedMarker } from "./session-state.js";
import { envInt } from "./env.js";

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
  /**
   * Payload-Verbosity (#50). Default `"lean"` — pro Hit nur
   * `id, title, type, scope, summary, score`; `matched_terms`, `mode`,
   * `hop`, `topic_path` und der `stages`-Block fallen weg. Das Modell stockt
   * bei Bedarf via `load_memory` auf (Multistep-Validation). `"full"` liefert
   * alle Felder — für die Mac-App / Debug.
   */
  verbosity: z.enum(["lean", "full"]).optional(),
  /**
   * Score-Floor (#50 / #9). Default `BASTRA_RECALL_FLOOR` (30, spiegelt den
   * Hook + die SKILL.md-Linie „score < 30 = noise"). Hits darunter werden
   * gar nicht erst zurückgegeben, damit Tail-Rauschen keinen Context frisst.
   * Caller können enger ziehen.
   */
  min_score: z.number().min(0).optional(),
});

export const LoadMemoryArgs = z.object({
  id: z.string().min(1),
  /** Spiegelt `RecallArgs.allow_private` — verhindert dass externe Clients
   *  Private-Memories per ID-Enumeration laden. Default `false`. */
  allow_private: z.boolean().optional(),
  /**
   * Payload-Verbosity (#50). Default `"lean"` — essenzielle Frontmatter
   * (id, title, type, scope, summary, topic_path, tags, recall_when,
   * related, created, updated) + body OHNE den Auto-Related-Block. `"full"`
   * liefert die komplette Frontmatter (related_via-Cosines, source,
   * confidence, …) + unbearbeiteten body — für die Mac-App / Debug.
   */
  verbosity: z.enum(["lean", "full"]).optional(),
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

/**
 * Pro-Stage-Dauern in ms (#38). Caller-agnostisch — sowohl der
 * MCP-Stdio-Handler als auch HTTP-SSE und der Telemetry-Pfad bekommen
 * dieselben Bucket-Namen. Wird in `recall_call`-JSONL-Logs als
 * `recall_stages` mitgeschrieben, um Bottlenecks zu identifizieren.
 */
export interface RecallStageTimings {
  query_parse_ms?: number;
  bm25_search_ms?: number;
  vector_search_ms?: number;
  rrf_fuse_ms?: number;
  hops_expand_ms?: number;
  staleness_rank_ms?: number;
  cache_hit?: boolean;
}

/** Stage-Namen → ms-Bucket in `RecallStageTimings`. `cache_hit` ist
 *  bewusst nicht hier — der ist ein boolean und wird separat gesetzt. */
type StageMsKey = "query_parse_ms" | "bm25_search_ms" | "vector_search_ms" | "rrf_fuse_ms" | "hops_expand_ms" | "staleness_rank_ms";

const STAGE_TO_TIMING_KEY: Partial<Record<RecallStage["name"], StageMsKey>> = {
  "query.parse": "query_parse_ms",
  "bm25.search": "bm25_search_ms",
  "vector.search": "vector_search_ms",
  "rrf.fuse": "rrf_fuse_ms",
  "hops.expand": "hops_expand_ms",
  "staleness.rank": "staleness_rank_ms",
};

/**
 * Sammelt Stage-Timings und fan-out zu einem optional externen Listener
 * (MCP-progress-notification oder HTTP-SSE). Der Caller bekommt die
 * Stage-Bucket-Map zurück, sobald `recall()` resolved ist — die Werte
 * landen dann in der Telemetrie.
 */
function makeStageCollector(forward?: StageListener): { listener: StageListener; timings: RecallStageTimings } {
  const timings: RecallStageTimings = {};
  const listener: StageListener = (stage: RecallStage) => {
    forward?.(stage);
    if (stage.name === "cache.hit") {
      timings.cache_hit = true;
      return;
    }
    if (stage.durationMs === undefined) return;
    const key = STAGE_TO_TIMING_KEY[stage.name];
    if (!key) return;
    // Stop-Events kommen nach Start-Events — durch das Überschreiben
    // (statt += ) bleibt der finale Wert die echte Dauer.
    timings[key] = stage.durationMs;
  };
  return { listener, timings };
}

/** Score-Floor (#50 / #9): Hits darunter sind Rauschen und werden nicht
 *  zurückgegeben. Spiegelt `SCORE_FLOOR` aus hook.ts + die SKILL.md-Linie. */
const RECALL_FLOOR = envInt("BASTRA_RECALL_FLOOR", 30);

/** Max-Länge der `summary` im lean-Modus (#50). Lang genug zum Validieren,
 *  kurz genug um Context zu sparen. `verbosity:"full"` umgeht das. */
const LEAN_SUMMARY_MAX = 160;

/** Kürzt auf max. `LEAN_SUMMARY_MAX` Zeichen an der letzten Wortgrenze und
 *  hängt „…" an. Nie mitten im Wort. Kürzere Summaries bleiben unverändert. */
export function truncateSummary(summary: string): string {
  if (summary.length <= LEAN_SUMMARY_MAX) return summary;
  const slice = summary.slice(0, LEAN_SUMMARY_MAX);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > LEAN_SUMMARY_MAX * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}

/** Schlanke Pro-Hit-Projektion (#50): nur die Felder, die das Modell zum
 *  Validieren braucht. Dropt `matched_terms` (größter variabler Fresser),
 *  `mode`, `hop`, `topic_path` und kürzt `summary` auf einen Snippet.
 *  `verbosity:"full"` liefert alle Felder + volle summary. */
export function toLeanHit(hit: RecallHit): Pick<RecallHit, "id" | "title" | "type" | "scope" | "summary" | "score"> {
  return {
    id: hit.id,
    title: hit.title,
    type: hit.type,
    scope: hit.scope,
    summary: truncateSummary(hit.summary),
    score: hit.score,
  };
}

export async function recallHandler(
  deps: ToolDeps,
  rawArgs: unknown,
  options: { onStage?: StageListener } = {},
): Promise<RecallResult & { stages?: RecallStageTimings }> {
  const parsed = RecallArgs.safeParse(rawArgs);
  if (!parsed.success) throw new Error(parsed.error.message);

  const t0 = Date.now();
  const collector = makeStageCollector(options.onStage);
  const recallOpts = {
    k: parsed.data.k,
    scope: parsed.data.scope,
    type: parsed.data.type,
    allow_private: parsed.data.allow_private ?? false,
    expand_hops: parsed.data.expand_hops as 0 | 1 | undefined,
    onStage: collector.listener,
  };
  const rawHits = deps.search.hasEmbeddings()
    ? await deps.search.recallHybrid(parsed.data.query, recallOpts)
    : deps.search.recall(parsed.data.query, recallOpts);
  const latencyMs = Date.now() - t0;

  // Prong 3 (#50 / #9): Sub-Floor-Rauschen gar nicht erst zurückgeben.
  const floor = parsed.data.min_score ?? RECALL_FLOOR;
  const hits = rawHits.filter((h) => h.score >= floor);
  const droppedBelowFloor = rawHits.length - hits.length;

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
      recall_stages: collector.timings,
      dropped_below_floor: droppedBelowFloor,
    }),
  );

  // Prong 1 (#50): lean-by-default. `verbosity: "full"` liefert alle
  // Felder + den stages-Block (Mac-App / Debug).
  const full = parsed.data.verbosity === "full";
  return {
    query: parsed.data.query,
    vault_size: deps.vault.size(),
    hits: full ? hits : hits.map(toLeanHit),
    recall_id: recallId,
    latency_ms: latencyMs,
    ...(full ? { stages: collector.timings } : {}),
  };
}

// ─── Load Memory ─────────────────────────────────────────────────

export interface LoadMemoryResult {
  id: string;
  frontmatter: Record<string, unknown>;
  body: string;
  file_path: string;
}

/** Frontmatter-Felder, die das Modell zum Anwenden eines Memorys braucht.
 *  Debug-/Vault-Interna (related_via-Cosines, source, confidence,
 *  sensitivity, affects_files, issues, categories, valid_until) fallen im
 *  lean-Modus weg (#50). */
const LEAN_FRONTMATTER_KEYS = [
  "id",
  "title",
  "type",
  "scope",
  "summary",
  "topic_path",
  "tags",
  "recall_when",
  "related",
  "created",
  "updated",
] as const;

/** Projiziert die volle Frontmatter auf die lean-Teilmenge. Unbekannte/
 *  fehlende Keys werden übersprungen. */
export function leanFrontmatter(fm: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of LEAN_FRONTMATTER_KEYS) {
    if (fm[key] !== undefined) out[key] = fm[key];
  }
  return out;
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

  // Reset-signal for the hook's per-session dedup (#32): touch a marker
  // file so the next hook invocation knows the agent has consumed this
  // memory and the dedup clock should restart.
  fireAndForget(touchLoadedMarker(parsed.data.id));

  // Lean-by-default (#50): essenzielle Frontmatter + body ohne den
  // Auto-Related-Block. `verbosity: "full"` liefert alles (Mac-App / Debug).
  const full = parsed.data.verbosity === "full";
  const fm = m.fm as unknown as Record<string, unknown>;
  return {
    id: m.fm.id,
    frontmatter: full ? fm : leanFrontmatter(fm),
    body: full ? m.body : stripAutoRelatedSection(m.body),
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
      "Never ignore a `lesson` hit with strong recall_when match.\n" +
      "\n" +
      "recall returns lean CANDIDATES (no bodies). This is step 1 of a " +
      "two-step flow: call load_memory ONLY for the hits you actually " +
      "need — do not load every hit.",
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
        verbosity: {
          type: "string",
          enum: ["lean", "full"],
          description:
            "'lean' (default) returns id, title, type, scope, summary, " +
            "score per hit. 'full' adds matched_terms, mode, hop, " +
            "topic_path and the stages timing block — for debugging / the " +
            "Mac-App. Leave unset to keep the context footprint small.",
        },
        min_score: {
          type: "number",
          description:
            "Drop hits below this score (default 30 = the noise floor). " +
            "Raise it to surface only high-confidence candidates.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "load_memory",
    description:
      "Load the content (frontmatter + body) of a single memory by id. " +
      "Step 2 of the recall flow — call this only for the candidates " +
      "recall() surfaced that you actually need. Returns essential " +
      "frontmatter + body by default; pass verbosity:'full' for the raw " +
      "frontmatter (related_via cosines, source, …).",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Memory id (the slug, no .md extension).",
        },
        verbosity: {
          type: "string",
          enum: ["lean", "full"],
          description:
            "'lean' (default) returns essential frontmatter + body without " +
            "the auto-related block. 'full' returns the complete frontmatter " +
            "and raw body — for debugging / the Mac-App.",
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
