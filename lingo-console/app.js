/* =========================================================================
 * Agent 调度台 —— 前端逻辑
 * 结构分层：
 *   1) MODELS       模型注册表（价格、额度、来源）
 *   2) DataSource   数据源抽象（当前为 mock，可替换成真实 API）
 *   3) Engine       Token 消耗 / 任务流引擎
 *   4) UI           渲染层（KPI、图表、额度、Agent 卡片）
 * ========================================================================= */

/* ------------------------- 1. 模型注册表 ------------------------- */
// 颜色通过 CSS 令牌引用（禁止裸 hex）——运行时从 :root 解析
// price: 每 1000 token 的美元单价 [输入, 输出]
// quota: 本地为上下文窗口占用；云端为账户余额
const TOKENS = {
  violet: "--lingo-violet-600",  // 活力紫
  coral: "--lingo-coral-500",    // 珊瑚红
  cyan: "--lingo-cyan-500",      // 充电蓝
  yellow: "--lingo-yellow-400",  // 透光黄
};

// 解析 CSS 变量为实际色值（供 Canvas / SVG 等无法使用 var() 的场景）
// 兜底值集中在此处（对应 styles.css 的 Semantic 层），避免散落各处
const TOKEN_FALLBACK = {
  "--color-data-in": "#13b8df",
  "--color-data-out": "#5b35c8",
  "--color-accent": "#fa554f",
  "--color-primary": "#5b35c8",
  "--color-success": "#1f9d63",
};
function tokenColor(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback || TOKEN_FALLBACK[name] || "#5b35c8";
}

/* ------------------------- 金额显示：统一换算成 USD -------------------------
 * 厂商给的余额是 CNY，项目统一按 USD 展示（官方价表也是 USD）。
 * 只换算「显示」——内部金额始终保留原始币种，避免来回换算累积误差。
 * 汇率来自本地代理 /api/fx（缓存 12h）；拿不到就回落显示原币种，绝不编汇率。
 * ------------------------------------------------------------------------- */
const Money = {
  TARGET: "USD",
  SYM: { CNY: "¥", USD: "$", EUR: "€" },
  usdPer: {},     // { CNY: 0.1492 }

  async load() {
    const froms = ["CNY"];   // 目前厂商只会返回 CNY
    await Promise.all(froms.map(async (f) => {
      try {
        const r = await fetch(`http://127.0.0.1:8900/api/fx?from=${f}&to=${this.TARGET}`,
          { signal: AbortSignal.timeout(9000) });
        const j = await r.json();
        if (typeof j.rate === "number") this.usdPer[f] = j.rate;
      } catch (_) { /* 拿不到就回落原币种显示 */ }
    }));
  },

  // 换算成 USD；拿不到汇率就原样返回（currency 不变）
  convert(amount, currency) {
    if (amount == null || !isFinite(amount)) return null;
    const cur = currency || "CNY";
    if (cur === this.TARGET) return { value: amount, currency: cur };
    const rate = this.usdPer[cur];
    if (typeof rate !== "number") return { value: amount, currency: cur };
    return { value: amount * rate, currency: this.TARGET };
  },

  fmt(amount, currency, digits = 2) {
    const c = this.convert(amount, currency);
    if (!c) return "—";
    return (this.SYM[c.currency] || (c.currency ? c.currency + " " : "")) + c.value.toFixed(digits);
  },

  // 说明当前显示单位（给 tooltip 用，讲清是换算值还是原始值）
  note(currency) {
    const c = currency || "CNY";
    if (c === this.TARGET) return "原始币种 USD";
    return typeof this.usdPer[c] === "number"
      ? `原始 ${c}，按实时汇率换算为 USD`
      : `原始 ${c}（汇率不可用，按原币种显示）`;
  },
};

/* ------------------------- 自动统计（累计充值 − 当前余额） -------------------------
 * DeepSeek 没有用量接口，但「花了多少钱」可以自动算出来：
 *     累计消费 = 累计充值 − 当前余额
 * 充值额 = 配置基线（人工提供的一次性数据）+ 之后自动识别的充值；
 * 余额由前端每次拉取后 POST 给代理，存在 spend.json。因此无需人工维护。
 * token 直接来自 opencode 库（自动）。官方控制台数字仅作参考。
 * 全部由本地代理 /api/baseline 算好返回。
 * ------------------------------------------------------------------------------- */
const Baseline = {
  url: "http://127.0.0.1:8900/api/baseline",
  data: null,

  async load() {
    try {
      const r = await fetch(this.url, { signal: AbortSignal.timeout(9000) });
      const j = await r.json();
      if (j && typeof j.consumedCNY === "number") this.data = j;
    } catch (_) { /* 拿不到就回落到本机记录 */ }
  },

  // 累计消费（CNY，自动）
  spend() {
    if (this.data && typeof this.data.consumedCNY === "number") {
      return { sum: this.data.consumedCNY, currency: "CNY" };
    }
    return Balance.totalSpent();
  },

  // 累计 token（自动，opencode 库）
  tokens() {
    return this.data && typeof this.data.opencodeTokens === "number" ? this.data.opencodeTokens : null;
  },
};

// 真实消费的统一入口：累计充值 − 当前余额（拿不到就回落到余额下降量）
function realSpend() { return Baseline.spend(); }

const MODELS = [
  {
    id: "deepseek-chat",
    name: "DeepSeek V3",
    vendor: "DeepSeek",
    location: "cloud",
    provider: "openai",              // 走 OpenAI 兼容协议
    apiModel: "deepseek-chat",
    colorToken: TOKENS.cyan,
    // 官方价：输入 $0.27 / 百万，输出 $1.10 / 百万（缓存未命中）
    price: [0.00027, 0.0011],
    // quota 由真实余额接口填充（见 Balance 模块），不再硬编码假数字
    quota: { used: 0, total: 0, unit: "" },
  },
  {
    id: "deepseek-reasoner",
    name: "DeepSeek R1",
    vendor: "DeepSeek",
    location: "cloud",
    provider: "openai",
    apiModel: "deepseek-reasoner",
    colorToken: TOKENS.violet,
    price: [0.00055, 0.00219],
    quota: { used: 0, total: 0, unit: "" },
  },
  {
    // 多模态：用于「识图」。配了密钥就能用，没配则识图走演示模式。
    id: "glm-4v",
    name: "GLM-4V",
    vendor: "智谱",
    location: "cloud",
    provider: "zhipu",           // 独立 provider，避免和文本模型共用 baseUrl
    apiModel: "glm-4v-flash",    // 免费档；也可换 glm-4v-plus
    colorToken: TOKENS.coral,
    price: [0.0001, 0.0001],     // 大致价，flash 免费
    quota: { used: 0, total: 0, unit: "" },
  },
];

// 识图默认用哪个模型（留空则自动挑第一个"像多模态且能跑"的）
// 想固定的话把它改成 MODELS 里的某个 id，例如 "glm-4v"
const VISION_MODEL_ID = "";

/* =====================================================================
 * Balance —— 账户真实余额
 * ---------------------------------------------------------------------
 * DeepSeek 有公开接口：GET {baseUrl}/user/balance（Bearer 你的 apiKey）
 *   → { is_available, balance_infos:[{currency,total_balance,...}] }
 * 前端通过本地代理 /api/balance 拿，代理端缓存 60 秒。
 *
 * 拿到的余额回填到对应模型的 m.quota，界面显示的就是真实数字。
 * 拿不到（厂商没接口/没配 key）→ supported:false，界面明确写「不支持查询」，
 *   **绝不显示编造的数字**。
 * ===================================================================== */
const Balance = {
  url: "http://127.0.0.1:8900",
  cache: {},          // provider -> data
  lastAt: 0,

  async fetch(provider) {
    try {
      const r = await fetch(this.url + "/api/balance?provider=" + encodeURIComponent(provider), {
        signal: AbortSignal.timeout(9000),
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      this.cache[provider] = j;
      return j;
    } catch (e) {
      const j = { supported: true, configured: true, error: e.message };
      this.cache[provider] = j;
      return j;
    }
  },

  // 把余额写回 MODELS 的 quota（这样所有渲染逻辑不用改）
  apply(provider, data) {
    const ms = MODELS.filter((m) => m.provider === provider);
    for (const m of ms) {
      if (data && data.supported && data.configured && typeof data.total === "number") {
        m.quota = { used: 0, total: data.total, spentApi: m.spent, unit: data.currency || "USD" };
        m.balance = data;
        m.balanceKnown = true;
      } else {
        m.balance = data || null;
        m.balanceKnown = false;
        m.quota = { used: 0, total: 0, unit: "" };
      }
    }
  },

  // 币种符号
  sym(cur) { return { CNY: "¥", USD: "$", EUR: "€" }[cur] || (cur ? cur + " " : ""); },

  // 把余额格式化成一行（参考 CodexBar：「¥60.26（充值 ¥60.26 / 赠金 ¥0.00）」）
  describe(b) {
    if (!b) return "—";
    if (b.error) return "查询失败";
    if (!b.configured) return "未配置密钥";
    if (b.supported === false) return b.reason || "该厂商无余额接口";
    if (typeof b.total !== "number") return "无数据";
    const s = this.sym(b.currency);
    const parts = [];
    if (typeof b.topped_up === "number" && b.topped_up > 0) parts.push(`充值 ${s}${b.topped_up.toFixed(2)}`);
    if (typeof b.granted === "number" && b.granted > 0) parts.push(`赠金 ${s}${b.granted.toFixed(2)}`);
    const tail = parts.length ? `（${parts.join(" / ")}）` : "";
    return `${s}${b.total.toFixed(2)}${tail}`;
  },

  // 刷新所有已配置 provider 的余额
  async refreshAll() {
    const providers = [...new Set(MODELS.map((m) => m.provider))];
    const res = await Promise.allSettled(providers.map((p) => this.fetch(p)));
    await Promise.all(providers.map((p, i) => {
      const d = res[i].status === "fulfilled" ? res[i].value : null;
      this.apply(p, d);
      return this.trackSpend(p, d);
    }));
    this.lastAt = Date.now();
    return this.cache;
  },

  /* ---------------- 累计已花（服务端持久化） ----------------
   * 「花了多少钱」由余额下降量推算，累加在服务端（data/spend.json）——
   * 放浏览器会因换 profile / 清缓存而丢，多窗口还会重复计数。
   * 前端只负责把每次拿到的真实余额 POST 上去，由服务端做唯一累加。
   * ------------------------------------------------------------- */
  spendUrl: "http://127.0.0.1:8900/api/spend",
  spend: {},

  async loadSpend() {
    try {
      const r = await fetch(this.spendUrl, { signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      if (j && j.providers) this.spend = j.providers;
    } catch (_) { /* 服务端不可用时保留本地镜像，不编造 */ }
  },

  async trackSpend(provider, data) {
    if (!data || !data.supported || !data.configured || typeof data.total !== "number") return;
    try {
      const r = await fetch(this.spendUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, total: data.total, currency: data.currency }),
        signal: AbortSignal.timeout(8000),
      });
      const j = await r.json();
      if (j && j.providers) this.spend = j.providers;
    } catch (_) { /* 失败就保留旧值 */ }
  },

  totalSpent() {
    let sum = 0, currency = "";
    for (const s of Object.values(this.spend)) {
      if (!s || typeof s.spent !== "number") continue;
      sum += s.spent;
      currency = currency || s.currency;
    }
    return { sum, currency };
  },
};

/* =====================================================================
 * Usage —— 用量历史（今天 / 本月）
 * ---------------------------------------------------------------------
 * CodexBar 的菜单卡会显示「今天的花费和 token、本月的花费和 token」。
 * 我们没有后台接口，就自己记账：每完成一个任务，把这一笔的
 * token / 花费累加到 localStorage，按「日期」和「月份」两个桶存。
 *
 * 结构： lingo.usage.v1 = {
 *   days:   { "2026-10-11": { in, out, cost, tasks, byModel:{id:{in,out,cost,tasks}} } },
 *   months: { "2026-10":     { in, out, cost, tasks } }
 * }
 * 只保留最近 120 天，避免无限增长。
 * ===================================================================== */
const Usage = {
  KEY: "lingo.usage.v1",
  days: {},
  months: {},

  load() {
    try {
      const j = JSON.parse(localStorage.getItem(this.KEY) || "null");
      if (j && j.days && j.months) { this.days = j.days; this.months = j.months; }
    } catch (_) { /* 损坏就重来 */ }
    this.prune();
  },

  save() {
    try { localStorage.setItem(this.KEY, JSON.stringify({ days: this.days, months: this.months })); } catch (_) {}
  },

  static_dayKey(d = new Date()) {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  },
  static_monthKey(d = new Date()) {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}`;
  },

  // 记一笔（agent：Engine 里的任务对象）
  record(agent) {
    if (!agent || !agent.tokens) return;
    const din = agent.tokens.input || 0;
    const dout = agent.tokens.output || 0;
    const cost = agent.cost || 0;
    const dk = this.static_dayKey();
    const mk = this.static_monthKey();

    const day = this.days[dk] || (this.days[dk] = { in: 0, out: 0, cost: 0, tasks: 0, byModel: {} });
    const mon = this.months[mk] || (this.months[mk] = { in: 0, out: 0, cost: 0, tasks: 0 });

    day.in += din; day.out += dout; day.cost += cost; day.tasks += 1;
    mon.in += din; mon.out += dout; mon.cost += cost; mon.tasks += 1;

    const mid = agent.model ? agent.model.id : "unknown";
    const bm = day.byModel[mid] || (day.byModel[mid] = { in: 0, out: 0, cost: 0, tasks: 0 });
    bm.in += din; bm.out += dout; bm.cost += cost; bm.tasks += 1;

    this.prune();
    this.save();
  },

  // 只保留最近 120 天 / 24 个月
  prune() {
    const keepKeys = (obj, n) => {
      const ks = Object.keys(obj).sort();
      if (ks.length > n) for (const k of ks.slice(0, ks.length - n)) delete obj[k];
    };
    keepKeys(this.days, 120);
    keepKeys(this.months, 24);
  },

  today() { return this.days[this.static_dayKey()] || { in: 0, out: 0, cost: 0, tasks: 0, byModel: {} }; },
  thisMonth() { return this.months[this.static_monthKey()] || { in: 0, out: 0, cost: 0, tasks: 0 }; },

  // 某模型在本地账本里的累计 token（跨天）——「成本归因」占比的分母回退用
  modelTokens(modelId) {
    let n = 0;
    for (const d of Object.values(this.days)) {
      const b = d.byModel && d.byModel[modelId];
      if (b) n += (b.in || 0) + (b.out || 0);
    }
    return n;
  },

  // 本地账本的累计汇总（跨天）——「历史总计」要把本调度台自己的消耗也加进来
  cumulative() {
    let inTok = 0, outTok = 0, cost = 0, tasks = 0;
    for (const d of Object.values(this.days)) {
      inTok += d.in || 0;
      outTok += d.out || 0;
      cost += d.cost || 0;
      tasks += d.tasks || 0;
    }
    return { in: inTok, out: outTok, cost, tasks };
  },

  // 按月画柱状（CodexBar 有当月 token 图）
  monthSeries() {
    const mk = this.static_monthKey();
    const [y, m] = mk.split("-").map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const p = (n) => String(n).padStart(2, "0");
    const out = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const k = `${y}-${p(m)}-${p(d)}`;
      const rec = this.days[k];
      out.push({ day: d, tokens: rec ? rec.in + rec.out : 0, cost: rec ? rec.cost : 0 });
    }
    return out;
  },
};

// 为每个模型解析出 color（默认值作为兜底），并初始化累计花费与预算
function initModelMeta() {
  MODELS.forEach((m) => {
    m.color = tokenColor(m.colorToken);
    m.spent = 0;                                   // 累计花费（成本归因用）
    m.budget = m.location === "local" ? 0 : m.quota.total;  // 云模型预算 = 初始余额
  });
}
initModelMeta();

/* ------------------------- 1b. 模型自动发现 -------------------------
 * 不再靠上面那份硬编码名单：启动时问代理 /api/models，
 * 把每个「已配密钥」的 provider 真实返回的模型全部注册进来。
 * 拉不到就保留硬编码种子（演示模式仍可跑），绝不编造模型。
 * ------------------------------------------------------------------ */
// 已知官方价（美元 / 1000 token，[输入, 输出]）。查不到价格的模型 priceKnown=false。
const PRICES = {
  "deepseek-flash":    [0.00015, 0.00060],
  "deepseek-v4-pro":   [0.00066, 0.00198],
  "deepseek-chat":     [0.00027, 0.00110],
  "deepseek-reasoner": [0.00055, 0.00219],
  "glm-4v-flash":      [0.00010, 0.00010],
  "glm-4v-plus":       [0.00010, 0.00010],
};

const PROVIDER_META = {
  openai:    { vendor: "DeepSeek",  location: "cloud", colorToken: TOKENS.cyan },
  zhipu:     { vendor: "智谱",      location: "cloud", colorToken: TOKENS.coral },
  dashscope: { vendor: "通义",      location: "cloud", colorToken: TOKENS.violet },
  anthropic: { vendor: "Anthropic", location: "cloud", colorToken: TOKENS.yellow },
  ollama:    { vendor: "本地",      location: "local", colorToken: TOKENS.yellow },
};

const AutoModels = {
  url: "http://127.0.0.1:8900/api/models",

  // 用真实列表替换 MODELS（只认 configured 且真返回了模型的 provider）
  apply(providers) {
    const found = [];
    for (const [p, d] of Object.entries(providers || {})) {
      if (!d || !d.configured || !Array.isArray(d.models) || !d.models.length) continue;
      const meta = PROVIDER_META[p] || PROVIDER_META.openai;
      for (const it of d.models) {
        const price = PRICES[it.id];
        found.push({
          id: it.id,
          name: it.name && it.name !== it.id ? it.name : it.id,
          vendor: meta.vendor,
          location: meta.location,
          provider: p,
          apiModel: it.id,
          colorToken: meta.colorToken,
          price: price || [0, 0],
          priceKnown: !!price,
          quota: { used: 0, total: 0, unit: "" },
        });
      }
    }
    if (!found.length) return false;
    MODELS.length = 0;
    MODELS.push(...found);
    initModelMeta();
    return true;
  },

  async load() {
    try {
      const r = await fetch(this.url, { signal: AbortSignal.timeout(9000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      const ok = this.apply(j.providers);
      console.log(ok
        ? `[Lingo] 自动接入 ${MODELS.length} 个模型：${MODELS.map((m) => m.id).join(", ")}`
        : "[Lingo] 无可自动接入的模型，使用内置种子");
      return ok;
    } catch (e) {
      console.warn("[Lingo] 模型列表拉取失败，使用内置种子：", e.message);
      return false;
    }
  },
};


// 令牌变化时刷新模型色（主题切换场景）
function refreshModelColors() {
  MODELS.forEach((m) => { m.color = tokenColor(m.colorToken, m.color); });
}

const modelById = (id) => MODELS.find((m) => m.id === id);

/* ------------------------- 2. 数据源抽象 ------------------------- */
/**
 * MockDataSource —— 生成模拟的流式 token 与产出文本。
 * 想接真实后端时，实现同样接口的类即可（streamTask / getQuotas）。
 */
const MockDataSource = {
  // 生成一段“该 AI 的产出文本”，按词切分以便流式吐字
  buildOutput(task, model) {
    const head = `【${model.name}】开始处理任务：\n“${task}”\n\n`;
    const body = [
      "正在分析需求要点……",
      "拆解为 3 个子步骤：",
      "1. 收集并整理相关信息",
      "2. 生成结构化草稿",
      "3. 校对与润色输出",
      "分析完成，以下是产出结果：",
      "· 结论清晰、层次分明，可直接进入下一步。",
      "· 已附带 2 条优化建议供参考。",
      "任务处理完毕。",
    ].join("\n");
    return head + body;
  },

  // 根据模型价格与文本长度估算一次任务的 token 用量
  estimateTokens(text, task) {
    const out = Math.max(60, Math.round(text.length / 3));
    const input = Math.max(40, Math.round((task.length + 120) / 3));
    return { input, output: out };
  },

  // 本地模型“免费”，云端按价计费
  computeCost(model, input, output) {
    return (input / 1000) * model.price[0] + (output / 1000) * model.price[1];
  },

  // 额度随消耗变化
  applyQuota(model, input, output) {
    if (model.location === "local") {
      // 本地：上下文占用波动
      model.quota.used = Math.min(model.quota.total, model.quota.used + Math.round((input + output) / 4));
    } else {
      const cost = this.computeCost(model, input, output);
      model.quota.used = Math.min(model.quota.total, model.quota.used + cost);
    }
  },
};

/* ------------------------- 2b. 真实数据源 ------------------------- */
/**
 * LiveDataSource —— 接真实 API（经 proxy.js 转发）。
 *
 * 设计要点：
 *  - 只跟 127.0.0.1:8900 说话，密钥在 proxy 进程里，浏览器拿不到
 *  - 用 SSE 流式读，边收边吐，token 用量用上游返回的真实值
 *  - 未配置密钥 / 连不上 → 自动回落到 MockDataSource（演示模式）
 */
const LiveDataSource = {
  baseUrl: "http://127.0.0.1:8900",
  _available: null,      // null=未探测, true/false=结果
  _providers: null,

  // 探测代理是否在线、哪些 provider 配好了
  async probe() {
    try {
      const r = await fetch(this.baseUrl + "/api/health", { signal: AbortSignal.timeout(2500) });
      if (!r.ok) throw new Error("health " + r.status);
      const j = await r.json();
      this._providers = j.providers;
      this._available = true;
      return j;
    } catch (_) {
      this._available = false;
      return null;
    }
  },

  isAvailable() { return this._available === true; },

  // 某个模型能不能真跑
  canRun(model) {
    if (!this.isAvailable() || !this._providers) return false;
    const p = model.provider || "openai";
    return !!(this._providers[p] && this._providers[p].configured);
  },

  /**
   * 多轮对话（给桌宠用）。
   * @param {object} model    模型注册表条目
   * @param {Array}  messages OpenAI 风格消息数组 [{role,content}, ...]
   * @param {object} handlers { onDelta(text), onUsage(inTok,outTok), onError(msg), onDone() }
   * @param {AbortSignal} signal
   */
  async chat(model, messages, handlers = {}, signal) {
    const provider = model.provider || "openai";
    const body = {
      provider,
      model: model.apiModel || model.id,
      messages,
      stream: true,
    };
    let res;
    try {
      res = await fetch(this.baseUrl + "/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (e.name === "AbortError") return;
      handlers.onError && handlers.onError("连不上本地代理（请确认 node start.js 在跑）：" + e.message);
      return;
    }
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      const j = await res.json().catch(() => ({}));
      if (j.error === "not_configured") handlers.onError && handlers.onError("该模型还没配密钥");
      else handlers.onError && handlers.onError(j.error || "上游返回错误");
      return;
    }
    if (!res.ok || !res.body) {
      handlers.onError && handlers.onError("HTTP " + res.status);
      return;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop();
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data:")) continue;
          let evt;
          try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (evt.type === "delta" && evt.text) handlers.onDelta && handlers.onDelta(evt.text);
          else if (evt.type === "reasoning" && evt.text) handlers.onReasoning && handlers.onReasoning(evt.text);
          else if (evt.type === "usage") handlers.onUsage && handlers.onUsage(evt.input || 0, evt.output || 0);
          else if (evt.type === "error") handlers.onError && handlers.onError(evt.message);
          else if (evt.type === "done") { handlers.onDone && handlers.onDone(); return; }
        }
      }
      handlers.onDone && handlers.onDone();
    } catch (e) {
      if (e.name === "AbortError") return;
      handlers.onError && handlers.onError("流读取失败：" + e.message);
    }
  },

  /**
   * 流式跑一个任务。
   * @param {object} model  模型注册表条目
   * @param {string} task   任务描述
   * @param {object} handlers { onDelta(text), onUsage(inTok,outTok), onError(msg), onDone() }
   * @returns {AbortController} 可用于中断
   */
  stream(model, task, handlers = {}) {
    const ctrl = new AbortController();
    const provider = model.provider || "openai";
    const body = {
      provider,
      model: model.apiModel || model.id,
      messages: [
        { role: "system", content: "你是 Lingo 智能体调度台里的一个执行 Agent。请直接、专业、简洁地完成用户交给的任务，输出中文。" },
        { role: "user", content: task },
      ],
      stream: true,
    };

    (async () => {
      let res;
      try {
        res = await fetch(this.baseUrl + "/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
      } catch (e) {
        if (e.name !== "AbortError") handlers.onError && handlers.onError("连接代理失败：" + e.message);
        return;
      }

      // 代理明确说「没配 key」
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        const j = await res.json().catch(() => ({}));
        if (j.error === "not_configured") handlers.onError && handlers.onError("该模型未配置密钥，已切换演示模式");
        else handlers.onError && handlers.onError(j.error || "上游返回错误");
        return;
      }
      if (!res.ok || !res.body) {
        handlers.onError && handlers.onError("HTTP " + res.status);
        return;
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop();
          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data:")) continue;
            let evt;
            try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
            if (evt.type === "delta" && evt.text) handlers.onDelta && handlers.onDelta(evt.text);
            else if (evt.type === "reasoning" && evt.text) handlers.onReasoning && handlers.onReasoning(evt.text);
            else if (evt.type === "usage") handlers.onUsage && handlers.onUsage(evt.input || 0, evt.output || 0);
            else if (evt.type === "error") handlers.onError && handlers.onError(evt.message);
            else if (evt.type === "done") { handlers.onDone && handlers.onDone(); return; }
          }
        }
        handlers.onDone && handlers.onDone();
      } catch (e) {
        if (e.name === "AbortError") return;
        handlers.onError && handlers.onError("流读取失败：" + e.message);
      }
    })();

    return ctrl;
  },

  // 真实用量算钱（比 mock 按字数估算准）
  computeCost(model, input, output) {
    return (input / 1000) * model.price[0] + (output / 1000) * model.price[1];
  },
};

/* ------------------------- 3. 引擎 ------------------------- */
const Engine = {
  /* 演示用：是否允许「随机中途失败」。
     曾经写死为每次吐字 1.2% 概率，导致任务平均约 38% 概率被随机弄挂 ——
     看起来像真 bug（任务跑到 96% 突然变 failed、桌宠一直挂着 × × 脸）。
     现在默认关闭，需要演示失败链路时在控制台执行：Engine.DEMO_FAIL_RATE = 0.05 */
  DEMO_FAIL_RATE: 0,

  agents: [],
  seq: 0,
  totalInput: 0,
  totalOutput: 0,
  totalCost: 0,
  totalCostIn: 0,     // 输入方向累计花费（KPI 需要与输出相加 = 总花费）
  totalCostOut: 0,
  totalTasks: 0,
  totalFailed: 0,
  paused: false,
  traces: [],          // 运行明细（每次运行一条）
  // 用于计算 token 速率
  recentTokens: [], // { t, n }

  addAgent({ modelId, name, task }) {
    const model = modelById(modelId) || MODELS[0];
    const live = LiveDataSource.canRun(model);

    // 演示模式：预先造好整段文本，之后按字符“吐字”
    // 真实模式：文本由 API 流式返回，这里留空
    const output = live ? "" : MockDataSource.buildOutput(task, model);
    const { input, output: outTokens } = live
      ? { input: 0, output: 0 }                       // 真实用量以上游返回为准
      : MockDataSource.estimateTokens(output, task);

    const agent = {
      id: `ag_${Date.now()}_${this.seq++}`,
      name: name?.trim() || `${model.name} #${this.seq}`,
      modelId,
      model,
      task,
      fullOutput: output,
      printed: 0,        // 已吞吐字符数
      status: "queued",  // queued | running | done | failed
      live,              // 本任务是否走真实 API
      tokens: { input: 0, output: 0 },
      cost: 0,
      plan: { input, output: outTokens },
      createdAt: Date.now(),
      finishedAt: null,
    };
    this.agents.unshift(agent);
    UI.renderAgents();
    // 桌宠：有任务时冒气泡提示
    Pet.notify({ title: "收到新任务", text: `${agent.name} · ${agent.model.name}${live ? " · 真实 API" : ""}`, tone: "info" });
    // 排队片刻后开始运行
    setTimeout(() => this.startAgent(agent.id), 300 + Math.random() * 500);
    return agent;
  },

  startAgent(id) {
    if (this.paused) {
      // 暂停时迟点再试
      setTimeout(() => this.startAgent(id), 500);
      return;
    }
    const a = this.agents.find((x) => x.id === id);
    if (!a || a.status !== "queued") return;
    a.status = "running";
    a.startedAt = Date.now();

    if (a.live) {
      // 真实 API：输入 token 先按字数粗估占位，结束时以真实 usage 修正
      a.tokens.input = Math.max(1, Math.round((a.task.length + 60) / 3));
      this.totalInput += a.tokens.input;
      UI.renderAgents();
      this.pumpLive(a);
    } else {
      a.tokens.input = a.plan.input; // 演示：输入 token 一次性计入
      this.totalInput += a.tokens.input;
      UI.renderAgents();
      this.pump(a);
    }
  },

  /* ---------- 真实 API 流式 ---------- */
  pumpLive(a) {
    if (this.paused) {
      // 暂停时不中断连接，只是等（流会继续缓冲）
      setTimeout(() => this.pumpLiveResume(a), 400);
      return;
    }
    a.liveBuf = a.liveBuf || "";
    a.reasoningBuf = a.reasoningBuf || "";
    a.liveStarted = Date.now();

    // 每个分片的 token 估算：中文≈1字/token，英文≈1token/4字符。
    // 既用于实时累计，也喂给「吞吐速率」（TPS）—— 真实 API 路径以前从不记录，
    // 所以 TPS 在真跑时恒为 0。
    // ponytail: 启发式，只影响流式期间的观感；结束时会用上游真实 usage 精确覆盖。
    const addChunk = (text) => {
      let cjk = 0, other = 0;
      for (const ch of text) {
        if (ch.codePointAt(0) >= 0x2e80) cjk++;
        else other++;
      }
      const n = cjk + other / 4;
      a.estTok = (a.estTok || 0) + n;

      const est = Math.round(a.estTok);
      if (est > a.tokens.output) {
        // 估算增量必须同步进 totalOutput：否则 onUsage 修正时按「已计入」算 delta，
        // 而总量里其实没有这笔估算，KPI 就会比 Agent 卡片/账本少一截。
        this.totalOutput += est - a.tokens.output;
        a.tokens.output = est;
        this.recomputeLiveCost(a);
      }
      // 吞吐速率与「输出」口径一致：思考过程也算（上游按它计费）
      this.recentTokens.push({ t: performance.now(), n });
    };

    a.ctl = LiveDataSource.stream(a.model, a.task, {
      onDelta: (text) => {
        a.liveBuf += text;
        a.printed = a.liveBuf.length;
        addChunk(text);
        UI.updateAgent(a);
      },
      // 思考过程：不算展示正文，但必须计入 token 估算（上游按它计费）
      onReasoning: (text) => {
        a.reasoningBuf += text;
        addChunk(text);
      },
      onUsage: (inTok, outTok) => {
        // 上游给了真实用量 → 用它修正
        if (inTok) {
          const delta = inTok - a.tokens.input;
          a.tokens.input = inTok;
          this.totalInput += delta;
        }
        if (outTok) {
          const delta = outTok - a.tokens.output;
          a.tokens.output = outTok;
          this.totalOutput += delta;
        }
        this.recomputeLiveCost(a);
      },
      onError: (msg) => this.failLive(a, msg),
      onDone: () => this.finishLive(a),
    });
  },

  pumpLiveResume(a) {
    if (!a.liveDone) return;
    this.finishLive(a);
  },

  recomputeLiveCost(a) {
    const cost = LiveDataSource.computeCost(a.model, a.tokens.input, a.tokens.output);
    const delta = cost - a.cost;
    a.cost = cost;
    this.totalCost += delta;
    this.trackCostByDir(a);
    a.model.spent += delta;
    // 云端按花费扣余额
    MockDataSource.applyQuota(a.model, delta > 0 ? 0 : 0, 0);
    if (a.model.location === "cloud") {
      a.model.quota.used = Math.min(a.model.quota.total, (a.model.quota.used || 0) + Math.max(0, delta));
    }
  },

  // 把「输入 / 输出」两个方向各自的花费累计起来。
  // KPI 栏要求三者自洽：输入花费 + 输出花费 = TOKEN 总量 的花费。
  trackCostByDir(a) {
    const p = a.model.price || [0, 0];
    const cin = (a.tokens.input / 1000) * p[0];
    const cout = (a.tokens.output / 1000) * p[1];
    this.totalCostIn += cin - (a.costIn || 0);
    this.totalCostOut += cout - (a.costOut || 0);
    a.costIn = cin;
    a.costOut = cout;
  },

  finishLive(a) {
    if (a.liveDone) return;
    a.liveDone = true;
    a.fullOutput = a.liveBuf || "（无输出）";
    a.printed = a.fullOutput.length;
    // 若上游没给 usage，用估算兜底
    if (!a.tokens.output) {
      a.tokens.output = Math.max(1, Math.round(a.printed / 2.2));
      this.totalOutput += a.tokens.output;
    }
    this.recomputeLiveCost(a);
    a.status = "done";
    a.finishedAt = Date.now();
    this.totalTasks++;
    this.recordTrace(a);
    Usage.record(a);            // 记账：今天 / 本月用量
    UI.renderAgents();
    UI.renderKPI();
    UI.renderQuotas();
    UI.renderTraces();
    UI.renderUsage();           // 用量格同步刷新
    Notifier.taskDone(a);
    UI.updateBotVoice();
  },

  /* 失败后 60 秒自动「消气」：把桌宠从 × × 苦瓜脸放回待命。
     失败本身仍留在运行明细里，只是不再持续驱动情绪。 */
  ackFailureLater(a) {
    clearTimeout(a._ackTimer);
    a._ackTimer = setTimeout(() => {
      a.failureAcked = true;
      UI.updateBotVoice();
    }, 60000);
  },

  failLive(a, msg) {
    if (a.liveDone) return;
    a.liveDone = true;
    a.fullOutput = a.liveBuf || "";
    a.printed = a.fullOutput.length;
    a.error = msg;
    a.status = "failed";
    a.finishedAt = Date.now();
    this.totalFailed++;
    this.recordTrace(a);
    this.ackFailureLater(a);
    UI.renderAgents();
    UI.renderKPI();
    UI.renderTraces();
    Notifier.add({
      level: "danger",
      title: `${a.name} 调用失败`,
      body: `${a.model.name} · ${String(msg).slice(0, 120)}`,
      dedupeKey: `livefail:${a.id}`, cooldownMs: 0,
    });
    UI.updateBotVoice();
  },

  // 逐字吐出产出，并逐步增加输出 token
  pump(a) {
    if (this.paused) {
      setTimeout(() => this.pump(a), 400);
      return;
    }
    if (a.status !== "running") return;

    const chunk = 2 + Math.floor(Math.random() * 5);
    const next = Math.min(a.fullOutput.length, a.printed + chunk);
    const addedChars = next - a.printed;
    a.printed = next;

    // 输出 token 按字符比例增长
    const ratio = a.plan.output / a.fullOutput.length;
    const addTokens = Math.max(1, Math.round(addedChars * ratio));
    a.tokens.output += addTokens;
    this.totalOutput += addTokens;

    const cost = MockDataSource.computeCost(a.model, a.tokens.input, a.tokens.output);
    const deltaCost = cost - a.cost;
    a.cost = cost;
    this.totalCost += deltaCost;
    this.trackCostByDir(a);
    a.model.spent += deltaCost;                 // 成本归因：累计到模型
    MockDataSource.applyQuota(a.model, 0, addTokens);

    this.recentTokens.push({ t: performance.now(), n: addTokens + (a.printed === chunk ? a.tokens.input : 0) });

    UI.updateAgent(a);

    // 演示失败链路（默认关闭，见 Engine.DEMO_FAIL_RATE）
    if (a.status === "running" && Math.random() < this.DEMO_FAIL_RATE) {
      a.status = "failed";
      a.finishedAt = Date.now();
      this.totalFailed++;
      this.recordTrace(a);
      this.ackFailureLater(a);
      UI.renderAgents();
      UI.renderKPI();
      UI.renderTraces();
      Notifier.add({
        level: "danger",
        title: `${a.name} 运行失败`,
        body: `${a.model.name} · 生成中断，已产生 ${fmt(a.tokens.input + a.tokens.output)} tokens`,
        dedupeKey: `fail:${a.id}`, cooldownMs: 0,
      });
      return;
    }

    if (a.printed >= a.fullOutput.length) {
      a.status = "done";
      a.finishedAt = Date.now();
      this.totalTasks++;
      this.recordTrace(a);
      Usage.record(a);        // 记账：今天 / 本月用量
      UI.renderAgents();
      UI.renderKPI();
      UI.renderQuotas();
      UI.renderTraces();
      UI.renderUsage();       // 用量格同步刷新
      Notifier.taskDone(a);   // 自建通知：任务完成（Notifier.add 会自动同步到桌宠对话框）
    } else {
      setTimeout(() => this.pump(a), 40 + Math.random() * 70);
    }
  },

  // 记录一条运行明细（Trace）
  recordTrace(a) {
    const existing = this.traces.find((t) => t.id === a.id);
    const rec = {
      id: a.id,
      name: a.name,
      model: a.model.name,
      modelColor: a.model.color,
      task: a.task,
      input: a.tokens.input,
      output: a.tokens.output,
      cost: a.cost,
      status: a.status,                       // done | failed
      createdAt: a.createdAt,
      finishedAt: a.finishedAt,
      latency: a.finishedAt ? (a.finishedAt - a.createdAt) / 1000 : 0,
      output_text: a.fullOutput.slice(0, a.printed),
    };
    if (existing) Object.assign(existing, rec);
    else this.traces.unshift(rec);
    if (this.traces.length > 200) this.traces.pop();
  },

  reset() {
    this.agents = [];
    this.seq = 0;
    this.totalInput = 0;
    this.totalOutput = 0;
    this.totalCost = 0;
    this.totalCostIn = 0;
    this.totalCostOut = 0;
    this.totalTasks = 0;
    this.totalFailed = 0;
    this.traces = [];
    this.recentTokens = [];
    MODELS.forEach((m) => {
      m.quota.used = m.location === "local" ? m.quota.used % 5000 : 0;
      m.spent = 0;
    });
    UI.renderAll();
    UI.renderTraces();
  },

  togglePause() {
    this.paused = !this.paused;
    UI.renderPause();
  },

  // token/秒：过去 2 秒内的消耗
  tps() {
    const now = performance.now();
    this.recentTokens = this.recentTokens.filter((r) => now - r.t < 2000);
    const sum = this.recentTokens.reduce((s, r) => s + r.n, 0);
    return Math.round(sum / 2);
  },
};

