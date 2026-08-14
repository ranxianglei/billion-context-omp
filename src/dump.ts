import { mkdirSync, writeFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { homeDir } from "./home.js";
import { CONFIG_DIR_NAME } from "@oh-my-pi/pi-utils";
import { debug } from "./log.js";

const counters: Record<string, number> = {};

export function dumpDir(): string {
  return path.join(homeDir(), CONFIG_DIR_NAME, "acp-omp-dumps");
}

export interface DumpMeta {
  sid: string;
  injected: boolean;
  emergency: boolean;
}

/** Dump the full AgentMessage[] sent to the LLM for each context event.
 *  Only fires when debug mode is on (ACP_DEBUG=1 or debug:true in config).
 *  Files are sequential JSON in ~/.omp/acp-omp-dumps/: 0000.json, 0001.json, ...
 *  Diff two dumps to verify prefix stability or inspect nudge injection. */
export function dumpContextMessages(messages: unknown[], meta: DumpMeta): string | null {
  if (!debug.enabled) return null;
  try {
    const dir = dumpDir();
    mkdirSync(dir, { recursive: true });

    if (!(dir in counters)) {
      try {
        const existing = readdirSync(dir).filter((f) => /^\d{4}\.json$/.test(f));
        const max = existing.reduce((mx, f) => {
          const n = parseInt(f, 10);
          return Number.isNaN(n) ? mx : Math.max(mx, n);
        }, -1);
        counters[dir] = max + 1;
      } catch {
        counters[dir] = 0;
      }
    }
    const seq = counters[dir]!;
    counters[dir] = seq + 1;

    const name = `${String(seq).padStart(4, "0")}.json`;
    const fullPath = path.join(dir, name);
    writeFileSync(
      fullPath,
      JSON.stringify({
        ts: new Date().toISOString(),
        ...meta,
        outMsgs: messages.length,
        messages,
      }),
    );
    debug.event("context-out-dump", { path: fullPath, msgs: messages.length });
    return fullPath;
  } catch (e) {
    debug.event("context-out-dump-error", { error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}
