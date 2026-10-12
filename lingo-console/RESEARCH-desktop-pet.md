# 同类机器人桌面案例调研（GitHub）

> 调研目的：为 Lingo 智能体调度台寻找可借鉴的「机器人助手」桌面/网页实现范式。
> 调研日期：2026-10-11

## 一、最接近本项目的案例（AI 编程 Agent 桌宠）

这一类的定位与 Lingo 调度台高度重合：**机器人在屏幕上实时反映 AI Agent 的运行状态**。

### 1. Clawd on Desk ⭐ 6.4k · JavaScript · AGPL-3.0
**最值得参考的案例。**

- 仓库：https://github.com/rullerzhou-afk/clawd-on-desk
- 官网：https://clawdondesk.com
- 形态：Electron 透明悬浮窗 + 像素风 SVG 动画桌宠
- 核心机制：通过各 Agent 的 **hooks / 日志轮询** 获取事件，驱动桌宠的动画状态机

**12 种动画状态**：idle、thinking、typing、building、subagent groove（1 个子代理）、multi-subagent juggling（2+ 子代理）、error、happy、notification、sweeping、carrying、sleeping

**关键设计（对本项目最有启发的点）**：

| 设计 | 说明 | 与 Lingo 的对应 |
| --- | --- | --- |
| 状态映射表 | 事件 → 动画一一映射，见 `docs/guides/state-mapping.md` | 我们的 `sideBotMsg` 语音状态机 |
| 主循环处理多会话 | 会话状态取**最高优先级**合并 | 我们的「运行中 > 排队 > 完成」播报优先级 |
| 权限气泡 | 浮动卡片就地允许/拒绝，不必盯终端 | 我们做的是「点击机器人派发任务」 |
| 迷你模式 | 拖到屏幕边缘隐藏，悬停探头 | 侧边栏折叠 `side-collapsed` |
| 视线跟随 | idle 时眼睛跟随鼠标，身体倾斜 | 可加的非必要趣味细节 |
| 睡眠序列 | 60s 空闲 → 打哈欠→打盹→沉睡；鼠标动 → 惊醒 | 我们的 `botBreathe` 呼吸动画 |
| 点击反应 | 双击戳一下、4 连击乱舞 | 我们：单击打开派发弹窗 |
| 位置记忆 | 重启后记住位置 | 我们：`localStorage` 存侧边栏折叠态 |
| 音效 | 完成/权限请求短音效，10s 冷却 | 我们：Notifier + 冷却去重 |
| 主题系统 | SVG + GIF/APNG 换角色 | 我们：`brand-assets/` 换形象 |
| 订阅额度光环 | 桌宠旁 Orbit 圆环显示配额窗口 | **我们的「API 实时余额」单元格** |
| 数据本地化 | 只在本地存最小数据，零遥测 | 我们：无第三方 API |

**自定义主题机制**（值得我们借鉴的工程化思路）：
```bash
node scripts/create-theme.js my-theme     # 脚手架
node scripts/validate-theme.js my-theme   # 校验
```
最小主题 = 1 个 SVG（带视线跟随的 idle）+ 7 个 GIF/APNG（thinking/working/error/happy/notification/sleeping/waking）。主题卡片会显示能力徽章：`Tracked idle` `Static theme` `Mini` `No reactions`。

> **代理集成覆盖面**（值得注意的广度）：Claude Code、Codex CLI、Copilot CLI、Gemini CLI、Antigravity、Cursor Agent、CodeBuddy、WorkBuddy、Grok Build、Kiro CLI、Kimi CLI、Qwen Code、ZCode、CodeWhale、**opencode**、MiMo Code、Pi、OMP、OpenClaw、Hermes Agent、Qoder、QwenWork、Reasonix、DeepSeek Harness、TraeCode、MiniMax Code

---

### 2. OpenPets ⭐ 1.3k · TypeScript · Electron
- 仓库：https://github.com/OpenPetsHQ/openpets
- 定位：本地优先的**桌宠平台**，带插件 SDK + 编程 Agent 集成
- 特点：把「桌宠」做成平台（插件生态），而非单一应用
- 启发：我们把 `MockDataSource` 做成可替换数据层，本质是同类思路

### 3. dsh-pet ⭐ 1.2k · TypeScript
- 仓库：https://github.com/PC2005-cloud/dsh-pet
- 定位：一行命令安装的透明动画小桌宠，支持多开、大小/位置配置，内置 DIY 素材链（用 AI 视频自造宠物）
- 启发：**「多开」**——我们要为每个 Agent 显示一个卡片，思路相通

### 4. agentpet ⭐ 378 · Swift · macOS/Windows
- 仓库：https://github.com/ntd4996/agentpet
- 定位：监控 AI 编程 Agent，**边写代码边长个子、喂 token 升级、排行榜**
- 启发：把「token 消耗」游戏化。我们的成本归因图是严肃版

