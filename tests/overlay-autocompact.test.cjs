"use strict";
// v179 自动压缩阈值 ⚙ 面板回归：模式/数值推导（acModeOf）、状态行与低阈值警告
// （syncAutoCompactInputs/acWarningText）、hover 阈值行文案（acInfoText）、
// 以及面板控件与主进程动作的源码契约。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "overlay.js"), "utf8");
function extract(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, "切片锚点失配：" + start);
  return source.slice(a, b);
}
/* 面板助手块（acModeOf/syncAutoCompactInputs/acTargetTokens/acWarningText/sendAutoCompactConfig）
 * 与 hover 阈值行（acInfoText）在实例闭包里同层，切片拼进同一沙箱即可互调 */
const helpers = extract("    /* ---------- v179 自动压缩阈值（⚙ 面板渲染与提交的单一出口） ---------- */", "    function srcStatusText(sv) {");
const infoText = extract("    /* v179 阈值行文案", "    function syncCompactBtn() {");

function makePanel() {
  const fields = new Map();
  const node = (key) => {
    if (!fields.has(key)) {
      fields.set(key, { value: "", textContent: "", classes: new Set(), classList: { toggle: (k, on) => { if (on) fields.get(key).classes.add(k); else fields.get(key).classes.delete(k); } } });
    }
    return fields.get(key);
  };
  /* querySelector 自动建节点：面板切片按类名取控件，缺失键也返回可写桩 */
  return { fields, node, panel: { querySelector: (sel) => node(sel) } };
}

function runHelpers({ state, lastBand } = {}) {
  const { fields, node, panel } = makePanel();
  const sandbox = {
    panel, state: state || { enginePatch: null }, lastBand: lastBand || null,
    L: (zh, en) => zh, document: { activeElement: null },
  };
  vm.runInNewContext(helpers, sandbox);
  return { sandbox, fields, node };
}

test("acModeOf 从阈值配置反推模式与数值（含损坏形状回退默认）", () => {
  const { sandbox } = runHelpers();
  const m = (cfg) => { const r = sandbox.acModeOf(cfg); return r.mode + "|" + r.value; };   // 跨 realm 对象比字段不比引用
  assert.equal(m(null), "default|");
  assert.equal(m([]), "default|");
  assert.equal(m({ enabled: false }), "disabled|");
  assert.equal(m({ enabled: true, thresholdPercent: 70 }), "percent|70");
  assert.equal(m({ enabled: true, thresholdTokens: 120000 }), "tokens|120000");
  assert.equal(m({ enabled: true, bufferTokens: 5000 }), "buffer|5000");
  assert.equal(m({ enabled: true }), "default|");
});

test("状态行覆盖补丁全生命周期文案", () => {
  const applied = runHelpers({ state: { enginePatch: { enabled: true, state: "applied", build: "3.17.1", config: { enabled: true, thresholdPercent: 70 } } } });
  applied.sandbox.syncAutoCompactInputs();
  assert.match(applied.node(".zu-ac-status").textContent, /已注入/);
  assert.match(applied.node(".zu-ac-status").textContent, /3\.17\.1/);
  const off = runHelpers({ state: { enginePatch: { enabled: false, state: "off" } } });
  off.sandbox.syncAutoCompactInputs();
  assert.match(off.node(".zu-ac-status").textContent, /开关关闭/);
  const none = runHelpers({});
  none.sandbox.syncAutoCompactInputs();
  assert.match(none.node(".zu-ac-status").textContent, /未加载/);
  const bad = runHelpers({ state: { enginePatch: { enabled: true, state: "unsupported_build", lastError: "engine sha abc not in ENGINE_TARGETS" } } });
  bad.sandbox.syncAutoCompactInputs();
  assert.match(bad.node(".zu-ac-status").textContent, /支持名单/);
  assert.match(bad.node(".zu-ac-status").textContent, /engine sha abc/);
});

test("输入控件随主进程真值回写（焦点中不回写）", () => {
  const focused = runHelpers({ state: { enginePatch: { enabled: true, state: "applied", config: { enabled: true, thresholdPercent: 70 } } } });
  focused.node(".zu-ac-mode").value = "default";
  focused.sandbox.document.activeElement = focused.node(".zu-ac-mode");
  focused.sandbox.syncAutoCompactInputs();
  assert.equal(focused.node(".zu-ac-mode").value, "default", "选择中的控件不被覆盖");
  const idle = runHelpers({ state: { enginePatch: { enabled: true, state: "applied", config: { enabled: true, thresholdTokens: 120000 } } } });
  idle.sandbox.syncAutoCompactInputs();
  assert.equal(idle.node(".zu-ac-mode").value, "tokens");
  assert.equal(idle.node(".zu-ac-value").value, "120000");
});

