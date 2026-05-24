#!/usr/bin/env node
/**
 * bastra-recall bridge — line-JSON RPC over stdio.
 *
 * Designed to be spawned as a child process by the Mac-app's Tauri
 * backend. The MCP server (index.ts) is for Claude Code; this bridge
 * is for the app's UI. Same vault, same in-memory index, different
 * transport.
 *
 * Protocol (one JSON object per line, both directions):
 *   request:  {"id": <number>, "method": <string>, "params"?: <object>}
 *   response: {"id": <number>, "result": <any>}  OR
 *             {"id": <number>, "error": {"message": <string>}}
 *
 * Methods:
 *   vault_status()                       -> { size: number }
 *   recall({ query, k?, scope?, type? }) -> RecallHit[]
 *   list_memorys({ type?, scope? })      -> Frontmatter[]
 *   load_memory({ id })                  -> { id, frontmatter, body, file_path } | null
 *   save_memory(SaveMemoryInput)         -> { id, file_path, created }
 *   delete_memory({ id })                -> { id, file_path, deleted }
 */
import {
  Vault,
  SearchIndex,
  EmbeddingIndex,
  OpenAIEmbeddingProvider,
  OllamaEmbeddingProvider,
  RelatedEnricher,
  type EmbeddingProvider,
  SaveMemoryInput,
  AuditLog,
  AuditContext,
  auditedSave,
  auditedSoftDelete,
  auditedRestore,
} from "@bastra-recall/core";
import { envFirst, envInt, envFloat, envBool } from "./env.js";
import readline from "node:readline";
import * as path from "node:path";

/**
 * Aktiviert Embeddings basierend auf BASTRA_EMBEDDING_PROVIDER:
 *   - "ollama": Lokal via Ollama (Standard für neue Setups). Optional
 *               BASTRA_OLLAMA_URL und BASTRA_EMBEDDING_MODEL.
 *   - "openai": Cloud via OpenAI. Braucht OPENAI_API_KEY oder BASTRA_EMBEDDING_KEY.
 *   - "none" / unset: Embeddings disabled (Recall fällt auf reines BM25).
 *
 * Default-Verhalten (kein BASTRA_EMBEDDING_PROVIDER gesetzt):
 *   Wenn ein OpenAI-Key gesetzt ist → openai (Backwards-Compat).
 *   Sonst disabled. Wer auf Ollama umstellen will, setzt explizit
 *   BASTRA_EMBEDDING_PROVIDER=ollama.
 */
async function attachEmbeddings(search: SearchIndex, vault: Vault): Promise<void> {
  const provider = pickEmbeddingProvider();
  if (!provider) return;
  const persistPath = path.join(VAULT_PATH!, ".bastra", "embeddings.json");
  const idx = new EmbeddingIndex(vault, provider, persistPath);
  await idx.start();
  search.useEmbeddings(idx);
  process.stderr.write(
    `[bastra-recall.bridge] embeddings ready provider=${provider.id} (${idx.size()} vectors, ${idx.pendingSize()} pending)\n`,
  );
  // Auto-Related-Enricher: pflegt frontmatter.related_via nach jedem Embed-
  // Batch. Im Bridge-Pfad (Mac-App) gleicher Default-Status wie im MCP-Pfad.
  if (envBool("BASTRA_AUTO_RELATED", true)) {
    const enricher = new RelatedEnricher(vault, idx, {
      topN: envInt("BASTRA_RELATED_TOP_N", 5),
      threshold: envFloat("BASTRA_RELATED_THRESHOLD", 0.7),
    });
    enricher.start();
    process.stderr.write(
      `[bastra-recall.bridge] auto-related: enabled (top ${envInt("BASTRA_RELATED_TOP_N", 5)} ≥ ${envFloat("BASTRA_RELATED_THRESHOLD", 0.7)})\n`,
    );
  }
}

function pickEmbeddingProvider(): EmbeddingProvider | null {
  const requested = (process.env.BASTRA_EMBEDDING_PROVIDER ?? "").toLowerCase();
  const apiKey = process.env.OPENAI_API_KEY ?? process.env.BASTRA_EMBEDDING_KEY;

  if (requested === "none") {
    process.stderr.write("[bastra-recall.bridge] embeddings disabled (provider=none)\n");
    return null;
  }
  if (requested === "ollama") {
    return makeOllamaProvider();
  }
  if (requested === "openai") {
    if (!apiKey) {
      process.stderr.write(
        "[bastra-recall.bridge] embeddings disabled (provider=openai but no API key)\n",
      );
      return null;
    }
    return new OpenAIEmbeddingProvider({ apiKey });
  }
  // Backwards-compat: kein expliziter Provider, aber API-Key vorhanden.
  if (apiKey) {
    return new OpenAIEmbeddingProvider({ apiKey });
  }
  process.stderr.write(
    "[bastra-recall.bridge] embeddings disabled (no BASTRA_EMBEDDING_PROVIDER, no API key)\n",
  );
  return null;
}

