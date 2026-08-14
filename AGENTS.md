# billion-context-omp Development Specification

> **This document is the highest-priority specification. All developers (including AI Agents) MUST comply.**

## 1. Project Overview

**billion-context-omp** is the [omp (oh-my-pi)](https://github.com/can1357/oh-my-pi) adapter for ACP (Active Context Pruning). omp is a hard fork of the Pi coding agent (re-scoped `@oh-my-pi/*` packages); this package targets omp's native extension API and wires acp-kernel's compression pipeline into it, providing model-driven context management.

> ⚠️ omp is **similar to Pi but not Pi**. Its extension API diverges (arktype schemas instead of TypeBox, `string[]` system prompts, different message/tool shapes, `~/.omp` config dir). Implement against omp's native types directly — do NOT lean on omp's legacy-Pi shim, or subtle bugs proliferate.

### Tech Stack

| Category | Technology |
|----------|-----------|
| Language | TypeScript (strict, ESM) |
| Build | tsup (bundling, inlines acp-kernel) |
| Test | Bun: `bun test tests/*.test.ts` (omp host packages import the Bun runtime) |
| Runtime Dep | `acp-kernel` (bundled at build time, zero runtime deps in dist) |
| Host | omp `@oh-my-pi/pi-coding-agent` >=17.0.0 |

### Repository Info

| Field | Value |
|-------|-------|
| npm package | `billion-context-omp` |
| GitHub | https://github.com/ranxianglei/billion-context-omp |
| License | MIT |

## 2. Architecture

### Module Map

```
billion-context-omp/
├── src/
│   ├── index.ts              # Extension entry: wire hooks, tools, commands
│   ├── config.ts             # AdapterConfig: wraps kernel defaultConfig
│   ├── runtime.ts            # AcpRuntime: state store, lock, stateFor()
│   ├── state.ts              # State persistence (~/.omp/agent/sessions/*.acp-omp.json)
│   ├── messages.ts           # omp ↔ kernel message conversion + ref tag patching
│   ├── compress-tool.ts      # compress tool handler
│   ├── decompress-tool.ts    # decompress tool handler
│   ├── search-tool.ts        # search_context tool
│   ├── search-index.ts       # Builds SearchDoc[] from session log + ACP blocks
│   ├── status-tool.ts        # acp_status tool
│   ├── commands.ts           # /acp slash command
│   ├── system-prompt.ts      # System prompt with compression philosophy
│   ├── auto-compress.ts      # /compact interception: model-summarized compaction
│   ├── tool-guardrails.ts    # bash default timeout + tool output byte cap
│   ├── footer-status.ts      # formatCompactTokens (delegate footer is a no-op in omp)
│   ├── user-config.ts        # ~/.omp/acp-omp.json loader
│   ├── compat.ts             # system-prompt normalization for omp event shape (string[])
│   ├── sequence-match.ts     # live↔persisted message alignment (omp path)
│   ├── home.ts               # homeDir(): HOME||USERPROFILE||os.homedir() (Bun quirk)
│   ├── tokens.ts             # Token estimation utilities
│   ├── log.ts                # Debug logging (~/.omp/acp-omp.log)
│   └── update.ts             # Auto-update: checks npm, auto-installs latest
├── tests/                    # 179 tests
├── tsup.config.ts
└── package.json
```

### Key Design Decisions

1. **acp-kernel is bundled inline** — tsup does NOT list it in `external`, so `dist/index.js` is self-contained (zero runtime deps).
2. **Tags use XML format** `` — written with hex escapes (`\x3c`, `\x3e`) to avoid Write/Edit tool stripping.
3. **Assistant messages skip tag injection** — prevents model echo of XML tags.
4. **Tags appended to END of text** — matches opencode-acp / billion-context-pi pattern.
5. **Auto-update on session_start** — checks npm registry (throttled), auto-installs if newer.
6. **acp-kernel MUST be pinned to an exact version** (e.g. `"acp-kernel": "0.0.22"`, NEVER `"^0.0.22"`). It is a build-time dependency that tsup bundles inline; a caret range makes the resolved version drift if `package-lock.json` is regenerated or absent, breaking reproducible builds.
7. **Delegate subsystem deferred** — omp provides its own multi-agent orchestration. This package does NOT register `acp_delegate*` tools to avoid conflicts. The `DelegateConfig` type is retained in `config.ts` as an inert, forward-compatible surface.
8. **Paths are omp-scoped via `CONFIG_DIR_NAME`** — imported from `@oh-my-pi/pi-utils` (resolves to `.omp`). Config: `~/.omp/acp-omp.json`, log: `~/.omp/acp-omp.log`, state: `<session>.acp-omp.json`. These never collide with anything else.
9. **Schemas use arktype, not TypeBox** — omp's `ToolDefinition.parameters` accepts omp's `TSchema` (= arktype `Type`), re-exported from `@oh-my-pi/omptype`. TypeBox schemas are structurally incompatible. The 4 tool schemas use arktype's `type({...})` builder.
10. **`complete` import** — omp moved it to `@oh-my-pi/pi-ai` root (no `/compat` subpath). `auto-compress.ts` imports `complete` from there.
11. **`homeDir()` helper** — `src/home.ts`. omp's host runs under Bun, whose `os.homedir()` ignores `HOME`/`USERPROFILE` env. All home-dir reads in src go through `homeDir()` (respects env first) for cross-platform correctness.
12. **Tests run under Bun** — omp host packages import the Bun runtime, which Node cannot resolve. Use `bun test` (supports `node:test`/`node:assert` imports). Tests hardcode `.omp` (matching billion-context-pi's hardcoded-`.pi` pattern) rather than importing `CONFIG_DIR_NAME` (which would drag omp's module graph into the test process).

## 3. Development Standards

### Build Commands

```bash
npm run build          # tsup bundle (inlines acp-kernel) + tsc --emitDeclarationOnly
npm run typecheck      # tsc --noEmit
npm test               # bun test tests/*.test.ts
```

### Code Quality

- **No `as any`**, **No `@ts-ignore`**
- **No comments unless absolutely necessary**
- Hex escapes required for any `` XML in source files

## 4. Git Safety Rules

Same as acp-kernel. See [acp-kernel AGENTS.md §4](https://github.com/ranxianglei/acp-kernel/blob/master/AGENTS.md).

### PR Merge — Absolute Prohibition

PR merges are **human-only**. The Agent MUST NEVER merge any PR.

## 5. Release Workflow

Same baseline as acp-kernel (branch naming, CI auto-publish, PR-merge-is-human-only, pre-flight checks, release-commit convention). Release branches: `YYYY-MM-DD_release-v{VERSION}`.

### Cross-repo dependency: acp-kernel MUST ship first

`acp-kernel` is pinned in **devDependencies** (exact version, no `^`) and **bundled inline** at build time. ⚠️ Publishing order is strict: release `acp-kernel` first, verify `npm view acp-kernel version`, THEN release billion-context-omp.

### Release commit

Bumps `"version"` in `package.json` and refreshes `package-lock.json`:
```bash
npm install                              # updates package-lock.json
npm run typecheck && npm test && npm run build
```
Commit message: `release v{VERSION}`. The commit touches `package.json` + `package-lock.json`.

## 6. npm Publishing

```bash
npm run build
npm test
npm publish
```

CI auto-publishes on release branch merge. Manual publish only as fallback.
