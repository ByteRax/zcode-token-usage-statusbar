'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const { sliceOverlay } = require('./helpers/overlay-extract.cjs');

const dockSource =
  sliceOverlay('  function qTime(v)', '  function qTimeS(v)') +
  sliceOverlay('  function quotaRemainPct(pct)', '  function quotaStatusText(st)') +
  sliceOverlay('  function onRefreshKeydown(e)', '  window.addEventListener("keydown", onGitKeydown') +
  `function pane(slot) {
    var quotaChipCache = null, lastQuota, lastQuotaAll, quotaProvider, quotaModel, quotaSourceId;
    var ariaLiveState = {}, bar = { classList: { contains: () => light } };
    var state = { quotaEnabled: true }, disposed = false, light = false, lang = 'en';
    var L = (zh, en) => lang === 'en' ? en : zh, FATAL = {}, quotaTipFor = null;
    var inactive = () => disposed, effectiveQuotaProvider = () => quotaProvider;
    var pluginRequest = (action, payload) => requests.push([action, payload && payload.sourceId]);
    var onQuotaEnter = () => {}, hideQuotaTip = () => {}, showQuotaTip = () => {};
    var quotaBalanceText = bal => '$' + bal.amount;
    var quotaStatusText = st => st;
    ${sliceOverlay('    var QUOTA_BANDS = ', '    /* 上下文分档口径')}
    ${sliceOverlay('    function syncCtxLite(el, lite)', '    function restoreCtxButton(btn)')}
    ${sliceOverlay('    function quotaBandOf(pct)', '    /* ---------- v344 增强提示词按钮')}
    return {
      push(q, sourceId = 'one', useLight = false) {
        lastQuota = q; quotaSourceId = sourceId; light = useLight; quotaProvider = 'account:bigmodel';
      },
      view() {
        const mode = quotaChipMode();
        if (!mode) return null;
        const view = quotaDockView(mode);
        return { ...view, html: quotaDockHTML(mode, view) };
      },
      tick: enhanceQuotaChip, live: ariaLiveState, diag: FATAL,
      setLang(next) { lang = next; },
      disable() { state.quotaEnabled = false; enhanceQuotaChip(); },
      dispose() { disposed = true; restoreQuotaChip(); },
    };
  }`;

test('quota dock normalizes remaining percentages, keeps used bands, and handles missing windows', () => {
  const quota = runInNewContext(dockSource + '\npane(0)');
  for (const [used, remaining, band] of [
    [-3, 100, 'calm'], [0, 100, 'calm'], [0.5, 100, 'calm'], [49.99, 50, 'norm'],
    [50, 50, 'mid'], [69.99, 30, 'mid'], [70, 30, 'high'], [90, 10, 'crit'],
    [99.51, 0, 'crit'], [100, 0, 'exc'], [130, 0, 'exc'],
  ]) {
    quota.push({ status: 'ok', windows: { fiveHour: { percent: used } } });
    const view = quota.view();
    assert.equal(view.aria, 'Remaining 5h quota ' + remaining + '%');
    assert.match(view.html, new RegExp('zu-qcol zu-qb-' + band + '"'));
    assert.equal(view.html.includes('visibility="hidden"'), remaining === 0);
    if (remaining === 100) assert.match(view.html, /stroke-dashoffset="0"/);
    assert.equal(view.time, '');
  }
  for (const percent of [NaN, Infinity, -Infinity, '50']) {
    quota.push({ status: 'ok', windows: { fiveHour: { percent } } });
    assert.equal(quota.view(), null);
  }
  quota.push({ status: 'ok', windows: {} });
  assert.equal(quota.view(), null);
  quota.push({ status: 'ok', windows: {}, quotaSummary: { remaining: 5 } });
  assert.match(quota.view().html, /zu-qdock-txt.*Quota \$5/);
  quota.push({ status: 'ok', windows: Object.fromEntries(
    ['daily', 'fiveHour', 'weekly', 'monthly', 'plan', 'unknown'].map(key => [key, { percent: 42, resetsAt: 1e12 }])
  ) });
  assert.equal(quota.view().cols.length, 5);
  assert.equal(quota.view().time, '');
});

test('quota dock signature tracks visible time, language and fractional arcs', () => {
  const quota = runInNewContext(dockSource + '\npane(0)');
  const view = (percent, resetsAt, expires) => {
    quota.push({ status: 'ok', windows: { weekly: { percent, resetsAt, expires } } });
    return quota.view();
  };
  const reset = view(42.1, 1e12, false);
  assert.match(reset.time, /^resets /);
  assert.notEqual(reset.sig, view(42.1, 1e12 + 3600000, false).sig);
  const expiry = view(42.1, 1e12, true);
  assert.match(expiry.time, /^expires /);
  assert.notEqual(reset.sig, expiry.sig);
  const fractional = view(42.2, 1e12, false);
  assert.equal(reset.aria, fractional.aria);
  assert.notEqual(reset.sig, fractional.sig);
  assert.equal(view(42.1, 'invalid', false).time, '');
  assert.equal(view(42.1, undefined, false).time, '');
  quota.setLang('zh');
  assert.notEqual(reset.sig, view(42.1, 1e12, false).sig);
  assert.match(quota.view().aria, /剩余 周额度 58%/);
});

