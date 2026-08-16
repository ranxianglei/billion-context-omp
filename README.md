# billion-context-omp

[English](./README.md) | [中文](./README.zh-CN.md)

<p align="center">
<strong>Billion-Context</strong> for <a href="https://github.com/can1357/oh-my-pi">omp (oh-my-pi)</a>
<br />
The model decides <em>when</em> and <em>what</em> to compress — not a hard limit.
</p>

---

<p align="center">
<a href="https://www.npmjs.com/package/billion-context-omp"><img src="https://img.shields.io/npm/v/billion-context-omp.svg?style=flat-square" alt="npm"></a>
<a href="https://github.com/ranxianglei/billion-context-omp/blob/master/LICENSE"><img src="https://img.shields.io/npm/l/billion-context-omp.svg?style=flat-square" alt="license"></a>
<a href="https://github.com/ranxianglei/billion-context-omp"><img src="https://img.shields.io/badge/GitHub-ranxianglei%2Fbillion--context--omp-181717?style=flat-square&logo=github" alt="GitHub"></a>
</p>

<p align="center">
<code>omp install billion-context-omp</code>
</p>

---

## Why?

When conversations get long, the model runs out of context. Most tools hard-truncate — silently dropping earlier messages. **billion-context** gives the model a `compress` tool: the LLM decides **when** and **what** to compress into high-fidelity summaries, preserving critical details (file paths, decisions, error strings) while reclaiming context space.

Unlike omp's built-in auto-compaction (which replaces everything with a single summary), billion-context:
- **Preserves structure** — compressed ranges become labeled blocks you can decompress later
- **Multi-tier** — summaries can be further distilled (T1 → T2 → T3) as sessions grow
- **Searchable** — `search_context` finds information inside compressed blocks without decompressing
- **Selective** — protected tools, user messages, and the recent working set are never compressed

This means:

