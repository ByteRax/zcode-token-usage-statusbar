const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// zuBarSpeedView 的子代理估算分支（v97）：Agent 工具运行期优先展示「子代理运行 · 估 X t/s」，
// subEst 缺席/过期（>3s 未刷新）时回退既有「状态词 · 耗时」；非 Agent 工具不受 subEst 影响。
// zuToolVerb 以恒等 stub 注入——文案长度另由 ZU_TOOL_VERBS 提取断言覆盖。
const NOW = 11000;

function extractSpeedView(source, lang, zuSkillName) {
  const start = source.indexOf('  var DEFAULT_CHARS_PER_TOKEN = 2;');
  const end = source.indexOf('  /* 思考态动效图标', start);
  assert.ok(start >= 0 && end > start, '提取失败: zuBarSpeedView');
  return vm.runInNewContext(source.slice(start, end) + '\nzuBarSpeedView;', {
    L: (zh, en) => (lang === 'en' ? en : zh),
    zuToolVerb: (name) => name,
    zuSkillName: zuSkillName || ((t) => (t || '').slice(0, 24)),
    Date: { now: () => NOW },
  });
}

/* v158：真实 zuSkillName 提取（与 overlay 同源切片），供 Skill 分支用例注入 */
function extractSkillName(source) {
  const start = source.indexOf('  function zuSkillName(');
  const end = source.indexOf('\n  }', start) + 4;   // 含收尾 '\n  }'
  assert.ok(start >= 0 && end > start, '提取失败: zuSkillName');
  return vm.runInNewContext(source.slice(start, end) + '\nzuSkillName;', {});
}

const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');

for (const lang of ['zh', 'en']) {
  const speedView = extractSpeedView(source, lang);
  const agentTool = { name: 'Agent', startedAt: 1000, childSessionId: 'sess_subagent_a' };
  const fresh = { rate: 45.16, at: NOW - 500, count: 1 };
  const est = lang === 'en' ? ' · est ' : ' · 估 ';

  test(`${lang}: fresh subSum shows summed estimated tok/s for running agents`, () => {
    const view = speedView({ complete: false, runningTool: agentTool, characterRate: null, observedMs: 0 }, null, fresh);
    assert.equal(view.text, 'Agent' + est + '45.2 t/s');
    assert.equal(view.phase, 'tool');
    assert.equal(view.cls, 'dim');
  });

  test(`${lang}: multiple running agents get ×N suffix with the summed rate`, () => {
    const view = speedView({ complete: false, runningTool: agentTool, characterRate: null, observedMs: 0 }, null,
      { rate: 120.44, at: NOW - 500, count: 3 });
    assert.equal(view.text, 'Agent ×3' + est + '120.4 t/s');
  });

  test(`${lang}: stale subSum (>3s) falls back to verb + elapsed`, () => {
    const view = speedView({ complete: false, runningTool: agentTool, characterRate: null, observedMs: 0 }, null,
      { rate: 45.16, at: NOW - 4000, count: 1 });
    assert.equal(view.text, 'Agent 10.0s');
  });

  test(`${lang}: subagent-row form (no startedAt, no subSum) shows verb only`, () => {
    const view = speedView({ complete: false, runningTool: { name: 'Agent', startedAt: null, childSessionId: 'sess_subagent_a' },
      characterRate: null, observedMs: 0 });
    assert.equal(view.text, 'Agent');
  });

  test(`${lang}: null-rate subSum falls back like absence`, () => {
    const view = speedView({ complete: false, runningTool: agentTool, characterRate: null, observedMs: 0 }, null,
      { rate: null, at: NOW - 100, count: 0 });
    assert.equal(view.text, 'Agent 10.0s');
  });

  test(`${lang}: non-agent tools ignore subSum entirely`, () => {
    const view = speedView({ complete: false, runningTool: { name: 'Read', startedAt: 1000 }, characterRate: null, observedMs: 0 },
      null, fresh);
    assert.equal(view.text, 'Read 10.0s');
  });

  // v187 补回 v181 工具组状态词：运行行落在 ≥2 连续同类组尾时状态词跟随组标签
  // （数据由 turn-stats runningGroupOf 提供），计时锚定组首行 startedAt。
  test(`${lang}: running group tail overrides the per-tool verb, timing anchored to the group head`, () => {
    const view = speedView({ complete: false, runningTool: { name: 'Read', startedAt: 10000 },
      runningGroup: { kind: 'explore', startedAt: 8000 }, characterRate: null, observedMs: 0 });
    assert.equal(view.text, lang === 'en' ? 'Explore·executing 3.0s' : '查阅·执行中 3.0s');
    assert.equal(view.phase, 'tool');
    assert.equal(view.cls, 'dim');
  });

  test(`${lang}: terminal group label and per-group startedAt anchoring`, () => {
    const view = speedView({ complete: false, runningTool: { name: 'Bash', startedAt: 10900 },
      runningGroup: { kind: 'terminal', startedAt: 10000 }, characterRate: null, observedMs: 0 });
    assert.equal(view.text, lang === 'en' ? 'Terminal·executing 1.0s' : '终端·执行中 1.0s');
  });

  test(`${lang}: group without startedAt falls back to the running row's startedAt`, () => {
    const view = speedView({ complete: false, runningTool: { name: 'Read', startedAt: 10000 },
      runningGroup: { kind: 'explore', startedAt: null }, characterRate: null, observedMs: 0 });
    assert.equal(view.text, lang === 'en' ? 'Explore·executing 1.0s' : '查阅·执行中 1.0s');
  });

  test(`${lang}: absent runningGroup keeps the legacy per-tool verb (old tracker compat)`, () => {
    const view = speedView({ complete: false, runningTool: { name: 'Read', startedAt: 10000 }, characterRate: null, observedMs: 0 });
    assert.equal(view.text, 'Read 1.0s');
  });
}

