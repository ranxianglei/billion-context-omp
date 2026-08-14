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

function quickHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

/** Extract a compact summary of the provider request payload for log lines.
 *  Captures the prefix signature (system prompt + first N messages) so cache
 *  instability is visible as a changing hash between consecutive turns. */
export function summarizeProviderPayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object") return { error: "non-object-payload" };
  const p = payload as Record<string, unknown>;
  const rawMsgs = Array.isArray(p.messages) ? (p.messages as Record<string, unknown>[]) : [];
  const model = typeof p.model === "string" ? p.model : "?";

  let systemLen = 0;
  let systemHash = "";
  const systemStr = typeof p.system === "string"
    ? p.system
    : (() => {
        const sysMsg = rawMsgs.find((m) => m?.role === "system");
        if (!sysMsg) return "";
        const c = sysMsg.content;
        return typeof c === "string" ? c : JSON.stringify(c ?? "");
      })();
  systemLen = systemStr.length;
  systemHash = quickHash(systemStr.slice(0, 2000));

  const prefixMsgs = rawMsgs.slice(0, 5).map((m) => ({
    role: String(m?.role ?? "?"),
    len: typeof m?.content === "string"
      ? m.content.length
      : JSON.stringify(m?.content ?? "").length,
  }));

  const prefixStr = JSON.stringify({
    s: systemStr.slice(0, 500),
    m: rawMsgs.slice(0, 5).map((m) => ({
      r: m?.role,
      c: typeof m?.content === "string" ? m.content.slice(0, 200) : null,
    })),
  });
  const prefixHash = quickHash(prefixStr);

  return {
    model,
    totalMsgs: rawMsgs.length,
    systemLen,
    systemHash,
    prefixHash,
    prefixMsgs,
    toolCount: Array.isArray(p.tools) ? p.tools.length : 0,
    stream: p.stream === true,
  };
}

/** Dump the raw provider request payload — the actual bytes sent to the LLM
 *  after ALL processing (ACP tags, omp system-reminders, message reordering).
 *  This is the true LLM exit point via the `before_provider_request` hook.
 *  Files: ~/.omp/acp-omp-dumps/req_NNNN.json */
export function dumpProviderRequest(payload: unknown, meta: { sid: string }): string | null {
  if (!debug.enabled) return null;
  try {
    const dir = dumpDir();
    mkdirSync(dir, { recursive: true });

    if (!("req" in counters)) {
      try {
        const existing = readdirSync(dir).filter((f) => /^req_\d+\.json$/.test(f));
        const max = existing.reduce((mx, f) => {
          const n = parseInt(f.slice(4, -5), 10);
          return Number.isNaN(n) ? mx : Math.max(mx, n);
        }, -1);
        counters["req"] = max + 1;
      } catch {
        counters["req"] = 0;
      }
    }
    const seq = counters["req"]!;
    counters["req"] = seq + 1;

    const name = `req_${String(seq).padStart(4, "0")}.json`;
    const fullPath = path.join(dir, name);
    const summary = summarizeProviderPayload(payload);
    writeFileSync(
      fullPath,
      JSON.stringify({
        ts: new Date().toISOString(),
        ...meta,
        ...summary,
        payload,
      }),
    );
    debug.event("provider-request-dump", { path: fullPath, ...summary });
    return fullPath;
  } catch (e) {
    debug.event("provider-request-dump-error", { error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}
