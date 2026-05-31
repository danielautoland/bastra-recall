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
  STATUSLINE_BIN,
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

// Single source of truth for the reflex layer. The Stop hook is intentionally
// opt-in because it can emit multi-line save-eval suggestions at turn end.
function hookDefinitions(opts: { includeStop?: boolean } = {}): HookDef[] {
  const defs: HookDef[] = [
    { event: "SessionStart", matcher: "startup|resume|clear|compact", bin: SESSION_HOOK_BIN, timeout: 3, note: "bastra-recall SessionStart hook" },
    { event: "UserPromptSubmit", bin: PROMPT_HOOK_BIN, timeout: 2, note: "bastra-recall UserPromptSubmit hook (lookup-mode, #33)" },
    { event: "PreToolUse", matcher: "Write|Edit|MultiEdit|NotebookEdit", bin: PRE_TOOL_HOOK_BIN, timeout: 2, note: "bastra-recall PreToolUse hook" },
    { event: "PreToolUse", matcher: "TodoWrite", bin: TODO_HOOK_BIN, timeout: 2, note: "bastra-recall TodoWrite hook (topology-recall, #36)" },
    { event: "PreToolUse", matcher: "Bash", bin: BASH_PRE_HOOK_BIN, timeout: 2, note: "bastra-recall Bash-pre hook (safety, #34)" },
    { event: "PostToolUse", matcher: "Bash", bin: BASH_FAIL_HOOK_BIN, timeout: 2, note: "bastra-recall Bash-fail hook (lesson recall on fail, #37)" },
  ];
  if (opts.includeStop) {
    defs.push({ event: "Stop", bin: STOP_HOOK_BIN, timeout: 3, note: "bastra-recall Stop hook (optional autonomous save-eval, #35)" });
  }
  return defs;
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
const REQUIRED_HOOK_FILES = OUR_HOOK_FILES.filter((f) => f !== "stop-hook.js");

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

async function patchClaudeCodeHooks(
  action: "install" | "uninstall",
  opts: { dryRun: boolean; includeStop?: boolean },
): Promise<{ status: HookStepStatus; detail: string; backupPath?: string }> {
  const defs = hookDefinitions({ includeStop: opts.includeStop });
  const includeStop = opts.includeStop === true;

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
  let stopPreserved = false;
  for (const ev of HOOK_EVENTS) {
    const cur = Array.isArray(hooks[ev]) ? (hooks[ev] as unknown[]) : [];
    before[ev] = cur;
    // On install without --with-stop-hook, preserve a previously opted-in Stop
    // hook instead of stripping it: re-running install / `bastra update` must
    // not silently remove a hook the user enabled earlier (#48).
    if (action === "install" && !includeStop && ev === "Stop") {
      after[ev] = cur;
      stopPreserved = cur.some((m) => isOurHookEntry(m));
    } else {
      after[ev] = cur.filter((m) => !isOurHookEntry(m));
    }
  }
  if (action === "install") {
    for (const def of defs) after[def.event].push(buildHookEntry(def));
  }
  const installNote = includeStop
    ? ""
    : stopPreserved
      ? " (existing Stop hook kept)"
      : " (Stop hook optional/off)";

  const currentMatches = HOOK_EVENTS.every(
    (ev) => JSON.stringify(before[ev]) === JSON.stringify(after[ev]),
  );

  if (currentMatches) {
    return action === "install"
      ? { status: "already-installed", detail: `${defs.length} hooks already registered with matching paths${installNote}` }
      : { status: "not-present", detail: "no bastra-recall hooks present" };
  }

  if (opts.dryRun) {
    return action === "install"
      ? { status: "would-install", detail: `would (re)register ${defs.length} hooks across ${HOOK_EVENTS.length} events${installNote}` }
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
    ? {
        status: "installed",
        detail: `${defs.length} hooks registered (SessionStart, UserPromptSubmit, PreToolUse×3, PostToolUse${includeStop ? ", Stop" : stopPreserved ? "; Stop kept" : "; Stop optional/off"})`,
        backupPath: backupPath ?? undefined,
      }
    : { status: "removed", detail: "bastra-recall hook entries removed", backupPath: backupPath ?? undefined };
}

// ─── Statusline helpers ──────────────────────────────────────────

// Matches Daniel's hand-configured block + the One-command default:
//   node <statusline>/dist/index.mjs --style=powerline
const STATUSLINE_COMMAND = `node ${STATUSLINE_BIN} --style=powerline`;

function buildStatuslineBlock(): Record<string, unknown> {
  return {
    type: "command",
    command: STATUSLINE_COMMAND,
    refreshInterval: 1,
    __bastraRecall: true,
  };
}

// Recognise our statusLine — by marker (our writes) or by command path
// (hand-configured ones that predate the marker).
function isOurStatusline(sl: unknown): boolean {
  if (typeof sl !== "object" || sl === null) return false;
  const s = sl as Record<string, unknown>;
  if (s.__bastraRecall === true || s.__nexusRecall === true) return true;
  const cmd = typeof s.command === "string" ? s.command : "";
  return (
    cmd.includes("bastra-statusline") ||
    cmd.includes("/statusline/dist/index.mjs") ||
    cmd.includes("/statusline/bin/claude-powerline") ||
    (cmd.includes("statusline") && cmd.includes("bastra"))
  );
}

function statuslineMatches(sl: unknown): boolean {
  if (typeof sl !== "object" || sl === null) return false;
  const s = sl as Record<string, unknown>;
  return (
    s.command === STATUSLINE_COMMAND &&
    s.type === "command" &&
    s.refreshInterval === 1
  );
}

type StatuslineStepStatus =
  | "installed" | "already-installed" | "would-install" | "foreign-kept"
  | "removed" | "not-present" | "would-remove" | "error";

async function patchClaudeCodeStatusline(
  action: "install" | "uninstall",
  opts: { dryRun: boolean; force: boolean },
): Promise<{ status: StatuslineStepStatus; detail: string; backupPath?: string }> {
  if (action === "install" && !(await fileExists(STATUSLINE_BIN))) {
    return { status: "error", detail: `statusline not built: ${STATUSLINE_BIN} — run 'npm run build'` };
  }

  const read = await readJsonConfig(CLAUDE_CODE_SETTINGS);
  if ("error" in read) return { status: "error", detail: read.error };
  const data = read.data;
  const existing = data.statusLine;
  const present = existing !== undefined && existing !== null;

  if (action === "install") {
    // A different statusLine is configured → never clobber it without --yes.
    if (present && !isOurStatusline(existing)) {
      if (!opts.force) {
        return { status: "foreign-kept", detail: "a different statusLine is configured — kept it (pass --yes to use bastra's)" };
      }
    } else if (statuslineMatches(existing)) {
      return { status: "already-installed", detail: "bastra statusLine already configured" };
    }

    if (opts.dryRun) {
      const verb = !present ? "would add" : isOurStatusline(existing) ? "would update" : "would replace foreign";
      return { status: "would-install", detail: `${verb} statusLine → ${STATUSLINE_COMMAND}` };
    }

    const backupPath = await backupConfig(CLAUDE_CODE_SETTINGS);
    data.statusLine = buildStatuslineBlock();
    await atomicWriteJson(CLAUDE_CODE_SETTINGS, data);
    const how = !present ? "powerline, refreshInterval 1s" : isOurStatusline(existing) ? "path updated" : "replaced foreign";
    return { status: "installed", detail: `statusLine registered (${how})`, backupPath: backupPath ?? undefined };
  }

  // uninstall — only remove our own statusLine, never a foreign one.
  if (!present || !isOurStatusline(existing)) {
    return { status: "not-present", detail: present ? "statusLine is not bastra's — kept" : "no statusLine present" };
  }
  if (opts.dryRun) return { status: "would-remove", detail: "would remove bastra statusLine" };

  const backupPath = await backupConfig(CLAUDE_CODE_SETTINGS);
  delete data.statusLine;
  await atomicWriteJson(CLAUDE_CODE_SETTINGS, data);
  return { status: "removed", detail: "bastra statusLine removed", backupPath: backupPath ?? undefined };
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
  const hookResult = await patchClaudeCodeHooks("install", {
    dryRun: opts.dryRun,
    includeStop: opts.withStopHook === true,
  });
  const statuslineResult = await patchClaudeCodeStatusline("install", { dryRun: opts.dryRun, force: opts.force === true });

  if (skillResult.status === "error") return { status: "error", message: `skill: ${skillResult.detail}`, configPath };
  if (hookResult.status === "error") return { status: "error", message: `hooks: ${hookResult.detail}`, configPath };
  if (statuslineResult.status === "error") return { status: "error", message: `statusline: ${statuslineResult.detail}`, configPath };

  // If everything is already in place: no MCP write, no Skill write, no Hook write.
  // A kept foreign statusLine counts as settled (nothing to write) — we just
  // surface the hint that --yes would switch it to bastra's.
  const statuslineSettled =
    statuslineResult.status === "already-installed" || statuslineResult.status === "foreign-kept";
  const allAlreadyInstalled =
    mcpMatches &&
    skillResult.status === "already-installed" &&
    hookResult.status === "already-installed" &&
    statuslineSettled;
  if (allAlreadyInstalled) {
    const msg = statuslineResult.status === "foreign-kept"
      ? "MCP, skill, hooks in place; statusLine: foreign one kept (pass --yes to use bastra's)"
      : "MCP server, skill, hooks, and statusLine all already in place";
    return { status: "already-installed", message: msg, configPath };
  }

  if (opts.dryRun) {
    const steps: string[] = [];
    if (!mcpMatches) steps.push(`mcp: would register '${SERVER_KEY}' in ${configPath}`);
    else steps.push("mcp: already matches");
    steps.push(`skill: ${skillResult.detail}`);
    steps.push(`hooks: ${hookResult.detail}`);
    steps.push(`statusline: ${statuslineResult.detail}`);
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
  lines.push(`statusline: ${statuslineResult.detail}`);
  lines.push("restart Claude Code to activate");

  return {
    status: "installed",
    message: lines.join("\n  · "),
    configPath,
    backupPath: backupPath ?? statuslineResult.backupPath,
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
  const statuslineResult = await patchClaudeCodeStatusline("uninstall", { dryRun: opts.dryRun, force: false });

  if (!mcpPresent && hookResult.status === "not-present" && statuslineResult.status === "not-present") {
    return { status: "not-present", message: "nothing to remove (skill kept in case Claude Desktop still uses it)", configPath };
  }

  if (opts.dryRun) {
    const steps: string[] = [];
    steps.push(mcpPresent ? `mcp: would remove '${SERVER_KEY}'` : "mcp: not present");
    steps.push(`hooks: ${hookResult.detail}`);
    steps.push(`statusline: ${statuslineResult.detail}`);
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
  lines.push(`statusline: ${statuslineResult.detail}`);
  lines.push("skill: kept (shared with Claude Desktop)");
  lines.push("restart Claude Code to drop the connection");

  return {
    status: "removed",
    message: lines.join("\n  · "),
    configPath,
    backupPath: backupPath ?? statuslineResult.backupPath,
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

  // Hooks. Stop is optional: some users intentionally disable autonomous
  // save-eval while keeping the rest of the reflex layer active.
  let requiredHooksMissing = false;
  const settingsRead = await readJsonConfig(CLAUDE_CODE_SETTINGS);
  if ("error" in settingsRead) {
    details["hooks"] = `settings.json broken: ${settingsRead.error}`;
    requiredHooksMissing = true;
  } else {
    const hooks = (settingsRead.data.hooks && typeof settingsRead.data.hooks === "object")
      ? settingsRead.data.hooks as Record<string, unknown>
      : {};
    const found = registeredHookBins(hooks);
    const requiredMissing = REQUIRED_HOOK_FILES.filter((f) => !found.has(f));
    const optionalMissing = OUR_HOOK_FILES
      .filter((f) => !REQUIRED_HOOK_FILES.includes(f))
      .filter((f) => !found.has(f));
    requiredHooksMissing = requiredMissing.length > 0;
    details["hooks"] = requiredHooksMissing
      ? `${found.size}/${OUR_HOOK_FILES.length} registered (missing required: ${requiredMissing.join(", ")})`
      : optionalMissing.length > 0
        ? `${found.size}/${OUR_HOOK_FILES.length} registered (optional disabled: ${optionalMissing.join(", ")})`
        : `${OUR_HOOK_FILES.length}/${OUR_HOOK_FILES.length} registered`;

    // Statusline (optional/cosmetic — never marks the surface as broken).
    const sl = settingsRead.data.statusLine;
    details["statusline"] = sl === undefined || sl === null
      ? "missing (run 'bastra install' to add it)"
      : isOurStatusline(sl)
        ? "present (bastra)"
        : "present (foreign — run 'bastra install --yes' to replace it)";
  }

  // Daemon
  const probe = await probeDaemon();
  details["daemon-on-6723"] = probe.ok ? `reachable (${probe.detail})` : probe.detail;

  if (!registered) return { status: "missing", message: "MCP not registered with Claude Code", details };
  const broken =
    details["forwarder-path"]?.includes("MISSING") === true ||
    details["vault-path"]?.includes("MISSING") === true ||
    requiredHooksMissing ||
    details["skill"] === "missing";
  if (broken) return { status: "broken", message: "registered but some pieces are missing", details };
  return { status: "ok", message: "MCP + skill + required hooks registered and healthy", details };
}

export const claudeCodeAdapter: Adapter = {
  surface: "claude-code",
  description: "Claude Code (MCP + Skill + Hooks)",
  configPath: CLAUDE_CODE_CONFIG,
  install: claudeCodeInstall,
  uninstall: claudeCodeUninstall,
  doctor: claudeCodeDoctor,
};
