#!/usr/bin/env node
/**
 * bastra-recall MCP-stdio forwarder.
 *
 * Spricht das MCP-Protocol über stdio (wie jeder andere MCP-Server), hält
 * aber selbst KEINEN Vault, KEINEN Embedding-Index und KEINEN Watcher. Jeder
 * CallToolRequest wird in einen HTTP-POST an den lokalen bastra-recall-
 * Daemon (`packages/daemon/dist/index.js`, Port 6723) übersetzt.
 *
 * Warum? Jede `claude`-Session, jeder Cursor-Tab, jeder MCP-Client spawnt
 * normalerweise einen eigenen stdio-Daemon. Das bedeutet n In-Memory-Vaults,
 * n Embedding-Indizes, n × Ollama-Backfills, und vor allem n unabhängige
 * State-Maschinen die per File-Watcher synchron gehalten werden müssen — auf
 * Cloud-Storage-Mounts (Google Drive, iCloud) ein bekannter Sync-Bug.
 *
 * Mit dem Forwarder gibt es genau einen Daemon. Alle Clients teilen
 * denselben Vault-State, denselben Embedding-Index, dieselbe Telemetry-
 * Verknüpfung. Hooks (POST /hook/recall), MCP-Clients (Claude Code, Claude
 * Desktop, Cursor, …) und perspektivisch externe Caller (ChatGPT Custom
 * GPT Actions via Tunnel) reden alle gegen dieselbe REST-API.
 *
 * Bootstrap:
 *   1. GET /health probieren. 200 → Daemon läuft, weiter.
 *   2. Sonst: detached `node dist/index.js` spawnen, ~10s auf /health
 *      pollen. Bei EADDRINUSE-Race (zwei Forwarder gleichzeitig) gewinnt
 *      einer, der andere sieht beim re-poll das fertige /health.
 *   3. Falls Daemon binnen Timeout nicht hoch kommt: Stdio-Server startet
 *      trotzdem, jeder CallTool-Request gibt einen Fehler zurück. Damit
 *      blockt der Forwarder den Client nicht.
 *
 * Konfig (env):
 *   BASTRA_DAEMON_URL       — default `http://127.0.0.1:6723`
 *   BASTRA_API_TOKEN        — falls gesetzt: als Bearer durchgereicht
 *   BASTRA_FORWARDER_SPAWN  — `0` deaktiviert den auto-spawn (für Fälle
 *                             wo der Daemon als launchd-Service läuft)
 *   BASTRA_VAULT_PATH       — wird beim Auto-Spawn an den Daemon vererbt
 *                             (alle weiteren BASTRA_*-Vars ebenfalls).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  pickPhrase,
  banterModeFromEnv,
  progressIndexFor,
  RECALL_STAGE_ORDER,
  type RecallStage,
} from "@bastra-recall/core";
import { MEMORY_TOOL_DEFS } from "./tool-handlers.js";
import { documentTools } from "./documents-handler.js";
import { documentWriteTools } from "./documents-write-handler.js";
import { claudeSessionPid, sessionFeedPath, STATUSLINE_DIR } from "./statusline-session.js";

const DAEMON_URL = (process.env.BASTRA_DAEMON_URL ?? "http://127.0.0.1:6723").replace(/\/+$/, "");
const API_TOKEN = process.env.BASTRA_API_TOKEN ?? "";
const SPAWN_ENABLED = (process.env.BASTRA_FORWARDER_SPAWN ?? "1") !== "0";
const HEALTH_TIMEOUT_MS = 10_000;
const HEALTH_POLL_INTERVAL_MS = 200;
const REQUEST_TIMEOUT_MS = 30_000;

async function probeHealth(): Promise<boolean> {
  try {
    const resp = await fetchWithTimeout(`${DAEMON_URL}/health`, {}, 1500);
    if (!resp.ok) return false;
    const body = (await resp.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
}

function spawnDaemon(): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const daemonScript = path.join(here, "index.js");
  const child = spawn(process.execPath, [daemonScript], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}

async function waitForHealth(): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < HEALTH_TIMEOUT_MS) {
    if (await probeHealth()) return true;
    await sleep(HEALTH_POLL_INTERVAL_MS);
  }
  return false;
}

async function ensureDaemonRunning(): Promise<boolean> {
  if (await probeHealth()) return true;
  if (!SPAWN_ENABLED) {
    console.error(
      "[bastra-recall-mcp] daemon not running and auto-spawn disabled (BASTRA_FORWARDER_SPAWN=0). Returning errors for tool calls until daemon is up.",
    );
    return false;
  }
  console.error("[bastra-recall-mcp] daemon not running, spawning…");
  spawnDaemon();
  const ready = await waitForHealth();
  if (!ready) {
    console.error(
      `[bastra-recall-mcp] daemon did not become healthy within ${HEALTH_TIMEOUT_MS}ms. Tool calls will error.`,
    );
  }
  return ready;
}

async function callDaemon(tool: string, args: unknown): Promise<unknown> {
  const url = `${DAEMON_URL}/api/v1/${tool}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (API_TOKEN) headers.Authorization = `Bearer ${API_TOKEN}`;

  const doFetch = async (): Promise<Response> => {
    return await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers,
        body: JSON.stringify(args ?? {}),
      },
      REQUEST_TIMEOUT_MS,
    );
  };

  let resp: Response;
  try {
    resp = await doFetch();
  } catch (err) {
    // Netzwerk-Fehler: einmaliger Retry — vielleicht ist der Daemon gerade
    // restartet. Beim zweiten Fehler durchreichen.
    await sleep(300);
    try {
      resp = await doFetch();
    } catch (err2) {
      throw new Error(
        `daemon unreachable at ${DAEMON_URL}: ${(err2 as Error).message}`,
      );
    }
  }

  const text = await resp.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`invalid JSON response from daemon: ${text.slice(0, 200)}`);
  }
  if (!resp.ok) {
    const errMsg =
      (body as { error?: string })?.error ?? `HTTP ${resp.status}`;
    throw new Error(errMsg);
  }
  return body;
}

async function main(): Promise<void> {
  // Best-effort: Daemon hochziehen wenn er fehlt. Fehlschlag blockt den
  // Stdio-Server NICHT — Tool-Calls scheitern dann mit klarer Message.
  await ensureDaemonRunning();

  // Seed the session statusline feed with the current vault size, so the
  // idle banner shows "N memories" from session start (not "0 memories"
  // until the first recall). Best-effort.
  try {
    const resp = await fetchWithTimeout(`${DAEMON_URL}/health`, {}, 1500);
    const body = (await resp.json()) as { vault_size?: number };
    if (typeof body.vault_size === "number") {
      liveStatusline.vault_size = body.vault_size;
      flushStatusline();
    }
  } catch {
    // no health / no vault_size — idle banner shows 0 until first recall
  }

  const server = new Server(
    { name: "bastra-recall-mcp", version: "0.6.0-beta.1" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    // Document-Write-Tools immer mitlisten — der Daemon entscheidet beim
    // Aufruf, ob BASTRA_DOCUMENT_WRITE=1 gesetzt ist und antwortet sonst
    // mit einer klaren Pro-Feature-Fehlermeldung.
    tools: [...MEMORY_TOOL_DEFS, ...documentTools, ...documentWriteTools],
  }));

  const banterMode = banterModeFromEnv(process.env);
  const banterLang = (process.env.BASTRA_BANTER_LANG ?? "en").toLowerCase() === "de" ? "de" : "en";

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const { name, arguments: args } = req.params;
    const progressToken = (req.params as { _meta?: { progressToken?: string | number } })._meta
      ?.progressToken;

    // Streaming recall (#38 follow-up): if the client sent a progressToken
    // and the call is `recall`, proxy via SSE against /hook/recall and
    // forward stage events as `notifications/progress` to the client.
    // Claude Code (and any MCP client that honors progress) renders these
    // as live status lines under the tool call.
    if (name === "recall") {
      const recallStartedAt = Date.now();
      // Statusline state-tracking runs for EVERY recall — independent of
      // whether the client sent a progressToken. (Claude Code often omits
      // it; the streaming SSE path against /hook/recall does not need it.)
      // Adopt a fresh turn if the prompt-hook reset to idle, then mark this
      // recall started. All mutations on in-memory liveStatusline — serial,
      // no race across parallel recalls.
      syncStatuslineTurn();
      liveStatusline.state = "running";
      liveStatusline.recall_count += 1;
      liveStatusline.current_recall_started_at = recallStartedAt;
      flushStatusline();
      try {
        const result = await callRecallStreaming(args, async (s: RecallStage) => {
          // notifications/progress only when the client opted in via a
          // progressToken. Claude Code drops them (bug #51713) — the
          // statusline segment is the visible channel there.
          if (progressToken !== undefined) {
            const phrase = pickPhrase(s, banterMode, banterLang);
            const dur = s.durationMs !== undefined ? `${s.durationMs}ms` : "";
            const message = phrase
              ? `${s.name} · ${dur} · ${phrase}`
              : `${s.name}${dur ? ` · ${dur}` : ""}`;
            await extra
              .sendNotification({
                method: "notifications/progress",
                params: {
                  progressToken,
                  progress: progressIndexFor(s.name),
                  total: RECALL_STAGE_ORDER.length,
                  message,
                },
              })
              .catch(() => undefined);
          }
          liveStatusline.current_stage = s.name;
          liveStatusline.current_stage_started_at = Date.now();
          flushStatusline();
        });
        // Recall complete: fold this recall's hits + duration into the turn
        // totals, clear the current-recall marks.
        const hits = (result as { hits?: unknown[] }).hits;
        const vaultSize = (result as { vault_size?: number }).vault_size;
        liveStatusline.total_hits += Array.isArray(hits) ? hits.length : 0;
        liveStatusline.total_ms += Date.now() - recallStartedAt;
        if (typeof vaultSize === "number") liveStatusline.vault_size = vaultSize;
        liveStatusline.current_stage = null;
        liveStatusline.current_stage_started_at = null;
        liveStatusline.current_recall_started_at = null;
        flushStatusline();
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        // On error: clear current-recall marks so the statusline doesn't
        // hang on a stuck stage.
        liveStatusline.current_stage = null;
        liveStatusline.current_stage_started_at = null;
        liveStatusline.current_recall_started_at = null;
        flushStatusline();
        return {
          isError: true,
          content: [{ type: "text" as const, text: (err as Error).message }],
        };
      }
    }

    try {
      const result = await callDaemon(name, args);
      return {
        content: [
          { type: "text", text: JSON.stringify(result, null, 2) },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          { type: "text" as const, text: (err as Error).message },
        ],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[bastra-recall-mcp] forwarder ready (daemon=${DAEMON_URL}, spawn=${SPAWN_ENABLED ? "on" : "off"})`,
  );

  const shutdown = async (): Promise<void> => {
    // Forwarder beendet sich, aber lässt den Daemon laufen — andere
    // Sessions können noch verbunden sein.
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

// ─── helpers ─────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(tid);
  }
}

interface HookRecallDonePayload {
  hits: unknown[];
  vault_size: number;
  latency_ms: number;
  recall_id: string;
}

const VALID_STAGE_NAMES: ReadonlySet<RecallStage["name"]> = new Set([
  "query.parse",
  "cache.hit",
  "bm25.search",
  "vector.search",
  "rrf.fuse",
  "hops.expand",
  "staleness.rank",
  "done",
  "error",
]);

/**
 * Streaming recall path. Posts to `/hook/recall` with `Accept:
 * text/event-stream`, parses SSE frames, fires `onStage` for each stage
 * event, returns the final result shaped like `/api/v1/recall` so the
 * client JSON is consistent regardless of which path was taken.
 *
 * Note: this reuses `/hook/recall` — that endpoint is open (no token)
 * and already SSE-capable. The side-effect is that hook_recall telemetry
 * gets logged for MCP recalls too; the `tool_name: "mcp-forwarder"`
 * marker lets us filter those out later.
 */
