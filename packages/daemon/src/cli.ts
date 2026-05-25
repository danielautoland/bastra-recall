#!/usr/bin/env node
/**
 * bastra — CLI to install/uninstall/check bastra-recall across AI clients.
 *
 * One command, every MCP-capable client: the user installs once and bastra-recall
 * is reachable from Claude Code, Claude Desktop, Cursor, etc. See vision in
 * bastra-recall#7 + memory `bastra-vision-universal-cross-surface-memory-onboarding`.
 *
 * Step 1 (this file): skeleton — argument parsing, subcommand dispatch, help,
 *   adapter registry, stubs for every surface.
 * Step 2: claude-desktop adapter implementation.
 * Step 3+: claude-code, cursor adapters.
 */

import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyFile, mkdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";

const VERSION = "0.1.0";

// ─── Adapter contract ────────────────────────────────────────────

interface InstallOpts {
  dryRun: boolean;
  vaultPath: string | null;
}

interface InstallResult {
  status: "installed" | "already-installed" | "would-install" | "error" | "not-implemented";
  message: string;
  configPath?: string;
  backupPath?: string;
}

interface UninstallResult {
  status: "removed" | "not-present" | "would-remove" | "error" | "not-implemented";
  message: string;
  configPath?: string;
  backupPath?: string;
}

interface DoctorResult {
  status: "ok" | "missing" | "broken" | "not-implemented";
  message: string;
  details?: Record<string, string>;
}

interface Adapter {
  surface: string;
  description: string;
  configPath: string;
  install(opts: InstallOpts): Promise<InstallResult>;
  uninstall(opts: { dryRun: boolean }): Promise<UninstallResult>;
  doctor(): Promise<DoctorResult>;
}

// ─── Shared adapter helpers ──────────────────────────────────────

const SERVER_KEY = "bastra-recall";
const DAEMON_HEALTH_URL = "http://127.0.0.1:6723/health";

// Absolute path to the forwarder script in this same package, regardless of
// whether the CLI is launched locally (`node dist/cli.js`), via `npx`, or
// from a brew-installed location.
const FORWARDER_SCRIPT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "mcp-forwarder.js",
);

interface McpServerBlock {
  command: string;
  args: string[];
  env: Record<string, string>;
}

function buildServerBlock(vaultPath: string): McpServerBlock {
  return {
    command: "node",
    args: [FORWARDER_SCRIPT_PATH],
    env: { BASTRA_VAULT_PATH: vaultPath },
  };
}

