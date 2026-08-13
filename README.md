[English](./README.md) | [中文](./README.zh-CN.md)

# billion-context-omp

[acp-kernel](https://github.com/ranxianglei/acp-kernel)-powered, model-driven context management for the [oh-my-pi (omp)](https://github.com/acidsugarx/oh-my-pi) coding agent.

omp is an enhancement framework that runs **on top of the [Pi CLI coding agent](https://github.com/nickthecook/pi)**. `billion-context-omp` is a Pi extension (just like [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi)) that wires acp-kernel's compression pipeline into omp's Pi runtime — giving you multi-tier, model-driven context compression with zero runtime dependencies.

## What it does

- **Message-ref tagging** — every message gets an `<acp tokens="2.1K" type="bash">m00175</acp>` ref tag the model cites inside compress calls.
- **Model-driven compression** — the model writes the summaries; the engine decides *when* to compress, *what range*, and tracks all state.
- **3-tier LSM compression** — tier-1 summaries distill into tier-2, then tier-3, as the session grows.
- **Growth-gated nudges** — a nudge is injected into context only when usage crosses a threshold *and* context has grown, so it never fires spuriously.
- **Emergency truncation** — last-resort truncation of runaway tool outputs above the emergency threshold.
- **Decompress + search** — restore a compressed block on demand, or keyword-search all summaries without decompressing.
- **`/compact` interception** — Pi's native compaction is replaced by an ACP model-summarized compaction.

## Install

```bash
pi install billion-context-omp
```

Restart Pi. The extension auto-activates on the next session.

## Config

Config is read from `~/.pi/acp-omp.json` (global) and `<project>/.pi/acp-omp.json` (project-local overrides global):

```jsonc
{
  "debug": false,            // verbose ACP log (default ~/.pi/acp-omp.log)
  "autoUpdate": true,        // auto-install newer versions from npm
  "modelContextLimit": 200000,
  "compress": {
    "maxContextLimit": "75%",        // forced-compression threshold
    "emergencyThresholdPercent": "95%", // emergency truncation threshold
    "nudgeGrowthTokens": 50000
  },
  "compressModel": "openai:gpt-4o", // model used for /compact auto-compression
  "toolBashDefaultTimeout": 60,
  "toolOutputMaxBytes": 200000
}
```

State persists to `~/.pi/agent/sessions/<session>.acp-omp.json`.

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

`billion-context-omp` is a close port of `billion-context-pi`. Both are Pi extensions built on acp-kernel. Differences:

- **Package identity & paths** — `billion-context-omp` uses `~/.pi/acp-omp.json`, `~/.pi/acp-omp.log`, and `<session>.acp-omp.json` state files so it never collides with a co-installed `billion-context-pi`.
- **Delegate subsystem deferred** — omp (oh-my-pi) already provides its own multi-agent orchestration and `delegate-task` tool. To avoid tool conflicts, this port does **not** register the `acp_delegate`/`acp_delegate_wait`/`acp_delegate_cancel` tools or the fleet status widget. Everything else (compression, decompress, search, status, nudges, `/compact` interception, tool guardrails) is identical to the Pi build.

## Build

```bash
npm run build       # tsup bundle (inlines acp-kernel) + tsc --emitDeclarationOnly
npm run typecheck   # tsc --noEmit
npm test            # node --import tsx --test tests/*.test.ts
```

`dist/index.js` is self-contained — acp-kernel is bundled inline (zero runtime deps).

## License

MIT © ranxianglei
