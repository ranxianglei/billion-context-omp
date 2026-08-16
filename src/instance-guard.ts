import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homeDir } from "./home.js";

/** Dual-instance guard (AGENTS.md decision #14 hazard, observed live
 *  2026-08-16): `omp install billion-context-omp` (plugin registry) and a
 *  manually-configured extension path (config.yml `extensions:`) can both
 *  load THIS package in one omp process. Two instances fight over two fold
 *  states — compressions evaporate, panels lie, logs interleave two formats.
 *
 *  Each instance stamps its load path at session_start. Finding a stamp
 *  from a DIFFERENT path freshened within the window means another instance
 *  is alive in (or just exited from) this process or a concurrent one —
 *  surface a one-shot warning instead of failing silently. */

const MARKER_FILE = ".billion-context-omp-instance.json";
const FRESH_MS = 60_000;

export interface InstanceMarker {
  path: string;
  version: string | null;
  pid: number;
  ts: number;
}

function markerPath(): string {
  return join(homeDir(), ".omp", MARKER_FILE);
}

function readMarker(): InstanceMarker | undefined {
  try {
    const raw = JSON.parse(readFileSync(markerPath(), "utf8")) as InstanceMarker;
    if (typeof raw?.path === "string" && typeof raw?.ts === "number") return raw;
  } catch {
    // absent / corrupt — treat as no marker
  }
  return undefined;
}

/** Returns the conflicting instance's marker when a dual load is detected. */
export function detectDualInstance(selfPath: string, now = Date.now()): InstanceMarker | undefined {
  const m = readMarker();
  if (!m) return undefined;
  if (m.path === selfPath) return undefined;
  if (now - m.ts > FRESH_MS) return undefined;
  return m;
}

export function stampInstance(selfPath: string, version: string | null, pid = process.pid, now = Date.now()): void {
  try {
    writeFileSync(markerPath(), JSON.stringify({ path: selfPath, version, pid, ts: now } satisfies InstanceMarker));
  } catch {
    // read-only home / sandbox — guard degrades to no-op
  }
}

/** Stamp ourselves; report a conflicting live marker if one exists. Stamp
 *  order matters: the OTHER instance's stamp may be from this same process
 *  (both loaded), so we overwrite only after reading the conflict. */
export function stampAndDetect(selfPath: string, version: string | null, now = Date.now()): InstanceMarker | undefined {
  const conflict = detectDualInstance(selfPath, now);
  stampInstance(selfPath, version, undefined, now);
  return conflict;
}
