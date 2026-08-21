import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import {
  checkForUpdate,
  findNpmRoot,
  autoInstallLatest,
  setRunNpmForTest,
  setRunNodeForTest,
} from "../src/update.js";
import type { NpmRunner, NodeRunner } from "../src/update.js";

// Opt-out must short-circuit BEFORE any network/filesystem touch. We assert this
// by making global fetch throw if it is ever reached.
function withFetchGuard<T>(fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("fetch must not be called when auto-update is disabled");
  }) as unknown as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

test("checkForUpdate is a no-op when autoUpdate=false (no fetch)", async () => {
  delete process.env.ACP_AUTO_UPDATE;
  await withFetchGuard(() => checkForUpdate(false));
});

test("checkForUpdate is a no-op for every opt-out env value, case-insensitive (no fetch)", async () => {
  const opts = ["0", "false", "no", "off", "FALSE", "No", "Off"];
  for (const v of opts) {
    process.env.ACP_AUTO_UPDATE = v;
    await withFetchGuard(() => checkForUpdate(true));
  }
  delete process.env.ACP_AUTO_UPDATE;
});

test("checkForUpdate trims surrounding whitespace in ACP_AUTO_UPDATE before matching (no fetch)", async () => {
  for (const v of [" false ", "\t no\t", "  off "]) {
    process.env.ACP_AUTO_UPDATE = v;
    await withFetchGuard(() => checkForUpdate(true));
  }
  delete process.env.ACP_AUTO_UPDATE;
});

test("findNpmRoot locates the package root when nested under node_modules", () => {
  const ext = join(homedir(), "x", "node_modules", "billion-context-omp");
  assert.equal(findNpmRoot(ext), join(homedir(), "x"));
});

test("findNpmRoot terminates when no node_modules ancestor exists (no Windows infinite loop)", { timeout: 2000 }, () => {
  assert.equal(findNpmRoot(homedir()), undefined);
});

test("a failed registry fetch does not burn the throttle window (issue #14 Minor3)", async () => {
  // The throttle stamp used to be written BEFORE the fetch: one network
  // failure silenced update checks for the full 3-minute window. Now the
  // stamp is only written once the request has actually gone out. Redirect
  // HOME to a scratch dir so the real throttle file is never touched.
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const tmp = fs.mkdtempSync(join(os.tmpdir(), "acp-update-order-"));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  delete process.env.ACP_AUTO_UPDATE;
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  try {
    await checkForUpdate(true);
  } finally {
    globalThis.fetch = original;
    process.env.HOME = saved.HOME;
    process.env.USERPROFILE = saved.USERPROFILE;
  }
  const throttle = path.join(tmp, ".omp", ".billion-context-omp-update-check");
  assert.ok(!fs.existsSync(throttle), "no throttle stamp after a failed fetch — retry stays possible");
  fs.rmSync(tmp, { recursive: true, force: true });
});

// --- autoInstallLatest install path (verify + rollback) -------------------
//
// The real discovery walk can never reach a fixture (the test process is not
// under a node_modules tree), so autoInstallLatest takes an npmDirOverride.
// npm is faked entirely; the smoke-import child is a REAL node process from
// PATH (under `bun test`, process.execPath is bun — spawn node explicitly so
// the smoke script runs under the same engine users run).

type Fixture = {
  root: string;
  extDir: string;
  writeInstalled: (version: string, opts?: { brokenEntry?: boolean }) => void;
};

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "omp-install-test-"));
  const extDir = join(root, "node_modules", "billion-context-omp");
  const writeInstalled: Fixture["writeInstalled"] = (version, opts) => {
    mkdirSync(join(extDir, "dist"), { recursive: true });
    const body = opts?.brokenEntry ? "export const broken = (!" : "export const loaded = true;\n";
    writeFileSync(join(extDir, "dist", "index.js"), body, "utf-8");
    writeFileSync(
      join(extDir, "package.json"),
      JSON.stringify(
        {
          name: "billion-context-omp",
          version,
          main: "dist/index.js",
          exports: { ".": { import: "./dist/index.js" } },
          omp: { extensions: ["./dist/index.js"] },
        },
        null,
        2,
      ),
      "utf-8",
    );
  };
  return { root, extDir, writeInstalled };
}

