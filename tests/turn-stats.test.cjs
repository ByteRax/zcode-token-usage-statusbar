const test = require('node:test');
const assert = require('node:assert/strict');
const { createTracker, subscribeStore, format, formatTokens } = require('../turn-stats.js');

function snapshot(seq, rows, sessionId = 's', logEpoch = 'e') {
  return { seq, sessionId, logEpoch, rows: { window: rows } };
}
function header(state = 'running', extra = {}) {
  return { rowId: 1, turnId: 't', kind: 'turnHeader', state, ...extra };
}
function text(value) { return { rowId: 2, turnId: 't', kind: 'assistantText', text: value }; }

test('counts visible text, reasoning and tool input without counting tool output', () => {
  let now = 0;
  const tracker = createTracker({ now: () => now });
  tracker.ingest(snapshot(1, [header(), text('a')]));
  now = 1000;
  tracker.ingest(snapshot(2, [header(), text('abc'),
    { rowId: 3, turnId: 't', kind: 'reasoning', text: '想' },
    { rowId: 4, turnId: 't', kind: 'toolCall', inputText: '{}', output: 'not model output' }]));
  assert.equal(tracker.get('t').characterRate, 5);
  assert.equal(tracker.get('t').tokenRate, null);
  assert.match(format(tracker.get('t')), /字符\/s/);
});

test('duplicate and old snapshots do not increment counts', () => {
  const tracker = createTracker({ now: () => 0 });
  assert.equal(tracker.ingest(snapshot(2, [header(), text('abc')])), true);
  assert.equal(tracker.ingest(snapshot(2, [header(), text('abcdef')])), false);
  assert.equal(tracker.ingest(snapshot(1, [header()])), false);
});

test('session and epoch changes discard old identities', () => {
  const tracker = createTracker({ now: () => 0 });
  tracker.ingest(snapshot(1, [header()]));
  tracker.ingest(snapshot(2, [], 'other'));
  assert.equal(tracker.get('t'), null);
  tracker.ingest(snapshot(1, [header()], 'other', 'new'));
  assert.equal(tracker.get('t').sessionId, 'other');
});

test('completed summary uses final output and model duration, not characters', () => {
  const tracker = createTracker({ now: () => 0 });
  tracker.ingest(snapshot(1, [header('completedSuccess', { outputTokens: 100, modelDurationMs: 2000, activeMs: 5000 }), text('tiny')]));
  assert.equal(tracker.get('t').tokenRate, 50);
  assert.equal(tracker.get('t').durationMs, 5000);
  assert.match(format(tracker.get('t')), /50.0 token\/s/);
  assert.equal(format(tracker.get('t')), '⚡ 50.0 token/s · 输出 100 token · 耗时 5.0s');
});

test('format switches token counts to 万/亿 only when asked; below 1 万 keeps the thousands separator', () => {
  const tracker = createTracker({ now: () => 0 });
  tracker.ingest(snapshot(1, [header('completedSuccess', { outputTokens: 58200, modelDurationMs: 2000, activeMs: 5000 }), text('tiny')]));
  assert.equal(format(tracker.get('t')), '⚡ 29100.0 token/s · 输出 58,200 token · 耗时 5.0s');
  assert.equal(format(tracker.get('t'), true), '⚡ 29100.0 token/s · 输出 5.82万 token · 耗时 5.0s');
  assert.deepEqual([950, 9500, 582000, 1420000, 1e8, 123456789, 1e9].map(n => formatTokens(n, true)),
    ['950', '9,500', '58.2万', '142万', '1亿', '1.23亿', '10亿']);
  assert.deepEqual([9500, 1420000].map(n => formatTokens(n, false)), ['9,500', '1,420,000']);
});

test('force KMB overrides cn for completed output without changing legacy formatting', () => {
  const values = [999, 1000, 9500, 1000000, 123456789, 1e9];
  assert.deepEqual(values.map(n => formatTokens(n, true, true)), ['999', '1.0K', '9.5K', '1.00M', '123.46M', '1.00B']);
  assert.equal(formatTokens(9500, false), '9,500');
  const stats = { complete: true, tokenRate: 5, outputTokens: 9500, durationMs: null, state: 'completedSuccess' };
  for (const cn of [true, false]) assert.match(format(stats, cn, true), /输出 9\.5K token/);
});

