import { type } from "@oh-my-pi/omptype";
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { searchBlocks, type SearchResult } from "acp-kernel";
import type { AcpRuntime } from "./runtime.js";
import { buildSearchDocs } from "./search-index.js";
import { formatTokens } from "./tokens.js";
import { logThrow } from "./log.js";

const SearchParams = type({
    query: type("string").describe("Keywords to locate detail folded into compressed summaries or historical messages."),
    "limit?": type("number").describe("Max results (default 10)."),
});

type SearchArgs = typeof SearchParams.infer;

export function makeSearchTool(runtime: AcpRuntime): ToolDefinition<typeof SearchParams> {
    return {
        name: "search_context",
        label: "Search Context",
        description:
            "Search compressed blocks AND historical messages by keyword. Use to cheaply locate detail before decompressing. Returns ranked results with ref, size, preview, and the decompress command to retrieve full content.",
        parameters: SearchParams,
        async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
            let result: string;
            try {
                result = await handleSearch(params as SearchArgs, runtime, ctx);
            } catch (e) {
                logThrow("search", e, { sid: ctx.sessionManager.getSessionId(), query: (params as SearchArgs).query });
                throw e;
            }
            return { details: undefined, content: [{ type: "text", text: result }] };
        },
    };
}

export async function handleSearch(args: SearchArgs, runtime: AcpRuntime, ctx: ExtensionContext): Promise<string> {
    const { state, coreMessages, archive } = await runtime.stateFor(ctx);
    // Archived messages fold under a-ids after a native compaction (#19);
    // including them keeps their text searchable via block ownership.
    const docs = buildSearchDocs([...archive, ...coreMessages], state);
    const msgCount = docs.filter((d) => d.kind === "message").length;
    const blockCount = docs.filter((d) => d.kind === "block").length;
    const results = searchBlocks(docs, args.query, { limit: args.limit });

    if (results.length === 0) {
        const blocks = state.blocks.length;
        return `No matches for "${args.query}" across ${blocks} block(s) and ${msgCount} historical message(s).`;
    }

    const lines = [`Found ${results.length} match(es) for "${args.query}" (searched ${blockCount} blocks + ${msgCount} messages):`];
    for (const r of results) lines.push("", formatResult(r));
    return lines.join("\n");
}

function formatResult(r: SearchResult): string {
    const sizeStr = r.tokens != null ? formatTokens(r.tokens) : "";
    const meta = [
        r.kind === "message" ? `message ${r.ref}` : `block ${r.ref}`,
        r.role ? `(${r.role})` : "",
        `T${r.tier}`,
        `score:${r.score.toFixed(2)}`,
        sizeStr,
    ].filter(Boolean).join(" ");

    const header = `${meta}  "${truncate(r.title, 50)}"`;

    const decompressHint = r.kind === "block"
        ? `→ decompress({ blockId: "${r.ref}" })`
        : r.blockId
          ? `→ decompress({ blockId: "${r.blockId}" })  (block containing message ${r.ref})`
          : `(message ${r.ref} is still visible in context)`;

    return `${header}\n  ${r.preview}\n  ${decompressHint}`;
}

function truncate(s: string, n: number): string {
    if (s.length <= n) return s;
    return s.slice(0, n - 1) + "…";
}
