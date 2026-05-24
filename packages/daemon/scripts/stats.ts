/**
 * Read ~/.bastra/logs/events-*.jsonl (mit Legacy-Fallback auf
 * ~/.nexus-recall/logs/) and print a summary.
 *
 * Usage:
 *   npx tsx packages/daemon/scripts/stats.ts            # all-time
 *   npx tsx packages/daemon/scripts/stats.ts --days 7   # last 7 days
 */
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function defaultLogDir(): string {
  const next = join(homedir(), ".bastra", "logs");
  const legacy = join(homedir(), ".nexus-recall", "logs");
  if (existsSync(next)) return next;
  if (existsSync(legacy)) return legacy;
  return next;
}

const LOG_DIR =
  process.env.BASTRA_LOG_PATH ?? process.env.NEXUS_LOG_PATH ?? defaultLogDir();

const daysArg = process.argv.indexOf("--days");
const DAYS: number | null =
  daysArg >= 0 && process.argv[daysArg + 1] ? parseInt(process.argv[daysArg + 1], 10) : null;

interface AnyEvent {
  kind: string;
  ts: string;
  [k: string]: unknown;
}

function pct(n: number, total: number): string {
  if (total === 0) return "—";
  return `${((n / total) * 100).toFixed(1)}%`;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function p95(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
}

async function loadEvents(): Promise<AnyEvent[]> {
  let files: string[];
  try {
    files = (await readdir(LOG_DIR)).filter((f) => f.startsWith("events-") && f.endsWith(".jsonl"));
  } catch {
    console.error(`no logs found at ${LOG_DIR}`);
    process.exit(1);
  }
  files.sort();

  const cutoff = DAYS !== null ? Date.now() - DAYS * 24 * 60 * 60 * 1000 : 0;
  const out: AnyEvent[] = [];
  for (const f of files) {
    const raw = await readFile(join(LOG_DIR, f), "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as AnyEvent;
        if (cutoff && new Date(e.ts).getTime() < cutoff) continue;
        out.push(e);
      } catch {
        // skip malformed
      }
    }
  }
  return out;
}

function summarizeHook(events: AnyEvent[]): void {
  const calls = events.filter((e) => e.kind === "hook_call");
  const recalls = events.filter((e) => e.kind === "hook_recall");

  if (calls.length === 0) {
    console.log("no hook_call events.");
    return;
  }

  const statuses = new Map<string, number>();
  const reachable = calls.filter((e) => e.daemon_reachable === true).length;
  for (const c of calls) {
    const s = String(c.status ?? "unknown");
    statuses.set(s, (statuses.get(s) ?? 0) + 1);
  }

  const totalLatencies = calls.map((c) => Number(c.latency_ms_total ?? 0));
  const recallLatencies = recalls.map((r) => Number(r.latency_ms_recall ?? 0));
  const httpLatencies = recalls.map((r) => Number(r.latency_ms_total ?? 0));

  const hintCounts = calls.map((c) => Number(c.hint_count ?? 0));
  const withHints = hintCounts.filter((n) => n > 0).length;

  const topScores = calls
    .map((c) => (c.top_score === null ? null : Number(c.top_score)))
    .filter((s): s is number => s !== null);
  const above100 = topScores.filter((s) => s >= 100).length;
  const above50 = topScores.filter((s) => s >= 50 && s < 100).length;
  const above30 = topScores.filter((s) => s >= 30 && s < 50).length;
  const below30 = topScores.filter((s) => s < 30).length;

  console.log(`\n## PreToolUse hook  (${calls.length} invocations)`);
  console.log(`  daemon reachable: ${reachable}  (${pct(reachable, calls.length)})`);
  console.log(`  with hints:       ${withHints}  (${pct(withHints, calls.length)})`);
  console.log(`  status breakdown:`);
  for (const [s, n] of [...statuses.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`     ${n.toString().padStart(4)}  ${s}`);
  }
  console.log(`  hook latency_ms_total:   median ${median(totalLatencies).toFixed(0).padStart(4)}   p95 ${p95(totalLatencies).toFixed(0).padStart(4)}`);
  console.log(`  daemon latency_ms_recall: median ${median(recallLatencies).toFixed(0).padStart(4)}   p95 ${p95(recallLatencies).toFixed(0).padStart(4)}`);
  console.log(`  daemon latency_ms_total: median ${median(httpLatencies).toFixed(0).padStart(4)}   p95 ${p95(httpLatencies).toFixed(0).padStart(4)}`);
  console.log(`  top-score distribution (only calls with hits):`);
  console.log(`     ≥ 100:  ${above100.toString().padStart(4)}  (${pct(above100, topScores.length)})`);
  console.log(`     50-99:  ${above50.toString().padStart(4)}  (${pct(above50, topScores.length)})`);
  console.log(`     30-49:  ${above30.toString().padStart(4)}  (${pct(above30, topScores.length)})`);
  console.log(`     <  30:  ${below30.toString().padStart(4)}  (${pct(below30, topScores.length)})`);
}

