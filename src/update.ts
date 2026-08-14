import { readFile, writeFile, mkdir } from "node:fs/promises";
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
const THROTTLE_FILE = join(homeDir(), CONFIG_DIR_NAME, "agent", ".billion-context-omp-update-check");

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
    const data = await readFile(THROTTLE_FILE, "utf-8");
    return parseInt(data.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

async function writeLastCheck(timestamp: number): Promise<void> {
  try {
    await mkdir(dirname(THROTTLE_FILE), { recursive: true });
    await writeFile(THROTTLE_FILE, String(timestamp), "utf-8");
  } catch {
    // best-effort
  }
}

type PackageJson = {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
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

async function autoInstallLatest(latest: string): Promise<boolean> {
  // Defense against a poisoned/MITM registry: only accept a strict semver,
  // then pass args as an array to execFile (never via a shell string) so the
  // version can never be interpreted as a command even if it slipped through.
  if (!SEMVER_RE.test(latest)) {
    logWarn("update", { event: "install-abort", reason: "semver", latest });
    return false;
  }
  const extDir = await findExtensionDir();
  if (!extDir) {
    logWarn("update", { event: "install-abort", reason: "extdir-not-found", moduleUrl: import.meta.url });
    return false;
  }
  const npmDir = findNpmRoot(extDir);
  if (!npmDir) {
    logWarn("update", { event: "install-abort", reason: "npmroot-not-found", extDir });
    return false;
  }

  try {
    // Hold the event loop while npm runs: short-lived hosts (print/JSON
    // mode) exit as soon as the single turn completes, which killed the
    // fire-and-forget install mid-flight (observed live: hasUpdate=true
    // logged, then nothing — process gone). A ref'd interval defers exit
    // until the install finishes.
    const keepAlive = setInterval(() => {}, 500);
    try {
      const code = await new Promise<number>((resolve) => {
        execFile(
          "npm",
          ["install", `${PACKAGE_NAME}@${latest}`, "--silent", "--no-audit", "--no-fund"],
          { cwd: npmDir, timeout: 60_000, shell: process.platform === "win32" },
          (err, _stdout, stderr) => {
            if (err) logWarn("update", { event: "install-exec-failed", error: err.message, stderr: String(stderr).slice(0, 300) });
            resolve(err ? 1 : 0);
          },
        );
      });
      return code === 0;
    } finally {
      clearInterval(keepAlive);
    }
  } catch (e) {
    logWarn("update", { event: "install-throw", error: e instanceof Error ? e.message : String(e) });
    return false;
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

    await writeLastCheck(now);

    const runtimeVersion = await getRuntimeVersion();

    const res = await fetch(REGISTRY_URL, {
      signal: AbortSignal.timeout(5000),
      headers: { Accept: "application/json" },
    });
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
      const installed = await autoInstallLatest(latest);
      if (installed && notify) {
        notify(
          `\x1b[32m\u2714 ACP auto-updated ${current} \u2192 ${latest}. Restart omp to finish.\x1b[0m`,
        );
        logInfo("update", { event: "auto-installed", from: current, to: latest });
      } else if (!installed && notify) {
        notify(
          `${PACKAGE_NAME} ${latest} available (you have ${current}). Run: omp install ${PACKAGE_NAME}@latest`,
        );
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
