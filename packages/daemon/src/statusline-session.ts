/**
 * Per-session statusline feed paths.
 *
 * Claude Code does NOT send a session identifier to MCP servers
 * (anthropics/claude-code#41836), so the forwarder cannot know which CC
 * session it belongs to from the protocol. But the forwarder, the
 * prompt-hook, and the statusline subprocess of ONE session all share the
 * same `claude` ancestor process. We walk the parent chain up to that
 * `claude` process and use its PID to namespace the feed file — so
 * concurrent sessions never clobber each other's counters.
 *
 * Feed layout: ~/.bastra/statusline/<claude-session-pid>.json
 */
import { execFileSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

export const STATUSLINE_DIR = path.join(os.homedir(), ".bastra", "statusline");

/**
 * Walk the parent-process chain (starting from our parent) up to the
 * nearest `claude` process and return its PID. One `ps` call, then an
 * in-memory walk. Falls back to `process.ppid` if `claude` isn't found.
 */
export function claudeSessionPid(): number {
  try {
    const out = execFileSync("ps", ["-axo", "pid=,ppid=,comm="], {
      encoding: "utf8",
    });
    const procs = new Map<number, { ppid: number; comm: string }>();
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (m) {
        procs.set(parseInt(m[1], 10), {
          ppid: parseInt(m[2], 10),
          comm: m[3] ?? "",
        });
      }
    }
    let pid = process.ppid;
    for (let i = 0; i < 12 && pid > 1; i++) {
      const e = procs.get(pid);
      if (!e) break;
      // comm is typically a basename like "claude"; match defensively.
      if (/(^|\/)claude\b/i.test(e.comm) || e.comm.toLowerCase().includes("claude"))
        return pid;
      if (e.ppid === pid) break;
      pid = e.ppid;
    }
  } catch {
    // ps unavailable / parse error — fall through to ppid
  }
  return process.ppid;
}

export function sessionFeedPath(sessionPid: number): string {
  return path.join(STATUSLINE_DIR, `${sessionPid}.json`);
}
