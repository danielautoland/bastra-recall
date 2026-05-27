/**
 * CLI-side update-hint (#39).
 *
 * After any `bastra <subcommand>` returns, optionally emits a dim 2-line
 * hint to stderr if a new release is available. Cheap: probes /health on
 * 127.0.0.1:6723 with a tight timeout (700 ms). Throttled to once per day
 * via ~/.bastra/update-hint-shown.txt (one ISO date per line, plain).
 *
 * Opt-out via env BASTRA_UPDATE_CHECK=off.
 *
 * Never throws — every failure path is silently swallowed.
 */
import { request as httpRequest } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { isOptedOut } from "../update-check.js";

const HEALTH_URL = "http://127.0.0.1:6723/health";
const PROBE_TIMEOUT_MS = 700;

interface HealthUpdate {
  current: string;
  latest: string;
  html_url: string;
  published_at: string;
}

interface HealthResponse {
  ok: boolean;
  update_available: HealthUpdate | null;
}

function shownFilePath(): string {
  return join(homedir(), ".bastra", "update-hint-shown.txt");
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

async function alreadyShownToday(path: string): Promise<boolean> {
  try {
    const raw = await readFile(path, "utf8");
    return raw.split("\n").some((line) => line.trim() === todayISO());
  } catch {
    return false;
  }
}

async function markShownToday(path: string): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    let existing = "";
    try {
      existing = await readFile(path, "utf8");
    } catch { /* file may not exist */ }
    const lines = existing
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (!lines.includes(todayISO())) lines.push(todayISO());
    // Keep last 30 entries — bounded growth.
    const trimmed = lines.slice(-30);
    await writeFile(path, trimmed.join("\n") + "\n", "utf8");
  } catch {
    // Best-effort.
  }
}

function probeHealth(): Promise<HealthResponse | null> {
  return new Promise((resolve_) => {
    const req = httpRequest(HEALTH_URL, { method: "GET", timeout: PROBE_TIMEOUT_MS }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString("utf8")) as HealthResponse;
          if (res.statusCode === 200 && data && data.ok) {
            resolve_(data);
            return;
          }
        } catch { /* fallthrough */ }
        resolve_(null);
      });
    });
    req.on("timeout", () => { req.destroy(); resolve_(null); });
    req.on("error", () => resolve_(null));
    req.end();
  });
}

/**
 * Emits an update hint to stderr if a daemon-reported update is available and
 * the throttle hasn't fired today. Returns true if a hint was printed.
 */
export async function maybeEmitUpdateHint(): Promise<boolean> {
  if (isOptedOut()) return false;
  if (await alreadyShownToday(shownFilePath())) return false;

  const health = await probeHealth();
  if (!health || !health.update_available) return false;

  const u = health.update_available;
  // Dim hint, written to stderr so it doesn't pollute pipeable subcommand output.
  // ANSI 2 = dim — many shells honor it; if not, plain text is still readable.
  process.stderr.write(
    `\n\x1b[2mℹ A new bastra-recall is available: ${u.latest} (you have ${u.current})\n` +
      `  → run: bastra update\x1b[0m\n`,
  );

  await markShownToday(shownFilePath());
  return true;
}
