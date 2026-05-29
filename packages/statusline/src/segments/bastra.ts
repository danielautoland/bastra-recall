import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * bastra-recall statusline segment.
 *
 * Reads the per-session feed written by the bastra-recall MCP forwarder:
 *   ~/.bastra/statusline/<claude-session-pid>.json
 *
 * Claude Code sends no session id to MCP servers (anthropics/claude-code
 * #41836), so the feed is namespaced by the shared `claude` ancestor PID
 * of the session's forwarder, prompt-hook, and this statusline process.
 * We walk our own parent chain up to `claude` to find the matching feed.
 *
 * Best-effort: any read/parse failure yields null → segment renders
 * nothing (never errors, never blanks).
 */

const STATUSLINE_DIR = path.join(os.homedir(), ".bastra", "statusline");

export interface BastraInfo {
  state: "idle" | "running";
  vaultSize: number;
  recallCount: number;
  totalHits: number;
  totalMs: number;
  currentStage: string | null;
  currentStageStartedAt: number | null;
  currentRecallStartedAt: number | null;
}

/** Walk parent chain up to the `claude` session process; its PID namespaces
 *  the feed. One `ps` call + in-memory walk. Falls back to process.ppid. */
function claudeSessionPid(): number {
  try {
    const out = execFileSync("ps", ["-axo", "pid=,ppid=,comm="], {
      encoding: "utf8",
    });
    const procs = new Map<number, { ppid: number; comm: string }>();
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (m) {
        procs.set(parseInt(m[1]!, 10), {
          ppid: parseInt(m[2]!, 10),
          comm: m[3] ?? "",
        });
      }
    }
    let pid = process.ppid;
    for (let i = 0; i < 12 && pid > 1; i++) {
      const e = procs.get(pid);
      if (!e) break;
      if (e.comm.toLowerCase().includes("claude")) return pid;
      if (e.ppid === pid) break;
      pid = e.ppid;
    }
  } catch {
    // ps unavailable — fall through to ppid
  }
  return process.ppid;
}

export class BastraProvider {
  getBastraInfo(): BastraInfo | null {
    const feed = path.join(STATUSLINE_DIR, `${claudeSessionPid()}.json`);
    try {
      const raw = fs.readFileSync(feed, "utf8");
      const d = JSON.parse(raw) as Record<string, unknown>;
      const state = d.state === "running" ? "running" : "idle";
      return {
        state,
        vaultSize: numOr(d.vault_size, 0),
        recallCount: numOr(d.recall_count, 0),
        totalHits: numOr(d.total_hits, 0),
        totalMs: numOr(d.total_ms, 0),
        currentStage:
          typeof d.current_stage === "string" ? d.current_stage : null,
        currentStageStartedAt: numOrNull(d.current_stage_started_at),
        currentRecallStartedAt: numOrNull(d.current_recall_started_at),
      };
    } catch {
      return null;
    }
  }
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
