#!/usr/bin/env node
/**
 * bastra-recall stop-hook — autonomous save-evaluation at Stop event.
 *
 * Looks at the recent transcript and surfaces save-suggestions when one of
 * three heuristics fires. Never calls save_memory itself — only suggests
 * (the agent decides in the next turn whether to act).
 *
 * Heuristics:
 *   1. Frustration-Density   — >=4 cues AND >=2 explicit frustration words
 *      (`wieder/schon wieder/wie oft/fuck/verdammt/scheisse`) in the last 10
 *      user turns. CAPS words count as cues only when they are >=5 chars or
 *      repeated in a turn AND not a technical acronym (SKILL/JSON/…); CAPS
 *      alone never triggers.
 *   2. Feature-Completion    — `git commit` mentioned in a USER turn + >=5
 *      distinct repo-relative source-file tokens, at least one of which exists
 *      under the session cwd.
 *   3. Architecture-Decision — `ok dann | lass uns | entschieden | final |
 *      gehen wir mit` in the last 5 user turns.
 *
 * Output: `<save-eval>` blocks, one per matched heuristic. No tool calls.
 *
 * Discipline:
 *   - Budget 1000 ms. Any failure path emits `{}` and exits 0.
 *   - Never blocks the workflow.
 *   - Telemetry best-effort.
 */
import { readFile, appendFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { envFirst, envInt } from "./env.js";
import { defaultLogDir } from "./telemetry.js";

const HOOK_TIMEOUT_MS = envInt("BASTRA_STOP_HOOK_TIMEOUT_MS", 1000);
const HOOK_VERSION = "0.1.0";
const FRUSTRATION_WINDOW_TURNS = 10;
const FRUSTRATION_CUE_THRESHOLD = 4;
const FRUSTRATION_FRUSTWORD_MIN = 2;
const DECISION_WINDOW_TURNS = 5;
const FEATURE_FILE_TOKEN_MIN = 5;

interface ClaudeStopPayload {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  transcript_path?: string;
  transcript?: unknown;
  stop_hook_active?: boolean;
}

interface TranscriptTurn {
  role: "user" | "assistant" | "system" | string;
  content: string;
}

type Heuristic = "frustration-density" | "feature-completion" | "architecture-decision";

interface SaveSuggestion {
  heuristic: Heuristic;
  title: string;
  type: "lesson" | "project-fact" | "decision";
  body: string;
}

async function main(): Promise<void> {
  const startedAt = Date.now();

  const raw = await readStdin();
  let payload: ClaudeStopPayload;
  try {
    payload = JSON.parse(raw) as ClaudeStopPayload;
  } catch {
    return emitEmpty();
  }

  if (payload.hook_event_name !== "Stop") return emitEmpty();
  if (payload.stop_hook_active === true) return emitEmpty();

  const turns = await loadTranscript(payload);
  if (turns.length === 0) return emitEmpty();

  const last30 = turns.slice(-30);
  const suggestions = evaluateHeuristics(last30, { cwd: payload.cwd });

  if (suggestions.length === 0) {
    emitEmpty();
  } else {
    // Stop-Hook hat kein hookSpecificOutput im Claude-Code-Schema.
    // Nur top-level Felder erlaubt: continue, suppressOutput, stopReason,
    // decision, reason, systemMessage, terminalSequence, permissionDecision.
    // → systemMessage trägt den <save-eval>-Block (sichtbar für den Agent).
    const blocks = suggestions.map(formatSuggestion).join("\n");
    process.stdout.write(
      JSON.stringify({
        systemMessage: blocks,
      }),
    );
  }

  const totalMs = Date.now() - startedAt;
  await writeTelemetry({
    heuristic: suggestions.map((s) => s.heuristic).join(",") || null,
    suggested_count: suggestions.length,
    turn_count: turns.length,
    latency_ms_total: totalMs,
  });
}

function emitEmpty(): void {
  process.stdout.write("{}");
}

async function loadTranscript(payload: ClaudeStopPayload): Promise<TranscriptTurn[]> {
  if (Array.isArray(payload.transcript)) {
    return normalizeTurns(payload.transcript as unknown[]);
  }
  if (typeof payload.transcript_path === "string") {
    try {
      const content = await readFile(payload.transcript_path, "utf8");
      return parseTranscriptFile(content);
    } catch {
      return [];
    }
  }
  return [];
}

function parseTranscriptFile(raw: string): TranscriptTurn[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed) as unknown[];
      return normalizeTurns(arr);
    } catch {
      return [];
    }
  }
  const out: unknown[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const l = line.trim();
    if (!l) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      // skip
    }
  }
  return normalizeTurns(out);
}

