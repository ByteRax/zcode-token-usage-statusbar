"use strict";
// 扩展沙箱视图（view-insights.html / view-context.html）渲染回归：假 DOM + 假 window.zcode 驱动页面里的真实脚本。
// 锁定：实测环形图取代按比例推算的分段、估算八分类默认折叠、主/子代理切换、质量卡片、
// 浏览器最新在前 + 游标翻页 + 逐轮模式 + 筛选片、抓包开关。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// 视图页面是插件顶层的 extension-view-*.js（内容是 HTML，宿主按文本读；放顶层是为了兼容在野旧版解包器）
const DIR = path.join(__dirname, "..", "plugins", "zcode-token-usage-statusbar");

function mkEl(id) {
  return {
    id, innerHTML: "", textContent: "", onclick: null, oninput: null, handlers: {},
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener(ev, fn) { this.handlers[ev] = fn; },
    getAttribute() { return null; }, focus() {}, setSelectionRange() {},
  };
}

function loadView(file, tools, opts = {}) {
  const script = fs.readFileSync(path.join(DIR, file), "utf8").match(/<script>([\s\S]*?)<\/script>/)[1];
  const els = {};
  const get = (id) => { if (!els[id]) els[id] = mkEl(id); return els[id]; };
  const hooks = {};   // content.querySelectorAll(sel) → 合成节点
  get("content").querySelectorAll = (sel) => (hooks[sel] ? hooks[sel]() : []);
  // 贴近真实 DOM 的两点语义：每次写 innerHTML 算一次重建——.timeline-wrap 变成新节点（横向滚动位置归零）；
  // 页面的纵向滚动容器（document.scrollingElement）则跨重绘是同一个节点
  let html = "", tlNode = { scrollLeft: 0 };
  Object.defineProperty(get("content"), "innerHTML", { get: () => html, set: (v) => { html = v; tlNode = { scrollLeft: 0 }; } });
  get("content").querySelector = (sel) => (sel === ".timeline-wrap" && html.includes("timeline-wrap") ? tlNode : null);
  const scroller = { scrollTop: 0 };
  const tabs = ["stats", "browser", "events"].map((t) => { const b = mkEl("tab-" + t); b.getAttribute = (n) => (n === "data-tab" ? t : null); return b; });
  const pills = ["all", "main", "sub"].map((m) => { const b = mkEl("split-" + m); b.getAttribute = (n) => (n === "data-split" ? m : null); return b; });
  const document = {
    getElementById: get,
    scrollingElement: scroller,
    querySelectorAll: (sel) => (sel === ".tab" ? tabs : sel === "[data-split]" ? pills : []),
    documentElement: { dataset: {} },
  };
  const calls = [];
  const noted = { toast: null, said: "" };
  const window = {
    zcode: {
      ready: () => Promise.resolve(), hostContext: { theme: "dark" },
      subscribe() {}, onResourceUpdated(fn) { noted.resUpdated = fn; }, subscribeResource() {},
      callTool: async (name, input) => { calls.push({ name, input }); return tools[name] ? tools[name](input) : { ok: false, error: "no tool" }; },
    },
  };
  const sandbox = { window, document, setTimeout, clearTimeout, console };
  sandbox.setTimeout = (fn) => { noted.toast = fn; return 0; };   // showToast 走 setTimeout：截下回调供断言
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { filename: file });
  // 调用入参诞生在 vm 的 realm 里，deepEqual 会因原型不同判不等：按 JSON 归一后再比
  const plain = (x) => JSON.parse(JSON.stringify(x));
  const flush = async () => {
    await new Promise((r) => setImmediate(r));
    const t = get("toast");
    if (t && t.textContent) noted.said = t.textContent;
    if (opts.onToast && noted.said) opts.onToast(noted.said);
  };
  return { calls, hooks, get, tabs, pills, plain, scroller, fireResource: () => noted.resUpdated && noted.resUpdated(), toast: () => noted.said, html: () => get("content").innerHTML, flush };
}

