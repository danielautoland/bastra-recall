import { writeFile, access, mkdir, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { z } from "zod";
import matter from "gray-matter";
import { MemoryTypeEnum } from "./schema.js";

/**
 * Input contract for save_memory.
 * Mirrors FrontmatterSchema but only the fields a caller should set —
 * id, created, updated are auto-derived; obsolete/replaces/superseded_by
 * are written by separate flows, not by save.
 */
export const SaveMemoryInput = z.object({
  title: z.string().min(1),
  type: MemoryTypeEnum,
  summary: z.string().min(1).max(400),
  body: z.string().min(1),
  topic_path: z.array(z.string().min(1)).min(1),
  tags: z.array(z.string().min(1)).min(1),
  scope: z.string().min(1),
  recall_when: z.array(z.string().min(1)).min(1),
  related: z.array(z.string()).optional(),
  /**
   * Memory-Graph (#30 / #49): LLM-detektierte Beziehungen. Optional —
   * normalerweise nicht beim manuellen save_memory gesetzt, sondern vom
   * Auto-Related-Detection-Background-Service via reindex_file persistiert.
   */
  related_via: z
    .array(
      z.object({
        id: z.string().min(1),
        reason: z.string().min(1),
        score: z.number().min(0).max(1),
      }),
    )
    .optional(),
  /**
   * Sensitivity-Level (#58). Optional, default „team" wenn nicht gesetzt.
   * Mac-App-UI macht den Per-Memory-Picker; Auto-Captures (Inbox-Watcher,
   * Share-Sheet) erben den Default.
   */
  sensitivity: z.enum(["private", "team", "public"]).optional(),
  /**
   * Memory-Lifecycle (#74): optionale Ablauf-/Review-Felder. `stale_status`
   * wird vom Vault-Loader computet, ist hier aber akzeptiert damit die
   * Mac-App es explizit setzen kann (z.B. manuelles „obsolete").
   */
  valid_until: z.string().optional(),
  expires_after_days: z.number().int().positive().optional(),
  last_reviewed_at: z.string().optional(),
  stale_status: z.enum(["fresh", "aging", "stale", "expired"]).optional(),
  /**
   * Duplicate-Detection (#70): SHA-256-Hash + Größe der Original-Datei.
   * Nur bei `type: doc` Memories sinnvoll. Mac-App-DocumentsImporter
   * berechnet beide beim ersten Import.
   */
  content_hash: z.string().optional(),
  content_size: z.number().int().nonnegative().optional(),
  source: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  affects_files: z.array(z.string()).optional(),
  issues: z.array(z.string()).optional(),
  id: z.string().optional(),
  overwrite: z.boolean().optional(),
  // Bookmark-only fields
  url: z.string().optional(),
  categories: z.array(z.string()).optional(),
  read_status: z.enum(["unread", "read", "archived"]).optional(),
  og_image: z.string().optional(),
  saved_at: z.string().optional(),
  source_app: z.string().optional(),
});
export type SaveMemoryInput = z.infer<typeof SaveMemoryInput>;

export interface SaveMemoryResult {
  id: string;
  file_path: string;
  created: boolean;
}

const SLUG_MAX_LEN = 80;

export function slugify(input: string): string {
  const lower = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "");
  const slug = lower
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

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Subfolder routing inside the vault.
 *
 * Top-level layout (three siblings):
 *   memories/         lessons, decisions, preferences, project-facts,
 *                     workflows — anything the agent learned and wants
 *                     to recall later.
 *     ├── user/             scope = "user-preference"
 *     ├── all-projects/     scope = "all-projects"
 *     └── projects/<scope>/ everything else
 *
 *   bookmarks/        type = "bookmark" — saved URLs with url/og_image.
 *                     Kept as a sibling because bookmarks aren't really
 *                     "memories" and carry their own metadata shape.
 *
 *   dokumentationen/  type = "doc" — living per-project documentation
 *                     ("software wiki"). Routed to dokumentationen/<scope>/
 *                     so each project owns its docs.
 *
 * The vault scans recursively, so older flat `memorys/` files continue to
 * work until they are migrated.
 */
function subfolderFor(scope: string, type: string): string {
  if (type === "bookmark") return "bookmarks";
  if (type === "doc") return `dokumentationen/${scope}`;
  if (scope === "user-preference") return "memories/user";
  if (scope === "all-projects") return "memories/all-projects";
  return `memories/projects/${scope}`;
}

/**
 * Build the .md content for a new memory and write it into the vault.
 * The vault watcher will pick it up and index it automatically.
 */
export async function saveMemory(
  vaultRoot: string,
  input: SaveMemoryInput,
): Promise<SaveMemoryResult> {
  const id = input.id ?? slugify(input.title);
  const subdir = subfolderFor(input.scope, input.type);
  const dir = join(vaultRoot, subdir);
  const filePath = join(dir, `${id}.md`);
  const exists = await fileExists(filePath);
  if (exists && !input.overwrite) {
    throw new Error(
      `memory already exists: ${id}. Pass overwrite=true to replace it, ` +
        `or pick a different title/id.`,
    );
  }

  const today = todayISO();
  const fm: Record<string, unknown> = {
    id,
    title: input.title,
    type: input.type,
    summary: input.summary,
    topic_path: input.topic_path,
    tags: input.tags,
    scope: input.scope,
    recall_when: input.recall_when,
    related: input.related ?? [],
    related_via: input.related_via ?? [],
    sensitivity: input.sensitivity ?? "team",
    ...(input.valid_until ? { valid_until: input.valid_until } : {}),
    ...(input.expires_after_days ? { expires_after_days: input.expires_after_days } : {}),
    ...(input.last_reviewed_at ? { last_reviewed_at: input.last_reviewed_at } : {}),
    ...(input.stale_status ? { stale_status: input.stale_status } : {}),
    ...(input.content_hash ? { content_hash: input.content_hash } : {}),
    ...(input.content_size != null ? { content_size: input.content_size } : {}),
    ...(input.source ? { source: input.source } : {}),
    confidence: input.confidence ?? 1,
    created: today,
    updated: today,
    affects_files: input.affects_files ?? [],
    issues: input.issues ?? [],
  };

  // Bookmark-specific fields, only set when type === "bookmark" so memory
  // files don't get bookmark-shaped frontmatter pollution.
  if (input.type === "bookmark") {
    if (input.url) fm.url = input.url;
    if (input.categories) fm.categories = input.categories;
    if (input.read_status) fm.read_status = input.read_status;
    if (input.og_image) fm.og_image = input.og_image;
    if (input.source_app) fm.source_app = input.source_app;
    fm.saved_at = input.saved_at ?? new Date().toISOString();
  }

  const body = input.body.startsWith("\n") ? input.body : `\n${input.body}`;
  const content = matter.stringify(body, fm);

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  return { id, file_path: filePath, created: !exists };
}

export interface DeleteMemoryResult {
  id: string;
  file_path: string;
  deleted: boolean;
}

/**
 * Remove a memory file from disk by its absolute path. Caller resolves
 * the path through the vault index (so we don't have to guess where the
 * file lives — it could sit in any subfolder).
 */
export async function deleteMemoryFile(filePath: string, id: string): Promise<DeleteMemoryResult> {
  if (!(await fileExists(filePath))) {
    throw new Error(`memory file not found: ${filePath}`);
  }
  await unlink(filePath);
  return { id, file_path: filePath, deleted: true };
}
