import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

/**
 * Host compatibility layer for pi vs omp (oh-my-pi) API differences.
 *
 * pi: systemPrompt is string, getSystemPrompt() returns string
 * omp: systemPrompt is string[], getSystemPrompt() returns string[]
 *
 * These helpers normalize the differences so the rest of the codebase
 * can work with a consistent string interface.
 */

/** Normalize systemPrompt to a single string (join with newlines if array). */
export function normalizeSystemPrompt(input: string | string[] | undefined): string {
  if (input === undefined) return "";
  if (Array.isArray(input)) return input.join("\n");
  return input;
}

/**
 * Format systemPrompt for the before_agent_start event handler.
 * omp's BeforeAgentStartEventResult.systemPrompt is string[]: each entry is a
 * prompt segment. We normalize the incoming base (string | string[]) to one
 * string, append the ACP block, and return it as a single-element array.
 */
export function formatSystemPromptForEvent(
  base: string | string[],
  append: string
): string[] {
  const normalized = normalizeSystemPrompt(base);
  return [`${normalized}\n\n${append}`];
}

/**
 * Get the system prompt as a single string, regardless of host type.
 * Handles both pi (string) and omp (string[]) return types.
 */
export function getSystemPromptText(ctx: ExtensionContext): string {
  const result = ctx.getSystemPrompt?.();
  return normalizeSystemPrompt(result);
}
