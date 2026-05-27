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
  cmdStatus,
  parseArgs,
  showHelp,
  showVersion,
} from "./cli/commands.js";
import { cmdUpdate } from "./cli/update.js";

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.showVersion) { showVersion(); return 0; }
  if (args.showHelp && !args.command) { showHelp(); return 0; }
  if (!args.command || args.command === "help") { showHelp(); return 0; }

  switch (args.command) {
    case "version": showVersion(); return 0;
    case "install": return cmdInstall(args);
    case "uninstall": return cmdUninstall(args);
    case "doctor": return cmdDoctor(args);
    case "update": return cmdUpdate(args);
    case "status": {
      const rc = await cmdStatus({ json: args.json, quiet: args.quiet });
      return rc;
    }
    default:
      process.stderr.write(`error: unknown command '${args.command}' — run 'bastra help'\n`);
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`fatal: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  },
);
