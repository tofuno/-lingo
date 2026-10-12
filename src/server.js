import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { paths, loadConfig, saveConfig } from "./config.js";
import { run } from "./scheduler.js";

let current = null;
const publicDir = path.join(paths.root, "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const json = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(obj));
  };
  const body = () => new Promise((resolve) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => resolve(b));
  });

  (async () => {
   try {
    if (req.method === "GET" && url.pathname === "/api/status") {
      return json(200, { running: !!current, startedAt: current?.startedAt ?? null, offset: 0 });
    }
    if (req.method === "GET" && url.pathname === "/api/config") {
      return json(200, loadConfig());
    }
    if (req.method === "POST" && url.pathname === "/api/config") {
      try {
        const patch = JSON.parse((await body()) || "{}");
        saveConfig({ ...loadConfig(), ...patch });
        return json(200, { ok: true });
      } catch (e) { return json(400, { error: e.message }); }
    }
    if (req.method === "POST" && url.pathname === "/api/start") {
      if (current) return json(409, { error: "已有任务在运行" });
      const cfg = loadConfig();
      const patch = await body();
      if (patch) { try { Object.assign(cfg, JSON.parse(patch)); } catch { /* ignore */ } }
      const ac = new AbortController();
      current = { ac, startedAt: Date.now() };
      json(200, { ok: true, mode: cfg.mode });
      run(cfg, { signal: ac.signal }).catch((e) => console.error("[run]", e)).finally(() => { current = null; });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/stop") {
      current?.ac.abort(); current = null; return json(200, { ok: true });
    }
    // 静态文件
    const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
    const file = path.join(publicDir, rel);
    if (file.startsWith(publicDir) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
      return;
    }
    json(404, { error: "not found" });
   } catch (e) {
    try { json(500, { error: e.message }); } catch { /* ignore */ }
   }
  })();
});

process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));

server.listen(8787, () => {
  console.log("抢购控制台已启动：http://localhost:8787");
});
