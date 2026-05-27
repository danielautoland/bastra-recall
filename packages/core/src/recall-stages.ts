/**
 * Stage-Event-Typen für die Recall-Pipeline (#38).
 *
 * Der Recall-Pfad in `SearchIndex` (BM25 + Vector + RRF + Hops + Staleness)
 * emittiert auf Wunsch nach jedem Schritt ein `RecallStage`-Event. Ein
 * Caller (MCP-progress-notification, HTTP-SSE, CLI-stderr-Spinner) hängt
 * sich via `RecallOptions.onStage` ein und macht die Schritte sichtbar.
 *
 * Designprinzipien:
 *   - Null Overhead, wenn `onStage` nicht gesetzt ist (Hot-Path bleibt
 *     unverändert, die einzigen Adds sind `t = Date.now()` + ein
 *     `?.()`-Aufruf).
 *   - Stage-Namen sind ein geschlossener String-Union — keine freien
 *     Strings, damit Banter-Engine und Telemetry exhaustiv matchen
 *     können.
 *   - `meta` ist optional und Free-Form (z.B. `{ vault_size: 163 }`
 *     beim `done`-Event, `{ cache: "query" }` beim `cache.hit`-Event).
 *   - `startedAtMs` + `durationMs`: ein einzelner Event-Type für Start
 *     und Stop. Der Banter-Picker entscheidet anhand von `durationMs`
 *     ob „Slow"-Phrasen gefeuert werden.
 */
export interface RecallStage {
  name:
    | "query.parse"
    | "cache.hit"
    | "bm25.search"
    | "vector.search"
    | "rrf.fuse"
    | "hops.expand"
    | "staleness.rank"
    | "done"
    | "error";
  /** Unix-ms beim Start der Stage (auch beim Stop-Event identisch — der
   *  Caller kann so Start- und Stop-Events korrelieren). */
  startedAtMs: number;
  /** Wenn gesetzt: Stage ist abgeschlossen, Dauer in ms. Wenn fehlend:
   *  Stage hat gerade erst gestartet. */
  durationMs?: number;
  /** Freie Metadaten — Stage-spezifisch. Beispiele:
   *  - `cache.hit`: `{ cache: "query" }`
   *  - `bm25.search`: `{ raw_hit_count: 42 }`
   *  - `vector.search`: `{ vector_hit_count: 17 }`
   *  - `rrf.fuse`: `{ fused_count: 50 }`
   *  - `hops.expand`: `{ hop_count: 3 }`
   *  - `done`: `{ hit_count, vault_size, total_ms }` */
  meta?: Record<string, unknown>;
}

export type StageListener = (stage: RecallStage) => void;

/**
 * Geordnete Stage-Sequenz für `recallHybrid`. Wird von Banter-Engine
 * und Progress-Counter gleichermaßen konsumiert (`total = 8` als
 * Anker für UI-Bars). Reihenfolge ist absichtlich stabil — neue Stages
 * werden hinten angehängt.
 */
export const RECALL_STAGE_ORDER: RecallStage["name"][] = [
  "query.parse",
  "cache.hit",
  "bm25.search",
  "vector.search",
  "rrf.fuse",
  "hops.expand",
  "staleness.rank",
  "done",
];

/**
 * 1-basierter Index für UI-Progress (`progress: number` im
 * MCP-`notifications/progress`-Payload erwartet eine Zahl). `error`
 * bekommt `0`, `done` bekommt `RECALL_STAGE_ORDER.length`.
 */
export function progressIndexFor(name: RecallStage["name"]): number {
  if (name === "error") return 0;
  const idx = RECALL_STAGE_ORDER.indexOf(name);
  return idx >= 0 ? idx + 1 : 0;
}
