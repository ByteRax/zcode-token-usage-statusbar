const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readOverlaySource, getNamedSlice } = require('./helpers/overlay-extract.cjs');

// v333 智能体后台运行的状态同步（specs/agent-background-support.md）：
// ① subRunningList——rows 行 ∪ 桥快照 backgroundWorks（kind='subagent' status='running'）
//   补给：后台智能体把启动行滚出父会话 60 行窗口后，槽位估算与「子代理运行中 ×N」不丢失；
// ② renderRunningSubagentItems——宿主状态面板 Agents 行（v4-running-subagent-item +
//   data-child-session-id）注入 .zu-substat 速率 chip，两态/幂等/开关清理。
// DOM 桩沿用 overlay-wfrun 模式。

const NOW = 1730000000000;
const BG_SID = 'sess_subagent_agent_bg1';

class El {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.children = []; this._cls = ''; this.classes = new Set();
    this.attrs = {}; this.textContent = ''; this.innerHTML = '';
    this.parentElement = null; this.isConnected = true;
  }
  get className() { return this._cls; }
  set className(v) { this._cls = String(v); this.classes = new Set(this._cls.split(/\s+/).filter(Boolean)); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  appendChild(c) { c.parentElement = this; this.children.push(c); c.isConnected = true; return c; }
  insertBefore(c, ref) {
    if (!ref || ref.parentElement !== this) return this.appendChild(c);
    const i = this.children.indexOf(ref);
    this.children.splice(i, 0, c); c.parentElement = this; c.isConnected = true; return c;
  }
  remove() {
    if (this.parentElement) {
      const a = this.parentElement.children, i = a.indexOf(this);
      if (i >= 0) a.splice(i, 1);
    }
    this.parentElement = null; this.isConnected = false;
  }
  contains(el) { return el === this || this.children.some(c => c.contains(el)); }
  get parentNode() { return this.parentElement; }
  get nextSibling() {
    if (!this.parentElement) return null;
    const a = this.parentElement.children, i = a.indexOf(this);
    return a[i + 1] || null;
  }
  get classList() { const s = this.classes; return { contains: c => s.has(c) }; }
  querySelectorAll(sel) {
    const pref = /^\[data-testid\^="(.+)"\]$/.exec(sel);
    const exact = /^\[data-testid="(.+)"\]$/.exec(sel);
    const cls = sel.startsWith('.') ? sel.slice(1) : null;
    const out = [];
    const walk = n => {
      for (const c of n.children) {
        const t = c.attrs['data-testid'];
        if (pref ? (typeof t === 'string' && t.startsWith(pref[1]))
          : exact ? (t === exact[1])
          : (cls && c.classes.has(cls))) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) { const r = this.querySelectorAll(sel); return r[0] || null; }
}

const source = readOverlaySource();

function extractTpsBand() {
  return vm.runInNewContext('(function(){' + getNamedSlice('tpsBandOnly') + '\nreturn tpsBand;})();', {});
}

/* 切片：subRunningList + renderRunningSubagentItems（subStatItems 具名切片） */
function extractSubStat(lang) {
  const ctxObj = {
    L: (zh, en) => (lang === 'en' ? en : zh),
    tpsBand: extractTpsBand(),
    ttEsc: x => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    fmt: n => String(Math.round(n)),
    Date: { now: () => NOW },
    document: {
      documentElement: { classList: { contains: () => true } },
      createElement: tag => new El(tag),
    },
    inactive: () => false,
    composer: null, wantedEl: null,
    bridge: { handle: null },
    subRate: { slots: {} },
    lastSub: null,
    subTipFor: null,
    showSubTip: () => {}, hideSubTip: () => {},
    subRowTipHTML: t => 'tip:' + (t.csid || ''),
    state: { show: { subRate: 1 } },
    console,
  };
  ctxObj.subRowPaneRoot = () => (ctxObj.composer && ctxObj.composer.parentElement) || null;
  const ctx = vm.createContext(ctxObj);
  const fn = vm.runInContext(
    '(function(){' + getNamedSlice('subStatItems') +
    '\nreturn { list: subRunningList, render: renderRunningSubagentItems, synth: synthesizeBackgroundStats };})();', ctx);
  return { ctx, fn };
}

/* 状态面板行夹具：pane 壳 > composer + running 行（testid + data-child-session-id） */
function makePaneItem(csid) {
  const root = new El();
  root.setAttribute('data-session-id', 'sid_main');
  const composer = new El('textarea');
  root.appendChild(composer);
  const item = new El('div');
  item.setAttribute('data-testid', 'v4-running-subagent-item');
  item.setAttribute('data-child-session-id', csid);
  const label = new El('span');
  item.appendChild(label);
  root.appendChild(item);
  return { root, composer, item };
}
const chipOf = item => item.querySelector('.zu-substat');

for (const lang of ['zh', 'en']) {
  test(`${lang}: subRunningList unions rows rows with backgroundWorks subagent entries`, () => {
    const { ctx, fn } = extractSubStat(lang);
    ctx.bridge.handle = { dead: false, store: { getState: () => ({ snapshot: { backgroundWorks: [
      { workId: 'w1', kind: 'subagent', status: 'running', childSessionId: BG_SID },
      { workId: 'w2', kind: 'subagent', status: 'resultPending', childSessionId: 'sess_subagent_agent_done' },   // 已完成不计
      { workId: 'w3', kind: 'bash', status: 'running', childSessionId: 'x' },   // 非 subagent 不计
      { workId: 'w4', kind: 'subagent', status: 'running' },                     // 无 childSessionId 不计
    ] } }) } };
    const stats = { complete: false, runningSubagents: [{ childSessionId: 'sess_subagent_agent_fg' }] };
    const list = fn.list(stats);
    const ids = list.map(x => x.childSessionId);
    assert.deepEqual(ids, ['sess_subagent_agent_fg', BG_SID], 'rows 行在前、补给追加、完成态/杂类剔除');
  });

  test(`${lang}: subRunningList dedupes ids already in rows`, () => {
    const { ctx, fn } = extractSubStat(lang);
    ctx.bridge.handle = { dead: false, store: { getState: () => ({ snapshot: { backgroundWorks: [
      { workId: 'w1', kind: 'subagent', status: 'running', childSessionId: BG_SID },
    ] } }) } };
    const list = fn.list({ complete: false, runningSubagents: [{ childSessionId: BG_SID }] });
    assert.equal(list.length, 1, '同一 childSessionId 不重复入槽');
  });

  test(`${lang}: subRunningList falls back to rows without bridge or backgroundWorks`, () => {
    const { ctx, fn } = extractSubStat(lang);
    const rows = [{ childSessionId: 'sess_subagent_agent_fg' }];
    assert.deepEqual(fn.list({ complete: false, runningSubagents: rows }).map(x => x.childSessionId),
      ['sess_subagent_agent_fg']);
    ctx.bridge.handle = { dead: false, store: { getState: () => ({ snapshot: {} }) } };
    assert.deepEqual(fn.list({ complete: false, runningSubagents: rows }).map(x => x.childSessionId),
      ['sess_subagent_agent_fg'], '快照缺 backgroundWorks 键 → 退化为 rows 行为（无害）');
    assert.equal(fn.list({ complete: true, runningSubagents: rows }).map(x => x.childSessionId).join(','),
      '', '完成态恒空（跨 realm 用 join 比对，vm 域字面量空数组过不了 deepEqual）');
  });

  test(`${lang}: running item chip shows slot estimate with band color`, () => {
    const { ctx, fn } = extractSubStat(lang);
    const p = makePaneItem(BG_SID);
    ctx.composer = p.composer;
    ctx.subRate.slots[BG_SID] = { rate: 45.16, at: NOW - 500 };
    fn.render();
    const chip = chipOf(p.item);
    assert.ok(chip, 'chip mounted');
    assert.equal(chip.className, 'zu-substat', '深色主题本体无 zu-light');
    assert.ok(chip.innerHTML.includes((lang === 'en' ? 'est ' : '估 ') + '45.2 t/s<'));
    assert.match(chip.innerHTML, /class="warm"/);
    assert.equal(chip.__zuT.csid, BG_SID);
    assert.equal(chip.__zuT.mode, 'est');
    assert.equal(typeof chip.__zuT.buildTip, 'function');
  });

  test(`${lang}: slot without rate shows estimating, absent slot falls back to tps_avg`, () => {
    const { ctx, fn } = extractSubStat(lang);
    const p = makePaneItem(BG_SID);
    ctx.composer = p.composer;
    ctx.subRate.slots[BG_SID] = { rate: null, at: 0 };
    ctx.lastSub = { list: [] };
    fn.render();
    assert.ok(chipOf(p.item).innerHTML.includes(lang === 'en' ? 'estimating…' : '估算中…'), '绑定中/思考期状态词');
    ctx.subRate.slots[BG_SID].rate = 20;   // 过期速率：3.5s 前刷新，超出 3s 新鲜度窗（钉住常量量级）
    ctx.subRate.slots[BG_SID].at = NOW - 3500;
    fn.render();
    assert.ok(chipOf(p.item).innerHTML.includes(lang === 'en' ? 'estimating…' : '估算中…'), '过期估算不得作为速率显示（v334 补断言）');
    ctx.lastSub = { list: [{ sid: BG_SID, tps_avg: 88.4, total: 1000, task: 'Explore', title: '' }] };
    ctx.subRate.slots[BG_SID] = null;
    fn.render();
    assert.ok(chipOf(p.item).innerHTML.includes('88.4 t/s<'), '无槽位回填 sub.list tps_avg');
    assert.equal(chipOf(p.item).__zuT.mode, 'real');
  });

  test(`${lang}: no slot and no data shows running-only chip with run tooltip mode`, () => {
    const { ctx, fn } = extractSubStat(lang);
    const p = makePaneItem(BG_SID);
    ctx.composer = p.composer;
    ctx.lastSub = { list: [] };
    fn.render();
    assert.ok(chipOf(p.item).innerHTML.includes(lang === 'en' ? 'running<' : '运行中<'));
    assert.equal(chipOf(p.item).__zuT.mode, 'run', '兜底态独立 mode：tooltip 不挂估速口径');
  });

  test(`${lang}: chip returns to the row when the host re-wraps it`, () => {
    const { ctx, fn } = extractSubStat(lang);
    const p = makePaneItem(BG_SID);
    ctx.composer = p.composer;
    ctx.subRate.slots[BG_SID] = { rate: 45, at: NOW - 100 };
    fn.render();
    const chip = chipOf(p.item);
    const inner = new El('div');   // 宿主结构变更把 chip 裹进更深容器
    inner.appendChild(chip);
    p.item.appendChild(inner);
    fn.render();
    assert.equal(chipOf(p.item), chip, '仍可寻回');
    assert.equal(chip.parentElement, p.item, '回位到行直接子节点（margin-left:auto 靠右定位依赖）');
  });

  test(`${lang}: render is idempotent and updates in place`, () => {
    const { ctx, fn } = extractSubStat(lang);
    const p = makePaneItem(BG_SID);
    ctx.composer = p.composer;
    ctx.subRate.slots[BG_SID] = { rate: 45, at: NOW - 100 };
    fn.render();
    const chip = chipOf(p.item);
    fn.render(); fn.render();
    assert.equal(chipOf(p.item), chip, '同节点复用');
    assert.equal(p.item.querySelectorAll('.zu-substat').length, 1);
    ctx.subRate.slots[BG_SID].rate = 620;
    fn.render();
    assert.equal(chipOf(p.item), chip);
    assert.ok(chip.innerHTML.includes('620.0 t/s<'), '速率更新原地改字');
  });

  test(`${lang}: subRate switch off strips chips and hides the hover tip`, () => {
    const { ctx, fn } = extractSubStat(lang);
    const p = makePaneItem(BG_SID);
    ctx.composer = p.composer;
    ctx.subRate.slots[BG_SID] = { rate: 45, at: NOW - 100 };
    fn.render();
    assert.ok(chipOf(p.item));
    const hidden = [];
    ctx.state.show.subRate = 0;
    ctx.subTipFor = chipOf(p.item);
    ctx.hideSubTip = () => hidden.push(1);
    fn.render();
    assert.equal(chipOf(p.item), null, '关闭即摘净（共用 subRate 开关）');
    assert.equal(hidden.length, 1, '本 pane 悬停浮层同步收起');
  });
}

  test(`synth: idle main session with live slots synthesizes Agent runningTool`, () => {
    const { ctx, fn } = extractSubStat('zh');
    ctx.subRate.slots[BG_SID] = { handle: {}, want: BG_SID, rate: 45, at: NOW - 100 };
    ctx.subRate.slots['sess_subagent_agent_b2'] = { handle: {}, want: 'sess_subagent_agent_b2', rate: 30, at: NOW - 100 };
    const out = fn.synth(null);   // 主会话无 stats（空闲）
    assert.equal(out.complete, false);
    assert.equal(out.runningTool.name, 'Agent');
    assert.equal(out.runningTool.childSessionId, 'sess_subagent_agent_b2', 'runningSubagents 取末槽');
    assert.equal(out.runningSubagents.length, 2);
    const out2 = fn.synth({ complete: true, runningTool: null });   // 上一轮已完成同样合成
    assert.equal(out2.runningTool.name, 'Agent');
  });

  test(`synth: live main session passes through; no slots returns original`, () => {
    const { ctx, fn } = extractSubStat('zh');
    const live = { complete: false, runningTool: { name: 'Read' } };
    assert.equal(fn.synth(live), live, '主会话实时轮优先，不合成');
    ctx.subRate.slots[BG_SID] = { want: BG_SID };
    const out = fn.synth(null);
    assert.equal(out.runningTool.name, 'Agent', 'want 槽位触发合成');
    ctx.subRate.slots = {};   // 清空槽位（后台全部结束）
    assert.equal(fn.synth(null), null, '无槽位且无 stats：原样返回（回落 DB/会话均路径）');
    const idle = { complete: true };
    assert.equal(fn.synth(idle), idle, '无槽位不合成：回落原完成态（会话均）');
  });

test('source contracts: substat wiring (style, delegation, call sites, union feed, version)', () => {
  assert.match(source, /"\.zu-substat\{flex:0 0 auto;white-space:nowrap;cursor:help/, 'chip 样式入注入块');
  assert.match(source, /e\.target\.closest\("\.zu-subrate,\.zu-wfrun,\.zu-substat"\)/, '委托判定含状态面板 chip');
  assert.match(source, /closest\("\.zu-substat"\) === subTipFor/, 'mouseout 离开判定同步');
  assert.match(source, /subRateTick\(subRunningList\(stats\)\)/, 'updateLive 补给接入槽位对账');
  assert.match(source, /renderRunningSubagentItems\(\);   \/\/ v333：状态面板 Agents 行速率 chip 数据点 reapply/, 'render 尾部数据点');
  assert.match(source, /renderRunningSubagentItems\(\);   \/\/ v333：状态面板 Agents 行 chip DOM 对账点/, 'heavy DOM 对账点');
  assert.match(source, /w\.kind === "subagent" && w\.status === "running"/, '补给只认运行中 subagent 条目');
  /* v335：dispose（12 分片）与 00 启动自清的三类 chip 全覆盖——两处收窄/缺类名都会让
   * pane 回收或热重载后残留冻结 chip（第一轮审查 M1/m2 的变异全绿缺口，源码契约锁定） */
  assert.match(source, /var staleChips = srr\.querySelectorAll\("\.zu-subrate,\.zu-wfrun,\.zu-substat"\)/, 'dispose 摘净链含三类 chip');
  assert.match(source, /,\.zu-subrate,\.zu-wfrun,\.zu-substat"\)\.forEach/, '启动自清列表含三类 chip');
  /* v337 主格合成态：槽位在而主会话无实时轮——合成 runningTool=Agent 让速度格走子代理分支 */
  assert.match(source, /function synthesizeBackgroundStats\(stats\)/, '合成函数在切片内');
  assert.match(source, /stats = synthesizeBackgroundStats\(stats\);/, 'updateLive 接线');
  assert.match(source, /if \(stats && !stats\.complete\) return stats;/, '主会话实时轮优先不合成');
  assert.match(source, /var VERSION = "v342";/);   // 只锁代际顺延；台账内容合法性由 ReleaseLedgerTests 守护
});
