/* Lingo 抢购控制台 · 最小 Service Worker
 *
 * 作用：
 *   1. 让 PWA 真正可安装（Chrome 要求 manifest + Service Worker + fetch 处理）
 *   2. 断网时仍能打开界面（抢购现场网络常不稳）
 *
 * 策略：
 *   - 同源 GET：网络优先，成功就顺手更新缓存；失败回落缓存 → 界面永远最新，离线有兜底
 *   - /api/*：永不缓存，抢购状态必须是实时的
 */
const CACHE = "lingo-tg-v1";
const SHELL = ["./", "./index.html"];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {})
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match("./index.html")))
  );
});
