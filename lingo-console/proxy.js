/* =========================================================================
 * Lingo 本地代理服务 (proxy.js)
 * -------------------------------------------------------------------------
 * 为什么需要它？
 *   浏览器直连 OpenAI/Anthropic 会撞 CORS，而且会把 API Key 暴露在前端。
 *   所以把「密钥 + 真实请求」放在这个 Node 进程里，前端只跟 127.0.0.1 说话。
 *
 * 支持协议：
 *   - openai    : OpenAI 兼容 /v1/chat/completions（DeepSeek / Qwen / Moonshot / 智谱…）
 *   - anthropic : Anthropic /v1/messages
 *   - ollama    : 本地 Ollama /api/chat（无需 key）
 *
 * 配置（环境变量，或用 config.json）：
 *   OPENAI_API_KEY / OPENAI_BASE_URL
 *   ANTHROPIC_API_KEY
 *   OLLAMA_BASE_URL（默认 http://127.0.0.1:11434）
 *   PROXY_PORT（默认 8900）
 *
 * 启动：node proxy.js
 * ========================================================================= */

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = Number(process.env.PROXY_PORT || 8900);
const CONFIG_FILE = path.join(__dirname, "config.json");
// 密钥文件（单独一份，权限更严，且必定被 gitignore）
const SECRET_FILE = path.join(__dirname, ".secrets.json");

/* ------------------------- Hook 状态总线 -------------------------
 * 借鉴 Clawd on Desk：桌宠不只是「主动调用」，还能「被接入」。
 * 任何外部 agent（Claude Code / opencode / 你自己的脚本）都可以 POST 状态过来，
 * 桌宠实时切换表情 + 冒气泡。用 SSE 广播给所有打开的前端。
 * -----------------------------------------------------------------*/
const hookClients = new Set();   // { res }
let hookState = {
  state: "idle",
  label: "待命",
  detail: "",
  source: "system",
  ts: Date.now(),
};
const hookHistory = [];          // 最近 100 条，供 Trajectory 视图
const HOOK_MAX_BODY = 32 * 1024; // 限制请求体，防滥用

// 允许的 state → 前端会映射到 12 种动画
const HOOK_STATES = new Set([
  "idle", "thinking", "typing", "reading", "writing", "running",
  "building", "testing", "searching", "waiting", "done", "error",
]);

function broadcastHook(evt) {
  const payload = "data: " + JSON.stringify(evt) + "\n\n";
  for (const client of hookClients) {
    try { client.res.write(payload); } catch (_) { hookClients.delete(client); }
  }
}

/* ------------------------- 配置加载 -------------------------
 * 优先级（高 → 低）：
 *   1. 环境变量            （最安全，密钥不落盘）
 *   2. .secrets.json       （单独文件，必定 gitignore）
 *   3. config.json         （便携配置，非密钥字段放这里）
 * -----------------------------------------------------------------*/
function readJSON(file, label) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.warn(`[config] ${label} 解析失败：`, e.message);
  }
  return {};
}

