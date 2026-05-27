#!/usr/bin/env node
/**
 * bastra-recall prompt hook — UserPromptSubmit reflex layer (Issue #33).
 *
 * Pipeline:
 *   stdin (JSON Claude-Code hook payload)
 *     -> filter to hook_event_name === "UserPromptSubmit"
 *     -> extract user prompt from payload.prompt / payload.user_message
 *     -> detect retrieval mode -> "retrieval" | "none" (default) | "generic" (env-opt-in)
 *     -> if retrieval/generic: POST 127.0.0.1:BASTRA_HTTP_PORT/hook/recall  (k=5, score-floor 50)
 *     -> emit <recall-hints surface="claude-code" trigger="prompt-lookup"> with
 *        explicit "use bastra-recall:recall BEFORE conversation_search" instruction
 *     -> otherwise: emit `{}`
 *
 * Why a separate file (not added to hook.ts):
 *   - hook.ts is under heavy refactor in a parallel PR; this hook ships as
 *     its own CLI entry (`bastra-recall-prompt-hook`) to avoid merge friction.
 *   - Helpers (postRecall/emitEmpty/telemetry/readStdin) are intentionally
 *     copied — not imported — for the same reason.
 */
import { detectProject } from "@bastra-recall/core";
import { request } from "node:http";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { envFirst, envInt } from "./env.js";
import { defaultLogDir } from "./telemetry.js";

const HOOK_TIMEOUT_MS = envInt("BASTRA_HOOK_TIMEOUT_MS", 250, "NEXUS_HOOK_TIMEOUT_MS");
const DEFAULT_PORT = 6723;
const HOOK_VERSION = "0.2.0";
const SCORE_FLOOR = 50; // higher than PreToolUse: prompts rarely match recall_when exactly
const MUST_LOAD_SCORE = 100;

/** "retrieval-only" (default) or "all" (also recall on non-lookup prompts, score-gated to MUST_LOAD_SCORE). */
type PromptHookMode = "retrieval-only" | "all";
const HOOK_MODE: PromptHookMode =
  (envFirst("BASTRA_PROMPT_HOOK_MODE") as PromptHookMode | undefined) ?? "retrieval-only";

export interface ClaudeHookPayload {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  /** primary surface in Claude Code docs */
  prompt?: string;
  /** legacy / alternative key seen in some Claude-Code payload variants */
  user_message?: string;
}

export interface RecallHit {
  id: string;
  title: string;
  type: string;
  scope: string;
  summary: string;
  score: number;
}

interface RecallResponse {
  hits: RecallHit[];
  vault_size: number;
  latency_ms: number;
  recall_id: string;
}

export type DetectedMode = "retrieval" | "none" | "generic";

// DE + EN retrieval triggers — match the spec in Issue #33.
const RETRIEVAL_DE = /^\s*(such|finde|wo (ist|sind)|wann (war|hatte)|wieviel|wie viel|was hab(e ich)?|was war)/i;
const RETRIEVAL_EN = /^\s*(find|search|where (is|are)|when (was|did)|how much|what (did|was))/i;

export function detectRetrieval(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (trimmed.length === 0) return false;
  return RETRIEVAL_DE.test(trimmed) || RETRIEVAL_EN.test(trimmed);
}

export function extractPrompt(payload: ClaudeHookPayload): string | null {
  const raw =
    typeof payload.prompt === "string"
      ? payload.prompt
      : typeof payload.user_message === "string"
        ? payload.user_message
        : null;
  if (raw == null) return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

async function main(): Promise<void> {
  const startedAt = Date.now();

  const raw = await readStdin();
  let payload: ClaudeHookPayload;
  try {
    payload = JSON.parse(raw) as ClaudeHookPayload;
  } catch {
    return emitEmpty();
  }

  if (payload.hook_event_name !== "UserPromptSubmit") return emitEmpty();

  const prompt = extractPrompt(payload);
  if (!prompt) return emitEmpty();

  const isRetrieval = detectRetrieval(prompt);
  let detectedMode: DetectedMode;
  if (isRetrieval) {
    detectedMode = "retrieval";
  } else if (HOOK_MODE === "all") {
    detectedMode = "generic";
  } else {
    detectedMode = "none";
  }

  if (detectedMode === "none") {
    emitEmpty();
    await writeTelemetry({
      detected_mode: "none",
      prompt_chars: prompt.length,
      daemon_url: null,
      daemon_reachable: false,
      hint_count: 0,
      top_score: null,
      latency_ms_total: Date.now() - startedAt,
      status: "ok",
      error: null,
    });
    return;
  }

  const project = detectProject(payload.cwd ?? process.cwd());
  const httpURL = envFirst("BASTRA_HTTP_URL", "NEXUS_HTTP_URL");
  const httpPort = envFirst("BASTRA_HTTP_PORT", "NEXUS_HTTP_PORT") ?? String(DEFAULT_PORT);
  const url = httpURL ?? `http://127.0.0.1:${httpPort}`;
  const remainingMs = Math.max(50, HOOK_TIMEOUT_MS - (Date.now() - startedAt));

  // For "generic" mode we only show top-tier hits, so request fewer (k=3).
  const k = detectedMode === "retrieval" ? 5 : 3;
  // In "generic" mode bump the score floor to MUST_LOAD_SCORE — only show
  // very strong matches to avoid noise on every single prompt.
  const effectiveFloor = detectedMode === "generic" ? MUST_LOAD_SCORE : SCORE_FLOOR;

  let resp: RecallResponse | null = null;
  let status: "ok" | "no-hits" | "daemon-unreachable" | "timeout" | "error" = "ok";
  let errMsg: string | null = null;
  try {
    resp = await postRecall(
      url,
      { query: prompt, project, k, tool_name: "UserPromptSubmit" },
      remainingMs,
    );
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ECONNREFUSED" || e.code === "ENOTFOUND" || e.code === "EHOSTUNREACH") {
      status = "daemon-unreachable";
    } else if (e.message === "timeout") {
      status = "timeout";
    } else {
      status = "error";
      errMsg = e.message ?? String(err);
    }
  }

  const filtered: RecallHit[] = [];
  if (resp && Array.isArray(resp.hits)) {
    for (const h of resp.hits) {
      if (h.score < effectiveFloor) continue;
      filtered.push(h);
    }
  }
  if (resp && filtered.length === 0) status = "no-hits";

  if (filtered.length === 0) {
    emitEmpty();
  } else {
    const block = formatHintBlock(filtered, project, detectedMode);
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: block,
        },
      }),
    );
  }

  await writeTelemetry({
    detected_mode: detectedMode,
    prompt_chars: prompt.length,
    daemon_url: url,
    daemon_reachable: resp !== null,
    hint_count: filtered.length,
    top_score: resp?.hits?.[0]?.score ?? null,
    latency_ms_total: Date.now() - startedAt,
    status,
    error: errMsg,
  });
}

