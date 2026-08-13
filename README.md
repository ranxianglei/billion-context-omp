[English](./README.md) | [中文](./README.zh-CN.md)

# billion-context-omp

[oh-my-pi (omp)](https://github.com/can1357/oh-my-pi) client extension for [billion-context](https://www.npmjs.com/package/billion-context).

`billion-context` is a Node.js proxy that sits between any AI agent and its model API, rewriting Anthropic/OpenAI streams with [acp-kernel](https://github.com/ranxianglei/acp-kernel) compression. `billion-context-omp` wires **omp** — the terminal coding agent — into that pipeline: it builds the `base_url` override that routes omp's traffic through a running `billion-context` proxy, and **self-disables when it detects omp is already behind bili** so two layers of compression never stack.

> ⚠️ This is a **skeleton** package. The config-building helpers are placeholders.
> Wire them to omp's actual provider/`base_url` config shape as you build it out.

## Why

Long coding sessions blow up context. Once you pass the context window the session degrades or dies, and every provider charges per token. Compression lets a single session run for days — billions of tokens through one window.

omp already supports arbitrary providers and custom `base_url`. This package is the thin glue that points those `base_url`s at a bili proxy and keeps the `/bili/` self-detection signal consistent with the rest of the billion-context client family (`billion-context-pi`, `opencode-acp`, …).

## Install

```bash
npm install billion-context-omp
```

## Quickstart

```ts
import { BillionContextOmp } from 'billion-context-omp';

const omp = new BillionContextOmp({ endpoint: 'http://localhost:8787' });

// Route a provider through bili:
omp.buildBaseUrl('https://api.openai.com/v1');
// => 'http://localhost:8787/bili/https://api.openai.com/v1'

// Detect an already-routed URL (use to self-disable / avoid double compression):
omp.isBiliBaseUrl('http://localhost:8787/bili/https://api.openai.com/v1'); // => true
```

## API

### `new BillionContextOmp(options?)`

| option     | type     | description                              |
| ---------- | -------- | ---------------------------------------- |
| `endpoint` | `string` | Origin of a running billion-context proxy. |

### `omp.buildBaseUrl(upstream): string`

Wrap an upstream `base_url` as `${endpoint}/bili/${upstream}`. Throws if no endpoint is configured. Passes through unchanged if already routed.

### `omp.isBiliBaseUrl(baseUrl): boolean`

True when the URL already carries the `/bili/` prefix — use this to self-disable when omp's `base_url` is already pointing at bili.

### `omp.buildConfig(providers): Record<provider, { base_url }>`

Build base_url overrides for multiple omp providers at once. _(Skeleton.)_

## License

MIT © [ranxianglei](https://github.com/ranxianglei)
