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

test('removed rows re-base the live rate: the pre-drop rate is held for one window, then only fresh growth counts', () => {
  let now = 0;
  const tracker = createTracker({ now: () => now });
  tracker.ingest(snapshot(1, [header(), text('abc')]));
  now = 1000;
  tracker.ingest(snapshot(2, [header(), text('abcdef')]));
  assert.equal(tracker.get('t').characterRate, 3);
  now = 1500;
  tracker.ingest(snapshot(3, [header(), text('a')]));   // 字符数下降：保持窗（2 秒）内沿用下降前采样之间的速率
  assert.equal(tracker.get('t').characterRate, 3);      // （不是按下降时刻摊算的 2）
  now = 5000;                                           // 保持窗结束 1500ms 后才有下一条通知：保持已作废，不回显旧速率
  tracker.ingest(snapshot(4, [header(), text('a')]));
  assert.equal(tracker.get('t').characterRate, null);
  now = 5300;                                           // 新基线已过 200ms 仍无增长：读 0，不再沿用下降前的旧速率
  assert.equal(tracker.get('t').characterRate, 0);
  now = 6000;
  tracker.ingest(snapshot(5, [header(), text('abcd')]));
  assert.equal(tracker.get('t').characterRate, 3);      // 只按新基线之后的增长计算
  tracker.ingest(snapshot(6, []));
  assert.equal(tracker.get('t'), null);
});

/* ---------- issue #483：估算只计真实生成（specs/live-rate-estimate-robustness.md） ---------- */

test('issue #483: prepended history rows are not counted as new output, but still count for calibration', () => {
  let now = 0;
  const tracker = createTracker({ now: () => now });
  const body = (value) => ({ rowId: 3, turnId: 't', kind: 'assistantText', text: value });
  const earlier = { rowId: 2, turnId: 't', kind: 'reasoning', text: 'x'.repeat(5000) };
  tracker.ingest(snapshot(1, [header(), body('abcdef')]));
  now = 1000;
  tracker.ingest(snapshot(2, [header(), body('abcdefghi')]));
  assert.equal(tracker.get('t').characterRate, 3);
  // 宿主往前补拉历史：行号 2 的旧行在 tracker 首个快照之后才出现（尾 60 行把它截在了窗外）
  now = 2000;
  tracker.ingest(snapshot(3, [header(), earlier, body('abcdefghijkl')]));
  assert.equal(tracker.get('t').characterRate, 3, '一次前插 5000 字符不能算成 2 秒内生成');
  assert.equal(tracker.get('t').totalCharacters, 5012, '校准分子仍含回填的旧行');
  // 末尾新增的行照常计入
  now = 3000;
  tracker.ingest(snapshot(4, [header(), earlier, body('abcdefghijkl'),
    { rowId: 4, turnId: 't', kind: 'assistantText', text: 'pqr' }]));
  assert.equal(tracker.get('t').characterRate, 3);
  assert.equal(tracker.get('t').totalCharacters, 5015);
});

test('issue #483: rows present in the tracker\'s first snapshot all count, whatever their order', () => {
  let now = 0;
  const tracker = createTracker({ now: () => now });
  const later = { rowId: 5, turnId: 't', kind: 'assistantText', text: 'bbb' };
  const earlier = { rowId: 3, turnId: 't', kind: 'reasoning', text: 'aaa' };
  tracker.ingest(snapshot(1, [header(), later, earlier]));
  now = 1000;
  tracker.ingest(snapshot(2, [header(), later, { ...earlier, text: 'aaaa' }]));
  assert.equal(tracker.get('t').characterRate, 1);
  assert.equal(tracker.get('t').totalCharacters, 7);
});

test('issue #483: a frame burst right after the tracker binds re-baselines instead of counting the catch-up', () => {
  let now = 0;
  const tracker = createTracker({ now: () => now });
  tracker.ingest(snapshot(1, [header(), text('a'.repeat(600))]));   // 重绑后的首个快照（订阅那一刻的整份快照）
  now = 10;
  tracker.ingest(snapshot(2, [header(), text('a'.repeat(900))]));  // 被压住的增量帧成批涌入
  now = 20;
  tracker.ingest(snapshot(3, [header(), text('a'.repeat(1200))]));
  now = 420;
  tracker.ingest(snapshot(4, [header(), text('a'.repeat(1320))])); // 之后 300 字符/s
  assert.equal(tracker.get('t').characterRate, 300, '按 20ms 处的新基线算，不把补齐的 600 算进去');
});

test('issue #483: the burst re-baseline only covers the tracker\'s first 300ms, never a later backlog', () => {
  let now = 0;
  const tracker = createTracker({ now: () => now });
  tracker.ingest(snapshot(1, [header(), text('a'.repeat(600))]));
  now = 3000;
  tracker.ingest(snapshot(2, [header(), text('a'.repeat(1500))]));  // 卡顿 3 秒后的合并快照
  now = 3010;
  tracker.ingest(snapshot(3, [header(), text('a'.repeat(1800))]));  // 积压帧紧接着涌入
  assert.equal(tracker.get('t').characterRate, 1200 * 1000 / 3010, '真实生成的迟到投递仍按窗口平均');
});

/* 通知预算两头的 store：整窗拷贝每次耗时 costMs。≥8ms 进预算（间隔 cost×9，上限 1 秒），间隔内的通知合并成
 * 一次入库；<8ms 每次通知同步处理。字符数与会话由用例给定，时钟从 start 起；给了 f.rows 就用它当窗口行。 */