function emitEmpty(): void {
  process.stdout.write("{}");
}

function formatHintLine(h: RecallHit): string {
  const summary = h.summary.length > 220 ? h.summary.slice(0, 217) + "…" : h.summary;
  return `- ${h.id} (${h.type}, score ${Math.round(h.score)}): ${summary}`;
}

export function formatHintBlock(hits: RecallHit[], project: string | null, mode: DetectedMode): string {
  const projAttr = project ? ` project="${escapeAttr(project)}"` : "";
  const head = `<recall-hints surface="claude-code" trigger="prompt-lookup"${projAttr}>`;
  const tail = `</recall-hints>`;

  const required = hits.filter((h) => h.score >= MUST_LOAD_SCORE);
  const optional = hits.filter((h) => h.score < MUST_LOAD_SCORE);
  const sections: string[] = [];

  if (mode === "retrieval") {
    sections.push(
      `The user prompt looks like a LOOKUP / retrieval query. ` +
        `Use bastra-recall:recall (and find_document if pdf-likely) BEFORE conversation_search / web_search. ` +
        `Pre-recalled candidates for this prompt:`,
    );
  } else {
    sections.push(
      `Pre-recall surfaced strong matches (score >=${MUST_LOAD_SCORE}) for this prompt. ` +
        `Load them via bastra-recall:load_memory before answering.`,
    );
  }

  if (required.length > 0) {
    sections.push("");
    sections.push(
      `REQUIRED — load_memory(id) for EACH of these before responding. ` +
        `Score >=${MUST_LOAD_SCORE} = strong match:`,
    );
    for (const h of required) sections.push(formatHintLine(h));
  }

  if (optional.length > 0) {
    if (required.length > 0) sections.push("");
    sections.push(
      `OPTIONAL (score ${SCORE_FLOOR}–${MUST_LOAD_SCORE - 1}) — load only if title/summary directly relates:`,
    );
    for (const h of optional) sections.push(formatHintLine(h));
  }

  return [head, ...sections, tail].join("\n");
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

interface RecallRequestBody {
  query: string;
  project: string | null;
  k: number;
  tool_name: string;
  scope?: string;
  type?: string;
}

function postRecall(
  baseUrl: string,
  body: RecallRequestBody,
  timeoutMs: number,
): Promise<RecallResponse> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL("/hook/recall", baseUrl);
    } catch (err) {
      reject(err);
      return;
    }
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const req = request(
      {
        method: "POST",
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": payload.byteLength.toString(),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const data = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(data) as RecallResponse);
          } catch {
            reject(new Error("invalid JSON response from daemon"));
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

interface PromptHookTelemetry {
  detected_mode: DetectedMode;
  prompt_chars: number;
  daemon_url: string | null;
  daemon_reachable: boolean;
  hint_count: number;
  top_score: number | null;
  latency_ms_total: number;
  status: "ok" | "no-hits" | "daemon-unreachable" | "timeout" | "error";
  error: string | null;
}

async function writeTelemetry(payload: PromptHookTelemetry): Promise<void> {
  if ((envFirst("BASTRA_TELEMETRY", "NEXUS_TELEMETRY") ?? "on").toLowerCase() === "off") return;
  try {
    const logDir = envFirst("BASTRA_LOG_PATH", "NEXUS_LOG_PATH") ?? defaultLogDir();
    await mkdir(logDir, { recursive: true });
    const ts = new Date().toISOString();
    const event = {
      kind: "prompt_hook_call",
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

// Only run the CLI when invoked directly (filename match), not when imported by tests.
const argv1 = process.argv[1] ?? "";
const isCliEntry = argv1.endsWith("prompt-hook.js") || argv1.endsWith("prompt-hook.ts");

if (isCliEntry) {
  const killSwitch = setTimeout(() => {
    emitEmpty();
    process.exit(0);
  }, HOOK_TIMEOUT_MS + 50);
  killSwitch.unref();

  main()
    .then(() => process.exit(0))
    .catch(() => {
      emitEmpty();
      process.exit(0);
    });
}