/* ---------- 样本快照（字段形状与 zusage.py 对齐）---------- */
const T0 = 1700000000000;
const bucket = (req, inp, out, genMs) => ({ requests: req, tokens: inp + out, inp, out, reas: 0, cr: Math.round(inp * 0.6), cw: 0, durMs: genMs + 1000, ttftMs: 1000, genMs,
  costUsd: 0.5, tps: Math.round(out / (genMs / 1000) * 10) / 10, cacheHitRate: 60, toolCalls: 3 });
const SPLIT = { all: { ...bucket(6, 4000, 800, 10000), sessions: 2 }, main: { ...bucket(4, 1500, 300, 2550), sessions: 1 }, sub: { ...bucket(1, 2400, 400, 4000), sessions: 1 } };
const ERRORS = { requests: 5, failedAttempts: 2, failed: 1, cancelled: 1, retries: 1, byType: { rate_limited: 1, cancelled: 1 } };
const TOOLQ = { total: 3, errorStatus: 1, nonZeroExit: 1, truncated: 1, readOnly: 1, destructive: 0, p50Ms: 120, p95Ms: 3000, avgMs: 1057 };
const COMP = { time: T0, auto: true, trigger: "auto", preTokens: 900000, postTokens: 50000, summarized: 40, kept: 1, willRetrigger: true, reason: "context_limit" };
const TOKEN_BREAKDOWN = [
  { id: "systemPrompt", tokens: 173 }, { id: "toolSchemas", tokens: 650 }, { id: "userMessages", tokens: 25 },
  { id: "injectedContext", tokens: 99 }, { id: "skillInjections", tokens: 50 }, { id: "toolCalls", tokens: 912 },
  { id: "reasoning", tokens: 150 }, { id: "answers", tokens: 650 },
];

const insightsSnap = () => ({
  ok: true, locale: "zh-CN",
  kpi: { sessions: 2, archivedSessions: 0, turns: 9, requests: 6, billedTokens: 4800, inputTokens: 4000, outputTokens: 800, cacheReadTokens: 2400,
    cacheHitRate: 60, costUsd: 0.5, fx: 7.1, toolCalls: 18, toolDurationMs: 3000, activeDurationMs: 20000, modelCalls: 6, tps: 61.5 },
  split: SPLIT,
  tokenSplit: [{ id: "cacheRead", tokens: 2400 }, { id: "cacheWrite", tokens: 0 }, { id: "bareInput", tokens: 1600 }, { id: "reasoning", tokens: 150 }, { id: "answers", tokens: 650 }],
  tokenBreakdown: TOKEN_BREAKDOWN, tokenBreakdownBasis: "ratio",
  timingBreakdown: { ttftMs: 6000, genMs: 13000, toolRunsMs: 3000, modelMs: 19000, avgTtftMs: 1500 },
  daily: Array.from({ length: 7 }, (_, i) => ({ date: "2026-11-" + String(21 + i), tokens: 600, costUsd: 0.07, requests: 1, sessions: 1,
    mainTokens: 400, subTokens: 200, mainCostUsd: 0.05, subCostUsd: 0.02, errors: i === 6 ? 2 : 0, rateLimited: i === 6 ? 1 : 0 })),
  heatmap: Array.from({ length: 56 }, (_, i) => ({ date: "2026-09-" + String((i % 28) + 1), tokens: 10, sessions: 1, avgTps: i % 3 ? 90 : 0 })),
  topSkills: [], topTools: [], topPrograms: [],
  topModels: [
    { modelId: "GLM-5.4", providerId: "p1", requests: 5, tokens: 2400, avgTps: 70, costUsd: 0.4, bySource: { all: { tokens: 2400, requests: 5, tps: 70, costUsd: 0.4 }, main: { tokens: 1500, requests: 4, tps: 117.6, costUsd: 0.3 } } },
    { modelId: "glm-flash", providerId: "p2", requests: 1, tokens: 2400, avgTps: 100, costUsd: 0.1, bySource: { all: { tokens: 2400, requests: 1, tps: 100, costUsd: 0.1 }, sub: { tokens: 2400, requests: 1, tps: 100, costUsd: 0.1 } } },
  ],
  sessions: [{ id: "sess_1", title: "T", directory: "/tmp/proj", archived: false, createdAt: T0, endTime: T0 + 3600000, updatedAt: T0 + 3600000,
    turns: 2, steps: 5, requests: 5, tokens: 1570, costUsd: 0.01, tps: 117.6, lastContext: 1000, models: ["GLM-5.4"] }],
  errors: ERRORS, toolQuality: TOOLQ, compactions: [COMP],
  compactionHealth: { count: 1, willRetrigger: 1, avgReductionPct: 94.4, latest: COMP },
  capture: null,
});

