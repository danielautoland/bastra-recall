import MiniSearch from "minisearch";
import type { Memory } from "./schema.js";
import type { Vault, VaultEvent } from "./vault.js";
import type { EmbeddingIndex } from "./embeddings.js";
import { fuseRRF } from "./embeddings.js";

export interface RecallHit {
  id: string;
  title: string;
  type: string;
  scope: string;
  summary: string;
  topic_path: string[];
  score: number;
  matched_terms: string[];
  /** „bm25" | „vector" | „hybrid" — primärer Treffer-Modus für Telemetrie. */
  mode?: "bm25" | "vector" | "hybrid";
  /** „direct" | „1-hop" — bei Multi-Hop-Recall: ob das Memory ein direkter
   *  Match war oder ein Nachbar über `related_via`. UI kann das anders rendern. */
  hop?: "direct" | "1-hop";
}

export interface RecallOptions {
  k?: number;
  scope?: string; // exact-match filter
  type?: string; // exact-match filter
  /**
   * Sensitivity-Filter (#58). Default `false` — externe MCP-Caller (Claude
   * Code, Cursor, etc.) sehen keine als `private` markierten Memories. Die
   * Mac-App ruft mit `allow_private: true` und sieht alles.
   */
  allow_private?: boolean;
  /**
   * Multi-Hop-Recall (#30 / #51). Default `0` — nur direkte BM25/Vector-Hits.
   * Bei `1`: nach den direkten Treffern werden deren `related_via`-Nachbarn
   * (1-Hop) eingehängt, mit reduziertem Score. UI kennzeichnet sie als
   * `hop: "1-hop"`.
   */
  expand_hops?: 0 | 1;
}

interface IndexDoc {
  id: string;
  title: string;
  summary: string;
  tags_flat: string;
  recall_when_flat: string;
  topic_path_flat: string;
  body: string;
  // not searched, just stored
  type: string;
  scope: string;
  topic_path: string[];
  obsolete: boolean;
  confidence: number;
  sensitivity: string;
}

/**
 * In-memory BM25 search over the vault.
 * Built on minisearch — handles ~thousands of memorys easily.
 * Field weights chosen so title + recall_when + tags > body.
 */
export class SearchIndex {
  private mini: MiniSearch<IndexDoc>;
  private detach?: () => void;
  private embeddings?: EmbeddingIndex;

  // Staleness-Cache (#29): `computeStaleness()` parsed Date-Strings und
  // rechnet Ratio-Logik — pro Recall × Hit-Count summiert sich das. Cache
  // ist memId → { touchTs, status, computedAt }. Invalidiert in `handle()`
  // bei change/remove, plus 12h-TTL gegen Tageswechsel (`aging → stale`
  // ohne Vault-Change).
  private stalenessCache = new Map<
    string,
    { touchTs: number; status: StaleStatus; computedAt: number }
  >();
  private static readonly STALENESS_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

  // Query-Cache (#30): MiniSearch tokenisiert die Query bei jedem
  // `recall()` neu. Hooks rufen häufig mit identischer Query auf
  // (detectTopics() ist deterministisch). LRU via Map-insertion-order,
  // hard cap 100 Einträge, TTL 30s. Vault-Change leert komplett.
  private queryCache = new Map<string, { hits: RecallHit[]; at: number }>();
  private static readonly QUERY_CACHE_MAX = 100;
  private static readonly QUERY_CACHE_TTL_MS = 30_000;

  constructor(private readonly vault: Vault) {
    this.mini = new MiniSearch<IndexDoc>({
      fields: [
        "title",
        "summary",
        "tags_flat",
        "recall_when_flat",
        "topic_path_flat",
        "body",
      ],
      storeFields: [
        "id",
        "title",
        "type",
        "scope",
        "summary",
        "topic_path",
        "obsolete",
        "confidence",
        "sensitivity",
      ],
      searchOptions: {
        boost: {
          // recall_when is authored exactly for triggering — highest weight.
          recall_when_flat: 5,
          title: 4,
          tags_flat: 3,
          topic_path_flat: 2,
          summary: 2,
          body: 1,
        },
        fuzzy: 0.2,
        prefix: true,
        combineWith: "OR",
      },
    });
  }