function rateStore(costMs, start = 0) {
  const f = { now: start, chars: 600, session: 's', timers: [], listener: null, rows: null };
  let seq = 0;
  f.store = {
    getState() {
      f.now += costMs;
      return { snapshot: snapshot(++seq, f.rows || [header(), text('a'.repeat(f.chars))], f.session) };
    },
    subscribe: cb => { f.listener = cb; return () => {}; },
  };
  f.options = {
    now: () => f.now,
    setTimeout: fn => { const t = { fire() { fn(); } }; f.timers.push(t); return t; },
    clearTimeout: () => {},
  };
  return f;
}

test('issue #483: an expensive session gets the catch-up burst as coalesced ingests, which re-baseline inside the settle window', () => {
  const f = rateStore(8);                                  // 预算间隔 72ms
  const tracker = createTracker({ now: () => f.now });
  subscribeStore(f.store, tracker, () => {}, f.options);   // 初次同步处理：t=8，600 字符
  f.now = 10; f.chars = 900; f.listener();                 // 被压住的帧开始涌入：间隔内只置 pending
  f.now = 40; f.chars = 1200; f.listener();
  f.now = 60; f.chars = 1460; f.listener();
  f.now = 80; f.timers[0].fire();                          // 合并成一次入库：t=88，1460 字符
  f.now = 288; f.chars = 1520; f.listener();               // 之后 300 字符/s；仍在建立后 300ms 内，照样重取基线
  f.now = 488; f.chars = 1580; f.listener();               // 间隔已过，同步处理：t=496
  assert.equal(tracker.get('t').characterRate, 300, '订阅快照之后攒下的 860 字符没有被算成 80ms 内生成');
  f.now = 497; f.listener();                               // 间隔内再合并一次
  f.now = 560; f.chars = 1605; f.listener();
  f.now = 569; f.timers[1].fire();                         // t=577
  assert.equal(tracker.get('t').characterRate, 85 * 1000 / 281, '出稳窗之后的合并入库照常计入');
  f.session = 's2'; f.now = 60000; f.chars = 600; f.listener();   // 一分钟后切到另一个会话（同步处理，t=60008）
  f.now = 60009; f.chars = 900; f.listener();              // 同样的补齐突发
  f.now = 60070; f.chars = 1460; f.listener();
  f.now = 60080; f.timers[2].fire();                       // t=60088
  f.now = 60288; f.chars = 1520; f.listener();
  f.now = 60488; f.chars = 1580; f.listener();
  assert.equal(tracker.get('t').characterRate, 300, '换会话视同新建：稳窗重新起算');
});

test('issue #483: a coalesced ingest that lands after the settle window re-baselines once, not twice', () => {
  const f = rateStore(40);                                 // 预算间隔 360ms：第一个合并入库落在建立后 400ms
  const tracker = createTracker({ now: () => f.now });
  subscribeStore(f.store, tracker, () => {}, f.options);   // t=40，600 字符
  f.now = 50; f.chars = 900; f.listener();                 // 被压住的帧：间隔内只置 pending
  f.now = 60; f.chars = 1460; f.listener();
  f.now = 400; f.timers[0].fire();                         // 合并入库：t=440（建立后 400ms），1460 字符
  f.now = 441; f.chars = 1552; f.listener();               // 之后 200ms 生成 92 字符；仍在间隔内，合并
  f.now = 801; f.timers[1].fire();                         // t=841
  assert.equal(tracker.get('t').characterRate, 92 * 1000 / 401, '建立 300ms 之后、1.2 秒之内的第一个合并入库照样重取基线');
  f.now = 842; f.chars = 1644; f.listener();
  f.now = 1202; f.timers[2].fire();                        // t=1242
  assert.equal(tracker.get('t').characterRate, 184 * 1000 / 802, '只做一次：第二次合并入库照常计入');
  f.session = 's2'; f.now = 60000; f.chars = 600; f.listener();   // 切到另一个会话（同步处理：t=60040）
  f.now = 60050; f.chars = 900; f.listener();                     // 同样的补齐突发
  f.now = 60060; f.chars = 1460; f.listener();
  f.now = 60400; f.timers[3].fire();                              // 合并入库：t=60440（建立后 400ms）
  f.now = 60801; f.chars = 1552; f.listener();                    // 间隔已过，同步处理
  f.now = 61201; f.chars = 1644; f.listener();
  assert.equal(tracker.get('t').characterRate, 184 * 1000 / 801, '换会话视同新建：那一次合并入库的重取重新可用');
});

test('issue #483: a flat coalesced ingest does not spend the once-per-bind re-baseline', () => {
  const f = rateStore(40);                                 // 预算间隔 360ms
  const tracker = createTracker({ now: () => f.now });
  subscribeStore(f.store, tracker, () => {}, f.options);   // t=40，600 字符
  f.now = 50; f.listener();                                // 字符没变：只置 pending
  f.now = 400; f.timers[0].fire();                         // 合并入库：t=440，仍是 600 字符
  f.now = 441; f.chars = 1460; f.listener();               // 补齐突发
  f.now = 801; f.timers[1].fire();                         // t=841
  f.now = 1201; f.chars = 1552; f.listener();              // 之后 300 字符/s（间隔已过，同步处理：t=1241）
  assert.equal(tracker.get('t').characterRate, 92 * 1000 / 400, '那一次重取基线留给真正带着补齐突发的合并入库');
});

