/**
 * Document-Hub WRITE Tools — `save_document`/`recategorize_document`/
 * `move_document`. Triage Issue #24:
 *
 * - Pro-Feature: Triage will diese hinter Lizenz-Gate. Bis das Pro-License-
 *   Service da ist (separates Issue), gaten wir mit env-Flag
 *   `BASTRA_DOCUMENT_WRITE=1` (Legacy: `NEXUS_DOCUMENT_WRITE`). Tool-Liste
 *   wird komplett ausgeblendet wenn das Flag fehlt — externe MCP-Caller
 *   sehen nur Read-Tools.
 *
 * - Cloud-Watcher-Mitigation: Schreib-Pfad reagiert NICHT auf chokidar
 *   (unzuverlässig auf GoogleDrive/iCloud). Stattdessen sofortiger
 *   `vault.reindexFile(sidecarPath)` nach jedem Write — analog zum
 *   `save_memory`-Pattern. Damit ist `save+find im selben Turn` zuverlässig.
 *   Triage-Acceptance: erfüllt.
 */
import { writeFile, mkdir, copyFile, unlink, stat, rename, access } from "node:fs/promises";
import { join, basename, isAbsolute } from "node:path";
import { z } from "zod";
import matter from "gray-matter";
import type { Vault } from "@bastra-recall/core";
import { truncateSummaryTo, SUMMARY_MAX } from "@bastra-recall/core";

// ─── Argument schemas ───────────────────────────────────────────

const documentCategoryEnum = z.enum([
  "vertrag",
  "rechnung",
  "notiz",
  "code",
  "bild",
  "sonstiges",
]);

export const SaveDocumentArgs = z.object({
  /** Absoluter Pfad der Original-Datei (z.B. ~/Downloads/Vertrag.pdf). */
  original_path: z.string().min(1),
  /** Folder relativ zu `<vault>/documents/`. Leer-String = Root. */
  folder_path: z.string().default(""),
  title: z.string().min(1),
  tags: z.array(z.string().min(1)).min(1),
  category: documentCategoryEnum,
  /**
   * Wenn true bleibt die Originaldatei am Quellort, das Sidecar trägt nur
   * den Verweis. Default false: Datei wird in `<vault>/documents/<folder>`
   * kopiert.
   */
  linked_file: z.boolean().default(false),
  /** Optional: extrahierter Plain-Text-Body des Sidecars. */
  body: z.string().optional(),
  /**
   * Optional: 1-Satz-Summary. Default = title-based.
   * Kein `.max` hier (analog `save_memory`): eine über-lange Summary wird
   * beim Build codepoint-sicher an der Wortgrenze geclampt, nie rejected —
   * ein `too_big`-Error würde den Caller in einen Retry-Roundtrip zwingen.
   */
  summary: z.string().optional(),
  /** Optional: zusätzliche Recall-Trigger. Default = title + tags. */
  recall_when: z.array(z.string()).optional(),
  /** Default false: existierender Document-Eintrag wirft Fehler. */
  overwrite: z.boolean().default(false),
});

export const RecategorizeDocumentArgs = z.object({
  id: z.string().min(1),
  /** Neuer Folder-Pfad. Wenn gesetzt, wird `move_document`-Logik mitgemacht. */
  folder_path: z.string().optional(),
  title: z.string().optional(),
  tags: z.array(z.string()).optional(),
  category: documentCategoryEnum.optional(),
  /**
   * Phase 3.2: wenn das Sidecar extern editiert wurde, blockiert der Daemon
   * den Update. `force=true` überschreibt das Veto explizit.
   */
  force: z.boolean().optional(),
});

export const MoveDocumentArgs = z.object({
  id: z.string().min(1),
  folder_path: z.string().min(1),
});

// ─── Tool definitions ───────────────────────────────────────────