test('force KMB rounds half boundaries up at each scale', () => {
  const values = [1249, 1250, 1251, 1124999, 1125000, 1125001, 1124999999, 1125000000, 1125000001];
  const expected = ['1.2K', '1.3K', '1.3K', '1.12M', '1.13M', '1.13M', '1.12B', '1.13B', '1.13B'];
  for (const cn of [true, false]) assert.deepEqual(values.map(n => formatTokens(n, cn, true)), expected);
  assert.equal(formatTokens(1250, false), '1,250');
});

test('missing or too short final summary is unknown rather than fabricated', () => {
  const tracker = createTracker({ now: () => 0 });
  tracker.ingest(snapshot(1, [header('failed')]));
  assert.equal(tracker.get('t').outputTokens, null);
  assert.equal(tracker.get('t').tokenRate, null);
  assert.match(format(tracker.get('t')), /失败/);
  tracker.ingest(snapshot(2, [header('completedSuccess', { outputTokens: 100, modelDurationMs: 100 })]));
  assert.equal(tracker.get('t').tokenRate, null);
});

test('subscription cleanup is idempotent and no updates occur after close', () => {
  let listener, offCount = 0, updates = 0;
  const tracker = createTracker({ now: () => 0 });
  const store = {
    getState: () => ({ snapshot: snapshot(1, [header()]) }),
    subscribe: callback => { listener = callback; return () => offCount++; },
  };
  const close = subscribeStore(store, tracker, () => updates++);
  assert.equal(updates, 1);
  close(); close(); listener();
  assert.equal(offCount, 1);
  assert.equal(updates, 1);
  assert.equal(tracker.get('t'), null);
});

test('unavailable interfaces are rejected', () => {
  assert.equal(subscribeStore({}, createTracker(), () => {}), null);
});

/* ---------- issue #309：通知路径的读取次数与处理预算（specs/perf-lag-reduction.md 规则 11/12） ----------
 * 桥 v2 的 getState() 每次都是整窗深拷贝（O(window)），所以 subscribeStore 必须只读一次并把读到的
 * state 交给回调；窗口大到单次处理很贵时，连发通知按成本合并，CPU 占比封顶。 */
test('subscribeStore reads once per notification and hands that very state to changed()', () => {
  let reads = 0, listener;
  const state = { snapshot: snapshot(1, [header()]) };
  const store = { getState: () => (reads++, state), subscribe: cb => { listener = cb; return () => {}; } };
  const seen = [];
  subscribeStore(store, createTracker({ now: () => 0 }), s => seen.push(s));
  assert.equal(reads, 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0], state, 'changed receives the state object that was read, so callers need no second getState()');
  state.snapshot = snapshot(2, [header(), text('abc')]);
  listener();
  assert.equal(reads, 2);
  assert.equal(seen[1], state);
});

/* 预算夹具：注入时钟与定时器；getState 每读一次把时钟推进 costMs()，模拟整窗拷贝的耗时。
 * seq 随读取次数递增，保证每次处理都被 ingest 接受并触发 changed。 */
function budgetFixture(costMs) {
  const clock = { t: 0 }, timers = [], log = { reads: 0, changed: 0, states: [] };
  let listener, seq = 0, throwNext = false;
  const store = {
    getState: () => {
      log.reads += 1;
      if (throwNext) { throwNext = false; clock.t += costMs(); throw new Error('store closed mid-flight'); }
      clock.t += costMs();
      return { snapshot: snapshot(++seq, [header(), text('x'.repeat(seq))]) };
    },
    subscribe: cb => { listener = cb; return () => {}; },
  };
  const options = {
    now: () => clock.t,
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false, fired: false, unref() { t.unrefd = true; }, fire() { t.fired = true; fn(); } }; timers.push(t); return t; },
    clearTimeout: t => { if (t) t.cleared = true; },
  };
  const close = subscribeStore(store, createTracker({ now: () => clock.t }), s => { log.changed += 1; log.states.push(s); }, options);
  const live = () => timers.filter(t => !t.cleared && !t.fired);
  return { clock, timers, live, log, close, notify: () => listener(), failNext: () => { throwNext = true; } };
}

test('cheap sessions are never deferred: every notification is processed synchronously (rule 5 unchanged)', () => {
  const f = budgetFixture(() => 2);
  for (let i = 0; i < 5; i++) { f.clock.t += 1; f.notify(); }
  assert.equal(f.log.changed, 6, 'initial subscribe pass + one per notification');
  assert.equal(f.timers.length, 0, 'no timer is ever armed for a cheap session');
});

