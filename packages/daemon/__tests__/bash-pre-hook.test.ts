import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { matchPattern, formatHintBlock } from "../src/bash-pre-hook.js";

describe("bash-pre-hook: matchPattern", () => {
  it("matches rm -rf as destructive", () => {
    const m = matchPattern("rm -rf /tmp/x");
    assert.ok(m, "expected match");
    assert.equal(m!.severity, "destructive");
    assert.equal(m!.label, "rm -rf");
  });

  it("matches git reset --hard as destructive", () => {
    const m = matchPattern("git reset --hard origin/main");
    assert.ok(m);
    assert.equal(m!.severity, "destructive");
    assert.equal(m!.label, "git reset --hard");
  });

  it("matches git push --force as destructive", () => {
    const m = matchPattern("git push --force origin main");
    assert.ok(m);
    assert.equal(m!.severity, "destructive");
  });

  it("matches git push -f as destructive", () => {
    const m = matchPattern("git push -f origin feat/x");
    assert.ok(m);
    assert.equal(m!.severity, "destructive");
  });

  it("matches DROP TABLE (case-insensitive)", () => {
    const m = matchPattern("psql -c 'drop table users;'");
    assert.ok(m);
    assert.equal(m!.label, "DROP TABLE");
  });

  it("matches npm uninstall", () => {
    const m = matchPattern("npm uninstall react");
    assert.ok(m);
    assert.equal(m!.label, "npm uninstall");
  });

  it("matches docker volume rm", () => {
    const m = matchPattern("docker volume rm myvol");
    assert.ok(m);
    assert.equal(m!.label, "docker volume rm");
  });

  it("matches kubectl delete", () => {
    const m = matchPattern("kubectl delete pod foo");
    assert.ok(m);
    assert.equal(m!.label, "kubectl delete");
  });

  it("matches chmod -R as risky", () => {
    const m = matchPattern("chmod -R 755 ./dist");
    assert.ok(m);
    assert.equal(m!.severity, "risky");
    assert.equal(m!.label, "chmod -R");
  });

  it("matches find ... -exec rm as risky", () => {
    const m = matchPattern("find . -name '*.tmp' -exec rm {} ;");
    assert.ok(m);
    assert.equal(m!.severity, "risky");
  });

  it("matches > overwrite redirect as risky", () => {
    const m = matchPattern("echo hi > /etc/hosts");
    assert.ok(m);
    assert.equal(m!.severity, "risky");
  });

  it("does NOT match ls -la", () => {
    assert.equal(matchPattern("ls -la"), null);
  });

  it("does NOT match git status", () => {
    assert.equal(matchPattern("git status"), null);
  });

  it("does NOT match >> append redirect", () => {
    assert.equal(matchPattern("echo hi >> log.txt"), null);
  });

  it("does NOT match 2> stderr redirect alone", () => {
    assert.equal(matchPattern("cmd 2> err.log"), null);
  });

  it("does NOT match echo with no redirect", () => {
    assert.equal(matchPattern("echo hello world"), null);
  });
});

describe("bash-pre-hook: formatHintBlock", () => {
  it("emits destructive trigger and STOP wording", () => {
    const out = formatHintBlock("rm -rf", "destructive", []);
    assert.match(out, /trigger="bash-destructive"/);
    assert.match(out, /STOP — destructive/);
    assert.match(out, /rm -rf/);
  });

  it("emits risky trigger and CAUTION wording", () => {
    const out = formatHintBlock("chmod -R", "risky", []);
    assert.match(out, /trigger="bash-risky"/);
    assert.match(out, /CAUTION/);
  });

  it("includes hits when present", () => {
    const hits = [
      {
        id: "no-force-push",
        title: "no force push",
        type: "user-preference",
        scope: "all-projects",
        summary: "Never force-push without explicit ok.",
        score: 95,
      },
    ];
    const out = formatHintBlock("git push --force", "destructive", hits);
    assert.match(out, /no-force-push/);
    assert.match(out, /score 95/);
  });
});
