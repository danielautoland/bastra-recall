#!/usr/bin/env node
/**
 * nexus-recall daemon — MCP server over a markdown memory vault.
 *
 * Tools exposed:
 *   recall(query, k?, scope?, type?)  → top-k matches
 *   load_memory(id)                   → full memory content (frontmatter + body)
 *
 * Configuration (env):
 *   NEXUS_VAULT_PATH  — required. Absolute path to the vault directory
 *                       (e.g. /Users/n0mad/Daniel/memorys).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { Vault, SearchIndex, saveMemory, SaveMemoryInput } from "@nexus-recall/core";
import { Telemetry, fireAndForget } from "./telemetry.js";
import { startHttpServer } from "./http.js";
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

// Triage Issue #24: Write-Tools sind Pro-Feature. Aktuelles Gate ist ein
// env-Flag — wenn ein Pro-License-Service kommt, ersetzt der das hier.
const DOCUMENT_WRITE_ENABLED = process.env.NEXUS_DOCUMENT_WRITE === "1";

const DAEMON_VERSION = "0.1.0";
const DEFAULT_HTTP_PORT = 6723;

const VAULT_PATH = process.env.NEXUS_VAULT_PATH;
if (!VAULT_PATH) {
  console.error(
    "[nexus-recall] FATAL: NEXUS_VAULT_PATH is not set. " +
      "Point it at the directory holding your memory .md files.",
  );
  process.exit(2);
}

const RecallArgs = z.object({
  query: z.string().min(1),
  k: z.number().int().min(1).max(20).optional(),
  scope: z.string().optional(),
  type: z.string().optional(),
});

const LoadMemoryArgs = z.object({
  id: z.string().min(1),
});

async function main(): Promise<void> {
  const vault = new Vault(VAULT_PATH!);
  const { loaded, skipped } = await vault.init();
  console.error(
    `[nexus-recall] vault loaded: ${loaded} memorys` +
      (skipped.length ? `, ${skipped.length} skipped` : ""),
  );
  for (const s of skipped) {
    console.error(`[nexus-recall]   skipped ${s.path}: ${s.err}`);
  }
  vault.startWatching();

  const search = new SearchIndex(vault);
  search.start();

  const telemetry = new Telemetry();
  if (telemetry.isEnabled()) {
    console.error(`[nexus-recall] telemetry: enabled (NEXUS_LOG_PATH=${process.env.NEXUS_LOG_PATH ?? "~/.nexus-recall/logs"})`);
  } else {
    console.error(`[nexus-recall] telemetry: disabled`);
  }

  const httpPort = parseInt(process.env.NEXUS_HTTP_PORT ?? String(DEFAULT_HTTP_PORT), 10);
  const httpHandle =
    process.env.NEXUS_HTTP === "off"
      ? { port: null, close: async () => undefined }
      : await startHttpServer({
          port: Number.isFinite(httpPort) ? httpPort : DEFAULT_HTTP_PORT,
          vault,
          search,
          telemetry,
          version: DAEMON_VERSION,
        });

  const server = new Server(
    { name: "nexus-recall", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: "recall",
        description:
          "Search the memory vault. Returns top-k matching memorys " +
          "(id, title, type, scope, summary, score). " +
          "\n\n" +
          "WHEN TO CALL (recall is part of acting, not a separate step):\n" +
          "- At session start (once): query for active-project + " +
          "user-preferences to load durable context.\n" +
          "- Before writing/editing a file: query with a description of " +
          "what you are about to write (e.g. 'creating React input with " +
          "focus styles'). This catches lessons before mistakes.\n" +
          "- Before giving a multi-step plan or recommendation: query for " +
          "preferences that shape format/scope.\n" +
          "- When the user's prompt touches a topic that may have a stored " +
          "lesson, decision, preference, or project-fact.\n" +
          "- Before save_memory: query to avoid creating a duplicate.\n" +
          "\n" +
          "WHAT TO DO WITH HITS:\n" +
          "- score >= ~100 with title/recall_when match: load_memory and " +
          "apply the lesson before acting.\n" +
          "- score 30-100: read the summary, load if directly relevant.\n" +
          "- score < 30: usually noise; skip unless the summary is a " +
          "perfect topic match.\n" +
          "Never ignore a `lesson` hit with strong recall_when match.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "Natural-language query OR a description of what you are " +
                "about to do (e.g. 'creating new input component', " +
                "'about to give a multi-option plan').",
            },
            k: {
              type: "number",
              description: "Max results (default 5, range 1-20).",
            },
            scope: {
              type: "string",
              description:
                "Optional exact-match filter, e.g. 'carnexus', " +
                "'user-preference', 'all-projects'.",
            },
            type: {
              type: "string",
              description:
                "Optional exact-match filter on memory type, e.g. 'lesson', " +
                "'preference', 'project-fact'.",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "load_memory",
        description:
          "Load the full content (frontmatter + body) of a single memory " +
          "by id. Use this after recall() returns a hint with a high score, " +
          "to read the full lesson before acting.",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Memory id (the slug, no .md extension).",
            },
          },
          required: ["id"],
        },
      },
      {
        name: "save_memory",
        description:
          "Persist a new memory into the vault as a markdown file with YAML " +
          "frontmatter. This is YOUR long-term memory — save autonomously " +
          "when a memory-worthy moment occurs, do not wait to be asked.\n" +
          "\n" +
          "STRONG SIGNALS — save without confirmation, then 1-line ack:\n" +
          "- User expresses repetition/frustration about a recurring issue " +
          "  ('wieder', 'schon wieder', 'wie oft', emphatic caps) → lesson\n" +
          "- User states an explicit durable rule ('immer X', 'nie Y', 'bei " +
          "  diesem Projekt nutzen wir Z') → preference / workflow\n" +
          "- User corrects a recurring tendency in your behavior → " +
          "  meta-working\n" +
          "- An architectural decision is finalized after weighing options " +
          "  → decision\n" +
          "- User confirms a workflow ('lass uns das immer so machen') → " +
          "  workflow\n" +
          "- A bug got fixed after >2 iterations with non-obvious root " +
          "  cause → lesson (capture the FAILED PATH too, not just the fix)\n" +
          "\n" +
          "ANTI-SIGNALS — do NOT save:\n" +
          "- One-off task descriptions ('baue mir bitte X') — that's a " +
          "  task, not a memory\n" +
          "- Speculation, 'maybe' statements, tentative ideas\n" +
          "- Anything derivable from code/git/CLAUDE.md\n" +
          "- Sensitive personal data (unless a stable preference)\n" +
          "- When unsure: default to NOT saving. False saves erode trust.\n" +
          "\n" +
          "BEFORE SAVING: call recall() with the title/topic to check for " +
          "an existing memory you should update (overwrite=true) instead " +
          "of creating a duplicate.\n" +
          "\n" +
          "QUALITY BARS:\n" +
          "- Title: short, specific, non-generic.\n" +
          "- Summary (<=400 chars): one sentence with the gist.\n" +
          "- Body: lead with the rule/fact, then **Why:** (root cause / " +
          "  reason / incident) and **How to apply:** (when this kicks in). " +
          "  For lessons, capture the failure path AND the fix.\n" +
          "- recall_when (CRITICAL — highest-weighted search field): 2-4 " +
          "  CONCRETE contexts/queries where future-you should be reminded. " +
          "  'about to write a Tailwind grid' beats 'CSS questions'. Without " +
          "  good recall_when, the memory is dead weight.\n" +
          "\n" +
          "AFTER SAVING: surface a single-line ack to the user, prefixed " +
          "with `→`: `→ saved: <title> (id: <id>)`. Nothing more.",
        inputSchema: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "Short, specific title (becomes the slug/id).",
            },
            type: {
              type: "string",
              enum: [
                "lesson",
                "preference",
                "project-fact",
                "meta-working",
                "decision",
                "workflow",
                "reference",
                "user-preference",
              ],
              description:
                "Memory type. Use 'lesson' for fixes/gotchas, 'preference' " +
                "for project-scoped style choices, 'user-preference' for " +
                "the human's cross-project preferences, 'project-fact' for " +
                "non-derivable project state, 'decision' for committed " +
                "design decisions, 'workflow' for recurring procedures.",
            },
            summary: {
              type: "string",
              description:
                "One sentence (<=400 chars) capturing the gist — appears in " +
                "recall() hits.",
            },
            body: {
              type: "string",
              description:
                "Full markdown body. Lead with the rule/fact, then explain " +
                "*why* (the reason/incident) and *how to apply* (when this " +
                "kicks in). Wikilinks like [[other-memory-id]] are supported.",
            },
            topic_path: {
              type: "array",
              items: { type: "string" },
              description:
                "Hierarchical topic path, e.g. ['nexus-recall','search','ranking'].",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Flat tags for filtering, at least one.",
            },
            scope: {
              type: "string",
              description:
                "Project/area this memory belongs to, e.g. 'nexus-recall', " +
                "'carnexus', 'user-preference', 'all-projects'.",
            },
            recall_when: {
              type: "array",
              items: { type: "string" },
              description:
                "Trigger phrases — situations where this memory should " +
                "surface. Highest-weighted search field. Be specific: " +
                "'about to write a Tailwind grid', not 'CSS questions'.",
            },
            related: {
              type: "array",
              items: { type: "string" },
              description:
                "Optional ids of related memories (for [[wikilink]] context).",
            },
            source: {
              type: "string",
              description:
                "Optional provenance, e.g. 'Daniel, 2026-05-01 after retro'.",
            },
            confidence: {
              type: "number",
              description:
                "0-1, default 1. Lower if the lesson is tentative.",
            },
            id: {
              type: "string",
              description:
                "Optional explicit id/slug. Default: slugified title.",
            },
            overwrite: {
              type: "boolean",
              description:
                "If true, replace an existing memory with the same id. " +
                "Default false (errors on collision).",
            },
          },
          required: [
            "title",
            "type",
            "summary",
            "body",
            "topic_path",
            "tags",
            "scope",
            "recall_when",
          ],
        },
      },
      ...documentTools,
      ...(DOCUMENT_WRITE_ENABLED ? documentWriteTools : []),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;

    if (name === "recall") {
      const parsed = RecallArgs.safeParse(args);
      if (!parsed.success) return errorResult(parsed.error.message);
      const t0 = Date.now();
      const hits = search.recall(parsed.data.query, {
        k: parsed.data.k,
        scope: parsed.data.scope,
        type: parsed.data.type,
      });
      const latencyMs = Date.now() - t0;
      const recallId = telemetry.newRecallId();
      fireAndForget(
        telemetry.logRecall({
          recall_id: recallId,
          query: parsed.data.query,
          k: parsed.data.k ?? null,
          scope: parsed.data.scope ?? null,
          type: parsed.data.type ?? null,
          vault_size: vault.size(),
          hit_count: hits.length,
          top_score: hits[0]?.score ?? null,
          hits: hits.map((h) => ({ id: h.id, score: h.score, type: h.type })),
          latency_ms: latencyMs,
        }),
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                query: parsed.data.query,
                vault_size: vault.size(),
                hits,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (name === "load_memory") {
      const parsed = LoadMemoryArgs.safeParse(args);
      if (!parsed.success) return errorResult(parsed.error.message);
      const m = search.loadFull(parsed.data.id);
      const hookHint = telemetry.findHookHintFor(parsed.data.id);
      fireAndForget(
        telemetry.logLoadMemory({
          id: parsed.data.id,
          found: !!m,
          follows_recall: telemetry.recentRecallId(),
          from_hook_recall: hookHint?.recall_id ?? null,
          hook_hint_rank: hookHint?.rank ?? null,
        }),
      );
      if (!m) return errorResult(`memory not found: ${parsed.data.id}`);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                id: m.fm.id,
                frontmatter: m.fm,
                body: m.body,
                file_path: m.filePath,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (name === "save_memory") {
      const parsed = SaveMemoryInput.safeParse(args);
      if (!parsed.success) return errorResult(parsed.error.message);
      try {
        const result = await saveMemory(VAULT_PATH!, parsed.data);
        // Don't trust the watcher on cloud-storage mounts — force-index now
        // so a follow-up recall() in the same session sees the new memory.
        await vault.reindexFile(result.file_path);
        fireAndForget(
          telemetry.logSaveMemory({
            id: result.id,
            type: parsed.data.type,
            scope: parsed.data.scope,
            title: parsed.data.title,
            tag_count: parsed.data.tags.length,
            recall_when_count: parsed.data.recall_when.length,
            body_chars: parsed.data.body.length,
            overwrite: parsed.data.overwrite ?? false,
            created: result.created,
            follows_recall: telemetry.recentRecallId(),
          }),
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
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
          `${name} is a Pro feature — set NEXUS_DOCUMENT_WRITE=1 to enable.`,
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
  console.error(`[nexus-recall] MCP server ready on stdio`);

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    console.error("[nexus-recall] shutting down");
    search.stop();
    await vault.stop();
    await httpHandle.close();
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

function errorResult(msg: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: msg }],
  };
}

main().catch((err) => {
  console.error("[nexus-recall] FATAL:", err);
  process.exit(1);
});
