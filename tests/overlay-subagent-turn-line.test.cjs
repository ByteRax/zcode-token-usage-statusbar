const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { sliceOverlay } = require('./helpers/overlay-extract.cjs');

// v460 子代理窗格统计行（specs/subagent-turn-stats-line.md）：伪 owner 观察器让 det 链
// 认领 sess_subagent_* 窗格，02 分片的两处实例门放行观察器 owner。夹具：源码切片 +
// 最小 DOM 桩（父链/包含/断连），03 切片从 fiberSideIdOf 起到观察器块尾（含 detOwnerOf
// 与 fiberSideIdOf 副本——detOwnerOf 的侧聊遍历会调 fiberSideIdOf，桩无 fiber 键返回空串）。

const WS_PATH = '/ws/alpha';

class El {
  constructor(tag, attrs) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.attrs = Object.assign({}, attrs || {});
    this.parentElement = null;
    this.isConnected = true;
  }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
  appendChild(c) { (this._kids = this._kids || []).push(c); c.parentElement = this; return c; }
  contains(el) { for (let p = el; p; p = p.parentElement) if (p === this) return true; return false; }
  querySelectorAll(sel) {   // 仅支持 [attr] 形态（zuSubDetIsLastTurnBox 的 [data-turn-id] 查询够用）
    const m = /^\[(.+)\]$/.exec(sel);
    const out = [];
    const rec = n => { for (const c of n._kids || []) { if (m && Object.prototype.hasOwnProperty.call(c.attrs, m[1])) out.push(c); rec(c); } };
    rec(this);
    return out;
  }
}

/* 03 切片：fiberSideIdOf → detOwnerOf → detSeenKey/detStatsFor → v460 观察器块尾 */
const DET_SLICE = '(function(){\n' +
  sliceOverlay('  function fiberSideIdOf(el) {', '  /* 节点只保存不透明令牌') +
  '\nreturn { detOwnerOf: detOwnerOf, list: zuSubDetPaneList, hasOwner: zuSubDetHasOwner,' +
  ' diag: zuSubDetDiag, tick: zuSubDetPaneTick, disposeAll: zuSubDetDisposeAll, ensure: zuSubDetEnsure,' +
  ' isLastTurnBox: zuSubDetIsLastTurnBox };})()';

/* zuActiveTurnId 真实实现（02 分片）：productTurnId 优先 */
const ACTIVE_TID = '(function(){' +
  sliceOverlay('  function zuActiveTurnId(snap) {', '  /* 完成态摘要：') + '\nreturn zuActiveTurnId;})()';

function make03ctx(opts) {
  opts = opts || {};
  const storeOffs = [], subOffs = [], trackerDisposes = [], callbacks = [], acquired = [], tryCalls = [];
  const body = new El();
  const instRoot = new El('div', { 'data-session-id': 'sess_main' });
  body.appendChild(instRoot);
  const instScope = () => ({ sid: 'sess_main', identity: '', workspacePath: WS_PATH, remoteSessionId: '' });
  const instances = opts.instances !== undefined ? opts.instances :
    [{ getScope: instScope, detRoot: () => instRoot }];   // 缺省：一个本地实例供 scope 借用（root 不含子窗格）
  const ctx = vm.createContext({
    instances,
    document: { body },
    stale: () => false,
    Date: { now: () => (opts.now || 0) },
    zuActiveTurnId: vm.runInNewContext(ACTIVE_TID, {}),
    TURN_STATS: {
      createTracker: () => {
        const t = { disposed: false, get: () => null, dispose: () => { t.disposed = true; trackerDisposes.push(t); } };
        return t;
      },
      subscribeStore: (store, tracker, cb) => { callbacks.push(cb); return () => subOffs.push(store); },
    },
    zuTryBindStore: sid => {
      tryCalls.push(sid);
      if (!opts.tryStore) return null;
      return { off: () => storeOffs.push(sid) };
    },
    zuAcquireSubStore: (sid, hint) => { acquired.push({ sid: sid, hint: hint }); return null; },
    console,
  });
  const api = vm.runInContext(DET_SLICE, ctx);
  return { ctx, api, body, instRoot, storeOffs, subOffs, trackerDisposes, callbacks, acquired, tryCalls };
}