function makeOllamaProvider(): OllamaEmbeddingProvider {
  const baseURL = process.env.BASTRA_OLLAMA_URL ?? "http://localhost:11434";
  const model = process.env.BASTRA_EMBEDDING_MODEL ?? "embeddinggemma";
  // Optional: dim per env override-bar — bei nicht-default Modell (z.B.
  // bge-m3 mit 1024 dim) muss der User das matchen.
  const dimEnv = process.env.BASTRA_EMBEDDING_DIM;
  const dim = dimEnv ? Number.parseInt(dimEnv, 10) : undefined;
  return new OllamaEmbeddingProvider({ baseURL, model, dim });
}

const VAULT_PATH = envFirst("BASTRA_VAULT_PATH", "NEXUS_VAULT_PATH");
if (!VAULT_PATH) {
  process.stderr.write("[bastra-recall.bridge] FATAL: BASTRA_VAULT_PATH is not set\n");
  process.exit(2);
}

interface Request {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

function send(payload: object): void {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

async function main(): Promise<void> {
  const vault = new Vault(VAULT_PATH!);
  const { loaded, skipped } = await vault.init();
  process.stderr.write(
    `[bastra-recall.bridge] vault loaded: ${loaded} memorys` +
      (skipped.length ? `, ${skipped.length} skipped` : "") +
      "\n",
  );
  vault.startWatching();
  const search = new SearchIndex(vault);
  search.start();
  const auditLog = new AuditLog(VAULT_PATH!);

  // Optional: Embedding-Index für semantische Recall-Suche. Bei vorhandenem
  // OPENAI_API_KEY wird OpenAI text-embedding-3-small aktiviert und mit
  // BM25 via RRF gefused. Sonst bleibt Recall reines BM25.
  attachEmbeddings(search, vault).catch((err) => {
    process.stderr.write(`[bastra-recall.bridge] embeddings attach error: ${err}\n`);
  });

  // Push-Channel: jedes Vault-Event geht als unsolicited Notification an die
  // App, damit die UI live aktualisiert ohne pollen zu müssen. Notifications
  // haben kein `id`-Feld — die App unterscheidet so von Responses.
  vault.on((e) => {
    if (e.kind === "remove") {
      send({ event: "vault_changed", kind: "remove", memory_id: e.id });
    } else {
      send({ event: "vault_changed", kind: e.kind, memory_id: e.memory.fm.id });
    }
  });

  process.stderr.write("[bastra-recall.bridge] ready\n");

  const rl = readline.createInterface({ input: process.stdin });

  rl.on("line", (line) => {
    let req: Request;
    try {
      req = JSON.parse(line);
    } catch {
      return; // malformed → silently drop, no id to reply to
    }
    const { id, method, params } = req;
    try {
      let result: unknown;
      switch (method) {
        case "vault_status":
          result = { size: vault.size() };
          break;
        case "recall": {
          // Hybrid (BM25 + Vector via RRF) wenn EmbeddingIndex registriert,
          // sonst plain BM25 (sync). Mac-App sieht IMMER den vollen Vault
          // inkl. private-Memories → allow_private: true hardgecoded; der
          // MCP-Server (index.ts) ist die richtige Stelle für externen
          // Filter. expand_hops/scope/type sind optional vom Caller.
          const opts = {
            k: params?.k as number | undefined,
            scope: params?.scope as string | undefined,
            type: params?.type as string | undefined,
            allow_private: true,
            expand_hops: (params?.expand_hops === 1 ? 1 : 0) as 0 | 1,
          };
          if (search.hasEmbeddings()) {
            search
              .recallHybrid(String(params?.query ?? ""), opts)
              .then((hits) => send({ id, result: hits }))
              .catch((err: Error) => send({ id, error: { message: err.message } }));
            return;
          }
          result = search.recall(String(params?.query ?? ""), opts);
          break;
        }
        case "list_memorys": {
          const wantType = params?.type as string | undefined;
          const wantScope = params?.scope as string | undefined;
          const all = vault.list();
          const filtered = all
            .filter((m) => !m.fm.obsolete)
            .filter((m) => !wantType || m.fm.type === wantType)
            .filter((m) => !wantScope || m.fm.scope === wantScope);
          result = filtered.map((m) => m.fm);
          break;
        }
        case "load_memory": {
          const m = search.loadFull(String(params?.id ?? ""));
          result = m
            ? {
                id: m.fm.id,
                frontmatter: m.fm,
                body: m.body,
                file_path: m.filePath,
              }
            : null;
          break;
        }
        case "save_memory": {
          // Caller-supplied audit_context wird vor dem Save-Schema getrennt;
          // Default-Actor für Mac-App-Aufrufe ist "user" (kein expliziter Reason nötig).
          const rawParams = (params ?? {}) as Record<string, unknown>;
          const ctxRaw = rawParams.audit_context as Record<string, unknown> | undefined;
          const { audit_context: _ignored, ...rest } = rawParams;
          void _ignored;
          const ctx = AuditContext.parse(ctxRaw ?? { actor: "user" });
          const parsed = SaveMemoryInput.safeParse(rest);
          if (!parsed.success) {
            throw new Error(parsed.error.message);
          }
          auditedSave({
            vault,
            auditLog,
            vaultRoot: VAULT_PATH!,
            input: parsed.data,
            context: ctx,
          })
            .then(async ({ result, audit }) => {
              await vault.reindexFile(result.file_path);
              send({ id, result: { ...result, audit_id: audit.id } });
            })
            .catch((err: Error) => {
              send({ id, error: { message: err.message } });
            });
          return;
        }
        case "delete_memory": {
          const targetId = String(params?.id ?? "").trim();
          if (!targetId) throw new Error("id is required");
          const ctxRaw = (params as Record<string, unknown> | undefined)
            ?.audit_context as Record<string, unknown> | undefined;
          const ctx = AuditContext.parse(ctxRaw ?? { actor: "user" });
          auditedSoftDelete({
            vault,
            auditLog,
            vaultRoot: VAULT_PATH!,
            memoryID: targetId,
            context: ctx,
          })
            .then(({ id: deletedId, trashPath, audit }) => {
              send({
                id,
                result: {
                  id: deletedId,
                  file_path: trashPath,
                  deleted: true,
                  audit_id: audit.id,
                },
              });
            })
            .catch((err: Error) => {
              send({ id, error: { message: err.message } });
            });
          return;
        }
        case "restore_memory": {
          const targetId = String(params?.id ?? "").trim();
          if (!targetId) throw new Error("id is required");
          const ctxRaw = (params as Record<string, unknown> | undefined)
            ?.audit_context as Record<string, unknown> | undefined;
          const ctx = AuditContext.parse(ctxRaw ?? { actor: "user" });
          const destOverride =
            typeof (params as Record<string, unknown> | undefined)?.dest_file_path
              === "string"
              ? ((params as Record<string, unknown>).dest_file_path as string)
              : undefined;
          auditedRestore({
            auditLog,
            vaultRoot: VAULT_PATH!,
            memoryID: targetId,
            destFilePath: destOverride,
            context: ctx,
          })
            .then(async ({ id: restoredId, restoredTo, audit }) => {
              // Restore = neuer File-Add für den Vault — explicit reindex.
              await vault.reindexFile(restoredTo);
              send({
                id,
                result: {
                  id: restoredId,
                  file_path: restoredTo,
                  audit_id: audit.id,
                },
              });
            })
            .catch((err: Error) => {
              send({ id, error: { message: err.message } });
            });
          return;
        }
        case "reindex_file": {
          // Cloud-Storage chokidar-Watcher kann mehrere Sekunden lagged
          // sein. Mac-App ruft das nach direktem Sidecar-Write um sofortige
          // Recall-Konsistenz zu erzwingen (Document-Hub Phase 1.4).
          const filePath = String(params?.file_path ?? "").trim();
          if (!filePath) throw new Error("file_path is required");
          vault.reindexFile(filePath)
            .then(() => send({ id, result: { reindexed: true, file_path: filePath } }))
            .catch((err: Error) => send({ id, error: { message: err.message } }));
          return;
        }
        case "audit_history": {
          const memoryID = String(params?.memory_id ?? "").trim();
          if (!memoryID) throw new Error("memory_id is required");
          auditLog.forMemory(memoryID)
            .then((entries) => send({ id, result: entries }))
            .catch((err: Error) => send({
              id,
              error: { message: err.message },
            }));
          return;
        }
        case "audit_recent": {
          const sinceISO = String(params?.since ?? "");
          if (!sinceISO) throw new Error("since (ISO timestamp) is required");
          const filterActor = params?.actor as string | undefined;
          const filterOp = params?.operation as string | undefined;
          auditLog
            .since(sinceISO, {
              actor: filterActor as never,
              operation: filterOp as never,
            })
            .then((entries) => send({ id, result: entries }))
            .catch((err: Error) => send({
              id,
              error: { message: err.message },
            }));
          return;
        }
        default:
          throw new Error(`unknown method: ${method}`);
      }
      send({ id, result });
    } catch (err) {
      send({
        id,
        error: { message: err instanceof Error ? err.message : String(err) },
      });
    }
  });

  rl.on("close", () => {
    process.stderr.write("[bastra-recall.bridge] stdin closed, exiting\n");
    process.exit(0);
  });
}

main().catch((err) => {
  process.stderr.write(`[bastra-recall.bridge] FATAL: ${err}\n`);
  process.exit(1);
});
