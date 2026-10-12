/* =========================================================================
 * 一键启动：静态站点 + API 代理
 *   node start.js
 * 会同时起：
 *   - http://127.0.0.1:8899  前端
 *   - http://127.0.0.1:8900  API 代理
 * ========================================================================= */
const { spawn } = require("child_process");
const path = require("path");

const cwd = __dirname;
const procs = [];

function run(name, file) {
  const p = spawn(process.execPath, [path.join(cwd, file)], { cwd, stdio: "inherit" });
  p.on("exit", (code) => console.log(`[${name}] 退出，code=${code}`));
  procs.push(p);
  return p;
}

console.log("启动 Lingo 调度台（前端 8899 + 代理 8900）...\n");
run("server", "server.js");
run("proxy", "proxy.js");

process.on("SIGINT", () => {
  procs.forEach((p) => { try { p.kill(); } catch (_) {} });
  process.exit(0);
});