async function callRecallStreaming(
  args: unknown,
  onStage: (s: RecallStage) => void | Promise<void>,
): Promise<unknown> {
  const a = (args ?? {}) as Record<string, unknown>;
  const body: Record<string, unknown> = {
    query: typeof a.query === "string" ? a.query : "",
    tool_name: "mcp-forwarder",
  };
  if (typeof a.k === "number") body.k = a.k;
  if (typeof a.scope === "string") body.scope = a.scope;
  if (typeof a.type === "string") body.type = a.type;
  // MCP-Pfad: genau k Hits, keine 1-Hop-Nachbarn (#50). Der /hook/recall-
  // Default ist 1 (gut für die PreToolUse-Hook-CLI), aber für den vom Modell
  // ausgelösten recall verdoppeln die Nachbarn nur den Context. Das Modell
  // kann expand_hops:1 explizit anfordern, wenn es Related-Memories will.
  body.expand_hops = typeof a.expand_hops === "number" ? a.expand_hops : 0;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  if (API_TOKEN) headers.Authorization = `Bearer ${API_TOKEN}`;

  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(`${DAEMON_URL}/hook/recall`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(tid);
    throw new Error(`daemon unreachable at ${DAEMON_URL}: ${(err as Error).message}`);
  }

  if (!resp.ok || !resp.body) {
    clearTimeout(tid);
    throw new Error(`daemon /hook/recall failed: HTTP ${resp.status}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let payload: HookRecallDonePayload | null = null;
  let errorMsg: string | null = null;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const evt = parseSseFrame(frame);
        if (!evt) continue;
        if (evt.type === "stage") {
          const d = evt.data as { name?: string; durationMs?: number; meta?: Record<string, unknown> };
          if (!d.name || !VALID_STAGE_NAMES.has(d.name as RecallStage["name"])) continue;
          const stage: RecallStage = {
            name: d.name as RecallStage["name"],
            startedAtMs: Date.now(),
            durationMs: d.durationMs,
            meta: d.meta,
          };
          await onStage(stage);
        } else if (evt.type === "done") {
          payload = evt.data as HookRecallDonePayload;
        } else if (evt.type === "error") {
          errorMsg = (evt.data as { error?: string })?.error ?? "unknown error";
        }
      }
    }
  } finally {
    clearTimeout(tid);
  }

  if (errorMsg) throw new Error(errorMsg);
  if (!payload) throw new Error("daemon /hook/recall ended without done event");

  // No `stages` block in the tool-result (#50): stage events already drove
  // the live progress channel via onStage; the timing map would just bloat
  // the context Claude reads. Debug timings live in /api/v1/recall + telemetry.
  return {
    query: body.query,
    vault_size: payload.vault_size,
    hits: payload.hits,
    recall_id: payload.recall_id,
    latency_ms: payload.latency_ms,
  };
}

// Feed is namespaced by the CC session (claude ancestor PID) so concurrent
// sessions don't clobber each other (CC sends no session id — #41836).
// Computed once at startup; the forwarder lives for the whole session.
const STATUSLINE_FEED_PATH = sessionFeedPath(claudeSessionPid());

/**
 * Statusline state — aggregated per Assistant-Turn. Read live by the
 * @bastra-recall/statusline `bastra` segment which renders it next to the
 * user's powerline. Claude Code does NOT render MCP notifications/progress
 * (issue #51713), so this file is the out-of-band channel.
 *
 * Ownership: this forwarder process owns the authoritative copy IN MEMORY
 * (single-threaded JS → concurrent recalls mutate it serially, no race).
 * The disk file is write-only from here, plus a single read at recall-start
 * to detect the prompt-hook's idle-reset (turn boundary).
 */
interface StatuslineState {
  ts: number;
  state: "idle" | "running";
  vault_size: number;
  recall_count: number;
  total_hits: number;
  total_ms: number;
  current_stage: string | null;
  current_stage_started_at: number | null;
  current_recall_started_at: number | null;
}

function defaultStatuslineState(): StatuslineState {
  return {
    ts: Date.now(),
    state: "idle",
    vault_size: 0,
    recall_count: 0,
    total_hits: 0,
    total_ms: 0,
    current_stage: null,
    current_stage_started_at: null,
    current_recall_started_at: null,
  };
}

let liveStatusline: StatuslineState = defaultStatuslineState();

/**
 * At recall start: adopt a fresh turn if the prompt-hook wrote an idle
 * marker (state === "idle"). This is the only disk READ in the hot path.
 * Keeps the latest vault_size across the reset.
 */
function syncStatuslineTurn(): void {
  try {
    const onDisk = JSON.parse(
      fs.readFileSync(STATUSLINE_FEED_PATH, "utf8"),
    ) as Partial<StatuslineState>;
    if (onDisk.state === "idle") {
      liveStatusline = {
        ...defaultStatuslineState(),
        vault_size: onDisk.vault_size ?? liveStatusline.vault_size,
      };
    }
  } catch {
    // no file / unreadable — keep in-memory state
  }
}

let statuslineDirEnsured = false;

/** Flush in-memory state to disk (atomic). Write-only — never reads. */
function flushStatusline(): void {
  try {
    if (!statuslineDirEnsured) {
      fs.mkdirSync(STATUSLINE_DIR, { recursive: true });
      statuslineDirEnsured = true;
    }
    liveStatusline.ts = Date.now();
    const tmp = `${STATUSLINE_FEED_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(liveStatusline), { encoding: "utf8" });
    fs.renameSync(tmp, STATUSLINE_FEED_PATH);
  } catch {
    // Best-effort — never fail the recall over a statusline write.
  }
}

function parseSseFrame(frame: string): { type: string; data: unknown } | null {
  let event = "";
  let data = "";
  for (const line of frame.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!event || !data) return null;
  try {
    return { type: event, data: JSON.parse(data) };
  } catch {
    return null;
  }
}

main().catch((err) => {
  console.error("[bastra-recall-mcp] FATAL:", err);
  process.exit(1);
});
