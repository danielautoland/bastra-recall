/**
 * Tests for prompt-hook.ts (Issue #33).
 *
 * Strategy: unit-test the pure helpers (detectRetrieval, extractPrompt,
 * formatHintBlock) directly, then run an end-to-end test by spawning the
 * hook via tsx against a mock daemon HTTP server.
 */
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  detectRetrieval,
  extractPrompt,
  formatHintBlock,
  type RecallHit,
} from "../src/prompt-hook.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = resolve(__dirname, "..", "src", "prompt-hook.ts");

// ─── Pure unit tests ─────────────────────────────────────────────────────

test("detectRetrieval — DE triggers match", () => {
  const cases = [
    "such mal meinen Strafzettel",
    "Suche nach Rechnungen von 2024",
    "finde alle PDFs zum Mietvertrag",
    "wo ist meine Steuererklärung?",
    "wo sind die Notizen vom Meeting?",
    "wann war der letzte Arzttermin?",
    "wann hatte ich Urlaub im Juli?",
    "wieviel habe ich für Strom bezahlt?",
    "wie viel Miete im März?",
    "was habe ich zum Architekt gesagt?",
    "Was hab ich gestern gemacht?",
    "was war der Stand bei der Steuer?",
  ];
  for (const c of cases) {
    assert.equal(detectRetrieval(c), true, `expected retrieval match for: ${c}`);
  }
});

test("detectRetrieval — EN triggers match", () => {
  const cases = [
    "find the parking ticket pdf",
    "search invoices from last quarter",
    "where is the lease agreement?",
    "where are the meeting notes?",
    "when was the last vet visit?",
    "when did I sign the contract?",
    "how much did I spend on rent?",
    "what did I tell the architect?",
    "what was the status on the tax filing?",
  ];
  for (const c of cases) {
    assert.equal(detectRetrieval(c), true, `expected retrieval match for: ${c}`);
  }
});

test("detectRetrieval — non-retrieval prompts skip", () => {
  const cases = [
    "bitte schreib mir einen Hook",
    "implement a UserPromptSubmit handler",
    "lass uns über das design reden",
    "refactor the daemon",
    "thanks!",
    "",
    "   ",
    "ok",
    "go ahead",
    "machen wir das so",
  ];
  for (const c of cases) {
    assert.equal(detectRetrieval(c), false, `expected NO retrieval match for: ${c}`);
  }
});

test("extractPrompt — prefers payload.prompt", () => {
  assert.equal(extractPrompt({ prompt: "hello", user_message: "ignored" }), "hello");
});

test("extractPrompt — falls back to user_message", () => {
  assert.equal(extractPrompt({ user_message: "fallback" }), "fallback");
});

test("extractPrompt — empty/missing returns null", () => {
  assert.equal(extractPrompt({}), null);
  assert.equal(extractPrompt({ prompt: "" }), null);
  assert.equal(extractPrompt({ prompt: "   " }), null);
});

test("formatHintBlock — retrieval mode includes lookup instruction", () => {
  const hits: RecallHit[] = [
    {
      id: "test-memory",
      title: "Test",
      type: "lesson",
      scope: "user",
      summary: "Summary of the lesson",
      score: 120,
    },
  ];
  const block = formatHintBlock(hits, "myproject", "retrieval");
  assert.match(block, /<recall-hints surface="claude-code" trigger="prompt-lookup"/);
  assert.match(block, /project="myproject"/);
  assert.match(block, /LOOKUP \/ retrieval query/);
  assert.match(block, /bastra-recall:recall.*BEFORE conversation_search/i);
  assert.match(block, /test-memory/);
  assert.match(block, /<\/recall-hints>/);
});

