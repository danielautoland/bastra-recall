import {
  CLAUDE_CODE_CONFIG,
  CLAUDE_CODE_SETTINGS,
  PRE_TOOL_HOOK_BIN,
  SESSION_HOOK_BIN,
  SKILL_TARGET_FILE,
} from "../paths.js";
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
import type { Adapter, DoctorResult, InstallOpts, InstallResult, UninstallResult } from "../types.js";

// ─── Hook helpers (claude-code-only surface) ─────────────────────

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

// ─── Adapter functions ───────────────────────────────────────────

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

  // Skill is shared with Claude Desktop (~/.claude/skills/bastra-recall).
  // We don't remove it here — Claude Desktop might still need it. To purge
  // the skill, run a separate `bastra uninstall --purge-skill` or remove
  // the file manually.
  const hookResult = await patchClaudeCodeHooks("uninstall", { dryRun: opts.dryRun });

  if (!mcpPresent && hookResult.status === "not-present") {
    return { status: "not-present", message: "nothing to remove (skill kept in case Claude Desktop still uses it)", configPath };
  }

  if (opts.dryRun) {
    const steps: string[] = [];
    steps.push(mcpPresent ? `mcp: would remove '${SERVER_KEY}'` : "mcp: not present");
    steps.push(`hooks: ${hookResult.detail}`);
    steps.push("skill: kept (shared with Claude Desktop)");
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
  lines.push(`hooks: ${hookResult.detail}`);
  lines.push("skill: kept (shared with Claude Desktop)");
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

export const claudeCodeAdapter: Adapter = {
  surface: "claude-code",
  description: "Claude Code (MCP + Skill + Hooks)",
  configPath: CLAUDE_CODE_CONFIG,
  install: claudeCodeInstall,
  uninstall: claudeCodeUninstall,
  doctor: claudeCodeDoctor,
};