const stats = () => ({
  ok: true,
  session: { id: "sess_1", title: "T", directory: "/tmp/proj" },
  kpi: { turns: 2, steps: 5, skillLoads: 0, answers: 2, contextEvents: { inject: 0, compact: 1, prune: 0 }, inputTokens: 1570, outputTokens: 310,
    cacheReadTokens: 1000, cacheCreationTokens: 100, billedTokens: 1880, cacheHitRate: 63.7, tps: 117.6, costUsd: 0.01, fx: 7.1, toolCalls: 3, toolErrors: 1 },
  inputOutput: { user: 3, read: 1, write: 0, search: 0 }, tools: [{ name: "Read", count: 1, errors: 0 }], commandPrograms: [],
  fleet: { self: {}, subagents: [] },
  tokenBreakdown: TOKEN_BREAKDOWN, tokenBreakdownBasis: "ratio",
  tokenSplit: [{ id: "cacheRead", tokens: 1000 }, { id: "cacheWrite", tokens: 100 }, { id: "bareInput", tokens: 470 }, { id: "reasoning", tokens: 50 }, { id: "answers", tokens: 260 }],
  timing: { modelDurationMs: 3600, toolDurationMs: 3170, totalDurationMs: 6770, avgTtftMs: 237, tps: 117.6, ttftMs: 950, genMs: 2650, toolRunsMs: 3170 },
  split: { all: bucket(5, 1570, 310, 2550), main: bucket(4, 1500, 300, 2550), aux: bucket(1, 70, 10, 100) },
  errors: ERRORS, toolQuality: TOOLQ, compactions: [COMP],
  turns: [{ n: 1, turnId: "turn_1", status: "completed", startedAt: T0, completedAt: T0 + 9000, durationMs: 9000, requests: 2, retries: 0, toolCalls: 1, toolErrors: 0,
            inputTokens: 1000, outputTokens: 200, reasoningTokens: 50, cacheReadTokens: 600, cancelled: false, contextExceeded: false, errorType: "" },
          { n: 2, turnId: "turn_2", status: "completed", startedAt: T0 + 16000, completedAt: T0 + 17000, durationMs: 1000, requests: 2, retries: 1, toolCalls: 1, toolErrors: 0,
            inputTokens: 500, outputTokens: 100, reasoningTokens: 0, cacheReadTokens: 400, cancelled: false, contextExceeded: false, errorType: "" }],
  capture: { enabled: false },
  models: [{ model: "deepseek-chat", provider: "deepseek", tokens: 1570, requests: 4, avgTps: 117.6, costUsd: 0.01, bySource: { all: {}, main: {} } }],
});

const CURSOR = { s: 4, t: T0 + 5000, id: "m4" };
const msg = (id, seq, role, extra, parts) => ({ id, sequence: seq, role, modelId: role === "assistant" ? "deepseek-chat" : "", time: T0 + seq * 1000,
  tps: 0, durationMs: 0, ttftMs: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, ...extra, parts });
const PAGE0 = { ok: true, sessionId: "sess_1", order: "desc", turnId: "", totalMessages: 5, hasMore: true, offset: 0, limit: 80, cursor: CURSOR,
  messages: [msg("m5", 5, "user", {}, [{ type: "compaction", time: T0, compaction: COMP }]),
             msg("m4", 4, "assistant", {}, [{ type: "reasoning", text: "think", estTokens: 2 }])],
  fileActivity: [], commands: [], events: [{ kind: "context_compaction", status: "done", time: T0, compaction: COMP }], capturedRequests: [] };
