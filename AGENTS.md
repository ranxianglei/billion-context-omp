# billion-context-omp Development Specification

> **This document is the highest-priority specification. All developers (including AI Agents) MUST comply.**

## 1. Project Overview

**billion-context-omp** is the [oh-my-pi (omp)](https://github.com/acidsugarx/oh-my-pi) adapter for ACP (Active Context Pruning). omp is an enhancement framework that runs on top of the [Pi CLI coding agent](https://github.com/nickthecook/pi); this package is a Pi extension that wires acp-kernel's compression pipeline into omp's Pi runtime, providing model-driven context management.

### Tech Stack

| Category | Technology |
|----------|-----------|
| Language | TypeScript (strict, ESM) |
| Build | tsup (bundling, inlines acp-kernel) |
| Test | Node.js built-in: `node --import tsx --test tests/*.test.ts` |
| Runtime Dep | `acp-kernel` (bundled at build time, zero runtime deps in dist) |
| Host | Pi `@earendil-works/pi-coding-agent` >=0.83 (omp runs on Pi) |

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
│   ├── state.ts              # State persistence (~/.pi/agent/sessions/*.acp-omp.json)
│   ├── messages.ts           # Pi ↔ kernel message conversion + ref tag patching
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
│   ├── user-config.ts        # ~/.pi/acp-omp.json loader
│   ├── compat.ts             # system-prompt normalization for Pi event shape
│   ├── sequence-match.ts     # live↔persisted message alignment (omp path)
│   ├── tokens.ts             # Token estimation utilities
│   ├── log.ts                # Debug logging (~/.pi/acp-omp.log)
│   └── update.ts             # Auto-update: checks npm, auto-installs latest
├── tests/                    # 194 tests
├── tsup.config.ts
└── package.json
```

### Key Design Decisions

1. **acp-kernel is bundled inline** — tsup does NOT list it in `external`, so `dist/index.js` is self-contained (zero runtime deps).
2. **Tags use XML format** `<acp tokens="2" type="text">m00001</acp>` — written with hex escapes (`\x3c`, `\x3e`) to avoid Write/Edit tool stripping.
3. **Assistant messages skip tag injection** — prevents model echo of XML tags.
4. **Tags appended to END of text** — matches opencode-acp / billion-context-pi pattern.
5. **Auto-update on session_start** — checks npm registry (3 min throttle), auto-installs if newer.
6. **acp-kernel MUST be pinned to an exact version** (e.g. `"acp-kernel": "0.0.22"`, NEVER `"^0.0.22"`). It is a build-time dependency that tsup bundles inline; a caret range makes the resolved version drift if `package-lock.json` is regenerated or absent, breaking reproducible builds.
7. **Delegate subsystem deferred** — omp provides its own multi-agent orchestration (`delegate-task`). This package does NOT register `acp_delegate*` tools to avoid conflicts. The `DelegateConfig` type is retained in `config.ts` as an inert, forward-compatible surface.
8. **Paths are omp-scoped** — `~/.pi/acp-omp.json` (config), `~/.pi/acp-omp.log` (log), `<session>.acp-omp.json` (state). These never collide with a co-installed `billion-context-pi`.

## 3. Development Standards

### Build Commands

```bash
npm run build          # tsup bundle (inlines acp-kernel) + tsc --emitDeclarationOnly
npm run typecheck      # TypeScript type checking
npm test               # node --import tsx --test tests/*.test.ts
```

### Code Quality

- **No `as any`**, **No `@ts-ignore`**
- **No comments unless absolutely necessary**
- Hex escapes required for any `<acp>` XML in source files

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
