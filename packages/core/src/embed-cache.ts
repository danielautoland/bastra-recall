/**
 * Content-Hash-Cache für Embeddings (#31, Bonus).
 *
 * Memories werden bei jedem `vault.change`-Event erneut an die Embed-Queue
 * geliefert, auch wenn nur Frontmatter-Felder geändert wurden, die in den
 * Embed-Text gar nicht eingehen (z.B. `last_reviewed_at`, `stale_status`,
 * `related_via`). Das verbrennt Tokens (OpenAI) oder Ollama-Compute.
 *
 * Lösung: Pro Memory den SHA-256 des embed-relevanten Contents speichern.
 * Vor einem Embed-Call vergleichen — wenn unverändert, skippen wir den
 * Provider-Call komplett.
 *
 * Cache-File: `<vault>/.bastra/embed-cache.json`, Form
 * `{ [memId]: { hash, vector_dim, embedded_at } }`.
 *
 * Bei Provider-/Dim-Wechsel wird der Cache durch den vorhandenen Persist-
 * Path-Invalidator (siehe embeddings.ts:load()) ohnehin nicht mehr passen
 * (Vector-Map ist leer → kein vorhandener Vector → Cache-Check schlägt fehl
 * und wir embedden frisch).
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { Memory } from "./schema.js";

export interface EmbedCacheEntry {
  hash: string;
  vector_dim: number;
  embedded_at: string;
}

export interface EmbedCacheFile {
  version: 1;
  provider: string;
  dim: number;
  entries: Record<string, EmbedCacheEntry>;
}

/**
 * Stable hash über den embed-relevanten Content. Identisch zum Format,
 * das `buildEmbedText()` in embeddings.ts produziert — wir hashen aber die
 * Quellfelder direkt, damit der Hash unabhängig von Format-Änderungen am
 * Embed-Text stabil bleibt (insgesamt sind die Felder das, was zählt).
 */
export function hashEmbedContent(m: Memory): string {
  const fm = m.fm;
  const seed = [
    fm.title,
    fm.tags.join(","),
    fm.recall_when.join("\n"),
    fm.summary,
    m.body.slice(0, 4000),
  ].join("|");
  return createHash("sha256").update(seed).digest("hex");
}

export class EmbedCache {
  private entries = new Map<string, EmbedCacheEntry>();
  private providerId: string;
  private dim: number;

  constructor(
    private readonly cachePath: string,
    providerId: string,
    dim: number,
  ) {
    this.providerId = providerId;
    this.dim = dim;
  }

  /** Lädt Cache von Disk; bei Provider-/Dim-Mismatch wird der Cache verworfen. */
  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.cachePath, "utf-8");
      const data = JSON.parse(raw) as EmbedCacheFile;
      if (data.version !== 1) return;
      if (data.provider !== this.providerId || data.dim !== this.dim) {
        // Cache war mit anderem Provider/Dim gebaut → unbrauchbar.
        return;
      }
      for (const [id, entry] of Object.entries(data.entries)) {
        this.entries.set(id, entry);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        console.error("[bastra.embeddings] embed-cache load error:", err);
      }
    }
  }

  /** Speichert Cache auf Disk. Idempotent — kann debounced aufgerufen werden. */
  async save(): Promise<void> {
    const entries: Record<string, EmbedCacheEntry> = {};
    for (const [id, e] of this.entries) entries[id] = e;
    const data: EmbedCacheFile = {
      version: 1,
      provider: this.providerId,
      dim: this.dim,
      entries,
    };
    try {
      await fs.mkdir(path.dirname(this.cachePath), { recursive: true });
      await fs.writeFile(this.cachePath, JSON.stringify(data));
    } catch (err) {
      console.error("[bastra.embeddings] embed-cache persist error:", err);
    }
  }

  /** True wenn Cache einen Eintrag mit identischem Hash hat. */
  isFresh(id: string, hash: string): boolean {
    const e = this.entries.get(id);
    return !!e && e.hash === hash;
  }

  /** Eintrag setzen nach erfolgreichem Embed. */
  set(id: string, hash: string): void {
    this.entries.set(id, {
      hash,
      vector_dim: this.dim,
      embedded_at: new Date().toISOString(),
    });
  }

  /** Eintrag löschen — z.B. wenn ein Memory aus dem Vault entfernt wird. */
  delete(id: string): boolean {
    return this.entries.delete(id);
  }

  /** Für Tests / Debug. */
  size(): number {
    return this.entries.size;
  }

  get(id: string): EmbedCacheEntry | undefined {
    return this.entries.get(id);
  }
}
