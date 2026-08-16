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
│   ├── runtime.ts            # Fold architecture: foldStream, FoldSlot, primeFold
│   ├── messages.ts           # omp ↔ kernel message conversion + ref tag patching
│   ├── wire-transform.ts     # Provider mode: wire payload ↔ agent stream surgery (issue #52) + viewToWireStream session-view→wire mirror (issue #64) + applyMessagesInPlace in-place payload sync (issue #79)
│   ├── compress-tool.ts      # compress tool handler
│   ├── decompress-tool.ts    # decompress tool handler
│   ├── search-tool.ts        # search_context tool
│   ├── search-index.ts       # Builds SearchDoc[] from the fold projection + ACP blocks
│   ├── status-tool.ts        # acp_status tool
│   ├── commands.ts           # /acp slash command
│   ├── system-prompt.ts      # System prompt with compression philosophy
│   ├── instance-guard.ts    # dual-instance detection (omp install + extensions path)
│   ├── tool-guardrails.ts    # bash default timeout + tool output byte cap
│   ├── footer-status.ts      # formatCompactTokens (delegate footer is a no-op in omp)
│   ├── user-config.ts        # ~/.omp/acp-omp.json loader
│   ├── compat.ts             # system-prompt normalization for omp event shape (string[])
│   ├── dump.ts               # Debug dumps: context-out + provider-request (rotating)
│   ├── home.ts               # homeDir(): HOME||USERPROFILE||os.homedir() (Bun quirk)
│   ├── tokens.ts             # Token estimation utilities
│   ├── log.ts                # Debug logging (~/.omp/acp-omp.log)
│   └── update.ts             # Auto-update: checks npm, auto-installs latest
├── tests/                    # 213 tests
├── tsup.config.ts
└── package.json
```

### Key Design Decisions

1. **acp-kernel is bundled inline** — tsup does NOT list it in `external`, so `dist/index.js` is self-contained (zero runtime deps). **billion-context-kit** (the host-agnostic shared surface: /acp panel, viableRanges, topicFallback) is likewise bundled inline from devDependencies.
2. **Tags use XML format** `` — written with hex escapes (`\x3c`, `\x3e`) to avoid Write/Edit tool stripping.
3. **Assistant messages skip tag injection** — prevents model echo of XML tags.
4. **Tags appended to END of text** — matches opencode-acp / billion-context-pi pattern.
5. **Auto-update on session_start** — checks npm registry (throttled), auto-installs if newer.
6. **acp-kernel MUST be pinned to an exact version** (e.g. `"acp-kernel": "0.0.23"`, NEVER `"^0.0.23"`). It is a build-time dependency that tsup bundles inline; a caret range makes the resolved version drift if `package-lock.json` is regenerated or absent, breaking reproducible builds. **billion-context-kit follows the same rule** — exact npm version (e.g. `"billion-context-kit": "0.2.0"`), also bundled inline.
7. **Delegate subsystem deferred** — omp provides its own multi-agent orchestration. This package does NOT register `acp_delegate*` tools to avoid conflicts. The `DelegateConfig` type is retained in `config.ts` as an inert, forward-compatible surface.
8. **Paths are omp-scoped via `CONFIG_DIR_NAME`** — imported from `@oh-my-pi/pi-utils` (resolves to `.omp`). Config: `~/.omp/acp-omp.json`, log: `~/.omp/acp-omp.log`, state: `<session>.acp-omp.json`. These never collide with anything else.
9. **Schemas use arktype, not TypeBox** — omp's `ToolDefinition.parameters` accepts omp's `TSchema` (= arktype `Type`), re-exported from `@oh-my-pi/omptype`. TypeBox schemas are structurally incompatible. The 4 tool schemas use arktype's `type({...})` builder.
10. **`complete` import** — omp moved it to `@oh-my-pi/pi-ai` root (no `/compat` subpath). [REMOVED with auto-compress.ts in v0.2.5]
11. **`homeDir()` helper** — `src/home.ts`. omp's host runs under Bun, whose `os.homedir()` ignores `HOME`/`USERPROFILE` env. All home-dir reads in src go through `homeDir()` (respects env first) for cross-platform correctness.
12. **Tests run under Bun** — omp host packages import the Bun runtime, which Node cannot resolve. Use `bun test` (supports `node:test`/`node:assert` imports). Tests hardcode `.omp` (matching billion-context-pi's hardcoded-`.pi` pattern) rather than importing `CONFIG_DIR_NAME` (which would drag omp's module graph into the test process).
13. **ACP tools are `loadMode: "essential"`** — all four (compress/decompress/search_context/acp_status) declare it so the host keeps them top-level. Extension tools default to `"discoverable"`, which omp's tools.xdev mounts under xd:// (invoked via write with JSON-in-JSON); the device protocol caused issue #21's parse failures, and device descriptions are capped at 200 chars (XDEV_EXTERNAL_DESCRIPTION_CAP), hiding the tool guidance. Legacy xd://compress calls still replay (src/messages.ts). [#36/#43]
14. **Dual transform modes (`transformMode`, issue #52; per-API default, issue #79)** — "context": the battle-tested context-event rewrite; its output can be re-fed as input by omp's recap/subagent pipelines (feedback-view loops: #22/#47, the 01a0059b loop). "provider": context event is an observer; the surgery runs at `before_provider_request` on the WIRE payload (wire-transform.ts synthesizes the fold stream from the payload, survivors rebuild from original wire objects). Request-local body → structurally no re-entry. Unknown formats pass through (fail-open). Both modes share ONE pipeline (`transformStream` in index.ts). **The unset default resolves per model API by FORMAT support (transform-mode.ts `PROVIDER_FORMAT_APIS`)** — superseded PR #80's host-trust whitelist (reverted): it snapshotted which pi-ai providers assign the onPayload result (anthropic-messages, ollama-chat) and routed every other API to context, which fixed the default path but left explicit `transformMode:"provider"` silently delivering nothing on openai-completions and required manual widening when hosts change. With `applyMessagesInPlace` (#16) the delivery no longer depends on host behavior, so the set is now purely "wire body parseable by detectWireFormat": `{anthropic-messages, ollama-chat, openai-completions}` — provider default on all three; openai-responses (`input`), google (`contents`), bedrock Converse and cursor runRequests bodies are unparseable → context (the one channel every host delivers). An explicit `transformMode` always wins. **Upstream tracking (issue #83)**: the dropped-replacement bug is filed as can1357/oh-my-pi PR #8717; our in-place sync makes the host fix redundant-but-welcome (it also removes the only remaining assumption — that the host does not CLONE the payload between hook and fetch). Live dual-extension hazard: `omp install` plugins + config extensions can run TWO instances — dev e2e must use `--no-extensions -e <dist>`.
15. **primeFold folds the WIRE projection in provider mode (issue #64)** — the authoritative fold (and the span fingerprints the compress tool stores) run on the wire-synthesized stream, a different projection from the persisted session view: openai payloads carry the system prompt as the FIRST message (it takes `m00001`) and drop tool names on `role:"tool"` entries (the compress result is not ref-BLOCKED). Folding the raw session view at `session_start` lands refs/fingerprints in the wrong space, the span guard rejects every in-stream replay, and a resumed provider session shows "Blocks: none" until the first provider request. Fix: `primeFold` folds `viewToWireStream(view, baseSystem + ACP block)` (wire-transform.ts) when `transformMode="provider"` and the model api is `openai-completions`, so the preview is in the same ref/fingerprint space as the live fold. The ACP block is appended at prime time because `before_agent_start` (which appends it on the wire) hasn't fired yet at `session_start`. Anthropic and context mode keep folding the session view (their projections are faithful). The slot is still marked preview and re-folded authoritatively at the first live event.
16. **Hosts may DISCARD the before_provider_request replacement — sync in place (issue #79 ROOT fix)** — @oh-my-pi/pi-ai's openai-completions provider (verified up to 17.3.5) runs `options?.onPayload?.(params, model);` WITHOUT assigning the result, unlike anthropic / ollama-chat (`nextParams = replacementPayload ?? nextParams`); the bug is filed upstream as can1357/oh-my-pi PR #8717 (tracked in issue #83). Fix: `applyMessagesInPlace(payload, wireOut)` (wire-transform.ts) mirrors the rebuilt messages onto the ORIGINAL payload object — the exact reference the host serializes to fetch — so the surgery lands regardless of host behavior; the replacement object is still returned (identical content) for honoring hosts. This is what lets `PROVIDER_FORMAT_APIS` (#14) include openai-completions: provider mode is the unset DEFAULT there (GLM / DeepSeek / vLLM — the dominant local setups — no longer need context fallback and gain the structurally re-entry-immune pipeline). Consequence: `event.payload` is MUTATED by the handler — never assume it stays pristine after the hook. Guard: AWS Bedrock Converse payloads (marker keys `modelId`/`inferenceConfig`/`toolConfig`/`additionalModelRequestFields`) are classified `"unknown"` by `detectWireFormat` — they carry `{system, messages}` and were misdetected as anthropic, harmless while hosts discarded the replacement but corrupting once we sync in place; cursor runRequests have no `messages` array. Both pass through untouched.

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

`acp-kernel` is pinned in **devDependencies** (exact version, no `^`) and **bundled inline** at build time. `billion-context-kit` likewise (exact pin). ⚠️ Publishing order is strict: release `acp-kernel` first, then `billion-context-kit` (verify each `npm view <pkg> version`), THEN release billion-context-omp.

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