const PAGE1 = { ok: true, sessionId: "sess_1", order: "desc", turnId: "", totalMessages: 3, hasMore: false, offset: 0, limit: 80, cursor: { s: 2, t: T0 + 2000, id: "m2" },
  messages: [msg("m3", 3, "user", {}, [{ type: "text", text: "third" }]),
             msg("m2", 2, "assistant", { inputTokens: 1000, cacheReadTokens: 600, outputTokens: 200 }, [{ type: "tool", toolName: "Bash", status: "completed", cat: "command", input: "{}", output: "ok", estTokens: 3 }])],
  fileActivity: [], commands: [], events: [], capturedRequests: [] };
const TURN_PAGE = { ok: true, sessionId: "sess_1", order: "asc", turnId: "turn_1", totalMessages: 2, hasMore: false, offset: 0, limit: 300, cursor: null,
  messages: [msg("m1", 1, "user", {}, [{ type: "text", text: "first" }]),
             msg("m2", 2, "assistant", { inputTokens: 1000, cacheReadTokens: 600, outputTokens: 200 }, [{ type: "reasoning", text: "plan", estTokens: 4 }])],
  fileActivity: [], commands: [], events: [], capturedRequests: [] };

const contextTools = () => {
  let captureOn = false;
  return {
    context_snapshot: () => ({ status: "ready", sessionId: "sess_1", isDraft: false, locale: "zh-CN", composition: null, contextPaths: null,
      capture: { enabled: captureOn }, stats: stats() }),
    context_browser: (input) => (input.turnId ? TURN_PAGE : input.before ? PAGE1 : PAGE0),
    context_capture_set: (input) => { captureOn = Boolean(input.enabled); return { ok: true, enabled: captureOn }; },
  };
};

/* ---------- 洞察页 ---------- */
test("insights: measured donuts replace ratio-derived segments; estimated 8-category is collapsed and labelled", async () => {
  const v = loadView("extension-view-insights.js", { insights_snapshot: insightsSnap });
  await v.flush();
  const html = v.html();
  assert.ok(html.includes("Token 统计（实测）") && html.includes("耗时统计（实测）"));
  for (const label of ["缓存读取", "缓存写入", "未命中输入", "首字等待", "模型生成", "工具执行"]) assert.ok(html.includes(label), "实测图例：" + label);
  for (const gone of ["其他开销", "Overhead", "模型等待 TTFT"]) assert.ok(!html.includes(gone), "按比例推算的分段不得出现：" + gone);
  assert.ok(/<details class="est-box"><summary>8 分类构成（估算）/.test(html), "估算八分类存在");
  assert.ok(!/<details class="est-box" open/.test(html), "估算八分类默认折叠");
  assert.ok(html.includes("用量库不存各类别的 token，以下均为估算值"));
  assert.ok(html.includes("≈1,200") || html.includes("≈1200") || html.includes("≈"), "估算值带 ≈ 标记");
});

test("insights: main/sub switch drives KPI row, daily chart, token split and model table", async () => {
  const v = loadView("extension-view-insights.js", { insights_snapshot: insightsSnap });
  await v.flush();
  let html = v.html();
  assert.ok(html.includes("4800"), "全部请求：合计 token");
  assert.ok(html.includes("glm-flash") && html.includes("GLM-5.4"), "全部请求：两个模型都在表里");
  assert.ok(html.includes("已归档"), "全部请求的会话副标是归档数");
  assert.ok(html.includes("失败尝试"), "日图带每日失败条");
  assert.equal(typeof v.pills[1].onclick, "function", "切换胶囊已绑定");
  v.pills[1].onclick();
  html = v.html();
  assert.ok(html.includes("1800"), "主会话：1500+300");
  assert.ok(html.includes("117.6 tok/s"), "主会话：用主会话桶的均速");
  assert.ok(html.includes("该来源的会话数"));
  assert.ok(html.includes("GLM-5.4") && !html.includes("glm-flash"), "主会话：没有主会话请求的模型不进表");
  v.pills[2].onclick();
  html = v.html();
  assert.ok(html.includes("glm-flash") && !html.includes("GLM-5.4"));
  assert.ok(html.includes("2800"), "子会话：2400+400");
});

