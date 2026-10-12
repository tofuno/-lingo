# Lingo 智能体调度台 · 设计系统

> 令牌架构：三层（Primitive → Semantic → Component）
> 品牌依据：Lingo VI 手册 v1.0
> 实现源：`styles.css` 顶部 `:root` 令牌块（唯一真值来源）

---

## 1. 令牌架构

```
Layer 1  Primitive   原始值（品牌色 / 间距 / 字号 / 圆角 / 动效）
Layer 2  Semantic    用途别名（背景 / 前景 / 主色 / 边框 / 状态）
Layer 3  Component   组件令牌（按钮 / 卡片 / 徽标 / 弹层）
```

**规则**：组件样式只引用 Semantic 或 Component 层，**禁止裸 hex**。

---

## 2. Layer 1 · Primitive

### 品牌色（Lingo VI）
| 令牌 | 值 | 用途 |
|---|---|---|
| `--lingo-plum-900` | `#281333` | 深李紫 · 侧栏 / 主文字 |
| `--lingo-plum-700` | `#3d2149` | 深李紫浅阶 |
| `--lingo-violet-600` | `#5b35c8` | 活力紫 · 主色 |
| `--lingo-violet-500` | `#4d2bb0` | 活力紫 · hover |
| `--lingo-violet-100` | `#efe9fb` | 活力紫 · 浅底 |
| `--lingo-coral-500` | `#fa554f` | 珊瑚红 · 强调 / 规则线 |
| `--lingo-cream-100` | `#fbf6eb` | 奶油白 · 纸感底 |
| `--lingo-cyan-500` | `#13b8df` | 充电蓝 · 输入数据 |
| `--lingo-yellow-400` | `#ffd43b` | 透光黄 · 模型标识 |

### 中性 / 文本 / 状态
`--neutral-0/50/100/200`、`--ink-900/700/650/600/500`、
`--state-green/amber/red-{100,200,600}`、`--on-deep-{muted,soft,nav,white}`

### 尺度
- **间距**（4px 基准 · VI 10.3）：`--space-1` … `--space-8` = 4/8/12/16/20/24/32
- **字号**：`--fs-xs/sm/base/md/lg/xl/2xl` = 11/12/13/14/19/25/27
- **圆角**：`--radius-sm/md/lg/xl/full` = 8/10/13/15/999（按钮 8，卡片 15）
- **动效**（VI 11.8/11.9）：`--duration-micro/btn/page/icon/logo`，`--ease-out` / `--ease-inout`

---

## 3. Layer 2 · Semantic

| 语义令牌 | 指向 Primitive | 用途 |
|---|---|---|
| `--color-background` | `--neutral-50` | 页面底 |
| `--color-surface` | `--neutral-0` | 卡片面 |
| `--color-surface-2` | `--lingo-cream-100` | 次级面 / 输入底 |
| `--color-foreground` | `--ink-900` | 主文字 |
| `--color-muted-foreground` | `--ink-600` | 次要文字（对比度 5.29 ✓） |
| `--color-border` / `-soft` | `--neutral-200/100` | 描边 |
| `--color-primary` | `--lingo-violet-600` | 主色 |
| `--color-accent` | `--lingo-coral-500` | 强调 / 焦点环 |
| `--color-data-in` / `-out` | cyan / violet | 图表数据系列 |
| `--color-success` / `warning` / `danger` | 状态色 | 语义状态 |

---

## 4. Layer 3 · Component

| 组件 | 令牌 |
|---|---|
| 按钮 | `--button-bg` `--button-border` `--button-hover-*` `--button-radius` `--button-primary-bg` `--button-focus-ring` |
| 卡片 | `--card-bg` `--card-border` `--card-radius` `--card-shadow` |
| 徽标 | `--badge-running-*` `--badge-done-bg` `--badge-queued-bg` |
| 弹层 | `--overlay-scrim` `--focus-ring-width` |

### 按钮状态
| 属性 | Default | Hover | Active | Disabled |
|---|---|---|---|---|
| 背景 | surface | surface-2 | — | surface |
| 边框 | border | hover-border | — | border |
| 变换 | — | — | `translateY(1px)` | — |
| 不透明度 | 1 | 1 | 1 | 0.55 |
| 光标 | pointer | pointer | pointer | not-allowed |

---

## 5. 无障碍（ui-ux-pro-max §1–§2）