// In Claude-Code transcripts a tool result is stored as a `role: "user"`
// message whose content is an array of `tool_result` blocks (bash/tool output).
// That is NOT human prose — the frustration / decision heuristics must not scan
// it. We reclassify such turns to role "tool" so only genuine typed user
// messages keep role "user". Feature-completion still scans every turn's text.
function isToolResultContent(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some(
      (b) => b && typeof b === "object" && (b as Record<string, unknown>).type === "tool_result",
    )
  );
}

function effectiveRole(role: string, content: unknown): string {
  if (role === "user" && isToolResultContent(content)) return "tool";
  return role;
}

function normalizeTurns(items: unknown[]): TranscriptTurn[] {
  const out: TranscriptTurn[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const directRole = obj.role;
    const directContent = obj.content;
    if (typeof directRole === "string") {
      out.push({ role: effectiveRole(directRole, directContent), content: stringifyContent(directContent) });
      continue;
    }
    const msg = obj.message;
    if (msg && typeof msg === "object") {
      const m = msg as Record<string, unknown>;
      const role = typeof m.role === "string" ? m.role : "unknown";
      out.push({ role: effectiveRole(role, m.content), content: stringifyContent(m.content) });
      continue;
    }
    if (typeof obj.text === "string") {
      out.push({ role: "unknown", content: obj.text });
    }
  }
  return out;
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const c of content) {
      if (typeof c === "string") parts.push(c);
      else if (c && typeof c === "object") {
        const obj = c as Record<string, unknown>;
        if (typeof obj.text === "string") parts.push(obj.text);
        else if (typeof obj.content === "string") parts.push(obj.content);
      }
    }
    return parts.join("\n");
  }
  if (content && typeof content === "object") {
    try {
      return JSON.stringify(content);
    } catch {
      return "";
    }
  }
  return "";
}

interface HeuristicDeps {
  cwd?: string;
  fileExists?: (absPath: string) => boolean;
}

function evaluateHeuristics(turns: TranscriptTurn[], deps: HeuristicDeps = {}): SaveSuggestion[] {
  const suggestions: SaveSuggestion[] = [];
  const fr = detectFrustration(turns);
  if (fr) suggestions.push(fr);
  const fc = detectFeatureCompletion(turns, deps);
  if (fc) suggestions.push(fc);
  const ad = detectArchitectureDecision(turns);
  if (ad) suggestions.push(ad);
  return suggestions;
}

// Explicit frustration words. "schon wieder" is matched before plain "wieder"
// so the same span is not double-counted; the global flag counts occurrences.
const FRUST_WORD_RE = /\b(?:schon\s+wieder|wieder|wie\s+oft|verdammt|fuck|schei(?:ss|ß)e)\b/gi;
// Letter runs incl. German Umlauts/ß. We intentionally do NOT use `\b` here:
// JS word boundaries treat Ä/Ö/Ü as non-word chars, so `\b[A-ZÄÖÜ]+\b` would
// mangle CAPS words that start with an Umlaut (ÄRGER → "RGER", ÜBER → no match).
const WORD_TOKEN_RE = /[A-Za-zÄÖÜäöüß]+/g;
const ALL_CAPS_RE = /^[A-ZÄÖÜ]{4,}$/;

// Technical all-caps acronyms that routinely appear in tool output, file paths
// and doc discussions — never a frustration signal on their own.
const CAPS_STOPLIST = new Set([
  "SKILL", "JSON", "CLAUDE", "BASTRA", "NEXUS", "API", "REST", "URL", "HTML",
  "CSS", "HTTP", "HTTPS", "YAML", "XML", "SQL", "PRS", "TUI", "TSX", "JSX",
  "SVG", "PNG", "PDF", "JPG", "TODO", "FIXME",
]);

function countFrustWords(content: string): number {
  const m = content.match(FRUST_WORD_RE);
  return m ? m.length : 0;
}

