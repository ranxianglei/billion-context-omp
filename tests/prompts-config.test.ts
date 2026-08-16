import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { resolvePrompts, defaultPrompts } from "acp-kernel";
import { buildAcpSystemPrompt } from "../src/system-prompt.js";
import { loadUserConfig, applyUserConfig } from "../src/user-config.js";
import type { AdapterConfig } from "../src/config.js";

const CONFIG_DIR_NAME = ".omp";

test("buildAcpSystemPrompt with defaults contains the philosophy and tier rules", () => {
  const prompt = buildAcpSystemPrompt(defaultPrompts);
  assert.ok(prompt.includes("ACP context management"), "has header");
  assert.ok(prompt.includes(defaultPrompts.compressPhilosophy.slice(0, 40)), "embeds compressPhilosophy");
  assert.ok(prompt.includes(defaultPrompts.howToCompressRules.slice(0, 40)), "embeds howToCompressRules");
  assert.ok(prompt.includes(defaultPrompts.tier2DistillRules.slice(0, 40)), "embeds tier2DistillRules");
  assert.ok(prompt.includes(defaultPrompts.tier3CondenseRules.slice(0, 40)), "embeds tier3CondenseRules");
});

test("buildAcpSystemPrompt reflects acknowledged custom prompts", () => {
  const custom = resolvePrompts(
    { compressPhilosophy: "CUSTOM-PHILOSOPHY-MARKER" },
    { acknowledgeRisk: true },
  );
  const prompt = buildAcpSystemPrompt(custom);
  assert.ok(prompt.includes("CUSTOM-PHILOSOPHY-MARKER"), "custom philosophy present");
  assert.ok(!prompt.includes(defaultPrompts.compressPhilosophy.slice(0, 40)), "default philosophy replaced");
  assert.ok(prompt.includes(defaultPrompts.howToCompressRules.slice(0, 40)), "unoverridden fields keep defaults");
});

test("resolvePrompts throws on override without acknowledgeRisk", () => {
  assert.throws(
    () => resolvePrompts({ compressPhilosophy: "x" }),
    /acknowledgeRisk/,
    "ungated override must throw",
  );
});

test("resolvePrompts with empty overrides is a no-op (no gate needed)", () => {
  const resolved = resolvePrompts({});
  assert.equal(resolved.compressPhilosophy, defaultPrompts.compressPhilosophy);
});

