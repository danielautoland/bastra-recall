import { mkdir, readFile, appendFile, rename, access } from "node:fs/promises";
import { join, dirname } from "node:path";

/**
 * Audit-Log: jede Memory-Mutation wird als JSON-Zeile in
 * `<vault>/.bastra/audit-log.ndjson` festgehalten.
 *
 * Append-only — keine Datei wird je überschrieben oder gekürzt. Die
 * `.bastra/` Dotfolder wird vom Vault-Watcher ignoriert (siehe vault.ts),
 * deshalb kann sie sicher im Vault-Root liegen ohne Index-Pollution.
 *
 * Datenfluss:
 *   saveMemory / softDeleteMemory / restoreMemory  (Caller, z.B. bridge.ts)
 *       └─→  AuditLog.record(...)
 *               └─→  appendFile(.bastra/audit-log.ndjson)
 *
 * Lese-API (forMemory / since) lädt das ganze File und filtert in-memory.
 * Bei Vaults mit zigtausend Mutationen kann das später durch einen
 * Index ersetzt werden — für heute (low-volume) reicht NDJSON-Scan.
 */

export type AuditOperation = "create" | "update" | "delete" | "restore";

export type AuditActor = "user" | "assistant" | "system" | "import";

export interface AuditEntry {
  /** Eindeutige Audit-Eintrag-ID — `<timestamp-ms>-<rand>`. */
  id: string;
  memory_id: string;
  /** ISO-8601 timestamp mit Millisekunden. */
  timestamp: string;
  actor: AuditActor;
  /** Optional: User-/Session-/Tool-Bezeichner (z.B. Mac-App vs. Claude-Code-Hook). */
  actor_detail?: string;
  operation: AuditOperation;
  /** Frontmatter-Snapshot vor der Mutation (null bei `create`). */
  diff_before: Record<string, unknown> | null;
  /** Frontmatter-Snapshot nach der Mutation (null bei `delete`). */
  diff_after: Record<string, unknown> | null;
  /**
   * Original-Pfad der Memory-Datei. Bei `delete` der Pfad VOR dem Move in den
   * Trash — den wir beim Restore brauchen. Bei `create`/`update` der finale
   * Pfad nach Save.
   */
  file_path?: string;
  /** Pflicht für `assistant`-Mutationen — kurzer Klartext-Grund (1-2 Sätze). */
  reason?: string;
  /** Korreliert mit Telemetry-session-id (UUID v4). */
  session_id?: string;
}

const AUDIT_DIR = ".bastra";
const AUDIT_FILE = "audit-log.ndjson";

export class AuditLog {
  private cache: AuditEntry[] | null = null;

  constructor(public readonly vaultRoot: string) {}

  // ─── public API ───────────────────────────────────────────────

  /** Schreibt einen neuen Audit-Eintrag und invalidiert den Lese-Cache. */
  async record(input: Omit<AuditEntry, "id" | "timestamp"> & {
    id?: string;
    timestamp?: string;
  }): Promise<AuditEntry> {
    const entry: AuditEntry = {
      id: input.id ?? makeAuditID(),
      memory_id: input.memory_id,
      timestamp: input.timestamp ?? new Date().toISOString(),
      actor: input.actor,
      ...(input.actor_detail ? { actor_detail: input.actor_detail } : {}),
      operation: input.operation,
      diff_before: input.diff_before,
      diff_after: input.diff_after,
      ...(input.file_path ? { file_path: input.file_path } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.session_id ? { session_id: input.session_id } : {}),
    };

    const filePath = this.filePath();
    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, JSON.stringify(entry) + "\n", "utf8");
    this.cache = null;
    return entry;
  }

  /** Alle Einträge (sortiert nach Timestamp aufsteigend), lazy geladen. */
  async readAll(): Promise<AuditEntry[]> {
    if (this.cache) return this.cache;
    const filePath = this.filePath();
    if (!(await fileExists(filePath))) {
      this.cache = [];
      return this.cache;
    }
    const raw = await readFile(filePath, "utf8");
    const out: AuditEntry[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as AuditEntry);
      } catch {
        // Korrupte Zeile ignorieren — append-only-Log darf nicht abbrechen.
      }
    }
    out.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    this.cache = out;
    return out;
  }

  /** Alle Einträge zu einer bestimmten Memory-ID, neueste zuerst. */
  async forMemory(memoryID: string): Promise<AuditEntry[]> {
    const all = await this.readAll();
    return all.filter((e) => e.memory_id === memoryID).reverse();
  }

  /** Einträge ab einem Timestamp, optional gefiltert nach actor/operation. */
  async since(
    sinceISO: string,
    filters: { actor?: AuditActor; operation?: AuditOperation } = {},
  ): Promise<AuditEntry[]> {
    const all = await this.readAll();
    return all
      .filter((e) => e.timestamp >= sinceISO)
      .filter((e) => !filters.actor || e.actor === filters.actor)
      .filter((e) => !filters.operation || e.operation === filters.operation)
      .reverse();
  }

  /** Letzter `delete`-Eintrag einer Memory — für Restore. */
  async lastDeleteFor(memoryID: string): Promise<AuditEntry | undefined> {
    const all = await this.forMemory(memoryID);
    return all.find((e) => e.operation === "delete");
  }

  // ─── internals ────────────────────────────────────────────────

  private filePath(): string {
    return join(this.vaultRoot, AUDIT_DIR, AUDIT_FILE);
  }
}

function makeAuditID(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `${t}-${r}`;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// ─── Trash-Folder helpers ─────────────────────────────────────────
//
// Soft-Delete: Memory-File wird nach `<vault>/.bastra/trash/<id>.md`
// verschoben. Der Watcher sieht ein "unlink" und entfernt aus dem Index.
// Restore kann die Datei aus dem Trash zurückmoven.

const TRASH_DIR = "trash";

export function trashPathFor(vaultRoot: string, id: string): string {
  return join(vaultRoot, AUDIT_DIR, TRASH_DIR, `${id}.md`);
}

export async function moveToTrash(
  vaultRoot: string,
  filePath: string,
  id: string,
): Promise<string> {
  const dest = trashPathFor(vaultRoot, id);
  await mkdir(dirname(dest), { recursive: true });
  await rename(filePath, dest);
  return dest;
}

export async function restoreFromTrash(
  vaultRoot: string,
  trashFile: string,
  destFile: string,
): Promise<void> {
  await mkdir(dirname(destFile), { recursive: true });
  await rename(trashFile, destFile);
}
