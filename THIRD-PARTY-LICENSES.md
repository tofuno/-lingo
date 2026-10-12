# 第三方资源与授权

本项目内置/依赖的第三方资源与各自授权如下。对外分发（例如打包成 exe 分发）时请一并保留本文件。

## 像素字体（`public/assets/fonts/`）

| 字体 | 作者 | 授权 | 用途 |
|------|------|------|------|
| Fusion Pixel 12px Proportional SC | TakWolf | **SIL Open Font License 1.1** | 正文 / 中文（12px 点阵） |
| Silkscreen | Jason Kottke | SIL Open Font License 1.1 | 备用拉丁像素字体 |
| Press Start 2P | CodeMan38 | SIL Open Font License 1.1 | HUD 大数字 |

- Fusion Pixel 上游：https://github.com/TakWolf/fusion-pixel-font
- 经过 npm 分发：`@fontsource/fusion-pixel-12px-proportional-sc`、`@fontsource/silkscreen`、`@fontsource/press-start-2p`
- OFL-1.1 允许免费使用、修改、**随软件一起分发**（含商业用途），条件是保留授权声明、不得单独售卖字体本身。

## 品牌素材（`public/assets/`、`desktop/icon.ico`）

Lingo 商标、机器人形象（`lingo-lockup*.png`、`robot*.png`、`icon-*.ico/png`）版权归 Lingo 所有。

## 运行时依赖

| 依赖 | 授权 |
|------|------|
| Electron | MIT |
| Playwright | Apache-2.0 |

## 系统组件

打包后的应用通过 Playwright 的 `msedge` 通道驱动 **Microsoft Edge**（Windows 10/11 自带），不分发其二进制。