/* ------------------------- 4. Notifier（自建通知系统） ------------------------- */
/**
 * 完全自主的通知引擎，不依赖任何第三方推送 API。
 * 通道：
 *   - inapp   : 页面内通知中心（默认，始终可用）
 *   - desktop : 浏览器原生 Notification API（本地能力，非第三方服务）
 * 规则：
 *   - 额度阈值告警（阈值可配置，带冷却去重）
 *   - 任务完成提醒（可开关）
 */
const Notifier = {
  items: [],          // { id, level, title, body, at, read }
  seq: 0,
  settings: {
    threshold: 85,    // 额度告警阈值 %
    onDone: true,     // 任务完成提醒
    desktop: false,   // 系统级通知
  },
  _cooldown: {},      // key -> last ts，防止重复刷屏
  _unread: 0,

  // 持久化：设置与最近通知（localStorage，纯本地）
  _PERSIST_KEY: "lingo.notify.v1",
  save() {
    try {
      localStorage.setItem(this._PERSIST_KEY, JSON.stringify({
        settings: this.settings,
        items: this.items.slice(0, 20),
        unread: this._unread,
      }));
    } catch (_) { /* 隐私模式等场景静默降级 */ }
  },
  load() {
    try {
      const raw = localStorage.getItem(this._PERSIST_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d.settings) Object.assign(this.settings, d.settings);
      if (Array.isArray(d.items)) this.items = d.items;
      this._unread = d.unread || 0;
    } catch (_) {}
  },

  add({ level = "info", title, body = "", dedupeKey = null, cooldownMs = 15000, silentPet = false }) {
    // 冷却去重：同类消息在冷却期内只记一次
    if (dedupeKey) {
      const last = this._cooldown[dedupeKey] || 0;
      if (Date.now() - last < cooldownMs) return null;
      this._cooldown[dedupeKey] = Date.now();
    }
    const item = {
      id: `nt_${Date.now()}_${this.seq++}`,
      level, title, body, at: Date.now(), read: false,
    };
    this.items.unshift(item);
    if (this.items.length > 50) this.items.pop();
    this._unread++;
    // 系统级通知（仅当用户开启且已授权）
    if (this.settings.desktop && "Notification" in window && Notification.permission === "granted") {
      try { new Notification(title, { body }); } catch (_) {}
    }
    UI.renderNotifs();
    // 桌宠对话框：把通知以「对话消息」形式送进桌宠（自建，无第三方）
    // silentPet：调用方已经在对话框里反馈过了，别再重复推一条
    if (!silentPet && typeof Pet !== "undefined" && Pet.notify) {
      Pet.notify({
        title,
        text: body,
        tone: level === "danger" ? "danger" : level === "warn" ? "warn" : level === "success" ? "success" : "info",
      });
    }
    this.save();
    return item;
  },

  markAllRead() {
    this.items.forEach((i) => (i.read = true));
    this._unread = 0;
    UI.renderNotifs();
    this.save();
  },

  clear() {
    this.items = [];
    this._unread = 0;
    UI.renderNotifs();
    this.save();
  },

  // 额度阈值检查：每次额度渲染后调用
  checkQuota() {
    MODELS.forEach((m) => {
      // 只在拿到真实余额时才告警（没有真实数据就别瞎报）
      if (!m.balanceKnown || !m.balance || typeof m.balance.total !== "number") return;
      const total = m.balance.total;
      const spent = m.spent || 0;
      if (total <= 0) {
        this.add({
          level: "danger",
          title: `${m.name} 余额为 0`,
          body: "账户余额不足，调用可能失败",
          dedupeKey: `quota:${m.id}`,
          cooldownMs: 300000,
        });
        return;
      }
      const pct = (spent / total) * 100;
      if (pct >= this.settings.threshold) {
        const c = m.balance.currency;
        this.add({
          level: pct >= 95 ? "danger" : "warn",
          title: `${m.name} 花费告警`,
          body: `本次会话已花 ${Money.fmt(spent, c, 4)}／余额 ${Money.fmt(total, c)}（${pct.toFixed(0)}%）`,
          dedupeKey: `quota:${m.id}`,
          cooldownMs: 60000,
        });
      }
    });
  },

  // 任务完成
  taskDone(agent) {
    if (!this.settings.onDone) return;
    this.add({
      level: "ok",
      title: `${agent.name} 已完成`,
      body: `${agent.model.name} · 共 ${fmt(agent.tokens.input + agent.tokens.output)} tokens · $${agent.cost.toFixed(4)}`,
      dedupeKey: `done:${agent.id}`,
      cooldownMs: 0,
    });
    // 桌宠主动把结果播报出来（真任务：附上模型实际产出）
    try { Pet.announceResult(agent); } catch (_) {}
  },
};