test("insights: quality cards render errors, compaction health and tool quality", async () => {
  let opened = null;
  const v = loadView("extension-view-insights.js", { insights_snapshot: insightsSnap, insights_open_session: (i) => { opened = i; return { ok: true }; } });
  await v.flush();
  const html = v.html();
  for (const label of ["错误与重试", "限流", "已取消", "压缩健康度", "94.4%", "下轮再压缩", "工具质量", "非零退出", "只读占比", "P50 / P95"]) {
    assert.ok(html.includes(label), "质量卡片：" + label);
  }
  assert.ok(html.includes("2 / 5"), "失败尝试 / 请求数");
  assert.ok(html.includes("err-strip"), "每日失败趋势条");
  assert.equal(v.calls.filter((c) => c.name === "insights_snapshot").length, 1);
  assert.equal(opened, null, "加载时不触发跳转");
});

/* ---------- Context 标签页 ---------- */
test("context stats tab: measured donuts, compaction log, quality and turn table", async () => {
  const v = loadView("extension-view-context.js", contextTools());
  await v.flush();
  const html = v.html();
  for (const label of ["Token Stats（实测）", "Timing Stats（实测）", "首字等待", "模型生成", "压缩记录", "下轮再压缩", "错误与重试", "工具质量", "逐轮", "点击一行看该轮消息"]) {
    assert.ok(html.includes(label), "Stats 分段：" + label);
  }
  assert.ok(/<span>Context Stats<\/span><\/div>/.test(html), "Context Stats 卡片头右侧不再显示会话标题（用户 11-27 要求删除）");
  for (const gone of ["Overhead", "其他</span>", "No compactions in this session"]) assert.ok(!html.includes(gone), "不得出现：" + gone);
  assert.ok(/<details class="est-box"><summary>8 分类构成（估算）/.test(html), "估算八分类存在且折叠");
  assert.ok(html.includes("data-turn=\"turn_1\"") && html.includes("data-turn=\"turn_2\""));
  assert.ok(html.indexOf("data-turn=\"turn_2\"") < html.indexOf("data-turn=\"turn_1\""), "逐轮表最新在上");
  assert.equal(v.calls.length, 1);
  assert.equal(v.calls[0].name, "context_snapshot");
});

test("context browser: newest first, cursor paging appends older pages, filters extended", async () => {
  const v = loadView("extension-view-context.js", contextTools());
  await v.flush();
  v.tabs[1].handlers.click();
  await v.flush();
  let html = v.html();
  const call = v.calls.find((c) => c.name === "context_browser");
  assert.deepEqual(v.plain(call.input), { limit: 80, offset: 0 });
  assert.ok(html.indexOf("#5") < html.indexOf("#4"), "最新在前");
  for (const chip of ["全部", "Thinking", "Tools", "Answer", "用户", "文件", "命令", "事件"]) assert.ok(html.includes(">" + chip + "</button>"), "筛选片：" + chip);
  assert.ok(html.includes("加载更早的消息") && html.includes("id=\"bMore\""));
  assert.ok(html.includes("启用抓包") && html.includes("请求抓包未启用"), "抓包关闭时给出开关与说明");
  assert.ok(html.includes("(≈2 tok)"), "字符估算带 ≈");
  assert.ok(html.includes("90.00万") && html.includes("5.00万"), "压缩 part 在消息流里可见（压缩前 → 压缩后）");
  assert.ok(!html.includes("回到最新"), "还没翻页时不出现回到最新");

  v.get("bMore").onclick();
  await v.flush();
  const more = v.calls.filter((c) => c.name === "context_browser").pop();
  assert.deepEqual(v.plain(more.input), { limit: 80, offset: 0, before: CURSOR }, "带上一页最老一条的游标");
  html = v.html();
  assert.ok(html.indexOf("#5") < html.indexOf("#4") && html.indexOf("#4") < html.indexOf("#3") && html.indexOf("#3") < html.indexOf("#2"), "更老的一页接在后面");
  assert.ok(html.includes("in 1000") && html.includes("(cache 60.0%)") && html.includes("out 200"), "消息头显示实测 token");
  assert.ok(html.includes("回到最新") && !html.includes("id=\"bMore\""), "翻到底后不再有加载更多");
  v.get("bLatest").onclick();
  assert.ok(!v.html().includes("回到最新"), "回到最新清掉更老页");
});

