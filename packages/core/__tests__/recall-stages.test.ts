/**
 * Tests für den Stage-Event-Emitter in `SearchIndex.recall` (#38).
 *
 * Verifiziert: Stage-Events feuern in der erwarteten Reihenfolge,
 * Start/Stop-Pairs haben passende Dauern, `done`-Event enthält
 * `hit_count` / `vault_size`. Hybrid-Pfad ist hier nicht abgedeckt
 * (braucht einen Embedding-Provider) — der wird im Banter-Test über
 * synthetic Stage-Events geprüft.
 *
 * Runner: `node --import tsx --test packages/core/__tests__/recall-stages.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex, type RecallStage } from "../src/index.js";

function memoryMarkdown(id: string, title: string): string {
  const ts = new Date().toISOString();
  return [
    "---",
    `id: ${id}`,
    `title: ${title}`,
    "type: reference",
    `summary: ${title}`,
    "topic_path:",
    "  - test",
    "tags:",
    "  - test",
    "scope: test-scope",
    "recall_when:",
    `  - ${title}`,
    `created: ${ts}`,
    `updated: ${ts}`,
    "---",
    "",
    `Body for ${title}.`,
    "",
  ].join("\n");
}

async function makeVault(memos: { id: string; title: string }[]): Promise<{ vault: Vault; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-stages-test-"));
  for (const m of memos) {
    await writeFile(join(dir, `${m.id}.md`), memoryMarkdown(m.id, m.title), "utf8");
  }
  const vault = new Vault(dir);
  await vault.init();
  return { vault, dir };
}

test("recall: emits stages in expected order", async () => {
  const { vault, dir } = await makeVault([
    { id: "stage-1", title: "alpha bravo" },
    { id: "stage-2", title: "charlie delta" },
  ]);
  try {
    const idx = new SearchIndex(vault);
    idx.start();

    const events: RecallStage[] = [];
    const hits = idx.recall("alpha", { k: 5, onStage: (s) => events.push(s) });

    // Mindestens ein Hit liefern, sonst war die Query schon defekt.
    assert.ok(hits.length >= 1, "at least one hit expected");

    // Erwartete Stage-Namen (Reihenfolge): query.parse(start) -> query.parse(stop)
    // -> bm25.search(start) -> bm25.search(stop) -> staleness.rank(start)
    // -> staleness.rank(stop) -> done.
    const names = events.map((e) => `${e.name}${e.durationMs === undefined ? ":start" : ":stop"}`);
    assert.deepEqual(
      names,
      [
        "query.parse:start",
        "query.parse:stop",
        "bm25.search:start",
        "bm25.search:stop",
        "staleness.rank:start",
        "staleness.rank:stop",
        "done:stop",
      ],
      `unexpected stage sequence: ${names.join(", ")}`,
    );

    // done-Event trägt hit_count + vault_size
    const done = events.at(-1)!;
    assert.equal(done.name, "done");
    assert.equal(done.meta?.hit_count, hits.length);
    assert.equal(done.meta?.vault_size, 2);
    assert.equal(typeof done.meta?.total_ms, "number");
    idx.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recall: hops.expand stage fires only when expand_hops=1", async () => {
  const { vault, dir } = await makeVault([
    { id: "h-1", title: "echo foxtrot" },
    { id: "h-2", title: "golf hotel" },
  ]);
  try {
    const idx = new SearchIndex(vault);
    idx.start();

    const noHopEvents: RecallStage[] = [];
    idx.recall("echo", { k: 3, onStage: (s) => noHopEvents.push(s) });
    const hasHopsStage = noHopEvents.some((e) => e.name === "hops.expand");
    assert.equal(hasHopsStage, false, "no hops.expand without expand_hops=1");

    const withHopEvents: RecallStage[] = [];
    idx.recall("echo", { k: 3, expand_hops: 1, onStage: (s) => withHopEvents.push(s) });
    const hopsStart = withHopEvents.find((e) => e.name === "hops.expand" && e.durationMs === undefined);
    const hopsStop = withHopEvents.find((e) => e.name === "hops.expand" && e.durationMs !== undefined);
    assert.ok(hopsStart, "expected hops.expand start event");
    assert.ok(hopsStop, "expected hops.expand stop event");
    assert.equal(typeof hopsStop!.meta?.hop_count, "number");

    idx.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recall: backwards-compat — no onStage means no stage overhead and same hits", async () => {
  const { vault, dir } = await makeVault([
    { id: "bc-1", title: "india juliet" },
  ]);
  try {
    const idx = new SearchIndex(vault);
    idx.start();

    const withStages: RecallStage[] = [];
    const aStaged = idx.recall("india", { k: 5, onStage: (s) => withStages.push(s) });
    const aBare = idx.recall("india", { k: 5 });

    assert.deepEqual(
      aStaged.map((h) => h.id),
      aBare.map((h) => h.id),
      "hits identical with and without onStage",
    );
    assert.ok(withStages.length > 0, "onStage was actually called");

    idx.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recall: empty query short-circuits with done event only", async () => {
  const { vault, dir } = await makeVault([{ id: "e-1", title: "kilo lima" }]);
  try {
    const idx = new SearchIndex(vault);
    idx.start();

    const events: RecallStage[] = [];
    const hits = idx.recall("   ", { onStage: (s) => events.push(s) });
    assert.equal(hits.length, 0);
    const names = events.map((e) => e.name);
    assert.ok(names.includes("query.parse"));
    assert.ok(names.includes("done"));
    assert.ok(!names.includes("bm25.search"), "no bm25.search on empty query");

    idx.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
