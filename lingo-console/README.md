# Lingo 智能体调度台

一个带**会干活的桌宠**的 AI Agent 调度台。桌宠不只是装饰——它能接真实大模型、
接收外部 Agent 状态、并被你直接派活。

---

## 快速开始

```bash
# 1) 启动（前端 8899 + API 代理 8900）
node start.js

# 或者分开起
node server.js     # 前端  http://127.0.0.1:8899
node proxy.js      # 代理  http://127.0.0.1:8900
```

打开 **http://127.0.0.1:8899/**（用 HTTP 地址，不要用 `file://`）。

> 没配密钥也能用——会自动进入**演示模式**（本地 mock 流式输出）。

---

## 接入真实模型

**不要把密钥写进代码，也不要在聊天里贴。** 三种方式选一：

### 方式 A：交互式（最简单）
```bash
node setkey.js deepseek     # DeepSeek 官方（文本对话）
node setkey.js glm          # 智谱 GLM-4V（识图 / 多模态）
node setkey.js qwen         # 阿里通义千问 VL（识图）
```
会提示输入，**不回显、不进命令行历史**，存到 `.secrets.json`（已 gitignore）。

可用的预设：`deepseek` `glm` `zhipu` `qwen` `dashscope` `openai` `moonshot` `anthropic`。

### 方式 B：环境变量（最安全，密钥不落盘）
```powershell
setx OPENAI_API_KEY "你的key"
setx OPENAI_BASE_URL "https://api.deepseek.com"
# 重开终端后：node start.js
```

### 方式 C：手动编辑 `.secrets.json`
```json
{ "providers": { "openai": { "baseUrl": "https://api.deepseek.com", "apiKey": "sk-..." } } }
```

**优先级：环境变量 > `.secrets.json` > `config.json`**

改完让代理立即生效（不用重启）：

```bash
curl http://127.0.0.1:8900/api/reload
```

### 支持的模型

| 模型 | provider | 协议 | 说明 |
| --- | --- | --- | --- |
| DeepSeek V3 | openai | OpenAI 兼容 | `deepseek-chat`，默认对话模型 |
| DeepSeek R1 | openai | OpenAI 兼容 | `deepseek-reasoner` |
| GLM-4V | zhipu | OpenAI 兼容 | 识图（多模态），`glm-4v-flash` |

> 界面只列出**你在用的**模型 —— 没配密钥的模型不会硬塞假数据进来。
> 想加别的，改 `app.js` 顶部的 `MODELS` 数组即可。

### 账户余额（真实数字，不是编的）

首页控制台「API 实时余额」格显示的是**厂商返回的真实余额**：

```bash
curl "http://127.0.0.1:8900/api/balance?provider=openai"
```

```json
{
  "supported": true,
  "available": true,
  "currency": "CNY",
  "total": 59.66,
  "topped_up": 59.66,   // 自己充的钱
  "granted": 0,         // 未过期的赠金
  "source": "deepseek /user/balance"
}
```

- **DeepSeek** 有公开接口 `GET {baseUrl}/user/balance`（Bearer 你的 key），
  能拿到 `total_balance` / `granted_balance` / `topped_up_balance`。代理端缓存 60 秒。
- **其它厂商**（智谱 / 阿里 / Anthropic / OpenAI 兼容服务）没有公开余额接口，
  界面会明确写「无法获取（原因）」，**绝不显示编造的数字**。
- 同一账号下的多个模型（V3 + R1 共用 DeepSeek 账号）只统计一次余额，不会重复相加。
- 格子里还有 **今天 / 本月** 的用量（任务数 · tokens · 花费），
  本地记账存在 `localStorage["lingo.usage.v1"]`，保留 120 天，不依赖任何厂商接口。
- 右上角 🔄 按钮可**立即强制刷新**余额。

### 工作模式

页面右上角有指示器：

| 显示 | 含义 |
| --- | --- |
| **真实 API · openai/ollama** | 已配密钥，任务真的调用 API |
| **演示模式** | 未配密钥 / 代理未启动，用本地模拟数据 |

**密钥只存在 `proxy.js` 进程里**，浏览器拿不到——这是刻意的设计
（浏览器直连会撞 CORS，且 key 会暴露在 DevTools）。

### 真实模式的 token 计量
- 输出 token 边流边估（用于实时显示）
- 上游返回 `usage` 后**用真实值修正**，成本按真实 token 计
- 单价写在 `MODELS` 每个条目的 `price: [输入, 输出]`（美元/1K token）

---

## 让桌宠接收外部 Agent 状态

桌宠可以像 **Clawd on Desk** 那样，被外部 Agent 驱动：

```bash
# 命令行
node hook.js thinking "正在分析需求"
node hook.js writing  "修改 app.js" "第 1200 行"
node hook.js error    "构建失败" "exit code 1"
node hook.js done
```

```js
// 代码里
const { pushState } = require("./hook.js");
pushState("running", { label: "跑测试", source: "my-agent" });
```

