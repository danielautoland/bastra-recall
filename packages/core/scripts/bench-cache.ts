/**
 * Micro-Bench für die Recall-Caches (#29 + #30).
 *
 * Generiert einen synthetischen Vault auf Disk (default 1000 Memorys
 * mit gemischten Types und touchTs), startet SearchIndex, und misst:
 *  - 10k Recalls mit 20 distinct Queries (Cache-WARM-Pfad)
 *  - 10k Recalls mit 10k distinct Queries (Cache-COLD-Pfad)
 *  - Vergleichsmessung gegen den freistehenden `applyStalenessMultiplier`
 *    (HEAD-Pfad ohne Per-Memory-Cache)
 *
 * Run: `npx tsx packages/core/scripts/bench-cache.ts`
 *      `BENCH_VAULT_SIZE=10000 npx tsx packages/core/scripts/bench-cache.ts`
 */
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Vault, SearchIndex } from "../src/index.js";
import { applyStalenessMultiplier } from "../src/search.js";

const VAULT_SIZE = Number(process.env.BENCH_VAULT_SIZE ?? 1000);
const RECALL_COUNT = Number(process.env.BENCH_RECALL_COUNT ?? 10_000);
const HOT_QUERY_COUNT = 20;

const WORDS = [
  "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf",
  "hotel", "india", "juliet", "kilo", "lima", "mike", "november",
  "oscar", "papa", "quebec", "romeo", "sierra", "tango", "uniform",
  "victor", "whiskey", "xray", "yankee", "zulu",
];

const TYPES = ["lesson", "decision", "project-fact", "reference", "preference"];

function pick<T>(arr: T[], i: number): T {
  return arr[i % arr.length]!;
}

function memoryMarkdown(i: number): string {
  const type = pick(TYPES, i);
  const w1 = pick(WORDS, i);
  const w2 = pick(WORDS, i * 7);
  const w3 = pick(WORDS, i * 13);
  // Mische frische und 200d alte Memorys damit der Staleness-Pfad
  // nicht durchgängig fresh ist.
  const ageDays = i % 5 === 0 ? 200 : i % 3;
  const ts = new Date(Date.now() - ageDays * 86400_000).toISOString();
  return [
    "---",
    `id: bench-${i}`,
    `title: ${w1} ${w2} ${i}`,
    `type: ${type}`,
    `summary: ${w1} ${w2} ${w3} probe`,
    "topic_path:",
    "  - bench",
    `  - ${type}`,
    "tags:",
    "  - bench",
    `  - ${w1}`,
    "scope: bench-scope",
    "recall_when:",
    `  - ${w1} ${w2}`,
    `  - ${w3}`,
    `created: ${ts}`,
    `updated: ${ts}`,
    "---",
    "",
    `Body for ${w1} ${w2} ${w3}. Lorem ipsum.`,
    "",
  ].join("\n");
}

interface BenchResult {
  label: string;
  totalMs: number;
  perCallUs: number;
  recalls: number;
}

async function setup(): Promise<{ vault: Vault; idx: SearchIndex; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-bench-"));
  for (let i = 0; i < VAULT_SIZE; i++) {
    await writeFile(join(dir, `bench-${i}.md`), memoryMarkdown(i), "utf8");
  }
  const vault = new Vault(dir);
  await vault.init();
  const idx = new SearchIndex(vault);
  idx.start();
  return { vault, idx, dir };
}

function bench(label: string, n: number, fn: (i: number) => void): BenchResult {
  // Warmup
  for (let i = 0; i < Math.min(50, n); i++) fn(i);
  const t0 = performance.now();
  for (let i = 0; i < n; i++) fn(i);
  const totalMs = performance.now() - t0;
  return {
    label,
    totalMs,
    perCallUs: (totalMs * 1000) / n,
    recalls: n,
  };
}

function printResult(r: BenchResult): void {
  console.log(
    `  ${r.label.padEnd(48)}  total ${r.totalMs.toFixed(1).padStart(8)} ms` +
      `  |  per call ${r.perCallUs.toFixed(2).padStart(8)} µs` +
      `  (n=${r.recalls})`,
  );
}