/* 主会话树：body > instRoot；子代理窗格树：body > subRoot[data-session-id] > box */
function subTree(h, sid, turn) {
  const root = new El('div', { 'data-session-id': sid });
  const box = new El('section', { 'data-turn-id': turn || 'turn_1' });
  root.appendChild(box);
  h.body.appendChild(root);
  return { root, box };
}

test('v460 观察器：detOwnerOf 无实例认领时回退发现子代理窗格（按 sid 幂等）', () => {
  const h = make03ctx({ tryStore: true });
  const t = subTree(h, 'sess_subagent_abc');
  const w = h.api.detOwnerOf(t.box);
  assert.equal(w.pid, 'subagent-pane:sess_subagent_abc');
  assert.equal(h.api.detOwnerOf(t.box), w);   // 幂等：同 sid 复用同一观察器
  assert.equal(w.getSid(), 'sess_subagent_abc');
  assert.deepEqual(JSON.parse(JSON.stringify(w.getScope())),   // 跨 realm 对象：JSON 往返再比
    { sid: 'sess_subagent_abc', identity: '', workspacePath: WS_PATH, remoteSessionId: '' });
  assert.equal(h.api.list().length, 1);
  assert.equal(h.api.hasOwner(w), true);
  assert.deepEqual(JSON.parse(JSON.stringify(h.api.diag())), { panes: 1, bound: 1 });   // 直绑成功
});

test('v460 观察器：实例 root 包含 box 时实例优先，观察器回退不触发', () => {
  const h = make03ctx({ tryStore: true });
  const box = new El('section', { 'data-turn-id': 'turn_m' });
  h.instRoot.appendChild(box);
  const w = h.api.detOwnerOf(box);
  assert.equal(w.pid, undefined);   // 实例 owner（桩实例无 pid 字段亦可，仅断非观察器）
  assert.equal(h.api.list().length, 0);
});

test('v460 观察器：最近会话根非子代理前缀不越级认领，也不建观察器', () => {
  const h = make03ctx({ tryStore: true });
  const plain = new El('div', { 'data-session-id': 'sess_main2' });
  const box = new El('section', { 'data-turn-id': 'turn_9' });
  plain.appendChild(box);
  h.body.appendChild(plain);
  assert.equal(h.api.detOwnerOf(box), null);
  assert.equal(h.api.list().length, 0);
  // sid 前缀正则边界：后缀 >72 字符不认领（与主桥 queryTurnText 同款边界）
  const t = subTree(h, 'sess_subagent_' + 'a'.repeat(73));
  assert.equal(h.api.detOwnerOf(t.box), null);
  assert.equal(h.api.list().length, 0);
});

test('v460 绑定：注册表直绑失败走 acquire 租约（借 workspacePath），再失败 2s 重试', () => {
  const h = make03ctx({});   // 无 tryStore、无 acquire → 双路径都拿不到
  const t = subTree(h, 'sess_subagent_x');
  h.api.detOwnerOf(t.box);
  assert.deepEqual(JSON.parse(JSON.stringify(h.api.diag())), { panes: 1, bound: 0 });
  assert.deepEqual(JSON.parse(JSON.stringify(h.acquired)),
    [{ sid: 'sess_subagent_x', hint: { workspacePath: WS_PATH } }]);
  h.api.tick();   // now=0 < retryAt(2000)：不重试
  assert.equal(h.acquired.length, 1);
  h.ctx.Date.now = () => 2500;
  h.api.tick();   // 到点重试
  assert.equal(h.acquired.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(h.api.diag())), { panes: 1, bound: 0 });
});

