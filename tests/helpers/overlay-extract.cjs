'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OVERLAY_PATH = path.join(ROOT, 'overlay.js');
const SRC_DIR = path.join(ROOT, 'src', 'overlay');

let _cachedOverlay = null;

function readOverlaySource(relFile = 'overlay.js') {
  if (relFile === 'overlay.js') {
    if (_cachedOverlay === null) {
      _cachedOverlay = fs.readFileSync(OVERLAY_PATH, 'utf8');
    }
    return _cachedOverlay;
  }
  return fs.readFileSync(path.join(ROOT, relFile), 'utf8');
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

/**
 * 按具名逻辑区段提取源码片段，集中维护常用测试切片边界。
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
};

function getNamedSlice(name, opts = {}) {
  const pair = NAMED_SLICES[name];
  assert.ok(pair, `未知具名切片: ${name}`);
  return sliceOverlay(pair[0], pair[1], opts);
}

module.exports = {
  ROOT,
  OVERLAY_PATH,
  SRC_DIR,
  NAMED_SLICES,
  readOverlaySource,
  readOverlayPart,
  sliceOverlay,
  getNamedSlice,
};