/* ------------------------- 5. UI ------------------------- */
const UI = {
  el: {},
  chartHistory: [], // { in, out }

  init() {
    this.el = {
      grid: document.getElementById("agentGrid"),
      empty: document.getElementById("emptyState"),
      agentHint: document.getElementById("agentCountHint"),
      kpiTotalTokens: document.getElementById("kpiTotalTokens"),
      kpiTotalCost: document.getElementById("kpiTotalCost"),
      kpiInTokens: document.getElementById("kpiInTokens"),
      kpiInCost: document.getElementById("kpiInCost"),
      kpiOutTokens: document.getElementById("kpiOutTokens"),
      kpiOutCost: document.getElementById("kpiOutCost"),
      kpiSpend: document.getElementById("kpiSpend"),
      kpiTasks: document.getElementById("kpiTasks"),
      kpiTps: document.getElementById("kpiTps"),
      // 科技感控制台：迷你走势线 + 环形仪表
      sparkTokens: document.getElementById("sparkTokens"),
      sparkIn: document.getElementById("sparkIn"),
      sparkOut: document.getElementById("sparkOut"),
      sparkTps: document.getElementById("sparkTps"),
      spendGaugeArc: document.getElementById("spendGaugeArc"),
      spendPop: document.getElementById("spendPop"),
      spendPopBtn: document.getElementById("spendPopBtn"),
      spendPopCost: document.getElementById("spendPopCost"),
      spendPopEst: document.getElementById("spendPopEst"),
      spendPopRate: document.getElementById("spendPopRate"),
      spendPopTokens: document.getElementById("spendPopTokens"),
      ccTaskList: document.getElementById("ccTaskList"),
      ccTaskEmpty: document.getElementById("ccTaskEmpty"),
      ccRunningTag: document.getElementById("ccRunningTag"),
      ccBalanceList: document.getElementById("ccBalanceList"),
      ccBalanceTag: document.getElementById("ccBalanceTag"),
      ccBalanceRefresh: document.getElementById("ccBalanceRefresh"),
      ccUsageToday: document.getElementById("ccUsageToday"),
      ccUsageMonth: document.getElementById("ccUsageMonth"),
      ccUsageTotal: document.getElementById("ccUsageTotal"),
      traceBody: document.getElementById("traceBody"),
      traceEmpty: document.getElementById("traceEmpty"),
      traceHint: document.getElementById("traceHint"),
      traceTable: document.getElementById("traceTable"),
      costAttrList: document.getElementById("costAttrList"),
      costAttrTotal: document.getElementById("costAttrTotal"),
      quotaList: document.getElementById("quotaList"),
      quotaUpdated: document.getElementById("quotaUpdated"),
      trendChart: document.getElementById("trendChart"),
      livePill: document.getElementById("livePill"),
      liveText: document.getElementById("liveText"),
      liveRegion: document.getElementById("liveRegion"),
      btnPauseText: document.getElementById("btnPauseText"),
      btnPause: document.getElementById("btnPause"),
      btnPet: document.getElementById("btnPet"),
      chartTable: document.getElementById("chartTable"),
      // 通知中心
      btnNotif: document.getElementById("btnNotif"),
      notifPanel: document.getElementById("notifPanel"),
      notifScrim: document.getElementById("notifScrim"),
      notifList: document.getElementById("notifList"),
      notifEmpty: document.getElementById("notifEmpty"),
      notifCount: document.getElementById("notifCount"),
      ruleThreshold: document.getElementById("ruleThreshold"),
      ruleOnDone: document.getElementById("ruleOnDone"),
      ruleDesktop: document.getElementById("ruleDesktop"),
      // 技能库
      skillBtn: document.getElementById("sideSkillBtn"),
      sideSkillCount: document.getElementById("sideSkillCount"),
      skillPanel: document.getElementById("skillPanel"),
      skillScrim: document.getElementById("skillScrim"),
      skillClose: document.getElementById("skillClose"),
      skillReload: document.getElementById("skillReload"),
      skillSearch: document.getElementById("skillSearch"),
      skillOnlyOn: document.getElementById("skillOnlyOn"),
      skillSummary: document.getElementById("skillSummary"),
      skillList: document.getElementById("skillList"),
      skillDetail: document.getElementById("skillDetail"),
      skillBack: document.getElementById("skillBack"),
      skillDetailName: document.getElementById("skillDetailName"),
      skillDetailScope: document.getElementById("skillDetailScope"),
      skillDetailBody: document.getElementById("skillDetailBody"),
      // modal
      backdrop: document.getElementById("modalBackdrop"),
      form: document.getElementById("dispatchForm"),
      fieldModel: document.getElementById("fieldModel"),
      fieldName: document.getElementById("fieldName"),
      fieldTask: document.getElementById("fieldTask"),
    };

    // 填充模型下拉
    this.el.fieldModel.innerHTML = MODELS.map(
      (m) => `<option value="${m.id}">${m.name} · ${m.vendor}${m.location === "local" ? "（本地）" : ""}</option>`
    ).join("");

    // 载入已保存的通知设置与历史，并把控件同步到设置值
    Notifier.load();
    this.el.ruleThreshold.value = Notifier.settings.threshold;
    this.el.ruleOnDone.checked = Notifier.settings.onDone;
    this.el.ruleDesktop.checked = Notifier.settings.desktop &&
      ("Notification" in window) && Notification.permission === "granted";

    // 恢复侧边栏折叠偏好
    try {
      if (localStorage.getItem("lingo.sidebar.collapsed") === "1") this.setSidebar(false);
    } catch (_) {}

    Pet.init();
    this.bindEvents();
    this.renderAll();
    this.startLoop();
  },
  bindEvents() {
    // 用量弹层（成本 / 使用率 / 词元数）开合：点按钮切换，点外面或 Esc 关闭
    if (this.el.spendPopBtn && this.el.spendPop) {
      const pop = this.el.spendPop, btn = this.el.spendPopBtn;

      // 固定定位：跟随按钮，且挂到 body 上 —— 否则会被控制台栏的 overflow 裁掉
      const place = () => {
        const r = btn.getBoundingClientRect();
        pop.style.top = (r.bottom + 10) + "px";
        pop.style.right = Math.max(8, window.innerWidth - r.right) + "px";
        pop.style.left = "auto";
      };
      const onMove = () => { if (!pop.hidden) place(); };
      const close = () => {
        pop.hidden = true;
        btn.setAttribute("aria-expanded", "false");
        window.removeEventListener("scroll", onMove, true);
        window.removeEventListener("resize", onMove);
      };

      btn.onclick = (e) => {
        e.stopPropagation();
        const willOpen = pop.hidden;
        if (willOpen) {
          if (pop.parentNode !== document.body) document.body.appendChild(pop);
          pop.hidden = false;
          this.renderSpendPop();
          place();
          window.addEventListener("scroll", onMove, true);
          window.addEventListener("resize", onMove);
        } else {
          close();
        }
        btn.setAttribute("aria-expanded", String(willOpen));
      };
      document.addEventListener("click", (e) => {
        if (pop.hidden) return;
        if (pop.contains(e.target) || btn.contains(e.target)) return;
        close();
      });
      document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
    }

    // 派发入口统一由「助手」承担：侧栏助手卡 / 桌宠本体 / 空态助手
    // （顶部不再放重复的「派发新任务」按钮）
    // 机器人 = AI 助手本人：点击即派发任务
    document.getElementById("sideBot").onclick = () => {
      this.openModal();
      setTimeout(() => this.el.fieldTask?.focus(), 60);
    };
    document.getElementById("emptyBot").onclick = () => {
      this.openModal();
      setTimeout(() => this.el.fieldTask?.focus(), 60);
    };
    document.getElementById("btnPause").onclick = () => Engine.togglePause();
    // 桌宠开关：自由走动 <-> 安静待命
    const petBtn = document.getElementById("btnPet");
    if (petBtn) {
      let petOn = (() => { try { return localStorage.getItem("lingo.pet.parked") !== "1"; } catch (_) { return true; } })();
      const syncPetBtn = () => {
        petBtn.setAttribute("aria-pressed", String(petOn));
        const t = document.getElementById("btnPetText");
        if (t) t.textContent = petOn ? "桌宠" : "已静默";
      };
      Pet.setParked(!petOn);
      syncPetBtn();
      petBtn.onclick = () => {
        petOn = !petOn;
        Pet.setParked(!petOn);
        try { localStorage.setItem("lingo.pet.parked", petOn ? "0" : "1"); } catch (_) {}
        syncPetBtn();
        this.toast(petOn ? "桌宠已恢复走动" : "桌宠已安静待命");
      };
    }
    document.getElementById("btnReset").onclick = () => {
      if (confirm("确定重置所有 Agent 与统计数据？")) Engine.reset();
    };
    document.getElementById("modalClose").onclick = () => this.closeModal();
    document.getElementById("modalCancel").onclick = () => this.closeModal();
    this.el.backdrop.addEventListener("click", (e) => {
      if (e.target === this.el.backdrop) this.closeModal();
    });
    this.el.form.onsubmit = (e) => {
      e.preventDefault();
      const submitBtn = this.el.form.querySelector('button[type="submit"]');
      if (submitBtn.disabled) return;            // 11.4 提交后禁用重复触发
      submitBtn.disabled = true;
      const modelId = this.el.fieldModel.value;
      const name = this.el.fieldName.value;
      const task = this.el.fieldTask.value.trim() || "（未填写具体内容）";
      const agent = Engine.addAgent({ modelId, name, task });
      this.closeModal();
      this.toast(`已派发任务给 ${agent.model.name}`);   // 11.4 显示结果
      setTimeout(() => { submitBtn.disabled = false; }, 300);
    };

    /* ---------- 通知中心事件 ---------- */
    this.el.btnNotif.onclick = () => this.toggleNotifs();
    document.getElementById("notifClose").onclick = () => this.closeNotifs();
    this.el.notifScrim.onclick = () => this.closeNotifs();
    document.getElementById("notifClear").onclick = () => Notifier.clear();

    /* ---------- 技能库事件 ---------- */
    this.bindSkills();

    /* ---------- 余额：手动刷新 ---------- */
    if (this.el.ccBalanceRefresh) {
      this.el.ccBalanceRefresh.onclick = async () => {
        const btn = this.el.ccBalanceRefresh;
        btn.classList.add("spin");
        btn.disabled = true;
        try {
          await Balance.refreshAll();
          this.renderBalances();
          this.renderQuotas();
        } finally {
          setTimeout(() => { btn.classList.remove("spin"); btn.disabled = false; }, 400);
        }
      };
    }

    // 规则：额度阈值
    this.el.ruleThreshold.onchange = () => {
      let v = parseInt(this.el.ruleThreshold.value, 10);
      if (isNaN(v)) v = 85;
      v = Math.min(100, Math.max(10, v));
      this.el.ruleThreshold.value = v;
      Notifier.settings.threshold = v;
      Notifier.checkQuota();
    };
    // 规则：任务完成提醒
    this.el.ruleOnDone.onchange = () => { Notifier.settings.onDone = this.el.ruleOnDone.checked; };
    // 规则：系统级通知（请求浏览器授权）
    this.el.ruleDesktop.onchange = async () => {
      const want = this.el.ruleDesktop.checked;
      if (want && "Notification" in window) {
        const perm = await Notification.requestPermission();
        if (perm !== "granted") {
          this.el.ruleDesktop.checked = false;
          Notifier.settings.desktop = false;
          this.toast("浏览器已拒绝通知权限");
          return;
        }
        Notifier.settings.desktop = true;
        this.toast("已开启系统级通知");
      } else {
        Notifier.settings.desktop = false;
      }
    };

    // Esc 关闭通知中心
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.el.notifPanel.hidden) this.closeNotifs();
    });

    /* ---------- 侧边栏折叠 ---------- */
    document.getElementById("sideToggle").onclick = () => this.setSidebar(false);
    document.getElementById("sideReveal").onclick = () => this.setSidebar(true);

    /* ---------- 导航跳转（平滑滚动 + 高亮） ---------- */
    document.querySelectorAll(".side-nav a").forEach((a) => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        const sel = a.getAttribute("href");
        const target = document.querySelector(sel);
        if (!target) return;
        this.setActiveNav(sel);
        this.scrollToSection(target);
        history.replaceState(null, "", sel);
      });
    });
    this.initScrollSpy();
    this.bindTraceTable();
    this.bindRange();
  },

  // 计算目标位置并平滑滚动（避开 sticky 侧栏/固定偏移）
  // target 可以是元素，也可以是选择器字符串（"#quota"）
  scrollToSection(target) {
    const el = typeof target === "string" ? document.querySelector(target) : target;
    if (!el) return false;
    const y = Math.max(0, el.getBoundingClientRect().top + window.pageYOffset - 12);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { window.scrollTo(0, y); return true; }
    // 平滑滚动：部分环境（后台/无头标签）不会推进动画，做一次兜底校正
    try {
      window.scrollTo({ top: y, behavior: "smooth" });
    } catch (_) {
      window.scrollTo(0, y);
      return true;
    }
    setTimeout(() => {
      // 若平滑动画未生效（位置几乎没变），直接跳到目标
      if (Math.abs(window.pageYOffset - y) > 4) window.scrollTo(0, y);
    }, 420);
    return true;
  },

  /* ---------- 侧边栏折叠状态 ---------- */
  setSidebar(open) {
    const layout = document.querySelector(".layout");
    layout.classList.toggle("collapsed", !open);
    document.getElementById("sideToggle").setAttribute("aria-expanded", String(open));
    document.getElementById("sideReveal").hidden = open;
    // 记忆折叠偏好（本地）
    try { localStorage.setItem("lingo.sidebar.collapsed", open ? "0" : "1"); } catch (_) {}
    // 布局变化后重绘图表（宽度变了）
    setTimeout(() => this.drawChart(), 240);
  },

  /* ---------- 滚动高亮当前区块 ---------- */
  setActiveNav(hash) {
    document.querySelectorAll(".side-nav a").forEach((a) => {
      const on = a.getAttribute("href") === hash;
      a.classList.toggle("active", on);
      if (on) a.setAttribute("aria-current", "true");
      else a.removeAttribute("aria-current");
    });
  },
  initScrollSpy() {
    const sections = [
      { id: "#dashboard", el: document.getElementById("dashboard") },
      { id: "#agents", el: document.getElementById("agents") },
      { id: "#quota", el: document.getElementById("quota") },
    ].filter((s) => s.el);
    if (!("IntersectionObserver" in window)) return;
    const io = new IntersectionObserver((entries) => {
      // 取当前可见度最高、且位于视口上部的区块
      const visible = entries.filter((e) => e.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
      if (visible[0]) {
        const hit = sections.find((s) => s.el === visible[0].target);
        if (hit) this.setActiveNav(hit.id);
      }
    }, { rootMargin: "-20% 0px -60% 0px", threshold: [0.1, 0.4, 0.75] });
    sections.forEach((s) => io.observe(s.el));
    this._scrollSpy = io;
  },

  openModal() {
    this.el.form.reset();
    this.el.backdrop.hidden = false;
    this.el.fieldTask.focus();
  },
  closeModal() {
    this.el.backdrop.hidden = true;
  },

  /* ---------- 通知中心 ---------- */
  toggleNotifs() {
    if (this.el.notifPanel.hidden) this.openNotifs();
    else this.closeNotifs();
  },
  openNotifs() {
    this.el.notifPanel.hidden = false;
    this.el.notifScrim.hidden = false;
    this.el.btnNotif.setAttribute("aria-expanded", "true");
    this.el.notifPanel.focus();
    Notifier.markAllRead();      // 打开即已读
  },
  closeNotifs() {
    this.el.notifPanel.hidden = true;
    this.el.notifScrim.hidden = true;
    this.el.btnNotif.setAttribute("aria-expanded", "false");
    this.el.btnNotif.focus();
  },

  /* ---------- 技能库（读取本地 skill） ---------- */
  _skillOpen: false,
  _skillQuery: "",
  _skillOnlyOn: false,
  _skillScopeLabel: {
    project: "项目 skills/",
    agents: ".agents/skills",
    codex: ".codex/skills",
    dsh: ".dsh/skills",
    custom: "自定义目录",
  },

  async openSkills() {
    const el = this.el;
    el.skillPanel.hidden = false;
    el.skillScrim.hidden = false;
    el.skillBtn.setAttribute("aria-expanded", "true");
    el.skillPanel.focus();
    this._skillOpen = true;
    if (!Skill.loaded) {
      el.skillList.innerHTML = `<div class="skill-empty">正在扫描本地 skill 目录…</div>`;
      await Skill.load();
    }
    this.renderSkills();
  },
  closeSkills() {
    const el = this.el;
    el.skillPanel.hidden = true;
    el.skillScrim.hidden = true;
    el.skillBtn.setAttribute("aria-expanded", "false");
    this._skillOpen = false;
    el.skillDetail.hidden = true;
    el.skillList.hidden = false;
    el.skillBtn.focus();
  },

  renderSkills() {
    const el = this.el;
    const q = this._skillQuery.trim().toLowerCase();
    el.sideSkillCount.textContent = Skill.loaded ? String(Skill.list.length) : "—";

    if (!Skill.loaded || !Skill.list.length) {
      el.skillList.innerHTML =
        `<div class="skill-empty">没读到 skill。<br>检查代理是否在跑（node proxy.js），或往 ./skills/ 里放一个 <code>SKILL.md</code>。</div>`;
      el.skillSummary.textContent = "";
      return;
    }

    let items = Skill.list;
    if (this._skillOnlyOn) items = items.filter((s) => Skill.isEnabled(s.id));
    if (q) {
      items = items.filter(
        (s) => s.id.toLowerCase().includes(q) || (s.description || "").toLowerCase().includes(q)
      );
    }

    // 按来源分组
    const groups = new Map();
    for (const s of items) {
      const g = s.scope;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(s);
    }

    const html = [];
    for (const [scope, arr] of groups) {
      const label = this._skillScopeLabel[scope] || scope;
      html.push(`<div class="skill-group">${escapeHtml(label)} · ${arr.length}</div>`);
      for (const s of arr) {
        const on = Skill.isEnabled(s.id);
        html.push(`
          <div class="skill-item${on ? "" : " off"}" role="listitem" data-id="${escapeHtml(s.id)}">
            <div class="skill-item-main" data-open="${escapeHtml(s.id)}">
              <div class="skill-item-name">
                ${escapeHtml(s.id)}
                <span class="skill-lv skill-lv-${s.level || "read"}">${s.level === "dispatch" ? "需授权" : s.level || "read"}</span>
              </div>
              <div class="skill-item-desc">${escapeHtml(s.description || "（无描述）")}</div>
            </div>
            <button class="skill-sw" type="button" role="switch" aria-checked="${on}"
                    aria-label="${on ? "禁用" : "启用"} ${escapeHtml(s.id)}" data-toggle="${escapeHtml(s.id)}"></button>
          </div>`);
      }
    }
    el.skillList.innerHTML = html.join("") || `<div class="skill-empty">没有匹配的 skill</div>`;
    el.skillList.hidden = false;
    el.skillDetail.hidden = true;

    const on = Skill.list.filter((s) => Skill.isEnabled(s.id)).length;
    el.skillSummary.innerHTML =
      `共 <b>${Skill.list.length}</b> 个 · 启用 <b>${on}</b> · 关闭 <b>${Skill.list.length - on}</b>` +
      (q || this._skillOnlyOn ? ` · 当前显示 <b>${items.length}</b>` : "");
  },

  async showSkillDetail(id) {
    const s = Skill.list.find((x) => x.id === id);
    if (!s) return;
    const el = this.el;
    el.skillList.hidden = true;
    el.skillDetail.hidden = false;
    el.skillDetailName.textContent = s.id;
    el.skillDetailScope.textContent =
      (this._skillScopeLabel[s.scope] || s.scope) + " · " + (s.bodyLen || 0) + " 字";
    el.skillDetailBody.textContent = "读取中…";
    const body = await Skill.body(id);
    el.skillDetailBody.textContent = body || "（读不到正文）";
  },

  /* ---------- 技能库事件绑定 ---------- */
  bindSkills() {
    const el = this.el;
    el.skillBtn.onclick = () => this.openSkills();
    el.skillClose.onclick = () => this.closeSkills();
    el.skillScrim.onclick = () => this.closeSkills();
    el.skillBack.onclick = () => {
      el.skillDetail.hidden = true;
      el.skillList.hidden = false;
    };
    el.skillReload.onclick = async () => {
      el.skillReload.disabled = true;
      el.skillReload.textContent = "扫描中…";
      await Skill.reload();
      el.skillReload.disabled = false;
      el.skillReload.textContent = "重扫";
      this.renderSkills();
      Notifier.add({ level: "info", title: "技能库已重扫", body: `当前 ${Skill.list.length} 个 skill` });
    };
    el.skillSearch.oninput = () => {
      this._skillQuery = el.skillSearch.value;
      this.renderSkills();
    };
    el.skillOnlyOn.onchange = () => {
      this._skillOnlyOn = el.skillOnlyOn.checked;
      this.renderSkills();
    };
    // 事件委托：点开关 / 点条目看详情
    el.skillList.addEventListener("click", (e) => {
      const sw = e.target.closest("[data-toggle]");
      if (sw) {
        const id = sw.dataset.toggle;
        Skill.setEnabled(id, !Skill.isEnabled(id));
        this.renderSkills();
        return;
      }
      const row = e.target.closest("[data-open]");
      if (row) this.showSkillDetail(row.dataset.open);
    });
    // Esc 关闭
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this._skillOpen) this.closeSkills();
    });
    // 侧栏折叠时隐藏入口文字由 CSS 处理；初始计数
    if (Skill.loaded) el.sideSkillCount.textContent = String(Skill.list.length);
  },

  renderNotifs() {
    const list = Notifier.items;
    // 未读角标
    const n = Notifier._unread;
    this.el.notifCount.hidden = n === 0;
    this.el.notifCount.textContent = n > 99 ? "99+" : String(n);
    this.el.notifCount.setAttribute("aria-hidden", "true");

    this.el.notifEmpty.style.display = list.length ? "none" : "block";

    const iconMap = {
      ok:   'M5 12.5 10 17l9-10',                       // 对勾
      warn: 'M12 8v5m0 3h.01',                          // 感叹
      danger: 'M12 8v5m0 3h.01',
      info: 'M12 16v-5m0-3h.01',
    };
    this.el.notifList.innerHTML = list.map((it) => `
      <li class="notif-item level-${it.level}${it.read ? "" : " unread"}">
        <svg class="notif-ic" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6"/>
          <path d="${iconMap[it.level] || iconMap.info}" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
        <div class="notif-text">
          <b>${escapeHtml(it.title)}</b>
          ${it.body ? `<span>${escapeHtml(it.body)}</span>` : ""}
          <time datetime="${new Date(it.at).toISOString()}">${timeAgo(it.at)}</time>
        </div>
      </li>`).join("");
  },

  /* ---------- 轻提示（11.4 结果反馈，非阻断） ---------- */
  toast(msg) {
    let t = document.getElementById("lingoToast");
    if (!t) {
      t = document.createElement("div");
      t.id = "lingoToast";
      t.className = "toast";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
  },

  /* ---------- KPI ---------- */
  renderKPI() {
    const total = Engine.totalInput + Engine.totalOutput;
    const active = Engine.agents.filter((a) => a.status === "running").length;
    this.setKPI(this.el.kpiTotalTokens, fmt(total));
    this.setKPI(this.el.kpiTotalCost, `$${Engine.totalCost.toFixed(4)}`);
    this.setKPI(this.el.kpiInTokens, fmt(Engine.totalInput));
    this.setKPI(this.el.kpiOutTokens, fmt(Engine.totalOutput));
    // 输入/输出两个方向各自烧了多少钱（三者自洽：输入 + 输出 = 总）
    if (this.el.kpiInCost) this.el.kpiInCost.textContent = "$" + Engine.totalCostIn.toFixed(6);
    if (this.el.kpiOutCost) this.el.kpiOutCost.textContent = "$" + Engine.totalCostOut.toFixed(6);

    // 总消耗金额：按账户真实余额的下降量累计（厂商无消费接口，这是唯一权威来源）
    const sp = realSpend();
    this.setKPI(this.el.kpiSpend, sp.sum > 0 ? Money.fmt(sp.sum, sp.currency) : "—");
    if (this.el.kpiSpend) {
      const b = Baseline.data;
      this.el.kpiSpend.title = b
        ? `累计消费 = 累计充值 − 当前余额（自动统计）\n累计充值 ¥${b.topUp.total.toFixed(2)}（基线 ¥${b.topUp.baseline.toFixed(2)} + 自动识别 ¥${b.topUp.auto.toFixed(2)}）\n当前余额 ¥${(b.balanceCNY == null ? 0 : b.balanceCNY).toFixed(2)}｜${Money.note(sp.currency)}`
        : `账户真实余额的累计下降量｜${Money.note(sp.currency)}`;
    }
    // 副行保留任务与活跃数，不丢信息
    this.el.kpiTasks.textContent = `已完成任务 ${Engine.totalTasks} · 活跃 ${active}/${Engine.agents.length}`;
    this.setKPI(this.el.kpiTps, fmt(Engine.tps()));

    // 科技感控制台：迷你走势线 + 环形负载仪表
    const hist = this.chartHistory || [];
    this.drawSpark(this.el.sparkTokens, hist.map((d) => d.in + d.out), tokenColor("--color-data-out"), { delta: true });
    this.drawSpark(this.el.sparkIn, hist.map((d) => d.in), tokenColor("--color-data-in"), { delta: true });
    this.drawSpark(this.el.sparkOut, hist.map((d) => d.out), tokenColor("--color-data-out"), { delta: true });
    this.drawSpark(this.el.sparkTps, (this._tpsHistory || []), tokenColor("--color-data-in"));
    this.updateSpendGauge(sp.sum);
    this.renderSpendPop();
    this.renderRunningTasks();
    this.renderBalances();

    // 技能 §1：以完整语义播报状态变化，不用裸数字，且节流避免刷屏
    const now = Date.now();
    if (this.el.liveRegion && now - (this._lastAnnounce || 0) > 4000) {
      this._lastAnnounce = now;
      this.el.liveRegion.textContent =
        `当前总消耗 ${fmt(total)} tokens，${active} 个 Agent 运行中，已完成 ${Engine.totalTasks} 个任务。`;
    }
  },

  // 仅在数值变化时更新，并触发一次高亮（11.5 状态切换只动一次；避免每帧重放动画）
  setKPI(el, value) {
    if (!el || el.textContent === value) return;
    el.textContent = value;
    el.classList.remove("kpi-bump");
    void el.offsetWidth;            // 重启动画
    el.classList.add("kpi-bump");
  },

  /* ---------- 迷你走势线（sparkline）---------- */
  // 对累计型数据取「每采样增量」，呈现真实吞吐走势（否则单调递增会压成一条直线）
  drawSpark(svg, series, color, opts = {}) {
    if (!svg) return;
    const W = 120, H = 28, P = 2;
    let data = (series || []).slice(-40);
    if (data.length < 2) { svg.innerHTML = ""; return; }
    // 可选：转为增量走势
    if (opts.delta) {
      const d = [];
      for (let i = 1; i < data.length; i++) d.push(Math.max(0, data[i] - data[i - 1]));
      data = d.length >= 2 ? d : [0, 0];
    }
    const min = Math.min(...data);
    const max = Math.max(...data);
    const span = max - min || 1;
    const sx = (W - P * 2) / (data.length - 1);
    const pt = (v, i) => [P + sx * i, H - P - ((v - min) / span) * (H - P * 2)];
    const line = data.map((v, i) => pt(v, i).map((n) => n.toFixed(1)).join(","));
    const last = pt(data[data.length - 1], data.length - 1);
    svg.innerHTML =
      `<polyline points="${line.join(" ")}" fill="none" stroke="${color}" stroke-width="1.6"
         stroke-linejoin="round" stroke-linecap="round" opacity=".9"/>` +
      `<polygon points="${line.join(" ")} ${(W - P).toFixed(1)},${H} ${P},${H}" fill="${color}" opacity=".14"/>` +
      `<circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2" fill="${color}"/>`;
  },

  /* ---------- 用量：今天 / 本月（本地记账）---------- */
  renderUsage() {
    const t = Usage.today();
    const m = Usage.thisMonth();
    const line = (r) => {
      const tok = (r.in || 0) + (r.out || 0);
      if (!r.tasks) return "暂无";
      return `${r.tasks} 个任务 · ${fmt(tok)} tok · $${(r.cost || 0).toFixed(4)}`;
    };
    if (this.el.ccUsageToday) {
      this.el.ccUsageToday.textContent = line(t);
      this.el.ccUsageToday.title = `本调度台自己的任务（UTC 本地日期）\n输入 ${fmt(t.in || 0)} / 输出 ${fmt(t.out || 0)} tokens\n花费按模型单价估算（USD），非账户实际扣费`;
    }
    if (this.el.ccUsageMonth) {
      this.el.ccUsageMonth.textContent = line(m);
      this.el.ccUsageMonth.title = `本调度台自己的任务（本月）\n输入 ${fmt(m.in || 0)} / 输出 ${fmt(m.out || 0)} tokens\n花费按模型单价估算（USD），非账户实际扣费`;
    }
    // 累计已花：由真实余额的下滑量推出（厂商无消费接口）
    if (this.el.ccUsageTotal) {
      const sp = realSpend();
      this.el.ccUsageTotal.textContent = Money.fmt(sp.sum, sp.currency);
      this.el.ccUsageTotal.title = `由真实余额的下降量累计得出（厂商未提供消费接口）｜${Money.note(sp.currency)}`;
    }
  },

  /* ---------- API 实时余额（控制台内联，每个模型一条）---------- */
  renderBalances() {
    const list = this.el.ccBalanceList;
    if (!list) return;
    // 首次构建固定行结构（后续只更新数值，避免闪烁）
    if (list.dataset.built !== "1") {
      list.innerHTML = MODELS.map((m) => `
        <li class="cc-bal-row" data-id="${m.id}">
          <span class="cc-bal-dot" style="background:${m.color}"></span>
          <span class="cc-bal-name">${m.name}</span>
          <span class="cc-bal-amt"></span>
        </li>
        <li class="cc-bal-bar" data-bar="${m.id}"><span class="cc-bal-fill"></span></li>`).join("");
      list.dataset.built = "1";
    }

    let totalRemain = 0, anyWarn = false, knownCount = 0, cur = "";

    // 同一账户下的多个模型（如 V3/R1 共用 DeepSeek 账号）只统计一次，
    // 否则标签里的总余额会被重复相加（¥59.88 × 2 = ¥119.76 的假数）。
    const seenProvider = new Set();

    MODELS.forEach((m) => {
      const amt = list.querySelector(`.cc-bal-row[data-id="${m.id}"] .cc-bal-amt`);
      const fill = list.querySelector(`.cc-bal-bar[data-bar="${m.id}"] .cc-bal-fill`);
      if (!amt || !fill) return;

      const known = m.balanceKnown && m.balance && typeof m.balance.total === "number";
      if (!known) {
        // 查不到就是查不到 —— 明说，不编数字
        const why = m.balance && m.balance.reason ? "（" + m.balance.reason + "）" : "";
        amt.textContent = m.balance && m.balance.error ? "查询失败" : "无法获取" + why;
        amt.classList.add("muted");
        amt.title = m.balance && m.balance.error ? m.balance.error : (m.balance && m.balance.reason) || "";
        fill.style.width = "0%";
        return;
      }
      amt.classList.remove("muted");
      // 真实余额
      const b = m.balance;
      // 已花（按 token 估算）
      const spent = m.spent || 0;
      amt.textContent = Money.fmt(b.total, b.currency);
      // 同一 provider 的多个模型 → 金额后面标注「共用账号」，避免误以为各有这么多
      const shared = MODELS.filter((x) => x.provider === m.provider).length > 1;
      amt.title = `账户真实余额（原始币种 ${b.currency}）｜${shared ? "此账号同时供 " + MODELS.filter((x) => x.provider === m.provider).map((x) => x.name).join(" / ") + " 使用｜" : ""}本次会话估算花费 ${Money.fmt(spent, b.currency, 4)}｜来源：${b.source || "接口"}｜${Money.note(b.currency)}`;
      amt.classList.remove("warn", "danger");
      amt.classList.toggle("warn", spent > b.total * 0.5 && b.total > 0);
      amt.classList.toggle("danger", b.available === false || spent > b.total);

      // 余额条：真实余额里"已花占比"（花费 / 余额），花超了就是满红
      const ratio = b.total > 0 ? Math.min(1, spent / b.total) : 0;
      const barColor = ratio >= 0.85 ? tokenColor("--color-accent")
        : ratio >= 0.5 ? tokenColor("--color-warning")
        : m.color;
      fill.style.width = Math.max(2, ratio * 100).toFixed(1) + "%";
      fill.style.background = barColor;

      // 同一 provider 只累加一次
      if (!seenProvider.has(m.provider)) {
        seenProvider.add(m.provider);
        totalRemain += b.total;
        cur = b.currency;
      }
      knownCount++;
      if (b.available === false) anyWarn = true;
    });

    if (this.el.ccBalanceTag) {
      this.el.ccBalanceTag.textContent = knownCount
        ? (anyWarn ? "LOW" : Money.fmt(totalRemain, cur))
        : "N/A";
      this.el.ccBalanceTag.style.color = anyWarn ? tokenColor("--color-accent") : "";
      this.el.ccBalanceTag.title = knownCount
        ? `账户真实可用余额｜${Money.note(cur)}`
        : "该厂商未提供余额查询接口";
    }
  },

  /* ---------- ② 成本归因 ---------- */
  /* 合计 = 真实累计已花（余额推算，权威）；
     每个模型 = 合计 × 该模型的真实 token 用量占比。
     占比来自 opencode 库（跨全部会话）；拿不到时回退本地账本。
     厂商只给账户级余额，无法直接按模型拆分 —— 这是「按用量占比分摊」，
     比例真实、总额真实，但单模型金额是分摊值，不是账单。 */
  renderCostAttr() {
    const list = this.el.costAttrList;
    if (!list) return;

    const real = realSpend();

    const share = {};
    let shareSum = 0;
    MODELS.forEach((m) => {
      let toks = 0;
      const oc = (OcActivity.byModel || []).find((x) => x.id === m.id || x.id === m.apiModel);
      if (oc) toks = (oc.input || 0) + (oc.output || 0);
      if (!toks) toks = Usage.modelTokens(m.id);   // 回退：本地账本
      share[m.id] = toks;
      shareSum += toks;
    });

    const alloc = {};
    let maxAlloc = 0;
    MODELS.forEach((m) => {
      const v = shareSum > 0 ? real.sum * (share[m.id] / shareSum) : null;
      alloc[m.id] = v;
      if (v != null) maxAlloc = Math.max(maxAlloc, v);
    });

    if (list.dataset.built !== "1") {
      list.innerHTML = MODELS.map((m) => `
        <div class="cost-row" data-id="${m.id}">
          <span class="cost-name"><span class="cost-dot" style="background:${m.color}"></span>${m.name}</span>
          <span class="cost-track"><span class="cost-fill"></span></span>
          <span class="cost-amt"></span>
        </div>`).join("");
      list.dataset.built = "1";
    }

    MODELS.forEach((m) => {
      const row = list.querySelector(`.cost-row[data-id="${m.id}"]`);
      if (!row) return;
      const fill = row.querySelector(".cost-fill");
      const amt = row.querySelector(".cost-amt");
      const v = alloc[m.id];
      const pct = v != null && maxAlloc > 0 ? (v / maxAlloc) * 100 : 0;
      fill.style.width = Math.max(v > 0 ? 2 : 0, pct).toFixed(1) + "%";
      fill.style.background = m.color;
      amt.textContent = v == null ? "—" : Money.fmt(v, real.currency);
      amt.title = v == null ? "无用量占比数据" : `按真实 token 用量占比分摊（${(share[m.id] / shareSum * 100).toFixed(1)}%）｜${Money.note(real.currency)}`;
      row.classList.toggle("zero", !(v > 0));
    });

    if (this.el.costAttrTotal) {
      this.el.costAttrTotal.textContent = `合计 ${Money.fmt(real.sum, real.currency)}`;
      this.el.costAttrTotal.title = (shareSum > 0
        ? "真实累计已花（由余额下降量推算）；各模型按真实 token 用量占比分摊"
        : "真实累计已花；但暂无各模型用量占比数据") + `｜${Money.note(real.currency)}`;
    }
  },

  /* ---------- ③ Trace 明细表 ---------- */
  _traceSort: { key: "createdAt", dir: "desc" },

  renderTraces() {
    const tb = this.el.traceBody;
    if (!tb) return;
    const list = Engine.traces;
    if (this.el.traceHint) this.el.traceHint.textContent = `共 ${list.length} 条`;
    if (this.el.traceEmpty) this.el.traceEmpty.hidden = list.length > 0;

    const { key, dir } = this._traceSort;
    const sign = dir === "asc" ? 1 : -1;
    const sorted = [...list].sort((a, b) => {
      let va = a[key], vb = b[key];
      if (typeof va === "string") return va.localeCompare(vb, "zh") * sign;
      return (va - vb) * sign;
    });

    // 记录已展开的行，重建后保留
    const open = new Set(
      [...tb.querySelectorAll(".trace-row.expanded")].map((r) => r.dataset.id)
    );

    tb.innerHTML = sorted.map((t) => {
      const time = new Date(t.createdAt).toLocaleTimeString("zh-CN", { hour12: false });
      const st = t.status === "failed"
        ? '<span class="trace-status failed">失败</span>'
        : t.status === "running"
        ? '<span class="trace-status running">运行中</span>'
        : '<span class="trace-status done">成功</span>';
      const isOpen = open.has(t.id);
      const main = `
        <tr class="trace-row${isOpen ? " expanded" : ""}" data-id="${t.id}">
          <td class="col-exp">
            <button class="trace-exp" aria-expanded="${isOpen}" aria-label="展开运行详情">${isOpen ? "▾" : "▸"}</button>
          </td>
          <td>${time}</td>
          <td>${escapeHtml(t.name)}</td>
          <td><span class="trace-model-dot" style="background:${t.modelColor}"></span>${escapeHtml(t.model)}</td>
          <td class="num">${fmt(t.input)}</td>
          <td class="num">${fmt(t.output)}</td>
          <td class="num">${t.latency ? t.latency.toFixed(1) + "s" : "—"}</td>
          <td class="num">$${t.cost.toFixed(4)}</td>
          <td>${st}</td>
        </tr>`;
      const detail = isOpen ? `
        <tr class="trace-detail-row"><td colspan="9"><div class="trace-detail">
          <div><h5>任务</h5><pre>${escapeHtml(t.task || "")}</pre></div>
          <div><h5>产出</h5><pre>${escapeHtml(t.output_text || "")}</pre></div>
        </div></td></tr>` : "";
      return main + detail;
    }).join("");
  },

  bindTraceTable() {
    const table = this.el.traceTable;
    if (!table) return;
    // 展开/收起（事件委托）
    this.el.traceBody.addEventListener("click", (e) => {
      const btn = e.target.closest(".trace-exp");
      if (!btn) return;
      const row = btn.closest(".trace-row");
      const id = row.dataset.id;
      const open = row.classList.toggle("expanded");
      btn.setAttribute("aria-expanded", String(open));
      btn.textContent = open ? "▾" : "▸";
      // 就地插入/移除详情行
      const next = row.nextElementSibling;
      if (open) {
        if (!next || !next.classList.contains("trace-detail-row")) {
          const t = Engine.traces.find((x) => x.id === id);
          if (t) {
            const tr = document.createElement("tr");
            tr.className = "trace-detail-row";
            tr.innerHTML = `<td colspan="9"><div class="trace-detail">
              <div><h5>任务</h5><pre></pre></div>
              <div><h5>产出</h5><pre></pre></div>
            </div></td>`;
            tr.querySelectorAll("pre")[0].textContent = t.task || "";
            tr.querySelectorAll("pre")[1].textContent = t.output_text || "";
            row.after(tr);
          }
        }
      } else if (next && next.classList.contains("trace-detail-row")) {
        next.remove();
      }
    });
    // 排序（点击表头）
    table.querySelectorAll("th.sortable").forEach((th) => {
      th.tabIndex = 0;
      const doSort = () => {
        const key = th.dataset.sort;
        if (this._traceSort.key === key) {
          this._traceSort.dir = this._traceSort.dir === "asc" ? "desc" : "asc";
        } else {
          this._traceSort = { key, dir: key === "name" || key === "model" || key === "status" ? "asc" : "desc" };
        }
        table.querySelectorAll("th").forEach((h) => h.removeAttribute("aria-sort"));
        th.setAttribute("aria-sort", this._traceSort.dir === "asc" ? "ascending" : "descending");
        this.renderTraces();
      };
      th.addEventListener("click", doSort);
      th.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); doSort(); }
      });
    });
  },

  /* ---------- ④ 时间范围 ---------- */
  chartRange: 3600,   // 秒；0 = 全部
  bindRange() {
    document.querySelectorAll(".range-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".range-btn").forEach((b) => {
          b.classList.remove("active"); b.setAttribute("aria-pressed", "false");
        });
        btn.classList.add("active");
        btn.setAttribute("aria-pressed", "true");
        this.chartRange = parseInt(btn.dataset.range, 10) || 0;
        this.drawChart();
      });
    });
  },

  /* ---------- 进行中任务（简明列表）----------
     真实 API 的短任务常 1 秒内跑完，如果只显示 running/queued，
     用户根本看不到它。所以这里把「刚刚完成（30 秒内）」的也一起列出，
     用不同颜色区分，让短任务有个可见的收尾。
     ------------------------------------------------------------------ */
  renderRunningTasks() {
    const list = this.el.ccTaskList;
    if (!list) return;
    const MAX = 3;           // 不滚动，最多展示 3 条
    const RECENT_MS = 30000; // 完成 30 秒内仍显示
    const now = Date.now();

    const running = Engine.agents.filter((a) => a.status === "running" || a.status === "queued");
    const recent = Engine.agents.filter(
      (a) =>
        a.status !== "running" &&
        a.status !== "queued" &&
        a.finishedAt &&
        now - a.finishedAt < RECENT_MS
    );
    const shown = [...running, ...recent].slice(0, MAX);

    // 标签：进行中数量为主，有刚完成的补一个 ✓
    if (this.el.ccRunningTag) {
      const extraDone = recent.length ? ` · ${recent.length} DONE` : "";
      this.el.ccRunningTag.textContent = `${running.length} RUNNING${extraDone}`;
    }

    if (shown.length === 0) {
      if (this.el.ccTaskEmpty) this.el.ccTaskEmpty.hidden = false;
      list.querySelectorAll(".cc-task-item, .cc-task-more").forEach((n) => n.remove());
      return;
    }
    if (this.el.ccTaskEmpty) this.el.ccTaskEmpty.hidden = true;

    // 重建（顺序会变：running 在前、recent 在后，直接按 id 对比成本低）
    const sig = shown.map((a) => a.id + a.status).join("|");
    if (list.dataset.sig !== sig) {
      list.dataset.sig = sig;
      list.querySelectorAll(".cc-task-item, .cc-task-more").forEach((n) => n.remove());
      shown.forEach((a) => {
        const li = document.createElement("li");
        li.className = "cc-task-item" + (a.status === "done" ? " cc-task-done" : "");
        if (a.status === "failed") li.classList.add("cc-task-failed");
        li.dataset.id = a.id;
        li.innerHTML =
          `<span class="cc-task-dot" aria-hidden="true"></span>` +
          `<span class="cc-task-name"></span><span class="cc-task-desc"></span>`;
        list.appendChild(li);
      });
    }

    shown.forEach((a) => {
      const li = list.querySelector(`.cc-task-item[data-id="${a.id}"]`);
      if (!li) return;
      const name = li.querySelector(".cc-task-name");
      const desc = li.querySelector(".cc-task-desc");
      const task = (a.task || "").replace(/\s+/g, " ");
      const brief = task.length > 34 ? task.slice(0, 34) + "…" : task;
      if (name.textContent !== a.name) name.textContent = a.name;
      const tail =
        a.status === "done" ? "已完成"
        : a.status === "failed" ? "失败"
        : a.status === "queued" ? "排队中"
        : "运行中";
      const dText = `${a.model.name} · ${brief} · ${tail}`;
      if (desc.textContent !== dText) desc.textContent = dText;
      desc.title = dText;
    });
  },

  /* ---------- 用量弹层：成本 / 使用率 / 词元数 ---------- */
  renderSpendPop() {
    if (!this.el.spendPop) return;
    const sp = realSpend();

    // 成本：真实扣费（余额下降量推算）
    if (this.el.spendPopCost) {
      this.el.spendPopCost.textContent = sp.sum > 0 ? Money.fmt(sp.sum, sp.currency) : "—";
      this.el.spendPopCost.title = `总消耗金额：账户真实余额的累计下降量（非估算）｜${Money.note(sp.currency)}`;
    }

    // 估算成本：按模型官方单价算出的理论费用（opencode 全部会话 + 本调度台账本）
    if (this.el.spendPopEst) {
      const t = OcActivity.totals;
      const ocCost = t ? t.cost || 0 : 0;
      const loc = Usage.cumulative();
      const est = ocCost + loc.cost;
      this.el.spendPopEst.textContent = est > 0 ? Money.fmt(est, "USD") : "—";
      this.el.spendPopEst.title = `按模型官方单价估算的理论费用（价表口径，非账户实际扣费）\n`
        + `opencode $${ocCost.toFixed(4)} + 本调度台 $${loc.cost.toFixed(4)}`;
    }

    // 使用率：已消耗 ÷（已消耗 + 当前余额）
    if (this.el.spendPopRate) {
      const m0 = MODELS.find((m) => m.balanceKnown && m.balance && typeof m.balance.total === "number");
      const remain = m0 ? m0.balance.total : 0;
      const denom = sp.sum + remain;
      this.el.spendPopRate.textContent = denom > 0 ? Math.round((sp.sum / denom) * 100) + "%" : "—";
      this.el.spendPopRate.title = "已消耗 ÷（已消耗 + 当前余额）";
    }

    // 词元数：自动统计（opencode 本地库），拿不到时回落到本机记录
    if (this.el.spendPopTokens) {
      let total = Baseline.tokens();
      let src = "自动统计：opencode 本地库全部会话";
      if (total == null) {
        const t = OcActivity.totals;
        const ocTok = t ? (t.input || 0) + (t.output || 0) : 0;
        const loc = Usage.cumulative();
        total = ocTok + loc.in + loc.out;
        src = "本机记录：opencode 全部会话 + 本调度台本地账本";
      }
      this.el.spendPopTokens.textContent = total > 0 ? fmt(total) : "—";
      this.el.spendPopTokens.title = "累计 token：" + src + "（自动统计）";
    }
  },

  /* ---------- 环形消耗仪表 ---------- */
  /* 已消耗占「已消耗 + 当前余额」的比例：一眼看出账户被用掉多少 */
  updateSpendGauge(spent) {
    const arc = this.el.spendGaugeArc;
    if (!arc) return;
    const C = 2 * Math.PI * 17;                 // 与 r=17 对应
    // 当前余额（同币种）作为分母的另一半
    let remain = 0;
    const m0 = MODELS.find((m) => m.balanceKnown && m.balance && typeof m.balance.total === "number");
    if (m0) remain = m0.balance.total;
    const denom = spent + remain;
    const ratio = denom > 0 ? Math.min(1, spent / denom) : 0;
    arc.style.strokeDashoffset = String(C * (1 - ratio));
    arc.style.stroke = ratio > 0.85 ? tokenColor("--color-accent")
      : ratio > 0.5 ? tokenColor("--color-warning")
      : tokenColor("--color-primary");
  },

  /* ---------- 额度 ---------- */
  renderQuotas() {
    // 首次构建；之后原地更新，保证进度条 width 过渡平滑（11.9 状态切换 ease-in-out）
    if (this.el.quotaList.dataset.built !== "1") {
      this.el.quotaList.innerHTML = MODELS.map((m, i) => `
        <div class="quota-item" data-idx="${i}">
          <div class="quota-top">
            <div class="quota-name">
              <span class="quota-loc ${m.location}">${m.location === "local" ? "本地" : "云端"}</span>
              ${m.name}
            </div>
            <span class="quota-num"></span>
          </div>
          <div class="quota-bar"><div class="quota-fill"></div></div>
          <div class="quota-sub"><span>${m.vendor}</span><span class="quota-remain"></span></div>
        </div>`).join("");
      this.el.quotaList.dataset.built = "1";
    }

    MODELS.forEach((m, i) => {
      const row = this.el.quotaList.querySelector(`[data-idx="${i}"]`);
      if (!row) return;
      const numEl = row.querySelector(".quota-num");
      const fill = row.querySelector(".quota-fill");
      const remainEl = row.querySelector(".quota-remain");

      const known = m.balanceKnown && m.balance && typeof m.balance.total === "number";
      if (!known) {
        // 查不到余额：不画进度条，写明原因
        numEl.textContent = "—";
        fill.style.width = "0%";
        const why = m.balance && m.balance.reason ? m.balance.reason
          : m.balance && m.balance.error ? ("查询失败：" + m.balance.error)
          : "无余额接口";
        remainEl.textContent = why;
        return;
      }

      const b = m.balance;
      const spent = m.spent || 0;
      const ratio = b.total > 0 ? Math.min(1, spent / b.total) : 0;
      const pct = ratio * 100;
      const color = pct > 85 ? "var(--red)" : pct > 50 ? "var(--amber)" : "var(--green)";
      // 顶部数字：直接显示真实余额（按 USD 展示）
      numEl.textContent = Money.fmt(b.total, b.currency);
      fill.style.width = Math.max(1.5, pct) + "%";
      fill.style.background = color;
      fill.style.opacity = 0.85;
      // 副行：充值/赠金拆分 + 本次花费（参考 CodexBar 的 Paid / Granted 标注）
      const bits = [];
      if (typeof b.topped_up === "number" && b.topped_up > 0) bits.push(`充值 ${Money.fmt(b.topped_up, b.currency)}`);
      if (typeof b.granted === "number" && b.granted > 0) bits.push(`赠金 ${Money.fmt(b.granted, b.currency)}`);
      const split = bits.length ? bits.join(" / ") + " · " : "";
      remainEl.textContent = `${split}本次已花 ${Money.fmt(spent, b.currency, 6)}`;
      remainEl.title = `来源：${b.source || "余额接口"}｜原始币种 ${b.currency}｜${Money.note(b.currency)}｜账户可用：${b.available ? "是" : "否"}`;
      if (b.available === false) remainEl.textContent = "⚠ 余额不足 " + remainEl.textContent;
    });
    this.el.quotaUpdated.textContent = "更新于 " + new Date().toLocaleTimeString("zh-CN");
    this.renderBalances();   // 控制台内联余额同步刷新
    this.renderCostAttr();   // 成本归因
    Notifier.checkQuota();   // 自建通知：额度阈值检查
  },

  /* ---------- Agent 卡片 ---------- */
  renderAgents() {
    const list = Engine.agents;
    this.el.agentHint.textContent = `共 ${list.length} 个`;
    this.el.empty.classList.toggle("show", list.length === 0);

    // 保留 DOM 以支持平滑流式更新：仅当结构变化时重建
    const existing = new Map([...this.el.grid.children].map((n) => [n.dataset.id, n]));
    const wanted = new Set(list.map((a) => a.id));

    // 移除已删除的
    for (const [id, node] of existing) if (!wanted.has(id)) node.remove();

    // 按顺序插入 / 创建
    list.forEach((a, idx) => {
      let card = existing.get(a.id);
      if (!card) {
        card = this.createCard(a);
        this.el.grid.appendChild(card);
      }
      // 简单保证顺序（unshift 的最新在最前）
      if (this.el.grid.children[idx] !== card) {
        this.el.grid.insertBefore(card, this.el.grid.children[idx] || null);
      }
      this.updateAgent(a);
    });
  },

  createCard(a) {
    const card = document.createElement("div");
    card.className = "agent-card";
    card.dataset.id = a.id;
    card.innerHTML = `
      <div class="agent-top">
        <div class="agent-id">
          <div class="agent-avatar" style="--av-color:${a.model.color}">
            <img src="./brand-assets/lingo-robot-head.png" alt="" aria-hidden="true" />
          </div>
          <div class="agent-meta">
            <div class="agent-name">${escapeHtml(a.name)}</div>
            <div class="agent-model">${a.model.name} · ${a.model.vendor}</div>
          </div>
        </div>
        <div class="status-badge status-queued">排队中</div>
      </div>
      <div class="agent-task">任务：${escapeHtml(a.task)}</div>
      <div class="agent-output"></div>
      <div class="agent-stats">
        <div class="stat"><div class="stat-label">输入</div><div class="stat-value in">0</div></div>
        <div class="stat"><div class="stat-label">输出</div><div class="stat-value out">0</div></div>
        <div class="stat"><div class="stat-label">费用</div><div class="stat-value cost">$0.0000</div></div>
        <div class="stat"><div class="stat-label">耗时</div><div class="stat-value lat">—</div></div>
      </div>
      <div class="agent-foot">
        <span class="foot-status">等待中…</span>
        <span class="foot-time">—</span>
      </div>`;
    return card;
  },

  updateAgent(a) {
    const card = this.el.grid.querySelector(`[data-id="${a.id}"]`);
    if (!card) return;

    card.classList.toggle("running", a.status === "running");
    card.classList.toggle("done", a.status === "done");
    card.classList.toggle("failed", a.status === "failed");

    const badge = card.querySelector(".status-badge");
    const map = {
      queued: ["status-queued", "排队中"],
      running: ["status-running", "运行中"],
      done: ["status-done", "已完成"],
      failed: ["status-failed", "已失败"],
    };
    const [cls, text] = map[a.status] || map.queued;
    badge.className = "status-badge " + cls;
    badge.textContent = text;

    // 流式输出
    const out = card.querySelector(".agent-output");
    const shown = a.fullOutput.slice(0, a.printed);
    out.textContent = shown;
    if (a.status === "running") {
      const cur = document.createElement("span");
      cur.className = "cursor";
      out.appendChild(cur);
    }
    if (a.status === "running") out.scrollTop = out.scrollHeight;

    // 统计
    card.querySelector(".stat-value.in").textContent = fmt(a.tokens.input);
    card.querySelector(".stat-value.out").textContent = fmt(a.tokens.output);
    card.querySelector(".stat-value.cost").textContent = `$${a.cost.toFixed(4)}`;
    // ① 耗时（运行中实时显示，完成后定格）
    const lat = card.querySelector(".stat-value.lat");
    if (a.finishedAt) lat.textContent = `${((a.finishedAt - a.createdAt) / 1000).toFixed(1)}s`;
    else if (a.status === "running") lat.textContent = `${((Date.now() - a.createdAt) / 1000).toFixed(1)}s`;
    else lat.textContent = "—";

    // 底部
    card.querySelector(".foot-status").textContent =
      a.status === "queued" ? "等待调度…" :
      a.status === "running" ? "正在生成…" :
      a.status === "failed" ? "生成中断 · 失败" :
      `完成 · 共 ${fmt(a.tokens.input + a.tokens.output)} tokens`;
    card.querySelector(".foot-time").textContent =
      a.finishedAt ? `用时 ${((a.finishedAt - a.createdAt) / 1000).toFixed(1)}s` : "—";
  },

  /* ---------- 趋势图 ---------- */
  drawChart() {
    const c = this.el.trendChart;
    const ctx = c.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = 180;
    c.width = w * dpr;
    c.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // ④ 按时间范围截取采样（每采样 800ms）
    const maxPoints = this.chartRange > 0 ? Math.max(2, Math.round(this.chartRange / 0.8)) : 300;
    const data = this.chartHistory.slice(-maxPoints);
    const pad = 10;
    const max = Math.max(100, ...data.map((d) => Math.max(d.in, d.out)));
    const stepX = (w - pad * 2) / Math.max(1, data.length - 1);

    // 网格（深色控制台面板上的浅色网格线）
    ctx.strokeStyle = "rgba(147,116,255,0.14)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad + ((h - pad * 2) / 4) * i;
      ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(w - pad, y); ctx.stroke();
    }

    const drawSeries = (key, color, dashed) => {
      if (data.length < 2) return;
      // 发光描边（科技感 HUD 光带）
      const stroke = (width, alpha) => {
        ctx.beginPath();
        data.forEach((d, i) => {
          const x = pad + stepX * i;
          const y = h - pad - (d[key] / max) * (h - pad * 2);
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        });
        ctx.strokeStyle = color; ctx.lineWidth = width; ctx.globalAlpha = alpha;
        ctx.lineJoin = "round"; ctx.lineCap = "round";
        // 技能 §10：用线型（实线/虚线）区分系列，不单靠颜色（色盲友好）
        ctx.setLineDash(dashed ? [6, 4] : []);
        ctx.stroke();
        ctx.setLineDash([]); ctx.globalAlpha = 1;
      };
      stroke(5, 0.16);   // 外发光
      stroke(2, 1);      // 主线

      // 面积填充（仅实线系列，避免视觉噪音）
      if (!dashed) {
        ctx.beginPath();
        data.forEach((d, i) => {
          const x = pad + stepX * i;
          const y = h - pad - (d[key] / max) * (h - pad * 2);
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        });
        ctx.lineTo(pad + stepX * (data.length - 1), h - pad);
        ctx.lineTo(pad, h - pad);
        ctx.closePath();
        const grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, color + "44");
        grad.addColorStop(1, color + "00");
        ctx.fillStyle = grad; ctx.fill();
      }
    };

    drawSeries("in", tokenColor("--color-data-in"), false);  // 输入 · 实线
    drawSeries("out", tokenColor("--color-data-out"), true); // 输出 · 虚线

    // 屏幕阅读器摘要刷新（技能 §10 screen-reader-summary）
    if (data.length >= 2) {
      const last = data[data.length - 1];
      c.setAttribute("aria-label",
        `Token 消耗趋势：最新采样输入 ${fmt(last.in)}、输出 ${fmt(last.out)} tokens，共 ${data.length} 个采样点。`);
    }
    this.updateChartTable(data);
  },

  // 图表数据表兜底（技能 §10 data-table）
  updateChartTable(data) {
    if (!this.el.chartTable) return;
    const tbody = this.el.chartTable.querySelector("tbody");
    const rows = data.slice(-6);   // 最近 6 个采样，避免过长
    tbody.innerHTML = rows.map((d, i) => {
      const n = data.length - rows.length + i + 1;
      return `<tr><td>${n}</td><td>${fmt(d.in)}</td><td>${fmt(d.out)}</td></tr>`;
    }).join("");
  },

  /* ---------- Lingo 助手情绪状态机（机器人即助手本人）---------- */
  // 情绪状态表：state -> { text, mood, label }
  // mood 驱动 CSS 动画与配色，text 是助手播报，label 用于 aria / tooltip
  BOT_EMOTIONS: {
    idle:     { mood: "idle",   label: "待命" },
    running:  { mood: "active", label: "处理中" },
    queued:   { mood: "active", label: "排队中" },
    done:     { mood: "happy",  label: "已完成" },
    warning:  { mood: "warn",   label: "额度告警" },
    failed:   { mood: "error",  label: "有失败" },
    paused:   { mood: "sleep",  label: "已暂停" },
  },

  // 外部 hook 状态驱动情绪（优先级高于本地引擎，但用户暂停时让位）
  setBotMoodFromHook(state, mood, label, evt) {
    // 用户主动暂停时不覆盖
    if (Engine.paused) return;
    this._hookActive = true;
    this._hookState = state;
    this._hookMood = mood;
    const msg = evt.label || evt.detail || label;
    this.sayBot(`${evt.source || "外部 Agent"}：${msg}`, state, mood, label);
    // 外部状态 6 秒没更新 → 交回本地引擎
    clearTimeout(this._hookTimeout);
    this._hookTimeout = setTimeout(() => {
      this._hookActive = false;
      this.updateBotVoice();
    }, 6000);
  },

  sayBot(msg, state, moodOverride, labelOverride) {
    const el = document.getElementById("sideBotMsg");
    if (el && el.textContent !== msg) el.textContent = msg;
    const live = document.getElementById("sideBotLive");
    if (live && live.textContent !== msg) live.textContent = msg;
    if (moodOverride) this._applyMood(moodOverride, labelOverride, state);
    else if (state) this.setBotMood(state);
  },

  // 直接应用 mood（外部 hook 用，绕过 BOT_EMOTIONS 表）
  _applyMood(mood, label, state) {
    this._botState = state;
    this._botMood = mood;
    document.querySelectorAll(".side-bot").forEach((n) => {
      n.dataset.mood = mood;
      n.dataset.state = state || "";
      n.title = `Lingo 助手 · ${label || mood}`;
      n.setAttribute("aria-label", `Lingo 助手（${label || mood}）：点击派发新任务`);
    });
    const head = document.querySelector(".console-head");
    if (head) head.dataset.mood = mood;
    Pet.setMood(mood, label);
  },

  // 切换机器人的情绪外观（数据驱动，全部作用于 .bot-mood-* 类）
  setBotMood(state) {
    const conf = this.BOT_EMOTIONS[state] || this.BOT_EMOTIONS.idle;
    this._botState = state;
    this._botMood = conf.mood;
    document.querySelectorAll(".side-bot").forEach((n) => {
      n.dataset.mood = conf.mood;
      n.dataset.state = state;
      n.title = `Lingo 助手 · ${conf.label}`;
      // 无障碍：把情绪并入可读标签
      n.setAttribute("aria-label", `Lingo 助手（${conf.label}）：点击派发新任务`);
    });
    // 指挥台栏头的小机器人同步情绪
    const head = document.querySelector(".console-head");
    if (head) head.dataset.mood = conf.mood;
    // 桌宠同步情绪
    Pet.setMood(conf.mood);
  },

  updateBotVoice() {
    // 外部 hook 正在主导情绪时，本地引擎不抢话筒
    if (this._hookActive) return;
    const running = Engine.agents.filter((a) => a.status === "running").length;
    const queued = Engine.agents.filter((a) => a.status === "queued").length;
    const failed = Engine.agents.filter(
      (a) => a.status === "failed" && !a.failureAcked
    ).length;
    const lowQuota = MODELS.some((m) => {
      const { used, total } = m.quota;
      return (used / total) >= 0.85;
    });

    // 优先级：暂停 > 失败 > 运行中 > 排队 > 额度告警 > 完成 > 待命
    if (Engine.paused) { this.sayBot("已暂停，随时可继续", "paused"); return; }
    if (failed > 0) { this.sayBot(`有 ${failed} 个任务失败了`, "failed"); return; }
    if (running > 0) { this.sayBot(`正在处理 ${running} 个任务…`, "running"); return; }
    if (queued > 0) { this.sayBot(`${queued} 个任务排队中`, "queued"); return; }
    if (lowQuota) { this.sayBot("有模型余额偏低，注意额度", "warning"); return; }
    if (Engine.totalTasks > 0) { this.sayBot(`已完成 ${Engine.totalTasks} 个任务`, "done"); return; }
    this.sayBot("随时待命，可派发任务", "idle");
  },

  /* ---------- API 模式指示 ---------- */
  renderApiMode(health) {
    const el = document.getElementById("apiMode");
    const txt = document.getElementById("apiModeText");
    if (!el || !txt) return;

    if (!health) {
      // 代理没起来
      el.dataset.mode = "demo";
      txt.textContent = "演示模式";
      el.title = "代理未启动。运行 node start.js 后可用真实 API；当前使用本地模拟数据。";
      return;
    }

    const provs = health.providers || {};
    const live = Object.entries(provs).filter(([, p]) => p.configured).map(([k]) => k);
    if (live.length) {
      el.dataset.mode = "live";
      txt.textContent = `真实 API · ${live.join("/")}`;
      el.title = live.map((k) => `${k}: ${provs[k].baseUrl}`).join("\n");
    } else {
      // 代理在，但一个 key 都没配
      el.dataset.mode = "demo";
      txt.textContent = "演示模式";
      el.title = "代理已启动，但未配置任何密钥。\n用 node setkey.js deepseek 配置后访问 /api/reload 生效。";
    }
  },

  /* ---------- 暂停状态 ---------- */
  renderPause() {
    const p = Engine.paused;
    this.el.livePill.classList.toggle("paused", p);
    this.el.liveText.textContent = p ? "已暂停" : "实时运行中";
    const side = document.getElementById("sideStatus");
    if (side) side.textContent = p ? "已暂停" : "系统运行中";
    const btn = document.getElementById("btnPause");
    btn.setAttribute("aria-pressed", String(p));
    if (this.el.btnPauseText) this.el.btnPauseText.textContent = p ? "继续" : "暂停";
    this.updateBotVoice();
  },

  renderAll() {
    this.renderKPI();
    this.renderQuotas();
    this.renderAgents();
    this.renderPause();
    this.drawChart();
    this.renderNotifs();
    this.renderTraces();
  },

  /* ---------- 定时循环 ---------- */
  startLoop() {
    setInterval(() => {
      if (Engine.paused) return;
      // 趋势图采样
      this.chartHistory.push({ in: Engine.totalInput, out: Engine.totalOutput });
      if (this.chartHistory.length > 300) this.chartHistory.shift();
      // TPS 采样（控制台迷你走势线）
      this._tpsHistory = this._tpsHistory || [];
      this._tpsHistory.push(Engine.tps());
      if (this._tpsHistory.length > 120) this._tpsHistory.shift();
      this.renderKPI();
      this.drawChart();
      this.renderQuotas();
      this.renderUsage();   // 累计已花与 KPI 同源，必须一起刷新，否则两边会不一致
      this.updateBotVoice();
      // 让「刚刚完成」的任务到点消失（30s 窗口）
      this.renderRunningTasks();
    }, 800);
    // 指挥台时钟（控制台状态显示）
    const clock = document.getElementById("consoleClock");
    if (clock) {
      const tick = () => { clock.textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false }); };
      tick(); setInterval(tick, 1000);
    }
    window.addEventListener("resize", () => this.drawChart());
  },
};

