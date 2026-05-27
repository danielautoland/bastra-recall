import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Vault } from "../src/vault.js";
import { EmbeddingIndex, type EmbeddingProvider } from "../src/embeddings.js";

function memoryMd(id: string): string {
  return `---
id: ${id}
title: ${id}
type: lesson
summary: s
topic_path: [t]
tags: [t]
scope: t
recall_when: ["w"]
created: 2026-05-01
updated: 2026-05-01
---

body ${id}
`;
}

class SlowMockProvider implements EmbeddingProvider {
  readonly id = "mock-slow";
  readonly dim = 4;
  public calls = 0;
  public peakInFlight = 0;
  public inFlight = 0;
  constructor(private readonly latencyMs: number) {}

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls++;
    this.inFlight++;
    if (this.inFlight > this.peakInFlight) this.peakInFlight = this.inFlight;
    try {
      await new Promise((r) => setTimeout(r, this.latencyMs));
      return texts.map((_, i) => new Float32Array([i, i, i, i]));
    } finally {
      this.inFlight--;
    }
  }
}

async function vaultWith(count: number): Promise<{ dir: string; vault: Vault }> {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-embed-bp-"));
  await mkdir(dir, { recursive: true });
  for (let i = 0; i < count; i++) {
    const id = `m${String(i).padStart(5, "0")}`;
    await writeFile(path.join(dir, `${id}.md`), memoryMd(id));
  }
  const vault = new Vault(dir);
  await vault.init();
  return { dir, vault };
}

test("flushQueue respects MAX_CONCURRENT_BATCHES (default 2)", async () => {
  // 200 Memories, 50 pro batch → 4 batches, sollte 2 parallel laufen lassen
  const { dir, vault } = await vaultWith(200);
  try {
    const provider = new SlowMockProvider(50);
    const persistPath = path.join(dir, ".bastra", "embeddings.json");
    const idx = new EmbeddingIndex(vault, provider, persistPath);
    await idx.start();
    // start() triggert flushQueue async; warten bis alle vectors da sind
    const deadline = Date.now() + 10_000;
    while (idx.size() < 200 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(idx.size(), 200, "all memories should be embedded");
    assert.ok(
      provider.peakInFlight <= 2,
      `peakInFlight = ${provider.peakInFlight}, must be <= 2`,
    );
    idx.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("enqueue() applies backpressure when queue grows beyond limit", async () => {
  // backpressure-limit auf 20 setzen via env-override
  const prevLimit = process.env.BASTRA_EMBED_BACKPRESSURE_LIMIT;
  const prevStall = process.env.BASTRA_EMBED_BACKPRESSURE_STALL_MS;
  process.env.BASTRA_EMBED_BACKPRESSURE_LIMIT = "20";
  process.env.BASTRA_EMBED_BACKPRESSURE_STALL_MS = "30";
  // Re-import dynamic, damit env-Werte beim Module-Init greifen.
  const mod = await import(
    "../src/embeddings.js?bp=" + Math.random()
  ).catch(() => import("../src/embeddings.js"));

  try {
    const { dir, vault } = await vaultWith(0);
    const provider = new SlowMockProvider(20);
    const persistPath = path.join(dir, ".bastra", "embeddings.json");
    const idx = new mod.EmbeddingIndex(vault, provider, persistPath);
    await idx.start();

    // 100 dummy-IDs in den Vault stopfen (file + reindex), dann enqueue alle.
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) {
      const id = `bp${String(i).padStart(4, "0")}`;
      ids.push(id);
      await writeFile(path.join(dir, `${id}.md`), memoryMd(id));
      await vault.reindexFile(path.join(dir, `${id}.md`));
    }

    // Burst-enqueue messen: dauert spürbar länger als ohne backpressure,
    // weil enqueue() stallt sobald queue > 20.
    const t0 = performance.now();
    await Promise.all(ids.map((id) => idx.enqueue(id)));
    const dt = performance.now() - t0;

    // mit limit=20 und stall=30ms sollten wir mehrfach gestallt haben → > 30ms
    assert.ok(dt > 30, `enqueue burst dt=${dt.toFixed(0)}ms must include stall`);

    idx.stop();
    await rm(dir, { recursive: true, force: true });
  } finally {
    if (prevLimit === undefined) delete process.env.BASTRA_EMBED_BACKPRESSURE_LIMIT;
    else process.env.BASTRA_EMBED_BACKPRESSURE_LIMIT = prevLimit;
    if (prevStall === undefined) delete process.env.BASTRA_EMBED_BACKPRESSURE_STALL_MS;
    else process.env.BASTRA_EMBED_BACKPRESSURE_STALL_MS = prevStall;
  }
});
