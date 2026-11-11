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
  zuBarSpeedView: ['  var DEFAULT_CHARS_PER_TOKEN = 2;', '  /* 思考态动效图标'],
  positionSubPop: ['    function positionSubPop() {', '    var subRateTimer = 0;'],
  buildSubPop: ['    function subPopItems(sub) {', '    function positionSubPop() {'],
  tpsBandsTable: ['  var TPS_BANDS = [', '  /* 返回 null = 调用方应把这当成'],
  tpsBandOnly: ['  var TPS_BANDS = [', '  /* tooltip 档位行文本'],
  buildLiveTip: ['    function buildLiveTip(speedView) {', '    /* 行内 SVG 线性图标（v54）'],
  statusRotator: ['  /* ==================== Status Rotator & Whale Tail (v268 移植；后按用户规格收敛) ====================', '  /* 设置页（MCP 配置等）内的编辑框不是聊天输入框'],
  subAgentRows: ['    var SUBROW_TID_PREFIX = "v4-subagent-open-side-pane-";', '    function subRateTick('],
  wfRunCards: ['    var WF_CARD_TID = "workflow-card";', '    /* 每次主桥数据到达时 reconcile'],
  subStatItems: ['    function subRunningList(stats) {', '    /* 每次主桥数据到达时 reconcile'],
};

/**
 * 按具名逻辑区段提取 inject-main.cjs 源码片段。
 */
const INJECT_SLICES = {
  pollPluginRequests: ['async function pollPluginRequests() {', 'setInterval(pollPluginRequests, 1000);'],
  pushPluginState: ['function pushPluginState(wc, state) {', '/* ack 必须先于更新器初始化'],
  deliverPluginRequest: ['function deliverPluginRequest(wc, requestId, result) {', 'async function setAnswerRateLine('],
  cdpSwitchBlock: ['/* CDP 调试口', 'catch (e) { LOG("cdp remote-debugging-port switch failed:", e.message); }', { includeEnd: true }],
  pendingZipBlock: ['/* ---------- v339 pending 更新包清理自愈', '/* ---------- v202 更新日志'],
  handleReleaseNotesRequest: ['async function handleReleaseNotesRequest(req, wc) {', '\n/* 逐问速率行开关'],
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