  /** Initial population from the vault, then subscribe to changes. */
  start(): void {
    for (const m of this.vault.list()) this.indexOne(m);
    this.detach = this.vault.on((e) => this.handle(e));
  }

  stop(): void {
    this.detach?.();
    this.detach = undefined;
  }

  /** Optionalen Embedding-Index registrieren — recallHybrid nutzt ihn,
   *  recall (sync) bleibt BM25-only für Backwards-Compat. */
  useEmbeddings(idx: EmbeddingIndex | undefined): void {
    this.embeddings = idx;
  }

  hasEmbeddings(): boolean {
    return this.embeddings !== undefined;
  }

  recall(query: string, opts: RecallOptions = {}): RecallHit[] {
    const k = opts.k ?? 5;
    if (!query.trim()) return [];

    // Query-Cache (#30) — bei Hit komplett überspringen, inkl. Hop-
    // Expansion und Staleness-Reranking. Cache speichert das finale
    // RecallHit[], nicht den BM25-Roh-Output.
    const cacheKey = `recall|${query}|${JSON.stringify(opts)}`;
    const cached = this.lookupQueryCache(cacheKey);
    if (cached) return cached;

    const raw = this.mini.search(query);

    const filtered = raw.filter((r) => {
      if (!passesRecallFilters(r, opts)) return false;
      return true;
    });

    // Pool-Size für Hop-Seeds: max(k*4, 20). Multi-Hop soll Nachbarn auch
    // für Hits sehen, die knapp unter dem k-Cut liegen — sonst gehen die
    // related_via-Kanten der Positionen 6–20 verloren.
    const HOP_SEED_POOL = Math.max(k * 4, 20);
    const directFull: RecallHit[] = filtered.slice(0, HOP_SEED_POOL).map((r) => ({
      id: r.id as string,
      title: r.title as string,
      type: r.type as string,
      scope: r.scope as string,
      summary: r.summary as string,
      topic_path: r.topic_path as string[],
      score: round(r.score),
      matched_terms: r.terms ?? [],
      mode: "bm25" as const,
      hop: "direct" as const,
    }));
    const direct = directFull.slice(0, k);

    const withHops = opts.expand_hops === 1
      ? [...direct, ...this.collectOneHopNeighbors(directFull, opts, new Set(direct.map((h) => h.id))).slice(0, k)]
      : direct;
    const reranked = this.applyStaleness(withHops);
    this.storeQueryCache(cacheKey, reranked);
    return reranked;
  }