/* =====================================================================
 * Skill 注册表客户端
 * ---------------------------------------------------------------------
 * 让桌宠能「调用 skill」—— 像 opencode / Claude Code 那样。
 *
 * 两类来源（都在 proxy 侧扫描）：
 *   1. 你已有的 skill 库：.agents / .codex / .dsh 下的 skills
 *   2. 项目自建：./skills/<id>/SKILL.md
 *
 * 触发方式：自动按需注入
 *   用户发一句话 → 本地关键词打分 → 命中的 skill 正文拼进 system prompt
 *   —— 用户完全无感，就像豆包自动带上相关知识。
 *
 * 权限分级（level 字段）：
 *   read     只读：直接跑，不动数据
 *   dispatch 派发：要用户授权（Codex 式确认），确认后才真正派任务
 * ===================================================================== */
const Skill = {
  url: "http://127.0.0.1:8900",
  list: [],            // [{id, description, scope, argumentHint}]
  loaded: false,
  _bodies: {},         // id -> 正文（懒加载 + 缓存）
  _inflight: null,     // 防止并发重复加载
  disabled: new Set(), // 被用户关掉的 skill id（不进候选）
  LS_DISABLED: "lingo.skill.disabled",
  sources: [],         // 扫描目录（后端返回）

  // 从 localStorage 读禁用列表
  loadPrefs() {
    try {
      const raw = localStorage.getItem(this.LS_DISABLED);
      if (raw) this.disabled = new Set(JSON.parse(raw));
    } catch (_) { this.disabled = new Set(); }
  },
  savePrefs() {
    try { localStorage.setItem(this.LS_DISABLED, JSON.stringify([...this.disabled])); } catch (_) {}
  },
  isEnabled(id) { return !this.disabled.has(id); },
  setEnabled(id, on) {
    if (on) this.disabled.delete(id); else this.disabled.add(id);
    this.savePrefs();
  },
  enabledCount() { return this.list.filter((s) => this.isEnabled(s.id)).length; },

  // 拉取 skill 索引（不含正文）
  async load() {
    if (this._inflight) return this._inflight;
    this._inflight = (async () => {
      try {
        const r = await fetch(this.url + "/api/skills", { signal: AbortSignal.timeout(3000) });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const j = await r.json();
        this.list = j.skills || [];
        this.sources = j.sources || [];
        this.loaded = true;
        return this.list;
      } catch (_) {
        this.loaded = false;
        this.list = [];
        return [];
      } finally {
        this._inflight = null;
      }
    })();
    return this._inflight;
  },

  // 通知后端重扫目录（往 skills/ 里放了新 skill 后）
  async reload() {
    try {
      await fetch(this.url + "/api/skills/reload", { method: "POST", signal: AbortSignal.timeout(3000) });
    } catch (_) {}
    this._bodies = {};
    this._inflight = null;
    return this.load();
  },

  // 取某个 skill 的正文（带缓存）
  async body(id) {
    if (this._bodies[id] != null) return this._bodies[id];
    try {
      const r = await fetch(this.url + "/api/skills/" + encodeURIComponent(id), { signal: AbortSignal.timeout(3000) });
      if (!r.ok) return "";
      const j = await r.json();
      this._bodies[id] = j.body || "";
      return this._bodies[id];
    } catch (_) {
      return "";
    }
  },

  /**
   * 关键词打分，本地匹配（不依赖后端，断网也能用）。
   * 分数 = id 精确命中(100) + 词命中 + description 英文词命中
   */
  match(query, limit = 2) {
    const q = String(query || "").toLowerCase();
    if (!q || !this.list.length) return [];
    const terms = q.split(/[\s,，。、；;!！?？]+/).filter((t) => t.length >= 2);
    const scored = [];
    for (const s of this.list) {
      if (!this.isEnabled(s.id)) continue;   // 被禁用的不参与匹配
      const hay = (s.id + " " + (s.description || "")).toLowerCase();
      let score = 0;
      if (q.includes(s.id.toLowerCase())) score += 100;
      for (const t of terms) {
        if (hay.includes(t)) score += t.length >= 4 ? 6 : 3;
      }
      for (const w of (s.description || "").toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/)) {
        if (w.length >= 4 && q.includes(w)) score += 4;
      }
      if (score > 0) scored.push({ skill: s, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((x) => x.skill);
  },

  // 把命中 skill 的正文拼成一段可注入 system prompt 的文本
  async inject(query, maxSkills = 2, maxChars = 9000) {
    const hits = this.match(query, maxSkills);
    if (!hits.length) return { text: "", used: [] };
    const parts = [];
    const used = [];
    let budget = maxChars;
    for (const h of hits) {
      const b = await this.body(h.id);
      if (!b) continue;
      const chunk = b.length > budget ? b.slice(0, budget) + "\n…（已截断）" : b;
      parts.push(`### 技能：${h.id}\n${chunk}`);
      used.push(h.id);
      budget -= chunk.length;
      if (budget <= 0) break;
    }
    if (!parts.length) return { text: "", used: [] };
    return {
      text:
        "以下是根据用户这句话自动匹配到的技能指令。**按它执行**，但不要向用户复述这段技能说明本身。\n\n" +
        parts.join("\n\n---\n\n"),
      used,
    };
  },
};

/* =====================================================================
 * UIAction —— 让桌宠「动手」操作页面
 * ---------------------------------------------------------------------
 * 桌宠以前只会「说」（LLM 文本），不会「做」。这个模块让它能真的操作 UI。
 *
 * 原理（复用派发任务那套标记机制）：
 *   模型在回复最后单独一行输出  [[UI]]{"action":"sidebar","open":true}[[/UI]]
 *   前端把它从气泡里剥掉，交给 UIAction.run() 真的执行。
 *
 * 安全设计：
 *   · 白名单：只有 ACTIONS 里登记的动作能执行，模型说别的直接忽略。
 *   · 无副作用：所有动作都是「看/切/滚/开」级别，不改数据、不删东西。
 *   · 需要确认的（如派发任务）走 [[DISPATCH]]，不在这里。
 *
 * 加新动作：在 ACTIONS 里加一条 { 说明, run, aliases } 即可。
 * ===================================================================== */
const UIAction = {
  // 执行日志（最近 20 条，调试用）
  log: [],

  /* ---------- 动作白名单 ----------
   * 每条：{ desc, aliases, params, run(args) → {ok, note} } */
  ACTIONS: {
    // 侧边栏：开 / 关 / 切
    sidebar: {
      desc: "展开或收起左侧导航栏",
      params: { open: "布尔值；true=展开，false=收起；省略则切换" },
      aliases: ["打开侧边栏", "展开侧边栏", "收起侧边栏", "关掉侧边栏", "侧边栏"],
      run(args) {
        const open = typeof args.open === "boolean" ? args.open : !document.querySelector(".layout").classList.contains("collapsed");
        UI.setSidebar(open);
        return { ok: true, note: open ? "已展开侧边栏" : "已收起侧边栏", open };
      },
    },

    // 滚动到某个区块
    scrollTo: {
      desc: "把页面滚动到指定区块",
      params: { target: "区块名：dashboard(仪表盘) / agents(task 卡片) / quota(模型额度) / traces(明细) / console(控制台) / skills(技能库)" },
      aliases: ["滚到", "跳到", "去", "滚动到", "定位到"],
      run(args) {
        // 关键片段 → 区块。用「包含」匹配，模型说「模型额度那一块」也能命中。
        const map = [
          ["#dashboard", ["dashboard", "仪表盘", "总览", "概览", "首页", "指标", "kpi", "token 总量"]],
          ["#agents", ["agents", "agent", "任务卡", "卡片", "智能体", "运行中", "在跑"]],
          ["#quota", ["quota", "额度", "模型", "余额", "余额格", "账户"]],
          ["#traces", ["traces", "trace", "明细", "日志", "记录", "轨迹"]],
          ["#console", ["console", "控制台", "指挥台", "实时指挥"]],
          ["#skills", ["skills", "skill", "技能", "技能库"]],
        ];
        const raw = String(args.target || "").trim();
        const key = raw.toLowerCase();
        if (!key) return { ok: false, note: "没说要滚到哪" };
        // 先精确，再包含匹配
        let sel = null;
        for (const [s, keys] of map) if (keys.includes(key)) { sel = s; break; }
        if (!sel) for (const [s, keys] of map) if (keys.some((k) => key.includes(k))) { sel = s; break; }
        if (!sel) return { ok: false, note: `不知道「${raw}」在哪` };
        UI.scrollToSection(sel);
        return { ok: true, note: `已滚动到 ${sel.replace("#", "")}` };
      },
    },

    // 桌宠 显 / 隐
    pet: {
      desc: "显示或隐藏桌面机器人",
      params: { show: "布尔值；true=显示，false=隐藏；省略则切换" },
      aliases: ["隐藏桌宠", "关掉桌宠", "隐藏机器人", "显示桌宠", "召唤桌宠"],
      run(args) {
        const btn = UI.el.btnPet;
        if (!btn) return { ok: false, note: "找不到桌宠开关" };
        const isOn = btn.getAttribute("aria-pressed") === "true";
        const want = typeof args.show === "boolean" ? args.show : !isOn;
        if (want !== isOn) btn.click();
        return { ok: true, note: want ? "桌宠已显示" : "桌宠已隐藏", show: want };
      },
    },

    // 打开某个面板
    panel: {
      desc: "打开界面上的某个抽屉面板",
      params: { name: "skills(技能库) | notifs(通知中心) | dispatch(派发任务)" },
      aliases: ["打开技能库", "打开通知", "打开通知中心", "打开派发"],
      run(args) {
        const n = String(args.name || "");
        if (n === "skills") { UI.openSkills(); return { ok: true, note: "已打开技能库" }; }
        if (n === "notifs") { UI.openNotifs(); return { ok: true, note: "已打开通知中心" }; }
        if (n === "dispatch") { UI.openModal(); return { ok: true, note: "已打开派发任务" }; }
        return { ok: false, note: `没有「${n}」这个面板` };
      },
    },

    // 刷新余额
    refreshBalance: {
      desc: "重新查询账户真实余额",
      params: {},
      aliases: ["刷新余额", "查余额", "更新余额"],
      run() {
        UI.el.ccBalanceRefresh?.click();
        return { ok: true, note: "正在重新查询余额…" };
      },
    },

    // 暂停 / 恢复运行
    pause: {
      desc: "暂停或恢复任务运行",
      params: { on: "布尔值；true=暂停，false=恢复；省略则切换" },
      aliases: ["暂停", "恢复", "继续"],
      run(args) {
        const btn = UI.el.btnPause;
        if (!btn) return { ok: false, note: "找不到暂停按钮" };
        const wantPause = typeof args.on === "boolean" ? args.on : !btn.classList.contains("paused");
        const isPaused = btn.classList.contains("paused");
        if (wantPause !== isPaused) btn.click();
        return { ok: true, note: wantPause ? "已暂停" : "已恢复运行" };
      },
    },
  },

  // 给模型看的动作清单（拼进 system prompt）
  manifest() {
    return Object.entries(this.ACTIONS)
      .map(([k, a]) => {
        const ps = Object.entries(a.params || {}).map(([p, d]) => `${p}: ${d}`).join("；");
        return `· ${k} — ${a.desc}${ps ? "（" + ps + "）" : ""}`;
      })
      .join("\n");
  },

  /* ---------- 离线关键词兜底 ----------
   * 没配模型时，也能听懂几句常用指令。 */
  matchLocal(text) {
    const t = String(text || "");
    const hit = (words) => words.some((w) => t.includes(w));

    // ── 1) 「滚动/跳到」优先 ──
    // 用户说「滚动到技能库」时应该滚动，而不是打开抽屉。
    // 所以带滚动动词的句子先按 scrollTo 处理。
    const SCROLL_VERBS = ["滚动到", "滚到", "跳到", "定位到", "翻到", "去看看"];
    if (hit(SCROLL_VERBS)) {
      const target = t.replace(/^.*?(滚动到|滚到|跳到|定位到|翻到|去看看)/, "").trim();
      if (target) return { action: "scrollTo", target };
    }

    // ── 2) 明确的开关动作 ──
    if (hit(["打开侧边栏", "展开侧边栏", "显示侧边栏"])) return { action: "sidebar", open: true };
    if (hit(["收起侧边栏", "关闭侧边栏", "隐藏侧边栏", "关掉侧边栏"])) return { action: "sidebar", open: false };
    if (hit(["侧边栏"]) && hit(["打开", "展开", "显示"])) return { action: "sidebar", open: true };

    if (hit(["隐藏桌宠", "关掉桌宠", "隐藏机器人"])) return { action: "pet", show: false };
    if (hit(["显示桌宠", "召唤桌宠", "叫出桌宠"])) return { action: "pet", show: true };

    if (hit(["打开技能库", "技能库"])) return { action: "panel", name: "skills" };
    if (hit(["通知中心", "打开通知"])) return { action: "panel", name: "notifs" };

    if (hit(["刷新余额", "查余额", "看看余额", "余额还剩"])) return { action: "refreshBalance" };

    // ── 3) 其余动作按别名兜底 ──
    for (const [k, a] of Object.entries(this.ACTIONS)) {
      if (hit(a.aliases)) return { action: k };
    }
    return null;
  },

  // 执行一个动作
  run(req) {
    if (!req || !req.action) return { ok: false, note: "没有动作" };
    const a = this.ACTIONS[req.action];
    if (!a) {
      const note = `我不认识「${req.action}」这个操作`;
      this.log.push({ at: Date.now(), req, ok: false, note });
      return { ok: false, note };
    }
    let out;
    try {
      out = a.run(req) || { ok: true };
    } catch (e) {
      out = { ok: false, note: "执行失败：" + e.message };
    }
    this.log.push({ at: Date.now(), req, ok: out.ok, note: out.note });
    if (this.log.length > 20) this.log.shift();
    return out;
  },

  // 从一段文本里抠出所有 [[UI]]{...}[[/UI]] 标记
  extract(text) {
    const out = [];
    const re = /\[\[UI\]\]([\s\S]*?)\[\[\/UI\]\]/g;
    let m;
    while ((m = re.exec(text))) {
      try { const j = JSON.parse(m[1].trim()); if (j && j.action) out.push(j); } catch (_) {}
    }
    return out;
  },

  /* 判断模型的回复是不是「在说我要去做某个界面动作」。
   * 用在兜底路径：模型嘴上答应、却没吐标记时，我们也照样执行。
   * 只在回复明显是「执行承诺」时才返回 true，避免误触发。 */
  looksLikeIntent(reply) {
    const t = String(reply || "");
    // 否定 / 做不到 → 不执行
    if (/(控制不了|做不到|没法|无法|不能操作|你自己点|需要你手动|没有权限)/.test(t)) return false;
    // 承诺语气 → 认为它想执行
    return /(好的|好嘞|收到|已|帮你|这就|马上|正在|搞定了|安排)/.test(t);
  },
};

/* =====================================================================
 * Vision —— 识图（图片理解）客户端
 * ---------------------------------------------------------------------
 * 目标：把图送进模型 + 把流程跑通。模型以后随便换。
 *
 * 三道工序：
 *   1. 读文件 → 压缩到长边 MAX_EDGE、转 JPEG（省 token、加快上传）
 *   2. 转成 OpenAI 多模态消息格式（image_url + base64 data URI）
 *   3. 交给 LiveDataSource 发出去（走同一个 /api/chat 代理，不用改后端）
 *
 * 模型选择（visionModel）：
 *   - 配置了 config.json 的 visionModel 就用它
 *   - 否则自动挑一个"看起来支持视觉"的已注册模型
 *   - 都没有 → 返回 null，前端走「演示识图」，用假描述把流程走完
 *
 * 支持的模型名（自动识别，可自行扩展）：
 *   gpt-4o / gpt-4o-mini / gpt-4-turbo / gpt-4-vision
 *   glm-4v / glm-4v-plus / glm-4v-flash
 *   qwen-vl / qwen-vl-max / qwen-vl-plus
 *   claude-3 / claude-sonnet / claude-opus / claude-haiku
 *   llava / bakllava / moondream / minicpm-v   （本地 Ollama）
 * ===================================================================== */
const Vision = {
  MAX_EDGE: 1024,        // 长边上限（像素）
  QUALITY: 0.85,         // JPEG 质量
  MAX_IMAGES: 4,         // 单条消息最多几张
  MAX_BYTES: 8 * 1024 * 1024,  // 单张原图上限 8MB（压缩前）

  // 哪些模型名算「多模态」
  _VISION_HINTS: [
    "gpt-4o", "gpt-4-turbo", "gpt-4-vision", "gpt-4.1",
    "glm-4v", "qwen-vl", "qwen2-vl", "qwen2.5-vl",
    "claude-3", "claude-sonnet", "claude-opus", "claude-haiku",
    "llava", "bakllava", "moondream", "minicpm-v", "gemini",
  ],

  looksMultimodal(model) {
    if (!model) return false;
    const s = ((model.apiModel || "") + " " + model.id + " " + model.name).toLowerCase();
    return this._VISION_HINTS.some((h) => s.includes(h));
  },

  /**
   * 挑一个用来识图的模型。
   * 优先级：config.visionModel（MODELS 里匹配）> 第一个能跑且像多模态的 > null
   */
  visionModel() {
    // 1) 显式配置
    if (typeof VISION_MODEL_ID === "string" && VISION_MODEL_ID) {
      const m = MODELS.find((x) => x.id === VISION_MODEL_ID || x.apiModel === VISION_MODEL_ID);
      if (m) return m;
    }
    // 2) 已注册 + 能跑 + 像多模态
    return MODELS.find((m) => this.looksMultimodal(m) && LiveDataSource.canRun(m)) || null;
  },

  /* ---------- 压缩：读文件 → canvas 缩放 → JPEG dataURI ---------- */
  compress(file) {
    return new Promise((resolve, reject) => {
      if (!file || !/^image\//.test(file.type)) return reject(new Error("不是图片文件"));
      if (file.size > this.MAX_BYTES) return reject(new Error(`图片太大（${(file.size / 1048576).toFixed(1)}MB > 8MB）`));

      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        try {
          let { width: w, height: h } = img;
          const long = Math.max(w, h);
          if (long > this.MAX_EDGE) {
            const k = this.MAX_EDGE / long;
            w = Math.round(w * k);
            h = Math.round(h * k);
          }
          const cv = document.createElement("canvas");
          cv.width = w;
          cv.height = h;
          const ctx = cv.getContext("2d");
          // JPEG 无透明通道，先铺白底，避免 PNG 透明区变黑
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          const dataUrl = cv.toDataURL("image/jpeg", this.QUALITY);
          resolve({
            dataUrl,
            width: w,
            height: h,
            bytes: Math.round((dataUrl.length - "data:image/jpeg;base64,".length) * 0.75),
            name: file.name || "image.jpg",
          });
        } catch (e) {
          reject(new Error("压缩失败：" + e.message));
        }
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("图片解码失败（文件可能损坏）")); };
      img.src = url;
    });
  },

  // 组装成 OpenAI 多模态 content 数组
  toOpenAIContent(text, images) {
    const arr = [];
    if (text) arr.push({ type: "text", text });
    for (const im of images || []) {
      arr.push({ type: "image_url", image_url: { url: im.dataUrl } });
    }
    return arr;   // 只有图没文字也合法
  },

  /* ---------- 演示识图：没配多模态模型时的兜底 ---------- */
  async demoDescribe(images, prompt) {
    // 模拟"看一眼"的耗时
    await new Promise((r) => setTimeout(r, 900 + Math.random() * 700));
    const n = images.length;
    const p = (prompt || "").trim();
    const lines = [
      `（**演示识图** —— 还没有配可用的多模态模型）`,
      "",
      `我收到了 **${n}** 张图：`,
      ...images.map((im, i) => `　${i + 1}. ${im.name} · ${im.width}×${im.height} · ${(im.bytes / 1024).toFixed(0)} KB`),
      "",
      p ? `你问的是：「${p}」` : "",
      "",
      "要让我**真的看图**，配一个多模态模型就行（任选其一）：",
      "```",
      "# 方式一：智谱 GLM-4V（国内直连，便宜）",
      "node setkey.js glm",
      "",
      "# 方式二：阿里通义千问 VL",
      "node setkey.js qwen",
      "```",
      "配好后回到这里，同样的按钮就能真识别了 —— **界面和流程都不用改**。",
    ];
    return lines.filter(Boolean).join("\n");
  },
};

/* =====================================================================
 * Hook 总线客户端（借鉴 Clawd on Desk）
 * ---------------------------------------------------------------------
 * 桌宠不只「主动调用」，也能「被接入」：
 * 任何外部 agent（Claude Code / opencode / 自己的脚本）POST 状态到
 * http://127.0.0.1:8900/api/hook，前端通过 SSE 实时收到并切表情。
 *
 * 12 种外部状态 → 6 种情绪 mood（色 + 形 双编码）
 * ===================================================================== */
const Hook = {
  url: "http://127.0.0.1:8900",
  es: null,
  connected: false,
  last: null,
  retryMs: 3000,

  // 外部状态 → 内部 mood
  STATE_MAP: {
    idle:      { mood: "idle",   label: "待命" },
    thinking:  { mood: "active", label: "思考中" },
    typing:    { mood: "active", label: "输出中" },
    reading:   { mood: "active", label: "读取中" },
    writing:   { mood: "active", label: "写入中" },
    running:   { mood: "active", label: "执行中" },
    building:  { mood: "active", label: "构建中" },
    testing:   { mood: "active", label: "测试中" },
    searching: { mood: "active", label: "搜索中" },
    waiting:   { mood: "warn",   label: "等待审批" },
    done:      { mood: "happy",  label: "已完成" },
    error:     { mood: "error",  label: "出错" },
  },

  init() {
    this.connect();
  },

  connect() {
    if (this.es) { try { this.es.close(); } catch (_) {} }
    try {
      this.es = new EventSource(this.url + "/api/hook/stream");
    } catch (_) {
      this.scheduleRetry();
      return;
    }
    this.es.onopen = () => { this.connected = true; this.applyConnection(true); };
    this.es.onmessage = (e) => {
      let evt;
      try { evt = JSON.parse(e.data); } catch { return; }
      if (evt.type === "state") this.onState(evt);
    };
    this.es.onerror = () => {
      this.connected = false;
      this.applyConnection(false);
      // EventSource 自带重连，这里只更新 UI，避免重复建连
    };
  },

  scheduleRetry() {
    clearTimeout(this._retry);
    this._retry = setTimeout(() => this.connect(), this.retryMs);
  },

  // 连接状态展示（侧栏助手卡上显示「已接入 N 个外部 agent」）
  applyConnection(on) {
    const el = document.getElementById("sideBotSource");
    if (el) el.textContent = on ? "已接入外部 Agent" : "本地模式";
    document.body.classList.toggle("hook-connected", on);
  },

  onState(evt) {
    this.last = evt;
    const conf = this.STATE_MAP[evt.state] || this.STATE_MAP.idle;
    UI.setBotMoodFromHook(evt.state, conf.mood, conf.label, evt);
    // 只在有意义的节点冒气泡，别每个 delta 都弹
    if (["done", "error", "waiting"].includes(evt.state)) {
      const tone = evt.state === "error" ? "danger" : evt.state === "waiting" ? "warn" : "success";
      const title = `${evt.source || "外部 Agent"} · ${conf.label}`;
      Notifier.add({
        level: tone,
        title,
        body: evt.label || evt.detail || "",
        dedupeKey: `hook:${evt.state}:${evt.label}`,
        cooldownMs: 8000,
      });
    }
  },
};

/* =====================================================================
 * Lingo 桌宠（自由走动 · 电子宠物）
 * ---------------------------------------------------------------------
 * 行为规则（对应用户需求）：
 *  1. 鼠标移动     → 在当前位置附近小幅活动（不追鼠标、不干扰操作）
 *  2. 系统空闲 N 秒 → 自由漫游：随机选目标点，走过去，停下观察数据
 *  3. 有任务       → 冒气泡提示，机器人走到相关数据模块旁
 *  4. 点击本体     → 派发任务；点击气泡「派发」同上
 *  5. 全程鼠标穿透：只有机器人本体与气泡可点
 * ===================================================================== */
const Pet = {
  // ---- 可调参数 ----
  IDLE_AFTER_MS: 12000,     // 无任何操作多久后才开始自由漫游
  SPEED: 62,                // 像素/秒
  OBSERVE_MS: 2600,         // 停下「观察」时长
  BUBBLE_MS: 6200,          // 气泡自动消失时间

  el: {},
  x: 0, y: 0,               // 当前视口坐标（左上角）
  tx: 0, ty: 0,             // 目标坐标
  walking: false,
  speed: 0,                 // 当前速度（用于起步加速/到站减速的重量感）
  traveled: 0,              // 本次行走已行进距离
  facing: "right",
  lastMouse: 0,             // 最后一次用户操作时间
  mode: "idle",             // idle | wander | observe
  observeUntil: 0,
  raf: 0,
  lastT: 0,
  parked: false,
  bubbleTimer: 0,
  destroyed: false,

  init() {
    this.el.root = document.getElementById("pet");
    if (!this.el.root) return;
    this.el.body = document.getElementById("petBody");
    this.el.img = document.getElementById("petImg");
    this.el.sway = document.getElementById("petSway");
    this.el.dialog = document.getElementById("petDialog");
    this.el.dialogBody = document.getElementById("petDialogBody");
    this.el.dialogStatus = document.getElementById("petDialogStatus");
    this.el.dialogMin = document.getElementById("petDialogMin");
    this.el.dialogClear = document.getElementById("petDialogClear");
    this.el.dialogDispatch = document.getElementById("petDialogDispatch");
    this.el.dialogNotif = document.getElementById("petDialogNotif");
    this.el.dialogForm = document.getElementById("petDialogForm");
    this.el.input = document.getElementById("petInput");
    this.el.imgBtn = document.getElementById("petImgBtn");
    this.el.imgFile = document.getElementById("petImgFile");
    this.el.attachBar = document.getElementById("petAttachBar");
    this.el.attachList = document.getElementById("petAttachList");
    this.el.lightbox = document.getElementById("petLightbox");
    this.el.lightboxImg = document.getElementById("petLightboxImg");
    this.el.lightboxClose = document.getElementById("petLightboxClose");
    this.el.lightboxDl = document.getElementById("petLightboxDl");
    this.el.quick = document.getElementById("petDialogQuick");
    this.el.badge = document.getElementById("petBadge");
    this.el.toastStack = document.getElementById("petToastStack");
    this.el.live = document.getElementById("petLive");

    // 初始位置：优先恢复上次拖拽落点，否则左下角（贴近侧边栏的助手卡）
    let restored = null;
    try { restored = JSON.parse(localStorage.getItem("lingo.pet.pos") || "null"); } catch (_) {}
    this.x = restored && isFinite(restored.x) ? restored.x : 24;
    this.y = restored && isFinite(restored.y) ? restored.y : window.innerHeight - 140;
    this.tx = this.x; this.ty = this.y;

    this.el.root.hidden = false;
    this.applyTransform();
    this.clampToViewport();

    // 点击本体 → 打开对话框（若刚拖动过则不触发点击）
    this.el.body.addEventListener("click", () => {
      if (this._dragged) { this._dragged = false; return; }
      this.toggleDialog();
    });
    // 长按拖动：指针按下即可拖，移动超过阈值才算「拖动」
    this.el.body.addEventListener("pointerdown", (e) => this.onDragStart(e));
    // 对话框操作
    this.el.dialogMin.addEventListener("click", () => this.hideDialog());
    this.el.dialogClear.addEventListener("click", () => {
      this.messages = [];
      this.renderMessages();
      this.seedWelcome();
      this.el.input?.focus();
    });
    this.el.dialogDispatch.addEventListener("click", () => { this.hideDialog(); UI.openModal(); });
    this.el.dialogNotif.addEventListener("click", () => { this.hideDialog(); UI.openNotifs(); });

    // 聊天输入：回车发送，Shift+Enter 换行；自动增高
    this.el.dialogForm.addEventListener("submit", (e) => {
      e.preventDefault();
      this.submitInput();
    });
    this.el.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.el.dialogForm.requestSubmit();
      }
    });
    this.el.input.addEventListener("input", () => {
      this.el.input.style.height = "auto";
      this.el.input.style.height = Math.min(76, this.el.input.scrollHeight) + "px";
    });

    /* ---------- 识图：选图 / 预览 / 移除 / 发送 ---------- */
    this.el.imgBtn.addEventListener("click", () => this.el.imgFile.click());
    this.el.imgFile.addEventListener("change", async () => {
      const files = [...(this.el.imgFile.files || [])];
      this.el.imgFile.value = "";   // 允许重复选同一张
      await this.addImages(files);
    });
    // 粘贴截图 / 拖放图片进对话框
    this.el.input.addEventListener("paste", (e) => {
      const items = [...((e.clipboardData && e.clipboardData.items) || [])];
      const files = items.filter((it) => it.type.startsWith("image/")).map((it) => it.getAsFile()).filter(Boolean);
      if (files.length) { e.preventDefault(); this.addImages(files); }
    });
    const dlg = document.getElementById("petDialog");
    if (dlg) {
      dlg.addEventListener("dragover", (e) => {
        if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) {
          e.preventDefault(); dlg.classList.add("drop-active");
        }
      });
      dlg.addEventListener("dragleave", () => dlg.classList.remove("drop-active"));
      dlg.addEventListener("drop", (e) => {
        dlg.classList.remove("drop-active");
        const files = [...((e.dataTransfer && e.dataTransfer.files) || [])].filter((f) => /^image\//.test(f.type));
        if (files.length) { e.preventDefault(); this.addImages(files); }
      });
    }
    // 预览条：点缩略图放大 / 点 × 移除
    this.el.attachList.addEventListener("click", (e) => {
      const rm = e.target.closest("[data-rm]");
      if (rm) { this.removeImage(Number(rm.dataset.rm)); return; }
      const thumb = e.target.closest("[data-view]");
      if (thumb) this.openLightbox(this.pending[Number(thumb.dataset.view)]);
    });
    // lightbox 关闭
    this.el.lightboxClose.addEventListener("click", () => this.closeLightbox());
    this.el.lightbox.addEventListener("click", (e) => { if (e.target === this.el.lightbox) this.closeLightbox(); });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.el.lightbox.hidden) this.closeLightbox();
    });
    this.el.lightboxDl.addEventListener("click", () => {
      const im = this._lbImage;
      if (!im) return;
      const a = document.createElement("a");
      a.href = im.dataUrl;
      a.download = im.name || "image.jpg";
      a.click();
    });
    // 快捷提问 chips
    this.el.quick.addEventListener("click", (e) => {
      const chip = e.target.closest(".pet-chip");
      if (chip) this.send(chip.dataset.ask);
    });
    // 防止在输入框里打字触发桌宠的全局空闲逻辑
    this.el.dialog.addEventListener("keydown", (e) => e.stopPropagation());

    this.seedWelcome();

    // 用户有任何操作 → 立刻静止，并重置空闲计时（鼠标移动还会让它「看向」光标）
    const activity = (e) => this.onUserActivity(e);
    window.addEventListener("mousemove", activity, { passive: true });
    window.addEventListener("mousedown", activity, { passive: true });
    window.addEventListener("wheel", activity, { passive: true });
    window.addEventListener("keydown", activity, { passive: true });
    window.addEventListener("touchstart", activity, { passive: true });
    window.addEventListener("touchmove", activity, { passive: true });
    window.addEventListener("resize", () => this.clampToViewport());
    // 页面不可见时也当作「无操作暂停」（切到别的标签页不乱跑）
    document.addEventListener("visibilitychange", () => {
      this.lastMouse = performance.now();
      if (document.hidden) { this.tx = this.x; this.ty = this.y; this.mode = "idle"; }
    });

    // 生命感：眨眼 + 待机小动作
    this.scheduleBlink();
    this.scheduleMicro();

    this.lastT = performance.now();
    this.lastMouse = performance.now();
    this.loop();
  },

  /* ---------- 长按拖动 ---------- */
  DRAG_THRESHOLD: 4,     // 超过几像素才算拖动（区分点击）
  dragging: false,
  _dragged: false,
  _dragStart: null,

  onDragStart(e) {
    // 仅左键 / 触摸 / 触控笔
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    this._dragStart = {
      px: e.clientX, py: e.clientY,
      ox: this.x, oy: this.y,
      moved: false,
    };
    this.dragging = true;
    this.el.root.classList.add("dragging");
    // 拖动时停止漫游动画
    this.walking = false;
    this.el.root.classList.remove("walking");
    // 指针捕获：拖到窗口外也能继续
    try { this.el.body.setPointerCapture(e.pointerId); } catch (_) {}
    this._pointerId = e.pointerId;
    // 绑定 this（方法引用会丢失上下文）
    this._moveHandler = (ev) => this._onDragMove(ev);
    this._endHandler = (ev) => this._onDragEnd(ev);
    window.addEventListener("pointermove", this._moveHandler);
    window.addEventListener("pointerup", this._endHandler);
    window.addEventListener("pointercancel", this._endHandler);
  },

  _onDragMove(e) {
    if (!this.dragging || !this._dragStart) return;
    const dx = e.clientX - this._dragStart.px;
    const dy = e.clientY - this._dragStart.py;
    if (!this._dragStart.moved && Math.hypot(dx, dy) < this.DRAG_THRESHOLD) return;
    this._dragStart.moved = true;
    this._dragged = true;
    const w = this.el.root.offsetWidth || 72;
    const h = this.el.root.offsetHeight || 90;
    this.x = clamp(this._dragStart.ox + dx, 4, window.innerWidth - w - 4);
    this.y = clamp(this._dragStart.oy + dy, 4, window.innerHeight - h - 4);
    this.applyTransform();
    // 朝向跟随拖动方向
    if (Math.abs(dx) > 6) {
      const f = dx < 0 ? "left" : "right";
      if (f !== this.facing) {
        this.facing = f;
        this.el.root.classList.toggle("facing-left", f === "left");
      }
    }
  },

  _onDragEnd() {
    if (!this.dragging) return;
    this.dragging = false;
    this.el.root.classList.remove("dragging");
    // 落点即新家：松开后目标点设为当前位置
    this.tx = this.x; this.ty = this.y;
    this.mode = "idle";
    this.lastMouse = performance.now();   // 重置空闲计时，别立刻又跑走
    // 记住位置（本地）
    try {
      localStorage.setItem("lingo.pet.pos", JSON.stringify({ x: Math.round(this.x), y: Math.round(this.y) }));
    } catch (_) {}
    try { this.el.body.releasePointerCapture(this._pointerId); } catch (_) {}
    window.removeEventListener("pointermove", this._moveHandler);
    window.removeEventListener("pointerup", this._endHandler);
    window.removeEventListener("pointercancel", this._endHandler);
  },

  // ---- 鼠标移动 → 立刻静止（不追鼠标、不随意走动）----
  // 但会「看向」鼠标：只转眼球/微微侧身，绝不移动位置
  onUserActivity(e) {
    this.lastMouse = performance.now();
    if (e && typeof e.clientX === "number") this.lookAt(e.clientX, e.clientY);
    if (this.parked || this.dragging) return;
    // 用户一有操作，立即停下并放弃当前漫游目标
    if (this.mode === "wander" || this.mode === "near" || this.mode === "observe") {
      this.tx = this.x;
      this.ty = this.y;
    }
    this.mode = "idle";
    if (this.walking) {
      this.walking = false;
      this.el.root.classList.remove("walking");
      this.el.root.style.setProperty("--gaze-tilt", "0deg");
    }
  },

  // 眼神/朝向：机器人不做瞳孔游移（不叠加任何眼睛图层），
  // 只做「轻微侧身」表达朝向 —— 用 CSS 变量驱动，避免覆盖呼吸动画。
  // 注意：不能每次 mousemove 都 getBoundingClientRect（会强制同步重排，拖慢整页）
  lookAt(mx, my) {
    if (!this.el.body) return;
    // 本体位置每帧都在变，这里用缓存 + 低频刷新，避免每次鼠标移动都触发布局计算
    const now = performance.now();
    if (!this._gazeRect || now - this._gazeRectAt > 250) {
      this._gazeRect = this.el.body.getBoundingClientRect();
      this._gazeRectAt = now;
    }
    const r = this._gazeRect;
    if (!r || !r.width) return;
    const cx = r.left + r.width / 2, cy = r.top + r.height * 0.42;
    const dx = mx - cx, dy = my - cy;
    // 轻微侧身：朝鼠标方向倾一点点（最多 3deg）
    if (this.el.sway && !this.walking && !this.dragging) {
      const tilt = (dx / Math.max(1, Math.abs(dx) + 200)) * 3;
      this.el.root.style.setProperty("--gaze-tilt", tilt.toFixed(2) + "deg");
    }
  },

  // 眨眼：加一次性 class
  blink() {
    if (!this.el.sway) return;
    this.el.sway.classList.add("blink");
    setTimeout(() => this.el.sway.classList.remove("blink"), 170);
  },
  scheduleBlink() {
    clearTimeout(this._blinkTimer);
    const wait = 2200 + Math.random() * 4200;
    this._blinkTimer = setTimeout(() => {
      if (!this.destroyed) { this.blink(); this.scheduleBlink(); }
    }, wait);
  },

  // 待机小动作：偶尔歪头/张望/伸个懒腰（纯 CSS transform，不移动位置）
  microIdle() {
    if (this.dragging || this.walking || this.parked) return;
    if (!this.el.body) return;
    const moves = ["tilt", "stretch", "look"];
    const m = moves[Math.floor(Math.random() * moves.length)];
    this.el.body.dataset.micro = m;
    clearTimeout(this._microTimer);
    this._microTimer = setTimeout(() => {
      if (this.el.body) delete this.el.body.dataset.micro;
    }, 700 + Math.random() * 500);
  },
  scheduleMicro() {
    clearTimeout(this._microIdleTimer);
    const wait = 5000 + Math.random() * 7000;
    this._microIdleTimer = setTimeout(() => {
      if (!this.destroyed) { this.microIdle(); this.scheduleMicro(); }
    }, wait);
  },

  // ---- 系统空闲 → 自由漫游 ----
  pickWanderTarget() {
    const w = this.el.root.offsetWidth || 72;
    const h = this.el.root.offsetHeight || 90;
    // 优先走向「数据模块」：控制台 / 额度 / Trace 表
    const anchors = ["#dashboard", "#quota", "#traces", "#agents"]
      .map((s) => document.querySelector(s))
      .filter((n) => n && n.getBoundingClientRect().height > 0);
    if (anchors.length && Math.random() < 0.72) {
      const a = anchors[Math.floor(Math.random() * anchors.length)];
      const r = a.getBoundingClientRect();
      this.tx = clamp(r.left + 24 + Math.random() * Math.max(1, r.width - w - 48), 8, window.innerWidth - w - 8);
      this.ty = clamp(r.top + 40 + Math.random() * Math.max(1, Math.min(r.height, 260) - 40), 70, window.innerHeight - h - 8);
      this.observeAfterArrive = true;
    } else {
      // 纯随机漫游
      this.tx = 40 + Math.random() * Math.max(1, window.innerWidth - w - 80);
      this.ty = 90 + Math.random() * Math.max(1, window.innerHeight - h - 160);
      this.observeAfterArrive = Math.random() < 0.5;
    }
    this.mode = "wander";
    this.traveled = 0;      // 重置起步加速
    this.speed = 0;
  },

  clampToViewport() {
    const w = this.el.root.offsetWidth || 72;
    const h = this.el.root.offsetHeight || 90;
    this.x = clamp(this.x, 4, window.innerWidth - w - 4);
    this.y = clamp(this.y, 4, window.innerHeight - h - 4);
    this.tx = clamp(this.tx, 4, window.innerWidth - w - 4);
    this.ty = clamp(this.ty, 4, window.innerHeight - h - 4);
    this.applyTransform();
  },

  applyTransform() {
    this.el.root.style.transform = `translate3d(${this.x.toFixed(1)}px, ${this.y.toFixed(1)}px, 0)`;
  },

  // ---- 主循环：简单物理 ----
  loop() {
    if (this.destroyed) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastT) / 1000);
    this.lastT = now;

    if (!this.parked && !this.dragging) {
      const idleMs = now - this.lastMouse;
      const userActive = idleMs < this.IDLE_AFTER_MS;

      if (userActive) {
        // 用户有操作：绝不走动，保持静止
        if (this.walking) {
          this.walking = false;
          this.el.root.classList.remove("walking");
        }
        this.mode = "idle";
      } else {
        // 完全空闲：允许自由漫游
        if (this.mode === "idle") {
          this.pickWanderTarget();
        }
        // 观察结束 → 换个目标继续
        if (this.mode === "observe" && now >= this.observeUntil) {
          this.pickWanderTarget();
        }
        if (this.mode === "wander") {
          const arrived = this.step(dt);
          if (arrived) {
            if (this.observeAfterArrive) {
              this.mode = "observe";
              this.observeUntil = now + this.OBSERVE_MS + Math.random() * 1600;
            } else {
              this.pickWanderTarget();
            }
          }
        }
      }
    }

    this.raf = requestAnimationFrame(() => this.loop());
  },

  // 返回是否到达目标（带起步加速 / 到站减速的重量感）
  step(dt) {
    const dx = this.tx - this.x;
    const dy = this.ty - this.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 2.5) {
      this.walking = false;
      this.speed = 0;
      this.el.root.classList.remove("walking");
      return true;
    }
    // 速度渐变：远离目标时加速到 SPEED，临近时减速停下（有重量）
    const easeIn = Math.min(1, (this.traveled || 0) / 34);       // 起步加速
    const easeOut = Math.min(1, dist / 46);                      // 到站减速
    const targetSpeed = this.SPEED * (0.35 + 0.65 * easeIn) * (0.28 + 0.72 * easeOut);
    this.speed += (targetSpeed - this.speed) * Math.min(1, dt * 6);
    const move = Math.max(6, this.speed) * dt;
    this.traveled = (this.traveled || 0) + move;
    const nx = this.x + (dx / dist) * Math.min(move, dist);
    const ny = this.y + (dy / dist) * Math.min(move, dist);
    // 朝向
    if (Math.abs(dx) > 0.8) {
      const f = dx < 0 ? "left" : "right";
      if (f !== this.facing) {
        this.facing = f;
        this.el.root.classList.toggle("facing-left", f === "left");
      }
    }
    this.x = nx; this.y = ny;
    this.applyTransform();
    if (!this.walking) {
      this.walking = true;
      this.el.root.classList.add("walking");
      // 走动时交给走路动画，清掉「看鼠标」的侧身
      this.el.root.style.setProperty("--gaze-tilt", "0deg");
      delete this.el.body.dataset.micro;
    }
    return false;
  },

  // ---- 情绪同步（由 UI.setBotMood 调用）----
  setMood(mood, label) {
    if (this.el.root) this.el.root.dataset.mood = mood;
    if (this.el.dialogStatus && label) this.el.dialogStatus.textContent = label;
  },

  /* ---------- 对话框（GPT 风格聊天）---------- */
  messages: [],          // { role:'bot'|'user', text, tone, ts }
  unread: 0,
  dialogOpen: false,
  busy: false,           // 助手正在思考/打字

  ICONS: { info: "◆", success: "✓", warn: "!", danger: "×" },

  // 追加一条消息；role 为 'bot' 时自动滚到底
  // images：可选，用户发的图 [{dataUrl,...}]，用于气泡里显示缩略图
  pushMsg(role, text, tone = "info", images = null) {
    this.messages.push({ role, text, tone, images: images && images.length ? images : null, ts: Date.now() });
    if (this.messages.length > 200) this.messages.shift();
  },

  // 有通知时：写入对话 + 弹一条微信式悬浮消息（不点开也自动出现，5~10s 自动隐藏）
  notify({ title, text, tone = "info" }) {
    if (!this.el.root || this.parked) return;
    this.pushMsg("bot", text ? `${title}\n${text}` : title, tone);
    this.renderMessages();
    this.el.live.textContent = `${title}。${text || ""}`;
    // 对话框开着就不打扰；否则弹悬浮通知
    if (this.dialogOpen) {
      this.scrollToBottom();
    } else {
      this.unread++;
      this.renderBadge();
      this.showToast({ title, text, tone });
    }
    this.el.root.classList.add("alerting");
    clearTimeout(this._alertTimer);
    this._alertTimer = setTimeout(() => this.el.root.classList.remove("alerting"), 1200);
  },

  /* ---------- 微信式悬浮通知 ---------- */
  TOAST_MIN_MS: 5000,
  TOAST_MAX_MS: 10000,
  TOAST_MAX: 3,

  showToast({ title, text, tone = "info" }) {
    const stack = this.el.toastStack;
    if (!stack) return;
    // 超出上限：先把最旧的「立刻」摘掉，保证循环一定会推进
    // （dismissToast 是异步移除的，不能用来收缩列表，否则这里会死循环）
    while (stack.children.length >= this.TOAST_MAX) {
      const oldest = stack.firstElementChild;
      if (!oldest) break;
      this._finalizeToast(oldest);
    }
    const el = document.createElement("div");
    el.className = `pet-toast ${tone}`;
    el.setAttribute("role", "button");
    el.setAttribute("tabindex", "0");
    el.innerHTML = `
      <img class="pet-toast-ava" src="./brand-assets/lingo-robot-head.png" alt="" aria-hidden="true" />
      <div class="pet-toast-body">
        <div class="pet-toast-title">${escapeHtml(title || "Lingo 助手")}</div>
        ${text ? `<div class="pet-toast-text">${escapeHtml(text)}</div>` : ""}
      </div>
      <span class="pet-toast-bar" aria-hidden="true" style="animation-duration:${this.TOAST_MAX_MS}ms"></span>`;
    stack.appendChild(el);
    // 点它 / 按回车 → 打开完整对话框
    const open = () => { this.dismissToast(el); this.openFromToast(); };
    el.addEventListener("click", open);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
    // 5~10 秒随机后自动隐藏
    const life = this.TOAST_MIN_MS + Math.random() * (this.TOAST_MAX_MS - this.TOAST_MIN_MS);
    el._timer = setTimeout(() => this.dismissToast(el), life);
  },

  dismissToast(el) {
    if (!el || el._gone) return;
    el._gone = true;
    clearTimeout(el._timer);
    el.classList.add("out");
    setTimeout(() => el.remove(), 280);
  },

  // 立即从 DOM 摘除（用于限制数量，必须同步生效，不能等动画）
  _finalizeToast(el) {
    if (!el) return;
    el._gone = true;
    clearTimeout(el._timer);
    el.remove();
  },

  clearToasts() {
    if (this.el.toastStack) this.el.toastStack.innerHTML = "";
  },

  openFromToast() {
    this.openDialog({ focusInput: false });
  },

  // 时间线分组标签
  _dayLabel(ts) {
    const d = new Date(ts), n = new Date();
    const sameDay = d.toDateString() === n.toDateString();
    if (sameDay) return "今天";
    const y = new Date(n.getTime() - 86400000);
    if (d.toDateString() === y.toDateString()) return "昨天";
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  },

  renderMessages() {
    if (!this.el.dialogBody) return;
    const body = this.el.dialogBody;
    const wasBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    let lastDay = "";
    let html = "";
    this.messages.forEach((m) => {
      const day = this._dayLabel(m.ts);
      if (day !== lastDay) {
        html += `<div class="pet-day">${day}</div>`;
        lastDay = day;
      }
      const isUser = m.role === "user";
      const time = new Date(m.ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
      const ava = isUser
        ? `<span class="pet-msg-ava" aria-hidden="true">我</span>`
        : `<span class="pet-msg-ava" aria-hidden="true"><img src="./brand-assets/lingo-robot-head.png" alt="" /></span>`;
      // 图片缩略图（用户发图时显示在文字上方）
      const imgs =
        m.images && m.images.length
          ? `<div class="pet-msg-imgs">${m.images
              .map(
                (im, i) =>
                  `<img src="${im.dataUrl}" alt="${escapeHtml(im.name || "图片")}" class="pet-msg-img" data-lb="${m.ts}:${i}" />`
              )
              .join("")}</div>`
          : "";
      html += `
        <div class="pet-msg ${isUser ? "user" : m.tone || "info"}">
          ${ava}
          <div class="pet-msg-body">
            ${imgs}
            ${m.text ? `<div class="pet-msg-text">${escapeHtml(m.text)}</div>` : `<div class="pet-msg-text"></div>`}
            <div class="pet-msg-time">${time}</div>
          </div>
        </div>`;
    });
    body.innerHTML = html;
    // 缩略图点击放大（事件委托，只绑一次）
    if (!this._imgDlgBound) {
      this._imgDlgBound = true;
      body.addEventListener("click", (e) => {
        const im = e.target.closest("[data-lb]");
        if (!im) return;
        const [ts, i] = im.dataset.lb.split(":");
        const msg = this.messages.find((m) => String(m.ts) === ts);
        if (msg && msg.images && msg.images[Number(i)]) this.openLightbox(msg.images[Number(i)]);
      });
    }
    if (wasBottom) body.scrollTop = body.scrollHeight;
  },

  scrollToBottom() {
    if (this.el.dialogBody) this.el.dialogBody.scrollTop = this.el.dialogBody.scrollHeight;
  },

  /* ---------- 打字机逐字输出 ---------- */
  typeOut(text, tone = "info", done) {
    if (!this.el.dialogBody) { this.pushMsg("bot", text, tone); return; }
    // 追加一条空消息，逐字填充
    this.pushMsg("bot", "", tone);
    const idx = this.messages.length - 1;
    this.renderMessages();
    const node = this.el.dialogBody.querySelectorAll(".pet-msg-text");
    const target = node[node.length - 1];
    if (!target) return;
    this.busy = true;
    let i = 0;
    // 每帧补 1~3 个字符，长文快一些
    const step = Math.max(1, Math.round(text.length / 90));
    const tick = () => {
      i = Math.min(text.length, i + step);
      this.messages[idx].text = text.slice(0, i);
      target.textContent = text.slice(0, i);
      // 打字光标
      if (i < text.length) {
        if (!target.querySelector(".pet-caret")) {
          const c = document.createElement("span");
          c.className = "pet-caret";
          target.appendChild(c);
        }
      }
      this.scrollToBottom();
      if (i < text.length) {
        setTimeout(tick, 26);
      } else {
        const c = target.querySelector(".pet-caret");
        if (c) c.remove();
        this.busy = false;
        this.el.live.textContent = text;
        if (done) done();
      }
    };
    tick();
  },

  // 显示「正在输入…」，返回移除函数
  showTyping() {
    if (!this.el.dialogBody) return () => {};
    const el = document.createElement("div");
    el.className = "pet-msg info";
    el.id = "petTyping";
    el.innerHTML = `
      <span class="pet-msg-ava" aria-hidden="true"><img src="./brand-assets/lingo-robot-head.png" alt="" /></span>
      <div class="pet-msg-body"><div class="pet-msg-text"><span class="pet-typing"><i></i><i></i><i></i></span></div></div>`;
    this.el.dialogBody.appendChild(el);
    this.scrollToBottom();
    return () => el.remove();
  },

  /* ---------- 聊天大脑 ----------
     真模式：调 proxy → 真 LLM（DeepSeek/OpenAI/Claude/本地 Ollama），流式吐字
     兜底：代理没起 / 没配密钥 → 退回内置规则引擎（answer）
     选中模型：优先用第一个可跑的模型；都能跑则用 DEFAULT_CHAT_MODEL_ID
     ------------------------------------------------------------------ */
  DEFAULT_CHAT_MODEL_ID: "deepseek-chat",
  _chatCtl: null,

  // 挑一个用于对话的模型
  chatModel() {
    const preferred = MODELS.find((m) => m.id === this.DEFAULT_CHAT_MODEL_ID && LiveDataSource.canRun(m));
    if (preferred) return preferred;
    return MODELS.find((m) => LiveDataSource.canRun(m)) || null;
  },

  // 把对话历史转成 LLM 消息数组（带调度台上下文 + 命中的 skill + 可选图片）
  async buildChatMessages(userText, opts = {}) {
    const images = opts.images || null;
    const s = {
      running: Engine.agents.filter((a) => a.status === "running").length,
      queued: Engine.agents.filter((a) => a.status === "queued").length,
      failed: Engine.agents.filter((a) => a.status === "failed").length,
      tokens: Engine.totalInput + Engine.totalOutput,
      cost: Engine.totalCost,
      done: Engine.totalTasks,
    };
    const live = LiveDataSource.isAvailable();
    // 哪个模型在跑话
    const cm = this.chatModel();
    // 余额最高的模型（演示数据里模型自带余额）
    const withBal = MODELS.filter((m) => m.quota > 0);
    const lowest = withBal.slice().sort((a, b) => a.quota - b.quota)[0];

    // 最近完成的任务（含产出摘要）—— 用户问「跑完了吗/结果呢」时能答上
    const recent = Engine.agents.slice(0, 4).map((a) => {
      const out = String(a.fullOutput || "").replace(/\s+/g, " ").trim();
      return (
        `· [${a.status}] ${a.name}（${a.model ? a.model.name : "?"}）` +
        `任务：${(a.task || "").slice(0, 60)}` +
        (out ? `　产出：${out.slice(0, 200)}${out.length > 200 ? "…" : ""}` : "　（无产出）")
      );
    });

    // skill 清单（只给 id + 描述，正文按需注入）
    const manifest = Skill.list.length
      ? "你可以调用以下技能（skill）。**如果用户的话匹配某个技能，就严格按那个技能里的指令做**：\n" +
        Skill.list.map((x) => `· ${x.id} — ${(x.description || "").slice(0, 130)}`).join("\n") +
        "\n当前对话使用的模型：" + (cm ? cm.name : "（演示模式）") +
        "\n⚠️ 涉及「派发任务」的技能需要用户先授权确认，绝不能自己直接派发。"
      : "";

    const sys =
      "你是 Lingo 智能体调度台里的桌面机器人助手，名字叫 Lingo 助手。\n" +
      "性格：友好、干练、有点俏皮，说中文。回答尽量简洁（除非用户要求详细）。\n" +
      "你可以用 Markdown，但别堆太长。\n" +
      "你同时是调度台的管家，能回答关于下面这些实时数据的问题：\n" +
      `· 正在运行 ${s.running} 个任务，排队 ${s.queued} 个，失败 ${s.failed} 个\n` +
      `· 累计消耗 ${fmt(s.tokens)} tokens，花费 $${s.cost.toFixed(4)}，已完成 ${s.done} 个任务\n` +
      `· 已接入模型：${MODELS.map((m) => m.name + "(" + m.id + ")").join("、")}\n` +
      (lowest ? `· 余额最低的模型：${lowest.name}（剩余 ${fmt(lowest.quota)}）\n` : "") +
      `· 当前运行模式：${live ? "真实 API" : "演示模式（没配密钥）"}\n` +
      "\n" +
      "最近的 task（用户问「跑完了吗」「结果是什么」「刚才那个任务」时，看这里回答，要引用具体产出）：\n" +
      (recent.length ? recent.join("\n") + "\n" : "（暂无任务记录）\n") +
      "\n" +
      (manifest ? manifest + "\n\n" : "") +
      "如果用户让你派发任务，**先复述任务和目标模型并征求确认**，确认后才在回复最后单独一行输出 [[DISPATCH]]{...}[[/DISPATCH]]。\n" +
      "\n" +
      "【重要】你**能够直接操作这个调度台的界面**，不要说「我控制不了」「你得自己点」。\n" +
      "用户让你操作界面时：先在正文用一句话回应，然后在回复最后单独一行输出动作标记。\n" +
      "格式：[[UI]]{\"action\":\"动作名\",\"参数\":值}[[/UI]]\n" +
      "例如用户说「打开侧边栏」，你就回：\n" +
      "好的，帮你打开侧边栏。\n" +
      "[[UI]]{\"action\":\"sidebar\",\"open\":true}[[/UI]]\n" +
      "你能做的界面动作只有下面这些，**只准用这些名字**，别自己造：\n" +
      UIAction.manifest() + "\n" +
      "注意：[[UI]] 标记只被程序读取，不会显示给用户，所以正文里要正常回话。一次最多输出一个 [[UI]] 标记。\n" +
      "如果用户要的操作不在上面这张表里，老实说做不到，但别否定你有操作界面的能力。\n" +
      "不要去编造上面没有的数据。";

    // 自动按需注入命中的 skill 正文
    let skillBlock = "";
    try {
      const inj = await Skill.inject(userText || "", 2, 9000);
      if (inj.text) {
        skillBlock = "\n\n" + inj.text;
        this._lastSkills = inj.used;
      } else {
        this._lastSkills = [];
      }
    } catch (_) { this._lastSkills = []; }

    const msgs = [{ role: "system", content: sys + skillBlock }];
    // 取最近 12 轮，避免上下文过长
    const hist = this.messages.slice(-12);
    hist.forEach((m, i) => {
      const isLast = i === hist.length - 1;
      // 只有最后一条（本轮）才带图片，历史里的图转成文字占位（省 token）
      const withImgs = isLast && images && images.length ? images : null;
      if (!m.text && !withImgs) return;
      if (withImgs) {
        const content = [];
        const imgs = withImgs.map((im) => ({ dataUrl: im.dataUrl }));
        // 用 Vision 的组装器：文字在前，图在后
        const parts = Vision.toOpenAIContent(m.text || "", imgs);
        msgs.push({ role: m.role === "user" ? "user" : "assistant", content: parts });
      } else {
        if (!m.text) return;
        const note = m.images && m.images.length ? `（用户发过 ${m.images.length} 张图）` : "";
        msgs.push({ role: m.role === "user" ? "user" : "assistant", content: m.text + note });
      }
    });
    return msgs;
  },

  // 真·流式回复：气泡边收边吐
  async replyLive(text) {
    const model = this.chatModel();
    if (!model) { this.replyLocal(text); return; }

    // 先插一条空气泡
    this.pushMsg("bot", "", "info");
    const idx = this.messages.length - 1;
    this.renderMessages();
    const nodes = this.el.dialogBody.querySelectorAll(".pet-msg-text");
    const target = nodes[nodes.length - 1];
    if (!target) { this.replyLocal(text); return; }

    this.busy = true;
    this._setDialogStatus(`正在思考…（${model.name}）`);
    let acc = "";
    let caret = document.createElement("span");
    caret.className = "pet-caret";
    target.appendChild(caret);

    // 过滤控制标记：[[DISPATCH]]{...}[[/DISPATCH]] 和 [[UI]]{...}[[/UI]]
    // 都不显示在气泡里。流式过程中标记可能还没吐完，用「可见前缀」策略：
    // 只显示第一个标记出现之前的文字。
    const VIS = (s) => {
      const cuts = [s.indexOf("[[DISPATCH]]"), s.indexOf("[[UI]]")].filter((n) => n !== -1);
      return cuts.length ? s.slice(0, Math.min(...cuts)) : s;
    };

    const paint = () => {
      const vis = VIS(acc).replace(/\n{3,}/g, "\n\n").trimEnd();
      target.textContent = vis;
      target.appendChild(caret);
      this.messages[idx].text = vis;
      this.scrollToBottom();
    };

    // 取消上一次没结束的对话
    if (this._chatCtl) this._chatCtl.abort();
    this._chatCtl = new AbortController();

    const messages = await this.buildChatMessages(text);
    // 状态栏顺便显示命中的技能
    if (this._lastSkills && this._lastSkills.length) {
      this._setDialogStatus(`正在思考…（${model.name}）`);
      this._setSkillTags(this._lastSkills);
    }

    await LiveDataSource.chat(
      model,
      messages,
      {
        onDelta: (t) => { acc += t; paint(); },
        onError: (msg) => {
          this.busy = false;
          caret.remove();
          if (!acc) {
            // 一个字都没吐出来 → 直接退回本地规则引擎
            this.messages.pop();
            this.renderMessages();
            this.replyLocal(text, `（真模型不可用：${msg}）\n`);
          } else {
            acc += `\n\n⚠️ ${msg}`;
            paint();
          }
          this._setDialogStatus("就绪");
        },
        onDone: () => {
          this.busy = false;
          caret.remove();
          this._setDialogStatus("就绪");
          if (!acc) {
            this.messages.pop();
            this.renderMessages();
            this.replyLocal(text);
            return;
          }
          // 检查是否有派发意图标记 → 弹授权卡
          const m = /\[\[DISPATCH\]\]([\s\S]*?)\[\[\/DISPATCH\]\]/.exec(acc);
          if (m) {
            let req = null;
            try { req = JSON.parse(m[1].trim()); } catch (_) {}
            if (req && req.task) {
              this.messages[idx].text = VIS(acc).trim() || "我准备好了，请确认后派发：";
              this.renderMessages();
              this.offerDispatch(req);
            }
          }

          // 检查是否有界面操作标记 → 真的去操作页面
          const uiReqs = UIAction.extract(acc);
          if (uiReqs.length) {
            // 先确保气泡里不含标记（可能已经通过 VIS 剥掉了，这里再兜一次）
            const clean = VIS(acc).replace(/\n{3,}/g, "\n\n").trim();
            this.messages[idx].text = clean;
            this.renderMessages();
            // 执行（一次最多一个，防抖）
            const req = uiReqs[0];
            const out = UIAction.run(req);
            this._flashAction(out, req);
          } else {
            // 兜底：模型嘴上说要做、却没吐标记，或者吐的标记坏了。
            // 用本地关键词再判一次 —— 保证「说得到」=「做得到」。
            const local = UIAction.matchLocal(text);
            if (local && UIAction.looksLikeIntent(acc)) {
              const out = UIAction.run(local);
              this._flashAction(out, local);
            }
          }
        },
      },
      this._chatCtl.signal
    );
  },

  /* ---------- 识图：待发送图片管理 ---------- */
  pending: [],   // [{dataUrl,width,height,bytes,name}]

  async addImages(files) {
    if (!files || !files.length) return;
    const room = Vision.MAX_IMAGES - this.pending.length;
    if (room <= 0) {
      Notifier.add({ level: "warn", title: "图片已达上限", body: `一条消息最多 ${Vision.MAX_IMAGES} 张`, dedupeKey: "img:max", cooldownMs: 3000 });
      return;
    }
    const take = files.slice(0, room);
    if (files.length > take.length) {
      Notifier.add({ level: "warn", title: "只收下前几张", body: `一条消息最多 ${Vision.MAX_IMAGES} 张`, dedupeKey: "img:trim", cooldownMs: 3000 });
    }
    for (const f of take) {
      try {
        const im = await Vision.compress(f);
        this.pending.push(im);
      } catch (err) {
        Notifier.add({ level: "danger", title: "图片读取失败", body: f.name + "：" + err.message, dedupeKey: "img:err:" + f.name, cooldownMs: 0 });
      }
    }
    this.renderAttach();
  },

  removeImage(i) {
    if (i < 0 || i >= this.pending.length) return;
    this.pending.splice(i, 1);
    this.renderAttach();
  },

  clearImages() {
    this.pending = [];
    this.renderAttach();
  },

  renderAttach() {
    const bar = this.el.attachBar, list = this.el.attachList;
    if (!bar || !list) return;
    if (!this.pending.length) { bar.hidden = true; list.innerHTML = ""; return; }
    bar.hidden = false;
    list.innerHTML = this.pending
      .map(
        (im, i) => `
        <div class="pet-attach-item">
          <img src="${im.dataUrl}" alt="${escapeHtml(im.name)}" data-view="${i}" title="点击放大" />
          <button class="pet-attach-rm" type="button" data-rm="${i}" aria-label="移除这张图">×</button>
          <span class="pet-attach-size">${im.width}×${im.height}</span>
        </div>`
      )
      .join("");
  },

  openLightbox(im) {
    if (!im) return;
    this._lbImage = im;
    this.el.lightboxImg.src = im.dataUrl;
    this.el.lightbox.hidden = false;
    this.el.lightboxClose.focus();
  },
  closeLightbox() {
    this.el.lightbox.hidden = true;
    this.el.lightboxImg.src = "";
    this._lbImage = null;
  },

  // 提交输入框（带图 or 不带图）
  submitInput() {
    const text = (this.el.input.value || "").trim();
    const imgs = this.pending.slice();
    if (!text && !imgs.length) return;
    this.el.input.value = "";
    this.el.input.style.height = "auto";
    if (imgs.length) {
      this.sendWithImages(text, imgs);
      this.clearImages();
    } else {
      this.send(text);
    }
  },

  /* ---------- 识图发送 ---------- */
  async sendWithImages(text, images) {
    if (this.busy) {
      Notifier.add({ level: "warn", title: "还在回复中", body: "等上一条说完再发", dedupeKey: "img:busy", cooldownMs: 1500 });
      return;
    }
    const prompt = text || "请描述这张图片的内容。";

    // 1) 用户气泡（带缩略图）
    this.pushMsg("user", prompt, "info", images);
    this.renderMessages();
    this.scrollToBottom();

    const model = Vision.visionModel();
    this._setDialogStatus(model ? `正在看图…（${model.name}）` : "正在看图…（演示）");

    // 2) 没有多模态模型 → 演示识图
    if (!model) {
      this.busy = true;
      const desc = await Vision.demoDescribe(images, text);
      this.busy = false;
      this.typeOut(desc, "info");
      this._setDialogStatus("就绪");
      return;
    }

    // 3) 有模型 → 走真多模态请求
    this.pushMsg("bot", "", "info");
    const idx = this.messages.length - 1;
    this.renderMessages();
    const nodes = this.el.dialogBody.querySelectorAll(".pet-msg-text");
    const target = nodes[nodes.length - 1];
    if (!target) return;

    this.busy = true;
    let acc = "";
    const caret = document.createElement("span");
    caret.className = "pet-caret";
    target.appendChild(caret);
    const paint = () => {
      target.textContent = acc;
      target.appendChild(caret);
      this.messages[idx].text = acc;
      this.scrollToBottom();
    };

    if (this._chatCtl) this._chatCtl.abort();
    this._chatCtl = new AbortController();

    // 组装多模态消息（历史 + 本轮图片）
    const msgs = await this.buildChatMessages(text, { images });
    await LiveDataSource.chat(
      model,
      msgs,
      {
        onDelta: (t) => { acc += t; paint(); },
        onError: (msg) => {
          this.busy = false;
          caret.remove();
          const hint = /image|vision|multimodal|content/i.test(msg)
            ? "\n\n（这个模型可能不支持图片输入，换一个多模态模型试试）"
            : "";
          if (!acc) {
            this.messages.pop();
            this.renderMessages();
            this.replyLocal(text, `（识图失败：${msg}）${hint}\n`);
          } else {
            acc += `\n\n⚠️ ${msg}${hint}`;
            paint();
          }
          this._setDialogStatus("就绪");
        },
        onDone: () => {
          this.busy = false;
          caret.remove();
          this._setDialogStatus("就绪");
          if (!acc) { this.messages.pop(); this.renderMessages(); }
        },
      },
      this._chatCtl.signal
    );
  },

  /* ---------- 任务完成播报 ----------
     真实 API 的短任务经常 1 秒内就跑完，「进行中」列表一闪而过，
     用户根本来不及看。所以完成时由桌宠主动把结果说出来。
     注意：Notifier.add 已经会自动调 Pet.notify() 把通知送进对话框，
     所以这里**不再重复 pushMsg**，只在有真实产出时把产出补一条出来。
     ------------------------------------------------------------------ */
  announceResult(agent) {
    if (!agent) return;
    const out = String(agent.fullOutput || "").trim();
    if (!out) return;                      // 没产出就靠通知即可
    const model = agent.model ? agent.model.name : "模型";
    const secs = agent.startedAt && agent.finishedAt
      ? ((agent.finishedAt - agent.startedAt) / 1000).toFixed(1)
      : null;

    let snippet = out;
    if (snippet.length > 500) snippet = snippet.slice(0, 500).replace(/\s+\S*$/, "") + "…";

    // 只补「产出正文」那一条，避免和通知消息重复
    const wasOpen = this.el.dialog && !this.el.dialog.hidden;
    this.pushMsg(
      "bot",
      `**${agent.name}** 的产出：\n\n${snippet}\n\n_${model}${secs ? " · " + secs + "s" : ""} · $${agent.cost.toFixed(4)}_`,
      "ok"
    );
    if (this.el.dialogBody) this.renderMessages();
    if (!wasOpen) this.renderBadge();
  },

  /* ---------- 任务派发授权（Codex 式：先确认，再执行）---------- */
  offerDispatch(req) {
    const mid = req.model || this.DEFAULT_CHAT_MODEL_ID;
    const model = MODELS.find((m) => m.id === mid) || MODELS[0];
    const el = document.createElement("div");
    el.className = "pet-dispatch-card";
    el.innerHTML = `
      <div class="pdc-head">
        <span class="pdc-badge">需要授权</span>
        <span class="pdc-title">派发任务</span>
      </div>
      <div class="pdc-row"><span class="pdc-k">模型</span><span class="pdc-v">${escapeHtml(model.name)} <em>${escapeHtml(model.id)}</em></span></div>
      <div class="pdc-row"><span class="pdc-k">任务</span><span class="pdc-v">${escapeHtml(req.task)}</span></div>
      <div class="pdc-actions">
        <button type="button" class="pdc-btn pdc-ok">确认派发</button>
        <button type="button" class="pdc-btn pdc-no">取消</button>
      </div>`;
    this.el.dialogBody.appendChild(el);
    this.scrollToBottom();

    const finish = (note) => {
      el.querySelector(".pdc-actions").innerHTML = `<span class="pdc-note">${escapeHtml(note)}</span>`;
    };
    el.querySelector(".pdc-no").addEventListener("click", () => finish("已取消"));
    el.querySelector(".pdc-ok").addEventListener("click", () => {
      finish("已派发 ✓");
      try {
        Engine.addAgent({ modelId: model.id, name: "助手派发", task: req.task });
        Notifier.add({ level: "info", title: "任务已派发", body: `${model.name} · ${req.task}` });
      } catch (e) {
        finish("派发失败：" + e.message);
      }
    });
  },

  // 本地规则引擎回复（打字机 + 可选前缀说明）
  replyLocal(text, prefix = "") {
    // 离线也要能听懂界面指令（没配模型时不至于「什么都不会做」）
    const uiReq = UIAction.matchLocal(text);
    setTimeout(() => {
      if (uiReq) {
        const out = UIAction.run(uiReq);
        const say = out.ok ? `好的，${out.note}。` : `这个我做不到：${out.note}`;
        this.typeOut(prefix + say, out.ok ? "success" : "warn");
        this._flashAction(out, uiReq);
        return;
      }
      this.typeOut(prefix + this.answer(text), "info");
    }, 200);
  },

  /* 执行界面动作后的反馈：气泡下方贴一行小提示 + 通知中心记一笔 */
  _flashAction(out, req) {
    if (!out) return;
    // 在对话框里贴一个轻量小条（不占用聊天气泡）
    const bar = document.createElement("div");
    bar.className = "pet-action-note " + (out.ok ? "ok" : "no");
    bar.innerHTML = `<span class="pan-ico">${out.ok ? "✓" : "✕"}</span><span class="pan-txt"></span>`;
    bar.querySelector(".pan-txt").textContent = out.note || (out.ok ? "已执行" : "未执行");
    this.el.dialogBody.appendChild(bar);
    this.scrollToBottom();
    setTimeout(() => { bar.classList.add("fade"); }, 2600);
    setTimeout(() => bar.remove(), 3400);

    // 成功执行的动作也进通知中心，方便回溯
    if (out.ok) {
      Notifier.add({
        level: "info",
        title: "助手操作了界面",
        body: out.note,
        dedupeKey: "ui:" + (req && req.action) + ":" + out.note,
        cooldownMs: 1500,
        silentPet: true,     // 已经在对话框里反馈了，别再弹宠物
      });
    }
  },

  _setDialogStatus(t) {
    if (this.el.dialogStatus) this.el.dialogStatus.textContent = t;
  },

  // 在状态栏显示命中的技能（小徽标）
  _setSkillTags(ids) {
    if (!this.el.dialogStatus) return;
    if (!ids || !ids.length) return;
    // 保留原文本，追加技能徽标
    const base = this.el.dialogStatus.textContent || "";
    this.el.dialogStatus.textContent = base;
    ids.forEach((id) => {
      const tag = document.createElement("span");
      tag.className = "pet-skill-tag";
      tag.textContent = "✦ " + id;
      this.el.dialogStatus.appendChild(tag);
    });
  },

  /* ---------- 聊天大脑（离线规则引擎）---------- */
  answer(q) {
    const s = String(q || "").trim();
    const running = Engine.agents.filter((a) => a.status === "running");
    const queued = Engine.agents.filter((a) => a.status === "queued");
    const failed = Engine.agents.filter((a) => a.status === "failed");
    const totalTok = Engine.totalInput + Engine.totalOutput;

    if (!s) return "你可以问我：用了多少 token、哪个模型余额低、现在有哪些任务在跑。";

    // 问候
    if (/^(你好|hi|hello|嗨|在吗)/i.test(s)) {
      return "你好，我是 Lingo 助手 🤖\n我一直在看着调度台。想了解点什么？";
    }
    // token
    if (/token|消耗|用量|用了多少/i.test(s)) {
      return `当前共消耗 ${fmt(totalTok)} tokens（输入 ${fmt(Engine.totalInput)}、输出 ${fmt(Engine.totalOutput)}），累计花费 $${Engine.totalCost.toFixed(4)}，已完成 ${Engine.totalTasks} 个任务。`;
    }
    // 成本
    if (/成本|花了|多少钱|费用|cost/i.test(s)) {
      const top = [...MODELS].sort((a, b) => b.spent - a.spent).filter((m) => m.spent > 0)[0];
      const list = MODELS.filter((m) => m.location !== "local")
        .map((m) => `${m.name} $${m.spent.toFixed(4)}`).join("、");
      return `累计花费 $${Engine.totalCost.toFixed(4)}。\n云端分项：${list || "暂未产生费用"}。\n花费最高的是 ${top ? top.name : "—"}。`;
    }
    // 余额 / 额度
    if (/余额|额度|quota|剩余|够不够|还好吗/i.test(s)) {
      const low = MODELS.filter((m) => (m.quota.used / m.quota.total) >= 0.85);
      const cloud = MODELS.filter((m) => m.location !== "local")
        .map((m) => `${m.name} $${(m.quota.total - m.quota.used).toFixed(4)}`).join("、");
      const local = MODELS.filter((m) => m.location === "local")
        .map((m) => `${m.name} 已用 ${fmt(m.quota.used)} ctx`).join("、");
      const warn = low.length ? `\n⚠️ ${low.map((m) => m.name).join("、")} 余额偏低，注意补充。` : "\n额度都还健康。";
      return `云端剩余：${cloud || "—"}。\n本地上下文：${local || "—"}。${warn}`;
    }
    // 失败（先于「任务」判断，否则"失败的任务"会被误判）
    if (/失败|报错|错误|fail|error/i.test(s)) {
      if (!failed.length) return "目前没有失败的任务，一切正常。";
      return `有 ${failed.length} 个任务失败：\n${failed.map((a) => `· ${a.name}（${a.model.name}）`).join("\n")}\n可以在「运行明细」里看详情。`;
    }
    // 任务
    if (/任务|在跑|干嘛|在做什么|进度|忙什么/i.test(s)) {
      if (!running.length && !queued.length) return `现在没有任务在跑，我已经完成 ${Engine.totalTasks} 个任务了。要我帮你派一个吗？`;
      const r = running.map((a) => `· ${a.name}（${a.model.name}）正在生成…`).join("\n");
      const qq = queued.map((a) => `· ${a.name} 排队中`).join("\n");
      return `${running.length} 个运行中、${queued.length} 个排队中：\n${[r, qq].filter(Boolean).join("\n")}`;
    }
    // 模型
    if (/模型|model|gpt|claude|qwen|deepseek/i.test(s)) {
      const list = MODELS.map((m) => `· ${m.name}（${m.vendor}${m.location === "local" ? " · 本地" : ""}）`).join("\n");
      return `当前接入 ${MODELS.length} 个模型：\n${list}`;
    }
    // 派发
    if (/派发|新建|创建|来一个|帮我做|dispatch/i.test(s)) {
      setTimeout(() => { this.hideDialog(); UI.openModal(); }, 600);
      return "好的，这就帮你打开派发窗口 ——";
    }
    // 帮助
    if (/帮助|help|能做什么|会什么|怎么用/i.test(s)) {
      return "我可以：\n· 汇报 token 用量与成本\n· 查看各模型余额\n· 列出正在跑和排队的任务\n· 汇报失败任务\n· 帮你打开派发窗口\n直接问我，或者点下面的快捷提问。";
    }
    // 兜底
    return `我暂时只懂调度台的数据～你可以试试问「用了多少 token」「余额还好吗」「在跑什么」。\n（累计已处理 ${Engine.totalTasks} 个任务）`;
  },

  // 发送一条用户消息 → 真模型流式回复（没配密钥则退回规则引擎）
  send(text) {
    const t = String(text || "").trim();
    if (!t || this.busy) return;
    this.pushMsg("user", t);
    this.renderMessages();
    this.scrollToBottom();

    // 有可跑的模型 → 真 LLM；否则规则引擎
    if (this.chatModel()) {
      this.replyLive(t);
    } else {
      // 离线：先看能不能听懂界面指令（走 replyLocal，它有 UIAction 兜底）
      const stop = this.showTyping();
      setTimeout(() => {
        stop();
        this.replyLocal(t);
      }, 380 + Math.random() * 420);
    }
  },

  renderBadge() {
    if (!this.el.badge) return;
    this.el.badge.hidden = this.unread <= 0;
    this.el.badge.textContent = this.unread > 9 ? "9+" : String(this.unread);
  },

  showDialog(opts) { this.openDialog(opts); },
  openDialog({ focusInput = true } = {}) {
    if (!this.el.dialog) return;
    this.clearToasts();
    this.el.dialog.hidden = false;
    this.dialogOpen = true;
    this.unread = 0;
    this.renderBadge();
    setTimeout(() => {
      this.scrollToBottom();
      if (focusInput) this.el.input?.focus();
    }, 40);
  },
  hideDialog() {
    if (!this.el.dialog) return;
    this.el.dialog.hidden = true;
    this.dialogOpen = false;
    this.el.root.classList.remove("alerting");
  },
  toggleDialog() {
    if (this.dialogOpen) { this.hideDialog(); return; }
    this.renderMessages();
    this.openDialog({ focusInput: true });
  },

  // 欢迎语（首次打开时）
  seedWelcome() {
    if (this.messages.length) return;
    this.pushMsg("bot", "你好，我是 Lingo 助手 🤖\n我负责盯着这个调度台：token 消耗、模型余额、任务进度都可以问我。", "info");
    this.renderMessages();
  },

  // ---- 安静待命模式 ----
  setParked(on) {
    this.parked = !!on;
    if (!this.el.root) return;          // 未初始化时仅记录状态
    this.el.root.classList.toggle("parked", this.parked);
    if (this.parked) {
      this.hideDialog();
      this.walking = false;
      this.el.root.classList.remove("walking");
      // 回到左下角助手位置
      this.tx = this.x = 24;
      this.ty = this.y = window.innerHeight - 140;
      this.applyTransform();
    } else {
      // 恢复走动：重置空闲计时，保持原地不动直到用户真正空闲
      this.lastMouse = performance.now();
      this.mode = "idle";
      this.tx = this.x;
      this.ty = this.y;
    }
  },
};

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/* ------------------------- 工具函数 ------------------------- */
function fmt(n) {
  return (n || 0).toLocaleString("en-US");
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
// 相对时间（通知时间戳）
function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return new Date(ts).toLocaleString("zh-CN");
}

