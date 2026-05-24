/**
 * Migrate a flat `memorys/` vault to the scope-based hierarchy:
 *
 *   memories/user/                  scope = "user-preference"
 *   memories/all-projects/          scope = "all-projects"
 *   memories/projects/<scope>/      everything else
 *
 * Bookmarks (type = "bookmark") stay in `bookmarks/` — they're a separate
 * top-level kind because they carry url/og_image and aren't really memories.
 *
 * Usage:
 *   BASTRA_VAULT_PATH=… npx tsx scripts/migrate-vault-structure.ts          # dry-run
 *   BASTRA_VAULT_PATH=… npx tsx scripts/migrate-vault-structure.ts --apply  # actually move
 */
import { readdir, readFile, mkdir, rename, rmdir } from "node:fs/promises";
import { join, basename } from "node:path";
import matter from "gray-matter";

const VAULT = process.env.BASTRA_VAULT_PATH ?? process.env.NEXUS_VAULT_PATH;
if (!VAULT) {
  console.error("set BASTRA_VAULT_PATH");
  process.exit(1);
}
const APPLY = process.argv.includes("--apply");

interface Plan {
  from: string;
  to: string;
  id: string;
  scope: string;
  type: string;
}

function targetSubfolder(scope: string, type: string): string {
  if (type === "bookmark") return "bookmarks";
  if (scope === "user-preference") return "memories/user";
  if (scope === "all-projects") return "memories/all-projects";
  return `memories/projects/${scope}`;
}

async function planFolder(folder: string, vault: string): Promise<Plan[]> {
  const dir = join(vault, folder);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: Plan[] = [];
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const from = join(dir, name);
    const raw = await readFile(from, "utf8");
    const fm = matter(raw).data as Record<string, unknown>;
    const scope = typeof fm.scope === "string" ? fm.scope : "unscoped";
    const type = typeof fm.type === "string" ? fm.type : "memory";
    const id = typeof fm.id === "string" ? fm.id : basename(name, ".md");
    const sub = targetSubfolder(scope, type);
    const to = join(vault, sub, name);
    if (from === to) continue;
    out.push({ from, to, id, scope, type });
  }
  return out;
}

async function main(): Promise<void> {
  const vault = VAULT!;
  const memorysPlan = await planFolder("memorys", vault);
  const bookmarksPlan = await planFolder("bookmarks", vault);
  const all = [...memorysPlan, ...bookmarksPlan];

  console.log(`vault: ${vault}`);
  console.log(`mode:  ${APPLY ? "APPLY" : "DRY-RUN (pass --apply to execute)"}`);
  console.log("");

  const byTarget = new Map<string, number>();
  for (const p of all) {
    const sub = p.to.replace(vault + "/", "").split("/").slice(0, -1).join("/");
    byTarget.set(sub, (byTarget.get(sub) ?? 0) + 1);
  }
  console.log("target distribution:");
  for (const [sub, n] of [...byTarget.entries()].sort()) {
    console.log(`  ${n.toString().padStart(3)}  ${sub}/`);
  }
  console.log("");
  console.log(`total moves: ${all.length}`);

  if (!APPLY) {
    console.log("\nfirst 5 moves (preview):");
    for (const p of all.slice(0, 5)) {
      console.log(`  ${p.from.replace(vault, "…")} → ${p.to.replace(vault, "…")}`);
    }
    console.log("\nrun with --apply to execute.");
    return;
  }

  const ensured = new Set<string>();
  let moved = 0;
  let failed = 0;
  for (const p of all) {
    const dir = p.to.split("/").slice(0, -1).join("/");
    if (!ensured.has(dir)) {
      await mkdir(dir, { recursive: true });
      ensured.add(dir);
    }
    try {
      await rename(p.from, p.to);
      moved++;
    } catch (err) {
      console.error(`! failed: ${p.from} → ${p.to}: ${(err as Error).message}`);
      failed++;
    }
  }
  console.log(`moved:  ${moved}`);
  console.log(`failed: ${failed}`);

  // Try to remove now-empty old folders.
  for (const old of ["memorys", "bookmarks"]) {
    try {
      await rmdir(join(vault, old));
      console.log(`removed empty: ${old}/`);
    } catch {
      // not empty or doesn't exist — leave it
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