test('v460 绑定：订阅回调推送活跃轮号（productTurnId 优先），isCurrentTurn 只认该轮', () => {
  const h = make03ctx({ tryStore: true });
  const t = subTree(h, 'sess_subagent_x');
  const w = h.api.detOwnerOf(t.box);
  assert.equal(h.callbacks.length, 1);
  assert.equal(w.isCurrentTurn('msg_t2'), false);   // 未推送前恒 false（不读 store）
  h.callbacks[0]({ snapshot: { sessionId: 'sess_subagent_x', rows: { window: [
    { kind: 'turnHeader', turnId: 'db_t1', productTurnId: 'msg_t1' },
    { kind: 'turnHeader', turnId: 'db_t2', productTurnId: 'msg_t2' },
  ] } } });
  assert.equal(w.isCurrentTurn('msg_t2'), true);
  assert.equal(w.isCurrentTurn('db_t2'), false);   // productTurnId 优先
  assert.equal(w.isCurrentTurn('msg_t1'), false);
  assert.equal(w.isCurrentTurn(''), false);
});

test('v460 生命周期：订阅快照 sessionId 不符（关闭/换代）→ 整观察器撤除', () => {
  const h = make03ctx({ tryStore: true });
  const t = subTree(h, 'sess_subagent_x');
  h.api.detOwnerOf(t.box);
  h.callbacks[0]({ snapshot: { sessionId: 'sess_other', rows: { window: [] } } });
  assert.equal(h.api.list().length, 0);
  assert.equal(h.storeOffs.length, 1);   // store 租约释放
  assert.equal(h.subOffs.length, 1);     // 订阅退订
  assert.equal(h.trackerDisposes.length, 1);
  h.callbacks[0]({ snapshot: { sessionId: 'sess_subagent_x', rows: { window: [] } } });   // dead 守卫：撤除后回调静默
  assert.equal(h.api.list().length, 0);
});

test('v460 生命周期：窗格根断连 → detRoot 返 null 不认领，tick 巡检撤除并释放租约', () => {
  const h = make03ctx({ tryStore: true });
  const t = subTree(h, 'sess_subagent_x');
  const w = h.api.detOwnerOf(t.box);
  t.root.isConnected = false;
  assert.equal(w.detRoot(), null);
  assert.equal(h.api.detOwnerOf(t.box), null);   // 断连后 detOwnerOf 不再认领
  h.api.tick();
  assert.equal(h.api.list().length, 0);
  assert.deepEqual(h.storeOffs, ['sess_subagent_x']);
});

test('v460 生命周期：disposeAll 释放两个在册观察器的全部租约与 tracker', () => {
  const h = make03ctx({ tryStore: true });
  const a = subTree(h, 'sess_subagent_a'), b = subTree(h, 'sess_subagent_b');
  h.api.detOwnerOf(a.box);
  h.api.detOwnerOf(b.box);
  assert.deepEqual(JSON.parse(JSON.stringify(h.api.diag())), { panes: 2, bound: 2 });
  h.api.disposeAll();
  assert.deepEqual(JSON.parse(JSON.stringify(h.api.diag())), { panes: 0, bound: 0 });
  assert.deepEqual(h.storeOffs.sort(), ['sess_subagent_a', 'sess_subagent_b']);
  assert.equal(h.subOffs.length, 2);
  assert.equal(h.trackerDisposes.length, 2);
});

test('v460 存量轮：zuSubDetIsLastTurnBox 只认窗格最后一个轮 tid（嵌套同 tid 均算）', () => {
  const h = make03ctx({ tryStore: true });
  const root = new El('div', { 'data-session-id': 'sess_subagent_x' });
  h.body.appendChild(root);
  const q = (attrs) => { const e = new El('section', attrs); root.appendChild(e); return e; };
  const b1 = q({ 'data-turn-id': 'msg_t1' });
  const b2unit = q({ 'data-turn-id': 'msg_t2' });
  const b2sec = new El('section', { 'data-turn-id': 'msg_t2' });
  b2unit.appendChild(b2sec);
  const w = h.api.detOwnerOf(b1);
  assert.equal(h.api.isLastTurnBox(w, b1), false);          // 非最后一轮
  assert.equal(h.api.isLastTurnBox(w, b2unit), true);       // 最后一轮（外层单元）
  assert.equal(h.api.isLastTurnBox(w, b2sec), true);        // 嵌套内层 section 同 tid 同算
  const other = new El('section', { 'data-turn-id': 'msg_t9' });
  assert.equal(h.api.isLastTurnBox(w, other), false);       // tid 不是窗格最后轮
  root.isConnected = false;
  assert.equal(h.api.isLastTurnBox(w, b2sec), false);       // 断连 root 返 false
});

