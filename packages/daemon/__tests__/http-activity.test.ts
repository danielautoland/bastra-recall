/**
 * Test für den onActivity-Hook des HTTP-Servers (Idle-Self-Shutdown, #50).
 *
 * Verifiziert: jeder echte Request (z.B. POST /hook/recall) feuert
 * onActivity; die billige GET /health-Liveness NICHT (sonst hielte ein
 * Monitor den Daemon ewig am Leben).
 *
 * Runner: `tsx --test __tests__/http-activity.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { startHttpServer } from "../src/http.js";
import { Telemetry } from "../src/telemetry.js";

function memoryMarkdown(id: string, title: string): string {
  const ts = new Date().toISOString();
  return [
    "---", `id: ${id}`, `title: ${title}`, "type: reference", `summary: ${title}`,
    "topic_path:", "  - test", "tags:", "  - test", "scope: act-test",
    "recall_when:", `  - ${title}`, `created: ${ts}`, `updated: ${ts}`, "---",
    "", `Body for ${title}.`, "",
  ].join("\n");
}

function httpReq(port: number, method: string, path: string, payload?: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const body = payload !== undefined ? JSON.stringify(payload) : undefined;
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: body
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body).toString() }
          : {},
      },
      (res) => {
        res.on("data", () => undefined);
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

test("onActivity: fires on /hook/recall, not on /health", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-act-test-"));
  await writeFile(join(dir, "alpha.md"), memoryMarkdown("alpha", "alpha bravo"), "utf8");
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const telemetry = new Telemetry();

  let activityCount = 0;
  const handle = await startHttpServer({
    port: 0,
    vault,
    search,
    telemetry,
    version: "test",
    toolDeps: { vault, search, telemetry, vaultPath: dir },
    documentWriteEnabled: false,
    onActivity: () => {
      activityCount += 1;
    },
  });

  try {
    await httpReq(handle.port!, "GET", "/health");
    assert.equal(activityCount, 0, "/health must not count as activity");

    await httpReq(handle.port!, "POST", "/hook/recall", { query: "alpha" });
    assert.equal(activityCount, 1, "/hook/recall must count as activity");

    await httpReq(handle.port!, "GET", "/health");
    assert.equal(activityCount, 1, "second /health still must not bump");
  } finally {
    search.stop();
    await vault.stop?.();
    await handle.close();
    await rm(dir, { recursive: true, force: true });
  }
});
