import { loadConfig } from "./config.js";
import { run } from "./scheduler.js";
import { launch, newContext, saveStorage } from "./browser.js";

const [cmd, ...args] = process.argv.slice(2);
const cfg = loadConfig();

if (cmd === "login") {
  const browser = await launch({ headless: false });
  const acc = cfg.accounts[0];
  const ctx = await newContext(browser, acc);
  const page = await ctx.newPage();
  await page.goto(cfg.targets[0].url, { waitUntil: "domcontentloaded" });
  const wi = args.indexOf("--wait");
  const waitSec = wi >= 0 ? (Number(args[wi + 1]) || 120) : null;
  if (waitSec) {
    console.log(`请在浏览器中完成登录，${waitSec} 秒后自动保存登录态…`);
    await new Promise((r) => setTimeout(r, waitSec * 1000));
  } else {
    console.log("请在浏览器中完成登录（扫码/短信），完成后回到终端按回车保存登录态…");
    await new Promise((res) => process.stdin.once("data", res));
  }
  await saveStorage(ctx, acc);
  await browser.close();
  console.log("登录态已保存，可运行：npm run monitor");
} else if (cmd === "run") {
  const i = args.indexOf("--mode");
  if (i >= 0) cfg.mode = args[i + 1];
  console.log(`[run] 模式=${cfg.mode}`);
  const ac = new AbortController();
  process.on("SIGINT", () => ac.abort());
  const { results } = await run(cfg, { signal: ac.signal });
  console.log("结果:", JSON.stringify(results, null, 2));
} else {
  console.log("用法：node src/index.js login | run --mode monitor|semi|full");
}
