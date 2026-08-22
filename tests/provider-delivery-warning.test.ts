import { describe, expect, test } from "bun:test";
import { createAcpExtension } from "../src/index.js";
import { providerDeliveryWarning } from "../src/transform-mode.js";

type Notify = (message: string, level?: "info" | "warning" | "error") => void;

function makeCtx(model: { api?: string; contextWindow?: number } = { api: "anthropic-messages", contextWindow: 200_000 }) {
  const notifications: Array<{ message: string; level?: "info" | "warning" | "error" }> = [];
  const notify: Notify = (message, level) => { notifications.push({ message, level }); };
  const ctx = {
    session: { id: "s1" },
    sessionManager: { getSessionId: () => "s1" },
    model,
    hasUI: true,
    ui: { notify },
    getContextUsage: () => ({ contextWindow: model.contextWindow ?? 0 }),
  } as unknown as import("@oh-my-pi/pi-coding-agent").ExtensionContext;
  return { ctx, notifications };
}

describe("providerDeliveryWarning (pure)", () => {
  test("viable APIs: no warning", () => {
    for (const api of ["anthropic-messages", "ollama-chat", "openai-responses", "openai-completions"]) {
      expect(providerDeliveryWarning({ api })).toBeUndefined();
    }
  });

  test("bedrock / cursor: host drops the replacement (nodelivery)", () => {
    for (const api of ["amazon-bedrock", "cursor"]) {
      const w = providerDeliveryWarning({ api });
      expect(w?.key).toBe(`nodelivery:${api}`);
      expect(w?.message).toContain("NOT applied");
    }
  });

  test("google / devin / unknown: no codec path (nocodec)", () => {
    for (const api of ["google", "devin", "mystery-api"]) {
      const w = providerDeliveryWarning({ api });
      expect(w?.key).toBe(`nocodec:${api}`);
      expect(w?.message).toContain("no kernel codec path");
    }
  });

  test("no api: no-api warning", () => {
    const w = providerDeliveryWarning({});
    expect(w?.key).toBe("no-api");
  });
});

describe("delivery warnings (context observer)", () => {
  test("bedrock: one warning at context", async () => {
    const { ctx, notifications } = makeCtx({ api: "amazon-bedrock" });
    const ext = createAcpExtension({ autoUpdate: false });
    const factory = ext as unknown as (api: unknown, ctx: unknown) => void;
    const handlers = new Map<string, unknown>();
    const api = { on: (name: string, fn: unknown) => { handlers.set(name, fn); }, registerTool: () => {}, registerCommand: () => {}, config: { load: () => ({}) } };
    factory(api, ctx);
    const stream = [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }];
    await (handlers.get("context") as (e: unknown, c: unknown) => Promise<unknown>)({ type: "context", messages: stream }, ctx);
    const atCtx = notifications.filter((n) => n.message.includes("billion-context-omp"));
    expect(atCtx.length).toBe(1);
    expect(atCtx[0]!.message).toContain("NOT applied");
  });

  test("google: one warning at context (nocodec)", async () => {
    const { ctx, notifications } = makeCtx({ api: "google" });
    const ext = createAcpExtension({ autoUpdate: false });
    const factory = ext as unknown as (api: unknown, ctx: unknown) => void;
    const handlers = new Map<string, unknown>();
    const api = { on: (name: string, fn: unknown) => { handlers.set(name, fn); }, registerTool: () => {}, registerCommand: () => {}, config: { load: () => ({}) } };
    factory(api, ctx);
    const stream = [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }];
    await (handlers.get("context") as (e: unknown, c: unknown) => Promise<unknown>)({ type: "context", messages: stream }, ctx);
    const atCtx = notifications.filter((n) => n.message.includes("billion-context-omp"));
    expect(atCtx.length).toBe(1);
    expect(atCtx[0]!.message).toContain("no kernel codec path");
  });

  test("viable API: no delivery warning", async () => {
    const { ctx, notifications } = makeCtx({ api: "anthropic-messages" });
    const ext = createAcpExtension({ autoUpdate: false });
    const factory = ext as unknown as (api: unknown, ctx: unknown) => void;
    const handlers = new Map<string, unknown>();
    const api = { on: (name: string, fn: unknown) => { handlers.set(name, fn); }, registerTool: () => {}, registerCommand: () => {}, config: { load: () => ({}) } };
    factory(api, ctx);
    const stream = [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }];
    await (handlers.get("context") as (e: unknown, c: unknown) => Promise<unknown>)({ type: "context", messages: stream }, ctx);
    const atCtx = notifications.filter((n) => n.message.includes("billion-context-omp"));
    expect(atCtx.length).toBe(0);
  });
});

