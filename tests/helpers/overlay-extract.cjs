'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OVERLAY_PATH = path.join(ROOT, 'overlay.js');
const INJECT_PATH = path.join(ROOT, 'inject-main.cjs');
const SRC_DIR = path.join(ROOT, 'src', 'overlay');

const _sourceCache = new Map();

function readOverlaySource(relFile = 'overlay.js') {
  if (!_sourceCache.has(relFile)) {
    const fullPath = relFile === 'overlay.js' ? OVERLAY_PATH
      : relFile === 'inject-main.cjs' ? INJECT_PATH
      : path.join(ROOT, relFile);
    _sourceCache.set(relFile, fs.readFileSync(fullPath, 'utf8'));
  }
  return _sourceCache.get(relFile);
}

function readInjectSource() {
  return readOverlaySource('inject-main.cjs');
}

function readOverlayPart(partName) {
  return fs.readFileSync(path.join(SRC_DIR, partName), 'utf8');
}

/**
 * 按起止锚点提取源码片段（统一断言与错误信息，避免各测试手写脆弱的 indexOf 算术）。
 * @param {string} startAnchor 起始锚点子串（包含在返回结果内）
 * @param {string} endAnchor   结束锚点子串（默认不包含在返回结果内）
 * @param {object} [opts]
 * @param {string} [opts.file='overlay.js'] 目标文件相对根路径
 * @param {boolean} [opts.includeEnd=false] 是否把 endAnchor 一并包含进返回片段
 */
function sliceOverlay(startAnchor, endAnchor, opts = {}) {
  const file = opts.file || 'overlay.js';
  const src = readOverlaySource(file);
  const a = src.indexOf(startAnchor);
  assert.ok(a >= 0, `未找到起始锚点 (${file}): ${startAnchor}`);
  const b = src.indexOf(endAnchor, a + startAnchor.length);
  assert.ok(b > a, `未找到结束锚点 (${file}): ${endAnchor} (after ${startAnchor})`);
  return src.slice(a, opts.includeEnd ? b + endAnchor.length : b);
}

function sliceInject(startAnchor, endAnchor, opts = {}) {
  return sliceOverlay(startAnchor, endAnchor, { ...opts, file: 'inject-main.cjs' });
}

/**
 * 按具名逻辑区段提取 overlay.js 源码片段，集中维护常用测试切片边界。
 */
