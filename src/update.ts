import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { homeDir } from "./home.js";
import { CONFIG_DIR_NAME } from "@oh-my-pi/pi-utils";
import { debug, logInfo, logWarn } from "./log.js";

declare const CURRENT_VERSION: string;

const PACKAGE_NAME = "billion-context-omp";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z-.]+)?$/;
const CHECK_INTERVAL_MS = 3 * 60 * 1000;
// Lazy on purpose: homeDir() at import time would freeze HOME before tests
// (or embedders) can redirect it; resolve the path per call instead.
const throttleFile = (): string => join(homeDir(), CONFIG_DIR_NAME, ".billion-context-omp-update-check");

// Guards against concurrent checks: the context event fires on every LLM call,
// so several can race past the throttle read before any writes the timestamp.
let updateInFlight = false;

function parseVersion(v: string): number[] {
  return v.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
}

function isNewer(latest: string, current: string): boolean {
  const l = parseVersion(latest);
  const c = parseVersion(current);
  for (let i = 0; i < 3; i++) {
    if ((l[i] ?? 0) > (c[i] ?? 0)) return true;
    if ((l[i] ?? 0) < (c[i] ?? 0)) return false;
  }
  return false;
}

async function readLastCheck(): Promise<number> {
  try {
    const data = await readFile(throttleFile(), "utf-8");
    return parseInt(data.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

async function writeLastCheck(timestamp: number): Promise<void> {
  try {
    await mkdir(dirname(throttleFile()), { recursive: true });
    await writeFile(throttleFile(), String(timestamp), "utf-8");
  } catch {
    // best-effort
  }
}

type PackageJson = {
  name?: string;
  version?: string;
  main?: string;
  dependencies?: Record<string, string>;
  exports?: Record<string, string | { import?: string }>;
  omp?: { extensions?: string[] };
};

async function readPackageJson(path: string): Promise<PackageJson | undefined> {
  try {
    const data = JSON.parse(await readFile(path, "utf-8"));
    return data && typeof data === "object" ? (data as PackageJson) : undefined;
  } catch {
    return undefined;
  }
}

export function findNpmRoot(extDir: string): string | undefined {
  let dir = dirname(extDir);
  for (;;) {
    if (dir.includes(".pnpm")) return undefined;
    if (dir.endsWith("node_modules")) return dirname(dir);
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

async function findExtensionDir(): Promise<string | undefined> {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pkg = await readPackageJson(join(dir, "package.json"));
    if (pkg?.name === PACKAGE_NAME) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// Test seams: the install path must be hermetic in tests (no real npm, no
// real network), and the smoke-import child must be replaceable. Both default
// to the real implementations; tests swap them via setRunNpmForTest /
// setRunNodeForTest and restore with undefined.
export type NpmRunner = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;
export type NodeRunner = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

const runNpmImpl: NpmRunner = (args, cwd) =>
  new Promise((resolve) => {
    execFile(
      "npm",
      args,
      { cwd, timeout: 60_000, shell: process.platform === "win32", maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) logWarn("update", { event: "install-exec-failed", error: err.message, stderr: String(stderr).slice(0, 300) });
        resolve({ code: err ? 1 : 0, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
let runNpm: NpmRunner = runNpmImpl;
export function setRunNpmForTest(impl: NpmRunner | undefined): void {
  runNpm = impl ?? runNpmImpl;
}

const runNodeImpl: NodeRunner = (args) =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      args,
      { timeout: 15_000, maxBuffer: 4 * 1024 * 1024, shell: false },
      (err, stdout, stderr) => {
        resolve({ code: err ? 1 : 0, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
let runNode: NodeRunner = runNodeImpl;
export function setRunNodeForTest(impl: NodeRunner | undefined): void {
  runNode = impl ?? runNodeImpl;
}

/** Declared loadable entries: omp manifest, exports["."], main — deduped. */
function declaredEntries(pkg: PackageJson): string[] {
  const entries = new Set<string>();
  for (const ext of pkg.omp?.extensions ?? []) {
    if (typeof ext === "string") entries.add(ext);
  }
  const dot = pkg.exports?.["."];
  if (typeof dot === "string") entries.add(dot);
  else if (dot && typeof dot.import === "string") entries.add(dot.import);
  if (typeof pkg.main === "string") entries.add(pkg.main);
  return [...entries];
}

/**
 * npm exit 0 only proves the tarball unpacked — not that the extension can
 * load. Verify: version matches, every declared entry exists, and the primary
 * entry actually imports in a real child process. A publish that ships
 * without dist (or with a syntax error) fails here instead of bricking the
 * next restart.
 */
async function verifyInstall(npmDir: string, latest: string): Promise<{ ok: boolean; reason?: string }> {
  const extDir = join(npmDir, "node_modules", PACKAGE_NAME);
  const pkg = await readPackageJson(join(extDir, "package.json"));
  if (!pkg) return { ok: false, reason: "package-json-missing" };
  if (pkg.version !== latest) return { ok: false, reason: `version-mismatch:${pkg.version ?? "none"}` };
  const entries = declaredEntries(pkg);
  if (entries.length === 0) return { ok: false, reason: "no-entry-declared" };
  for (const rel of entries) {
    try {
      await access(join(extDir, rel));
    } catch {
      return { ok: false, reason: `entry-missing:${rel}` };
    }
  }
  const smokeEntry = pkg.omp?.extensions?.[0] ?? entries[0];
  if (!smokeEntry) return { ok: false, reason: "no-entry-declared" };
  // pathToFileURL: Windows drive letters break naive file:// concatenation.
  const smoke = `const{pathToFileURL}=require("node:url");import(pathToFileURL(process.argv[1]).href).then(()=>{},(e)=>{console.error(e&&e.stack||e);process.exit(1)});`;
  const r = await runNode(["-e", smoke, join(extDir, smokeEntry)]);
  if (r.code !== 0) return { ok: false, reason: `entry-import-failed:${r.stderr.slice(0, 500)}` };
  return { ok: true };
}

const installArgs = (version: string): string[] => [
  "install",
  `${PACKAGE_NAME}@${version}`,
  // --no-save: the auto-updater must never mutate the host's package.json
  // or lockfile.
  "--no-save",
  "--silent",
  "--no-audit",
  "--no-fund",
];

export type InstallOutcome = "ok" | "failed" | "rolled-back";

/**
 * npmDirOverride exists only for tests: the test process is not installed
 * under a node_modules tree, so the real discovery walk can never reach a
 * fixture. Production callers pass nothing and discovery runs as usual.
 */
export async function autoInstallLatest(latest: string, npmDirOverride?: string): Promise<InstallOutcome> {
  // Defense against a poisoned/MITM registry: only accept a strict semver,
  // then pass args as an array to execFile (never via a shell string) so the
  // version can never be interpreted as a command even if it slipped through.
  if (!SEMVER_RE.test(latest)) {
    logWarn("update", { event: "install-abort", reason: "semver", latest });
    return "failed";
  }
  const extDir = await findExtensionDir();
  if (!extDir) {
    logWarn("update", { event: "install-abort", reason: "extdir-not-found", moduleUrl: import.meta.url });
    return "failed";
  }
  const npmDir = npmDirOverride ?? findNpmRoot(extDir);
  if (!npmDir) {
    logWarn("update", { event: "install-abort", reason: "npmroot-not-found", extDir });
    return "failed";
  }
  // Remember the pre-install version: if verification fails we reinstall it
  // instead of leaving a half-broken newer version on disk.
  const prevVersion =
    (await readPackageJson(join(npmDir, "node_modules", PACKAGE_NAME, "package.json")))?.version ?? CURRENT_VERSION;

  try {
    // Hold the event loop while npm runs: short-lived hosts (print/JSON
    // mode) exit as soon as the single turn completes, which killed the
    // fire-and-forget install mid-flight (observed live: hasUpdate=true
    // logged, then nothing — process gone). A ref'd interval defers exit
    // until the install (and verification / rollback) finishes.
    const keepAlive = setInterval(() => {}, 500);
    try {
      const res = await runNpm(installArgs(latest), npmDir);
      if (res.code !== 0) {
        logWarn("update", { event: "auto-install-failed", latest, stderr: res.stderr.slice(0, 2000) });
        return "failed";
      }
      const verify = await verifyInstall(npmDir, latest);
      if (!verify.ok) {
        // A broken publish would otherwise brick the extension on next
        // restart — and a dead extension can never auto-update itself
        // healthy again. Roll back to the previously running version.
        const rollbackTo = SEMVER_RE.test(prevVersion) ? prevVersion : CURRENT_VERSION;
        logWarn("update", { event: "auto-install-verify-failed", latest, reason: verify.reason, rollbackTo });
        const rb = await runNpm(installArgs(rollbackTo), npmDir);
        logInfo("update", { event: "rollback", from: latest, to: rollbackTo, ok: rb.code === 0 });
        return "rolled-back";
      }
      logInfo("update", { event: "auto-installed", from: prevVersion, to: latest });
      return "ok";
    } finally {
      clearInterval(keepAlive);
    }
  } catch (e) {
    logWarn("update", { event: "install-throw", error: e instanceof Error ? e.message : String(e) });
    return "failed";
  }
}

export async function checkForUpdate(
  autoUpdate: boolean,
  notify?: (msg: string) => void,
): Promise<void> {
  const envFlag = process.env.ACP_AUTO_UPDATE?.trim().toLowerCase();
  if (
    !autoUpdate ||
    envFlag === "0" ||
    envFlag === "false" ||
    envFlag === "no" ||
    envFlag === "off"
  ) {
    return;
  }
  if (updateInFlight) return;
  updateInFlight = true;
  try {
    const now = Date.now();
    const lastCheck = await readLastCheck();
    if (now - lastCheck < CHECK_INTERVAL_MS) return;

    const runtimeVersion = await getRuntimeVersion();

    const res = await fetch(REGISTRY_URL, {
      signal: AbortSignal.timeout(5000),
      headers: { Accept: "application/json" },
    });
    // Stamp the throttle only once the request has actually gone out and
    // resolved: writing it before the fetch burns the whole 3-minute window
    // on a failed attempt (issue #14 Minor3). If the fetch throws (network
    // down) no stamp is written — the next context event retries, bounded by
    // the 5s timeout above.
    await writeLastCheck(now);
    if (!res.ok) {
      logWarn("update", { event: "check-http", status: res.status });
      return;
    }
    const data = (await res.json()) as { version?: string };
    const latest = data.version;
    if (!latest) return;

    const current = runtimeVersion ?? CURRENT_VERSION;
    const hasUpdate = isNewer(latest, current);
    debug.event("update-check", {
      current,
      latest,
      hasUpdate,
    });
    logInfo("update", { event: "check", current, latest, hasUpdate });

    if (hasUpdate) {
      const outcome = await autoInstallLatest(latest);
      if (!notify) return;
      if (outcome === "ok") {
        notify(`\x1b[32m\u2714 ACP auto-updated ${current} \u2192 ${latest}. Restart omp to finish.\x1b[0m`);
      } else if (outcome === "rolled-back") {
        // No manual install hint here: the user would reinstall the very
        // broken version we just rolled back.
        notify(
          `\x1b[33m\u26a0 ${PACKAGE_NAME} ${latest} failed verification and was rolled back. Keeping ${current}. A later release will auto-update.\x1b[0m`,
        );
      } else {
        notify(`${PACKAGE_NAME} ${latest} available (you have ${current}). Run: omp install ${PACKAGE_NAME}@latest`);
      }
    }
  } catch (e) {
    logWarn("update", { event: "check-error", error: e instanceof Error ? e.message : String(e) });
  } finally {
    updateInFlight = false;
  }
}

async function getRuntimeVersion(): Promise<string | undefined> {
  const extDir = await findExtensionDir();
  if (!extDir) return undefined;
  const pkg = await readPackageJson(join(extDir, "package.json"));
  return pkg?.version;
}
