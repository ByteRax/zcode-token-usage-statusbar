const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// v176 子代理行内速率 chip：把 v97 逐槽位估算与泵快照 sub.list 的 tps_avg 投到宿主 v4
// Agent 工具行（testid 前缀 v4-subagent-open-side-pane- + childSessionId，与槽位键同源）。
// 夹具：源码切片 + 专用 DOM 桩（前缀选择器/子树类查询/父子链），渲染函数无状态对账的
// 两态/幂等/串号/摘除/pane 隔离/浅色结构，以及 tooltip 构建器与源码契约。

const NOW = 1730000000000;

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
  get nextSibling() {
    if (!this.parentElement) return null;
    const a = this.parentElement.children, i = a.indexOf(this);
    return a[i + 1] || null;
  }
  get parentNode() { return this.parentElement; }
  querySelectorAll(sel) {
    const m = /^\[data-testid\^="(.+)"\]$/.exec(sel);
    const cls = sel.startsWith('.') ? sel.slice(1) : null;
    const out = [];
    const walk = n => {
      for (const c of n.children) {
        const t = c.attrs['data-testid'];
        if (m ? (typeof t === 'string' && t.startsWith(m[1]))
          : (cls && c.classes.has(cls))) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) { const r = this.querySelectorAll(sel); return r[0] || null; }
}

const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), utf());
function utf() { return 'utf8'; }

/* 真实 TPS_BANDS + tpsBand（与条面同源切片），档位类断言不做本地复制 */
function extractTpsBand() {
  const s = source.indexOf('  var TPS_BANDS = [');
  const e = source.indexOf('  /* tooltip 档位行文本', s);
  assert.ok(s >= 0 && e > s, '提取失败: TPS_BANDS/tpsBand');
  return vm.runInNewContext('(function(){' + source.slice(s, e) + '\nreturn tpsBand;})();', {});
}

/* 渲染切片：SUBROW_TID_PREFIX 起（subRowPaneRoot/subRowDurText/subRowTipHTML/renderSubAgentRows）。
 * 闭包自由变量全部经沙箱全局注入，测试直接改 context 字段驱动两态。 */
function extractRender(lang) {
  const s = source.indexOf('    var SUBROW_TID_PREFIX = "v4-subagent-open-side-pane-";');
  const e = source.indexOf('    function subRateTick(', s);
  assert.ok(s >= 0 && e > s, '提取失败: 行内 chip 渲染切片');
  const ctx = vm.createContext({
    L: (zh, en) => (lang === 'en' ? en : zh),
    tpsBand: extractTpsBand(),
    ttEsc: x => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    ttRow: (k, v) => '<div class="rt-row"><b>' + k + '</b><span>' + v + '</span></div>',
    fmt: n => String(Math.round(n)),
    sec: ms => (ms ? (ms / 1000).toFixed(1) + 's' : '–'),
    fmtStart: () => '2026-10-31 10:00',
    zuActiveTurnId: snap => (snap && snap.activeTid) || '',
    DEFAULT_CHARS_PER_TOKEN: 2,
    bridge: { handle: { charsPerToken: 4 } },
    Date: { now: () => NOW },
    document: {
      documentElement: { classList: { contains: () => true } },   // 深色主题（浅色结构另有源码契约）
      createElement: tag => new El(tag),
    },
    inactive: () => false,
    composer: null, wantedEl: null,
    subRate: { slots: {} },
    lastSub: null,
    subTipFor: null,
    showSubTip: () => {}, hideSubTip: () => {},
    state: { show: { subRate: 1 } },   // v178 ⚙ 开关（测试直接改 ctx.state.show.subRate 驱动）
    console,
  });
  const fn = vm.runInContext(
    '(function(){' + source.slice(s, e) +
    '\nreturn { render: renderSubAgentRows, tip: subRowTipHTML, dur: subRowDurText, root: subRowPaneRoot };})();', ctx);
  return { ctx, fn };
}