test('expensive sessions coalesce a burst into one trailing run on the latest state', () => {
  const f = budgetFixture(() => 96);
  assert.equal(f.log.changed, 1);            // 初次同步处理：耗时 96ms → 预算间隔 min(1000, 96×9=864)
  f.clock.t += 4; f.notify();                // 距上次处理结束 4ms
  f.clock.t += 20; f.notify();
  f.clock.t += 20; f.notify();
  assert.equal(f.log.reads, 1, 'burst inside the gap neither reads the store nor ingests');
  assert.equal(f.log.changed, 1);
  assert.equal(f.live().length, 1, 'exactly one trailing timer for the whole burst');
  assert.equal(f.live()[0].ms, 864 - 4, 'armed on the first coalesced notification, to land exactly when the gap (864ms) after the last run ends');
  assert.equal(f.live()[0].unrefd, true, 'timer is unref-ed so it cannot hold a Node test process open');
  f.clock.t += 820;
  f.live()[0].fire();                        // 尾部定时器触发
  assert.equal(f.log.reads, 2);
  assert.equal(f.log.changed, 2);
  assert.equal(f.log.states[1].snapshot.seq, 2, 'the trailing run reads the latest state');
  assert.equal(f.live().length, 0, 'fired timer is not left armed');
});

test('after the gap elapses the next notification is processed synchronously again, without a timer', () => {
  const f = budgetFixture(() => 96);
  f.clock.t += 1; f.notify();                // 进入合并
  f.clock.t += 900; f.live()[0].fire();      // 尾部处理（间隔届满）
  const timersBefore = f.timers.length;
  f.clock.t += 864 + 1;                      // 越过本次处理结束后的间隔
  f.notify();
  assert.equal(f.log.changed, 3, 'processed immediately');
  assert.equal(f.timers.length, timersBefore, 'no new timer needed');
});

test('budget thresholds: 8ms is the first throttled cost, the gap is capped at 1000ms', () => {
  const below = budgetFixture(() => 7.99);
  below.clock.t += 1; below.notify();
  assert.equal(below.log.changed, 2, '7.99ms stays synchronous');
  assert.equal(below.timers.length, 0);
  const at = budgetFixture(() => 8);
  at.clock.t += 1; at.notify();
  assert.equal(at.log.changed, 1, '8ms is already throttled');
  assert.equal(at.live()[0].ms, 72 - 1, 'gap = cost × 9');
  const huge = budgetFixture(() => 500);
  huge.clock.t += 1; huge.notify();
  assert.equal(huge.live()[0].ms, 1000 - 1, 'gap never exceeds 1000ms however expensive one run was');
});

test('closing the subscription clears the trailing timer and a stale firing does nothing', () => {
  const f = budgetFixture(() => 96);
  f.clock.t += 1; f.notify();
  const timer = f.live()[0];
  assert.ok(timer, 'a trailing run is pending');
  f.close();
  assert.equal(timer.cleared, true, 'close() clears the pending timer');
  const reads = f.log.reads;
  timer.fn();                                // 即使定时器回调仍被调到
  assert.equal(f.log.reads, reads, 'closed subscriptions never read the store');
  f.notify();
  assert.equal(f.log.reads, reads);
});

test('a store that throws during the trailing run neither escapes the timer nor stops later notifications', () => {
  const f = budgetFixture(() => 96);
  f.clock.t += 1; f.notify();
  f.failNext();
  f.clock.t += 900;
  assert.doesNotThrow(() => f.live()[0].fire());
  const changed = f.log.changed;
  f.clock.t += 5000;
  f.notify();
  assert.equal(f.log.changed, changed + 1, 'the subscription survives a failed run');
});

test('removed rows reset the live rate instead of retaining old characters', () => {
  let now = 0;
  const tracker = createTracker({ now: () => now });
  tracker.ingest(snapshot(1, [header(), text('abc')]));
  now = 1000;
  tracker.ingest(snapshot(2, [header(), text('abcdef')]));
  assert.equal(tracker.get('t').characterRate, 3);
  now = 1500;
  tracker.ingest(snapshot(3, [header(), text('a')]));
  assert.equal(tracker.get('t').characterRate, null);
  tracker.ingest(snapshot(4, []));
  assert.equal(tracker.get('t'), null);
});

test('live speed does not stay stale indefinitely when output stops', () => {
  let now = 0;
  const tracker = createTracker({ now: () => now });
  tracker.ingest(snapshot(1, [header(), text('a')]));
  now = 1000;
  tracker.ingest(snapshot(2, [header(), text('abc')]));
  now = 4000;
  assert.equal(tracker.get('t').characterRate, null);
});