test("context browser: turn mode opens that turn oldest-first and can exit", async () => {
  const v = loadView("extension-view-context.js", contextTools());
  await v.flush();
  const row = mkEl("row");
  row.getAttribute = (n) => (n === "data-turn" ? "turn_1" : null);   // 同一个节点反复返回：绑定后才能取到 onclick
  v.hooks["[data-turn]"] = () => [row];
  v.tabs[0].handlers.click();
  assert.equal(typeof row.onclick, "function", "逐轮行已绑定点击");
  row.onclick();
  await v.flush();
  const call = v.calls.filter((c) => c.name === "context_browser").pop();
  assert.deepEqual(v.plain(call.input), { limit: 300, offset: 0, turnId: "turn_1" });
  const html = v.html();
  assert.ok(html.includes("逐轮消息") && html.includes("退出逐轮"));
  assert.ok(html.indexOf("#1") < html.indexOf("#2"), "逐轮模式时间正序");
  v.get("bExitTurn").onclick();
  await v.flush();
  assert.deepEqual(v.plain(v.calls.filter((c) => c.name === "context_browser").pop().input), { limit: 80, offset: 0 }, "退出逐轮回到最新");
});

test("context events tab lists compaction with before/after tokens; capture toggle calls the tool and refreshes", async () => {
  const v = loadView("extension-view-context.js", contextTools());
  await v.flush();
  v.tabs[1].handlers.click();
  await v.flush();
  v.get("bCapture").onclick();
  await v.flush();
  const set = v.calls.find((c) => c.name === "context_capture_set");
  assert.deepEqual(v.plain(set.input), { enabled: true }, "关闭状态下点击=开启");
  assert.ok(v.calls.filter((c) => c.name === "context_snapshot").length >= 2, "切换后重新取快照");
  const html = v.html();
  assert.ok(html.includes("关闭抓包"), "开关状态随快照更新");
  assert.ok(html.includes("抓包已开启，还没有本会话的记录"));
  v.tabs[2].handlers.click();
  const ev = v.html();
  assert.ok(ev.includes("context_compaction") && ev.includes("90.00万 → 5.00万"), "事件页显示压缩前后 token");
});

test("context browser: an extension process still on the old version degrades to a hint instead of wrong data", async () => {
  // 旧版 extension.mjs：不认 turnId / before（永远回首页），也没有 context_capture_set
  let noted = "";
  const v = loadView("extension-view-context.js", {
    context_snapshot: () => ({ status: "ready", sessionId: "sess_1", isDraft: false, locale: "zh-CN", composition: null, contextPaths: null, capture: { enabled: false }, stats: stats() }),
    context_browser: () => PAGE0,
  }, { onToast: (m) => { noted = m; } });
  await v.flush();
  v.tabs[1].handlers.click();
  await v.flush();
  v.get("bMore").onclick();
  await v.flush();
  const html = v.html();
  assert.ok(html.includes("翻页暂不可用") && html.includes("重启 ZCode 后生效"), "翻页给出提示");
  assert.equal(html.split("#5").length - 1, 1, "同一页不重复追加");
  assert.ok(!html.includes("id=\"bMore\""), "不再提供加载更多");
  const row = mkEl("row");
  row.getAttribute = (n) => (n === "data-turn" ? "turn_1" : null);
  v.hooks["[data-turn]"] = () => [row];
  v.get("bExitTurn").onclick();
  await v.flush();
  v.tabs[0].handlers.click();
  v.get("content").querySelectorAll("[data-turn]")[0].onclick();
  await v.flush();
  const stale = v.html();
  assert.ok(stale.includes("逐轮视图暂不可用") && !stale.includes("#5"), "逐轮模式不拿普通页冒充");
  v.get("bExitTurn").onclick();
  await v.flush();
  v.get("bCapture").onclick();
  await v.flush();
  assert.ok(noted.includes("抓包开关暂不可用"), "开关缺失时给出提示，不静默");
  assert.ok(!v.html().includes("抓包已开启"), "状态没有被误标成已开启");
});

