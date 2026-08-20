import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectDualInstance, stampAndDetect, stampInstance } from "../src/instance-guard.js";

// Dual-instance guard: `omp install` (plugin registry) + a manual extensions
// path in config.yml can both load this package in one process — two fold
// states fight, compressions evaporate (live incident 2026-08-16). The guard
// stamps the load path at session_start and warns when a DIFFERENT path's
// stamp is fresh.

test("no marker / stale marker / same path → silent", async () => {
  const home = await mkdtemp(join(tmpdir(), "acp-instguard-"));
  const prev = { ...process.env, HOME: home, USERPROFILE: home };
  Object.assign(process.env, prev);
  try {
    assert.equal(detectDualInstance("file:///a/dist/index.js"), undefined, "no marker → silent");
    await writeFile(join(home, ".omp", ".billion-context-omp-instance.json"), JSON.stringify({ path: "file:///b/dist/index.js", version: "0.2.0", pid: 1, ts: Date.now() - 61_000 }), { encoding: "utf8" }).catch(async () => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(home, ".omp"), { recursive: true });
      await writeFile(join(home, ".omp", ".billion-context-omp-instance.json"), JSON.stringify({ path: "file:///b/dist/index.js", version: "0.2.0", pid: 1, ts: Date.now() - 61_000 }), { encoding: "utf8" });
    });
    assert.equal(detectDualInstance("file:///a/dist/index.js"), undefined, "stale marker (>60s) → silent");
    assert.equal(detectDualInstance("file:///b/dist/index.js"), undefined, "same path → silent");
  } finally {
    delete process.env.HOME; process.env.HOME = prev.HOME;
    process.env.USERPROFILE = prev.USERPROFILE;
    await rm(home, { recursive: true, force: true });
  }
});

test("fresh marker from a different path → conflict reported, then overwritten by stampAndDetect", async () => {
  const home = await mkdtemp(join(tmpdir(), "acp-instguard2-"));
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home; process.env.USERPROFILE = home;
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(home, ".omp"), { recursive: true });
    await writeFile(join(home, ".omp", ".billion-context-omp-instance.json"), JSON.stringify({ path: "file:///plugins/dist/index.js", version: "0.2.0", pid: 42, ts: Date.now() }), { encoding: "utf8" });

    const conflict = stampAndDetect("file:///projects/billion-context-omp/dist/index.js", "0.2.1");
    assert.ok(conflict, "conflict detected");
    assert.equal(conflict!.path, "file:///plugins/dist/index.js");
    assert.equal(conflict!.pid, 42);

    const raw = JSON.parse(await readFile(join(home, ".omp", ".billion-context-omp-instance.json"), "utf8"));
    assert.equal(raw.path, "file:///projects/billion-context-omp/dist/index.js", "stamp overwritten by self");
    assert.equal(raw.pid, process.pid);
    // Second instance stamps first → first instance now sees OUR fresh stamp.
    stampInstance("file:///plugins/dist/index.js", "0.2.0");
    const back = detectDualInstance("file:///projects/billion-context-omp/dist/index.js");
    assert.ok(back, "detection is symmetric");
  } finally {
    process.env.HOME = prev.HOME; process.env.USERPROFILE = prev.USERPROFILE;
    await rm(home, { recursive: true, force: true });
  }
});

test("host cache-busting query (?mtime=) on the same physical path is NOT a dual instance (issue #88)", async () => {
  const home = await mkdtemp(join(tmpdir(), "acp-instguard3-"));
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home; process.env.USERPROFILE = home;
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(home, ".omp"), { recursive: true });
    const marker = join(home, ".omp", ".billion-context-omp-instance.json");
    // The other instance stamped a url WITH a ?mtime= cache-bust query.
    await writeFile(marker, JSON.stringify({ path: "file:///ext/dist/index.js?mtime=1724000000000", version: "0.2.6", pid: 7, ts: Date.now() }), { encoding: "utf8" });
    assert.equal(detectDualInstance("file:///ext/dist/index.js"), undefined, "same physical file, fresh ?mtime= marker → silent");
    assert.equal(detectDualInstance("file:///ext/dist/index.js?mtime=1724000999999"), undefined, "different mtime value, same physical file → silent");
    // A genuinely different physical path still conflicts.
    const conflict = stampAndDetect("file:///other/dist/index.js?mtime=1724000000000", "0.2.6");
    assert.ok(conflict, "different physical path still conflicts");
    assert.equal(conflict!.path, "file:///ext/dist/index.js?mtime=1724000000000", "marker is stamped raw (diagnostics keep the url)");
  } finally {
    process.env.HOME = prev.HOME; process.env.USERPROFILE = prev.USERPROFILE;
    await rm(home, { recursive: true, force: true });
  }
});