test('issue #483: a coalesced ingest that first brings a new turn does not trip the re-baseline rule', () => {
  const f = rateStore(8);
  let changed = 0;
  const tracker = createTracker({ now: () => f.now });
  subscribeStore(f.store, tracker, () => { changed += 1; }, f.options);   // 初次同步处理
  f.now = 10;
  f.rows = [header('completedSuccess', { outputTokens: 300 }), text('a'.repeat(600)),
    { rowId: 10, turnId: 't2', kind: 'turnHeader', state: 'running' },
    { rowId: 11, turnId: 't2', kind: 'assistantText', text: 'bb' }];
  f.listener();                                            // 间隔内：置 pending
  f.now = 80; f.timers[0].fire();                          // 合并入库：新一轮 t2 第一次出现
  assert.equal(changed, 2, '入库没有抛错（抛错会被订阅吞掉，回调就少一次）');
  assert.equal(tracker.get('t2').characterRate, null);
});

test('issue #483: the 1.2s bound on coalesced re-baselines is exact: 1199ms after bind counts, exactly 1200ms does not', () => {
  const landed = gapMs => {
    const f = rateStore(8);
    const tracker = createTracker({ now: () => f.now });
    subscribeStore(f.store, tracker, () => {}, f.options);   // t=8，600 字符
    f.now = 9; f.chars = 1460; f.listener();                 // 间隔内只置 pending
    f.now = gapMs; f.timers[0].fire();                       // 合并入库落在 t=gapMs+8，即建立后 gapMs
    f.now = gapMs + 300; f.chars = 1552; f.listener();       // 之后 300 字符/s（间隔已过，同步处理）
    f.now = gapMs + 500; f.chars = 1612; f.listener();
    return tracker.get('t').characterRate;
  };
  assert.equal(landed(1199), 152 * 1000 / 500, '1.2 秒之内：重取基线');
  assert.equal(landed(1200), 1012 * 1000 / 1700, '整 1.2 秒：按窗口平均');
});

test('issue #483: a coalesced ingest only re-baselines within the tracker\'s first 1.2s', () => {
  const f = rateStore(8);
  const tracker = createTracker({ now: () => f.now });
  subscribeStore(f.store, tracker, () => {}, f.options);   // t=8，600 字符
  f.now = 5000; f.listener();                              // 会话停了 5 秒：间隔早过，同步处理（t=5008），仍是 600 字符
  f.now = 5009; f.chars = 1500; f.listener();              // 间隔内：只置 pending
  f.now = 5070; f.chars = 1521; f.listener();
  f.now = 5080; f.timers[0].fire();                        // 合并入库：t=5088，1521 字符
  f.now = 5288; f.chars = 1581; f.listener();              // 之后 300 字符/s（同步处理，t=5296）
  assert.equal(tracker.get('t').characterRate, 981 * 1000 / 5288, '建立 1.2 秒之后的合并入库是真实生成的迟到投递，仍按窗口平均');
});

test('issue #483: on a very expensive session the first coalesced ingest lands over a second after bind, still inside the settle window', () => {
  const S = 5000000;                                        // 时钟不从 0 起：真机的 performance.now() 早就过了稳窗
  const f = rateStore(150, S);                              // 预算间隔 min(1000, 150×9)，即上限 1000ms
  const tracker = createTracker({ now: () => f.now });
  subscribeStore(f.store, tracker, () => {}, f.options);   // t=S+150，600 字符
  f.now = S + 160; f.chars = 900; f.listener();             // 间隔内：只置 pending
  f.now = S + 1140; f.chars = 1460; f.listener();
  f.now = S + 1150; f.timers[0].fire();                     // 合并入库：t=S+1300（建立后 1150ms），1460 字符
  f.now = S + 1301; f.chars = 1552; f.listener();           // 之后 200ms 生成 92 字符；仍在间隔内，合并
  f.now = S + 2300; f.timers[1].fire();                     // t=S+2450
  assert.equal(tracker.get('t').characterRate, 92 * 1000 / 1150, '1.2 秒 = 预算间隔上限 1 秒加一次读取：这种会话也在稳窗内');
});

test('issue #483: synchronous ingests are never taken for a coalesced catch-up', () => {
  const f = rateStore(2);
  const tracker = createTracker({ now: () => f.now });
  subscribeStore(f.store, tracker, () => {}, f.options);   // t=2，600 字符
  f.now = 500; f.chars = 650; f.listener();                // 廉价会话：逐条同步入库，先慢后快（200 → 300 字符/s）
  f.now = 750; f.chars = 725; f.listener();
  assert.equal(tracker.get('t').characterRate, 125 * 1000 / 750, '一帧没丢：按窗口平均，不重取基线');
});

test('issue #483: when the trailing timer is late, the synchronous ingest that skipped notifications still counts as coalesced', () => {
  const f = rateStore(8);
  const tracker = createTracker({ now: () => f.now });
  subscribeStore(f.store, tracker, () => {}, f.options);   // t=8，600 字符
  f.now = 58; f.chars = 620; f.listener();                 // 被压住的帧：间隔内只置 pending
  f.now = 358; f.chars = 1220; f.listener();               // 尾部定时器迟迟没触发，间隔早已过去：同步处理（t=366），带着补齐的 600 字符
  f.now = 966; f.chars = 1400; f.listener();               // 之后 300 字符/s（间隔已过，同步处理：t=974）
  assert.equal(tracker.get('t').characterRate, 180 * 1000 / 608, '中间确实跳过了通知，这一条按合并入库重取基线');
});

