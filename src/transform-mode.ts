import { VERSION } from "@oh-my-pi/pi-utils";

// omp requires a host that applies the before_provider_request (onPayload)
// replacement on the provider-viable APIs. That landed in pi-ai 17.3.8
// (upstream PR can1357/oh-my-pi#8717, issue #83). Older hosts drop the
// replacement fire-and-forget, so provider mode would deliver NOTHING to the
// model (issue #79). We therefore declare 17.3.8 the minimum supported host
// and warn at load time on older ones.
export const MIN_HOST_VERSION: readonly [number, number, number] = [17, 3, 8];

export function hostVersionAtLeast(
  min: readonly [number, number, number],
  version: string = VERSION,
): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  if (!m) return false;
  const v: [number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return v[0] > min[0] || (v[0] === min[0] && (v[1] > min[1] || (v[1] === min[1] && v[2] >= min[2])));
}

/** True when the running host meets the minimum version omp requires. */
export function hostMeetsMinimum(version: string = VERSION): boolean {
  return hostVersionAtLeast(MIN_HOST_VERSION, version);
}

// Model APIs whose wire body the kernel codec can parse AND rebuild
// (wire-fold.ts). These are the only APIs where provider-mode compression is
// actually delivered. Everything else (amazon-bedrock, cursor, google, devin,
// unknown) has no codec path yet — the payload passes through untransformed
// (fail-open) and a delivery warning is surfaced (issue #83; kernel codecs
// tracked upstream).
const CODEC_VIABLE_APIS = new Set(["anthropic-messages", "ollama-chat", "openai-responses", "openai-completions"]);

export interface ProviderDeliveryWarning {
  key: string;
  reason: string;
  message: string;
}

/** Compression is delivered only where the kernel has a codec for the wire
 *  body. On stock hosts the other APIs (bedrock / cursor / google / devin /
 *  unknown) have no codec path yet — the payload passes through untransformed
 *  and compression is silently a no-op. Surface why instead of failing
 *  silently (issue #83; kernel codecs tracked upstream). */
export function providerDeliveryWarning(
  model: { api?: string } | undefined,
): ProviderDeliveryWarning | undefined {
  const api = model?.api;
  if (api == null) {
    return {
      key: "no-api",
      reason: "model has no api field — cannot determine wire format",
      message: "⚠ billion-context-omp: the model exposes no `api` — the wire format is unknown and compression is NOT applied. This is a host/model gap, not a config error.",
    };
  }
  if (CODEC_VIABLE_APIS.has(api)) return undefined;
  // bedrock / cursor: the host drops the onPayload replacement even on
  // 17.3.8+ (fire-and-forget), so even a codec would not be delivered.
  if (api === "amazon-bedrock" || api === "cursor") {
    return {
      key: `nodelivery:${api}`,
      reason: `${api} host drops the before_provider_request replacement (fire-and-forget) — no codec path and no delivery`,
      message: `⚠ billion-context-omp: the ${api} wire body has no codec path and the host discards payload rewrites — compression is NOT applied. Kernel codec + host delivery tracked upstream (issue #83).`,
    };
  }
  // google / devin / unknown: the host honors the replacement but the kernel
  // has no codec for the wire body yet.
  return {
    key: `nocodec:${api}`,
    reason: `${api} wire body has no kernel codec path yet (issue #83)`,
    message: `⚠ billion-context-omp: the ${api} wire body has no kernel codec path yet (#83) — compression is NOT applied. Kernel codec tracked upstream.`,
  };
}
