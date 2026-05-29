#!/usr/bin/env node
/**
 * bastra-recall daemon — MCP server over a markdown memory vault.
 *
 * Tools exposed:
 *   recall(query, k?, scope?, type?)  → top-k matches
 *   load_memory(id)                   → full memory content (frontmatter + body)
 *
 * Configuration (env):
 *   BASTRA_VAULT_PATH — required. Absolute path to the vault directory
 *                       (e.g. /Users/n0mad/Daniel/memorys).
 *                       Legacy alias `NEXUS_VAULT_PATH` wird noch gelesen.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  Vault,
  SearchIndex,
  EmbeddingIndex,
  OpenAIEmbeddingProvider,
  OllamaEmbeddingProvider,
  RelatedEnricher,
  pickPhrase,
  banterModeFromEnv,
  progressIndexFor,
  RECALL_STAGE_ORDER,
  type EmbeddingProvider,
  type RecallStage,
  type StageListener,
} from "@bastra-recall/core";
import * as path from "node:path";
import { Telemetry, logDirFor } from "./telemetry.js";
import { startHttpServer } from "./http.js";
import {
  recallHandler,
  loadMemoryHandler,
  saveMemoryHandler,
  MEMORY_TOOL_DEFS,
  type ToolDeps,
} from "./tool-handlers.js";
import {
  documentTools,
  FindDocumentArgs,
  ReadDocumentArgs,
  OpenDocumentArgs,
  findDocument,
  readDocument,
  openDocument,
} from "./documents-handler.js";
import {
  documentWriteTools,
  SaveDocumentArgs,
  RecategorizeDocumentArgs,
  MoveDocumentArgs,
  saveDocument,
  recategorizeDocument,
  moveDocument,
} from "./documents-write-handler.js";
import { envFirst, envInt, envFloat, envBool } from "./env.js";
import { startBackgroundCheck } from "./update-check.js";

// Triage Issue #24: Write-Tools sind Pro-Feature. Aktuelles Gate ist ein
// env-Flag — wenn ein Pro-License-Service kommt, ersetzt der das hier.
const DOCUMENT_WRITE_ENABLED = envFirst("BASTRA_DOCUMENT_WRITE", "NEXUS_DOCUMENT_WRITE") === "1";

const DAEMON_VERSION = "0.1.0";
const DEFAULT_HTTP_PORT = 6723;

const VAULT_PATH = envFirst("BASTRA_VAULT_PATH", "NEXUS_VAULT_PATH");
if (!VAULT_PATH) {
  console.error(
    "[bastra-recall] FATAL: BASTRA_VAULT_PATH is not set. " +
      "Point it at the directory holding your memory .md files.",
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const vault = new Vault(VAULT_PATH!);
  const { loaded, skipped } = await vault.init();
  console.error(
    `[bastra-recall] vault loaded: ${loaded} memorys` +
      (skipped.length ? `, ${skipped.length} skipped` : ""),
  );
  for (const s of skipped) {
    console.error(`[bastra-recall]   skipped ${s.path}: ${s.err}`);
  }
  vault.startWatching();

  const search = new SearchIndex(vault);
  search.start();

  // Hybrid-Recall: Provider via BASTRA_EMBEDDING_PROVIDER (ollama|openai|none).
  // Backwards-compat: ohne expliziten Provider, aber mit OPENAI_API_KEY → openai.
  const provider = pickEmbeddingProvider();
  if (provider) {
    const persistPath = path.join(VAULT_PATH!, ".bastra", "embeddings.json");
    const embIdx = new EmbeddingIndex(vault, provider, persistPath);
    // Auto-Related-Enricher: pflegt frontmatter.related_via nach jedem Embed-
    // Batch. Threshold/topN über Env überschreibbar, sonst RelatedEnricher-
    // Defaults (top 5, cosine ≥ 0.7).
    const enricher = new RelatedEnricher(vault, embIdx, {
      topN: envInt("BASTRA_RELATED_TOP_N", 5),
      threshold: envFloat("BASTRA_RELATED_THRESHOLD", 0.7),
    });
    embIdx
      .start()
      .then(() => {
        search.useEmbeddings(embIdx);
        if (envBool("BASTRA_AUTO_RELATED", true)) {
          enricher.start();
          console.error(
            `[bastra-recall] auto-related: enabled (top ${envInt("BASTRA_RELATED_TOP_N", 5)} ≥ ${envFloat("BASTRA_RELATED_THRESHOLD", 0.7)})`,
          );
        }
        console.error(
          `[bastra-recall] embeddings ready provider=${provider.id} (${embIdx.size()} vectors, ${embIdx.pendingSize()} pending)`,
        );
      })
      .catch((err) => {
        console.error(`[bastra-recall] embeddings start error: ${err}`);
      });
  }

  // Update-check (fire-and-forget, opt-out via BASTRA_UPDATE_CHECK=off).
  // Caches result on disk for 24h → no GitHub-API hit on every daemon restart.
  startBackgroundCheck(DAEMON_VERSION);

  const telemetry = new Telemetry();
  if (telemetry.isEnabled()) {
    console.error(`[bastra-recall] telemetry: enabled (log path: ${logDirFor()})`);
  } else {
    console.error(`[bastra-recall] telemetry: disabled`);
  }

  // Shared dependency-bag — wird sowohl vom MCP-stdio-Handler als auch von den
  // HTTP-REST-Routes konsumiert. Damit teilen beide Pfade Tool-Logik und
  // Telemetry; kein Drift.
  const toolDeps: ToolDeps = {
    vault,
    search,
    telemetry,
    vaultPath: VAULT_PATH!,
  };

  // Idle self-shutdown: the shared daemon is spawned on demand by the
  // mcp-forwarder, so it can safely self-terminate after a stretch of no
  // activity — the next recall respawns it. Keeps the process table clean
  // (no orphaned daemons after sessions end). 0 disables. Default 30 min.
  const idleShutdownMs = envInt("BASTRA_DAEMON_IDLE_SHUTDOWN_MS", 30 * 60 * 1000);
  let lastActivityMs = Date.now();
  const markActivity = (): void => {
    lastActivityMs = Date.now();
  };

  const httpPort = envInt("BASTRA_HTTP_PORT", DEFAULT_HTTP_PORT, "NEXUS_HTTP_PORT");
  const httpHandle =
    envFirst("BASTRA_HTTP", "NEXUS_HTTP") === "off"
      ? { port: null, close: async () => undefined }
      : await startHttpServer({
          port: Number.isFinite(httpPort) ? httpPort : DEFAULT_HTTP_PORT,
          vault,
          search,
          telemetry,
          version: DAEMON_VERSION,
          toolDeps,
          documentWriteEnabled: DOCUMENT_WRITE_ENABLED,
          onActivity: markActivity,
        });

  const server = new Server(
    { name: "bastra-recall", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      ...MEMORY_TOOL_DEFS,
      ...documentTools,
      ...(DOCUMENT_WRITE_ENABLED ? documentWriteTools : []),
    ],
  }));


  // Banter-Lang: nutzt BASTRA_BANTER_LANG (de|en), default `en` —
  // MCP-Clients sind heterogen, ein deutsches "Stichwörter durchforsten"
  // im englischen Chat-Verlauf wirkt fremd. Deutsche Mac-App-User setzen
  // BASTRA_BANTER_LANG=de in ihrer Shell oder dem Daemon-Launchd-Plist.
  const banterMode = banterModeFromEnv(process.env);
  const banterLang = (process.env.BASTRA_BANTER_LANG ?? "en").toLowerCase() === "de" ? "de" : "en";

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    markActivity();
    const { name, arguments: args } = req.params;

    if (name === "recall") {
      try {
        // MCP-Progress-Notification (#38): wenn der Caller einen
        // progressToken mitschickt, leiten wir Stage-Events als
        // `notifications/progress` weiter. Claude Code rendert die als
        // Live-Stage-Lines unter dem Tool-Aufruf. Banter-Phrase landet
        // im `message`-Feld der Notification.
        const progressToken = (req.params as { _meta?: { progressToken?: string | number } })._meta
          ?.progressToken;
        const onStage: StageListener | undefined = progressToken !== undefined
          ? (s: RecallStage) => {
              // Nur Stop-Events (mit durationMs) als Progress-Tick
              // emittieren — Start-Events würden Claude Code mit
              // doppelten Lines fluten.
              if (s.durationMs === undefined && s.name !== "cache.hit" && s.name !== "done") return;
              const phrase = pickPhrase(s, banterMode, banterLang);
              const message = phrase
                ? `${s.name} — ${phrase}${s.durationMs !== undefined ? ` (${s.durationMs}ms)` : ""}`
                : `${s.name}${s.durationMs !== undefined ? ` (${s.durationMs}ms)` : ""}`;
              // Fire-and-forget — Notification-Failures dürfen den
              // Recall nicht kippen.
              void extra.sendNotification({
                method: "notifications/progress",
                params: {
                  progressToken,
                  progress: progressIndexFor(s.name),
                  total: RECALL_STAGE_ORDER.length,
                  message,
                },
              }).catch(() => undefined);
            }
          : undefined;
        const result = await recallHandler(toolDeps, args, { onStage });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorResult((err as Error).message);
      }
    }

    if (name === "load_memory") {
      try {
        const result = await loadMemoryHandler(toolDeps, args);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorResult((err as Error).message);
      }
    }

    if (name === "save_memory") {
      try {
        const result = await saveMemoryHandler(toolDeps, args);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorResult((err as Error).message);
      }
    }

    if (name === "find_document") {
      const parsed = FindDocumentArgs.safeParse(args);
      if (!parsed.success) return errorResult(parsed.error.message);
      const result = findDocument(search, parsed.data);
      return {
        content: [
          { type: "text", text: JSON.stringify(result, null, 2) },
        ],
      };
    }

    if (name === "read_document") {
      const parsed = ReadDocumentArgs.safeParse(args);
      if (!parsed.success) return errorResult(parsed.error.message);
      const doc = readDocument(vault, parsed.data);
      if (!doc) return errorResult(`document not found: ${parsed.data.id}`);
      return {
        content: [
          { type: "text", text: JSON.stringify(doc, null, 2) },
        ],
      };
    }

    if (name === "open_document") {
      const parsed = OpenDocumentArgs.safeParse(args);
      if (!parsed.success) return errorResult(parsed.error.message);
      const result = openDocument(vault, parsed.data);
      if ("ok" in result && !result.ok) {
        return errorResult(result.message);
      }
      return {
        content: [
          { type: "text", text: JSON.stringify(result, null, 2) },
        ],
      };
    }

    if (name === "save_document" || name === "recategorize_document" || name === "move_document") {
      if (!DOCUMENT_WRITE_ENABLED) {
        return errorResult(
          `${name} is a Pro feature — set BASTRA_DOCUMENT_WRITE=1 to enable.`,
        );
      }
      try {
        if (name === "save_document") {
          const parsed = SaveDocumentArgs.safeParse(args);
          if (!parsed.success) return errorResult(parsed.error.message);
          const result = await saveDocument(vault, parsed.data);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }
        if (name === "recategorize_document") {
          const parsed = RecategorizeDocumentArgs.safeParse(args);
          if (!parsed.success) return errorResult(parsed.error.message);
          const result = await recategorizeDocument(vault, parsed.data);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }
        // move_document
        const parsed = MoveDocumentArgs.safeParse(args);
        if (!parsed.success) return errorResult(parsed.error.message);
        const result = await moveDocument(vault, parsed.data);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorResult((err as Error).message);
      }
    }

    return errorResult(`unknown tool: ${name}`);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[bastra-recall] MCP server ready on stdio`);

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    console.error("[bastra-recall] shutting down");
    search.stop();
    await vault.stop();
    await httpHandle.close();
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  // Idle watchdog — terminate after `idleShutdownMs` without activity.
  // `.unref()` so the timer itself never keeps the process alive.
  if (idleShutdownMs > 0) {
    const tick = Math.min(idleShutdownMs, 60_000);
    const idleTimer = setInterval(() => {
      if (Date.now() - lastActivityMs >= idleShutdownMs) {
        console.error(
          `[bastra-recall] idle for ${Math.round(idleShutdownMs / 60000)}min — self-terminating (respawns on next recall)`,
        );
        void shutdown();
      }
    }, tick);
    idleTimer.unref();
  }
}

function errorResult(msg: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: msg }],
  };
}

/**
 * Wählt den Embedding-Provider basierend auf BASTRA_EMBEDDING_PROVIDER:
 *   ollama  → lokale Ollama-Instanz (BASTRA_OLLAMA_URL, BASTRA_EMBEDDING_MODEL)
 *   openai  → OpenAI Cloud (OPENAI_API_KEY oder BASTRA_EMBEDDING_KEY)
 *   none/—  → Embeddings disabled (Recall fällt auf reines BM25 zurück)
 * Backwards-compat: wenn Provider nicht gesetzt aber API-Key da → openai.
 */
