#!/usr/bin/env node
/**
 * bastra-recall todo hook — TodoWrite reflex layer (Issue #36).
 *
 * Pipeline:
 *   stdin (JSON Claude-Code hook payload)
 *     -> filter to hook_event_name === "PreToolUse" AND tool_name === "TodoWrite"
 *     -> from tool_input.todos (Array<{ content, status, ... }>):
 *          · first 1–2 contents as full-text query
 *          · top-3 topic words (lowercased tokens that appear in >= 2 todos)
 *     -> if confidence too low (very short query + < 2 topic words): emit `{}`
 *     -> otherwise POST 127.0.0.1:BASTRA_HTTP_PORT/hook/recall
 *          { query, project, k=5, type: "project-fact" }
 *     -> emit <recall-hints surface="claude-code" trigger="todo-plan"> with
 *        explicit "load project-facts above before starting these todos" instruction.
 *
 * Why a separate file (not added to hook.ts):
 *   - hook.ts is under heavy refactor in a parallel PR; this hook ships as
 *     its own CLI entry (`bastra-recall-todo-hook`) to avoid merge friction.
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
const SCORE_FLOOR = 50;
const MUST_LOAD_SCORE = 100;
const TOPIC_WORD_CAP = 3;
const MIN_QUERY_LEN_WITHOUT_TOPICS = 10;

export interface TodoItem {
  content?: unknown;
  status?: unknown;
  activeForm?: unknown;
}

export interface ClaudeHookPayload {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { todos?: unknown } & Record<string, unknown>;
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

// Tiny stopword list — covers the most-common DE/EN noise tokens that would
// otherwise dominate the topic-frequency map ("add", "fix", "the", "und"…).
const STOPWORDS = new Set([
  // EN
  "the", "a", "an", "and", "or", "but", "if", "then", "for", "to", "of", "in",
  "on", "at", "by", "with", "from", "as", "is", "are", "was", "were", "be",
  "this", "that", "these", "those", "it", "its", "we", "i", "you", "they",
  "add", "fix", "update", "make", "do", "use", "run", "set", "get", "new",
  "all", "any", "into", "via", "out", "up", "down", "also",
  // DE
  "der", "die", "das", "den", "dem", "des", "ein", "eine", "einen", "einem",
  "und", "oder", "aber", "wenn", "dann", "für", "fur", "zu", "von", "in",
  "an", "auf", "mit", "bei", "aus", "als", "ist", "sind", "war", "waren",
  "im", "am", "zur", "zum", "auch", "noch", "nicht", "kein", "keine",
  "neu", "neue", "alle", "alles",
]);

export interface TopicExtraction {
  query: string;
  topics: string[];
  todoCount: number;
}

/**
 * Pull a topic-rich query out of a TodoWrite payload. Strategy:
 * 1. Use the first 1–2 `content` strings verbatim as the spine of the query.
 * 2. Tokenize ALL todo contents to a-z/0-9 words (length >= 3, no stopwords).
 * 3. Pick the top words that appear in >= 2 todos as `topics`.
 * 4. Final query = "<topics joined>  <first 2 todos joined>".
 */
