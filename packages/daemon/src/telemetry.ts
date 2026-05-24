import { appendFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { envFirst } from "./env.js";

/**
 * Migration-aware default log directory: prefer `~/.bastra/logs`, aber
 * solange das alte `~/.nexus-recall/logs` existiert und das neue noch
 * nicht, lesen wir aus dem alten weiter — damit Daniels existing
 * telemetry beim Migrationsfenster nicht orphan wird. Sobald die Mac-App
 * den `~/.nexus-recall/`-Folder nach `~/.bastra/` verschoben hat (siehe
 * Bastra.AppDelegate Migration), nimmt sich der daemon den neuen Pfad.
 */
function defaultLogDir(): string {
  const next = join(homedir(), ".bastra", "logs");
  const legacy = join(homedir(), ".nexus-recall", "logs");
  if (existsSync(next)) return next;
  if (existsSync(legacy)) return legacy;
  return next;
}

export type TelemetryEvent =
  | RecallEvent
  | LoadMemoryEvent
  | SaveMemoryEvent
  | HookRecallEvent
  | HookCallEvent
  | SessionHookCallEvent;

interface BaseEvent {
  ts: string;
  session_id: string;
}

export interface RecallEvent extends BaseEvent {
  kind: "recall";
  recall_id: string;
  query: string;
  k: number | null;
  scope: string | null;
  type: string | null;
  vault_size: number;
  hit_count: number;
  top_score: number | null;
  hits: { id: string; score: number; type: string }[];
  latency_ms: number;
}

export interface LoadMemoryEvent extends BaseEvent {
  kind: "load_memory";
  id: string;
  found: boolean;
  follows_recall: string | null;
  /** recall_id of a recent hook_recall whose hits[] contained this id, if any. */
  from_hook_recall: string | null;
  /** Rank (1-based) at which this id appeared in that hook_recall's hits[]. */
  hook_hint_rank: number | null;
}

export interface SaveMemoryEvent extends BaseEvent {
  kind: "save_memory";
  id: string;
  type: string;
  scope: string;
  title: string;
  tag_count: number;
  recall_when_count: number;
  body_chars: number;
  overwrite: boolean;
  created: boolean;
  follows_recall: string | null;
}

/** Recall served from the HTTP /hook/recall endpoint (server-side view). */
export interface HookRecallEvent extends BaseEvent {
  kind: "hook_recall";
  recall_id: string;
  query: string;
  topics: string[];
  tool_name: string | null;
  project: string | null;
  k: number;
  scope: string | null;
  type: string | null;
  vault_size: number;
  hit_count: number;
  top_score: number | null;
  hits: { id: string; score: number; type: string }[];
  latency_ms_recall: number;
  latency_ms_total: number;
}

/** Hook CLI invocation (client-side view: total wall-clock incl. network). */
export interface HookCallEvent extends BaseEvent {
  kind: "hook_call";
  tool_name: string;
  file_path: string | null;
  topics: string[];
  query_chars: number;
  daemon_url: string;
  daemon_reachable: boolean;
  hint_count: number;
  top_score: number | null;
  latency_ms_total: number;
  status: "ok" | "no-hits" | "daemon-unreachable" | "timeout" | "error";
  error: string | null;
}

/**
 * SessionStart hook CLI invocation. Fires once per Claude Code session
 * (also after /clear, /resume, and auto-compact via the `source` field).
 * Logged client-side because the session hook makes 2-3 sub-recalls and
 * we want one row per session, not per scope.
 */
export interface SessionHookCallEvent extends BaseEvent {
  kind: "session_hook_call";
  source: string | null;
  project: string | null;
  queries: number;
  daemon_url: string;
  daemon_reachable: boolean;
  hint_count: number;
  top_score: number | null;
  latency_ms_total: number;
  status: "ok" | "no-hits" | "daemon-unreachable" | "timeout" | "error";
  error: string | null;
}

const RECALL_FOLLOWUP_WINDOW_MS = 5 * 60 * 1000;
/**
 * Window during which a load_memory call is treated as a follow-up to a
 * hook_recall hint. A bit longer than the MCP recall→save window because
 * the user has to actually read the hint, decide it's relevant, and ask
 * Claude to load the memory — that round-trip can take a few minutes.
 */
const HOOK_HINT_WINDOW_MS = 10 * 60 * 1000;

interface HookHintTrace {
  recall_id: string;
  rank: number;
  ts: number;
}

export class Telemetry {
  private readonly enabled: boolean;
  private readonly logDir: string;
  private readonly sessionId: string;
  private lastRecall: { id: string; ts: number } | null = null;
  /** Map<memory_id, most-recent HookHintTrace>. Older traces are evicted lazily. */
  private hookHints = new Map<string, HookHintTrace>();
  private initPromise: Promise<void> | null = null;

  constructor() {
    this.enabled =
      (envFirst("BASTRA_TELEMETRY", "NEXUS_TELEMETRY") ?? "on").toLowerCase() !== "off";
    // Log-Pfad bleibt bei `~/.nexus-recall/logs` bis zur User-Data-Migration
    // (Daniel hat existing logs, die wir nicht orphanen wollen).
    this.logDir =
      envFirst("BASTRA_LOG_PATH", "NEXUS_LOG_PATH") ??
      defaultLogDir();
    this.sessionId = randomUUID();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  newRecallId(): string {
    const id = randomUUID();
    this.lastRecall = { id, ts: Date.now() };
    return id;
  }

  /** Returns the most recent recall_id if it's still within the follow-up window. */
  recentRecallId(): string | null {
    if (!this.lastRecall) return null;
    if (Date.now() - this.lastRecall.ts > RECALL_FOLLOWUP_WINDOW_MS) return null;
    return this.lastRecall.id;
  }

  /**
   * Record the rank-ordered hits returned by a hook_recall so that a later
   * load_memory(id) can report whether (and where) the id was hinted to the
   * user. Most-recent hint wins on collision.
   */
  recordHookHints(recall_id: string, hits: Array<{ id: string }>): void {
    const ts = Date.now();
    for (let i = 0; i < hits.length; i++) {
      this.hookHints.set(hits[i].id, { recall_id, rank: i + 1, ts });
    }
  }

  /**
   * Returns the recall_id + rank if this id was hinted in the last
   * HOOK_HINT_WINDOW_MS. Lazy-evicts the entry on miss.
   */
  findHookHintFor(id: string): { recall_id: string; rank: number } | null {
    const t = this.hookHints.get(id);
    if (!t) return null;
    if (Date.now() - t.ts > HOOK_HINT_WINDOW_MS) {
      this.hookHints.delete(id);
      return null;
    }
    return { recall_id: t.recall_id, rank: t.rank };
  }

  async logRecall(payload: Omit<RecallEvent, "kind" | "ts" | "session_id">): Promise<void> {
    if (!this.enabled) return;
    await this.write({
      kind: "recall",
      ts: new Date().toISOString(),
      session_id: this.sessionId,
      ...payload,
    });
  }

  async logLoadMemory(
    payload: Omit<LoadMemoryEvent, "kind" | "ts" | "session_id">,
  ): Promise<void> {
    if (!this.enabled) return;
    await this.write({
      kind: "load_memory",
      ts: new Date().toISOString(),
      session_id: this.sessionId,
      ...payload,
    });
  }

  async logSaveMemory(
    payload: Omit<SaveMemoryEvent, "kind" | "ts" | "session_id">,
  ): Promise<void> {
    if (!this.enabled) return;
    await this.write({
      kind: "save_memory",
      ts: new Date().toISOString(),
      session_id: this.sessionId,
      ...payload,
    });
  }

  async logHookRecall(
    payload: Omit<HookRecallEvent, "kind" | "ts" | "session_id">,
  ): Promise<void> {
    if (!this.enabled) return;
    await this.write({
      kind: "hook_recall",
      ts: new Date().toISOString(),
      session_id: this.sessionId,
      ...payload,
    });
  }

  async logHookCall(
    payload: Omit<HookCallEvent, "kind" | "ts" | "session_id">,
  ): Promise<void> {
    if (!this.enabled) return;
    await this.write({
      kind: "hook_call",
      ts: new Date().toISOString(),
      session_id: this.sessionId,
      ...payload,
    });
  }

  private async ensureDir(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = mkdir(this.logDir, { recursive: true }).then(() => undefined);
    }
    await this.initPromise;
  }

  private async write(event: TelemetryEvent): Promise<void> {
    try {
      await this.ensureDir();
      const day = event.ts.slice(0, 10);
      const file = join(this.logDir, `events-${day}.jsonl`);
      await appendFile(file, JSON.stringify(event) + "\n", "utf8");
    } catch (err) {
      // Telemetry must never break a tool call.
      console.error(`[bastra-recall] telemetry write failed: ${(err as Error).message}`);
    }
  }
}

export function fireAndForget(p: Promise<unknown>): void {
  p.catch((err) => {
    console.error(`[bastra-recall] telemetry: ${(err as Error).message}`);
  });
}

export function logDirFor(): string {
  return envFirst("BASTRA_LOG_PATH", "NEXUS_LOG_PATH") ?? defaultLogDir();
}

export { defaultLogDir };

// Re-export so consumers can build paths if needed.
export { dirname };
