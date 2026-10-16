const test = require('node:test');
const assert = require('node:assert/strict');
const { createTracker, subscribeStore, format } = require('../turn-stats.js');

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
  assert.match(format(tracker.get('t')), /50.0 tok\/s/);
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
