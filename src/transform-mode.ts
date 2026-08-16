import type { AdapterConfig } from "./config.js";

// Model APIs where the omp host's provider layer applies the
// before_provider_request (onPayload) replacement AND serves a `messages`-array
// wire body the wire transform recognizes. Every other API either drops the
// replacement fire-and-forget (openai-completions, amazon-bedrock, cursor) or
// uses a body format detectWireFormat cannot parse (openai-responses `input`,
// google `contents`) — the model never sees the injections, issue #79.
const PROVIDER_VIABLE_APIS = new Set(["anthropic-messages", "ollama-chat"]);

// Effective transform mode. An explicit `transformMode` always wins (the user
// may run a patched host that honors payload replacement on more APIs); the
// unset default resolves per-API so the injections are actually delivered.
export function resolveTransformMode(
  adapter: Pick<AdapterConfig, "transformMode">,
  model: { api?: string } | undefined,
): "context" | "provider" {
  if (adapter.transformMode) return adapter.transformMode;
  return model?.api != null && PROVIDER_VIABLE_APIS.has(model.api) ? "provider" : "context";
}
