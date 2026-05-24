/**
 * Scope-Migration: zieht alle Memories aus dem Legacy-Scope `nexus-recall`
 * nach `bastra-recall` (Repo wurde umbenannt von bastra-open → bastra-recall;
 * detectProject(cwd) liefert jetzt `bastra-recall`, und der SessionStart-Hook
 * filtert scope-gleich, weshalb die alten Memories sonst unsichtbar bleiben).
 *
 * Was passiert:
 *   - Liest alle *.md unter <vault>/memories/projects/nexus-recall/
 *   - Setzt `scope: nexus-recall` → `scope: bastra-recall` im Frontmatter
 *   - Move nach <vault>/memories/projects/bastra-recall/ (gleicher Dateiname)
 *   - Räumt den source-Folder am Ende auf, wenn leer
 *
 * Was NICHT passiert:
 *   - Memory-IDs / Slugs werden NICHT umbenannt (Wikilinks dürfen nicht brechen).
 *   - `topic_path` / `tags` werden NICHT angetastet (Daniels Auftrag: nur scope).
 *
 * Idempotent: Files, die bereits `scope: bastra-recall` haben, werden
 * übersprungen (ungewöhnlich falls sie noch im source-Folder liegen — wird
 * geloggt, aber nicht überschrieben).
 *
 * Run:
 *   BASTRA_VAULT_PATH=… npx tsx scripts/migrate-scope.ts
 *   BASTRA_VAULT_PATH=… BACKFILL_DRY_RUN=1 npx tsx scripts/migrate-scope.ts
 */
import { readFile, writeFile, readdir, mkdir, rm, rmdir, stat } from "node:fs/promises";
import matter from "gray-matter";
import * as path from "node:path";

const FROM_SCOPE = "nexus-recall";
const TO_SCOPE = "bastra-recall";

const VAULT = process.env.BASTRA_VAULT_PATH ?? process.env.NEXUS_VAULT_PATH;
if (!VAULT) {
  console.error("[bastra-recall.migrate-scope] BASTRA_VAULT_PATH ist nicht gesetzt — abort.");
  process.exit(2);
}

const DRY_RUN = envBool("BACKFILL_DRY_RUN", false);

async function main(): Promise<void> {
  const fromDir = path.join(VAULT!, "memories", "projects", FROM_SCOPE);
  const toDir = path.join(VAULT!, "memories", "projects", TO_SCOPE);
  console.error(
    `[bastra-recall.migrate-scope] ${fromDir}\n` +
      `                          → ${toDir}${DRY_RUN ? "   (dry-run)" : ""}`,
  );

  let entries: string[];
  try {
    entries = await readdir(fromDir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error("[bastra-recall.migrate-scope] source dir does not exist — nothing to do.");
      process.exit(0);
    }
    throw err;
  }

  const mdFiles = entries.filter((f) => f.endsWith(".md"));
  const otherFiles = entries.filter((f) => !f.endsWith(".md"));
  console.error(
    `[bastra-recall.migrate-scope] found ${mdFiles.length} .md file(s)` +
      (otherFiles.length > 0 ? ` + ${otherFiles.length} non-md (untouched)` : ""),
  );

  if (!DRY_RUN) {
    await mkdir(toDir, { recursive: true });
  }

  let migrated = 0;
  let alreadyMigrated = 0;
  let scopeMismatch = 0;
  let dstCollisions = 0;

  for (const file of mdFiles) {
    const srcPath = path.join(fromDir, file);
    const dstPath = path.join(toDir, file);

    const raw = await readFile(srcPath, "utf8");
    const parsed = matter(raw);
    const fm = parsed.data as Record<string, unknown>;
    const currentScope = fm.scope;

    if (currentScope === TO_SCOPE) {
      alreadyMigrated++;
      console.error(`  SKIP (scope already ${TO_SCOPE}): ${file}`);
      continue;
    }

    if (currentScope !== FROM_SCOPE) {
      scopeMismatch++;
      console.error(
        `  WARN (scope=${JSON.stringify(currentScope)}, expected ${FROM_SCOPE}): ${file} — migrating anyway`,
      );
    }

    if (await exists(dstPath)) {
      dstCollisions++;
      console.error(`  ERR (dest exists, would clobber): ${dstPath} — skip`);
      continue;
    }

    fm.scope = TO_SCOPE;
    const next = matter.stringify(
      parsed.content.startsWith("\n") ? parsed.content : `\n${parsed.content}`,
      fm,
    );

    if (DRY_RUN) {
      console.error(`  WOULD migrate: ${file}  (scope ${currentScope} → ${TO_SCOPE})`);
    } else {
      // Schreibe direkt ans Ziel mit aktualisiertem scope, dann lösche source.
      // Vault-Watcher (chokidar) sieht: add(dst) + unlink(src) → kein Doppel-
      // Index, da Vault über fm.id dedupliziert.
      await writeFile(dstPath, next, "utf8");
      await rm(srcPath);
      console.error(`  ✓ ${file}`);
    }
    migrated++;
  }

  console.error(
    `[bastra-recall.migrate-scope] migrated: ${migrated}, already-migrated: ${alreadyMigrated}, ` +
      `scope-mismatch: ${scopeMismatch}, dest-collisions: ${dstCollisions}`,
  );

  if (!DRY_RUN) {
    try {
      const remaining = await readdir(fromDir);
      if (remaining.length === 0) {
        await rmdir(fromDir);
        console.error(`[bastra-recall.migrate-scope] removed empty source dir: ${fromDir}`);
      } else {
        console.error(
          `[bastra-recall.migrate-scope] source dir not empty (${remaining.length} item(s) left): ${remaining.join(", ")} — kept.`,
        );
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return !["0", "false", "off", "no"].includes(raw.toLowerCase());
}

main().catch((err) => {
  console.error("[bastra-recall.migrate-scope] FATAL:", err);
  process.exit(1);
});