/**
 * Count qualifying CAPS cues in one turn. A CAPS token only counts when it is
 * not a technical acronym AND it is either >=5 chars or repeated within the
 * turn. A single short token like "SKILL" or "JSON" never qualifies.
 */
function countQualifyingCaps(content: string): number {
  const words = content.match(WORD_TOKEN_RE);
  if (!words) return 0;
  const counts = new Map<string, number>();
  for (const w of words) {
    if (!ALL_CAPS_RE.test(w)) continue;
    if (CAPS_STOPLIST.has(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  let qualifying = 0;
  for (const [w, n] of counts) {
    if (w.length >= 5 || n >= 2) qualifying += 1;
  }
  return qualifying;
}

function detectFrustration(turns: TranscriptTurn[]): SaveSuggestion | null {
  const userTurns = turns.filter((t) => t.role === "user").slice(-FRUSTRATION_WINDOW_TURNS);
  let frustWordCount = 0;
  let capsCueCount = 0;
  const exemplars: string[] = [];
  for (const t of userTurns) {
    const fw = countFrustWords(t.content);
    if (fw > 0) {
      frustWordCount += fw;
      if (exemplars.length < 3) exemplars.push(t.content.slice(0, 120));
    }
    capsCueCount += countQualifyingCaps(t.content);
  }
  const totalCues = frustWordCount + capsCueCount;
  // CAPS alone must never trigger: require both enough total cues AND a
  // minimum of genuine frustration words.
  if (totalCues < FRUSTRATION_CUE_THRESHOLD) return null;
  if (frustWordCount < FRUSTRATION_FRUSTWORD_MIN) return null;
  return {
    heuristic: "frustration-density",
    title: "recurring frustration — capture the underlying lesson",
    type: "lesson",
    body: `Detected ${totalCues} frustration cues (${frustWordCount} explicit frustration words) ` +
      `in the last ${userTurns.length} user turns. ` +
      `Exemplars: ${exemplars.join(" | ")}. ` +
      `If a concrete recurring pattern surfaced, save a 'lesson' memory that captures the failure path and the fix.`,
  };
}

// Source extensions that signal a real edit. `.md` only counts under docs/.
// json/yaml/css/html are deliberately excluded — they produced the bulk of the
// false-positive noise (settings.json, .claude.json, …).
const SOURCE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "swift", "rs", "py", "go",
]);

const FILE_TOKEN_RE = /[\w./-]+\.[A-Za-z][A-Za-z0-9]*/g;

/**
 * A file token only counts when it looks like a repo-relative source path:
 * has a directory component, a source extension, and is neither absolute nor a
 * user-home / dotfile path (which is where URL-citation noise lives).
 */
function isRepoRelativeSourceToken(token: string): boolean {
  if (!token.includes("/")) return false;            // bare filename → reject
  if (token.startsWith("/") || token.startsWith("~")) return false; // absolute / home
  if (token.startsWith(".")) return false;           // ./x or .hidden
  if (/^Users\//.test(token)) return false;          // home path with stripped leading slash
  if (token.includes("/.")) return false;            // any dotfile/dotdir segment (e.g. /.claude/)
  const ext = token.slice(token.lastIndexOf(".") + 1).toLowerCase();
  if (SOURCE_EXTENSIONS.has(ext)) return true;
  if (ext === "md" && /(^|\/)docs\//.test(token)) return true;
  return false;
}

function detectFeatureCompletion(turns: TranscriptTurn[], deps: HeuristicDeps = {}): SaveSuggestion | null {
  // "git commit" must come from a USER turn — not assistant text, tool output,
  // shell output or quoted code. A user confirming the commit is the signal.
  const userText = turns.filter((t) => t.role === "user").map((t) => t.content).join("\n");
  if (!/\bgit\s+commit\b/i.test(userText)) return null;

  // File tokens may appear anywhere (the assistant's edits carry the real
  // paths) but are filtered down to repo-relative source files.
  const text = turns.map((t) => t.content).join("\n");
  const fileTokens = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = FILE_TOKEN_RE.exec(text)) !== null) {
    if (isRepoRelativeSourceToken(m[0])) fileTokens.add(m[0]);
    if (fileTokens.size > 200) break;
  }
  if (fileTokens.size < FEATURE_FILE_TOKEN_MIN) return null;

  // cwd-check: at least one token must resolve to a file that exists in the
  // active repo — rules out tokens scraped from docs/URLs of other projects.
  const cwd = deps.cwd ?? process.cwd();
  const exists = deps.fileExists ?? existsSync;
  const inRepo = [...fileTokens].some((tok) => {
    try {
      return exists(resolve(cwd, tok));
    } catch {
      return false;
    }
  });
  if (!inRepo) return null;

  const sample = [...fileTokens].slice(0, 6).join(", ");
  return {
    heuristic: "feature-completion",
    title: "feature-completion — save a topology / project-fact entry",
    type: "project-fact",
    body: `A git commit was mentioned alongside ${fileTokens.size} distinct repo-relative source files (e.g. ${sample}). ` +
      `If this lands a coherent feature/refactor, save a 'project-fact' that maps what was built where ` +
      `(file paths in path/to/file.ts:42 format, status, links to related decisions).`,
  };
}

const DECISION_PATTERNS: RegExp[] = [
  /\bok dann\b/i,
  /\blass uns\b/i,
  /\bentschieden\b/i,
  /\bfinal\b/i,
  /\bgehen wir mit\b/i,
];

function detectArchitectureDecision(turns: TranscriptTurn[]): SaveSuggestion | null {
  const userTurns = turns.filter((t) => t.role === "user").slice(-DECISION_WINDOW_TURNS);
  const exemplars: string[] = [];
  for (const t of userTurns) {
    for (const p of DECISION_PATTERNS) {
      if (p.test(t.content)) {
        if (exemplars.length < 2) exemplars.push(t.content.slice(0, 160));
        break;
      }
    }
  }
  if (exemplars.length === 0) return null;
  return {
    heuristic: "architecture-decision",
    title: "decision finalized — save the chosen path and the why",
    type: "decision",
    body: `Decision-language in the last ${userTurns.length} user turns: ${exemplars.join(" | ")}. ` +
      `If an architectural choice was committed (X over Y, the trade-off), save a 'decision' memory ` +
      `with the why + how-to-apply.`,
  };
}

function formatSuggestion(s: SaveSuggestion): string {
  return [
    `<save-eval>`,
    `Suggested save (heuristic: ${s.heuristic}):`,
    `  title: "${s.title}"`,
    `  type: ${s.type}`,
    `  body: "${escapeBody(s.body)}"`,
    `To save: call save_memory with the values above (or refine first).`,
    `</save-eval>`,
  ].join("\n");
}

function escapeBody(body: string): string {
  return body.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

interface StopHookTelemetry {
  heuristic: string | null;
  suggested_count: number;
  turn_count: number;
  latency_ms_total: number;
}

async function writeTelemetry(payload: StopHookTelemetry): Promise<void> {
  if ((envFirst("BASTRA_TELEMETRY", "NEXUS_TELEMETRY") ?? "on").toLowerCase() === "off") return;
  try {
    const logDir = envFirst("BASTRA_LOG_PATH", "NEXUS_LOG_PATH") ?? defaultLogDir();
    await mkdir(logDir, { recursive: true });
    const ts = new Date().toISOString();
    const event = {
      kind: "save_eval_call",
      ts,
      session_id: randomUUID(),
      hook_version: HOOK_VERSION,
      ...payload,
    };
    const file = join(logDir, `events-${ts.slice(0, 10)}.jsonl`);
    await appendFile(file, JSON.stringify(event) + "\n", "utf8");
  } catch {
    // Telemetry must never break the hook.
  }
}

export {
  evaluateHeuristics,
  detectFrustration,
  detectFeatureCompletion,
  detectArchitectureDecision,
  formatSuggestion,
  parseTranscriptFile,
  normalizeTurns,
};
export type { TranscriptTurn, SaveSuggestion };

const killSwitch = setTimeout(() => {
  emitEmpty();
  process.exit(0);
}, HOOK_TIMEOUT_MS + 50);
killSwitch.unref();

const isMain = (() => {
  if (typeof process.argv[1] !== "string") return false;
  const argv1 = process.argv[1];
  return (
    argv1.endsWith("stop-hook.js") ||
    argv1.endsWith("stop-hook.ts") ||
    argv1.endsWith("bastra-recall-stop-hook")
  );
})();

if (isMain) {
  main()
    .then(() => process.exit(0))
    .catch(() => {
      emitEmpty();
      process.exit(0);
    });
}
