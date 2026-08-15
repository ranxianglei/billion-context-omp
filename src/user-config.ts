import { promises as fs } from "node:fs";
import * as path from "node:path";
import { homeDir } from "./home.js";
import { CONFIG_DIR_NAME } from "@oh-my-pi/pi-utils";
import type { Prompts } from "acp-kernel";
import type { AdapterConfig, CompressConfig, DelegateConfig } from "./config.js";
import { debug, logWarn } from "./log.js";

/** User-facing config keys (subset of AdapterConfig). Loaded from
 *  ~/.<CONFIG_DIR_NAME>/acp-omp.json (global) and <cwd>/.<CONFIG_DIR_NAME>/acp-omp.json
 *  (project-local overrides project-global). Project wins over global. */
export interface UserAcpConfig {
  debug?: boolean;
  autoUpdate?: boolean;
  modelContextLimit?: number;
  toolBashDefaultTimeout?: number;
  toolOutputMaxBytes?: number;
  delegate?: boolean | DelegateConfig;
  compress?: CompressConfig;
  displayUsage?: "merged" | "separate";
  prompts?: Partial<Prompts>;
  /** Acknowledge the risks of user-supplied compression prompts (system-prompt
   *  injection surface). Only honored from the GLOBAL config — a project-local
   *  acp-omp.json under agent control cannot pre-acknowledge its own risk gate. */
  acknowledgePromptsRisk?: boolean;
  /** Model for /compact summaries, as "provider:modelId" (e.g.
   *  "zhipuai:glm-5.2"). Shortcut for compress.compressModel — normalized
   *  into the nested path at load time. */
  compressModel?: string;
}

/** Read global + project acp-omp.json, project overrides global. Returns {} on any
 *  error (missing file, bad JSON) — never throws.
 *
 *  `prompts` / `acknowledgePromptsRisk` are accepted from the GLOBAL config
 *  only (issue #32): a repo under agent control can ship a project-local
 *  .omp/acp-omp.json, and letting it inject arbitrary system-prompt text
 *  every turn is a prompt-injection surface. Project-local files may tune
 *  everything else (thresholds, models, timeouts) but not the prompts. */
export async function loadUserConfig(cwd: string): Promise<UserAcpConfig> {
  const home = homeDir();
  const merged: UserAcpConfig = {};
  for (const base of [join(home, CONFIG_DIR_NAME), join(cwd, CONFIG_DIR_NAME)]) {
    const file = join(base, "acp-omp.json");
    const allowPrompts = base.startsWith(home);
    try {
      const raw = await fs.readFile(file, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        Object.assign(merged, pickKnown(parsed, allowPrompts));
        debug.event("config-loaded", { file });
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        logWarn("config", { event: "load-failed", file, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  return merged;
}

function join(... parts: string[]): string {
  return path.join(...parts);
}

const KNOWN = new Set([
  "debug", "autoUpdate", "modelContextLimit",
  "toolBashDefaultTimeout", "toolOutputMaxBytes",
  "delegate", "compress", "compressModel", "displayUsage",
  "prompts", "acknowledgePromptsRisk",
]);

function pickKnown(parsed: Record<string, unknown>, allowPrompts: boolean): UserAcpConfig {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (KNOWN.has(k)) (out as Record<string, unknown>)[k] = v;
  }
  if (!allowPrompts) {
    delete out.prompts;
    delete out.acknowledgePromptsRisk;
  }
  return out as UserAcpConfig;
}

/** Merge user config onto an adapter config: user config wins for the keys it
 *  sets. Used at session_start to apply runtime-discovered config. */
export function applyUserConfig(adapter: AdapterConfig, user: UserAcpConfig): AdapterConfig {
  const { compressModel, ...rest } = user;
  const merged: AdapterConfig = {
    ...adapter,
    ...rest,
    coreOverrides: adapter.coreOverrides,
    protectedTools: adapter.protectedTools,
    preserveRecentMessages: adapter.preserveRecentMessages,
  };
  if (compressModel && !merged.compress?.compressModel) {
    merged.compress = { ...merged.compress, compressModel };
  }
  return merged;
}