test("formatHintBlock — separates REQUIRED vs OPTIONAL by score", () => {
  const hits: RecallHit[] = [
    { id: "high", title: "H", type: "lesson", scope: "user", summary: "high", score: 150 },
    { id: "mid", title: "M", type: "lesson", scope: "user", summary: "mid", score: 70 },
  ];
  const block = formatHintBlock(hits, null, "retrieval");
  const requiredIdx = block.indexOf("REQUIRED");
  const optionalIdx = block.indexOf("OPTIONAL");
  assert.ok(requiredIdx >= 0, "REQUIRED section missing");
  assert.ok(optionalIdx > requiredIdx, "OPTIONAL must come after REQUIRED");
  assert.ok(block.indexOf("high") < block.indexOf("mid"));
});

// ─── Integration test via mock daemon ────────────────────────────────────

function startMockDaemon(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  return new Promise<{ port: number; close: () => Promise<void> }>((ok) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      ok({
        port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

function runHook(
  payload: object,
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((ok, ko) => {
    const child = spawn("npx", ["tsx", HOOK_PATH], {
      env: { ...process.env, ...env, BASTRA_TELEMETRY: "off" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", ko);
    child.on("close", (code) => ok({ stdout, stderr, code: code ?? -1 }));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

test("integration — retrieval prompt yields recall-hints block", async () => {
  let received: { url: string | undefined; body: unknown } | null = null;
  const daemon = await startMockDaemon((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      received = { url: req.url, body: JSON.parse(body) };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          hits: [
            {
              id: "parkticket-2025",
              title: "Strafzettel März 2025",
              type: "project-fact",
              scope: "personal",
              summary: "Parkverstoß Berlin Mitte, 35€, bezahlt 2025-03-12.",
              score: 142,
            },
          ],
          vault_size: 100,
          latency_ms: 12,
          recall_id: "test-recall",
        }),
      );
    });
  });

  try {
    const { stdout } = await runHook(
      {
        hook_event_name: "UserPromptSubmit",
        prompt: "such mal meinen Strafzettel",
        cwd: process.cwd(),
      },
      { BASTRA_HTTP_URL: `http://127.0.0.1:${daemon.port}` },
    );

    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput?: { additionalContext?: string; hookEventName?: string };
    };
    assert.ok(parsed.hookSpecificOutput, "hook should emit hookSpecificOutput");
    assert.equal(parsed.hookSpecificOutput?.hookEventName, "UserPromptSubmit");
    const ctx = parsed.hookSpecificOutput?.additionalContext ?? "";
    assert.match(ctx, /parkticket-2025/);
    assert.match(ctx, /trigger="prompt-lookup"/);
    assert.match(ctx, /BEFORE conversation_search/);

    assert.ok(received, "mock daemon should have received request");
    const r = received as { url: string | undefined; body: { query: string; k: number } };
    assert.equal(r.url, "/hook/recall");
    assert.equal(r.body.query, "such mal meinen Strafzettel");
    assert.equal(r.body.k, 5);
  } finally {
    await daemon.close();
  }
});

test("integration — non-retrieval prompt emits empty object", async () => {
  let hit = false;
  const daemon = await startMockDaemon((_req, res) => {
    hit = true;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"hits":[],"vault_size":0,"latency_ms":1,"recall_id":"x"}');
  });
  try {
    const { stdout } = await runHook(
      {
        hook_event_name: "UserPromptSubmit",
        prompt: "lass uns das implementieren",
        cwd: process.cwd(),
      },
      { BASTRA_HTTP_URL: `http://127.0.0.1:${daemon.port}` },
    );
    assert.equal(stdout.trim(), "{}");
    assert.equal(hit, false, "daemon must not be called when no retrieval signal");
  } finally {
    await daemon.close();
  }
});

test("integration — wrong hook_event_name emits empty object", async () => {
  const daemon = await startMockDaemon((_req, res) => {
    res.writeHead(200);
    res.end("{}");
  });
  try {
    const { stdout } = await runHook(
      { hook_event_name: "PreToolUse", prompt: "such mal meinen Strafzettel" },
      { BASTRA_HTTP_URL: `http://127.0.0.1:${daemon.port}` },
    );
    assert.equal(stdout.trim(), "{}");
  } finally {
    await daemon.close();
  }
});
