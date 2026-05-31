#!/usr/bin/env bash
# Install Bastra.command — double-click in Finder to set up bastra-recall.
#
# Idempotent: safe to run multiple times. Installs Homebrew if missing,
# adds the bastra tap, installs bastra-recall, and registers it with
# every supported AI client (Claude Code, Claude Desktop, Cursor).
#
# After this script finishes, restart the AI client(s) you use — the
# memory tool will be live.

set -euo pipefail

# Make double-click logs readable even when launched from Finder
mkdir -p "$HOME/Library/Logs"
exec > >(tee -a "$HOME/Library/Logs/bastra-install.log") 2>&1
echo
echo "════════════════════════════════════════════════════════════"
echo "  Bastra Recall — One-click install"
echo "  log: ~/Library/Logs/bastra-install.log"
echo "════════════════════════════════════════════════════════════"
echo

# 1. Homebrew
if ! command -v brew >/dev/null 2>&1; then
  echo "→ Installing Homebrew (one-time, may ask for your password)…"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # Make brew available in this script's environment
  if [ -x /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [ -x /usr/local/bin/brew ]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
fi

# 2. Tap
if ! brew tap | grep -q "^n0mad-ai/tap$"; then
  echo "→ Adding bastra tap…"
  brew tap n0mad-ai/tap
fi

# 3. Install / upgrade
if brew list bastra-recall >/dev/null 2>&1; then
  echo "→ bastra-recall already installed — checking for updates…"
  # Non-fatal under `set -e`: a transient upgrade failure (network/tap) must not
  # abort before the friendly error block below — registration can still proceed
  # on the already-installed version.
  upgrade_rc=0
  brew upgrade bastra-recall || upgrade_rc=$?
  if [ "$upgrade_rc" -ne 0 ]; then
    echo "  ⚠ upgrade failed (rc=$upgrade_rc) — continuing with the installed version."
  fi
else
  echo "→ Installing bastra-recall…"
  brew install n0mad-ai/tap/bastra-recall
fi

# 4. Register with every supported AI client
echo
echo "→ Registering bastra-recall with Claude Code, Claude Desktop, Cursor…"
install_rc=0
bastra install all || install_rc=$?

# 5. Show status
echo
echo "→ Final status:"
doctor_rc=0
bastra doctor || doctor_rc=$?

if [ "$install_rc" -ne 0 ] || [ "$doctor_rc" -ne 0 ]; then
  echo
  echo "════════════════════════════════════════════════════════════"
  echo "  Install finished with errors."
  echo
  echo "  Log: ~/Library/Logs/bastra-install.log"
  echo "  Run this after fixing the issue:"
  echo "    bastra install all"
  echo "    bastra doctor"
  echo "════════════════════════════════════════════════════════════"
  echo
  echo "(This window will stay open. Press any key to close.)"
  read -r -n 1 -s
  exit 1
fi

echo
echo "════════════════════════════════════════════════════════════"
echo "  ✓ Done."
echo
echo "  Restart Claude Code / Claude Desktop / Cursor"
echo "  to pick up the new memory tool."
echo "════════════════════════════════════════════════════════════"
echo
echo "(This window will stay open. Press any key to close.)"
read -r -n 1 -s