- 文本对比度：正文/次要文字 ≥ 4.5:1（实测 4.95–16.9）
- 焦点环：`2px solid var(--button-focus-ring)`，`outline-offset: 2px`
- 触摸目标：按钮 ≥ 40px 高（桌面），移动端建议 ≥ 44px
- 实时播报：`role="status" aria-atomic="true"`，完整语义、节流 4s
- 图表：`role="img"` + `aria-label` 摘要 + `<details>` 数据表兜底
- 动效：完整支持 `prefers-reduced-motion`

---

## 6. 图表规范（ui-ux-pro-max §10）

- 系列区分**不单靠颜色**：输入=实线、输出=虚线（色盲友好）
- 提供图例、屏幕阅读器摘要、数据表兜底
- 网格线低对比（`rgba(40,19,51,0.07)`），不抢数据
- 数据数字使用 `font-variant-numeric: tabular-nums`

---

## 7. 通知系统组件令牌

| 组件 | 令牌 |
|---|---|
| 通知角标 | `--color-accent` `--radius-pill` |
| 通知面板 | `--card-radius` `--shadow-float` |
| 通知项 | `--radius-data`，level 用 `--color-{warning,danger,success}` |
| 开关 | `--color-primary` `--radius-pill` `--dur-micro` |

通知级别 → 颜色映射：
- `ok` → `--color-success`
- `warn` → `--color-warning`
- `danger` → `--color-danger`
- `info` → `--color-muted-foreground`

---

## 8. 通知系统架构（自建 · 无第三方 API）

```
Notifier（通知引擎）
├── 规则层
│   ├── checkQuota()   额度阈值告警（阈值可配置 + 冷却去重）
│   └── taskDone()     任务完成提醒（可开关）
├── 通道层
│   ├── inapp          页面内通知中心（默认，始终可用）
│   └── desktop        浏览器原生 Notification API（本地能力）
└── 存储层
    └── localStorage   设置 + 最近 20 条历史（纯本地，刷新不丢）
```

**设计要点**
- 无任何第三方推送服务依赖，全部自主实现
- 冷却去重：同类消息按 `dedupeKey` 在冷却期内只记一次
- 无障碍：`aria-live="polite"` 列表、`aria-expanded` 开关状态、Esc 关闭
- 降级：权限被拒 / 隐私模式 / 不支持 Notification 时静默降级到页面内通知

---

## 9. 科技感指挥台（Console）

深色 HUD 面板嵌在浅色后台外壳内 —— 既保留 VI「后台默认浅色」，又给仪表盘核心区以数据控制台的科技质感。

**结构（垂直三栏控制台）**

| 组件 | 说明 |
|---|---|
| `.console-head` | 栏头：编号 + 标题 + HUD 虚线条 + 实时时钟 |
| `.console-bar` | 总控条：3 列网格，5 个指标单元（总量 / 输入 / 输出 / 速率 / 活跃 Agent） |
| `.console-cell` | 竖排单元：标签+标签牌 → 大数值 → 单位 → 撑满的迷你走势线 |
| `.cc-gauge-cell` | 活跃 Agent 单元：环形仪表 + 文字（活跃/总数） |
| `.cc-balance-cell` | API 实时余额单元：每个模型一行「色点 + 名称 + 余额 + 余额条」 |
| `.cc-tasks-cell` | 进行中任务单元：简明列出正在跑的任务 |
| `.console-gauge` | 环形负载仪表（活跃/总数），负载 >66% 转珊瑚红 |
| `.console-panel` | 深色面板：网格纹理 + 发光描边，用于趋势图与额度面板 |

**分栏规则**
- 桌面：`grid-template-columns: repeat(3, 1fr)`
  - 第 1 行：总量 / 输入 / 输出
  - 第 2 行：速率 / 活跃 Agent 仪表 / **API 实时余额**
  - 第 3 行：进行中任务
- ≤1120px：降为 2 列
- ≤560px：降为 1 列
- 分栏线：`nth-of-type(3n+1)` 去左边框，首行去上边框（栅格化分隔线）

**API 实时余额（`.cc-balance-list`）**
- 每模型一行：品牌色点 + 名称 + 余额（云端 `$x.xxxx` / 本地 `n ctx`）+ 3px 余额条
- 余额条按**剩余比例**填充：充足用模型品牌色 → ≤35% 黄 → ≤15% 珊瑚红
- 金额随消耗实时递减；≤35% 金额转黄、≤15% 转红
- 单元头标签：云端余额合计 `$x.xxxx`，任一模型告警时显示 `LOW`
- 无滚动条

