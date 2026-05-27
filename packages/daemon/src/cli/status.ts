/// <reference types="node" />
import process from "process";
import { probeDaemon } from "./helpers.js";
import { ADAPTERS } from "./registry.js";

interface StatusOptions {
  json?: boolean;
  quiet?: boolean;
}

function printLine(message: string) {
  process.stdout.write(message + "\n");
}

export async function cmdStatus(options: StatusOptions): Promise<number> {
  let hasError = false;
  const statusResult: Record<string, any> = {};

  // 1. Check daemon status
  const daemonInfo = await probeDaemon();
  if (daemonInfo.ok) {
    // Expose daemonInfo.detail as message
    statusResult["daemon"] = { status: "ok", message: daemonInfo.detail };
    if (!options.quiet && !options.json) {
      printLine(`✓ daemon          (${daemonInfo.detail})`);
    }
  } else {
    hasError = true;
    statusResult["daemon"] = { status: "error", message: daemonInfo.detail };
    if (!options.quiet && !options.json) {
      printLine(`✗ daemon          (${daemonInfo.detail})`);
    }
  }

  // 2. Check adapters status
  for (const [name, adapter] of Object.entries(ADAPTERS)) {
    try {
      const r = await adapter.doctor();
      
      if (r.status === "ok") {
        statusResult[name] = { status: "ok", message: r.message };
        if (!options.quiet && !options.json) {
          printLine(`✓ ${name.padEnd(15)} (${r.message})`);
        }
      } else {
        hasError = true;
        statusResult[name] = { status: r.status, message: r.message };
        if (!options.quiet && !options.json) {
          printLine(`✗ ${name.padEnd(15)} (${r.message})`);
        }
      }
    } catch (err) {
      hasError = true;
      const errMsg = (err as Error).message;
      statusResult[name] = { status: "error", message: errMsg };
      if (!options.quiet && !options.json) {
        printLine(`✗ ${name.padEnd(15)} (failed to check: ${errMsg})`);
      }
    }
  }

  // 3. Handle options and flags
  if (options.json) {
    printLine(JSON.stringify(statusResult, null, 2));
  }

  // Return exit code based on error status
  return hasError ? 1 : 0;
}