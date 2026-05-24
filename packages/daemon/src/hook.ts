#!/usr/bin/env node
/**
 * bastra-recall hook CLI — bridges Claude Code's PreToolUse event into the
 * daemon's /hook/recall HTTP endpoint and emits a `<recall-hints>` block as
 * `additionalContext` so Claude reads it before the actual Write/Edit fires.
 *
 * Pipeline:
 *   stdin (JSON Claude-Code hook payload)
 *     → filter to PreToolUse on Write/Edit/MultiEdit/NotebookEdit
 *     → detectTopics(file_path, content excerpt) → query
 *     → POST 127.0.0.1:BASTRA_HTTP_PORT/hook/recall
 *     → format hits as <recall-hints>…</recall-hints>
 *     → stdout: {"hookSpecificOutput": { hookEventName, additionalContext }}
 *
 * Discipline:
 *   - Hard wall-clock budget: HOOK_TIMEOUT_MS. We MUST exit fast and
 *     never block Claude — any failure path emits `{}` and exits 0.
 *   - No persistent state. No vault read. We only know the daemon URL.
 *   - Telemetry is best-effort and never blocks the response.
 */
import { detectTopics, detectProject, extractContentExcerpt, type ToolIntent } from "@bastra-recall/core";
import { request } from "node:http";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { envFirst, envInt } from "./env.js";
import { defaultLogDir } from "./telemetry.js";

const HOOK_TIMEOUT_MS = envInt("BASTRA_HOOK_TIMEOUT_MS", 250, "NEXUS_HOOK_TIMEOUT_MS");
const DEFAULT_PORT = 6723;
const HOOK_VERSION = "0.2.0";
const SCORE_FLOOR = 30; // mirror SKILL.md: <30 is noise
const MUST_LOAD_SCORE = 100; // hits at/above this are non-negotiable loads

interface ClaudeHookPayload {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

interface RecallHit {
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

const SUPPORTED_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

async function main(): Promise<void> {
  const startedAt = Date.now();

  // 1) Read stdin as JSON. If anything goes wrong: exit 0 with {}.
  const raw = await readStdin();
  let payload: ClaudeHookPayload;
  try {
    payload = JSON.parse(raw) as ClaudeHookPayload;
  } catch {
    return emitEmpty();
  }

  // 2) Only act on PreToolUse for file-mutating tools.
  if (payload.hook_event_name !== "PreToolUse") return emitEmpty();
  const toolName = payload.tool_name ?? "";
  if (!SUPPORTED_TOOLS.has(toolName)) return emitEmpty();

  const toolInput = (payload.tool_input ?? {}) as Record<string, unknown>;
  const filePath = typeof toolInput.file_path === "string" ? toolInput.file_path : null;
  if (!filePath) return emitEmpty();

  const intent: ToolIntent = {
    tool_name: toolName,
    file_path: filePath,
    content_excerpt: extractContentExcerpt(toolName, toolInput),
  };
  const topics = detectTopics(intent);
  const project = detectProject(payload.cwd ?? process.cwd());

  const httpURL = envFirst("BASTRA_HTTP_URL", "NEXUS_HTTP_URL");
  const httpPort = envFirst("BASTRA_HTTP_PORT", "NEXUS_HTTP_PORT") ?? String(DEFAULT_PORT);
  const url = httpURL ?? `http://127.0.0.1:${httpPort}`;
  const remainingMs = Math.max(50, HOOK_TIMEOUT_MS - (Date.now() - startedAt));

  // 3) Call daemon. Any failure → silent skip.
  let resp: RecallResponse | null = null;
  let status: "ok" | "no-hits" | "daemon-unreachable" | "timeout" | "error" = "ok";
  let errMsg: string | null = null;
  try {
    resp = await postRecall(url, {
      query: topics.query,
      topics: topics.topics,
      project,
      tool_name: toolName,
      k: 3,
    }, remainingMs);
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

  const requiredHits: RecallHit[] = [];
  const optionalHits: RecallHit[] = [];
  if (resp && Array.isArray(resp.hits)) {
    for (const h of resp.hits) {
      if (h.score < SCORE_FLOOR) continue;
      if (h.score >= MUST_LOAD_SCORE) requiredHits.push(h);
      else optionalHits.push(h);
    }
  }

  const totalHints = requiredHits.length + optionalHits.length;
  if (resp && totalHints === 0) status = "no-hits";

  const totalMs = Date.now() - startedAt;
  const topScore = resp?.hits?.[0]?.score ?? null;

  // 4) Emit Claude-Code hookSpecificOutput first — that's the hot path.
  if (totalHints === 0) {
    emitEmpty();
  } else {
    const block = formatHintBlock(requiredHits, optionalHits, project);
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: block,
        },
      }),
    );
  }

  // 5) Telemetry — awaited so process.exit doesn't kill the appendFile.
  await writeTelemetry({
    tool_name: toolName,
    file_path: filePath,
    topics: topics.topics,
    query_chars: topics.query.length,
    daemon_url: url,
    daemon_reachable: resp !== null,
    hint_count: totalHints,
    required_count: requiredHits.length,
    top_score: topScore,
    latency_ms_total: totalMs,
    status,
    error: errMsg,
  });
}

