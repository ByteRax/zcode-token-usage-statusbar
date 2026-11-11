const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readOverlaySource, getNamedSlice } = require('./helpers/overlay-extract.cjs');

// v332 工作流 run 卡 chip（specs/workflow-support.md）：会话流宿主动态工作流卡片上的
// 汇总 chip。分组按「已知 runId 集合」前缀匹配（runId 自身含 `-`，不可从 sid 反推）；
// 速率 = sub.list 行 tps_out/tps_gen 分量的 Σout ÷ Σgen（不能对各 tps_avg 平均）；
// 运行状态实时读卡 DOM（data-workflow-card-state + [data-agent-status]）。
// 夹具沿用 overlay-subagent-row 的源码切片 + DOM 桩模式，选择器桩扩展精确 testid
// 与裸属性两种形态。

const NOW = 1730000000000;
const RUN = 'dwfrun-0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b';   // 宿主 runId 本身含 `-`
const WF_SID = 'sess_dwf-' + RUN + '-judge-1@1';
const WF_SID2 = 'sess_dwf-' + RUN + '-writer-2@2';

class El {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.children = []; this._cls = ''; this.classes = new Set();
    this.attrs = {}; this.textContent = ''; this.innerHTML = '';
    this.parentElement = null; this.isConnected = true;
  }
  get className() { return this._cls; }
  set className(v) { this._cls = String(v); this.classes = new Set(this._cls.split(/\s+/).filter(Boolean)); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
  appendChild(c) { c.parentElement = this; this.children.push(c); c.isConnected = true; return c; }
  insertBefore(c, ref) {
    if (!ref || ref.parentElement !== this) return this.appendChild(c);
    const i = this.children.indexOf(ref);
    this.children.splice(i, 0, c); c.parentElement = this; c.isConnected = true; return c;
  }
  remove() {
    if (this.parentElement) {
      const a = this.parentElement.children, i = a.indexOf(this);
      if (i >= 0) a.splice(i, 1);
    }
    this.parentElement = null; this.isConnected = false;
  }
  contains(el) { return el === this || this.children.some(c => c.contains(el)); }
  get parentNode() { return this.parentElement; }
  get nextSibling() {
    if (!this.parentElement) return null;
    const a = this.parentElement.children, i = a.indexOf(this);
    return a[i + 1] || null;
  }
  get classList() { const s = this.classes; return { contains: c => s.has(c) }; }   // DOMTokenList 形态（renderWorkflowCards 关闭分支消费）
  querySelectorAll(sel) {
    const pref = /^\[data-testid\^="(.+)"\]$/.exec(sel);
    const exact = /^\[data-testid="(.+)"\]$/.exec(sel);
    const bare = /^\[([a-z-]+)\]$/.exec(sel);   // [data-agent-status] 裸属性
    const cls = sel.startsWith('.') ? sel.slice(1) : null;
    const out = [];
    const walk = n => {
      for (const c of n.children) {
        const t = c.attrs['data-testid'];
        if (pref ? (typeof t === 'string' && t.startsWith(pref[1]))
          : exact ? (t === exact[1])
          : bare ? Object.prototype.hasOwnProperty.call(c.attrs, bare[1])
          : (cls && c.classes.has(cls))) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) { const r = this.querySelectorAll(sel); return r[0] || null; }
}

const source = readOverlaySource();

function extractTpsBand() {
  return vm.runInNewContext('(function(){' + getNamedSlice('tpsBandOnly') + '\nreturn tpsBand;})();', {});
}

/* 渲染切片：WF_CARD_TID 起（wfRunsFromList/wfRunStateOf/wfRunTipHTML/renderWorkflowCards）。
 * subRowPaneRoot 在 subAgentRows 区（切片外），按同语义注入：composer 父链的 pane 壳。 */
function extractWf(lang) {
  const ctxObj = {
    L: (zh, en) => (lang === 'en' ? en : zh),
    tpsBand: extractTpsBand(),
    ttEsc: x => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    ttRow: (k, v) => '<div class="rt-row"><b>' + k + '</b><span>' + v + '</span></div>',
    fmt: n => String(Math.round(n)),
    Date: { now: () => NOW },
    document: {
      documentElement: { classList: { contains: () => true } },
      createElement: tag => new El(tag),
    },
    inactive: () => false,
    composer: null, wantedEl: null,
    lastSub: null,
    subTipFor: null,
    showSubTip: () => {}, hideSubTip: () => {},
    state: { show: { wfChip: 1 } },
    console,
  };
  ctxObj.subRowPaneRoot = () => (ctxObj.composer && ctxObj.composer.parentElement) || null;
  const ctx = vm.createContext(ctxObj);
  const fn = vm.runInContext(
    '(function(){' + getNamedSlice('wfRunCards') +
    '\nreturn { render: renderWorkflowCards, runs: wfRunsFromList, tip: wfRunTipHTML, stateOf: wfRunStateOf };})();', ctx);
  return { ctx, fn };
}

/* 卡夹具：pane 壳 > composer + workflow-card（runId/状态属性 + status 行 + running 药丸） */
function makeCard(runId, opts = {}) {
  const root = new El();
  root.setAttribute('data-session-id', 'sid_main');
  const composer = new El('textarea');
  root.appendChild(composer);
  const card = new El('section');
  card.setAttribute('data-testid', 'workflow-card');
  card.setAttribute('data-workflow-run-id', runId);
  card.setAttribute('data-workflow-card-state', opts.state || 'running');
  const status = new El('div');
  status.className = 'workflow-card-status';
  card.appendChild(status);
  const body = new El('div');
  body.className = 'workflow-card-body';
  for (let i = 0; i < (opts.pills || 0); i++) {
    const pill = new El('span');
    pill.setAttribute('data-agent-status', 'running');
    body.appendChild(pill);
  }
  card.appendChild(body);
  root.appendChild(card);
  return { root, composer, card, status };
}
const chipOf = card => card.querySelector('.zu-wfrun');

for (const lang of ['zh', 'en']) {
  test(`${lang}: runs group by known runId prefix (runId itself contains dashes)`, () => {
    const { ctx, fn } = extractWf(lang);
    ctx.lastSub = { list: [
      { sid: WF_SID, total: 120, requests: 2, tps_out: 300, tps_gen: 3000, tps_avg: 100, task: '研究员·通识', title: '' },
      { sid: WF_SID2, total: 80, requests: 1, tps_out: 200, tps_gen: 1000, tps_avg: 200, task: '', title: 'writer' },
      { sid: 'sess_dwf-other-run-x@1', total: 999, requests: 9, tps_out: 1, tps_gen: 1, tps_avg: 1, task: '' },
      { sid: 'sess_subagent_a', total: 500, requests: 5, tps_out: 5, tps_gen: 5, tps_avg: 1, task: '' },
    ] };
    const runs = fn.runs([RUN]);
    assert.deepEqual(Object.keys(runs), [RUN], '未知 runId 的行与非工作流行都不进组');
    const g = runs[RUN];
    assert.equal(g.total, 200);
    assert.equal(g.requests, 3);
    assert.equal(g.actors.length, 2);
    assert.ok(Math.abs(g.outSum - 500) < 1e-9 && Math.abs(g.genSum - 4000) < 1e-9, 'Σ 分量');
  });

  test(`${lang}: empty runId list yields no groups`, () => {
    const { ctx, fn } = extractWf(lang);
    ctx.lastSub = { list: [{ sid: WF_SID, total: 1, requests: 1, tps_out: 1, tps_gen: 1, tps_avg: 1, task: '', title: '' }] };
    assert.deepEqual(Object.keys(fn.runs([])), []);
  });

  test(`${lang}: chip mounts after .workflow-card-status with token and weighted rate`, () => {
    const { ctx, fn } = extractWf(lang);
    const p = makeCard(RUN, { pills: 2 });
    ctx.composer = p.composer;
    ctx.lastSub = { list: [
      { sid: WF_SID, total: 120, requests: 2, tps_out: 300, tps_gen: 3000, tps_avg: 100, task: '研究员·通识', title: '' },
      { sid: WF_SID2, total: 80, requests: 1, tps_out: 200, tps_gen: 1000, tps_avg: 200, task: '', title: 'writer' },
    ] };
    fn.render();
    const chip = chipOf(p.card);
    assert.ok(chip, 'chip mounted');
    assert.equal(p.card.children.indexOf(chip), p.card.children.indexOf(p.status) + 1, '紧跟卡状态行之后');
    assert.equal(chip.className, 'zu-wfrun', '深色主题本体无 zu-light');
    assert.ok(chip.innerHTML.includes('200 · 125.0 t/s<'), 'token 合计 + Σout÷Σgen 加权（500/4000=125，非 tps_avg 平均 150）');
    assert.equal(chip.__zuT.total, 200);
    assert.equal(chip.__zuT.rate, '125.0');
    assert.equal(chip.__zuT.running, 2, 'running 药丸计数进包');
    assert.equal(chip.__zuT.actors[0].name, '研究员·通识');
    assert.equal(chip.__zuT.actors[1].name, 'writer');
  });

  test(`${lang}: render is idempotent and updates in place`, () => {
    const { ctx, fn } = extractWf(lang);
    const p = makeCard(RUN, { pills: 1 });
    ctx.composer = p.composer;
    ctx.lastSub = { list: [{ sid: WF_SID, total: 10, requests: 1, tps_out: 100, tps_gen: 1000, tps_avg: 100, task: 'a', title: '' }] };
    fn.render();
    const chip = chipOf(p.card);
    fn.render(); fn.render();
    assert.equal(chipOf(p.card), chip, '同节点复用');
    assert.equal(p.card.querySelectorAll('.zu-wfrun').length, 1);
    ctx.lastSub.list[0].total = 20;
    fn.render();
    assert.equal(chipOf(p.card), chip);
    assert.ok(chip.innerHTML.includes('20 · '), 'token 更新原地改字');
  });

  test(`${lang}: fresh run with no DB rows shows running-only chip`, () => {
    const { ctx, fn } = extractWf(lang);
    const p = makeCard(RUN, { pills: 1 });
    ctx.composer = p.composer;
    ctx.lastSub = { list: [] };
    fn.render();
    const chip = chipOf(p.card);
    assert.ok(chip, '仅 DOM 运行状态也渲染');
    assert.ok(chip.innerHTML.includes((lang === 'en' ? 'running' : '运行中') + '<'), '只显运行中词');
    assert.equal(chip.__zuT.total, 0);
    assert.equal(chip.__zuT.rate, null);
  });

  test(`${lang}: no workflow cards in pane is a no-op`, () => {
    const { ctx, fn } = extractWf(lang);
    const root = new El();
    root.setAttribute('data-session-id', 'sid_main');
    const composer = new El('textarea');
    root.appendChild(composer);
    ctx.composer = composer;
    ctx.lastSub = { list: [{ sid: WF_SID, total: 5, requests: 1, tps_out: 1, tps_gen: 1, tps_avg: 1, task: '', title: '' }] };
    fn.render();   // 不抛错即可
    assert.equal(root.querySelectorAll('.zu-wfrun').length, 0);
  });

  test(`${lang}: wfChip switch off strips chips and hides the hover tip`, () => {
    const { ctx, fn } = extractWf(lang);
    const p = makeCard(RUN, { pills: 1 });
    ctx.composer = p.composer;
    ctx.lastSub = { list: [{ sid: WF_SID, total: 5, requests: 1, tps_out: 1, tps_gen: 1, tps_avg: 1, task: '', title: '' }] };
    fn.render();
    assert.ok(chipOf(p.card));
    const hidden = [];
    ctx.state.show.wfChip = 0;
    ctx.subTipFor = chipOf(p.card);
    ctx.hideSubTip = () => hidden.push(1);
    fn.render();
    assert.equal(chipOf(p.card), null, '关闭即摘净');
    assert.equal(hidden.length, 1, '本 pane 悬停浮层同步收起');
  });

  test(`${lang}: tooltip builder renders actors, basis line only with rate`, () => {
    const { ctx, fn } = extractWf(lang);
    const pack = {
      runId: RUN, runShort: RUN.slice(-12), state: 'running', running: 1,
      total: 200, requests: 3, rate: '125.0',
      actors: [{ name: '研究员·通识', total: 120, tps: '100.0' }, { name: 'writer', total: 80, tps: null }],
    };
    const html = fn.tip(pack);
    assert.ok(html.includes('125.0'), '聚合速率行');
    const basis = lang === 'en' ? 'Completed-segment weighted average' : 'Σ输出 ÷ Σ生成耗时';
    assert.ok(html.includes(basis), '口径行随速率出现');
    assert.ok(html.includes('研究员·通识') && html.includes('100.0'), 'actor 名与速率');
    assert.ok(html.includes('80') && !/80 · /.test(html), '无速率 actor 只显 token');
    const noRate = fn.tip({ ...pack, rate: null });
    assert.ok(!noRate.includes(basis), '旧快照缺分量 → 无速率无口径行');
  });
}

test('source contracts: wf chip wiring (style, panel row, delegation, reapply points)', () => {
  assert.match(source, /"\.zu-wfrun\{flex:0 0 auto;white-space:nowrap;cursor:help/, 'chip 样式入注入块');
  assert.match(source, /data-k="wfChip"/, '⚙ 面板行（data-k 通用 handler 零接线）');
  assert.match(source, /if \(!state\.show\.wfChip\) \{/, '渲染门控读开关');
  assert.match(source, /e\.target\.closest\("\.zu-subrate,\.zu-wfrun"\)/, '委托判定含工作流 chip（零新增监听）');
  assert.match(source, /closest\("\.zu-wfrun"\) === subTipFor/, 'mouseout 离开判定同步');
  assert.match(source, /renderWorkflowCards\(\);   \/\/ v332：工作流 run 卡 chip 数据点 reapply/, 'render 尾部数据点');
  assert.match(source, /renderWorkflowCards\(\);   \/\/ v332：工作流 run 卡 chip DOM 对账点/, 'heavy DOM 对账点');
  assert.match(source, /indexOf\("sess_dwf-" \+ runIds\[r\] \+ "-"\)/, 'runId 前缀匹配（runId 自身含连字符）');
  assert.match(source, /card\.querySelector\("\.workflow-card-status"\)/, '插入锚=卡状态行');
  assert.match(source, /wfRunTipHTML/, 'tooltip 构建器在切片内');
});
