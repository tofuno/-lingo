/**
 * 自动校时：对齐平台/公共服务器时间，避免本地时钟偏差。
 * 返回 offset(ms) = 服务器时间 - 本地时间。
 */
let offsetMs = 0;

export async function syncTime(source = "taobao") {
  try {
    const url = source === "taobao"
      ? "https://acs.m.taobao.com/gw/mtop.common.getTimestamp/"
      : "https://api.bilibili.com/x/report/click/now";
    const t0 = Date.now();
    const res = await fetch(url);
    const t1 = Date.now();
    const j = await res.json().catch(() => null);
    let serverMs = null;
    if (j?.data?.t) serverMs = Number(j.data.t);
    else if (j?.data?.now) serverMs = Number(j.data.now) * 1000;
    if (!serverMs) {
      console.warn("[time] 取服务器时间失败，使用本地时钟");
      return offsetMs;
    }
    offsetMs = serverMs - Math.round((t0 + t1) / 2);
    console.log(`[time] 已校准，偏差 ${offsetMs} ms（服务器 - 本地）`);
  } catch (e) {
    console.warn("[time] 校时失败:", e.message);
  }
  return offsetMs;
}

export function now() { return Date.now() + offsetMs; }
export function offset() { return offsetMs; }
