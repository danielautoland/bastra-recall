import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { unlink } from "node:fs/promises";
import {
  readExitCode,
  extractErrorContext,
  extractCommandHead,
  extractErrorKeywords,
  formatHintBlock,
  isThrottled,
  markThrottle,
  throttleFile,
} from "../src/bash-fail-hook.js";

const SESSION = "test-session-fail-hook";

async function clearThrottle(): Promise<void> {
  try {
    await unlink(throttleFile(SESSION));
  } catch {
    // ignore
  }
}

describe("bash-fail-hook: readExitCode", () => {
  it("reads exit_code from numeric field", () => {
    assert.equal(readExitCode({ exit_code: 1 }), 1);
  });
  it("reads from camelCase exitCode", () => {
    assert.equal(readExitCode({ exitCode: 2 }), 2);
  });
  it("parses string exit codes", () => {
    assert.equal(readExitCode({ exit_code: "127" }), 127);
  });
  it("returns null when missing", () => {
    assert.equal(readExitCode({}), null);
  });
});

describe("bash-fail-hook: extractCommandHead", () => {
  it("returns first 3 tokens of first clause", () => {
    assert.equal(extractCommandHead("npm install --save react"), "npm install --save");
  });
  it("stops at pipeline operators", () => {
    assert.equal(extractCommandHead("ls -la | grep foo"), "ls -la");
  });
});

describe("bash-fail-hook: extractErrorContext", () => {
  it("prefers error/Failed/fatal lines", () => {
    const out = extractErrorContext({
      stderr: "doing things\nthings happen\nError: ENOENT no such file\ndone",
    });
    assert.match(out, /Error: ENOENT/);
  });
  it("falls back to tail when no interesting lines", () => {
    const out = extractErrorContext({ stderr: "plain noise" });
    assert.equal(out, "plain noise");
  });
});

describe("bash-fail-hook: extractErrorKeywords", () => {
  it("extracts alpha-token keywords, deduped, capped", () => {
    const out = extractErrorKeywords("Error: ENOENT module not found react react react");
    assert.match(out, /Error/);
    assert.match(out, /ENOENT/);
    assert.match(out, /module/);
    // dedup: 'react' should appear once
    assert.equal((out.match(/react/g) ?? []).length, 1);
  });
});

describe("bash-fail-hook: formatHintBlock", () => {
  it("emits bash-fail trigger and the failure-mode wording", () => {
    const out = formatHintBlock([
      {
        id: "some-lesson",
        title: "t",
        type: "lesson",
        scope: "all",
        summary: "s",
        score: 80,
      },
    ]);
    assert.match(out, /trigger="bash-fail"/);
    assert.match(out, /failure modes/);
    assert.match(out, /some-lesson/);
  });
});

describe("bash-fail-hook: throttle", () => {
  beforeEach(async () => {
    await clearThrottle();
  });

  it("is not throttled before any markThrottle call", async () => {
    assert.equal(await isThrottled(SESSION), false);
  });

  it("is throttled immediately after markThrottle", async () => {
    await markThrottle(SESSION);
    assert.equal(await isThrottled(SESSION), true);
  });
});