// 工具动词契约：「正在运行子智能体」压成「子代理运行中」（v97），桌面与 Web 同文案。
for (const file of ['overlay.js', 'web/overlay.js']) {
  test(`${file}: Agent verb is exactly 6 CJK chars in zh`, () => {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const start = src.indexOf('var ZU_TOOL_VERBS = {');
    const end = src.indexOf('};', start);
    assert.ok(start >= 0 && end > start, `提取失败: ${file} ZU_TOOL_VERBS`);
    const verbs = vm.runInNewContext(src.slice(start, end + 2) + '\nZU_TOOL_VERBS;', {});
    assert.equal(verbs.Agent[0], '子代理运行中');
    assert.equal(Array.from(verbs.Agent[0]).length, 6);
    assert.equal(verbs.Task[0], '子代理运行中');
    assert.equal(verbs.Agent[1], 'Running agent');
    // 表内不再使用旧文案（版本日志注释保留历史记录，不在检查范围）
    assert.ok(!src.slice(start, end + 2).includes('正在运行子智能体'));
  });
}

// subRateTick 生命周期（v97 review P1 回归锁）：subscribeStore 会同步首调一次回调，
// 首调即 detach（sessionId 不匹配/换代）时不得把悬挂订阅当成功绑定写回，且 2s 节流
// 必须覆盖该路径（否则 0.1s 心跳下每秒 10 次全表 diag 枚举 + tracker 分配）。
const BRIDGE_NOW = 1000000;

function extractSubRateBridge() {
  const start = source.indexOf('    /* ---------- 子代理运行期速率桥');
  const end = source.indexOf('    function bridgeTick()', start);
  assert.ok(start >= 0 && end > start, '提取失败: subRate 桥段');
  return source.slice(start, end) + '\n[subRateTick, subRateDetach, subRate, subRateSlotText];';
}

