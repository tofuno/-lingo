import fs from "node:fs";
import { chromium } from "playwright";
import { dataPath, loadConfig } from "./config.js";

/* 浏览器通道
 * 打包后不用额外下载 ~150MB 的 chromium，直接用 Windows 自带的 Edge
 * （同样是 Chromium 内核）。Electron 主进程会传 LINGO_CHANNEL=msedge。
 * 也可在 config.json 里写 browser.channel 覆盖。 */
function resolveChannel() {
  if (process.env.LINGO_CHANNEL) return process.env.LINGO_CHANNEL;
  try {
    return loadConfig().browser?.channel || undefined;
  } catch {
    return undefined;
  }
}

export async function launch({ headless = false } = {}) {
  const channel = resolveChannel();
  return chromium.launch(channel ? { headless, channel } : { headless });
}

/** 为某个账号创建隔离上下文，复用其登录态（storageState） */
export async function newContext(browser, account) {
  const state = account?.storage && fs.existsSync(dataPath(account.storage))
    ? dataPath(account.storage)
    : undefined;
  return browser.newContext({
    storageState: state,
    locale: "zh-CN",
    viewport: { width: 1280, height: 900 },
  });
}

export async function saveStorage(ctx, account) {
  if (!account?.storage) return;
  await ctx.storageState({ path: dataPath(account.storage) });
  console.log(`[browser] 已保存登录态 ${account.storage}`);
}
