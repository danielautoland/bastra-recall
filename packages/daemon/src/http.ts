/**
 * Local HTTP endpoint for Claude Code hooks (PreToolUse / SessionStart / …)
 * UND REST-API für externe Caller (ChatGPT Custom GPT Actions via Cloudflare
 * Tunnel, weitere MCP-Forwarder-Sessions, andere AI-Agents).
 *
 * Lives alongside the stdio MCP transport in the same daemon process so the
 * in-memory BM25 index, der Embedding-Index und der RelatedEnricher EIN MAL
 * gehalten werden — egal wie viele Sessions/Clients gerade angedockt sind.
 *
 * Bind policy: 127.0.0.1 only. Wenn ein anderer bastra-recall daemon den
 * Port hält, geben wir auf und überlassen ihm die Endpoints (Vault-Pfad ist
 * by convention identisch). Für public exposure: Cloudflare-Tunnel / ngrok
 * davor und BASTRA_API_TOKEN setzen.
 *
 * Endpoints:
 *   GET  /health                         → { ok, vault_size, version }
 *   POST /hook/recall                    → hook-spezifisch (Telemetry-Pfad,
 *                                          loopback-only, kein Auth)
 *
 *   REST-API (alle POST, JSON-Body, JSON-Antwort, mit Auth+CORS):
 *   POST /api/v1/recall                  → wie MCP-Tool recall
 *   POST /api/v1/load_memory             → wie MCP-Tool load_memory
 *   POST /api/v1/save_memory             → wie MCP-Tool save_memory
 *   POST /api/v1/find_document           → wie MCP-Tool find_document
 *   POST /api/v1/read_document           → wie MCP-Tool read_document
 *   POST /api/v1/open_document           → wie MCP-Tool open_document
 *   POST /api/v1/save_document           → Pro-gated
 *   POST /api/v1/recategorize_document   → Pro-gated
 *   POST /api/v1/move_document           → Pro-gated
 *
 * Auth (für /api/v1/* — /hook/recall und /health bleiben offen, sind
 * loopback-only):
 *   - Wenn BASTRA_API_TOKEN gesetzt: Authorization: Bearer <token>
 *     erforderlich.
 *   - Loopback-Aufrufe (127.0.0.1) werden per Default ohne Token
 *     akzeptiert (BASTRA_AUTH_LOOPBACK_SKIP=0 erzwingt Token auch lokal).
 *   - Ohne gesetzten Token läuft alles offen — dev/local mode.
 *
 * CORS (für /api/v1/*):
 *   - BASTRA_CORS_ORIGIN (default "*") — bei Tunneling mit eigener Domain
 *     auf konkrete Origin einschränken.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Vault, SearchIndex, RecallStage, StageListener } from "@bastra-recall/core";
import { fireAndForget, type Telemetry } from "./telemetry.js";
import {
  recallHandler,
  loadMemoryHandler,
  saveMemoryHandler,
  type ToolDeps,
} from "./tool-handlers.js";
import {
  FindDocumentArgs,
  ReadDocumentArgs,
  OpenDocumentArgs,
  findDocument,
  readDocument,
  openDocument,
} from "./documents-handler.js";
import {
  SaveDocumentArgs,
  RecategorizeDocumentArgs,
  MoveDocumentArgs,
  saveDocument,
  recategorizeDocument,
  moveDocument,
} from "./documents-write-handler.js";
import { getUpdateState } from "./update-check.js";

export interface HttpOptions {
  port: number;
  vault: Vault;
  search: SearchIndex;
  telemetry: Telemetry;
  version: string;
  toolDeps: ToolDeps;
  documentWriteEnabled: boolean;
}

const MAX_BODY_BYTES = 256 * 1024; // 256 KiB — content excerpts are capped client-side

export interface HttpHandle {
  port: number | null;
  close: () => Promise<void>;
}

// Loopback-Aufrufe sehen wir an `127.0.0.1`/`::1`/`::ffff:127.0.0.1`. Wenn
// BASTRA_AUTH_LOOPBACK_SKIP nicht explizit auf "0" steht, dürfen sie
// /api/v1/* ohne Token aufrufen — der MCP-Forwarder läuft loopback und soll
// nicht jedes Mal authentifizieren müssen.
function isLoopback(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? "";
  return (
    addr === "127.0.0.1" ||
    addr === "::1" ||
    addr === "::ffff:127.0.0.1"
  );
}

export async function startHttpServer(opts: HttpOptions): Promise<HttpHandle> {
  const { port, vault, telemetry, version, toolDeps, documentWriteEnabled } = opts;
  const { search } = toolDeps;

  const apiToken = process.env.BASTRA_API_TOKEN ?? "";
  const loopbackSkip = (process.env.BASTRA_AUTH_LOOPBACK_SKIP ?? "1") !== "0";
  const corsOrigin = process.env.BASTRA_CORS_ORIGIN ?? "*";

  const server = createServer((req, res) => {
    const t0 = Date.now();
    const url = req.url ?? "";
    const method = req.method ?? "GET";

    // CORS preflight for /api/v1/*
    if (method === "OPTIONS" && url.startsWith("/api/v1/")) {
      sendCors(res, corsOrigin);
      res.writeHead(204);
      res.end();
      return;
    }

    if (method === "GET" && url === "/health") {
      const updateState = getUpdateState();
      sendJson(res, 200, {
        ok: true,
        vault_size: vault.size(),
        version,
        update_available: updateState && updateState.hasUpdate
          ? {
              current: updateState.current,
              latest: updateState.latest,
              html_url: updateState.html_url,
              published_at: updateState.published_at,
            }
          : null,
      });
      return;
    }

    if (method === "POST" && url === "/hook/recall") {
      handleHookRecall(req, res, t0, vault, search, telemetry);
      return;
    }

    // ─── REST-API /api/v1/* ──────────────────────────────────────
    if (url.startsWith("/api/v1/")) {
      sendCors(res, corsOrigin);

      // Auth-Gate (nach CORS-Header, damit Browser-Preflight nicht
      // an 401 verzweifelt)
      if (apiToken && !(loopbackSkip && isLoopback(req))) {
        const authz = req.headers.authorization ?? "";
        const expected = `Bearer ${apiToken}`;
        if (authz !== expected) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }
      }

      if (method !== "POST") {
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }

      const tool = url.slice("/api/v1/".length);

      readJsonBody(req, MAX_BODY_BYTES)
        .then(async (body) => {
          try {
            const result = await dispatchApi(tool, body, {
              toolDeps,
              documentWriteEnabled,
            });
            if (result === undefined) {
              sendJson(res, 404, { error: `unknown tool: ${tool}` });
              return;
            }
            sendJson(res, 200, result);
          } catch (err) {
            sendJson(res, 400, { error: (err as Error).message });
          }
        })
        .catch((err: Error) => {
          sendJson(res, 400, { error: err.message });
        });
      return;
    }

    sendJson(res, 404, { error: `not found: ${method} ${url}` });
  });

  return new Promise<HttpHandle>((resolve) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      if (err.code === "EADDRINUSE") {
        console.error(
          `[bastra-recall] http: port ${port} already in use — assuming another bastra-recall daemon owns it. Hooks will reach that one.`,
        );
        server.removeAllListeners("error");
        server.removeAllListeners("listening");
        resolve({
          port: null,
          close: async () => undefined,
        });
        return;
      }
      console.error(`[bastra-recall] http: failed to bind: ${err.message}`);
      resolve({
        port: null,
        close: async () => undefined,
      });
    };

    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onError);
      const addr = server.address() as AddressInfo;
      console.error(`[bastra-recall] http: listening on http://127.0.0.1:${addr.port}`);
      resolve({
        port: addr.port,
        close: () => closeServer(server),
      });
    });
  });
}

// ─── /hook/recall handler ────────────────────────────────────────

function handleHookRecall(
  req: IncomingMessage,
  res: ServerResponse,
  t0: number,
  vault: Vault,
  search: SearchIndex,
  telemetry: Telemetry,
): void {
  // SSE-Branch (#38): wenn der Caller `Accept: text/event-stream`
  // sendet, streamen wir Stages live. Default-JSON-Response bleibt
  // BC-erhalten — alte Hook-CLIs und REST-Caller sehen keinen
  // Unterschied.
  const accept = String(req.headers.accept ?? "");
  const wantsSse = accept.includes("text/event-stream");

  readJsonBody(req, MAX_BODY_BYTES)
    .then(async (body) => {
      const query = typeof body.query === "string" ? body.query.trim() : "";
      if (!query) {
        if (wantsSse) {
          openSseHeaders(res);
          writeSseEvent(res, "error", { error: "query is required" });
          res.end();
        } else {
          sendJson(res, 400, { error: "query is required" });
        }
        return;
      }
      const k = clampInt(body.k, 1, 10, 3);
      const scope = typeof body.scope === "string" ? body.scope : undefined;
      const type = typeof body.type === "string" ? body.type : undefined;
      // expand_hops: Hooks profitieren vom Multi-Hop-Recall sobald
      // related_via befüllt ist (über RelatedEnricher). Default 1 — der
      // Caller kann explizit 0 schicken um es zu deaktivieren.
      const expand_hops = body.expand_hops === 0 ? 0 : 1;

      const stageTimings: NonNullable<Parameters<Telemetry["logHookRecall"]>[0]["recall_stages"]> = {};
      const collectStage = (s: RecallStage): void => {
        if (s.name === "cache.hit") {
          stageTimings.cache_hit = true;
          return;
        }
        if (s.durationMs === undefined) return;
        switch (s.name) {
          case "query.parse": stageTimings.query_parse_ms = s.durationMs; break;
          case "bm25.search": stageTimings.bm25_search_ms = s.durationMs; break;
          case "vector.search": stageTimings.vector_search_ms = s.durationMs; break;
          case "rrf.fuse": stageTimings.rrf_fuse_ms = s.durationMs; break;
          case "hops.expand": stageTimings.hops_expand_ms = s.durationMs; break;
          case "staleness.rank": stageTimings.staleness_rank_ms = s.durationMs; break;
        }
      };

      if (wantsSse) {
        openSseHeaders(res);
      }

      const onStage: StageListener = (s: RecallStage) => {
        collectStage(s);
        if (wantsSse) {
          // Nur Stop- + cache.hit + done-Events streamen (Start-Events
          // wären für UI redundant). `done`-Event kommt unten als
          // separater finaler SSE-Event mit den hits[] — wir
          // unterdrücken den Stage-`done`, damit der finale Frame
          // nicht doppelt rendert.
          if (s.name === "done") return;
          if (s.durationMs === undefined && s.name !== "cache.hit") return;
          writeSseEvent(res, "stage", {
            name: s.name,
            durationMs: s.durationMs,
            meta: s.meta,
          });
        }
      };

      const tRecall0 = Date.now();
      const hits = search.hasEmbeddings()
        ? await search.recallHybrid(query, { k, scope, type, expand_hops, onStage })
        : search.recall(query, { k, scope, type, expand_hops, onStage });
      const recallLatencyMs = Date.now() - tRecall0;
      const totalLatencyMs = Date.now() - t0;
      const recallId = telemetry.newRecallId();
      telemetry.recordHookHints(recallId, hits);

      fireAndForget(
        telemetry.logHookRecall({
          recall_id: recallId,
          query,
          topics: Array.isArray(body.topics)
            ? (body.topics as unknown[]).filter((t): t is string => typeof t === "string")
            : [],
          tool_name: typeof body.tool_name === "string" ? body.tool_name : null,
          project: typeof body.project === "string" ? body.project : null,
          k,
          scope: scope ?? null,
          type: type ?? null,
          vault_size: vault.size(),
          hit_count: hits.length,
          top_score: hits[0]?.score ?? null,
          hits: hits.map((h) => ({ id: h.id, score: h.score, type: h.type })),
          latency_ms_recall: recallLatencyMs,
          latency_ms_total: totalLatencyMs,
          recall_stages: stageTimings,
        }),
      );

      const payload = {
        hits,
        vault_size: vault.size(),
        latency_ms: totalLatencyMs,
        recall_id: recallId,
      };
      if (wantsSse) {
        writeSseEvent(res, "done", payload);
        res.end();
      } else {
        sendJson(res, 200, payload);
      }
    })
    .catch((err: Error) => {
      if (wantsSse && !res.headersSent) {
        openSseHeaders(res);
      }
      if (wantsSse) {
        writeSseEvent(res, "error", { error: err.message });
        res.end();
      } else {
        sendJson(res, 400, { error: err.message });
      }
    });
}

// ─── SSE helpers ─────────────────────────────────────────────────

function openSseHeaders(res: ServerResponse): void {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  // Disable Nagle for prompt event delivery on local connections.
  res.setHeader("X-Accel-Buffering", "no");
  res.writeHead(200);
  // First chunk forces headers to flush so curl/test clients see them
  // before the first stage event lands.
  res.write(":ok\n\n");
}

function writeSseEvent(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ─── /api/v1 dispatcher ──────────────────────────────────────────

interface DispatchCtx {
  toolDeps: ToolDeps;
  documentWriteEnabled: boolean;
}

async function dispatchApi(
  tool: string,
  body: Record<string, unknown>,
  ctx: DispatchCtx,
): Promise<unknown | undefined> {
  const { toolDeps, documentWriteEnabled } = ctx;
  const { vault, search } = toolDeps;

  switch (tool) {
    case "recall":
      return await recallHandler(toolDeps, body);
    case "load_memory":
      return await loadMemoryHandler(toolDeps, body);
    case "save_memory":
      return await saveMemoryHandler(toolDeps, body);

    case "find_document": {
      const parsed = FindDocumentArgs.safeParse(body);
      if (!parsed.success) throw new Error(parsed.error.message);
      return findDocument(search, parsed.data);
    }
    case "read_document": {
      const parsed = ReadDocumentArgs.safeParse(body);
      if (!parsed.success) throw new Error(parsed.error.message);
      const doc = readDocument(vault, parsed.data);
      if (!doc) throw new Error(`document not found: ${parsed.data.id}`);
      return doc;
    }
    case "open_document": {
      const parsed = OpenDocumentArgs.safeParse(body);
      if (!parsed.success) throw new Error(parsed.error.message);
      const result = openDocument(vault, parsed.data);
      if ("ok" in result && !result.ok) {
        throw new Error(result.message);
      }
      return result;
    }

    case "save_document":
    case "recategorize_document":
    case "move_document": {
      if (!documentWriteEnabled) {
        throw new Error(
          `${tool} is a Pro feature — set BASTRA_DOCUMENT_WRITE=1 to enable.`,
        );
      }
      if (tool === "save_document") {
        const parsed = SaveDocumentArgs.safeParse(body);
        if (!parsed.success) throw new Error(parsed.error.message);
        return await saveDocument(vault, parsed.data);
      }
      if (tool === "recategorize_document") {
        const parsed = RecategorizeDocumentArgs.safeParse(body);
        if (!parsed.success) throw new Error(parsed.error.message);
        return await recategorizeDocument(vault, parsed.data);
      }
      const parsed = MoveDocumentArgs.safeParse(body);
      if (!parsed.success) throw new Error(parsed.error.message);
      return await moveDocument(vault, parsed.data);
    }
  }
  return undefined;
}

// ─── helpers ─────────────────────────────────────────────────────

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function sendCors(res: ServerResponse, origin: string): void {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization",
  );
  res.setHeader("Access-Control-Max-Age", "600");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  if (!res.headersSent) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Length", Buffer.byteLength(payload).toString());
  }
  res.writeHead(status);
  res.end(payload);
}

function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error(`body too large (>${maxBytes} bytes)`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        resolve(parsed);
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", (err) => reject(err));
  });
}

function clampInt(
  raw: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  const i = Math.round(raw);
  return Math.min(max, Math.max(min, i));
}