// 多槽位沙箱：每个 sid 一个独立 store（可各自配置快照 sessionId 与 tracker stats），
// zuTryBindStore 计数以验证节流；TURN_STATS stub 复刻 subscribeStore 同步首调行为。
function makeSandbox({ stores = {}, stats = null, c2t = 2, paneScope = null, acquireStore = null } = {}) {
  const win = acquireStore ? { __zusageAcquireConversationStore: acquireStore } : {};   // 桥 v2 探针共用
  const state = { bindCalls: 0, unsubscribed: 0, disposed: 0, updates: 0 };
  const sandboxStores = {};
  for (const sid of Object.keys(stores).length ? Object.keys(stores) : []) {
    const conf = stores[sid];
    sandboxStores[sid] = {
      getState: () => ({ snapshot: { sessionId: conf.snapshotSessionId || sid } }),
      subscribe: (fn) => { (conf.listeners = conf.listeners || []).push(fn); return () => { state.unsubscribed++; }; },
      off: () => { state.unsubscribed++; },
    };
  }
  const tracker = { ingest() {}, get: (tid) => (stores[tid] && stores[tid].stats) || stats, dispose() { state.disposed++; } };
  const diagObj = {};   // v180：SUBRATE_DIAG 提到模块级，切片外声明——沙箱内预接同一对象
  const sandbox = vm.createContext({
    SUBRATE_DIAG: diagObj,
    TURN_STATS: {
      createTracker: () => tracker,
      subscribeStore: (st, tr, cb) => {   // 复刻真实行为：注册后同步首调一次
        const off = st.subscribe(() => cb());
        if (typeof off !== 'function') return null;
        cb();
        return () => { try { off(); } finally { tr.dispose(); } };
      },
    },
    zuTryBindStore: (sid) => {
      state.bindCalls++;
      const st = sandboxStores[sid];
      if (!st) return null;   // 注册表里没有该 topic：绑定失败
      st.__sid = sid;
      return st;
    },
    inactive: () => false,
    zuActiveTurnId: (snap) => (snap && snap.sessionId) || '',   // tid=sid：tracker.get 按槽位配 stats
    bridge: { handle: { charsPerToken: c2t } },
    L: (zh, en) => zh,   // subRateSlotText 的文案分支（中文即可断言数值）
    DEFAULT_CHARS_PER_TOKEN: 2,
    updateLive: () => { state.updates++; },
    Date: { now: () => BRIDGE_NOW },
    FATAL: { subRate: diagObj },                 // v179：与 SUBRATE_DIAG 同对象（模拟模块级首挂）
    readPaneScope: () => paneScope,              // v179：acquire 降级取 pane scope——null 即走 noStore
    // v180：zuAcquireSubStore 在模块层（切片外）——沙箱内置同 guards 镜像桩
    zuAcquireSubStore: (sid, scope) => {
      if (typeof sid !== 'string' || sid.indexOf('sess_subagent_') !== 0) return null;
      const acquire = win.__zusageAcquireConversationStore;
      if (typeof acquire !== 'function' || !scope || scope.remoteSessionId) return null;
      const out = { sessionId: sid };
      if (scope.workspacePath) out.workspacePath = scope.workspacePath;
      if (scope.identity) out.workspaceIdentity = scope.identity;
      if (!out.workspacePath && !out.workspaceIdentity) return null;
      try { return acquire(out) || null; } catch (e) { return null; }
    },
    wantedEl: null, pickedSid: '', instSid: '', pid: '',
    window: win,   // v179：无 __zusageAcquireConversationStore ⇒ acqFn=0（桥 v1 沙箱）
  });
  const [tick, detachAll, subRate, slotText] = vm.runInContext(extractSubRateBridge(), sandbox);
  return { tick, detachAll, subRate, slotText, state, sandbox };
}

