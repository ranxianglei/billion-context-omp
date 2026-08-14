# billion-context-omp 会话交接文档

> 生成时间: 2026-08-14
> 会话目标: 修复 omp 下 ACP 上下文管理问题（live-* refs 导致压缩块失活、上下文膨胀、cache miss）

---

## 一、已完成的主要工作

### 1. 删除 mergeLiveEntries 机制 (commit 3d45653, +46 −866 行, 8 文件)

**根因:** omp 在 `event.messages` 里注入 `<system-reminder>`（todo nudge、TTSR 规则），这些消息不在 `getBranch()` 里。`findUniqueLongestRun` 需要连续匹配 → 注入点之后的位移导致 283 条消息拿不到稳定 ID → 每轮分配新 `live-N` → `assignRefs` 映射到不同 `mNNNNN` → block `effectiveMessageIds` 失配 → block 被错误停用 → 压缩消息重现 → 上下文膨胀 + cache miss。

**删除内容:**
- `runtime.ts` (284→97 行): mergeLiveEntries 及全部 12 个辅助函数（dumpInputMessages, nextLiveId, migrateTaggedRef, migrateLiveRefs, normalizePersistedMatchKeys, toolResultStructureKey, valueInRange, sameToolResult, sameNonTextBlocks, isPiHost, AgentMessage type, lastEntries cache）
- `state.ts` (168→132): LiveRefOrigin interface, getLiveRefOrigins/setLiveRefOrigins, parseLiveRefOrigins。save() 现在写 `JSON.stringify(state)` 不再带 liveRefOrigins
- `sequence-match.ts`: 整个文件删除（findUniqueLongestRun + MatchRange type）
- `messages.ts`: 删除 messageRef（删除后无调用方）
- `index.ts:161`: stateFor(ctx) 调用去掉 event.messages 参数

**新流程:** `getBranch()` → `buildContextEntries()` → `entriesToCoreMessages` → `pruneOrphanRefs` → `assignRefs`。`getBranch()` 提供稳定持久化 ID，不再需要 live→persisted 匹配。

**测试:** typecheck 通过, 178 tests 全绿, build 成功 (180.86 KB)

### 2. IDENTITY_KEYS 白名单修复 (commit 471d785)

`messages.ts` 的 `messageIdentity` 函数增加 `IDENTITY_KEYS` 白名单：只比较 `{ role, attribution }`，忽略 omp 注入的 `usage`/`stopReason`/`provider`/`api` 等元数据字段，避免相同消息因元数据不同而被视为不同。

### 3. omp 配置调优

- `~/.omp/agent/config.yml`: modelRoles default → `zhipuai-lb/glm-5.2`, statusLine 显示 cache_hit + context_pct
- `~/.omp/acp-omp.json`: compress.nudgeGrowthTokens → 20000

---

## 二、核心架构知识（重要记忆）

### ACP 标签机制
- **注入位置:** `messages.ts:287-334` 的 `patchRefTag`，在 omp `context` event 里对 user/tool 消息追加 `<acp tokens="X" type="Y">mNNNNN</acp>` 到文本末尾
- **Assistant 消息跳过:** `messages.ts:295`，防止模型 echo XML 标签
- **标签不入 session log:** 标签是运行时注入，持久化的 session JSONL 不含 `<acp>` 标签
- **hex 转义:** 源码中 `<acp`/`</acp>` 写为 `\x3cacp`/`\x3c/acp\x3e`，避免 Write/Edit 工具剥离

### omp 与 Pi 的关键差异
- **config 目录:** `.omp` 不是 `.pi`（通过 `@oh-my-pi/pi-utils` 的 `CONFIG_DIR_NAME` 导入）
- **schema:** arktype 不是 TypeBox（`@oh-my-pi/omptype` 的 `Type`）
- **complete 导入:** `@oh-my-pi/pi-ai` 根路径（无 `/compat` 子路径）
- **homeDir():** `src/home.ts`，Bun 的 `os.homedir()` 忽略 HOME/USERPROFILE，需自定义
- **系统消息注入:** omp 在 `event.messages` 里注入 `<system-reminder>`（todo nudge、TTSR），这些不在 `getBranch()` 返回的持久化条目里

### 状态文件结构
- **路径:** `~/.omp/agent/sessions/<project>/<session>.jsonl.acp-omp.json`
- **关键字段:** `blocks[]`（压缩块，`active`/`effectiveMessageIds`）、`messageRefs.byRaw`（raw ID → ref 映射）、`messageRefs.byRef`（ref → raw ID）
- **live-* ID 是旧 bug 残留:** 新代码不再产生。旧 session 恢复后仍可见历史 live-* refs，但不影响新消息

### 压缩块稳定性原理
- block 的 `effectiveMessageIds` 存储的是持久化 entry ID（如 `e2`）
- 如果 ID 不稳定（每轮变化），block 会被错误停用 → 压缩消息重现 → 上下文膨胀
- 修复后: `getBranch()` 直接提供稳定 ID，无需 live→persisted 迁移

---

## 三、待验证 / 待办

### 烟雾测试（需新 session）
- [ ] 重启 omp 到**新 session**（不是恢复旧 session）
- [ ] 多轮对话后检查 `~/.omp/agent/sessions/.../*.acp-omp.json`:
  - 新消息不应产生 `live-*` refs
  - 压缩块应保持 `active: true`
  - cache hit 应保持高位
- [ ] 验证 ACP 标签出现在每条 user/tool 消息上

### 已知遗留
- 旧 session 的 719 个 live-* refs 是历史残留，不影响新 session
- delegate 子系统（`acp_delegate*` 工具）有意未注册——omp 自带多 agent 编排
- `nudge` 机制在旧 session 中可能仍触发误报（旧 live-* refs 导致），新 session 正常

---

## 四、关键文件路径速查

| 文件 | 作用 |
|---|---|
| `src/runtime.ts` | AcpRuntime: 状态存储、锁、stateFor() |
| `src/messages.ts` | omp↔kernel 消息转换、patchRefTag 标签注入 |
| `src/state.ts` | 状态持久化 (~/.omp/agent/sessions/*.acp-omp.json) |
| `src/index.ts` | 扩展入口: 注册 hooks、tools、commands |
| `src/search-index.ts` | 从 session log + ACP 块构建 SearchDoc[] |
| `src/auto-compress.ts` | /compact 拦截: model-summarized 压缩 |
| `dist/index.js` | tsup 打包产物（内联 acp-kernel，零运行时依赖） |

### omp 配置文件
| 路径 | 作用 |
|---|---|
| `~/.omp/agent/config.yml` | 模型、扩展路径、状态栏 |
| `~/.omp/acp-omp.json` | ACP 全局配置（nudge 阈值等） |

### 构建命令
```bash
npm run build          # tsup bundle + tsc --emitDeclarationOnly
npm run typecheck      # tsc --noEmit
npm test               # bun test tests/*.test.ts
```

---

## 五、Git 状态

- 当前分支有 2 个 commit 未推送:
  - `471d785` — IDENTITY_KEYS whitelist fix
  - `3d45653` — 删除 mergeLiveEntries 机制
- `acp-kernel` 必须精确版本（当前 `0.0.22`），不能加 `^`
- dist/index.js 已重建（2026-08-14 14:56:44）
- 全局 npm link 指向 `/home/dog/projects/billion-context-omp`