/* v460 补强源码契约：扫描循环的观察器存量轮旁路（纯富文本轮）关键行——
 * 行为级依赖完整扫描切片（state/TURN_STATS/zuRichKey/zuDetPlace 等十余依赖），以
 * 锚点断言锁定结构与语义（缓存命中插行 / 仅最后一轮发查询 / 不插占位 / 实例不受影响）。 */
test('v460 存量轮：扫描循环旁路源码契约（纯富文本轮语义）', () => {
  const src = require('./helpers/overlay-extract.cjs').readOverlaySource();
  const i = src.indexOf('if (!stats && typeof zuSubDetHasOwner === "function" && zuSubDetHasOwner(owner))');
  assert.ok(i > 0, '观察器存量轮旁路缺失');
  const block = src.slice(i, src.indexOf('if (!stats || !stats.complete) continue;', i));
  assert.ok(block.indexOf('richTextCache[richKey]') > 0 && block.indexOf('zuDetPlace') > 0, '缓存命中应直接插行');
  assert.ok(block.indexOf('zuSubDetIsLastTurnBox(owner, box)') > 0, '仅窗格最后一轮发查询');
  assert.ok(block.indexOf('zuRequestTurnText(owner, tid, { sessionId: owner.getSid() })') > 0, '最小 stats 替身过 noSid 门');
  assert.equal(block.indexOf('zuUnavailableText'), -1, '旁路绝不插「本轮统计不可用」误导行');
});

const SLICE02 = '(function(){\n' +
  sliceOverlay('  var richTextDiag = ', '    scanDeterministicLines();\n  };', { includeEnd: true }) +
  '\nreturn { flush: zuFlushRichTextWants, deliver: window.__zusageDeliverTurnText, diag: richTextDiag,' +
  ' cache: richTextCache, tids: richTextRequestTids, wants: richTextWants, keyOf: zuRichKey,' +
  ' reqs: function () { return window.__zusagePluginRequests || []; } };})()';

function subOwnerStub() {
  return {
    __sub: true,   // has03 桩的观察器判据（真实链路是 03 注册表身份比对，桩用标记位近似）
    pid: 'subagent-pane:sess_subagent_x',
    getSid: () => 'sess_subagent_x',
    getScope: () => ({ sid: 'sess_subagent_x', identity: '', workspacePath: WS_PATH, remoteSessionId: '' }),
    isCurrentTurn: tid => tid === 't2',
  };
}

function make02ctx(opts) {
  opts = opts || {};
  const rescans = [];
  const ctx = vm.createContext({
    Date: { now: () => 1000 },
    window: {},
    stale: () => false,
    instances: opts.instances || [],
    capPut: (obj, k, v) => { obj[k] = v; },
    cnUnits: () => true,
    state: { forceKmb: false, cost: 1, data: { remote_evidence: false } },
    MY_GEN: 7,
    richTextRequestEpoch: 0,
    richTextUnitEpoch: 1,
    richTextCache: {},
    richTextAttempts: {},
    richTextRequestTids: {},
    richTextWants: {},
    richTextOwners: new WeakMap(),   // zuRichKey 的 owner 序号表（声明在切片上游的自由变量）
    richTextOwnerSeq: 0,
    scanDeterministicLines: () => { rescans.push(1); },
    JSON,
    console,
  });
  if (opts.has03) ctx.zuSubDetHasOwner = o => !!(o && o.__sub === true);
  const api = vm.runInContext(SLICE02, ctx);
  return { ctx, api, rescans };
}

function wantFor(h, owner, tid) {
  h.api.wants[owner.getSid()] = { key: h.api.keyOf(owner, tid), tid: tid, owner: owner };
}