test('issue #483: the settle window restarts when the tracker is cleared or the session / epoch changes', () => {
  const burst = restart => {
    let now = 0;
    const tracker = createTracker({ now: () => now });
    tracker.ingest(snapshot(1, [header(), text('a'.repeat(600))], 's1', 'e1'));
    now = 5000;                                            // 建立已 5 秒：平时的补齐突发早已出稳窗
    const first = restart(tracker);                        // 视同新建后的首个快照
    tracker.ingest(first);
    now = 5010;
    tracker.ingest(snapshot(3, [header(), text('a'.repeat(1500))], first.sessionId, first.logEpoch));   // 补齐突发
    now = 5310;
    tracker.ingest(snapshot(4, [header(), text('a'.repeat(1590))], first.sessionId, first.logEpoch));   // 之后 300 字符/s
    return tracker.get('t').characterRate;
  };
  assert.equal(burst(() => snapshot(2, [header(), text('a'.repeat(600))], 's2', 'e1')), 300, '换会话');
  assert.equal(burst(() => snapshot(2, [header(), text('a'.repeat(600))], 's1', 'e2')), 300, '换纪元');
  assert.equal(burst(tracker => { tracker.clear(); return snapshot(1, [header(), text('a'.repeat(600))], 's1', 'e1'); }), 300, 'clear()');
  assert.equal(burst(() => snapshot(2, [header(), text('a'.repeat(600))], 's1', 'e1')), 990 * 1000 / 5310,
    '对照：同一会话同一纪元没有重挂，5 秒后的突发仍按窗口平均');
});

test('issue #483: a character drop holds the pre-drop rate instead of re-basing low ahead of a refill', () => {
  let now = 0;
  const tracker = createTracker({ now: () => now });
  tracker.ingest(snapshot(1, [header(), text('a'.repeat(600))]));
  now = 1000;
  tracker.ingest(snapshot(2, [header(), text('a'.repeat(900))]));
  assert.equal(tracker.get('t').characterRate, 300);
  now = 1500;
  tracker.ingest(snapshot(3, [header(), text('a'.repeat(600))]));   // 缩水 300：行文本被替换得更短或行被移除
  now = 1600;
  tracker.ingest(snapshot(4, [header(), text('a'.repeat(1080))]));  // 100ms 后回填：旧实现读 4800
  assert.equal(tracker.get('t').characterRate, 300, '保持窗内沿用下降前的窗口速率');
  now = 2500;
  tracker.ingest(snapshot(5, [header(), text('a'.repeat(1350))]));
  assert.equal(tracker.get('t').characterRate, 300);
  now = 3500;
  tracker.ingest(snapshot(6, [header(), text('a'.repeat(1650))]));  // 窗过后的新基线未满 200ms：仍沿用
  assert.equal(tracker.get('t').characterRate, 300);
  now = 3700;
  tracker.ingest(snapshot(7, [header(), text('a'.repeat(1680))]));  // 之后 150 字符/s
  assert.equal(tracker.get('t').characterRate, 150, '只按新基线以来的增长计算，不再是沿用的 300');
});

test('issue #483: a drop before any valid rate leaves the estimate empty for the hold window', () => {
  let now = 0;
  const tracker = createTracker({ now: () => now });
  tracker.ingest(snapshot(1, [header(), text('abc')]));
  now = 100;
  tracker.ingest(snapshot(2, [header(), text('a')]));
  now = 1000;
  tracker.ingest(snapshot(3, [header(), text('a'.repeat(300))]));   // 回填
  assert.equal(tracker.get('t').characterRate, null, '保持窗内不采样，也不把回填算成生成');
  now = 2300;
  tracker.ingest(snapshot(4, [header(), text('a'.repeat(300))]));
  now = 2500;
  tracker.ingest(snapshot(5, [header(), text('a'.repeat(360))]));
  assert.equal(tracker.get('t').characterRate, 300);
});

test('issue #483: a baseline that lands after the hold window still bridges, with no empty reading in between', () => {
  let now = 0;
  const tracker = createTracker({ now: () => now });
  tracker.ingest(snapshot(1, [header(), text('a'.repeat(600))]));
  now = 1000;
  tracker.ingest(snapshot(2, [header(), text('a'.repeat(900))]));
  now = 1500;
  tracker.ingest(snapshot(3, [header(), text('a'.repeat(600))]));   // 缩水，保持窗到 3500
  now = 3700;                                                       // 窗已结束、下一条通知还没来：读数不空
  assert.equal(tracker.get('t').characterRate, 300);
  now = 3899;                                                       // 窗结束 399ms 后才有下一条通知
  tracker.ingest(snapshot(4, [header(), text('a'.repeat(1650))]));
  assert.equal(tracker.get('t').characterRate, 300);
  now = 3999;
  tracker.ingest(snapshot(5, [header(), text('a'.repeat(1740))]));  // 之后 900 字符/s
  assert.equal(tracker.get('t').characterRate, 300, '新基线未满 200ms：仍沿用');
  now = 4099;
  assert.equal(tracker.get('t').characterRate, 450);                // 新窗口接上：200ms 增 90 字符
});

test('issue #483: a baseline exactly 400ms after the hold window does not echo the pre-drop rate', () => {
  let now = 0;
  const tracker = createTracker({ now: () => now });
  tracker.ingest(snapshot(1, [header(), text('a'.repeat(600))]));
  now = 1000;
  tracker.ingest(snapshot(2, [header(), text('a'.repeat(900))]));
  now = 1500;
  tracker.ingest(snapshot(3, [header(), text('a'.repeat(600))]));   // 缩水，保持窗到 3500
  now = 3899;
  assert.equal(tracker.get('t').characterRate, 300, '窗结束 399ms：还在沿用');
  now = 3900;
  assert.equal(tracker.get('t').characterRate, null, '窗结束整 400ms：保持作废');
  tracker.ingest(snapshot(4, [header(), text('a'.repeat(1650))]));  // 这一条只作新基线
  assert.equal(tracker.get('t').characterRate, null);
  now = 4100;
  tracker.ingest(snapshot(5, [header(), text('a'.repeat(1710))]));
  assert.equal(tracker.get('t').characterRate, 300);
});

