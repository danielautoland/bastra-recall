/**
 * Tests for todo-hook.ts (Issue #36).
 *
 * Strategy: unit-test the pure helpers (extractTopicsFromTodos,
 * isLowConfidence, formatHintBlock) directly, then end-to-end against a
 * mock daemon HTTP server.
 */
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  extractTopicsFromTodos,
  isLowConfidence,
  formatHintBlock,
  type RecallHit,
} from "../src/todo-hook.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = resolve(__dirname, "..", "src", "todo-hook.ts");

// ─── Pure unit tests ─────────────────────────────────────────────────────

test("extractTopicsFromTodos — picks topic words that appear in >=2 todos", () => {
  const todos = [
    { content: "Refactor the bastra-recall daemon hook pipeline", status: "pending" },
    { content: "Update bastra-recall daemon telemetry events", status: "pending" },
    { content: "Document the new daemon hook config", status: "pending" },
  ];
  const ex = extractTopicsFromTodos(todos);
  // "daemon" appears in all 3, "bastra-recall" + "hook" each in 2.
  assert.ok(ex.topics.includes("daemon"), `topics: ${ex.topics.join(",")}`);
  assert.ok(ex.topics.includes("hook"), `topics: ${ex.topics.join(",")}`);
  assert.equal(ex.todoCount, 3);
  assert.ok(ex.query.length > 0);
  // Query should start with the topics
  assert.ok(ex.query.startsWith(ex.topics.join(" ")));
});

test("extractTopicsFromTodos — handles missing/empty payload", () => {
  assert.deepEqual(extractTopicsFromTodos(undefined), {
    query: "",
    topics: [],
    todoCount: 0,
  });
  assert.deepEqual(extractTopicsFromTodos([]), {
    query: "",
    topics: [],
    todoCount: 0,
  });
  const onlyEmptyContent = extractTopicsFromTodos([{ content: "" }, { content: "" }]);
  assert.equal(onlyEmptyContent.query, "");
  assert.equal(onlyEmptyContent.topics.length, 0);
});

test("extractTopicsFromTodos — filters stopwords and short words", () => {
  const todos = [
    { content: "fix the and or but if then for to of in" },
    { content: "fix the and or but if then for to of in" },
  ];
  const ex = extractTopicsFromTodos(todos);
  // "fix" is stopword too; everything else is < 3 chars or stopword.
  assert.equal(ex.topics.length, 0);
});

test("isLowConfidence — triggers when no topics and short query", () => {
  assert.equal(isLowConfidence({ query: "hi", topics: [], todoCount: 1 }), true);
  assert.equal(isLowConfidence({ query: "", topics: [], todoCount: 0 }), true);
});

test("isLowConfidence — passes with >=2 topics", () => {
  assert.equal(
    isLowConfidence({ query: "x", topics: ["alpha", "beta"], todoCount: 2 }),
    false,
  );
});

test("isLowConfidence — passes with long query even if no topics", () => {
  assert.equal(
    isLowConfidence({
      query: "implement a complete user-prompt-submit hook end to end",
      topics: [],
      todoCount: 1,
    }),
    false,
  );
});

test("formatHintBlock — emits todo-plan trigger + load instruction", () => {
  const hits: RecallHit[] = [
    {
      id: "bastra-projekt-ubersicht-master",
      title: "Bastra Projekt Übersicht",
      type: "project-fact",
      scope: "bastra-recall",
      summary: "Master entry covering the whole project.",
      score: 130,
    },
  ];
  const block = formatHintBlock(hits, "bastra-recall", ["daemon", "hook"]);
  assert.match(block, /<recall-hints surface="claude-code" trigger="todo-plan"/);
  assert.match(block, /project="bastra-recall"/);
  assert.match(block, /topics="daemon,hook"/);
  assert.match(block, /Before starting these todos, load the project-facts/);
  assert.match(block, /bastra-projekt-ubersicht-master/);
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

test("integration — TodoWrite with topical todos yields hints + type=project-fact filter", async () => {
  let received: { url: string | undefined; body: { type?: string; query?: string } } | null =
    null;
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
              id: "bastra-projekt-ubersicht-master",
              title: "Bastra Projekt Übersicht",
              type: "project-fact",
              scope: "bastra-recall",
              summary: "Master entry.",
              score: 135,
            },
          ],
          vault_size: 100,
          latency_ms: 10,
          recall_id: "test",
        }),
      );
    });
  });

  try {
    const { stdout } = await runHook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "TodoWrite",
        cwd: process.cwd(),
        tool_input: {
          todos: [
            { content: "Implement bastra-recall daemon hook for TodoWrite", status: "pending" },
            { content: "Wire up bastra-recall daemon telemetry", status: "pending" },
            { content: "Test the daemon hook pipeline", status: "pending" },
          ],
        },
      },
      { BASTRA_HTTP_URL: `http://127.0.0.1:${daemon.port}` },
    );

    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput?: { additionalContext?: string; hookEventName?: string };
    };
    assert.ok(parsed.hookSpecificOutput, "hook should emit hookSpecificOutput");
    assert.equal(parsed.hookSpecificOutput?.hookEventName, "PreToolUse");
    const ctx = parsed.hookSpecificOutput?.additionalContext ?? "";
    assert.match(ctx, /trigger="todo-plan"/);
    assert.match(ctx, /bastra-projekt-ubersicht-master/);

    assert.ok(received, "mock daemon should have been called");
    const r = received as { url: string | undefined; body: { type?: string; query?: string } };
    assert.equal(r.url, "/hook/recall");
    assert.equal(r.body.type, "project-fact", "must filter by type=project-fact");
    assert.match(r.body.query ?? "", /daemon/);
  } finally {
    await daemon.close();
  }
});

test("integration — low-confidence todos emit empty object", async () => {
  let hit = false;
  const daemon = await startMockDaemon((_req, res) => {
    hit = true;
    res.writeHead(200);
    res.end('{"hits":[],"vault_size":0,"latency_ms":1,"recall_id":"x"}');
  });
  try {
    const { stdout } = await runHook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "TodoWrite",
        tool_input: { todos: [{ content: "ok", status: "pending" }] },
      },
      { BASTRA_HTTP_URL: `http://127.0.0.1:${daemon.port}` },
    );
    assert.equal(stdout.trim(), "{}");
    assert.equal(hit, false, "daemon must not be called for low-confidence todos");
  } finally {
    await daemon.close();
  }
});

test("integration — wrong tool_name emits empty object", async () => {
  const daemon = await startMockDaemon((_req, res) => {
    res.writeHead(200);
    res.end("{}");
  });
  try {
    const { stdout } = await runHook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: "/tmp/x.ts" },
      },
      { BASTRA_HTTP_URL: `http://127.0.0.1:${daemon.port}` },
    );
    assert.equal(stdout.trim(), "{}");
  } finally {
    await daemon.close();
  }
});
