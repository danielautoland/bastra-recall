/**
 * Tests für die Summary-Truncation (#48-Folge: kein too_big-Reject mehr).
 *
 * Verifiziert:
 * - truncateSummaryTo: Output nie > max (inkl. Ellipsis), Wortgrenze,
 *   Single-Long-Word-Hardcut, codepoint-sicher (kein Split einer
 *   Surrogate-Pair), idempotent.
 * - clampSummary: meldet, ob gekürzt wurde.
 * - Save-Pfad (SaveMemoryInput): akzeptiert eine >400-summary (kein Reject).
 * - Load-Pfad (FrontmatterSchema): kürzt eine >400-summary statt zu werfen
 *   (sonst stiller Skip = Datenverlust), leere summary bleibt abgelehnt.
 *
 * Runner: `node --import tsx --test packages/core/__tests__/summary.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { truncateSummaryTo, clampSummary, SUMMARY_MAX } from "../src/summary.js";
import { SaveMemoryInput, saveMemory } from "../src/save.js";
import { FrontmatterSchema, parseMemoryWith } from "../src/schema.js";

test("SUMMARY_MAX is 400 (shared by save + load → SAVE cap == LOAD cap)", () => {
  assert.equal(SUMMARY_MAX, 400);
});

test("truncateSummaryTo: leaves a summary within budget unchanged", () => {
  const s = "kurz und knapp";
  assert.equal(truncateSummaryTo(s, 400), s);
});

test("truncateSummaryTo: output length never exceeds max (incl. ellipsis)", () => {
  const long = "wort ".repeat(200); // ~1000 chars
  const out = truncateSummaryTo(long, 400);
  assert.ok([...out].length <= 400, `length ${[...out].length} must be <= 400`);
  assert.ok(out.endsWith("…"));
});

test("truncateSummaryTo: cuts at a word boundary, not mid-word", () => {
  const long = "alpha bravo charlie delta echo foxtrot ".repeat(20);
  const out = truncateSummaryTo(long, 40);
  const body = out.slice(0, -1); // drop the ellipsis
  assert.ok(long.startsWith(body), "kept text is a prefix of the input");
  assert.ok(
    long[body.length] === " " || body.length === long.length,
    "the cut lands on a space (whole-word boundary)",
  );
});

test("truncateSummaryTo: hard-cuts a single very long word", () => {
  const word = "x".repeat(500);
  const out = truncateSummaryTo(word, 100);
  assert.ok([...out].length <= 100);
  assert.ok(out.endsWith("…"));
});

test("truncateSummaryTo: codepoint-safe — never splits a surrogate pair", () => {
  const emoji = "😀".repeat(300); // 300 code points = 600 UTF-16 units
  const out = truncateSummaryTo(emoji, 100);
  assert.ok([...out].length <= 100);
  for (const ch of out) {
    const cp = ch.codePointAt(0)!;
    assert.ok(!(cp >= 0xd800 && cp <= 0xdfff), "no lone surrogate at the cut");
  }
});

test("truncateSummaryTo: idempotent (re-truncating a truncated value is a no-op)", () => {
  const long = "satz ".repeat(200);
  const once = truncateSummaryTo(long, 400);
  assert.equal(truncateSummaryTo(once, 400), once);
});

test("clampSummary: reports whether the summary was shortened", () => {
  assert.deepEqual(clampSummary("kurz"), { summary: "kurz", truncated: false });
  const { summary, truncated } = clampSummary("a ".repeat(500));
  assert.equal(truncated, true);
  assert.ok([...summary].length <= SUMMARY_MAX);
});

test("save path: SaveMemoryInput accepts a >400 summary (no too_big reject)", () => {
  const r = SaveMemoryInput.shape.summary.safeParse("x".repeat(600));
  assert.equal(r.success, true);
});

test("load path: FrontmatterSchema truncates a >400 summary instead of rejecting", () => {
  const r = FrontmatterSchema.shape.summary.safeParse("y".repeat(600));
  assert.equal(r.success, true);
  assert.ok(r.success && [...r.data].length <= SUMMARY_MAX);
});

test("load path: an empty summary is still rejected", () => {
  const r = FrontmatterSchema.shape.summary.safeParse("");
  assert.equal(r.success, false);
});

test("save path e2e: an over-long summary is truncated on disk, returns a note, and re-parses", async () => {
  const root = await mkdtemp(join(tmpdir(), "bastra-summary-"));
  const longSummary = "Dies ist ein viel zu langer Zusammenfassungssatz. ".repeat(15); // ~750 chars
  const res = await saveMemory(root, {
    title: "Summary Truncation Roundtrip",
    type: "lesson",
    summary: longSummary,
    body: "Body content.",
    topic_path: ["test"],
    tags: ["test"],
    scope: "test",
    recall_when: ["over-long summary save"],
  });
  assert.ok(res.summary_note?.includes("400"), "result carries a truncation note");
  const raw = await readFile(res.file_path, "utf8");
  const parsed = parseMemoryWith((s) => matter(s), raw, res.file_path, 0);
  assert.ok([...parsed.fm.summary].length <= SUMMARY_MAX, "stored summary fits the cap");
  assert.ok(parsed.fm.summary.endsWith("…"), "truncation ellipsis present");
});
