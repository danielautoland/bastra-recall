/**
 * Smoke test for the telemetry module.
 * Writes one event of each kind to a tmp log dir, then verifies the
 * JSONL contains them with the right correlation ids.
 *
 * Run: npm run smoke:telemetry
 */
import { Telemetry } from "../src/telemetry.js";
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

const TMP_LOG = "/tmp/bastra-recall-telemetry-smoke";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function main(): Promise<void> {
  await rm(TMP_LOG, { recursive: true, force: true });
  process.env.BASTRA_LOG_PATH = TMP_LOG;
  process.env.BASTRA_TELEMETRY = "on";

  const t = new Telemetry();
  assert(t.isEnabled(), "telemetry should be enabled by default");

  const recallId = t.newRecallId();
  await t.logRecall({
    recall_id: recallId,
    query: "test query",
    k: 5,
    scope: null,
    type: null,
    vault_size: 64,
    hit_count: 1,
    top_score: 525.4,
    hits: [{ id: "foo", score: 525.4, type: "lesson" }],
    latency_ms: 4,
  });

  const followup = t.recentRecallId();
  assert(followup === recallId, "recentRecallId should return the just-created id");

  await t.logLoadMemory({ id: "foo", found: true, follows_recall: followup });
  await t.logSaveMemory({
    id: "bar",
    type: "lesson",
    scope: "test",
    title: "Bar",
    tag_count: 2,
    recall_when_count: 3,
    body_chars: 120,
    overwrite: false,
    created: true,
    follows_recall: followup,
  });

  const files = await readdir(TMP_LOG);
  assert(files.length === 1, `expected 1 log file, got ${files.length}`);

  const content = await readFile(join(TMP_LOG, files[0]), "utf8");
  const lines = content.trim().split("\n").filter(Boolean);
  assert(lines.length === 3, `expected 3 events, got ${lines.length}`);

  const events = lines.map((l) => JSON.parse(l));
  assert(events[0].kind === "recall", "first event must be recall");
  assert(events[1].kind === "load_memory", "second event must be load_memory");
  assert(events[2].kind === "save_memory", "third event must be save_memory");
  assert(
    events[1].follows_recall === events[0].recall_id,
    "load_memory should reference the recall_id",
  );
  assert(
    events[2].follows_recall === events[0].recall_id,
    "save_memory should reference the recall_id",
  );
  assert(
    events[0].session_id === events[1].session_id &&
      events[1].session_id === events[2].session_id,
    "all events from the same Telemetry instance share session_id",
  );

  // Disable check
  delete process.env.BASTRA_TELEMETRY;
  process.env.BASTRA_TELEMETRY = "off";
  const off = new Telemetry();
  assert(!off.isEnabled(), "telemetry should be disabled when BASTRA_TELEMETRY=off");

  await rm(TMP_LOG, { recursive: true, force: true });
  console.error(`[telemetry-smoke] PASS — ${lines.length} events, correlation ok`);
}

main().catch((err) => {
  console.error("[telemetry-smoke] FAIL:", err);
  process.exit(1);
});