test('issue #483: a drop after the output had already stopped does not revive the pre-stall rate', () => {
  let now = 0, seq = 0;
  const tracker = createTracker({ now: () => now });
  const at = (t, n) => { now = t; tracker.ingest(snapshot(++seq, [header(), text('a'.repeat(n))])); };
  at(0, 0); at(500, 150); at(1000, 300);          // 300 字符/s，随后输出停止
  at(2900, 200);                                  // 近 2 秒没有新输出之后出现一次缩水
  assert.equal(tracker.get('t').characterRate, null, '停更之前的速率不再被沿用');
  at(3100, 200);
  assert.equal(tracker.get('t').characterRate, null);
  at(3300, 260);                                  // 300 字符/s 恢复：保持窗（到 4900）内不采样
  assert.equal(tracker.get('t').characterRate, null);
  at(4950, 500);
  at(5150, 560);
  assert.equal(tracker.get('t').characterRate, 300);
});

test('issue #483: a drop landing on the first snapshot after the hold window restarts it, so the refill is not sampled', () => {
  let now = 0, seq = 0;
  const tracker = createTracker({ now: () => now });
  const at = (t, n) => { now = t; tracker.ingest(snapshot(++seq, [header(), text('a'.repeat(n))])); };
  at(0, 0); at(1000, 300); at(4900, 1470);                        // 300 字符/s
  at(5000, 1200);                                                // 缩水，保持窗到 7000
  at(6000, 1200);                                                // 窗内：增长 300、又缩水 300
  at(6900, 1470);
  at(7000, 1200);                                                // 恰好在保持窗结束的那条快照上又一次缩水
  at(7100, 1530);                                                // 100ms 后回填：不续期的话这条被采成 3000 字符/s
  assert.equal(tracker.get('t').characterRate, 300, '回填没有被采样');
  at(7200, 1560); at(7300, 1590);
  assert.equal(tracker.get('t').characterRate, 300);
});

test('issue #483: a drop during the hold window restarts it, so a slow refill is not sampled either', () => {
  let now = 0, seq = 0;
  const tracker = createTracker({ now: () => now });
  const at = (t, n) => { now = t; tracker.ingest(snapshot(++seq, [header(), text('a'.repeat(n))])); };
  at(0, 0); at(1000, 300); at(4900, 1470);
  at(5000, 1200);                                                // 缩水，保持窗到 7000
  at(6900, 1770);
  at(6950, 1485);                                                // 窗结束前 50ms 又缩水：保持窗重新计时到 8950
  at(7000, 1500);                                                // 还没有回填
  at(7100, 1830);                                                // 150ms 后才回填
  assert.equal(tracker.get('t').characterRate, 300, '回填没有被采样');
  at(7200, 1860);
  assert.equal(tracker.get('t').characterRate, 300);
});

test('issue #483: a drop on a baseline younger than 200ms carries the rate the previous hold showed', () => {
  let now = 0, seq = 0;
  const tracker = createTracker({ now: () => now });
  const at = (t, n) => { now = t; tracker.ingest(snapshot(++seq, [header(), text('a'.repeat(n))])); };
  at(0, 0); at(1000, 300); at(4900, 1470);
  at(5000, 1200);                                                // 缩水，保持窗到 7000
  at(7000, 1800);                                                // 窗结束：新基线刚落
  at(7100, 1530);                                                // 100ms 后又缩水：新基线不满 200ms，取不到下降前的窗口速率
  assert.equal(tracker.get('t').characterRate, 300, '沿用上一段保持的速率，不空读数');
  at(8000, 1800);
  assert.equal(tracker.get('t').characterRate, 300);
});

test('issue #483: a row that left the window and comes back is not counted as new output', () => {
  let now = 0;
  const tracker = createTracker({ now: () => now });
  const a = n => ({ rowId: 2, turnId: 't', kind: 'assistantText', text: 'a'.repeat(n) });
  const b = { rowId: 3, turnId: 't', kind: 'assistantText', text: 'b'.repeat(5000) };
  tracker.ingest(snapshot(1, [header(), a(6)]));
  now = 1500;
  tracker.ingest(snapshot(2, [header(), a(6), b]));              // 新出现的行：全文计入
  now = 1600;
  tracker.ingest(snapshot(3, [header(), a(6)]));                 // b 出窗：字符数下降，保持窗开始
  now = 4000;                                                     // 保持窗早已结束（已作废）
  tracker.ingest(snapshot(4, [header(), a(6)]));
  now = 4200;
  tracker.ingest(snapshot(5, [header(), a(7)]));
  now = 4300;
  tracker.ingest(snapshot(6, [header(), a(7), b]));              // b 原样回来
  assert.equal(tracker.get('t').characterRate, 1000 / 300, '回来的是见过的内容，不算这 300ms 里生成的');
  assert.equal(tracker.get('t').totalCharacters, 5007, '校准分子照常含它');
});

