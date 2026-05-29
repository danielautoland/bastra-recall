import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { request as httpRequest } from "node:http";
import { FORWARDER_SCRIPT_PATH, CLAUDE_DESKTOP_CONFIG, CLAUDE_CODE_CONFIG } from "./paths.js";
import type { InstallOpts } from "./types.js";

export const VERSION = "0.6.0-beta.1";
export const SERVER_KEY = "bastra-recall";
const DAEMON_HEALTH_URL = "http://127.0.0.1:6723/health";

export interface McpServerBlock {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function buildServerBlock(vaultPath: string): McpServerBlock {
  return {
    command: "node",
    args: [FORWARDER_SCRIPT_PATH],
    env: { BASTRA_VAULT_PATH: vaultPath },
  };
}

export function blocksMatch(existing: unknown, target: McpServerBlock): boolean {
  if (typeof existing !== "object" || existing === null) return false;
  const x = existing as Record<string, unknown>;
  if (x.command !== target.command) return false;
  if (!Array.isArray(x.args) || x.args.length !== target.args.length) return false;
  for (let i = 0; i < target.args.length; i++) if (x.args[i] !== target.args[i]) return false;
  const xenv = x.env;
  if (typeof xenv !== "object" || xenv === null) return false;
  const e = xenv as Record<string, unknown>;
  if (Object.keys(e).length !== Object.keys(target.env).length) return false;
  for (const [k, v] of Object.entries(target.env)) if (e[k] !== v) return false;
  return true;
}

export async function fileExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

export interface ParsedConfig { data: Record<string, unknown>; existed: boolean; }

export async function readJsonConfig(p: string): Promise<ParsedConfig | { error: string }> {
  if (!(await fileExists(p))) return { data: {}, existed: false };
  let raw: string;
  try { raw = await readFile(p, "utf8"); }
  catch (e) { return { error: `cannot read ${p}: ${(e as Error).message}` }; }
  if (raw.trim() === "") return { data: {}, existed: true };
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { error: `${p} is valid JSON but not an object — refusing to edit` };
    }
    return { data: parsed as Record<string, unknown>, existed: true };
  } catch (e) {
    return { error: `${p} has invalid JSON: ${(e as Error).message} — refusing to edit (fix it manually first)` };
  }
}

export async function backupConfig(configPath: string): Promise<string | null> {
  if (!(await fileExists(configPath))) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${configPath}.bak-${ts}`;
  await copyFile(configPath, backupPath);
  return backupPath;
}

export async function atomicWriteJson(configPath: string, data: unknown): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  const tmp = `${configPath}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  await rename(tmp, configPath);
}

async function detectExistingVault(): Promise<string | null> {
  const candidates = [CLAUDE_DESKTOP_CONFIG, CLAUDE_CODE_CONFIG];
  for (const c of candidates) {
    try {
      const raw = await readFile(c, "utf8");
      const data = JSON.parse(raw);
      const vault = data?.mcpServers?.[SERVER_KEY]?.env?.BASTRA_VAULT_PATH;
      if (typeof vault === "string" && vault.length > 0) return vault;
    } catch { /* ignore — try next */ }
  }
  return null;
}

export async function resolveVault(opts: InstallOpts): Promise<{ path: string } | { error: string }> {
  if (opts.vaultPath) return { path: opts.vaultPath };
  const env = process.env.BASTRA_VAULT_PATH;
  if (env && env.length > 0) return { path: env };
  const detected = await detectExistingVault();
  if (detected) return { path: detected };
  return {
    error: "vault path required — pass --vault <path>, set BASTRA_VAULT_PATH, or install for another surface first (vault is auto-detected from existing registrations)",
  };
}

export function probeDaemon(): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve_) => {
    const req = httpRequest(DAEMON_HEALTH_URL, { method: "GET", timeout: 1500 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          if (res.statusCode === 200 && data?.ok) {
            resolve_({ ok: true, detail: `vault_size=${data.vault_size}` });
            return;
          }
        } catch { /* fallthrough */ }
        resolve_({ ok: false, detail: `daemon answered but health unexpected (status=${res.statusCode})` });
      });
    });
    req.on("timeout", () => { req.destroy(); resolve_({ ok: false, detail: "timeout (no daemon listening — forwarder will auto-spawn on first MCP call)" }); });
    req.on("error", (e) => resolve_({ ok: false, detail: `not reachable: ${(e as NodeJS.ErrnoException).code ?? e.message} (forwarder will auto-spawn on first MCP call)` }));
    req.end();
  });
}

export function getServersBlock(data: Record<string, unknown>): Record<string, unknown> | null {
  const s = data.mcpServers;
  if (s && typeof s === "object" && !Array.isArray(s)) return s as Record<string, unknown>;
  return null;
}

export function formatStatus(status: string): string {
  switch (status) {
    case "installed": return "✓ installed";
    case "already-installed": return "= already installed";
    case "would-install": return "~ would install (dry-run)";
    case "removed": return "✓ removed";
    case "not-present": return "= not present";
    case "would-remove": return "~ would remove (dry-run)";
    case "ok": return "✓ ok";
    case "missing": return "✗ missing";
    case "broken": return "✗ broken";
    case "not-implemented": return "… not implemented yet";
    case "error": return "✗ error";
    default: return status;
  }
}
