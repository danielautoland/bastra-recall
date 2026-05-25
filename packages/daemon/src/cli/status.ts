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

  // 1. Daemon 상태 확인 (helpers.ts의 실제 probeDaemon 리턴 타입 반영)
  const daemonInfo = await probeDaemon();
  if (daemonInfo.ok) {
    // daemonInfo.detail에 "vault_size=157" 형태로 들어있으므로 파싱하거나 그대로 노출
    statusResult["daemon"] = { status: "ok", detail: daemonInfo.detail };
    if (!options.quiet && !options.json) {
      printLine(`✓ daemon          (${daemonInfo.detail})`);
    }
  } else {
    hasError = true;
    statusResult["daemon"] = { status: "error", detail: daemonInfo.detail };
    if (!options.quiet && !options.json) {
      printLine(`✗ daemon          (${daemonInfo.detail})`);
    }
  }

  // 2. 어댑터(클라이언트) 상태 확인 (registry.ts의 ADAPTERS 활용)
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

  // 3. 플래그(options) 조건 처리
  if (options.json) {
    printLine(JSON.stringify(statusResult, null, 2));
  }

  // quiet 플래그가 있으면 프로세스를 강제 종료하고, 없으면 일반 리턴 코드를 반환합니다.
  if (options.quiet) {
    process.exit(hasError ? 1 : 0);
  }

  return hasError ? 1 : 0;
}