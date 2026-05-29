/**
 * measure-recall-payload — quantifies the context cost of a recall
 * tool-result, lean vs. full, at k=5/10/20 (#50).
 *
 * Read-only: opens the real vault, runs a handful of representative queries
 * through recallHandler, JSON-serializes the result exactly like the MCP /
 * REST path does, and prints bytes + an approximate token count (~bytes/4)
 * for each (query, k, verbosity) combination, plus the lean-vs-full saving.
 *
 * Run: BASTRA_VAULT_PATH=/path/to/vault tsx scripts/measure-recall-payload.ts
 *      (defaults to the migration vault, like scripts/smoke.ts)
 */
import { Vault, SearchIndex } from "@bastra-recall/core";
import { resolve } from "node:path";
import { Telemetry } from "../src/telemetry.js";
import { recallHandler, type ToolDeps } from "../src/tool-handlers.js";

const DEFAULT_VAULT = resolve(import.meta.dirname, "../../../private/migration/memorys");
const VAULT = process.env.BASTRA_VAULT_PATH ?? process.env.NEXUS_VAULT_PATH ?? DEFAULT_VAULT;

const QUERIES = [
  "scrollbar pattern",
  "git commit workflow",
  "kompliziert in css",
  "bastra recall architektur files",
  "modal mit blur backdrop",
];
const KS = [5, 10, 20];

/** Rough token estimate — good enough for a before/after comparison. */
function approxTokens(bytes: number): number {
  return Math.round(bytes / 4);
}

function payloadBytes(obj: unknown): number {
  // Mirror the MCP serialization (index.ts: JSON.stringify(result, null, 2)).
  return Buffer.byteLength(JSON.stringify(obj, null, 2), "utf8");
}

async function main(): Promise<void> {
  console.error(`[measure] vault: ${VAULT}`);
  const vault = new Vault(VAULT);
  const { loaded } = await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  console.error(`[measure] loaded ${loaded} memorys, indexed ${search.size()} docs\n`);

  const deps: ToolDeps = { vault, search, telemetry: new Telemetry(), vaultPath: VAULT };

  const totals = { lean: 0, full: 0, n: 0 };
  console.log("query | k | lean B (~tok) | full B (~tok) | saving");
  console.log("------|---|---------------|---------------|-------");
  for (const query of QUERIES) {
    for (const k of KS) {
      const lean = await recallHandler(deps, { query, k });
      const full = await recallHandler(deps, { query, k, verbosity: "full" });
      const lb = payloadBytes(lean);
      const fb = payloadBytes(full);
      totals.lean += lb;
      totals.full += fb;
      totals.n += 1;
      const saving = fb > 0 ? Math.round((1 - lb / fb) * 100) : 0;
      console.log(
        `${query.slice(0, 24).padEnd(24)} | ${String(k).padStart(2)} | ` +
          `${String(lb).padStart(6)} (${String(approxTokens(lb)).padStart(5)}) | ` +
          `${String(fb).padStart(6)} (${String(approxTokens(fb)).padStart(5)}) | ${saving}%`,
      );
    }
  }

  const avgSaving = totals.full > 0 ? Math.round((1 - totals.lean / totals.full) * 100) : 0;
  console.log("\n[measure] aggregate over", totals.n, "calls:");
  console.log(
    `  lean total: ${totals.lean} B (~${approxTokens(totals.lean)} tok)\n` +
      `  full total: ${totals.full} B (~${approxTokens(totals.full)} tok)\n` +
      `  average lean saving: ${avgSaving}%`,
  );

  search.stop();
  await vault.stop?.();
}

main().catch((err) => {
  console.error("[measure] failed:", err);
  process.exit(1);
});
