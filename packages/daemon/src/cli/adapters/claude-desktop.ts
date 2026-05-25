import { CLAUDE_DESKTOP_CONFIG, SKILL_TARGET_FILE } from "../paths.js";
import {
  SERVER_KEY,
  atomicWriteJson,
  backupConfig,
  blocksMatch,
  buildServerBlock,
  fileExists,
  getServersBlock,
  probeDaemon,
  readJsonConfig,
  resolveVault,
} from "../helpers.js";
import { copySkill } from "../skill.js";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Adapter, DoctorResult, InstallOpts, InstallResult, UninstallResult } from "../types.js";

async function claudeDesktopInstall(opts: InstallOpts): Promise<InstallResult> {
  const configPath = CLAUDE_DESKTOP_CONFIG;
  const vault = await resolveVault(opts);
  if ("error" in vault) return { status: "error", message: vault.error, configPath };

  const block = buildServerBlock(vault.path);
  const read = await readJsonConfig(configPath);
  if ("error" in read) return { status: "error", message: read.error, configPath };

  const data = read.data;
  const servers = getServersBlock(data) ?? {};
  const mcpMatches = blocksMatch(servers[SERVER_KEY], block);

  // Claude Desktop reads skills from the same ~/.claude/skills/ path as
  // Claude Code, so we drop the Skill here too (idempotent). Hooks aren't
  // a Claude Desktop surface yet.
  const skillResult = await copySkill({ dryRun: opts.dryRun });
  if (skillResult.status === "error") return { status: "error", message: `skill: ${skillResult.detail}`, configPath };

  if (mcpMatches && skillResult.status === "already-installed") {
    return {
      status: "already-installed",
      message: "MCP server and skill both already in place",
      configPath,
    };
  }

  if (opts.dryRun) {
    const steps: string[] = [];
    steps.push(mcpMatches ? "mcp: already matches" : `mcp: would register '${SERVER_KEY}' (vault=${vault.path})`);
    steps.push(`skill: ${skillResult.detail}`);
    return { status: "would-install", message: steps.join("\n  · "), configPath };
  }

  let backupPath: string | undefined;
  if (!mcpMatches) {
    backupPath = (await backupConfig(configPath)) ?? undefined;
    data.mcpServers = { ...servers, [SERVER_KEY]: block };
    await atomicWriteJson(configPath, data);
  }

  const lines: string[] = [];
  lines.push(mcpMatches ? "mcp: already matches" : `mcp: registered '${SERVER_KEY}'`);
  lines.push(`skill: ${skillResult.detail}`);
  lines.push("restart Claude Desktop to activate");

  return {
    status: "installed",
    message: lines.join("\n  · "),
    configPath,
    backupPath,
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

  // 3. Skill (shared with Claude Code under ~/.claude/skills/)
  details["skill"] = (await fileExists(SKILL_TARGET_FILE)) ? `present (${SKILL_TARGET_FILE})` : "missing";

  // 4. Daemon reachable
  const probe = await probeDaemon();
  details["daemon-on-6723"] = probe.ok ? `reachable (${probe.detail})` : probe.detail;

  if (!registered) return { status: "missing", message: "not registered with Claude Desktop", details };
  const broken =
    details["forwarder-path"]?.includes("MISSING") === true ||
    details["vault-path"]?.includes("MISSING") === true ||
    details["forwarder-path"]?.startsWith("no ") === true ||
    details["vault-path"]?.startsWith("not ") === true ||
    details["skill"] === "missing";
  if (broken) return { status: "broken", message: "registered but skill or referenced paths are missing", details };
  return { status: "ok", message: "registered with skill, looks healthy", details };
}

export const claudeDesktopAdapter: Adapter = {
  surface: "claude-desktop",
  description: "Claude Desktop App",
  configPath: CLAUDE_DESKTOP_CONFIG,
  install: claudeDesktopInstall,
  uninstall: claudeDesktopUninstall,
  doctor: claudeDesktopDoctor,
};
