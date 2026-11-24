const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { getInjectSlice, readInjectSource } = require('./helpers/overlay-extract.cjs');

// v458 子代理统计行（specs/subagent-turn-stats-line.md 规则 5）：主桥 queryTurnText 对
// sess_subagent_* 前缀 sid 且带 turnRef（窗格里这一轮的页面轮号）的请求改走
// token_rate --turn-ref——按轮号只认这一轮、轮已结束才出数。没有 turnRef 的子代理 sid、
// sess_dwf-* 与其它 sid 一律维持 --current 口径（hook 只给用户提问记 promptTs，子会话带
// --current 必然 fail-closed 空输出，但绝不会取到别的轮）。sid 边界与主渲染端
// zuSubDetEnsure 同款正则（后缀 ≤72）；turnRef 与 sid 同一套字符白名单、长度 ≤80。

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
const val = (args, name) => args[args.indexOf(name) + 1];
/* 调用形参与主进程处理器一致：queryTurnText(sid, wc, cn===0, forceKmb, unitEpoch, cost===0, turnRef) */
const call = (h, sid, turnRef) => h.fn(sid, h.wc, false, false, '7:1', false, turnRef);

test('v458 主桥：子代理 sid 带页面轮号 → --turn --turn-ref <轮号> --session <sid>（不带 --current）', () => {
  const h = harness();
  call(h, 'sess_subagent_abc12', 'msg_mwt9w9x9_9');
  const args = argsOf(h);
  assert.equal(args[0], '/pkg/token_rate.py');
  assert.equal(args[1], '--turn');
  assert.equal(args.includes('--current'), false);
  assert.equal(val(args, '--turn-ref'), 'msg_mwt9w9x9_9');
  assert.equal(val(args, '--session'), 'sess_subagent_abc12');
  // 格式上界：80 字符放行；首字符是下划线或数字也放行（真库轮号是 msg_ 开头，规则只禁首字符 -）
  for (const ok of ['a'.repeat(80), '_msg_1', '9']) {
    const k = harness();
    call(k, 'sess_subagent_abc12', ok);
    assert.equal(k.spawned.length, 1, ok);
    assert.equal(argsOf(k).includes('--turn-ref'), true, ok);
    assert.equal(argsOf(k).includes('--current'), false, ok);
  }
});

test('v458 主桥：子代理 sid 不带轮号 → 维持 --current（不按会话取「最新一轮」，宁可不出行）', () => {
  for (const ref of [undefined, null, '']) {
    const h = harness();
    call(h, 'sess_subagent_abc12', ref);
    const args = argsOf(h);
    assert.equal(args.includes('--current'), true, String(ref));
    assert.equal(args.includes('--turn-ref'), false, String(ref));
  }
});

test('v458 主桥：非法轮号（空白 / 控制字符 / 超长 / 以 - 开头 / 非字符串）不进 --turn-ref', () => {
  for (const ref of ['msg 1', 'msg\n1', 'a'.repeat(81), '-x', '--json', 42, { id: 'msg_1' }, true]) {
    const h = harness();
    call(h, 'sess_subagent_abc12', ref);
    const args = argsOf(h);
    assert.equal(args.includes('--current'), true, String(ref));
    assert.equal(args.includes('--turn-ref'), false, String(ref));
  }
});

test('v458 主桥：主会话 sid 即使带轮号也保留 --current（既有口径不回归）', () => {
  const h = harness();
  call(h, 'sess_main1', 'msg_mwt9w9x9_9');
  const args = argsOf(h);
  assert.equal(args[2], '--current');   // 紧跟 --turn
  assert.equal(args.includes('--turn-ref'), false);
  assert.equal(val(args, '--session'), 'sess_main1');
});

test('v458 主桥：sess_dwf-* 与 sess_subagentfoo（无下划线）不在子代理前缀内，带轮号也仍带 --current', () => {
  for (const sid of ['sess_dwf-xyz', 'sess_subagentfoo']) {
    const h = harness();
    call(h, sid, 'msg_1');
    const args = argsOf(h);
    assert.equal(args.includes('--current'), true, sid);
    assert.equal(args.includes('--turn-ref'), false, sid);
  }
});

test('v458 主桥：外层 sid 总长门 80 字符（超出整单拒绝：不 spawn、不回推）', () => {
  // 总长 ≤80 的子代理 sid 正常 spawn
  const ok = harness();
  call(ok, 'sess_subagent_' + 'a'.repeat(66), 'msg_1');
  assert.equal(ok.spawned.length, 1);
  assert.equal(argsOf(ok).includes('--turn-ref'), true);
  // 总长 81：整单拒绝（与前缀分支无关）
  const long = harness();
  call(long, 'sess_subagent_' + 'a'.repeat(67), 'msg_1');
  assert.equal(long.spawned.length, 0);
  assert.equal(long.delivered.length, 0);
});

test('v458 主桥：cn/forceKmb/noCost 开关在轮号分支同样透传', () => {
  const h = harness();
  h.fn('sess_subagent_x', h.wc, true, true, null, true, 'msg_1');
  const args = argsOf(h);
  assert.equal(args.includes('--no-cn-units'), true);
  assert.equal(args.includes('--force-kmb'), true);
  assert.equal(args.includes('--no-cost'), true);
  assert.equal(args.includes('--current'), false);
  assert.equal(val(args, '--turn-ref'), 'msg_1');
});

test('v458 主桥：子会话查空（轮没结束 / 库未追上）仍按 empty 原因回推，回推只带 sid 不带轮号明文', async () => {
  const h = harness({ code: 0 });
  call(h, 'sess_subagent_x', 'msg_t2');
  await new Promise(r => setTimeout(r, 20));
  assert.equal(h.delivered.length, 1);
  assert.ok(h.delivered[0].indexOf('__zusageDeliverTurnText') > 0);
  assert.ok(h.delivered[0].indexOf('"empty"') > 0);
  assert.equal(h.delivered[0].indexOf('msg_t2'), -1, '轮号不回传（渲染端按在途请求自己归档）');
});

test('v458 主桥：处理器把渲染端的 turnRef 透传给 queryTurnText（非字符串按缺省处理）', () => {
  const src = readInjectSource();
  assert.ok(src.includes('function queryTurnText(sid, wc, plainUnits, forceKmb, unitEpoch, noCost, turnRef) {'), '签名带 turnRef');
  const i = src.indexOf('req.action === "turn-text" && typeof req.sid === "string"');
  assert.ok(i > 0, 'turn-text 处理分支缺失');
  const call = src.slice(i, src.indexOf('} else if', i));
  assert.ok(call.includes('req.cost === 0,\n            typeof req.turnRef === "string" ? req.turnRef : "")'), 'turnRef 透传');
});