  /** Hybrid-Recall: BM25 + Vector via Reciprocal-Rank-Fusion. Wenn kein
   *  EmbeddingIndex registriert ist, fällt auf reines BM25 (sync) zurück.
   *  Der finale Score ist auf 0–1000 skaliert (RRF * 1000) damit das
   *  Hook-Score-Threshold (≥100 = REQUIRED) sinnvoll greift. */
  async recallHybrid(query: string, opts: RecallOptions = {}): Promise<RecallHit[]> {
    if (!this.embeddings) return this.recall(query, opts);
    const k = opts.k ?? 5;
    if (!query.trim()) return [];

    // Query-Cache (#30) — eigener Key-Prefix damit BM25-only und Hybrid
    // sich nicht gegenseitig überschreiben (gleicher Query-String,
    // anderes Ranking-Ergebnis).
    const cacheKey = `hybrid|${query}|${JSON.stringify(opts)}`;
    const cached = this.lookupQueryCache(cacheKey);
    if (cached) return cached;

    // BM25 — top 50 für RRF-Pool.
    const bm25 = this.mini.search(query).filter((r) => passesRecallFilters(r, opts));
    const bm25Top = bm25.slice(0, 50);

    // Vector — top 50 für RRF-Pool, plus type/scope/sensitivity-Filter über vault.
    const vec = await this.embeddings.search(query, 100);
    const vectorTop = vec
      .map((h) => ({ hit: h, mem: this.vault.get(h.id) }))
      .filter(({ mem }) => {
        if (!mem) return false;
        if (mem.fm.obsolete === true) return false;
        if (opts.scope && mem.fm.scope !== opts.scope) return false;
        if (opts.type && mem.fm.type !== opts.type) return false;
        if (
          !opts.allow_private &&
          (mem.fm as { sensitivity?: string }).sensitivity === "private"
        ) {
          return false;
        }
        return true;
      })
      .slice(0, 50);

    const bm25Ids = bm25Top.map((r) => r.id as string);
    const vectorIds = vectorTop.map(({ hit }) => hit.id);
    const fused = fuseRRF(bm25Ids, vectorIds);

    // Lookup-Maps für die finale Hit-Konstruktion.
    const bm25Lookup = new Map(bm25Top.map((r) => [r.id as string, r]));
    const vectorLookup = new Map(vectorTop.map((v) => [v.hit.id, v]));

    const sorted = Array.from(fused.entries()).sort((a, b) => b[1] - a[1]);
    // Größerer Pool für Hop-Seeds (siehe recall()-Kommentar).
    const HOP_SEED_POOL = Math.max(k * 4, 20);
    const outFull: RecallHit[] = [];
    for (const [id, fusedScore] of sorted) {
      if (outFull.length >= HOP_SEED_POOL) break;
      const bm = bm25Lookup.get(id);
      const v = vectorLookup.get(id);
      const mem = v?.mem ?? this.vault.get(id);
      if (!mem) continue;
      const fm = mem.fm;
      const inBoth = bm !== undefined && v !== undefined;
      outFull.push({
        id: fm.id,
        title: fm.title,
        type: fm.type,
        scope: fm.scope,
        summary: fm.summary,
        topic_path: fm.topic_path,
        // RRF-Score skaliert auf BM25-vergleichbare Range. Klassisch sind
        // BM25-Scores ~5–500, RRF ist 0.005–0.04 → *5000 mappt grob.
        score: round(fusedScore * 5000),
        matched_terms: bm?.terms ?? [],
        mode: inBoth ? "hybrid" : bm ? "bm25" : "vector",
        hop: "direct" as const,
      });
    }
    const out = outFull.slice(0, k);
    const withHops = opts.expand_hops === 1
      ? [...out, ...this.collectOneHopNeighbors(outFull, opts, new Set(out.map((h) => h.id))).slice(0, k)]
      : out;
    const reranked = this.applyStaleness(withHops);
    this.storeQueryCache(cacheKey, reranked);
    return reranked;
  }

  /**
   * Multi-Hop-Expansion (#30 / #51): sammelt `related_via.id`-Nachbarn aus
   * den Seed-Hits (typischerweise top-20 aus dem BM25/Hybrid-Pool, nicht nur
   * top-k — sonst gehen Nachbarn von Position 6–20 verloren), filtert sie
   * (obsolete / scope / type / sensitivity / dedup gegen `exclude`), und
   * liefert sie mit reduziertem Score sortiert zurück. Score-Reduktion:
   * `seed.score * 0.5 * link.score` (heuristisch — Nachbarn sollen nie über
   * direkte Treffer ranken). Wenn ein Nachbar mehrfach gefunden wird, gewinnt
   * der höchste Score.
   */
  private collectOneHopNeighbors(
    seeds: RecallHit[],
    opts: RecallOptions,
    exclude: Set<string>,
  ): RecallHit[] {
    if (seeds.length === 0) return [];
    const best = new Map<string, RecallHit>();
    for (const seed of seeds) {
      const mem = this.vault.get(seed.id);
      const related = (mem?.fm as { related_via?: { id: string; reason: string; score: number }[] })
        ?.related_via;
      if (!related?.length) continue;
      for (const link of related) {
        if (exclude.has(link.id)) continue;
        const neigh = this.vault.get(link.id);
        if (!neigh) continue;
        if (neigh.fm.obsolete === true) continue;
        if (opts.scope && neigh.fm.scope !== opts.scope) continue;
        if (opts.type && neigh.fm.type !== opts.type) continue;
        if (
          !opts.allow_private &&
          (neigh.fm as { sensitivity?: string }).sensitivity === "private"
        ) {
          continue;
        }
        const score = round(seed.score * 0.5 * link.score);
        const prior = best.get(link.id);
        if (prior && prior.score >= score) continue;
        best.set(link.id, {
          id: neigh.fm.id,
          title: neigh.fm.title,
          type: neigh.fm.type,
          scope: neigh.fm.scope,
          summary: neigh.fm.summary,
          topic_path: neigh.fm.topic_path,
          score,
          matched_terms: [],
          mode: seed.mode,
          hop: "1-hop" as const,
        });
      }
    }
    return Array.from(best.values()).sort((a, b) => b.score - a.score);
  }

