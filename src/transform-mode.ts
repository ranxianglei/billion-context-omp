import type { AdapterConfig } from "./config.js";

// Model APIs whose WIRE BODY the provider transform can parse and rebuild —
// `messages`-array formats (anthropic messages, openai chat completions,
// ollama chat). Delivery no longer depends on the host applying the
// before_provider_request replacement: applyMessagesInPlace (issue #79)
// mirrors the rebuilt messages onto the ORIGINAL payload object — the exact
// reference the host serializes to fetch — so the surgery lands whether the
// host honors the returned replacement (anthropic-messages, ollama-chat) or
// drops it fire-and-forget (openai-completions: GLM / DeepSeek / vLLM).
// Every other API serves a body detectWireFormat cannot parse
// (openai-responses `input`, google `contents`, bedrock Converse, cursor
// runRequests): provider mode can only pass those through untouched, so they
// default to context — the one channel every host guarantees to deliver.
const PROVIDER_FORMAT_APIS = new Set(["anthropic-messages", "ollama-chat", "openai-completions"]);

// Effective transform mode. An explicit `transformMode` always wins; the
// unset default resolves per model API by FORMAT SUPPORT (not host trust):
// provider wherever the wire body is parseable, context everywhere else.
export function resolveTransformMode(
  adapter: Pick<AdapterConfig, "transformMode">,
  model: { api?: string } | undefined,
): "context" | "provider" {
  if (adapter.transformMode) return adapter.transformMode;
  return model?.api != null && PROVIDER_FORMAT_APIS.has(model.api) ? "provider" : "context";
}