**进行中任务列表（`.cc-task-list`）**
- 每条：闪烁状态点 + Agent 名称 + 「模型 · 任务简述」
- 最多展示 3 条，超出折叠为「还有 N 个任务进行中…」（**无滚动条**）
- 任务简述截断至 34 字，完整内容进 `title` 提示
- `aria-live="polite"` 播报；无任务时显示空态
- 节流：数量不变时原地更新文本，不重建 DOM

**控制台令牌（Layer 3b）**

| 令牌 | 值 | 用途 |
|---|---|---|
| `--console-bg` | `#1b0d24` | 控制台底色（深李紫派生） |
| `--console-bg-2` | `#241031` | 顶部渐变 |
| `--console-line` | `rgba(147,116,255,.22)` | 分隔线/描边 |
| `--console-grid` | `rgba(147,116,255,.10)` | 网格纹理 |
| `--console-k` | `#9a86b8` | 键名/标签 |
| `--console-v` | `#f4f0ff` | 数值 |
| `--console-glow` | `0 0 10px rgba(91,53,200,.55)` | 紫色发光 |

**对比度（深色面板上，全部 ≥4.5:1）**

| 前景 | 背景 | 比值 |
|---|---|---|
| `#f4f0ff` 数值 | `#1b0d24` | 16.60 |
| `#9a86b8` 标签 | `#1b0d24` | 5.73 |
| `#13b8df` 输入 | `#1b0d24` | 7.92 |
| `#b79dff` 输出 | `#1b0d24` | 8.22 |

**技术要点**
- Sparkline：SVG `polyline` + 面积 `polygon` + 末点 `circle`，40 点窗口，纯数据驱动，撑满卡片高度
- 环形仪表：`stroke-dasharray` = 2πr，`stroke-dashoffset` 按 `活跃/总数` 驱动，480ms ease-in-out
- 趋势图在深色面板上重绘：网格线改浅紫 `rgba(147,116,255,.14)`，主线外加 5px 低透明度发光描边
- 所有色值派生自 Lingo 品牌色，不引入体系外颜色

---

## 10. 页面结构与导航
**单页结构（自上而下）**

```
#dashboard   仪表盘（KPI + 趋势图 + 模型额度面板）
#agents      Agent 监控（卡片列表）
#quota       模型额度锚点（供侧边栏跳转）
```

首页首屏为仪表盘总览，向下滚动到 Agent 监控。

**侧边栏导航**

| 行为 | 实现 |
|---|---|
| 点击跳转 | `UI.scrollToSection()` — 计算 `getBoundingClientRect().top + pageYOffset - 12` |
| 平滑滚动 | `window.scrollTo({behavior:'smooth'})`，420ms 后兜底校正（后台/无头环境不推进动画时直接跳转） |
| 减少动效 | `prefers-reduced-motion` 时改为瞬时跳转 |
| 当前区块高亮 | `IntersectionObserver` 滚动监听（`rootMargin: -20% 0 -60% 0`），同步 `aria-current` |
| 折叠/展开 | `.layout.collapsed` 切换 `grid-template-columns`；折叠后浮出 `.side-reveal` 按钮 |
| 偏好记忆 | `localStorage["lingo.sidebar.collapsed"]` |

**无障碍**
- `nav[aria-label="页面导航"]`
- 折叠按钮 `aria-expanded` / `aria-controls`
- 当前项 `aria-current="true"`
- 所有交互控件 `:focus-visible` 焦点环

**注意**：全局 `scroll-behavior` 不设在 CSS（避免与脚本化滚动、减少动效偏好冲突），由 JS 统一控制。

---

## 11. 实际应用资产（可选）

数据集内可用的设计资产：
- 图表脚手架与 Chart.js 配置：`design-system/data/slide-charts.csv`
- 布局变体：`design-system/data/slide-layouts.csv`
- 排版尺度：`design-system/data/slide-typography.csv`

> 本项目为纯 HTML/CSS/JS，直接使用 `styles.css` 的 `:root` 令牌即可，无需构建步骤。

## 12. Lingo 助手（机器人）

**设定：AI 助手就是机器人。** VI 手册注明「主品牌标志不含机器人」——机器人是 **AI 输入法 / 对话场景的吉祥物**，因此仅用于本调度台的「助手人格」语境，绝不与主字标组合。

