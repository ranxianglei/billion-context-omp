import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { SessionStateStore, readParentSessionPath } from "../src/state.js";
import { createInitialState } from "acp-kernel";

function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "acp-state-"));
}

test("load returns fresh state when no file exists", async () => {
  const dir = await tempDir();
  const store = new SessionStateStore();
  const state = await store.load(path.join(dir, "session.json"), "sid-1");
  assert.deepEqual(state.blocks, []);
  assert.equal(state.nextBlockId, 1, "fresh state starts nextBlockId at 1");
  await rm(dir, { recursive: true, force: true });
});

test("save then load round-trips state", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "session.json");
  const store = new SessionStateStore();
  const before = createInitialState();
  before.blocks.push({
    blockId: "b0",
    runId: "0",
    tier: 1,
    generation: "young",
    active: true,
    summary: "alpha",
    directMessageIds: ["a", "b"],
    effectiveMessageIds: ["a", "b"],
    directBlockIds: [],
    compressedTokens: 0,
    survivedCount: 1,
    createdAt: 100,
  });
  before.nextBlockId = 1;
  before.messageRefs.byRaw.a = "m00000";
  before.messageRefs.byRef.m00000 = "a";

  await store.save(before, file, "sid");
  const store2 = new SessionStateStore();
  const after = await store2.load(file, "sid");

  assert.equal(after.blocks.length, 1);
  assert.equal(after.blocks[0]!.blockId, "b0");
  assert.equal(after.nextBlockId, 1);
  assert.equal(after.messageRefs.byRef.m00000, "a");
  await rm(dir, { recursive: true, force: true });
});

test("load merges forward-compat: missing fields filled from fresh state", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "session.json");
  // The store persists to `{sessionFile}.acp-omp.json`; write a minimal legacy file there.
  const minimal = { blocks: [{ blockId: "b0", active: true }], nextBlockId: 1 };
  const { promises: fs } = await import("node:fs");
  await fs.writeFile(`${file}.acp-omp.json`, JSON.stringify(minimal), "utf8");

  const store = new SessionStateStore();
  const state = await store.load(file, "sid");
  assert.equal(state.blocks.length, 1);
  assert.equal(state.nudge.lastPerMessageNudgeTokens, 0, "nudge backfilled");
  assert.ok(state.messageRefs.byRaw, "messageRefs backfilled");
  await rm(dir, { recursive: true, force: true });
});

test("invalidate forces a fresh read after save", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "session.json");
  const store = new SessionStateStore();
  const s1 = createInitialState();
  s1.nextBlockId = 5;
  await store.save(s1, file, "sid");

  store.invalidate();
  const reloaded = await store.load(file, "sid");
  assert.equal(reloaded.nextBlockId, 5);
  await rm(dir, { recursive: true, force: true });
});

const { promises: fs } = await import("node:fs");

async function writeSessionHeader(file: string, opts: { parentSession?: string } = {}) {
  const header = { type: "session", version: 3, id: "test-sid", timestamp: new Date().toISOString(), cwd: "/tmp", ...opts };
  await fs.writeFile(file, JSON.stringify(header) + "\n", "utf8");
}

async function writeAcpState(sessionFile: string, blocks: unknown[] = [], nextBlockId = 1) {
  const state = { blocks, nextBlockId, messageRefs: { byRaw: {}, byRef: {}, nextRef: 0 }, nudge: {}, stats: {} };
  await fs.writeFile(`${sessionFile}.acp-omp.json`, JSON.stringify(state), "utf8");
}

function makeBlock(id: string) {
  return { blockId: id, runId: 0, tier: 1, generation: "young", active: true, summary: `summary ${id}`, directMessageIds: ["msg-a"], effectiveMessageIds: ["msg-a"], survivedCount: 1, createdAt: Date.now() };
}

test("readParentSessionPath: returns parentSession from valid header", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "child.jsonl");
  await writeSessionHeader(file, { parentSession: "/some/parent.jsonl" });
  const result = await readParentSessionPath(file);
  assert.equal(result, "/some/parent.jsonl");
  await rm(dir, { recursive: true, force: true });
});

test("readParentSessionPath: returns undefined when no parentSession in header", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "child.jsonl");
  await writeSessionHeader(file);
  const result = await readParentSessionPath(file);
  assert.equal(result, undefined);
  await rm(dir, { recursive: true, force: true });
});

test("readParentSessionPath: returns undefined for missing file", async () => {
  const result = await readParentSessionPath("/nonexistent/file.jsonl");
  assert.equal(result, undefined);
});

test("readParentSessionPath: returns undefined for empty file", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "empty.jsonl");
  await fs.writeFile(file, "", "utf8");
  const result = await readParentSessionPath(file);
  assert.equal(result, undefined);
  await rm(dir, { recursive: true, force: true });
});

test("readParentSessionPath: returns undefined when first line is not JSON", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "bad.jsonl");
  await fs.writeFile(file, "not json at all\n", "utf8");
  const result = await readParentSessionPath(file);
  assert.equal(result, undefined);
  await rm(dir, { recursive: true, force: true });
});