1. **A single session handles enormous workloads.** Per simulation tests of the three-tier architecture (see [opencode-acp](https://github.com/ranxianglei/opencode-acp)), one session can process on the order of 10–60 billion cumulative tokens — while retaining long-term memory of distant key information (paths, decisions, signatures). You can work in the **same session for months** without outgrowing the context.
2. **Context stays lean over the long run.** In practice context typically holds under ~150K tokens (opencode-acp keeps it under ~200K), so compared to traditional compaction that lets context balloon toward 1M, **a single session costs roughly 5× less in tokens**.

## Install

```bash
omp install billion-context-omp
```

That's it. The extension auto-loads on next omp startup. No configuration needed — it reads your model's context window automatically.

Or add it to your omp settings (`~/.omp/agent/settings.json` or project `.omp/settings.json`):

```jsonc
{
  "extensions": ["billion-context-omp"]
}
```

## How it works

billion-context intercepts omp's `context` event (fired before each LLM call) and runs the acp-kernel pipeline:

```
assign refs → fold in-stream compress calls → prune → nudge → emergency truncate
```

Each message gets an invisible `<acp>` ref tag (`m00001`, `m00002`, ...) visible to the model but not the user. The model uses these refs to specify compression ranges.

**The session stream is the single source of truth.** Compress calls live in the stream itself: every compress tool call's arguments (ranges + summaries) are re-applied deterministically on each LLM call, on restart, and on resume — no sidecar state file to drift out of sync. Position ids (`p1..pN`) and model-facing refs (`m00001..`) are re-derived from the stream every turn; prefix rewrites (retry, rewind, host compaction) are detected and safely re-folded, with fingerprint guards against replaying a call onto the wrong messages.

omp's built-in `/compact` is **the host's feature** — it runs natively (user-initiated, between turns). ACP does not intercept it. Compression itself is the model's decision via the compress tool. If you want ACP to be the *only* compression authority, set `"compaction": { "enabled": false }` in omp settings to disable the host's auto-compact (the 80% threshold trigger); manual `/compact` still works whenever you want it.

## Plugin compatibility

**Keep exactly one context-compression plugin installed.** If two compression extensions both rewrite the message list, they clobber each other's work — compressed ranges can be re-expanded or corrupted. Any *third-party* compression/compaction extension should be uninstalled.

## Model-facing tools

| Tool | What it does |
|------|-------------|
| `compress` | Replace a contiguous message range with a detailed summary |
| `decompress` | Restore a previously compressed block's content (to file by default; `inline:true` for single messages) |
| `search_context` | Search compressed block summaries and the original messages folded into them by keyword (visible messages are not indexed) |
| `acp_status` | Show context usage, compressed blocks, compressible ranges |

> The `acp_delegate` sub-agent subsystem from the Pi build is intentionally **not** registered — omp ships its own multi-agent orchestration, and duplicate delegation tools would conflict.

## `/acp` command

Rich status display for the user:

```
╭─────────────────────────────────────────────╮
│           ACP Context Analysis              │
╰─────────────────────────────────────────────╯
 billion-context-omp@0.1.7

 Context (session accounting, host footer scale): 9% (93k / 1.0M) — never shrinks; includes compressed originals

 Sent to LLM (after compression, est.): 63k (6% of limit)
 Session-only (compressed originals, est.): 110k — pruned from every request; the footer/nudge still count them

 Token Breakdown (sent view):
   Tool       ██████████████████░░  88%  55k
   SysPrompt  ██░░░░░░░░░░░░░░░░░   9%  5.9k
   Text       ░░░░░░░░░░░░░░░░░░░░   1%  553
   Summaries  ░░░░░░░░░░░░░░░░░░░░   2%  1.5k

 Nudge: idle — growth 0 < floor 20000, ready: T1 50394

 Blocks: 1 active / 1 total (112k tokens compressed)
   [b1] T1 112k→1.5k: PR141 review + follow-up fixes
 Tag visibility: tags injected to LLM only (deep copy), not persisted in session, not shown in terminal.
```

## Configuration

billion-context-omp works out of the box with no configuration. Optional keys can be set in a JSON config file.

### Config file

Create `~/.omp/acp-omp.json` (global) and/or `<project>/.omp/acp-omp.json` (project-local, overrides global):

```json
{
  "debug": false,
  "autoUpdate": true,
  "modelContextLimit": 200000,
  "toolBashDefaultTimeout": 60,
  "toolOutputMaxBytes": 200000,
  "compress": {
    "maxContextLimit": "75%",
    "emergencyThresholdPercent": "95%",
    "nudgeGrowthTokens": 50000
  },

  "prompts": {
    "compressPhilosophy": "Override the compression philosophy...",
    "howToCompressRules": "Override tier-1 rules...",
    "tier2DistillRules": "Override tier-2 distillation rules...",
    "tier3CondenseRules": "Override tier-3 condensation rules..."
  },
  "acknowledgePromptsRisk": true
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `debug` | `false` | Enable verbose **debug-level** events in the log. The always-on log (lifecycle events, errors, warnings) is written regardless; `debug` only adds extra diagnostics. Also enabled by env `ACP_DEBUG=1`. |
| `transformMode` | `"provider"` (default since v0.2.6) or `"context"` — where the compression surgery intercepts. `provider` transforms the provider wire payload (request-local, structurally immune to feedback re-entry). `context` is the legacy rewrite-in-place mode. |
| `autoUpdate` | `true` | On session start (throttled to one check per 3 minutes), check npm for a newer version and auto-install it. Disable to avoid all startup network calls. |
| `modelContextLimit` | *(auto)* | Override the context limit (in tokens). Defaults to the model's `contextWindow`. |
| `toolBashDefaultTimeout` | `60` | Seconds injected into the `bash` tool when the model omits `timeout`. Without this a forgotten timeout can hang for thousands of seconds. `0` restores unbounded behavior. |
| `toolOutputMaxBytes` | `200000` | Hard byte cap on tool result text (applied via the `tool_result` hook). Stops runaway output that omp's own caps can't catch. When it fires the model is told where the full output lives; set lower (e.g. `8192`) for a tighter context budget, or `0` to disable. |
| `compress.maxContextLimit` | `"75%"` | Context usage threshold that triggers **forced compression** nudges (bypasses growth-gate + cadence). Accepts a ratio (`0.75`) or percent string (`"75%"`). Lower = compress earlier / more aggressively. |
| `compress.emergencyThresholdPercent` | `"95%"` | Context usage threshold that triggers **emergency truncation** of large tool outputs to keep the session alive. Must be ≥ `maxContextLimit`. |
| `compress.nudgeGrowthTokens` | `50000` | Token growth step for soft compression nudges. A nudge fires roughly every time this many tokens become compressible; if the model ignores it, it re-fires after the same amount of further growth. Lower = compress more often. |
| `prompts` | *(kernel defaults)* | Override acp-kernel's 4 load-bearing compression prompt rules (`compressPhilosophy`, `howToCompressRules`, `tier2DistillRules`, `tier3CondenseRules`). Each set field replaces the default verbatim; omitted fields are inherited. Requires `acknowledgePromptsRisk: true`. |
| `acknowledgePromptsRisk` | `false` | Safety gate for `prompts` overrides. Set `true` to acknowledge that replacing the tuned compression rules may reduce summary quality, and to make overrides take effect. |

The three nudge thresholds (`maxContextLimit`, `emergencyThresholdPercent`, `nudgeGrowthTokens`) form a three-tier escalation: growth-driven soft nudges → forced nudges at `maxContextLimit` → emergency truncation at `emergencyThresholdPercent`.

### Environment variables

| Variable | Effect |
|----------|--------|
| `ACP_AUTO_UPDATE` | Set to `0` / `false` / `no` / `off` (case-insensitive) to disable auto-update, overriding the config. |
| `ACP_MODEL_CONTEXT_LIMIT` | Override the context limit. Takes precedence over the config value. |
| `ACP_DEBUG` | Set to `1` or `true` to enable debug-level logging (always-on events are written regardless). |
| `ACP_LOG_FILE` | Override the log file path (default `~/.omp/acp-omp.log`). |

### Logging

billion-context-omp writes a structured, always-on log to `~/.omp/acp-omp.log` (override with `ACP_LOG_FILE`). It covers the model's whole working session and is useful for diagnosing problems:

- **Always written** (even with `debug: false`): `error`, `warn`, `info` levels — session start, every context turn (token usage / nudge decision), compress/decompress, and **all errors and warnings**. Error lines include the message and stack trace.
- **Written only when `debug: true`**: verbose `debug`-level diagnostics (full field dumps, per-turn internals, fold/replay events).

Each line: `<ISO timestamp> [<level>] [<scope>] key=value key=value`. The file rotates to `~/.omp/acp-omp.log.old` at 10 MB.

```sh
tail -f ~/.omp/acp-omp.log                 # watch the session live
grep '\[error\]' ~/.omp/acp-omp.log        # surface every recorded failure
```

### Compression philosophy

The model receives detailed guidance (in its system prompt) on **when** to compress, **what** to keep verbatim (paths, signatures, errors, decisions, user intent), and **what** to drop (verbose logs, duplicates, consumed exploration). This guidance is injected on every turn so it stays in the model's attention.

### What gets protected

billion-context protects three categories of content from compression:

1. **Always-protected tools** — `compress` calls are hard-protected (they're load-bearing metadata; compressing them breaks decompress and the "summary is historical" contract).
2. **Soft recent-zone** — the last N messages (default 5) and last ~5K tokens are soft-protected so the model keeps its working set. Tool results from `decompress`, `search_context`, `read`, and `bash` are **excluded** from this zone: they're large and meant to be compressible once consumed.
3. **Last user message** — always protected (user intent must survive).

## Built on acp-kernel

The compression engine is [`acp-kernel`](https://github.com/ranxianglei/acp-kernel) — a platform-agnostic, MIT-licensed library. It's bundled inline into `dist/index.js`, so there are zero runtime dependencies.

## License

MIT © ranxianglei
test