/* 行夹具：v4 Agent 行 = trigger(testid+title) > [icon, kind, type, .tool-summary-content] */
function makeRow(csid, title) {
  const row = new El('div');
  row.setAttribute('data-testid', 'v4-subagent-open-side-pane-' + csid);
  if (title !== undefined) row.setAttribute('title', title);
  const content = new El('div');
  content.className = 'tool-summary-content min-w-0 flex';
  const desc = new El('span');
  content.appendChild(desc);
  row.appendChild(new El('span'));       // icon
  row.appendChild(new El('span'));       // kind label
  row.appendChild(new El('span'));       // type
  row.appendChild(content);
  return row;
}
function makePane(csid) {
  const root = new El();
  root.setAttribute('data-session-id', 'sid_main');
  const composer = new El('textarea');
  root.appendChild(composer);
  const row = makeRow(csid, 'Review 精简模式线');
  root.appendChild(row);
  return { root, composer, row, content: row.querySelector('.tool-summary-content') };
}
const chipOf = row => row.querySelector('.zu-subrate');

for (const lang of ['zh', 'en']) {
  const est = lang === 'en' ? 'est ' : '估 ';

  test(`${lang}: running slot renders estimate chip after .tool-summary-content`, () => {
    const { ctx, fn } = extractRender(lang);
    const p = makePane('sess_subagent_a');
    ctx.composer = p.composer;
    ctx.subRate.slots['sess_subagent_a'] = { rate: 45.16, at: NOW - 500 };
    fn.render();
    const chip = chipOf(p.row);
    assert.ok(chip, 'chip mounted');
    assert.equal(p.row.children.indexOf(chip), p.row.children.indexOf(p.content) + 1, '紧跟摘要行之后');
    assert.equal(chip.className, 'zu-subrate', '深色主题 chip 本体无 zu-light');
    assert.match(chip.innerHTML, /class="warm"/);
    assert.ok(chip.innerHTML.includes('>' + est + '45.2 t/s<'), '估字头+数值+单位');
    assert.equal(chip.getAttribute('data-zusage-csid'), 'sess_subagent_a');
    assert.equal(chip.__zuT.mode, 'est');
    assert.equal(chip.__zuT.rate, '45.2');
    assert.equal(chip.__zuT.title, 'Review 精简模式线');
    assert.equal(typeof chip.__zuT.buildTip, 'function');
  });

  test(`${lang}: render is idempotent and reuses the same chip node across passes`, () => {
    const { ctx, fn } = extractRender(lang);
    const p = makePane('sess_subagent_a');
    ctx.composer = p.composer;
    ctx.subRate.slots['sess_subagent_a'] = { rate: 152, at: NOW - 100 };
    fn.render();
    const chip = chipOf(p.row);
    fn.render(); fn.render();
    assert.equal(chipOf(p.row), chip, '同节点复用');
    assert.equal(p.row.querySelectorAll('.zu-subrate').length, 1);
    assert.match(chip.innerHTML, /class="zu-teal"/);
    // 速率更新 → 原地改字（同节点、同内层结构）
    ctx.subRate.slots['sess_subagent_a'].rate = 620;
    fn.render();
    assert.equal(chipOf(p.row), chip);
    assert.match(chip.innerHTML, /class="zu-violet"/);   // 500–800 档
    assert.ok(chip.innerHTML.includes('>' + est + '620.0 t/s<'));
  });

  test(`${lang}: thinking phase (null rate) and stale slot (3s gate) show nothing`, () => {
    const { ctx, fn } = extractRender(lang);
    const p = makePane('sess_subagent_a');
    ctx.composer = p.composer;
    ctx.subRate.slots['sess_subagent_a'] = { rate: null, at: NOW - 100 };
    fn.render();
    assert.equal(chipOf(p.row), null, '思考期隐藏');
    ctx.subRate.slots['sess_subagent_a'].rate = 90;
    ctx.subRate.slots['sess_subagent_a'].at = NOW - 4000;
    fn.render();
    assert.equal(chipOf(p.row), null, '>3s 过期不显示');
  });

  test(`${lang}: completed sub switches to real tps_avg on the same node; removal when data gone`, () => {
    const { ctx, fn } = extractRender(lang);
    const p = makePane('sess_subagent_a');
    ctx.composer = p.composer;
    ctx.subRate.slots['sess_subagent_a'] = { rate: 45.16, at: NOW - 500 };
    fn.render();
    const chip = chipOf(p.row);
    ctx.subRate.slots = {};                                  // 槽位收敛
    ctx.lastSub = { list: [{ sid: 'sess_subagent_a', tps_avg: 88.44, task: 'Review 精简模式线', agent: 'general-purpose', output: 4350, requests: 6, last: NOW }] };
    fn.render();
    assert.equal(chipOf(p.row), chip, '同节点切换真实值');
    assert.equal(chip.__zuT.mode, 'real');
    assert.ok(chip.innerHTML.includes('>88.4 t/s<'), '真实值无估字头');
    assert.match(chip.innerHTML, /class="ok"/);
    ctx.lastSub = null;                                      // 数据消失 → 摘除
    fn.render();
    assert.equal(chipOf(p.row), null, '无数据摘除');
  });

  test(`${lang}: pump gap between slot detach and sub.list push leaves chip absent (no frozen estimate)`, () => {
    const { ctx, fn } = extractRender(lang);
    const p = makePane('sess_subagent_a');
    ctx.composer = p.composer;
    ctx.subRate.slots['sess_subagent_a'] = { rate: 45.16, at: NOW - 500 };
    fn.render();
    ctx.subRate.slots = {};
    fn.render();
    assert.equal(chipOf(p.row), null, '间隙期不保留冻结估算');
  });

  test(`${lang}: row testid reassigned to another subagent rewrites chip identity (串号)`, () => {
    const { ctx, fn } = extractRender(lang);
    const p = makePane('sess_subagent_a');
    ctx.composer = p.composer;
    ctx.subRate.slots['sess_subagent_b'] = { rate: 210, at: NOW - 100 };
    fn.render();
    assert.equal(chipOf(p.row), null, '旧 csid 无数据不挂');
    p.row.setAttribute('data-testid', 'v4-subagent-open-side-pane-sess_subagent_b');
    fn.render();
    const chip = chipOf(p.row);
    assert.ok(chip);
    assert.equal(chip.getAttribute('data-zusage-csid'), 'sess_subagent_b');
    assert.equal(chip.__zuT.csid, 'sess_subagent_b');
  });

  test(`${lang}: chip wiped by host rerender is recreated on next pass`, () => {
    const { ctx, fn } = extractRender(lang);
    const p = makePane('sess_subagent_a');
    ctx.composer = p.composer;
    ctx.subRate.slots['sess_subagent_a'] = { rate: 45.16, at: NOW - 500 };
    fn.render();
    chipOf(p.row).remove();                                  // 模拟 React 重挂连带丢弃
    fn.render();
    assert.ok(chipOf(p.row), '下一拍重建');
  });

  test(`${lang}: row without .tool-summary-content falls back to row end`, () => {
    const { ctx, fn } = extractRender(lang);
    const p = makePane('sess_subagent_a');
    p.content.remove();                                      // 空摘要行（宿主 hasSummaryContent=false 分支）
    ctx.composer = p.composer;
    ctx.subRate.slots['sess_subagent_a'] = { rate: 45.16, at: NOW - 500 };
    fn.render();
    const chip = chipOf(p.row);
    assert.ok(chip);
    assert.equal(chip.parentElement, p.row, '退回行末尾');
    assert.equal(p.row.children[p.row.children.length - 1], chip);
  });

  test(`${lang}: scan is scoped to this pane's session shell (split-view same session isolation)`, () => {
    const { ctx, fn } = extractRender(lang);
    const a = makePane('sess_subagent_a'), b = makePane('sess_subagent_a');
    ctx.subRate.slots['sess_subagent_a'] = { rate: 45.16, at: NOW - 500 };
    ctx.composer = a.composer;
    fn.render();
    assert.ok(chipOf(a.row), '本 pane 行有 chip');
    assert.equal(chipOf(b.row), null, '另一 pane 同会话行不受染指');
    ctx.composer = b.composer;
    fn.render();
    assert.ok(chipOf(b.row));
    assert.equal(b.row.querySelector('.zu-subrate').getAttribute('data-zusage-csid'), 'sess_subagent_a');
  });

  test(`${lang}: no [data-session-id] ancestor → render is a no-op (fail-closed root)`, () => {
    const { ctx, fn } = extractRender(lang);
    const root = new El();                                   // 无 data-session-id（桥未打/结构未知）
    const composer = new El('textarea');
    root.appendChild(composer);
    const row = makeRow('sess_subagent_a');
    root.appendChild(row);
    ctx.composer = composer;
    ctx.subRate.slots['sess_subagent_a'] = { rate: 45.16, at: NOW - 500 };
    fn.render();
    assert.equal(chipOf(row), null, '定位不到 pane 壳不写任何 DOM');
  });

  test(`${lang}: ⚙ switch off removes chips and suppresses hover tip; on rebuilds`, () => {
    const { ctx, fn } = extractRender(lang);
    const p = makePane('sess_subagent_a');
    ctx.composer = p.composer;
    ctx.subRate.slots['sess_subagent_a'] = { rate: 45.16, at: NOW - 500 };
    fn.render();
    assert.ok(chipOf(p.row), '开启（默认）时挂载');
    let hidden = 0;
    ctx.hideSubTip = () => { hidden++; };
    ctx.subTipFor = chipOf(p.row);            // 模拟悬停中
    ctx.state.show.subRate = 0;               // ⚙ 关闭（data-k 通用 handler 写 state.show 后心跳对账）
    fn.render();
    assert.equal(chipOf(p.row), null, '关闭即摘除已有 chip');
    assert.ok(hidden >= 1, '收起本 pane 悬停浮层');
    fn.render();                              // 关闭态重复渲染不复活
    assert.equal(chipOf(p.row), null);
    ctx.state.show.subRate = 1;               // ⚙ 重开：心跳自然重建
    fn.render();
    assert.ok(chipOf(p.row), '重开重建');
  });

  test(`${lang}: switch off in one pane never hides another pane's open tooltip`, () => {
    const { ctx, fn } = extractRender(lang);
    const a = makePane('sess_subagent_a'), b = makePane('sess_subagent_a');
    ctx.subRate.slots['sess_subagent_a'] = { rate: 45.16, at: NOW - 500 };
    // 先在 b pane 渲染出 chip 并模拟悬停
    ctx.composer = b.composer;
    fn.render();
    const rowB = b.composer.parentElement.querySelectorAll('[data-testid^="v4-subagent-open-side-pane-"]')[0];
    const chipB = rowB.querySelector('.zu-subrate');
    assert.ok(chipB, 'b pane chip 已挂载');
    ctx.composer = a.composer;
    fn.render();
    let hidden = 0;
    ctx.hideSubTip = () => { hidden++; };
    ctx.subTipFor = chipB;
    ctx.state.show.subRate = 0;               // a pane 关闭
    fn.render();
    assert.ok(chipB.isConnected, 'b pane 的 chip 不受染指');
    assert.equal(hidden, 0, '别的 pane 的悬停浮层不被收起');
  });

  test(`${lang}: subRowDurText zh/en segment rules (紧邻中文 / 英文数字留空格)`, () => {
    const { fn } = extractRender(lang);
    assert.equal(fn.dur(95000), lang === 'en' ? '1m 35s' : '1分35秒');
    assert.equal(fn.dur(5000), lang === 'en' ? '5s' : '5秒');
    assert.equal(fn.dur(60000), lang === 'en' ? '1m' : '1分');
    assert.equal(fn.dur(400), '0.4s');                       // <1s 走 sec()
  });

  test(`${lang}: estimate tooltip — elapsed time, calibrated output, escaping`, () => {
    const { ctx, fn } = extractRender(lang);
    const p = makePane('sess_subagent_a');
    ctx.composer = p.composer;
    ctx.subRate.slots['sess_subagent_a'] = {
      rate: 45.16, at: NOW - 500, calib: null,
      store: { getState: () => ({ snapshot: { activeTid: 't1' } }) },
      tracker: { get: id => (id === 't1' ? { startedAt: NOW - 95000, totalCharacters: 8800, complete: false } : null) },
    };
    fn.render();
    const html = fn.tip(chipOf(p.row).__zuT);
    assert.match(html, /zusage-subrate-tip \.rt-row/);       // 作用域样式随内容走
    assert.match(html, /Review 精简模式线/);                  // 行 title 兜底名
    assert.match(html, new RegExp('<b>' + (lang === 'en' ? 'Estimate' : '估速') + '</b><span>45.2 t/s'));
    assert.match(html, new RegExp((lang === 'en' ? 'Running for' : '已运行') + '</b><span>' + (lang === 'en' ? '1m 35s' : '1分35秒')));
    assert.match(html, /≈2200 token/);                       // 8800 字符 ÷ 主桥 c2t 4
    assert.match(html, lang === 'en' ? /Text-delta estimate/ : /字符增量估算/);
  });

  test(`${lang}: real tooltip — task name, agent, output/requests/last; hostile task escaped`, () => {
    const { ctx, fn } = extractRender(lang);
    const p = makePane('sess_subagent_a', '');
    ctx.composer = p.composer;
    ctx.lastSub = { list: [{ sid: 'sess_subagent_a', tps_avg: 88.44, task: 'Review <script>alert(1)</script>', agent: 'general-purpose', output: 4350, requests: 6, last: NOW }] };
    fn.render();
    const html = fn.tip(chipOf(p.row).__zuT);
    assert.match(html, /Review &lt;script&gt;/, '动态名转义');
    assert.ok(!html.includes('<script>'));
    assert.match(html, /general-purpose/);
    assert.match(html, new RegExp('<b>' + (lang === 'en' ? 'Average rate' : '平均速率') + '</b><span>88.4 t/s'));
    assert.match(html, /4350 token/);
    assert.match(html, new RegExp((lang === 'en' ? 'Requests' : '请求数') + '</b><span>6'));
    assert.match(html, /2026-10-31 10:00/);
  });
}

