/**
 * Tests für die lean-by-default Projektion von recall + load_memory (#50)
 * und den Score-Floor (#50 / #9).
 *
 * Verifiziert:
 * - recall (default) liefert pro Hit nur id/title/type/scope/summary/score —
 *   kein matched_terms/mode/hop/topic_path, kein stages-Block. summary voll.
 * - recall verbosity:"full" bringt matched_terms/topic_path + stages zurück.
 * - min_score dropt Hits unter der Schwelle.
 * - load_memory (default) liefert essenzielle Frontmatter (kein related_via/
 *   source/confidence) + body ohne Auto-Related-Block.
 * - load_memory verbosity:"full" liefert die komplette Frontmatter + raw body.
 *
 * Runner: `tsx --test __tests__/tool-handlers-lean.test.ts`
 * Echtes File-Vault, kein Mocking — der Such-Pfad läuft real.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex, AUTO_RELATED_START } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { recallHandler, loadMemoryHandler, truncateSummary, type ToolDeps } from "../src/tool-handlers.js";

const LONG_SUMMARY =
  "alpha bravo charlie delta echo foxtrot golf hotel india juliett kilo lima mike november " +
  "oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu extra words here";

function leanMemory(id: string, title: string): string {
  const ts = new Date().toISOString();
  return [
    "---",
    `id: ${id}`,
    `title: ${title}`,
    "type: lesson",
    `summary: ${title} summary text`,
    "topic_path:",
    "  - test",
    "tags:",
    "  - test",
    "scope: lean-test",
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

/** Memory mit voller Frontmatter (related_via/source/confidence) + Auto-Related-Block. */
function richMemory(id: string, title: string): string {
  const ts = new Date().toISOString();
  return [
    "---",
    `id: ${id}`,
    `title: ${title}`,
    "type: lesson",
    `summary: ${title} summary text`,
    "topic_path:",
    "  - test",
    "tags:",
    "  - test",
    "scope: lean-test",
    "recall_when:",
    `  - ${title}`,
    "related_via:",
    "  - id: other",
    "    reason: cosine 0.71",
    "    score: 0.71",
    "source: unit-test",
    "confidence: 1",
    `created: ${ts}`,
    `updated: ${ts}`,
    "---",
    "",
    `Body for ${title}.`,
    "",
    "## Auto-Related " + AUTO_RELATED_START,
    "",
    "- [[other]] (cosine 0.71)",
    "",
    "<!-- bastra:auto-related:end -->",
    "",
  ].join("\n");
}