test('tracker is disposed even when the host unsubscribe throws', () => {
  const tracker = createTracker({ now: () => 0 });
  const close = subscribeStore({
    getState: () => ({ snapshot: snapshot(1, [header()]) }),
    subscribe: () => () => { throw new Error('closed host'); },
  }, tracker, () => {});
  assert.throws(close, /closed host/);
  assert.equal(tracker.get('t'), null);
  assert.doesNotThrow(close);
});

test('totalCharacters exposes the running cumulative count for caller-side chars-to-token calibration', () => {
  let now = 0;
  const tracker = createTracker({ now: () => now });
  tracker.ingest(snapshot(1, [header(), text('abc')]));
  assert.equal(tracker.get('t').totalCharacters, 3);
  now = 1000;
  tracker.ingest(snapshot(2, [header(), text('abcdefgh')]));
  assert.equal(tracker.get('t').totalCharacters, 8);
  tracker.ingest(snapshot(3, [header('completedSuccess', { outputTokens: 4, modelDurationMs: 1000 })]));
  assert.equal(tracker.get('t').totalCharacters, 0);   // 正文行被移除后累计清零，不冒充已消失的内容
});

test('runningTool is recomputed from surviving rows, never stuck on a row that slid out of the window', () => {
  const tracker = createTracker({ now: () => 0 });
  tracker.ingest(snapshot(1, [header(), text('abc'),
    { rowId: 5, turnId: 't', kind: 'toolCall', toolName: 'Read', inputText: '{}', status: 'running', startedAt: 123 }]));
  assert.equal(tracker.get('t').runningTool.name, 'Read');
  // 工具行完成后随虚拟列表窗口滑动被移出快照（新快照只剩 header+正文行）：
  // runningTool 必须为 null——缓存旧引用会让 loading 状态词永远显示"正在读取"。
  tracker.ingest(snapshot(2, [header(), { rowId: 6, turnId: 't', kind: 'assistantText', text: 'done' }]));
  assert.equal(tracker.get('t').runningTool, null);
  // 同理：状态演进（running→success）时以最新对象为准
  tracker.ingest(snapshot(3, [header(),
    { rowId: 7, turnId: 't', kind: 'toolCall', toolName: 'Bash', inputText: '', status: 'success' }]));
  assert.equal(tracker.get('t').runningTool, null);
});

