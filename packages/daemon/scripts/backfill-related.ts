/**
 * Backfill für `related[]` und `related_via[]` über den gesamten Vault.
 *
 * Hintergrund: bis Mai 2026 hat der OSS-Stack nur das Schema-Feld definiert
 * — befüllt wurde es nie (Auto-Detection lebte angeblich in der Mac-App,
 * existiert dort de facto auch nicht). Folge: Multi-Hop-Recall war tot.
 *
 * Dieses Skript läuft einmalig (idempotent — kann beliebig oft laufen):
 *
 *   Pass A — Wikilinks: für jedes Memory `[[id]]`-Referenzen im Body
 *            extrahieren, mit `related[]` mergen, ggf. File rewriten.
 *
 *   Pass B — Embeddings: EmbeddingIndex starten, auf Backfill warten, dann
 *            für jedes Memory `RelatedEnricher.enrich()` aufrufen (top-5
 *            Cosine-Nachbarn ≥ 0.7 nach `related_via[]` schreiben).
 *
 * Beide Passes sind idempotent — sie schreiben nur, wenn sich am id-Set
 * tatsächlich etwas ändert.
 *
 * Run:
 *   BASTRA_VAULT_PATH=… BASTRA_EMBEDDING_PROVIDER=ollama \
 *     tsx scripts/backfill-related.ts
 *
 * Flags via Env:
 *   BASTRA_RELATED_TOP_N        (default 5)
 *   BASTRA_RELATED_THRESHOLD    (default 0.7)
 *   BACKFILL_SKIP_WIKILINKS=1   (Pass A überspringen)
 *   BACKFILL_SKIP_EMBEDDINGS=1  (Pass B überspringen)
 *   BACKFILL_DRY_RUN=1          (nur reporten, nichts schreiben)
 */
import {
  Vault,
  EmbeddingIndex,
  OpenAIEmbeddingProvider,
  OllamaEmbeddingProvider,
  RelatedEnricher,
  extractWikilinks,
  type EmbeddingProvider,
} from "@bastra-recall/core";
import { readFile, writeFile } from "node:fs/promises";
import matter from "gray-matter";
import * as path from "node:path";

const VAULT = process.env.BASTRA_VAULT_PATH ?? process.env.NEXUS_VAULT_PATH;
if (!VAULT) {
  console.error("[bastra-recall.backfill] BASTRA_VAULT_PATH ist nicht gesetzt — abort.");
  process.exit(2);
}

const DRY_RUN = envBool("BACKFILL_DRY_RUN", false);
const SKIP_WIKILINKS = envBool("BACKFILL_SKIP_WIKILINKS", false);
const SKIP_EMBEDDINGS = envBool("BACKFILL_SKIP_EMBEDDINGS", false);
const TOP_N = envInt("BASTRA_RELATED_TOP_N", 5);
const THRESHOLD = envFloat("BASTRA_RELATED_THRESHOLD", 0.7);