// Real node child for the smoke import — this is the whole point: a genuinely
// loadable entry, not a mocked success.
const realNodeFromPath: NodeRunner = (args) =>
  new Promise((resolve) => {
    import("node:child_process").then(({ execFile }) =>
      execFile("node", args, { timeout: 15_000 }, (err, stdout, stderr) =>
        resolve({ code: err ? 1 : 0, stdout: String(stdout), stderr: String(stderr) }),
      ),
    );
  });

test("autoInstallLatest: clean install verifies via real smoke import and reports ok", { timeout: 60_000 }, async () => {
  const fx = makeFixture();
  fx.writeInstalled("1.0.0");
  const calls: string[][] = [];
  const fakeNpm: NpmRunner = async (args) => {
    calls.push(args);
    const target = String(args[1] ?? "");
    if (target.endsWith("@9.9.9")) fx.writeInstalled("9.9.9");
    return { code: 0, stdout: "", stderr: "" };
  };
  setRunNpmForTest(fakeNpm);
  setRunNodeForTest(realNodeFromPath);
  try {
    const outcome = await autoInstallLatest("9.9.9", fx.root);
    assert.equal(outcome, "ok");
    assert.ok(calls.some((a) => a.includes("billion-context-omp@9.9.9")), "installs the new version");
    assert.ok(calls.every((a) => a.includes("--no-save")), "never mutates the host manifest");
  } finally {
    setRunNpmForTest(undefined);
    setRunNodeForTest(undefined);
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("autoInstallLatest: syntax-broken entry fails verification and rolls back to the previous version", { timeout: 60_000 }, async () => {
  const fx = makeFixture();
  fx.writeInstalled("1.2.3"); // the rollback target
  const installs: string[] = [];
  const fakeNpm: NpmRunner = async (args) => {
    const target = String(args[1] ?? "");
    installs.push(target);
    if (target.endsWith("@9.9.9")) fx.writeInstalled("9.9.9", { brokenEntry: true });
    if (target.endsWith("@1.2.3")) fx.writeInstalled("1.2.3");
    return { code: 0, stdout: "", stderr: "" };
  };
  setRunNpmForTest(fakeNpm);
  setRunNodeForTest(realNodeFromPath);
  try {
    const outcome = await autoInstallLatest("9.9.9", fx.root);
    assert.equal(outcome, "rolled-back");
    assert.deepEqual(installs, ["billion-context-omp@9.9.9", "billion-context-omp@1.2.3"]);
    const onDisk = JSON.parse(readFileSync(join(fx.extDir, "package.json"), "utf-8"));
    assert.equal(onDisk.version, "1.2.3", "disk is back on the healthy previous version");
  } finally {
    setRunNpmForTest(undefined);
    setRunNodeForTest(undefined);
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("autoInstallLatest: npm failure reports failed — no verify, no rollback", { timeout: 30_000 }, async () => {
  const fx = makeFixture();
  fx.writeInstalled("1.0.0");
  let nodeCalls = 0;
  setRunNpmForTest(async () => ({ code: 1, stdout: "", stderr: "npm ERR! code E404" }));
  setRunNodeForTest(async () => {
    nodeCalls += 1;
    return { code: 0, stdout: "", stderr: "" };
  });
  try {
    const outcome = await autoInstallLatest("9.9.9", fx.root);
    assert.equal(outcome, "failed");
    assert.equal(nodeCalls, 0, "a failed install is never verified");
  } finally {
    setRunNpmForTest(undefined);
    setRunNodeForTest(undefined);
    rmSync(fx.root, { recursive: true, force: true });
  }
});