function pickEmbeddingProvider(): EmbeddingProvider | null {
  const requested = (process.env.BASTRA_EMBEDDING_PROVIDER ?? "").toLowerCase();
  const apiKey = process.env.OPENAI_API_KEY ?? process.env.BASTRA_EMBEDDING_KEY;

  if (requested === "none") {
    console.error("[bastra-recall] embeddings disabled (provider=none)");
    return null;
  }
  if (requested === "ollama") {
    const baseURL = process.env.BASTRA_OLLAMA_URL ?? "http://localhost:11434";
    const model = process.env.BASTRA_EMBEDDING_MODEL ?? "embeddinggemma";
    const dimEnv = process.env.BASTRA_EMBEDDING_DIM;
    const dim = dimEnv ? Number.parseInt(dimEnv, 10) : undefined;
    return new OllamaEmbeddingProvider({ baseURL, model, dim });
  }
  if (requested === "openai") {
    if (!apiKey) {
      console.error(
        "[bastra-recall] embeddings disabled (provider=openai but no API key)",
      );
      return null;
    }
    return new OpenAIEmbeddingProvider({ apiKey });
  }
  if (apiKey) {
    return new OpenAIEmbeddingProvider({ apiKey });
  }
  console.error(
    "[bastra-recall] embeddings disabled (no BASTRA_EMBEDDING_PROVIDER, no API key)",
  );
  return null;
}

main().catch((err) => {
  console.error("[bastra-recall] FATAL:", err);
  process.exit(1);
});