function loadConfig() {
  const fileCfg = readJSON(CONFIG_FILE, "config.json");
  const secretCfg = readJSON(SECRET_FILE, ".secrets.json");
  const fp = fileCfg.providers || {};
  const sp = secretCfg.providers || {};
  const pick = (...vals) => vals.find((v) => typeof v === "string" && v.trim()) || "";
  const base = (...vals) => vals.find((v) => typeof v === "string" && v.trim()) || "";

  return {
    openai: {
      baseUrl: base(process.env.OPENAI_BASE_URL, sp.openai?.baseUrl, fp.openai?.baseUrl, "https://api.openai.com"),
      apiKey: pick(process.env.OPENAI_API_KEY, sp.openai?.apiKey, fp.openai?.apiKey),
    },
    anthropic: {
      baseUrl: base(process.env.ANTHROPIC_BASE_URL, sp.anthropic?.baseUrl, fp.anthropic?.baseUrl, "https://api.anthropic.com"),
      apiKey: pick(process.env.ANTHROPIC_API_KEY, sp.anthropic?.apiKey, fp.anthropic?.apiKey),
    },
    // 智谱（GLM-4V 识图）—— 走 OpenAI 兼容协议
    zhipu: {
      baseUrl: base(process.env.ZHIPU_BASE_URL, sp.zhipu?.baseUrl, fp.zhipu?.baseUrl, "https://open.bigmodel.cn/api/paas/v4"),
      apiKey: pick(process.env.ZHIPU_API_KEY, sp.zhipu?.apiKey, fp.zhipu?.apiKey),
    },
    // 阿里百炼（通义千问 VL 识图）—— 也走 OpenAI 兼容协议
    dashscope: {
      baseUrl: base(process.env.DASHSCOPE_BASE_URL, sp.dashscope?.baseUrl, fp.dashscope?.baseUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1"),
      apiKey: pick(process.env.DASHSCOPE_API_KEY, sp.dashscope?.apiKey, fp.dashscope?.apiKey),
    },
    ollama: {
      baseUrl: base(process.env.OLLAMA_BASE_URL, sp.ollama?.baseUrl, fp.ollama?.baseUrl, "http://127.0.0.1:11434"),
    },
  };
}
let CONFIG = loadConfig();

/* ------------------------- Skill 注册表 -------------------------
 * 让桌宠能「调用 skill」—— 就像 opencode / Claude Code 那样。
 *
 * 两类来源：
 *   1. 外部 skill 库（只读）：用户已有的 .agents/.codex/.dsh skills 目录
 *      —— 从 SKILL.md 的 YAML frontmatter 里读 name/description
 *   2. 项目自建 skill：<项目>/skills/<id>/SKILL.md
 *
 * 三种 skill 能力等级（决定执行权限）：
 *   read      只读：可以读数据、生成文本，不改任何状态
 *   dispatch  派发：可以往调度台派发真实任务（需要用户授权，像 Codex）
 *   write     写入：可以改文件等（当前未开放，预留）
 *
 * 安全：
 *   - SKILL.md 内容有长度上限，超长截断
 *   - 只允许扫描白名单目录，路径做穿越校验
 *   - skill 正文不会自动注入；只有「命中」时才把指令拼进 system prompt
 * -----------------------------------------------------------------*/
const SKILL_BODY_MAX = 24 * 1024;   // 单个 skill 正文上限
let SKILL_CACHE = null;             // [{ id, name, description, scope, file, body }]

/**
 * 计算最终要扫描的目录列表：
 *   1. 内置 4 个（project / agents / codex / dsh）
 *   2. config.json 或 .secrets.json 里的 skillDirs（可选，字符串或 {dir,scope}）
 *   3. 环境变量 LINGO_SKILL_DIRS（分号分隔）
 * —— 自定义目录排在前面，同名 skill 优先用自定义的。
 */
function skillDirs() {
  const base = [
    { dir: path.join(__dirname, "skills"), scope: "project" },
    { dir: "C:\\Users\\wyx15\\.agents\\skills", scope: "agents" },
    { dir: "C:\\Users\\wyx15\\.codex\\skills", scope: "codex" },
    { dir: "C:\\Users\\wyx15\\.dsh\\skills", scope: "dsh" },
  ];
  const fileCfg = readJSON(CONFIG_FILE, "config.json");
  const secretCfg = readJSON(SECRET_FILE, ".secrets.json");
  const extraRaw = [
    ...(Array.isArray(fileCfg.skillDirs) ? fileCfg.skillDirs : []),
    ...(Array.isArray(secretCfg.skillDirs) ? secretCfg.skillDirs : []),
    ...String(process.env.LINGO_SKILL_DIRS || "").split(";").map((s) => s.trim()).filter(Boolean),
  ];
  const extra = extraRaw
    .map((e, i) =>
      typeof e === "string"
        ? { dir: e, scope: "custom" + (i || "") }
        : e && e.dir ? { dir: e.dir, scope: e.scope || "custom" + (i || "") } : null
    )
    .filter(Boolean)
    .map((e) => ({ dir: path.resolve(e.dir.replace(/^~/, require("os").homedir())), scope: e.scope }));
  // 去重（同一路径只扫一次）
  const seen = new Set();
  return [...extra, ...base].filter((d) => {
    const k = path.resolve(d.dir).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// 极简 YAML frontmatter 解析（只需要 name / description / argument-hint）
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const fm = {};
  if (m) {
    m[1].split(/\r?\n/).forEach((line) => {
      const kv = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
      if (kv) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
    });
  }
  const body = m ? text.slice(m[0].length).trim() : text.trim();
  return { fm, body };
}

function scanSkills() {
  const list = [];
  const seen = new Set();
  for (const { dir, scope } of skillDirs()) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const file = path.join(dir, e.name, "SKILL.md");
      // 目录穿越防护：必须仍在白名单目录内
      if (!path.resolve(file).startsWith(path.resolve(dir))) continue;
      let raw;
      try { raw = fs.readFileSync(file, "utf8"); } catch (_) { continue; }
      const { fm, body } = parseFrontmatter(raw);
      const id = (fm.name || e.name).trim();
      // 同名 skill 以先扫到的为准（自定义 > project > agents > codex > dsh）
      if (!id || seen.has(id)) continue;
      seen.add(id);
      list.push({
        id,
        name: fm.title || id,
        description: (fm.description || "").slice(0, 600),
        argumentHint: fm["argument-hint"] || "",
        level: ["read", "dispatch", "write"].includes(fm.level) ? fm.level : "read",
        scope,
        dir,
        file,
        bodyLen: body.length,
        body: body.slice(0, SKILL_BODY_MAX),
      });
    }
  }
  return list;
}

function getSkills() {
  if (!SKILL_CACHE) SKILL_CACHE = scanSkills();
  return SKILL_CACHE;
}

// 摘要（不含正文）—— 用于把「有哪些 skill」塞进 system prompt
function skillIndex() {
  return getSkills().map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    level: s.level,
    scope: s.scope,
    argumentHint: s.argumentHint,
    bodyLen: s.bodyLen,
  }));
}

/**
 * 关键词打分，自动挑最匹配的 skill（用户无感，按需注入）。
 * 用 description 里的英文词 + 中文触发词一起算，简单但够用。
 */
function matchSkills(query, limit = 2) {
  const q = String(query || "").toLowerCase();
  if (!q) return [];
  const terms = q.split(/[\s,，。、；;!！?？]+/).filter((t) => t.length >= 2);
  const scored = [];
  for (const s of getSkills()) {
    const hay = (s.id + " " + s.description).toLowerCase();
    let score = 0;
    // 完整 id 直接命中：最高优先级
    if (q.includes(s.id.toLowerCase())) score += 100;
    for (const t of terms) {
      if (t.length < 2) continue;
      if (hay.includes(t)) score += t.length >= 4 ? 6 : 3;
    }
    // description 里的关键词命中（英文单词边界）
    for (const w of s.description.toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/)) {
      if (w.length < 4) continue;
      if (q.includes(w)) score += 4;
    }
    if (score > 0) scored.push({ skill: s, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.skill);
}

/* ------------------------- 工具 ------------------------- */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { ...CORS, "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("请求体过大")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/* ------------------------- 协议适配 ------------------------- */
/**
 * 统一入参（前端只发这一种格式）：
 * {
 *   provider: "openai" | "anthropic" | "ollama",
 *   model: "gpt-4o-mini",
 *   messages: [{ role: "system"|"user"|"assistant", content: "..." }],
 *   tools: [...],        // 可选，OpenAI 工具格式（会自动转换成各家的）
 *   stream: true
 * }
 */

// ---- 把统一的消息/工具转成 OpenAI 格式（本身即是）----
function toOpenAI(req) {
  return {
    model: req.model,
    messages: req.messages,
    stream: true,
    ...(req.tools && req.tools.length ? { tools: req.tools } : {}),
  };
}

// ---- 转 Anthropic：system 要单独抽出来，tool 结果要用 user + tool_result ----
// 多模态：OpenAI 的 {type:"image_url", image_url:{url}} → Anthropic 的 {type:"image", source:{...}}
function openAIContentToAnthropic(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  const out = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text") {
      out.push({ type: "text", text: String(part.text ?? "") });
    } else if (part.type === "image_url") {
      const url = part.image_url && part.image_url.url ? part.image_url.url : "";
      const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(url);
      if (m) {
        out.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
      } else if (url) {
        out.push({ type: "image", source: { type: "url", url } });
      }
    }
  }
  return out.length ? out : "";
}