### 资产
| 文件 | 用途 | 说明 |
| --- | --- | --- |
| `brand-assets/lingo-robot.png` | 全身像 | 去除奶油底（flood fill）并裁切，`774×988` |
| `brand-assets/lingo-robot-head.png` | 头像 | 上部 62% 裁切，用于卡片 / 栏头 |

### 出现位置
| 位置 | 元素 | 交互 |
| --- | --- | --- |
| 侧边栏助手卡 | `.side-bot`（`<button id="sideBot">`） | **点击派发任务**：打开派发弹窗并聚焦任务输入 |
| 指挥台栏头 | `.console-head-bot` | 静态身份标识（44×44） |
| Agent 卡片头像 | `.agent-avatar img` | 每个 Agent 统一用机器人头像，外圈取模型色 |
| 空态 | `.empty-bot-btn`（`<button id="emptyBot">`） | **点击派发任务**，含「派发任务」CTA |

### 动效（ch.11 动效系统）
- `.side-bot-ava` / `.empty-bot` / `.console-head-bot`：`botBreathe` 3.2s 呼吸浮动（`translateY` 0→-2px，`ease-inout`）。
- 悬停：`botWave` 700ms（±9° 摆动 + 缩放 1.06），CTA「+」旋转 90° 并转成珊瑚色。
- 全部动效受 `prefers-reduced-motion` 收敛。

### ① 情绪状态机

机器人不是装饰，而是有情绪的助手人格。`UI.setBotMood(state)` 把 `state` 映射为 `mood`，写入 `.side-bot[data-mood]`，驱动 **专属动画 + 光环配色 + 情绪圆点**，全部纯 CSS，零图片资源。

- 状态表定义在 `UI.BOT_EMOTIONS`（`state → { mood, label }`）。
- 情绪圆点 `.side-bot-mood`：**色 + 形双重编码**（脉冲/常亮），不单靠颜色传达状态。
- 指挥台栏头小机器人通过 `.console-head[data-mood]` 同步情绪。
- `aria-label` 会带上情绪（如「Lingo 助手（处理中）：点击派发新任务」），`title` 同上。

### ② 状态映射表（引擎事件 → 机器人）

单一数据源：`UI.updateBotVoice()`（每 800ms + 状态变更时触发）。**优先级从上到下，命中即停。**

| 优先级 | 触发条件（引擎事件） | state | mood | 播报文案 | 动画 |
| --- | --- | --- | --- | --- | --- |
| 1 | `Engine.paused === true` | `paused` | `sleep` | 已暂停，随时可继续 | `botBreathe` 5s（变暗 62%） |
| 2 | 存在 `status === "failed"` 的 Agent | `failed` | `error` | 有 N 个任务失败了 | `botError` 420ms ×4（急摆） |
| 3 | 存在 `status === "running"` 的 Agent | `running` | `active` | 正在处理 N 个任务… | `botWork` 900ms（工作抖动） |
| 4 | 存在 `status === "queued"` 的 Agent | `queued` | `active` | N 个任务排队中 | `botWork` 900ms |
| 5 | 任一模型 `used/total >= 0.85` | `warning` | `warn` | 有模型余额偏低，注意额度 | `botWarn` 1.5s（警觉摆动） |
| 6 | `Engine.totalTasks > 0` | `done` | `happy` | 已完成 N 个任务 | `botHappy` 620ms ×2（弹跳） |
| 7 | 以上皆否 | `idle` | `idle` | 随时待命，可派发任务 | `botBreathe` 3.2s |

**情绪配色（`.side-bot-mood` 圆点）**

| mood | 圆点颜色 | 令牌 | 附加 |
| --- | --- | --- | --- |
| `idle` | `#7d6b96` 灰紫 | — | 常亮 |
| `active` | `#13B8DF` 青 | `--lingo-cyan` | 脉冲 1.4s |
| `happy` | `#FFD43B` 黄 | `--lingo-yellow-400` | 常亮 |
| `warn` | `#FFD43B` 黄 | `--lingo-yellow-400` | 常亮 + 卡片边框转黄 |
| `error` | `#FA554F` 珊瑚 | `--lingo-coral-500` | 脉冲 1.1s + 卡片描边转珊瑚 |
| `sleep` | `#5C4D72` 深紫 | — | 常亮 + 整体 62% 不透明 |

