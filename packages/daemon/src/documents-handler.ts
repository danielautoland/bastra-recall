/**
 * Document-Hub MCP-Tool-Handler. Read-only — Phase 2.1 lebt komplett hier in
 * bastra-recall (OSS, MIT) und ist für jeden MCP-fähigen Coding-Agent ohne
 * Pro-Lizenz nutzbar (Triage-Repo-Split aus Issue #24).
 *
 * Schreib-Tools (`save_document`/`recategorize`/`move_document`) leben in
 * bastra-pro hinter Lizenz-Gate.
 */
import { spawn } from "node:child_process";
import { z } from "zod";
import type { Vault, SearchIndex } from "@bastra-recall/core";

// ─── Argument schemas ───────────────────────────────────────────

export const FindDocumentArgs = z.object({
  query: z.string().min(1),
  // Triage: Top-3 default, Token-Budget. Hardcap 5.
  k: z.number().int().min(1).max(5).optional(),
});

export const ReadDocumentArgs = z.object({
  id: z.string().min(1),
});

export const OpenDocumentArgs = z.object({
  id: z.string().min(1),
});

// ─── Tool definitions for ListTools response ─────────────────────

export const documentTools = [
  {
    name: "find_document",
    description:
      "Search the user's document vault (PDFs, notes, contracts, code) " +
      "and return top-3 hits with id, title, summary and score. " +
      "Pair with read_document to load full content.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Natural-language description of the document, e.g. " +
            "'OAuth flow architecture notes', 'Vertrag Muster Q3 2025'.",
        },
        k: {
          type: "number",
          description: "Max hits (1–5, default 3).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "read_document",
    description:
      "Load a document's metadata + extracted text by id (returned from " +
      "find_document). Use this before quoting or summarizing.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Document id (slug, no .md extension).",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "open_document",
    description:
      "Open a document in the system's default handler (macOS only). " +
      "Use only when the user explicitly says 'open', 'show me' or similar.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Document id (slug, no .md extension).",
        },
      },
      required: ["id"],
    },
  },
];

// ─── Handler implementations ─────────────────────────────────────

/**
 * Filtert Recall-Hits auf type=doc und liefert die Top-k. SearchIndex
 * versteht den `type`-Filter bereits — wir delegieren komplett dahin.
 * Sensitivity (#58) wird über `allowPrivate` propagiert: externe MCP-Caller
 * sehen nur `team`+`public` Documents, die Mac-App ruft mit `true`.
 */
export function findDocument(
  search: SearchIndex,
  args: { query: string; k?: number },
  opts: { allowPrivate?: boolean } = {},
): { query: string; hits: Array<unknown> } {
  const k = args.k ?? 3;
  const hits = search.recall(args.query, {
    k,
    type: "doc",
    allow_private: opts.allowPrivate ?? false,
  });
  return { query: args.query, hits };
}

/**
 * Liefert das volle Sidecar inklusive Document-spezifischer Felder
 * (`original_path`, `document_category`, `folder_path`, `linked_file`).
 * `allowPrivate=false` (default) blendet `sensitivity: private` Documents
 * aus — verhindert Bypass des Sensitivity-Filters per direkter ID.
 */
export function readDocument(
  vault: Vault,
  args: { id: string },
  opts: { allowPrivate?: boolean } = {},
):
  | {
      id: string;
      title: string;
      summary: string;
      tags: string[];
      folder_path: string | null;
      document_category: string | null;
      original_path: string | null;
      linked_file: boolean;
      file_path: string;
      body: string;
    }
  | null {
  const m = vault.get(args.id);
  if (!m || m.fm.type !== "doc") return null;
  if (
    !opts.allowPrivate &&
    (m.fm as { sensitivity?: string }).sensitivity === "private"
  ) {
    return null;
  }
  const fm = m.fm as typeof m.fm & {
    original_path?: string;
    linked_file?: boolean;
    document_category?: string;
    folder_path?: string;
  };
  return {
    id: fm.id,
    title: fm.title,
    summary: fm.summary,
    tags: fm.tags,
    folder_path: fm.folder_path ?? null,
    document_category: fm.document_category ?? null,
    original_path: fm.original_path ?? null,
    linked_file: fm.linked_file ?? false,
    file_path: m.filePath,
    body: m.body,
  };
}

/**
 * Öffnet das Originalfile im System-Default-Handler. macOS-only — auf
 * anderen Plattformen liefern wir den Pfad zurück, ohne ihn zu starten.
 */
export function openDocument(
  vault: Vault,
  args: { id: string },
  opts: { allowPrivate?: boolean } = {},
):
  | { ok: true; path: string }
  | { ok: false; path?: string; message: string } {
  const m = vault.get(args.id);
  if (!m || m.fm.type !== "doc") {
    return { ok: false, message: `document not found: ${args.id}` };
  }
  if (
    !opts.allowPrivate &&
    (m.fm as { sensitivity?: string }).sensitivity === "private"
  ) {
    return { ok: false, message: `document not found: ${args.id}` };
  }
  const fm = m.fm as typeof m.fm & { original_path?: string };
  const path = fm.original_path ?? m.filePath;
  if (process.platform !== "darwin") {
    return {
      ok: false,
      path,
      message: "open_document is only supported on macOS — returning path.",
    };
  }
  try {
    const child = spawn("open", [path], { detached: true, stdio: "ignore" });
    child.unref();
    return { ok: true, path };
  } catch (err) {
    return {
      ok: false,
      path,
      message: `failed to open: ${(err as Error).message}`,
    };
  }
}
