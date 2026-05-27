/**
 * Tests for src/update-check.ts (#39).
 *
 * Uses node:test runner via tsx — no extra deps. Network calls are stubbed
 * via the injectable `fetchLatest` option, so this passes offline.
 *
 * Run: npx tsx --test packages/daemon/scripts/update-check.test.ts
 *      (or: npm run test:update --workspace=@bastra-recall/daemon)
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  compareVersions,
  checkForUpdate,
  isOptedOut,
} from "../src/update-check.js";
import { detectInstallMode } from "../src/cli/update.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-update-check-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("compareVersions: numeric ordering", () => {
  assert.equal(compareVersions("0.5.2", "0.6.0"), -1);
  assert.equal(compareVersions("0.6.0", "1.0.0"), -1);
  assert.equal(compareVersions("0.6.0", "0.6.0"), 0);
  assert.equal(compareVersions("1.2.3", "1.2.4"), -1);
  assert.equal(compareVersions("1.2.10", "1.2.2"), 1); // numeric, not lexical
  assert.equal(compareVersions("2.0.0", "1.99.99"), 1);
});

test("compareVersions: tolerates 'v' prefix and pre-release", () => {
  assert.equal(compareVersions("v0.6.0", "0.6.0"), 0);
  assert.equal(compareVersions("0.6.0-rc.1", "0.6.0"), 0);
  assert.equal(compareVersions("v0.5.0", "v0.6.0"), -1);
});

test("checkForUpdate: cache hit within TTL skips fetch", async () => {
  await withTempDir(async (dir) => {
    const cachePath = join(dir, "cache.json");
    const now = Date.now();
    await writeFile(cachePath, JSON.stringify({
      last_checked_at: new Date(now - 60_000).toISOString(),
      current: "0.5.2",
      latest: "0.6.0",
      html_url: "https://example.com/v0.6.0",
      published_at: "2026-05-20T00:00:00Z",
      hasUpdate: true,
    }), "utf8");

    let fetchCalls = 0;
    const state = await checkForUpdate({
      currentVersion: "0.5.2",
      cachePath,
      ttlMs: 24 * 60 * 60 * 1000,
      now,
      fetchLatest: async () => {
        fetchCalls++;
        return null;
      },
    });
    assert.equal(fetchCalls, 0, "fetch must not be called when cache is fresh");
    assert.ok(state);
    assert.equal(state.latest, "0.6.0");
    assert.equal(state.hasUpdate, true);
  });
});

test("checkForUpdate: cache miss triggers fetch + writes cache", async () => {
  await withTempDir(async (dir) => {
    const cachePath = join(dir, "cache.json");
    const now = Date.now();
    let fetchCalls = 0;
    const state = await checkForUpdate({
      currentVersion: "0.5.2",
      cachePath,
      ttlMs: 24 * 60 * 60 * 1000,
      now,
      fetchLatest: async () => {
        fetchCalls++;
        return {
          tag: "v0.6.0",
          html_url: "https://example.com/v0.6.0",
          published_at: "2026-05-20T00:00:00Z",
          body: "release notes",
        };
      },
    });
    assert.equal(fetchCalls, 1);
    assert.ok(state);
    assert.equal(state.current, "0.5.2");
    assert.equal(state.latest, "0.6.0");
    assert.equal(state.hasUpdate, true);

    const cached = JSON.parse(await readFile(cachePath, "utf8"));
    assert.equal(cached.latest, "0.6.0");
    assert.equal(cached.hasUpdate, true);
  });
});

test("checkForUpdate: when local is current, hasUpdate=false", async () => {
  await withTempDir(async (dir) => {
    const cachePath = join(dir, "cache.json");
    const state = await checkForUpdate({
      currentVersion: "0.6.0",
      cachePath,
      ttlMs: 24 * 60 * 60 * 1000,
      now: Date.now(),
      fetchLatest: async () => ({
        tag: "0.6.0",
        html_url: "",
        published_at: "",
        body: "",
      }),
    });
    assert.ok(state);
    assert.equal(state.hasUpdate, false);
  });
});

test("checkForUpdate: opt-out via env returns null without fetching", async () => {
  await withTempDir(async (dir) => {
    const prev = process.env.BASTRA_UPDATE_CHECK;
    process.env.BASTRA_UPDATE_CHECK = "off";
    try {
      assert.equal(isOptedOut(), true);
      let fetchCalls = 0;
      const state = await checkForUpdate({
        currentVersion: "0.5.2",
        cachePath: join(dir, "cache.json"),
        ttlMs: 24 * 60 * 60 * 1000,
        now: Date.now(),
        fetchLatest: async () => {
          fetchCalls++;
          return null;
        },
      });
      assert.equal(state, null);
      assert.equal(fetchCalls, 0);
    } finally {
      if (prev === undefined) delete process.env.BASTRA_UPDATE_CHECK;
      else process.env.BASTRA_UPDATE_CHECK = prev;
    }
  });
});

test("checkForUpdate: stale-cache fallback when fetch returns null", async () => {
  await withTempDir(async (dir) => {
    const cachePath = join(dir, "cache.json");
    const now = Date.now();
    // Cache older than TTL
    await writeFile(cachePath, JSON.stringify({
      last_checked_at: new Date(now - 48 * 60 * 60 * 1000).toISOString(),
      current: "0.5.2",
      latest: "0.6.0",
      html_url: "https://example.com",
      published_at: "2026-05-01T00:00:00Z",
      hasUpdate: true,
    }), "utf8");

    const state = await checkForUpdate({
      currentVersion: "0.5.2",
      cachePath,
      ttlMs: 24 * 60 * 60 * 1000,
      now,
      fetchLatest: async () => null, // simulate offline
    });
    assert.ok(state, "should fall back to stale cache when fetch fails");
    assert.equal(state.latest, "0.6.0");
  });
});

test("detectInstallMode: brew path", () => {
  const m = detectInstallMode("/opt/homebrew/Cellar/bastra-recall/0.5.2/libexec/dist/cli.js");
  assert.equal(m.mode, "brew");
  assert.match(m.updateCommand, /brew upgrade/);
});

test("detectInstallMode: npm-global path", () => {
  const m = detectInstallMode("/Users/x/.nvm/versions/node/v20.0.0/lib/node_modules/@bastra-recall/daemon/dist/cli.js");
  assert.equal(m.mode, "npm-global");
  assert.match(m.updateCommand, /npm install -g/);
});

test("detectInstallMode: source checkout with .git ancestor", async () => {
  await withTempDir(async (dir) => {
    // Build a fake source tree: dir/.git + dir/packages/daemon/dist/cli.js
    await mkdir(join(dir, ".git"), { recursive: true });
    await mkdir(join(dir, "packages", "daemon", "dist"), { recursive: true });
    const fakeCli = join(dir, "packages", "daemon", "dist", "cli.js");
    await writeFile(fakeCli, "// fake", "utf8");
    const m = detectInstallMode(fakeCli);
    assert.equal(m.mode, "source");
    assert.match(m.updateCommand, /git pull/);
  });
});

test("detectInstallMode: unknown path", () => {
  const m = detectInstallMode("/tmp/some/random/place/cli.js");
  // /tmp has no .git ancestor → unknown
  assert.equal(m.mode, "unknown");
  assert.match(m.updateCommand, /github\.com/);
});