> 数据源可替换：状态机只读 `Engine` 的对外字段（`paused`/`agents[].status`/`totalTasks`/`MODELS[].quota`），把 `MockDataSource` 换成真实 API 后逻辑不变。

### 助手「说话」（自建，无第三方）
`UI.sayBot(msg, state)` 同时更新两处并切换情绪：
- `.side-bot-meta #sideBotMsg` —— 可见文案
- `#sideBotLive`（`role="status" aria-live="polite"`，`sr-only`）—— 屏幕阅读器朗读，不抢焦点

文案与情绪严格一致：改文案必然走 `sayBot(msg, state)`，`state` 决定 `mood`，杜绝「说完成但表情告警」的不一致。

### 无障碍
- 机器人入口均为原生 `<button>`，`aria-label` 含情绪态：`Lingo 助手（待命）：点击派发新任务`。
- 装饰性 `<img>` 设 `alt="" aria-hidden="true"`；情绪圆点 `aria-hidden="true"`（信息已并入 `aria-label`）。
- 情绪不仅靠颜色：每种 mood 有**独立动画**（抖动/弹跳/急摆/呼吸各不相同）+ 文字播报，色盲用户可辨。
- 焦点可见：`:focus-visible` 使用 `--focus-ring-width` 品牌描边。

## 13. Lingo 桌宠（自由走动 · 电子宠物）

第 12 节的机器人是**身份标识**；桌宠是它的**行为化身**——一个可自由走动、会主动提示的电子宠物。

### 行为规则（`Pet` 控制器）

**核心原则：用户有任何操作时，机器人绝不移动。**

| 触发 | 行为 | 实现 |
| --- | --- | --- |
| **任何用户操作**（鼠标移动/点击/滚轮/键盘/触摸） | **立即静止**，放弃当前漫游目标；但会**转头看向光标**（不移动） | `onUserActivity()` + `lookAt()` |
| 完全空闲 **12 秒** | **自由漫游**：72% 概率走向数据模块（控制台/额度/Trace/Agent），到达后停下「观察」2.6–4.2s，再继续走 | `pickWanderTarget()` + `loop()` |
| 切换标签页 / 长时间待机 | 呼吸放慢、眼睛半闭进入「打瞌睡」 | `petSleep` + `data-mood="sleep"` |
| 平时（始终） | 呼吸起伏、每 2–6s 眨眼、每 5–12s 做个小动作（歪头/伸懒腰/张望） | `petBreath` + `scheduleBlink()` + `scheduleMicro()` |
| 切换到别的标签页 | 视同「无操作暂停」，不乱跑 | `visibilitychange` |
| 有任务/通知 | 弹出**微信式悬浮通知**并冒未读角标（不影响走动状态） | `Pet.notify()` + `showToast()` |
| **长按拖动** | 把机器人拖到任意位置（悬空时晃晃悠悠），松开后落点即新家并本地记忆 | `onDragStart/_onDragMove/_onDragEnd` |
| 单击本体 | 打开/收起对话框 | `toggleDialog()` |
| 点击工具栏「桌宠」 | 自由走动 ↔ 安静待命（状态持久化） | `setParked()` |

> **不做的事**：不跟随鼠标、不在鼠标附近乱晃。鼠标一动它只是安静地待着。
> 空闲计时器 `IDLE_AFTER_MS = 12000`（12 秒），可按需调整。

### 鼠标穿透（关键）
`.pet { pointer-events: none }` —— 桌面容器不拦截任何操作；只有 `.pet-body`（机器人本体）与 `.pet-dialog`（对话框）设 `pointer-events: auto`。**绝不影响正常电脑操作。**

### 只在真正空闲时走动（关键）
`onUserActivity()` 监听鼠标移动/点击/滚轮/键盘/触摸，**任何操作都会立刻把机器人定住**并清空漫游目标。只有当 `performance.now() - lastMouse > IDLE_AFTER_MS(12s)` 且页面可见时才允许漫游 —— 正常使用电脑时它永远安静待着，不追鼠标、不乱晃。

### 性能与陷阱（踩过的坑，勿回退）| 坑 | 症状 | 正确做法 |
| --- | --- | --- |
| **`while (stack.children.length >= MAX)` + 异步 `remove()`** | 页面**彻底卡死**（标签页无响应、所有脚本超时） | 用 `_finalizeToast()` **同步 `el.remove()`**，循环一定会推进；动画退场用 `dismissToast()` |
| **`mousemove` 里调 `getBoundingClientRect()`** | 每次鼠标移动都强制同步重排，拖动整体变卡 | `lookAt()` 用 `_gazeRect` 缓存 + 250ms 低频刷新 |
| **给 `.pet-sway` 写内联 `style.transform`** | 内联样式**永久覆盖** `petBreath` 呼吸动画 | 改用 CSS 变量 `--gaze-tilt`，由 CSS 规则消费 |