test('runningGroup reports ≥2 consecutive same-kind rows ending at the running row, anchored to the first (v187 restore of v181)', () => {
  const tracker = createTracker({ now: () => 0 });
  // 只读行连续 ≥2（success+running 同类）→ explore，startedAt 锚定组首行供计时
  tracker.ingest(snapshot(1, [header(),
    { rowId: 4, turnId: 't', kind: 'toolCall', toolName: 'Read', inputText: '{}', status: 'success', startedAt: 100 },
    { rowId: 5, turnId: 't', kind: 'toolCall', toolName: 'Grep', inputText: '{}', status: 'running', startedAt: 300 }]));
  assert.deepEqual(tracker.get('t').runningGroup, { kind: 'explore', startedAt: 100 });
  // 单行运行不成组
  tracker.ingest(snapshot(2, [header(),
    { rowId: 6, turnId: 't', kind: 'toolCall', toolName: 'Read', inputText: '{}', status: 'running', startedAt: 500 }]));
  assert.equal(tracker.get('t').runningGroup, null);
  // shell 命令文本分类：两条写命令连续 → terminal（写优先于只读判定）
  tracker.ingest(snapshot(3, [header(),
    { rowId: 7, turnId: 't', kind: 'toolCall', toolName: 'Bash', inputText: '{"command":"rm -rf /tmp/x"}', status: 'success', startedAt: 600 },
    { rowId: 8, turnId: 't', kind: 'toolCall', toolName: 'Bash', inputText: '{"command":"touch /tmp/y"}', status: 'running', startedAt: 700 }]));
  assert.deepEqual(tracker.get('t').runningGroup, { kind: 'terminal', startedAt: 600 });
  // 半截 JSON → defer 透明：不入组也不打断所在组（explore→defer→explore 仍成组）
  tracker.ingest(snapshot(4, [header(),
    { rowId: 9, turnId: 't', kind: 'toolCall', toolName: 'Read', inputText: '{}', status: 'success', startedAt: 800 },
    { rowId: 10, turnId: 't', kind: 'toolCall', toolName: 'Bash', inputText: '{"command":', status: 'running', startedAt: 900 }]));
  assert.equal(tracker.get('t').runningGroup, null);   // defer 后仅 1 个 explore → 不成组
  tracker.ingest(snapshot(5, [header(),
    { rowId: 11, turnId: 't', kind: 'toolCall', toolName: 'Read', inputText: '{}', status: 'success', startedAt: 800 },
    { rowId: 12, turnId: 't', kind: 'toolCall', toolName: 'Bash', inputText: '{"command":', status: 'success', startedAt: 850 },
    { rowId: 13, turnId: 't', kind: 'toolCall', toolName: 'Glob', inputText: '{}', status: 'running', startedAt: 900 }]));
  assert.deepEqual(tracker.get('t').runningGroup, { kind: 'explore', startedAt: 800 });
  // 完成态恒 null；正文行打断连续组
  tracker.ingest(snapshot(6, [header('completedSuccess', { outputTokens: 1, modelDurationMs: 500 })]));
  assert.equal(tracker.get('t').runningGroup, null);
  tracker.ingest(snapshot(7, [header(),
    { rowId: 14, turnId: 't', kind: 'toolCall', toolName: 'Read', inputText: '{}', status: 'success', startedAt: 1000 },
    { rowId: 15, turnId: 't', kind: 'assistantText', text: 'between' },
    { rowId: 16, turnId: 't', kind: 'toolCall', toolName: 'Grep', inputText: '{}', status: 'running', startedAt: 1100 }]));
  assert.equal(tracker.get('t').runningGroup, null);
  // 完成态守卫：完成快照窗口仍带连续工具行时仍须 null（complete 守卫本身不可省）
  tracker.ingest(snapshot(8, [header('completedSuccess', { outputTokens: 1, modelDurationMs: 500 }),
    { rowId: 17, turnId: 't', kind: 'toolCall', toolName: 'Read', inputText: '{}', status: 'success', startedAt: 1200 },
    { rowId: 18, turnId: 't', kind: 'toolCall', toolName: 'Grep', inputText: '{}', status: 'success', startedAt: 1300 }]));
  assert.equal(tracker.get('t').runningGroup, null);
  // 非 groupClassify 命中的工具行（TodoWrite/Skill 等）是组边界：打断连续计数
  tracker.ingest(snapshot(9, [header(),
    { rowId: 19, turnId: 't', kind: 'toolCall', toolName: 'Read', inputText: '{}', status: 'success', startedAt: 1400 },
    { rowId: 20, turnId: 't', kind: 'toolCall', toolName: 'TodoWrite', inputText: '{}', status: 'success', startedAt: 1450 },
    { rowId: 21, turnId: 't', kind: 'toolCall', toolName: 'Grep', inputText: '{}', status: 'running', startedAt: 1500 }]));
  assert.equal(tracker.get('t').runningGroup, null);
  // defer 另两路径同样透明：空命令文本（!cands）与仅分隔符的命令（!segs）都不入组不打断——
  // 夹在 terminal 行之间验证（变异成 explore 会打断 terminal 连续组而变红）
  tracker.ingest(snapshot(10, [header(),
    { rowId: 22, turnId: 't', kind: 'toolCall', toolName: 'Bash', inputText: '{"command":"touch /tmp/a"}', status: 'success', startedAt: 1600 },
    { rowId: 23, turnId: 't', kind: 'toolCall', toolName: 'Bash', inputText: '', status: 'success', startedAt: 1650 },
    { rowId: 24, turnId: 't', kind: 'toolCall', toolName: 'Bash', inputText: '{"command":"mkdir /tmp/b"}', status: 'running', startedAt: 1700 }]));
  assert.deepEqual(tracker.get('t').runningGroup, { kind: 'terminal', startedAt: 1600 });
  tracker.ingest(snapshot(11, [header(),
    { rowId: 25, turnId: 't', kind: 'toolCall', toolName: 'Bash', inputText: '{"command":"rm /tmp/a"}', status: 'success', startedAt: 1800 },
    { rowId: 26, turnId: 't', kind: 'toolCall', toolName: 'Bash', inputText: '{"command":";;;"}', status: 'success', startedAt: 1850 },
    { rowId: 27, turnId: 't', kind: 'toolCall', toolName: 'Bash', inputText: '{"command":"mkdir /tmp/c"}', status: 'running', startedAt: 1900 }]));
  assert.deepEqual(tracker.get('t').runningGroup, { kind: 'terminal', startedAt: 1800 });
  // defer 不冒充 terminal（守卫整体删除的观测点）：尾部场景「写命令 + defer 行运行」必须 null——
  // 若 !cands/!segs 守卫被删并穿透到末行 return 'terminal'，这里会产出虚假 terminal 组
  tracker.ingest(snapshot(12, [header(),
    { rowId: 28, turnId: 't', kind: 'toolCall', toolName: 'Bash', inputText: '{"command":"touch /tmp/d"}', status: 'success', startedAt: 2000 },
    { rowId: 29, turnId: 't', kind: 'toolCall', toolName: 'Bash', inputText: '', status: 'running', startedAt: 2100 }]));
  assert.equal(tracker.get('t').runningGroup, null);
  tracker.ingest(snapshot(13, [header(),
    { rowId: 30, turnId: 't', kind: 'toolCall', toolName: 'Bash', inputText: '{"command":"rm /tmp/d"}', status: 'success', startedAt: 2200 },
    { rowId: 31, turnId: 't', kind: 'toolCall', toolName: 'Bash', inputText: '{"command":";;;"}', status: 'running', startedAt: 2300 }]));
  assert.equal(tracker.get('t').runningGroup, null);
});