export function extractTopicsFromTodos(todosRaw: unknown): TopicExtraction {
  if (!Array.isArray(todosRaw)) {
    return { query: "", topics: [], todoCount: 0 };
  }
  const todos: TodoItem[] = todosRaw.filter(
    (t): t is TodoItem => typeof t === "object" && t !== null,
  );
  const contents: string[] = todos
    .map((t) => (typeof t.content === "string" ? t.content : ""))
    .filter((c) => c.length > 0);

  if (contents.length === 0) {
    return { query: "", topics: [], todoCount: todos.length };
  }

  // Per-todo unique word sets — count "appears in >= N todos", not raw freq,
  // so a single chatty todo can't dominate the topic list.
  const perTodoWords: Set<string>[] = contents.map((c) => {
    const words = c
      .toLowerCase()
      .replace(/[^a-z0-9äöüß\s-]/gi, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
    return new Set(words);
  });

  const docFreq = new Map<string, number>();
  for (const set of perTodoWords) {
    for (const w of set) {
      docFreq.set(w, (docFreq.get(w) ?? 0) + 1);
    }
  }

  const topics = [...docFreq.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOPIC_WORD_CAP)
    .map(([w]) => w);

  const firstTwo = contents.slice(0, 2).join("  ");
  const queryParts: string[] = [];
  if (topics.length > 0) queryParts.push(topics.join(" "));
  queryParts.push(firstTwo);
  const query = queryParts.join("  ").trim();

  return { query, topics, todoCount: todos.length };
}

/** Min-confidence gate — reject extractions that are too thin to be useful. */
export function isLowConfidence(extraction: TopicExtraction): boolean {
  if (extraction.todoCount === 0) return true;
  if (extraction.query.length === 0) return true;
  if (extraction.topics.length < 2 && extraction.query.length < MIN_QUERY_LEN_WITHOUT_TOPICS) {
    return true;
  }
  return false;
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

  if (payload.hook_event_name !== "PreToolUse") return emitEmpty();
  if (payload.tool_name !== "TodoWrite") return emitEmpty();

  const extraction = extractTopicsFromTodos(payload.tool_input?.todos);
  if (isLowConfidence(extraction)) {
    emitEmpty();
    await writeTelemetry({
      topic: extraction.topics.join(",") || null,
      todo_count: extraction.todoCount,
      query_chars: extraction.query.length,
      daemon_url: null,
      daemon_reachable: false,
      hit_count: 0,
      top_score: null,
      latency_ms_total: Date.now() - startedAt,
      status: "low-confidence",
      error: null,
    });
    return;
  }

  const project = detectProject(payload.cwd ?? process.cwd());
  const httpURL = envFirst("BASTRA_HTTP_URL", "NEXUS_HTTP_URL");
  const httpPort = envFirst("BASTRA_HTTP_PORT", "NEXUS_HTTP_PORT") ?? String(DEFAULT_PORT);
  const url = httpURL ?? `http://127.0.0.1:${httpPort}`;
  const remainingMs = Math.max(50, HOOK_TIMEOUT_MS - (Date.now() - startedAt));

  let resp: RecallResponse | null = null;
  let status: "ok" | "no-hits" | "daemon-unreachable" | "timeout" | "error" | "low-confidence" =
    "ok";
  let errMsg: string | null = null;
  try {
    resp = await postRecall(
      url,
      {
        query: extraction.query,
        topics: extraction.topics,
        project,
        tool_name: "TodoWrite",
        k: 5,
        type: "project-fact",
      },
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
      if (h.score < SCORE_FLOOR) continue;
      filtered.push(h);
    }
  }
  if (resp && filtered.length === 0) status = "no-hits";

  if (filtered.length === 0) {
    emitEmpty();
  } else {
    const block = formatHintBlock(filtered, project, extraction.topics);
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: block,
        },
      }),
    );
  }

  await writeTelemetry({
    topic: extraction.topics.join(",") || null,
    todo_count: extraction.todoCount,
    query_chars: extraction.query.length,
    daemon_url: url,
    daemon_reachable: resp !== null,
    hit_count: filtered.length,
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

export function formatHintBlock(
  hits: RecallHit[],
  project: string | null,
  topics: string[],
): string {
  const projAttr = project ? ` project="${escapeAttr(project)}"` : "";
  const topicsAttr = topics.length > 0 ? ` topics="${escapeAttr(topics.join(","))}"` : "";
  const head = `<recall-hints surface="claude-code" trigger="todo-plan"${projAttr}${topicsAttr}>`;
  const tail = `</recall-hints>`;

  const required = hits.filter((h) => h.score >= MUST_LOAD_SCORE);
  const optional = hits.filter((h) => h.score < MUST_LOAD_SCORE);
  const sections: string[] = [];

  sections.push(
    `You just produced a multi-step plan via TodoWrite. ` +
      `Before starting these todos, load the project-facts above to understand ` +
      `the current file layout / past decisions in this area. ` +
      `Call bastra-recall:load_memory(id) for each REQUIRED hit; treat OPTIONAL hits as candidates.`,
  );

  if (required.length > 0) {
    sections.push("");
    sections.push(
      `REQUIRED — load_memory(id) for EACH of these BEFORE the first todo. ` +
        `Score >=${MUST_LOAD_SCORE} = strong topology / decision match:`,
    );
    for (const h of required) sections.push(formatHintLine(h));
  }

  if (optional.length > 0) {
    if (required.length > 0) sections.push("");
    sections.push(
      `OPTIONAL (score ${SCORE_FLOOR}–${MUST_LOAD_SCORE - 1}) — load only if title/summary maps to a concrete todo:`,
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

interface TodoHookTelemetry {
  topic: string | null;
  todo_count: number;
  query_chars: number;
  daemon_url: string | null;
  daemon_reachable: boolean;
  hit_count: number;
  top_score: number | null;
  latency_ms_total: number;
  status: "ok" | "no-hits" | "daemon-unreachable" | "timeout" | "error" | "low-confidence";
  error: string | null;
}

async function writeTelemetry(payload: TodoHookTelemetry): Promise<void> {
  if ((envFirst("BASTRA_TELEMETRY", "NEXUS_TELEMETRY") ?? "on").toLowerCase() === "off") return;
  try {
    const logDir = envFirst("BASTRA_LOG_PATH", "NEXUS_LOG_PATH") ?? defaultLogDir();
    await mkdir(logDir, { recursive: true });
    const ts = new Date().toISOString();
    const event = {
      kind: "todo_hook_call",
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

// Only run the CLI when invoked directly, not when imported by tests.
const argv1 = process.argv[1] ?? "";
const isCliEntry = argv1.endsWith("todo-hook.js") || argv1.endsWith("todo-hook.ts");

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
