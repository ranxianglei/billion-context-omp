#!/usr/bin/env node
/**
 * billion-context-omp
 *
 * oh-my-pi (omp) client extension for billion-context.
 *
 * `billion-context` is a Node.js proxy that sits between an AI agent and its
 * model API, rewriting Anthropic/OpenAI streams with acp-kernel compression.
 * This package wires [omp](https://github.com/can1357/oh-my-pi) — the terminal
 * coding agent — into that pipeline: it builds the base_url override that
 * routes omp's traffic through a running billion-context proxy, and
 * self-disables when it detects omp is *already* behind bili (so two layers of
 * compression never stack).
 *
 * > Skeleton package. The config-building helpers below are placeholders; wire
 * > them to omp's actual provider/base_url config shape as you build it out.
 */

/** Marker path segment bili rewrites upstream URLs under. */
export const BILI_PREFIX = '/bili/';

export interface BillionContextOmpOptions {
  /**
   * Origin of a running billion-context proxy, e.g. `http://localhost:8787`.
   */
  endpoint?: string;
}

export interface OmpProviderOverride {
  /** The provider key to override in omp's config (e.g. `openai`, `anthropic`). */
  provider: string;
  /** Original upstream base URL, e.g. `https://api.openai.com/v1`. */
  upstream: string;
}

export class BillionContextOmp {
  private readonly endpoint?: string;

  constructor(options: BillionContextOmpOptions = {}) {
    this.endpoint = options.endpoint?.replace(/\/$/, '');
  }

  /**
   * Detect whether a base_url is already pointing at a billion-context proxy.
   * Client extensions use this to self-disable and avoid double compression.
   */
  isBiliBaseUrl(baseUrl: string): boolean {
    return baseUrl.includes(BILI_PREFIX);
  }

  /**
   * Build the base_url omp should use so its traffic flows through bili.
   * Result shape: `${endpoint}/bili/${upstream}`.
   */
  buildBaseUrl(upstream: string): string {
    if (!this.endpoint) {
      throw new Error(
        'billion-context-omp: cannot build base_url — no proxy endpoint configured',
      );
    }
    if (this.isBiliBaseUrl(upstream)) return upstream; // already routed
    const clean = upstream.replace(/\/$/, '');
    return `${this.endpoint}${BILI_PREFIX}${clean}`;
  }

  /**
   * Produce the provider overrides omp should merge into its config to route
   * every listed provider through bili.
   *
   * Skeleton — returns base_url overrides only; extend with headers / auth
   * passthrough / model-list tweaks as needed.
   */
  buildConfig(providers: OmpProviderOverride[]): Record<string, { base_url: string }> {
    const out: Record<string, { base_url: string }> = {};
    for (const { provider, upstream } of providers) {
      out[provider] = { base_url: this.buildBaseUrl(upstream) };
    }
    return out;
  }

  /** Whether the client is configured against a proxy endpoint. */
  get hasEndpoint(): boolean {
    return this.endpoint !== undefined;
  }
}

export default BillionContextOmp;
