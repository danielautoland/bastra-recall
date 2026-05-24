#!/usr/bin/env bash
# install bastra-recall skill into ~/.claude/skills/bastra-recall/
# rerun after every change to SKILL.md to refresh the local copy.
#
# Migration: removes any pre-existing ~/.claude/skills/nexus-recall/ so the
# old skill doesn't shadow the new one in the Claude Code skill loader.

set -euo pipefail

src="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dst="${HOME}/.claude/skills/bastra-recall"
legacy="${HOME}/.claude/skills/nexus-recall"

if [ -d "${legacy}" ]; then
  echo "→ removing legacy skill at ${legacy}"
  rm -rf "${legacy}"
fi

mkdir -p "${dst}"
cp "${src}/SKILL.md" "${dst}/SKILL.md"

echo "✓ bastra-recall skill installed at ${dst}/SKILL.md"
echo "  Restart Claude Code so the skill loader picks up the new file."
