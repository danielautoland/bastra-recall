import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

// This file lives at dist/cli/paths.js after build.
// DAEMON_DIST is one level up (dist/), PACKAGE_ROOT one more (packages/daemon/).
const DAEMON_DIST = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGE_ROOT = dirname(DAEMON_DIST);

export const FORWARDER_SCRIPT_PATH = resolve(DAEMON_DIST, "mcp-forwarder.js");
export const PRE_TOOL_HOOK_BIN = resolve(DAEMON_DIST, "hook.js");
export const SESSION_HOOK_BIN = resolve(DAEMON_DIST, "session-hook.js");
export const PROMPT_HOOK_BIN = resolve(DAEMON_DIST, "prompt-hook.js");
export const TODO_HOOK_BIN = resolve(DAEMON_DIST, "todo-hook.js");
export const BASH_PRE_HOOK_BIN = resolve(DAEMON_DIST, "bash-pre-hook.js");
export const BASH_FAIL_HOOK_BIN = resolve(DAEMON_DIST, "bash-fail-hook.js");
export const STOP_HOOK_BIN = resolve(DAEMON_DIST, "stop-hook.js");

export const SKILL_SOURCE_PATH = resolve(PACKAGE_ROOT, "..", "skill", "SKILL.md");
export const SKILL_TARGET_DIR = resolve(homedir(), ".claude/skills/bastra-recall");
export const SKILL_TARGET_FILE = resolve(SKILL_TARGET_DIR, "SKILL.md");

export const CLAUDE_DESKTOP_CONFIG = resolve(
  homedir(),
  "Library/Application Support/Claude/claude_desktop_config.json",
);
export const CLAUDE_CODE_CONFIG = resolve(homedir(), ".claude.json");
export const CLAUDE_CODE_SETTINGS = resolve(homedir(), ".claude/settings.json");
export const CURSOR_CONFIG = resolve(homedir(), ".cursor/mcp.json");
