/* =========================================================================
 * 给外部 agent 用的 hook 推送脚本（借鉴 Clawd on Desk 的接入方式）
 * -------------------------------------------------------------------------
 * 用法（命令行）：
 *   node hook.js thinking "正在分析需求"
 *   node hook.js writing "修改 app.js"
 *   node hook.js done
 *
 * 用法（代码里）：
 *   const { pushState } = require("./hook.js");
 *   pushState("running", { label: "跑测试", detail: "pytest -q", source: "my-agent" });
 *
 * 可选环境变量：
 *   PROXY_URL（默认 http://127.0.0.1:8900）
 *
 * 12 种状态：
 *   idle thinking typing reading writing running
 *   building testing searching waiting done error
 * ========================================================================= */
const PROXY = process.env.PROXY_URL || "http://127.0.0.1:8900";

const STATES = [
  "idle", "thinking", "typing", "reading", "writing", "running",
  "building", "testing", "searching", "waiting", "done", "error",
];

async function pushState(state, opts = {}) {
  if (!STATES.includes(state)) {
    throw new Error(`未知状态 "${state}"，可用：${STATES.join(" ")}`);
  }
  const body = {
    state,
    label: opts.label || "",
    detail: opts.detail || "",
    source: opts.source || "hook-cli",
  };
  const r = await fetch(PROXY + "/api/hook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

module.exports = { pushState, STATES };

// 直接命令行调用
if (require.main === module) {
  const [state, label, detail] = process.argv.slice(2);
  if (!state) {
    console.log("用法: node hook.js <state> [label] [detail]");
    console.log("状态: " + STATES.join(" "));
    process.exit(1);
  }
  pushState(state, { label, detail })
    .then((r) => console.log("已推送:", JSON.stringify(r)))
    .catch((e) => { console.error("推送失败:", e.message); process.exit(1); });
}
