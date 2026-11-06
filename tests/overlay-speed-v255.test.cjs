const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

// v255：修复「生成速度 Tooltip 有时新、有时旧」——一次性 json 回退帧缺
// speed_history 时整卡闪回旧版。验证渲染端粘性轮表与 compact chip 的 V2 接线。
const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');

function stickyCtx() {
  const ctx = vm.createContext({ window: {} });
  vm.runInContext(
    'var state={data:null},instances=[],lastSpeedHistory=null,FATAL={};' +
      'function stale(){return false}' +
      source.slice(source.indexOf('  window.__zusageUpdate = function (d) {'),
        source.indexOf('  window.__zusagePluginRequests = [];')) +
      'var remoteTodayCache={};',
    ctx,
  );
  return ctx;
}

test('a snapshot with speed_history is remembered for later frames without it', () => {
  const ctx = stickyCtx();
  const h = { turns: [{ t: 1 }], sids: ['s1'], snames: ['a'], pids: [['p', 'P']], mnames: [] };
  ctx.window.__zusageUpdate({ speed_history: h, session: {} });
  const first = ctx.state.data.speed_history;
  ctx.window.__zusageUpdate({ session: {}, last_turn: {} });
  assert.equal(ctx.state.data.speed_history, first,
    'serve 重启/空闲回收的缺字段帧不得让 V2 闪回旧版整卡');
});

test('a fresh full history replaces the sticky one (no stale data)', () => {
  const ctx = stickyCtx();
  const h1 = { turns: [{ t: 1 }] };
  const h2 = { turns: [{ t: 2 }, { t: 3 }] };
  ctx.window.__zusageUpdate({ speed_history: h1 });
  ctx.window.__zusageUpdate({ speed_history: h2 });
  assert.equal(ctx.state.data.speed_history, h2);
  ctx.window.__zusageUpdate({});
  assert.equal(ctx.state.data.speed_history.turns.length, 2);
});

test('empty history never becomes a sticky V2 frame', () => {
  const ctx = stickyCtx();
  ctx.window.__zusageUpdate({ speed_history: { turns: [] } });
  ctx.window.__zusageUpdate({});
  assert.equal(ctx.state.data.speed_history, undefined,
    '空轮表不粘性，避免把「无数据」冒充 V2 历史');
});

// v262 根因回归：实例 spawn 首渲染/桥空窗的空对象兜底 render 不得抹掉共享轮表。
// render 在 spawnInstance 闭包内、行为夹具不可达（spdRender 铁证：无条件 state.data = d
// 让 hover 瞬间整条渲染读不到 speed_history，走 fb-html 旧卡），按项目先例锁结构。
test('render() guards shared state.data against bare fallback frames (v262)', () => {
  const start = source.indexOf('    function render(d) {');
  const seg = source.slice(start, start + 700);
  assert.match(seg, /if \(d && d\.session && d\.session\.sid\) state\.data = d;/,
    'render 条件写：只有真实快照帧（带会话 sid）才更新共享数据');
  assert.ok(!/function render\(d\) \{\s*state\.data = d;/.test(seg),
    'render 首行不得盲写 state.data（空对象兜底会抹掉轮表）');
});

// compact chip：V2 整卡由 tpsChipTipHTML 经 spdRebuildOr 生成，不再恒走旧 speedCardHTML。
test('compact tps chip tip routes to the V2 card when history is present', () => {
  const fn = source.slice(source.indexOf('    function tpsChipTipHTML(t) {'),
    source.indexOf('      /* 状态条摘要'));
  assert.match(fn, /spdRebuildOr\(t && t\.speedHistory/,
    '精简 chip 必须用统一轮表走 V2，而不是无条件调用旧 speedCardHTML');
  assert.match(fn, /if \(cv2\) return cv2\(/,
    'V2 生成成功时直接返回整卡，不追加旧状态条摘要');
});

test('tpsTip has V2 tab / dimension / bar hover delegation without extra global listeners', () => {
  const block = source.slice(source.indexOf('  var tpsTip = document.createElement("div");'),
    source.indexOf('  var TPS_HIDE_DELAY_MS'));
  assert.match(block, /\.zu-sv-tab/);
  assert.match(block, /\.zu-sv-dimsel/);
  assert.match(block, /\.zu-sc-col/);
  assert.match(block, /function tpsSpeedPick/);
});
