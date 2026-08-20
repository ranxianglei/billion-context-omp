import { defaultConfig, validateConfig, type Config, type Prompts } from "acp-kernel";
import { logWarn } from "./log.js";

/** Delegate sub-agent configuration. */
export interface DelegateConfig {
  /** Enable acp_delegate tools (delegate/wait/cancel) and their system-prompt
   *  section. Default: true. Set `enabled: false` to skip registering them. */
  enabled?: boolean;
  /** How delegate usage is reported back to the main session.
   *  "separate" (default) — delegate tokens tracked in a separate accumulator;
   *  main session totals stay clean, delegate usage shows as its own block in
   *  acp_status (excluded from main totals).
   *  "merged" — delegate token usage folded into the tool-result usage field,
   *  counted as part of the main session totals. */
  displayUsage?: "merged" | "separate";
}

/** Compression tuning. All fields accept a ratio (0.75) or percent string
 *  ("75%") where noted. */
export interface CompressConfig {
  maxContextLimit?: number | string;
  emergencyThresholdPercent?: number | string;
  nudgeGrowthTokens?: number;
  /** Model for /compact summaries, as "provider:modelId" (e.g.
   *  "zhipuai:glm-5.2"). Omit to use the current session model. */
  compressModel?: string;
}

/**
 * Adapter configuration. Maps onto acp-kernel's `Config` plus Pi-specific knobs
 * (live model context window, protected tools, state persistence).
 */
export interface AdapterConfig {
  /** Where the compression surgery intercepts (issue #52). "provider"
   *  leaves the agent array untouched and transforms the WIRE payload at
   *  before_provider_request — request-local, no re-entry, structurally
   *  immune to omp's feedback-view loops (the recap / subagent re-feed
   *  pathology, issues #22/#52). Unknown provider formats pass through
   *  untransformed (fail-open). "context" rewrites the context event —
   *  battle-tested legacy mode, kept for compat.
   *  When omitted, the mode is resolved per model API (issue #79):
   *  "provider" where the host actually applies the wire-payload
   *  replacement AND the wire body has a codec path — anthropic-messages,
   *  ollama-chat, and openai-completions on hosts >= 17.3.8 (upstream PR
   *  can1357/oh-my-pi#8717, issue #83); "context" everywhere else
   *  (older hosts drop the replacement; bedrock/cursor/responses/google
   *  bodies have no codec path yet). Explicit pinning in
   *  ~/.omp/acp-omp.json always wins. */
  transformMode?: "context" | "provider";
  /** When omitted, the adapter reads `ctx.model.contextWindow` live each turn.
   *  Set explicitly for tests/headless runs. */
  modelContextLimit?: number;
  protectedTools?: string[];
  preserveRecentMessages?: number;
  /** Check npm for a newer billion-context-omp on startup and auto-install it. Default: true.
   *  Disable via `autoUpdate: false` or env `ACP_AUTO_UPDATE=0` to avoid all
   *  network calls on startup. */
  autoUpdate?: boolean;
  /** Enable debug-level events in the ACP log file (default ~/.omp/acp-omp.log).
   *  Always-on events (session/turn/compress/delegate lifecycle, all errors and
   *  warnings) are written regardless; `debug` only adds verbose diagnostics.
   *  Default: false (or env ACP_DEBUG=1/true). */
  debug?: boolean;
  /** Default timeout in seconds injected into the bash tool when the model
   *  omits `timeout`. Pi has NO built-in default, so without this a command
   *  that the model forgets to time out can hang for thousands of seconds.
   *  Default: 60 (catches hangs quickly). On timeout the model is guided to
   *  re-run with a larger `timeout`. Set to 0 to disable (restore Pi's
   *  unbounded behavior). */
  toolBashDefaultTimeout?: number;
  /** Hard byte cap applied to tool result text via the `tool_result` hook.
   *  Default: 200000 (~200KB, roughly 5000 lines at ~40 bytes/line) — a
   *  generous ceiling that stops runaway output. Pi already caps bash/read/grep
   *  at 50KB/2000 lines (bash full output is saved to a temp file), so this
   *  default mainly caps tools Pi doesn't cap. Set lower (e.g. 8192) for a
   *  tighter context budget, or 0 to disable. When capped, oversized text is
   *  head-truncated with a notice telling the model how to see the full output
   *  (bash: read BashToolDetails.fullOutputPath). */
  toolOutputMaxBytes?: number;
  /** Delegate sub-agent config. Accepts a boolean shorthand (`true` →
   *  `{ enabled: true }`, `false` → `{ enabled: false }`) or a DelegateConfig
   *  object. Default: enabled. */
  delegate?: boolean | DelegateConfig;
  /** Compression tuning. */
  compress?: CompressConfig;
  /** Legacy flat alias for `delegate.displayUsage`. Kept for backward
   *  compatibility with existing acp-omp.json files. Prefer `delegate.displayUsage`. */
  displayUsage?: "merged" | "separate";
  /** Override acp-kernel's load-bearing compression prompt rules (the 4
   *  Prompts fields). Each set field replaces the kernel default verbatim.
   *  Requires acknowledgePromptsRisk: true — without it, overrides are dropped
   *  (defaults used) and a warning is logged. Set via ~/.omp/acp-omp.json. */
  prompts?: Partial<Prompts>;
  /** Must be true for `prompts` overrides to take effect. Acknowledges that
   *  replacing the kernel's tuned compression rules may reduce summary quality
   *  (lost paths/signatures/decisions → worse retrieval). */
  acknowledgePromptsRisk?: boolean;
  coreOverrides?: Partial<Config>;
}