function blocksMatch(existing: unknown, target: McpServerBlock): boolean {
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

async function fileExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

interface ParsedConfig { data: Record<string, unknown>; existed: boolean; }

async function readJsonConfig(p: string): Promise<ParsedConfig | { error: string }> {
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

async function backupConfig(configPath: string): Promise<string | null> {
  if (!(await fileExists(configPath))) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${configPath}.bak-${ts}`;
  await copyFile(configPath, backupPath);
  return backupPath;
}

async function atomicWriteJson(configPath: string, data: unknown): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  const tmp = `${configPath}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  await rename(tmp, configPath);
}

async function detectExistingVault(): Promise<string | null> {
  // Try claude_desktop_config first, then claude.json — whichever already
  // has bastra-recall registered with a vault path.
  const candidates = [
    resolve(homedir(), "Library/Application Support/Claude/claude_desktop_config.json"),
    resolve(homedir(), ".claude.json"),
  ];
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

async function resolveVault(opts: InstallOpts): Promise<{ path: string } | { error: string }> {
  if (opts.vaultPath) return { path: opts.vaultPath };
  const env = process.env.BASTRA_VAULT_PATH;
  if (env && env.length > 0) return { path: env };
  const detected = await detectExistingVault();
  if (detected) return { path: detected };
  return {
    error: "vault path required — pass --vault <path>, set BASTRA_VAULT_PATH, or install for another surface first (vault is auto-detected from existing registrations)",
  };
}

function probeDaemon(): Promise<{ ok: boolean; detail: string }> {
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

function getServersBlock(data: Record<string, unknown>): Record<string, unknown> | null {
  const s = data.mcpServers;
  if (s && typeof s === "object" && !Array.isArray(s)) return s as Record<string, unknown>;
  return null;
}

// ─── claude-desktop adapter ──────────────────────────────────────

const CLAUDE_DESKTOP_CONFIG = resolve(
  homedir(),
  "Library/Application Support/Claude/claude_desktop_config.json",
);

async function claudeDesktopInstall(opts: InstallOpts): Promise<InstallResult> {
  const configPath = CLAUDE_DESKTOP_CONFIG;
  const vault = await resolveVault(opts);
  if ("error" in vault) return { status: "error", message: vault.error, configPath };

  const block = buildServerBlock(vault.path);
  const read = await readJsonConfig(configPath);
  if ("error" in read) return { status: "error", message: read.error, configPath };

  const data = read.data;
  const servers = getServersBlock(data) ?? {};

  if (blocksMatch(servers[SERVER_KEY], block)) {
    return {
      status: "already-installed",
      message: `'${SERVER_KEY}' already registered with matching forwarder + vault`,
      configPath,
    };
  }

  if (opts.dryRun) {
    return {
      status: "would-install",
      message: `would register '${SERVER_KEY}' (vault=${vault.path}, forwarder=${block.args[0]})`,
      configPath,
    };
  }

  const backupPath = await backupConfig(configPath);
  data.mcpServers = { ...servers, [SERVER_KEY]: block };
  await atomicWriteJson(configPath, data);

  return {
    status: "installed",
    message: `registered '${SERVER_KEY}' — restart Claude Desktop to pick it up`,
    configPath,
    backupPath: backupPath ?? undefined,
  };
}

async function claudeDesktopUninstall(opts: { dryRun: boolean }): Promise<UninstallResult> {
  const configPath = CLAUDE_DESKTOP_CONFIG;
  const read = await readJsonConfig(configPath);
  if ("error" in read) return { status: "error", message: read.error, configPath };
  if (!read.existed) return { status: "not-present", message: "config file doesn't exist", configPath };

  const data = read.data;
  const servers = getServersBlock(data);
  if (!servers || !(SERVER_KEY in servers)) {
    return { status: "not-present", message: `'${SERVER_KEY}' not registered`, configPath };
  }

  if (opts.dryRun) {
    return { status: "would-remove", message: `would remove '${SERVER_KEY}' from mcpServers`, configPath };
  }

  const backupPath = await backupConfig(configPath);
  delete servers[SERVER_KEY];
  data.mcpServers = servers;
  await atomicWriteJson(configPath, data);

  return {
    status: "removed",
    message: `removed '${SERVER_KEY}' — restart Claude Desktop to drop the connection`,
    configPath,
    backupPath: backupPath ?? undefined,
  };
}

async function claudeDesktopDoctor(): Promise<DoctorResult> {
  const configPath = CLAUDE_DESKTOP_CONFIG;
  const details: Record<string, string> = {};

  // 1. Claude Desktop installed?
  const appSupport = resolve(homedir(), "Library/Application Support/Claude");
  details["claude-desktop-app"] = (await fileExists(appSupport))
    ? "installed (~/Library/Application Support/Claude exists)"
    : "not detected";

  // 2. Config + registration
  const read = await readJsonConfig(configPath);
  if ("error" in read) return { status: "broken", message: read.error, details };
  details["config-file"] = read.existed ? "present" : "missing (created on first Desktop launch)";

  const servers = getServersBlock(read.data) ?? {};
  const registered = SERVER_KEY in servers;
  details["mcp-registration"] = registered ? "present" : "missing";

  if (registered) {
    const block = servers[SERVER_KEY] as Record<string, unknown>;
    const args = Array.isArray(block?.args) ? block.args : [];
    const fwd = args[0];
    if (typeof fwd === "string") {
      details["forwarder-path"] = (await fileExists(fwd)) ? `${fwd} (exists)` : `${fwd} (MISSING)`;
    } else {
      details["forwarder-path"] = "no path in args[0]";
    }
    const env = block?.env as Record<string, unknown> | undefined;
    const vault = env?.BASTRA_VAULT_PATH;
    if (typeof vault === "string") {
      details["vault-path"] = (await fileExists(vault)) ? `${vault} (exists)` : `${vault} (MISSING)`;
    } else {
      details["vault-path"] = "not set in env";
    }
  }

  // 3. Daemon reachable
  const probe = await probeDaemon();
  details["daemon-on-6723"] = probe.ok ? `reachable (${probe.detail})` : probe.detail;

  if (!registered) return { status: "missing", message: "not registered with Claude Desktop", details };
  const broken =
    details["forwarder-path"]?.includes("MISSING") === true ||
    details["vault-path"]?.includes("MISSING") === true ||
    details["forwarder-path"]?.startsWith("no ") === true ||
    details["vault-path"]?.startsWith("not ") === true;
  if (broken) return { status: "broken", message: "registered but referenced paths are missing or incomplete", details };
  return { status: "ok", message: "registered and looks healthy", details };
}

// ─── claude-code adapter helpers (skill + hooks) ─────────────────

const CLAUDE_CODE_CONFIG = resolve(homedir(), ".claude.json");
const CLAUDE_CODE_SETTINGS = resolve(homedir(), ".claude/settings.json");
const SKILL_TARGET_DIR = resolve(homedir(), ".claude/skills/bastra-recall");
const SKILL_TARGET_FILE = resolve(SKILL_TARGET_DIR, "SKILL.md");
const SKILL_SOURCE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "skill", "SKILL.md",
);
const PRE_TOOL_HOOK_BIN = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "hook.js",
);
const SESSION_HOOK_BIN = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "session-hook.js",
);

type SkillStepStatus = "installed" | "already-installed" | "would-install" | "removed" | "not-present" | "would-remove" | "error";

async function copySkill(opts: { dryRun: boolean }): Promise<{ status: SkillStepStatus; detail: string }> {
  if (!(await fileExists(SKILL_SOURCE_PATH))) {
    return { status: "error", detail: `skill source missing: ${SKILL_SOURCE_PATH}` };
  }
  if (await fileExists(SKILL_TARGET_FILE)) {
    const src = await readFile(SKILL_SOURCE_PATH, "utf8");
    const dst = await readFile(SKILL_TARGET_FILE, "utf8");
    if (src === dst) return { status: "already-installed", detail: `skill already at ${SKILL_TARGET_FILE}` };
  }
  if (opts.dryRun) {
    return { status: "would-install", detail: `would copy SKILL.md → ${SKILL_TARGET_FILE}` };
  }
  await mkdir(SKILL_TARGET_DIR, { recursive: true });
  await copyFile(SKILL_SOURCE_PATH, SKILL_TARGET_FILE);
  return { status: "installed", detail: `skill installed at ${SKILL_TARGET_FILE}` };
}

async function removeSkill(opts: { dryRun: boolean }): Promise<{ status: SkillStepStatus; detail: string }> {
  if (!(await fileExists(SKILL_TARGET_FILE))) {
    return { status: "not-present", detail: "skill not installed" };
  }
  if (opts.dryRun) {
    return { status: "would-remove", detail: `would remove ${SKILL_TARGET_FILE}` };
  }
  await rm(SKILL_TARGET_FILE, { force: true });
  try { await rmdir(SKILL_TARGET_DIR); } catch { /* dir not empty, leave it */ }
  return { status: "removed", detail: `removed skill at ${SKILL_TARGET_FILE}` };
}

interface HookBlock {
  matcher: string;
  hooks: Array<{
    type: string;
    command: string;
    timeout: number;
    __bastraRecall: true;
    __note: string;
  }>;
}

function buildPreToolHook(): HookBlock {
  return {
    matcher: "Write|Edit|MultiEdit|NotebookEdit",
    hooks: [{
      type: "command",
      command: `node ${PRE_TOOL_HOOK_BIN}`,
      timeout: 2,
      __bastraRecall: true,
      __note: "bastra-recall PreToolUse hook",
    }],
  };
}

function buildSessionHook(): HookBlock {
  return {
    matcher: "startup|resume|clear|compact",
    hooks: [{
      type: "command",
      command: `node ${SESSION_HOOK_BIN}`,
      timeout: 3,
      __bastraRecall: true,
      __note: "bastra-recall SessionStart hook",
    }],
  };
}

function isOurHookEntry(matcher: unknown): boolean {
  if (typeof matcher !== "object" || matcher === null) return false;
  const m = matcher as Record<string, unknown>;
  const hooks = Array.isArray(m.hooks) ? m.hooks : [];
  return hooks.some((h: unknown) => {
    if (typeof h !== "object" || h === null) return false;
    const hh = h as Record<string, unknown>;
    if (hh.__bastraRecall === true || hh.__nexusRecall === true) return true;
    const cmd = typeof hh.command === "string" ? hh.command : "";
    if (cmd.includes("/daemon/dist/hook.js")) return true;
    if (cmd.includes("/daemon/dist/session-hook.js")) return true;
    return false;
  });
}

type HookStepStatus = "installed" | "already-installed" | "would-install" | "removed" | "not-present" | "would-remove" | "error";

async function patchClaudeCodeHooks(action: "install" | "uninstall", opts: { dryRun: boolean }): Promise<{ status: HookStepStatus; detail: string; backupPath?: string }> {
  if (action === "install") {
    if (!(await fileExists(PRE_TOOL_HOOK_BIN))) return { status: "error", detail: `hook binary missing: ${PRE_TOOL_HOOK_BIN} — run 'npm run build'` };
    if (!(await fileExists(SESSION_HOOK_BIN))) return { status: "error", detail: `hook binary missing: ${SESSION_HOOK_BIN} — run 'npm run build'` };
  }

  const read = await readJsonConfig(CLAUDE_CODE_SETTINGS);
  if ("error" in read) return { status: "error", detail: read.error };

  const data = read.data;
  const hooks = (data.hooks && typeof data.hooks === "object" && !Array.isArray(data.hooks))
    ? data.hooks as Record<string, unknown>
    : {};

  const preTool = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  const session = Array.isArray(hooks.SessionStart) ? hooks.SessionStart : [];
  const newPreTool = preTool.filter((m) => !isOurHookEntry(m));
  const newSession = session.filter((m) => !isOurHookEntry(m));

  let target: { preTool: unknown[]; session: unknown[] };
  if (action === "install") {
    newPreTool.push(buildPreToolHook());
    newSession.push(buildSessionHook());
    target = { preTool: newPreTool, session: newSession };
  } else {
    target = { preTool: newPreTool, session: newSession };
  }

  const currentMatches =
    JSON.stringify(preTool) === JSON.stringify(target.preTool) &&
    JSON.stringify(session) === JSON.stringify(target.session);

  if (currentMatches) {
    return action === "install"
      ? { status: "already-installed", detail: "hooks already registered with matching paths" }
      : { status: "not-present", detail: "no bastra-recall hooks present" };
  }

  if (opts.dryRun) {
    return action === "install"
      ? { status: "would-install", detail: "would (re)register PreToolUse + SessionStart hooks" }
      : { status: "would-remove", detail: "would strip bastra-recall hook entries" };
  }

  // Commit changes
  if (target.preTool.length > 0) hooks.PreToolUse = target.preTool; else delete hooks.PreToolUse;
  if (target.session.length > 0) hooks.SessionStart = target.session; else delete hooks.SessionStart;
  data.hooks = hooks;

  const backupPath = await backupConfig(CLAUDE_CODE_SETTINGS);
  await atomicWriteJson(CLAUDE_CODE_SETTINGS, data);
  return action === "install"
    ? { status: "installed", detail: "PreToolUse + SessionStart registered", backupPath: backupPath ?? undefined }
    : { status: "removed", detail: "bastra-recall hook entries removed", backupPath: backupPath ?? undefined };
}

// ─── claude-code adapter ─────────────────────────────────────────

async function claudeCodeInstall(opts: InstallOpts): Promise<InstallResult> {
  const configPath = CLAUDE_CODE_CONFIG;
  const vault = await resolveVault(opts);
  if ("error" in vault) return { status: "error", message: vault.error, configPath };

  const block = buildServerBlock(vault.path);
  const read = await readJsonConfig(configPath);
  if ("error" in read) return { status: "error", message: read.error, configPath };

  const data = read.data;
  const servers = getServersBlock(data) ?? {};

  const mcpMatches = blocksMatch(servers[SERVER_KEY], block);
  const skillResult = await copySkill({ dryRun: opts.dryRun });
  const hookResult = await patchClaudeCodeHooks("install", { dryRun: opts.dryRun });

  if (skillResult.status === "error") return { status: "error", message: `skill: ${skillResult.detail}`, configPath };
  if (hookResult.status === "error") return { status: "error", message: `hooks: ${hookResult.detail}`, configPath };

  // If everything is already in place: no MCP write, no Skill write, no Hook write
  const allAlreadyInstalled =
    mcpMatches &&
    skillResult.status === "already-installed" &&
    hookResult.status === "already-installed";
  if (allAlreadyInstalled) {
    return {
      status: "already-installed",
      message: "MCP server, skill, and hooks all already in place",
      configPath,
    };
  }

  if (opts.dryRun) {
    const steps: string[] = [];
    if (!mcpMatches) steps.push(`mcp: would register '${SERVER_KEY}' in ${configPath}`);
    else steps.push("mcp: already matches");
    steps.push(`skill: ${skillResult.detail}`);
    steps.push(`hooks: ${hookResult.detail}`);
    return { status: "would-install", message: steps.join("\n  · "), configPath };
  }

  // Write MCP block (if changed)
  let backupPath: string | undefined;
  if (!mcpMatches) {
    backupPath = (await backupConfig(configPath)) ?? undefined;
    data.mcpServers = { ...servers, [SERVER_KEY]: block };
    await atomicWriteJson(configPath, data);
  }

  const lines: string[] = [];
  lines.push(mcpMatches ? "mcp: already matches" : `mcp: registered '${SERVER_KEY}'`);
  lines.push(`skill: ${skillResult.detail}`);
  lines.push(`hooks: ${hookResult.detail}`);
  lines.push("restart Claude Code to activate");

  return {
    status: "installed",
    message: lines.join("\n  · "),
    configPath,
    backupPath,
  };
}

async function claudeCodeUninstall(opts: { dryRun: boolean }): Promise<UninstallResult> {
  const configPath = CLAUDE_CODE_CONFIG;
  const read = await readJsonConfig(configPath);
  if ("error" in read) return { status: "error", message: read.error, configPath };

  const data = read.data;
  const servers = getServersBlock(data);
  const mcpPresent = !!(servers && SERVER_KEY in servers);

  const skillResult = await removeSkill({ dryRun: opts.dryRun });
  const hookResult = await patchClaudeCodeHooks("uninstall", { dryRun: opts.dryRun });

  if (!mcpPresent && skillResult.status === "not-present" && hookResult.status === "not-present") {
    return { status: "not-present", message: "nothing to remove", configPath };
  }

  if (opts.dryRun) {
    const steps: string[] = [];
    steps.push(mcpPresent ? `mcp: would remove '${SERVER_KEY}'` : "mcp: not present");
    steps.push(`skill: ${skillResult.detail}`);
    steps.push(`hooks: ${hookResult.detail}`);
    return { status: "would-remove", message: steps.join("\n  · "), configPath };
  }

  // Write MCP removal
  let backupPath: string | undefined;
  if (mcpPresent && servers) {
    backupPath = (await backupConfig(configPath)) ?? undefined;
    delete servers[SERVER_KEY];
    data.mcpServers = servers;
    await atomicWriteJson(configPath, data);
  }

  const lines: string[] = [];
  lines.push(mcpPresent ? `mcp: removed '${SERVER_KEY}'` : "mcp: not present");
  lines.push(`skill: ${skillResult.detail}`);
  lines.push(`hooks: ${hookResult.detail}`);
  lines.push("restart Claude Code to drop the connection");

  return {
    status: "removed",
    message: lines.join("\n  · "),
    configPath,
    backupPath,
  };
}

async function claudeCodeDoctor(): Promise<DoctorResult> {
  const configPath = CLAUDE_CODE_CONFIG;
  const details: Record<string, string> = {};

  // MCP entry in ~/.claude.json
  const read = await readJsonConfig(configPath);
  if ("error" in read) return { status: "broken", message: read.error, details };
  details["claude-json"] = read.existed ? "present" : "missing";
  const servers = getServersBlock(read.data) ?? {};
  const registered = SERVER_KEY in servers;
  details["mcp-registration"] = registered ? "present" : "missing";

  if (registered) {
    const block = servers[SERVER_KEY] as Record<string, unknown>;
    const args = Array.isArray(block?.args) ? block.args : [];
    const fwd = args[0];
    if (typeof fwd === "string") {
      details["forwarder-path"] = (await fileExists(fwd)) ? `${fwd} (exists)` : `${fwd} (MISSING)`;
    }
    const env = block?.env as Record<string, unknown> | undefined;
    const vault = env?.BASTRA_VAULT_PATH;
    if (typeof vault === "string") {
      details["vault-path"] = (await fileExists(vault)) ? `${vault} (exists)` : `${vault} (MISSING)`;
    }
  }

  // Skill
  details["skill"] = (await fileExists(SKILL_TARGET_FILE)) ? `present (${SKILL_TARGET_FILE})` : "missing";

  // Hooks
  const settingsRead = await readJsonConfig(CLAUDE_CODE_SETTINGS);
  if ("error" in settingsRead) details["hooks"] = `settings.json broken: ${settingsRead.error}`;
  else {
    const hooks = (settingsRead.data.hooks && typeof settingsRead.data.hooks === "object")
      ? settingsRead.data.hooks as Record<string, unknown>
      : {};
    const preTool = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse.some(isOurHookEntry) : false;
    const session = Array.isArray(hooks.SessionStart) ? hooks.SessionStart.some(isOurHookEntry) : false;
    details["pretool-hook"] = preTool ? "registered" : "missing";
    details["sessionstart-hook"] = session ? "registered" : "missing";
  }

  // Daemon
  const probe = await probeDaemon();
  details["daemon-on-6723"] = probe.ok ? `reachable (${probe.detail})` : probe.detail;

  if (!registered) return { status: "missing", message: "MCP not registered with Claude Code", details };
  const broken =
    details["forwarder-path"]?.includes("MISSING") === true ||
    details["vault-path"]?.includes("MISSING") === true ||
    details["pretool-hook"] === "missing" ||
    details["sessionstart-hook"] === "missing" ||
    details["skill"] === "missing";
  if (broken) return { status: "broken", message: "registered but some pieces are missing", details };
  return { status: "ok", message: "MCP + skill + hooks all registered and healthy", details };
}

// ─── cursor adapter (MCP-only — Rules layer is roadmap) ──────────

const CURSOR_CONFIG = resolve(homedir(), ".cursor/mcp.json");

async function cursorInstall(opts: InstallOpts): Promise<InstallResult> {
  const configPath = CURSOR_CONFIG;
  const vault = await resolveVault(opts);
  if ("error" in vault) return { status: "error", message: vault.error, configPath };

  const block = buildServerBlock(vault.path);
  const read = await readJsonConfig(configPath);
  if ("error" in read) return { status: "error", message: read.error, configPath };

  const data = read.data;
  const servers = getServersBlock(data) ?? {};

  if (blocksMatch(servers[SERVER_KEY], block)) {
    return {
      status: "already-installed",
      message: `'${SERVER_KEY}' already registered with matching forwarder + vault`,
      configPath,
    };
  }
  if (opts.dryRun) {
    return {
      status: "would-install",
      message: `would register '${SERVER_KEY}' (vault=${vault.path}, forwarder=${block.args[0]})`,
      configPath,
    };
  }
  const backupPath = await backupConfig(configPath);
  data.mcpServers = { ...servers, [SERVER_KEY]: block };
  await atomicWriteJson(configPath, data);
  return {
    status: "installed",
    message: `registered '${SERVER_KEY}' — restart Cursor (Cursor Rules layer not installed; coming next)`,
    configPath,
    backupPath: backupPath ?? undefined,
  };
}

async function cursorUninstall(opts: { dryRun: boolean }): Promise<UninstallResult> {
  const configPath = CURSOR_CONFIG;
  const read = await readJsonConfig(configPath);
  if ("error" in read) return { status: "error", message: read.error, configPath };
  if (!read.existed) return { status: "not-present", message: "config file doesn't exist", configPath };

  const data = read.data;
  const servers = getServersBlock(data);
  if (!servers || !(SERVER_KEY in servers)) {
    return { status: "not-present", message: `'${SERVER_KEY}' not registered`, configPath };
  }
  if (opts.dryRun) {
    return { status: "would-remove", message: `would remove '${SERVER_KEY}' from mcpServers`, configPath };
  }
  const backupPath = await backupConfig(configPath);
  delete servers[SERVER_KEY];
  data.mcpServers = servers;
  await atomicWriteJson(configPath, data);
  return {
    status: "removed",
    message: `removed '${SERVER_KEY}' — restart Cursor`,
    configPath,
    backupPath: backupPath ?? undefined,
  };
}

async function cursorDoctor(): Promise<DoctorResult> {
  const configPath = CURSOR_CONFIG;
  const details: Record<string, string> = {};

  const cursorAppDir = resolve(homedir(), ".cursor");
  details["cursor-config-dir"] = (await fileExists(cursorAppDir))
    ? `present (${cursorAppDir})`
    : "not detected (Cursor may not be installed)";

  const read = await readJsonConfig(configPath);
  if ("error" in read) return { status: "broken", message: read.error, details };
  details["mcp-config"] = read.existed ? "present" : "missing (will be created on install)";

  const servers = getServersBlock(read.data) ?? {};
  const registered = SERVER_KEY in servers;
  details["mcp-registration"] = registered ? "present" : "missing";

  if (registered) {
    const block = servers[SERVER_KEY] as Record<string, unknown>;
    const args = Array.isArray(block?.args) ? block.args : [];
    const fwd = args[0];
    if (typeof fwd === "string") {
      details["forwarder-path"] = (await fileExists(fwd)) ? `${fwd} (exists)` : `${fwd} (MISSING)`;
    }
    const env = block?.env as Record<string, unknown> | undefined;
    const vault = env?.BASTRA_VAULT_PATH;
    if (typeof vault === "string") {
      details["vault-path"] = (await fileExists(vault)) ? `${vault} (exists)` : `${vault} (MISSING)`;
    }
  }

  const probe = await probeDaemon();
  details["daemon-on-6723"] = probe.ok ? `reachable (${probe.detail})` : probe.detail;

  if (!registered) return { status: "missing", message: "not registered with Cursor", details };
  const broken =
    details["forwarder-path"]?.includes("MISSING") === true ||
    details["vault-path"]?.includes("MISSING") === true;
  if (broken) return { status: "broken", message: "registered but referenced paths are missing", details };
  return { status: "ok", message: "registered (no Cursor Rules layer yet — roadmap)", details };
}

// ─── Adapter registry ────────────────────────────────────────────

const claudeDesktopAdapter: Adapter = {
  surface: "claude-desktop",
  description: "Claude Desktop App",
  configPath: CLAUDE_DESKTOP_CONFIG,
  install: claudeDesktopInstall,
  uninstall: claudeDesktopUninstall,
  doctor: claudeDesktopDoctor,
};

const claudeCodeAdapter: Adapter = {
  surface: "claude-code",
  description: "Claude Code (MCP + Skill + Hooks)",
  configPath: CLAUDE_CODE_CONFIG,
  install: claudeCodeInstall,
  uninstall: claudeCodeUninstall,
  doctor: claudeCodeDoctor,
};

const cursorAdapter: Adapter = {
  surface: "cursor",
  description: "Cursor (MCP only)",
  configPath: CURSOR_CONFIG,
  install: cursorInstall,
  uninstall: cursorUninstall,
  doctor: cursorDoctor,
};

const ADAPTERS: Record<string, Adapter> = {
  "claude-desktop": claudeDesktopAdapter,
  "claude-code": claudeCodeAdapter,
  "cursor": cursorAdapter,
};

// ─── Help / version ──────────────────────────────────────────────

function showHelp(): void {
  const supportedSurfaces = Object.keys(ADAPTERS).join(", ");
  process.stdout.write(`bastra ${VERSION} — install bastra-recall across AI clients

Usage:
  bastra <command> [surface] [options]

Commands:
  install <surface|all>      Register bastra-recall with the AI client
  uninstall <surface|all>    Remove the registration
  doctor [surface|all]       Check status of one or every surface
  help                       Show this help
  version                    Show version

Surfaces:
  claude-desktop             Claude Desktop App
  claude-code                Claude Code
  cursor                     Cursor
  all                        Every surface above

Options:
  --dry-run                  Print what would change; write nothing
  --vault <path>             Vault path (BASTRA_VAULT_PATH env also works)
  --help, -h                 Show this help
  --version, -v              Show version

Examples:
  bastra install claude-desktop
  bastra install all --dry-run
  bastra doctor
  bastra uninstall claude-desktop

Supported surfaces (this build): ${supportedSurfaces}
`);
}

function showVersion(): void {
  process.stdout.write(`${VERSION}\n`);
}

// ─── Argument parser (tiny, no dependencies) ─────────────────────

interface ParsedArgs {
  command: string | null;
  surface: string | null;
  dryRun: boolean;
  vaultPath: string | null;
  showHelp: boolean;
  showVersion: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    command: null,
    surface: null,
    dryRun: false,
    vaultPath: null,
    showHelp: false,
    showVersion: false,
  };

  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") result.showHelp = true;
    else if (a === "--version" || a === "-v") result.showVersion = true;
    else if (a === "--dry-run") result.dryRun = true;
    else if (a === "--vault") {
      result.vaultPath = argv[++i] ?? null;
    } else if (a.startsWith("--vault=")) {
      result.vaultPath = a.slice("--vault=".length);
    } else if (a.startsWith("--")) {
      process.stderr.write(`warning: unknown flag '${a}' ignored\n`);
    } else {
      positional.push(a);
    }
  }

  result.command = positional[0] ?? null;
  result.surface = positional[1] ?? null;
  return result;
}

