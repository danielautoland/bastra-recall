#!/usr/bin/env node
/**
 * bastra-recall stop-hook — autonomous save-evaluation at Stop event.
 *
 * Looks at the recent transcript and surfaces save-suggestions when one of
 * three heuristics fires. Never calls save_memory itself — only suggests
 * (the agent decides in the next turn whether to act).
 *
 * Heuristics:
 *   1. Frustration-Density   — >=3 "wieder/schon wieder/CAPS/fuck/verdammt"
 *      tokens in the last 10 user turns.
 *   2. Feature-Completion    — `git commit` mentioned + multiple modified
 *      files in the same area.
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
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { envFirst, envInt } from "./env.js";
import { defaultLogDir } from "./telemetry.js";

const HOOK_TIMEOUT_MS = envInt("BASTRA_STOP_HOOK_TIMEOUT_MS", 1000);
const HOOK_VERSION = "0.1.0";
const FRUSTRATION_WINDOW_TURNS = 10;
const FRUSTRATION_THRESHOLD = 3;
const DECISION_WINDOW_TURNS = 5;

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
  const suggestions = evaluateHeuristics(last30);

  if (suggestions.length === 0) {
    emitEmpty();
  } else {
    const blocks = suggestions.map(formatSuggestion).join("\n");
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "Stop",
          additionalContext: blocks,
        },
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

function normalizeTurns(items: unknown[]): TranscriptTurn[] {
  const out: TranscriptTurn[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const directRole = obj.role;
    const directContent = obj.content;
    if (typeof directRole === "string") {
      out.push({ role: directRole, content: stringifyContent(directContent) });
      continue;
    }
    const msg = obj.message;
    if (msg && typeof msg === "object") {
      const m = msg as Record<string, unknown>;
      const role = typeof m.role === "string" ? m.role : "unknown";
      out.push({ role, content: stringifyContent(m.content) });
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

function evaluateHeuristics(turns: TranscriptTurn[]): SaveSuggestion[] {
  const suggestions: SaveSuggestion[] = [];
  const fr = detectFrustration(turns);
  if (fr) suggestions.push(fr);
  const fc = detectFeatureCompletion(turns);
  if (fc) suggestions.push(fc);
  const ad = detectArchitectureDecision(turns);
  if (ad) suggestions.push(ad);
  return suggestions;
}

const FRUSTRATION_PATTERNS: RegExp[] = [
  /\bwieder\b/i,
  /\bschon wieder\b/i,
  /\bwie oft\b/i,
  /\bverdammt\b/i,
  /\bfuck\b/i,
  /\bscheisse\b/i,
  /\bscheiße\b/i,
];

const CAPS_WORD_RE = /\b[A-ZÄÖÜ]{4,}\b/g;

function detectFrustration(turns: TranscriptTurn[]): SaveSuggestion | null {
  const userTurns = turns.filter((t) => t.role === "user").slice(-FRUSTRATION_WINDOW_TURNS);
  let count = 0;
  const exemplars: string[] = [];
  for (const t of userTurns) {
    for (const p of FRUSTRATION_PATTERNS) {
      if (p.test(t.content)) {
        count++;
        if (exemplars.length < 3) exemplars.push(t.content.slice(0, 120));
        break;
      }
    }
    const caps = t.content.match(CAPS_WORD_RE);
    if (caps && caps.length > 0) {
      count++;
      if (exemplars.length < 3) exemplars.push(caps.slice(0, 3).join(" "));
    }
  }
  if (count < FRUSTRATION_THRESHOLD) return null;
  return {
    heuristic: "frustration-density",
    title: "recurring frustration — capture the underlying lesson",
    type: "lesson",
    body: `Detected ${count} frustration cues in the last ${userTurns.length} user turns. ` +
      `Exemplars: ${exemplars.join(" | ")}. ` +
      `If a concrete recurring pattern surfaced, save a 'lesson' memory that captures the failure path and the fix.`,
  };
}

function detectFeatureCompletion(turns: TranscriptTurn[]): SaveSuggestion | null {
  const text = turns.map((t) => t.content).join("\n");
  const commitMatch = /\bgit\s+commit\b/.test(text) || /\[(?:main|master|feat\/[\w./-]+)\s+[0-9a-f]{6,12}\]/.test(text);
  if (!commitMatch) return null;

  const fileTokens = new Set<string>();
  const fileRe = /\b[\w./-]+\.(?:ts|tsx|js|jsx|swift|rs|py|go|md|json|yml|yaml|css|html)\b/g;
  let m: RegExpExecArray | null;
  while ((m = fileRe.exec(text)) !== null) {
    fileTokens.add(m[0]);
    if (fileTokens.size > 200) break;
  }
  if (fileTokens.size < 3) return null;

  const sample = [...fileTokens].slice(0, 6).join(", ");
  return {
    heuristic: "feature-completion",
    title: "feature-completion — save a topology / project-fact entry",
    type: "project-fact",
    body: `A git commit was mentioned alongside ${fileTokens.size} distinct file tokens (e.g. ${sample}). ` +
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
