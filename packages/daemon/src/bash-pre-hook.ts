#!/usr/bin/env node
/**
 * bastra-recall bash-pre-hook — PreToolUse hook for Bash commands.
 *
 * Pattern-matches destructive / risky shell commands and surfaces relevant
 * safety lessons from the vault as `additionalContext` so Claude reads them
 * BEFORE running e.g. `rm -rf`, `git reset --hard`, `git push --force`, etc.
 *
 * Pipeline:
 *   stdin (Claude-Code hook payload, hook_event_name=PreToolUse, tool_name=Bash)
 *     → match command against DESTRUCTIVE_PATTERNS / RISKY_PATTERNS
 *     → POST 127.0.0.1:BASTRA_HTTP_PORT/hook/recall (scope=all-projects, k=3)
 *     → emit <recall-hints surface="claude-code" trigger="bash-destructive">
 *
 * Discipline (mirrors hook.ts):
 *   - Hard wall-clock budget. Any failure path emits `{}` and exits 0.
 *   - Never blocks the tool — hint only, no `block: true`.
 *   - No loop: bastra-recall-* invocations are NOT matched (and would not
 *     match anyway, but the prefix is checked defensively).
 */
import { request } from "node:http";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { envFirst, envInt } from "./env.js";
import { defaultLogDir } from "./telemetry.js";

const HOOK_TIMEOUT_MS = envInt("BASTRA_HOOK_TIMEOUT_MS", 500, "NEXUS_HOOK_TIMEOUT_MS");
const DEFAULT_PORT = 6723;
const HOOK_VERSION = "0.1.0";
const SCORE_FLOOR = 50;

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

/**
 * Destructive patterns — always need a recall.
 * Order matters: longer / more specific phrases first so the *match string*
 * we surface to the user is the meaningful one.
 */
const DESTRUCTIVE_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "rm -rf", re: /\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b/ },
  { label: "rm -r", re: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*\b/ },
  { label: "rmdir", re: /\brmdir\b/ },
  { label: "git reset --hard", re: /\bgit\s+reset\s+--hard\b/ },
  { label: "git checkout --", re: /\bgit\s+checkout\s+--\s/ },
  { label: "git clean -f", re: /\bgit\s+clean\s+-[a-zA-Z]*f[a-zA-Z]*\b/ },
  { label: "git branch -D", re: /\bgit\s+branch\s+-D\b/ },
  { label: "git push --force-with-lease", re: /\bgit\s+push\b[^\n]*--force-with-lease/ },
  { label: "git push --force", re: /\bgit\s+push\b[^\n]*--force\b/ },
  { label: "git push -f", re: /\bgit\s+push\b[^\n]*\s-f\b/ },
  { label: "git commit --amend", re: /\bgit\s+commit\b[^\n]*--amend\b/ },
  { label: "gh repo delete", re: /\bgh\s+repo\s+delete\b/ },
  { label: "gh release delete", re: /\bgh\s+release\s+delete\b/ },
  { label: "npm uninstall", re: /\bnpm\s+uninstall\b/ },
  { label: "npm rm", re: /\bnpm\s+rm\b/ },
  { label: "yarn remove", re: /\byarn\s+remove\b/ },
  { label: "pnpm rm", re: /\bpnpm\s+(?:rm|remove)\b/ },
  { label: "DROP TABLE", re: /\bDROP\s+TABLE\b/i },
  { label: "DROP DATABASE", re: /\bDROP\s+DATABASE\b/i },
  { label: "TRUNCATE", re: /\bTRUNCATE\b/i },
  { label: "docker rm", re: /\bdocker\s+rm\b/ },
  { label: "docker volume rm", re: /\bdocker\s+volume\s+rm\b/ },
  { label: "kubectl delete", re: /\bkubectl\s+delete\b/ },
];

/**
 * Risky patterns — surface a softer hint. Same code path, only the label
 * differs so the recall query can pick up the right lessons.
 */
const RISKY_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "chmod -R", re: /\bchmod\s+-[a-zA-Z]*R[a-zA-Z]*\b/ },
  { label: "chown -R", re: /\bchown\s+-[a-zA-Z]*R[a-zA-Z]*\b/ },
  { label: "find ... -exec rm", re: /\bfind\b[^\n]*-exec\s+rm\b/ },
  // Overwrite redirect: `> file` (not `>>` append, not `2>` stderr, not `>&`).
  // Require a non-`>` char before `>` and at least one whitespace+filename after.
  { label: "> overwrite redirect", re: /(?:^|[^>&0-9])>\s+[^\s>&]/ },
];