async function main(): Promise<void> {
  console.error(`[bastra-recall.backfill] vault: ${VAULT}${DRY_RUN ? "  (dry-run)" : ""}`);
  const vault = new Vault(VAULT!);
  const { loaded, skipped } = await vault.init();
  console.error(`[bastra-recall.backfill] loaded ${loaded} memories, skipped ${skipped.length}`);

  const validIds = new Set(vault.list().map((m) => m.fm.id));

  // ── Pass A: Wikilinks → related[] ─────────────────────────────
  if (!SKIP_WIKILINKS) {
    let updatedA = 0;
    let deadLinks = 0;
    for (const mem of vault.list()) {
      const bodyLinks = extractWikilinks(mem.body);
      if (bodyLinks.length === 0) continue;

      const existing = mem.fm.related ?? [];
      const merged: string[] = [];
      const seen = new Set<string>();
      for (const id of [...existing, ...bodyLinks]) {
        if (id === mem.fm.id) continue;
        if (!validIds.has(id)) {
          deadLinks++;
          continue; // tote Wikilinks droppen wir
        }
        if (seen.has(id)) continue;
        seen.add(id);
        merged.push(id);
      }

      if (sameStringSet(existing, merged)) continue;
      if (!DRY_RUN) await rewriteFrontmatterField(mem.filePath, "related", merged);
      updatedA++;
      console.error(`  A  ${mem.fm.id}: +${merged.length - existing.length} link(s)`);
    }
    console.error(
      `[bastra-recall.backfill] Pass A: ${updatedA} files updated, ${deadLinks} dead wikilinks dropped`,
    );
  } else {
    console.error("[bastra-recall.backfill] Pass A: skipped");
  }

  // ── Pass B: Embeddings → related_via[] ────────────────────────
  if (SKIP_EMBEDDINGS) {
    console.error("[bastra-recall.backfill] Pass B: skipped");
    await vault.stop();
    process.exit(0);
  }

  const provider = pickEmbeddingProvider();
  if (!provider) {
    console.error(
      "[bastra-recall.backfill] Pass B: kein EmbeddingProvider verfügbar — abort. " +
        "Setz BASTRA_EMBEDDING_PROVIDER=ollama oder openai.",
    );
    await vault.stop();
    process.exit(1);
  }

  const persistPath = path.join(VAULT!, ".bastra", "embeddings.json");
  const embIdx = new EmbeddingIndex(vault, provider, persistPath);
  await embIdx.start();
  console.error(
    `[bastra-recall.backfill] embeddings: ${embIdx.size()} ready, ${embIdx.pendingSize()} pending`,
  );

  // Warten bis alle pending embeddings durch sind. Poll alle 500ms, max 5min.
  const deadline = Date.now() + 5 * 60 * 1000;
  while (embIdx.pendingSize() > 0 && Date.now() < deadline) {
    await sleep(500);
  }
  if (embIdx.pendingSize() > 0) {
    console.error(
      `[bastra-recall.backfill] WARN: ${embIdx.pendingSize()} embeddings noch pending nach 5min — weiter mit was da ist.`,
    );
  }
  console.error(`[bastra-recall.backfill] embeddings: ${embIdx.size()} ready (alle backfilled)`);

  // RelatedEnricher fürs Schreiben nutzen — aber im DRY_RUN nur reporten.
  let updatedB = 0;
  if (DRY_RUN) {
    for (const mem of vault.list()) {
      const similar = embIdx.findSimilarById(mem.fm.id, TOP_N * 2);
      if (!similar) continue;
      const filtered = similar.filter((h) => h.score >= THRESHOLD).slice(0, TOP_N);
      if (filtered.length === 0) continue;
      const existing = (mem.fm as { related_via?: { id: string }[] }).related_via ?? [];
      if (sameStringSet(existing.map((e) => e.id), filtered.map((f) => f.id))) continue;
      updatedB++;
      console.error(
        `  B  ${mem.fm.id}: → ${filtered.map((f) => `${f.id}(${f.score.toFixed(2)})`).join(", ")}`,
      );
    }
  } else {
    const enricher = new RelatedEnricher(vault, embIdx, {
      topN: TOP_N,
      threshold: THRESHOLD,
    });
    for (const mem of vault.list()) {
      const result = await enricher.enrich(mem.fm.id);
      if (result === null) continue;
      updatedB++;
      console.error(
        `  B  ${mem.fm.id}: → ${result.map((r) => `${r.id}(${r.score.toFixed(2)})`).join(", ") || "(geleert)"}`,
      );
    }
  }
  console.error(`[bastra-recall.backfill] Pass B: ${updatedB} files updated`);

  embIdx.stop();
  await vault.stop();
  process.exit(0);
}

// ─── helpers ───────────────────────────────────────────────────

async function rewriteFrontmatterField(
  filePath: string,
  field: string,
  value: unknown,
): Promise<void> {
  const raw = await readFile(filePath, "utf8");
  const parsed = matter(raw);
  const fm = parsed.data as Record<string, unknown>;
  fm[field] = value;
  const next = matter.stringify(
    parsed.content.startsWith("\n") ? parsed.content : `\n${parsed.content}`,
    fm,
  );
  await writeFile(filePath, next, "utf8");
}

function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const aSet = new Set(a);
  for (const x of b) if (!aSet.has(x)) return false;
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function pickEmbeddingProvider(): EmbeddingProvider | null {
  const requested = (process.env.BASTRA_EMBEDDING_PROVIDER ?? "").toLowerCase();
  const apiKey = process.env.OPENAI_API_KEY ?? process.env.BASTRA_EMBEDDING_KEY;
  if (requested === "none") return null;
  if (requested === "ollama") {
    const baseURL = process.env.BASTRA_OLLAMA_URL ?? "http://localhost:11434";
    const model = process.env.BASTRA_EMBEDDING_MODEL ?? "embeddinggemma";
    const dimEnv = process.env.BASTRA_EMBEDDING_DIM;
    const dim = dimEnv ? Number.parseInt(dimEnv, 10) : undefined;
    return new OllamaEmbeddingProvider({ baseURL, model, dim });
  }
  if (requested === "openai") {
    if (!apiKey) return null;
    return new OpenAIEmbeddingProvider({ apiKey });
  }
  if (apiKey) return new OpenAIEmbeddingProvider({ apiKey });
  return null;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return !["0", "false", "off", "no"].includes(raw.toLowerCase());
}

main().catch((err) => {
  console.error("[bastra-recall.backfill] FATAL:", err);
  process.exit(1);
});
