/**
 * 通知：Webhook（企业微信/钉钉/自建皆可）+ 控制台日志
 * 不包含任何平台私密接口。
 */
export async function notify(cfg, title, text) {
  const n = cfg?.notify || {};
  console.log(`[notify] ${title} — ${text}`);
  if (!n.webhook) return;
  try {
    await fetch(n.webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, text, ts: Date.now() }),
    });
    console.log("[notify] webhook 已发送");
  } catch (e) {
    console.error("[notify] webhook 失败:", e.message);
  }
}