function toAnthropic(req) {
  const sys = req.messages.filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .filter(Boolean).join("\n\n");
  const msgs = req.messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      if (m.role === "tool") {
        return { role: "user", content: [{ type: "tool_result", tool_use_id: m.tool_call_id, content: String(m.content ?? "") }] };
      }
      return { role: m.role === "assistant" ? "assistant" : "user", content: openAIContentToAnthropic(m.content) };
    });
  const out = { model: req.model, max_tokens: 2048, messages: msgs, stream: true };
  if (sys) out.system = sys;
  if (req.tools && req.tools.length) {
    out.tools = req.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));
  }
  return out;
}

// ---- 转 Ollama（/api/chat）----
function toOllama(req) {
  return { model: req.model, messages: req.messages, stream: true };
}

/* ------------------------- 上游请求 ------------------------- */
function buildUpstream(provider, body) {
  if (provider === "openai") {
    const c = CONFIG.openai;
    return {
      url: c.baseUrl.replace(/\/$/, "") + "/v1/chat/completions",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.apiKey}` },
      payload: toOpenAI(body),
    };
  }
  if (provider === "anthropic") {
    const c = CONFIG.anthropic;
    return {
      url: c.baseUrl.replace(/\/$/, "") + "/v1/messages",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": c.apiKey,
        "anthropic-version": "2023-06-01",
      },
      payload: toAnthropic(body),
    };
  }
  if (provider === "ollama") {
    const c = CONFIG.ollama;
    return {
      url: c.baseUrl.replace(/\/$/, "") + "/api/chat",
      headers: { "Content-Type": "application/json" },
      payload: toOllama(body),
    };
  }
  // 智谱 / 阿里百炼：都是 OpenAI 兼容协议，只是 baseUrl 和 key 不同
  if (provider === "zhipu" || provider === "dashscope") {
    const c = CONFIG[provider];
    return {
      url: c.baseUrl.replace(/\/$/, "") + "/chat/completions",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.apiKey}` },
      payload: toOpenAI(body),
    };
  }
  throw new Error("未知 provider: " + provider);
}

/* ------------------------- SSE 流式转发 -------------------------
 * 把各家的流统一成前端最好处理的格式（每行一个 JSON）：
 *   {"type":"delta","text":"..."}        文本增量
 *   {"type":"tool","name":"...","args":{}} 工具调用
 *   {"type":"usage","input":n,"output":n} token 用量
 *   {"type":"done"}                       结束
 *   {"type":"error","message":"..."}      错误
 * -----------------------------------------------------------------*/
function emit(res, obj) {
  res.write("data: " + JSON.stringify(obj) + "\n\n");
}

// OpenAI 的 SSE：data: {...}\n\n ... data: [DONE]
function pipeOpenAI(res, upstreamRes, usage) {
  let buf = "";
  upstreamRes.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    const parts = buf.split("\n\n");
    buf = parts.pop();
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let j;
      try { j = JSON.parse(data); } catch { continue; }
      const d = j.choices && j.choices[0] && j.choices[0].delta;
      if (!d) continue;
      if (d.content) emit(res, { type: "delta", text: d.content });
      // 思考过程（DeepSeek-R1 / V4 等会流式吐）：单独转发，
      // 前端据此把「思考 token」也计入实时估算，否则数字会严重偏低。
      if (d.reasoning_content) emit(res, { type: "reasoning", text: d.reasoning_content });
      if (d.tool_calls) {
        for (const tc of d.tool_calls) {
          emit(res, {
            type: "tool_call",
            index: tc.index,
            id: tc.id,
            name: tc.function && tc.function.name,
            args: tc.function && tc.function.arguments,
          });
        }
      }
      if (j.usage) usage.set(j.usage.prompt_tokens || 0, j.usage.completion_tokens || 0);
    }
  });
}

// Anthropic 的 SSE：event: xxx\ndata: {...}
function pipeAnthropic(res, upstreamRes, usage) {
  let buf = "";
  upstreamRes.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    const parts = buf.split("\n\n");
    buf = parts.pop();
    for (const part of parts) {
      const dataLine = part.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      let j;
      try { j = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
      if (j.type === "content_block_delta" && j.delta) {
        if (j.delta.type === "text_delta") emit(res, { type: "delta", text: j.delta.text });
        if (j.delta.type === "input_json_delta") emit(res, { type: "tool_args", index: j.index, args: j.delta.partial_json });
      }
      if (j.type === "content_block_start" && j.content_block && j.content_block.type === "tool_use") {
        emit(res, { type: "tool_call", index: j.index, id: j.content_block.id, name: j.content_block.name });
      }
      if (j.type === "message_start" && j.message && j.message.usage) usage.set(j.message.usage.input_tokens || 0, 0);
      if (j.type === "message_delta" && j.usage) usage.set(null, j.usage.output_tokens || 0);
    }
  });
}

