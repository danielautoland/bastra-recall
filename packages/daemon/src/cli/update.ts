import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cmdInstall } from "./commands.js";
import type { ParsedArgs } from "./types.js";

const LAUNCH_AGENT_LABEL = "ai.n0mad.bastra-recall";

export type InstallSource = "brew" | "npm-global" | "source" | "unknown";

export interface InstallMode {
  mode: InstallSource;
  cliPath: string;
  detail: string;
  updateCommand: string;
}

/**
 * Heuristic — uses the on-disk path of this CLI module:
 *   /opt/homebrew or /Cellar    → brew
 *   …/node_modules/@bastra-recall/daemon/dist/cli/update.js
 *     (npm prefix root)        → npm-global
 *   path under a git working tree (sibling package.json + .git up the tree)
 *                                → source
 *   else                          → unknown
 */
export function detectInstallMode(cliPathOverride?: string): InstallMode {
  const cliPath = cliPathOverride ?? fileURLToPath(import.meta.url);

  // Homebrew Cellar
  if (
    cliPath.startsWith("/opt/homebrew/") ||
    cliPath.startsWith("/usr/local/Cellar/") ||
    cliPath.includes("/homebrew/Cellar/") ||
    cliPath.includes("/Cellar/bastra-recall/")
  ) {
    return {
      mode: "brew",
      cliPath,
      detail: "installed via Homebrew",
      updateCommand: "brew upgrade bastra-recall",
    };
  }

  // npm-global: cliPath sits inside a `node_modules/@bastra-recall/daemon/` tree.
  if (cliPath.includes("/node_modules/@bastra-recall/") || cliPath.includes("/lib/node_modules/")) {
    return {
      mode: "npm-global",
      cliPath,
      detail: "installed via npm (global)",
      updateCommand: "npm install -g @bastra-recall/daemon@latest",
    };
  }

  // source: walk up from the cli file, look for a .git directory next to a package.json.
  if (hasGitAncestor(cliPath)) {
    return {
      mode: "source",
      cliPath,
      detail: "running from source checkout",
      updateCommand: "git pull && npm ci && npm run build",
    };
  }

  return {
    mode: "unknown",
    cliPath,
    detail: "unable to determine install mode",
    updateCommand: "see https://github.com/n0mad-ai/bastra-recall/releases",
  };
}

function hasGitAncestor(start: string): boolean {
  let dir = dirname(start);
  for (let i = 0; i < 12; i++) {
    if (existsSync(resolve(dir, ".git"))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  return false;
}

function launchAgentPresent(uid: string): boolean {
  const r = spawnSync("launchctl", ["print", `gui/${uid}/${LAUNCH_AGENT_LABEL}`], { stdio: "pipe" });
  return r.status === 0;
}

export async function cmdUpdate(args: ParsedArgs): Promise<number> {
  const mode = detectInstallMode();
  process.stdout.write(`→ install mode: ${mode.detail}\n`);
  process.stdout.write(`  cli path: ${mode.cliPath}\n\n`);

  if (args.dryRun) {
    process.stdout.write("(dry-run — describing what would happen, writing nothing)\n\n");
    process.stdout.write(`→ install source: ${mode.mode}\n`);
    process.stdout.write(`  update command: ${mode.updateCommand}\n\n`);
    process.stdout.write("  would: 1) run the update command above\n");
    process.stdout.write("         2) re-register every surface (idempotent)\n");
    process.stdout.write("         3) restart the daemon\n");
    return 0;
  }

  // 1. Update the binary itself
  if (mode.mode === "brew") {
    process.stdout.write(`→ ${mode.updateCommand}\n`);
    if (!args.dryRun) {
      const r = spawnSync("brew", ["upgrade", "bastra-recall"], { stdio: "inherit" });
      if (r.status !== 0 && r.status !== null) {
        process.stdout.write("\n✗ brew upgrade failed — fix it manually, then re-run 'bastra update'\n");
        return 1;
      }
    } else {
      process.stdout.write(`  would run: ${mode.updateCommand}\n`);
    }
    process.stdout.write("\n");
  } else if (mode.mode === "npm-global") {
    process.stdout.write(`→ ${mode.updateCommand}\n`);
    if (!args.dryRun) {
      const r = spawnSync("npm", ["install", "-g", "@bastra-recall/daemon@latest"], { stdio: "inherit" });
      if (r.status !== 0 && r.status !== null) {
        process.stdout.write("\n✗ npm install failed — fix it manually, then re-run 'bastra update'\n");
        return 1;
      }
    } else {
      process.stdout.write(`  would run: ${mode.updateCommand}\n`);
    }
    process.stdout.write("\n");
  } else if (mode.mode === "source") {
    process.stdout.write("→ source install — rebuild yourself first if you haven't:\n");
    process.stdout.write(`    cd <bastra-recall> && ${mode.updateCommand}\n`);
    process.stdout.write("  Then re-run 'bastra update' to refresh configs + restart the daemon.\n\n");
  } else {
    process.stdout.write("⚠ install mode unknown — install manually from:\n");
    process.stdout.write(`    ${mode.updateCommand}\n\n`);
  }

  // 2. Re-register every surface (idempotent — refreshes skill content if SKILL.md changed)
  process.stdout.write("→ re-registering with every supported surface (idempotent)\n\n");
  const installArgs: ParsedArgs = { ...args, command: "install", surface: "all" };
  const installRC = await cmdInstall(installArgs);
  if (installRC !== 0) {
    process.stdout.write("✗ re-register failed — fix the surface errors above, then re-run\n");
    return installRC;
  }

  // 3. Restart the daemon so the new code is actually loaded
  process.stdout.write("→ restarting daemon\n");
  const uid = String(process.getuid?.() ?? 0);
  if (launchAgentPresent(uid)) {
    if (args.dryRun) {
      process.stdout.write("  would kickstart LaunchAgent\n\n");
    } else {
      const kick = spawnSync(
        "launchctl",
        ["kickstart", "-k", `gui/${uid}/${LAUNCH_AGENT_LABEL}`],
        { stdio: "inherit" },
      );
      if (kick.status === 0) process.stdout.write("  ✓ LaunchAgent kicked — daemon restarted with new code\n\n");
      else process.stdout.write("  ✗ kickstart failed — restart the daemon manually\n\n");
    }
  } else {
    process.stdout.write("  no LaunchAgent registered — running daemon (if any) still holds the old code in memory\n");
    process.stdout.write("  Restart it manually:\n");
    process.stdout.write("    lsof -i :6723             # find the daemon pid\n");
    process.stdout.write("    kill <pid>                 # forwarder respawns it with new code on next call\n\n");
  }

  process.stdout.write("→ done. Restart any open AI clients (Claude Code, Claude Desktop, Cursor) to pick up the new code.\n");
  return 0;
}
