import { readFile, readdir, stat } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import matter from "gray-matter";
import { type Memory, parseMemoryWith, NotAMemoryFile } from "./schema.js";

export type VaultEvent =
  | { kind: "add"; memory: Memory }
  | { kind: "change"; memory: Memory }
  | { kind: "remove"; id: string; filePath: string };

export type VaultListener = (e: VaultEvent) => void;

/**
 * A vault is a directory tree of .md files. Files with valid memory
 * frontmatter (recognized `type:` field) are loaded; everything else
 * (e.g. plain Obsidian notes living in the same folders) is silently
 * skipped. Sub-directories are walked recursively, dotfolders and
 * `node_modules` are excluded.
 *
 * This means the user can point the app at an Obsidian vault root and
 * organize memorys into nested topic folders if they want, without
 * giving up the ability to keep regular notes alongside.
 */
export class Vault {
  private memorys = new Map<string, Memory>(); // id → memory
  private filePathToId = new Map<string, string>(); // absolute path → id
  private listeners = new Set<VaultListener>();
  private watcher?: FSWatcher;

  constructor(public readonly root: string) {}

  async init(): Promise<{ loaded: number; skipped: { path: string; err: string }[] }> {
    // Reihenfolge stabil halten: nach Pfad sortieren bevor wir parallel laden.
    // So bleibt die Map-Iterationsordnung deterministisch (Maps iterieren in
    // Insertion-Order; wir setzen die Ergebnisse in Pfad-Sortierreihenfolge).
    const files = (await this.listMarkdownFiles()).slice().sort();
    const skipped: { path: string; err: string }[] = [];
    const BATCH = 32;
    type Loaded = { kind: "ok"; file: string; memory: Memory };
    type Skipped = { kind: "skip" };
    type Failed = { kind: "fail"; file: string; err: string };
    const results: (Loaded | Skipped | Failed)[] = new Array(files.length);
    for (let i = 0; i < files.length; i += BATCH) {
      const chunk = files.slice(i, i + BATCH);
      const settled = await Promise.allSettled(
        chunk.map((f) => this.read(f)),
      );
      for (let j = 0; j < settled.length; j++) {
        const s = settled[j];
        const f = chunk[j];
        if (s.status === "fulfilled") {
          results[i + j] = { kind: "ok", file: f, memory: s.value };
        } else {
          const err = s.reason;
          if (err instanceof NotAMemoryFile) {
            results[i + j] = { kind: "skip" };
          } else {
            const msg = (err as Error).message ?? String(err);
            console.warn(`[vault] init skipped (${basename(f)}): ${msg}`);
            results[i + j] = { kind: "fail", file: f, err: msg };
          }
        }
      }
    }
    // Insertion in Pfad-Sortierreihenfolge → deterministische Map-Iteration.
    for (const r of results) {
      if (!r || r.kind !== "ok") {
        if (r && r.kind === "fail") skipped.push({ path: r.file, err: r.err });
        continue;
      }
      this.memorys.set(r.memory.fm.id, r.memory);
      this.filePathToId.set(r.file, r.memory.fm.id);
    }
    return { loaded: this.memorys.size, skipped };
  }

  /** Start watching the vault tree (recursive). Emits add/change/remove. */
  startWatching(): void {
    if (this.watcher) return;
    // fsevents/kqueue do not fire reliably for files written *into* a
    // GoogleDrive/iCloud/Dropbox provider mount. Force polling on those.
    const isCloudMount = /(CloudStorage|Dropbox|iCloud)/i.test(this.root);
    this.watcher = chokidar.watch(`${this.root}/**/*.md`, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
      usePolling: isCloudMount,
      interval: isCloudMount ? 1500 : undefined,
      ignored: (path: string) => {
        // Skip dotfolders (.obsidian, .git, .trash, …) and node_modules
        const segments = path.split(/[/\\]/);
        return segments.some(
          (s) => (s.startsWith(".") && s.length > 1) || s === "node_modules",
        );
      },
    });
    this.watcher.on("add", (p) => void this.handleAddOrChange(p, "add"));
    this.watcher.on("change", (p) => void this.handleAddOrChange(p, "change"));
    this.watcher.on("unlink", (p) => this.handleRemove(p));
  }

  /**
   * Force re-read of a single file and emit an add/change event.
   * Use after a known write (e.g. save_memory) so callers don't have to
   * wait for the watcher — which is unreliable on cloud-storage mounts.
   */
  async reindexFile(filePath: string): Promise<void> {
    const existing = this.filePathToId.has(filePath);
    await this.handleAddOrChange(filePath, existing ? "change" : "add");
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
    this.watcher = undefined;
  }

  on(listener: VaultListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): Memory[] {
    return [...this.memorys.values()];
  }

  get(id: string): Memory | undefined {
    return this.memorys.get(id);
  }

  size(): number {
    return this.memorys.size;
  }

  // ─── internals ───────────────────────────────────────────────

  private async listMarkdownFiles(): Promise<string[]> {
    const out: string[] = [];
    await this.walkDir(this.root, out);
    return out;
  }

  private async walkDir(dir: string, out: string[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable subtree → ignore
    }
    for (const e of entries) {
      // Skip noise that almost never holds memorys
      if (e.name.startsWith(".") && e.name.length > 1) continue;
      if (e.name === "node_modules") continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await this.walkDir(full, out);
      } else if (e.isFile() && extname(e.name) === ".md") {
        out.push(full);
      }
    }
  }

  private async read(filePath: string): Promise<Memory> {
    const [raw, st] = await Promise.all([
      readFile(filePath, "utf8"),
      stat(filePath),
    ]);
    return parseMemoryWith(
      (input) => matter(input),
      raw,
      filePath,
      st.mtimeMs,
    );
  }

  private async handleAddOrChange(
    filePath: string,
    kind: "add" | "change",
  ): Promise<void> {
    try {
      const m = await this.read(filePath);
      // If id changed (rare), drop the old mapping
      const oldId = this.filePathToId.get(filePath);
      if (oldId && oldId !== m.fm.id) {
        this.memorys.delete(oldId);
      }
      this.memorys.set(m.fm.id, m);
      this.filePathToId.set(filePath, m.fm.id);
      this.emit({ kind, memory: m });
    } catch (err) {
      // Silent on plain notes; loud only on actual schema breakage.
      if (err instanceof NotAMemoryFile) return;
      console.error(
        `[vault] ${kind} skipped (${basename(filePath)}): ${(err as Error).message}`,
      );
    }
  }

  private handleRemove(filePath: string): void {
    const id = this.filePathToId.get(filePath);
    if (!id) return;
    this.memorys.delete(id);
    this.filePathToId.delete(filePath);
    this.emit({ kind: "remove", id, filePath });
  }

  private emit(e: VaultEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch (err) {
        console.error("[vault] listener error:", err);
      }
    }
  }
}
