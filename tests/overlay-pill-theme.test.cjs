const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

/* Full renderer script in a real, isolated browser document. There is no Electron,
 * database, host profile, network service, or source-code instrumentation here.
 * On machines without Chromium or Node's WebSocket this suite explicitly skips. */
const chromeCandidates = [
  process.env.ZUSAGE_TEST_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
  process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe'),
].filter(Boolean);
const chrome = chromeCandidates.find(file => {
  try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; }
});
const skipReason = !chrome ? 'Chromium/Chrome not available' : typeof WebSocket !== 'function' ? 'Node WebSocket not available' : false;
const overlay = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function getJson(port, url) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: url }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(text)); } catch (err) { reject(err); }
      });
    }).on('error', reject);
  });
}

async function startBrowser(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zusage-pill-test-'));
  const profile = path.join(temp, 'profile');
  const fixture = path.join(temp, 'fixture.html');
  fs.writeFileSync(fixture, '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
  const args = [
    '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-extensions',
    '--disable-sync', '--disable-features=OptimizationHints,MediaRouter', '--no-proxy-server',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    '--user-data-dir=' + profile, pathToFileURL(fixture).href,
  ];
  const proc = spawn(chrome, args, { stdio: 'ignore' });
  let spawnError;
  proc.on('error', err => { spawnError = err; });
  let socket;
  t.after(async () => {
    if (socket && socket.readyState < 2) socket.close();
    if (proc.exitCode === null && !proc.signalCode) {
      const exited = new Promise(resolve => proc.once('exit', resolve));
      proc.kill();
      await Promise.race([exited, delay(2000)]);
      if (proc.exitCode === null && !proc.signalCode) {
        proc.kill('SIGKILL');
        await Promise.race([exited, delay(2000)]);
      }
    }
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const portFile = path.join(profile, 'DevToolsActivePort');
  let port;
  for (let i = 0; i < 100; i++) {
    if (spawnError) throw spawnError;
    if (proc.exitCode !== null) throw new Error('Chrome exited before opening its debugging port');
    try { port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]); } catch {}
    if (port) break;
    await delay(50);
  }
  assert.ok(port, 'isolated Chrome did not start');
  let target;
  for (let i = 0; i < 100; i++) {
    try { target = (await getJson(port, '/json/list')).find(x => x.type === 'page'); } catch {}
    if (target) break;
    await delay(50);
  }
  assert.ok(target && target.webSocketDebuggerUrl, 'fixture page not found');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const msg = JSON.parse(String(event.data));
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  });
  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const next = ++id;
      pending.set(next, { resolve, reject });
      socket.send(JSON.stringify({ id: next, method, params }));
    });
  }
  async function evaluate(expression) {
    const out = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || out.exceptionDetails.text);
    return out.result.value;
  }
  async function waitFor(expression, message) {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(expression)) return;
      await delay(50);
    }
    assert.fail(message || 'timed out waiting for ' + expression);
  }
  await call('Page.enable');
  await call('Runtime.enable');
  await call('Network.enable');
  await call('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] });
  await waitFor('document.readyState === "complete" && location.protocol === "file:"', 'initial fixture page did not load');
  return { call, evaluate, waitFor, url: pathToFileURL(fixture).href };
}

const fixtureHtml = `
<style>
  /* 配色取自安装版 app.asar 的 zai-light/zai-dark 构建令牌与 highspeed-activation.css：
     浅卡 #ffffff + rgba(13,13,13,.1) 边、深卡 #2b2b2b + rgba(255,255,255,.1)、圆角 16px（rounded-2xl）、
     Highspeed 稳定态紫边 #6041ff、深色 surface #151515；聚焦只变边框透明度（0.1→0.15），与宿主一致。
     各状态保持可区分，供断言药丸样式跟随。 */
  html, body { margin: 0; height: 100%; background: #f8f8f8 }
  .pane { position: absolute; top: 500px; width: 440px }
  #pane-a { left: 50px } #pane-b { left: 700px }
  .card, .highspeed-composer-surface { box-sizing: border-box; border: 1px solid rgba(13, 13, 13, 0.1); border-radius: 16px; background: #ffffff; }
  .card { display: flex; flex-direction: column; padding: 8px }
  .card:focus-within { border-color: rgba(13, 13, 13, 0.15) }
  html.dark .card { background: #2b2b2b; border-color: rgba(255, 255, 255, 0.1) }
  html.dark .card:focus-within { border-color: rgba(255, 255, 255, 0.15) }
  .highspeed-composer-surface { position: relative; background: #ffffff; border-color: transparent }
  /* Unequal insets make the outer surface's center and bottom differ from the inner card. */
  #switch-surface.highspeed-composer-surface { padding: 7px 50px 14px 10px }
  .highspeed-composer-surface .card { background: transparent; border-color: transparent }
  html.dark .highspeed-composer-surface { background: #151515 }
  html.dark .highspeed-composer-surface:focus-within { border-color: rgba(255, 255, 255, 0.15) }
  .highspeed-composer-surface:has([data-phase="stable"]) { border-color: #6041ff !important }
  .highspeed-composer-surface:focus-within { border-color: rgba(13, 13, 13, 0.15) }
  .highspeed-composer-surface:focus-within:has([data-phase="stable"]) { border-color: #6041ff !important }
  .phase-marker { position: absolute; width: 0; height: 0 }
  textarea { box-sizing: border-box; width: 100%; height: 58px; resize: none }
  .group\\/toolbar { display: flex; height: 30px; align-items: center; justify-content: end }
</style>
<div id="pane-a" class="pane" data-pane-id="a" data-session-id="sid_a">
  <div id="card-a" class="card"><textarea aria-label="Composer A"></textarea><div class="group/toolbar"><span><button data-testid="chat-context-usage-trigger" aria-label="上下文总量 200,000"><svg><circle></circle><circle></circle></svg></button></span></div></div>
</div>
<div id="pane-b" class="pane" data-pane-id="b" data-session-id="sid_b">
  <div id="highspeed" class="highspeed-composer-surface" data-highspeed-composer="true"><i class="phase-marker" data-phase="starting"></i><div id="card-b" class="card"><textarea aria-label="Composer B"></textarea><div class="group/toolbar"><span><button data-testid="chat-context-usage-trigger" aria-label="上下文总量 200,000"><svg><circle></circle><circle></circle></svg></button></span></div></div></div>
</div>`;

const payload = {
  remote_evidence: false, not_local: [], today: { total: 582500, input: 500000, output: 82500, requests: 9 },
  recent: ['a', 'b'].map(id => ({
    sid: 'sid_' + id, workspace_identity: '', total: 582500, input: 500000, output: 82500,
    cache_read: 250000, requests: 9, turns: 3, ctx: 63400, context_window: 200000, last_at: 1,
    last_turn: { total: 125000, input: 100000, output: 25000, cache_read: 50000, requests: 3, duration_ms: 9000 },
    last: { tps: 92, duration_ms: 3500, ttft_ms: 700, provider_id: 'account:bigmodel-individual-coding-plan', model: 'GLM-test' },
    tools: { total: 3, errors: 0, list: [] },
  })),
  quota: { status: 'ok', providerId: 'account:bigmodel-individual-coding-plan', stale: false, error: '',
    windows: { fiveHour: { percent: 26, resetsAt: null, details: [] }, weekly: { percent: 12, resetsAt: null, details: [] } }, tools: { used: 48, total: 4000 } },
};