test('running subagent row exposes childSessionId for the caller to bind the child store', () => {
  const tracker = createTracker({ now: () => 0 });
  tracker.ingest(snapshot(1, [header(),
    { rowId: 4, turnId: 't', kind: 'subagent', status: 'running', childSessionId: 'sess_subagent_abc' }]));
  const rt = tracker.get('t').runningTool;
  assert.equal(rt.name, 'Agent');
  assert.equal(rt.startedAt, null);
  assert.equal(rt.childSessionId, 'sess_subagent_abc');
  // 行上没有 childSessionId（旧投影/字段缺席）→ null，调用方按无数据降级
  tracker.ingest(snapshot(2, [header(),
    { rowId: 5, turnId: 't', kind: 'subagent', status: 'running' }]));
  assert.equal(tracker.get('t').runningTool.childSessionId, null);
  // 子智能体行结束 → runningTool 归 null（既有行为不回归）
  tracker.ingest(snapshot(3, [header(),
    { rowId: 6, turnId: 't', kind: 'subagent', status: 'success', childSessionId: 'sess_subagent_abc' }]));
  assert.equal(tracker.get('t').runningTool, null);
});

test('runningSubagents lists every running subagent row for multi-slot rate estimation', () => {
  const tracker = createTracker({ now: () => 0 });
  const sub = (rowId, sid, status = 'running') =>
    ({ rowId, turnId: 't', kind: 'subagent', status, childSessionId: sid });
  tracker.ingest(snapshot(1, [header(), sub(3, 'sess_a1'), sub(5, 'sess_b2')]));
  let all = tracker.get('t').runningSubagents;
  assert.deepEqual(all.map(r => r.childSessionId), ['sess_a1', 'sess_b2']);   // rowId 升序稳定
  // 部分结束：只剩未结束的；无 childSessionId 的 running 行跳过；完成态恒 []
  tracker.ingest(snapshot(2, [header(), sub(3, 'sess_a1', 'success'), sub(5, 'sess_b2'),
    { rowId: 7, turnId: 't', kind: 'subagent', status: 'running' }]));
  all = tracker.get('t').runningSubagents;
  assert.deepEqual(all.map(r => r.childSessionId), ['sess_b2']);
  tracker.ingest(snapshot(3, [header('completedSuccess')]));
  assert.deepEqual(tracker.get('t').runningSubagents, []);
});


test('completed output without model duration explains missing basis and never divides by active time', () => {
  const tracker = createTracker({ now: () => 0 });
  for (const [i, modelDurationMs] of [undefined, null, 0, 100, Infinity].entries()) {
    tracker.ingest(snapshot(i + 1, [header('completedSuccess', { outputTokens: 1577, activeMs: 110200, modelDurationMs }), text('reply')]));
    const stats = tracker.get('t');
    assert.equal(stats.tokenRate, null);
    const line = format(stats);
    assert.match(line, /生成时长缺失，暂不显示速率/);
    assert.match(line, /输出 1,577 token · 耗时 110.2s/);
    assert.doesNotMatch(line, /速率不可用|14.3 token\/s|NaN|Infinity/);
  }
});

test('isCompact flags turns containing a compact timelineMarker (header executionKind stays agent on real hosts)', () => {
  const tracker = createTracker({ now: () => 0 });
  tracker.ingest(snapshot(1, [header('completedSuccess', { outputTokens: 0 }),
    { rowId: 3, turnId: 't', kind: 'timelineMarker', marker: { type: 'compact', status: 'success' } }]));
  assert.equal(tracker.get('t').isCompact, true);
  // 模型切换 marker 不是压缩轮（v230 实测普通轮可带 modelChange 类 timelineMarker）
  tracker.ingest(snapshot(2, [header('completedSuccess', { outputTokens: 0 }),
    { rowId: 3, turnId: 't', kind: 'timelineMarker', marker: { type: 'modelChange' } }]));
  assert.equal(tracker.get('t').isCompact, false);
  // 无 marker 行的普通轮
  tracker.ingest(snapshot(3, [header('completedSuccess', { outputTokens: 12 })]));
  assert.equal(tracker.get('t').isCompact, false);
});

