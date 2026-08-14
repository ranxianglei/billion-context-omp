import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createInitialState, type CompressionState } from "acp-kernel";
import { logError, logInfo, logWarn } from "./log.js";

const STATE_SUFFIX = ".acp-omp.json";

interface StateCacheSlot {
  state: CompressionState;
}

function stateFileFor(sessionFile: string | undefined): string | null {
  if (sessionFile) return sessionFile + STATE_SUFFIX;
  return null;
}

export async function readParentSessionPath(sessionFile: string): Promise<string | undefined> {
  try {
    const handle = await fs.open(sessionFile, "r");
    try {
      const buf = Buffer.alloc(65536);
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      if (bytesRead === 0) return undefined;
      const firstLine = buf.subarray(0, bytesRead).toString("utf8").split("\n")[0] ?? "";
      if (!firstLine.startsWith("{")) return undefined;
      const header = JSON.parse(firstLine);
      return typeof header.parentSession === "string" ? header.parentSession : undefined;
    } finally {
      await handle.close();
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logWarn("state", { event: "read-parent-header-failed", file: sessionFile, error: e instanceof Error ? e.message : String(e) });
    }
    return undefined;
  }
}

function cacheKey(sessionFile: string | undefined, sessionId: string): string {
  return sessionFile ? `file:${sessionFile}` : `session:${sessionId}`;
}

export class SessionStateStore {
  private cache = new Map<string, StateCacheSlot>();

  async load(sessionFile: string | undefined, sessionId: string): Promise<CompressionState> {
    const file = stateFileFor(sessionFile);
    const key = cacheKey(sessionFile, sessionId);
    const cached = this.cache.get(key);
    if (cached) return cached.state;
    let state = createInitialState();
    if (file) {
      try {
        const raw = await fs.readFile(file, "utf8");
        const parsed = JSON.parse(raw) as CompressionState;
        if (parsed && Array.isArray(parsed.blocks)) {
          state = mergeInitialState(parsed);
        }
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          logWarn("state", { event: "load-failed", file, error: e instanceof Error ? e.message : String(e) });
        }
      }
      // Inherit from parent when own state has no compression blocks.
      // Covers two cases: (1) ENOENT — file doesn't exist yet (new clone);
      // (2) empty blocks — file exists but was poisoned by a pre-fix resume
      // that saved createInitialState() before inheritance was added.
      if (state.blocks.length === 0 && sessionFile) {
        const parentState = await this.tryLoadParentState(sessionFile);
        if (parentState) state = parentState;
      }
    }
    this.cache.set(key, { state });
    return state;
  }

  async save(state: CompressionState, sessionFile: string | undefined, sessionId: string): Promise<void> {
    const file = stateFileFor(sessionFile);
    if (!file) return;
    const key = cacheKey(sessionFile, sessionId);
    this.cache.set(key, { state });
    const dir = path.dirname(file);
    await fs.mkdir(dir, { recursive: true }).catch((e: unknown) => {
      logError("state", { event: "save-mkdir-failed", dir, error: e instanceof Error ? e.message : String(e) });
    });
    const tmp = path.join(dir, `.acp-omp-tmp-${path.basename(file)}`);
    try {
      await fs.writeFile(tmp, JSON.stringify(state), "utf8");
      await fs.rename(tmp, file);
    } catch (e) {
      logError("state", { event: "save-failed", file, error: e instanceof Error ? e.message : String(e) });
    }
  }

  invalidate(): void {
    this.cache.clear();
  }

  private async tryLoadParentState(sessionFile: string): Promise<CompressionState | undefined> {
    const MAX_CHAIN_DEPTH = 8;
    let current = sessionFile;
    for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth++) {
      const parentJsonl = await readParentSessionPath(current);
      if (!parentJsonl) return undefined;
      const parentAcp = stateFileFor(parentJsonl);
      if (!parentAcp) return undefined;
      try {
        const raw = await fs.readFile(parentAcp, "utf8");
        const parsed = JSON.parse(raw) as CompressionState;
        if (parsed && Array.isArray(parsed.blocks) && parsed.blocks.length > 0) {
          logInfo("state", { event: "inherited-parent-state", file: parentAcp, depth, blocks: parsed.blocks.length, tokensCompressed: parsed.stats?.tokensCompressed ?? 0 });
          return mergeInitialState(parsed);
        }
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          logWarn("state", { event: "parent-state-load-failed", file: parentAcp, error: e instanceof Error ? e.message : String(e) });
          return undefined;
        }
      }
      current = parentJsonl;
    }
    logWarn("state", { event: "parent-chain-exhausted", file: sessionFile, maxDepth: MAX_CHAIN_DEPTH });
    return undefined;
  }
}

function mergeInitialState(parsed: CompressionState): CompressionState {
  const fresh = createInitialState();
  return {
    blocks: parsed.blocks ?? fresh.blocks,
    messageRefs: parsed.messageRefs ?? fresh.messageRefs,
    nudge: { ...fresh.nudge, ...(parsed.nudge ?? {}) },
    stats: { ...fresh.stats, ...(parsed.stats ?? {}) },
    nextBlockId: parsed.nextBlockId ?? fresh.nextBlockId,
    nextRunId: parsed.nextRunId ?? fresh.nextRunId,
  };
}
