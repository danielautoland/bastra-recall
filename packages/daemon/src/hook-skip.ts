/**
 * hook-skip — fast path/extension filter for the PreToolUse hook.
 *
 * Goal: cheaply decide "is this Write/Edit even worth a recall round-trip?"
 * BEFORE we load `@bastra-recall/core` or hit the daemon. Pure stdlib, no
 * deps — kept in its own module so hook.ts can stay tight and so the
 * matrix is unit-testable in isolation.
 *
 * Heuristic (see issue #20):
 *   - Skip extensions: .txt, .rst, .log, .tmp, .cache, .lock — never source.
 *   - Skip .md OUTSIDE of any `docs/` segment. Docs writes can legitimately
 *     benefit from prior context, everything else (issue bodies, scratch
 *     notes, plan files) is transient.
 *   - Skip transient basenames: issue-*, pr-*, CHANGELOG*, README*,
 *     CONTRIBUTING*, LICENSE*, .env*.
 */
import * as path from "node:path";

const SKIP_EXTENSIONS = new Set<string>([
  ".txt",
  ".rst",
  ".log",
  ".tmp",
  ".cache",
  ".lock",
]);

const SKIP_BASENAME_PATTERNS: RegExp[] = [
  /^issue-/i,
  /^pr-/i,
  /^CHANGELOG/i,
  /^README/i,
  /^CONTRIBUTING/i,
  /^LICENSE/i,
  /^\.env/,
];

/**
 * Returns `true` if the path should be skipped (no recall round-trip).
 * Returns `false` if the file is plausibly source code worth recalling for.
 *
 * `cwd` is currently informational only — kept in the signature so future
 * refinements (e.g. respect a project-level skip-list) don't have to break
 * the call sites.
 */
export function shouldSkipPath(filePath: string, _cwd?: string): boolean {
  if (!filePath) return true;
  const norm = filePath.replace(/\\/g, "/");
  const ext = path.extname(norm).toLowerCase();
  const base = path.basename(norm);

  // Hard-skip basenames — transient or non-code regardless of extension.
  for (const rx of SKIP_BASENAME_PATTERNS) {
    if (rx.test(base)) return true;
  }

  // Hard-skip extensions.
  if (SKIP_EXTENSIONS.has(ext)) return true;

  // .md is conditional: keep ACTIVE if anywhere in the path is a `docs/`
  // segment (case-insensitive). Otherwise skip — issue bodies, ad-hoc
  // plans, scratch notes don't benefit from a project-wide recall.
  if (ext === ".md") {
    const segments = norm.toLowerCase().split("/");
    const inDocs = segments.includes("docs");
    return !inDocs;
  }

  return false;
}