/* =====================================================================
 * OcActivity —— 本机 AI 活动监控（opencode 等）
 * ---------------------------------------------------------------------
 * 数据来自本地代理只读 opencode 库，每 5 秒轮询一次。
 * 「正在跑」由后端判定（会话最后一条消息不是 idle），前端只负责展示。
 * 会话标题/目录是外部内容 → 一律转义后再插 DOM，避免注入。
 * ===================================================================== */
const OcActivity = {
  url: "http://127.0.0.1:8900/api/opencode/activity",
  timer: null,

  esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  },

  /* 历史总计：全部自动统计。
     金额 = 累计充值 − 当前余额（充值额来自配置基线 + 自动识别的后续充值）；
     token = opencode 库总计（自动）；官方控制台数字仅作参考。 */
  renderTotals(t) {
    const tokEl = document.getElementById("ocTotalTokens");
    const costEl = document.getElementById("ocTotalCost");
    if (!tokEl || !costEl) return;

    const b = Baseline.data;
    const local = Usage.cumulative();
    const ocTok = t ? (t.input || 0) + (t.output || 0) : 0;
    const ocCost = t ? t.cost || 0 : 0;
    const estCost = ocCost + local.cost;   // 价表口径（USD）

    if (b && typeof b.consumedCNY === "number") {
      tokEl.textContent = fmt(b.opencodeTokens || 0);
      tokEl.title = `自动统计：opencode 本地库全部会话累计 token`
        + `（输入 ${fmt((b.opencodeBreakdown || {}).input || 0)} / 输出 ${fmt((b.opencodeBreakdown || {}).output || 0)}`
        + ` / 缓存读 ${fmt((b.opencodeBreakdown || {}).cacheRead || 0)}）`
        + (b.reference && b.reference.tokens30d ? `\n官方控制台参考（近30天）：${fmt(b.reference.tokens30d)}` : "");

      costEl.textContent = Money.fmt(b.consumedCNY, "CNY");
      costEl.title = `自动统计：累计消费 = 累计充值 − 当前余额`
        + `\n累计充值 ¥${b.topUp.total.toFixed(2)}（基线 ¥${b.topUp.baseline.toFixed(2)} + 自动识别 ¥${b.topUp.auto.toFixed(2)}）`
        + `\n当前余额 ¥${(b.balanceCNY == null ? 0 : b.balanceCNY).toFixed(2)}`;
    } else {
      tokEl.textContent = fmt(ocTok + local.in + local.out);
      costEl.textContent = Money.fmt(estCost, "USD");
      tokEl.title = "代理不可用，显示本机记录：opencode 全部会话 + 本调度台本地账本";
      costEl.title = "代理不可用，显示价表估算（USD）";
    }
  },

  async load() {
    const body = document.getElementById("ocBody");
    const hint = document.getElementById("ocHint");
    const empty = document.getElementById("ocEmpty");
    if (!body) return;

    let data;
    try {
      const r = await fetch(this.url, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      data = await r.json();
    } catch (e) {
      data = { available: false, reason: "连不上本地代理：" + e.message };
    }

    if (!data || !data.available) {
      body.innerHTML = "";
      empty.hidden = false;
      empty.textContent = (data && data.reason) || "未检测到本机 AI 活动";
      hint.textContent = "不可用";
      return;
    }

    const runs = data.sessions.filter((s) => s.status === "running");
    hint.textContent = `${runs.length} 个进行中 · 共 ${data.sessions.length} 个会话`;
    // 按模型的真实用量（供「成本归因」按占比分摊真实花费）
    this.byModel = data.byModel || [];
    this.totals = data.totals || null;
    this.renderTotals(data.totals);

    // 进行中的排最前，其余按最近活动排序
    const sorted = data.sessions.slice().sort((a, b) => {
      if ((a.status === "running") !== (b.status === "running")) return a.status === "running" ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });

    body.innerHTML = sorted.map((s) => {
      const chip = s.status === "running"
        ? '<span class="trace-status running">运行中</span>'
        : '<span class="trace-status done">空闲</span>';
      return `<tr>
        <td>${chip}</td>
        <td>${this.esc(s.title)}</td>
        <td>${this.esc(s.directory)}</td>
        <td>${this.esc(s.model) || "—"}</td>
        <td class="num">${s.input.toLocaleString()}</td>
        <td class="num">${s.output.toLocaleString()}</td>
        <td class="num">$${(s.cost || 0).toFixed(4)}</td>
        <td>${timeAgo(s.updatedAt)}</td>
      </tr>`;
    }).join("");

    const hasRunning = runs.length > 0;
    empty.hidden = hasRunning || sorted.length > 0;
    if (!empty.hidden) empty.textContent = "未检测到本机 AI 活动。";
  },

  start() {
    this.load();
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.load(), 5000);
  },
};

