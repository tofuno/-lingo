const { app, BrowserWindow, shell, dialog } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const PORT = "8787";
let server = null;

function startServer() {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };

  // 只有打包后才改默认行为，开发态与以前完全一致
  if (app.isPackaged) {
    // 程序目录（resources/app）只读：配置 / 登录态 / 截图都写到用户目录
    const dataDir = app.getPath("userData");
    fs.mkdirSync(dataDir, { recursive: true });
    env.LINGO_DATA_DIR = dataDir;
    // 用 Windows 自带 Edge（同为 Chromium 内核），免去额外下载 150MB 浏览器
    env.LINGO_CHANNEL = env.LINGO_CHANNEL || "msedge";
    console.log("[main] data dir:", dataDir);
  }

  server = spawn(process.execPath, [path.join(root, "src", "server.js")], {
    cwd: root,
    stdio: "inherit",
    env,
  });
  server.on("exit", (code) => console.log("[server] exited", code));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 840,
    minWidth: 380,
    title: "Lingo · 抢购助手",
    icon: path.join(__dirname, "icon.ico"),
    backgroundColor: "#0e1018",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true },
  });

  win.loadURL(`http://localhost:${PORT}/`);
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("did-fail-load", () => {
    dialog.showErrorBox(
      "后端没起来",
      `无法连接 http://localhost:${PORT}/\n\n可能原因：端口被占用，或 src/server.js 启动失败。\n请看控制台日志。`
    );
  });
  return win;
}

// 单实例：避免开多个窗口抢同一个端口
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) {
      if (w.isMinimized()) w.restore();
      w.focus();
    }
  });

  app.whenReady().then(() => {
    app.setAppUserModelId("com.lingo.ticketgrabber");
    startServer();
    setTimeout(createWindow, 1200);
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    try { server && server.kill(); } catch (e) { /* ignore */ }
    app.quit();
  });
}