// Ollama 的 NDJSON：一行一个 JSON
function pipeOllama(res, upstreamRes, usage) {
  let buf = "";
  upstreamRes.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    const parts = buf.split("\n");
    buf = parts.pop();
    for (const line of parts) {
      const t = line.trim();
      if (!t) continue;
      let j;
      try { j = JSON.parse(t); } catch { continue; }
      if (j.message && j.message.content) emit(res, { type: "delta", text: j.message.content });
      if (j.prompt_eval_count || j.eval_count) usage.set(j.prompt_eval_count || 0, j.eval_count || 0);
    }
  });
}

/* ------------------------- 账户余额查询 -------------------------
 * 各家的余额接口不一样，这里做适配。返回统一结构：
 *   { supported: bool, configured: bool, currency, total, granted, topped_up, raw }
 * ---------------------------------------------------------------- */
const balanceCache = new Map();   // key -> { at, data }

async function queryBalance(provider, c) {
  const base = c.baseUrl.replace(/\/$/, "");

  if (provider === "openai") {
    // DeepSeek 官方：/user/balance
    // 若 baseUrl 是 api.deepseek.com 就走 DeepSeek 协议；
    // 真 OpenAI 的余额接口路径不同，这里一并试一下。
    const isDeepSeek = /deepseek/i.test(base);
    if (isDeepSeek) {
      const r = await fetch(base + "/user/balance", {
        headers: { Authorization: `Bearer ${c.apiKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(6000),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        throw new Error(`HTTP ${r.status} ${String(t).slice(0, 160)}`);
      }
      const j = await r.json();
      const infos = Array.isArray(j.balance_infos) ? j.balance_infos : [];
      // 官方固定返回 CNY/USD；优先 CNY（充值通常是人民币），否则 USD，再否则第一条。
      // 参考 CodexBar：把「充值余额(paid)」和「赠金(granted)」分开标注。
      const pick = infos.find((x) => x.currency === "CNY") || infos.find((x) => x.currency === "USD") || infos[0] || null;
      return {
        supported: true,
        configured: true,
        available: !!j.is_available,          // 账户是否够余额可调用
        currency: pick ? pick.currency : "",
        total: pick ? Number(pick.total_balance) : null,
        granted: pick ? Number(pick.granted_balance) : null,      // 未过期赠金
        topped_up: pick ? Number(pick.topped_up_balance) : null,  // 自己充的钱
        // 全币种明细，界面可切换
        all: infos.map((x) => ({
          currency: x.currency,
          total: Number(x.total_balance),
          granted: Number(x.granted_balance),
          topped_up: Number(x.topped_up_balance),
        })),
        source: "deepseek /user/balance",
      };
    }
    // 其它 OpenAI 兼容服务：无统一接口
    return { supported: false, configured: true, reason: "该服务未提供公开的余额接口" };
  }

  if (provider === "anthropic" || provider === "zhipu" || provider === "dashscope") {
    return { supported: false, configured: !!c.apiKey, reason: "该厂商未提供公开的余额接口" };
  }
  if (provider === "ollama") {
    return { supported: false, configured: true, reason: "本地模型没有余额概念" };
  }
  return { supported: false, reason: "未知 provider" };
}

/* ---------------- 模型列表（自动发现） ----------------
 * 各 provider 的 OpenAI 兼容 /models；Ollama 用 /api/tags。
 * 只上报真实返回的模型，拿不到就带 error，绝不编造。
 * 结果缓存 5 分钟。
 * ------------------------------------------------------ */
const modelsCache = new Map();   // key -> { at, data }

async function queryModels(provider, c) {
  const base = c.baseUrl.replace(/\/$/, "");
  const isOllama = provider === "ollama";
  const r = await fetch(isOllama ? base + "/api/tags" : base + "/models", {
    headers: isOllama
      ? { Accept: "application/json" }
      : { Authorization: `Bearer ${c.apiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const arr = isOllama ? j.models || [] : j.data || [];
  return arr
    .map((x) => ({ id: x.id || x.model || x.name, name: x.name || x.id || x.model }))
    .filter((x) => x.id);
}

/* ---------------- 本机 AI 活动（opencode 等） ----------------
 * 只读 opencode 的本地库，列出「进行中 / 最近」的会话。
 * 判定「正在跑」：该会话最后一条 session_message 的 type 不是 idle。
 *   （不能用 time_updated > time_idle —— 已结束的会话也会因最后一次写入而满足）
 * 库不存在 / 打不开 / Node 不支持 sqlite → available:false，前端照实显示，不编造。
 * ------------------------------------------------------------ */
const OC_DB = path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
const activityCache = { at: 0, data: null };

function queryOpencodeActivity() {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch (e) {
    return { available: false, reason: "当前 Node 不支持 node:sqlite（需 Node 22+）" };
  }
  if (!fs.existsSync(OC_DB)) return { available: false, reason: "未找到 opencode 数据库" };

  let db;
  try {
    db = new DatabaseSync(OC_DB, { readOnly: true });
  } catch (e) {
    return { available: false, reason: "数据库打不开：" + e.message };
  }

  try {
    const rows = db
      .prepare(
        `SELECT s.id, s.title, s.directory, s.model, s.cost,
                s.tokens_input, s.tokens_output, s.time_updated,
                (SELECT m.type FROM session_message m WHERE m.session_id = s.id ORDER BY m.seq DESC LIMIT 1) AS last_type
         FROM session_v2 s
         ORDER BY s.time_updated DESC
         LIMIT 40`
      )
      .all();

    const now = Date.now();
    // opencode 的时间戳是毫秒；兼容秒的情况
    const ms = (t) => { const n = Number(t) || 0; return n > 1e12 ? n : n * 1000; };

    // 按模型汇总（按 id 合并 variant，如 high/low）。
    // 占比用「输入+输出 token」而不是 cost：opencode 的价表缺某些模型的价格
    // （deepseek-chat 的 cost 记成 0），用 cost 会把占比全压给另一个模型。
    const byModelRows = db
      .prepare(
        `SELECT model, SUM(tokens_input) AS input, SUM(tokens_output) AS output,
                SUM(cost) AS cost, COUNT(*) AS sessions
         FROM session_v2 GROUP BY model`
      )
      .all();
    const merged = new Map();
    for (const r of byModelRows) {
      let mid = "";
      try { const m = JSON.parse(r.model); mid = (m && m.id) || ""; } catch (_) {}
      if (!mid) continue;
      const cur = merged.get(mid) || { id: mid, input: 0, output: 0, cost: 0, sessions: 0 };
      cur.input += r.input || 0;
      cur.output += r.output || 0;
      cur.cost += r.cost || 0;
      cur.sessions += r.sessions || 0;
      merged.set(mid, cur);
    }
    const byModel = [...merged.values()];

    // 历史总计（全部会话）：token 与成本，供「历史总共消耗」展示
    const t = db
      .prepare(
        `SELECT COUNT(*) AS sessions,
                COALESCE(SUM(tokens_input),0)      AS input,
                COALESCE(SUM(tokens_output),0)     AS output,
                COALESCE(SUM(tokens_reasoning),0)  AS reasoning,
                COALESCE(SUM(tokens_cache_read),0) AS cacheRead,
                COALESCE(SUM(cost),0)              AS cost,
                MIN(time_created) AS firstAt,
                MAX(time_updated) AS lastAt
         FROM session_v2`
      )
      .get();
    const totals = {
      sessions: t.sessions || 0,
      input: t.input || 0,
      output: t.output || 0,
      reasoning: t.reasoning || 0,
      cacheRead: t.cacheRead || 0,
      cost: t.cost || 0,
      firstAt: ms(t.firstAt),
      lastAt: ms(t.lastAt),
    };

    const sessions = rows.map((r) => {
      let model = null;
      try { model = JSON.parse(r.model); } catch (_) {}
      const mid = model && model.id ? model.id : "";
      return {
        id: r.id,
        title: r.title || "(无标题)",
        directory: r.directory || "",
        model: mid ? mid + (model.variant ? " · " + model.variant : "") : "",
        status: r.last_type && r.last_type !== "idle" ? "running" : "idle",
        input: r.tokens_input || 0,
        output: r.tokens_output || 0,
        cost: r.cost || 0,
        updatedAt: ms(r.time_updated),
        ageMs: now - ms(r.time_updated),
      };
    });

    return { available: true, source: "opencode", sessions, byModel, totals };
  } catch (e) {
    return { available: false, reason: "查询失败：" + e.message };
  } finally {
    try { db.close(); } catch (_) {}
  }
}

/* ---------------- 汇率（把 CNY 余额换算成 USD 显示） ----------------
 * 只做展示换算：金额本身仍以厂商返回的原始币种为准，这里只负责换算显示。
 * 缓存 12 小时；拿不到就返回 error，前端回落显示原币种 —— 绝不编造汇率。
 * -------------------------------------------------------------------- */
let fxCache = { at: 0, key: "", data: null };

async function queryFx(from, to) {
  const r = await fetch(`https://open.er-api.com/v6/latest/${encodeURIComponent(from)}`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  const rate = j && j.rates && j.rates[to];
  if (typeof rate !== "number") throw new Error("返回里没有 " + to + " 汇率");
  return { from, to, rate, updated: j.time_last_update_utc || "" };
}

/* ---------------- 累计已花（服务端持久化） ----------------
 * 「花了多少钱」由余额下降量推算（厂商无消费接口），必须存在服务端 ——
 * 放浏览器 localStorage 会因换 profile / 清缓存而丢失。
 *
 * 存 data/spend.json。规则：
 *   余额比上次少 → 差额累加进 spent
 *   余额比上次多（充值）→ 只更新基准，不计入花费
 * 前端每次拿到真实余额就 POST 一次，服务端做唯一累加（避免多窗口重复计数）。
 * ------------------------------------------------------------ */
const SPEND_FILE = path.join(__dirname, "data", "spend.json");
let spendState = null;

function loadSpendState() {
  if (spendState) return spendState;
  try {
    const j = JSON.parse(fs.readFileSync(SPEND_FILE, "utf8"));
    spendState = j && typeof j === "object" ? j : {};
  } catch (_) {
    spendState = {};
  }
  // 本机最早观测到的余额（2026-10-13 实测 DeepSeek ¥39.67）与当时已累计的花费。
  // 厂商不提供消费历史，用这份观测值当起点，之后的下降都会自动累加。
  if (!spendState.openai) spendState.openai = { currency: "CNY", last: 39.67, spent: 30.42 };
  return spendState;
}

function saveSpendState() {
  try {
    fs.mkdirSync(path.dirname(SPEND_FILE), { recursive: true });
    fs.writeFileSync(SPEND_FILE, JSON.stringify(spendState, null, 2), "utf8");
  } catch (_) {}
}

function trackSpend(provider, total, currency) {
  const st = loadSpendState();
  const s = st[provider] || (st[provider] = { currency, last: null, spent: 0, topUps: 0 });
  if (typeof s.last === "number" && total < s.last) {
    s.spent += s.last - total;
  } else if (typeof s.last === "number" && total > s.last) {
    // 余额上升 = 充值 → 自动计入累计充值（不用人工改配置）
    s.topUps = (s.topUps || 0) + (total - s.last);
  }
  s.last = total;
  if (currency) s.currency = currency;
  saveSpendState();
  return s;
}

/* ---------------- 自动统计配置（累计充值基线） ----------------
 * DeepSeek 没有用量接口，但「花了多少钱」可以自动算出来：
 *     累计消费 = 累计充值 − 当前余额
 * 累计充值 = 用户提供的基线（$20+$20+¥800）+ 之后自动识别的充值（余额上升）。
 * 余额由前端每次拉取后 POST 上来，存在 spend.json，因此无需人工维护。
 * ------------------------------------------------------------- */
const BASELINE_FILE = path.join(__dirname, "data", "usage-baseline.json");
let baselineState = null;

function loadBaseline() {
  if (baselineState) return baselineState;
  try {
    const j = JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8"));
    baselineState = j && typeof j === "object" ? j : {};
  } catch (_) {
    baselineState = {};
  }
  return baselineState;
}

// 基线充值额（CNY）：多币种按配置里的汇率折算
function baselineTopUpCNY(b) {
  const rate = b.usdToCny || 6.7003;
  let cny = 0;
  for (const t of b.topUps || []) {
    if (!t || typeof t.amount !== "number") continue;
    cny += (t.currency === "USD") ? t.amount * rate : t.amount;
  }
  return cny;
}

// opencode 库的 token 总量（输入 + 输出 + 缓存读）—— 自动来源
function opencodeTokenTotal() {
  try {
    const { DatabaseSync } = require("node:sqlite");
    if (!fs.existsSync(OC_DB)) return null;
    const d = new DatabaseSync(OC_DB, { readOnly: true });
    const r = d
      .prepare(
        `SELECT COALESCE(SUM(tokens_input),0)      AS i,
                COALESCE(SUM(tokens_output),0)     AS o,
                COALESCE(SUM(tokens_cache_read),0) AS c
         FROM session_v2`
      )
      .get();
    d.close();
    return { input: r.i, output: r.o, cacheRead: r.c, total: r.i + r.o + r.c };
  } catch (_) {
    return null;
  }
}

/* ------------------------- 路由 ------------------------- */
const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];

  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }

  // 健康检查 / 能力探测：前端用它决定「真实模式」还是「演示模式」
  if (url === "/api/health") {
    // Ollama 没密钥，得主动探一下它是否真的在跑（带短超时，避免拖慢健康检查）
    let ollamaUp = false;
    try {
      const r = await fetch(CONFIG.ollama.baseUrl.replace(/\/$/, "") + "/api/tags", {
        signal: AbortSignal.timeout(1200),
      });
      ollamaUp = r.ok;
    } catch (_) { ollamaUp = false; }

    return sendJSON(res, 200, {
      ok: true,
      providers: {
        openai: { configured: !!CONFIG.openai.apiKey, baseUrl: CONFIG.openai.baseUrl },
        anthropic: { configured: !!CONFIG.anthropic.apiKey, baseUrl: CONFIG.anthropic.baseUrl },
        zhipu: { configured: !!CONFIG.zhipu.apiKey, baseUrl: CONFIG.zhipu.baseUrl },
        dashscope: { configured: !!CONFIG.dashscope.apiKey, baseUrl: CONFIG.dashscope.baseUrl },
        ollama: { configured: ollamaUp, baseUrl: CONFIG.ollama.baseUrl, reachable: ollamaUp },
      },
      time: Date.now(),
    });
  }

  /* ---------------- 账户余额 ----------------
   * DeepSeek: GET {baseUrl}/user/balance  （Bearer 你的 apiKey）→ 真实余额
   * 结果缓存 60 秒，避免前端每次刷新都打一次。
   * 其他厂商若没有公开余额接口，返回 { supported: false }，前端显示「不支持查询」。
   * -------------------------------------------- */
  if (url === "/api/balance") {
    const provider = (new URL("http://x" + req.url)).searchParams.get("provider") || "openai";
    const c = CONFIG[provider];
    if (!c) return sendJSON(res, 200, { supported: false, reason: "未知 provider" });
    if (!c.apiKey && provider !== "ollama") {
      return sendJSON(res, 200, { supported: true, configured: false, reason: "未配置密钥" });
    }
    // 缓存
    const key = provider + "|" + (c.apiKey || "").slice(-6);
    const hit = balanceCache.get(key);
    if (hit && Date.now() - hit.at < 60000) {
      return sendJSON(res, 200, { ...hit.data, cached: true, at: hit.at });
    }
    let data;
    try {
      data = await queryBalance(provider, c);
    } catch (e) {
      return sendJSON(res, 200, { supported: true, configured: true, error: e.message });
    }
    balanceCache.set(key, { at: Date.now(), data });
    return sendJSON(res, 200, { ...data, cached: false, at: Date.now() });
  }

  /* ---------------- 模型列表（自动发现） ----------------
   * 一次拉全部 provider：已配密钥的查 /models，没配的返回 configured:false。
   * 单个 provider 失败不影响其它（各自带 error）。
   * ------------------------------------------------------ */
  if (url === "/api/models") {
    const out = {};
    await Promise.all(
      Object.entries(CONFIG).map(async ([p, c]) => {
        if (p !== "ollama" && !c.apiKey) {
          out[p] = { configured: false, models: [] };
          return;
        }
        const key = p + "|" + (c.apiKey || "").slice(-6);
        const hit = modelsCache.get(key);
        if (hit && Date.now() - hit.at < 300000) {
          out[p] = { ...hit.data, cached: true };
          return;
        }
        try {
          const models = await queryModels(p, c);
          const data = { configured: true, models };
          modelsCache.set(key, { at: Date.now(), data });
          out[p] = data;
        } catch (e) {
          out[p] = { configured: true, models: [], error: e.message };
        }
      })
    );
    return sendJSON(res, 200, { providers: out });
  }

  /* ---------------- 本机 AI 活动 ----------------
   * 前端每 5 秒轮询；这里缓存 3 秒，避免重复开库。
   * ---------------------------------------------- */
  if (url === "/api/opencode/activity") {
    if (activityCache.data && Date.now() - activityCache.at < 3000) {
      return sendJSON(res, 200, activityCache.data);
    }
    const data = queryOpencodeActivity();
    activityCache.at = Date.now();
    activityCache.data = data;
    return sendJSON(res, 200, data);
  }

  /* ---------------- 汇率（展示换算用） ---------------- */
  if (url === "/api/fx") {
    const q = new URL("http://x" + req.url).searchParams;
    const from = (q.get("from") || "CNY").toUpperCase();
    const to = (q.get("to") || "USD").toUpperCase();
    const key = from + ">" + to;
    if (fxCache.data && fxCache.key === key && Date.now() - fxCache.at < 12 * 3600 * 1000) {
      return sendJSON(res, 200, { ...fxCache.data, cached: true });
    }
    try {
      const d = await queryFx(from, to);
      fxCache = { at: Date.now(), key, data: d };
      return sendJSON(res, 200, { ...d, cached: false });
    } catch (e) {
      return sendJSON(res, 200, { from, to, error: e.message });
    }
  }

  /* ---------------- 累计已花（服务端持久化） ---------------- */
  if (url === "/api/spend") {
    if (req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          const b = JSON.parse(raw || "{}");
          if (typeof b.total === "number") {
            trackSpend(b.provider || "openai", b.total, b.currency || "CNY");
          }
        } catch (_) { /* 坏请求就忽略，保留原状态 */ }
        sendJSON(res, 200, { providers: loadSpendState() });
      });
      return;
    }
    return sendJSON(res, 200, { providers: loadSpendState() });
  }

  /* ---------------- 自动统计（累计充值 − 当前余额） ----------------
   * 全部自动：充值额来自配置基线 + 自动识别的后续充值；余额来自 spend.json
   * （前端每次拉取余额后 POST 上来）。token 来自 opencode 库。
   * 官方控制台数字仅作参考返回，不参与计算。
   * ---------------------------------------------------------------- */
  if (url === "/api/baseline") {
    const b = loadBaseline();
    const sp = loadSpendState();
    const s = sp.openai || {};

    const baseTopUp = baselineTopUpCNY(b);
    const autoTopUp = s.topUps || 0;
    const topUpCNY = baseTopUp + autoTopUp;
    const balanceCNY = typeof s.last === "number" ? s.last : null;
    const consumedCNY = balanceCNY == null ? null : Math.max(0, topUpCNY - balanceCNY);

    const oc = opencodeTokenTotal();
    const ref = b.reference || {};

    return sendJSON(res, 200, {
      topUp: { baseline: baseTopUp, auto: autoTopUp, total: topUpCNY },
      balanceCNY,
      consumedCNY,
      opencodeTokens: oc ? oc.total : null,
      opencodeBreakdown: oc ? { input: oc.input, output: oc.output, cacheRead: oc.cacheRead } : null,
      reference: {
        tokens30d: ref.tokens30d || null,
        requests30d: ref.requests30d || null,
        observedAt: ref.observedAt || "",
      },
    });
  }

  // 重新加载配置（改完 config.json 不用重启）
  if (url === "/api/reload") {
    CONFIG = loadConfig();
    SKILL_CACHE = null;   // 顺便重扫 skill 目录
    modelsCache.clear();  // 模型列表也重拉
    return sendJSON(res, 200, { ok: true, openai: !!CONFIG.openai.apiKey, anthropic: !!CONFIG.anthropic.apiKey });
  }

  /* ---------------- Skill 注册表 ---------------- */

  // 列出所有可用 skill（摘要）
  if (url === "/api/skills" && req.method === "GET") {
    const skills = getSkills();
    return sendJSON(res, 200, {
      count: skills.length,
      sources: skillDirs().map((d) => ({ dir: d.dir, scope: d.scope })),
      skills: skillIndex(),
    });
  }

  // 读取某个 skill 全文（供桌宠按需注入）
  if (url.startsWith("/api/skills/") && req.method === "GET") {
    const id = decodeURIComponent(url.slice("/api/skills/".length));
    const s = getSkills().find((x) => x.id === id);
    if (!s) return sendJSON(res, 404, { error: "没有这个 skill: " + id });
    return sendJSON(res, 200, s);
  }

  // 关键词匹配（前端也可以本地匹配，这个主要用于调试）
  if (url === "/api/skills/match" && req.method === "POST") {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (e) { return sendJSON(res, 400, { error: "body 必须是 JSON" }); }
    const hits = matchSkills(body.query || "", body.limit || 2);
    return sendJSON(res, 200, { query: body.query, hits: hits.map((s) => ({ id: s.id, description: s.description })) });
  }

  // 主动重扫 skill 目录（刚往 skills/ 里放了新 skill，不用重启）
  if (url === "/api/skills/reload" && req.method === "POST") {
    SKILL_CACHE = null;
    const n = getSkills().length;
    return sendJSON(res, 200, { ok: true, count: n });
  }

  /* ---------------- Hook 状态总线 ---------------- */

  // 外部 agent 推送状态：POST /api/hook
  // body: { state, label?, detail?, source? }
  if (url === "/api/hook" && req.method === "POST") {
    let raw;
    try { raw = await readBody(req, HOOK_MAX_BODY); }
    catch (e) { return sendJSON(res, 413, { error: e.message }); }

    let body;
    try { body = JSON.parse(raw || "{}"); }
    catch (e) { return sendJSON(res, 400, { error: "body 必须是 JSON" }); }

    const state = HOOK_STATES.has(body.state) ? body.state : "idle";
    hookState = {
      state,
      label: String(body.label ?? "").slice(0, 80),
      detail: String(body.detail ?? "").slice(0, 400),
      source: String(body.source ?? "external").slice(0, 40),
      ts: Date.now(),
    };
    const evt = { type: "state", ...hookState };
    hookHistory.push(evt);
    if (hookHistory.length > 100) hookHistory.shift();
    broadcastHook(evt);
    return sendJSON(res, 200, { ok: true, state: hookState.state });
  }

  // 查询当前状态
  if (url === "/api/hook" && req.method === "GET") {
    return sendJSON(res, 200, { current: hookState, states: [...HOOK_STATES] });
  }

  // Trajectory：历史状态流
  if (url === "/api/hook/history") {
    return sendJSON(res, 200, { history: hookHistory });
  }

  // SSE 订阅：前端连上后，外部 agent 每次推状态都会实时收到
  if (url === "/api/hook/stream") {
    res.writeHead(200, {
      ...CORS,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    // 连上先推当前状态
    res.write("data: " + JSON.stringify({ type: "state", ...hookState }) + "\n\n");
    const client = { res };
    hookClients.add(client);
    // 心跳，防代理超时断连
    const hb = setInterval(() => { try { res.write(": ping\n\n"); } catch (_) {} }, 20000);
    req.on("close", () => { clearInterval(hb); hookClients.delete(client); });
    return;
  }

  // 主对话入口（流式）
  if (url === "/api/chat" && req.method === "POST") {
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (e) { return sendJSON(res, 400, { error: "body 解析失败: " + e.message }); }

    if (!body.provider || !body.model) return sendJSON(res, 400, { error: "缺少 provider 或 model" });

    // 没配 key 的云厂商 → 明确告知前端走演示模式
    const KEY_ENV = {
      openai: "OPENAI_API_KEY",
      anthropic: "ANTHROPIC_API_KEY",
      zhipu: "ZHIPU_API_KEY",
      dashscope: "DASHSCOPE_API_KEY",
    };
    if (KEY_ENV[body.provider] && !CONFIG[body.provider].apiKey) {
      const name = { openai: "OpenAI 兼容", anthropic: "Anthropic", zhipu: "智谱", dashscope: "阿里百炼" }[body.provider] || body.provider;
      return sendJSON(res, 200, {
        error: "not_configured",
        provider: body.provider,
        hint: `未配置 ${KEY_ENV[body.provider]}（${name}），前端将使用演示模式`,
      });
    }

    let up;
    try { up = buildUpstream(body.provider, body); }
    catch (e) { return sendJSON(res, 400, { error: e.message }); }

    res.writeHead(200, {
      ...CORS,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const usage = { input: 0, output: 0, set(i, o) { if (i != null) this.input = i; if (o != null) this.output = o; } };

    let upstreamRes;
    try {
      upstreamRes = await fetch(up.url, {
        method: "POST",
        headers: up.headers,
        body: JSON.stringify(up.payload),
      });
    } catch (e) {
      emit(res, { type: "error", message: `无法连接上游 ${body.provider}：${e.message}` });
      emit(res, { type: "done" });
      return res.end();
    }

    if (!upstreamRes.ok) {
      const txt = await upstreamRes.text().catch(() => "");
      emit(res, { type: "error", message: `${body.provider} 返回 ${upstreamRes.status}：${txt.slice(0, 400)}` });
      emit(res, { type: "done" });
      return res.end();
    }

    // Node 的 fetch 返回 web ReadableStream → 转成 Node 流
    const { Readable } = require("stream");
    const nodeStream = Readable.fromWeb(upstreamRes.body);

    if (body.provider === "openai") pipeOpenAI(res, nodeStream, usage);
    else if (body.provider === "anthropic") pipeAnthropic(res, nodeStream, usage);
    else pipeOllama(res, nodeStream, usage);

    nodeStream.on("end", () => {
      if (usage.input || usage.output) emit(res, { type: "usage", input: usage.input, output: usage.output });
      emit(res, { type: "done" });
      res.end();
    });
    nodeStream.on("error", (e) => {
      emit(res, { type: "error", message: "流读取失败：" + e.message });
      emit(res, { type: "done" });
      res.end();
    });
    // 客户端断开 → 停掉上游
    req.on("close", () => { try { nodeStream.destroy(); } catch (_) {} });
    return;
  }

  // 非流式单次调用（给工具调用等场景用）
  if (url === "/api/complete" && req.method === "POST") {
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (e) { return sendJSON(res, 400, { error: "body 解析失败: " + e.message }); }
    let up;
    try { up = buildUpstream(body.provider, body); up.payload.stream = false; }
    catch (e) { return sendJSON(res, 400, { error: e.message }); }
    try {
      const r = await fetch(up.url, { method: "POST", headers: up.headers, body: JSON.stringify(up.payload) });
      const txt = await r.text();
      res.writeHead(r.status, { ...CORS, "Content-Type": "application/json; charset=utf-8" });
      return res.end(txt);
    } catch (e) {
      return sendJSON(res, 502, { error: "上游请求失败：" + e.message });
    }
  }

  sendJSON(res, 404, { error: "not found", routes: ["/api/health", "/api/chat", "/api/complete", "/api/reload", "/api/skills", "/api/skills/:id", "/api/skills/match", "/api/hook", "/api/hook/stream", "/api/hook/history"] });
});

server.listen(PORT, "127.0.0.1", async () => {
  console.log(`Lingo 代理已启动: http://127.0.0.1:${PORT}`);
  console.log(`  OpenAI   : ${CONFIG.openai.apiKey ? "已配置 key" : "未配置（演示模式）"}  ${CONFIG.openai.baseUrl}`);
  console.log(`  Anthropic: ${CONFIG.anthropic.apiKey ? "已配置 key" : "未配置（演示模式）"}`);
  let ollamaUp = false;
  try {
    const r = await fetch(CONFIG.ollama.baseUrl.replace(/\/$/, "") + "/api/tags", { signal: AbortSignal.timeout(1200) });
    ollamaUp = r.ok;
  } catch (_) {}
  console.log(`  Ollama   : ${ollamaUp ? "已就绪" : "未检测到（未启动）"}  ${CONFIG.ollama.baseUrl}`);
  if (!CONFIG.openai.apiKey && !CONFIG.anthropic.apiKey && !ollamaUp) {
    console.log("\n  ⚠️  未配置任何密钥 → 前端将使用「演示模式」");
    console.log("     配置：node setkey.js deepseek    （或设置 OPENAI_API_KEY 环境变量）\n");
  }
});