// ---- 性能治理（specs/perf-lag-reduction.md）：ingest 字符计数不得再整串 Array.from，且结果逐值等价 ----

function totalChars(texts) {
  const tracker = createTracker({ now: () => 0 });
  const rows = [header()];
  texts.forEach((t, i) => rows.push({ rowId: i + 2, turnId: 't', kind: 'assistantText', text: t }));
  tracker.ingest(snapshot(1, rows));
  return tracker.get('t').totalCharacters;
}

test('character count equals Array.from(text).length for emoji, lone surrogates and mixed text', () => {
  const cases = [
    '', 'abc', '中文混排abc', '😀', '😀😀a😀', 'a\uD83D', '\uDE00a', '\uD83D\uD83D\uDE00', '\uDE00\uD83D',
    '\uD83D\uD83D', 'x'.repeat(1000) + '😀', '👨‍👩‍👧‍👦 family', '\uD83Dabc\uDE00',
    // 代理项区间边界码点（0xD800/0xDBFF 高、0xDC00/0xDFFF 低；0xD7FF/0xE000 在区间外）
    '\uD800\uDC00', '\uDBFF\uDFFF', '\uDBFF\uDC00', '\uD7FFa', '\uDC00\uDC00', '\uD800', '\uDBFF', '\uDC00', '\uDFFF', '\uD7FF\uE000', '\uD800\uE000',
  ];
  for (const c of cases) assert.equal(totalChars([c]), Array.from(c).length, JSON.stringify(c));
  // 随机串：覆盖代理项在各种位置的组合
  const pool = ['a', '中', '\uD83D', '\uDE00', '😀', '\n'];
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let k = 0; k < 300; k++) {
    let s = '';
    for (let i = 0, n = Math.floor(rnd() * 40); i < n; i++) s += pool[Math.floor(rnd() * pool.length)];
    assert.equal(totalChars([s]), Array.from(s).length, JSON.stringify(s));
  }
  assert.equal(totalChars(['😀a', 'b\uD83D', '中']), Array.from('😀a').length + Array.from('b\uD83D').length + 1);
});

test('ingest never builds an array from a text string (hot path allocation guard)', () => {
  const realFrom = Array.from;
  let stringCalls = 0;
  Array.from = function (x, ...rest) { if (typeof x === 'string') stringCalls++; return realFrom.call(this, x, ...rest); };
  try {
    const tracker = createTracker({ now: () => 0 });
    const big = { rowId: 3, turnId: 't', kind: 'toolCall', inputText: 'x'.repeat(50000) };
    tracker.ingest(snapshot(1, [header(), text('流式😀'.repeat(2000)), big]));
    tracker.ingest(snapshot(2, [header(), text('流式😀'.repeat(2001)), big]));
  } finally { Array.from = realFrom; }
  assert.equal(stringCalls, 0);
});

test('row character cache: unchanged text is reused, changed text recounts, removed rows stop counting and recount on reappearance', () => {
  const tracker = createTracker({ now: () => 0 });
  const big = { rowId: 3, turnId: 't', kind: 'toolCall', inputText: '😀'.repeat(100) };
  tracker.ingest(snapshot(1, [header(), text('abc'), big]));
  assert.equal(tracker.get('t').totalCharacters, 3 + 100);
  // 同一行文本不变（新行对象、同内容）→ 总数稳定
  tracker.ingest(snapshot(2, [header(), text('abc'), { ...big }]));
  assert.equal(tracker.get('t').totalCharacters, 3 + 100);
  // 文本变化 → 重算；工具入参行不变仍按缓存计入
  tracker.ingest(snapshot(3, [header(), text('abcdef😀'), big]));
  assert.equal(tracker.get('t').totalCharacters, 7 + 100);
  // 同 rowId 换 kind/文本（文本相同则缓存仍正确，不同则重算）
  tracker.ingest(snapshot(4, [header(), { rowId: 2, turnId: 't', kind: 'reasoning', text: '想想' }, big]));
  assert.equal(tracker.get('t').totalCharacters, 2 + 100);
  // 行被移出窗口：不再计入，再次出现按新文本计数（旧缓存不得复活）
  tracker.ingest(snapshot(5, [header(), text('z')]));
  assert.equal(tracker.get('t').totalCharacters, 1);
  tracker.ingest(snapshot(6, [header(), text('z'), { ...big, inputText: 'ab' }]));
  assert.equal(tracker.get('t').totalCharacters, 3);
});

