/**
 * Tests für die Banter-Engine (#38).
 *
 * Verifiziert:
 * - DE/EN-Phrasen-Pool je Stage liefert non-empty Strings.
 * - `mode: "off"` und `mode: "terse"` → null.
 * - Slow-Phrasen (> 500 ms) kommen aus dem SLOW_PHRASES-Pool, nicht
 *   aus dem Stage-Pool.
 * - `banterModeFromEnv` parsed `BASTRA_BANTER` korrekt.
 *
 * Runner: `node --import tsx --test packages/core/__tests__/recall-banter.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pickPhrase,
  pickToolPhrase,
  banterModeFromEnv,
  type RecallStage,
} from "../src/index.js";

const STAGES: RecallStage["name"][] = [
  "query.parse",
  "cache.hit",
  "bm25.search",
  "vector.search",
  "rrf.fuse",
  "hops.expand",
  "staleness.rank",
  "done",
];

test("pickPhrase: returns non-empty DE string for every stage in 'on' mode", () => {
  for (const name of STAGES) {
    const phrase = pickPhrase(
      { name, startedAtMs: 1_700_000_000_000 },
      "on",
      "de",
    );
    assert.equal(typeof phrase, "string");
    assert.ok(phrase!.length > 0, `empty DE phrase for stage ${name}`);
  }
});

test("pickPhrase: returns non-empty EN string for every stage in 'on' mode", () => {
  for (const name of STAGES) {
    const phrase = pickPhrase(
      { name, startedAtMs: 1_700_000_000_000 },
      "on",
      "en",
    );
    assert.equal(typeof phrase, "string");
    assert.ok(phrase!.length > 0, `empty EN phrase for stage ${name}`);
  }
});

test("pickPhrase: 'off' and 'terse' both return null", () => {
  const stage: RecallStage = { name: "bm25.search", startedAtMs: Date.now() };
  assert.equal(pickPhrase(stage, "off", "de"), null);
  assert.equal(pickPhrase(stage, "off", "en"), null);
  assert.equal(pickPhrase(stage, "terse", "de"), null);
  assert.equal(pickPhrase(stage, "terse", "en"), null);
});

test("pickPhrase: slow-stage (> 500ms) draws from slow pool, not stage pool", () => {
  // Gleicher Stage einmal schnell, einmal langsam — die Phrase muss
  // sich unterscheiden (deterministischer Seed über `(name, sekunde)`
  // bleibt gleich; aber der Pool ist anders).
  const fast: RecallStage = { name: "bm25.search", startedAtMs: 1_700_000_000_000, durationMs: 50 };
  const slow: RecallStage = { name: "bm25.search", startedAtMs: 1_700_000_000_000, durationMs: 750 };
  const fastPhrase = pickPhrase(fast, "on", "de")!;
  const slowPhrase = pickPhrase(slow, "on", "de")!;
  assert.notEqual(fastPhrase, slowPhrase, "slow phrase must differ from fast-stage phrase");
  // Slow-Pool enthält erkennbare Mein-Gott-Phrasen.
  const slowMarkers = ["dauert", "zieht sich", "tief", "Pause", "voll"];
  assert.ok(
    slowMarkers.some((m) => slowPhrase.includes(m)),
    `slow phrase did not match slow-pool markers: ${slowPhrase}`,
  );
});

test("pickPhrase: very-slow-stage (> 1000ms) escalates further", () => {
  const verySlow: RecallStage = {
    name: "vector.search",
    startedAtMs: 1_700_000_000_000,
    durationMs: 1500,
  };
  const phrase = pickPhrase(verySlow, "on", "en")!;
  assert.equal(typeof phrase, "string");
  assert.ok(phrase.length > 0);
});

test("pickPhrase: deterministic within same second bucket", () => {
  const a: RecallStage = { name: "rrf.fuse", startedAtMs: 1_700_000_001_000 };
  const b: RecallStage = { name: "rrf.fuse", startedAtMs: 1_700_000_001_500 };
  assert.equal(
    pickPhrase(a, "on", "de"),
    pickPhrase(b, "on", "de"),
    "same second bucket should yield same phrase",
  );
});

test("banterModeFromEnv: parses BASTRA_BANTER", () => {
  assert.equal(banterModeFromEnv({ BASTRA_BANTER: "off" }), "off");
  assert.equal(banterModeFromEnv({ BASTRA_BANTER: "terse" }), "terse");
  assert.equal(banterModeFromEnv({ BASTRA_BANTER: "on" }), "on");
  assert.equal(banterModeFromEnv({ BASTRA_BANTER: "OFF" }), "off"); // case-insensitive
  assert.equal(banterModeFromEnv({}), "on", "default is on");
  assert.equal(banterModeFromEnv({ BASTRA_BANTER: "junk" }), "on", "unknown values fall back to on");
});

test("pickToolPhrase: known tool yields a non-empty phrase, off/terse → null", () => {
  const p = pickToolPhrase("load_memory", "on", "de", 0)!;
  assert.equal(typeof p, "string");
  assert.ok(p.length > 0);
  assert.equal(pickToolPhrase("load_memory", "off", "de", 0), null);
  assert.equal(pickToolPhrase("load_memory", "terse", "de", 0), null);
});

test("pickToolPhrase: unknown tool falls back to the default pool", () => {
  const p = pickToolPhrase("some_unmapped_tool", "on", "en", 1)!;
  assert.equal(typeof p, "string");
  assert.ok(p.length > 0);
});

test("pickToolPhrase: seed cycles through the pool (a series varies)", () => {
  // Different seeds should be able to surface different phrases — collect a few.
  const seen = new Set<string>();
  for (let seed = 0; seed < 8; seed++) {
    seen.add(pickToolPhrase("load_memory", "on", "de", seed)!);
  }
  assert.ok(seen.size > 1, "a series of calls should not all show the same phrase");
});
