[English](./README.md) | [中文](./README.zh-CN.md)

# billion-context-omp

[oh-my-pi (omp)](https://github.com/can1357/oh-my-pi) 的 [billion-context](https://www.npmjs.com/package/billion-context) 客户端扩展。

`billion-context` 是一个 Node.js 代理,架在任意 AI 助手与其模型 API 之间,用 [acp-kernel](https://github.com/ranxianglei/acp-kernel) 压缩重写 Anthropic/OpenAI 流。`billion-context-omp` 把 **omp** —— 终端编程助手 —— 接入这条链路:它生成 `base_url` 覆盖,把 omp 的流量路由到运行中的 `billion-context` 代理,并在**检测到 omp 已经位于 bili 之后时自动停用**,避免两层压缩叠加。

> ⚠️ 这是一个**骨架**包,配置构建辅助函数目前是占位实现。
> 请按 omp 实际的 provider / `base_url` 配置形态对接后再行扩展。

## 为什么

长编程会话会把上下文撑爆。一旦超过上下文窗口,会话质量下降甚至崩掉,而各家 provider 按 token 计费。压缩能让**一个会话连跑数天** —— 海量 token 穿过同一个窗口。

omp 本就支持任意 provider 和自定义 `base_url`。本包提供薄薄一层胶水,把这些 `base_url` 指向 bili 代理,并保持 `/bili/` 自检信号与 billion-context 客户端家族(`billion-context-pi`、`opencode-acp` 等)一致。

## 安装

```bash
npm install billion-context-omp
```

## 快速开始

```ts
import { BillionContextOmp } from 'billion-context-omp';

const omp = new BillionContextOmp({ endpoint: 'http://localhost:8787' });

// 让某个 provider 走 bili:
omp.buildBaseUrl('https://api.openai.com/v1');
// => 'http://localhost:8787/bili/https://api.openai.com/v1'

// 检测已路由的 URL(用于自我停用 / 避免双重压缩):
omp.isBiliBaseUrl('http://localhost:8787/bili/https://api.openai.com/v1'); // => true
```

## API

### `new BillionContextOmp(options?)`

| 选项       | 类型     | 说明                              |
| ---------- | -------- | --------------------------------- |
| `endpoint` | `string` | 运行中的 billion-context 代理地址。 |

### `omp.buildBaseUrl(upstream): string`

把上游 `base_url` 包成 `${endpoint}/bili/${upstream}`。未配置 endpoint 时抛错。若已是路由过的 URL 则原样返回。

### `omp.isBiliBaseUrl(baseUrl): boolean`

URL 含 `/bili/` 前缀时返回 true —— omp 的 `base_url` 已指向 bili 时用此方法自我停用。

### `omp.buildConfig(providers): Record<provider, { base_url }>`

一次性为多个 omp provider 生成 base_url 覆盖。_(骨架。)_

## License

MIT © [ranxianglei](https://github.com/ranxianglei)