test("低阈值警告：目标低于当前用量才触发（200K 窗、85% 现值 vs 70% 目标）", () => {
  const warn = runHelpers({
    state: { enginePatch: { enabled: true, state: "applied", config: { enabled: true, thresholdPercent: 70 } } },
    lastBand: { cw: 200000, pct: 85 },
  });
  warn.sandbox.syncAutoCompactInputs();
  assert.match(warn.node(".zu-ac-status").textContent, /目标阈值低于当前用量/);
  assert.equal(warn.node(".zu-ac-status").classes.has("zu-ac-warn"), true);
  const calm = runHelpers({
    state: { enginePatch: { enabled: true, state: "applied", config: { enabled: true, thresholdPercent: 70 } } },
    lastBand: { cw: 200000, pct: 50 },
  });
  calm.sandbox.syncAutoCompactInputs();
  assert.doesNotMatch(calm.node(".zu-ac-status").textContent, /目标阈值低于当前用量/);
  assert.equal(calm.node(".zu-ac-status").classes.has("zu-ac-warn"), false);
  // 默认/禁用模式与缺窗口数据不误报
  const plain = runHelpers({
    state: { enginePatch: { enabled: true, state: "applied", config: { enabled: true } } },
    lastBand: { cw: 200000, pct: 95 },
  });
  plain.sandbox.syncAutoCompactInputs();
  assert.doesNotMatch(plain.node(".zu-ac-status").textContent, /目标阈值低于当前用量/);
});

test("acTargetTokens：三种模式换算与近似基准（21K 预留）", () => {
  const { sandbox } = runHelpers();
  const r = (mc, cw) => Math.round(sandbox.acTargetTokens(mc, cw));   // 浮点噪声：生产消费端各自 floor/round
  assert.equal(r({ mode: "percent", value: "70" }, 200000), 125300);
  assert.equal(r({ mode: "tokens", value: "120000" }, 200000), 120000);
  assert.equal(r({ mode: "buffer", value: "5000" }, 200000), 200000 - 21000 - 5000);
  assert.equal(sandbox.acTargetTokens({ mode: "default", value: "" }, 200000), null);
  assert.equal(sandbox.acTargetTokens({ mode: "disabled", value: "" }, 200000), null);
});

function runInfoText({ state, label } = {}) {
  const sandbox = {
    state: state || { enginePatch: null },
    L: (zh, en) => zh,
    ZU_CTX_TRIGGER: '[data-testid="chat-context-usage-trigger"]',
    nearestByRect: () => (label == null ? null : { getAttribute: () => label }),
  };
  /* acInfoText 依赖 acModeOf/acTargetTokens（同实例闭包）：helpers 块一并入沙箱 */
  vm.runInNewContext(helpers + "\n" + infoText + "\nacInfoText", sandbox);
  return sandbox.acInfoText;
}

test("acInfoText：补丁未生效返回空串（不渲染）", () => {
  assert.equal(runInfoText()({}), "");
  assert.equal(runInfoText({ state: { enginePatch: { enabled: false, state: "off" } } })({}), "");
  assert.equal(runInfoText({ state: { enginePatch: { enabled: true, state: "unsupported_build" } } })({}), "");
});

test("acInfoText：默认/禁用/百分比模式文案（aria 总量 → 标称窗口口径）", () => {
  const f = (ep) => runInfoText({ state: { enginePatch: ep }, label: "上下文已用 63,400 / 总量 200,000" });
  assert.match(f({ enabled: true, state: "applied" })({}), /跟随引擎默认/);
  assert.match(f({ enabled: true, state: "applied", config: { enabled: false } })({}), /已禁用/);
  const pct = f({ enabled: true, state: "applied", config: { enabled: true, thresholdPercent: 70 } })({});
  assert.match(pct, /~63%/);
  assert.match(pct, /125,300 token/);
});

test("acInfoText：解析不到总量时 tokens 模式给绝对值，percent/buffer 不硬算", () => {
  const f = (ep) => runInfoText({ state: { enginePatch: ep }, label: null });
  assert.match(f({ enabled: true, state: "applied", config: { enabled: true, thresholdTokens: 125300 } })({}), /自动压缩阈值 125,300 token/);
  assert.doesNotMatch(f({ enabled: true, state: "applied", config: { enabled: true, thresholdTokens: 125300 } })({}), /%/);
  assert.match(f({ enabled: true, state: "applied", config: { enabled: true, thresholdPercent: 70 } })({}), /自定义阈值/);   // 无窗口不硬算百分比
});

test("源码契约：设置控件、动作路由与状态种子齐备", () => {
  for (const needle of ["zu-ac-enable", 'class="zu-ac-mode"', "zu-ac-value", "zu-ac-status",
    'pluginRequest("autocompact-patch"', "autocompact-config", "sendAutoCompactConfig"]) {
    assert.ok(source.includes(needle), "overlay.js 缺少 " + needle);
  }
  assert.match(source, /enginePatch: \(window\.__zusagePluginState && window\.__zusagePluginState\.enginePatch\) \|\| null/);   // 状态种子
  assert.match(source, /if \(s && s\.enginePatch && typeof s\.enginePatch === "object"\) state\.enginePatch = s\.enginePatch/);   // v172 纪律：__zusagePluginUpdate 拷贝行
  assert.match(source, /syncAutoCompactInputs\(\);\s*$/m);   // syncPanel 对账
});