test('subRateTick: healthy slots feed per-agent rates and the summed view', () => {
  const running = [{ childSessionId: 'sess_a' }, { childSessionId: 'sess_b' }];
  const { tick, subRate, slotText, state, sandbox } = makeSandbox({
    stores: {
      sess_a: { stats: { complete: false, characterRate: 90 } },    // 90/2 = 45
      sess_b: { stats: { complete: false, characterRate: 30 } },    // 30/2 = 15
    },
  });
  tick(running);
  assert.equal(state.bindCalls, 2);
  assert.equal(subRate.slots.sess_a.rate, 45);
  assert.equal(subRate.slots.sess_b.rate, 15);
  assert.equal(subRate.sum.rate, 60);   // 合计（跨 VM 上下文对象不能 deepEqual，逐字段）
  assert.equal(subRate.sum.count, 2);
  assert.equal(subRate.sum.at, BRIDGE_NOW);
  assert.equal(slotText('sess_a').includes('45.0'), true);
  tick(running);   // 同集合：幂等不重绑
  assert.equal(state.bindCalls, 2);
  // v179 定位诊断：FATAL.subRate 原地记录槽位分布（acqFn=0 为桥 v1 沙箱）
  assert.deepEqual({ ...sandbox.FATAL.subRate, t: 0 },
    { want: 2, bound: 2, rate: 2, think: 0, calib: 0, noStore: 0, acqFn: 0, t: 0 });
  assert.equal(subRate.slots.sess_a.st, 'rate');
  assert.equal(subRate.slots.sess_b.st, 'rate');
});

test('subRateTick: converging the running set detaches finished agents and recomputes the sum', () => {
  const { tick, subRate, state } = makeSandbox({
    stores: {
      sess_a: { stats: { complete: false, characterRate: 90 } },
      sess_b: { stats: { complete: false, characterRate: 30 } },
    },
  });
  tick([{ childSessionId: 'sess_a' }, { childSessionId: 'sess_b' }]);
  assert.equal(subRate.sum.count, 2);
  tick([{ childSessionId: 'sess_b' }]);   // a 结束：槽位移除、合计只剩 b
  assert.ok(!subRate.slots.sess_a, '结束的槽位彻底移除');
  assert.equal(subRate.sum.rate, 15);
  assert.equal(subRate.sum.count, 1);
  assert.equal(subRate.sum.at, BRIDGE_NOW);
  assert.ok(state.unsubscribed >= 1, '移除时订阅被释放');
  tick(null);   // 全部结束：清空
  assert.equal(Object.keys(subRate.slots).length, 0);
  assert.equal(subRate.sum.rate, null);
});

test('subRateTick: first-callback mismatch resets the slot with 2s backoff, not a ghost binding', () => {
  const { tick, subRate, state } = makeSandbox({
    stores: {
      sess_a: { stats: { complete: false, characterRate: 90 } },
      bad: { snapshotSessionId: 'other-session' },   // 绑定成功但快照 sessionId 不匹配
    },
  });
  tick([{ childSessionId: 'sess_a' }, { childSessionId: 'bad' }]);
  assert.ok(subRate.slots.sess_a.handle, '健康槽位不受影响');
  const bad = subRate.slots.bad;
  assert.equal(bad.handle, null, '首调 reset 后不得残留 handle');
  assert.equal(bad.off, null, '悬挂解绑函数不得写回');
  assert.ok(state.unsubscribed >= 1 && state.disposed >= 1, '订阅已释放、tracker 已 dispose');
  assert.equal(bad.retryAt, BRIDGE_NOW + 2000, 'mismatch 槽位进入 2s 节流');
  assert.equal(subRate.sum.rate, 45);   // 合计只含健康槽位
  assert.equal(subRate.sum.count, 1);
  tick([{ childSessionId: 'sess_a' }, { childSessionId: 'bad' }]);   // 节流窗口内：不再枚举
  assert.equal(state.bindCalls, 2);
});

