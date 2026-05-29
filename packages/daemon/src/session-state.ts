/**
 * session-state — per-session tmpfile dedup for the PreToolUse hook (#32).
 *
 * Problem: the hook is stateless across invocations within the SAME Claude
 * session, so the same memory can appear in the <recall-hints> block on
 * every Write/Edit. Telemetry showed one lesson dominating 67% of misses.
 *
 * Solution: store a small JSON state per `session_id` under
 * `/tmp/bastra-hook/<session_id>.json` with shape `{ shown: { [memId]:
 * { count, at } } }`. Each hook call:
 *   1. Loads the session state (best-effort, returns empty on any error).
 *   2. Filters hits: if a hit has been shown >= MAX_SHOW times AND was
 *      shown within the last RESET_WINDOW_MS, drop it.
 *   3. After emitting the hint block, bumps `count` for every hit that
 *      was actually shown and writes the state atomically (tmpfile + rename).
 *
 * Reset signal: the daemon writes a touch-file `/tmp/bastra-hook/loaded-
 * <memId>.touch` whenever `load_memory(id)` is invoked. The hook
 * consults the touch-file mtime — if `at < loaded.mtime`, the counter is
 * reset (the agent has now consumed that memory, so the dedup-clock starts
 * over).
 *
 * Race conditions: tmpfile + rename gives atomic writes. Two hooks racing
 * on the same session can off-by-one the counter — acceptable per the
 * acceptance criteria.
 */
import { mkdir, readFile, rename, stat, writeFile, readdir, unlink } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

export interface ShownEntry {
  count: number;
  at: number; // ms since epoch when last shown
}

export interface SessionState {
  shown: Record<string, ShownEntry>;
}

/** Threshold above which a memory is dropped from hints (#32 acceptance). */
export const MAX_SHOW = 3;
/** Window in ms after which the dedup counter expires (4h per #32). */
export const RESET_WINDOW_MS = 4 * 60 * 60 * 1000;
/** Cleanup: drop session files older than this (mtime). */
export const STATE_MAX_AGE_MS = 4 * 60 * 60 * 1000;

const DEFAULT_DIR = path.join(os.tmpdir(), "bastra-hook");

export function sessionStateDir(): string {
  return process.env.BASTRA_HOOK_STATE_DIR || DEFAULT_DIR;
}

function sessionFile(sessionId: string, dir = sessionStateDir()): string {
  // sanitize — defensive; session ids should be UUIDs but a stray slash
  // would let an attacker write outside the dir.
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(dir, `${safe}.json`);
}

function loadedMarkerFile(memId: string, dir = sessionStateDir()): string {
  const safe = memId.replace(/[^a-zA-Z0-9_.\-]/g, "_");
  return path.join(dir, `loaded-${safe}.touch`);
}

/**
 * Load the session state. Never throws — on any error (missing file,
 * malformed JSON, EACCES, …) we return an empty state and let the hook
 * proceed without dedup.
 */
export async function loadSessionState(sessionId: string): Promise<SessionState> {
  if (!sessionId) return { shown: {} };
  try {
    const raw = await readFile(sessionFile(sessionId), "utf8");
    const parsed = JSON.parse(raw) as Partial<SessionState>;
    if (!parsed || typeof parsed !== "object" || !parsed.shown) {
      return { shown: {} };
    }
    return { shown: parsed.shown as Record<string, ShownEntry> };
  } catch {
    return { shown: {} };
  }
}

/**
 * Atomically persist the session state. Best-effort: failures are
 * swallowed so the hook never breaks the user's tool call.
 */
export async function saveSessionState(sessionId: string, state: SessionState): Promise<void> {
  if (!sessionId) return;
  try {
    const dir = sessionStateDir();
    await mkdir(dir, { recursive: true });
    const target = sessionFile(sessionId, dir);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(state), "utf8");
    await rename(tmp, target);
  } catch {
    // dedup state is non-essential — never break the hot path
  }
}

/**
 * Cleanup: best-effort sweep of session files older than `maxAgeMs`. Runs
 * lazily from the hook (only when we already loaded a state, so we don't
 * pay for it on every cold call).
 */
export async function cleanupOldStates(maxAgeMs: number = STATE_MAX_AGE_MS): Promise<void> {
  try {
    const dir = sessionStateDir();
    const entries = await readdir(dir);
    const now = Date.now();
    await Promise.all(
      entries.map(async (name) => {
        if (!name.endsWith(".json") && !name.endsWith(".touch")) return;
        const full = path.join(dir, name);
        try {
          const st = await stat(full);
          if (now - st.mtimeMs > maxAgeMs) await unlink(full);
        } catch {
          // ignore — concurrent unlink or transient FS error
        }
      }),
    );
  } catch {
    // missing dir is fine
  }
}

/**
 * Touch the loaded-marker for `memId`. Called from the daemon's
 * load_memory tool handler so subsequent hook calls reset the dedup
 * counter for this memory.
 */
export async function touchLoadedMarker(memId: string): Promise<void> {
  if (!memId) return;
  try {
    const dir = sessionStateDir();
    await mkdir(dir, { recursive: true });
    const file = loadedMarkerFile(memId, dir);
    // open-write-close gives us a fresh mtime even if the file already exists
    await writeFile(file, String(Date.now()), "utf8");
  } catch {
    // marker is advisory — never break load_memory if /tmp is unwritable
  }
}

/**
 * Returns the mtime of the loaded-marker for `memId`, or null if no
 * marker exists. Hook uses this to decide whether to reset the dedup
 * counter (counter resets if last-shown `at` < marker mtime).
 */
export async function getLoadedMarkerMtime(memId: string): Promise<number | null> {
  if (!memId) return null;
  try {
    const st = await stat(loadedMarkerFile(memId));
    return st.mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Decide whether a hit with id `memId` should be dropped from the hint
 * block. Pure function — no I/O — so the unit test can pin behavior.
 *
 *   shouldDrop(state.shown[memId], loadedMarkerMtime, now)
 *
 *   - No prior entry → false (always show).
 *   - Entry older than RESET_WINDOW_MS → false (stale, treat as fresh).
 *   - load_memory marker newer than entry.at → false (agent consumed it,
 *     dedup clock resets).
 *   - count >= MAX_SHOW AND within window AND no newer load marker → true.
 */
export function shouldDropHit(
  entry: ShownEntry | undefined,
  loadedMarkerMtime: number | null,
  now: number = Date.now(),
): boolean {
  if (!entry) return false;
  if (now - entry.at >= RESET_WINDOW_MS) return false;
  if (loadedMarkerMtime !== null && loadedMarkerMtime > entry.at) return false;
  return entry.count >= MAX_SHOW;
}

/**
 * Bump the shown-count for `memId` in `state` (mutates in place) and
 * stamp the current time.
 */
export function bumpShown(state: SessionState, memId: string, now: number = Date.now()): void {
  const prev = state.shown[memId];
  if (!prev || now - prev.at >= RESET_WINDOW_MS) {
    state.shown[memId] = { count: 1, at: now };
  } else {
    state.shown[memId] = { count: prev.count + 1, at: now };
  }
}
