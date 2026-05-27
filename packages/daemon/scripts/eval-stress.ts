#!/usr/bin/env tsx
/**
 * M0.5 — recall stress-test harness (Issues #2 + #8).
 *
 * Builds on top of the M0 baseline in scripts/eval.ts. The M0 eval used each
 * memory's own recall_when phrase as the query — a trivially easy case. This
 * harness exercises three realistic failure modes:
 *
 *   1. paraphrased — query reformulated so it shares ZERO literal tokens
 *      with the original recall_when. Pass: Recall@3 >= 0.7.
 *   2. cross-memory — single query that should surface 2-4 distinct memories
 *      all in top-k. Optional: a `oneHop` slice for `related_via` neighbors
 *      that should only show up when `expand_hops: 1` is set.
 *   3. anti-hallucination — query for a topic that is NOT in the vault. The
 *      top-1 score must stay in the noise band (configurable cutoff).
 *
 * Usage:
 *   BASTRA_VAULT_PATH=/path/to/vault npx tsx scripts/eval-stress.ts \
 *     --slice all              # default: paraphrased,cross,anti
 *     --slice paraphrased      # single slice
 *     --out report.json        # also write a JSON report (no markdown)
 *     --cutoff 80              # noise cutoff for anti slice (default 80)
 *     --hybrid                 # use SearchIndex.recallHybrid (needs embeddings)
 *
 * When `--slice all` runs, the harness additionally writes a markdown
 * report to scripts/stress-report.md with a comparison to M0.
 *
 * Exit code: 0 on pass, 1 on fail. "Pass" = all three configured slices
 * pass their respective thresholds.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Vault, SearchIndex } from "@bastra-recall/core";
import type { RecallHit, RecallOptions } from "@bastra-recall/core";
import { PARAPHRASED_CASES } from "./stress-fixtures/paraphrased.js";
import { CROSS_MEMORY_CASES } from "./stress-fixtures/cross-memory.js";
import { ANTI_HALLUCINATION_CASES } from "./stress-fixtures/anti-hallucination.js";

// ── CLI parsing ────────────────────────────────────────────────

interface Args {
  slices: Slice[];
  out: string | null;
  cutoff: number;
  hybrid: boolean;
}

type Slice = "paraphrased" | "cross" | "anti";

function parseArgs(argv: string[]): Args {
  const args: Args = {
    slices: ["paraphrased", "cross", "anti"],
    out: null,
    cutoff: 80,
    hybrid: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--slice") {
      const v = argv[++i];
      if (!v) throw new Error("--slice needs a value");
      if (v === "all") {
        args.slices = ["paraphrased", "cross", "anti"];
      } else {
        const parts = v.split(",") as Slice[];
        for (const p of parts) {
          if (!["paraphrased", "cross", "anti"].includes(p)) {
            throw new Error(`unknown slice: ${p}`);
          }
        }
        args.slices = parts;
      }
    } else if (a === "--out") {
      args.out = argv[++i] ?? null;
    } else if (a === "--cutoff") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n)) throw new Error("--cutoff must be a number");
      args.cutoff = n;
    } else if (a === "--hybrid") {
      args.hybrid = true;
    } else if (a === "-h" || a === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown flag: ${a}`);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(
    `eval-stress — recall stress-test harness (Issues #2 + #8)

Flags:
  --slice paraphrased|cross|anti|all   default: all
  --out report.json                    write JSON report
  --cutoff 80                          anti-slice noise cutoff (default 80)
  --hybrid                             use SearchIndex.recallHybrid (BM25+vector)
  -h, --help                           this message

Env:
  BASTRA_VAULT_PATH (required)         path to the markdown vault
`,
  );
}

// ── Search wrapper (sync BM25 by default, async hybrid optional) ───

type Recaller = (query: string, opts?: RecallOptions) => Promise<RecallHit[]>;

function makeRecaller(search: SearchIndex, hybrid: boolean): Recaller {
  if (hybrid && search.hasEmbeddings()) {
    return (q, opts) => search.recallHybrid(q, opts);
  }
  return async (q, opts) => search.recall(q, opts);
}

// ── Slice 1: paraphrased ───────────────────────────────────────

interface ParaphrasedResult {
  goldId: string;
  label: string;
  paraphrase: string;
  rank: number; // 0 = miss
  topId: string;
  topScore: number;
  goldScore: number; // 0 if not in top-10
}

interface ParaphrasedSummary {
  total: number;
  unknownIds: string[];
  recallAt1: number;
  recallAt3: number;
  mrr: number;
  perMemory: Map<string, { hits: number; tests: number }>;
  rows: ParaphrasedResult[];
  pass: boolean;
}

async function runParaphrased(
  vault: Vault,
  recall: Recaller,
): Promise<ParaphrasedSummary> {
  const knownIds = new Set(vault.list().map((m) => m.fm.id));
  const unknownIds: string[] = [];
  const rows: ParaphrasedResult[] = [];
  const perMemory = new Map<string, { hits: number; tests: number }>();

  for (const c of PARAPHRASED_CASES) {
    if (!knownIds.has(c.id)) {
      unknownIds.push(c.id);
      continue;
    }
    const slot = perMemory.get(c.id) ?? { hits: 0, tests: 0 };
    for (const p of c.paraphrases) {
      const hits = await recall(p, { k: 10 });
      const rank = hits.findIndex((h) => h.id === c.id);
      const goldHit = hits[rank];
      rows.push({
        goldId: c.id,
        label: c.label,
        paraphrase: p,
        rank: rank === -1 ? 0 : rank + 1,
        topId: hits[0]?.id ?? "(none)",
        topScore: hits[0]?.score ?? 0,
        goldScore: goldHit?.score ?? 0,
      });
      slot.tests++;
      if (rank !== -1 && rank < 3) slot.hits++;
    }
    perMemory.set(c.id, slot);
  }

  const total = rows.length;
  const top1 = rows.filter((r) => r.rank === 1).length;
  const top3 = rows.filter((r) => r.rank >= 1 && r.rank <= 3).length;
  const mrr = total === 0
    ? 0
    : rows.reduce((acc, r) => acc + (r.rank > 0 ? 1 / r.rank : 0), 0) / total;

  const recallAt3 = total === 0 ? 0 : top3 / total;
  return {
    total,
    unknownIds,
    recallAt1: total === 0 ? 0 : top1 / total,
    recallAt3,
    mrr,
    perMemory,
    rows,
    pass: recallAt3 >= 0.7,
  };
}

// ── Slice 2: cross-memory ──────────────────────────────────────

interface CrossResult {
  query: string;
  expected: string[];
  found: string[]; // ids in top-k order
  missing: string[];
  oneHopExpected: string[];
  oneHopFound: string[];
  oneHopMissing: string[];
  topScore: number;
  pass: boolean;
}

interface CrossSummary {
  total: number;
  passed: number;
  rows: CrossResult[];
  recallAtK: number;
  pass: boolean;
}

async function runCrossMemory(
  vault: Vault,
  recall: Recaller,
): Promise<CrossSummary> {
  const knownIds = new Set(vault.list().map((m) => m.fm.id));
  const rows: CrossResult[] = [];

  for (const c of CROSS_MEMORY_CASES) {
    const validExpected = c.expected.filter((id) => knownIds.has(id));
    const validOneHop = (c.oneHop ?? []).filter((id) => knownIds.has(id));
    const k = Math.max(4, validExpected.length);

    const directHits = await recall(c.query, { k });
    const foundDirect = directHits.map((h) => h.id);
    const missing = validExpected.filter((id) => !foundDirect.includes(id));

    let oneHopFound: string[] = [];
    if (validOneHop.length > 0) {
      const hopHits = await recall(c.query, { k, expand_hops: 1 });
      const hopIds = hopHits.map((h) => h.id);
      oneHopFound = validOneHop.filter((id) => hopIds.includes(id));
    }
    const oneHopMissing = validOneHop.filter((id) => !oneHopFound.includes(id));

    const pass = missing.length === 0 && oneHopMissing.length === 0;
    rows.push({
      query: c.query,
      expected: validExpected,
      found: foundDirect,
      missing,
      oneHopExpected: validOneHop,
      oneHopFound,
      oneHopMissing,
      topScore: directHits[0]?.score ?? 0,
      pass,
    });
  }

  const passed = rows.filter((r) => r.pass).length;
  const totalExpected = rows.reduce(
    (acc, r) => acc + r.expected.length + r.oneHopExpected.length,
    0,
  );
  const totalFound = rows.reduce(
    (acc, r) =>
      acc +
      (r.expected.length - r.missing.length) +
      (r.oneHopExpected.length - r.oneHopMissing.length),
    0,
  );
  const recallAtK = totalExpected === 0 ? 0 : totalFound / totalExpected;
  return {
    total: rows.length,
    passed,
    rows,
    recallAtK,
    pass: passed === rows.length,
  };
}

// ── Slice 3: anti-hallucination ────────────────────────────────

interface AntiResult {
  query: string;
  topScore: number;
  topId: string;
  note: string;
  underCutoff: boolean;
}

interface AntiSummary {
  total: number;
  underCutoff: number;
  cutoff: number;
  median: number;
  rows: AntiResult[];
  histogram: Map<string, number>;
  pass: boolean;
}

async function runAntiHallucination(
  vault: Vault,
  recall: Recaller,
  cutoff: number,
): Promise<AntiSummary> {
  const rows: AntiResult[] = [];
  for (const c of ANTI_HALLUCINATION_CASES) {
    const hits = await recall(c.query, { k: 3 });
    const top = hits[0];
    const topScore = top?.score ?? 0;
    rows.push({
      query: c.query,
      topScore,
      topId: top?.id ?? "(none)",
      note: c.note ?? "",
      underCutoff: topScore < cutoff,
    });
  }

  const sortedScores = [...rows.map((r) => r.topScore)].sort((a, b) => a - b);
  const median = sortedScores.length === 0
    ? 0
    : sortedScores[Math.floor(sortedScores.length / 2)] ?? 0;

  // Bucket histogram: 0-30, 30-60, 60-100, 100-150, >=150.
  const histogram = new Map<string, number>([
    ["0-30", 0],
    ["30-60", 0],
    ["60-100", 0],
    ["100-150", 0],
    [">=150", 0],
  ]);
  for (const r of rows) {
    if (r.topScore < 30) histogram.set("0-30", (histogram.get("0-30") ?? 0) + 1);
    else if (r.topScore < 60)
      histogram.set("30-60", (histogram.get("30-60") ?? 0) + 1);
    else if (r.topScore < 100)
      histogram.set("60-100", (histogram.get("60-100") ?? 0) + 1);
    else if (r.topScore < 150)
      histogram.set("100-150", (histogram.get("100-150") ?? 0) + 1);
    else histogram.set(">=150", (histogram.get(">=150") ?? 0) + 1);
  }

  const underCutoff = rows.filter((r) => r.underCutoff).length;
  // Pass when the *median* is under the cutoff. Individual outliers are
  // expected with BM25 + fuzzy + prefix matching on short generic tokens.
  return {
    total: rows.length,
    underCutoff,
    cutoff,
    median,
    rows,
    histogram,
    pass: median < cutoff,
  };
}

// ── Output helpers ─────────────────────────────────────────────

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function printParaphrased(s: ParaphrasedSummary): void {
  console.log("\n## Slice 1 — Paraphrased\n");
  console.log(
    `Cases: **${s.total}** across ${s.perMemory.size} memories  ·  Pass criterion: Recall@3 ≥ 0.7`,
  );
  if (s.unknownIds.length) {
    console.log(`\n_Skipped ${s.unknownIds.length} unknown ids:_`);
    for (const id of s.unknownIds) console.log(`  - ${id}`);
  }
  console.log(`\n- **Recall@1: ${pct(s.recallAt1)}**`);
  console.log(`- **Recall@3: ${pct(s.recallAt3)}**`);
  console.log(`- **MRR:      ${s.mrr.toFixed(3)}**`);
  console.log(`- Verdict:   ${s.pass ? "PASS" : "FAIL"}`);

  const misses = s.rows.filter((r) => r.rank === 0 || r.rank > 3);
  if (misses.length === 0) {
    console.log("\nNo misses.");
    return;
  }
  console.log(`\n### Misses (rank > 3 or not in top-10) — ${misses.length}\n`);
  console.log("| rank | gold | paraphrase | top hit (won) | top score |");
  console.log("|---|---|---|---|---:|");
  for (const r of misses) {
    console.log(
      `| ${r.rank || "—"} | \`${r.goldId}\` | ${truncate(r.paraphrase, 60)} | \`${r.topId}\` | ${r.topScore.toFixed(1)} |`,
    );
  }
}

function printCross(s: CrossSummary): void {
  console.log("\n## Slice 2 — Cross-Memory\n");
  console.log(
    `Cases: **${s.total}**  ·  Passed: **${s.passed}/${s.total}**  ·  Recall@k: **${pct(s.recallAtK)}**  ·  Verdict: ${s.pass ? "PASS" : "FAIL"}`,
  );
  console.log("\n| pass | query | expected | found | missing | 1-hop missing |");
  console.log("|:---:|---|---:|---:|---|---|");
  for (const r of s.rows) {
    const e = r.expected.length;
    const f = e - r.missing.length;
    console.log(
      `| ${r.pass ? "✓" : "×"} | ${truncate(r.query, 60)} | ${e} | ${f}/${e} | ${
        r.missing.length === 0 ? "—" : r.missing.map((id) => `\`${id}\``).join(" ")
      } | ${
        r.oneHopMissing.length === 0
          ? "—"
          : r.oneHopMissing.map((id) => `\`${id}\``).join(" ")
      } |`,
    );
  }
}

function printAnti(s: AntiSummary): void {
  console.log("\n## Slice 3 — Anti-Hallucination\n");
  console.log(
    `Cases: **${s.total}**  ·  Cutoff: **<${s.cutoff}**  ·  Median top-score: **${s.median.toFixed(1)}**  ·  Verdict: ${s.pass ? "PASS" : "FAIL"} (median < cutoff)`,
  );
  console.log(
    `\nIndividual cases under cutoff: **${s.underCutoff}/${s.total}** (${pct(s.underCutoff / s.total)}).`,
  );
  console.log("\n### Top-score histogram\n");
  console.log("| bucket | count |");
  console.log("|---|---:|");
  for (const [bucket, count] of s.histogram) {
    const bar = "█".repeat(count);
    console.log(`| ${bucket} | ${count} ${bar} |`);
  }
  console.log("\n### Per query\n");
  console.log("| query | top score | top hit | < cutoff |");
  console.log("|---|---:|---|:---:|");
  for (const r of s.rows) {
    console.log(
      `| ${truncate(r.query, 55)} | ${r.topScore.toFixed(1)} | \`${truncate(r.topId, 50)}\` | ${r.underCutoff ? "✓" : "×"} |`,
    );
  }
}

// ── Markdown report (combined, when --slice all) ────────────────

interface ReportInput {
  vaultPath: string;
  vaultSize: number;
  provider: string;
  para?: ParaphrasedSummary;
  cross?: CrossSummary;
  anti?: AntiSummary;
}

function buildMarkdownReport(r: ReportInput): string {
  const now = new Date().toISOString();
  const home = process.env.HOME ?? "";
  const displayPath =
    home && r.vaultPath.startsWith(home) ? "~" + r.vaultPath.slice(home.length) : r.vaultPath;
  const lines: string[] = [];
  lines.push(`# Bastra Recall — Stress Eval Report`);
  lines.push("");
  lines.push(`- **Run date:** ${now}`);
  lines.push(`- **Vault path:** \`${displayPath}\``);
  lines.push(`- **Vault size:** ${r.vaultSize} memories`);
  lines.push(`- **Search provider:** ${r.provider}`);
  lines.push("");
  lines.push(`## Comparison to M0 baseline`);
  lines.push("");
  lines.push(
    "M0 used each memory's own first `recall_when` as the query (trivial). " +
      "Stress-eval uses paraphrased queries with zero literal-token overlap.",
  );
  lines.push("");
  lines.push("| metric | M0 (own trigger) | Stress (paraphrased) |");
  lines.push("|---|---:|---:|");
  if (r.para) {
    lines.push(`| Recall@1 | 98.3% | ${pct(r.para.recallAt1)} |`);
    lines.push(`| Recall@3 | 100.0% | ${pct(r.para.recallAt3)} |`);
    lines.push(`| MRR      | 0.992 | ${r.para.mrr.toFixed(3)} |`);
  } else {
    lines.push("| Recall@1 | 98.3% | — |");
    lines.push("| Recall@3 | 100.0% | — |");
    lines.push("| MRR      | 0.992 | — |");
  }
  lines.push("");

  if (r.para) {
    lines.push("## Slice 1 — Paraphrased");
    lines.push("");
    lines.push(
      `- Cases: ${r.para.total} across ${r.para.perMemory.size} memories`,
    );
    lines.push(`- Recall@1: **${pct(r.para.recallAt1)}**`);
    lines.push(`- Recall@3: **${pct(r.para.recallAt3)}**`);
    lines.push(`- MRR: **${r.para.mrr.toFixed(3)}**`);
    lines.push(`- Pass criterion: Recall@3 ≥ 0.7`);
    lines.push(`- **Verdict: ${r.para.pass ? "PASS" : "FAIL"}**`);
    const misses = r.para.rows.filter((row) => row.rank === 0 || row.rank > 3);
    if (misses.length > 0) {
      lines.push("");
      lines.push(`### Misses — ${misses.length}`);
      lines.push("");
      lines.push("| rank | gold | paraphrase | top hit (won) |");
      lines.push("|---|---|---|---|");
      for (const m of misses) {
        lines.push(
          `| ${m.rank || "—"} | \`${m.goldId}\` | ${truncate(m.paraphrase, 60)} | \`${m.topId}\` |`,
        );
      }
    }
    if (r.para.unknownIds.length) {
      lines.push("");
      lines.push(`_Skipped unknown ids: ${r.para.unknownIds.length}_`);
    }
    lines.push("");
  }

  if (r.cross) {
    lines.push("## Slice 2 — Cross-Memory");
    lines.push("");
    lines.push(`- Cases: ${r.cross.total}`);
    lines.push(`- Passed: ${r.cross.passed}/${r.cross.total}`);
    lines.push(`- Aggregate Recall@k: **${pct(r.cross.recallAtK)}**`);
    lines.push(`- **Verdict: ${r.cross.pass ? "PASS" : "FAIL"}**`);
    lines.push("");
    lines.push("| pass | query | expected | found | missing |");
    lines.push("|:---:|---|---:|---:|---|");
    for (const row of r.cross.rows) {
      const e = row.expected.length;
      const f = e - row.missing.length;
      lines.push(
        `| ${row.pass ? "✓" : "×"} | ${truncate(row.query, 60)} | ${e} | ${f}/${e} | ${
          row.missing.length === 0 ? "—" : row.missing.map((id) => `\`${id}\``).join(" ")
        } |`,
      );
    }
    lines.push("");
  }

  if (r.anti) {
    lines.push("## Slice 3 — Anti-Hallucination");
    lines.push("");
    lines.push(`- Cases: ${r.anti.total}`);
    lines.push(`- Noise cutoff: <${r.anti.cutoff}`);
    lines.push(`- Median top-score: **${r.anti.median.toFixed(1)}**`);
    lines.push(
      `- Under-cutoff cases: **${r.anti.underCutoff}/${r.anti.total}** (${pct(r.anti.underCutoff / r.anti.total)})`,
    );
    lines.push(`- **Verdict: ${r.anti.pass ? "PASS" : "FAIL"} (median < cutoff)**`);
    lines.push("");
    lines.push("### Histogram");
    lines.push("");
    lines.push("| bucket | count |");
    lines.push("|---|---:|");
    for (const [bucket, count] of r.anti.histogram) {
      lines.push(`| ${bucket} | ${count} |`);
    }
    lines.push("");
    lines.push("### Per query");
    lines.push("");
    lines.push("| query | top score | top hit |");
    lines.push("|---|---:|---|");
    for (const row of r.anti.rows) {
      lines.push(
        `| ${truncate(row.query, 60)} | ${row.topScore.toFixed(1)} | \`${truncate(row.topId, 50)}\` |`,
      );
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("_Generated by `scripts/eval-stress.ts` (Issues #2, #8)._");
  return lines.join("\n") + "\n";
}

// ── main ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const vaultPath = process.env.BASTRA_VAULT_PATH ?? process.env.NEXUS_VAULT_PATH;
  if (!vaultPath) {
    console.error("FATAL: BASTRA_VAULT_PATH (or NEXUS_VAULT_PATH) not set");
    process.exit(2);
  }

  const vault = new Vault(vaultPath);
  const { loaded, skipped } = await vault.init();
  if (skipped.length) {
    console.error(`[stress] ${skipped.length} memorys skipped:`);
    for (const s of skipped) console.error(`  - ${s.path}: ${s.err}`);
  }
  console.error(`[stress] vault loaded: ${loaded} memorys`);

  const search = new SearchIndex(vault);
  search.start();

  const recall = makeRecaller(search, args.hybrid);
  const provider =
    args.hybrid && search.hasEmbeddings() ? "Hybrid (BM25 + Vector RRF)" : "BM25-only";
  console.error(`[stress] provider: ${provider}`);

  const para = args.slices.includes("paraphrased")
    ? await runParaphrased(vault, recall)
    : undefined;
  const cross = args.slices.includes("cross")
    ? await runCrossMemory(vault, recall)
    : undefined;
  const anti = args.slices.includes("anti")
    ? await runAntiHallucination(vault, recall, args.cutoff)
    : undefined;

  // ── stdout report ─────────────────────────────────────────
  console.log("\n# Bastra Recall — Stress Eval\n");
  console.log(`Vault: **${loaded}** memories  ·  Provider: **${provider}**`);
  if (para) printParaphrased(para);
  if (cross) printCross(cross);
  if (anti) printAnti(anti);

  const passes: boolean[] = [];
  if (para) passes.push(para.pass);
  if (cross) passes.push(cross.pass);
  if (anti) passes.push(anti.pass);
  const allPass = passes.length > 0 && passes.every((p) => p);

  console.log("\n## Overall\n");
  console.log(`Verdict: **${allPass ? "PASS" : "FAIL"}**`);

  // ── JSON export ───────────────────────────────────────────
  if (args.out) {
    const json = {
      run_date: new Date().toISOString(),
      vault_path: vaultPath,
      vault_size: loaded,
      provider,
      slices: {
        paraphrased: para
          ? {
              total: para.total,
              recall_at_1: para.recallAt1,
              recall_at_3: para.recallAt3,
              mrr: para.mrr,
              pass: para.pass,
              unknown_ids: para.unknownIds,
              rows: para.rows,
            }
          : null,
        cross: cross
          ? {
              total: cross.total,
              passed: cross.passed,
              recall_at_k: cross.recallAtK,
              pass: cross.pass,
              rows: cross.rows,
            }
          : null,
        anti: anti
          ? {
              total: anti.total,
              cutoff: anti.cutoff,
              median: anti.median,
              under_cutoff: anti.underCutoff,
              pass: anti.pass,
              histogram: Object.fromEntries(anti.histogram),
              rows: anti.rows,
            }
          : null,
      },
      overall_pass: allPass,
    };
    writeFileSync(resolve(args.out), JSON.stringify(json, null, 2));
    console.error(`[stress] wrote JSON report to ${args.out}`);
  }

  // ── Markdown report (only when running the full sweep) ────
  if (args.slices.length === 3) {
    const md = buildMarkdownReport({
      vaultPath,
      vaultSize: loaded,
      provider,
      para,
      cross,
      anti,
    });
    const outPath = resolve(
      new URL(".", import.meta.url).pathname,
      "stress-report.md",
    );
    writeFileSync(outPath, md);
    console.error(`[stress] wrote Markdown report to ${outPath}`);
  }

  search.stop();
  await vault.stop();

  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error("[stress] FATAL:", err);
  process.exit(1);
});
