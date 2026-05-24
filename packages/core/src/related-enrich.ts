/**
 * Auto-Related-Enricher — pflegt `frontmatter.related_via` UND eine markierte
 * Body-Section mit `[[id]]`-Wikilinks automatisch via Embedding-Similarity.
 *
 * Warum beide Stellen?
 *   - `frontmatter.related_via[]` ist strukturiert (id + reason + score) und
 *     dient unserem Multi-Hop-Recall in search.ts.
 *   - Body-Wikilinks zwischen den Auto-Markern werden vom Obsidian-Graph als
 *     Edges erkannt. Wir wollen Obsidian sauber unterstützen, sonst hätten
 *     wir ein eigenes UI bauen können.
 *
 * Pipeline:
 *   EmbeddingIndex.onEmbed(id)
 *     → findSimilarById(id, topN+self)
 *     → cosine ≥ threshold filtern
 *     → mit existing related_via UND existing body-section vergleichen
 *     → wenn etwas abweicht: file rewrite (frontmatter + body), vault.reindexFile
 *
 * Loop-Prevention:
 *   Der reindex triggert ein neues Embed (Body hat sich geändert). Das zweite
 *   Embed liefert dasselbe Similarity-Set → sameIdSet UND sameBody → no-op.
 *   Kein File-Write, kein Loop. (Score-Rundung ist deterministisch über
 *   .toFixed(3), also vergleichbar.)
 */
import { readFile, writeFile } from "node:fs/promises";
import matter from "gray-matter";
import type { Vault } from "./vault.js";
import type { EmbeddingIndex } from "./embeddings.js";
import { AUTO_RELATED_START, AUTO_RELATED_END, stripAutoRelatedSection } from "./save.js";

export interface RelatedEnricherOptions {
  /** Wieviele Nachbarn maximal nach related_via schreiben. Default 5. */
  topN?: number;
  /** Cosine-Schwellwert, unterhalb dessen Nachbarn nicht aufgenommen werden.
   *  Bei embeddinggemma (multilingual) ist 0.7 streng, 0.6 großzügig. Default
   *  0.7 — lieber wenige präzise Links als viele Halb-Treffer (Multi-Hop
   *  würde sonst rauschen). */
  threshold?: number;
}

interface RelatedViaEntry {
  id: string;
  reason: string;
  score: number;
}

export class RelatedEnricher {
  private detach?: () => void;
  private readonly topN: number;
  private readonly threshold: number;

  constructor(
    private readonly vault: Vault,
    private readonly embeddings: EmbeddingIndex,
    opts: RelatedEnricherOptions = {},
  ) {
    this.topN = opts.topN ?? 5;
    this.threshold = opts.threshold ?? 0.7;
  }

  start(): void {
    if (this.detach) return;
    this.detach = this.embeddings.onEmbed((id) => {
      void this.enrich(id);
    });
  }

  stop(): void {
    this.detach?.();
    this.detach = undefined;
  }

  /** Berechnet related_via + Body-Wikilink-Section für ein Memory und
   *  schreibt das File neu, wenn sich Frontmatter ODER Body-Section ändern.
   *  Liefert die geschriebenen Einträge zurück, oder `null` wenn nichts zu
   *  tun war. */
  async enrich(id: string): Promise<RelatedViaEntry[] | null> {
    const memory = this.vault.get(id);
    if (!memory) return null;

    const similar = this.embeddings.findSimilarById(id, this.topN * 2);
    if (!similar) return null; // Vector noch nicht da

    const filtered = similar
      .filter((h) => h.score >= this.threshold)
      .slice(0, this.topN)
      .map<RelatedViaEntry>((h) => ({
        id: h.id,
        reason: `cosine ${h.score.toFixed(3)}`,
        score: Number(h.score.toFixed(3)),
      }));

    const existing = (memory.fm as { related_via?: RelatedViaEntry[] }).related_via ?? [];
    const sameVia = sameIdSet(existing, filtered);

    const expectedBody = rebuildBodyWithAutoSection(memory.body, filtered);
    const sameBody = memory.body === expectedBody;

    if (sameVia && sameBody) return null;

    await rewriteFile(memory.filePath, filtered, expectedBody);
    await this.vault.reindexFile(memory.filePath);
    return filtered;
  }
}

function sameIdSet(a: RelatedViaEntry[], b: RelatedViaEntry[]): boolean {
  if (a.length !== b.length) return false;
  const aIds = new Set(a.map((e) => e.id));
  for (const e of b) if (!aIds.has(e.id)) return false;
  return true;
}

/**
 * Baut den Body so, dass die Auto-Related-Section am Ende exakt die
 * übergebenen Einträge spiegelt. Existierende Section wird ersetzt. Bei
 * leerer Liste wird die Section komplett entfernt — der „kein guter
 * Nachbar"-Zustand soll keinen toten Block hinterlassen.
 */
function rebuildBodyWithAutoSection(
  body: string,
  entries: RelatedViaEntry[],
): string {
  const stripped = stripAutoRelatedSection(body).replace(/\n+$/, "");
  if (entries.length === 0) {
    return stripped.length > 0 ? stripped + "\n" : "";
  }
  const lines = [
    "",
    "",
    `## Auto-Related ${AUTO_RELATED_START}`,
    "",
    ...entries.map((e) => `- [[${e.id}]] (cosine ${e.score.toFixed(2)})`),
    "",
    AUTO_RELATED_END,
    "",
  ];
  return stripped + lines.join("\n");
}

async function rewriteFile(
  filePath: string,
  related_via: RelatedViaEntry[],
  newBody: string,
): Promise<void> {
  const raw = await readFile(filePath, "utf8");
  const parsed = matter(raw);
  const fm = parsed.data as Record<string, unknown>;
  fm.related_via = related_via;
  const next = matter.stringify(
    newBody.startsWith("\n") ? newBody : `\n${newBody}`,
    fm,
  );
  await writeFile(filePath, next, "utf8");
}