function emitEmpty(): void {
  process.stdout.write("{}");
}

function formatHintLine(h: RecallHit): string {
  // Truncate summary to keep total payload small.
  const summary = h.summary.length > 220 ? h.summary.slice(0, 217) + "…" : h.summary;
  return `- ${h.id} (${h.type}, score ${Math.round(h.score)}): ${summary}`;
}

function formatHintBlock(required: RecallHit[], optional: RecallHit[], project: string | null): string {
  const projAttr = project ? ` project="${escapeAttr(project)}"` : "";
  const head = `<recall-hints surface="claude-code"${projAttr}>`;
  const tail = `</recall-hints>`;
  const sections: string[] = [];

  if (required.length > 0) {
    sections.push(
      `REQUIRED — call load_memory(id) for EACH of these BEFORE the pending tool call. ` +
        `Score ≥${MUST_LOAD_SCORE} means the memory is a strong topic match for what you're about to do. ` +
        `Skipping these is not allowed (per user-preference: agent must not ignore hook hints).`,
    );
    for (const h of required) sections.push(formatHintLine(h));
  }

  if (optional.length > 0) {
    if (required.length > 0) sections.push("");
    sections.push(
      `OPTIONAL (score ${SCORE_FLOOR}–${MUST_LOAD_SCORE - 1}) — load only if the title/summary directly relates to the pending change:`,
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
  topics: string[];
  project: string | null;
  tool_name: string;
  k: number;
  scope?: string;
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
          const raw = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(raw) as RecallResponse);
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

interface HookCallTelemetry {
  tool_name: string;
  file_path: string | null;
  topics: string[];
  query_chars: number;
  daemon_url: string;
  daemon_reachable: boolean;
  hint_count: number;
  required_count: number;
  top_score: number | null;
  latency_ms_total: number;
  status: "ok" | "no-hits" | "daemon-unreachable" | "timeout" | "error";
  error: string | null;
}

async function writeTelemetry(payload: HookCallTelemetry): Promise<void> {
  if ((envFirst("BASTRA_TELEMETRY", "NEXUS_TELEMETRY") ?? "on").toLowerCase() === "off") return;
  try {
    const logDir = envFirst("BASTRA_LOG_PATH", "NEXUS_LOG_PATH") ?? defaultLogDir();
    await mkdir(logDir, { recursive: true });
    const ts = new Date().toISOString();
    const event = {
      kind: "hook_call",
      ts,
      session_id: randomUUID(), // hook CLI is stateless; one event = one synthetic "session"
      hook_version: HOOK_VERSION,
      ...payload,
    };
    const file = join(logDir, `events-${ts.slice(0, 10)}.jsonl`);
    await appendFile(file, JSON.stringify(event) + "\n", "utf8");
  } catch {
    // Telemetry must never break the hook.
  }
}

// Global hard cap: even if main() somehow stalls, we exit fast.
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

// Suppress dirname warning (not used here; kept for parity with telemetry.ts re-export style).
void dirname;