const NAMED_SLICES = {
  visCache: ['    function isOwnOverlay(el) {', '    function findComposer() {'],
  coverCache: ['    function coverOK(el) {', '    /* 隐藏态诊断'],
  tpsBands: ['  function zuHasMeaningfulOutput', '  /* 思考态动效图标'],
  inSettingsView: ['  function inSettingsView(el) {', '  function coordinator() {'],
  coordinatorBlock: ['  function inSettingsView(el) {', '  /* ---------- 实例工厂（v61.1）'],
  findComposer: ['    function findComposer() {', '    function collectDiag(extra) {'],
  deepFind: ['    function deepFind() {', '    /* 输入框是否真的露在屏幕上'],
  anchorCard: ['    /* 从 textarea 向上找视觉卡片容器', '    /* 读原生 UI 的上下文总量'],
  ctxBandOf: ['    var CTX_BANDS', '    function html(d) {'],
  updateLive: ['    function updateLive() {', '    /* v90：心跳'],
  autoCompactHelpers: ['    /* ---------- v179 自动压缩阈值（⚙ 面板渲染与提交的单一出口） ---------- */', '    function srcStatusText(sv) {'],
  autoCompactInfoText: ['    /* v179 阈值行文案', '    function syncCompactBtn() {'],
  paneScopeHelpers: ['  function collectSidWs()', '  /* ---------- 回复末尾速率行'],
  fiberSideIdHelpers: ['  function fiberSideIdOf(', '  function detSeenKey'],
  sidePaneKeyOf: ['    function sidePaneKeyOf(el) {', '    var SEL = '],
  sessionForBlock: ['  function sessionFor(', '  window.__zusagePluginRequests'],
  remoteViewBlock: ['      var myTarget = p.remote_target || "";', '      lastSub = view.sub;'],
  hitItemFor: ['function hitItemFor', '/* 事件挂 document 捕获阶段'],
  tipLeaveAt: ['    function tipLeaveAt(x, y) {', '    listenGlobal(document.documentElement, "mouseleave"'],
  tipOutsideDown: ['    function tipOutsideDown(e) {', '    listenGlobal(document, "mousedown", tipOutsideDown'],
  tipGlobalEsc: ['    function tipGlobalEsc(e) {', '    listenGlobal(document, "keydown", tipGlobalEsc'],
  hideTipFn: ['    function hideTip(force, cause) {', '    function positionTip(el, keepTop) {'],
  zuBarSpeedView: ['  var DEFAULT_CHARS_PER_TOKEN = 2;', '  /* 思考态动效图标'],
  positionSubPop: ['    function positionSubPop() {', '    var subRateTimer = 0;'],
  buildSubPop: ['    function subPopItems(sub) {', '    function positionSubPop() {'],
  tpsBandsTable: ['  var TPS_BANDS = [', '  /* 返回 null = 调用方应把这当成'],
  tpsBandOnly: ['  var TPS_BANDS = [', '  /* tooltip 档位行文本'],
  buildLiveTip: ['    function buildLiveTip(speedView) {', '    /* 行内 SVG 线性图标（v54）'],
  statusRotator: ['  /* ==================== Status Rotator & Whale Tail (v268 移植；后按用户规格收敛) ====================', '  /* 设置页（MCP 配置等）内的编辑框不是聊天输入框'],
  subAgentRows: ['    var SUBROW_TID_PREFIX = "v4-subagent-open-side-pane-";', '    function subRateTick('],
  wfRunCards: ['    var WF_CARD_TID = "workflow-card";', '    /* 每次主桥数据到达时 reconcile'],
  subStatItems: ['    /* 心跳读快照（issue #309', '    /* 每次主桥数据到达时 reconcile'],
  /* v350 状态栏排序/优先级共享助手（00 分片）：html() 尾部 zuBarSortItems 的定义区。
   * tip-layout/tooltip-span/speed-chart 家族只切 07 分片进 VM，html() 新引用模块级助手
   * 时必须把这个切片前置拼进 helpers（zuBarSortItems is not defined 断链，62 例回归根因）。 */
  barOrderHelpers: ['  var ZU_BAR_KEYS =', '  var state = {'],
  /* 速度格稳定占位（specs/speed-chip-stable-slot.md）：展示协调器（08，updateLive 尾部到 liveTipBuiltAt
   * 声明之前的全部实例级状态）与折叠段的折叠/回展循环（12，候选计算到 speedMinOn 回写）。
   * 行为测试见 overlay-speed-slot.test.cjs（协调器时间戳显式注入；折叠循环用可控 scrollWidth 桩）。 */
  speedDisp: ['    /* ---------- 展示协调器（specs/speed-chip-stable-slot.md）', '    var liveTipBuiltAt = -Infinity'],
  speedFoldLoop: ['      var candidates = zuBarFoldOrder(rows.map(', '      syncSeparators();\n      var hidden = rows.filter('],
  /* 精简主题速率 chip 的面/档位色/全称取值段（11 分片 syncTpsChip） */
  tpsChipFace: ['      var fv = v.kind === "live" ? (v.face || v.sv) : { kind: "real", db: true, speedValue: v.dbTps > 0 ? v.dbTps : null };', '      var prevT = chip.__zuT;'],
  /* 折叠判据的内容宽：可见子项 rect 宽度和 + gap（scrollWidth 以 clientWidth 为下限，量不出富余） */
  speedContentWidth: ['    function zuBarContentWidth() {', '    function syncBarOverflow() {'],
  /* 折叠重算开头：清空上一轮折叠集与速度格极窄档（每轮从头重算） */
  speedFoldReset: ['      rows.forEach(function (el) { el.dataset.zuFolded = "0"; delete el.dataset.zuEndlead; });', '      function syncSeparators() {'],
  /* 药丸速度格档位升降（12 分片，条宽触顶降档、富余够升档） */
  speedPillTier: ['    var pillSpeedTier = 0, pillSpeedEmAt = 0, pillSpeedEm = 14;', '    function barMorePosition() {'],
  /* 精简速率 chip 的布局档位（11 分片）：纯函数 zuTsbTierNext + 测量/写类名 zuTsbTierSync */
  tsbTier: ['    var ZU_TSB_TIERS = [', '    function syncTpsChip() {'],
};

/**
 * 按具名逻辑区段提取 inject-main.cjs 源码片段。
 */
const INJECT_SLICES = {
  pollPluginRequests: ['async function pollPluginRequests() {', 'setInterval(pollPluginRequests, 1000);'],
  pushPluginState: ['function pushPluginState(wc, state) {', '/* ack 必须先于更新器初始化'],
  deliverPluginRequest: ['function deliverPluginRequest(wc, requestId, result) {', 'async function setAnswerRateLine('],
  /* v458 子代理统计行：主桥逐问富文本查询段（--current 门与 sess_subagent_ 前缀分支） */
  turnTextQuery: ['function queryTurnText(sid, wc, plainUnits, forceKmb, unitEpoch, noCost, turnRef) {', '/* ---------- Git 状态旁路查询（v96）'],
  cdpSwitchBlock: ['/* CDP 调试口', 'catch (e) { LOG("cdp remote-debugging-port switch failed:", e.message); }', { includeEnd: true }],
  pendingZipBlock: ['/* ---------- v339 pending 更新包清理自愈', '/* ---------- v202 更新日志'],
  handleReleaseNotesRequest: ['async function handleReleaseNotesRequest(req, wc) {', '\n/* 逐问速率行开关'],
  sysmonBlock: ['function pushSysmonTo(wc, frame) {', '\n/* ---------- v202 更新日志'],
};

function getNamedSlice(name, opts = {}) {
  const pair = NAMED_SLICES[name];
  assert.ok(pair, `未知 overlay 具名切片: ${name}`);
  return sliceOverlay(pair[0], pair[1], { ...(pair[2] || {}), ...opts });
}

function getInjectSlice(name, opts = {}) {
  const pair = INJECT_SLICES[name];
  assert.ok(pair, `未知 inject-main 具名切片: ${name}`);
  return sliceInject(pair[0], pair[1], { ...(pair[2] || {}), ...opts });
}

module.exports = {
  ROOT,
  OVERLAY_PATH,
  INJECT_PATH,
  SRC_DIR,
  NAMED_SLICES,
  INJECT_SLICES,
  readOverlaySource,
  readInjectSource,
  readOverlayPart,
  sliceOverlay,
  sliceInject,
  getNamedSlice,
  getInjectSlice,
};
