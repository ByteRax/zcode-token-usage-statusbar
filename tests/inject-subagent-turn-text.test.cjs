const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { getInjectSlice } = require('./helpers/overlay-extract.cjs');

// v458 子代理统计行（specs/subagent-turn-stats-line.md 规则 5）：主桥 queryTurnText 对
// sess_subagent_* 前缀 sid 去掉 --current（走 token_rate latestTurn）——hook 只给用户提问
// 记 promptTs，子会话带 --current 必然 fail-closed 空输出。sess_dwf-* 不在子代理前缀内，
// 维持 --current；sid 边界与主渲染端 zuSubDetEnsure 同款正则（后缀 ≤72）。

function harness(opts) {
  opts = opts || {};
  const spawned = [], delivered = [];
  const wc = { isDestroyed: () => false, executeJavaScript: code => { delivered.push(code); return Promise.resolve(); } };
  const ctx = vm.createContext({
    JSON, Buffer, console,
    TOKEN_RATE: '/pkg/token_rate.py',
    readCfgCached: () => ({ python_path: 'python3' }),
    LOG: () => {},
    isLocalHostPage: () => true,
    spawn: (cmd, args, o) => {
      spawned.push({ cmd: cmd, args: args, opts: o });
      return {
        stdout: { on() {} }, stderr: { on() {} }, kill() {},
        on(ev, cb) { if (ev === 'close') setImmediate(() => cb(opts.code === undefined ? 0 : opts.code)); },
      };
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
  const fn = vm.runInContext(getInjectSlice('turnTextQuery') + '\nqueryTurnText', ctx);
  return { fn, wc, spawned, delivered };
}

const argsOf = h => h.spawned[0].args;

test('v458 主桥：子代理 sid 的 spawn 参数形如 --turn --session <sid>（无 --current）', () => {
  const h = harness();
  h.fn('sess_subagent_abc12', h.wc);
  const args = argsOf(h);
  assert.equal(args[0], '/pkg/token_rate.py');
  assert.equal(args[1], '--turn');
  assert.equal(args.includes('--current'), false);
  assert.equal(args[args.indexOf('--session') + 1], 'sess_subagent_abc12');
});

test('v458 主桥：主会话 sid 保留 --current（既有口径不回归）', () => {
  const h = harness();
  h.fn('sess_main1', h.wc);
  const args = argsOf(h);
  assert.equal(args[2], '--current');   // 紧跟 --turn
  assert.equal(args[args.indexOf('--session') + 1], 'sess_main1');
});

test('v458 主桥：sess_dwf-* 工作流 actor 不在子代理前缀内，仍带 --current', () => {
  const h = harness();
  h.fn('sess_dwf-xyz', h.wc);
  assert.equal(argsOf(h).includes('--current'), true);
});

test('v458 主桥：sid 长度门与前缀正则的交界（外层 80 字符总长门先于前缀分支）', () => {
  // 总长 ≤80 的子代理 sid（后缀 ≤66）正常 spawn 且无 --current
  const ok = harness();
  ok.fn('sess_subagent_' + 'a'.repeat(66), ok.wc);
  assert.equal(ok.spawned.length, 1);
  assert.equal(argsOf(ok).includes('--current'), false);
  // 后缀 67（总长 81）先被外层 sid 门整单拒绝：不 spawn、不回推（与前缀分支无关）
  const long = harness();
  long.fn('sess_subagent_' + 'a'.repeat(67), long.wc);
  assert.equal(long.spawned.length, 0);
});

test('v458 主桥：cn/forceKmb/noCost 开关在子代理分支同样透传', () => {
  const h = harness();
  h.fn('sess_subagent_x', h.wc, true, true, null, true);
  const args = argsOf(h);
  assert.equal(args.includes('--no-cn-units'), true);
  assert.equal(args.includes('--force-kmb'), true);
  assert.equal(args.includes('--no-cost'), true);
  assert.equal(args.includes('--current'), false);
});

test('v458 主桥：子会话查空（库未追上）仍按 empty 原因回推（冷文件降级不破损）', async () => {
  const h = harness({ code: 0 });
  h.fn('sess_subagent_x', h.wc);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(h.delivered.length, 1);
  assert.ok(h.delivered[0].indexOf('__zusageDeliverTurnText') > 0);
  assert.ok(h.delivered[0].indexOf('"empty"') > 0);
});