/** Memory mit einer summary > 160 Zeichen, query-relevant via title. */
function longSummaryMemory(id: string, title: string): string {
  const ts = new Date().toISOString();
  return [
    "---",
    `id: ${id}`,
    `title: ${title}`,
    "type: lesson",
    `summary: ${LONG_SUMMARY}`,
    "topic_path:",
    "  - test",
    "tags:",
    "  - test",
    "scope: lean-test",
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

async function makeDeps(): Promise<{ deps: ToolDeps; close: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-lean-test-"));
  await writeFile(join(dir, "alpha.md"), leanMemory("alpha", "alpha bravo"), "utf8");
  await writeFile(join(dir, "charlie.md"), leanMemory("charlie", "charlie delta"), "utf8");
  await writeFile(join(dir, "rich.md"), richMemory("rich", "rich echo"), "utf8");
  await writeFile(join(dir, "longsum.md"), longSummaryMemory("longsum", "alpha bravo"), "utf8");
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const telemetry = new Telemetry();
  const deps: ToolDeps = { vault, search, telemetry, vaultPath: dir };
  return {
    deps,
    close: async () => {
      search.stop();
      await vault.stop?.();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("recall lean (default): only essential fields, no debug fields, no stages", async () => {
  const { deps, close } = await makeDeps();
  try {
    const res = await recallHandler(deps, { query: "alpha bravo" });
    assert.ok(res.hits.length > 0, "expected at least one hit");
    assert.equal((res as { stages?: unknown }).stages, undefined, "lean must not carry stages");
    const hit = res.hits[0] as Record<string, unknown>;
    assert.equal(typeof hit.id, "string");
    assert.equal(typeof hit.summary, "string");
    assert.ok((hit.summary as string).length > 0, "summary must be present (full)");
    for (const debugKey of ["matched_terms", "mode", "hop", "topic_path"]) {
      assert.equal(hit[debugKey], undefined, `lean hit must not contain ${debugKey}`);
    }
  } finally {
    await close();
  }
});

test("truncateSummary: cuts long summaries at a word boundary with ellipsis, keeps short ones", () => {
  const short = "alpha bravo charlie";
  assert.equal(truncateSummary(short), short, "short summary unchanged");
  const cut = truncateSummary(LONG_SUMMARY);
  assert.ok(cut.length <= 161, `truncated length ${cut.length} must be <= ~160 (+ellipsis)`);
  assert.ok(cut.endsWith("…"), "must end with ellipsis");
  assert.ok(!cut.slice(0, -1).includes("  "), "no mid-word break artifacts");
  assert.ok(LONG_SUMMARY.startsWith(cut.slice(0, -1).trimEnd()), "prefix must match original");
});

test("recall lean: long summary is truncated; full keeps it intact", async () => {
  const { deps, close } = await makeDeps();
  try {
    const lean = await recallHandler(deps, { query: "alpha bravo" });
    const leanHit = (lean.hits as Array<{ id: string; summary: string }>).find((h) => h.id === "longsum");
    assert.ok(leanHit, "longsum must be among hits");
    assert.ok(leanHit!.summary.endsWith("…"), "lean long summary truncated");
    assert.ok(leanHit!.summary.length < LONG_SUMMARY.length);

    const full = await recallHandler(deps, { query: "alpha bravo", verbosity: "full" });
    const fullHit = (full.hits as Array<{ id: string; summary: string }>).find((h) => h.id === "longsum");
    assert.equal(fullHit!.summary, LONG_SUMMARY, "full keeps the complete summary");
  } finally {
    await close();
  }
});

test("recall verbosity:full: brings back matched_terms/topic_path + stages", async () => {
  const { deps, close } = await makeDeps();
  try {
    const res = await recallHandler(deps, { query: "alpha bravo", verbosity: "full" });
    assert.ok(res.hits.length > 0);
    assert.ok((res as { stages?: unknown }).stages !== undefined, "full must carry stages");
    const hit = res.hits[0] as Record<string, unknown>;
    assert.ok("matched_terms" in hit, "full hit must contain matched_terms");
    assert.ok("topic_path" in hit, "full hit must contain topic_path");
  } finally {
    await close();
  }
});

test("recall min_score: drops hits below the threshold", async () => {
  const { deps, close } = await makeDeps();
  try {
    const all = await recallHandler(deps, { query: "alpha bravo", min_score: 0 });
    assert.ok(all.hits.length > 0, "min_score 0 should keep hits");
    const none = await recallHandler(deps, { query: "alpha bravo", min_score: 1e9 });
    assert.equal(none.hits.length, 0, "absurdly high min_score should drop everything");
  } finally {
    await close();
  }
});

test("load_memory lean (default): essential frontmatter, no auto-related block", async () => {
  const { deps, close } = await makeDeps();
  try {
    const res = await loadMemoryHandler(deps, { id: "rich" });
    assert.equal(res.id, "rich");
    // body has the auto-related block stripped
    assert.ok(!res.body.includes(AUTO_RELATED_START), "auto-related block must be stripped");
    assert.ok(res.body.includes("Body for rich echo"), "main body must remain");
    // essential frontmatter present
    assert.equal(res.frontmatter.id, "rich");
    assert.ok("summary" in res.frontmatter);
    assert.ok("recall_when" in res.frontmatter);
    // debug frontmatter dropped
    for (const dbg of ["related_via", "source", "confidence"]) {
      assert.equal(res.frontmatter[dbg], undefined, `lean frontmatter must drop ${dbg}`);
    }
  } finally {
    await close();
  }
});

test("load_memory verbosity:full: complete frontmatter + raw body", async () => {
  const { deps, close } = await makeDeps();
  try {
    const res = await loadMemoryHandler(deps, { id: "rich", verbosity: "full" });
    assert.ok(res.body.includes(AUTO_RELATED_START), "full body keeps auto-related block");
    assert.ok("related_via" in res.frontmatter, "full frontmatter keeps related_via");
    assert.ok("source" in res.frontmatter, "full frontmatter keeps source");
  } finally {
    await close();
  }
});
