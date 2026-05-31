# Contributing to Bastra Recall

Thanks for considering a contribution. Bastra is solo-maintained, so the
workflow is light — but a few conventions keep things smooth.

## Before you start

- **Pre-alpha.** Things still change fast. Open an issue before a large PR
  so we can align on direction.
- **One maintainer.** Best-effort response times — sponsors get priority.
- **Scope rule:** the OSS core must stay fully functional **without** the
  paid Mac app. Don't propose changes that move OSS features behind a tier.

## Ways to contribute

| Type | How |
|---|---|
| 🐛 Bug | [Open a bug report](https://github.com/n0mad-ai/bastra-recall/issues/new?template=bug_report.yml) — the form pre-fills the required context (`bastra doctor`, surface, OS, logs) |
| 💡 Feature | [Suggest a feature](https://github.com/n0mad-ai/bastra-recall/issues/new?template=feature_request.yml) — please describe the **problem**, not the solution |
| 💬 Question | [Start a discussion](https://github.com/n0mad-ai/bastra-recall/discussions) |
| 🔧 Code | See "Development setup" below |
| 💖 Sponsor | [github.com/sponsors/n0mad-ai](https://github.com/sponsors/n0mad-ai) — credited in [SUPPORTERS.md](./SUPPORTERS.md) |

## Claiming an issue

If you'd like to work on something — especially a `good first issue` —
drop a short comment on the issue:

> Hi! I'd like to work on this.

You'll be assigned (usually within a day) so nobody duplicates the work.
Once assigned, the issue is yours. If you can't get to it within ~2 weeks,
please leave a note so it can free up for someone else.

Already a few commits in by the time you comment? Even better — link the
branch in your fork.

## Development setup

### Requirements

- Node ≥ 20 (`node --version`)
- macOS for the full experience (Linux works for daemon + CLI; some
  adapters are macOS-only)
- npm (comes with Node)

### Clone, install, build

```bash
git clone https://github.com/n0mad-ai/bastra-recall.git
cd bastra-recall
npm install
npm run build
```

The repo is an npm workspace — `npm install` at the root pulls every
package's dependencies; `npm run build` compiles every workspace.

### Type-check (no emit)

```bash
npm run check:types
```

### Run the daemon locally

```bash
cd packages/daemon
npm run dev
```

Listens on `127.0.0.1:6723`. Logs go to stdout/stderr.

### Use a test vault, not your real one

The daemon mutates files in the vault. Always set
`BASTRA_VAULT_PATH` to a throwaway folder while developing:

```bash
BASTRA_VAULT_PATH=/tmp/bastra-dev-vault npm run dev
```

### Smoke-test

```bash
npm run smoke
```

This uses the public `fixtures/sample-vault` so a fresh clone can verify recall
quality without private data.

### Package check

```bash
npm run pack:check
```

This runs npm pack dry-runs for the publishable workspaces and catches missing
runtime assets such as the packaged Skill or statusline bundle.

## Project structure

```
packages/
  core/       Vault parsing, search index, save logic — no I/O surface
  daemon/     MCP server, HTTP REST, hooks, `bastra` CLI
  skill/      SKILL.md installed into ~/.claude/skills/
distribution/
  homebrew/   Brew formula (head-only)
  Install Bastra.command   Double-click installer
scripts/      One-off telemetry / eval / backfill scripts
```

### Where your change probably lives

- **Search / recall behavior** → `packages/core/`
- **New MCP tool / new REST endpoint** → `packages/daemon/src/`
- **New AI-client adapter** → `packages/daemon/src/cli/adapters/`
- **Skill content / hook prompts** → `packages/skill/`

## Coding conventions

- **TypeScript strict.** `noUnusedLocals`, `noImplicitReturns`, etc. — see
  `packages/daemon/tsconfig.json`.
- **ESM imports need `.js` extensions** (NodeNext module resolution):
  ```ts
  import { foo } from "./helpers.js"; // ✓
  import { foo } from "./helpers";    // ✗ — won't run
  ```
- **Small files.** Soft ceiling ~800 lines per file. If a file grows past
  that, propose a split (or implement one in your PR).
- **Match the existing style.** No drive-by reformatting; `prettier` /
  `eslint` aren't enforced yet.
- **No new dependencies without an issue first.** Every dependency is a
  long-term cost.

## Commit messages

Format: `<scope>: <imperative summary>`. Scopes match what's changing:

- `cli:` — `bastra` CLI / adapters
- `daemon:` — MCP server / HTTP / hooks
- `core:` — vault, schema, search
- `skill:` — `SKILL.md`, hook prompts
- `docs:` — README, PLAN, SUPPORTERS
- `chore:` — tooling, deps, repo plumbing
- `fix:` — bug fix
- `feat:` — user-facing capability

Body explains **why**, not what — the diff already shows what.

## Pull requests

- **From a fork:** fork the repo, branch from `main` in your fork, then
  open the PR against `n0mad-ai/bastra-recall:main`. (You don't need
  write access — the standard GitHub fork-PR flow works.)
- Reference the issue: `Fixes #N` or `Refs #N` in the PR body.
- Include a short **test plan** — what you ran, what you saw. A
  paste of CLI output or a screenshot is enough for most changes.
- Run `npm run check:types` and `npm run build` before opening.
- Smaller PRs land faster — split if you can.
- WIP / draft PRs are welcome; open them as **Draft** PRs (the GitHub
  button) rather than `[WIP]` in the title.

## License + DCO

Bastra Recall is MIT-licensed. By contributing, you agree that your
contribution is released under the same MIT license. No CLA, no extra
forms — we trust the standard inbound = outbound model.

## Recognition

- Every contributor appears in the [GitHub Contributors graph](https://github.com/n0mad-ai/bastra-recall/graphs/contributors).
- [Sponsors are listed in SUPPORTERS.md](./SUPPORTERS.md) by tier.
- Significant feature contributors get a `## Contributors` mention in the
  matching release notes.

## Code of Conduct

Be excellent to each other. Disagreements over technical decisions are
welcome; disrespect for people is not. The maintainer reserves the right
to moderate comments and close discussions that don't follow this rule.
