/**
 * Unit tests for session-state.ts (#32).
 *
 * Covers:
 *   - roundtrip (save → load preserves shape)
 *   - corrupted/missing files yield empty state
 *   - shouldDropHit logic (count threshold, time window, loaded marker)
 *   - bumpShown counter / reset-on-stale
 *   - touchLoadedMarker / getLoadedMarkerMtime roundtrip
 */
import { test, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let testDir = "";

before(async () => {
  testDir = await mkdtemp(join(tmpdir(), "bastra-hook-test-"));
  process.env.BASTRA_HOOK_STATE_DIR = testDir;
});

after(async () => {
  if (testDir) await rm(testDir, { recursive: true, force: true });
  delete process.env.BASTRA_HOOK_STATE_DIR;
});

// Import AFTER env override so sessionStateDir() picks up the test dir.
const ss = await import("../src/session-state.js");

test("loadSessionState: missing file → empty state", async () => {
  const s = await ss.loadSessionState("nonexistent-session-id");
  assert.deepEqual(s, { shown: {} });
});

test("loadSessionState: corrupted JSON → empty state", async () => {
  const sessionId = "session-corrupt";
  // Write garbage directly to the file
  const filePath = join(testDir, `${sessionId}.json`);
  await writeFile(filePath, "not-valid-json {", "utf8");
  const s = await ss.loadSessionState(sessionId);
  assert.deepEqual(s, { shown: {} });
});

test("saveSessionState + loadSessionState: roundtrip preserves shape", async () => {
  const sessionId = "session-roundtrip";
  const now = Date.now();
  const original: ss.SessionState = {
    shown: {
      "mem-a": { count: 2, at: now - 1000 },
      "mem-b": { count: 1, at: now - 5000 },
    },
  };
  await ss.saveSessionState(sessionId, original);
  const loaded = await ss.loadSessionState(sessionId);
  assert.deepEqual(loaded, original);
});

test("saveSessionState: empty session id is a no-op (no throw, no file)", async () => {
  await ss.saveSessionState("", { shown: { x: { count: 1, at: Date.now() } } });
  const back = await ss.loadSessionState("");
  assert.deepEqual(back, { shown: {} });
});

test("shouldDropHit: no entry → never drop", () => {
  assert.equal(ss.shouldDropHit(undefined, null), false);
});

test("shouldDropHit: count below threshold → keep", () => {
  const entry = { count: ss.MAX_SHOW - 1, at: Date.now() };
  assert.equal(ss.shouldDropHit(entry, null), false);
});

test("shouldDropHit: count at threshold within window → drop", () => {
  const entry = { count: ss.MAX_SHOW, at: Date.now() };
  assert.equal(ss.shouldDropHit(entry, null), true);
});

test("shouldDropHit: count above threshold within window → drop", () => {
  const entry = { count: ss.MAX_SHOW + 5, at: Date.now() };
  assert.equal(ss.shouldDropHit(entry, null), true);
});

test("shouldDropHit: count threshold but window expired → keep", () => {
  const entry = { count: ss.MAX_SHOW, at: Date.now() - ss.RESET_WINDOW_MS - 1000 };
  assert.equal(ss.shouldDropHit(entry, null), false);
});

test("shouldDropHit: loaded marker newer than entry.at → keep (reset clock)", () => {
  const now = Date.now();
  const entry = { count: ss.MAX_SHOW, at: now - 60_000 }; // shown 1 min ago
  const markerNewer = now - 30_000; // loaded 30s ago — newer than shown
  assert.equal(ss.shouldDropHit(entry, markerNewer, now), false);
});

test("shouldDropHit: loaded marker older than entry.at → drop (already shown after load)", () => {
  const now = Date.now();
  const entry = { count: ss.MAX_SHOW, at: now - 30_000 }; // shown 30s ago
  const markerOlder = now - 60_000; // loaded 1 min ago, before last show
  assert.equal(ss.shouldDropHit(entry, markerOlder, now), true);
});

test("bumpShown: first-time entry starts at count=1", () => {
  const state: ss.SessionState = { shown: {} };
  const now = 1_000_000;
  ss.bumpShown(state, "mem-x", now);
  assert.deepEqual(state.shown["mem-x"], { count: 1, at: now });
});

test("bumpShown: within window increments", () => {
  const now = 1_000_000;
  const state: ss.SessionState = { shown: { "mem-x": { count: 2, at: now - 1000 } } };
  ss.bumpShown(state, "mem-x", now);
  assert.equal(state.shown["mem-x"].count, 3);
  assert.equal(state.shown["mem-x"].at, now);
});

test("bumpShown: outside window resets to 1", () => {
  const now = 1_000_000;
  const state: ss.SessionState = {
    shown: { "mem-x": { count: 5, at: now - ss.RESET_WINDOW_MS - 1 } },
  };
  ss.bumpShown(state, "mem-x", now);
  assert.equal(state.shown["mem-x"].count, 1);
  assert.equal(state.shown["mem-x"].at, now);
});

test("touchLoadedMarker + getLoadedMarkerMtime: roundtrip", async () => {
  const memId = "test-mem-touch";
  const before = await ss.getLoadedMarkerMtime(memId);
  assert.equal(before, null, "no marker before touch");
  await ss.touchLoadedMarker(memId);
  const after = await ss.getLoadedMarkerMtime(memId);
  assert.ok(after !== null, "marker exists after touch");
  assert.ok((after as number) > Date.now() - 5000, "marker mtime is recent");
});

test("end-to-end drop logic: write → read → shouldDrop after 3 shows", async () => {
  const sessionId = "session-e2e";
  const memId = "mem-noisy";
  const now = Date.now();
  // Show 3 times
  const state: ss.SessionState = { shown: {} };
  ss.bumpShown(state, memId, now - 3000);
  ss.bumpShown(state, memId, now - 2000);
  ss.bumpShown(state, memId, now - 1000);
  assert.equal(state.shown[memId].count, 3);
  await ss.saveSessionState(sessionId, state);

  const reloaded = await ss.loadSessionState(sessionId);
  const entry = reloaded.shown[memId];
  // 4th hook call: should drop
  assert.equal(ss.shouldDropHit(entry, null, now), true);

  // Now agent calls load_memory(memId) → marker is touched
  await ss.touchLoadedMarker(memId);
  const marker = await ss.getLoadedMarkerMtime(memId);
  assert.ok(marker !== null);
  // Next hook call after the touch: dedup clock reset, should NOT drop
  assert.equal(ss.shouldDropHit(entry, marker, Date.now()), false);
});
