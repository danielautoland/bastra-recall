import { homedir } from "node:os";
import { resolve } from "node:path";
import { CURSOR_CONFIG } from "../paths.js";
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
import type { Adapter, DoctorResult, InstallOpts, InstallResult, UninstallResult } from "../types.js";

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

export const cursorAdapter: Adapter = {
  surface: "cursor",
  description: "Cursor (MCP only)",
  configPath: CURSOR_CONFIG,
  install: cursorInstall,
  uninstall: cursorUninstall,
  doctor: cursorDoctor,
};
