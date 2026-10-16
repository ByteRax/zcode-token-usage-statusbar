const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync(path.join(__dirname, '..', 'inject-main.cjs'), 'utf8');
function harness() {
  const timers = new Map(), intervals = [], procs = [], injected = [], deliveries = [];
  const app = new EventEmitter(); app.getPath = () => '/fixture';
  let id = 0, cfg = {}, overlay = 'window.revision=1;', mtime = 1, reads = 0;
  const queue = [];   // 页面 __zusagePluginRequests 的替代：测试往这里推动作，poll 取走
  const wc = new EventEmitter(); Object.assign(wc, { id: 1, getType: () => 'window', isDestroyed: () => false,
    getURL: () => 'file:///fixture/index.html', isLoading: () => false,
    executeJavaScript: async s => {
      injected.push(s);
      if (s.includes('__zusageDeliverTurnText')) deliveries.push(s);
      if (s.includes('__zusagePluginRequests')) return queue.splice(0, 8);   // poll 每秒取走页面队列
      return s.includes('WantSids') ? '[]' : null;
    } });
  const windows = [wc];
  const spawn = () => {
    const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.stdin = new EventEmitter();
    p.stdin.writable = true; p.stdin.write = (s, cb) => { p.request = s; if (p.writeError) throw p.writeError; if (cb) cb(p.callbackError); };
    p.kill = () => { p.kills = (p.kills || 0) + 1; };
    procs.push(p); return p;
  };
  const spawnRecording = (bin, args) => { const p = spawn(); p.bin = bin; p.args = args; return p; };
  const sandbox = vm.createContext({ __dirname: '/fixture', console: { error() {} },
    process: { uptime: () => 1, platform: process.platform, resourcesPath: '/fixture', execPath: process.execPath },
    setTimeout: (fn, ms) => { timers.set(++id, { fn, ms }); return id; }, clearTimeout: n => timers.delete(n),
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return ++id; },
    require(name) {
      if (name === 'fs') return {
        readFileSync: p => p.endsWith('config.json') ? JSON.stringify(cfg) : p.endsWith('overlay.js') ? (reads++, overlay) : '',
        statSync: p => ({ mtimeMs: p.endsWith('overlay.js') ? mtime : 1 }), existsSync: () => false,
        watch: () => ({ on() {}, close() {} }), writeFileSync() {},
      };
      if (name === 'child_process') return { spawn: spawnRecording, execFile() {} };
      if (name === 'electron') return { app, webContents: { getAllWebContents: () => windows }, ipcMain: new EventEmitter() };
      if (name === './plugin-updater.cjs') return { createUpdater: () => ({ status: () => ({}), tick: async () => {}, request: async () => {} }) };
      return require(name);
    },
  });
  vm.runInContext(source, sandbox);
  const evalCode = s => vm.runInContext(s, sandbox);
  const runTimer = ms => { const entry = [...timers].find(([, t]) => t.ms === ms); assert.ok(entry, 'timer ' + ms); timers.delete(entry[0]); entry[1].fn(); };
  /* 常驻泵启动/重启也挂 15000ms 超时哨兵：取最新的那一个，正好是刚入队查询的守护计时器 */
  const runLastTimer = ms => {
    const entry = [...timers].filter(([, t]) => t.ms === ms).pop();
    assert.ok(entry, 'timer ' + ms);
    timers.delete(entry[0]);
    entry[1].fn();
  };
  const timersAt = ms => [...timers.values()].filter(t => t.ms === ms).length;
  return { timers, intervals, procs, windows, wc, app, injected, deliveries, queue, evalCode, runTimer, runLastTimer, timersAt,
    setCfg: c => { cfg = c; evalCode('cfgCache = null'); },
    setOverlay: (s, m) => { overlay = s; mtime = m; }, reads: () => reads,
    poll: () => intervals.find(t => t.ms === 1000).fn() };
}
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

test('hotreload stats before reading and accepts source only after syntax validation', async () => {
  const h = harness(); await flush();
  const reads = h.reads(); h.evalCode('hotReloadIfChanged()'); assert.equal(h.reads(), reads);
  h.setOverlay('window.revision = ;', 2); h.evalCode('hotReloadIfChanged()');
  assert.equal(h.evalCode('overlayMtime'), 1);
  h.setOverlay('window.revision=2;', 2); h.evalCode('hotReloadIfChanged()'); await flush();
  assert.equal(h.evalCode('overlayMtime'), 2);
  const injection = h.injected.find(s => s.endsWith('window.revision=2;'));
  assert.ok(injection.includes('__zusageDispose'));
  assert.ok(injection.indexOf('__zusageDispose') < injection.indexOf('window.revision=2'));
});

