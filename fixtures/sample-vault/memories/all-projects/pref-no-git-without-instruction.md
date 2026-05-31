---
id: pref-no-git-without-instruction
title: "Do not create git commits without instruction"
type: preference
summary: "Do not run git commit, amend, push, or release commands unless the user explicitly asks for that git action in the current task."
topic_path: [workflow, git]
tags: [git, commit, workflow, safety]
scope: all-projects
recall_when:
  - git commit
  - preparing a commit
  - running git push or release commands
related: []
related_via: []
sensitivity: team
source: "public sample vault"
confidence: 1
created: 2026-05-01
updated: 2026-05-01
---

## Rule
Only create commits, amend commits, or push branches after explicit user instruction.

## Why
Git operations change shared history and user workflow expectations.

## How to apply
It is fine to inspect `git status` or `git diff`; stop before mutating git history unless asked.