export const documentWriteTools = [
  {
    name: "save_document",
    description:
      "Persist a new document into the user's vault: copy (or link) the " +
      "original file and write a sidecar with frontmatter for retrieval. " +
      "Pair with find_document/read_document afterwards.",
    inputSchema: {
      type: "object",
      properties: {
        original_path: {
          type: "string",
          description: "Absolute path to the source file.",
        },
        folder_path: {
          type: "string",
          description:
            "Target folder relative to documents-root (e.g. 'Verträge/2026'). Empty = root.",
        },
        title: { type: "string", description: "Concise human-readable title." },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "1–5 retrieval tags.",
        },
        category: {
          type: "string",
          enum: documentCategoryEnum.options,
          description: "Document category.",
        },
        linked_file: {
          type: "boolean",
          description: "If true, do not copy — keep original at source path.",
        },
        body: { type: "string", description: "Optional extracted plain-text." },
        summary: {
          type: "string",
          description: "Optional 1-sentence summary (<=400 chars).",
        },
        overwrite: {
          type: "boolean",
          description: "If true, replace existing document with same id.",
        },
      },
      required: ["original_path", "title", "tags", "category"],
    },
  },
  {
    name: "recategorize_document",
    description:
      "Update folder, title, tags or category of an existing document. " +
      "Refuses to overwrite externally edited sidecars unless force=true.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Document id (slug)." },
        folder_path: {
          type: "string",
          description: "New folder relative to documents-root.",
        },
        title: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        category: { type: "string", enum: documentCategoryEnum.options },
        force: {
          type: "boolean",
          description:
            "If true, override the conflict-detection veto (use when the user explicitly accepts losing the external edit).",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "move_document",
    description:
      "Move a document (original + sidecar) into a different folder. " +
      "The id stays stable; only paths and folder_path-frontmatter change.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Document id (slug)." },
        folder_path: {
          type: "string",
          description: "Target folder relative to documents-root.",
        },
      },
      required: ["id", "folder_path"],
    },
  },
];

// ─── Helpers ────────────────────────────────────────────────────

const DOCUMENTS_ROOT = "documents";
const SLUG_MAX_LEN = 80;

function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LEN);
  if (!slug) throw new Error(`cannot slugify: ${JSON.stringify(input)}`);
  return slug;
}