function summarizeSessionHook(events: AnyEvent[]): void {
  const calls = events.filter((e) => e.kind === "session_hook_call");
  if (calls.length === 0) return;

  const reachable = calls.filter((e) => e.daemon_reachable === true).length;
  const withHints = calls.filter((c) => Number(c.hint_count ?? 0) > 0).length;
  const lats = calls.map((c) => Number(c.latency_ms_total ?? 0));
  const sources = new Map<string, number>();
  for (const c of calls) {
    const s = String(c.source ?? "unknown");
    sources.set(s, (sources.get(s) ?? 0) + 1);
  }

  console.log(`\n## SessionStart hook  (${calls.length} invocations)`);
  console.log(`  daemon reachable: ${reachable}  (${pct(reachable, calls.length)})`);
  console.log(`  with hints:       ${withHints}  (${pct(withHints, calls.length)})`);
  console.log(`  latency_ms_total: median ${median(lats).toFixed(0)}   p95 ${p95(lats).toFixed(0)}`);
  console.log(`  by source:`);
  for (const [s, n] of [...sources.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`     ${n.toString().padStart(4)}  ${s}`);
  }
}

function summarizeMcp(events: AnyEvent[]): void {
  const recalls = events.filter((e) => e.kind === "recall");
  const loads = events.filter((e) => e.kind === "load_memory");
  const saves = events.filter((e) => e.kind === "save_memory");

  console.log(`\n## MCP tools`);
  console.log(`  recall:       ${recalls.length}`);
  console.log(`  load_memory:  ${loads.length}`);
  console.log(`  save_memory:  ${saves.length}`);

  if (recalls.length) {
    const lats = recalls.map((r) => Number(r.latency_ms ?? 0));
    console.log(`  recall latency_ms: median ${median(lats).toFixed(0)}   p95 ${p95(lats).toFixed(0)}`);
  }

  // Save → was there a preceding recall?
  if (saves.length) {
    const followsRecall = saves.filter((s) => s.follows_recall != null).length;
    console.log(`  saves following a recall (≤5min): ${followsRecall} of ${saves.length}  (${pct(followsRecall, saves.length)})`);
  }
}

function summarizeFollowThrough(events: AnyEvent[]): void {
  const loads = events.filter((e) => e.kind === "load_memory");
  const hookRecalls = events.filter((e) => e.kind === "hook_recall");
  if (loads.length === 0 && hookRecalls.length === 0) return;

  const fromHook = loads.filter((l) => l.from_hook_recall != null);
  const distinctHookRecallsConsumed = new Set(
    fromHook.map((l) => String(l.from_hook_recall)),
  );

  const rankCounts = new Map<number, number>();
  for (const l of fromHook) {
    const r = Number(l.hook_hint_rank ?? 0);
    if (r > 0) rankCounts.set(r, (rankCounts.get(r) ?? 0) + 1);
  }

  console.log(`\n## Follow-through  (did hook hints actually get loaded?)`);
  console.log(`  load_memory total:                ${loads.length}`);
  console.log(`  load_memory triggered by a hint:  ${fromHook.length}  (${pct(fromHook.length, loads.length)})`);
  console.log(`  hook_recalls that produced ≥1 load: ${distinctHookRecallsConsumed.size} of ${hookRecalls.length}  (${pct(distinctHookRecallsConsumed.size, hookRecalls.length)})`);
  if (rankCounts.size > 0) {
    console.log(`  loaded-from-hint by rank in hint list:`);
    for (const [r, n] of [...rankCounts.entries()].sort((a, b) => a[0] - b[0])) {
      console.log(`     rank ${r}:  ${n.toString().padStart(4)}`);
    }
  }
}

function topHints(events: AnyEvent[]): void {
  const recalls = events.filter((e) => e.kind === "hook_recall" && Array.isArray(e.hits));
  const idCount = new Map<string, number>();
  for (const r of recalls) {
    const hits = r.hits as Array<{ id: string; score: number }>;
    for (const h of hits.slice(0, 1)) {
      // Only count the top hit per call to avoid inflating long-tail.
      idCount.set(h.id, (idCount.get(h.id) ?? 0) + 1);
    }
  }
  if (idCount.size === 0) return;
  const top = [...idCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log(`\n## Top-hit memorys (rank 1 from hook recall)`);
  for (const [id, n] of top) {
    console.log(`  ${n.toString().padStart(4)}  ${id}`);
  }
}

function topProjects(events: AnyEvent[]): void {
  const recalls = events.filter((e) => e.kind === "hook_recall");
  const projCount = new Map<string, number>();
  for (const r of recalls) {
    const p = r.project ? String(r.project) : "(no-project)";
    projCount.set(p, (projCount.get(p) ?? 0) + 1);
  }
  if (projCount.size === 0) return;
  console.log(`\n## Hook calls by project`);
  for (const [p, n] of [...projCount.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n.toString().padStart(4)}  ${p}`);
  }
}

async function main(): Promise<void> {
  const events = await loadEvents();
  if (events.length === 0) {
    console.log("no events in window.");
    return;
  }
  const window = DAYS ? `last ${DAYS} day(s)` : "all-time";
  console.log(`# nexus-recall stats — ${window}`);
  console.log(`logs: ${LOG_DIR}`);
  console.log(`events: ${events.length}`);

  summarizeHook(events);
  summarizeSessionHook(events);
  summarizeMcp(events);
  summarizeFollowThrough(events);
  topProjects(events);
  topHints(events);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