test('issue #483: a row that left before a later row also stays old when it comes back on a fallen max row id', () => {
  let now = 0;
  const tracker = createTracker({ now: () => now });
  const a = n => ({ rowId: 2, turnId: 't', kind: 'assistantText', text: 'a'.repeat(n) });
  const c = { rowId: 4, turnId: 't', kind: 'assistantText', text: 'c'.repeat(5000) };
  const b = { rowId: 5, turnId: 't', kind: 'assistantText', text: 'b'.repeat(5) };
  tracker.ingest(snapshot(1, [header(), a(6)]));
  now = 1000;
  tracker.ingest(snapshot(2, [header(), a(6), c]));
  now = 1100;
  tracker.ingest(snapshot(3, [header(), a(6), c, b]));
  now = 1200;
  tracker.ingest(snapshot(4, [header(), a(6), c]));              // b 出窗：最大行号回落到 4
  now = 1300;
  tracker.ingest(snapshot(5, [header(), a(6)]));                 // c 出窗：最大行号回落到 1
  now = 4000;
  tracker.ingest(snapshot(6, [header(), a(6)]));
  now = 4200;
  tracker.ingest(snapshot(7, [header(), a(7)]));
  now = 4300;
  tracker.ingest(snapshot(8, [header(), a(7), c]));              // c 回来时行号不小于最大行号，单看行号不像旧行
  assert.equal(tracker.get('t').characterRate, 1000 / 300);
  assert.equal(tracker.get('t').totalCharacters, 5007, '校准分子照常含它');
});

test('issue #483: a row that comes back longer than it left is excluded at the length it comes back with', () => {
  let now = 0, seq = 0;
  const tracker = createTracker({ now: () => now });
  const a = n => ({ rowId: 2, turnId: 't', kind: 'assistantText', text: 'a'.repeat(n) });
  const b = n => ({ rowId: 3, turnId: 't', kind: 'assistantText', text: 'b'.repeat(n) });
  const c = { rowId: 4, turnId: 't', kind: 'assistantText', text: 'c'.repeat(5) };
  const at = (t, rows) => { now = t; tracker.ingest(snapshot(++seq, [header(), ...rows])); };
  at(0, [a(6), b(100), c]);
  at(1000, [a(306), b(100), c]);
  at(1100, [a(336), b(100), c]);
  assert.equal(tracker.get('t').characterRate, 300);
  at(1200, [a(366), c]);                        // b 出窗：字符数下降，保持窗到 3200
  at(3300, [a(1026), c]);                       // 窗结束 100ms 后：新基线
  at(3400, [a(1086), b(160), c]);               // 100ms 后 b 长了 60 回来：出窗期间长出来的不算刚生成的
  at(3500, [a(1146), b(160), c]);               // 之后只有 a 在涨：600 字符/s
  assert.equal(tracker.get('t').characterRate, 600, '只有 a 的增长被算进去');
});

test('issue #483: a row mistaken for history at first sight does not have its in-window growth counted twice when it returns', () => {
  let now = 0, seq = 0;
  const tracker = createTracker({ now: () => now });
  const r = (rowId, n) => ({ rowId, turnId: 't', kind: 'assistantText', text: 'x'.repeat(n) });
  const at = (t, rows) => { now = t; tracker.ingest(snapshot(++seq, [header(), ...rows])); };
  at(0, [r(7, 100), r(6, 100)]);                  // 首快照乱序：仍在流式的行 6 排在行 7 后面，被当作回填的旧行
  at(350, [r(7, 100), r(6, 205)]);                // 行 6 在窗内长出来的部分照常计入
  at(550, [r(7, 100), r(6, 265)]);
  assert.equal(tracker.get('t').characterRate, 300);
  at(750, []);                                    // 两行都出窗：字符数下降，保持窗到 2750
  at(2750, []);
  at(2950, [r(6, 325)]);                          // 行 6 以最大行身份回来：只算它出窗之后长出来的 60
  assert.equal(tracker.get('t').characterRate, 300);
});

test('issue #483: a returning row counts only what it gained since it left', () => {
  let now = 0, seq = 0;
  const tracker = createTracker({ now: () => now });
  const r = (rowId, n) => ({ rowId, turnId: 't', kind: 'assistantText', text: 'x'.repeat(n) });
  const at = (t, rows) => { now = t; tracker.ingest(snapshot(++seq, [header(), ...rows])); };
  at(0, [r(2, 100), r(3, 100), r(4, 100), r(5, 100)]);
  at(350, [r(2, 205), r(3, 100), r(4, 100), r(5, 100)]);
  at(550, [r(2, 265), r(3, 100), r(4, 100), r(5, 100)]);
  at(750, [r(2, 265), r(3, 100)]);                // 行 4、5 出窗：最大行号回落到 3
  at(2750, [r(2, 265), r(3, 100)]);
  at(2950, [r(2, 265), r(3, 100), r(4, 160)]);    // 行 4 回来时长了 60
  assert.equal(tracker.get('t').characterRate, 300, '只算这 60，整行不算「回来时才生成的」');
});

test('issue #483: a row that leaves, grows in the window and leaves again is not recounted on its second return', () => {
  let now = 0, seq = 0;
  const tracker = createTracker({ now: () => now });
  const a = n => ({ rowId: 3, turnId: 't', kind: 'assistantText', text: 'a'.repeat(n) });   // 一直在窗内，300 字符/s
  const b = n => ({ rowId: 5, turnId: 't', kind: 'assistantText', text: 'b'.repeat(n) });
  const at = (t, rows) => { now = t; tracker.ingest(snapshot(++seq, [header(), ...rows])); };
  at(0, [a(0), b(100)]);
  at(1000, [a(300), b(100)]);
  at(1200, [a(360)]);                    // b 出窗（记 100）：字符数下降，保持窗到 3200
  at(3300, [a(990)]);
  at(3500, [a(1050), b(260)]);           // b 以最大行身份回来，出窗期间长了 160
  at(3700, [a(1110), b(320)]);           // 窗内又长 60，这次已经算过
  at(3900, [a(1170)]);                   // b 再次出窗：应记住 320，而不是第一次的 100
  at(6000, [a(1770)]);
  at(6200, [a(1830), b(320)]);           // 原样回来
  at(6400, [a(1890), b(320)]);
  assert.equal(tracker.get('t').characterRate, 300, '窗内算过的 60 没有被再算一遍');
});