async function reset(browser, { stored, brokenRead = false, brokenWrite = false, width = 1200, narrow = false, freeze600 = false } = {}) {
  await browser.call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
  const token = Math.random().toString(36).slice(2);
  await browser.call('Page.navigate', { url: browser.url + '?case=' + token });
  await browser.waitFor(`document.readyState === "complete" && location.search === '?case=${token}'`, 'fixture page did not load');
  await browser.evaluate(`(() => {
    document.body.innerHTML = ${JSON.stringify(fixtureHtml)};
    localStorage.clear();
    ${stored === undefined ? '' : `localStorage.setItem('zusage3.theme', ${JSON.stringify(stored)});`}
    window.__testWrites = [];
    const originalSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function(k, v) {
      window.__testWrites.push([k, String(v)]);
      if (${brokenWrite} && k === 'zusage3.theme') throw new Error('storage denied');
      return originalSet.call(this, k, v);
    };
    ${brokenRead ? `const originalGet = Storage.prototype.getItem; Storage.prototype.getItem = function(k) { if (k === 'zusage3.theme') throw new Error('storage denied'); return originalGet.call(this, k); };` : ''}
    ${freeze600 ? `const nativeInterval = window.setInterval; window.__blocked600 = 0; window.__ran600 = 0;
      window.setInterval = function(fn, ms, ...args) { return nativeInterval.call(this, function() {
        if (ms === 600 && window.__freeze600) { window.__blocked600++; return; }
        if (ms === 600) window.__ran600++;
        return fn(...args);
      }, ms); };` : ''}
    ${narrow ? `document.querySelector('#pane-b').remove(); Object.assign(document.querySelector('#pane-a').style, { left: '-50px', width: '600px' });` : ''}
  })()`);
  await browser.evaluate(overlay);
  const count = narrow ? 1 : 2;
  await browser.waitFor(`document.querySelectorAll('.zusage-root').length === ${count} && [...document.querySelectorAll('.zusage-root')].every(b => getComputedStyle(b).display !== 'none')`, 'bars did not mount');
  await browser.evaluate(`window.__zusageUpdate(${JSON.stringify(payload)})`);
  await browser.waitFor(`document.querySelectorAll('.zu-quota').length === ${count}`, 'test quota chips did not mount');
  // A payload changes the bar width; positioning follows on the next animation frame.
  await browser.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
}

async function choose(browser, value, panelIndex = 0) {
  await browser.evaluate(`(() => {
    const panels = document.querySelectorAll('.zu-settings');
    const input = panels[${panelIndex}].querySelector('.zu-theme-choice[value="${value}"]');
    if (!input) throw new Error('theme choice ${value} missing');
    input.click();
  })()`);
}

async function themes(browser) {
  return browser.evaluate(`[...document.querySelectorAll('.zusage-root')].map(b => b.getAttribute('data-zusage-theme'))`);
}

async function compareSurface(browser, barIndex, selector) {
  return browser.evaluate(`(() => {
    const bar = document.querySelectorAll('.zusage-root')[${barIndex}];
    const surface = document.querySelector(${JSON.stringify(selector)});
    const keys = ['backgroundColor', 'borderTopWidth', 'borderTopStyle', 'borderTopColor', 'borderRadius'];
    const read = el => { const s = getComputedStyle(el); return Object.fromEntries(keys.map(k => [k, s[k]])); };
    return { bar: read(bar), surface: read(surface) };
  })()`);
}