### 5. tokenbean / TokenTracker ⭐ 2k · JavaScript
- 仓库：https://github.com/xiufengsun/TokenTracker
- 定位：本地优先的 AI token 用量与成本追踪，覆盖 31 种工具
- 启发：**「永不读取 prompt」** 的隐私边界声明——我们的 `DESIGN-SYSTEM.md` 也可写明数据流向

---

## 二、通用桌宠框架（工程范式参考）

| 项目 | Stars | 技术 | 值得借鉴 |
| --- | --- | --- | --- |
| [BongoCat](https://github.com/ayangweb/BongoCat) | 23.9k | Tauri + Rust | 跨平台打包、透明窗 |
| [VPet](https://github.com/LorisYounger/VPet) | 6.9k | WPF/C# | 「可内嵌到任何 WPF 应用」的组件化 |
| [Mate-Engine](https://github.com/shinyflvre/Mate-Engine) | 3.8k | ShaderLab | VRM 自定义模型 |
| [DyberPet](https://github.com/ChaozhongLiu/DyberPet) | 998 | PySide6 | 桌宠框架化 |
| [myCat](https://github.com/yumiaura/myCat) | 321 | Qt | 系统托盘 + 覆盖层 |

---

## 三、纯 Web / 网页内嵌（与我们的技术栈一致）

### Neko.js — 纯 JS 网页桌宠
- 仓库：https://github.com/louisabraham/nekojs
- Demo：https://louisabraham.github.io/nekojs
- 技术：**纯原生 JavaScript，零依赖**，~38KB（brotli 后 14KB），32×32 像素精灵
- 行为：跟随光标、静止时睡觉、点击切换行为模式
- **与我们最相关的点**：验证了「**零依赖原生 JS 实现有状态机动画的桌宠**」完全可行——这正是我们的技术路线

### Emotion Ball (aora-bot) ⭐ 459 · 原生 JavaScript
- 仓库：https://github.com/sam70361/aora-bot
- 定位：面向 AI 助手的**表情引擎**，32 种状态表情，**纯 SVG + 原生 JS 实时驱动，零框架、零图片资源**
- 接口：AI 侧只需输出一个 `emotionId`，小球切换到对应表情
- **极大的启发**：我们的机器人目前只有 `botBreathe` / `botWave` 两种动效。可以升级为「**情绪状态机**」——由 `updateBotVoice()` 同时输出 **文案 + 表情 id**，机器人表情与语音一致（待命/处理中/完成/告警/失败）。

---

## 四、可移植到 Lingo 的设计清单

基于以上调研，筛出适合本项目（纯 HTML/CSS/JS、无构建、自建通知）的改进项：

### 建议采纳
1. **情绪状态机**（学 Emotion Ball + Clawd）
   - 机器人增加表情状态：`待命 / 处理中 / 完成 / 告警 / 失败 / 休眠`
   - `updateBotVoice()` 同时返回 `{ text, emotion }`，表情与文案严格一致
   - 纯 CSS/SVG 实现，不引入图片资源

2. **状态映射表文档化**（学 Clawd `state-mapping.md`）
   - 把「引擎事件 → 机器人状态 → 文案 → 动效」写成一张表放进 `DESIGN-SYSTEM.md`
   - 我们已有 `updateBotVoice` 的优先级逻辑，只差文档化

3. **点击反应分级**（学 Clawd）
   - 单击 = 派发任务（已实现）
   - 双击 = 让机器人「说」一句当前状态摘要
   - 长按/右键 = 快捷菜单（暂停 / 重置 / 打开通知）

4. **空闲休眠**（学 Clawd 60s 空闲）
   - 无 Agent 运行超过 N 秒 → 机器人进入「打盹」低功耗态（动画减速 + 文案变暗）
   - 有事件 → 惊醒

5. **主题/形象可替换**（学 Clawd 主题系统）
   - 把机器人素材路径抽到配置，便于换形象
   - 可复用其「最小主题 = 1 个 idle + N 个状态图」的清单作为规格

6. **隐私边界声明**（学 TokenTracker）
   - 在 `DESIGN-SYSTEM.md` 写明：数据仅本地、无遥测、不读第三方 prompt

### 暂不建议
- Electron/Tauri 打包成本高，且我们已有 `server.js` 静态服务
- 权限气泡需要 Agent hook 集成，超出当前 mock 范围
- 远程推送（Telegram/Slack/飞书）——用户明确要求**自建通知系统，不用第三方 API**
- Live2D / VRM 三维形象，与 VI 的像素机器人风格冲突

---

## 五、结论

**Clawd on Desk 是最直接的同类案例**：同样是「桌宠实时反映 AI Agent 状态」，工程上把状态机、主题系统、多会话合并、配额光环都做透了。我们的调度台在**信息密度**上更接近一个「控制台」（垂直三栏 + Trace 明细 + 成本归因），而 Clawd 更偏「陪伴式状态指示」。

两者可结合的中间态：**Lingo 机器人作为调度台的助手人格**，既保留控制台的信息密度，又通过「情绪状态机 + 点击交互 + 空闲休眠」获得陪伴感——这正是当前实现的方向。
