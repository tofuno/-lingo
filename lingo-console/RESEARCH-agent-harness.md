# 桌面宠物 Agent 开源生态调研

> 调研时间：2026-10-11
> 目的：为 Lingo 桌宠接入真实 API / Agent 能力做参考

---

## 一、DeepSeek Harness（`dsh`）

**你要的「DeepSeek harness」就是这个。**

| 项 | 值 |
|---|---|
| 仓库 | `github.com/deepseek-ai/deepseek-harness` |
| 发布 | 2026-08-13（Developer Preview） |
| 协议 | MIT |
| 星标 | ~203k（两周冲到第一，一度超过 OpenCode） |
| 技术栈 | Node.js / TypeScript |
| 跑法 | `npx @deepseek-ai/dsh web` 或 Desktop 版 |

### 核心理念：Everything is a plugin
基于 **Cordis** 框架（北大 + DeepSeek 论文《A Programming Paradigm for Spatiotemporal Composability》），两条性质：

- **时间可组合（temporal composability）**：组件被移除时，副作用**完全回滚**
- **空间可组合（spatial composability）**：组件声明并响应式管理彼此依赖

可替换的插件维度：**模型适配器 / 工具注册表 / 技能 / 会话 / 沙箱 / 文件系统 / agent loop 本身 / 编排 / UI**。

### 值得借鉴
1. **插件化一切** —— 含 agent loop 本身（我们可先做「模型适配器插件化」）
2. **Trajectory 视图** —— 完整日志 / payload / 结果 / 耗时，可回放
3. **不隐藏思维链** —— 可审视、可干预
4. **能把 Claude Code / Codex 当子 agent 调用**

---

## 二、桌宠 Agent（Clawd 系）

### 主线：Clawd on Desk
| 项 | 值 |
|---|---|
| 仓库 | `rullerzhou-afk/clawd-on-desk` |
| 星标 | ~6.4k |
| 协议 | AGPL-3.0（**美术素材不在协议内**） |
| 技术栈 | Electron |

🦀 像素螃蟹，实时可视化 **14+ 种 AI 编程助手**的工作状态。

### 关键机制（最重要的一点）
**它不读你的 API Key。** 而是监听 agent 的**状态事件**：

| 接入方式 | 说明 |
|---|---|
| 命令 hook | Claude Code / Codex / Copilot / Gemini / Cursor 等自动注册 |
| 本地 HTTP 桥 | 监听 `127.0.0.1:7788`，agent 把状态 POST 过来 |
| JSONL 日志轮询 | hook 不可用时的兜底 |
| 权限审批气泡 | 桌面直接批准/拒绝终端请求，不用切窗口 |
| 桥安全 | 限制请求体大小 + Origin 白名单，可选 `PETDECK_BRIDGE_TOKEN` |

### 我们的做法（已实现）
`proxy.js` 的 **`/api/hook` 状态总线** 就是这个思路：
- 任何外部 agent `POST /api/hook` 推状态
- 前端用 **SSE** 实时接收 → 桌宠切表情 + 冒气泡
- 12 种状态经校验后规整，非法值落回 `idle`

### 同类项目
| 项目 | 星 | 说明 |
|---|---|---|
| `QingJ01/Clyde` | — | Clawd 的 Rust/Tauri 重写，加 i18n |
| `eigent-ai/eigent` | 15.5k | 开源 Cowork 桌面 agent |
| `LorisYounger/VPet` | 6.9k | 虚拟桌宠模拟器（C#/WPF），可嵌入任何 WPF 应用 |
| `jihe520/Agentic-Desktop-Pet` | 338 | LLM + 记忆 + 情感 + RPG + Claude Code |
| `OpenBMB/MiniCPM-Desk-Pet` | — | 本地 1B 模型，不烧 token，纯陪伴 |
| `alvinunreal/OpenPets` | 1.2k | 沙箱插件 SDK v3，本地优先 |
| `pet-tty` (PetDeck) | — | Tauri 2 + Rust，`127.0.0.1:7788` 桥 |

---

## 三、我们的架构与取舍

```
浏览器 (app.js)
  │  EventSource 订阅
  ↓
proxy.js  ──  持有密钥，唯一的出网口
  │  ├─ /api/hook        ← 外部 agent 推状态（Clawd 思路）
  │  ├─ /api/hook/stream → SSE 广播给前端
  │  ├─ /api/chat        → OpenAI / Anthropic / Ollama 统一流式
  │  └─ /api/health      → 前端据此选「真实」或「演示」模式
  ↓
OpenAI / Anthropic / Ollama
```

**为什么密钥必须放后端**：浏览器直连会撞 CORS，且 key 会暴露在 DevTools 里。

**取舍**：
- 采 Clawd 的 **hook 接入**（桌宠不只是调用者，也是接收端）
- 采 dsh 的 **Trajectory** 思路（`/api/hook/history`，最近 100 条）
- **暂不做** Clawd 的 Electron 桌面壳 —— 我们是 Web，穿透用 `pointer-events` 实现
- **暂不做** 完整插件化 —— 先做状态机 + 协议适配，避免过度设计

---

## 四、12 种状态映射（对齐 Clawd）

| 外部状态 | 情绪 mood | 中文标签 | 形态 |
|---|---|---|---|
| `idle` | idle | 待命 | 点（无表情） |
| `thinking` | active | 思考中 | `• •` |
| `typing` | active | 输出中 | `• •` |
| `reading` | active | 读取中 | `• •` |
| `writing` | active | 写入中 | `• •` |
| `running` | active | 执行中 | `• •` |
| `building` | active | 构建中 | `• •` |
| `testing` | active | 测试中 | `• •` |
| `searching` | active | 搜索中 | `• •` |
| `waiting` | warn | 等待审批 | `> <` |
| `done` | happy | 已完成 | `^ ^` |
| `error` | error | 出错 | 珊瑚 `× ×` |

**优先级**：外部 hook（6 秒有效期）> 用户暂停 > 引擎失败 > 运行中 > 排队 > 额度告警 > 完成 > 待命。
外部状态 6 秒无更新 → 自动交回本地引擎。

---

## 五、参考链接
- DeepSeek Harness: `github.com/deepseek-ai/deepseek-harness`
- Clawd on Desk: `github.com/rullerzhou-afk/clawd-on-desk`
- Clyde: `github.com/QingJ01/Clyde`
- OpenPets: `openpets.dev`
- VPet: `github.com/LorisYounger/VPet`
- awesome-ai-companion: `github.com/DasterProkio/awesome-ai-companion`
