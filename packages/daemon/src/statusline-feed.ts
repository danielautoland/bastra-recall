/**
 * Per-session statusline feed state + turn-boundary logic.
 *
 * The MCP forwarder owns the authoritative copy of this state IN MEMORY and
 * flushes it to `~/.bastra/statusline/<claude-session-pid>.json`. The
 * UserPromptSubmit prompt-hook resets it to idle at each turn boundary. Both
 * processes only communicate through that one file, so the turn boundary has
 * to be derived from its contents.
 *
 * Why a `turn_id` and not `state === "idle"` (Issue #51): the old reset
 * trigger fired on a *state* — every recall that read `state: "idle"` reset
 * the counters. A late/duplicate idle marker landing mid-sequence (the
 * prompt-hook runs in a separate, slower-to-start process) therefore nulled
 * `recall_count` *after* parallel recalls had already counted up → the
 * statusline showed `1 call` instead of `N`. The `turn_id` ties the reset to
 * an *event* (a turn change) that the forwarder adopts exactly once: the first
 * recall to see a new id resets, every later recall in that turn sees the same
 * id and accumulates. Repeated idle markers with an already-adopted id are
 * idempotent — no clobber.
 */

export interface StatuslineState {
  ts: number;
  /** Monotonic-enough id stamped by the prompt-hook at each turn start
   *  (`Date.now()` of UserPromptSubmit). The forwarder adopts it once per turn
   *  and preserves it across flushes. */
  turn_id: number;
  state: "idle" | "running";
  vault_size: number;
  /** Count of bastra tool calls this turn — recalls AND non-streaming tools
   *  (load_memory, save_memory, …), so the statusline stays alive on
   *  load_memory-heavy turns. Rendered as "N calls". */
  recall_count: number;
  /** Recall-only: summed hits / elapsed ms. Stay 0 on load_memory-only turns
   *  (the renderer then omits the "hits/ms" segment). */
  total_hits: number;
  total_ms: number;
  current_stage: string | null;
  /** Human-readable banter phrase for the running stage (e.g. "Semantik
   *  abgleichen …"). The statusline segment renders this when present and
   *  falls back to the raw `current_stage` name. `null` when banter is off or
   *  no recall is in flight. */
  current_message: string | null;
  current_stage_started_at: number | null;
  current_recall_started_at: number | null;
  /** Banter phrase shown in the DONE banner after a recall finishes. Unlike
   *  current_message (visible only during the ~120ms running window, which the
   *  ≥1s statusline refresh almost never catches), this persists in the
   *  done-snapshot — the only state reliably rendered. Cleared on the next turn
   *  via adoptTurn/defaultStatuslineState (so it never leaks across turns). */
  last_phrase: string | null;
  /** Unix-ms when last_phrase was set. The statusline segment hides the phrase
   *  once it is older than its TTL (~10s), falling back to the bare banner. */
  last_phrase_at: number | null;
}

/** Fresh zeroed state. `turn_id: 0` is the "no turn adopted yet" sentinel —
 *  the first real prompt-hook turn_id (a Date.now() ms value) always differs. */
export function defaultStatuslineState(): StatuslineState {
  return {
    ts: 0,
    turn_id: 0,
    state: "idle",
    vault_size: 0,
    recall_count: 0,
    total_hits: 0,
    total_ms: 0,
    current_stage: null,
    current_message: null,
    current_stage_started_at: null,
    current_recall_started_at: null,
    last_phrase: null,
    last_phrase_at: null,
  };
}

/**
 * The idle marker the prompt-hook writes at a turn boundary. Carries a fresh
 * `turn_id` so the forwarder knows a new turn started, and preserves the last
 * known `vault_size` so the statusline keeps showing `N memories` while idle.
 */
export function idleStatuslineState(turnId: number, vaultSize: number): StatuslineState {
  return {
    ...defaultStatuslineState(),
    ts: turnId,
    turn_id: turnId,
    vault_size: vaultSize,
  };
}

/**
 * Turn-boundary decision (Issue #51). Called by the forwarder at recall start
 * with its in-memory `current` state and whatever is `onDisk`.
 *
 * Returns a *fresh* turn (counters zeroed, new turn_id adopted, vault_size
 * carried over) iff the disk shows a turn_id we have not adopted yet.
 * Otherwise returns `current` unchanged — so parallel recalls in the same turn
 * accumulate, and a late/duplicate idle marker for an already-adopted turn is
 * ignored. A disk file without a `turn_id` (e.g. a stale pre-fix feed) never
 * triggers a reset, which is the safe direction.
 */
export function adoptTurn(
  current: StatuslineState,
  onDisk: Partial<StatuslineState> | null | undefined,
): StatuslineState {
  const diskTurn = onDisk?.turn_id;
  if (typeof diskTurn === "number" && diskTurn !== current.turn_id) {
    return {
      ...defaultStatuslineState(),
      turn_id: diskTurn,
      vault_size:
        typeof onDisk?.vault_size === "number" ? onDisk.vault_size : current.vault_size,
    };
  }
  return current;
}