> 排查手法：`while`/`do` 循环体里只要调用了「延迟移除」类函数，就必须确认「循环条件会推进」，否则 100% 死循环。

### 生命感（真实感）四件事
| 能力 | 实现 | 细节 |
| --- | --- | --- |
| **呼吸 / 待机微动作** | `.pet-sway` 上的 `petBreath`（3.4s 循环）+ `microIdle()` | 胸腔起伏；每 5–12s 随机做一次小动作：歪头 `microTilt` / 伸懒腰 `microStretch` / 张望 `microLook` |
| **眨眼** | `blink()` / `scheduleBlink()` | 每 2.2–6.4s 眨一次，`.blink` 做 160ms 明暗闪动 |
| **走路有重量感** | `step()` 速度渐变 + `petStep` / `petStride` | 起步加速（`traveled/34`）、到站减速（`dist/46`）；落地时身体下沉 1.6px 再蹬起，躯干随步伐左右倾 ±5° |
| **看向鼠标（不跟走）** | `lookAt(mx,my)` | 瞳孔层 `--gaze-x/--gaze-y` 朝光标偏移（≤5px），躯干最多倾 3°；**位置绝对不动** |
| **情绪化表情** | `.pet-face` 伪元素 | `active` 专注 `•` · `happy` 眯眼 `^` · `warn` 警觉 `><` · `error` 珊瑚 `×` · `sleep` 睡眼 `‿` · `idle` 透明 |

> **三层动效结构**：`.pet-body` 负责位移/落地（重量）→ `.pet-sway` 负责呼吸/摇摆 → `.pet-img` 负责朝向镜像。互不干扰，拖动时 `.pet-dangle` 让它晃晃悠悠。
> `prefers-reduced-motion` 下全部动效关闭（含 `pet-gaze` 的过渡）。

### 拖动交互（Pointer Events）
- `pointerdown` → `setPointerCapture` 捕获指针（拖出窗口也能继续）
- 移动 **> 4px** 才算拖动（`DRAG_THRESHOLD`），低于阈值视为点击 → 不影响单击打开对话框
- 拖动中：`cursor: grabbing`、机器人放大 6% + 抬起阴影、所有走动动画暂停
- 朝向跟随拖动方向（`facing-left` 镜像翻转）
- 松开：位置写入 `localStorage["lingo.pet.pos"]`，刷新后自动恢复；重置空闲计时避免立刻又跑走
- 触摸设备：`touch-action: none` 防止拖动机器人时页面滚动

### 对话框（GPT 风格聊天窗）
结构：头部（头像/状态/清空/收起）→ **可滚动消息列表** → 快捷提问 → **输入框** → 工具按钮。

| 元素 | 说明 |
| --- | --- |
| `.pet-dialog-head` | 机器人头像 + 「Lingo 助手」+ 实时状态（复用情绪 `label`）+ 清空 + 收起 |
| `.pet-dialog-body` | `role="log" aria-live="polite"`；**可滚动长列表**（280px，`overflow-y: auto`），最多保留 200 条 |
| `.pet-day` | **时间线分隔**：今天 / 昨天 / M月D日 |
| `.pet-msg` | 一条消息；**助手靠左**（机器人头像）、**用户靠右**（紫色气泡「我」） |
| `.pet-typing` | 「正在输入…」三点跳动指示器 |
| `.pet-caret` | 打字机光标（闪烁） |
| `.pet-chip` | 快捷提问 chips：token 用量 / 余额 / 在跑什么 |
| `.pet-dialog-input` | 输入框（自适应增高，最多 76px）+ 圆形发送按钮 |
| `.pet-dialog-foot` | 「派发新任务」→ 派发弹窗；「查看通知」→ 通知中心 |
| `.pet-badge` | 未读角标（>9 显示 `9+`），打开对话框即清零 |

**交互**：`Enter` 发送、`Shift+Enter` 换行；发送后显示「正在输入…」→ 延迟 0.4–0.8s → **打字机逐字输出**（每 26ms 补若干字符，长文提速）。

