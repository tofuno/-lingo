/**
 * 平台适配公共层
 * 各平台只提供 profile（可购/休息/下单/支付 的正则），由 makeActions 生成统一动作。
 * 不含验证码绕过、签名伪造、风控规避。
 */
export function makeActions(profile) {
  const p = profile;

  async function openTarget(ctx, target) {
    const page = await ctx.newPage();
    page.setDefaultTimeout(p.timeout || 8000);
    await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(600);
    console.log(`[${p.id}] 已打开：${target.item || target.url}`);
    return page;
  }

  async function clickText(page, re, timeout = 5000) {
    const el = page.getByText(re).first();
    if (await el.count().catch(() => 0)) {
      await el.click({ timeout }).catch(() => {});
      return true;
    }
    return false;
  }

  async function checkAvailability(page, target) {
    let html = "";
    try { html = await page.content(); } catch { /* ignore */ }
    const available = p.buyable.test(html) && !p.rest.test(html);
    const slotHit = (target.slots || []).some((s) => html.includes(String(s).slice(0, 5)));
    return { available, slotHit };
  }

  async function submitOrder(page, target, slot) {
    try {
      if (slot) await clickText(page, new RegExp(String(slot).replace(/[-:]/g, "[-:]?").slice(0, 5)));
      await clickText(page, p.buy);
      await page.waitForTimeout(400);
      const submitted = await clickText(page, p.submit);
      const html = await page.content().catch(() => "");
      const orderNo = (html.match(/订单号[:：]?\s*([A-Za-z0-9]+)/) || [])[1] || null;
      return { ok: submitted, orderNo, slot };
    } catch (e) {
      return { ok: false, error: e.message, slot };
    }
  }

  async function pay(page) {
    const ok = await clickText(page, p.pay);
    if (ok) console.log(`[${p.id}] 已点击支付（如弹出验证，需人工完成）`);
    return ok;
  }

  async function close(page) { try { await page.close(); } catch { /* ignore */ } }

  return { openTarget, checkAvailability, submitOrder, pay, close, meta: { id: p.id, name: p.name } };
}
