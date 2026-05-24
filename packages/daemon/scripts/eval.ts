#!/usr/bin/env tsx
/**
 * M0 — recall-quality eval against the live vault.
 *
 * Hypothesis under test: BM25 + recall_when-boosting retrieves the right
 * memory under realistic queries, without embeddings.
 *
 * Method: for each memory M, take its first recall_when phrase as a query.
 * If recall_when truly steers retrieval, M should be the top hit (Recall@1).
 * Aggregate: Recall@1, Recall@3, MRR, and which field actually triggered
 * the match (recall_when vs title/tags/body).
 *
 * Run:  BASTRA_VAULT_PATH=/path/to/vault npx tsx scripts/eval.ts
 */
import { Vault, SearchIndex } from "@bastra-recall/core";

const VAULT_PATH = process.env.BASTRA_VAULT_PATH ?? process.env.NEXUS_VAULT_PATH;
if (!VAULT_PATH) {
  console.error("FATAL: BASTRA_VAULT_PATH not set");
  process.exit(2);
}

interface EvalRow {
  id: string;
  query: string;
  rank: number; // 1-based; 0 = miss
  topHit: string;
  topScore: number;
  matchedTerms: string[];
  /** True if at least one matched term appears in the gold memory's recall_when. */
  triggeredByRecallWhen: boolean;
  /** True if at least one matched term appears in the gold memory's title. */
  triggeredByTitle: boolean;
}

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 2),
  );
}

function rankOf(hits: { id: string }[], goldId: string): number {
  const i = hits.findIndex((h) => h.id === goldId);
  return i === -1 ? 0 : i + 1;
}

async function main(): Promise<void> {
  const vault = new Vault(VAULT_PATH!);
  const { loaded, skipped } = await vault.init();
  if (skipped.length) {
    console.error(`[eval] ${skipped.length} memorys skipped:`);
    for (const s of skipped) console.error(`  - ${s.path}: ${s.err}`);
  }
  console.error(`[eval] vault loaded: ${loaded} memorys`);

  const search = new SearchIndex(vault);
  search.start();

  const memories = vault.list().filter((m) => !m.fm.obsolete);
  const rows: EvalRow[] = [];

  for (const m of memories) {
    const trigger = m.fm.recall_when[0];
    if (!trigger) continue;

    const hits = search.recall(trigger, { k: 10 });
    const rank = rankOf(hits, m.fm.id);
    const top = hits[0];

    const matched = (hits.find((h) => h.id === m.fm.id)?.matched_terms ??
      top?.matched_terms ??
      []) as string[];

    const recallWhenTokens = tokenize(m.fm.recall_when.join(" "));
    const titleTokens = tokenize(m.fm.title);

    rows.push({
      id: m.fm.id,
      query: trigger,
      rank,
      topHit: top?.id ?? "(none)",
      topScore: top?.score ?? 0,
      matchedTerms: matched,
      triggeredByRecallWhen: matched.some((t) => recallWhenTokens.has(t)),
      triggeredByTitle: matched.some((t) => titleTokens.has(t)),
    });
  }

  const total = rows.length;
  const top1 = rows.filter((r) => r.rank === 1).length;
  const top3 = rows.filter((r) => r.rank >= 1 && r.rank <= 3).length;
  const mrr =
    rows.reduce((acc, r) => acc + (r.rank > 0 ? 1 / r.rank : 0), 0) / total;

  const matchedAny = rows.filter((r) => r.matchedTerms.length > 0);
  const recallWhenSteered = matchedAny.filter(
    (r) => r.triggeredByRecallWhen,
  ).length;
  const titleOnlySteered = matchedAny.filter(
    (r) => !r.triggeredByRecallWhen && r.triggeredByTitle,
  ).length;
  const otherSteered =
    matchedAny.length - recallWhenSteered - titleOnlySteered;

  const misses = rows.filter((r) => r.rank === 0 || r.rank > 3);

  // ── Report ───────────────────────────────────────────────────
  console.log("\n# M0 Recall-Quality Eval\n");
  console.log(`Vault size: **${loaded}**  ·  Eval cases: **${total}**\n`);
  console.log("## Aggregate");
  console.log(`- Recall@1: **${pct(top1, total)}** (${top1}/${total})`);
  console.log(`- Recall@3: **${pct(top3, total)}** (${top3}/${total})`);
  console.log(`- MRR:      **${mrr.toFixed(3)}**`);
  console.log("\n## What steered retrieval");
  console.log(
    `- recall_when terms matched: **${pct(recallWhenSteered, matchedAny.length)}** ` +
      `(${recallWhenSteered}/${matchedAny.length})`,
  );
  console.log(
    `- title-only (no recall_when overlap): **${pct(titleOnlySteered, matchedAny.length)}**`,
  );
  console.log(
    `- other fields only (tags/body/topic_path): **${pct(otherSteered, matchedAny.length)}**`,
  );
  console.log(
    "\n_Note: recall_when phrases naturally share tokens with the title for " +
      "many well-written memorys — these counts overlap. The signal we care " +
      "about is whether recall_when terms are present in matched_terms at all._",
  );

  if (misses.length > 0) {
    console.log(
      `\n## Misses (rank > 3 or not found) — ${misses.length}/${total}\n`,
    );
    console.log("| rank | id | query | top hit |");
    console.log("|---|---|---|---|");
    for (const m of misses.slice(0, 30)) {
      console.log(
        `| ${m.rank || "—"} | ${m.id} | ${truncate(m.query, 50)} | ${m.topHit} |`,
      );
    }
    if (misses.length > 30) {
      console.log(`\n_…and ${misses.length - 30} more_`);
    }
  } else {
    console.log("\n## Misses\n\nNone. Every memory ranked in top-3 for its own trigger.");
  }

  const nonTop1 = rows.filter((r) => r.rank > 1);
  if (nonTop1.length > 0) {
    console.log(`\n## Non-Top-1 cases (${nonTop1.length})\n`);
    console.log("| rank | id (gold) | query | top hit (won) |");
    console.log("|---|---|---|---|");
    for (const r of nonTop1) {
      console.log(
        `| ${r.rank} | ${r.id} | ${truncate(r.query, 60)} | ${r.topHit} |`,
      );
    }
  }

  // Distribution of where the gold memory landed
  console.log("\n## Rank distribution");
  const buckets: Record<string, number> = { "1": 0, "2-3": 0, "4-10": 0, miss: 0 };
  for (const r of rows) {
    if (r.rank === 1) buckets["1"]++;
    else if (r.rank >= 2 && r.rank <= 3) buckets["2-3"]++;
    else if (r.rank >= 4 && r.rank <= 10) buckets["4-10"]++;
    else buckets.miss++;
  }
  for (const [k, v] of Object.entries(buckets)) {
    console.log(`- rank ${k}: ${v}`);
  }

  search.stop();
  await vault.stop();
}

function pct(num: number, denom: number): string {
  if (denom === 0) return "0%";
  return `${((num / denom) * 100).toFixed(1)}%`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

main().catch((err) => {
  console.error("[eval] FATAL:", err);
  process.exit(1);
});
