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
import { fileURLToPath } from "node:url";
import { MEMORY_TOOL_DEFS } from "./tool-handlers.js";
import { documentTools } from "./documents-handler.js";
import { documentWriteTools } from "./documents-write-handler.js";

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

  const server = new Server(
    { name: "bastra-recall-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    // Document-Write-Tools immer mitlisten — der Daemon entscheidet beim
    // Aufruf, ob BASTRA_DOCUMENT_WRITE=1 gesetzt ist und antwortet sonst
    // mit einer klaren Pro-Feature-Fehlermeldung.
    tools: [...MEMORY_TOOL_DEFS, ...documentTools, ...documentWriteTools],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
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

main().catch((err) => {
  console.error("[bastra-recall-mcp] FATAL:", err);
  process.exit(1);
});