test('subRateTick: unbindable topic keeps a throttled slot without binding', () => {
  const { tick, subRate, state, sandbox } = makeSandbox({ stores: { sess_a: { stats: { complete: false, characterRate: 90 } } } });
  tick([{ childSessionId: 'sess_a' }, { childSessionId: 'missing' }]);   // missing 无 store
  assert.equal(state.bindCalls, 2);   // 两个都尝试过一次
  assert.ok(!subRate.slots.missing.handle);
  assert.equal(subRate.slots.missing.retryAt, BRIDGE_NOW + 2000);
  tick([{ childSessionId: 'sess_a' }, { childSessionId: 'missing' }]);
  assert.equal(state.bindCalls, 2, '节流窗口内不再重试枚举');
  assert.equal(subRate.sum.rate, 45);
  assert.equal(subRate.sum.count, 1);
  // v180 review：诊断按 handle 判绑定——未绑定槽位入 noStore 桶，acqFn=0（桥 v1 沙箱）
  assert.deepEqual({ ...sandbox.FATAL.subRate, t: 0 },
    { want: 2, bound: 1, rate: 1, think: 0, calib: 0, noStore: 1, acqFn: 0, t: 0 });
});

test('subRateTick: acquire fallback binds unregistered background subagents (v179)', () => {
  let acquireCalls = 0, offs = 0;
  const seen = [];
  const acquired = {
    getState: () => ({ snapshot: { sessionId: 'sess_subagent_bg' } }),
    subscribe: () => () => {},
    off: () => { offs++; },
  };
  const { tick, subRate, state, sandbox } = makeSandbox({
    // sess_subagent_bg 不在 stores ⇒ zuTryBindStore 必然 null（模拟注册表无现成 topic）
    stats: { complete: false, characterRate: 80 },   // tracker.get 兜底：80/2 = 40
    paneScope: { sid: 'sid_main', identity: '', workspacePath: '/w', remoteSessionId: '' },
    acquireStore: (scope) => {
      acquireCalls++;
      seen.push({ sessionId: scope.sessionId, workspacePath: scope.workspacePath,
                  workspaceIdentity: scope.workspaceIdentity });
      return acquired;
    },
  });
  tick([{ childSessionId: 'sess_subagent_bg' }]);
  assert.ok(acquireCalls >= 1, 'existing 缺席时尝试 acquire');
  assert.deepEqual(seen[0], { sessionId: 'sess_subagent_bg', workspacePath: '/w', workspaceIdentity: undefined });   // 空 identity 不进 scope
  assert.equal(subRate.slots['sess_subagent_bg'].st, 'rate', 'acquire 到的 store 出速率');
  assert.equal(subRate.slots['sess_subagent_bg'].rate, 40);
  assert.equal(sandbox.FATAL.subRate.acqFn, 1);
  assert.equal(sandbox.FATAL.subRate.noStore, 0);
  tick(null);   // 槽位收敛 → 解绑 → subSlotReset → store.off 即租约归还
  assert.ok(offs >= 1, 'acquire 包装 store 的 off 被调（租约归还）');
  assert.equal(subRate.slots['sess_subagent_bg'], undefined, '槽位彻底移除');
});

test('subRateTick: remote scope never attempts acquire', () => {
  let acquireCalls = 0;
  const { tick, subRate } = makeSandbox({
    paneScope: { sid: 'sid_main', identity: 'ident', workspacePath: '/w', remoteSessionId: 'r1' },
    acquireStore: () => { acquireCalls++; return null; },
  });
  tick([{ childSessionId: 'sess_subagent_r' }]);
  assert.equal(acquireCalls, 0, '远端会话的子代理不尝试本地 acquire');
  assert.equal(subRate.slots['sess_subagent_r'].st, 'noStore');
});


