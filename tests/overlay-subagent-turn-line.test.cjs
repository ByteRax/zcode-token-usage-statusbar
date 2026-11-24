const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { sliceOverlay, readOverlaySource } = require('./helpers/overlay-extract.cjs');

// v458 子代理窗格统计行（specs/subagent-turn-stats-line.md）：伪 owner 观察器让 det 链
// 认领 sess_subagent_* 窗格，02 分片的实例门放行观察器 owner，富文本请求带页面轮号。
// 夹具：源码切片 + 最小 DOM 桩（父链/包含/断连/属性查询/行节点）。
//   03 切片从 fiberSideIdOf 起到观察器块尾（detOwnerOf 与 fiberSideIdOf 副本——detOwnerOf 的
//   侧聊遍历会调 fiberSideIdOf，桩无 fiber 键返回空串）；
//   全链切片把富文本请求/回执、观察器、扫描循环、换代清理、sharedTick 装进同一个上下文，
//   扫描旁路按行为断言（发了几条请求、带什么轮号、哪一轮下插了行），不再只比源码字符串。

const WS_PATH = '/ws/alpha';
const SUB_SID = 'sess_subagent_x';
/* 桥写在会话根上的本地 scope 属性（renderer_bridge.py pane_attributes 的同款字段） */
const BRIDGE_LOCAL = {
  'data-zusage-scope-version': '1', 'data-zusage-workspace-path': WS_PATH,
  'data-zusage-workspace-identity': '', 'data-zusage-remote-session-id': '', 'data-zusage-pane-id': 'pane-sub',
};