**12 种状态**：`idle thinking typing reading writing running building testing searching waiting done error`

也可以直接打接口：

```bash
curl -X POST http://127.0.0.1:8900/api/hook \
  -H "Content-Type: application/json" \
  -d '{"state":"writing","label":"改代码中","source":"claude-code"}'
```

| 接口 | 说明 |
| --- | --- |
| `POST /api/hook` | 推状态 |
| `GET /api/hook` | 查当前状态 |
| `GET /api/hook/history` | 最近 100 条（轨迹） |
| `GET /api/hook/stream` | SSE 订阅 |
| `POST /api/chat` | 统一流式对话（前端用） |
| `GET /api/health` | 探测哪些 provider 已配好 |
| `GET /api/balance?provider=openai` | **真实账户余额**（DeepSeek `/user/balance`，缓存 60s） |
| `GET /api/skills` | 列出所有 skill（摘要） |
| `GET /api/skills/:id` | 读某个 skill 全文 |
| `POST /api/skills/match` | 按关键词匹配 skill |
| `POST /api/skills/reload` | 重扫 skill 目录 |

---

## 技能库（skill）

桌宠能像 opencode / Claude Code 那样**调用 skill**。skill 就是一段 Markdown 指令，
命中后自动注入对话的 system prompt —— 用户完全无感。

### 内置扫描的目录

| 目录 | 说明 |
| --- | --- |
| `./skills/` | 项目自己的 skill（推荐往这里加） |
| `~/.agents/skills` | agents 技能库 |
| `~/.codex/skills` | codex 技能库 |
| `~/.dsh/skills` | dsh 技能库 |

同名 skill 以**先扫到的**为准（自定义 > 项目 > agents > codex > dsh）。

### 加自定义目录

在 `config.json`（或 `.secrets.json`）里加：

```json
{
  "skillDirs": [
    "D:\\my-skills",
    { "dir": "E:\\team\\skills", "scope": "team" }
  ]
}
```

也可以用环境变量：`set LINGO_SKILL_DIRS=D:\my-skills;E:\team\skills`。
改完点技能库面板里的「重扫」，或访问 `POST /api/skills/reload`。

### 写一个自己的 skill

在 `skills/<id>/SKILL.md` 建文件，带 frontmatter：

```markdown
---
name: my-skill
description: 什么时候用这个技能（写得越具体，自动匹配越准）
level: read
argument-hint: "[参数]"
---

# 正文：给模型的指令
...
```

`level` 三档，决定执行权限：

| level | 含义 | 执行方式 |
| --- | --- | --- |
| `read` | 只读，不改任何状态 | 直接跑 |
| `dispatch` | 会派发真实任务 | **需要用户授权**（Codex 式确认） |
| `write` | 会改文件（预留，暂未开放） | — |

### 浏览与管理

左下角 **技能库** 打开抽屉：分组列出所有 skill、搜索、点开看完整正文、
每个技能一个开关（关掉后不再参与自动匹配）。启停状态存 `localStorage`。

### 任务派发授权

带 `dispatch` 的 skill 让模型输出 `[[DISPATCH]]{...}[[/DISPATCH]]` 标记时，
前端**不会**直接派发，而是弹出授权卡：

```
┌─ 需要授权 ──────────────┐
│ 模型  DeepSeek R1       │
│ 任务  分析这段代码…      │
│ [确认派发] [取消]        │
└─────────────────────────┘
```

点「确认派发」才真正进调度台；点「取消」什么都不发生。
标记本身不会显示在气泡里。

---

## 目录结构

```
index.html          页面结构
styles.css          样式（三层令牌：Primitive → Semantic → Component）
app.js              前端逻辑（Engine / UI / Notifier / Pet / Hook / Skill / LiveDataSource）
proxy.js            API 代理（持有密钥，唯一的出网口）+ skill 注册表
hook.js             给外部 Agent 用的状态推送工具
setkey.js           安全写入密钥（不回显、不落代码）
server.js           静态服务器
start.js            一键起两个服务
skills/             项目自建 skill（lingo-dashboard / lingo-dispatch / lingo-report）
config.json         非密钥配置（baseUrl、skillDirs 等）
.secrets.json       密钥文件（自动生成，已 gitignore）
config.example.json 配置模板
DESIGN-SYSTEM.md    设计系统文档
RESEARCH-*.md       调研文档
brand-assets/       Lingo 品牌素材
```

---

## 文档

- `DESIGN-SYSTEM.md` —— 令牌架构、桌宠行为、情绪状态机、Hook 总线
- `RESEARCH-agent-harness.md` —— DeepSeek Harness / Clawd 等调研
- `RESEARCH-desktop-pet.md` —— 桌面宠物生态调研

---

## 安全提示

- `config.json` 已在 `.gitignore` 里，**不要提交**
- 代理只监听 `127.0.0.1`，不对公网开放
- Hook 接口限制请求体 32KB，state 走白名单校验
- 桌宠容器 `pointer-events: none`，绝不影响正常电脑操作