async function main(): Promise<void> {
  console.log(
    `[bench] vault=${VAULT_SIZE} memorys, recall_count=${RECALL_COUNT}`,
  );
  const t0 = performance.now();
  const { vault, idx, dir } = await setup();
  console.log(`[bench] indexed ${idx.size()} memorys in ${(performance.now() - t0).toFixed(0)} ms`);
  console.log();

  // ─── #30 Query-Cache ──────────────────────────────────────────
  console.log("Query-Tokenizer-Cache (#30):");

  // Cold: unique queries → cache miss every time.
  const coldQueries = Array.from({ length: RECALL_COUNT }, (_, i) =>
    `${pick(WORDS, i)} ${pick(WORDS, i * 11)} ${i}`,
  );
  const cold = bench(
    "cold path (unique queries, miss every call)",
    RECALL_COUNT,
    (i) => {
      idx.recall(coldQueries[i % coldQueries.length]!, { k: 5 });
    },
  );
  printResult(cold);

  // Hot: 20 queries cycled → cache hits after first 20.
  const hotQueries = Array.from({ length: HOT_QUERY_COUNT }, (_, i) =>
    `${pick(WORDS, i)} ${pick(WORDS, i * 11)}`,
  );
  // Wir resetten den Cache explizit um die Hits zu zeigen.
  (idx as unknown as { queryCache: Map<string, unknown> }).queryCache.clear();
  const hot = bench(
    "hot path (20 cycled queries, mostly cache-hit)",
    RECALL_COUNT,
    (i) => {
      idx.recall(hotQueries[i % HOT_QUERY_COUNT]!, { k: 5 });
    },
  );
  printResult(hot);
  console.log(
    `  → hot/cold speedup: ${(cold.perCallUs / hot.perCallUs).toFixed(1)}×`,
  );

  console.log();

  // ─── #29 Staleness-Cache ──────────────────────────────────────
  console.log("Staleness-Cache (#29):");

  // Reset query cache so the staleness comparison is not skewed.
  (idx as unknown as { queryCache: Map<string, unknown> }).queryCache.clear();
  (idx as unknown as { stalenessCache: Map<string, unknown> }).stalenessCache.clear();

  // Pre-fetch ein hit set (5 hits) damit wir applyStaleness direkt messen.
  const sampleHits = idx.recall("alpha", { k: 5 });
  if (sampleHits.length === 0) {
    console.error("no sample hits — vault generation issue?");
  }
  console.log(`  (sample hit count: ${sampleHits.length})`);

  // HEAD-Pfad: freistehende applyStalenessMultiplier ohne Cache.
  const head = bench(
    "applyStalenessMultiplier (HEAD, no per-memory cache)",
    RECALL_COUNT,
    () => {
      // Kopie der Hits weil die Funktion das Array mutiert / re-sorted.
      const hits = sampleHits.map((h) => ({ ...h }));
      applyStalenessMultiplier(hits, (id) => vault.get(id)?.fm as Record<string, unknown> | undefined);
    },
  );
  printResult(head);

  // Cached: SearchIndex.applyStaleness via private cast.
  const applyStalenessCached = (
    idx as unknown as { applyStaleness: (hits: unknown[]) => unknown[] }
  ).applyStaleness.bind(idx);
  // Warmup damit der Staleness-Cache gefüllt ist.
  applyStalenessCached(sampleHits.map((h) => ({ ...h })));
  const cached = bench(
    "SearchIndex.applyStaleness (cached, this PR)",
    RECALL_COUNT,
    () => {
      const hits = sampleHits.map((h) => ({ ...h }));
      applyStalenessCached(hits);
    },
  );
  printResult(cached);
  console.log(
    `  → cached/HEAD speedup: ${(head.perCallUs / cached.perCallUs).toFixed(1)}×`,
  );

  console.log();
  console.log("[bench] cleanup …");
  idx.stop();
  await vault.stop();
  await rm(dir, { recursive: true, force: true });
  console.log("[bench] done.");
}

main().catch((err) => {
  console.error("[bench] FATAL:", err);
  process.exit(1);
});
