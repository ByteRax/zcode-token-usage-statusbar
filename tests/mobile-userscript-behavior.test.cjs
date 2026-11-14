/* 接收端行为回归：运行手机传输源码，桌面 UI 用独立接口桩记录精确载荷。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const DIR = path.join(__dirname, '..', 'src', 'mobile');
const source = fs.readdirSync(DIR).filter(name => /^\d\d-.*\.js$/.test(name)).sort()
  .map(name => fs.readFileSync(path.join(DIR, name), 'utf8')).join('');
const overlayStub = `(() => {
  if (!window.__zusageMobileMode) throw new Error('mobile mode must precede activation');
  window.__overlays.installed++;
  window.__zusageOverlay = true;
  window.__zusageUpdate = data => window.__overlays.updates.push(data);
  window.__zusageDispose = () => { window.__overlays.disposed++; window.__zusageOverlay = false; };
})();`;
const script = debug => source.replace('var DEBUG_BUILD = __ZM_DEBUG__;', `var DEBUG_BUILD = ${debug};`)
  .replace('var OVERLAY_CODE = __ZM_OVERLAY_SOURCE__;', `var OVERLAY_CODE = ${JSON.stringify(overlayStub)};`)
  .replace(/\}\)\(\);\s*$/, 'window.__test = { stats, relayStates, fragMap, heartbeat, safeUrl }; })();');

function vql(value) {
  const out = [];
  do { let byte = value & 127; value = Math.floor(value / 128); if (value) byte |= 128; out.push(byte); } while (value);
  return out;
}
function encoded(body) {
  const data = Buffer.from(JSON.stringify(body));
  return Buffer.from([4, 2, 6, ...vql(204), 6, ...vql(2147483647), 5, ...vql(data.length), ...data]);
}
function harness({ stored = {}, debug = false, preexisting = false, readyState = 'complete', noBody = false } = {}) {
  let time = 100000, timerId = 0, reloads = 0;
  const timers = new Map(), elements = [], infos = [], storage = new Map(Object.entries(stored));
  const overlays = { installed: 0, updates: [], disposed: 0 };
  class Events {
    constructor() { this.events = {}; }
    addEventListener(type, fn) { (this.events[type] ||= []).push(fn); }
    removeEventListener(type, fn) { this.events[type] = (this.events[type] || []).filter(x => x !== fn); }
    emit(type, extra = {}) { for (const fn of [...(this.events[type] || [])]) fn.call(this, { currentTarget: this, target: this, ...extra }); }
    count(type) { return (this.events[type] || []).length; }
  }
  class Node extends Events {
    constructor(tag) {
      super(); this.tagName = tag; this.children = []; this.parentNode = null; this.style = {}; this.textContent = ''; this.className = '';
      elements.push(this);
    }
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      this.children.push(child); child.parentNode = this;
      if (child.tagName === 'script') vm.runInContext(child.textContent, context, { filename: 'embedded-overlay.js' });
      return child;
    }
    removeChild(child) { this.children = this.children.filter(c => c !== child); child.parentNode = null; }
  }
  class WS extends Events {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor(url, protocols) { super(); this.url = url; this.protocols = protocols; this.readyState = 1; this.sent = []; }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; this.emit('close'); }
  }
  class Worker { constructor(url, options) { this.url = url; this.options = options; } }
  const document = Object.assign(new Events(), { readyState,
    createElement: tag => new Node(tag), head: new Node('head'), body: noBody ? null : new Node('body'), documentElement: new Node('html') });
  const pageEvents = new Events();
  const FakeDate = class extends Date { static now() { return time; } };
  function setTimer(fn, delay, repeat) { const id = ++timerId; timers.set(id, { fn, delay, repeat }); return id; }
  const sandbox = { document, WebSocket: WS, Worker, SharedWorker: Worker, URL, Date: FakeDate,
    localStorage: { getItem: key => storage.has(key) ? storage.get(key) : null, setItem: (key, value) => storage.set(key, String(value)) },
    location: { href: 'https://zcode.z.ai/remote/?sid=d_device', search: '?sid=d_device', reload() { reloads++; } },
    atob: text => Buffer.from(text, 'base64').toString('binary'), console: { info: text => infos.push(text) },
    addEventListener: pageEvents.addEventListener.bind(pageEvents), removeEventListener: pageEvents.removeEventListener.bind(pageEvents),
    setInterval: (fn, delay) => setTimer(fn, delay, true), setTimeout: (fn, delay) => setTimer(fn, delay, false),
    clearInterval: id => timers.delete(id), clearTimeout: id => timers.delete(id), __overlays: overlays,
    fetch() { throw new Error('network code download forbidden'); },
  };
  sandbox.window = sandbox;
  let early;
  if (preexisting) { early = new WS('wss://example.invalid/api/v1/remote/ws2'); sandbox.__zmWSList = [early]; }
  const context = vm.createContext(sandbox);
  function inject(isDebug = debug) { vm.runInContext(script(isDebug), context, { filename: 'mobile-shards.js' }); }
  inject();
  const socket = (url = 'wss://example.invalid/api/v1/remote/ws2', protocols) => new sandbox.WebSocket(url, protocols);
  let sequence = 0;
  function part(ws, bytes, { seq, bridge = 'bridge', count = 1, index = 0 } = {}) {
    ws.emit('message', { data: JSON.stringify({ type: 'data', payload: { zcode_type: 'rpc-frame', bridgeSessionId: bridge,
      messageSeq: seq === undefined ? ++sequence : seq, fragmentCount: count, fragmentIndex: index, dataBase64: bytes.toString('base64') } }) });
  }
  const frame = (ws, body, opts = {}) => part(ws, encoded(body), opts);
  return { sandbox, document, elements, overlays, socket, frame, part, early, inject, pageEvents, timers, storage, infos, nativeWS: WS, nativeWorker: Worker,
    advance: ms => { time += ms; }, heartbeat: () => sandbox.__test.heartbeat(),
    fireTimer(delay) { for (const [id, timer] of [...timers]) if (timer.delay === delay) { if (!timer.repeat) timers.delete(id); timer.fn(); } },
    last: () => overlays.updates.at(-1), reloads: () => reloads,
    debugNodes: () => elements.filter(el => el.parentNode && /^zm-/.test(el.className)),
  };
}
const plain = value => JSON.parse(JSON.stringify(value));
function dataFrame(taskId = 's1', scopeKind = 'local', binding = 'b1', total = 42) {
  const row = { sid: taskId, total, avg_tps: 23, ...(scopeKind === 'remote' ? { remote: true } : {}) };
  return { zm: 1, ts: 100000, target: { taskId }, mine: taskId, scopeKind, binding,
    snap: { session: { ...row }, recent: [{ ...row }], today: { total: total * 2 } } };
}
const unavailable = (taskId = 's1', scopeKind = 'local', binding = 'b1') => ({ zm: 1, target: { taskId }, mine: taskId, scopeKind, binding, state: 'unavailable' });
const cap = (cfgGen = 0) => ({ zm: 1, zuUpCap: 2, cfgGen });

test('starts embedded desktop overlay in mobile waiting mode without independent UI or network', () => {
  const h = harness();
  assert.equal(h.overlays.installed, 1);
  assert.equal(h.last().mobile.state, 'waiting');
  assert.deepEqual(plain(h.last()), { session: {}, recent: [], mine: '', mobile: { taskId: '', binding: '', scopeKind: '', state: 'waiting' } });
  assert.equal(h.debugNodes().length, 0);
  assert.equal(h.elements.some(el => /zm-root|zm-bar|zm-panel/.test(el.className)), false);
  assert.equal(h.document.head.children.length, 0, 'inline script element must be removed after execution');
});

test('document-start defers desktop activation until body exists and keeps the newest pending frame', () => {
  const h = harness({ noBody: true, readyState: 'loading' }), ws = h.socket();
  assert.equal(h.overlays.installed, 0);
  h.frame(ws, dataFrame('s1')); h.frame(ws, unavailable('s2', 'remote', 'b2'));
  h.document.body = h.document.createElement('body');
  h.document.emit('DOMContentLoaded');
  assert.equal(h.overlays.installed, 1); assert.equal(h.last().mobile.state, 'unavailable');
  assert.equal(h.last().mine, 's2'); assert.equal(h.last().session.total, undefined);
  const next = harness({ noBody: true, readyState: 'loading' });
  next.document.body = next.document.createElement('body'); next.document.emit('DOMContentLoaded');
  assert.equal(next.overlays.installed, 1); assert.equal(next.last().mobile.state, 'waiting');
});

test('local, remote, unavailable and recovery use one desktop instance and target-specific payloads', () => {
  const h = harness(), ws = h.socket();
  const local = dataFrame('s1', 'local', 'b1', 123);
  h.frame(ws, local);
  assert.deepEqual(plain(h.last()), { ...local.snap, mine: 's1', mobile: { taskId: 's1', binding: 'b1', scopeKind: 'local', state: 'ready' } });
  assert.equal(local.snap.mine, undefined, 'source snapshot must not be mutated');
  h.frame(ws, dataFrame('s2', 'remote', 'b2', 456));
  assert.equal(h.last().session.total, 456); assert.equal(h.last().today.total, 912);
  assert.equal(h.last().recent[0].remote, true);
  h.frame(ws, unavailable('s2', 'remote', 'b2'));
  assert.deepEqual(plain(h.last()), { session: {}, recent: [], mine: 's2', mobile: { taskId: 's2', binding: 'b2', scopeKind: 'remote', state: 'unavailable' } });
  h.frame(ws, dataFrame('s1', 'local', 'b3', 0));
  assert.equal(h.last().session.total, 0, 'real numeric zero is preserved');
  assert.equal(h.last().today.total, 0);
  assert.equal(h.overlays.installed, 1); assert.equal(h.overlays.disposed, 0);
});

test('rejects invalid binding, mismatched target, non-unique rows, state and leaked identity', () => {
  const h = harness(), ws = h.socket();
  h.frame(ws, dataFrame());
  const last = h.last();
  const invalid = [
    { ...dataFrame(), target: null }, { ...dataFrame(), target: { taskId: '' }, mine: '' },
    { ...dataFrame(), mine: 'other' }, { ...dataFrame(), target: { taskId: 's'.repeat(129) }, mine: 's'.repeat(129) },
    { ...dataFrame(), binding: '' }, { ...dataFrame(), binding: 'ssh:server:/private' },
    { ...dataFrame(), binding: 'b'.repeat(129) }, { ...dataFrame(), scopeKind: undefined },
    { ...dataFrame(), state: 'unknown' }, { ...dataFrame(), snap: { session: { sid: 's1' }, recent: [] } },
    { ...dataFrame(), snap: { session: { sid: 's2' }, recent: [{ sid: 's1' }] } },
    { ...dataFrame(), snap: { session: { sid: 's1' }, recent: [{ sid: 's2' }] } },
    { ...dataFrame(), snap: { session: { sid: 's1' }, recent: [{ sid: 's1' }, { sid: 's1' }] } },
    { ...dataFrame(), snap: { ...dataFrame().snap, mine: 'other' } },
    { ...dataFrame(), target: { taskId: 's1', workspaceIdentity: 'remote:ssh:private' } },
    { ...dataFrame(), snap: { ...dataFrame().snap, remote_target: { identity: 'private' } } },
    { ...dataFrame(), snap: { ...dataFrame().snap, nested: [{ deep: { workspace_identity: 'private' } }] } },
    { ...dataFrame('s1', 'remote'), snap: dataFrame().snap },
    { ...dataFrame(), snap: dataFrame('s1', 'remote').snap },
  ];
  for (const body of invalid) { h.frame(ws, body); assert.equal(h.last(), last, JSON.stringify(body)); }
  h.frame(ws, { ...dataFrame(), snap: { ...dataFrame().snap, workspace_identity: '' } });
  assert.notEqual(h.last(), last, 'empty compatibility field carries no actual identity');
});

test('unavailable requires binding and rejects any attached rendering data', () => {
  const h = harness(), ws = h.socket(); h.frame(ws, dataFrame()); const last = h.last();
  for (const body of [
    { ...unavailable(), binding: undefined }, { ...unavailable(), mine: 's2' },
    { ...unavailable(), chips: [] }, { ...unavailable(), bySession: {} }, { ...unavailable(), snap: {} },
    { ...unavailable(), target: { taskId: 's1', workspaceIdentity: 'remote:server:host' } },
  ]) { h.frame(ws, body); assert.equal(h.last(), last); }
});

test('chips-only frames request desktop upgrade without manufacturing statistics', () => {
  const h = harness(), ws = h.socket();
  h.frame(ws, dataFrame());
  h.frame(ws, { zm: 1, chips: [{ id: 'win', v: '999秘密' }] });
  assert.equal(h.last().mobile.state, 'upgrade');
  assert.deepEqual(plain(h.last().recent), []); assert.deepEqual(plain(h.last().session), {});
  assert.equal(JSON.stringify(h.last()).includes('999秘密'), false);
  h.frame(ws, { zm: 1, bySession: { s2: [] }, mine: 's2', target: { taskId: 's2' }, scopeKind: 'remote' });
  assert.equal(h.last().mobile.state, 'upgrade'); assert.equal(h.last().mine, 's2');
  assert.equal(h.overlays.installed, 1);
});

test('cap announcements preserve data freshness and do not advance data order', () => {
  const h = harness(), ws = h.socket();
  h.frame(ws, dataFrame(), { seq: 1 }); const last = h.last();
  h.advance(30000); h.frame(ws, cap(), { seq: 8 });
  assert.equal(h.last(), last); assert.equal(h.sandbox.__test.stats.lastTs, 100000);
  h.frame(ws, { ...dataFrame('s2'), ts: 130000 }, { seq: 2 });
  assert.equal(h.last().mine, 's2');
});

test('late and duplicate data or unavailable cannot replace current target', () => {
  const h = harness(), ws = h.socket();
  h.frame(ws, dataFrame(), { seq: 1 });
  h.frame(ws, unavailable('s2', 'remote', 'b2'), { seq: 3 }); const last = h.last();
  h.frame(ws, dataFrame(), { seq: 2 }); h.frame(ws, dataFrame(), { seq: 3 });
  assert.equal(h.last(), last);
  h.frame(ws, dataFrame('s2', 'remote', 'b2'), { seq: 5 }); const current = h.last();
  h.frame(ws, unavailable(), { seq: 4 }); assert.equal(h.last(), current);
});

test('late fragment completion cannot restore prior data; fragment order can be reversed', () => {
  const h = harness(), ws = h.socket();
  const bytes = encoded(dataFrame('obsolete')), mid = Math.floor(bytes.length / 2);
  h.part(ws, bytes.subarray(mid), { seq: 2, count: 2, index: 1 });
  h.frame(ws, unavailable('s3'), { seq: 3 });
  h.part(ws, bytes.subarray(0, mid), { seq: 2, count: 2, index: 0 });
  assert.equal(h.last().mine, 's3'); assert.equal(h.last().mobile.state, 'unavailable');
  const next = encoded(dataFrame('s4')), cut = Math.floor(next.length / 2);
  h.part(ws, next.subarray(cut), { seq: 4, count: 2, index: 1 });
  h.part(ws, next.subarray(0, cut), { seq: 4, count: 2, index: 0 });
  assert.equal(h.last().mine, 's4');
});

test('bridge replacement retires old data and fragments without capability announcements changing the bridge', () => {
  const h = harness(), ws = h.socket();
  h.frame(ws, dataFrame('old'), { bridge: 'old-bridge', seq: 1 });
  const bytes = encoded(dataFrame('old-late')), mid = Math.floor(bytes.length / 2);
  h.part(ws, bytes.subarray(0, mid), { bridge: 'old-bridge', seq: 2, count: 2, index: 0 });
  h.frame(ws, cap(), { bridge: 'announcement-only', seq: 100 });
  h.frame(ws, dataFrame('old-still-current'), { bridge: 'old-bridge', seq: 3 });
  assert.equal(h.last().mine, 'old-still-current', 'capability cannot retire the legitimate data bridge');
  h.frame(ws, dataFrame('new'), { bridge: 'new-bridge', seq: 1 });
  const latest = h.last();
  assert.equal(h.sandbox.__test.fragMap.has(ws), false, 'accepted replacement clears every pending fragment on this socket');
  h.part(ws, bytes.subarray(mid), { bridge: 'old-bridge', seq: 2, count: 2, index: 1 });
  h.frame(ws, dataFrame('old-higher-seq'), { bridge: 'old-bridge', seq: 1000 });
  h.frame(ws, unavailable('old'), { bridge: 'old-bridge', seq: 1001 });
  assert.equal(h.last(), latest, 'retired bridge cannot revive with fragments or a higher sequence');
  assert.equal(h.sandbox.__test.fragMap.has(ws), false, 'retired fragments cannot allocate pending state again');
  h.frame(ws, dataFrame('new-next'), { bridge: 'new-bridge', seq: 2 });
  assert.equal(h.last().mine, 'new-next');
});

test('old bridge seq2 completing after new bridge seq1 cannot revive old ready data', () => {
  const h = harness(), ws = h.socket();
  h.frame(ws, dataFrame('old'), { bridge: 'old-bridge', seq: 1 });
  const bytes = encoded(dataFrame('old')), mid = Math.floor(bytes.length / 2);
  h.part(ws, bytes.subarray(0, mid), { bridge: 'old-bridge', seq: 2, count: 2, index: 0 });
  h.frame(ws, dataFrame('new'), { bridge: 'new-bridge', seq: 1 });
  h.part(ws, bytes.subarray(mid), { bridge: 'old-bridge', seq: 2, count: 2, index: 1 });
  assert.equal(h.last().mine, 'new');
});

test('newer socket data retires older socket data and partial frames even after current closes', () => {
  const h = harness(), old = h.socket();
  h.frame(old, dataFrame('old'), { seq: 1 });
  const bytes = encoded(dataFrame('old-late')), mid = Math.floor(bytes.length / 2);
  h.part(old, bytes.subarray(0, mid), { seq: 2, count: 2, index: 0 });
  const current = h.socket();
  h.frame(current, cap(), { bridge: 'cap-bridge', seq: 500 });
  h.frame(old, dataFrame('old-still-live'), { seq: 3 });
  assert.equal(h.last().mine, 'old-still-live', 'new socket capability alone cannot take over');
  h.frame(current, dataFrame('new'), { seq: 1 });
  const latest = h.last();
  assert.equal(h.sandbox.__test.fragMap.has(old), false);
  h.part(old, bytes.subarray(mid), { seq: 2, count: 2, index: 1 });
  h.frame(old, dataFrame('old-revived'), { bridge: 'old-new-bridge', seq: 1000 });
  h.frame(old, unavailable('old'), { seq: 1001 });
  assert.equal(h.last(), latest);
  current.close(); const waiting = h.last();
  h.frame(old, dataFrame('old-after-close'), { bridge: 'another-old-bridge', seq: 2000 });
  assert.equal(h.last(), waiting, 'closing current source cannot revive an obsolete socket');
  const next = h.socket(); h.frame(next, dataFrame('newest'), { seq: 1 });
  assert.equal(h.last().mine, 'newest');
});

test('older socket first data cannot replace a newer active source', () => {
  const h = harness(), old = h.socket(), current = h.socket();
  h.frame(current, dataFrame('current'), { seq: 1 }); const latest = h.last();
  h.frame(old, dataFrame('late-first-old'), { seq: 99 });
  assert.equal(h.last(), latest);
});

test('ready expires after 30 seconds without accepted data and capability cannot extend its lifetime', () => {
  const h = harness(), ws = h.socket();
  h.frame(ws, dataFrame('s1', 'remote', 'fresh-binding', 777), { seq: 1 });
  const ready = h.last();
  h.advance(30000); h.heartbeat(); assert.equal(h.last(), ready, 'exactly 30 seconds remains within the data lifetime');
  h.frame(ws, cap(), { bridge: 'cap-only', seq: 100 });
  h.frame(ws, dataFrame('duplicate'), { seq: 1 });
  h.advance(1); h.heartbeat();
  assert.equal(h.last().mobile.state, 'unavailable');
  assert.equal(h.last().mobile.taskId, 's1'); assert.equal(h.last().mobile.binding, 'fresh-binding');
  assert.deepEqual(plain(h.last().recent), []); assert.deepEqual(plain(h.last().session), {});
  assert.equal(h.last().today, undefined); assert.equal(h.sandbox.__test.stats.lastTs, 100000);
  const expired = h.last(), count = h.overlays.updates.length;
  h.frame(ws, cap(1), { bridge: 'cap-only', seq: 101 }); h.advance(10000); h.heartbeat();
  assert.equal(h.last(), expired); assert.equal(h.overlays.updates.length, count, 'empty state is delivered only once');
  h.frame(ws, { ...dataFrame('s1', 'remote', 'fresh-binding', 123), ts: 140001 }, { seq: 2 });
  assert.equal(h.last().mobile.state, 'ready'); assert.equal(h.last().today.total, 246);
  assert.equal(h.overlays.installed, 1, 'expiry and recovery reuse the same desktop overlay');
});

test('expired body timestamp with a higher sequence cannot revive ready or extend data freshness', () => {
  const h = harness(), ws = h.socket();
  h.frame(ws, dataFrame('s1', 'local', 'same-binding'), { seq: 1 });
  h.advance(30001); h.heartbeat(); const expired = h.last();
  h.frame(ws, dataFrame('old-but-higher', 'local', 'same-binding'), { seq: 1000 });
  assert.equal(h.last(), expired); assert.equal(h.sandbox.__test.stats.lastTs, 100000);
  h.frame(ws, { ...dataFrame('s1', 'local', 'same-binding', 24), ts: 130001 }, { seq: 2 });
  assert.equal(h.last().mobile.state, 'ready'); assert.equal(h.last().session.total, 24);
  assert.equal(h.last().mobile.binding, 'same-binding', 'fresh data may recover with the same binding');
});

test('stale ready cannot replace a live bridge and arrival does not reset the timestamp lifetime', () => {
  const h = harness(), ws = h.socket();
  h.frame(ws, dataFrame('live'), { bridge: 'live-bridge', seq: 1 });
  h.frame(ws, { ...dataFrame('stale-other'), ts: 69999 }, { bridge: 'other-bridge', seq: 50 });
  assert.equal(h.last().mine, 'live');
  h.frame(ws, dataFrame('live-next'), { bridge: 'live-bridge', seq: 2 });
  assert.equal(h.last().mine, 'live-next');
  h.frame(ws, { ...dataFrame('slightly-delayed'), ts: 71000 }, { bridge: 'live-bridge', seq: 3 });
  h.advance(1001); h.heartbeat();
  assert.equal(h.last().mobile.state, 'unavailable', 'a 29-second-old frame has only one second of lifetime left');
});

test('late DOM activation never delivers a ready snapshot older than 30 seconds', () => {
  const h = harness({ noBody: true, readyState: 'loading' }), ws = h.socket();
  h.frame(ws, dataFrame()); h.advance(30001);
  h.document.body = h.document.createElement('body'); h.document.emit('DOMContentLoaded');
  assert.equal(h.last().mobile.state, 'unavailable'); assert.deepEqual(plain(h.last().recent), []);
});

test('fragments belong to each socket, expire and disappear on close', () => {
  const h = harness(), a = h.socket(), b = h.socket();
  const bytes = encoded(dataFrame('s2')), mid = Math.floor(bytes.length / 2);
  h.part(a, bytes.subarray(0, mid), { seq: 7, count: 2, index: 0 });
  h.part(b, bytes.subarray(mid), { seq: 7, count: 2, index: 1 });
  assert.equal(h.last().mobile.state, 'waiting'); assert.equal(h.sandbox.__test.fragMap.size, 2);
  a.close(); assert.equal(h.sandbox.__test.fragMap.size, 1);
  h.part(b, bytes.subarray(0, mid), { seq: 7, count: 2, index: 0 }); assert.equal(h.last().mine, 's2');
  h.part(b, bytes.subarray(0, mid), { seq: 8, count: 2, index: 0 });
  h.advance(60001); h.heartbeat(); assert.equal(h.sandbox.__test.fragMap.size, 0);
});

test('capability, acknowledgements, rollback and retry belong to the same socket', () => {
  const h = harness(), a = h.socket(), b = h.socket();
  h.heartbeat(); assert.equal(a.sent.length, 0); assert.equal(b.sent.length, 0);
  h.frame(a, cap()); assert.equal(a.sent.length, 1); assert.equal(b.sent.length, 0);
  h.advance(31000); h.heartbeat(); assert.equal(a.sent[1].payload.zuCfg.gen, 1);
  h.frame(a, cap(1)); h.frame(a, cap(0)); assert.equal(a.sent[2].payload.zuCfg.gen, 2);
  h.frame(a, cap(0)); assert.equal(a.sent.length, 3, 'same rollback must not flood');
  h.frame(b, cap(5)); assert.equal(b.sent[0].payload.zuCfg.gen, 6);
  a.close(); assert.equal(h.sandbox.__test.relayStates.has(a), false);
  assert.equal(h.sandbox.__zmWSList.includes(a), false);
  h.advance(31000); h.heartbeat(); assert.equal(a.sent.length, 3); assert.equal(b.sent.length, 2);
});

test('desktop preferences converge only on capable sockets and newer generations replace pending ones', () => {
  const h = harness(), a = h.socket(), b = h.socket();
  h.frame(a, cap());
  h.sandbox.localStorage.setItem('zusage3.show', '{"win":0}'); h.heartbeat();
  assert.equal(a.sent[1].payload.zuCfg.prefs.show, '{"win":0}'); assert.equal(b.sent.length, 0);
  h.heartbeat(); assert.equal(a.sent.length, 2);
  h.sandbox.localStorage.setItem('zusage3.theme', 'pill'); h.heartbeat();
  assert.deepEqual(a.sent.map(x => x.payload.zuCfg.gen), [1, 2, 3]);
  h.frame(a, cap(1)); h.advance(46000);
  h.sandbox.localStorage.setItem('zusage3.lang', 'en'); h.heartbeat(); assert.equal(a.sent.length, 3);
  h.frame(a, cap()); assert.equal(a.sent[3].payload.zuCfg.gen, 4); assert.equal(a.sent[3].payload.zuCfg.prefs.lang, 'en');
  h.frame(b, cap()); assert.equal(b.sent[0].payload.zuCfg.prefs.theme, 'pill');
});

test('legacy preferences migrate only to missing desktop keys and retain unknown values', () => {
  const legacy = '{"show":{"win":false},"theme":"pill","just":"start","lang":"en","unknown":"keep"}';
  const h = harness({ stored: { zusageMobilePrefs: legacy } }), ws = h.socket();
  h.frame(ws, cap()); const prefs = ws.sent[0].payload.zuCfg.prefs;
  assert.equal(JSON.parse(prefs.show).win, false); assert.equal(prefs.theme, 'pill');
  assert.equal(prefs.just, 'start'); assert.equal(prefs.lang, 'en');
  assert.equal(h.storage.get('zusageMobilePrefs'), legacy);
  const existing = harness({ stored: { zusageMobilePrefs: legacy, 'zusage3.show': '{"win":1}', 'zusage3.theme': 'default', 'zusage3.barJust': 'end', 'zusage3.lang': 'zh' } });
  const other = existing.socket(); existing.frame(other, cap()); const current = other.sent[0].payload.zuCfg.prefs;
  assert.equal(JSON.parse(current.show).win, 1); assert.equal(current.theme, 'default');
  assert.equal(current.just, 'end'); assert.equal(current.lang, 'zh');
});

test('duplicate injection reuses early sockets, cleans resources and requires fresh capability', () => {
  const h = harness({ preexisting: true }), ws = h.early;
  const list = h.sandbox.__zmWSList;
  h.frame(ws, cap()); h.frame(ws, dataFrame());
  assert.equal(ws.count('message'), 1); assert.equal(ws.count('close'), 1); assert.equal(h.timers.size, 2);
  const previous = h.sandbox.__test;
  h.inject();
  assert.equal(h.overlays.installed, 2); assert.equal(h.overlays.disposed, 1);
  assert.equal(h.last().mobile.state, 'waiting'); assert.equal(h.sandbox.__zmWSList, list);
  assert.equal(ws.count('message'), 1); assert.equal(ws.count('close'), 1); assert.equal(h.timers.size, 2);
  h.heartbeat(); assert.equal(ws.sent.length, 1, 'new generation cannot reuse capability');
  h.frame(ws, dataFrame('s2')); assert.equal(h.last().mine, 's2');
  assert.equal(previous.stats.magicFrames, 2, 'old consumer must remain inactive');
  h.frame(ws, cap()); assert.equal(ws.sent.length, 2);
  h.sandbox.__zmDispose();
  assert.equal(ws.count('message'), 0); assert.equal(ws.count('close'), 0); assert.equal(h.timers.size, 0);
  assert.equal(h.pageEvents.count('pagehide'), 0); assert.equal(h.pageEvents.count('pageshow'), 0);
  assert.equal(h.document.count('DOMContentLoaded'), 0); assert.equal(h.sandbox.WebSocket, h.nativeWS);
  assert.equal(ws.readyState, 1); assert.equal(list.includes(ws), true); assert.equal(h.sandbox.__zusageMobileMode, undefined);
});

test('pagehide suspends consumers and bfcache pageshow restores them once', () => {
  const h = harness({ preexisting: true }), ws = h.early;
  h.frame(ws, cap()); h.frame(ws, dataFrame());
  h.pageEvents.emit('pagehide'); assert.equal(h.timers.size, 0); assert.equal(ws.count('message'), 0);
  h.pageEvents.emit('pageshow', { persisted: true });
  assert.equal(h.last().mobile.state, 'waiting'); assert.equal(ws.count('message'), 1);
  assert.equal(h.timers.size, 2); h.heartbeat(); assert.equal(ws.sent.length, 1);
  const afterResume = h.socket(); assert.equal(afterResume instanceof h.nativeWS, true); assert.equal(afterResume.count('message'), 1);
  h.pageEvents.emit('pageshow', { persisted: true }); assert.equal(ws.count('message'), 1);
  h.sandbox.__zmDispose(); h.pageEvents.emit('pageshow', { persisted: true }); assert.equal(h.timers.size, 0);
});

test('socket close clears displayed data and removes the consumer without closing other sockets', () => {
  const h = harness(), a = h.socket(), b = h.socket();
  h.frame(a, dataFrame()); a.close(); assert.equal(h.last().mobile.state, 'waiting');
  assert.deepEqual(plain(h.last().recent), []); assert.equal(a.count('close'), 0); assert.equal(a.count('message'), 0);
  assert.equal(b.readyState, 1); h.frame(b, dataFrame('s2')); assert.equal(h.last().mine, 's2');
});

test('diagnostic URLs omit userinfo, query, fragment and never trigger an automatic refresh', () => {
  const h = harness({ debug: true });
  const ws = h.socket('wss://user:secret@example.invalid/api/v1/remote/ws2?token=supersecret#fragment', ['p']);
  assert.equal(ws instanceof h.nativeWS, true); assert.deepEqual(ws.protocols, ['p']);
  new h.sandbox.Worker('https://worker:password@example.invalid/js/worker.js?key=secret#tail');
  new h.sandbox.SharedWorker('https://shared:password@example.invalid/js/shared.js?key=secret#tail');
  const dbg = h.debugNodes().find(el => el.className === 'zm-dbg'); h.heartbeat();
  assert.match(dbg.textContent, /wss:\/\/example.invalid\/api\/v1\/remote\/ws2/);
  assert.doesNotMatch(dbg.textContent, /user:|secret|token=|#fragment|password|key=/);
  assert.equal(h.sandbox.__test.safeUrl('data:text/javascript,password'), '[非网络 URL]');
  ws.close(); h.fireTimer(8000); assert.match(dbg.textContent, /请手动刷新页面/); assert.equal(h.reloads(), 0);
  h.sandbox.__zmDispose(); assert.equal(h.debugNodes().length, 0); assert.equal(h.sandbox.Worker, h.nativeWorker);
});

test('formal script creates no diagnostic nodes or styles and emits manual refresh guidance', () => {
  const h = harness(); h.fireTimer(8000);
  assert.equal(h.debugNodes().length, 0); assert.equal(h.document.head.children.length, 0);
  assert.equal(h.sandbox.Worker, h.nativeWorker); assert.equal(h.reloads(), 0);
  assert.match(h.infos[0], /请手动刷新页面/); assert.equal(h.last().mobile.state, 'waiting');
});