test('v460 门控：flush 对观察器 owner 放行并入队 turn-text 请求（无 03 时不放行）', () => {
  const h = make02ctx({ has03: true });
  const o = subOwnerStub();
  wantFor(h, o, 't2');
  h.api.flush();
  const reqs = h.api.reqs();
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].action, 'turn-text');
  assert.equal(reqs[0].sid, 'sess_subagent_x');
  assert.equal(h.api.diag.sent, 1);
  assert.equal(h.api.diag.noInst, 0);
  assert.ok(h.api.tids['sess_subagent_x']);   // pending 已登记（deliver 门的前提）
});

test('v460 门控：切片只装载 02（typeof 守卫走原行为）→ noInst 拦截', () => {
  const h = make02ctx({});
  const o = subOwnerStub();
  wantFor(h, o, 't2');
  h.api.flush();
  assert.equal(h.api.reqs().length, 0);
  assert.equal(h.api.diag.sent, 0);
  assert.equal(h.api.diag.noInst, 1);
});

test('v460 门控：zuSubDetHasOwner 判否的 owner 照旧 noInst 拦截', () => {
  const h = make02ctx({ has03: true });
  const o = subOwnerStub();
  delete o.__sub;   // 桩判据：无 __sub 标记 → 非观察器
  wantFor(h, o, 't2');
  h.api.flush();
  assert.equal(h.api.reqs().length, 0);
  assert.equal(h.api.diag.noInst, 1);
});

test('v460 补强：flush 的 isCurrentTurn 门对观察器 owner 短路（存量轮 latestTurn 查询放行）', () => {
  const h = make02ctx({ has03: true });
  const o = subOwnerStub();
  o.isCurrentTurn = () => false;   // 冷窗格：快照无 turnHeader，activeTid 恒空
  wantFor(h, o, 't2');
  h.api.flush();
  assert.equal(h.api.reqs().length, 1);   // 最后一轮判据在收集端（zuSubDetIsLastTurnBox），flush 端不拦
  assert.equal(h.api.diag.notCur, 0);
  assert.equal(h.api.diag.sent, 1);
});

test('v460 补强：实例 owner 的 isCurrentTurn 门不回归（观察器短路不外溢）', () => {
  const o = subOwnerStub();
  const h = make02ctx({ instances: [o] });   // 实例路径无 03 分片
  o.isCurrentTurn = () => false;
  wantFor(h, o, 't2');
  h.api.flush();
  assert.equal(h.api.reqs().length, 0);
  assert.equal(h.api.diag.notCur, 1);   // 实例 owner 照旧被门拦
});

test('v460 门控：实例 owner 不受 typeof 守卫影响（既有路径回归保护）', () => {
  const o = subOwnerStub();
  const h = make02ctx({ instances: [o] });   // 无 03 分片：实例路径原本就放行
  wantFor(h, o, 't2');
  h.api.flush();
  assert.equal(h.api.reqs().length, 1);
  assert.equal(h.api.diag.sent, 1);
  assert.equal(h.api.diag.noInst, 0);
});

test('v460 门控：deliver 对观察器 owner 写缓存并立即重扫（ok 桶）', () => {
  const h = make02ctx({ has03: true });
  const o = subOwnerStub();
  wantFor(h, o, 't2');
  h.api.flush();
  const pending = h.api.tids['sess_subagent_x'];
  h.api.deliver('sess_subagent_x', '⚡ 富文本统计行', pending.epoch, null);
  assert.equal(h.api.cache[pending.key], '⚡ 富文本统计行');
  assert.equal(h.api.diag.ok, 1);
  assert.equal(h.api.diag.stale, 0);
  assert.equal(h.rescans.length, 1);
});

test('v460 门控：deliver 在 owner 判否时 stale 拒绝（不写缓存不重扫）', () => {
  const h = make02ctx({ has03: true });
  const o = subOwnerStub();
  wantFor(h, o, 't2');
  h.api.flush();
  const pending = h.api.tids['sess_subagent_x'];
  h.ctx.zuSubDetHasOwner = () => false;   // 观察器在 deliver 前被撤除
  h.api.deliver('sess_subagent_x', '⚡ 富文本统计行', pending.epoch, null);
  assert.equal(h.api.cache[pending.key], undefined);
  assert.equal(h.api.diag.stale, 1);
  assert.equal(h.api.diag.ok, 0);
  assert.equal(h.rescans.length, 0);
});