test('resident child error and subsequent close settle once and back off only once', async () => {
  const h = harness(); await flush(); const p = h.procs[0];
  p.emit('error', new Error('ENOENT')); p.emit('close', 1);
  assert.equal(h.evalCode('busy'), false); assert.equal(h.evalCode('pyFail'), 1);
  assert.equal([...h.timers.values()].filter(t => t.ms === 1000).length, 1);
  assert.equal([...h.timers.values()].filter(t => t.ms === 15000).length, 0);
});

test('resident stdin error settles pending request without unhandled EPIPE', async () => {
  const h = harness(); await flush(); const p = h.procs[0];
  p.stdin.emit('error', new Error('EPIPE')); p.emit('close', 1);
  assert.equal(h.evalCode('busy'), false); assert.equal(h.evalCode('pyFail'), 1);
  assert.equal([...h.timers.values()].filter(t => t.ms === 15000).length, 0);
});

test('resident timeout cannot later release a newer query or deliver stale output', async () => {
  const h = harness(); await flush(); const old = h.procs[0];
  h.runTimer(15000); assert.equal(h.evalCode('busy'), false); h.runTimer(0);
  h.evalCode('runQuery("sid_next")'); const current = h.procs[1];
  old.emit('close', 0); old.stdout.emit('data', '{"recent":[]}\n');
  assert.equal(h.evalCode('busy'), true); assert.equal(h.evalCode('pyRes.proc') === current, true);
  current.stdout.emit('data', '{"recent":[]}\n'); assert.equal(h.evalCode('busy'), false);
});

test('idle/config-off/no-window/quit stop resident and never schedule unconditional restarts', async () => {
  for (const mode of ['idle', 'config', 'window', 'quit']) {
    const h = harness(); await flush(); const p = h.procs[0];
    p.stdout.emit('data', '{"recent":[]}\n');
    if (mode === 'idle') h.runTimer(30000);
    if (mode === 'config') { h.setCfg({ resident: false, hot_reload: false }); h.intervals.find(t => t.ms === 2000).fn(); }
    if (mode === 'window') { h.windows.length = 0; h.wc.emit('destroyed'); assert.equal(h.evalCode('lastStamp'), 0); }
    if (mode === 'quit') h.app.emit('before-quit');
    p.emit('close', 0);
    assert.equal(h.evalCode('pyRes'), null, mode); assert.equal(p.kills, 1, mode);
    assert.equal([...h.timers.values()].filter(t => t.ms === 0).length, 0, mode);
  }
});

test('one-shot error/close and timeout share single settlement, preserving remote polling', async () => {
  const h = harness(); await flush(); h.evalCode('stopResident()'); h.setCfg({ resident: false });
  h.evalCode('lastHadRemote = true; runQuery("remote_sid")'); const p = h.procs.at(-1);
  assert.equal(p.request, undefined);
  p.emit('error', new Error('ENOENT')); h.evalCode('busy = true'); p.emit('close', 1);
  assert.equal(h.evalCode('busy'), true);
  assert.equal([...h.timers.values()].filter(t => t.ms === 3000).length, 1);
  h.evalCode('busy = false; runQuery("remote_sid")'); h.runTimer(15000);
  assert.equal(h.evalCode('busy'), false);
});

test('page wants reads are serialized and successful reads clear their timeout', async () => {
  const h = harness(); h.evalCode('maybeSpawn(); maybeSpawn()'); await flush();
  assert.equal(h.injected.filter(s => s.includes('var a=window.__zusageWantSids')).length, 1);
  assert.equal([...h.timers.values()].filter(t => t.ms === 1000).length, 0);
});

test('resident synchronous and callback stdin failures release busy immediately', async () => {
  for (const mode of ['writeError', 'callbackError']) {
    const h = harness(); await flush(); const p = h.procs[0];
    p.stdout.emit('data', '{"recent":[]}\n');
    p[mode] = new Error('EPIPE'); h.evalCode('runQuery("next_sid")');
    assert.equal(h.evalCode('busy'), false);
    p.emit('close', 1); assert.equal(h.evalCode('pyFail'), 1);
    assert.equal([...h.timers.values()].filter(t => t.ms === 15000).length, 0);
  }
});

