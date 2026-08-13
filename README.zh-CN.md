[English](./README.md) | [中文](./README.zh-CN.md)

# billion-context-omp

基于 [acp-kernel](https://github.com/ranxianglei/acp-kernel) 的、模型驱动的上下文管理，面向 [omp (oh-my-pi)](https://github.com/can1357/oh-my-pi) 编码代理。

[omp](https://omp.sh) 是 [Pi 编码代理](https://github.com/nickthecook/pi) 的硬分叉（包名重新归为 `@oh-my-pi/*`）。`billion-context-omp` 直接对接 omp 原生扩展 API，把 acp-kernel 的压缩管线接入其中——提供多层、模型驱动的上下文压缩，零运行时依赖。

> **不是** `billion-context-pi` 的直接复制。omp 的扩展 API 与标准 Pi 有差异（arktype schema、`string[]` 系统提示词、不同的消息/工具形状、`~/.omp` 配置目录），因此本移植直接对接 omp，而非依赖 omp 的 legacy-Pi 兼容层。

## 功能

- **消息 ref 标签** —— 每条消息获得 `` ref 标签，模型在 compress 调用中引用。
- **模型驱动压缩** —— 摘要由模型撰写；引擎决定*何时*压缩、*压缩哪段*，并跟踪全部状态。
- **3 层 LSM 压缩** —— 随会话增长，tier-1 摘要蒸馏为 tier-2，再到 tier-3。
- **增长门控提醒** —— 仅当使用率越过阈值*且*上下文有增长时才注入提醒，不会误触发。
- **紧急截断** —— 超过紧急阈值时对失控的工具输出做最后手段的截断。
- **解压 + 搜索** —— 按需恢复压缩块，或关键字搜索全部摘要而无需解压。
- **拦截 `/compact`** —— 用 ACP 模型摘要式压缩替换 omp 原生 compaction。

## 安装

omp 通过 `extensions:` 设置项（用户级 `~/.omp/agent/settings.json` 或项目级 `.omp/settings.json`）、`omp:` manifest key 或 `--trusted-extension` 标志加载扩展。

从 npm 安装：

```bash
omp install billion-context-omp
```

或加入 omp 设置：

```jsonc
{
  "extensions": ["billion-context-omp"]
}
```

重启 omp，扩展在下次会话自动激活。

## 配置

从 `~/.omp/acp-omp.json`（全局）与 `<项目>/.omp/acp-omp.json`（项目级覆盖全局）读取：

```jsonc
{
  "debug": false,            // 详细 ACP 日志（默认 ~/.omp/acp-omp.log）
  "autoUpdate": true,        // 自动从 npm 安装更新版本
  "modelContextLimit": 200000,
  "compress": {
    "maxContextLimit": "75%",        // 强制压缩阈值
    "emergencyThresholdPercent": "95%", // 紧急截断阈值
    "nudgeGrowthTokens": 50000
  },
  "compressModel": "zhipuai:glm-5.2", // /compact 自动压缩所用模型
  "toolBashDefaultTimeout": 60,
  "toolOutputMaxBytes": 200000
}
```

状态持久化到 `~/.omp/agent/sessions/<session>.acp-omp.json`。

## 工具与命令

| 工具 | 用途 |
|------|------|
| `compress` | 用你撰写的摘要替换一段对话 |
| `decompress` | 恢复压缩块（默认写文件；`inline:true` 内联返回） |
| `search_context` | 关键字搜索压缩摘要 |
| `acp_status` | 上下文用量、分解、可压缩区间、块 |

| 命令 | 用途 |
|------|------|
| `/acp` | 上下文用量 + token 分解 + 压缩状态 |
| `/acp-status` | 同 `/acp` |
| `/acp-decompress <id>` | 内联恢复某块内容 |
| `/acp-search <query>` | 搜索压缩块 |

## 与 billion-context-pi 的关系

`billion-context-omp` 是 [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi) 的紧密移植。两者都是 acp-kernel 适配器。差异：

- **面向 omp 而非 Pi** —— 从 `@oh-my-pi/pi-coding-agent`（omp 分叉）导入类型，使用 omp 的 arktype schema（`@oh-my-pi/omptype`），配置目录取自 `@oh-my-pi/pi-utils`（`CONFIG_DIR_NAME` = `.omp`），故所有路径都落在 `~/.omp/` 下。
- **包标识与路径** —— 使用 `~/.omp/acp-omp.json`、`~/.omp/acp-omp.log` 和 `<session>.acp-omp.json` 状态文件，不会与任何其他东西冲突。
- **延迟 delegate 子系统** —— omp 已自带多代理编排。为避免工具冲突，本移植**不**注册 `acp_delegate`/`acp_delegate_wait`/`acp_delegate_cancel` 工具及 fleet 状态组件。其余（压缩、解压、搜索、状态、提醒、`/compact` 拦截、工具护栏）与 Pi 版本完全一致。

## 构建

```bash
npm run build       # tsup 打包（内联 acp-kernel）+ tsc --emitDeclarationOnly
npm run typecheck   # tsc --noEmit
npm test            # bun test tests/*.test.ts
```

`dist/index.js` 自包含——acp-kernel 被内联打包（零运行时依赖）。

> 测试在 [Bun](https://bun.sh) 下运行（omp 宿主包会 import Bun 运行时）。请先安装 Bun：`curl -fsSL https://bun.sh/install | sh`。

## 许可证

MIT © ranxianglei
