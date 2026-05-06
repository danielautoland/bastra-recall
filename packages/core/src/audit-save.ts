import { z } from "zod";
import {
  saveMemory,
  type SaveMemoryInput,
  type SaveMemoryResult,
} from "./save.js";
import {
  AuditLog,
  type AuditEntry,
  moveToTrash,
  restoreFromTrash,
  trashPathFor,
} from "./audit-log.js";
import type { Vault } from "./vault.js";
import { access, readFile } from "node:fs/promises";
import matter from "gray-matter";

/**
 * Audit-Kontext, den jeder Caller (bridge.ts, index.ts) mitgibt — beschreibt
 * WER die Mutation veranlasst hat. Wird im Audit-Log gespeichert, geht aber
 * NICHT in die Memory-Frontmatter (saubere Trennung CRUD ↔ Audit).
 */
export const AuditContext = z.object({
  actor: z.enum(["user", "assistant", "system", "import"]),
  actor_detail: z.string().optional(),
  reason: z.string().optional(),
  session_id: z.string().optional(),
});
export type AuditContext = z.infer<typeof AuditContext>;

/**
 * Save mit Audit-Trail.
 *
 *   1. Vorherige Memory-Frontmatter holen (für diff_before).
 *   2. Validation: Assistant-Mutationen brauchen `reason` (1-2 Sätze).
 *   3. saveMemory ausführen.
 *   4. AuditLog.record() mit before/after.
 */
export async function auditedSave(args: {
  vault: Vault;
  auditLog: AuditLog;
  vaultRoot: string;
  input: SaveMemoryInput;
  context: AuditContext;
}): Promise<{ result: SaveMemoryResult; audit: AuditEntry }> {
  const { vault, auditLog, vaultRoot, input, context } = args;

  if (context.actor === "assistant" && !context.reason?.trim()) {
    throw new Error(
      "assistant mutations require a `reason` (1-2 sentences explaining the change).",
    );
  }

  // Bestehenden Zustand erfassen (vor dem Schreiben), damit diff_before
  // korrekt ist. Wenn input.id gesetzt ist, lookup der existing Memory.
  const candidateID = input.id;
  const existing = candidateID ? vault.get(candidateID) : undefined;
  const diffBefore = existing ? cloneFrontmatter(existing.fm) : null;

  const result = await saveMemory(vaultRoot, input);

  // diff_after: aus dem result-Pfad lesen — Vault-Watcher hatte vielleicht
  // noch keine Zeit zum Re-Indexen.
  const diffAfter = await readFrontmatter(result.file_path);

  const audit = await auditLog.record({
    memory_id: result.id,
    actor: context.actor,
    actor_detail: context.actor_detail,
    operation: existing ? "update" : "create",
    diff_before: diffBefore,
    diff_after: diffAfter,
    file_path: result.file_path,
    reason: context.reason,
    session_id: context.session_id,
  });

  return { result, audit };
}

/**
 * Soft-Delete mit Audit-Trail.
 *
 *   1. Memory aus Vault-Cache holen (für diff_before + filePath).
 *   2. File nach <vault>/.bastra/trash/<id>.md verschieben.
 *   3. AuditLog.record() mit operation=delete.
 *
 * Hard-Delete (Forget-Tool, Block 2) hat einen eigenen Pfad und sollte den
 * Trash-Folder umgehen.
 */
export async function auditedSoftDelete(args: {
  vault: Vault;
  auditLog: AuditLog;
  vaultRoot: string;
  memoryID: string;
  context: AuditContext;
}): Promise<{ id: string; trashPath: string; audit: AuditEntry }> {
  const { vault, auditLog, vaultRoot, memoryID, context } = args;

  const memory = vault.get(memoryID);
  if (!memory) {
    throw new Error(`memory not found in vault: ${memoryID}`);
  }
  if (context.actor === "assistant" && !context.reason?.trim()) {
    throw new Error(
      "assistant deletes require a `reason` (1-2 sentences explaining the change).",
    );
  }

  const diffBefore = cloneFrontmatter(memory.fm);
  const originalPath = memory.filePath;
  const trashPath = await moveToTrash(vaultRoot, originalPath, memoryID);

  const audit = await auditLog.record({
    memory_id: memoryID,
    actor: context.actor,
    actor_detail: context.actor_detail,
    operation: "delete",
    diff_before: diffBefore,
    diff_after: null,
    file_path: originalPath, // Wohin der Restore zurückmoven soll.
    reason: context.reason,
    session_id: context.session_id,
  });

  return { id: memoryID, trashPath, audit };
}

/**
 * Restore aus dem Trash.
 *
 *   1. Letzten `delete`-Audit-Eintrag der Memory finden.
 *   2. Trash-File ermitteln.
 *   3. Original-Pfad rekonstruieren aus diff_before.
 *   4. File zurückmoven.
 *   5. Audit-Eintrag operation=restore mit diff_before=null/diff_after=alt.
 */
export async function auditedRestore(args: {
  auditLog: AuditLog;
  vaultRoot: string;
  memoryID: string;
  /** Optional: bestimmten Original-Pfad erzwingen (Power-User). */
  destFilePath?: string;
  context: AuditContext;
}): Promise<{ id: string; restoredTo: string; audit: AuditEntry }> {
  const { auditLog, vaultRoot, memoryID, destFilePath, context } = args;

  const lastDelete = await auditLog.lastDeleteFor(memoryID);
  if (!lastDelete) {
    throw new Error(`no delete audit-entry found for memory: ${memoryID}`);
  }

  const trashFile = trashPathFor(vaultRoot, memoryID);
  if (!(await fileExists(trashFile))) {
    throw new Error(`trashed file missing for memory: ${memoryID}`);
  }

  // Zielpfad: vom Caller bevorzugt, sonst aus dem letzten Delete-Audit-Eintrag.
  const dest = destFilePath ?? lastDelete.file_path;
  if (!dest) {
    throw new Error(
      `restore needs an explicit destFilePath — the original path is missing in the audit-log.`,
    );
  }

  await restoreFromTrash(vaultRoot, trashFile, dest);

  const audit = await auditLog.record({
    memory_id: memoryID,
    actor: context.actor,
    actor_detail: context.actor_detail,
    operation: "restore",
    diff_before: null,
    diff_after: lastDelete.diff_before,
    file_path: dest,
    reason: context.reason,
    session_id: context.session_id,
  });

  return { id: memoryID, restoredTo: dest, audit };
}

// ─── helpers ────────────────────────────────────────────────────

function cloneFrontmatter(fm: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(fm)) as Record<string, unknown>;
}

async function readFrontmatter(
  filePath: string,
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = matter(raw);
    return parsed.data as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
