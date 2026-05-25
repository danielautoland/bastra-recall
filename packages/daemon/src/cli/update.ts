import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cmdInstall } from "./commands.js";
import type { ParsedArgs } from "./types.js";

const LAUNCH_AGENT_LABEL = "ai.n0mad.bastra-recall";

interface InstallMode {
  mode: "brew" | "source" | "unknown";
  cliPath: string;
  detail: string;
}

function detectInstallMode(): InstallMode {
  const cliPath = fileURLToPath(import.meta.url);
  if (
    cliPath.startsWith("/opt/homebrew/") ||
    cliPath.startsWith("/usr/local/Cellar/") ||
    cliPath.includes("/homebrew/Cellar/") ||
    cliPath.includes("/Cellar/bastra-recall/")
  ) {
    return { mode: "brew", cliPath, detail: "installed via Homebrew" };
  }
  if (cliPath.includes("/Projekte/") || cliPath.includes("/repos/") || cliPath.includes("/src/")) {
    return { mode: "source", cliPath, detail: "running from source checkout" };
  }
  return { mode: "unknown", cliPath, detail: "unable to determine install mode" };
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
  }

  // 1. Update the binary itself
  if (mode.mode === "brew") {
    process.stdout.write("→ brew upgrade bastra-recall\n");
    if (!args.dryRun) {
      const r = spawnSync("brew", ["upgrade", "bastra-recall"], { stdio: "inherit" });
      if (r.status !== 0 && r.status !== null) {
        process.stdout.write("\n✗ brew upgrade failed — fix it manually, then re-run 'bastra update'\n");
        return 1;
      }
    } else {
      process.stdout.write("  would run: brew upgrade bastra-recall\n");
    }
    process.stdout.write("\n");
  } else if (mode.mode === "source") {
    process.stdout.write("→ source install — rebuild yourself first if you haven't:\n");
    process.stdout.write("    cd <bastra-recall> && git pull && npm install && npm run build\n");
    process.stdout.write("  Then re-run 'bastra update' to refresh configs + restart the daemon.\n\n");
  } else {
    process.stdout.write("⚠ install mode unknown — make sure your code is up to date before continuing\n\n");
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
