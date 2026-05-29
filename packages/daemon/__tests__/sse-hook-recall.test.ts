/**
 * Tests für den SSE-Branch von `/hook/recall` (#38).
 *
 * Verifiziert:
 * - Mit `Accept: text/event-stream` → Content-Type ist SSE, Stages
 *   kommen als named events, finaler `event: done`-Frame trägt die
 *   hits[].
 * - Ohne `Accept`-Header → bestehende JSON-Response (BC).
 *
 * Runner: `node --import tsx --test packages/daemon/__tests__/sse-hook-recall.test.ts`
 *
 * Der Test startet einen echten Daemon-HTTP-Server gegen ein
 * temporäres File-Vault — kein Mocking des SearchIndex, damit der
 * Stage-Flow real durchläuft.
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
    "---",
    `id: ${id}`,
    `title: ${title}`,
    "type: reference",
    `summary: ${title}`,
    "topic_path:",
    "  - test",
    "tags:",
    "  - test",
    "scope: sse-test",
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

interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function httpPost(
  port: number,
  path: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body).toString(),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function makeDaemon(): Promise<{ port: number; close: () => Promise<void>; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-sse-test-"));
  await writeFile(join(dir, "alpha.md"), memoryMarkdown("alpha", "alpha bravo"), "utf8");
  await writeFile(join(dir, "charlie.md"), memoryMarkdown("charlie", "charlie delta"), "utf8");
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const telemetry = new Telemetry();

  const handle = await startHttpServer({
    port: 0, // OS picks free port
    vault,
    search,
    telemetry,
    version: "test",
    toolDeps: { vault, search, telemetry, vaultPath: dir },
    documentWriteEnabled: false,
  });
  return {
    port: handle.port!,
    close: async () => {
      search.stop();
      await vault.stop?.();
      await handle.close();
      await rm(dir, { recursive: true, force: true });
    },
    dir,
  };
}

test("hook/recall: without Accept header returns JSON", async () => {
  const d = await makeDaemon();
  try {
    const r = await httpPost(d.port, "/hook/recall", { query: "alpha" });
    assert.equal(r.status, 200);
    const ct = String(r.headers["content-type"] ?? "");
    assert.ok(ct.includes("application/json"), `expected JSON content-type, got ${ct}`);
    const parsed = JSON.parse(r.body);
    assert.ok(Array.isArray(parsed.hits), "hits must be array");
    assert.equal(typeof parsed.recall_id, "string");
    assert.equal(typeof parsed.latency_ms, "number");
  } finally {
    await d.close();
  }
});

test("hook/recall: with Accept: text/event-stream returns SSE stages + done", async () => {
  const d = await makeDaemon();
  try {
    const r = await httpPost(
      d.port,
      "/hook/recall",
      { query: "alpha" },
      { Accept: "text/event-stream" },
    );
    assert.equal(r.status, 200);
    const ct = String(r.headers["content-type"] ?? "");
    assert.ok(ct.includes("text/event-stream"), `expected SSE content-type, got ${ct}`);

    // Body enthält named events (\nevent: stage\ndata: {...}\n\n)
    assert.ok(r.body.includes("event: stage"), "no stage events in SSE body");
    assert.ok(r.body.includes("event: done"), "no done event in SSE body");

    // Parse jeden Event-Block — wir wollen mindestens query.parse,
    // bm25.search, staleness.rank Stages und einen finalen done-Frame
    // mit hits[].
    const blocks = r.body.split("\n\n").filter((b) => b.startsWith("event: "));
    const stageNames = blocks
      .filter((b) => b.includes("event: stage"))
      .map((b) => {
        const m = b.match(/data: (.+)$/m);
        return m ? (JSON.parse(m[1]) as { name: string }).name : "";
      });
    assert.ok(stageNames.includes("query.parse"), `missing query.parse in ${stageNames.join(",")}`);
    assert.ok(stageNames.includes("bm25.search"), `missing bm25.search in ${stageNames.join(",")}`);
    assert.ok(stageNames.includes("staleness.rank"), `missing staleness.rank in ${stageNames.join(",")}`);

    const doneBlock = blocks.find((b) => b.includes("event: done"))!;
    const doneJson = JSON.parse(doneBlock.match(/data: (.+)$/m)![1]);
    assert.ok(Array.isArray(doneJson.hits));
    assert.equal(typeof doneJson.recall_id, "string");
    assert.equal(typeof doneJson.latency_ms, "number");
  } finally {
    await d.close();
  }
});

test("hook/recall: SSE missing query returns error event", async () => {
  const d = await makeDaemon();
  try {
    const r = await httpPost(
      d.port,
      "/hook/recall",
      {},
      { Accept: "text/event-stream" },
    );
    assert.equal(r.status, 200, "SSE keeps 200 even on error — event carries the failure");
    assert.ok(r.body.includes("event: error"), `expected error event, got: ${r.body}`);
  } finally {
    await d.close();
  }
});
