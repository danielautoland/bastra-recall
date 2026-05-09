/**
 * Local HTTP endpoint for Claude Code hooks (PreToolUse / SessionStart / …).
 *
 * Lives alongside the stdio MCP transport in the same daemon process so the
 * in-memory BM25 index is reused — recall latency stays in the tens of ms.
 *
 * Bind policy: 127.0.0.1 only. If another nexus-recall daemon already holds
 * the port we emit one warning to stderr and continue without HTTP — the
 * other daemon's endpoint serves all hook callers (vault path is the same
 * by convention).
 *
 * Endpoints:
 *   POST /hook/recall  body: { query, topics?, scope?, type?, k? }
 *                      → { hits, vault_size, latency_ms, recall_id }
 *   GET  /health       → { ok, vault_size, version }
 *
 * No auth — the listener is loopback-only and the endpoint is
 * read-only (cannot save or mutate the vault).
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Vault, SearchIndex } from "@nexus-recall/core";
import { fireAndForget, type Telemetry } from "./telemetry.js";

export interface HttpOptions {
  port: number;
  vault: Vault;
  search: SearchIndex;
  telemetry: Telemetry;
  version: string;
}

const MAX_BODY_BYTES = 256 * 1024; // 256 KiB — content excerpts are capped client-side

export interface HttpHandle {
  port: number | null;
  close: () => Promise<void>;
}

export async function startHttpServer(opts: HttpOptions): Promise<HttpHandle> {
  const { port, vault, search, telemetry, version } = opts;

  const server = createServer((req, res) => {
    const t0 = Date.now();
    const url = req.url ?? "";
    const method = req.method ?? "GET";

    if (method === "GET" && url === "/health") {
      sendJson(res, 200, {
        ok: true,
        vault_size: vault.size(),
        version,
      });
      return;
    }

    if (method === "POST" && url === "/hook/recall") {
      readJsonBody(req, MAX_BODY_BYTES)
        .then(async (body) => {
          const query = typeof body.query === "string" ? body.query.trim() : "";
          if (!query) {
            sendJson(res, 400, { error: "query is required" });
            return;
          }
          const k = clampInt(body.k, 1, 10, 3);
          const scope = typeof body.scope === "string" ? body.scope : undefined;
          const type = typeof body.type === "string" ? body.type : undefined;

          const tRecall0 = Date.now();
          const hits = search.hasEmbeddings()
            ? await search.recallHybrid(query, { k, scope, type })
            : search.recall(query, { k, scope, type });
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
            }),
          );

          sendJson(res, 200, {
            hits,
            vault_size: vault.size(),
            latency_ms: totalLatencyMs,
            recall_id: recallId,
          });
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
          `[nexus-recall] http: port ${port} already in use — assuming another nexus-recall daemon owns it. Hooks will reach that one.`,
        );
        server.removeAllListeners("error");
        server.removeAllListeners("listening");
        resolve({
          port: null,
          close: async () => undefined,
        });
        return;
      }
      console.error(`[nexus-recall] http: failed to bind: ${err.message}`);
      resolve({
        port: null,
        close: async () => undefined,
      });
    };

    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onError);
      const addr = server.address() as AddressInfo;
      console.error(`[nexus-recall] http: listening on http://127.0.0.1:${addr.port}`);
      resolve({
        port: addr.port,
        close: () => closeServer(server),
      });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload).toString(),
  });
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
