/**
 * Tests für den Staleness-Cache in `SearchIndex` (#29).
 *
 * Ziel: verifizieren dass `computeStaleness()` pro Memory nur einmal
 * läuft (Cache-Hit beim zweiten Recall), dass Vault-Changes den Eintrag
 * invalidieren, und dass die 12h-TTL alte Einträge neu rechnet — auch
 * wenn die Frontmatter unverändert ist (Tageswechsel-Flip aging → stale).
 *
 * Runner: `node --import tsx --test packages/core/__tests__/staleness-cache.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex } from "../src/index.js";

interface MemorySpec {
  id: string;
  title: string;
  type: string;
  summary: string;
  updated?: string;
  body?: string;
}

function memoryMarkdown(spec: MemorySpec): string {
  const updated = spec.updated ?? new Date().toISOString();
  // `created` muss <= `updated` sein und ist Pflicht — wir nehmen den
  // gleichen Stempel.
  return [
    "---",
    `id: ${spec.id}`,
    `title: ${spec.title}`,
    `type: ${spec.type}`,
    `summary: ${spec.summary}`,
    "topic_path:",
    "  - test",
    "tags:",
    "  - test",
    "scope: test-scope",
    "recall_when:",
    `  - ${spec.title}`,
    `created: ${updated}`,
    `updated: ${updated}`,
    "---",
    "",
    spec.body ?? `Body for ${spec.title}.`,
    "",
  ].join("\n");
}

async function makeVault(specs: MemorySpec[]): Promise<{ vault: Vault; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-staleness-test-"));
  for (const s of specs) {
    await writeFile(join(dir, `${s.id}.md`), memoryMarkdown(s), "utf8");
  }
  const vault = new Vault(dir);
  await vault.init();
  return { vault, dir };
}

test("staleness-cache: zweiter Recall verwendet Cache (kein Re-Compute)", async () => {
  // 200 Tage altes lesson (default 180d → ratio ~1.1 → stale).
  const oldDate = new Date(Date.now() - 200 * 86400_000).toISOString();
  const { vault, dir } = await makeVault([
    { id: "stale-old", title: "alter eintrag", type: "lesson", summary: "alt", updated: oldDate },
    { id: "stale-fresh", title: "frischer eintrag", type: "lesson", summary: "frisch" },
  ]);
  try {
    const idx = new SearchIndex(vault);
    idx.start();

    // Erster Recall — Cache füllt sich.
    const a = idx.recall("eintrag", { k: 5 });
    assert.ok(a.length >= 2, "beide Memorys finden");

    // Internen Cache anzapfen (private — Test-Only über cast).
    const cache = (idx as unknown as {
      stalenessCache: Map<string, { touchTs: number; status: string; computedAt: number }>;
    }).stalenessCache;
    assert.equal(cache.size, 2, "Cache hat einen Eintrag pro Hit");

    // Stempel mutieren: wenn der zweite Recall den staleness-Cache wirklich
    // benutzt, bleiben die Stempel unverändert (Cache-Hit-Pfad updated
    // computedAt NICHT, nur Miss-Pfad).
    const stamp = Date.now() - 1_000;
    for (const v of cache.values()) v.computedAt = stamp;

    // Anderen Query verwenden damit der queryCache miss-t und die
    // Staleness-Logik tatsächlich erneut betreten wird.
    const b = idx.recall("alter", { k: 5 });
    assert.ok(b.length >= 1);
    for (const [id, v] of cache.entries()) {
      assert.equal(
        v.computedAt,
        stamp,
        `computedAt für ${id} bleibt stabil bei Cache-Hit`,
      );
    }

    idx.stop();
  } finally {
    await vault.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("staleness-cache: Vault-Change invalidiert den Eintrag", async () => {
  const { vault, dir } = await makeVault([
    { id: "change-test", title: "change me", type: "lesson", summary: "x" },
  ]);
  try {
    const idx = new SearchIndex(vault);
    idx.start();

    idx.recall("change", { k: 5 });
    const cache = (idx as unknown as {
      stalenessCache: Map<string, unknown>;
    }).stalenessCache;
    assert.ok(cache.has("change-test"), "Cache hat Eintrag nach erstem Recall");

    // Force-reindex über Vault — feuert ein `change`-Event → handle() löscht
    // den Cache-Eintrag.
    await writeFile(
      join(dir, "change-test.md"),
      memoryMarkdown({
        id: "change-test",
        title: "change me",
        type: "lesson",
        summary: "x v2",
      }),
      "utf8",
    );
    await vault.reindexFile(join(dir, "change-test.md"));

    assert.equal(cache.has("change-test"), false, "Cache-Eintrag wurde invalidiert");

    idx.stop();
  } finally {
    await vault.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("staleness-cache: 12h TTL rechnet alten Eintrag neu", async () => {
  // touch-ts „heute" — Status fresh.
  const { vault, dir } = await makeVault([
    { id: "ttl-test", title: "ttl probe", type: "lesson", summary: "x" },
  ]);
  try {
    const idx = new SearchIndex(vault);
    idx.start();

    // Erster Call: Cache fresh, computedAt = now0.
    const now0 = Date.now();
    idx.recall("ttl", { k: 5 });
    const cache = (idx as unknown as {
      stalenessCache: Map<string, { touchTs: number; status: string; computedAt: number }>;
    }).stalenessCache;
    const e0 = cache.get("ttl-test");
    assert.ok(e0, "Cache-Eintrag vorhanden");
    assert.ok(e0!.computedAt >= now0 - 1000, "computedAt frisch");

    // Cache-Eintrag manuell „13h alt" stempeln — TTL > 12h.
    e0!.computedAt = Date.now() - 13 * 3600_000;
    const stampedAt = e0!.computedAt;

    // Wir nutzen einen ANDEREN Query damit der queryCache miss-t und
    // die Staleness-Logik wirklich erneut greift. Beide Queries matchen
    // dieselbe Memory („ttl probe").
    idx.recall("probe", { k: 5 });
    const e1 = cache.get("ttl-test");
    assert.ok(e1, "Cache-Eintrag noch da");
    assert.ok(
      e1!.computedAt > stampedAt,
      `computedAt wurde aktualisiert (was ${stampedAt}, now ${e1!.computedAt})`,
    );

    idx.stop();
  } finally {
    await vault.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