// ─── Dispatch helpers ────────────────────────────────────────────

function resolveTargets(surface: string | null): Adapter[] | { error: string } {
  if (!surface) return { error: "missing surface — use one of: claude-desktop, claude-code, cursor, all" };
  if (surface === "all") return Object.values(ADAPTERS);
  const a = ADAPTERS[surface];
  if (!a) return { error: `unknown surface '${surface}' — supported: ${Object.keys(ADAPTERS).join(", ")}` };
  return [a];
}

function resolveVaultPath(cliVault: string | null): string | null {
  return cliVault ?? process.env.BASTRA_VAULT_PATH ?? null;
}

async function cmdInstall(args: ParsedArgs): Promise<number> {
  const targets = resolveTargets(args.surface);
  if ("error" in targets) {
    process.stderr.write(`error: ${targets.error}\n`);
    return 2;
  }

  const vaultPath = resolveVaultPath(args.vaultPath);
  const opts: InstallOpts = { dryRun: args.dryRun, vaultPath };

  let hadError = false;
  for (const adapter of targets) {
    process.stdout.write(`→ ${adapter.surface} (${adapter.description})\n`);
    process.stdout.write(`  config: ${adapter.configPath}\n`);
    try {
      const r = await adapter.install(opts);
      process.stdout.write(`  ${formatStatus(r.status)}: ${r.message}\n`);
      if (r.backupPath) process.stdout.write(`  backup: ${r.backupPath}\n`);
      if (r.status === "error") hadError = true;
    } catch (err) {
      hadError = true;
      process.stdout.write(`  error: ${(err as Error).message}\n`);
    }
    process.stdout.write("\n");
  }
  return hadError ? 1 : 0;
}

