# 抢购工具 · 落地方案

多平台抢购 / 余票监控工具。**先做有赞 H5**，架构可扩展到 大麦 / 猫眼 / 淘票票 / 缤玩岛（Web/H5）与抖音（真机）。

> ⚠️ 合规边界：本工具**不实现**验证码绕过、签名伪造、风控规避、批量代抢。默认以
> **纯监控提醒**为主，**下单/付款需显式开启**，并自行承担平台条款与法律风险。

## 架构

```
ticket-grabber/
├── package.json
├── desktop/                 # Electron 壳（打包成 exe）
│   ├── main.cjs             # 主进程：起后端 + 开窗口
│   └── icon.ico
├── public/                  # 控制台（像素风 · 移动端可用 · PWA 可安装）
│   ├── index.html
│   └── assets/              # Lingo 商标 / 桌宠 / 像素字体
├── data/                    # 开发态：登录态(storageState)、截图
└── src/
    ├── config.js            # 读写 config.json（打包后自动落到用户目录）
    ├── browser.js           # Playwright 上下文 / 登录态 / 浏览器通道
    ├── time-sync.js         # 对齐服务器时间
    ├── notify.js            # 通知（Webhook / 微信）
    ├── scheduler.js         # 任务调度（多账号 × 多时段，抢到即转场）
    ├── platforms/           # 各平台适配（有赞优先）
    ├── index.js             # CLI（login / run）
    └── server.js            # 控制台后端（HTTP + API）
```

## 三种模式（合规模式）

| 模式 | 行为 | 风险 |
|------|------|------|
| `monitor` | 只监控余票/开售 → 通知 + 跳转，**不下单** | 最低 |
| `semi` | 自动监控 + **自动提交订单**，不自动付款 | 中 |
| `full` | 自动监控 + 自动提交 + **自动付款** | 最高（不保证支持）|

## 调度策略
- **多账号 × 多时段**：每个账号一个隔离上下文（storageState）
- **全部抢满 · 抢到即转场**：某账号抢到一个时段后，立即转去抢其他未完成时段
- **循环抢**：未成功则按间隔重试，直到全部抢满或手动停止

## 运行（开发态）

```bash
npm install            # 安装依赖（含 playwright）
npx playwright install chromium   # 首次安装浏览器
npm run login          # 扫码/手动登录有赞，保存登录态到 data/
npm start              # 启动控制台 http://localhost:8787
npm run app            # 或直接开桌面窗口（Electron）
npm run monitor        # 或直接跑纯监控
```

## 打包成 EXE

```bash
npm run dist     # 产出「安装包」+「免安装版」（都进 dist/）
npm run pack     # 只产出解包目录 dist/win-unpacked（调试用，最快）
```

产物：

| 文件 | 说明 |
|------|------|
| `dist/Lingo-TicketGrabber-<版本>-setup.exe` | NSIS 安装包：可选安装路径、建桌面/开始菜单快捷方式 |
| `dist/Lingo-TicketGrabber-<版本>-portable.exe` | 免安装单文件：首次启动自解压到临时目录（约 10–20s 才出窗口） |
| `dist/win-unpacked/Lingo抢购助手.exe` | 解包目录里直接双击（启动最快，推荐自用） |

打包后与开发态的差异（由 `desktop/main.cjs` 判断 `app.isPackaged` 切换）：

| | 开发态 | 打包后 |
|---|---|---|
| 配置 / 登录态 / 截图 | `src/config.json`、`./data/` | **`%APPDATA%\Lingo抢购助手\`**（程序目录只读，必须搬走；首次运行自动从 `config.example.json` 生成） |
| 浏览器 | 本地 chromium | **系统自带 Edge**（`channel: msedge`），免去额外下载 ~150MB |

打包注意事项：
- **国内网络必须走镜像**，否则会卡在下载 electron / nsis 资源：
  ```powershell
  $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
  $env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
  npm run dist
  ```
- **未配代码签名证书 → exe 未签名**：别的机器首次运行会被 SmartScreen 拦（点「更多信息 → 仍要运行」）。要消掉得买证书并配 `win.certificateFile` / `CSC_LINK`。
- 依赖 Edge（Win10/11 自带）。若被卸载，可在 `config.json` 里改 `browser.channel`，或改用本地 chromium。
- 打包用 `asar: false`（有意为之）：主进程需要把 `src/server.js` 作为子进程拉起，不用 asar 更省事、更好排障。

## 平台适配（后续）
- 有赞 / 大麦 / 猫眼 / 淘票票 / 缤玩岛：Web/H5 → Playwright 适配
- 抖音：App → 需真机自动化（AutoJS/Appium），另起模块

## 说明
- 登录态保存在 `data/*.json`（开发态）或 `%APPDATA%\Lingo抢购助手\data\`（打包后），**不要提交到仓库**。
- 监控请求频率遵循配置的 `intervalMs`，**建议 ≥ 500ms**，避免高频触发风控。
