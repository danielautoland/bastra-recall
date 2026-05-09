#!/usr/bin/env node
/**
 * nexus-recall session-start hook — preloads the most relevant memorys for
 * a fresh Claude Code session as `additionalContext` so the model knows
 * who the user is, what project they're in, and what cross-project rules
 * apply, before the first user prompt arrives.
 *
 * Pipeline:
 *   stdin (JSON Claude-Code SessionStart payload)
 *     → detectProject(cwd)
 *     → 3 scope-filtered POSTs to 127.0.0.1:NEXUS_HTTP_PORT/hook/recall
 *         · scope=user-preference  k=3   query="session-start preferences"
 *         · scope=<project>        k=3   query="<project> active context"
 *         · scope=all-projects     k=2   query="cross-project working rules"
 *     → merge by score, drop dups, format as <session-context>…</session-context>
 *     → stdout: {"hookSpecificOutput": { hookEventName, additionalContext }}
 *
 * Discipline mirrors hook.ts: hard wall-clock budget, fail-silent on every
 * error path, telemetry best-effort.
 */
import { detectProject } from "@nexus-recall/core";
import { request } from "node:http";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const HOOK_TIMEOUT_MS = parseInt(process.env.NEXUS_HOOK_TIMEOUT_MS ?? "500", 10);
const DEFAULT_PORT = 6723;
const HOOK_VERSION = "0.2.0";
const SCORE_FLOOR = 30;
const MUST_LOAD_SCORE = 100;
const TOTAL_HINTS_CAP = 7;

interface SessionPayload {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  source?: "startup" | "resume" | "clear" | "compact";
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

async function main(): Promise<void> {
  const startedAt = Date.now();

  const raw = await readStdin();
  let payload: SessionPayload;
  try {
    payload = JSON.parse(raw) as SessionPayload;
  } catch {
    return emitEmpty();
  }
  if (payload.hook_event_name !== "SessionStart") return emitEmpty();

  const project = detectProject(payload.cwd ?? process.cwd());
  const url =
    process.env.NEXUS_HTTP_URL ?? `http://127.0.0.1:${process.env.NEXUS_HTTP_PORT ?? DEFAULT_PORT}`;

  const queries: Array<{ scope: string; query: string; k: number }> = [
    { scope: "user-preference", query: "session-start preferences active context", k: 3 },
    { scope: "all-projects", query: "cross-project working rules", k: 2 },
  ];
  if (project) {
    queries.push({ scope: project, query: `${project} active context project-facts decisions`, k: 3 });
  }

  let status: "ok" | "no-hits" | "daemon-unreachable" | "timeout" | "error" = "ok";
  let errMsg: string | null = null;
  const responses: Array<{ scope: string; resp: RecallResponse | null }> = [];

  for (const q of queries) {
    const remainingMs = Math.max(60, HOOK_TIMEOUT_MS - (Date.now() - startedAt));
    try {
      const resp = await postRecall(
        url,
        { query: q.query, scope: q.scope, k: q.k, project, source: payload.source ?? null },
        remainingMs,
      );
      responses.push({ scope: q.scope, resp });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ECONNREFUSED" || e.code === "ENOTFOUND" || e.code === "EHOSTUNREACH") {
        status = "daemon-unreachable";
        responses.push({ scope: q.scope, resp: null });
        break; // no point hammering
      }
      if (e.message === "timeout") {
        status = "timeout";
      } else {
        status = "error";
        errMsg = e.message ?? String(err);
      }
      responses.push({ scope: q.scope, resp: null });
    }
  }

  // Merge: dedup by id, sort by score, cap total.
  const seen = new Set<string>();
  const merged: RecallHit[] = [];
  for (const r of responses) {
    if (!r.resp) continue;
    for (const h of r.resp.hits) {
      if (h.score < SCORE_FLOOR) continue;
      if (seen.has(h.id)) continue;
      seen.add(h.id);
      merged.push(h);
    }
  }
  merged.sort((a, b) => b.score - a.score);
  const top = merged.slice(0, TOTAL_HINTS_CAP);

  if (top.length === 0) {
    if (status === "ok") status = "no-hits";
    emitEmpty();
  } else {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: formatBlock(top, project, payload.source ?? null),
        },
      }),
    );
  }

  await writeTelemetry({
    source: payload.source ?? null,
    project,
    queries: queries.length,
    daemon_url: url,
    daemon_reachable: responses.some((r) => r.resp !== null),
    hint_count: top.length,
    top_score: top[0]?.score ?? null,
    latency_ms_total: Date.now() - startedAt,
    status,
    error: errMsg,
  });
}

function emitEmpty(): void {
  process.stdout.write("{}");
}

function formatBlock(hits: RecallHit[], project: string | null, source: string | null): string {
  const projAttr = project ? ` project="${escapeAttr(project)}"` : "";
  const srcAttr = source ? ` source="${escapeAttr(source)}"` : "";
  const head = `<session-context surface="claude-code"${projAttr}${srcAttr}>`;
  const tail = `</session-context>`;

  const required = hits.filter((h) => h.score >= MUST_LOAD_SCORE);
  const optional = hits.filter((h) => h.score < MUST_LOAD_SCORE);
  const sections: string[] = [];

  if (required.length > 0) {
    sections.push(
      `REQUIRED — load each of these via load_memory(id) before responding to the user. ` +
        `Score ≥${MUST_LOAD_SCORE} means it's a strong match for ${project ?? "this"} session context. ` +
        `Skipping is not allowed (per user-preference: agent must not ignore hook hints).`,
    );
    for (const h of required) sections.push(formatHintLine(h));
  }

  if (optional.length > 0) {
    if (required.length > 0) sections.push("");
    sections.push(
      `OPTIONAL (score ${SCORE_FLOOR}–${MUST_LOAD_SCORE - 1}) — load only when the user prompt directly touches the topic:`,
    );
    for (const h of optional) sections.push(formatHintLine(h));
  }

  return [head, ...sections, tail].join("\n");
}

function formatHintLine(h: RecallHit): string {
  const summary = h.summary.length > 220 ? h.summary.slice(0, 217) + "…" : h.summary;
  return `- ${h.id} (${h.type}/${h.scope}, score ${Math.round(h.score)}): ${summary}`;
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
  scope?: string;
  k: number;
  project: string | null;
  source: string | null;
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

interface SessionHookTelemetry {
  source: string | null;
  project: string | null;
  queries: number;
  daemon_url: string;
  daemon_reachable: boolean;
  hint_count: number;
  top_score: number | null;
  latency_ms_total: number;
  status: "ok" | "no-hits" | "daemon-unreachable" | "timeout" | "error";
  error: string | null;
}

async function writeTelemetry(payload: SessionHookTelemetry): Promise<void> {
  if ((process.env.NEXUS_TELEMETRY ?? "on").toLowerCase() === "off") return;
  try {
    const logDir =
      process.env.NEXUS_LOG_PATH ?? join(homedir(), ".nexus-recall", "logs");
    await mkdir(logDir, { recursive: true });
    const ts = new Date().toISOString();
    const event = {
      kind: "session_hook_call",
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

const killSwitch = setTimeout(() => {
  emitEmpty();
  process.exit(0);
}, HOOK_TIMEOUT_MS + 100);
killSwitch.unref();

main()
  .then(() => process.exit(0))
  .catch(() => {
    emitEmpty();
    process.exit(0);
  });