  loadFull(id: string): Memory | undefined {
    return this.vault.get(id);
  }

  size(): number {
    return this.mini.documentCount;
  }

  // ─── internals ───────────────────────────────────────────────

  private handle(e: VaultEvent): void {
    if (e.kind === "remove") {
      // Staleness-Cache invalidieren (#29) — memId genügt.
      this.stalenessCache.delete(e.id);
      // Query-Cache komplett leeren (#30) — selektive Invalidierung wäre
      // ein eigenes Ranking-Problem und Vault-Changes sind selten.
      this.queryCache.clear();
      try {
        this.mini.discard(e.id);
      } catch {
        // not indexed; ignore
      }
      return;
    }
    if (e.kind === "change") {
      this.stalenessCache.delete(e.memory.fm.id);
      this.queryCache.clear();
      try {
        this.mini.discard(e.memory.fm.id);
      } catch {
        // first time; treat as add
      }
    } else if (e.kind === "add") {
      // Neue Memory könnte BM25-Ranking aller bestehenden Queries
      // verändern → Query-Cache leeren. Staleness wird ohnehin lazy
      // beim nächsten Recall berechnet.
      this.queryCache.clear();
    }
    this.indexOne(e.memory);
  }

  /**
   * Staleness-Reranking mit Per-Memory-Cache (#29). Cache-Key ist die
   * memId — invalidiert in `handle()` bei change/remove. Zusätzlich
   * 12h-TTL gegen Tageswechsel-Flips (`aging → stale` ohne Vault-Change).
   *
   * Behält die Sortier-Semantik von `applyStalenessMultiplier`: Direct-
   * vs 1-hop-Hits bleiben getrennt sortiert.
   */
  private applyStaleness(hits: RecallHit[], now: Date = new Date()): RecallHit[] {
    const nowMs = now.getTime();
    for (const h of hits) {
      const fm = this.vault.get(h.id)?.fm as Record<string, unknown> | undefined;
      if (!fm) continue;
      const touchTs = computeTouchTs(fm);
      let entry = this.stalenessCache.get(h.id);
      const ttlExpired =
        entry != null && nowMs - entry.computedAt > SearchIndex.STALENESS_CACHE_TTL_MS;
      if (!entry || entry.touchTs !== touchTs || ttlExpired) {
        const status = computeStaleness(fm, now);
        entry = { touchTs, status, computedAt: nowMs };
        this.stalenessCache.set(h.id, entry);
      }
      const mult = STALE_MULTIPLIERS[entry.status];
      if (mult !== 1.0) h.score = round(h.score * mult);
    }
    const direct = hits.filter((h) => h.hop !== "1-hop");
    const hops = hits.filter((h) => h.hop === "1-hop");
    direct.sort((a, b) => b.score - a.score);
    hops.sort((a, b) => b.score - a.score);
    return [...direct, ...hops];
  }