async function checkBrowserDock() {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const waitForObserver = () => new Promise(resolve => setTimeout(resolve, 0));
  let disconnected = 0;
  window.MutationObserver = class extends MutationObserver {
    disconnect() { disconnected++; super.disconnect(); }
  };
  const makeSidebar = () => {
    const sidebar = document.createElement('aside');
    sidebar.innerHTML = '<div data-testid="sidebar-task-list-region"></div><footer>' +
      '<div><button data-testid="task-settings-button">gear</button></div></footer>';
    return sidebar;
  };
  let sidebar = makeSidebar();
  document.body.append(sidebar);
  const a = pane(0), b = pane(1);
  const data = percent => ({ status: 'ok', windows: { fiveHour: { percent } } });
  a.push(data(70), 'one', true);
  b.push(data(20), 'two');
  a.tick();
  const dock = sidebar.querySelector('footer').firstElementChild;
  const link = dock.querySelector('.zu-qr-arc');
  check(link && getComputedStyle(link).stroke.includes('url('), 'arc uses the SVG gradient');
  const stop = dock.querySelector('#zu-qg-zu-qb-high stop');
  check(getComputedStyle(stop).stopColor === 'rgb(255, 180, 91)', 'light gradient uses the light theme');
  check(getComputedStyle(dock.querySelector('.zu-qr-defs')).display === 'none', 'defs have no flex box');
  dock.focus();
  const audit = new MutationObserver(() => {});
  audit.observe(sidebar.querySelector('footer'), { childList: true, subtree: true });
  a.tick();
  b.tick();
  check(audit.takeRecords().length === 0 && document.activeElement === dock, 'stable tick preserves focus and DOM');
  dock.click();
  check(JSON.stringify(requests) === '[["quota-refresh","one"]]', 'refresh belongs to the displayed pane');
  audit.disconnect();

  dock.remove();
  await waitForObserver();
  check(sidebar.querySelector('footer').firstElementChild === dock, 'detached dock returns immediately');
  const newSidebar = makeSidebar();
  sidebar.replaceWith(newSidebar);
  sidebar = newSidebar;
  await waitForObserver();
  check(sidebar.querySelector('footer').firstElementChild === dock, 'same dock follows replacement footer');
  const wrongFooter = document.body.appendChild(document.createElement('footer'));
  wrongFooter.prepend(dock);
  await waitForObserver();
  check(sidebar.querySelector('footer').firstElementChild === dock, 'first in another footer is not in place');
  const gear = sidebar.querySelector('button'), gearRow = gear.parentElement;
  gear.remove();
  a.tick();
  check(dock.style.display === 'none', 'missing anchor hides the same dock');
  gearRow.append(gear);
  a.tick();
  check(sidebar.querySelector('footer').firstElementChild === dock && !dock.style.display, 'return restores the cached dock');

  const previous = dock.innerHTML;
  const label = dock.getAttribute('aria-label');
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
  Object.defineProperty(dock, 'innerHTML', {
    configurable: true, get: descriptor.get, set() { throw new Error('fixture render failure'); },
  });
  a.push(data(55), 'next');
  a.tick();
  check(dock.innerHTML === previous && dock.getAttribute('aria-label') === label && a.live.textContent === label &&
    a.diag.qdockRenderErr.error.includes('fixture render failure'), 'failed render keeps the prior content and ARIA');
  dock.click();
  check(requests.length === 1, 'a failed source switch cannot refresh the wrong source');
  delete dock.innerHTML;
  a.tick();
  check(dock.innerHTML !== previous && dock.getAttribute('aria-label').includes('45%'), 'next tick retries');
  dock.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
  check(requests.at(-1)?.[1] === 'next' && requests.length === 2, 'keyboard refresh uses the newly rendered source');

  a.dispose();
  await waitForObserver();
  check(!dock.isConnected && !document.__zuQuotaDock && disconnected === 2, 'dispose releases the dock and observer');
  dock.click();
  check(requests.length === 2, 'disposed dock has no click listeners');
  b.tick();
  const next = sidebar.querySelector('footer').firstElementChild;
  check(next !== dock && next.querySelector('.zu-qr-val').textContent === '80%', 'remaining pane takes ownership');
  next.click();
  check(requests.at(-1)?.[1] === 'two', 'new owner refreshes its own source');
  b.push({ status: 'ok', balance: { amount: 15 } }, 'two', true);
  b.tick();
  check(getComputedStyle(next.querySelector('.zu-qdock-txt .zu-qseg')).color === 'rgb(15, 157, 108)', 'balance text uses the light theme');
  b.disable();
  await waitForObserver();
  check(!next.isConnected && !document.querySelector('.zu-qdock') && disconnected === 3, 'disable releases the dock and observer');
}

const chrome = process.env.ZUSAGE_TEST_CHROME;
test('quota dock browser mount, observer, focus, palette, retry and ownership', { skip: !chrome }, () => {
  const css = sliceOverlay('      ".zu-qdock{', '      ".zu-qseg.zu-qb-calm')
    .split('\n').map(line => line.trim()).filter(line => line.startsWith('"'))
    .map(line => JSON.parse(line.match(/^"(?:[^"\\]|\\.)*"/)[0])).join('');
  const script = 'const requests = [];\n' + dockSource + '\n(' + checkBrowserDock + ')().then(' +
    '() => document.body.append(Object.assign(document.createElement("pre"), {id:"result",textContent:"ok"})),' +
    'e => document.body.append(Object.assign(document.createElement("pre"), {id:"result",textContent:e.message})));';
  const html = '<!doctype html><meta charset="utf-8"><style>' + css + '</style><body><script>' + script + '</script>';
  const profile = mkdtempSync(join(tmpdir(), 'zusage-dock-'));
  try {
    const output = execFileSync(chrome, ['--headless', '--disable-gpu', '--no-first-run',
      '--disable-background-networking', '--disable-component-update', '--user-data-dir=' + profile,
      '--virtual-time-budget=1000', '--dump-dom', 'data:text/html;base64,' + Buffer.from(html).toString('base64')],
    { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] });
    assert.equal(output.match(/<pre id="result">([^<]*)/)?.[1], 'ok');
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});
