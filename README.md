[English](./README.md) | [中文](./README.zh-CN.md)

# billion-context-omp

[acp-kernel](https://github.com/ranxianglei/acp-kernel)-powered, model-driven context management for the [omp (oh-my-pi)](https://github.com/can1357/oh-my-pi) coding agent.

[omp](https://omp.sh) is a hard fork of the [Pi coding agent](https://github.com/nickthecook/pi) (re-scoped `@oh-my-pi/*` packages). `billion-context-omp` targets omp's native extension API and wires acp-kernel's compression pipeline into it — giving you multi-tier, model-driven context compression with zero runtime dependencies.

> **Not** a drop-in copy of `billion-context-pi`. omp's extension API differs from standard Pi (arktype schemas, `string[]` system prompts, divergent message/tool shapes, `~/.omp` config dir), so this port targets omp directly rather than leaning on omp's legacy-Pi shim.

## What it does

- **Message-ref tagging** — every message gets an `` ref tag the model cites inside compress calls.
- **Model-driven compression** — the model writes the summaries; the engine decides *when* to compress, *what range*, and tracks all state.
- **3-tier LSM compression** — tier-1 summaries distill into tier-2, then tier-3, as the session grows.
- **Growth-gated nudges** — a nudge is injected into context only when usage crosses a threshold *and* context has grown, so it never fires spuriously.
- **Emergency truncation** — last-resort truncation of runaway tool outputs above the emergency threshold.
- **Decompress + search** — restore a compressed block on demand, or keyword-search all summaries without decompressing.
- **`/compact` interception** — omp's native compaction is replaced by an ACP model-summarized compaction.

## Install

omp loads extensions via the `extensions:` setting (user `~/.omp/agent/settings.json` or project `.omp/settings.json`), or the `omp:` manifest key, or the `--trusted-extension` flag.

From npm:

```bash
omp install billion-context-omp
```

Or add it to your omp settings:

```jsonc
{
  "extensions": ["billion-context-omp"]
}
```

Restart omp. The extension auto-activates on the next session.

## Config

Config is read from `~/.omp/acp-omp.json` (global) and `<project>/.omp/acp-omp.json` (project-local overrides global):

```jsonc
{
  "debug": false,            // verbose ACP log (default ~/.omp/acp-omp.log)
  "autoUpdate": true,        // auto-install newer versions from npm
  "modelContextLimit": 200000,
  "compress": {
    "maxContextLimit": "75%",        // forced-compression threshold
    "emergencyThresholdPercent": "95%", // emergency truncation threshold
    "nudgeGrowthTokens": 50000
  },
  "compressModel": "zhipuai:glm-5.2", // model used for /compact auto-compression
  "toolBashDefaultTimeout": 60,
  "toolOutputMaxBytes": 200000
}
```

State persists to `~/.omp/agent/sessions/<session>.acp-omp.json`.

## Tools & commands

| Tool | Purpose |
|------|---------|
| `compress` | Replace a conversation range with a summary you write |
| `decompress` | Restore a compressed block (to file by default; `inline:true` to return inline) |
| `search_context` | Keyword-search compressed summaries |
| `acp_status` | Context usage, breakdown, compressible ranges, blocks |

| Command | Purpose |
|---------|---------|
| `/acp` | Context usage + token breakdown + compression status |
| `/acp-status` | Same as `/acp` |
| `/acp-decompress <id>` | Restore a block's content inline |
| `/acp-search <query>` | Search compressed blocks |

## Relationship to billion-context-pi

`billion-context-omp` is a close port of [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi). Both are acp-kernel adapters. Differences:

- **Targets omp, not Pi** — imports types from `@oh-my-pi/pi-coding-agent` (omp's fork), uses omp's arktype schemas (`@oh-my-pi/omptype`), and reads the config dir from `@oh-my-pi/pi-utils` (`CONFIG_DIR_NAME` = `.omp`), so all paths land under `~/.omp/`.
- **Package identity & paths** — `billion-context-omp` uses `~/.omp/acp-omp.json`, `~/.omp/acp-omp.log`, and `<session>.acp-omp.json` state files, so it never collides with anything else.
- **Delegate subsystem deferred** — omp already provides its own multi-agent orchestration. To avoid tool conflicts, this port does **not** register the `acp_delegate`/`acp_delegate_wait`/`acp_delegate_cancel` tools or the fleet status widget. Everything else (compression, decompress, search, status, nudges, `/compact` interception, tool guardrails) is identical to the Pi build.

## Build

```bash
npm run build       # tsup bundle (inlines acp-kernel) + tsc --emitDeclarationOnly
npm run typecheck   # tsc --noEmit
npm test            # bun test tests/*.test.ts
```

`dist/index.js` is self-contained — acp-kernel is bundled inline (zero runtime deps).

> Tests run under [Bun](https://bun.sh) (omp's host packages import the Bun runtime). Install Bun first: `curl -fsSL https://bun.sh/install | sh`.

## License

MIT © ranxianglei
