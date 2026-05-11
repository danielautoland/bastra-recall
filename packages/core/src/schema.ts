import { z } from "zod";

/**
 * YAML 1.1 parses bare `2026-05-01` as a JS Date.
 * Coerce back to the YYYY-MM-DD string we actually want.
 */
const dateString = z.preprocess((v) => {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return v;
}, z.string());

export const MemoryTypeEnum = z.enum([
  "lesson",
  "preference",
  "project-fact",
  "meta-working",
  "decision",
  "workflow",
  "reference",
  "user-preference",
  "bookmark",
  "doc",
]);
export type MemoryType = z.infer<typeof MemoryTypeEnum>;

const MEMORY_TYPES: ReadonlySet<string> = new Set(MemoryTypeEnum.options);

/**
 * Thrown when a markdown file has no `type:` frontmatter that we recognize
 * as a memory marker. Callers silently ignore these — they're plain Obsidian
 * notes living next to memorys, not parse errors.
 */
export class NotAMemoryFile extends Error {
  constructor(public readonly filePath: string) {
    super(`not a memory file: ${filePath}`);
    this.name = "NotAMemoryFile";
  }
}

export const FrontmatterSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  type: MemoryTypeEnum,
  summary: z.string().min(1).max(400),
  topic_path: z.array(z.string()).min(1),
  tags: z.array(z.string()).min(1),
  scope: z.string().min(1),
  recall_when: z.array(z.string()).min(1),
  related: z.array(z.string()).default([]),
  /**
   * Memory-Graph (#30 / #49): LLM-erkannte Beziehungen zu anderen Memories.
   * `id` ist die Ziel-Memory, `reason` ein kurzer Satz warum sie verbunden
   * sind, `score` ist die LLM-Confidence (0..1). Wird vom Auto-Related-
   * Detection-Background-Service in der Mac-App gefüllt, vom Multi-Hop-
   * Recall in `search.recall(expand_hops:)` gelesen.
   */
  related_via: z
    .array(
      z.object({
        id: z.string().min(1),
        reason: z.string().min(1),
        score: z.number().min(0).max(1),
      }),
    )
    .default([]),
  /**
   * Sensitivity-Level (#58): steuert, welche Surfaces das Memory sehen.
   * - `private`: nur Mac-App, NICHT für externe MCP-Clients.
   * - `team` (default): lokale KI-Tools (Claude Code, Cursor) dürfen es sehen.
   * - `public`: auch via Cross-Surface-Endpoints sichtbar.
   * Daemon filtert in recall/find_document/load_memory/list_memorys auf
   * `min_sensitivity` (default `team` für externe Caller, Mac-App ruft mit
   * `private` als Override).
   */
  sensitivity: z.enum(["private", "team", "public"]).default("team"),
  source: z.string().optional(),
  confidence: z.number().min(0).max(1).default(1.0),
  created: dateString,
  updated: dateString,
  // Optional augmentation fields (see docs/memory-schema.md)
  affects_files: z.array(z.string()).default([]),
  status: z.string().optional(),
  issues: z.array(z.string()).default([]),
  obsolete: z.boolean().optional(),
  replaces: z.string().optional(),
  superseded_by: z.string().optional(),
  // Bookmark-only fields (only present when type === "bookmark")
  url: z.string().optional(),
  categories: z.array(z.string()).default([]),
  read_status: z.enum(["unread", "read", "archived"]).optional(),
  og_image: z.string().optional(),
  saved_at: z.string().optional(),
  source_app: z.string().optional(),
  // Document-only fields (only present when type === "doc"). Sidecar trägt
  // diese, damit find_document/read_document das Original-File wiederfinden,
  // auch wenn es außerhalb des Vaults liegt (linked_file === true).
  original_path: z.string().optional(),
  linked_file: z.boolean().optional(),
  document_category: z.string().optional(),
  folder_path: z.string().optional(),
  // Auto-Inbox: Files vom Inbox-Watcher werden ohne User-Sheet eingelesen
  // und als "ungeprüft" markiert. Mac-App rendert Pill + Tint, bietet
  // Bulk-Review-Sheet bei ≥2 needs_review im aktuellen Folder.
  needs_review: z.boolean().optional(),
  // Auto-Inbox: KI-Vorschlag für den Zielordner. Wird beim Auto-Commit
  // gespeichert, während das File physisch in Inbox/ landet. Review-Sheet
  // zeigt's und verwendet es als Default beim Folder-Picker.
  ai_suggested_folder: z.string().optional(),
  // Geo-Koordinaten + Reverse-Geocoding-Resultat. Mac-App schreibt EXIF-GPS
  // (Bilder) oder NSDataDetector-Adresse (Verträge/Rechnungen) hier rein,
  // Map-View rendert die Pins. Optional — Default für Docs ohne Location.
  location: z
    .object({
      lat: z.number(),
      lon: z.number(),
      place: z.string().optional(),
      source: z.enum(["exif", "ocr", "manual"]).optional(),
    })
    .optional(),
});
export type Frontmatter = z.infer<typeof FrontmatterSchema>;

export interface Memory {
  fm: Frontmatter;
  body: string;
  filePath: string;
  mtime: number;
}

/**
 * Parse a markdown file with YAML frontmatter into a Memory.
 * Throws if the frontmatter is missing or invalid.
 */
export function parseMemory(
  raw: string,
  filePath: string,
  mtime: number,
): Memory {
  // gray-matter is dynamically imported by the caller to keep this module pure-ish
  throw new Error("Use parseMemoryWith(matter, raw, filePath, mtime) instead");
}

/**
 * The actual parse entry point — takes the gray-matter function as injection
 * so this module stays trivially testable without IO.
 */
export function parseMemoryWith(
  matter: (input: string) => { data: unknown; content: string },
  raw: string,
  filePath: string,
  mtime: number,
): Memory {
  const { data, content } = matter(raw);
  // Pre-check: if there's no recognizable memory `type:` field, throw a
  // NotAMemoryFile so the caller can silently skip it. Lets the vault scan
  // recursively through an Obsidian vault and only pick up memorys.
  if (
    !data ||
    typeof data !== "object" ||
    !("type" in data) ||
    !MEMORY_TYPES.has(String((data as Record<string, unknown>).type))
  ) {
    throw new NotAMemoryFile(filePath);
  }
  const parsed = FrontmatterSchema.safeParse(data);
  if (!parsed.success) {
    const where = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`invalid frontmatter in ${filePath}: ${where}`);
  }
  return { fm: parsed.data, body: content, filePath, mtime };
}