**消息语气**（通知消息左侧色条）：`info` 紫 · `success` 绿 · `warn` 黄 · `danger` 珊瑚。

### 聊天大脑（`Pet.answer()`）
纯本地规则引擎，**只读 `Engine`/`MODELS` 的实时状态**作答，不调用任何外部 API：

| 意图 | 关键词 | 回答内容 |
| --- | --- | --- |
| 问候 | 你好 / hi / 嗨 | 自我介绍 |
| Token | token / 消耗 / 用量 | 输入·输出·合计·成本·完成数 |
| 成本 | 成本 / 花了 / 费用 | 累计花费 + 云端分项 + 最高花费模型 |
| 余额 | 余额 / 额度 / 够不够 | 云端剩余、本地上下文占用、<15% 告警 |
| 任务 | 任务 / 在跑 / 进度 | 运行中 + 排队中列表 |
| 失败 | 失败 / 报错 | 失败任务清单 |
| 模型 | 模型 / gpt / claude… | 接入模型清单 |
| 派发 | 派发 / 帮我做 | 延迟 0.6s 打开派发弹窗 |
| 帮助 | 帮助 / 能做什么 | 能力清单 |
| 兜底 | — | 引导到有效提问 |

> 匹配顺序：**失败 > 任务**（否则「失败的任务」会被任务分支截胡）；更具体的意图优先。

### 与通知系统的关系（自建，无第三方）
`Notifier.add()` 是唯一通知入口 → 它调用 `Pet.notify()` 把通知转成对话消息。因此**所有通知自动出现在桌宠对话框**，无需在业务代码里重复调用；新增通知类型只需走 `Notifier.add()`。

---

## 14. 外部 Agent 接入（Hook 总线）

> 借鉴 **Clawd on Desk**：桌宠不只是「主动调用」，也是「状态接收端」。
> **不读你的 API Key** —— 只接收状态事件。

### 架构
```
外部 Agent (Claude Code / opencode / 任意脚本)
    │  POST http://127.0.0.1:8900/api/hook
    ↓
proxy.js  Hook 状态总线
    │  ├─ 校验 state（12 种白名单）→ 非法落回 idle
    │  ├─ 写入 hookHistory（最近 100 条，Trajectory）
    │  └─ SSE 广播
    ↓
浏览器  EventSource  /api/hook/stream
    ↓
UI.setBotMoodFromHook() → 桌宠切表情 + 冒气泡
```

### 接口
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/hook` | 推状态。body: `{ state, label?, detail?, source? }` |
| `GET` | `/api/hook` | 查当前状态 + 12 种可选状态 |
| `GET` | `/api/hook/history` | Trajectory：最近 100 条状态流 |
| `GET` | `/api/hook/stream` | SSE 订阅（连上先推当前状态，20s 心跳） |

### 用法
```bash
node hook.js writing "正在修改 app.js" "第 1200 行"
node hook.js error "构建失败" "exit code 1"
```
```js
const { pushState } = require("./hook.js");
pushState("running", { label: "跑测试", source: "my-agent" });
```

### 12 种状态 → 情绪映射
| 外部状态 | mood | 表情 |
| --- | --- | --- |
| idle | idle | 无 |
| thinking / typing / reading / writing / running / building / testing / searching | active | `• •` |
| waiting | warn | `> <` |
| done | happy | `^ ^` |
| error | error | 珊瑚 `× ×` |

### 优先级与让位
**外部 hook（6 秒有效）> 用户暂停 > 引擎失败 > 运行中 > 排队 > 额度告警 > 完成 > 待命。**
- `updateBotVoice()` 在 `_hookActive` 时**不抢话筒**
- 外部状态 6 秒无更新 → `_hookActive = false`，自动交回本地引擎
- 只有 `done` / `error` / `waiting` 三个节点冒气泡（避免每个 delta 都弹）
- 连接状态显示在侧栏 `.side-src`（`body.hook-connected`）


### 无障碍
- 机器人本体、对话框按钮均为原生 `<button>`，带 `aria-label`。
- 消息列表 `role="log" aria-live="polite"`，新消息自动播报；`#petLive` 同步朗读。
- 未读角标 `aria-hidden`（信息已在消息列表与朗读中）。
- 窄屏（≤760px）隐藏桌宠，避免遮挡内容。
- `prefers-reduced-motion` 下关闭所有走动/呼吸动画。