test('light theme structure: band class rides inner span, zu-light on chip body (descendant selectors)', () => {
  const s = source.indexOf('    var SUBROW_TID_PREFIX = "v4-subagent-open-side-pane-";');
  const e = source.indexOf('    function subRateTick(', s);
  const slice = source.slice(s, e);
  assert.match(slice, /var cls = "zu-subrate" \+ \(dark \? "" : " zu-light"\)/);
  assert.match(slice, /'<span class="' \+ bandCls \+ '">'/);
  // 浅色加深版是后代选择器，chip 本体携带 zu-light 时档位类必须在子节点上
  assert.match(source, /"\.zu-light \.ok\{color:#0f9d6c\}/);
});

test('source contracts: updateLive hook, scan cleanup, delegation listener, CSS rule, version', () => {
  assert.match(source, /renderSubAgentRows\(\);   \/\/ v176：Agent 行内速率 chip 对账/, 'updateLive 挂渲染通道');
  assert.match(source, /if \(subTipFor && !subTipFor\.isConnected\) hideSubTip\(\);/, 'scanRateLines detach 兜底收起');
  assert.ok(source.includes('e.target.closest(".zu-subrate")'), 'document 委托悬停（免逐 chip 监听）');
  assert.match(source, /"\.zu-subrate\{flex:0 0 auto;white-space:nowrap;cursor:help/, 'chip 样式入注入块');
  assert.match(source, /var VERSION = "v190";/);   // v187 补回 v181 工具组状态词（PR #161 遗漏的 turn-stats/overlay 块，2026-10-31）
  // v179/v180 review P1：调用侧形状锁——showSubTip 以数据包调 buildTip（v178 回归即红）
  assert.ok(source.includes('el.__zuT.buildTip(el.__zuT)'), 'tooltip 数据包调用约定');
  assert.ok(source.includes("runningSubagents.length - 1"), '截断从尾部取（最新派发优先）');
  assert.match(source, /__zusageAcquireConversationStore/, '桥 v2 acquire 访问器消费点');
  assert.match(source, /sid\.indexOf\("sess_subagent_"\) !== 0/, 'acquire 限子代理前缀');
  // 委托 mouseout 不得把移入浮层当作离开（提示 180ms 延迟收起与 tpsTip 同款）
  assert.match(source, /subTip\.contains\(to\)/);
});

test('source contracts: ⚙ subRate switch (seed, panel row, render gate)', () => {
  assert.match(source, /subRate: 1 \},/, 'state.show 种子默认开');
  assert.match(source, /data-k="subRate"/, '⚙ 面板行（data-k 通用 handler 零接线）');
  assert.match(source, /if \(!state\.show\.subRate\) \{/, '渲染门控读开关');
  assert.match(source, /rootEl\.contains\(subTipFor\) \|\| !subTipFor\.isConnected/, '只收本 pane 浮层');
});