class El {
  constructor(tag, attrs) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.attrs = Object.assign({}, attrs || {});
    this.parentElement = null;
    this.isConnected = true;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.className = '';
    this._text = '';
  }
  get textContent() { return this.children.length ? this.children.map(c => c.textContent).join('') : this._text; }
  set textContent(v) { this.children = []; this._text = String(v); }
  /* dataset 赋值镜像成 data-* 属性（zuDetBuildLine 走 quote.dataset.zusageDeterministic，真实 DOM 里即属性） */
  _datasetKey(k) { return k.indexOf('data-') === 0 ? k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()) : null; }
  getAttribute(k) {
    if (Object.prototype.hasOwnProperty.call(this.attrs, k)) return this.attrs[k];
    const dk = this._datasetKey(k);
    return dk && Object.prototype.hasOwnProperty.call(this.dataset, dk) ? String(this.dataset[dk]) : null;
  }
  hasAttribute(k) { return this.getAttribute(k) !== null; }
  appendChild(c) { c.remove(); this.children.push(c); c.parentElement = this; c.isConnected = true; return c; }
  insertBefore(c, ref) {
    const i = ref ? this.children.indexOf(ref) : -1;
    c.remove();
    if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
    c.parentElement = this; c.isConnected = true;
    return c;
  }
  get nextSibling() {
    if (!this.parentElement) return null;
    const a = this.parentElement.children;
    return a[a.indexOf(this) + 1] || null;
  }
  remove() {
    if (!this.parentElement) return;
    const a = this.parentElement.children, i = a.indexOf(this);
    if (i >= 0) a.splice(i, 1);
    this.parentElement = null;
    this.isConnected = false;   // 离开文档（真实 DOM 的 isConnected 语义）
  }
  contains(el) { for (let p = el; p; p = p.parentElement) if (p === this) return true; return false; }
  /* 仅支持「标签 + 若干 [attr]」的简单选择器（逗号分组）；本文件用到的查询都在这个范围内 */
  matches(simple) {
    const m = /^([a-zA-Z*]*)((?:\[[^\]]+\])*)$/.exec(simple);
    if (!m) return false;
    if (m[1] && m[1] !== '*' && m[1].toUpperCase() !== this.tagName) return false;
    const attrs = m[2] ? m[2].match(/\[[^\]]+\]/g).map(a => a.slice(1, -1)) : [];
    return attrs.every(a => this.hasAttribute(a));
  }
  querySelectorAll(sel) {
    const out = [], parts = sel.split(',').map(s => s.trim());
    const rec = n => { for (const c of n.children) { if (parts.some(s => c.matches(s))) out.push(c); rec(c); } };
    rec(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

/* 03 切片：fiberSideIdOf → detOwnerOf → detSeenKey/detStatsFor → v458 观察器块尾 */
const DET_SLICE = '(function(){\n' +
  sliceOverlay('  function fiberSideIdOf(el) {', '  /* 节点只保存不透明令牌') +
  '\nreturn { detOwnerOf: detOwnerOf, list: zuSubDetPaneList, hasOwner: zuSubDetHasOwner,' +
  ' diag: zuSubDetDiag, tick: zuSubDetPaneTick, disposeAll: zuSubDetDisposeAll, ensure: zuSubDetEnsure,' +
  ' isLastTurnBox: zuSubDetIsLastTurnBox };})()';

/* zuActiveTurnId 真实实现（02 分片）：productTurnId 优先 */
const ACTIVE_TID = '(function(){' +
  sliceOverlay('  function zuActiveTurnId(snap) {', '  /* 完成态摘要：') + '\nreturn zuActiveTurnId;})()';

const plain = o => JSON.parse(JSON.stringify(o));

function make03ctx(opts) {
  opts = opts || {};
  const storeOffs = [], subOffs = [], trackerDisposes = [], callbacks = [], acquired = [], tryCalls = [];
  const body = new El('body');
  const instRoot = new El('div', { 'data-session-id': 'sess_main' });
  body.appendChild(instRoot);
  const instScope = () => ({ sid: 'sess_main', identity: '', workspacePath: WS_PATH, remoteSessionId: '' });
  const instances = opts.instances !== undefined ? opts.instances :
    [{ getScope: instScope, detRoot: () => instRoot }];   // 缺省：一个本地实例（root 不含子窗格）
  const ctx = vm.createContext({
    instances,
    document: { body: body },
    stale: () => false,
    Date: { now: () => (opts.now || 0) },
    zuActiveTurnId: vm.runInNewContext(ACTIVE_TID, {}),
    TURN_STATS: {
      createTracker: () => {
        const t = { disposed: false, get: () => null, dispose: () => { t.disposed = true; trackerDisposes.push(t); } };
        return t;
      },
      subscribeStore: (store, tracker, cb) => {
        callbacks.push(cb);
        if (opts.subThrows) throw new Error("host store subscribe failed");
        if (opts.syncCbState !== undefined) cb(opts.syncCbState);   // 真实 subscribeStore 会同步先跑一次回调
        if (opts.subNull) return null;   // 真实 subscribeStore 在 store 缺 subscribe / 退订不是函数时返回 null
        return () => subOffs.push(store);
      },
    },
    zuTryBindStore: (sid, want) => {
      tryCalls.push({ sid: sid, want: want });
      if (opts.tryThrows) throw new Error("registry diag failed");
      if (!opts.tryStore) return null;
      return { off: () => storeOffs.push(sid) };
    },
    zuAcquireSubStore: (sid, scope) => {
      acquired.push({ sid: sid, hint: scope });
      if (opts.acquireThrows) throw new Error("bridge acquire failed");
      return opts.acquireStore ? { off: () => storeOffs.push(sid) } : null;
    },
    console,
  });
  const api = vm.runInContext(DET_SLICE, ctx);
  return { ctx, api, body, instRoot, storeOffs, subOffs, trackerDisposes, callbacks, acquired, tryCalls };
}

/* 子代理窗格树：body > root[data-session-id] > box。attrs 缺省带本地桥属性；null = 桥缺席 */
function subTree(h, sid, turn, attrs) {
  const root = new El('div', Object.assign({ 'data-session-id': sid }, attrs === undefined ? BRIDGE_LOCAL : (attrs || {})));
  const box = new El('section', { 'data-turn-id': turn || 'turn_1' });
  root.appendChild(box);
  h.body.appendChild(root);
  return { root, box };
}

test('v458 观察器：detOwnerOf 无实例认领时回退发现子代理窗格（按 sid 幂等，scope 取窗格自身）', () => {
  const h = make03ctx({ tryStore: true });
  const t = subTree(h, 'sess_subagent_abc');
  const w = h.api.detOwnerOf(t.box);
  assert.equal(w.pid, 'subagent-pane:sess_subagent_abc');
  assert.equal(h.api.detOwnerOf(t.box), w);   // 幂等：同 sid 复用同一观察器
  assert.equal(w.getSid(), 'sess_subagent_abc');
  assert.deepEqual(plain(w.getScope()),   // 跨 realm 对象：JSON 往返再比
    { sid: 'sess_subagent_abc', identity: '', workspacePath: WS_PATH, remoteSessionId: '' });
  assert.equal(h.api.list().length, 1);
  assert.equal(h.api.hasOwner(w), true);
  assert.deepEqual(plain(h.api.diag()), { panes: 1, bound: 1, retrying: 0 });   // 直绑成功
  /* 绑定用窗格自身的 scope 精确匹配注册表本地键（不带 want 会命中同 sid 的远端 store） */
  assert.deepEqual(plain(h.tryCalls), [{ sid: 'sess_subagent_abc', want: { workspacePath: WS_PATH } }]);
});

test('v458 观察器：实例 root 包含 box 时实例优先，观察器回退不触发', () => {
  const h = make03ctx({ tryStore: true });
  const box = new El('section', { 'data-turn-id': 'turn_m' });
  h.instRoot.appendChild(box);
  const w = h.api.detOwnerOf(box);
  assert.equal(w.pid, undefined);   // 实例 owner（桩实例无 pid 字段亦可，仅断非观察器）
  assert.equal(h.api.list().length, 0);
});

test('v458 观察器：最近会话根非子代理前缀不越级认领，也不建观察器', () => {
  const h = make03ctx({ tryStore: true });
  const plainRoot = new El('div', { 'data-session-id': 'sess_main2' });
  const box = new El('section', { 'data-turn-id': 'turn_9' });
  plainRoot.appendChild(box);
  h.body.appendChild(plainRoot);
  assert.equal(h.api.detOwnerOf(box), null);
  // 子代理根里再嵌一层别的会话根：box 的最近会话根不是子代理窗格，同样不越级认领
  const outer = new El('div', Object.assign({ 'data-session-id': SUB_SID }, BRIDGE_LOCAL));
  const inner = new El('div', { 'data-session-id': 'sess_main3' });
  const nested = new El('section', { 'data-turn-id': 'turn_n' });
  inner.appendChild(nested);
  outer.appendChild(inner);
  h.body.appendChild(outer);
  assert.equal(h.api.detOwnerOf(nested), null);
  // sid 前缀正则边界：sess_subagentfoo（无下划线）与后缀 >72 字符都不认领（与主桥同款边界）
  for (const bad of ['sess_subagentfoo', 'sess_subagent_' + 'a'.repeat(73)]) {
    const t = subTree(h, bad);
    assert.equal(h.api.detOwnerOf(t.box), null, bad);
  }
  assert.equal(h.api.list().length, 0);
  assert.equal(h.tryCalls.length, 0);
  assert.equal(h.acquired.length, 0);
});

test('v458 归属：远端或带身份的窗格不认领——不借本地实例的身份（同窗口有本地实例也不认）', () => {
  const cases = [
    ['远端会话 id', { 'data-zusage-remote-session-id': 'ssh-host' }],
    ['工作区身份', { 'data-zusage-workspace-identity': 'remote:ssh:host' }],
    ['桥属性残缺（路径空）', { 'data-zusage-workspace-path': '' }],
    ['桥属性残缺（缺路径属性）', { 'data-zusage-workspace-path': undefined }],
    ['桥属性残缺（缺远端属性）', { 'data-zusage-remote-session-id': undefined }],
    ['路径带控制字符', { 'data-zusage-workspace-path': '/ws/\nalpha' }],
  ];
  for (const [name, over] of cases) {
    const h = make03ctx({ tryStore: true });
    const attrs = Object.assign({}, BRIDGE_LOCAL, over);
    Object.keys(attrs).forEach(k => { if (attrs[k] === undefined) delete attrs[k]; });
    const t = subTree(h, SUB_SID, 'msg_t1', attrs);
    assert.equal(h.api.detOwnerOf(t.box), null, name);
    assert.equal(h.api.list().length, 0, name);
    assert.equal(h.tryCalls.length, 0, name + '：不绑 store');
    assert.equal(h.acquired.length, 0, name + '：不取租约');
  }
});

test('v458 归属：桥缺席时的退路——本窗口每个实例都是已验证的本地 scope、且同属一个工作区才认领', () => {
  const inst = scope => ({ getScope: () => scope });
  const LOCAL = { sid: 'sess_main', identity: '', workspacePath: WS_PATH, remoteSessionId: '' };
  const local = () => inst(LOCAL);
  const notClaimed = (name, insts) => {
    const h = make03ctx({ tryStore: true, instances: insts });
    assert.equal(h.api.detOwnerOf(subTree(h, SUB_SID, 'msg_t1', null).box), null, name);
    assert.equal(h.api.list().length, 0, name);
    assert.equal(h.tryCalls.length, 0, name + '：不绑 store');
    assert.equal(h.acquired.length, 0, name + '：不取租约');
  };
  // 全本地且同一工作区：认领，scope 用实例的 workspacePath（本地键精确直绑）
  const ok = make03ctx({ tryStore: true, instances: [local(), local()] });
  const w = ok.api.detOwnerOf(subTree(ok, SUB_SID, 'msg_t1', null).box);
  assert.equal(w && w.pid, 'subagent-pane:' + SUB_SID);
  assert.deepEqual(plain(w.getScope()), { sid: SUB_SID, identity: '', workspacePath: WS_PATH, remoteSessionId: '' });
  assert.deepEqual(plain(ok.tryCalls), [{ sid: SUB_SID, want: { workspacePath: WS_PATH } }]);
  // 退路门的每个条件单独成立（其余条件都满足，含「同一个工作区」）都必须不认领：远端隔离门不靠别的条件搭便车
  notClaimed('远端实例（只带 remoteSessionId）', [local(), inst(Object.assign({}, LOCAL, { remoteSessionId: 'host' }))]);
  notClaimed('远端实例（只带工作区身份）', [local(), inst(Object.assign({}, LOCAL, { identity: 'remote:ssh:host' }))]);
  notClaimed('实例 scope 没有工作区路径', [local(), inst(Object.assign({}, LOCAL, { workspacePath: '' }))]);
  notClaimed('实例 scope 为 null', [local(), inst(null)]);
  notClaimed('实例没有 getScope', [local(), {}]);
  notClaimed('实例分属多个本地工作区', [local(), inst(Object.assign({}, LOCAL, { workspacePath: '/ws/beta' }))]);
  // 实例给的工作区路径过不了桥在位分支同款校验（类型 / 空白 / 控制字符）：两个实例给同一个坏值也不认领
  for (const [name, badPath] of [['数字', 42], ['纯空白', '   '], ['带控制字符', '/ws/\nalpha'], ['null', null]]) {
    notClaimed('实例工作区路径' + name, [inst(Object.assign({}, LOCAL, { workspacePath: badPath })), inst(Object.assign({}, LOCAL, { workspacePath: badPath }))]);
  }
  notClaimed('没有任何实例', []);
});

test('v458 绑定：注册表直绑失败走 acquire 租约（窗格自身 scope），再失败 2s 重试', () => {
  const h = make03ctx({});   // 无 tryStore、无 acquire → 双路径都拿不到
  const t = subTree(h, 'sess_subagent_x');
  h.api.detOwnerOf(t.box);
  assert.deepEqual(plain(h.api.diag()), { panes: 1, bound: 0, retrying: 1 });
  assert.deepEqual(plain(h.acquired), [{ sid: 'sess_subagent_x', hint: { workspacePath: WS_PATH } }]);
  h.api.tick();   // now=0 < retryAt(2000)：不重试
  assert.equal(h.acquired.length, 1);
  h.ctx.Date.now = () => 1999;
  h.api.tick();   // 差 1ms 到点：仍不重试
  assert.equal(h.acquired.length, 1);
  h.ctx.Date.now = () => 2000;
  h.api.tick();   // 恰到重试点：重试
  assert.equal(h.acquired.length, 2);
  h.ctx.Date.now = () => 2500;
  h.api.tick();   // 这一拍仍没绑上：重试点顺延，不连发
  assert.equal(h.acquired.length, 2);
  assert.deepEqual(plain(h.api.diag()), { panes: 1, bound: 0, retrying: 1 });
});

test('v458 归属：工作区身份是纯空白时视为无身份（与 readPaneScope 同语义），照常认领', () => {
  const h = make03ctx({ tryStore: true });
  const t = subTree(h, SUB_SID, 'msg_t1', Object.assign({}, BRIDGE_LOCAL, { 'data-zusage-workspace-identity': '   ' }));
  assert.equal(h.api.detOwnerOf(t.box).pid, 'subagent-pane:' + SUB_SID);
  assert.equal(h.api.list().length, 1);
  assert.deepEqual(plain(h.tryCalls), [{ sid: SUB_SID, want: { workspacePath: WS_PATH } }]);
});

test('v458 绑定：注册表直绑成功后不再取租约（两条路径都拿得到时只走直绑）', () => {
  const h = make03ctx({ tryStore: true, acquireStore: true });
  const w = h.api.detOwnerOf(subTree(h, SUB_SID).box);
  assert.deepEqual(plain(h.tryCalls), [{ sid: SUB_SID, want: { workspacePath: WS_PATH } }]);
  assert.equal(h.acquired.length, 0, '直绑成功就不取租约');
  assert.deepEqual(plain(h.api.diag()), { panes: 1, bound: 1, retrying: 0 });
  assert.equal(w.store !== null, true, '观察器持有 store');
  assert.equal(w.tracker.disposed, false);
  assert.equal(h.storeOffs.length, 0);
  h.ctx.Date.now = () => 9000;
  h.api.tick();
  assert.equal(h.acquired.length, 0, '已绑定的观察器巡检时不再取租约');
  assert.equal(h.storeOffs.length, 0, '已绑定的观察器巡检时不放租约');
});

test('v458 绑定：订阅回调推送活跃轮号（productTurnId 优先），isCurrentTurn 只认该轮', () => {
  const h = make03ctx({ tryStore: true });
  const t = subTree(h, SUB_SID);
  const w = h.api.detOwnerOf(t.box);
  assert.equal(h.callbacks.length, 1);
  assert.equal(w.isCurrentTurn('msg_t2'), false);   // 未推送前恒 false（不读 store）
  h.callbacks[0]({ snapshot: { sessionId: SUB_SID, rows: { window: [
    { kind: 'turnHeader', turnId: 'db_t1', productTurnId: 'msg_t1' },
    { kind: 'turnHeader', turnId: 'db_t2', productTurnId: 'msg_t2' },
  ] } } });
  assert.equal(w.isCurrentTurn('msg_t2'), true);
  assert.equal(w.isCurrentTurn('db_t2'), false);   // productTurnId 优先
  assert.equal(w.isCurrentTurn('msg_t1'), false);
  assert.equal(w.isCurrentTurn(''), false);
});

test('v458 生命周期：订阅快照 sessionId 不符（关闭/换代）→ 整观察器撤除', () => {
  const h = make03ctx({ tryStore: true });
  const t = subTree(h, SUB_SID);
  h.api.detOwnerOf(t.box);
  h.callbacks[0]({ snapshot: { sessionId: 'sess_other', rows: { window: [] } } });
  assert.equal(h.api.list().length, 0);
  assert.equal(h.storeOffs.length, 1);   // store 租约释放
  assert.equal(h.subOffs.length, 1);     // 订阅退订
  assert.equal(h.trackerDisposes.length, 1);
  h.callbacks[0]({ snapshot: { sessionId: SUB_SID, rows: { window: [] } } });   // dead 守卫：撤除后回调静默
  assert.equal(h.api.list().length, 0);
});

const OTHER_STATE = { snapshot: { sessionId: 'sess_other', rows: { window: [] } } };
const OWN_STATE = { snapshot: { sessionId: SUB_SID, rows: { window: [] } } };

test('v458 生命周期：订阅的同步首跑身份不符 = 绑定失败——订阅、租约、tracker 当场放掉，观察器留在册 2s 后重试', () => {
  // 真实 subscribeStore 会同步先跑一次回调。拿到手的 store 若推的是别的会话的快照（注册表键串了 / 换代残留），
  // 不能把它绑到观察器上（首绑时观察器还没入册，旧实现会照常入册并记成「已绑定」）
  const opts = { tryStore: true, syncCbState: OTHER_STATE };
  const h = make03ctx(opts);
  const w = h.api.detOwnerOf(subTree(h, SUB_SID).box);            // 创建路径
  assert.equal(w.store, null, '别的会话的 store 不入册');
  assert.deepEqual(plain(h.api.diag()), { panes: 1, bound: 0, retrying: 1 });
  assert.deepEqual(h.storeOffs, [SUB_SID], '租约放掉');
  assert.equal(h.subOffs.length, 1, '订阅退订');
  assert.equal(h.trackerDisposes.length, 1, 'tracker 释放');
  h.api.tick();
  assert.equal(h.callbacks.length, 1, '未到重试点不重试');
  // 重绑路径：到点重试又拿到别的会话的 store → 同样当场放掉，继续等
  h.ctx.Date.now = () => 2500;
  h.api.tick();
  assert.deepEqual(plain(h.api.diag()), { panes: 1, bound: 0, retrying: 1 });
  assert.deepEqual(h.storeOffs, [SUB_SID, SUB_SID]);
  assert.equal(h.subOffs.length, 2);
  assert.equal(h.trackerDisposes.length, 2);
  h.api.tick();
  assert.equal(h.callbacks.length, 2, '一次巡检只重试一次');
  // 重试拿到本会话的 store → 绑定成功，此后巡检不再动它
  opts.syncCbState = OWN_STATE;
  h.ctx.Date.now = () => 5000;
  h.api.tick();
  assert.deepEqual(plain(h.api.diag()), { panes: 1, bound: 1, retrying: 0 });
  assert.equal(h.callbacks.length, 3);
  assert.equal(h.storeOffs.length, 2, '成功绑定后租约留在观察器上');
});

test('v458 生命周期：回调收到空快照（null / 无 snapshot）不抛——未入册时按绑定失败，已入册时撤除', () => {
  for (const empty of [null, {}, { snapshot: null }, { snapshot: {} }]) {
    // 首跑就空：绑定失败
    const h = make03ctx({ tryStore: true, syncCbState: empty });
    const w = h.api.detOwnerOf(subTree(h, SUB_SID).box);
    assert.equal(w.store, null, '首跑空快照：' + JSON.stringify(empty) + ' → 不入册');
    assert.deepEqual(plain(h.api.diag()), { panes: 1, bound: 0, retrying: 1 });
    assert.deepEqual(h.storeOffs, [SUB_SID]);
    assert.equal(h.subOffs.length, 1);
    assert.equal(h.trackerDisposes.length, 1);
    // 入册之后才空：按关闭/换代处理，整观察器撤除
    const h2 = make03ctx({ tryStore: true });
    h2.api.detOwnerOf(subTree(h2, SUB_SID).box);
    assert.doesNotThrow(() => h2.callbacks[0](empty));
    assert.equal(h2.api.list().length, 0, '入册后空快照：' + JSON.stringify(empty) + ' → 撤除');
    assert.deepEqual(h2.storeOffs, [SUB_SID]);
    assert.equal(h2.subOffs.length, 1);
    assert.equal(h2.trackerDisposes.length, 1);
  }
});

test('v458 绑定：拿不到退订函数（subscribeStore 返回 null）→ 租约放掉、tracker 释放、2s 重试', () => {
  const h = make03ctx({ tryStore: true, subNull: true });
  h.api.detOwnerOf(subTree(h, SUB_SID).box);
  assert.deepEqual(plain(h.api.diag()), { panes: 1, bound: 0, retrying: 1 });
  assert.deepEqual(h.storeOffs, [SUB_SID], '没有退订函数时租约仍要放掉');
  assert.equal(h.trackerDisposes.length, 1, '没有退订函数替它释放，这里兜底');
  h.api.tick();
  assert.equal(h.callbacks.length, 1, '未到重试点不重试（不是每 500ms 一次）');
  h.ctx.Date.now = () => 2500;
  h.api.tick();
  assert.equal(h.callbacks.length, 2, '到点重试');
});

test('v458 绑定：订阅时抛异常 / 桥 acquire 抛异常 / 注册表查询抛异常——绑定过程不抛，已拿到的当场放掉，2s 后重试', () => {
  // 绑定跑在 detOwnerOf 的无归属回退上（每拍扫描）：异常冒出去会打断主会话的扫描
  const h = make03ctx({ tryStore: true, subThrows: true });
  let w = null;
  assert.doesNotThrow(() => { w = h.api.detOwnerOf(subTree(h, SUB_SID).box); });
  assert.deepEqual(plain(h.api.diag()), { panes: 1, bound: 0, retrying: 1 });
  assert.deepEqual(h.storeOffs, [SUB_SID], '订阅抛异常：租约放掉');
  assert.equal(h.trackerDisposes.length, 1, '订阅抛异常：tracker 释放');
  assert.equal(w.store, null, '不带着没订上的 store 入册');
  h.api.tick();
  assert.equal(h.callbacks.length, 1, '未到重试点不重试');
  h.ctx.Date.now = () => 2500;
  assert.doesNotThrow(() => h.api.tick());
  assert.equal(h.callbacks.length, 2);
  assert.deepEqual(h.storeOffs, [SUB_SID, SUB_SID]);
  // 桥 acquire 抛异常（注册表里没有这个 store）
  const a = make03ctx({ acquireThrows: true });
  assert.doesNotThrow(() => a.api.detOwnerOf(subTree(a, SUB_SID).box));
  assert.deepEqual(plain(a.api.diag()), { panes: 1, bound: 0, retrying: 1 });
  assert.equal(a.callbacks.length, 0, '拿不到 store 就不订阅');
  a.api.tick();
  assert.equal(a.acquired.length, 1, '未到重试点不重试');
  a.ctx.Date.now = () => 2500;
  assert.doesNotThrow(() => a.api.tick());
  assert.equal(a.acquired.length, 2, '到点重试');
  // 注册表查询抛异常：不继续往下取租约
  const t = make03ctx({ tryThrows: true, acquireStore: true });
  assert.doesNotThrow(() => t.api.detOwnerOf(subTree(t, SUB_SID).box));
  assert.equal(t.acquired.length, 0, '注册表查询抛异常后不继续取租约');
  assert.deepEqual(plain(t.api.diag()), { panes: 1, bound: 0, retrying: 1 });
  t.ctx.Date.now = () => 2500;
  assert.doesNotThrow(() => t.api.tick());
  assert.equal(t.tryCalls.length, 2, '到点重试');
});

test('v458 已知限制：同一子代理会话两个窗格——观察器只跟先发现的根，另一个根不认领', () => {
  const h = make03ctx({ tryStore: true });
  const a = subTree(h, SUB_SID), b = subTree(h, SUB_SID);
  const w = h.api.detOwnerOf(a.box);
  assert.equal(w.pid, 'subagent-pane:' + SUB_SID);
  assert.equal(h.api.detOwnerOf(b.box), null);
  assert.equal(h.api.detOwnerOf(a.box), w);
  assert.equal(h.api.list().length, 1);
});

test('v458 生命周期：已撤除观察器的迟到回调静默——不会误撤同 sid 的新观察器', () => {
  // 真实 subscribeStore 退订后不再回调（closed 标志）；回调里的 dead 守卫是它之后的最后一道防线：
  // 旧观察器的回调闭包若在撤除后还被调到，不能把同 sid 的新观察器当成「换代」撤掉。
  // 两条撤除路径都验：代际清理 disposeAll、巡检时单个撤除 zuSubDetPaneDispose
  for (const how of ['disposeAll', 'tick']) {
    const h = make03ctx({ tryStore: true });
    const first = subTree(h, SUB_SID);
    const old = h.api.detOwnerOf(first.box);
    const late = h.callbacks[0];
    first.root.isConnected = false;   // 旧窗格被宿主回收
    if (how === 'disposeAll') h.api.disposeAll(); else h.api.tick();
    assert.equal(h.api.list().length, 0, how);
    assert.deepEqual(h.storeOffs, [SUB_SID], how);
    first.root.remove();
    const second = subTree(h, SUB_SID);   // 宿主重挂窗格根：同 sid 的新观察器
    const fresh = h.api.detOwnerOf(second.box);
    assert.notEqual(fresh, old, how);
    assert.equal(h.api.list().length, 1, how);
    assert.deepEqual(plain(h.api.diag()), { panes: 1, bound: 1, retrying: 0 }, how);
    late({ snapshot: { sessionId: 'sess_other', rows: { window: [] } } });   // 旧订阅迟到的、别的会话的快照
    assert.equal(h.api.list().length, 1, how + '：新观察器没被旧回调误撤');
    assert.equal(h.api.detOwnerOf(second.box), fresh, how);
    assert.deepEqual(h.storeOffs, [SUB_SID], how + '：新观察器的订阅与租约原封不动');
    late({ snapshot: { sessionId: SUB_SID, rows: { window: [{ kind: 'turnHeader', turnId: 'db_t9', productTurnId: 'msg_t9' }] } } });
    assert.equal(fresh.isCurrentTurn('msg_t9'), false, how + '：旧回调不会往新观察器里写活跃轮号');
  }
});

test('v458 生命周期：窗格根断连 → detRoot 返 null 不认领，tick 巡检撤除并释放租约', () => {
  const h = make03ctx({ tryStore: true });
  const t = subTree(h, SUB_SID);
  const w = h.api.detOwnerOf(t.box);
  t.root.isConnected = false;
  assert.equal(w.detRoot(), null);
  assert.equal(h.api.detOwnerOf(t.box), null);   // 断连后 detOwnerOf 不再认领
  h.api.tick();
  assert.equal(h.api.list().length, 0);
  assert.deepEqual(h.storeOffs, [SUB_SID]);
});

test('v458 生命周期：disposeAll 释放两个在册观察器的全部租约与 tracker', () => {
  const h = make03ctx({ tryStore: true });
  const a = subTree(h, 'sess_subagent_a'), b = subTree(h, 'sess_subagent_b');
  h.api.detOwnerOf(a.box);
  h.api.detOwnerOf(b.box);
  assert.deepEqual(plain(h.api.diag()), { panes: 2, bound: 2, retrying: 0 });
  h.api.disposeAll();
  assert.deepEqual(plain(h.api.diag()), { panes: 0, bound: 0, retrying: 0 });
  assert.deepEqual(h.storeOffs.sort(), ['sess_subagent_a', 'sess_subagent_b']);
  assert.equal(h.subOffs.length, 2);
  assert.equal(h.trackerDisposes.length, 2);
});

test('v458 存量轮：zuSubDetIsLastTurnBox 只认窗格最后一个轮 tid（嵌套同 tid 均算）', () => {
  const h = make03ctx({ tryStore: true });
  const root = new El('div', Object.assign({ 'data-session-id': SUB_SID }, BRIDGE_LOCAL));
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

/* ---------- 全链夹具：富文本请求/回执 + 观察器 + 扫描循环 + 换代清理 + sharedTick ---------- */
const CHAIN = '(function(){\n' +
  sliceOverlay('  var richTextDiag = ', '    scanDeterministicLines();\n  };', { includeEnd: true }) + '\n' +
  sliceOverlay('  /* ---------- 确定性历史行', '  function zuDiagStats(') + '\n' +
  '  function zuDiagStats() { return null; }\n' +
  sliceOverlay('  function cleanupDeterministic() {', '  /* ---------- 工具动词表') + '\n' +
  sliceOverlay('  function sharedTick() {', '  detTimer = setInterval(sharedTick, 500);') +
  '\n  detTimer = setInterval(sharedTick, 500);\n' +   // 与源码同款登记（切片止于这一句之前）
  '\nreturn { scan: scanDeterministicLines, flush: zuFlushRichTextWants, deliver: window.__zusageDeliverTurnText,' +
  ' cache: richTextCache, diag: richTextDiag, list: zuSubDetPaneList, diagSub: zuSubDetDiag,' +
  ' cleanup: cleanupDeterministic, reqs: function () { return window.__zusagePluginRequests || []; } };})()';

function makeChainctx(opts) {
  opts = opts || {};
  const body = new El('body');
  const storeOffs = [], acquired = [], intervals = [];
  let cleared = 0;
  const clock = { t: 1000 };
  const ctx = vm.createContext({
    Date: class extends Date { static now() { return clock.t; } },   // 扫描的日期对象要能 new（诊断时间戳），now 走假时钟
    window: {},
    document: { body: body, createElement: tag => new El(tag), querySelectorAll: sel => body.querySelectorAll(sel) },
    instances: [],
    stale: () => false,
    capPut: (obj, k, v) => { obj[k] = v; },
    cnUnits: () => true,
    state: { forceKmb: false, cost: 1, data: { remote_evidence: false }, rateLine: 1 },
    MY_GEN: 7, richTextRequestEpoch: 0, richTextUnitEpoch: 1,
    richTextCache: {}, richTextAttempts: {}, richTextRequestTids: {}, richTextWants: {},
    richTextOwners: new WeakMap(), richTextOwnerSeq: 0,
    FATAL: {},
    zuActiveTurnId: () => '',
    TURN_STATS: {
      createTracker: () => ({ get: tid => (opts.stats && opts.stats[tid]) || null, dispose() {} }),
      subscribeStore: () => { if (opts.subThrows) throw new Error('host store subscribe failed'); return () => {}; },
    },
    zuHasMeaningfulOutput: s => !!(s && s.outputTokens),
    zuFinalText: s => 'final:' + s.text,
    zuUnavailableText: () => 'unavailable',
    zuIsUnavailableText: t => t === 'unavailable',
    isRateLine: () => false,
    zuTryBindStore: () => (opts.tryStore ? { off: () => storeOffs.push(SUB_SID) } : null),
    zuAcquireSubStore: sid => { acquired.push(sid); return null; },
    setInterval: fn => { intervals.push(fn); return 1; },
    clearInterval: () => { cleared++; },
    JSON, console,
  });
  const api = vm.runInContext(CHAIN, ctx);
  return { ctx, api, body, storeOffs, acquired, intervals, cleared: () => cleared, clock: clock };
}

/* 子代理窗格：body > root > box…；turns = [轮号…] */
function pane(h, turns, sid) {
  sid = sid || SUB_SID;
  const root = new El('div', Object.assign({ 'data-session-id': sid }, BRIDGE_LOCAL));
  const boxes = turns.map(t => { const b = new El('section', { 'data-turn-id': t }); root.appendChild(b); return b; });
  h.body.appendChild(root);
  return { root: root, boxes: boxes };
}
const linesOf = el => el.querySelectorAll('blockquote[data-zusage-deterministic]');   // 行节点与其内的 <p> 都带该属性，只数行

test('v458 扫描旁路（行为）：两轮都没有 tracker 记录 → 只给最后一轮发带轮号的请求、此刻不插任何行；富文本到达后只在那一轮下插一行', () => {
  const h = makeChainctx();
  const t = pane(h, ['msg_t1', 'msg_t2']);
  h.api.scan();
  const reqs = h.api.reqs();
  assert.equal(reqs.length, 1, '只发一条请求');
  assert.equal(reqs[0].action, 'turn-text');
  assert.equal(reqs[0].sid, SUB_SID);
  assert.equal(reqs[0].turnRef, 'msg_t2', '页面轮号随请求下发（主桥据此精确取这一轮）');
  assert.equal(linesOf(h.body).length, 0, '富文本到达前不插占位，也不插「不可用」行');
  h.api.deliver(SUB_SID, '⚡ t2 富文本', reqs[0].unitEpoch, null);
  assert.equal(linesOf(t.boxes[0]).length, 0, '非最后一轮不出行');
  assert.equal(linesOf(t.boxes[1]).length, 1, '最后一轮恰一行');
  assert.equal(linesOf(t.boxes[1])[0].querySelector('p').textContent, '⚡ t2 富文本');
  h.api.scan();   // 最后一轮已缓存之后：非最后一轮的存量轮依旧不发请求（每拍只有一个在途槽，不能靠它掩盖）
  assert.equal(h.api.reqs().length, 1, '非最后一轮的存量轮不发请求');
  assert.equal(linesOf(t.boxes[0]).length, 0);
});

test('v458 扫描旁路（行为）：空回执（轮没结束 / 库没追上 / 旧主桥）不写缓存、任何轮都不插行，下一拍照常重试', () => {
  const h = makeChainctx();
  const t = pane(h, ['msg_t1', 'msg_t2']);
  h.api.scan();
  const first = h.api.reqs()[0];
  h.api.deliver(SUB_SID, '', first.unitEpoch, 'empty');
  assert.equal(linesOf(h.body).length, 0);
  assert.equal(Object.keys(h.api.cache).length, 0);
  assert.equal(h.api.diag.empty, 1);
  assert.equal(h.api.diag.ok, 0);
  h.api.scan();
  const again = h.api.reqs()[1];
  assert.ok(again && again.turnRef === 'msg_t2' && again.unitEpoch === first.unitEpoch, '同目标重试不换代号');
  assert.equal(linesOf(h.body).length, 0);
});

test('v458 扫描（行为）：tracker 有完成记录的轮走既有占位路径，请求同样带页面轮号', () => {
  const h = makeChainctx({ tryStore: true, stats: {
    msg_t1: { complete: true, observedLive: true, outputTokens: 10, text: 'A', sessionId: SUB_SID },
    msg_t2: { complete: true, observedLive: true, outputTokens: 20, text: 'B', sessionId: SUB_SID },
  } });
  const t = pane(h, ['msg_t1', 'msg_t2']);
  h.api.scan();
  assert.equal(linesOf(t.boxes[0])[0].querySelector('p').textContent, 'final:A');
  assert.equal(linesOf(t.boxes[1])[0].querySelector('p').textContent, 'final:B');
  assert.equal(h.api.reqs().length, 1);   // 同会话每拍只追最后一个未缓存轮（既有单槽契约）
  assert.equal(h.api.reqs()[0].turnRef, 'msg_t2');
});

test('v458 扫描（行为）：tracker 记录为进行中的轮不发请求、不插行', () => {
  const h = makeChainctx({ tryStore: true, stats: { msg_t2: { complete: false, observedLive: true, outputTokens: 5, text: 'B', sessionId: SUB_SID } } });
  const t = pane(h, ['msg_t2']);
  h.api.scan();
  assert.equal(h.api.reqs().length, 0);
  assert.equal(linesOf(h.body).length, 0);
});

test('v458 接线（行为）：主开关关闭那一拍撤行的同时释放全部观察器租约与订阅', () => {
  const h = makeChainctx({ tryStore: true });
  const t = pane(h, ['msg_t2']);
  h.api.scan();
  h.api.deliver(SUB_SID, '⚡ rich', h.api.reqs()[0].unitEpoch, null);
  assert.equal(linesOf(t.boxes[0]).length, 1);
  assert.equal(h.api.list().length, 1);
  h.ctx.state.rateLine = 0;
  h.api.scan();
  assert.equal(linesOf(h.body).length, 0);
  assert.deepEqual(plain(h.api.diagSub()), { panes: 0, bound: 0, retrying: 0 });
  assert.deepEqual(h.storeOffs, [SUB_SID]);
});

test('v458 接线（行为）：换代清理 cleanupDeterministic 释放在册观察器的全部租约', () => {
  const h = makeChainctx({ tryStore: true });
  pane(h, ['msg_t2'], SUB_SID);
  pane(h, ['msg_t2'], 'sess_subagent_b');
  h.api.scan();
  assert.deepEqual(plain(h.api.diagSub()), { panes: 2, bound: 2, retrying: 0 });
  h.api.cleanup();
  assert.deepEqual(plain(h.api.diagSub()), { panes: 0, bound: 0, retrying: 0 });
  assert.equal(h.storeOffs.length, 2);
  assert.equal(h.cleared(), 1, '扫描定时器一并清掉');
});

test('v458 接线（行为）：观察器绑定抛异常不打断扫描与 sharedTick——同拍的窗格照常发现，节拍照跑', () => {
  // 绑定挂在 detOwnerOf 的无归属回退上（每拍扫描）；异常冒出去会让文档序在后的行整拍不再处理
  const h = makeChainctx({ tryStore: true, subThrows: true });
  const a = pane(h, ['msg_t2'], SUB_SID);
  pane(h, ['msg_t2'], 'sess_subagent_b');
  assert.doesNotThrow(() => h.api.scan());
  assert.deepEqual(plain(h.api.diagSub()), { panes: 2, bound: 0, retrying: 2 });
  assert.equal(h.api.reqs().length, 2, '两个窗格的存量最后一轮照常发请求（数字按轮号取，不依赖订阅）');
  assert.deepEqual(plain(h.api.reqs().map(r => r.turnRef)), ['msg_t2', 'msg_t2']);
  h.api.deliver(SUB_SID, '⚡ 富文本 A', h.api.reqs()[0].unitEpoch, null);
  assert.equal(linesOf(a.boxes[0]).length, 1, '没绑上 store 的观察器照样出行');
  assert.doesNotThrow(() => h.intervals[0]());
  h.clock.t = 3100;
  assert.doesNotThrow(() => h.intervals[0]());   // 到重试点再试一次，仍不抛
});

test('v458 接线（行为）：sharedTick 里巡检观察器——根断连即撤除并释放租约，未绑定的到点重试', () => {
  const h = makeChainctx({ tryStore: true });
  const t = pane(h, ['msg_t2']);
  h.api.scan();
  assert.equal(h.intervals.length, 1, '扫描节拍只登记一个定时器');
  t.root.remove();   // 宿主回收窗格：根离开文档
  h.intervals[0]();
  assert.equal(h.api.list().length, 0);
  assert.deepEqual(h.storeOffs, [SUB_SID]);
  const h2 = makeChainctx({});   // 绑不上 store 的窗格
  pane(h2, ['msg_t2']);
  h2.api.scan();
  assert.equal(h2.acquired.length, 1);
  h2.clock.t = 3100;   // 过了 2s 重试点（首次尝试在 t=1000）
  h2.intervals[0]();
  assert.equal(h2.acquired.length, 2, '到点经 sharedTick 重试取租约');
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

test('v458 门控：flush 对观察器 owner 放行并入队 turn-text 请求（无 03 时不放行）', () => {
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

test('v458 门控：观察器 owner 的请求带页面轮号 turnRef，实例 owner 的请求不带', () => {
  const o = subOwnerStub();
  const h = make02ctx({ has03: true });
  wantFor(h, o, 'msg_t2');
  h.api.flush();
  assert.equal(h.api.reqs()[0].turnRef, 'msg_t2');
  const inst = make02ctx({ instances: [Object.assign(subOwnerStub(), { pid: 'workspace-main' })] });
  const i = inst.ctx.instances[0];
  i.__sub = false;
  wantFor(inst, i, 't2');
  inst.api.flush();
  assert.equal(Object.prototype.hasOwnProperty.call(inst.api.reqs()[0], 'turnRef'), false);
});

test('v458 门控：切片只装载 02（typeof 守卫走原行为）→ noInst 拦截', () => {
  const h = make02ctx({});
  const o = subOwnerStub();
  wantFor(h, o, 't2');
  h.api.flush();
  assert.equal(h.api.reqs().length, 0);
  assert.equal(h.api.diag.sent, 0);
  assert.equal(h.api.diag.noInst, 1);
});

test('v458 门控：zuSubDetHasOwner 判否的 owner 照旧 noInst 拦截', () => {
  const h = make02ctx({ has03: true });
  const o = subOwnerStub();
  delete o.__sub;   // 桩判据：无 __sub 标记 → 非观察器
  wantFor(h, o, 't2');
  h.api.flush();
  assert.equal(h.api.reqs().length, 0);
  assert.equal(h.api.diag.noInst, 1);
});

test('v458 门控：flush 的 isCurrentTurn 门对观察器 owner 短路（存量轮查询放行）', () => {
  const h = make02ctx({ has03: true });
  const o = subOwnerStub();
  o.isCurrentTurn = () => false;   // 存量轮：快照里没有它的轮头，activeTid 恒空
  wantFor(h, o, 't2');
  h.api.flush();
  assert.equal(h.api.reqs().length, 1);   // 「只发窗格最后一轮」的限定在收集端（zuSubDetIsLastTurnBox），flush 端不拦
  assert.equal(h.api.diag.notCur, 0);
  assert.equal(h.api.diag.sent, 1);
});

test('v458 门控：实例 owner 的 isCurrentTurn 门不回归（观察器短路不外溢）', () => {
  const o = subOwnerStub();
  const h = make02ctx({ instances: [o] });   // 实例路径无 03 分片
  o.isCurrentTurn = () => false;
  wantFor(h, o, 't2');
  h.api.flush();
  assert.equal(h.api.reqs().length, 0);
  assert.equal(h.api.diag.notCur, 1);   // 实例 owner 照旧被门拦
});

test('v458 门控：实例 owner 不受 typeof 守卫影响（既有路径回归保护）', () => {
  const o = subOwnerStub();
  const h = make02ctx({ instances: [o] });   // 无 03 分片：实例路径原本就放行
  wantFor(h, o, 't2');
  h.api.flush();
  assert.equal(h.api.reqs().length, 1);
  assert.equal(h.api.diag.sent, 1);
  assert.equal(h.api.diag.noInst, 0);
});

test('v458 门控：deliver 对观察器 owner 写缓存并立即重扫（ok 桶）', () => {
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

test('v458 门控：deliver 在 owner 判否时 stale 拒绝（不写缓存不重扫）', () => {
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

test('v458 源码契约：扫描循环的观察器存量轮旁路不插占位、不插「不可用」行', () => {
  // 行为由上方全链用例锁定；这里只钉「旁路分支里不出现任何占位文案调用」这条负约束
  const src = readOverlaySource();
  const i = src.indexOf('if (!stats && typeof zuSubDetHasOwner === "function" && zuSubDetHasOwner(owner))');
  assert.ok(i > 0, '观察器存量轮旁路缺失');
  const block = src.slice(i, src.indexOf('if (!stats || !stats.complete) continue;', i));
  assert.equal(block.indexOf('zuUnavailableText'), -1, '旁路绝不插「本轮统计不可用」误导行');
  assert.equal(block.indexOf('zuFinalText'), -1, '旁路绝不插 tracker 简化文案占位');
});