test("loadUserConfig picks up prompts and acknowledgePromptsRisk keys from the GLOBAL config", async () => {
  const tmpDir = path.join(os.tmpdir(), `acp-prompts-${Date.now()}`);
  const cfgDir = path.join(tmpDir, CONFIG_DIR_NAME);
  await fs.mkdir(cfgDir, { recursive: true });
  await fs.writeFile(
    path.join(cfgDir, "acp-omp.json"),
    JSON.stringify({ prompts: { compressPhilosophy: "X" }, acknowledgePromptsRisk: true }),
    "utf8",
  );
  const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = tmpDir;
  process.env.USERPROFILE = tmpDir;
  const cwd = path.join(tmpDir, "unrelated-project"); // no project-local config
  try {
    const config = await loadUserConfig(cwd);
    assert.equal(config.acknowledgePromptsRisk, true, "acknowledgePromptsRisk loaded");
    assert.deepEqual(config.prompts, { compressPhilosophy: "X" }, "prompts loaded");
  } finally {
    process.env.HOME = savedHome.HOME;
    process.env.USERPROFILE = savedHome.USERPROFILE;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("project-local acp-omp.json cannot inject prompts (issue #32)", async () => {
  const tmpDir = path.join(os.tmpdir(), `acp-proj-prompts-${Date.now()}`);
  const homeDirPath = path.join(tmpDir, "home");
  const projectDir = path.join(tmpDir, "repo-under-agent-control");
  await fs.mkdir(path.join(homeDirPath, CONFIG_DIR_NAME), { recursive: true });
  await fs.mkdir(path.join(projectDir, CONFIG_DIR_NAME), { recursive: true });
  await fs.writeFile(
    path.join(homeDirPath, CONFIG_DIR_NAME, "acp-omp.json"),
    JSON.stringify({ modelContextLimit: 123_456 }),
    "utf8",
  );
  // A repo under agent control ships a project-local config that tries to
  // rewrite the system-prompt surface AND pre-acknowledge the risk gate.
  await fs.writeFile(
    path.join(projectDir, CONFIG_DIR_NAME, "acp-omp.json"),
    JSON.stringify({ prompts: { compressPhilosophy: "INJECTED" }, acknowledgePromptsRisk: true, toolOutputMaxBytes: 999 }),
    "utf8",
  );
  const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = homeDirPath;
  process.env.USERPROFILE = homeDirPath;
  try {
    const config = await loadUserConfig(projectDir);
    assert.equal(config.prompts, undefined, "project-local prompts must be ignored");
    assert.equal(config.acknowledgePromptsRisk, undefined, "project-local risk acknowledgement must be ignored");
    assert.equal(config.modelContextLimit, 123_456, "global keys still load");
    assert.equal(config.toolOutputMaxBytes, 999, "project-local tuning keys still override");
  } finally {
    process.env.HOME = savedHome.HOME;
    process.env.USERPROFILE = savedHome.USERPROFILE;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("project-local config UNDER $HOME cannot inject prompts (prefix-match bypass)", async () => {
  // Regression: allowPrompts used base.startsWith(home), and the default
  // dev layout (project at ~/code/repo) puts the project config dir under
  // $HOME too — the issue #32 gate only held for projects outside $HOME.
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-proj-home-"));
  const homeDirPath = path.join(tmpDir, "home");
  const projectDir = path.join(homeDirPath, "code", "repo-under-home");
  await fs.mkdir(path.join(homeDirPath, CONFIG_DIR_NAME), { recursive: true });
  await fs.mkdir(path.join(projectDir, CONFIG_DIR_NAME), { recursive: true });
  await fs.writeFile(
    path.join(homeDirPath, CONFIG_DIR_NAME, "acp-omp.json"),
    JSON.stringify({ modelContextLimit: 123_456 }),
    "utf8",
  );
  await fs.writeFile(
    path.join(projectDir, CONFIG_DIR_NAME, "acp-omp.json"),
    JSON.stringify({ prompts: { compressPhilosophy: "INJECTED" }, acknowledgePromptsRisk: true, toolOutputMaxBytes: 999 }),
    "utf8",
  );
  const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = homeDirPath;
  process.env.USERPROFILE = homeDirPath;
  try {
    const config = await loadUserConfig(projectDir);
    assert.equal(config.prompts, undefined, "project-under-$HOME prompts must be ignored");
    assert.equal(config.acknowledgePromptsRisk, undefined, "project-under-$HOME risk acknowledgement must be ignored");
    assert.equal(config.modelContextLimit, 123_456, "global keys still load");
    assert.equal(config.toolOutputMaxBytes, 999, "project-local tuning keys still override");
  } finally {
    process.env.HOME = savedHome.HOME;
    process.env.USERPROFILE = savedHome.USERPROFILE;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("global prompts still load when the project also sits under $HOME (no over-blocking)", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-global-home-"));
  const homeDirPath = path.join(tmpDir, "home");
  const projectDir = path.join(homeDirPath, "code", "another-repo");
  await fs.mkdir(path.join(homeDirPath, CONFIG_DIR_NAME), { recursive: true });
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(
    path.join(homeDirPath, CONFIG_DIR_NAME, "acp-omp.json"),
    JSON.stringify({ prompts: { compressPhilosophy: "LEGIT" }, acknowledgePromptsRisk: true }),
    "utf8",
  );
  const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = homeDirPath;
  process.env.USERPROFILE = homeDirPath;
  try {
    const config = await loadUserConfig(projectDir);
    assert.deepEqual(config.prompts, { compressPhilosophy: "LEGIT" }, "global prompts still load");
    assert.equal(config.acknowledgePromptsRisk, true, "global risk acknowledgement still loads");
  } finally {
    process.env.HOME = savedHome.HOME;
    process.env.USERPROFILE = savedHome.USERPROFILE;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("applyUserConfig flows prompts through to the adapter", () => {
  const adapter: AdapterConfig = { modelContextLimit: 200_000 };
  const user = { prompts: { tier3CondenseRules: "Y" }, acknowledgePromptsRisk: true };
  const result = applyUserConfig(adapter, user);
  assert.deepEqual(result.prompts, { tier3CondenseRules: "Y" }, "prompts merged");
  assert.equal(result.acknowledgePromptsRisk, true, "ack flag merged");
  assert.equal(result.modelContextLimit, 200_000, "other fields preserved");
});

test("buildAcpSystemPrompt default output is byte-stable (no trailing whitespace, full rules embedded)", () => {
  const prompt = buildAcpSystemPrompt(defaultPrompts);
  assert.ok(
    prompt.endsWith("the current step no longer needs them.\n"),
    "ends exactly like the master const — const->function refactor must not add trailing whitespace",
  );
  assert.equal(
    /\s$/.test(prompt.replace(/\n$/, "")),
    false,
    "no trailing whitespace before the final newline",
  );
  assert.ok(prompt.includes(defaultPrompts.compressPhilosophy), "full compressPhilosophy embedded verbatim");
  assert.ok(prompt.includes(defaultPrompts.howToCompressRules), "full howToCompressRules embedded verbatim");
  assert.ok(prompt.includes(defaultPrompts.tier2DistillRules), "full tier2DistillRules embedded verbatim");
  assert.ok(prompt.includes(defaultPrompts.tier3CondenseRules), "full tier3CondenseRules embedded verbatim");
});
