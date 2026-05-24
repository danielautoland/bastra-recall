#!/usr/bin/env bash
# Install / update the bastra-recall hooks in ~/.claude/settings.json.
#
# Registers two hooks:
#   - PreToolUse  → recall before each Write/Edit/MultiEdit/NotebookEdit
#   - SessionStart → preload top memorys when a fresh session opens
#
# Idempotent: re-running updates paths if they changed; will not duplicate
# the matcher blocks. Cleans up legacy `__nexusRecall`-marked entries from
# the pre-rename setup. Backs up settings.json before each write.
#
# Usage:
#   bash packages/skill/install-hook.sh                # install
#   bash packages/skill/install-hook.sh --uninstall    # remove
#   bash packages/skill/install-hook.sh --print        # dry-run, print resulting JSON

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PRE_TOOL_BIN="${REPO_ROOT}/packages/daemon/dist/hook.js"
SESSION_BIN="${REPO_ROOT}/packages/daemon/dist/session-hook.js"
SETTINGS_FILE="${HOME}/.claude/settings.json"
ACTION="install"
for arg in "$@"; do
  case "$arg" in
    --uninstall) ACTION="uninstall" ;;
    --print) ACTION="print" ;;
    *) echo "unknown flag: $arg" >&2 ; exit 2 ;;
  esac
done

if [[ "$ACTION" == "install" || "$ACTION" == "print" ]]; then
  for bin in "${PRE_TOOL_BIN}" "${SESSION_BIN}"; do
    if [[ ! -f "${bin}" ]]; then
      echo "✗ hook binary not built: ${bin}" >&2
      echo "  Run: (cd ${REPO_ROOT} && npm install && npm run build)" >&2
      exit 1
    fi
    chmod +x "${bin}" 2>/dev/null || true
  done
fi

mkdir -p "$(dirname "${SETTINGS_FILE}")"
[[ -f "${SETTINGS_FILE}" ]] || echo "{}" > "${SETTINGS_FILE}"

if [[ "$ACTION" != "print" ]]; then
  cp "${SETTINGS_FILE}" "${SETTINGS_FILE}.bak"
fi

# Patch JSON via inline Node — robust against existing hook entries.
PRE_TOOL_BIN="${PRE_TOOL_BIN}" SESSION_BIN="${SESSION_BIN}" \
  SETTINGS_FILE="${SETTINGS_FILE}" ACTION="${ACTION}" \
  node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
import { stdout } from "node:process";

const file = process.env.SETTINGS_FILE;
const preToolBin = process.env.PRE_TOOL_BIN;
const sessionBin = process.env.SESSION_BIN;
const action = process.env.ACTION;

const raw = readFileSync(file, "utf8") || "{}";
let cfg;
try { cfg = JSON.parse(raw); }
catch { console.error(`✗ ${file} is not valid JSON. Aborting.`); process.exit(1); }
if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) cfg = {};

cfg.hooks ??= {};

function isOurs(matcher) {
  if (!matcher || typeof matcher !== "object") return false;
  const hooks = Array.isArray(matcher.hooks) ? matcher.hooks : [];
  return hooks.some((h) => {
    if (!h || typeof h !== "object") return false;
    if (h.__bastraRecall === true || h.__nexusRecall === true) return true;
    const cmd = typeof h.command === "string" ? h.command : "";
    // Pfad-Heuristik: our hook binaries enden auf /daemon/dist/{hook,session-hook}.js,
    // unabhängig vom Repo-Folder-Namen (bastra-recall / bastra-open / nexus-recall).
    if (cmd.includes("/daemon/dist/hook.js")) return true;
    if (cmd.includes("/daemon/dist/session-hook.js")) return true;
    if ((cmd.includes("bastra-recall") || cmd.includes("nexus-recall")) && cmd.includes("hook")) return true;
    return false;
  });
}

function rewrite(eventName, install) {
  const matchers = (cfg.hooks[eventName] ??= []);
  const next = matchers.filter((m) => !isOurs(m));
  if (install.length) next.push(...install);
  if (next.length === 0) delete cfg.hooks[eventName];
  else cfg.hooks[eventName] = next;
}

if (action === "uninstall") {
  rewrite("PreToolUse", []);
  rewrite("SessionStart", []);
} else {
  rewrite("PreToolUse", [{
    matcher: "Write|Edit|MultiEdit|NotebookEdit",
    hooks: [{
      type: "command",
      command: `node ${JSON.stringify(preToolBin).slice(1, -1)}`,
      timeout: 2,
      __bastraRecall: true,
      __note: "bastra-recall PreToolUse hook",
    }],
  }]);
  rewrite("SessionStart", [{
    matcher: "startup|resume|clear|compact",
    hooks: [{
      type: "command",
      command: `node ${JSON.stringify(sessionBin).slice(1, -1)}`,
      timeout: 3,
      __bastraRecall: true,
      __note: "bastra-recall SessionStart hook",
    }],
  }]);
}

const out = JSON.stringify(cfg, null, 2) + "\n";
if (action === "print") {
  stdout.write(out);
} else {
  writeFileSync(file, out, "utf8");
}
'

case "$ACTION" in
  install)
    echo "✓ bastra-recall hooks registered in ${SETTINGS_FILE}"
    echo "  PreToolUse:   node ${PRE_TOOL_BIN}"
    echo "  SessionStart: node ${SESSION_BIN}"
    echo "  Backup:       ${SETTINGS_FILE}.bak"
    echo
    echo "Restart Claude Code (or open a fresh session) to activate."
    ;;
  uninstall)
    echo "✓ bastra-recall hooks removed from ${SETTINGS_FILE}"
    echo "  Backup: ${SETTINGS_FILE}.bak"
    ;;
  print)
    : # JSON already written to stdout
    ;;
esac