  /**
   * LRU-Lookup für `queryCache` (#30). Bei Hit wird der Eintrag
   * re-inserted, damit die Map-insertion-order ihn als „recently used"
   * sieht. TTL 30s — frische Edits sollen den Cache nicht zu lange
   * dominieren, auch wenn der Watcher nicht feuert.
   */
  private lookupQueryCache(key: string): RecallHit[] | undefined {
    const cached = this.queryCache.get(key);
    if (!cached) return undefined;
    if (Date.now() - cached.at > SearchIndex.QUERY_CACHE_TTL_MS) {
      this.queryCache.delete(key);
      return undefined;
    }
    // LRU-Bump: löschen + neu setzen, damit Map-iteration den Eintrag
    // als jüngsten sieht.
    this.queryCache.delete(key);
    this.queryCache.set(key, cached);
    // Defensive Kopie — Caller könnte das Array mutieren (sortieren,
    // pushen). Cache-Werte bleiben damit stabil über Calls hinweg.
    return cached.hits.map((h) => ({ ...h }));
  }

  private storeQueryCache(key: string, hits: RecallHit[]): void {
    if (this.queryCache.size >= SearchIndex.QUERY_CACHE_MAX) {
      // Oldest first — Map preserved insertion order.
      const oldest = this.queryCache.keys().next().value;
      if (oldest !== undefined) this.queryCache.delete(oldest);
    }
    // Tiefen-Kopie der Hits, gleicher Grund wie in lookupQueryCache.
    this.queryCache.set(key, {
      hits: hits.map((h) => ({ ...h })),
      at: Date.now(),
    });
  }

  private indexOne(m: Memory): void {
    const fm = m.fm;
    const doc: IndexDoc = {
      id: fm.id,
      title: fm.title,
      summary: fm.summary,
      tags_flat: fm.tags.join(" "),
      recall_when_flat: fm.recall_when.join(" \n "),
      topic_path_flat: fm.topic_path.join(" "),
      body: m.body,
      type: fm.type,
      scope: fm.scope,
      topic_path: fm.topic_path,
      obsolete: fm.obsolete === true,
      confidence: fm.confidence ?? 1,
      // Default ist "team" (kommt aus dem zod-Schema), aber alte Files
      // ohne das Feld werden hier zu "team" defaultet damit der Filter
      // konsistent ist.
      sensitivity: (fm as { sensitivity?: string }).sensitivity ?? "team",
    };
    this.mini.add(doc);
  }
}

/**
 * Standard-Filter für BM25-Roh-Treffer: obsolete-Maskierung, scope/type-
 * Exact-Match, und der neue Sensitivity-Filter (#58). Wird sowohl von
 * `recall` als auch von `recallHybrid` aufgerufen, damit der Filter an
 * einer Stelle gepflegt wird. `r` ist ein MiniSearch-`SearchResult`, das
 * via `storeFields` die gespeicherten Doc-Properties als beliebige
 * Keys mit-trägt — daher das `Record<string, unknown>`-Typing hier.
 */
