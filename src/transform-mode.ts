import type { AdapterConfig } from "./config.js";
import { VERSION } from "@oh-my-pi/pi-utils";

// Model APIs where the omp host's provider layer applies the
// before_provider_request (onPayload) replacement AND serves a `messages`-array
// wire body the wire transform recognizes.
const PROVIDER_VIABLE_APIS = new Set(["anthropic-messages", "ollama-chat"]);

// openai-completions honors the onPayload replacement only from host 17.3.8
// (upstream PR can1357/oh-my-pi#8717, shipped in pi-ai 17.3.8; issue #83). On
// older hosts it drops the replacement fire-and-forget — provider mode would
// deliver nothing to the model (issue #79) — so the unset default stays
// "context" there. amazon-bedrock / cursor honor the replacement from 17.3.8
// too, but their wire bodies (Converse untyped content blocks / gRPC
// AgentRunRequest) have no codec path in the wire transform yet, so they stay
// on the context default as well.
const OPENAI_COMPLETIONS_VIABLE_FROM: readonly [number, number, number] = [17, 3, 8];

export function hostVersionAtLeast(
  min: readonly [number, number, number],
  version: string = VERSION,
): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  if (!m) return false;
  const v: [number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return v[0] > min[0] || (v[0] === min[0] && (v[1] > min[1] || (v[1] === min[1] && v[2] >= min[2])));
}

// Effective transform mode. An explicit `transformMode` always wins (the user
// may run a patched host that honors payload replacement on more APIs); the
// unset default resolves per-API so the injections are actually delivered.
export function resolveTransformMode(
  adapter: Pick<AdapterConfig, "transformMode">,
  model: { api?: string } | undefined,
  hostVersion: string = VERSION,
): "context" | "provider" {
  if (adapter.transformMode) return adapter.transformMode;
  const api = model?.api;
  if (api == null) return "context";
  if (PROVIDER_VIABLE_APIS.has(api)) return "provider";
  if (api === "openai-completions" && hostVersionAtLeast(OPENAI_COMPLETIONS_VIABLE_FROM, hostVersion)) return "provider";
  return "context";
}

export interface ProviderDeliveryWarning {
  key: string;
  reason: string;
  message: string;
}

/** An explicit transformMode "provider" is an escape hatch for patched hosts
 *  — but on stock hosts some APIs silently deliver NOTHING: before 17.3.8 the
 *  host drops the before_provider_request replacement on openai-completions /
 *  bedrock / cursor (upstream can1357/oh-my-pi#8717, issue #83), and bedrock /
 *  cursor bodies still have no codec path even on newer hosts. The unset
 *  default already avoids all of this; only an explicit override can land
 *  here, so surface why instead of failing silently (ework issue #3). */
export function providerDeliveryWarning(
  adapter: Pick<AdapterConfig, "transformMode">,
  model: { api?: string } | undefined,
  hostVersion: string = VERSION,
): ProviderDeliveryWarning | undefined {
  if (adapter.transformMode !== "provider") return undefined;
  const api = model?.api;
  const dropWarning = (target: string): ProviderDeliveryWarning => ({
    key: `drop:${target}`,
    reason: `host < 17.3.8 drops the before_provider_request replacement on ${target} (fixed upstream pi-ai 17.3.8, can1357/oh-my-pi#8717)`,
    message: `⚠ billion-context-omp: transformMode "provider" is set, but this host (pi-ai < 17.3.8) discards the rewritten payload on ${target} — compression is NOT applied. Upgrade the host (omp update) or remove the transformMode override.`,
  });
  if (api === "openai-completions" && !hostVersionAtLeast(OPENAI_COMPLETIONS_VIABLE_FROM, hostVersion)) {
    return dropWarning(api);
  }
  if (api === "amazon-bedrock" || api === "cursor") {
    if (!hostVersionAtLeast(OPENAI_COMPLETIONS_VIABLE_FROM, hostVersion)) return dropWarning(api);
    return {
      key: `nocodec:${api}`,
      reason: `${api} honors the replacement from 17.3.8 but its wire body has no codec path yet (issue #83)`,
      message: `⚠ billion-context-omp: transformMode "provider" is set, but the ${api} wire body has no codec path yet (#83) — compression is NOT applied. Remove the transformMode override to use context mode.`,
    };
  }
  return undefined;
}