test('issue #483: the previous hold only lends its rate for 400ms after its window ends', () => {
  let now = 0, seq = 0;
  const tracker = createTracker({ now: () => now });
  const at = (t, n) => { now = t; tracker.ingest(snapshot(++seq, [header(), text('a'.repeat(n))])); };
  at(0, 100); at(350, 205); at(550, 265);
  at(750, 65);                                    // 下降：保持窗到 2750，随后输出停止
  at(2750, 65);
  at(2950, 125);                                  // 新基线 200ms 后出现增长
  assert.equal(tracker.get('t').characterRate, 300);
  at(3700, 65);                                   // 上一段保持的窗结束已 950ms：不再借用它的速率
  assert.equal(tracker.get('t').characterRate, null);
});

test('issue #483: the once-per-bind coalesced re-baseline is tracked per turn', () => {
  let now = 0;
  const tracker = createTracker({ now: () => now });
  const rows = (a, b) => [
    { rowId: 1, turnId: 'u', kind: 'turnHeader', state: 'running' }, { rowId: 2, turnId: 'u', kind: 'assistantText', text: 'a'.repeat(a) },
    { rowId: 3, turnId: 't', kind: 'turnHeader', state: 'running' }, { rowId: 4, turnId: 't', kind: 'assistantText', text: 'b'.repeat(b) },
  ];
  tracker.ingest(snapshot(1, rows(100, 100)));        // 建立时的整份快照
  now = 400;
  tracker.ingest(snapshot(2, rows(700, 700)), true);  // 400ms 后一次合并入库：两轮各带着补齐的 600 字符
  now = 600;
  tracker.ingest(snapshot(3, rows(760, 760)), true);
  assert.equal(tracker.get('u').characterRate, 300, '轮 u 重取了基线');
  assert.equal(tracker.get('t').characterRate, 300, '轮 t 也重取了基线，不靠它在 Map 里的先后');
});

test('the live rate follows the last two seconds: a slowdown shows up as the window slides', () => {
  let now = 100, n = 100, seq = 1;
  const tracker = createTracker({ now: () => now });
  tracker.ingest(snapshot(seq++, [header(), text('x'.repeat(n))]));
  for (let t = 300; t <= 6000; t += 200) {           // 前 3 秒 1000 字符/s，后 3 秒 100 字符/s
    now = t; n += t < 3000 ? 200 : 20;
    tracker.ingest(snapshot(seq++, [header(), text('x'.repeat(n))]));
  }
  assert.equal(tracker.get('t').characterRate, 100, '窗口里只剩慢的那一段');
});

test('a last sample exactly 2000ms old still counts, one ms older is stale', () => {
  let now = 0;
  const tracker = createTracker({ now: () => now });
  tracker.ingest(snapshot(1, [header(), text('x'.repeat(100))]));
  now = 400;
  tracker.ingest(snapshot(2, [header(), text('x'.repeat(340))]));
  now = 2400;
  assert.equal(tracker.get('t').characterRate, 100);
  now = 2401;
  assert.equal(tracker.get('t').characterRate, null);
});

test('issue #483: a row that comes back shorter than it left adds nothing and never counts as another drop', () => {
  let now = 0, seq = 0;
  const tracker = createTracker({ now: () => now });
  const a = n => ({ rowId: 2, turnId: 't', kind: 'assistantText', text: 'a'.repeat(n) });
  const b = n => ({ rowId: 3, turnId: 't', kind: 'assistantText', text: 'b'.repeat(n) });
  const at = (t, rows) => { now = t; tracker.ingest(snapshot(++seq, [header(), ...rows])); };
  at(0, [a(6), b(5000)]);
  at(1000, [a(306), b(5000)]);
  at(1100, [a(336), b(5000)]);
  assert.equal(tracker.get('t').characterRate, 300);
  at(1200, [a(366)]);                        // b 出窗：字符数下降，保持窗到 3200
  at(1300, [a(396), b(4000)]);               // b 回来时比出窗时短：不该倒扣，也不该再算一次下降
  at(3200, [a(966), b(4000)]);
  at(3400, [a(1086), b(4000)]);              // 之后 600 字符/s
  assert.equal(tracker.get('t').characterRate, 600, '保持窗没有被那次回来续期');
});

test('issue #483: the settle window counts from the tracker\'s birth, not from time zero', () => {
  let now = 5000000;                                             // 真机的 performance.now() 早就过了 300ms
  const tracker = createTracker({ now: () => now });
  tracker.ingest(snapshot(1, [header(), text('a'.repeat(600))]));
  now += 10;
  tracker.ingest(snapshot(2, [header(), text('a'.repeat(900))]));
  now += 10;
  tracker.ingest(snapshot(3, [header(), text('a'.repeat(1200))]));
  now += 378;
  tracker.ingest(snapshot(4, [header(), text('a'.repeat(1260))]));
  assert.equal(tracker.get('t').characterRate, 60 * 1000 / 378, '稳窗锚在建立时刻');
});

test('issue #483: every growing frame inside the settle window re-baselines, so the first reading counts from the last of them', () => {
  let now = 0, seq = 0;
  const tracker = createTracker({ now: () => now });
  const at = n => { tracker.ingest(snapshot(++seq, [header(), text('a'.repeat(n))])); };
  at(600); now = 100; at(630); now = 200; at(660); now = 250; at(675);   // 稳态通知：间隔远大于成批涌入的帧
  now = 450;
  at(720);
  assert.equal(tracker.get('t').characterRate, 45 * 1000 / 200, '基线落在稳窗内最后一帧增长上；首个读数因此晚到建立后约半秒');
});