test('three early resident failures fall back to one-shot without another resident', async () => {
  const h = harness(); await flush();
  for (let i = 0; i < 3; i++) {
    const p = h.procs.at(-1); p.emit('error', new Error('ENOENT')); p.emit('close', 1);
    if (i < 2) h.runTimer(i === 0 ? 1000 : 2000);
  }
  assert.equal(h.evalCode('pyFail'), 3);
  h.evalCode('runQuery("fallback_sid")');
  assert.equal(h.procs.length, 4); assert.equal(h.procs[3].request, undefined);
  h.procs[3].emit('close', 0); assert.equal(h.evalCode('busy'), false);
});

/* v75：确定性历史行的数据库富文本 —— overlay 每 2s 把 {action:'turn-text'} 推进页面
 * 队列，pollPluginRequests 每秒取走并按 session 跑一次 token_rate.py --current（纯文本
 * 模式）；不带显式 turn-id——数据库 turn_id（turn_<uuid>）和渲染器投影的 turnId/
 * productTurnId（msg_<uuid>）是两套互不相通的标识，前端查不到后者对应的数据库主键，
 * 只能复用 Hook 原本依赖的「按 session 记录的提问时刻」推断路径。结果（含空串）一律
 * 按 sid 回推请求它的那个渲染进程；不走常驻泵的 stdin 行协议。 */
test('turn-text request runs a one-shot token_rate --current query by session', async () => {
  const h = harness(); await flush();
  const before = h.procs.length;
  h.queue.push({ action: 'turn-text', sid: 'sid_a' });
  h.poll(); await flush();
  assert.equal(h.procs.length, before + 1);              // 旁路一次性 spawn，不占用常驻泵
  const p = h.procs.at(-1);
  assert.equal(p.request, undefined);                    // 未写常驻 stdin
  assert.equal(p.bin, 'python');                         // readCfgCached().python_path 缺省
  assert.equal(p.args[0], '/fixture/token_rate.py');
  assert.equal(p.args.slice(1).join(' '), '--turn --current --session sid_a');   // 纯文本模式，不带 --json/--turn-id
  const before15 = h.timersAt(15000);
  p.stdout.emit('data', '⚡ 82.6 tok/s(本轮) · 首字 1.4s\n');
  p.emit('close', 0); await flush();
  assert.equal(h.deliveries.length, 1);
  assert.ok(h.deliveries[0].includes(JSON.stringify('sid_a')));
  assert.ok(h.deliveries[0].includes(JSON.stringify('⚡ 82.6 tok/s(本轮) · 首字 1.4s')));   // trim 掉尾换行
  assert.ok(h.timersAt(15000) <= before15);   // 不再往计时器表里堆积（自己的哨兵已清）
});

test('turn-text request with a suspicious sid never spawns', async () => {
  const h = harness(); await flush();
  const before = h.procs.length;
  h.queue.push({ action: 'turn-text', sid: 'sid_a; rm -rf /' });
  h.queue.push({ action: 'turn-text', sid: 'bad id!(1)' });
  h.queue.push({ action: 'turn-text' });                 // 缺 sid：非字符串
  h.poll(); await flush();
  assert.equal(h.procs.length, before);   // 校验失败一律不 spawn，也不抛错
  assert.equal(h.deliveries.length, 0);
});

test('turn-text timeout kills the child and reports an empty result so the page can retry', async () => {
  const h = harness(); await flush();
  h.queue.push({ action: 'turn-text', sid: 'sid_a' });
  h.poll(); await flush();
  const p = h.procs.at(-1);
  h.runLastTimer(15000);                  // 本轮查询自己的守护计时器：15s 未结算 → 杀进程 + 回推空串
  assert.equal(p.kills, 1);
  await flush();
  assert.equal(h.deliveries.length, 1);
  assert.ok(h.deliveries[0].includes(JSON.stringify('')));
  p.emit('close', 0); p.stdout.emit('data', 'late\n'); await flush();
  assert.equal(h.deliveries.length, 1);   // 超时后迟到的 close 不再二次结算
});

test('turn-text child error settles once with an empty result', async () => {
  const h = harness(); await flush();
  h.queue.push({ action: 'turn-text', sid: 'sid_a' });
  h.poll(); await flush();
  const p = h.procs.at(-1);
  const before15 = h.timersAt(15000);
  p.emit('error', new Error('ENOENT')); p.emit('close', 1); await flush();
  assert.equal(h.deliveries.length, 1);
  assert.ok(h.deliveries[0].includes(JSON.stringify('')));
  assert.ok(h.timersAt(15000) <= before15);
  p.emit('close', 1); await flush();
  assert.equal(h.deliveries.length, 1);   // error 之后 close 不再结算
});
