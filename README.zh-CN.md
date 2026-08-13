[English](./README.md) | [中文](./README.zh-CN.md)

# billion-context-omp

基于 [acp-kernel](https://github.com/ranxianglei/acp-kernel) 的、模型驱动的上下文管理，面向 [oh-my-pi (omp)](https://github.com/acidsugarx/oh-my-pi) 编码代理。

omp 是运行在 [Pi CLI 编码代理](https://github.com/nickthecook/pi) **之上**的增强框架。`billion-context-omp` 是一个 Pi 扩展（与 [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi) 一样），把 acp-kernel 的压缩管线接入 omp 的 Pi 运行时——提供多层、模型驱动的上下文压缩，零运行时依赖。

## 功能

- **消息 ref 标签** —— 每条消息获得 `<acp tokens="2.1K" type="bash">m00175</acp>` ref 标签，模型在 compress 调用中引用。
- **模型驱动压缩** —— 摘要由模型撰写；引擎决定*何时*压缩、*压缩哪段*，并跟踪全部状态。
- **3 层 LSM 压缩** —— 随会话增长，tier-1 摘要蒸馏为 tier-2，再到 tier-3。
- **增长门控提醒** —— 仅当使用率越过阈值*且*上下文有增长时才注入提醒，不会误触发。
- **紧急截断** —— 超过紧急阈值时对失控的工具输出做最后手段的截断。
- **解压 + 搜索** —— 按需恢复压缩块，或关键字搜索全部摘要而无需解压。
- **拦截 `/compact`** —— 用 ACP 模型摘要式压缩替换 Pi 原生 compaction。

## 安装

```bash
pi install billion-context-omp
```

重启 Pi，扩展在下次会话自动激活。

## 配置

从 `~/.pi/acp-omp.json`（全局）与 `<项目>/.pi/acp-omp.json`（项目级覆盖全局）读取：

```jsonc
{
  "debug": false,
  "autoUpdate": true,
  "modelContextLimit": 200000,
  "compress": {
    "maxContextLimit": "75%",
    "emergencyThresholdPercent": "95%",
    "nudgeGrowthTokens": 50000
  },
  "compressModel": "openai:gpt-4o",
  "toolBashDefaultTimeout": 60,
  "toolOutputMaxBytes": 200000
}
```

状态持久化到 `~/.pi/agent/sessions/<session>.acp-omp.json`。

## 与 billion-context-pi 的关系

`billion-context-omp` 是 `billion-context-pi` 的紧密移植。两者都是基于 acp-kernel 的 Pi 扩展。差异：

- **包标识与路径** —— 使用 `~/.pi/acp-omp.json`、`~/.pi/acp-omp.log` 和 `<session>.acp-omp.json` 状态文件，避免与共存的 `billion-context-pi` 冲突。
- **延迟 delegate 子系统** —— omp（oh-my-pi）已自带多代理编排与 `delegate-task` 工具。为避免工具冲突，本移植**不**注册 `acp_delegate`/`acp_delegate_wait`/`acp_delegate_cancel` 工具及 fleet 状态组件。其余（压缩、解压、搜索、状态、提醒、`/compact` 拦截、工具护栏）与 Pi 版本完全一致。

## 构建

```bash
npm run build       # tsup 打包（内联 acp-kernel）+ tsc --emitDeclarationOnly
npm run typecheck   # tsc --noEmit
npm test            # node --import tsx --test tests/*.test.ts
```

`dist/index.js` 自包含——acp-kernel 被内联打包（零运行时依赖）。

## 许可证

MIT © ranxianglei
