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
  brew upgrade bastra-recall || true
else
  echo "→ Installing bastra-recall…"
  brew install n0mad-ai/tap/bastra-recall
fi

# 4. Register with every supported AI client
echo
echo "→ Registering bastra-recall with Claude Code, Claude Desktop, Cursor…"
bastra install all || true

# 5. Show status
echo
echo "→ Final status:"
bastra doctor || true

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
