import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const FOOTER_STATUS_KEY = "billion-context-omp";

/** Mirrors pi's footer.js formatTokens: lowercase k/M, thresholds <1000/<10000/<1e6/<1e7. */
export function formatCompactTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

// Footer sub-agent usage tracking is a no-op in the omp build: omp (oh-my-pi)
// provides its own multi-agent orchestration and tracks delegate usage itself,
// so this adapter does not maintain a separate usage accumulator. The hooks
// remain as no-ops so call sites that reference them still compile.

export function initFooterStatus(_ctx: ExtensionContext): void {
  // no-op
}

export function updateFooterStatus(): void {
  // no-op
}

export function disposeFooterStatus(): void {
  // no-op
}
