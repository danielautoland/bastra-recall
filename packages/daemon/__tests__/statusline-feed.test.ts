/**
 * Tests for statusline-feed.ts — the per-session statusline turn-boundary
 * logic (Issue #51: recall_count under-counts on parallel recalls).
 *
 * The forwarder, at each recall start, reads the on-disk feed and runs
 * `adoptTurn(inMemory, onDisk)`, then increments recall_count. The bug was
 * that the OLD trigger (`onDisk.state === "idle"`) is not idempotent: every
 * recall that observes the idle marker resets the counters, so N parallel
 * recalls reading the same idle marker collapse to recall_count = 1.
 *
 * We model the forwarder's recall-start step and assert the turn_id trigger
 * accumulates correctly where the old state trigger did not.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  adoptTurn,
  defaultStatuslineState,
  idleStatuslineState,
  type StatuslineState,
} from "../src/statusline-feed.ts";

/** Mirror the forwarder's recall-start mutation: adopt the turn, then count. */
function recallStart(
  current: StatuslineState,
  onDisk: Partial<StatuslineState>,
): StatuslineState {
  const s = adoptTurn(current, onDisk);
  return { ...s, state: "running", recall_count: s.recall_count + 1 };
}

/** The OLD (buggy) reset trigger, kept here only to prove the regression:
 *  reset whenever the disk shows state "idle". */
function recallStartOld(
  current: StatuslineState,
  onDisk: Partial<StatuslineState>,
): StatuslineState {
  let s = current;
  if (onDisk.state === "idle") {
    s = {
      ...defaultStatuslineState(),
      vault_size: onDisk.vault_size ?? current.vault_size,
    };
  }
  return { ...s, state: "running", recall_count: s.recall_count + 1 };
}

test("defaultStatuslineState — zeroed, turn_id sentinel 0", () => {
  const s = defaultStatuslineState();
  assert.equal(s.turn_id, 0);
  assert.equal(s.recall_count, 0);
  assert.equal(s.state, "idle");
  assert.equal(s.last_phrase, null);
  assert.equal(s.last_phrase_at, null);
});

test("turn reset clears the done-banner phrase (no leak across turns)", () => {
  // A finished recall left a done phrase behind; the next turn must clear it,
  // otherwise an old "Da, bitte." would hang in the new turn's idle banner.
  const live = {
    ...defaultStatuslineState(),
    turn_id: 700,
    recall_count: 2,
    last_phrase: "Da, bitte.",
    last_phrase_at: 123456,
  };
  const next = adoptTurn(live, idleStatuslineState(800, 10));
  assert.equal(next.last_phrase, null);
  assert.equal(next.last_phrase_at, null);
  assert.equal(next.recall_count, 0);
});

test("idleStatuslineState carries no stale phrase", () => {
  const s = idleStatuslineState(900, 5);
  assert.equal(s.last_phrase, null);
  assert.equal(s.last_phrase_at, null);
});

test("idleStatuslineState — stamps turn_id, preserves vault_size", () => {
  const s = idleStatuslineState(1234, 99);
  assert.equal(s.turn_id, 1234);
  assert.equal(s.vault_size, 99);
  assert.equal(s.recall_count, 0);
  assert.equal(s.state, "idle");
});

test("first recall of a turn adopts the new turn_id and resets", () => {
  let live = { ...defaultStatuslineState(), recall_count: 7, turn_id: 100 }; // stale prev turn
  const idle = idleStatuslineState(200, 42);
  live = recallStart(live, idle);
  assert.equal(live.turn_id, 200);
  assert.equal(live.recall_count, 1);
  assert.equal(live.vault_size, 42); // carried over from the idle marker
});

test("Issue #51 — N recalls reading the SAME idle marker accumulate (fix)", () => {
  // Race: all three parallel recalls observe the same idle marker before any
  // running-flush became visible. The turn_id is adopted exactly once.
  const idle = idleStatuslineState(500, 10);
  let live = defaultStatuslineState();
  live = recallStart(live, idle);
  live = recallStart(live, idle);
  live = recallStart(live, idle);
  assert.equal(live.recall_count, 3);
  assert.equal(live.turn_id, 500);
});

test("Issue #51 — old state-trigger under-counts the same stream (regression)", () => {
  // Same input stream through the OLD logic collapses to 1 — the bug.
  const idle = idleStatuslineState(500, 10);
  let live = defaultStatuslineState();
  live = recallStartOld(live, idle);
  live = recallStartOld(live, idle);
  live = recallStartOld(live, idle);
  assert.equal(live.recall_count, 1); // documents the under-count the fix removes
});

test("a late duplicate idle marker for an already-adopted turn does not clobber", () => {
  const idle = idleStatuslineState(700, 10);
  let live = defaultStatuslineState();
  live = recallStart(live, idle); // adopt turn 700, count 1
  live = recallStart(live, { turn_id: 700, state: "running" }); // count 2
  // prompt-hook's idle marker arrives late, same turn_id → must NOT reset
  live = adoptTurn(live, idle);
  assert.equal(live.recall_count, 2);
  assert.equal(live.turn_id, 700);
});

test("a genuinely new turn_id resets the counters", () => {
  let live = { ...defaultStatuslineState(), turn_id: 700, recall_count: 3 };
  live = recallStart(live, idleStatuslineState(800, 10));
  assert.equal(live.turn_id, 800);
  assert.equal(live.recall_count, 1);
});

test("disk feed without a turn_id never triggers a reset (safe direction)", () => {
  const live = { ...defaultStatuslineState(), turn_id: 900, recall_count: 4 };
  const next = adoptTurn(live, { state: "idle", vault_size: 5 }); // legacy/stale feed
  assert.equal(next.recall_count, 4); // unchanged
  assert.equal(next.turn_id, 900);
});