function makeDocId(folderPath: string, filename: string): string {
  const combined = folderPath ? `${folderPath}/${filename}` : filename;
  return `doc-${slugify(combined)}`;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function isCloudMount(path: string): boolean {
  return /(CloudStorage|Dropbox|iCloud)/i.test(path);
}

function vaultRoot(vault: Vault): string {
  return vault.root;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

interface DocumentFrontmatter {
  id: string;
  title: string;
  type: "doc";
  summary: string;
  topic_path: string[];
  tags: string[];
  scope: string;
  recall_when: string[];
  related: string[];
  confidence: number;
  created: string;
  updated: string;
  original_path: string;
  document_category: string;
  linked_file: boolean;
  folder_path: string;
}

function buildFrontmatter(args: {
  id: string;
  title: string;
  summary: string;
  tags: string[];
  category: string;
  recallWhen: string[];
  originalPath: string;
  linkedFile: boolean;
  folderPath: string;
  created: string;
  updated: string;
}): DocumentFrontmatter {
  const topicPath: string[] = ["documents"];
  if (args.folderPath) {
    topicPath.push(...args.folderPath.split("/").filter(Boolean));
  } else {
    topicPath.push(args.category);
  }
  return {
    id: args.id,
    title: args.title,
    type: "doc",
    summary: args.summary,
    topic_path: topicPath,
    tags: args.tags,
    scope: "documents",
    recall_when: args.recallWhen,
    related: [],
    confidence: 1.0,
    created: args.created,
    updated: args.updated,
    original_path: args.originalPath,
    document_category: args.category,
    linked_file: args.linkedFile,
    folder_path: args.folderPath,
  };
}

function renderSidecar(fm: DocumentFrontmatter, body: string): string {
  return matter.stringify(body, fm as unknown as Record<string, unknown>);
}

// ─── save_document ──────────────────────────────────────────────

export interface SaveDocumentResult {
  id: string;
  sidecar_path: string;
  original_path: string;
  reindexed: boolean;
  cloud_mount_warning?: string;
}

export async function saveDocument(
  vault: Vault,
  args: z.infer<typeof SaveDocumentArgs>,
): Promise<SaveDocumentResult> {
  if (!isAbsolute(args.original_path)) {
    throw new Error(`original_path must be absolute: ${args.original_path}`);
  }
  if (!(await pathExists(args.original_path))) {
    throw new Error(`source file not found: ${args.original_path}`);
  }

  const root = vaultRoot(vault);
  const docsRoot = join(root, DOCUMENTS_ROOT);
  const folder = args.folder_path
    ? join(docsRoot, args.folder_path)
    : docsRoot;
  await mkdir(folder, { recursive: true });

  const filename = basename(args.original_path);
  const docID = makeDocId(args.folder_path ?? "", filename);

  let originalDest = args.original_path;
  if (!args.linked_file) {
    originalDest = join(folder, filename);
    if (await pathExists(originalDest)) {
      if (!args.overwrite) {
        throw new Error(`destination already exists: ${originalDest}`);
      }
      await unlink(originalDest);
    }
    await copyFile(args.original_path, originalDest);
  }

  const sidecarPath = join(folder, `${filename}.md`);
  if ((await pathExists(sidecarPath)) && !args.overwrite) {
    throw new Error(`sidecar already exists: ${sidecarPath}`);
  }

  const summary = args.summary ?? `${args.category}: ${args.title}`;
  const recallWhen = args.recall_when ?? [
    `find document ${args.title}`,
    args.tags.slice(0, 3).join(" "),
    `file ${basename(filename, "." + (filename.split(".").pop() ?? ""))}`,
  ].filter(Boolean);

  const today = todayISO();
  const fm = buildFrontmatter({
    id: docID,
    title: args.title,
    summary: truncateSummaryTo(summary, SUMMARY_MAX),
    tags: args.tags,
    category: args.category,
    recallWhen,
    originalPath: originalDest,
    linkedFile: args.linked_file,
    folderPath: args.folder_path ?? "",
    created: today,
    updated: today,
  });

  const body = args.body
    ? `> Sidecar für \`${originalDest}\`.\n\n## Extrahierter Inhalt\n\n${args.body}`
    : `> Sidecar für \`${originalDest}\`.\n\n_(Kein extrahierter Inhalt — vom Caller nicht mitgeliefert.)_`;

  await writeFile(sidecarPath, renderSidecar(fm, body), "utf8");

  // Cloud-Watcher-Mitigation: synchroner reindex statt auf chokidar warten.
  await vault.reindexFile(sidecarPath);

  const cloudWarn = isCloudMount(root)
    ? "Vault is on a cloud-storage mount (Dropbox/GoogleDrive/iCloud) — using polling watcher; reindex done synchronously."
    : undefined;

  return {
    id: docID,
    sidecar_path: sidecarPath,
    original_path: originalDest,
    reindexed: true,
    cloud_mount_warning: cloudWarn,
  };
}

// ─── recategorize_document ──────────────────────────────────────

export async function recategorizeDocument(
  vault: Vault,
  args: z.infer<typeof RecategorizeDocumentArgs> & { force?: boolean },
): Promise<{ id: string; sidecar_path: string; reindexed: boolean }> {
  const m = vault.get(args.id);
  if (!m || m.fm.type !== "doc") {
    throw new Error(`document not found: ${args.id}`);
  }
  // Phase 3.2 Conflict-Detection: wenn das Sidecar zwischen letztem
  // Vault-Read und jetzt extern editiert wurde, refusen wir den Update —
  // sonst überschreiben wir User-Edits aus Obsidian. Caller kann mit
  // `force: true` über das Veto gehen.
  if (!args.force) {
    try {
      const st = await stat(m.filePath);
      if (st.mtimeMs > m.mtime) {
        throw new Error(
          `sidecar was edited externally (mtime ${new Date(st.mtimeMs).toISOString()} > vault ${new Date(m.mtime).toISOString()}). Pass force=true to overwrite.`,
        );
      }
    } catch (err) {
      if ((err as Error).message.startsWith("sidecar was edited")) throw err;
      // stat-Fehler (File weg etc.) → durchlaufen, write-Logik wird erneut prüfen.
    }
  }
  const fm = m.fm as typeof m.fm & {
    original_path?: string;
    document_category?: string;
    folder_path?: string;
    linked_file?: boolean;
  };

  // Wenn Folder geändert: erst move (verschiebt Files + Sidecar). Sonst nur
  // Sidecar-Frontmatter aktualisieren.
  let sidecarPath = m.filePath;
  let originalPath = fm.original_path ?? m.filePath.replace(/\.md$/, "");
  let folderPath = fm.folder_path ?? "";

  if (args.folder_path !== undefined && args.folder_path !== folderPath) {
    const moved = await moveDocumentFiles(vault, {
      sidecarPath,
      originalPath,
      currentFolderPath: folderPath,
      newFolderPath: args.folder_path,
      linkedFile: fm.linked_file ?? false,
    });
    sidecarPath = moved.newSidecarPath;
    originalPath = moved.newOriginalPath;
    folderPath = args.folder_path;
  }

  const category = args.category ?? fm.document_category ?? "sonstiges";
  const updated: DocumentFrontmatter = buildFrontmatter({
    id: m.fm.id,
    title: args.title ?? m.fm.title,
    summary: m.fm.summary,
    tags: args.tags ?? m.fm.tags,
    category,
    recallWhen: m.fm.recall_when,
    originalPath,
    linkedFile: fm.linked_file ?? false,
    folderPath,
    created: m.fm.created,
    updated: todayISO(),
  });

  await writeFile(sidecarPath, renderSidecar(updated, m.body), "utf8");
  await vault.reindexFile(sidecarPath);

  return { id: m.fm.id, sidecar_path: sidecarPath, reindexed: true };
}

// ─── move_document ──────────────────────────────────────────────

export async function moveDocument(
  vault: Vault,
  args: z.infer<typeof MoveDocumentArgs>,
): Promise<{ id: string; sidecar_path: string; original_path: string; reindexed: boolean }> {
  const m = vault.get(args.id);
  if (!m || m.fm.type !== "doc") {
    throw new Error(`document not found: ${args.id}`);
  }
  const fm = m.fm as typeof m.fm & {
    original_path?: string;
    folder_path?: string;
    linked_file?: boolean;
  };

  const moved = await moveDocumentFiles(vault, {
    sidecarPath: m.filePath,
    originalPath: fm.original_path ?? m.filePath.replace(/\.md$/, ""),
    currentFolderPath: fm.folder_path ?? "",
    newFolderPath: args.folder_path,
    linkedFile: fm.linked_file ?? false,
  });

  // Frontmatter im neuen Sidecar aktualisieren.
  const updated: DocumentFrontmatter = buildFrontmatter({
    id: m.fm.id,
    title: m.fm.title,
    summary: m.fm.summary,
    tags: m.fm.tags,
    category: (fm as { document_category?: string }).document_category ?? "sonstiges",
    recallWhen: m.fm.recall_when,
    originalPath: moved.newOriginalPath,
    linkedFile: fm.linked_file ?? false,
    folderPath: args.folder_path,
    created: m.fm.created,
    updated: todayISO(),
  });
  await writeFile(moved.newSidecarPath, renderSidecar(updated, m.body), "utf8");
  await vault.reindexFile(moved.newSidecarPath);

  return {
    id: m.fm.id,
    sidecar_path: moved.newSidecarPath,
    original_path: moved.newOriginalPath,
    reindexed: true,
  };
}

async function moveDocumentFiles(
  vault: Vault,
  args: {
    sidecarPath: string;
    originalPath: string;
    currentFolderPath: string;
    newFolderPath: string;
    linkedFile: boolean;
  },
): Promise<{ newSidecarPath: string; newOriginalPath: string }> {
  const root = vaultRoot(vault);
  const docsRoot = join(root, DOCUMENTS_ROOT);
  const targetFolder = args.newFolderPath
    ? join(docsRoot, args.newFolderPath)
    : docsRoot;
  await mkdir(targetFolder, { recursive: true });

  const sidecarFilename = basename(args.sidecarPath);
  const originalFilename = basename(args.originalPath);

  const newSidecarPath = join(targetFolder, sidecarFilename);
  const newOriginalPath = args.linkedFile
    ? args.originalPath
    : join(targetFolder, originalFilename);

  if (!args.linkedFile && newOriginalPath !== args.originalPath) {
    if (await pathExists(newOriginalPath)) {
      throw new Error(`target original already exists: ${newOriginalPath}`);
    }
    await rename(args.originalPath, newOriginalPath);
  }
  if (newSidecarPath !== args.sidecarPath) {
    if (await pathExists(newSidecarPath)) {
      throw new Error(`target sidecar already exists: ${newSidecarPath}`);
    }
    await rename(args.sidecarPath, newSidecarPath);
  }

  return { newSidecarPath, newOriginalPath };
}

// ─── Conflict-Detection (Phase 3.2 — basic mtime-Check) ─────────

/**
 * Vergleicht die mtime des Original-Files mit der Cache-mtime im Vault.
 * Wenn die Datei seit dem letzten Vault-Read jünger ist, signalisieren wir
 * einen Conflict — der Caller (UI) entscheidet ob er trotzdem überschreibt.
 */
export async function detectExternalEdit(
  vault: Vault,
  id: string,
): Promise<{ conflict: boolean; reason?: string }> {
  const m = vault.get(id);
  if (!m) return { conflict: false };
  const fm = m.fm as typeof m.fm & { original_path?: string };
  const target = fm.original_path ?? m.filePath;
  let st;
  try {
    st = await stat(target);
  } catch {
    return { conflict: false }; // File weg → kein Konflikt, nur Fehler-Pfad
  }
  if (st.mtimeMs > m.mtime) {
    return {
      conflict: true,
      reason: `file changed externally at ${new Date(st.mtimeMs).toISOString()} (vault mtime ${new Date(m.mtime).toISOString()})`,
    };
  }
  return { conflict: false };
}
