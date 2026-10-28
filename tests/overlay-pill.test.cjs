/* 紧凑药丸形态（v120）行为验证：
 * 1) 状态与持久化：zusage3.pill 默认关、显式 "1" 开、persist 回写；
 * 2) track() 几何：药丸水平居中于输入卡且不锁卡宽，默认形态保持左对齐 + 锁卡宽（回归）；
 * 3) heavy() 挂载：药丸短路 mountInCard（永不进卡），回落 below-card + 让位带；
 * 4) 接线完整性：⚙ 通用开关行、change 分支、render 皮肤类对账、CSS 规则齐备。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');

function extract(start, end, from = 0) {
  const a = source.indexOf(start, from);
  const b = a >= 0 ? source.indexOf(end, a) : -1;
  assert.ok(a >= 0 && b > a, `提取失败: ${start}`);
  return source.slice(a, b + end.length);
}
function runInVm(code, sandbox) {
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox;
}

test('状态与持久化：pill 默认关、显式开启、persist 回写', () => {
  // 截止行在 persist 函数体内部，补收口花括号保持切片可独立求值
  const slice = extract('var LS = { show:', 'lsSet(LS.sec, state.settingsSec);') + '\n}';
  const mk = (stored) => {
    const store = {};
    const sb = runInVm(slice, {
      window: {},
      JSON,
      localStorage: {
        getItem: k => (k in stored ? stored[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
      },
      stored,
    });
    return { sb, store };
  };
  // 缺省：pill 关
  const a = mk({});
  assert.equal(a.sb.state.pill, 0);
  a.sb.persist();
  assert.equal(a.store['zusage3.pill'], '0');
  // 显式 "1"：开；改回 0 后 persist 回写 "0"
  const b = mk({ 'zusage3.pill': '1' });
  assert.equal(b.sb.state.pill, 1);
  b.sb.state.pill = 0;
  b.sb.persist();
  assert.equal(b.store['zusage3.pill'], '0');
  // 其余共享键不受影响（回归：show/lang/sec 照旧）
  const c = mk({ 'zusage3.show': '{"turn":0}', 'zusage3.lang': 'en', 'zusage3.sec': 'quota' });
  assert.equal(c.sb.state.show.turn, 0);
  assert.equal(c.sb.state.lang, 'en');
  assert.equal(c.sb.state.settingsSec, 'quota');
});

test('track() 几何：药丸居中于输入卡且不锁宽；默认形态左对齐 + 锁卡宽', () => {
  // 截止行落在 else 块内部，补一个收口花括号保持切片可独立求值
  const slice = extract('var left = Math.round(ar.left);', 'bar.style.maxWidth = minW + "px";') + '\n}';
  const mk = (pill, card, barW) => {
    const bar = { offsetWidth: barW, style: {} };
    const lastPos = [-1, -1];
    const sb = runInVm(slice, {
      state: { pill },
      ar: { left: card.left, width: card.width, bottom: card.bottom },
      innerHeight: 900,
      bar,
      lastPos,
      Math,
    });
    return { bar, lastPos, sb };
  };
  const card = { left: 300, width: 800, bottom: 700 };
  // 药丸：条宽 240 → left = 300 + (800-240)/2 = 580；不写 min/max-width
  const p = mk(1, card, 240);
  assert.equal(p.bar.style.left, '580px');
  assert.equal(p.bar.style.maxWidth, undefined);
  assert.equal(p.bar.style.minWidth, undefined);
  // 药丸贴视口左缘夹回（卡片极窄、条更宽时不出屏）
  const narrow = mk(1, { left: 0, width: 100, bottom: 700 }, 240);
  assert.equal(narrow.bar.style.left, '8px');
  // 默认形态：左对齐卡片左缘，min=max=卡宽（回归）
  const d = mk(0, card, 240);
  assert.equal(d.bar.style.left, '300px');
  assert.equal(d.bar.style.minWidth, '800px');
  assert.equal(d.bar.style.maxWidth, '800px');
  // 默认形态残留的药丸内联锁会被重写成卡宽（不会卡在旧值）
  assert.ok('minWidth' in d.bar.style);
});

test('heavy() 挂载：药丸短路 mountInCard，恒 below-card + 让位带', () => {
  const anchor = source.indexOf('cardMode = state.pill ? false : mountInCard();');
  assert.ok(anchor > 0, '药丸挂载短路缺失');
  const a = source.lastIndexOf('if (cardCache) {', anchor);
  const b = source.indexOf('nativeCtxVal = readNativeCtx(cardCache);', anchor);
  assert.ok(a >= 0 && b > a, '挂载分支提取失败');
  // 截止行在 if 块内部，补收口花括号；else-if(cardMode) 回落分支在源码层断言
  const slice = source.slice(a, b + 'nativeCtxVal = readNativeCtx(cardCache);'.length) + '\n}';
  assert.ok(/else if \(cardMode\) \{\s*mountBelowCard\(\);/.test(source), 'else-if 回落分支缺失');
  const mk = (pill, hasCard) => {
    const calls = { inCard: 0, below: 0, pad: 0, pads: 0 };
    const sb = runInVm(slice, {
      cardCache: hasCard ? {} : null,
      cardMode: false,
      state: { pill },
      mountInCard: () => { calls.inCard++; return true; },
      releasePads: () => { calls.pads++; },
      mountBelowCard: () => { calls.below++; },
      ensureCardPad: () => { calls.pad++; },
      readNativeCtx: () => 0,
    });
    return { calls, sb };
  };
  // 药丸开：不进卡，below-card + 让位带
  const on = mk(1, true);
  assert.equal(on.calls.inCard, 0);
  assert.equal(on.calls.below, 1);
  assert.equal(on.calls.pad, 1);
  assert.equal(on.sb.cardMode, false);
  // 默认：优先进卡（回归）
  const off = mk(0, true);
  assert.equal(off.calls.inCard, 1);
  assert.equal(off.sb.cardMode, true);
  assert.equal(off.calls.pads, 1);
});

test('接线完整性：开关行 / change 分支 / 皮肤类对账 / CSS 规则', () => {
  // ⚙ 通用分区有开关行（双语）
  assert.ok(source.includes('class="zu-pill-mode"'), '设置面板缺少药丸开关');
  assert.ok(source.includes('紧凑药丸样式') && source.includes('Compact pill style'));
  // change 分支：写状态 → persist → applyPillMode → renderAll
  const branch = extract('t2.classList.contains("zu-pill-mode")', 'renderAll(false);');
  assert.ok(branch.includes('persist()'));
  assert.ok(branch.includes('applyPillMode()'));
  // render 对账皮肤类（多实例共享 state 的收敛点）
  assert.ok(source.includes('bar.classList.toggle("zu-pill", !!state.pill);'));
  // 条创建时带皮（重挂载前生效）
  assert.ok(source.includes('if (state.pill) bar.classList.add("zu-pill");'));
  // CSS：药丸皮与分隔距
  assert.ok(source.includes('.zusage-root.zu-pill{'), '缺少药丸 CSS');
  assert.ok(source.includes('.zu-pill .sep{'));
  // 弹层白卡皮肤：固定浅色板 + 表面接线（applyPillMode 切换 / 创建时带皮）
  assert.ok(source.includes('.zu-pill-skin{'), '缺少弹层皮肤 CSS');
  assert.ok(source.includes('.zu-pill-skin .rt-row b{color:#6b7280}'));
  const skinTargets = ['rateTip', 'quotaTip', 'gitTip', 'tip', 'subPanel', 'excBubble'];
  const ap = extract('function applyPillMode()', 'else if (cardMode) {');
  assert.ok(ap.includes('mountBelowCard()'));
  for (const t of skinTargets) {
    assert.ok(ap.includes(t), `applyPillMode 未覆盖弹层 ${t}`);
    assert.equal(source.split(`if (state.pill) ${t}.classList.add("zu-pill-skin");`).length - 1, 1,
      `创建时缺 ${t} 皮肤接线`);
  }
  // 固定浅色板关键值（DSH 观感）
  assert.ok(source.includes('.zu-pill .it .ico{color:#3b82f6}'));
  assert.ok(source.includes('.zu-pill .ok{color:#16a34a}.zu-pill .warm{color:#d97706}.zu-pill .hot{color:#ef4444}'));
  assert.ok(source.includes("Microsoft YaHei UI"));
  // v125 药丸：条面只留核心数据（缓存命中率/次数/轮数/耗时/首字 收进 tooltip）
  assert.ok(source.includes('(shrink || state.pill ? "" : cachePct(lt.cache_read, lt.input))'));
  assert.ok(source.includes('(shrink || state.pill ? "" : cachePct(sess.cache_read, sess.input))'));
  // 万/亿单位：药丸形态固定 K/M/B
  assert.ok(source.includes('function cnUnits() { return state.lang !== "en" && !!state.cnNum && !state.pill; }'));
  // 逐帧性能：药丸宽缓存 + render 条件写类 + 关闭毛玻璃
  assert.ok(source.includes('bar.__zuPillW = bar.offsetWidth;'));
  assert.ok(source.includes('(ar.width - (bar.__zuPillW || bar.offsetWidth))'));
  assert.ok(source.includes('if (bar.classList.contains("zu-pill") !== pillOn) bar.classList.toggle("zu-pill", pillOn);'));
  assert.ok(source.includes('"backdrop-filter:none;-webkit-backdrop-filter:none;" +'));
  // 原生上下文按钮档位色固定 DSH 浅色板（v134 五档映射：calm/norm 绿 · mid/high 黄 · crit 红）
  assert.ok(source.includes('[data-testid=chat-context-usage-trigger][data-zusage-pill][data-zusage-band=calm]{color:#16a34a!important}'));
  assert.ok(source.includes('[data-testid=chat-context-usage-trigger][data-zusage-pill][data-zusage-band=crit]{color:#ef4444!important}'));
  assert.ok(source.includes('if (state.pill && !pill) el.setAttribute("data-zusage-pill", "1");'));
  // 额度 chip 燃烧率口径（药丸）：仅 5h/7d 窗、回退保留旧口径、五档类名映射
  assert.ok(source.includes('function pillQuotaBurn(pct, resetsAt, windowMs, now)'));
  assert.ok(source.includes('state.pill && (defs[i][0] === "fiveHour" || defs[i][0] === "weekly")'));
  assert.ok(source.includes('(s.burn ? s.burnBand : quotaBandOf(s.pct))'));
  assert.ok(source.includes('.zu-quota[data-zusage-pill] .zu-qseg.zu-qb-calm{color:#16a34a}'));
  const burn = extract('function pillQuotaBurn(pct, resetsAt, windowMs, now)', 'return { label: used + " " + Math.round(pct) + "%", band: band };') + '\n}';
  const runBurn = (pct, resetsAt, windowMs, now) => {
    const sb = runInVm(burn, { resetsAt, windowMs, now, Date, isFinite, Math });
    return sb.pillQuotaBurn(pct, resetsAt, windowMs, now);
  };
  // 21% 已用、窗口已过 1.23h → 外推 ~85%：绿，标签 1.23/5h 21%
  const now = 1793100000000;
  const g = runBurn(21, now + (5 - 1.23) * 3600000, 18000000, now);
  assert.equal(g.band, 'zu-qb-calm');
  assert.equal(g.label, '1.23/5h 21%');
  // 2h 已用 48% → 外推 120%：红
  assert.equal(runBurn(48, now + 3 * 3600000, 18000000, now).band, 'zu-qb-crit');
  // 2.5h 已用 48% → 外推 96%：黄
  assert.equal(runBurn(48, now + 2.5 * 3600000, 18000000, now).band, 'zu-qb-mid');
  // 窗口刚重置（已过 <5%）→ 外推不可靠按宽裕
  assert.equal(runBurn(30, now + 4.9 * 3600000, 18000000, now).band, 'zu-qb-calm');
  // 周窗：天为单位，1 位小数
  const w = runBurn(41, now + (7 - 3.4) * 86400000, 604800000, now);
  assert.equal(w.label, '3.4/7d 41%');
  // 无重置时间 → null（回退旧口径）
  assert.equal(runBurn(21, null, 18000000, now), null);
  // ISO 字符串重置时间可解析
  const iso = runBurn(21, new Date(now + 3.77 * 3600000).toISOString(), 18000000, now);
  assert.equal(iso.band, 'zu-qb-calm');
  assert.ok(iso.label.startsWith('1.23/5h'));
});
