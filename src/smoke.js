import { loadConfig } from "./config.js";
import { launch, newContext } from "./browser.js";
import { getPlatform } from "./platforms/index.js";

const cfg = loadConfig();
const target = cfg.targets[0];
const platform = getPlatform(cfg.platform);
const browser = await launch({ headless: true });
const ctx = await newContext(browser, cfg.accounts?.[0]);

try {
  const page = await platform.openTarget(ctx, target);
  await page.waitForTimeout(2500);
  const title = await page.title();
  const finalUrl = page.url();
  const avail = await platform.checkAvailability(page, target);
  await page.screenshot({ path: "data/smoke.png", fullPage: false });
  console.log(JSON.stringify({ platform: platform.meta, title, finalUrl, avail }, null, 2));
} catch (e) {
  console.error("[smoke] 失败:", e.message);
} finally {
  await browser.close().catch(() => {});
}
