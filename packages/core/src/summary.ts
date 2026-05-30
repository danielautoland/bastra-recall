/**
 * Summary truncation — the single source of truth for the `summary` field's
 * length budget, shared by the save path (save.ts), the load/parse path
 * (schema.ts) and the daemon's lean-recall snippet.
 *
 * Why this lives in its own leaf module: save.ts already imports from
 * schema.ts, so putting the helper in either would create an import cycle
 * (schema.ts -> save.ts -> schema.ts). A dependency-free leaf avoids that and
 * lets both schemas import it.
 */

/** Hard length budget for a stored `summary` (characters, incl. ellipsis). */
export const SUMMARY_MAX = 400;

/**
 * Truncate `summary` to at most `max` characters *including* the trailing
 * ellipsis, cutting at the last word boundary when one sits reasonably close
 * to the end (>60% of the budget), otherwise hard-cutting.
 *
 * Codepoint-safe: iterates by Unicode code point (`[...summary]`), so a
 * surrogate pair (emoji) or astral character is never split mid-character —
 * unlike a raw UTF-16 `slice`. Strings already within `max` are returned
 * unchanged, which makes the function idempotent (re-truncating a truncated
 * value is a no-op).
 */
export function truncateSummaryTo(summary: string, max: number): string {
  // Fast path: UTF-16 .length is an upper bound on the code-point count, so a
  // string within budget here cannot exceed it in code points — return without
  // allocating the spread. Matters in the load hot loop (every memory on
  // vault.init / reindex / watch runs this).
  if (summary.length <= max) return summary;
  const chars = [...summary];
  if (chars.length <= max) return summary;
  const budget = max - 1; // reserve one code point for the "…"
  const head = chars.slice(0, budget);
  // lastIndexOf on the code-point array → a code-point index, dimensionally
  // consistent with `budget` (mixing it with a UTF-16 index would mis-judge the
  // word-boundary threshold for astral-character-heavy summaries).
  const lastSpace = head.lastIndexOf(" ");
  const cut = lastSpace > budget * 0.6 ? head.slice(0, lastSpace) : head;
  return `${cut.join("").trimEnd()}…`;
}

/**
 * Clamp a summary to {@link SUMMARY_MAX} and report whether it was shortened.
 * Used on the save path so the caller can surface a non-fatal note instead of
 * rejecting an over-long summary with a Zod error (which forces a retry).
 */
export function clampSummary(summary: string): { summary: string; truncated: boolean } {
  const clamped = truncateSummaryTo(summary, SUMMARY_MAX);
  return { summary: clamped, truncated: clamped !== summary };
}