// buildLiveTip（v97）：chip tooltip 在工具期逐槽位列出运行中子代理的实时估算，
// 并行 ≥2 个有效槽位时先给合计行；思考期槽位显示「估算中…」。
test('buildLiveTip lists per-agent rows with a sum line during the tool phase', () => {
  const src = source;
  const start = src.indexOf('    function ttEsc(');
  const end = src.indexOf('return "\\x01" + rows;', start);
  const brace = src.indexOf('}', end);
  assert.ok(start >= 0 && end > start && brace > end, '提取失败: buildLiveTip');
  // v127：buildLiveTip 追加了颜色对照图例——注入真实 tpsBandLegend（不含 zuBarSpeedView）
  const bandHelpers = src.slice(src.indexOf('  var TPS_BANDS = ['), src.indexOf('  /* 返回 null = 调用方应把这当成'));
  const now = 1000000;
  const buildTip = vm.runInNewContext(bandHelpers + src.slice(start, brace + 1) + '\nbuildLiveTip;', {
    L: (zh, en) => zh,
    Date: { now: () => now },
    subRate: { slots: {
      sess_aa: { rate: 45.16, at: now - 100 },          // 有效
      sess_bb: { rate: 15.04, at: now - 100 },          // 有效
      sess_cc: { rate: null, at: 0 },                   // 思考期
    }, sum: { rate: 60.2, at: now - 100, count: 2 } },
  });
  const html = buildTip({ phase: 'tool' });
  assert.ok(html.indexOf('合计') >= 0 && html.indexOf('60.2') >= 0, '合计行（2 个有效槽位）');
  assert.ok(html.indexOf('…s_aa') >= 0 && html.indexOf('45.2') >= 0, '槽位 aa 的实时值');
  assert.ok(html.indexOf('…s_bb') >= 0 && html.indexOf('15.0') >= 0, '槽位 bb 的实时值');
  assert.ok(html.indexOf('…s_cc') >= 0 && html.indexOf('估算中…') >= 0, '思考期槽位降级文案');
  // 非工具期（思考/正文）不列子代理行
  const html2 = buildTip({ phase: 'thinking' });
  assert.ok(html2.indexOf('…s_aa') < 0, '非工具期不列槽位行');
});

/* ---------- v158：Skill 运行期「技能名·执行中」 ---------- */
test('skill tool shows the extracted skill name with executing suffix (zh/en)', () => {
  const sk = extractSkillName(source);
  for (const lang of ['zh', 'en']) {
    const view = extractSpeedView(source, lang, sk);
    const v = view({ complete: false, runningTool: { name: 'Skill', startedAt: NOW - 400,
      inputText: '{"name":"查阅","args":{}}' }, characterRate: null, observedMs: 0, startedAt: 1000 });
    assert.equal(v.text, lang === 'en' ? '查阅·executing 0.4s' : '查阅·执行中 0.4s');
    assert.equal(v.phase, 'tool');
  }
});
test('skill without a parsable name keeps the generic verb; long names ellipsize', () => {
  const view = extractSpeedView(source, 'zh', extractSkillName(source));
  const noName = view({ complete: false, runningTool: { name: 'Skill', startedAt: NOW - 400,
    inputText: '{"args":{}}' }, characterRate: null, observedMs: 0, startedAt: 1000 });
  assert.equal(noName.text, 'Skill 0.4s');   // zuToolVerb 恒等桩：真机为「运行技能中 0.4s」
  const long = view({ complete: false, runningTool: { name: 'Skill', startedAt: NOW - 400,
    inputText: '{"name":"' + 'x'.repeat(40) + '"}' }, characterRate: null, observedMs: 0, startedAt: 1000 });
  assert.ok(long.text.startsWith('x'.repeat(24) + '…·执行中'), long.text.slice(0, 40));
});
test('zuSkillName extraction: JSON field, regex fallback, control-char rejection', () => {
  const fn = extractSkillName(source);
  assert.equal(fn('{"name":"查阅"}'), '查阅');
  assert.equal(fn('not json {"name" : "zcode-review"} trailing'), 'zcode-review');
  assert.equal(fn('{"name":"' + 'y'.repeat(30) + '"}'), 'y'.repeat(24) + '…');
  assert.equal(fn('{"name":"a\\u0000b"}'), '');
  assert.equal(fn(''), '');
  assert.equal(fn('{"args":{}}'), '');
});

