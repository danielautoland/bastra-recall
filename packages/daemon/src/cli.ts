#!/usr/bin/env node
/**
 * bastra — CLI to install/uninstall/check bastra-recall across AI clients.
 *
 * One command, every MCP-capable client: the user installs once and bastra-recall
 * is reachable from Claude Code, Claude Desktop, Cursor, etc. See vision in
 * bastra-recall#7 + memory `bastra-vision-universal-cross-surface-memory-onboarding`.
 *
 * Entry point only — parsing, adapters, commands live in ./cli/.
 */

import {
  cmdDoctor,
  cmdInstall,
  cmdUninstall,
  parseArgs,
  showHelp,
  showVersion,
} from "./cli/commands.js";
import { cmdUpdate } from "./cli/update.js";
import { maybeEmitUpdateHint } from "./cli/update-hint.js";

async function dispatch(args: ReturnType<typeof parseArgs>): Promise<number> {
  if (args.showVersion) { showVersion(); return 0; }
  if (args.showHelp && !args.command) { showHelp(); return 0; }
  if (!args.command || args.command === "help") { showHelp(); return 0; }

  switch (args.command) {
    case "version": showVersion(); return 0;
    case "install": return cmdInstall(args);
    case "uninstall": return cmdUninstall(args);
    case "doctor": return cmdDoctor(args);
    case "update": return cmdUpdate(args);
    default:
      process.stderr.write(`error: unknown command '${args.command}' — run 'bastra help'\n`);
      return 2;
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const code = await dispatch(args);

  // After every subcommand: optionally emit a dim update hint to stderr.
  // Skip for `bastra update` itself (the user is already mid-update) and for
  // help/version (low-noise commands; users hit them often).
  const skipHint = args.command === "update" || args.command === "help" || args.command === "version" || args.showHelp || args.showVersion;
  if (!skipHint) {
    try { await maybeEmitUpdateHint(); } catch { /* never break the CLI over this */ }
  }
  return code;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`fatal: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  },
);