export const DEFAULT_TOOL_BASH_TIMEOUT = 60;
export const DEFAULT_TOOL_OUTPUT_MAX_BYTES = 200_000;

/** Resolve delegate config from the adapter, handling the boolean shorthand
 *  and the legacy flat `displayUsage` alias.
 *
 *  Forward-compatible: not yet wired (AGENTS.md §7 — delegates deferred).
 *  Retained so future wiring can consume it without re-deriving the logic. */
export function resolveDelegate(adapter: AdapterConfig): { enabled: boolean; displayUsage: "merged" | "separate" } {
  const d = adapter.delegate;
  if (typeof d === "object" && d !== null) {
    return {
      enabled: d.enabled !== false,
      displayUsage: d.displayUsage ?? adapter.displayUsage ?? "separate",
    };
  }
  return {
    enabled: d !== false,
    displayUsage: adapter.displayUsage ?? "separate",
  };
}

export function resolveConfig(adapter: AdapterConfig, liveContextLimit: number): Config {
  const envLimit = process.env.ACP_MODEL_CONTEXT_LIMIT;
  const envLimitNum = envLimit ? Number(envLimit) : NaN;
  const FALLBACK_LIMIT = 150_000;
  const limit =
    !Number.isNaN(envLimitNum) && envLimitNum > 0
      ? envLimitNum
      : adapter.modelContextLimit && adapter.modelContextLimit > 0
        ? adapter.modelContextLimit
        : liveContextLimit > 0
          ? liveContextLimit
          : FALLBACK_LIMIT;
  const config = defaultConfig(limit, {
    protectedTools: adapter.protectedTools ?? [],
    preserveRecentMessages: adapter.preserveRecentMessages ?? 5,
    ...adapter.coreOverrides,
  });
  const c = adapter.compress;
  if (c?.maxContextLimit !== undefined) config.nudge.maxContextLimitPct = parsePercent(c.maxContextLimit);
  if (c?.emergencyThresholdPercent !== undefined) {
    const pct = parsePercent(c.emergencyThresholdPercent);
    if (pct <= 0) {
      // A zero threshold fires the emergency nudge AND the full truncate on
      // EVERY turn (kernel truncate: tokenCount >= 0 always) — and
      // parsePercent maps unparseable values to 0, so "abc" would silently
      // do the same. Ignore the override instead of zeroing both thresholds
      // (review M3, issue #92).
      logWarn("config", { event: "emergency-threshold-ignored", value: String(c.emergencyThresholdPercent), reason: "zero threshold would truncate every turn" });
    } else {
      config.nudge.emergencyThresholdPct = pct;
      config.truncate.threshold = pct;
    }
  }
  if (c?.nudgeGrowthTokens !== undefined) {
    config.nudge.growthFloor = c.nudgeGrowthTokens;
    config.nudge.growthCap = c.nudgeGrowthTokens;
  }
  const warnings = validateConfig(config);
  if (warnings.length > 0) logWarn("config", { warnings: warnings.join("; ") });
  return config;
}

export function parsePercent(v: number | string): number {
  const raw = typeof v === "number" ? v : v.trim().endsWith("%") ? Number(v.trim().slice(0, -1)) : Number(v);
  if (!Number.isFinite(raw)) return 0;
  // A bare value above 1 cannot be a ratio (these thresholds cap at 100%) —
  // read it as percent ("75" ≡ "75%"). The old clamp silently turned it
  // into 1, so a user writing maxContextLimit: 75 got forced nudges only at
  // a full context with no warning.
  const n = raw > 1 ? raw / 100 : raw;
  if (n > 1 || n < 0) {
    logWarn("config", { event: "percent-clamped", value: String(v), clamped: Math.min(1, Math.max(0, n)) });
  }
  return Math.min(1, Math.max(0, n));
}