test('dual theme browser behaviour (isolated fixture)', { skip: skipReason, timeout: 90000 }, async t => {
  const b = await startBrowser(t);

  await t.test('default and invalid values fall back; pill restores on boot', async () => {
    for (const [stored, expected] of [[undefined, 'default'], ['', 'default'], ['invalid', 'default'], ['PILL', 'default'], ['default', 'default'], ['pill', 'pill']]) {
      await reset(b, { stored });
      assert.deepEqual(await themes(b), [expected, expected], `stored theme ${String(stored)}`);
      const checks = await b.evaluate(`[...document.querySelectorAll('.zu-settings')].map(p => [...p.querySelectorAll('.zu-theme-choice')].filter(x => x.checked).map(x => x.value))`);
      assert.deepEqual(checks, [[expected], [expected]]);
    }
  });

  await t.test('theme writes are independent, synchronized across panes, and reversible', async () => {
    await reset(b);
    await b.evaluate(`document.querySelector('.zu-cn-num').click()`);
    const ordinaryWrites = await b.evaluate('window.__testWrites');
    assert.ok(ordinaryWrites.length > 0, 'ordinary settings must persist');
    assert.ok(!ordinaryWrites.some(([k]) => k === 'zusage3.theme'), 'ordinary persist must not write theme');
    await b.evaluate('window.__testWrites.length = 0');
    await choose(b, 'pill');
    assert.deepEqual(await themes(b), ['pill', 'pill']);
    assert.deepEqual(await b.evaluate('window.__testWrites'), [['zusage3.theme', 'pill']]);
    assert.deepEqual(await b.evaluate(`[...document.querySelectorAll('.zu-settings')].map(p => p.querySelector('.zu-theme-choice[value="pill"]').checked)`), [true, true]);
    await b.evaluate(`document.querySelector('.zu-cn-num').click()`);
    assert.equal(await b.evaluate(`localStorage.getItem('zusage3.theme')`), 'pill', 'ordinary persistence must not reset an existing theme');
    await reset(b, { stored: 'pill' });
    assert.deepEqual(await themes(b), ['pill', 'pill'], 'stored preference restores in a new document');
    await b.evaluate('window.__testWrites.length = 0');
    await choose(b, 'default', 1);
    assert.deepEqual(await themes(b), ['default', 'default']);
    assert.deepEqual(await b.evaluate('window.__testWrites'), [['zusage3.theme', 'default']]);
  });

  await t.test('storage exceptions do not prevent rendering or switching', async () => {
    await reset(b, { stored: 'pill', brokenRead: true });
    assert.deepEqual(await themes(b), ['default', 'default']);
    await choose(b, 'pill');
    assert.deepEqual(await themes(b), ['pill', 'pill']);
    await reset(b, { brokenWrite: true });
    await choose(b, 'pill');
    assert.deepEqual(await themes(b), ['pill', 'pill']);
    await choose(b, 'default', 1);
    assert.deepEqual(await themes(b), ['default', 'default']);
  });

  await t.test('pill follows each card, fits the viewport, and leaves settings clickable', async () => {
    await reset(b, { stored: 'pill' });
    // Give content enough room to grow instead of immediately saturating card max-width.
    await b.evaluate(`Object.assign(document.querySelector('#pane-a').style, { left: '20px', width: '570px' });
      Object.assign(document.querySelector('#pane-b').style, { left: '610px', width: '570px' });`);
    await b.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const geometry = await b.evaluate(`(() => {
      const bars = [...document.querySelectorAll('.zusage-root')];
      const cards = [document.querySelector('#card-a'), document.querySelector('#card-b')];
      return bars.map((bar, i) => {
        const r = bar.getBoundingClientRect(), c = cards[i].getBoundingClientRect();
        return { left: r.left, right: r.right, width: r.width, top: r.top, cardBottom: c.bottom,
          center: (r.left + r.right) / 2, cardCenter: (c.left + c.right) / 2, position: getComputedStyle(bar).position };
      });
    })()`);
    for (const g of geometry) {
      assert.equal(g.position, 'fixed');
      assert.ok(g.top >= g.cardBottom - 1, JSON.stringify(g));
      assert.ok(Math.abs(g.center - g.cardCenter) <= 2, JSON.stringify(g));
      assert.ok(g.left >= 0 && g.right <= 1200 && g.width > 0, JSON.stringify(g));
    }
    const largerPayload = JSON.parse(JSON.stringify(payload));
    for (const entry of largerPayload.recent) {
      entry.last.tps = 1000;
      entry.last_turn.total = 999999999999;
      entry.total = 999999999999;
    }
    largerPayload.today.total = 999999999999;
    await b.evaluate(`window.__zusageUpdate(${JSON.stringify(largerPayload)})`);
    await b.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const resized = await b.evaluate(`(() => {
      const cards = [document.querySelector('#card-a'), document.querySelector('#card-b')];
      return [...document.querySelectorAll('.zusage-root')].map((bar, i) => {
        const r = bar.getBoundingClientRect(), c = cards[i].getBoundingClientRect();
        return { width: r.width, center: (r.left + r.right) / 2, cardCenter: (c.left + c.right) / 2 };
      });
    })()`);
    assert.ok(resized.some((g, i) => Math.abs(g.width - geometry[i].width) > 1), 'payload must actually change bar width');
    for (const g of resized) assert.ok(Math.abs(g.center - g.cardCenter) <= 2, JSON.stringify(g));
    await reset(b, { stored: 'pill', width: 500, narrow: true });
    const target = await b.evaluate(`(() => {
      const bar = document.querySelector('.zusage-root'), r = bar.getBoundingClientRect();
      const gear = bar.querySelector('.zu-gear'), g = gear.getBoundingClientRect();
      const x = (g.left + g.right) / 2, y = (g.top + g.bottom) / 2;
      const hit = document.elementFromPoint(x, y);
      return { left: r.left, right: r.right, width: r.width, x, y, gearHit: !!hit && (hit === gear || gear.contains(hit)) };
    })()`);
    assert.ok(target.left >= 0 && target.right <= 500 && target.width > 0, JSON.stringify(target));
    assert.equal(target.gearHit, true, 'gear must remain hit-testable');
    await b.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y });
    await b.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 });
    await b.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 });
    assert.equal(await b.evaluate(`document.querySelector('.zu-settings').classList.contains('open')`), true);
    await b.evaluate(`document.querySelector('.zu-settings .zu-settings-close').click()`);
    const scrolled = await b.evaluate(`(() => {
      const bar = document.querySelector('.zusage-root'), main = bar.querySelector('.zu-main');
      const items = [...main.querySelectorAll('.it')], sub = main.querySelector('.zu-sub');
      const overflow = main.scrollWidth > main.clientWidth;
      main.scrollLeft = main.scrollWidth;
      const r = sub.getBoundingClientRect(), x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2;
      const hit = document.elementFromPoint(x, y);
      const gear = bar.querySelector('.zu-gear'), g = gear.getBoundingClientRect();
      const gearHit = document.elementFromPoint((g.left + g.right) / 2, (g.top + g.bottom) / 2);
      return { count: items.length, overflow, scrollLeft: main.scrollLeft,
        sub: { x, y, hit: !!hit && (hit === sub || sub.contains(hit)) },
        gearHit: !!gearHit && (gearHit === gear || gear.contains(gearHit)) };
    })()`);
    assert.ok(scrolled.count >= 6, 'compact data items must remain present');
    assert.ok(scrolled.overflow && scrolled.scrollLeft > 0, 'clipped items must be horizontally scrollable');
    assert.equal(scrolled.sub.hit, true, JSON.stringify(scrolled));
    assert.equal(scrolled.gearHit, true, 'gear must remain hit-testable after scrolling');
    const sub = { x: scrolled.sub.x, y: scrolled.sub.y };
    await b.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...sub });
    await b.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...sub, button: 'left', clickCount: 1 });
    await b.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...sub, button: 'left', clickCount: 1 });
    assert.equal(await b.evaluate(`document.querySelector('.subp').classList.contains('open')`), true, 'sub-agent control must remain clickable');
    // Real Tab navigation should scroll the off-screen button back into view.
    await b.evaluate(`(() => {
      const bar = document.querySelector('.zusage-root'), main = bar.querySelector('.zu-main');
      document.querySelector('.subp').classList.remove('open');
      main.scrollLeft = 0;
      const items = main.querySelectorAll('.it');
      items[items.length - 2].focus();
    })()`);
    await b.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    await b.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    await b.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const keyboard = await b.evaluate(`(() => {
      const bar = document.querySelector('.zusage-root'), main = bar.querySelector('.zu-main'), sub = main.querySelector('.zu-sub');
      const r = sub.getBoundingClientRect(), mr = main.getBoundingClientRect();
      const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
      return { focused: document.activeElement === sub, scrollLeft: main.scrollLeft,
        within: r.left >= mr.left - 1 && r.right <= mr.right + 1,
        hit: !!hit && (hit === sub || sub.contains(hit)) };
    })()`);
    assert.equal(keyboard.focused, true, 'Tab should reach the sub-agent button');
    assert.ok(keyboard.scrollLeft > 0, 'keyboard focus should scroll to the off-screen entry');
    assert.equal(keyboard.within, true, 'focused control must be fully visible');
    assert.equal(keyboard.hit, true, 'focused control must not be covered by the gear');
  });

  await t.test('bottom-docked cards reserve the full pill height and top gap', async () => {
    await reset(b, { stored: 'pill' });
    // Unlike an absolutely-positioned pane, a bottom flex dock moves up as the
    // card's margin grows, reproducing the host's available-space constraint.
    await b.evaluate(`(() => {
      document.querySelector('#pane-b').remove();
      const pane = document.querySelector('#pane-a');
      Object.assign(pane.style, { position: 'fixed', top: 'auto', bottom: '0px', height: '230px', display: 'flex', flexDirection: 'column', justifyContent: 'end' });
    })()`);
    await delay(700);
    await b.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const measure = async () => b.evaluate(`(() => {
      const card = document.querySelector('#card-a'), bar = document.querySelector('.zusage-root');
      const c = card.getBoundingClientRect(), r = bar.getBoundingClientRect();
      return { cardBottom: c.bottom, barTop: r.top, barBottom: r.bottom, barHeight: r.height,
        margin: parseFloat(getComputedStyle(card).marginBottom), viewportBottom: innerHeight };
    })()`);
    const normal = await measure();
    assert.ok(normal.barHeight > 0, JSON.stringify(normal));
    assert.ok(normal.barTop >= normal.cardBottom + 3, JSON.stringify(normal));
    assert.ok(normal.barBottom <= normal.viewportBottom, JSON.stringify(normal));
    assert.ok(normal.margin >= normal.barHeight + 4 - 1, JSON.stringify(normal));
    // Larger UI fonts make a fixed 24px spacer visibly insufficient.
    await b.evaluate(`document.documentElement.style.setProperty('--ui-font-size', '24px')`);
    await b.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await delay(100);
    const larger = await measure();
    assert.ok(larger.barHeight > normal.barHeight, JSON.stringify({ normal, larger }));
    assert.ok(larger.barTop >= larger.cardBottom + 3, JSON.stringify(larger));
    assert.ok(larger.barBottom <= larger.viewportBottom, JSON.stringify(larger));
    assert.ok(larger.margin >= larger.barHeight + 4 - 1, JSON.stringify(larger));
    await choose(b, 'default');
    await b.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    assert.equal(await b.evaluate(`document.querySelector('#card-a').style.marginBottom`), '', 'returning to in-card default restores the original margin');
    await choose(b, 'pill');
    await b.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const restored = await measure();
    assert.ok(restored.barTop >= restored.cardBottom + 3 && restored.barBottom <= restored.viewportBottom, JSON.stringify(restored));
    await b.evaluate('window.__zusageDispose()');
    assert.equal(await b.evaluate(`document.querySelector('#card-a').style.marginBottom`), '', 'disposing pill restores the original margin');
  });

  await t.test('switching back to default resets the compact bar scroll position', async () => {
    await reset(b, { stored: 'pill', width: 500, narrow: true });
    const before = await b.evaluate(`(() => {
      const main = document.querySelector('.zusage-root .zu-main');
      main.scrollLeft = main.scrollWidth;
      return { left: main.scrollLeft, overflow: main.scrollWidth > main.clientWidth };
    })()`);
    assert.ok(before.overflow && before.left > 0, 'fixture must start with a scrolled compact bar');
    await choose(b, 'default');
    const after = await b.evaluate(`(() => {
      const bar = document.querySelector('.zusage-root'), main = bar.querySelector('.zu-main');
      const first = main.querySelector('.it'), r = first.getBoundingClientRect(), mr = main.getBoundingClientRect();
      return { theme: bar.getAttribute('data-zusage-theme'), left: main.scrollLeft, firstLeft: r.left, mainLeft: mr.left };
    })()`);
    assert.equal(after.theme, 'default');
    assert.equal(after.left, 0, 'default mode must reset pill scrollLeft synchronously');
    assert.ok(after.firstLeft >= after.mainLeft - 1, JSON.stringify(after));
    await b.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    assert.equal(await b.evaluate(`document.querySelector('.zusage-root .zu-main').scrollLeft`), 0, 'later frames must not restore the old offset');
  });

  await t.test('the left pane settings panel stays within its card and does not cover the right pane', async () => {
    await reset(b, { stored: 'pill' });
    const initial = await b.evaluate(`(() => {
      const gear = document.querySelector('.zusage-root .zu-gear'), r = gear.getBoundingClientRect();
      return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
    })()`);
    await b.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...initial });
    await b.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...initial, button: 'left', clickCount: 1 });
    await b.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...initial, button: 'left', clickCount: 1 });
    await b.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const geometry = await b.evaluate(`(() => {
      const panel = document.querySelectorAll('.zu-settings')[0], card = document.querySelector('#card-a');
      const rightPane = document.querySelector('#pane-b'), p = panel.getBoundingClientRect();
      const c = card.getBoundingClientRect(), other = rightPane.getBoundingClientRect();
      return { open: panel.classList.contains('open'), panelLeft: p.left, panelRight: p.right,
        cardLeft: c.left, cardRight: c.right, rightPaneLeft: other.left, panelWidth: p.width };
    })()`);
    assert.equal(geometry.open, true, 'first pane settings should open');
    assert.ok(geometry.panelWidth > 0, JSON.stringify(geometry));
    assert.ok(geometry.panelLeft >= geometry.cardLeft - 1, JSON.stringify(geometry));
    assert.ok(geometry.panelRight <= geometry.cardRight + 1, JSON.stringify(geometry));
    assert.ok(geometry.panelRight <= geometry.rightPaneLeft, JSON.stringify(geometry));
  });

  await t.test('moving a surface out of an animating ancestor stops the sampling timer', async () => {
    await reset(b, { stored: 'pill' });
    const result = await b.evaluate(`(async () => {
      const card = document.querySelector('#card-a'), parent = card.parentElement;
      const inner = document.createElement('div'), outer = document.createElement('div');
      parent.insertBefore(outer, card);
      outer.appendChild(inner);
      inner.appendChild(card);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const originalSetInterval = window.setInterval, originalClearInterval = window.clearInterval;
      const active = new Set();
      window.setInterval = function(fn, ms) {
        const id = originalSetInterval(fn, ms);
        if (ms === 80) active.add(id);
        return id;
      };
      window.clearInterval = function(id) { active.delete(id); return originalClearInterval(id); };
      outer.dispatchEvent(new TransitionEvent('transitionrun', { bubbles: true, propertyName: 'border-color' }));
      const started = active.size;
      parent.appendChild(inner);
      await new Promise(resolve => setTimeout(resolve, 250));
      const remaining = active.size;
      window.setInterval = originalSetInterval;
      window.clearInterval = originalClearInterval;
      return { started, remaining, inputConnected: card.querySelector('textarea').isConnected };
    })()`);
    assert.equal(result.started, 1, 'fixture must start the 80ms sampler');
    assert.equal(result.remaining, 0, 'moving the composer out of the animated ancestor must stop it');
    assert.equal(result.inputConnected, true);
  });

  await t.test('pill inherits its own surface in light, dark, focus and highspeed phase changes', async () => {
    await reset(b, { stored: 'pill' });
    const check = async (i, selector) => {
      const pair = await compareSurface(b, i, selector);
      assert.deepEqual(pair.bar, pair.surface, selector);
      return pair;
    };
    const light = await check(0, '#card-a');
    const highNormal = await check(1, '#highspeed');
    assert.notDeepEqual(light.surface, highNormal.surface, 'each pane must actually have a different surface');
    await b.evaluate(`document.documentElement.classList.add('dark')`);
    await delay(100);
    const dark = await check(0, '#card-a');
    assert.notDeepEqual(dark.surface, light.surface, 'host theme must actually change the fixture');
    await check(1, '#highspeed');
    await b.evaluate(`document.querySelector('#card-a textarea').focus()`);
    await delay(100);
    const focused = await check(0, '#card-a');
    assert.notDeepEqual(focused.surface, dark.surface, 'ordinary focus must actually change the fixture');
    await b.evaluate(`document.querySelector('#card-b textarea').focus()`);
    await delay(100);
    const highFocus = await check(1, '#highspeed');
    /* 宿主真实行为：Highspeed 聚焦不改变边框（transparent/idle），失焦后稳定态紫色保持——
     * 聚焦/失焦只断言药丸持续与表面一致；表面真实变化由阶段切换与末尾主题翻转覆盖。 */
    await b.evaluate(`document.querySelector('#highspeed [data-phase]').dataset.phase = 'stable'`);
    await delay(100);
    const highStable = await check(1, '#highspeed');
    assert.notDeepEqual(highStable.surface, highNormal.surface, 'highspeed phase must actually change the fixture');
    await b.evaluate('document.activeElement.blur()');
    await delay(100);
    const highBlur = await check(1, '#highspeed');
    assert.deepEqual(highBlur.surface, highStable.surface, 'stable purple persists across blur in the real host');
    await b.evaluate(`document.documentElement.classList.remove('dark')`);
    await delay(100);
    await check(0, '#card-a');
    const highLight = await check(1, '#highspeed');
    assert.notDeepEqual(highLight.surface, highBlur.surface, 'final theme flip must actually change the fixture');
  });

  await t.test('focus changing an inner wrapper background does not change the owning card', async () => {
    await reset(b, { stored: 'pill' });
    await b.evaluate(`(() => {
      const card = document.querySelector('#card-a'), input = card.querySelector('textarea');
      const wrapper = document.createElement('div');
      wrapper.id = 'focus-wrapper';
      wrapper.style.cssText = 'margin-left:34px;margin-right:6px';
      card.insertBefore(wrapper, input);
      wrapper.appendChild(input);
      const style = document.createElement('style');
      style.textContent = '#focus-wrapper:focus-within{background:rgb(250,100,50);border:3px solid rgb(200,40,20)}';
      document.head.appendChild(style);
      window.__wrapperInput = input;
    })()`);
    await delay(700);
    const inspect = async () => b.evaluate(`(() => {
      const card = document.querySelector('#card-a'), wrap = document.querySelector('#focus-wrapper');
      const bar = document.querySelectorAll('.zusage-root')[0];
      const r = bar.getBoundingClientRect(), c = card.getBoundingClientRect(), w = wrap.getBoundingClientRect();
      return { same: wrap.querySelector('textarea') === window.__wrapperInput && window.__wrapperInput.isConnected,
        cardBackground: getComputedStyle(card).backgroundColor, wrapBackground: getComputedStyle(wrap).backgroundColor,
        barBackground: getComputedStyle(bar).backgroundColor, cardMargin: card.style.marginBottom, wrapperMargin: wrap.style.marginBottom,
        barCenter: (r.left + r.right) / 2, cardCenter: (c.left + c.right) / 2, wrapCenter: (w.left + w.right) / 2,
        barTop: r.top, cardBottom: c.bottom };
    })()`);
    const before = await inspect();
    assert.equal(before.wrapBackground, 'rgba(0, 0, 0, 0)', 'fixture wrapper starts transparent');
    assert.ok(Math.abs(before.cardCenter - before.wrapCenter) > 5, 'wrapper and card centers must differ');
    await b.evaluate(`window.__wrapperInput.focus()`);
    await delay(700); // Check even after the next heavy reconciliation.
    await b.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const focused = await inspect();
    assert.equal(focused.same, true);
    assert.notEqual(focused.wrapBackground, before.wrapBackground, 'focus must really change the wrapper background');
    assert.notEqual(focused.wrapBackground, focused.cardBackground, 'fixture distinguishes wrapper from owning card');
    assert.equal(focused.barBackground, focused.cardBackground, JSON.stringify(focused));
    assert.ok(Math.abs(focused.barCenter - focused.cardCenter) <= 2, JSON.stringify(focused));
    assert.ok(focused.barTop >= focused.cardBottom - 1, JSON.stringify(focused));
    assert.ok(parseFloat(focused.cardMargin) > 0, JSON.stringify(focused));
    assert.equal(focused.wrapperMargin, '', 'transparent wrapper must never receive the spacer');
  });

  await t.test('an existing composer follows in-place highspeed activation and removal', async () => {
    await reset(b, { stored: 'pill' });
    // Insert the stable wrapper before the observations. The input, card and wrapper
    // then remain connected and identical while only the highspeed attributes change.
    await b.evaluate(`(() => {
      const card = document.querySelector('#card-a'), parent = card.parentElement;
      const outer = document.createElement('div');
      outer.id = 'switch-surface';
      parent.insertBefore(outer, card);
      outer.appendChild(card);
      window.__sameComposer = card.querySelector('textarea');
      window.__sameCard = card;
      window.__sameSurface = outer;
    })()`);
    await delay(750); // One coordinator/heavy reconciliation period.
    await b.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const inspect = async () => b.evaluate(`(() => {
      const bar = document.querySelectorAll('.zusage-root')[0];
      const card = document.querySelector('#card-a'), outer = document.querySelector('#switch-surface');
      const r = bar.getBoundingClientRect(), c = card.getBoundingClientRect(), o = outer.getBoundingClientRect();
      const props = ['backgroundColor', 'borderTopWidth', 'borderTopStyle', 'borderTopColor', 'borderRadius'];
      const style = el => { const s = getComputedStyle(el); return Object.fromEntries(props.map(k => [k, s[k]])); };
      return { same: window.__sameComposer === card.querySelector('textarea') && window.__sameCard === card &&
          window.__sameSurface === outer && window.__sameComposer.isConnected && card.isConnected && outer.isConnected,
        bar: style(bar), card: style(card), outer: style(outer), cardMargin: card.style.marginBottom,
        outerMargin: outer.style.marginBottom, barHeight: r.height, barCenter: (r.left + r.right) / 2, barTop: r.top,
        cardCenter: (c.left + c.right) / 2, cardBottom: c.bottom,
        outerCenter: (o.left + o.right) / 2, outerBottom: o.bottom };
    })()`);
    const ordinary = await inspect();
    assert.equal(ordinary.same, true);
    assert.deepEqual(ordinary.bar, ordinary.card);
    assert.ok(Math.abs(ordinary.barCenter - ordinary.cardCenter) <= 2, JSON.stringify(ordinary));
    assert.ok(ordinary.barTop >= ordinary.cardBottom - 1, JSON.stringify(ordinary));
    assert.ok(parseFloat(ordinary.cardMargin) >= ordinary.barHeight + 4, 'ordinary card must reserve pill height plus gap');
    assert.equal(ordinary.outerMargin, '', 'unmarked wrapper must not own the spacer');

    await b.evaluate(`document.querySelector('#switch-surface').classList.add('highspeed-composer-surface');
      document.querySelector('#switch-surface').setAttribute('data-highspeed-composer', 'true');`);
    await delay(750);
    await b.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const active = await inspect();
    assert.equal(active.same, true, 'activating highspeed must not replace the composer');
    assert.notDeepEqual(active.outer, ordinary.card, 'fixture must provide distinct highspeed colors');
    assert.ok(Math.abs(active.outerCenter - active.cardCenter) > 10, 'fixture must distinguish outer and inner geometry');
    assert.deepEqual(active.bar, active.outer, 'pill must adopt the highspeed surface');
    assert.ok(Math.abs(active.barCenter - active.outerCenter) <= 2, JSON.stringify(active));
    assert.ok(active.barTop >= active.outerBottom - 1, JSON.stringify(active));
    assert.equal(active.cardMargin, '', 'old card spacer must be restored');
    assert.ok(parseFloat(active.outerMargin) >= active.barHeight + 4, 'highspeed surface must reserve pill height plus gap');

    await b.evaluate(`document.querySelector('#switch-surface').classList.remove('highspeed-composer-surface');
      document.querySelector('#switch-surface').removeAttribute('data-highspeed-composer');`);
    await delay(750);
    await b.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const restored = await inspect();
    assert.equal(restored.same, true, 'deactivating highspeed must not replace the composer');
    assert.deepEqual(restored.bar, restored.card, 'pill must return to the ordinary card');
    assert.ok(Math.abs(restored.barCenter - restored.cardCenter) <= 2, JSON.stringify(restored));
    assert.ok(restored.barTop >= restored.cardBottom - 1, JSON.stringify(restored));
    assert.ok(parseFloat(restored.cardMargin) >= restored.barHeight + 4, 'ordinary card regains the full spacer');
    assert.equal(restored.outerMargin, '', 'highspeed surface spacer must be restored');
  });

  await t.test('in-place highspeed marker is discovered without a 600ms reconciliation', async () => {
    await reset(b, { stored: 'pill', freeze600: true });
    // Reuse an ancestor that was already present when the overlay mounted.
    // The input remains connected and in the same place throughout the test.
    await b.evaluate(`(() => {
      const card = document.querySelector('#card-a'), outer = card.parentElement;
      outer.id = 'switch-surface';
      outer.style.left = '50px';
      window.__fastInput = card.querySelector('textarea');
    })()`);
    await delay(100);
    await b.evaluate('window.__freeze600 = true');
    const result = await b.evaluate(`(async () => {
      const card = document.querySelector('#card-a'), outer = document.querySelector('#switch-surface');
      const bar = document.querySelectorAll('.zusage-root')[0], started = performance.now(), ran = window.__ran600;
      outer.classList.add('highspeed-composer-surface');
      outer.setAttribute('data-highspeed-composer', 'true');
      while (performance.now() - started < 500) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        const r = bar.getBoundingClientRect(), o = outer.getBoundingClientRect();
        const matches = getComputedStyle(bar).backgroundColor === getComputedStyle(outer).backgroundColor &&
          Math.abs((r.left + r.right - o.left - o.right) / 2) <= 2 && r.top >= o.bottom - 1 &&
          parseFloat(outer.style.marginBottom) > 0 && card.style.marginBottom === '';
        if (matches) return { matched: true, elapsed: performance.now() - started,
          sameInput: card.querySelector('textarea') === window.__fastInput && window.__fastInput.isConnected,
          heavyRan: window.__ran600 - ran, blocked: window.__blocked600 };
      }
      const r = bar.getBoundingClientRect(), c = card.getBoundingClientRect(), o = outer.getBoundingClientRect();
      return { matched: false, elapsed: performance.now() - started, heavyRan: window.__ran600 - ran, blocked: window.__blocked600,
        barBg: getComputedStyle(bar).backgroundColor, cardBg: getComputedStyle(card).backgroundColor,
        outerBg: getComputedStyle(outer).backgroundColor, bar: [r.left, r.top, r.width, r.height],
        card: [c.left, c.top, c.width, c.height], outer: [o.left, o.top, o.width, o.height],
        cardMargin: card.style.marginBottom, outerMargin: outer.style.marginBottom };
    })()`);
    assert.equal(result.heavyRan, 0, '600ms periodic callbacks must not run during observation');
    assert.equal(result.matched, true, JSON.stringify(result));
    assert.equal(result.sameInput, true, 'existing composer must remain connected');
    assert.ok(result.elapsed < 500, JSON.stringify(result));
    const removed = await b.evaluate(`(async () => {
      const card = document.querySelector('#card-a'), outer = document.querySelector('#switch-surface');
      const bar = document.querySelectorAll('.zusage-root')[0], started = performance.now(), ran = window.__ran600;
      outer.classList.remove('highspeed-composer-surface');
      outer.removeAttribute('data-highspeed-composer');
      while (performance.now() - started < 500) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        const r = bar.getBoundingClientRect(), c = card.getBoundingClientRect();
        const matches = getComputedStyle(bar).backgroundColor === getComputedStyle(card).backgroundColor &&
          Math.abs((r.left + r.right - c.left - c.right) / 2) <= 2 && r.top >= c.bottom - 1 &&
          parseFloat(card.style.marginBottom) >= r.height + 4 && outer.style.marginBottom === '';
        if (matches) return { matched: true, elapsed: performance.now() - started, heavyRan: window.__ran600 - ran,
          sameInput: card.querySelector('textarea') === window.__fastInput && window.__fastInput.isConnected };
      }
      return { matched: false, elapsed: performance.now() - started, heavyRan: window.__ran600 - ran,
        cardMargin: card.style.marginBottom, outerMargin: outer.style.marginBottom };
    })()`);
    assert.equal(removed.heavyRan, 0, 'marker removal must not rely on the 600ms timer');
    assert.equal(removed.matched, true, JSON.stringify(removed));
    assert.equal(removed.sameInput, true);
    assert.ok(removed.elapsed < 500, JSON.stringify(removed));
  });

  await t.test('a newly inserted ancestor is observed before its highspeed marker changes', async () => {
    await reset(b, { stored: 'pill', freeze600: true });
    await b.evaluate(`(() => {
      const card = document.querySelector('#card-a'), outer = document.createElement('div');
      window.__fastInput = card.querySelector('textarea');
      window.__fastCard = card;
      window.__fastOuter = outer;
      window.__freeze600 = true;
      outer.id = 'switch-surface';
      card.parentElement.insertBefore(outer, card);
      outer.appendChild(card);
    })()`);
    await b.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))))');
    const result = await b.evaluate(`(async () => {
      const card = window.__fastCard, outer = window.__fastOuter;
      const bar = document.querySelectorAll('.zusage-root')[0], started = performance.now(), ran = window.__ran600;
      outer.classList.add('highspeed-composer-surface');
      outer.setAttribute('data-highspeed-composer', 'true');
      while (performance.now() - started < 500) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        const r = bar.getBoundingClientRect(), o = outer.getBoundingClientRect();
        const matches = getComputedStyle(bar).backgroundColor === getComputedStyle(outer).backgroundColor &&
          Math.abs((r.left + r.right - o.left - o.right) / 2) <= 2 && r.top >= o.bottom - 1 &&
          parseFloat(outer.style.marginBottom) >= r.height + 4 && card.style.marginBottom === '';
        if (matches) return { matched: true, elapsed: performance.now() - started,
          sameInput: card.querySelector('textarea') === window.__fastInput && window.__fastInput.isConnected,
          heavyRan: window.__ran600 - ran };
      }
      const r = bar.getBoundingClientRect(), c = card.getBoundingClientRect(), o = outer.getBoundingClientRect();
      return { matched: false, elapsed: performance.now() - started, heavyRan: window.__ran600 - ran,
        barBg: getComputedStyle(bar).backgroundColor, outerBg: getComputedStyle(outer).backgroundColor,
        bar: [r.left, r.top, r.width, r.height], card: [c.left, c.top, c.width, c.height],
        outer: [o.left, o.top, o.width, o.height], cardMargin: card.style.marginBottom, outerMargin: outer.style.marginBottom };
    })()`);
    assert.equal(result.heavyRan, 0, 'new ancestor must be tracked without the 600ms timer');
    assert.equal(result.matched, true, JSON.stringify(result));
    assert.equal(result.sameInput, true, 'same composer must remain connected during the marker change');
    assert.ok(result.elapsed < 500, JSON.stringify(result));
  });

  await t.test('highspeed exit restores a card whose outer surface has no chat-composer class', async () => {
    await reset(b, { stored: 'pill', freeze600: true });
    // #highspeed exists before injection and intentionally has only the highspeed
    // class. Keep the same connected input while disabling that outer surface.
    const before = await b.evaluate(`(() => {
      const outer = document.querySelector('#highspeed'), card = document.querySelector('#card-b');
      const bar = document.querySelectorAll('.zusage-root')[1];
      window.__unmarkedInput = card.querySelector('textarea');
      window.__freeze600 = true;
      const r = bar.getBoundingClientRect(), o = outer.getBoundingClientRect();
      return { hasChatClass: outer.classList.contains('chat-composer-input-surface'),
        bg: getComputedStyle(bar).backgroundColor, outerBg: getComputedStyle(outer).backgroundColor,
        centerDelta: Math.abs((r.left + r.right - o.left - o.right) / 2), outerMargin: outer.style.marginBottom };
    })()`);
    assert.equal(before.hasChatClass, false, 'fixture outer must not have the host chat-composer class');
    assert.equal(before.bg, before.outerBg);
    assert.ok(before.centerDelta <= 2 && parseFloat(before.outerMargin) > 0, JSON.stringify(before));
    const after = await b.evaluate(`(async () => {
      const outer = document.querySelector('#highspeed'), card = document.querySelector('#card-b');
      const bar = document.querySelectorAll('.zusage-root')[1], started = performance.now(), ran = window.__ran600;
      outer.classList.remove('highspeed-composer-surface');
      outer.removeAttribute('data-highspeed-composer');
      while (performance.now() - started < 500) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        const r = bar.getBoundingClientRect(), c = card.getBoundingClientRect();
        const same = card.querySelector('textarea') === window.__unmarkedInput && window.__unmarkedInput.isConnected;
        const matches = getComputedStyle(bar).backgroundColor === getComputedStyle(card).backgroundColor &&
          Math.abs((r.left + r.right - c.left - c.right) / 2) <= 2 && r.top >= c.bottom - 1 &&
          parseFloat(card.style.marginBottom) >= r.height + 4 && outer.style.marginBottom === '';
        if (matches) return { matched: true, same, elapsed: performance.now() - started, heavyRan: window.__ran600 - ran };
      }
      const r = bar.getBoundingClientRect(), c = card.getBoundingClientRect();
      return { matched: false, elapsed: performance.now() - started, heavyRan: window.__ran600 - ran,
        barBg: getComputedStyle(bar).backgroundColor, cardBg: getComputedStyle(card).backgroundColor,
        bar: [r.left, r.top, r.width, r.height], card: [c.left, c.top, c.width, c.height],
        cardMargin: card.style.marginBottom, outerMargin: outer.style.marginBottom };
    })()`);
    assert.equal(after.heavyRan, 0, 'restoration must not depend on the 600ms timer');
    assert.equal(after.matched, true, JSON.stringify(after));
    assert.equal(after.same, true, 'the original input must remain connected');
    assert.ok(after.elapsed < 500, JSON.stringify(after));
  });

  await t.test('pill tooltips explicitly show zero cache hit rate when input is positive', async () => {
    await reset(b, { stored: 'pill' });
    const zeroCache = JSON.parse(JSON.stringify(payload));
    for (const entry of zeroCache.recent) {
      entry.cache_read = 0;
      entry.last_turn.cache_read = 0;
    }
    await b.evaluate(`window.__zusageUpdate(${JSON.stringify(zeroCache)})`);
    const tips = await b.evaluate(`(() => {
      const bar = document.querySelector('.zusage-root'), items = [...bar.querySelectorAll('.zu-main .it')];
      const turn = items.find(el => el.textContent.includes('12.5万'));
      const session = items.find(el => el.textContent.includes('58.25万'));
      if (!turn || !session) throw new Error('turn or session item missing');
      const readTip = el => { el.focus(); const tip = document.getElementById(el.getAttribute('aria-describedby'));
        return tip && tip.textContent; };
      return { turn: readTip(turn), session: readTip(session) };
    })()`);
    assert.match(tips.turn, /输入/);
    assert.match(tips.turn, /命中\s*0%/, 'positive turn input and zero cached tokens must show 0%');
    assert.match(tips.session, /输入/);
    assert.match(tips.session, /命中\s*0%/, 'positive session input and zero cached tokens must show 0%');
  });

  await t.test('focused turn tooltip refreshes hidden values without replacing its unchanged item', async () => {
    await reset(b, { stored: 'pill' });
    const initial = await b.evaluate(`(() => {
      const main = document.querySelector('.zusage-root .zu-main');
      const item = [...main.querySelectorAll('.it')].find(el => el.textContent.includes('12.5万'));
      if (!item) throw new Error('turn item missing');
      item.focus();
      window.__unchangedMain = main;
      window.__unchangedItem = item;
      const id = item.getAttribute('aria-describedby'), tip = id && document.getElementById(id);
      return { focused: document.activeElement === item, id, visible: !!tip && getComputedStyle(tip).display !== 'none',
        tip: tip && tip.textContent, html: main.innerHTML };
    })()`);
    assert.ok(initial.focused && initial.id && initial.visible, JSON.stringify(initial));
    assert.match(initial.tip, /单次耗时\s*3\.5s/);
    assert.match(initial.tip, /本轮\s*·\s*3\s*次请求/);
    const inspect = async () => b.evaluate(`(() => {
      const main = document.querySelector('.zusage-root .zu-main'), item = window.__unchangedItem;
      const id = item.getAttribute('aria-describedby'), tip = id && document.getElementById(id);
      return { sameMain: main === window.__unchangedMain, sameItem: item.isConnected && main.contains(item),
        focused: document.activeElement === item, id, visible: !!tip && getComputedStyle(tip).display !== 'none',
        tip: tip && tip.textContent, html: main.innerHTML };
    })()`);
    const duration = JSON.parse(JSON.stringify(payload));
    duration.recent[0].last.duration_ms = 8100;
    await b.evaluate(`window.__zusageUpdate(${JSON.stringify(duration)})`);
    const afterDuration = await inspect();
    assert.ok(afterDuration.sameMain && afterDuration.sameItem && afterDuration.focused, JSON.stringify(afterDuration));
    assert.equal(afterDuration.html, initial.html, 'hidden duration must not rebuild or change the pill surface');
    assert.equal(afterDuration.id, initial.id, 'tooltip relationship must stay on the focused element');
    assert.equal(afterDuration.visible, true);
    assert.match(afterDuration.tip, /单次耗时\s*8\.1s/);
    assert.doesNotMatch(afterDuration.tip, /单次耗时\s*3\.5s/);
    const requests = JSON.parse(JSON.stringify(duration));
    requests.recent[0].last_turn.requests = 7;
    await b.evaluate(`window.__zusageUpdate(${JSON.stringify(requests)})`);
    const afterRequests = await inspect();
    assert.ok(afterRequests.sameMain && afterRequests.sameItem && afterRequests.focused, JSON.stringify(afterRequests));
    assert.equal(afterRequests.html, initial.html, 'hidden request count must not rebuild or change the pill surface');
    assert.equal(afterRequests.id, initial.id);
    assert.equal(afterRequests.visible, true);
    assert.match(afterRequests.tip, /本轮\s*·\s*7\s*次请求/);
    assert.match(afterRequests.tip, /单次耗时\s*8\.1s/);
    assert.doesNotMatch(afterRequests.tip, /本轮\s*·\s*3\s*次请求/);
  });

  await t.test('focused item replacement retains focus and its updated tooltip relationship', async () => {
    await reset(b, { stored: 'pill' });
    const before = await b.evaluate(`(() => {
      const bar = document.querySelector('.zusage-root');
      const item = [...bar.querySelectorAll('.zu-main .it')].find(el => el.textContent.includes('12.5万'));
      if (!item) throw new Error('turn item missing');
      item.focus();
      window.__oldFocusedItem = item;
      const id = item.getAttribute('aria-describedby'), tip = document.getElementById(id);
      return { focused: document.activeElement === item, id, tip: tip && tip.textContent,
        visible: tip && getComputedStyle(tip).display !== 'none' };
    })()`);
    assert.equal(before.focused, true);
    assert.ok(before.id && before.visible, JSON.stringify(before));
    assert.match(before.tip, /12\.5万|10万/);
    const updated = JSON.parse(JSON.stringify(payload));
    updated.recent[0].last_turn.total = 230000;
    updated.recent[0].last_turn.input = 200000;
    updated.recent[0].last_turn.cache_read = 50000;
    await b.evaluate(`window.__zusageUpdate(${JSON.stringify(updated)})`);
    await b.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const after = await b.evaluate(`(() => {
      const bar = document.querySelector('.zusage-root');
      const item = [...bar.querySelectorAll('.zu-main .it')].find(el => el.textContent.includes('23万'));
      const id = item && item.getAttribute('aria-describedby'), tip = id && document.getElementById(id);
      return { replaced: !!item && item !== window.__oldFocusedItem && !window.__oldFocusedItem.isConnected,
        focused: document.activeElement === item, id, tip: tip && tip.textContent,
        visible: !!tip && getComputedStyle(tip).display !== 'none' };
    })()`);
    assert.equal(after.replaced, true, 'fixture must actually rebuild the focused item');
    assert.equal(after.focused, true, 'focus should follow the replacement item');
    assert.ok(after.id && after.visible, JSON.stringify(after));
    assert.match(after.tip, /20万/, 'replacement tooltip must reflect the updated input');
    assert.match(after.tip, /命中\s*25%/, 'replacement tooltip must reflect updated cache ratio');
  });

  await t.test('compact display keeps values, detail tooltip, units and quota across round trip', async () => {
    await reset(b);
    // Remove width-based shrink hysteresis from this content-only comparison.
    await b.evaluate(`document.querySelectorAll('.zusage-root .zu-main').forEach(el => {
      Object.defineProperty(el, 'clientWidth', { value: 10000, configurable: true });
      Object.defineProperty(el, 'scrollWidth', { value: 0, configurable: true });
    })`);
    await b.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const inspect = async () => b.evaluate(`(() => {
      const bar = document.querySelector('.zusage-root');
      const items = [...bar.querySelectorAll('.zu-main .it')];
      const turn = items.find(el => el.textContent.includes('12.5万'));
      const session = items.find(el => el.textContent.includes('58.25万'));
      if (!turn || !session) throw new Error('turn or session item missing');
      const readTip = el => {
        el.focus();
        const tip = document.getElementById(el.getAttribute('aria-describedby'));
        return tip && tip.textContent;
      };
      return { visible: turn.textContent, tip: readTip(turn), session: session.textContent, sessionTip: readTip(session),
        quota: document.querySelector('.zu-quota').textContent, total: bar.textContent, itemCount: items.length };
    })()`);
    const normal = await inspect();
    assert.match(normal.visible, /12\.5万/);
    assert.match(normal.tip, /本轮/);
    assert.match(normal.tip, /首字延迟/);
    assert.match(normal.quota, /26%/);
    assert.match(normal.total, /58\.25万/);
    await choose(b, 'pill');
    const pill = await inspect();
    assert.match(pill.visible, /12\.5万/);
    assert.equal(pill.tip, normal.tip, 'compact mode must retain the full turn tooltip');
    assert.equal(pill.sessionTip, normal.sessionTip, 'compact mode must retain the full session tooltip');
    assert.equal(pill.itemCount, normal.itemCount, 'compact mode must retain each interactive item');
    assert.equal(pill.quota, normal.quota, 'quota text must not depend on bar theme');
    assert.match(pill.total, /58\.25万/);
    assert.ok(pill.visible.length < normal.visible.length, 'pill should omit secondary turn fields');
    assert.ok(pill.session.length < normal.session.length, 'pill should omit secondary session fields');
    await choose(b, 'default', 1);
    const restored = await inspect();
    assert.equal(restored.visible, normal.visible);
    assert.equal(restored.session, normal.session);
    assert.equal(restored.tip, normal.tip);
    assert.equal(restored.sessionTip, normal.sessionTip);
    assert.equal(restored.quota, normal.quota);
  });

  await t.test('reinjection removes the previous generation and leaves no duplicate handlers', async () => {
    await reset(b, { stored: 'pill' });
    await b.evaluate(`window.__oldBars = [...document.querySelectorAll('.zusage-root')]; window.__oldGeneration = window.__zusageGen; window.__zusageOverlay = false;`);
    await b.evaluate(overlay);
    await b.waitFor(`document.querySelectorAll('.zusage-root').length === 2 && [...document.querySelectorAll('.zusage-root')].every(b => getComputedStyle(b).display !== 'none')`);
    const clean = await b.evaluate(`({ generation: window.__zusageGen, previous: window.__oldGeneration,
      oldConnected: window.__oldBars.map(b => b.isConnected), panels: document.querySelectorAll('.zu-settings').length })`);
    assert.ok(clean.generation > clean.previous);
    assert.deepEqual(clean.oldConnected, [false, false]);
    assert.equal(clean.panels, 2);
    assert.deepEqual(await themes(b), ['pill', 'pill']);
    await b.evaluate('window.__testWrites.length = 0');
    await choose(b, 'default');
    assert.deepEqual(await themes(b), ['default', 'default']);
    assert.deepEqual(await b.evaluate('window.__testWrites'), [['zusage3.theme', 'default']]);
    await b.evaluate('window.__zusageDispose()');
    assert.equal(await b.evaluate(`document.querySelectorAll('.zusage-root, .zu-settings').length`), 0);
  });
});
