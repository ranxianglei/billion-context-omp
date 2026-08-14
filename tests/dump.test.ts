import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync, mkdtempSync } from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { setDebugEnabled } from "../src/log.js";
import { dumpContextMessages, dumpDir } from "../src/dump.js";

describe("dump", () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let origProfile: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(path.join(tmpdir(), "acp-dump-test-"));
    origHome = process.env.HOME;
    origProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
  });

  afterEach(() => {
    setDebugEnabled(false);
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = origProfile;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test("returns null and writes nothing when debug disabled", () => {
    setDebugEnabled(false);
    const result = dumpContextMessages([{ role: "user", content: "hi" }], {
      sid: "s1",
      injected: false,
      emergency: false,
    });
    assert.equal(result, null);
    assert.equal(existsSync(dumpDir()), false);
  });

  test("writes sequential JSON when debug enabled", () => {
    setDebugEnabled(true);
    const msgs = [{ role: "user", content: "hello" }];
    const p0 = dumpContextMessages(msgs, { sid: "s1", injected: false, emergency: false });
    const p1 = dumpContextMessages(msgs, { sid: "s1", injected: true, emergency: false });

    assert.ok(p0);
    assert.ok(p1);
    assert.ok(p0!.endsWith("0000.json"));
    assert.ok(p1!.endsWith("0001.json"));

    const files = readdirSync(dumpDir()).sort();
    assert.equal(files.length, 2);
    assert.deepEqual(files, ["0000.json", "0001.json"]);

    const data = JSON.parse(readFileSync(p1!, "utf8"));
    assert.equal(data.sid, "s1");
    assert.equal(data.injected, true);
    assert.equal(data.emergency, false);
    assert.equal(data.outMsgs, 1);
    assert.deepEqual(data.messages, msgs);
    assert.ok(typeof data.ts === "string");
  });

  test("continues numbering from existing files", () => {
    setDebugEnabled(true);
    const dir = dumpDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "0005.json"), "{}");

    const p = dumpContextMessages([], { sid: "s1", injected: false, emergency: false });
    assert.ok(p!.endsWith("0006.json"));
  });
});
