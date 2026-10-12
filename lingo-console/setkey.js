/* =========================================================================
 * 安全写入密钥（setkey.js）
 * -------------------------------------------------------------------------
 * 密钥不写进代码、不写进聊天记录，只落到 .secrets.json（已 gitignore）。
 *
 * 用法：
 *   node setkey.js deepseek            # 交互式输入（推荐，不会留在命令行历史）
 *   node setkey.js deepseek sk-xxx     # 直接传（会留在 shell 历史里）
 *   node setkey.js openai sk-xxx
 *   node setkey.js anthropic sk-ant-xxx
 *   node setkey.js show                # 查看当前配置了哪些（key 只显示前 6 位）
 *   node setkey.js clear               # 清空
 *
 * 也支持环境变量（更安全，建议长期用这个）：
 *   Windows:  set OPENAI_API_KEY=sk-xxx   （当前会话）
 *             setx OPENAI_API_KEY sk-xxx  （永久，需重开终端）
 *   macOS/Linux: export OPENAI_API_KEY=sk-xxx
 * ========================================================================= */
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const FILE = path.join(__dirname, ".secrets.json");

const PRESETS = {
  deepseek: { provider: "openai", baseUrl: "https://api.deepseek.com" },
  openai: { provider: "openai", baseUrl: "https://api.openai.com" },
  moonshot: { provider: "openai", baseUrl: "https://api.moonshot.cn" },
  // 识图（多模态）——
  zhipu: { provider: "zhipu", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
  glm: { provider: "zhipu", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
  dashscope: { provider: "dashscope", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  qwen: { provider: "dashscope", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  anthropic: { provider: "anthropic", baseUrl: "https://api.anthropic.com" },
};

function load() {
  try {
    if (fs.existsSync(FILE)) return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch (e) {
    console.error("读取 .secrets.json 失败：", e.message);
  }
  return { providers: {} };
}

function save(cfg) {
  fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2), { encoding: "utf8", mode: 0o600 });
  console.log("已写入 " + FILE);
}

function mask(k) {
  if (!k) return "（未设置）";
  if (k.length <= 10) return k.slice(0, 3) + "***";
  return k.slice(0, 6) + "..." + k.slice(-4) + `（共 ${k.length} 位）`;
}

const [cmd, arg] = process.argv.slice(2);

if (!cmd || cmd === "help") {
  console.log(`用法：
  node setkey.js deepseek [key]     # DeepSeek 官方（推荐，文本对话）
  node setkey.js glm      [key]     # 智谱 GLM-4V（识图 / 多模态）
  node setkey.js qwen     [key]     # 阿里通义千问 VL（识图）
  node setkey.js openai   [key]     # OpenAI
  node setkey.js moonshot [key]     # Moonshot
  node setkey.js anthropic[key]     # Claude
  node setkey.js show               # 查看已配置
  node setkey.js clear              # 清空

不给 key 参数时会交互式询问（不会留在命令行历史里）。`);
  process.exit(0);
}

if (cmd === "show") {
  const cfg = load();
  const p = cfg.providers || {};
  console.log("当前 .secrets.json：");
  for (const name of ["openai", "anthropic", "ollama"]) {
    if (p[name]) console.log(`  ${name.padEnd(10)} baseUrl=${p[name].baseUrl || "-"}  key=${mask(p[name].apiKey)}`);
  }
  if (!Object.keys(p).length) console.log("  （空）");
  console.log("\n环境变量：");
  console.log("  OPENAI_API_KEY    " + mask(process.env.OPENAI_API_KEY));
  console.log("  ANTHROPIC_API_KEY " + mask(process.env.ANTHROPIC_API_KEY));
  console.log("\n优先级：环境变量 > .secrets.json > config.json");
  process.exit(0);
}

if (cmd === "clear") {
  save({ providers: {} });
  console.log("已清空。");
  process.exit(0);
}

const preset = PRESETS[cmd];
if (!preset) {
  console.error(`未知服务 "${cmd}"。可用：${Object.keys(PRESETS).join(", ")}`);
  process.exit(1);
}

function store(key) {
  // 只保留可打印 ASCII：raw 模式下 Ctrl+V（0x16）等控制字符会混进粘贴内容，
  // 带进 Authorization 头会导致 "不是有效的控制字符" 报错。
  const clean = String(key || "").replace(/[^\x21-\x7E]/g, "");
  if (!clean) { console.error("key 不能为空"); process.exit(1); }
  const cfg = load();
  cfg.providers = cfg.providers || {};
  cfg.providers[preset.provider] = {
    baseUrl: preset.baseUrl,
    apiKey: clean,
  };
  save(cfg);
  console.log(`${cmd} 配置完成（provider=${preset.provider}, baseUrl=${preset.baseUrl}）`);
  console.log("key: " + mask(clean));
  console.log("\n访问 http://127.0.0.1:8900/api/reload 让代理立即生效（不用重启）");
}

if (arg) {
  store(arg);
} else {
  // 交互式输入：不回显
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  process.stdout.write(`请输入 ${cmd} 的 API Key（不会显示，也不会留在命令行历史）：`);
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  if (stdin.isTTY) stdin.setRawMode(true);
  let buf = "";
  const onData = (ch) => {
    const s = ch.toString();
    if (s === "\r" || s === "\n" || s === "\u0004") {
      process.stdout.write("\n");
      stdin.removeListener("data", onData);
      if (stdin.isTTY) stdin.setRawMode(wasRaw);
      rl.close();
      store(buf);
      return;
    }
    if (s === "\u0003") { process.stdout.write("\n已取消\n"); process.exit(1); }
    if (s === "\u007f" || s === "\b") { buf = buf.slice(0, -1); return; }
    buf += s;
  };
  stdin.on("data", onData);
}