function passesRecallFilters(
  r: Record<string, unknown>,
  opts: RecallOptions,
): boolean {
  if (r.obsolete) return false;
  if (opts.scope && r.scope !== opts.scope) return false;
  if (opts.type && r.type !== opts.type) return false;
  if (!opts.allow_private && r.sensitivity === "private") return false;
  return true;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// MARK: - Lifecycle-Reranking (#74)

/**
 * Default-Verfallszeit pro Memory-Type. Identisch zu
 * `Sources/Bastra/MemoryLifecycle.swift:defaultExpirationDays` — bei
 * Änderungen beide Stellen mitziehen.
 * `null` = Type altert nie automatisch (Bookmarks, Documents,
 * Preferences, References).
 */
const DEFAULT_EXPIRATION_DAYS: Record<string, number | null> = {
  lesson: 180,
  decision: 365,
  "project-fact": 90,
  "meta-working": 365,
  workflow: 180,
  preference: null,
  "user-preference": null,
  reference: null,
  bookmark: null,
  doc: null,
};

const AGING_THRESHOLD_FRACTION = 0.75;

/**
 * Score-Multiplier basierend auf der Staleness (#74). Wird nach allen
 * anderen Filtern in `recall`/`recallHybrid` auf den finalen Hit-Score
 * angewandt — stale Memories ranken niedriger, expired noch niedriger.
 */
export type StaleStatus = "fresh" | "aging" | "stale" | "expired";

const STALE_MULTIPLIERS: Record<StaleStatus, number> = {
  fresh: 1.0,
  aging: 0.85,
  stale: 0.5,
  expired: 0.2,
};

export function computeStaleness(
  fm: Record<string, unknown>,
  now: Date = new Date(),
): StaleStatus {
  const updated = parseDateValue(fm.updated);
  const lastReviewed = parseDateValue(fm.last_reviewed_at);
  const touch = Math.max(updated ?? 0, lastReviewed ?? 0);

  const validUntil = parseDateValue(fm.valid_until);
  if (validUntil != null) {
    if (now.getTime() >= validUntil) return "expired";
    const total = validUntil - touch;
    const elapsed = now.getTime() - touch;
    if (total > 0 && elapsed / total >= AGING_THRESHOLD_FRACTION) {
      return "aging";
    }
    return "fresh";
  }

  const type = String(fm.type ?? "");
  const userOverride =
    typeof fm.expires_after_days === "number" ? (fm.expires_after_days as number) : null;
  const typeDefault =
    type in DEFAULT_EXPIRATION_DAYS ? DEFAULT_EXPIRATION_DAYS[type] : null;
  const days = userOverride ?? typeDefault;
  if (days == null || days <= 0) return "fresh";

  if (touch <= 0) return "fresh";
  const secondsSinceTouch = (now.getTime() - touch) / 1000;
  const staleSeconds = days * 86400;
  if (secondsSinceTouch <= 0) return "fresh";
  const ratio = secondsSinceTouch / staleSeconds;
  if (ratio >= 1.5) return "expired";
  if (ratio >= 1.0) return "stale";
  if (ratio >= AGING_THRESHOLD_FRACTION) return "aging";
  return "fresh";
}

function parseDateValue(raw: unknown): number | null {
  if (raw == null) return null;
  // YAML kann `2026-05-12` als Date entlocken — wir akzeptieren beides.
  if (raw instanceof Date) return raw.getTime();
  if (typeof raw === "string" && raw.length > 0) {
    const t = Date.parse(raw);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/**
 * „Touch-Timestamp" einer Memory: jüngeres aus `updated` und
 * `last_reviewed_at`. Wird vom Staleness-Cache (#29) als Identitäts-
 * Stempel benutzt — ändert sich der touchTs, wird der Cache-Eintrag
 * neu berechnet, auch ohne Vault-Event (z.B. wenn die Mac-App die
 * Frontmatter direkt patcht).
 */
function computeTouchTs(fm: Record<string, unknown>): number {
  const updated = parseDateValue(fm.updated) ?? 0;
  const lastReviewed = parseDateValue(fm.last_reviewed_at) ?? 0;
  return Math.max(updated, lastReviewed);
}

/**
 * Wendet den Staleness-Multiplier auf einen Hit-Score an. Daemon nutzt
 * die `vault.get(id).fm` als Quelle für das Frontmatter — die Computation
 * läuft lazy beim Recall (kein File-Write).
 */
export function applyStalenessMultiplier(
  hits: RecallHit[],
  resolveFrontmatter: (id: string) => Record<string, unknown> | undefined,
  now: Date = new Date(),
): RecallHit[] {
  for (const h of hits) {
    const fm = resolveFrontmatter(h.id);
    if (!fm) continue;
    const status = computeStaleness(fm, now);
    const mult = STALE_MULTIPLIERS[status];
    if (mult !== 1.0) {
      h.score = round(h.score * mult);
    }
  }
  // Re-sort nach möglicher Score-Anpassung. Direct-Hits vor 1-hop-Hits
  // bleiben aber Gruppe — wir sortieren INNERHALB jeder Gruppe.
  const direct = hits.filter((h) => h.hop !== "1-hop");
  const hops = hits.filter((h) => h.hop === "1-hop");
  direct.sort((a, b) => b.score - a.score);
  hops.sort((a, b) => b.score - a.score);
  return [...direct, ...hops];
}