test("clone inherits parent compression state via parentSession", async () => {
  const dir = await tempDir();
  const parentJsonl = path.join(dir, "parent.jsonl");
  const childJsonl = path.join(dir, "child.jsonl");

  await writeSessionHeader(parentJsonl);
  await writeAcpState(parentJsonl, [makeBlock("b0"), makeBlock("b1")], 3);
  await writeSessionHeader(childJsonl, { parentSession: parentJsonl });

  const store = new SessionStateStore();
  const state = await store.load(childJsonl, "child-sid");

  assert.equal(state.blocks.length, 2);
  assert.equal(state.blocks[0]!.blockId, "b0");
  assert.equal(state.blocks[1]!.blockId, "b1");
  assert.equal(state.nextBlockId, 3);
  await rm(dir, { recursive: true, force: true });
});

test("P1: clone inherits when own .acp-omp.json exists but has empty blocks", async () => {
  const dir = await tempDir();
  const parentJsonl = path.join(dir, "parent.jsonl");
  const childJsonl = path.join(dir, "child.jsonl");

  await writeSessionHeader(parentJsonl);
  await writeAcpState(parentJsonl, [makeBlock("b0")], 2);
  await writeSessionHeader(childJsonl, { parentSession: parentJsonl });
  await writeAcpState(childJsonl, [], 1);

  const store = new SessionStateStore();
  const state = await store.load(childJsonl, "child-sid");

  assert.equal(state.blocks.length, 1);
  assert.equal(state.blocks[0]!.blockId, "b0");
  assert.equal(state.nextBlockId, 2);
  await rm(dir, { recursive: true, force: true });
});

test("chain walk: inherits grandparent when parent has no .acp-omp.json", async () => {
  const dir = await tempDir();
  const grandparentJsonl = path.join(dir, "grandparent.jsonl");
  const parentJsonl = path.join(dir, "parent.jsonl");
  const childJsonl = path.join(dir, "child.jsonl");

  await writeSessionHeader(grandparentJsonl);
  await writeAcpState(grandparentJsonl, [makeBlock("gp0")], 2);
  await writeSessionHeader(parentJsonl, { parentSession: grandparentJsonl });
  await writeSessionHeader(childJsonl, { parentSession: parentJsonl });

  const store = new SessionStateStore();
  const state = await store.load(childJsonl, "child-sid");

  assert.equal(state.blocks.length, 1);
  assert.equal(state.blocks[0]!.blockId, "gp0");
  await rm(dir, { recursive: true, force: true });
});

test("chain walk: parent with empty blocks continues to grandparent", async () => {
  const dir = await tempDir();
  const grandparentJsonl = path.join(dir, "grandparent.jsonl");
  const parentJsonl = path.join(dir, "parent.jsonl");
  const childJsonl = path.join(dir, "child.jsonl");

  await writeSessionHeader(grandparentJsonl);
  await writeAcpState(grandparentJsonl, [makeBlock("gp0")], 2);
  await writeSessionHeader(parentJsonl, { parentSession: grandparentJsonl });
  await writeAcpState(parentJsonl, [], 1);
  await writeSessionHeader(childJsonl, { parentSession: parentJsonl });

  const store = new SessionStateStore();
  const state = await store.load(childJsonl, "child-sid");

  assert.equal(state.blocks.length, 1);
  assert.equal(state.blocks[0]!.blockId, "gp0");
  await rm(dir, { recursive: true, force: true });
});

test("load does not inherit when own state has blocks", async () => {
  const dir = await tempDir();
  const parentJsonl = path.join(dir, "parent.jsonl");
  const childJsonl = path.join(dir, "child.jsonl");

  await writeSessionHeader(parentJsonl);
  await writeAcpState(parentJsonl, [makeBlock("parent-block")], 2);
  await writeSessionHeader(childJsonl, { parentSession: parentJsonl });
  await writeAcpState(childJsonl, [makeBlock("child-block")], 2);

  const store = new SessionStateStore();
  const state = await store.load(childJsonl, "child-sid");

  assert.equal(state.blocks.length, 1);
  assert.equal(state.blocks[0]!.blockId, "child-block");
  await rm(dir, { recursive: true, force: true });
});

test("no parentSession in header → fresh state even with empty blocks", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "session.jsonl");

  await writeSessionHeader(file);
  await writeAcpState(file, [], 1);

  const store = new SessionStateStore();
  const state = await store.load(file, "sid");

  assert.equal(state.blocks.length, 0);
  assert.equal(state.nextBlockId, 1);
  await rm(dir, { recursive: true, force: true });
});

test("live ref origins remain isolated across interleaved sessions", async () => {
  const dir = await tempDir();
  const fileA = path.join(dir, "a.session.json");
  const fileB = path.join(dir, "b.session.json");
  const store = new SessionStateStore();
  const stateA = await store.load(fileA, "a");
  const stateB = await store.load(fileB, "b");
  store.setLiveRefOrigins(fileA, "a", [{ rawId: "live-1", identity: "A" }]);
  store.setLiveRefOrigins(fileB, "b", [{ rawId: "live-0", identity: "B" }]);
  await store.save(stateA, fileA, "a");
  await store.save(stateB, fileB, "b");
  store.invalidate();
  await store.load(fileA, "a");
  await store.load(fileB, "b");
  assert.deepEqual(store.getLiveRefOrigins(fileA, "a"), [{ rawId: "live-1", identity: "A" }]);
  assert.deepEqual(store.getLiveRefOrigins(fileB, "b"), [{ rawId: "live-0", identity: "B" }]);
  await rm(dir, { recursive: true, force: true });
});
