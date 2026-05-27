/**
 * Tests für den Query-Tokenizer-LRU-Cache in `SearchIndex` (#30).
 *
 * Verifiziert: identischer Query → Cache-Hit (kein erneutes MiniSearch),
 * unterschiedliche opts → Cache-Miss (Key enthält JSON-stringified opts),
 * Vault-Change → komplettes clear(), LRU-Eviction bei > 100 distinct Keys.
 *
 * Runner: `node --import tsx --test packages/core/__tests__/query-cache.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex } from "../src/index.js";

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
  const dir = await mkdtemp(join(tmpdir(), "bastra-query-test-"));
  for (const m of memos) {
    await writeFile(join(dir, `${m.id}.md`), memoryMarkdown(m.id, m.title), "utf8");
  }
  const vault = new Vault(dir);
  await vault.init();
  return { vault, dir };
}

function getQueryCache(idx: SearchIndex): Map<string, { hits: unknown[]; at: number }> {
  return (idx as unknown as {
    queryCache: Map<string, { hits: unknown[]; at: number }>;
  }).queryCache;
}

test("query-cache: zweiter Recall mit identischem Query hit Cache", async () => {
  const { vault, dir } = await makeVault([
    { id: "qc-1", title: "alpha bravo" },
    { id: "qc-2", title: "charlie delta" },
  ]);
  try {
    const idx = new SearchIndex(vault);
    idx.start();

    const cache = getQueryCache(idx);
    assert.equal(cache.size, 0);

    const a = idx.recall("alpha", { k: 5 });
    assert.equal(cache.size, 1, "Cache füllt sich nach Recall");
    const a2 = idx.recall("alpha", { k: 5 });
    assert.equal(cache.size, 1, "zweiter Call ändert Cache-Größe nicht");
    assert.deepEqual(
      a.map((h) => h.id),
      a2.map((h) => h.id),
      "gleiche IDs aus dem Cache",
    );

    idx.stop();
  } finally {
    await vault.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("query-cache: andere opts → Cache-Miss (separater Key)", async () => {
  const { vault, dir } = await makeVault([{ id: "qc-1", title: "alpha bravo" }]);
  try {
    const idx = new SearchIndex(vault);
    idx.start();

    const cache = getQueryCache(idx);
    idx.recall("alpha", { k: 5 });
    assert.equal(cache.size, 1);

    // Anderer k → anderer Key → zweiter Eintrag im Cache.
    idx.recall("alpha", { k: 3 });
    assert.equal(cache.size, 2, "unterschiedliche opts erzeugen separate Cache-Keys");

    // Scope-Filter → wieder anderer Key.
    idx.recall("alpha", { k: 5, scope: "other-scope" });
    assert.equal(cache.size, 3);

    idx.stop();
  } finally {
    await vault.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("query-cache: Vault-Change leert den Cache komplett", async () => {
  const { vault, dir } = await makeVault([{ id: "qc-1", title: "alpha bravo" }]);
  try {
    const idx = new SearchIndex(vault);
    idx.start();

    const cache = getQueryCache(idx);
    idx.recall("alpha", { k: 5 });
    idx.recall("bravo", { k: 5 });
    assert.equal(cache.size, 2);

    // change event über reindexFile.
    await writeFile(
      join(dir, "qc-1.md"),
      memoryMarkdown("qc-1", "alpha bravo updated"),
      "utf8",
    );
    await vault.reindexFile(join(dir, "qc-1.md"));

    assert.equal(cache.size, 0, "Cache wurde geleert");

    idx.stop();
  } finally {
    await vault.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("query-cache: LRU-Eviction bei > 100 Keys", async () => {
  const { vault, dir } = await makeVault([{ id: "qc-1", title: "alpha bravo" }]);
  try {
    const idx = new SearchIndex(vault);
    idx.start();

    const cache = getQueryCache(idx);

    // 100 verschiedene Queries → Cache läuft voll.
    for (let i = 0; i < 100; i++) {
      idx.recall(`query-${i}`, { k: 5 });
    }
    assert.equal(cache.size, 100, "Cache füllt sich bis zum Limit");

    const firstKey = `recall|query-0|${JSON.stringify({ k: 5 })}`;
    assert.ok(cache.has(firstKey), "erste Query noch im Cache");

    // 101. Query → erste muss rausfliegen.
    idx.recall("query-100", { k: 5 });
    assert.equal(cache.size, 100, "Cache-Größe bleibt am Limit");
    assert.equal(cache.has(firstKey), false, "älteste Query wurde gedroppt");
    assert.ok(cache.has(`recall|query-100|${JSON.stringify({ k: 5 })}`));

    idx.stop();
  } finally {
    await vault.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("query-cache: LRU-Bump bei Hit verhindert Eviction der gebumpten Query", async () => {
  const { vault, dir } = await makeVault([{ id: "qc-1", title: "alpha bravo" }]);
  try {
    const idx = new SearchIndex(vault);
    idx.start();

    const cache = getQueryCache(idx);

    // Fülle Cache exakt voll.
    for (let i = 0; i < 100; i++) {
      idx.recall(`q-${i}`, { k: 5 });
    }

    // „query-0" nochmal anfassen → bump auf jüngst.
    idx.recall("q-0", { k: 5 });

    // Eine neue Query → jetzt fliegt „q-1" raus (q-0 war gerade gebumpt).
    idx.recall("q-new", { k: 5 });
    assert.equal(cache.has(`recall|q-0|${JSON.stringify({ k: 5 })}`), true, "gebumpte Query bleibt");
    assert.equal(cache.has(`recall|q-1|${JSON.stringify({ k: 5 })}`), false, "vorher zweitälteste fliegt raus");

    idx.stop();
  } finally {
    await vault.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