function matchPattern(cmd: string): { label: string; severity: "destructive" | "risky" } | null {
  for (const p of DESTRUCTIVE_PATTERNS) {
    if (p.re.test(cmd)) return { label: p.label, severity: "destructive" };
  }
  for (const p of RISKY_PATTERNS) {
    if (p.re.test(cmd)) return { label: p.label, severity: "risky" };
  }
  return null;
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
  if (payload.tool_name !== "Bash") return emitEmpty();

  const toolInput = (payload.tool_input ?? {}) as Record<string, unknown>;
  const command = typeof toolInput.command === "string" ? toolInput.command : "";
  if (!command.trim()) return emitEmpty();

  // Defensive: never recurse on our own hook binaries.
  if (/\bbastra-recall(?:-[a-z-]+)?\b/.test(command)) return emitEmpty();

  const match = matchPattern(command);
  if (!match) return emitEmpty();

  const httpURL = envFirst("BASTRA_HTTP_URL", "NEXUS_HTTP_URL");
  const httpPort = envFirst("BASTRA_HTTP_PORT", "NEXUS_HTTP_PORT") ?? String(DEFAULT_PORT);
  const url = httpURL ?? `http://127.0.0.1:${httpPort}`;
  const remainingMs = Math.max(50, HOOK_TIMEOUT_MS - (Date.now() - startedAt));

  let resp: RecallResponse | null = null;
  let status: "ok" | "no-hits" | "daemon-unreachable" | "timeout" | "error" = "ok";
  let errMsg: string | null = null;
  try {
    resp = await postRecall(
      url,
      {
        query: `${match.label} safety workflow user-preference`,
        topics: ["bash", match.severity, "safety"],
        project: null,
        tool_name: "Bash",
        scope: "all-projects",
        k: 3,
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

  const hits: RecallHit[] = [];
  if (resp && Array.isArray(resp.hits)) {
    for (const h of resp.hits) {
      if (h.score >= SCORE_FLOOR) hits.push(h);
    }
  }
  if (resp && hits.length === 0) status = "no-hits";

  // Emit hint even if no memories match — the warning itself is the point.
  const block = formatHintBlock(match.label, match.severity, hits);
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: block,
      },
    }),
  );

  const totalMs = Date.now() - startedAt;
  await writeTelemetry({
    matched_pattern: match.label,
    severity: match.severity,
    daemon_url: url,
    daemon_reachable: resp !== null,
    hint_count: hits.length,
    top_score: resp?.hits?.[0]?.score ?? null,
    latency_ms_total: totalMs,
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

function formatHintBlock(
  pattern: string,
  severity: "destructive" | "risky",
  hits: RecallHit[],
): string {
  const head = `<recall-hints surface="claude-code" trigger="bash-${severity}">`;
  const tail = `</recall-hints>`;
  const lines: string[] = [];

  if (severity === "destructive") {
    lines.push(
      `STOP — destructive Bash command detected (pattern: \`${pattern}\`). ` +
        `Per user-preference this needs explicit user confirmation unless authorized in advance. ` +
        `Do not run blindly: confirm the target paths, the scope of effect, and that Daniel has asked for this exact action.`,
    );
  } else {
    lines.push(
      `CAUTION — risky Bash command detected (pattern: \`${pattern}\`). ` +
        `Check the target/scope before running — recursive/destructive side effects are easy to miss.`,
    );
  }

  if (hits.length > 0) {
    lines.push("");
    lines.push(
      `Relevant lessons / preferences from the vault — load_memory(id) before deciding to run:`,
    );
    for (const h of hits) lines.push(formatHintLine(h));
  }

  return [head, ...lines, tail].join("\n");
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
          const body = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(body) as RecallResponse);
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

interface BashHookCallTelemetry {
  matched_pattern: string;
  severity: "destructive" | "risky";
  daemon_url: string;
  daemon_reachable: boolean;
  hint_count: number;
  top_score: number | null;
  latency_ms_total: number;
  status: "ok" | "no-hits" | "daemon-unreachable" | "timeout" | "error";
  error: string | null;
}

async function writeTelemetry(payload: BashHookCallTelemetry): Promise<void> {
  if ((envFirst("BASTRA_TELEMETRY", "NEXUS_TELEMETRY") ?? "on").toLowerCase() === "off") return;
  try {
    const logDir = envFirst("BASTRA_LOG_PATH", "NEXUS_LOG_PATH") ?? defaultLogDir();
    await mkdir(logDir, { recursive: true });
    const ts = new Date().toISOString();
    const event = {
      kind: "bash_hook_call",
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

// Export for testing.
export { matchPattern, formatHintBlock, DESTRUCTIVE_PATTERNS, RISKY_PATTERNS };

// Global hard cap.
const killSwitch = setTimeout(() => {
  emitEmpty();
  process.exit(0);
}, HOOK_TIMEOUT_MS + 50);
killSwitch.unref();

// Only run main() when invoked as a CLI, not when imported by tests.
const isMain = (() => {
  if (typeof process.argv[1] !== "string") return false;
  const argv1 = process.argv[1];
  return (
    argv1.endsWith("bash-pre-hook.js") ||
    argv1.endsWith("bash-pre-hook.ts") ||
    argv1.endsWith("bastra-recall-bash-pre-hook")
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
