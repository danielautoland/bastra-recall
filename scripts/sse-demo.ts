/**
 * Manual SSE-Demo für `/hook/recall` (#38). Startet einen ephemeral
 * Daemon gegen ein temporäres Vault, sendet eine Recall-Anfrage mit
 * `Accept: text/event-stream` und druckt die Stage-Lines aus.
 *
 * Run: npx tsx scripts/sse-demo.ts
 */
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { startHttpServer } from "../packages/daemon/src/http.js";
import { Telemetry } from "../packages/daemon/src/telemetry.js";

function mem(id: string, title: string): string {
  const ts = new Date().toISOString();
  return [
    "---",
    `id: ${id}`,
    `title: ${title}`,
    "type: reference",
    `summary: ${title}`,
    "topic_path:",
    "  - demo",
    "tags:",
    "  - demo",
    "scope: demo-scope",
    "recall_when:",
    `  - ${title}`,
    `created: ${ts}`,
    `updated: ${ts}`,
    "---",
    "",
    `Body for ${title}.`,
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "sse-demo-"));
  await writeFile(join(dir, "a.md"), mem("alpha-demo", "alpha bravo charlie"), "utf8");
  await writeFile(join(dir, "b.md"), mem("beta-demo", "alpha delta echo"), "utf8");
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const tele = new Telemetry();
  const handle = await startHttpServer({
    port: 0,
    vault,
    search,
    telemetry: tele,
    version: "demo",
    toolDeps: { vault, search, telemetry: tele, vaultPath: dir },
    documentWriteEnabled: false,
  });

  const body = JSON.stringify({ query: "alpha" });
  const out = await new Promise<string>((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: handle.port!,
        path: "/hook/recall",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body).toString(),
          Accept: "text/event-stream",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });

  console.log("=== SSE OUTPUT ===");
  console.log(out);
  console.log("=== END ===");
  await handle.close();
  search.stop();
  await vault.stop?.();
  await rm(dir, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
