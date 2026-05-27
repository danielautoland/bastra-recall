/**
 * Synthetic Bench für vault.init().
 *
 * Erzeugt einen Vault mit N Memories (Default 1000), misst init-Zeit drei
 * Mal hintereinander (warm FS-Cache) und gibt min/median/max aus.
 *
 * Usage:
 *   npm run bench:vault-init --workspace=@bastra-recall/core
 *   N=2000 npm run bench:vault-init --workspace=@bastra-recall/core
 */
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Vault } from "../src/vault.js";

const N = Number(process.env.N ?? "1000");
const RUNS = Number(process.env.RUNS ?? "3");

function memoryMd(id: string): string {
  // ~500 chars Body, damit der Parse-Aufwand realistisch ist.
  const body = "x ".repeat(250);
  return `---
id: ${id}
title: Memory ${id}
type: lesson
summary: bench memory ${id}
topic_path: [bench]
tags: [bench, perf]
scope: bench
recall_when: ["bench query"]
created: 2026-05-01
updated: 2026-05-01
---

${body}
`;
}

async function setup(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-bench-init-"));
  // Spread über folders wie ein realer Obsidian-Vault.
  for (let i = 0; i < N; i++) {
    const sub = path.join(dir, `folder-${i % 20}`);
    await mkdir(sub, { recursive: true });
    const id = `bench-${String(i).padStart(5, "0")}`;
    await writeFile(path.join(sub, `${id}.md`), memoryMd(id));
  }
  return dir;
}

async function main(): Promise<void> {
  console.log(`bench-vault-init: N=${N}, RUNS=${RUNS}`);
  const dir = await setup();
  try {
    const times: number[] = [];
    for (let r = 0; r < RUNS; r++) {
      const vault = new Vault(dir);
      const t0 = performance.now();
      const result = await vault.init();
      const dt = performance.now() - t0;
      times.push(dt);
      console.log(
        `run ${r + 1}: loaded=${result.loaded} skipped=${result.skipped.length} dt=${dt.toFixed(1)}ms`,
      );
    }
    const sorted = [...times].sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const median = sorted[Math.floor(sorted.length / 2)];
    console.log(
      `summary: min=${min.toFixed(1)}ms median=${median.toFixed(1)}ms max=${max.toFixed(1)}ms (N=${N})`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
