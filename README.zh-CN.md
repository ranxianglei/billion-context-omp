[English](./README.md) | [中文](./README.zh-CN.md)

# billion-context-omp

<p align="center">
面向 <a href="https://github.com/can1357/oh-my-pi">omp (oh-my-pi)</a> 的 <strong>Billion-Context</strong>
<br />
由模型决定<em>何时</em>压缩、<em>压缩什么</em> —— 而不是硬截断。
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

## 为什么？

会话变长后，模型的上下文会耗尽。多数工具采用硬截断——悄悄丢弃早期消息。**billion-context** 给模型一个 `compress` 工具：由 LLM 自己决定**何时**压缩、**压缩什么**，生成高保真摘要，保留关键细节（文件路径、决策、报错原文）的同时回收上下文空间。

与 omp 内置的自动 compaction（把一切都换成一条摘要）不同，billion-context：
- **保留结构** —— 被压缩的区间变成带标签的块，之后可以解压还原
- **多层蒸馏** —— 摘要可随会话增长继续蒸馏（T1 → T2 → T3）
- **可搜索** —— `search_context` 不解压即可在压缩块摘要中检索信息
- **有选择性** —— 受保护工具、用户消息、近期工作集永不被压缩

这意味着：

1. **单个会话可以承载巨大的工作量。** 三层架构的模拟测试（见 [opencode-acp](https://github.com/ranxianglei/opencode-acp)）显示，一个会话可处理 100~600 亿累计 token——同时保持对早期关键信息（路径、决策、签名）的长期记忆。你可以在**同一个会话里工作数月**而不会撑爆上下文。
2. **上下文长期保持精瘦。** 实际运行中上下文通常保持在 ~150K token 以下（opencode-acp 控制在 ~200K 以下）。相比放任上下文膨胀到 1M 的传统 compaction，**单个会话的 token 成本约低 5 倍**。

## 安装

```bash
omp install billion-context-omp
```

就这一步。扩展在下次 omp 启动时自动加载，无需任何配置——它自动读取模型的上下文窗口。

或加入 omp 设置（`~/.omp/agent/settings.json` 或项目级 `.omp/settings.json`）：

```jsonc
{
  "extensions": ["billion-context-omp"]
}
```

## 工作原理

billion-context 拦截 omp 的 `context` 事件（每次 LLM 调用前触发）并运行 acp-kernel 管线：

```
分配 ref → 折叠流内 compress 调用 → 剪枝 → 提醒 → 紧急截断
```

每条消息获得一个模型可见、用户不可见的 `<acp>` ref 标签（`m00001`、`m00002`、...）。模型用这些 ref 指定压缩区间。

**会话流是唯一真相源。** compress 调用本身就存在于流中：每次 compress 工具调用的参数（区间 + 摘要）在每次 LLM 调用、重启、resume 时被确定性重放——没有会漂移失步的独立状态文件。位置 id（`p1..pN`）和面向模型的 ref（`m00001..`）每轮从流重新推导；前缀改写（retry、rewind、宿主 compaction）会被检测并安全重折叠，指纹守卫防止把调用重放到错误的消息上。

omp 内置的 `/compact` 被拦截，替换为 ACP 模型摘要式 compaction，它同时保留之前的 compress 调用摘要——摘要与保留条目之间的空隙不会丢任何东西。

## 插件兼容性

**只安装一个上下文压缩插件。** 若两个压缩扩展都改写消息列表，它们会互相破坏对方的工作——被压缩的区间可能被重新展开或损坏。omp 自己的 `/compact` 已被 billion-context-omp 自动拦截，但任何*第三方*压缩/compaction 扩展都应卸载。

## 面向模型的工具

| 工具 | 作用 |
|------|------|
| `compress` | 把一段连续消息区间替换为详细摘要 |
| `decompress` | 恢复之前压缩的块内容（默认写文件；单条消息可 `inline:true`） |
| `search_context` | 按关键字搜索压缩块摘要及被折叠其中的原始消息（可见消息不建索引） |
| `acp_status` | 显示上下文用量、压缩块、可压缩区间 |

> Pi 版中的 `acp_delegate` 子代理系统在此**有意不注册**——omp 自带多代理编排，重复的委派工具会冲突。

## `/acp` 命令

面向用户的富状态面板：

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

## 配置

billion-context-omp 开箱即用，无需配置。可选键写入 JSON 配置文件。

### 配置文件

创建 `~/.omp/acp-omp.json`（全局）和/或 `<项目>/.omp/acp-omp.json`（项目级覆盖全局）：

```json
{
  "debug": false,
  "autoUpdate": true,
  "modelContextLimit": 200000,
  "compressModel": "zhipuai:glm-5.2",
  "toolBashDefaultTimeout": 60,
  "toolOutputMaxBytes": 200000,
  "compress": {
    "maxContextLimit": "75%",
    "emergencyThresholdPercent": "95%",
    "nudgeGrowthTokens": 50000
  },

  "prompts": {
    "compressPhilosophy": "覆盖压缩哲学...",
    "howToCompressRules": "覆盖 tier-1 规则...",
    "tier2DistillRules": "覆盖 tier-2 蒸馏规则...",
    "tier3CondenseRules": "覆盖 tier-3 凝缩规则..."
  },
  "acknowledgePromptsRisk": true
}
```

| 键 | 默认 | 说明 |
|-----|------|------|
| `debug` | `false` | 开启**debug 级**详细日志事件。常开日志（生命周期事件、错误、警告）无论如何都会写；`debug` 只增加诊断信息。也可用环境变量 `ACP_DEBUG=1` 开启。 |
| `autoUpdate` | `true` | 会话启动时（节流为每 3 分钟最多一次）检查 npm 是否有新版本并自动安装。关闭可避免所有启动期网络请求。 |
| `modelContextLimit` | *(自动)* | 覆盖上下文上限（token 数）。默认取模型的 `contextWindow`。 |
| `compressModel` | *(会话模型)* | `/compact` 模型摘要式压缩使用的 `provider:modelId`（如 `"zhipuai:glm-5.2"`）。缺省用当前会话模型。 |
| `toolBashDefaultTimeout` | `60` | 模型省略 `timeout` 时注入 `bash` 工具的秒数。没有它，一次忘记的 timeout 可能挂起数千秒。`0` 恢复无限制。 |
| `toolOutputMaxBytes` | `200000` | 工具结果文本的硬字节上限（经 `tool_result` 钩子实施）。拦截 omp 自身上限管不住的失控输出。触发时模型会被告知完整输出在哪；调低（如 `8192`）可更省上下文，`0` 禁用。 |
| `compress.maxContextLimit` | `"75%"` | 触发**强制压缩**提醒的上下文用量阈值（绕过增长门控与节拍）。接受比例（`0.75`）或百分比字符串（`"75%"`）。越低 = 越早/越激进压缩。 |
| `compress.emergencyThresholdPercent` | `"95%"` | 触发**紧急截断**（截断失控工具输出以保住会话）的上下文用量阈值。必须 ≥ `maxContextLimit`。 |
| `compress.nudgeGrowthTokens` | `50000` | 软压缩提醒的 token 增长步长。每积累约这么多可压缩 token 就提醒一次；模型无视则再增长同等数量后重新提醒。越低 = 越常压缩。 |
| `prompts` | *(kernel 默认)* | 覆盖 acp-kernel 的 4 条承重压缩提示规则（`compressPhilosophy`、`howToCompressRules`、`tier2DistillRules`、`tier3CondenseRules`）。每个设置的字段逐字替换默认值；未设置的字段继承默认。需要 `acknowledgePromptsRisk: true`。 |
| `acknowledgePromptsRisk` | `false` | `prompts` 覆盖的安全门。设 `true` 表示知悉替换调优过的压缩规则可能降低摘要质量，并使覆盖生效。 |

三个提醒阈值（`maxContextLimit`、`emergencyThresholdPercent`、`nudgeGrowthTokens`）构成三级升级：增长驱动的软提醒 → `maxContextLimit` 处的强制提醒 → `emergencyThresholdPercent` 处的紧急截断。

### 环境变量

| 变量 | 效果 |
|------|------|
| `ACP_AUTO_UPDATE` | 设为 `0` / `false` / `no` / `off`（不区分大小写）禁用自动更新，覆盖配置。 |
| `ACP_MODEL_CONTEXT_LIMIT` | 覆盖上下文上限。优先于配置值。 |
| `ACP_DEBUG` | 设为 `1` 或 `true` 开启 debug 级日志（常开事件无论如何都写）。 |
| `ACP_LOG_FILE` | 覆盖日志文件路径（默认 `~/.omp/acp-omp.log`）。 |

### 日志

billion-context-omp 向 `~/.omp/acp-omp.log`（可用 `ACP_LOG_FILE` 覆盖）写入结构化的常开日志，覆盖模型整个工作会话，适合诊断问题：

- **始终写入**（即使 `debug: false`）：`error`、`warn`、`info` 级——会话启动、每个 context 轮次（token 用量/提醒决策）、压缩/解压，以及**全部错误和警告**。错误行含消息与堆栈。
- **仅在 `debug: true` 时写入**：冗长的 `debug` 级诊断（完整字段转储、每轮内部状态、折叠/重放事件）。

每行格式：`<ISO 时间戳> [<级别>] [<作用域>] key=value key=value`。文件在 10 MB 时轮转为 `~/.omp/acp-omp.log.old`。

```sh
tail -f ~/.omp/acp-omp.log                 # 实时观察会话
grep '\[error\]' ~/.omp/acp-omp.log        # 列出所有已记录的失败
```

### 压缩哲学

模型（在其系统提示中）收到详细指引：**何时**压缩、**什么**必须逐字保留（路径、签名、报错、决策、用户意图）、**什么**该丢弃（冗长日志、重复内容、已消费的探索）。该指引每轮注入，保持在模型注意力内。

### 受保护的内容

billion-context 保护三类内容不被压缩：

1. **永久保护的工具** —— `compress` 调用被硬保护（它们是承重元数据；压缩它们会破坏 decompress 与"摘要属于历史"的契约）。
2. **软性近期区** —— 最后 N 条消息（默认 5 条）与最后约 5K token 被软保护，模型保持工作集。`decompress`、`search_context`、`read`、`bash` 的工具结果**排除**在该区之外：它们体量大、消费后本就该可压缩。
3. **最后一条用户消息** —— 永久保护（用户意图必须存活）。

## 基于 acp-kernel

压缩引擎是 [`acp-kernel`](https://github.com/ranxianglei/acp-kernel)——平台无关的 MIT 库。它被内联打包进 `dist/index.js`，因此零运行时依赖。

## 许可

MIT © ranxianglei
