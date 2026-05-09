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
}

export interface RecallOptions {
  k?: number;
  scope?: string; // exact-match filter
  type?: string; // exact-match filter
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
    const raw = this.mini.search(query);

    const filtered = raw.filter((r) => {
      // hide obsolete by default
      if (r.obsolete) return false;
      if (opts.scope && r.scope !== opts.scope) return false;
      if (opts.type && r.type !== opts.type) return false;
      return true;
    });

    return filtered.slice(0, k).map((r) => ({
      id: r.id as string,
      title: r.title as string,
      type: r.type as string,
      scope: r.scope as string,
      summary: r.summary as string,
      topic_path: r.topic_path as string[],
      score: round(r.score),
      matched_terms: r.terms ?? [],
      mode: "bm25" as const,
    }));
  }

  /** Hybrid-Recall: BM25 + Vector via Reciprocal-Rank-Fusion. Wenn kein
   *  EmbeddingIndex registriert ist, fällt auf reines BM25 (sync) zurück.
   *  Der finale Score ist auf 0–1000 skaliert (RRF * 1000) damit das
   *  Hook-Score-Threshold (≥100 = REQUIRED) sinnvoll greift. */
  async recallHybrid(query: string, opts: RecallOptions = {}): Promise<RecallHit[]> {
    if (!this.embeddings) return this.recall(query, opts);
    const k = opts.k ?? 5;
    if (!query.trim()) return [];

    // BM25 — top 50 für RRF-Pool.
    const bm25 = this.mini.search(query).filter((r) => {
      if (r.obsolete) return false;
      if (opts.scope && r.scope !== opts.scope) return false;
      if (opts.type && r.type !== opts.type) return false;
      return true;
    });
    const bm25Top = bm25.slice(0, 50);

    // Vector — top 50 für RRF-Pool, plus type/scope-Filter über vault.
    const vec = await this.embeddings.search(query, 100);
    const vectorTop = vec
      .map((h) => ({ hit: h, mem: this.vault.get(h.id) }))
      .filter(({ mem }) => {
        if (!mem) return false;
        if (mem.fm.obsolete === true) return false;
        if (opts.scope && mem.fm.scope !== opts.scope) return false;
        if (opts.type && mem.fm.type !== opts.type) return false;
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
    const out: RecallHit[] = [];
    for (const [id, fusedScore] of sorted) {
      if (out.length >= k) break;
      const bm = bm25Lookup.get(id);
      const v = vectorLookup.get(id);
      const mem = v?.mem ?? this.vault.get(id);
      if (!mem) continue;
      const fm = mem.fm;
      const inBoth = bm !== undefined && v !== undefined;
      out.push({
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
      });
    }
    return out;
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
      try {
        this.mini.discard(e.id);
      } catch {
        // not indexed; ignore
      }
      return;
    }
    if (e.kind === "change") {
      try {
        this.mini.discard(e.memory.fm.id);
      } catch {
        // first time; treat as add
      }
    }
    this.indexOne(e.memory);
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
    };
    this.mini.add(doc);
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