test("insights: a source bucket with no requests in the window shows explicit zeros, not global numbers", async () => {
  // 审查第 1 轮 MINOR：切到「子代理」而窗口内没有子代理请求时，此前回退显示全局数字
  const snap = insightsSnap();
  snap.split = { all: SPLIT.all, main: SPLIT.main };
  const v = loadView("extension-view-insights.js", { insights_snapshot: () => snap });
  await v.flush();
  assert.ok(v.html().includes("4800"), "前置：全部请求显示合计");
  v.pills[2].onclick();
  const html = v.html();
  assert.ok(!html.includes("4800"), "子代理档不显示全局 token");
  assert.ok(!html.includes("6,923") && !html.includes("61.5 tok/s"), "子代理档不显示全局均速");
  assert.ok(html.includes("0 次请求") && html.includes("该来源的会话数"), "显式的 0");
});

test("context browser: clicking a timeline bar or a snapshot refresh keeps scroll positions; switching tabs returns to top", async () => {
  // 用户 11-27 实机报告：点柱子后时间线横向滚动条回到起点。原因是整段 innerHTML 重建换了滚动容器节点。
  const steps = Array.from({ length: 40 }, (_, i) => ({ step: i + 1, inputTokens: 1000 + i * 100, outputTokens: 50, tps: 90, modelId: "m", durationMs: 1000, ttftMs: 100, cacheReadTokens: 0 }));
  const tools = contextTools();
  let sid = "sess_1";
  tools.context_snapshot = () => ({ status: "ready", sessionId: sid, isDraft: false, locale: "zh-CN", composition: null, contextPaths: null,
    capture: { enabled: false }, stats: Object.assign(stats(), { steps }) });
  const v = loadView("extension-view-context.js", tools);
  await v.flush();
  v.tabs[1].handlers.click();
  await v.flush();
  const content = v.get("content");
  assert.ok(content.querySelector(".timeline-wrap"), "前置：浏览器分段有时间线");
  const bar = mkEl("bar");
  bar.getAttribute = (n) => (n === "data-step" ? "37" : null);
  v.hooks["[data-step]"] = () => [bar];
  v.tabs[1].handlers.click();
  await v.flush();
  assert.equal(typeof bar.onclick, "function", "前置：柱子已绑定点击");
  content.querySelector(".timeline-wrap").scrollLeft = 480;   // 用户把时间线横向滚到靠后
  v.scroller.scrollTop = 260;                                  // 页面也往下滚了
  bar.onclick();
  assert.ok(v.html().includes("Step #37"), "选中详情出现");
  assert.equal(content.querySelector(".timeline-wrap").scrollLeft, 480, "点柱子后时间线横向滚动位置保留（选中的柱子还在视野里）");
  assert.equal(v.scroller.scrollTop, 260, "点柱子后页面纵向滚动位置保留");
  content.querySelector(".timeline-wrap").scrollLeft = 300;
  await v.fireResource();
  await v.flush();
  assert.equal(content.querySelector(".timeline-wrap").scrollLeft, 300, "快照刷新（流式期间会反复发生）不重置横向滚动");
  assert.equal(v.scroller.scrollTop, 260, "快照刷新不重置页面滚动");
  v.tabs[2].handlers.click();
  assert.equal(v.scroller.scrollTop, 0, "切换分段回到顶部");
  // 换了会话（焦点切到别的会话）：内容整体换成另一份，纵向滚动不能停在原来的像素位置
  v.tabs[1].handlers.click();
  v.scroller.scrollTop = 150;
  content.querySelector(".timeline-wrap").scrollLeft = 200;
  await v.fireResource();
  await v.flush();
  assert.equal(v.scroller.scrollTop, 150, "同一会话的刷新保留");
  sid = "sess_2";
  await v.fireResource();
  await v.flush();
  assert.equal(v.scroller.scrollTop, 0, "换会话后回到顶部");
  assert.equal(content.querySelector(".timeline-wrap").scrollLeft, 0, "换会话后时间线也回到起点（是另一份步骤）");
});