/* ------------------------- 启动 ------------------------- */
document.addEventListener("DOMContentLoaded", async () => {
  // 先自动拉取各 provider 的真实模型列表，再渲染（避免先用种子渲染一遍）
  await AutoModels.load();
  await Money.load();   // 汇率（用于把 CNY 金额按 USD 展示；拿不到就回落原币种）
  await Baseline.load(); // 官方用量基线 + 之后增量（真实消费与 token 的权威来源）

  UI.init();
  Hook.init();     // 连接外部 Agent 状态总线（没连上就安静地用本地模式）
  // 技能库：读偏好（启停）+ 扫描本地 skill 目录
  Skill.loadPrefs();
  Skill.load().then((list) => {
    UI.el.sideSkillCount.textContent = String(list.length);
    if (list.length) console.log(`[Lingo] 读到 ${list.length} 个 skill（启用 ${Skill.enabledCount()}）`);
  });

  // 探测真实 API 是否可用（代理在线 + 至少一个 provider 配了密钥）
  const health = await LiveDataSource.probe();
  UI.renderApiMode(health);
  const anyLive = health && Object.values(health.providers || {}).some((p) => p.configured);
  console.log(anyLive ? "[Lingo] 真实 API 模式" : "[Lingo] 演示模式（未配置密钥或代理未启动）");

  // 拉真实账户余额（DeepSeek 有 /user/balance 接口）
  await Balance.loadSpend();   // 先取服务端累计已花（余额下降量推算，持久化）
  Balance.refreshAll().then((cache) => {
    UI.renderQuotas();
    UI.renderBalances();
    Object.entries(cache).forEach(([p, d]) => {
      if (d && d.supported && typeof d.total === "number") {
        console.log(`[Lingo] ${p} 真实余额：${d.currency} ${d.total}`);
      }
    });
  });
  // 每 5 分钟刷新一次余额
  setInterval(() => Balance.refreshAll().then(() => { UI.renderQuotas(); UI.renderBalances(); }), 300000);
  // 每 30 秒刷新官方基线 + 增量（代理端要读一次 opencode 库，别太频繁）
  setInterval(() => Baseline.load().then(() => UI.renderKPI()), 30000);

  // 载入本地用量账本（今天 / 本月），并渲染
  Usage.load();
  UI.renderUsage();

  // 本机 AI 活动（opencode 等）：首屏拉一次，之后每 5 秒轮询
  OcActivity.start();

  if (anyLive) {
    // 真实模式：用 DeepSeek 跑几个真任务
    const liveModels = MODELS.filter((m) => LiveDataSource.canRun(m));
    const m0 = liveModels[0];
    if (m0) {
      Engine.addAgent({ modelId: m0.id, name: "调度台自检", task: "用一句话说明你是 Lingo 调度台里的哪个模型，并说明你已就绪。" });
    }
  } else {
    // 演示模式：预置几个 Demo Agent，打开页面即可看到效果
    Engine.addAgent({ modelId: "deepseek-chat", name: "文案助手", task: "为新品写一段 80 字的社交媒体推广文案。" });
    setTimeout(() => Engine.addAgent({ modelId: "deepseek-chat", name: "摘要器", task: "把这份周报压缩成三条要点。" }), 900);
    setTimeout(() => Engine.addAgent({ modelId: "deepseek-reasoner", name: "代码审查", task: "审查这段 Python 函数并给出优化建议。" }), 1800);
  }
});
