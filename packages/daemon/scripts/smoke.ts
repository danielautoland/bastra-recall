/**
 * Smoke test — verify Vault + SearchIndex work end-to-end against
 * the migration-vault on disk. Does NOT touch the MCP transport.
 *
 * Run: NEXUS_VAULT_PATH=/path/to/vault tsx scripts/smoke.ts
 *      (or: npm run smoke  — picks up env from default below)
 */
import { Vault, SearchIndex } from "@bastra-recall/core";
import { resolve } from "node:path";

const DEFAULT_VAULT = resolve(
  import.meta.dirname,
  "../../../private/migration/memorys",
);
const VAULT = process.env.BASTRA_VAULT_PATH ?? process.env.NEXUS_VAULT_PATH ?? DEFAULT_VAULT;

const QUERIES: { query: string; expectIds?: string[] }[] = [
  { query: "scrollbar", expectIds: ["carnexus-scrollbar-subtle-pattern"] },
  {
    query: "neuen input bauen",
    expectIds: ["carnexus-input-focus-border-global-red"],
  },
  {
    query: "git commit",
    expectIds: ["pref-no-git-without-instruction"],
  },
  {
    query: "kompliziert in css",
    expectIds: ["lesson-css-pixel-fix-one-value-at-a-time"],
  },
  {
    query: "modal mit blur",
    expectIds: ["carnexus-modal-pattern-blur-backdrop"],
  },
  {
    query: "schadensbild pdf",
    expectIds: ["carnexus-v11-vs-legacy-damage-images-schema"],
  },
  {
    query: "soll ich phase 5 architektur dazubauen",
    expectIds: ["nexus-recall-no-overengineering"],
  },
];

async function main(): Promise<void> {
  console.error(`[smoke] vault: ${VAULT}`);
  const t0 = Date.now();
  const vault = new Vault(VAULT);
  const { loaded, skipped } = await vault.init();
  const tInit = Date.now() - t0;
  console.error(`[smoke] loaded ${loaded} memorys in ${tInit}ms`);
  if (skipped.length) {
    console.error(`[smoke] ${skipped.length} skipped:`);
    for (const s of skipped) console.error(`  - ${s.path}: ${s.err}`);
  }

  const search = new SearchIndex(vault);
  search.start();
  console.error(`[smoke] indexed ${search.size()} docs\n`);

  let passes = 0;
  for (const q of QUERIES) {
    const t1 = Date.now();
    const hits = search.recall(q.query, { k: 5 });
    const elapsed = Date.now() - t1;
    const top = hits.slice(0, 5);
    const found = q.expectIds
      ? q.expectIds.every((id) => top.some((h) => h.id === id))
      : true;
    if (found) passes++;
    const status = found ? "PASS" : "FAIL";
    console.error(`── [${status}] "${q.query}"  (${elapsed}ms, ${hits.length} hits)`);
    if (top.length === 0) {
      console.error(`   (no hits)`);
    }
    for (const h of top) {
      const mark = q.expectIds?.includes(h.id) ? "★" : " ";
      console.error(
        `   ${mark} ${h.score.toFixed(2).padStart(8)}  ${h.id.padEnd(50)} ${h.title}`,
      );
    }
    if (!found && q.expectIds) {
      const missing = q.expectIds.filter((id) => !top.some((h) => h.id === id));
      console.error(`   missing expected: ${missing.join(", ")}`);
    }
    console.error("");
  }

  console.error(
    `[smoke] ${passes}/${QUERIES.length} expected-id queries passed`,
  );
  search.stop();
  await vault.stop();
  process.exit(passes === QUERIES.length ? 0 : 1);
}

main().catch((err) => {
  console.error("[smoke] FATAL:", err);
  process.exit(2);
});