test('issue #483: a catch-up frame that lands 20ms after the subscribe snapshot is re-baselined as well', () => {
  let now = 0;
  const tracker = createTracker({ now: () => now });
  tracker.ingest(snapshot(1, [header(), text('a'.repeat(600))]));   // 订阅那一刻的整份快照
  now = 20;
  tracker.ingest(snapshot(2, [header(), text('a'.repeat(900))]));  // 被压住的首帧隔了 20ms 才到
  now = 420;
  tracker.ingest(snapshot(3, [header(), text('a'.repeat(1020))])); // 之后 300 字符/s
  assert.equal(tracker.get('t').characterRate, 300);
});

test('issue #483: a burst that arrives 800ms after bind is a late delivery of real output and gets averaged', () => {
  let now = 0;
  const tracker = createTracker({ now: () => now });
  tracker.ingest(snapshot(1, [header(), text('a'.repeat(600))]));
  now = 800;
  tracker.ingest(snapshot(2, [header(), text('a'.repeat(900))]));
  now = 810;
  tracker.ingest(snapshot(3, [header(), text('a'.repeat(1200))]));
  now = 1210;
  tracker.ingest(snapshot(4, [header(), text('a'.repeat(1320))]));
  assert.equal(tracker.get('t').characterRate, 720 * 1000 / 1210, '稳窗只管建立后 300ms');
});

test('issue #483: the settle window ends exactly 300ms after bind', () => {
  const grown = gapMs => {
    let now = 0;
    const tracker = createTracker({ now: () => now });
    tracker.ingest(snapshot(1, [header(), text('a'.repeat(600))]));
    now = gapMs;
    tracker.ingest(snapshot(2, [header(), text('a'.repeat(900))]));
    now = gapMs + 300;
    tracker.ingest(snapshot(3, [header(), text('a'.repeat(990))]));   // 之后 300 字符/s
    return tracker.get('t').characterRate;
  };
  assert.equal(grown(299), 300, '299ms：还在稳窗内，重取基线');
  assert.equal(grown(300), 390 * 1000 / 600, '整 300ms：按窗口平均');
});

test('issue #483: a flat frame right after bind does not move the baseline', () => {
  let now = 0;
  const tracker = createTracker({ now: () => now });
  tracker.ingest(snapshot(1, [header(), text('a'.repeat(600))]));
  now = 10;
  tracker.ingest(snapshot(2, [header(), text('a'.repeat(600))]));  // 10ms 后来了一帧，字符没变
  now = 310;
  tracker.ingest(snapshot(3, [header(), text('a'.repeat(693))]));  // 300 字符/s
  assert.equal(tracker.get('t').characterRate, 93 * 1000 / 310);
});

test('issue #483: a completed turn never shows an estimate, whether or not the completing snapshot drops characters', () => {
  let now = 0, seq = 0;
  const tracker = createTracker({ now: () => now });
  const at = (t, turn, state, n) => {
    now = t;
    tracker.ingest(snapshot(++seq, [
      { rowId: 1, turnId: turn, kind: 'turnHeader', state, outputTokens: 100, modelDurationMs: 1000 },
      { rowId: 2, turnId: turn, kind: 'assistantText', text: 'a'.repeat(n) },
    ]));
  };
  at(0, 't', 'running', 600);
  at(1000, 't', 'running', 900);
  assert.equal(tracker.get('t').characterRate, 300);
  at(1500, 't', 'completedSuccess', 1350);                       // 正常完成：窗口里还有样本
  assert.equal(tracker.get('t').characterRate, null);
  assert.equal(tracker.get('t').tokenRate, 100);
  at(3000, 'u', 'running', 600);
  at(4000, 'u', 'running', 900);
  at(4500, 'u', 'completedSuccess', 600);                        // 完成的同一条快照里字符数下降
  assert.equal(tracker.get('u').characterRate, null, '保持窗不越过完成态');
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

test('a notification arriving after the gap but before a late timer runs synchronously and retires the pending timer', () => {
  const f = budgetFixture(() => 96);
  f.clock.t += 1; f.notify();                // 进入合并，排尾部定时器
  const timer = f.live()[0];
  assert.ok(timer);
  f.clock.t += 900;                          // 间隔已过，但定时器被后台节流而迟到
  f.notify();                                // 新通知先到：同步处理
  assert.equal(f.log.changed, 2);
  assert.equal(timer.cleared, true, 'the superseded timer is cleared');
  const reads = f.log.reads;
  timer.fire();                              // 即便迟到回调仍被调到，也不再多读一次整窗
  assert.equal(f.log.reads, reads, 'no redundant full-window read after the synchronous run');
});

test('default timer helpers tolerate hosts without setTimeout/clearTimeout (AGENTS §4 typeof guard)', () => {
  const saved = { st: global.setTimeout, ct: global.clearTimeout };
  try {
    const f = (() => {
      let l, n = 0, clock = 0;
      const store = { getState: () => { clock += 96; return { snapshot: snapshot(++n, [header(), text('x')]) }; }, subscribe: cb => { l = cb; return () => {}; } };
      const close = subscribeStore(store, createTracker({ now: () => clock }), () => {}, { now: () => clock });
      return { l, close, bump: () => { clock += 1; } };
    })();
    global.setTimeout = undefined; global.clearTimeout = undefined;
    f.bump();
    assert.doesNotThrow(() => f.l(), 'arming without setTimeout must not throw into the host notification chain');
    assert.doesNotThrow(() => f.close(), 'closing without clearTimeout must not throw');
  } finally { global.setTimeout = saved.st; global.clearTimeout = saved.ct; }
});
