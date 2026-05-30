import {
  CLAUDE_CODE_CONFIG,
  CLAUDE_CODE_SETTINGS,
  PRE_TOOL_HOOK_BIN,
  SESSION_HOOK_BIN,
  PROMPT_HOOK_BIN,
  TODO_HOOK_BIN,
  BASH_PRE_HOOK_BIN,
  BASH_FAIL_HOOK_BIN,
  STOP_HOOK_BIN,
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

type HookEventName = "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop";

interface HookDef {
  event: HookEventName;
  matcher?: string;
  bin: string;
  timeout: number;
  note: string;
}

// Single source of truth for the full reflex layer (issue #1). Order matters
// only cosmetically — it's the order entries land in settings.json.
function hookDefinitions(): HookDef[] {
  return [
    { event: "SessionStart", matcher: "startup|resume|clear|compact", bin: SESSION_HOOK_BIN, timeout: 3, note: "bastra-recall SessionStart hook" },
    { event: "UserPromptSubmit", bin: PROMPT_HOOK_BIN, timeout: 2, note: "bastra-recall UserPromptSubmit hook (lookup-mode, #33)" },
    { event: "PreToolUse", matcher: "Write|Edit|MultiEdit|NotebookEdit", bin: PRE_TOOL_HOOK_BIN, timeout: 2, note: "bastra-recall PreToolUse hook" },
    { event: "PreToolUse", matcher: "TodoWrite", bin: TODO_HOOK_BIN, timeout: 2, note: "bastra-recall TodoWrite hook (topology-recall, #36)" },
    { event: "PreToolUse", matcher: "Bash", bin: BASH_PRE_HOOK_BIN, timeout: 2, note: "bastra-recall Bash-pre hook (safety, #34)" },
    { event: "PostToolUse", matcher: "Bash", bin: BASH_FAIL_HOOK_BIN, timeout: 2, note: "bastra-recall Bash-fail hook (lesson recall on fail, #37)" },
    { event: "Stop", bin: STOP_HOOK_BIN, timeout: 3, note: "bastra-recall Stop hook (autonomous save-eval, #35)" },
  ];
}

function buildHookEntry(def: HookDef): Record<string, unknown> {
  const entry: Record<string, unknown> = {};
  if (def.matcher) entry.matcher = def.matcher;
  entry.hooks = [{
    type: "command",
    command: `node ${def.bin}`,
    timeout: def.timeout,
    __bastraRecall: true,
    __note: def.note,
  }];
  return entry;
}

// Hook bin filenames we own — recognised even on entries missing the
// __bastraRecall marker (e.g. older hand-added ones).
const OUR_HOOK_FILES = [
  "hook.js", "session-hook.js", "prompt-hook.js", "todo-hook.js",
  "bash-pre-hook.js", "bash-fail-hook.js", "stop-hook.js",
];

function isOurHookEntry(matcher: unknown): boolean {
  if (typeof matcher !== "object" || matcher === null) return false;
  const m = matcher as Record<string, unknown>;
  const hooks = Array.isArray(m.hooks) ? m.hooks : [];
  return hooks.some((h: unknown) => {
    if (typeof h !== "object" || h === null) return false;
    const hh = h as Record<string, unknown>;
    if (hh.__bastraRecall === true || hh.__nexusRecall === true) return true;
    const cmd = typeof hh.command === "string" ? hh.command : "";
    if (cmd.includes("/daemon/dist/") && OUR_HOOK_FILES.some((f) => cmd.includes(`/${f}`))) return true;
    // Fallback (mirrors install-hook.sh): bare-bin / legacy command form, e.g.
    // `bastra-recall-session-hook` or `nexus-recall-*-hook` from the docs snippet.
    if ((cmd.includes("bastra-recall") || cmd.includes("nexus-recall")) && cmd.includes("hook")) return true;
    return false;
  });
}

const HOOK_EVENTS: HookEventName[] = [
  "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop",
];

// Which of our hook bins are actually registered (by dist filename), across
// every event — used by doctor to report N/7 coverage.
function registeredHookBins(hooks: Record<string, unknown>): Set<string> {
  const found = new Set<string>();
  for (const ev of HOOK_EVENTS) {
    const arr = Array.isArray(hooks[ev]) ? (hooks[ev] as unknown[]) : [];
    for (const entry of arr) {
      if (!isOurHookEntry(entry)) continue;
      const hs = (entry as Record<string, unknown>).hooks;
      if (!Array.isArray(hs)) continue;
      for (const h of hs) {
        const cmd = typeof (h as Record<string, unknown>)?.command === "string"
          ? ((h as Record<string, unknown>).command as string)
          : "";
        for (const f of OUR_HOOK_FILES) if (cmd.includes(`/${f}`)) found.add(f);
      }
    }
  }
  return found;
}

type HookStepStatus = "installed" | "already-installed" | "would-install" | "removed" | "not-present" | "would-remove" | "error";

async function patchClaudeCodeHooks(action: "install" | "uninstall", opts: { dryRun: boolean }): Promise<{ status: HookStepStatus; detail: string; backupPath?: string }> {
  const defs = hookDefinitions();

  if (action === "install") {
    for (const def of defs) {
      if (!(await fileExists(def.bin))) {
        return { status: "error", detail: `hook binary missing: ${def.bin} — run 'npm run build'` };
      }
    }
  }

  const read = await readJsonConfig(CLAUDE_CODE_SETTINGS);
  if ("error" in read) return { status: "error", detail: read.error };

  const data = read.data;
  const hooks = (data.hooks && typeof data.hooks === "object" && !Array.isArray(data.hooks))
    ? data.hooks as Record<string, unknown>
    : {};

  // Per event: keep all foreign entries, append our (possibly re-built) entries.
  const before: Record<HookEventName, unknown[]> = {} as Record<HookEventName, unknown[]>;
  const after: Record<HookEventName, unknown[]> = {} as Record<HookEventName, unknown[]>;
  for (const ev of HOOK_EVENTS) {
    const cur = Array.isArray(hooks[ev]) ? (hooks[ev] as unknown[]) : [];
    before[ev] = cur;
    after[ev] = cur.filter((m) => !isOurHookEntry(m));
  }
  if (action === "install") {
    for (const def of defs) after[def.event].push(buildHookEntry(def));
  }

  const currentMatches = HOOK_EVENTS.every(
    (ev) => JSON.stringify(before[ev]) === JSON.stringify(after[ev]),
  );

  if (currentMatches) {
    return action === "install"
      ? { status: "already-installed", detail: `all ${defs.length} hooks already registered with matching paths` }
      : { status: "not-present", detail: "no bastra-recall hooks present" };
  }

  if (opts.dryRun) {
    return action === "install"
      ? { status: "would-install", detail: `would (re)register ${defs.length} hooks across ${HOOK_EVENTS.length} events` }
      : { status: "would-remove", detail: "would strip bastra-recall hook entries" };
  }

  // Commit changes
  for (const ev of HOOK_EVENTS) {
    if (after[ev].length > 0) hooks[ev] = after[ev];
    else delete hooks[ev];
  }
  data.hooks = hooks;

  const backupPath = await backupConfig(CLAUDE_CODE_SETTINGS);
  await atomicWriteJson(CLAUDE_CODE_SETTINGS, data);
  return action === "install"
    ? { status: "installed", detail: `${defs.length} hooks registered (SessionStart, UserPromptSubmit, PreToolUse×3, PostToolUse, Stop)`, backupPath: backupPath ?? undefined }
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
  let hooksMissing = false;
  const settingsRead = await readJsonConfig(CLAUDE_CODE_SETTINGS);
  if ("error" in settingsRead) {
    details["hooks"] = `settings.json broken: ${settingsRead.error}`;
    hooksMissing = true;
  } else {
    const hooks = (settingsRead.data.hooks && typeof settingsRead.data.hooks === "object")
      ? settingsRead.data.hooks as Record<string, unknown>
      : {};
    const found = registeredHookBins(hooks);
    const missing = OUR_HOOK_FILES.filter((f) => !found.has(f));
    hooksMissing = missing.length > 0;
    details["hooks"] = hooksMissing
      ? `${found.size}/${OUR_HOOK_FILES.length} registered (missing: ${missing.join(", ")})`
      : `${OUR_HOOK_FILES.length}/${OUR_HOOK_FILES.length} registered`;
  }

  // Daemon
  const probe = await probeDaemon();
  details["daemon-on-6723"] = probe.ok ? `reachable (${probe.detail})` : probe.detail;

  if (!registered) return { status: "missing", message: "MCP not registered with Claude Code", details };
  const broken =
    details["forwarder-path"]?.includes("MISSING") === true ||
    details["vault-path"]?.includes("MISSING") === true ||
    hooksMissing ||
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
