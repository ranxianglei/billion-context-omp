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