test('row character cache is actually used: an unchanged large row is not rescanned on the next notification', () => {
  const tracker = createTracker({ now: () => 0 });
  const big = { rowId: 3, turnId: 't', kind: 'toolCall', inputText: 'x'.repeat(50000) };
  tracker.ingest(snapshot(1, [header(), text('a'), big]));
  const real = String.prototype.charCodeAt;
  let calls = 0;
  String.prototype.charCodeAt = function (i) { calls++; return real.call(this, i); };
  try {
    tracker.ingest(snapshot(2, [header(), text('ab'), big]));   // 仅小行变化；大行文本引用/内容未变
  } finally { String.prototype.charCodeAt = real; }
  assert.ok(calls < 1000, `unchanged 50k-char row must hit the cache (charCodeAt calls: ${calls})`);
  assert.equal(tracker.get('t').totalCharacters, 2 + 50000);
});

test('row character cache compares text content, not just length (same UTF-16 length, different code points)', () => {
  const tracker = createTracker({ now: () => 0 });
  tracker.ingest(snapshot(1, [header(), text('ab')]));
  assert.equal(tracker.get('t').totalCharacters, 2);
  tracker.ingest(snapshot(2, [header(), text('😀')]));   // UTF-16 长度同为 2，码点数 2→1
  assert.equal(tracker.get('t').totalCharacters, 1);
});

test('row character cache is keyed per row: two long rows of the same kind do not overwrite each other', () => {
  const tracker = createTracker({ now: () => 0 });
  const a = { rowId: 3, turnId: 't', kind: 'assistantText', text: 'a'.repeat(5000) };
  const b = { rowId: 4, turnId: 't', kind: 'assistantText', text: 'b'.repeat(5000) };
  tracker.ingest(snapshot(1, [header(), a, b]));
  const real = String.prototype.charCodeAt;
  let calls = 0;
  String.prototype.charCodeAt = function (i) { calls++; return real.call(this, i); };
  try {
    tracker.ingest(snapshot(2, [header(), a, b]));
  } finally { String.prototype.charCodeAt = real; }
  assert.ok(calls < 100, `both unchanged rows must hit their own cache entry (charCodeAt calls: ${calls})`);
  assert.equal(tracker.get('t').totalCharacters, 10000);
});

test('row character cache is released when a row leaves the window: the same text reappearing is recounted', () => {
  const tracker = createTracker({ now: () => 0 });
  const long = { rowId: 3, turnId: 't', kind: 'assistantText', text: 'x'.repeat(5000) };
  tracker.ingest(snapshot(1, [header(), long]));
  tracker.ingest(snapshot(2, [header()]));                   // 行滑出窗口
  const real = String.prototype.charCodeAt;
  let calls = 0;
  String.prototype.charCodeAt = function (i) { calls++; return real.call(this, i); };
  try {
    tracker.ingest(snapshot(3, [header(), long]));           // 同文本重现
  } finally { String.prototype.charCodeAt = real; }
  assert.ok(calls >= 4000, `released entry must not be revived from the old cache (charCodeAt calls: ${calls})`);
  assert.equal(tracker.get('t').totalCharacters, 5000);
});

test('non-string text fields never throw and are not counted', () => {
  const tracker = createTracker({ now: () => 0 });
  const rows = [header(),
    { rowId: 2, turnId: 't', kind: 'assistantText', text: null },
    { rowId: 3, turnId: 't', kind: 'assistantText', text: 5 },
    { rowId: 4, turnId: 't', kind: 'reasoning', text: { a: 1 } },
    { rowId: 5, turnId: 't', kind: 'toolCall', inputText: undefined },
    { rowId: 6, turnId: 't', kind: 'toolCall', inputText: ['x'] },
    { rowId: 7, turnId: 't', kind: 'assistantText', text: 'ok' }];
  assert.doesNotThrow(() => tracker.ingest(snapshot(1, rows)));
  assert.equal(tracker.get('t').totalCharacters, 2);
  assert.doesNotThrow(() => tracker.ingest(snapshot(2, rows)));   // 二次 ingest 走缓存分支同样安全
  assert.equal(tracker.get('t').totalCharacters, 2);
});