async function cmdUninstall(args: ParsedArgs): Promise<number> {
  const targets = resolveTargets(args.surface);
  if ("error" in targets) {
    process.stderr.write(`error: ${targets.error}\n`);
    return 2;
  }

  let hadError = false;
  for (const adapter of targets) {
    process.stdout.write(`→ ${adapter.surface} (${adapter.description})\n`);
    process.stdout.write(`  config: ${adapter.configPath}\n`);
    try {
      const r = await adapter.uninstall({ dryRun: args.dryRun });
      process.stdout.write(`  ${formatStatus(r.status)}: ${r.message}\n`);
      if (r.backupPath) process.stdout.write(`  backup: ${r.backupPath}\n`);
      if (r.status === "error") hadError = true;
    } catch (err) {
      hadError = true;
      process.stdout.write(`  error: ${(err as Error).message}\n`);
    }
    process.stdout.write("\n");
  }
  return hadError ? 1 : 0;
}

async function cmdDoctor(args: ParsedArgs): Promise<number> {
  const surface = args.surface ?? "all";
  const targets = resolveTargets(surface);
  if ("error" in targets) {
    process.stderr.write(`error: ${targets.error}\n`);
    return 2;
  }

  for (const adapter of targets) {
    process.stdout.write(`→ ${adapter.surface} (${adapter.description})\n`);
    process.stdout.write(`  config: ${adapter.configPath}\n`);
    try {
      const r = await adapter.doctor();
      process.stdout.write(`  ${formatStatus(r.status)}: ${r.message}\n`);
      if (r.details) {
        for (const [k, v] of Object.entries(r.details)) {
          process.stdout.write(`    ${k}: ${v}\n`);
        }
      }
    } catch (err) {
      process.stdout.write(`  error: ${(err as Error).message}\n`);
    }
    process.stdout.write("\n");
  }
  return 0;
}

function formatStatus(status: string): string {
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

// ─── main ────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.showVersion) { showVersion(); return 0; }
  if (args.showHelp && !args.command) { showHelp(); return 0; }
  if (!args.command || args.command === "help") { showHelp(); return 0; }

  switch (args.command) {
    case "version": showVersion(); return 0;
    case "install": return cmdInstall(args);
    case "uninstall": return cmdUninstall(args);
    case "doctor": return cmdDoctor(args);
    default:
      process.stderr.write(`error: unknown command '${args.command}' — run 'bastra help'\n`);
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`fatal: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  },
);
