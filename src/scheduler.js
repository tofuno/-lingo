import { launch, newContext, saveStorage } from "./browser.js";
import { syncTime } from "./time-sync.js";
import { notify } from "./notify.js";
import { getPlatform } from "./platforms/index.js";

/**
 * 调度：多账号 × 多时段，全部抢满 · 抢到即转场 · 循环重试
 * mode: monitor(只通知) | semi(提交订单) | full(提交+付款)
 */
export async function run(cfg, { signal, onLog } = {}) {
  const log = (m) => { console.log(m); onLog?.(m); };
  const platform = getPlatform(cfg.platform);

  if (cfg.timeSync?.enabled) await syncTime(cfg.timeSync.source || "taobao");
  const browser = await launch({ headless: cfg.browser?.headless ?? false });
  const results = [];

  try {
    for (const target of cfg.targets || []) {
      const pending = new Set(target.slots?.length ? target.slots : ["默认"]);
      const accounts = (cfg.accounts || []).filter(
        (a) => !target.accounts || target.accounts.includes(a.id),
      );
      log(`[task] 目标「${target.item}」待抢 ${pending.size} 段 · 账号 ${accounts.length} 个`);

      await Promise.all(accounts.map(async (acc) => {
        const ctx = await newContext(browser, acc);
        const page = await platform.openTarget(ctx, target);
        try {
          while (pending.size > 0 && !signal?.aborted) {
            const slot = pending.values().next().value;
            const { available } = await platform.checkAvailability(page, target);
            if (!available) { await page.waitForTimeout(target.intervalMs || 800); continue; }

            if (cfg.mode === "monitor") {
              await notify(cfg, "有票/可预约", `${target.item} · ${slot}`);
              pending.delete(slot);
              continue;
            }
            const r = await platform.submitOrder(page, target, slot);
            if (r.ok) {
              results.push({ target: target.id, slot, account: acc.id, orderNo: r.orderNo });
              pending.delete(slot); // 抢到即转场
              log(`[ok] ${acc.id} 抢到「${slot}」单号 ${r.orderNo || "-"}`);
              await notify(cfg, "已提交订单", `${target.item} · ${slot}`);
              if (cfg.mode === "full") { await platform.pay(page); log(`[pay] ${acc.id} 已尝试付款`); }
            } else {
              await page.waitForTimeout(target.intervalMs || 800);
            }
          }
        } finally {
          await saveStorage(ctx, acc);
          await platform.close(page).catch(() => {});
          await ctx.close().catch(() => {});
        }
      }));
      log(`[task] 目标「${target.item}」完成：成功 ${results.length} 段`);
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return { results };
}
