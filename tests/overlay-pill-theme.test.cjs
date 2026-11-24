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
const turnStats = fs.readFileSync(path.join(__dirname, '..', 'turn-stats.js'), 'utf8');   // 统计内核（线上注入序：先于 overlay.js）
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
    '--use-mock-keychain', '--password-store=basic',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    '--user-data-dir=' + profile, pathToFileURL(fixture).href,
  ];
  const proc = spawn(chrome, args, { stdio: 'ignore', env: {
    ...process.env, HOME: temp, USERPROFILE: temp, TMPDIR: temp,
    XDG_CONFIG_HOME: path.join(temp, 'config'), XDG_CACHE_HOME: path.join(temp, 'cache'),
    APPDATA: path.join(temp, 'roaming'), LOCALAPPDATA: path.join(temp, 'local'),
  } });
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
      await delay(500);
    }
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
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
  async function waitFor(expression, message, budget = 160) {
    /* v177：默认 5s→8s——冷启动+负载下 bars 挂载偶发超 5s（双向 flake 实测）；
     * 个别慢等待可传更大 budget。 */
    for (let i = 0; i < budget; i++) {
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
    last_turn: { total: 125000, input: 100000, output: 25000, cache_read: 50000, requests: 3, duration_ms: 9000, avg_duration_ms: 3500, avg_ttft_ms: 700 },
    last: { tps: 92, duration_ms: 3500, ttft_ms: 700, provider_id: 'account:bigmodel-individual-coding-plan', model: 'GLM-test' },
    tools: { total: 3, errors: 0, list: [] },
  })),
  quota: { status: 'ok', providerId: 'account:bigmodel-individual-coding-plan', stale: false, error: '',
    windows: { fiveHour: { percent: 26, resetsAt: null, details: [] }, weekly: { percent: 12, resetsAt: null, details: [] } }, tools: { used: 48, total: 4000 } },
};

async function reset(browser, { stored, brokenRead = false, brokenWrite = false, width = 1200, narrow = false, freeze600 = false, withKernel = false, ls = {}, dsf = 1 } = {}) {
  await browser.call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: dsf, mobile: false });
  const token = Math.random().toString(36).slice(2);
  await browser.call('Page.navigate', { url: browser.url + '?case=' + token });
  await browser.waitFor(`document.readyState === "complete" && location.search === '?case=${token}'`, 'fixture page did not load');
  await browser.evaluate(`(() => {
    document.body.innerHTML = ${JSON.stringify(fixtureHtml)};
    localStorage.clear();
    ${stored === undefined ? '' : `localStorage.setItem('zusage3.theme', ${JSON.stringify(stored)});`}
    ${Object.entries(ls).map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n')}
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
  if (withKernel) {   // 走实时数据链的用例：先装桥接口与统计内核，再注入 overlay（注入序同线上）
    await browser.evaluate(`(${liveProbeBoot.toString()})()`);
    await browser.evaluate(turnStats);
  }
  await browser.evaluate(overlay);
  const count = narrow ? 1 : 2;
  await browser.waitFor(`document.querySelectorAll('.zusage-root').length === ${count} && [...document.querySelectorAll('.zusage-root')].every(b => getComputedStyle(b).display !== 'none')`, 'bars did not mount');
  await browser.evaluate(`window.__zusageUpdate(${JSON.stringify(payload)})`);
  await browser.waitFor(`document.querySelectorAll('.zu-quota').length === ${count}`, 'test quota chips did not mount');
  // A payload changes the bar width; positioning follows on the next animation frame.
  await browser.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
}

/* ---------- 实时数据链（updateLive）用例的页面侧辅助，经 toString() 送进夹具页面 ---------- */
/* 伪造 renderer 会话 store 桥（与 tests/overlay-bridge.test.cjs 的 harness 同语义）+ 快照构造器。
 * 注入序与线上一致：桥接口 → turn-stats.js → overlay.js。 */
function liveProbeBoot() {
  const P = window.__liveProbe = { sessions: [] };
  P.mkStore = snapshot => { const subs = new Set(); return { state: snapshot,
    getState() { return this.state === null ? null : { snapshot: this.state, status: 'live' }; },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }, off() {},
    set(s) { this.state = s; for (const fn of [...subs]) fn(); } }; };
  P.snap = (seq, rows) => ({ sessionId: 'sid_a', logEpoch: 'e1', seq, rows: { window: rows } });
  P.header = (state, extra) => Object.assign({ rowId: 1, turnId: 't1', productTurnId: 'pt1', kind: 'turnHeader', state }, extra || {});
  P.text = value => ({ rowId: 2, turnId: 't1', productTurnId: 'pt1', kind: 'assistantText', text: value });
  P.tool = (status, extra) => Object.assign({ rowId: 5, turnId: 't1', productTurnId: 'pt1', kind: 'toolCall', toolName: 'Read', inputText: '{}', status }, extra || {});
  window.__zusageConversationDiagnostics = () => ({ keys: P.sessions.map(s => s.key), sessions: P.sessions });
  window.__zusageGetExistingConversationStore = scope => {
    if (!scope || typeof scope.sessionId !== 'string') return null;
    const ws = (typeof scope.workspaceIdentity === 'string' && scope.workspaceIdentity.trim()) || scope.workspacePath;
    if (!ws) return null;
    const remote = scope.remoteSessionId || '__base__';
    const entry = P.sessions.find(s => s.topic === 'conversation/' + scope.sessionId && s.key === remote + ' ' + ws);
    return entry && entry.store || null;
  };
  /* pane-a 的速度格：卡内形态的条在 #pane-a 里；药丸条挂在 body 级——按实例序取第一条（a 在前） */
  P.cell = () => {
    const bars = [...document.querySelectorAll('.zusage-root')];
    const bar = bars.find(x => x.closest('#pane-a')) || bars[0];
    return bar ? bar.querySelector('.zu-main > .it.zu-speed') : null;
  };
}
/* 速度格与邻格的几何（CSS 像素，保留两位）与语义。图标按类名/路径区分：脑（思考）/ 扳手（工具）/ 闪电。 */
function liveGeo() {
  const cell = window.__liveProbe.cell();
  if (!cell) return null;
  const r = e => { if (!e) return null; const b = e.getBoundingClientRect(); return [b.left, b.top, b.width, b.height].map(x => Math.round(x * 100) / 100); };
  const ico = cell.querySelector('.ico'), live = cell.querySelector('.zu-live');
  const lab = cell.querySelector('.zu-sp-label'), val = cell.querySelector('.zu-sp-val'), unit = cell.querySelector('.zu-sp-unit');
  const main = cell.closest('.zu-main'), bar = cell.closest('.zusage-root'), card = document.querySelector('#card-a');
  const iconKind = !ico ? null : ico.classList.contains('zu-think') ? 'think' : /M14\.5 2\.5a6 6/.test(ico.innerHTML) ? 'tool' : 'bolt';
  const cells = [...main.querySelectorAll(':scope > .it')].filter(e => e.dataset.zuFolded !== '1').map(e => [e.dataset.zuKey, r(e)]);
  const c = card.getBoundingClientRect(), br = bar.getBoundingClientRect();
  return { label: lab ? lab.textContent : null, value: val ? val.textContent : null, unit: unit ? unit.textContent : null,
    cls: live.className, iconKind, cell: r(cell), icon: r(ico), live: r(live), labelRect: r(lab), val: r(val), unitRect: r(unit),
    cells, scrollLeft: main.scrollLeft, bar: r(bar), barCenter: br.left + br.width / 2, cardCenter: c.left + c.width / 2,
    barCls: bar.className, tier: bar.classList.contains('zu-narrow') ? 'narrow' : bar.classList.contains('zu-tight') ? 'tight'
      : bar.classList.contains('zu-speed-tight') ? 'pill-tight' : bar.classList.contains('zu-speed-mid') ? 'pill-mid' : 'wide',
    aria: cell.getAttribute('aria-label'), full: cell.dataset.zuFull,
    ariaLive: cell.getAttribute('aria-live') || (cell.closest('[aria-live]') ? 'ancestor' : null),
    iconAriaHidden: ico ? ico.getAttribute('aria-hidden') : null, focusable: cell.tabIndex };   // 图标是装饰（aria-hidden），含义由 aria-label 承载
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

/* 速度格稳定占位的真实布局探针（specs/speed-chip-stable-slot.md；在夹具页面里执行，自包含）：对真实
   overlay 建出来的状态条，逐档（默认四档 + 药丸三档）逐状态面写入格面并量矩形。状态面与
   zuSpeedFaceHtml 同构、不经数据链（展示时机由 overlay-speed-slot 锁）。越界判据=最后一个可见项
   右缘超过速度格内容区右缘（亚像素）——scrollWidth/clientWidth 是取整整数，会掩盖 1~3px 的越界
   （紧张档 6.4em 时期「思考 23:59:59」实测越界 1.5px 即被掩盖）。量完全部还原。 */
function speedSlotProbe() {
  const bar = document.querySelector('#pane-a .zusage-root'), main = bar.querySelector('.zu-main');
  const speed = main.querySelector('.it.zu-speed');
  if (!speed) return { error: 'speed cell missing' };
  const F = (label, val, unit) => '<span class="zu-sp-label">' + label + '</span><span class="zu-sp-val">' + val + '</span>' + (unit ? '<span class="zu-sp-unit dim">' + unit + '</span>' : '');
  const faces = {
    real201: F('', '201', 't/s'), hist: F('历史', '201.4', 't/s'), real99: F('', '9.9', 't/s'), real250: F('', '250.0', 't/s'),
    est: F('生成', '≈128.6', 't/s'), estMax: F('生成', '≈9999.9', 't/s'), estK: F('生成', '≈12.9k', 't/s'),
    thinkHalf: F('思考', '0.5s'), think: F('思考', '6:33'), thinkHour: F('思考', '1:05:00'), thinkDay: F('思考', '23:59:59'), thinkOver: F('思考', '1天3时'),
    tool: F('读取', '01s'), group: F('查阅', '03s'), skill: F('代码审查与修复', '12s'),
    sub1: F('代理', '≈1286.5', 't/s'), sub3: F('代理×3', '≈28.8', 't/s'), sub12: F('代理×12', '≈1286.5', 't/s'),
    enThink: F('Think', '23:59:59'), enOver: F('Think', '1d 3h'), enAgt: F('Agt×12', '≈1286.5', 't/s'), enGen: F('Gen', '≈9999.9', 't/s'), enSkill: F('code-review-and-fix', '12s'),
  };
  const tiers = [
    ['默认 宽裕', [], null, ''], ['默认 中等', ['zu-tight'], null, ''], ['默认 紧张', ['zu-tight', 'zu-narrow'], null, ''], ['默认 极窄', ['zu-tight', 'zu-narrow'], '1', ''],
    ['药丸 宽裕', ['zu-pill'], null, 'p'], ['药丸 中等', ['zu-pill', 'zu-speed-mid'], null, 'p'], ['药丸 紧张', ['zu-pill', 'zu-speed-tight'], null, 'p'],
  ];
  const first = speed.querySelector('.zu-live');
  const origLive = first && first.outerHTML;
  const save = { barStyle: bar.getAttribute('style'), barCls: bar.className, rootVar: document.documentElement.style.getPropertyValue('--ui-font-size') };
  const R = e => e.getBoundingClientRect();
  const setFace = html => {
    const cur = speed.querySelector('.zu-live'), next = '<span class="zu-live zu-sky">' + html + '</span>';
    if (cur) cur.outerHTML = next; else speed.insertAdjacentHTML('beforeend', next);
  };
  const setVar = v => { if (v) document.documentElement.style.setProperty('--ui-font-size', v); else document.documentElement.style.removeProperty('--ui-font-size'); };
  const res = {};
  try {
    const lockBase = Math.round(R(bar.parentElement).width) + 'px';
    for (const ui of ['', '11px', '20px']) {
      setVar(ui || save.rootVar);
      for (const [name, cls, min, mode] of tiers) {
        bar.className = 'zusage-root' + (mode === 'p' ? ' zu-pill' : ' zu-in') + cls.map(c => ' ' + c).join('');
        const lock = mode === 'p' ? '' : lockBase;
        bar.style.minWidth = lock; bar.style.maxWidth = lock;
        if (min) speed.dataset.zuSpeedMin = min; else delete speed.dataset.zuSpeedMin;
        const turn = main.querySelector('.it[data-zu-key="turn"]');
        const row = { fs: getComputedStyle(speed).fontSize, speedW: [], turnL: [], overflow: [], minSlack: Infinity, minLead: Infinity };
        res[(ui || 'default') + ' ' + name] = row;
        const set = mode === 'min' ? { real201: faces.real201, hist: faces.hist } : faces;
        for (const [key, html] of Object.entries(set)) {
          setFace(html);
          const cs = getComputedStyle(speed), box = R(speed);
          const items = [...speed.querySelectorAll('.zu-live > *')].filter(e => getComputedStyle(e).display !== 'none');
          row.speedW.push(Math.round(box.width * 100) / 100);
          if (turn) row.turnL.push(Math.round(R(turn).left * 100) / 100);
          if (!items.length) continue;
          const slack = (box.right - parseFloat(cs.paddingRight)) - R(items[items.length - 1]).right;   // 右侧余量（<0 即越界）
          const lead = R(items[0]).left - R(speed.querySelector('.zu-live')).left;                      // 左侧余量：最窄档数值靠右，余量在左
          row.minSlack = Math.min(row.minSlack, Math.round(slack * 100) / 100);
          row.minLead = Math.min(row.minLead, Math.round(lead * 100) / 100);
          if (slack < -0.05) row.overflow.push(key);
        }
      }
    }
  } finally {
    setVar(save.rootVar);
    bar.setAttribute('style', save.barStyle || ''); bar.className = save.barCls;
    if (origLive && speed.querySelector('.zu-live')) setFace(origLive.replace(/^<span class="zu-live[^"]*">/, '').replace(/<\/span>$/, ''));
    delete speed.dataset.zuSpeedMin;
  }
  return res;
}

test('dual theme browser behaviour (isolated fixture)', { skip: skipReason, timeout: 90000 }, async t => {
  const b = await startBrowser(t);

  await t.test('theme change resets the main scroll offset (scrolled pill → default)', async () => {
    /* 速度格稳定占位（specs/speed-chip-stable-slot.md）后默认条的横向滚动不再可达：折叠回展触发器改按
       真实内容宽判富余（scrollWidth 以 clientWidth 为下限，旧判据从未成立、回展分支是死分支），默认条
       钳 .zu-main 会触发重算，把剩余格（含速度格）折进「···」吸收溢出。旧版本「默认条 220px 全折后钳
       48px 制造横滚再切药丸」的前置不再成立；改在药丸条（按内容定宽、原生横滚）上制造真实偏移，验证
       切档归零（setBarTheme 对任何主题变化都置 scrollLeft=0）。 */
    await reset(b, { stored: 'pill' });
    await b.evaluate(`Object.assign(document.querySelector('#pane-a').style, { left: '20px', width: '240px' })`);
    /* 药丸条挂 body 级（不在 #pane-a 子树内），按卡片顺序取第 0 个条（同下文 pill 跟随卡片的取法） */
    await b.waitFor(`(() => { const m = document.querySelectorAll('.zusage-root')[0].querySelector('.zu-main'); return m.scrollWidth > m.clientWidth + 1; })()`, 'narrow pill did not scroll');
    await b.evaluate(`(() => { const m = document.querySelectorAll('.zusage-root')[0].querySelector('.zu-main'); m.scrollLeft = m.scrollWidth; })()`);
    assert.ok(await b.evaluate(`document.querySelectorAll('.zusage-root')[0].querySelector('.zu-main').scrollLeft`) > 0, 'pill main is really scrolled');
    await b.evaluate(`window.__testMain = document.querySelectorAll('.zusage-root')[0].querySelector('.zu-main')`);
    await choose(b, 'default');
    assert.equal(await b.evaluate(`window.__testMain.scrollLeft`), 0);
  });

  await t.test('secondary counts use a compact step before hiding and restore', async () => {
    await reset(b);
    await b.evaluate(`document.querySelector('#pane-a').style.width = '1100px'`);
    await b.waitFor(`!document.querySelector('#pane-a .zusage-root').classList.contains('zu-narrow')`, 'wide bar did not restore');
    const dims = await b.evaluate(`(() => {
      const bar = document.querySelector('#pane-a .zusage-root'), main = bar.querySelector('.zu-main');
      const probe = bar.cloneNode(false), m = main.cloneNode(true);
      probe.classList.remove('zu-in', 'zu-narrow', 'zu-tight');
      probe.style.cssText = 'position:fixed;left:-10000px;visibility:hidden;width:max-content;min-width:0;max-width:none';
      m.style.cssText = 'width:max-content;min-width:max-content;flex:none;overflow:visible';
      probe.appendChild(m); bar.parentElement.appendChild(probe);
      const full = m.getBoundingClientRect().width;
      probe.classList.add('zu-tight'); const tight = m.getBoundingClientRect().width;
      probe.remove();
      return { full, tight, delta: document.querySelector('#pane-a').getBoundingClientRect().width - main.clientWidth,
        secondarySize: parseFloat(getComputedStyle(main.querySelector('.zu-secondary')).fontSize),
        primarySize: parseFloat(getComputedStyle(main.querySelector('.v')).fontSize) };
    })()`);
    assert.ok(dims.full > dims.tight + 4, JSON.stringify(dims));
    await b.evaluate(`document.querySelector('#pane-a').style.width = ${JSON.stringify((dims.full + dims.tight) / 2 + dims.delta)} + 'px'`);
    await b.waitFor(`document.querySelector('#pane-a .zusage-root').classList.contains('zu-tight')`, 'compact step did not activate');
    const tight = await b.evaluate(`(() => { const bar = document.querySelector('#pane-a .zusage-root'), m = bar.querySelector('.zu-main'), s = m.querySelector('.zu-secondary'); return { visible: getComputedStyle(s).visibility, size: parseFloat(getComputedStyle(s).fontSize), primary: parseFloat(getComputedStyle(m.querySelector('.v')).fontSize), overflow: m.scrollWidth > m.clientWidth + 1, tip: !!s.closest('.it').__tip }; })()`);
    assert.equal(tight.visible, 'visible'); assert.ok(tight.size < dims.secondarySize && tight.size >= 11);
    assert.ok(tight.primary < dims.primarySize && tight.primary >= 11); assert.equal(tight.overflow, false); assert.ok(tight.tip);
    await b.evaluate(`document.querySelector('#pane-a').style.width = ${JSON.stringify(dims.tight - 10 + dims.delta)} + 'px'`);
    await b.waitFor(`document.querySelector('#pane-a .zusage-root').classList.contains('zu-narrow')`, 'secondary counts did not hide');
    await b.evaluate(`document.querySelector('#pane-a').style.width = ${JSON.stringify(dims.tight + 30 + dims.delta)} + 'px'`);
    await b.waitFor(`(() => { const bar = document.querySelector('#pane-a .zusage-root'); return bar.classList.contains('zu-tight') && !bar.classList.contains('zu-narrow'); })()`, 'compact step did not return');
    await b.evaluate(`document.querySelector('#pane-a').style.width = ${JSON.stringify(dims.full + 30 + dims.delta)} + 'px'`);
    await b.waitFor(`(() => { const b = document.querySelector('#pane-a .zusage-root'); return !b.classList.contains('zu-tight') && !b.classList.contains('zu-narrow'); })()`, 'full counts did not return');
  });

  await t.test('default bar adapts counts, folds through the speed cell, and restores independently', async () => {
    await reset(b);
    await b.evaluate(`document.querySelector('#pane-a').style.width = '1100px'`);
    await b.waitFor(`!document.querySelector('#pane-a .zusage-root').classList.contains('zu-narrow')`, 'wide bar did not restore');
    const full = await b.evaluate(`(() => { const bar = document.querySelector('#pane-a .zusage-root'); return [...bar.querySelectorAll('.zu-secondary')].map(x => x.textContent); })()`);
    assert.ok(full.length >= 3, 'secondary counts exist');
    await b.evaluate(`document.querySelector('#pane-a').style.width = '420px'`);
    await b.waitFor(`document.querySelector('#pane-a .zusage-root').classList.contains('zu-narrow')`, 'narrow bar did not compact');
    const compact = await b.evaluate(`(() => { const bar = document.querySelector('#pane-a .zusage-root'); return { counts: [...bar.querySelectorAll('.zu-secondary')].map(x => [x.textContent, getComputedStyle(x).visibility]), other: document.querySelector('#pane-b .zusage-root').classList.contains('zu-narrow') }; })()`);
    assert.deepEqual(compact.counts.map(x => x[0]), full);
    assert.ok(compact.counts.every(x => x[1] === 'hidden'));
    await b.evaluate(`document.querySelector('#pane-a').style.width = '220px'`);
    /* v357① 探针剥折叠态修复后，220px 是稳定终态：可折叠格全部折进「···」，残部
       （speed+⋯+齿轮）恰好装下——旧断言「此时必须溢出+渐隐」实际骑在折叠↔展开
       震荡的展开相上（探针把已折叠克隆量成全宽装下→shrink 回 0，约 2Hz）。 */
    await b.waitFor(`(() => {
      const bar = document.querySelector('#pane-a .zusage-root'), m = bar.querySelector('.zu-main');
      const folded = [...m.querySelectorAll(':scope > .it')].filter(e => (e.dataset.zuKey || 'system') !== 'speed');
      return bar.classList.contains('zu-narrow') && folded.length > 0 &&
        folded.every(e => e.dataset.zuFolded === '1') &&
        bar.querySelector('.zu-more').dataset.zuVisible === '1' &&
        m.scrollWidth <= m.clientWidth + 1 && !m.classList.contains('zu-clip');
    })()`, 'narrow bar did not settle fully folded');
    /* 速度格稳定占位（specs/speed-chip-stable-slot.md）：钳 .zu-main 触发折叠重算（已折叠态的富余按
       真实内容宽计，失去富余即重算）。速度格是最后候选——先降「极窄」（data-zu-speed-min，仅图标，
       装得下且富余≥FOLD_HYS 就停），再窄才折进「···」；解除钳制按同一序列回展。旧版本靠钳 48px
       制造「全折仍溢出→横滚渐隐」已不可达（重算会吸收溢出）。 */
    const clamp = px => b.evaluate(px ? `document.querySelector('#pane-a .zu-main').style.maxWidth = '${px}px'` : `document.querySelector('#pane-a .zu-main').style.maxWidth = ''`);
    await clamp(64);
    await b.waitFor(`(() => {
      const bar = document.querySelector('#pane-a .zusage-root'), m = bar.querySelector('.zu-main');
      const speed = m.querySelector('.it[data-zu-key="speed"]');
      return bar.classList.contains('zu-narrow') && !!speed && speed.dataset.zuSpeedMin === '1' && speed.dataset.zuFolded === '0' &&
        [...m.querySelectorAll(':scope > .it')].filter(e => e !== speed).every(e => e.dataset.zuFolded === '1') &&
        m.scrollWidth <= m.clientWidth + 1 && !m.classList.contains('zu-clip');
    })()`, 'speed cell did not degrade to icon-only before folding');
    assert.deepEqual(await b.evaluate(`[...document.querySelectorAll('#pane-a .zu-main > .it')].filter(e => e.dataset.zuFolded !== '1').map(e => e.dataset.zuKey)`), ['speed'], 'only the speed cell stays on the bar, icon-only');
    await clamp(48);
    await b.waitFor(`(() => { const m = document.querySelector('#pane-a .zu-main'); return [...m.querySelectorAll(':scope > .it')].every(e => e.dataset.zuFolded === '1') && m.scrollWidth <= m.clientWidth + 1; })()`, 'speed cell did not fold when even icon-only leaves no hysteresis slack');
    assert.equal(await b.evaluate(`document.querySelector('#pane-a .zu-more').dataset.zuVisible`), '1', 'everything is reachable from the ⋯ menu');
    await clamp('');
    await b.waitFor(`(() => {
      const bar = document.querySelector('#pane-a .zusage-root'), m = bar.querySelector('.zu-main');
      const speed = m.querySelector('.it[data-zu-key="speed"]');
      const folded = [...m.querySelectorAll(':scope > .it')].filter(e => (e.dataset.zuKey || 'system') !== 'speed');
      return bar.classList.contains('zu-narrow') && !!speed && speed.dataset.zuSpeedMin !== '1' && speed.dataset.zuFolded === '0' &&
        folded.every(e => e.dataset.zuFolded === '1') && m.scrollWidth <= m.clientWidth + 1;
    })()`, 'speed cell did not restore after unclamping');
    await b.evaluate(`document.querySelector('#pane-a').style.width = '1100px'`);
    await b.waitFor(`!document.querySelector('#pane-a .zusage-root').classList.contains('zu-narrow')`, 'wide bar did not restore after folding');
    const restored = await b.evaluate(`(() => { const bar = document.querySelector('#pane-a .zusage-root'); return [...bar.querySelectorAll('.zu-secondary')].map(x => getComputedStyle(x).visibility); })()`);
    assert.ok(restored.every(x => x === 'visible'));
    assert.equal(await b.evaluate(`[...document.querySelectorAll('#pane-a .zu-main > .it')].every(e => e.dataset.zuFolded !== '1')`), true, 'no cell stays folded on the wide bar');
  });

  /* 速度格稳定占位（specs/speed-chip-stable-slot.md）核心不变量的真实布局证据：同一布局档位里，状态
     面怎么变速度格宽度都恒定、邻格 left 不动；数值右缘不得越过速度格内容区（亚像素判据）；三种界面
     字号覆盖 em 随字号缩放与图标定宽的交互；药丸紧张档与默认条紧张档同宽。 */
  await t.test('speed cell keeps one slot width per layout tier across all state faces; neighbours never move; no value crosses the cell edge', async () => {
    await reset(b);
    await b.evaluate(`document.querySelector('#pane-a').style.width = '1100px'`);
    await b.waitFor(`!document.querySelector('#pane-a .zusage-root').classList.contains('zu-tight')`, 'wide bar did not restore');
    const report = await b.evaluate(`(${speedSlotProbe.toString()})()`);
    assert.ok(!report.error, report.error);
    assert.equal(Object.keys(report).length, 21, '3 interface font sizes × 7 tiers');
    for (const [tier, r] of Object.entries(report)) {
      assert.equal(new Set(r.speedW).size, 1, `${tier}: speed width varies with state: ${[...new Set(r.speedW)]}`);
      assert.ok(r.turnL.length > 0 && new Set(r.turnL).size === 1, `${tier}: neighbour cell moved: ${[...new Set(r.turnL)]}`);
      assert.deepEqual(r.overflow, [], `${tier}: value crosses the cell edge`);
    }
    for (const ui of ['default', '11px', '20px']) {
      const d = report[ui + ' 默认 紧张'], p = report[ui + ' 药丸 紧张'];
      assert.equal(d.fs, p.fs, `${ui}: pill tight tier uses the default bar's narrow font size`);
      assert.equal(d.speedW[0], p.speedW[0], `${ui}: pill tight tier is as wide as the default bar's narrow tier`);
      assert.ok(Math.min(d.minLead, p.minLead) >= 4, `${ui}: narrow tier lead ≥4px (got default ${d.minLead}, pill ${p.minLead})`);
      assert.ok(report[ui + ' 默认 极窄'].speedW[0] < d.speedW[0] / 2, `${ui}: icon-only tier`);
      assert.ok(d.speedW[0] < report[ui + ' 默认 中等'].speedW[0] && report[ui + ' 默认 中等'].speedW[0] < report[ui + ' 默认 宽裕'].speedW[0], `${ui}: tiers shrink monotonically`);
      const m = report[ui + ' 药丸 中等'], dm = report[ui + ' 默认 中等'];
      assert.equal(dm.fs, m.fs, `${ui}: pill mid tier uses the default bar's compact font size`);
      assert.equal(dm.speedW[0], m.speedW[0], `${ui}: pill mid tier is as wide as the default bar's compact tier`);
    }
    /* 目标 §5 四档宽度区间（按默认界面字号 14px 校验；其它界面字号随 em 等比缩放）：宽裕 160–180 / 中等 112–132 / 紧张 72–88 / 极窄 32–40 */
    const inRange = (tier, lo, hi) => { const w = report['default ' + tier].speedW[0]; assert.ok(w >= lo && w <= hi, `${tier}: ${w}px outside ${lo}–${hi}`); };
    inRange('默认 宽裕', 160, 180); inRange('默认 中等', 112, 132); inRange('默认 紧张', 72, 88); inRange('默认 极窄', 32, 40);
    inRange('药丸 宽裕', 160, 180); inRange('药丸 中等', 112, 132); inRange('药丸 紧张', 72, 88);
    assert.ok(report['default 默认 宽裕'].speedW[0] > report['11px 默认 宽裕'].speedW[0] && report['20px 默认 宽裕'].speedW[0] > report['default 默认 宽裕'].speedW[0], 'em scales with the interface font size');
    assert.equal(await b.evaluate(`getComputedStyle(document.querySelector('#pane-a .zusage-root')).display !== 'none' && !!document.querySelector('#pane-a .it.zu-speed .zu-live') && !document.documentElement.style.getPropertyValue('--ui-font-size')`), true, 'bar and font variable restored after the probe');
  });

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

  await t.test('all six cells off auto-switches to compact and restores the source theme (v226)', async () => {
    const uncheckSix = `(() => {
      const panel = document.querySelector('.zu-settings');
      for (const k of ['turn', 'win', 'proj', 'tools', 'today', 'sub']) {
        const cb = panel.querySelector('input[type=checkbox][data-k="' + k + '"]');
        if (!cb.checked) throw new Error(k + ' should start checked');
        cb.click();
      }
    })()`;
    const recheckTurn = `document.querySelector('.zu-settings input[type=checkbox][data-k="turn"]').click()`;

    await reset(b);
    await b.evaluate(uncheckSix);
    assert.deepEqual(await themes(b), ['compact', 'compact']);
    assert.equal(await b.evaluate(`localStorage.getItem('zusage3.theme')`), 'compact');
    assert.equal(await b.evaluate(`localStorage.getItem('zusage3.autoCompact')`), 'default');
    assert.ok(await b.evaluate(`[...document.querySelectorAll('.zusage-root')].every(x => getComputedStyle(x).display === 'none')`), '条随精简档隐藏');
    assert.equal(await b.evaluate(`getComputedStyle(document.querySelector('.zu-just-block')).display`), 'none', '对齐设置块随档隐藏');
    await b.evaluate(recheckTurn);
    assert.deepEqual(await themes(b), ['default', 'default']);
    assert.equal(await b.evaluate(`localStorage.getItem('zusage3.autoCompact')`), '', '恢复后标记清除');

    await reset(b);
    await choose(b, 'pill');
    await b.evaluate(uncheckSix);
    assert.deepEqual(await themes(b), ['compact', 'compact']);
    assert.equal(await b.evaluate(`localStorage.getItem('zusage3.autoCompact')`), 'pill', '药丸来源被记录');
    await b.evaluate(recheckTurn);
    assert.deepEqual(await themes(b), ['pill', 'pill'], '重开格子恢复药丸');
  });

  await t.test('horizontal alignment: three choices, default-theme-only, right packs via first-child auto margin (v226)', async () => {
    await reset(b);
    const firstMargin = `getComputedStyle(document.querySelector('.zusage-root .zu-main').firstElementChild).marginLeft`;
    const betweenMargin = await b.evaluate(firstMargin);
    assert.equal(await b.evaluate(`getComputedStyle(document.querySelector('.zusage-root .zu-main')).justifyContent`), 'space-between', '缺省均分');
    await b.evaluate(`document.querySelector('.zu-settings .zu-just-choice[value="start"]').click()`);
    assert.equal(await b.evaluate(`localStorage.getItem('zusage3.barJust')`), 'start');
    assert.equal(await b.evaluate(`getComputedStyle(document.querySelector('.zusage-root .zu-main')).justifyContent`), 'flex-start');
    await choose(b, 'pill');
    assert.equal(await b.evaluate(`getComputedStyle(document.querySelector('.zu-just-block')).display`), 'none', '药丸档隐藏设置块');
    await choose(b, 'default');
    assert.notEqual(await b.evaluate(`getComputedStyle(document.querySelector('.zu-just-block')).display`), 'none', '切回默认设置块重现');
    await b.evaluate(`document.querySelector('.zu-settings .zu-just-choice[value="end"]').click()`);
    /* 夹具默认载荷下条面可能超宽（无自由空间时 auto margin 按规范归 0，溢出态三种对齐视觉等价——
     * 这正是居右不用字面 flex-end 要保的溢出方向正确性）；flex-basis 强制 2000px 制造自由空间，
     * 摆脱字体度量差异做确定性断言（width 会被 flex:1 1 auto 收缩吃掉，必须动 flex） */
    await b.evaluate(`document.querySelector('.zusage-root .zu-main').style.flex = '0 0 2000px'`);
    const endMargin = await b.evaluate(firstMargin);
    await b.evaluate(`document.querySelector('.zusage-root .zu-main').style.flex = ''`);
    assert.notEqual(endMargin, betweenMargin, '居右=首格 margin-left:auto 右聚拢');
    await b.evaluate(`document.querySelector('.zu-settings .zu-just-choice[value="between"]').click()`);
    assert.equal(await b.evaluate(firstMargin), betweenMargin, '回均分后恢复原分布');
    assert.equal(await b.evaluate(`localStorage.getItem('zusage3.barJust')`), 'between');
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
      if (bars.length !== 2 || cards.some(c => !c)) throw new Error('fixture: bars=' + bars.length + ' cardsNull=' + cards.filter(c => !c).length + ' roots=' + bars.map(x => (x.textContent || '').slice(0, 30)).join('##'));
      return bars.map((bar, i) => {
        const r = bar.getBoundingClientRect(), c = cards[i] && cards[i].getBoundingClientRect();
        return { left: r.left, right: r.right, width: r.width, top: r.top, cardBottom: c ? c.bottom : 'no-card',
          center: (r.left + r.right) / 2, cardCenter: c ? (c.left + c.right) / 2 : 'no-card', cardTag: cards[i] ? cards[i].tagName : 'NONE', position: getComputedStyle(bar).position };
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
      return [...document.querySelectorAll('.zusage-root')].slice(0, 2).map((bar, i) => {
        const c = cards[i];
        const r = bar.getBoundingClientRect(), cr = c ? c.getBoundingClientRect() : null;
        return { width: r.width, center: (r.left + r.right) / 2, cardCenter: cr ? (cr.left + cr.right) / 2 : 'no-card', cardFound: !!c, rootTag: bar.tagName };
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
      const r = sub.getBoundingClientRect();
      /* v177：无头 Chrome 回退字体行盒偏高时单元格内容（图标/文字）顶置，盒子垂直中心
       * 可能落在内容下方的空白里（探针实测 ±11px 全条带命中 .zu-main 容器）。契约是
       * 「子代理控件可见且可点」，逐点格子扫描找内容命中点，点击也用该点。 */
      let hitPt = null;
      for (let py = r.top + 2; py <= r.bottom - 2 && !hitPt; py += 2) {
        for (let px = r.left + 2; px <= r.right - 2 && !hitPt; px += 3) {
          const h = document.elementFromPoint(px, py);
          if (h && (h === sub || sub.contains(h))) hitPt = { x: px, y: py };
        }
      }
      const gear = bar.querySelector('.zu-gear'), g = gear.getBoundingClientRect();
      const gearHit = document.elementFromPoint((g.left + g.right) / 2, (g.top + g.bottom) / 2);
      return { count: items.length, overflow, scrollLeft: main.scrollLeft,
        sub: hitPt ? { ...hitPt, hit: true } : { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2, hit: false },
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
    assert.equal(await b.evaluate(`document.querySelector('.zu-sub-pop').classList.contains('open')`), true, 'sub-agent control must remain clickable');
    // Real Tab navigation should scroll the off-screen button back into view.
    await b.evaluate(`(() => {
      const bar = document.querySelector('.zusage-root'), main = bar.querySelector('.zu-main');
      document.querySelector('.zu-sub-pop').classList.remove('open');
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
      /* v177：与上方同款环境敏感性——回退字体行盒偏高时中心点落在内容外，格子扫描判定可点性 */
      let hit = false;
      for (let py = r.top + 2; py <= r.bottom - 2 && !hit; py += 2) {
        for (let px = r.left + 2; px <= r.right - 2 && !hit; px += 3) {
          const h = document.elementFromPoint(px, py);
          if (h && (h === sub || sub.contains(h))) hit = true;
        }
      }
      return { focused: document.activeElement === sub, scrollLeft: main.scrollLeft,
        within: r.left >= mr.left - 1 && r.right <= mr.right + 1, hit };
    })()`);
    assert.equal(keyboard.focused, true, 'Tab should reach the sub-agent button');
    assert.ok(keyboard.scrollLeft > 0, 'keyboard focus should scroll to the off-screen entry');
    assert.equal(keyboard.within, true, 'focused control must be fully visible');
    assert.equal(keyboard.hit, true, 'focused control must not be covered by the gear');
  });

  await t.test('default fallback retains its 2px viewport-bottom gap', async () => {
    await reset(b);
    await b.evaluate(`(() => {
      document.querySelector('#pane-b').remove();
      const pane = document.querySelector('#pane-a');
      Object.assign(pane.style, { position: 'fixed', top: 'auto', bottom: '0px', height: '230px', display: 'flex', flexDirection: 'column', justifyContent: 'end' });
      document.querySelector('#card-a').querySelector('[data-testid="chat-context-usage-trigger"]').closest('[class="group/toolbar"]').remove();
    })()`);
    await b.waitFor(`getComputedStyle(document.querySelector('.zusage-root')).position === 'fixed'`, 'default bar did not fall back below the card');
    await b.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const gap = await b.evaluate(`innerHeight - document.querySelector('.zusage-root').getBoundingClientRect().bottom`);
    assert.ok(Math.abs(gap - 2) <= 1, `default fallback bottom gap: ${gap}px`);
  });

  await t.test('bottom-docked cards leave 8px above and below the pill', async () => {
    await reset(b, { stored: 'pill' });
    // Unlike an absolutely-positioned pane, a bottom flex dock moves up as the
    // card's margin grows, reproducing the host's available-space constraint
    // (host dock carries pb-4 = 16px below the card margin).
    await b.evaluate(`(() => {
      document.querySelector('#pane-b').remove();
      const pane = document.querySelector('#pane-a');
      pane.setAttribute('data-v4-composer-dock-content', 'true');
      Object.assign(pane.style, { position: 'fixed', top: 'auto', bottom: '0px', height: '230px', display: 'flex', flexDirection: 'column', justifyContent: 'end', paddingBottom: '16px' });
    })()`);
    await delay(700);
    await b.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const measure = async () => b.evaluate(`(() => {
      const card = document.querySelector('#card-a'), bar = document.querySelector('.zusage-root');
      const c = card.getBoundingClientRect(), r = bar.getBoundingClientRect();
      return { cardBottom: c.bottom, barTop: r.top, barBottom: r.bottom, barHeight: r.height,
        margin: parseFloat(getComputedStyle(card).marginBottom), viewportBottom: innerHeight,
        visibility: getComputedStyle(bar).visibility };
    })()`);
    const expectedMargin = m => Math.ceil(m.barHeight);
    const normal = await measure();
    assert.ok(normal.barHeight > 0, JSON.stringify(normal));
    const assertGaps = m => {
      assert.ok(Math.abs(m.barTop - m.cardBottom - 8) <= 1, JSON.stringify(m));
      assert.ok(Math.abs(m.viewportBottom - m.barBottom - 8) <= 1, JSON.stringify(m));
      assert.ok(Math.abs(m.margin - expectedMargin(m)) <= 1, JSON.stringify(m));
      // A hidden bar keeps its layout rect, so the gap assertions above pass
      // even when pillUnsafe wrongly hides the pill — lock actual visibility.
      assert.equal(m.visibility, 'visible', JSON.stringify(m));
    };
    assertGaps(normal);
    // Larger UI fonts change the bar height and the spacer follows it.
    await b.evaluate(`document.documentElement.style.setProperty('--ui-font-size', '24px')`);
    await b.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await delay(100);
    const larger = await measure();
    assert.ok(larger.barHeight > normal.barHeight, JSON.stringify({ normal, larger }));
    assertGaps(larger);
    await choose(b, 'default');
    await b.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    assert.equal(await b.evaluate(`document.querySelector('#card-a').style.marginBottom`), '', 'returning to in-card default restores the original margin');
    await choose(b, 'pill');
    await b.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const restored = await measure();
    assertGaps(restored);
    await b.evaluate('window.__zusageDispose()');
    assert.equal(await b.evaluate(`document.querySelector('#card-a').style.marginBottom`), '', 'disposing pill restores the original margin');
  });

  await t.test('bottom-docked gaps do not depend on the host padding or bottom inset', async () => {
    for (const [padding, inset] of [[0, 0], [12, 0], [16, 4]]) {
      await reset(b, { stored: 'pill' });
      await b.evaluate(`(() => {
        document.querySelector('#pane-b').remove();
        const pane = document.querySelector('#pane-a');
        pane.setAttribute('data-v4-composer-dock-content', 'true');
        Object.assign(pane.style, { position: 'fixed', top: 'auto', bottom: '${inset}px', height: '230px', display: 'flex', flexDirection: 'column', justifyContent: 'end', paddingBottom: '${padding}px' });
      })()`);
      await delay(700);
      const m = await b.evaluate(`(() => {
        const card = document.querySelector('#card-a').getBoundingClientRect();
        const bar = document.querySelector('.zusage-root').getBoundingClientRect();
        return { gapAbove: bar.top - card.bottom, gapBelow: innerHeight - bar.bottom };
      })()`);
      assert.ok(Math.abs(m.gapAbove - 8) <= 1, `padding=${padding}, inset=${inset}: ${JSON.stringify(m)}`);
      if (padding + inset <= 16) assert.ok(Math.abs(m.gapBelow - 8) <= 1, `padding=${padding}, inset=${inset}: ${JSON.stringify(m)}`);
      else assert.ok(m.gapBelow >= 7, `padding=${padding}, inset=${inset}: ${JSON.stringify(m)}`);
    }
  });

  await t.test('extra host padding does not overlap a bottom-docked pill', async () => {
    await reset(b, { stored: 'pill' });
    await b.evaluate(`(() => {
      document.querySelector('#pane-b').remove();
      const pane = document.querySelector('#pane-a');
      pane.setAttribute('data-v4-composer-dock-content', 'true');
      Object.assign(pane.style, { position: 'fixed', top: 'auto', bottom: '0px', height: '230px', display: 'flex', flexDirection: 'column', justifyContent: 'end', paddingBottom: '40px' });
    })()`);
    await delay(700);
    const m = await b.evaluate(`(() => {
      const card = document.querySelector('#card-a').getBoundingClientRect();
      const bar = document.querySelector('.zusage-root').getBoundingClientRect();
      return { gapAbove: bar.top - card.bottom, gapBelow: innerHeight - bar.bottom };
    })()`);
    assert.ok(Math.abs(m.gapAbove - 8) <= 1, JSON.stringify(m));
    assert.ok(m.gapBelow >= 7, JSON.stringify(m));
  });

  await t.test('dynamic host padding and viewport changes keep both 8px gaps', async () => {
    await reset(b, { stored: 'pill' });
    await b.evaluate(`(() => {
      document.querySelector('#pane-b').remove();
      const pane = document.querySelector('#pane-a');
      pane.setAttribute('data-v4-composer-dock-content', 'true');
      Object.assign(pane.style, { position: 'fixed', top: 'auto', bottom: '0px', height: '230px', display: 'flex', flexDirection: 'column', justifyContent: 'end', paddingBottom: '0px' });
    })()`);
    const gaps = async () => b.evaluate(`(() => {
      const card = document.querySelector('#card-a'), c = card.getBoundingClientRect();
      const r = document.querySelector('.zusage-root').getBoundingClientRect();
      const pane = document.querySelector('#pane-a').getBoundingClientRect();
      return { above: r.top - c.bottom, below: innerHeight - r.bottom, cardHeight: c.height,
        barHeight: r.height, dockHeight: pane.height, originalMargin: card.dataset.zuCardPad };
    })()`);
    for (const pad of [0, 16]) {
      await b.evaluate(`document.querySelector('#pane-a').style.paddingBottom = '${pad}px'`);
      await delay(700);
      const m = await gaps();
      assert.ok(m.originalMargin === '' || parseFloat(m.originalMargin) === 0, `host margin must start at zero: ${JSON.stringify({ pad, ...m })}`);
      assert.ok(m.dockHeight >= m.cardHeight + m.barHeight + Math.max(16, pad), `fixture must have room for both gaps: ${JSON.stringify({ pad, ...m })}`);
      assert.ok(Math.abs(m.above - 8) <= 1, `gap above after padding=${pad}: ${JSON.stringify(m)}`);
      assert.ok(Math.abs(m.below - 8) <= 1, `gap below after padding=${pad}: ${JSON.stringify(m)}`);
    }
    await b.call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
    await delay(700);
    const resized = await gaps();
    assert.ok(Math.abs(resized.above - 8) <= 1 && Math.abs(resized.below - 8) <= 1, JSON.stringify(resized));
  });

  await t.test('preserves host margin changes made while pill mode is active', async () => {
    await reset(b, { stored: 'pill' });
    await b.evaluate(`document.querySelector('#card-a').style.marginBottom = '11px'`);
    await delay(700);
    await choose(b, 'default');
    const margin = await b.evaluate(`document.querySelector('#card-a').style.marginBottom`);
    assert.equal(margin, '11px', 'switching themes must restore the host-updated inline margin');
  });

  await t.test('an attachment error remains visible above the pill', async () => {
    await reset(b, { stored: 'pill' });
    await b.evaluate(`(() => {
      document.querySelector('#pane-b').remove();
      const pane = document.querySelector('#pane-a'), card = document.querySelector('#card-a');
      pane.setAttribute('data-v4-composer-dock-content', 'true');
      Object.assign(pane.style, { position: 'fixed', top: 'auto', bottom: '0px', height: '230px', display: 'flex', flexDirection: 'column', justifyContent: 'end', paddingBottom: '16px' });
      const shell = document.createElement('div'), form = document.createElement('form');
      shell.className = 'chat-composer-input-surface';
      card.parentElement.insertBefore(shell, card);
      shell.appendChild(form);
      form.appendChild(card);
      const error = document.createElement('p');
      error.textContent = 'Unable to attach a file';
      error.style.cssText = 'margin:0;padding:12px;line-height:20px';
      shell.appendChild(error);
      window.__attachmentError = error;
    })()`);
    await delay(1400);
    const measure = async () => b.evaluate(`(() => {
      const error = window.__attachmentError.getBoundingClientRect();
      const bar = document.querySelector('.zusage-root').getBoundingClientRect();
      return { errorBottom: error.bottom, barTop: bar.top, barBottom: bar.bottom, viewportBottom: innerHeight };
    })()`);
    const oneLine = await measure();
    assert.ok(oneLine.barTop >= oneLine.errorBottom + 7, JSON.stringify(oneLine));
    assert.ok(Math.abs(oneLine.viewportBottom - oneLine.barBottom - 8) <= 1, JSON.stringify(oneLine));
    await b.evaluate(`window.__attachmentError.textContent = 'Unable to attach a file '.repeat(30)`);
    await delay(800);
    const wrapped = await measure();
    assert.ok(wrapped.barTop >= wrapped.errorBottom + 7, JSON.stringify(wrapped));
    assert.ok(Math.abs(wrapped.viewportBottom - wrapped.barBottom - 8) <= 1, JSON.stringify(wrapped));
    await b.evaluate(`window.__attachmentError.remove()`);
    await delay(800);
    const closed = await measure();
    assert.ok(Math.abs(closed.viewportBottom - closed.barBottom - 8) <= 1, JSON.stringify(closed));
    const cardGap = await b.evaluate(`(() => {
      const card = document.querySelector('#card-a').getBoundingClientRect();
      const bar = document.querySelector('.zusage-root').getBoundingClientRect();
      return bar.top - card.bottom;
    })()`);
    assert.ok(Math.abs(cardGap - 8) <= 1, `card gap after error removal: ${cardGap}px`);
  });

  await t.test('replacing an attachment error with a new node retains its position above the pill', async () => {
    await reset(b, { stored: 'pill' });
    await b.evaluate(`(() => {
      document.querySelector('#pane-b').remove();
      const pane = document.querySelector('#pane-a'), card = document.querySelector('#card-a');
      pane.setAttribute('data-v4-composer-dock-content', 'true');
      Object.assign(pane.style, { position: 'fixed', top: 'auto', bottom: '0px', height: '230px', display: 'flex', flexDirection: 'column', justifyContent: 'end', paddingBottom: '16px' });
      const shell = document.createElement('div'), form = document.createElement('form');
      shell.className = 'chat-composer-input-surface';
      card.parentElement.insertBefore(shell, card); shell.appendChild(form); form.appendChild(card);
      window.__errorShell = shell;
    })()`);
    await delay(800);
    const initial = await b.evaluate(`(() => {
      const card = document.querySelector('#card-a').getBoundingClientRect();
      const bar = document.querySelector('.zusage-root').getBoundingClientRect();
      return bar.top - card.bottom;
    })()`);
    assert.ok(Math.abs(initial - 8) <= 1, `initial gap: ${initial}px`);
    await b.evaluate(`(() => {
      const error = document.createElement('p'); error.textContent = 'A new attachment error';
      error.style.cssText = 'margin:0;padding:12px;line-height:20px'; window.__errorShell.appendChild(error);
      window.__newAttachmentError = error;
    })()`);
    await delay(800);
    const m = await b.evaluate(`(() => {
      const error = window.__newAttachmentError.getBoundingClientRect();
      const bar = document.querySelector('.zusage-root').getBoundingClientRect();
      return { above: bar.top - error.bottom, below: innerHeight - bar.bottom };
    })()`);
    assert.ok(m.above >= 7 && m.below >= 7, JSON.stringify(m));
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
    assert.ok(Math.abs(parseFloat(ordinary.cardMargin) - Math.ceil(ordinary.barHeight)) <= 1, 'pill spacer reserves the 8px gaps around the pill');
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
    assert.ok(Math.abs(parseFloat(active.outerMargin) - Math.ceil(active.barHeight)) <= 1, 'highspeed surface reserves the 8px gaps');

    await b.evaluate(`document.querySelector('#switch-surface').classList.remove('highspeed-composer-surface');
      document.querySelector('#switch-surface').removeAttribute('data-highspeed-composer');`);
    await delay(750);
    await b.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const restored = await inspect();
    assert.equal(restored.same, true, 'deactivating highspeed must not replace the composer');
    assert.deepEqual(restored.bar, restored.card, 'pill must return to the ordinary card');
    assert.ok(Math.abs(restored.barCenter - restored.cardCenter) <= 2, JSON.stringify(restored));
    assert.ok(restored.barTop >= restored.cardBottom - 1, JSON.stringify(restored));
    assert.ok(Math.abs(parseFloat(restored.cardMargin) - Math.ceil(restored.barHeight)) <= 1, 'ordinary card keeps the 8px-gap spacer');
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
          Math.abs(parseFloat(card.style.marginBottom) - Math.ceil(r.height)) <= 1 && outer.style.marginBottom === '';
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
          Math.abs(parseFloat(outer.style.marginBottom) - Math.ceil(r.height)) <= 1 && card.style.marginBottom === '';
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
          Math.abs(parseFloat(card.style.marginBottom) - Math.ceil(r.height)) <= 1 && outer.style.marginBottom === '';
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
    assert.match(String(tips.turn), /缓存\s*0%/, 'positive turn input and zero cached tokens must show 0% (v299.1 turn label)');
    assert.match(String(tips.session), /输入/);
    assert.match(String(tips.session), /缓存\s*0%/, 'positive session input and zero cached tokens must show 0% (v300 session label)');
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
    assert.match(initial.tip, /平均耗时\s*3\.5s/);
    assert.match(initial.tip, /本轮[\s\S]*?3\s*次请求/);
    const inspect = async () => b.evaluate(`(() => {
      const main = document.querySelector('.zusage-root .zu-main'), item = window.__unchangedItem;
      const id = item.getAttribute('aria-describedby'), tip = id && document.getElementById(id);
      return { sameMain: main === window.__unchangedMain, sameItem: item.isConnected && main.contains(item),
        focused: document.activeElement === item, id, visible: !!tip && getComputedStyle(tip).display !== 'none',
        tip: tip && tip.textContent, html: main.innerHTML };
    })()`);
    const duration = JSON.parse(JSON.stringify(payload));
    duration.recent[0].last_turn.avg_duration_ms = 8100;
    await b.evaluate(`window.__zusageUpdate(${JSON.stringify(duration)})`);
    const afterDuration = await inspect();
    assert.ok(afterDuration.sameMain && afterDuration.sameItem && afterDuration.focused, JSON.stringify(afterDuration));
    assert.equal(afterDuration.html, initial.html, 'hidden duration must not rebuild or change the pill surface');
    assert.equal(afterDuration.id, initial.id, 'tooltip relationship must stay on the focused element');
    assert.equal(afterDuration.visible, true);
    assert.match(afterDuration.tip, /平均耗时\s*8\.1s/);
    assert.doesNotMatch(afterDuration.tip, /平均耗时\s*3\.5s/);
    const requests = JSON.parse(JSON.stringify(duration));
    requests.recent[0].last_turn.requests = 7;
    await b.evaluate(`window.__zusageUpdate(${JSON.stringify(requests)})`);
    const afterRequests = await inspect();
    assert.ok(afterRequests.sameMain && afterRequests.sameItem && afterRequests.focused, JSON.stringify(afterRequests));
    assert.equal(afterRequests.html, initial.html, 'hidden request count must not rebuild or change the pill surface');
    assert.equal(afterRequests.id, initial.id);
    assert.equal(afterRequests.visible, true);
    assert.match(afterRequests.tip, /本轮[\s\S]*?7\s*次请求/);
    assert.match(afterRequests.tip, /平均耗时\s*8\.1s/);
    assert.doesNotMatch(afterRequests.tip, /本轮[\s\S]*?3\s*次请求/);
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
    assert.match(after.tip, /缓存\s*25%/, 'replacement tooltip must reflect updated cache ratio (v299.1 turn label)');
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
    assert.match(normal.tip, /平均延迟/);
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

// Regression cases for split-pane stability, tooltips and highspeed transitions.
test('pill review browser regressions (isolated fixture)', { skip: skipReason, timeout: 120000 }, async t => {
  const b = await startBrowser(t);

  await t.test('vertical split keeps both pill instances when the upper composer moves across 45%', async () => {
    // Lay out the upper dock before boot; the pill spacer must move the actual input.
    await b.call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
    const token = Math.random().toString(36).slice(2);
    await b.call('Page.navigate', { url: b.url + '?case=' + token });
    await b.waitFor(`document.readyState === "complete" && location.search === '?case=${token}'`);
    const before = await b.evaluate(`(() => {
      document.body.innerHTML = ${JSON.stringify(fixtureHtml)};
      localStorage.clear();
      localStorage.setItem('zusage3.theme', 'pill');
      const upper = document.querySelector('#pane-a'), lower = document.querySelector('#pane-b');
      Object.assign(upper.style, { position: 'fixed', top: '0px', bottom: 'auto', left: '50px',
        height: '530px', display: 'flex', flexDirection: 'column', justifyContent: 'end' });
      Object.assign(lower.style, { position: 'fixed', top: '600px', bottom: 'auto', left: '50px' });
      const input = upper.querySelector('textarea');
      input.setAttribute('data-testid', 'v4-composer-input');
      upper.style.height = (upper.getBoundingClientRect().height + 420 - input.getBoundingClientRect().top) + 'px';
      window.__splitInput = input;
      window.__splitEvents = [];
      window.__splitObserver = new MutationObserver(records => {
        for (const record of records) for (const [kind, nodes] of [['added', record.addedNodes], ['removed', record.removedNodes]]) {
          for (const node of nodes) if (node.nodeType === 1 && node.classList.contains('zusage-root')) {
            window.__splitEvents.push({ kind, id: node.id, at: Math.round(performance.now()) });
          }
        }
      });
      window.__splitObserver.observe(document.body, { childList: true, subtree: true });
      return { top: input.getBoundingClientRect().top, threshold: innerHeight * 0.45,
        upperBottom: upper.getBoundingClientRect().bottom, lowerTop: lower.getBoundingClientRect().top };
    })()`);
    assert.ok(Math.abs(before.top - 420) <= 1 && before.top > before.threshold, JSON.stringify(before));
    assert.ok(before.upperBottom < before.lowerTop, JSON.stringify(before));
    await b.evaluate(overlay);
    await b.waitFor(`document.querySelectorAll('.zusage-root').length === 2 &&
      document.querySelector('#pane-a textarea').getBoundingClientRect().top < innerHeight * 0.45`,
      'pill did not move the upper composer across the threshold');
    const mounted = await b.evaluate(`(() => {
      const bars = [...document.querySelectorAll('.zusage-root')];
      window.__firstSplitBars = bars;
      return { top: window.__splitInput.getBoundingClientRect().top,
        barTops: bars.map(bar => bar.getBoundingClientRect().top) };
    })()`);
    assert.ok(mounted.top < before.threshold && mounted.top > 350, JSON.stringify(mounted));
    assert.ok(mounted.barTops[0] < mounted.barTops[1], JSON.stringify(mounted));
    const observed = await b.evaluate(`(async () => {
      const samples = [], end = performance.now() + 2100;
      while (performance.now() < end) {
        await new Promise(resolve => setTimeout(resolve, 100));
        samples.push({ top: window.__splitInput.getBoundingClientRect().top,
          bars: document.querySelectorAll('.zusage-root').length,
          connected: window.__firstSplitBars.map(bar => bar.isConnected),
          visible: [...document.querySelectorAll('.zusage-root')].filter(bar => getComputedStyle(bar).display !== 'none').length });
      }
      window.__splitObserver.disconnect();
      return { samples, events: window.__splitEvents, sameInput: window.__splitInput.isConnected };
    })()`);
    assert.equal(observed.sameInput, true, JSON.stringify(observed));
    assert.deepEqual(observed.events.map(event => event.kind), ['added', 'added'], JSON.stringify(observed));
    assert.ok(observed.samples.every(sample => sample.bars === 2 && sample.visible === 2 && sample.connected.every(Boolean)), JSON.stringify(observed));
  });

  for (const change of [
    { name: 'duration', path: 'last_turn', key: 'avg_duration_ms', value: 8100, old: /平均耗时\s*3\.5s/, updated: /平均耗时\s*8\.1s/ },
    { name: 'request count', path: 'last_turn', key: 'requests', value: 7, old: /本轮[\s\S]*?3\s*次请求/, updated: /本轮[\s\S]*?7\s*次请求/ },
  ]) {
    await t.test(`hovered turn tooltip refreshes hidden ${change.name} without pointer movement`, async () => {
      await reset(b, { stored: 'pill' });
      await b.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
      await delay(200); // The renderer throttles real pointer moves to 150ms.
      const point = await b.evaluate(`(() => {
        const main = document.querySelector('.zusage-root .zu-main');
        const item = [...main.querySelectorAll('.it')].find(el => el.textContent.includes('12.5万'));
        if (!item) throw new Error('turn item missing');
        const r = item.getBoundingClientRect(), x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2;
        const hit = document.elementFromPoint(x, y);
        window.__hoverMain = main;
        window.__hoverItem = item;
        return { x, y, hit: !!hit && (hit === item || item.contains(hit)) };
      })()`);
      assert.equal(point.hit, true, JSON.stringify(point));
      await b.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
      await b.waitFor(`window.__hoverItem.getAttribute('aria-describedby')`, 'real hover did not open turn tooltip');
      const inspect = async () => b.evaluate(`(() => {
        const main = document.querySelector('.zusage-root .zu-main'), item = window.__hoverItem;
        const id = item.getAttribute('aria-describedby'), tip = id && document.getElementById(id);
        return { sameMain: main === window.__hoverMain, sameItem: item.isConnected && main.contains(item),
          hovered: item.matches(':hover'), focused: document.activeElement === item, html: main.innerHTML,
          id, visible: !!tip && getComputedStyle(tip).display !== 'none', tip: tip && tip.textContent };
      })()`);
      const initial = await inspect();
      assert.ok(initial.hovered && !initial.focused && initial.visible, JSON.stringify(initial));
      assert.match(initial.tip, change.old);
      const updated = JSON.parse(JSON.stringify(payload));
      updated.recent[0][change.path][change.key] = change.value;
      await b.evaluate(`window.__zusageUpdate(${JSON.stringify(updated)})`);
      await b.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const after = await inspect();
      assert.ok(after.sameMain && after.sameItem && after.hovered && !after.focused && after.visible, JSON.stringify(after));
      assert.equal(after.html, initial.html, 'hidden values must not rebuild or change the visible pill item');
      assert.equal(after.id, initial.id);
      assert.match(after.tip, change.updated, JSON.stringify(after));
      assert.doesNotMatch(after.tip, change.old);
    });
  }

  await t.test('Escape keeps a focused turn tooltip closed across a data rebuild', async () => {
    await reset(b, { stored: 'pill' });
    await b.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
    const setup = await b.evaluate(`(() => {
      const main = document.querySelector('.zusage-root .zu-main');
      const items = [...main.querySelectorAll('.it')];
      const index = items.findIndex(item => item.textContent.includes('12.5万'));
      if (index < 1) throw new Error('turn item or previous keyboard stop missing');
      items[index - 1].focus();
      window.__escapeOldItem = items[index];
      window.__escapeTip = document.querySelector('.zusage-tip-root');
      return { previousFocused: document.activeElement === items[index - 1], index };
    })()`);
    assert.equal(setup.previousFocused, true, JSON.stringify(setup));
    await b.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    await b.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    const focused = await b.evaluate(`({ focused: document.activeElement === window.__escapeOldItem,
      described: window.__escapeOldItem.getAttribute('aria-describedby'),
      visible: getComputedStyle(window.__escapeTip).display !== 'none' })`);
    assert.ok(focused.focused && focused.described && focused.visible, JSON.stringify(focused));
    await b.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await b.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    const closed = await b.evaluate(`({ focused: document.activeElement === window.__escapeOldItem,
      described: window.__escapeOldItem.getAttribute('aria-describedby'),
      visible: getComputedStyle(window.__escapeTip).display !== 'none' })`);
    assert.ok(closed.focused && !closed.described && !closed.visible, JSON.stringify(closed));
    const updated = JSON.parse(JSON.stringify(payload));
    updated.recent[0].last_turn.total = 230000;
    updated.recent[0].last_turn.input = 200000;
    await b.evaluate(`window.__zusageUpdate(${JSON.stringify(updated)})`);
    await delay(750);
    const after = await b.evaluate(`(() => {
      const item = [...document.querySelector('.zusage-root .zu-main').querySelectorAll('.it')]
        .find(el => el.textContent.includes('23万'));
      return { replaced: !!item && item !== window.__escapeOldItem && !window.__escapeOldItem.isConnected,
        focused: document.activeElement === item, described: item && item.getAttribute('aria-describedby'),
        visible: getComputedStyle(window.__escapeTip).display !== 'none', tip: window.__escapeTip.textContent };
    })()`);
    assert.ok(after.replaced && after.focused, JSON.stringify(after));
    assert.ok(!after.visible && !after.described, `Escape must survive a rebuild: ${JSON.stringify(after)}`);
    // Returning via real keyboard navigation is a new request to open the tooltip.
    await b.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    await b.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    await b.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', modifiers: 8, windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    await b.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', modifiers: 8, windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    const reopened = await b.evaluate(`({ focused: document.activeElement.textContent.includes('23万'),
      described: document.activeElement.getAttribute('aria-describedby'),
      visible: getComputedStyle(window.__escapeTip).display !== 'none' })`);
    assert.ok(reopened.focused && reopened.described && reopened.visible, JSON.stringify(reopened));
  });

  await t.test('hover remains associated across repeated bar rebuilds and preserves text selection', async () => {
    await reset(b, { stored: 'pill' });
    await b.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
    await delay(200);
    const point = await b.evaluate(`(() => {
      const item = [...document.querySelector('.zusage-root .zu-main').querySelectorAll('.it')].find(el => el.textContent.includes('12.5万'));
      const r = item.getBoundingClientRect(); return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
    })()`);
    await b.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await b.waitFor(`document.querySelector('.zusage-tip-root').style.display === 'block'`, 'hover tooltip did not open');
    for (const total of [230000, 330000]) {
      const next = JSON.parse(JSON.stringify(payload));
      next.recent[0].last_turn.total = total;
      next.recent[0].last_turn.input = total - 30000;
      await b.evaluate(`window.__zusageUpdate(${JSON.stringify(next)})`);
      const text = await b.evaluate(`document.querySelector('.zusage-tip-root').textContent`);
      assert.match(text, total === 230000 ? /20万/ : /30万/);
    }
    const selected = await b.evaluate(`(() => {
      const tip = document.querySelector('.zusage-tip-root');
      const el = tip.querySelector('.rt-models .rt-row span') || tip.querySelector('.zu-stat-v') || tip.querySelector('.zu-stat-time span');
      const range = document.createRange(); range.selectNodeContents(el);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      return selection.toString();
    })()`);
    assert.ok(selected);
    const changed = JSON.parse(JSON.stringify(payload));
    changed.recent[0].last_turn.total = 330000;
    changed.recent[0].last_turn.input = 400000;
    await b.evaluate(`window.__zusageUpdate(${JSON.stringify(changed)})`);
    assert.equal(await b.evaluate(`getSelection().toString()`), selected);
    await b.evaluate(`getSelection().removeAllRanges()`);
    await b.evaluate(`window.__zusageUpdate(${JSON.stringify(changed)})`);
    assert.match(await b.evaluate(`document.querySelector('.zusage-tip-root').textContent`), /40万/);
  });

  await t.test('focused and hovered items keep independent tooltips during a rebuild', async () => {
    await reset(b, { stored: 'pill' });
    const point = await b.evaluate(`(() => {
      const items = document.querySelectorAll('.zusage-root .zu-main .it');
      const focused = items[1], hovered = items[2];
      focused.focus(); focused.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      window.__focusIndex = 1; window.__hoverIndex = 2;
      const r = hovered.getBoundingClientRect(); return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
    })()`);
    await b.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
    await delay(200);
    await b.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await b.waitFor(`document.querySelectorAll('.zusage-root .zu-main .it')[2].hasAttribute('aria-describedby')`);
    const changed = JSON.parse(JSON.stringify(payload));
    changed.recent[0].last_turn.total = 230000;
    await b.evaluate(`window.__zusageUpdate(${JSON.stringify(changed)})`);
    const state = await b.evaluate(`(() => {
      const items = document.querySelectorAll('.zusage-root .zu-main .it');
      return { focused: document.activeElement === items[1], described: items[2].getAttribute('aria-describedby'), text: document.querySelector('.zusage-tip-root').textContent };
    })()`);
    assert.ok(state.focused && state.described, JSON.stringify(state));
    assert.match(state.text, /会话累计/);
  });

  await t.test('default bar returns to the input card after an initially active highspeed exits', async () => {
    await b.call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
    const token = Math.random().toString(36).slice(2);
    await b.call('Page.navigate', { url: b.url + '?case=' + token });
    await b.waitFor(`document.readyState === "complete" && location.search === '?case=${token}'`);
    await b.evaluate(`(() => {
      document.body.innerHTML = ${JSON.stringify(fixtureHtml)};
      localStorage.clear();
      localStorage.setItem('zusage3.theme', 'pill');
      // In the active host surface the inner card is visually transparent and borderless.
      const style = document.createElement('style');
      style.textContent = '.highspeed-composer-surface #card-b{border:0;background:transparent}';
      document.head.appendChild(style);
      window.__highspeedInput = document.querySelector('#card-b textarea');
      window.__highspeedInput.setAttribute('data-testid', 'v4-composer-input');
      window.__highspeedCard = document.querySelector('#card-b');
      window.__highspeedCard.setAttribute('data-composer-layout', 'stacked');
      window.__highspeedOuter = document.querySelector('#highspeed');
      window.__highspeedOuter.classList.add('chat-composer-input-surface');
    })()`);
    await b.evaluate(overlay);
    await b.waitFor(`document.querySelectorAll('.zusage-root').length === 2 &&
      [...document.querySelectorAll('.zusage-root')].every(bar => getComputedStyle(bar).display !== 'none')`);
    await b.evaluate(`window.__zusageUpdate(${JSON.stringify(payload)})`);
    await b.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const initial = await b.evaluate(`(() => {
      const bar = document.querySelectorAll('.zusage-root')[1], card = window.__highspeedCard, outer = window.__highspeedOuter;
      window.__highspeedBar = bar;
      return { theme: bar.dataset.zusageTheme, cardBg: getComputedStyle(card).backgroundColor,
        cardBorder: getComputedStyle(card).borderTopWidth, barBg: getComputedStyle(bar).backgroundColor,
        outerBg: getComputedStyle(outer).backgroundColor, outerMargin: outer.style.marginBottom };
    })()`);
    assert.equal(initial.theme, 'pill');
    assert.equal(initial.cardBg, 'rgba(0, 0, 0, 0)', JSON.stringify(initial));
    assert.equal(initial.cardBorder, '0px', JSON.stringify(initial));
    assert.equal(initial.barBg, initial.outerBg, JSON.stringify(initial));
    const click = async expression => {
      const point = await b.evaluate(`(() => {
        const el = ${expression};
        if (!el) throw new Error('click target missing: ' + ${JSON.stringify(expression)});
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const r = el.getBoundingClientRect(), x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2;
        const hit = document.elementFromPoint(x, y);
        return { x, y, hit: !!hit && (hit === el || el.contains(hit)) };
      })()`);
      assert.equal(point.hit, true, JSON.stringify(point));
      await b.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
      await b.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      await b.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    };
    await click(`window.__highspeedBar.querySelector('.zu-gear')`);
    await b.waitFor(`document.querySelectorAll('.zu-settings')[1].classList.contains('open')`, 'highspeed settings did not open');
    await click(`document.querySelectorAll('.zu-settings')[1].querySelector('.zu-navitem[data-sec="display"]')`);
    await click(`document.querySelectorAll('.zu-settings')[1].querySelector('.zu-theme-choice[value="default"]')`);
    await b.waitFor(`window.__highspeedBar.dataset.zusageTheme === 'default'`, 'real theme selection did not switch to default');
    await b.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await b.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await b.evaluate(`window.__highspeedOuter.classList.remove('highspeed-composer-surface');
      window.__highspeedOuter.removeAttribute('data-highspeed-composer');`);
    await delay(1400); // More than two coordinator ticks; all host nodes stay in place.
    const after = await b.evaluate(`(() => {
      const card = window.__highspeedCard, outer = window.__highspeedOuter, bar = window.__highspeedBar;
      return { sameInput: card.querySelector('textarea') === window.__highspeedInput && window.__highspeedInput.isConnected,
        sameCard: card.isConnected && outer.contains(card), sameBar: bar.isConnected,
        theme: bar.dataset.zusageTheme, insideCard: bar.parentElement === card,
        inCardClass: bar.classList.contains('zu-in'), position: getComputedStyle(bar).position,
        cardBg: getComputedStyle(card).backgroundColor, outerMargin: outer.style.marginBottom,
        cardMargin: card.style.marginBottom };
    })()`);
    assert.ok(after.sameInput && after.sameCard && after.sameBar, JSON.stringify(after));
    assert.equal(after.theme, 'default');
    assert.notEqual(after.cardBg, 'rgba(0, 0, 0, 0)', JSON.stringify(after));
    assert.ok(after.insideCard && after.inCardClass, `default bar must mount inside the restored card: ${JSON.stringify(after)}`);
    assert.equal(after.outerMargin, '', JSON.stringify(after));
    assert.equal(after.cardMargin, '', JSON.stringify(after));
  });

  await t.test('host alertdialog and backdrop hide the bar even while plugin settings are open', async () => {
    const modalBrowser = await startBrowser(t);
    await reset(modalBrowser, { stored: 'pill' });
    const gear = await modalBrowser.evaluate(`(() => {
      const el = document.querySelector('.zusage-root .zu-gear'), r = el.getBoundingClientRect();
      const x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2, hit = document.elementFromPoint(x, y);
      return { x, y, hit: !!hit && (hit === el || el.contains(hit)) };
    })()`);
    assert.equal(gear.hit, true, JSON.stringify(gear));
    await modalBrowser.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: gear.x, y: gear.y });
    await modalBrowser.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: gear.x, y: gear.y, button: 'left', clickCount: 1 });
    await modalBrowser.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: gear.x, y: gear.y, button: 'left', clickCount: 1 });
    await modalBrowser.waitFor(`document.querySelector('.zu-settings').classList.contains('open')`, 'real click did not open plugin settings');
    const fixture = await modalBrowser.evaluate(`(() => {
      window.__modalBars = [...document.querySelectorAll('.zusage-root')];
      const backdrop = document.createElement('div');
      backdrop.id = 'host-modal-backdrop';
      backdrop.style.cssText = 'position:fixed;inset:0;z-index:100;background:rgba(0,0,0,.45)';
      document.body.appendChild(backdrop);
      const dialog = document.createElement('div');
      dialog.id = 'host-alertdialog';
      dialog.setAttribute('role', 'alertdialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-label', 'Host confirmation');
      dialog.style.cssText = 'position:fixed;left:500px;top:80px;width:200px;height:120px;z-index:101;background:white';
      document.body.appendChild(dialog);
      const r = backdrop.getBoundingClientRect(), dr = dialog.getBoundingClientRect();
      return { settingsOpen: document.querySelector('.zu-settings').classList.contains('open'),
        settingsRole: document.querySelector('.zu-settings').getAttribute('role'),
        dialogRole: dialog.getAttribute('role'), dialogVisible: dr.width > 0 && dr.height > 0,
        backdropWidth: r.width, backdropHeight: r.height, viewportWidth: innerWidth, viewportHeight: innerHeight,
        backdropOpacity: getComputedStyle(backdrop).backgroundColor };
    })()`);
    assert.ok(fixture.settingsOpen && fixture.settingsRole === 'dialog' && fixture.dialogRole === 'alertdialog' && fixture.dialogVisible, JSON.stringify(fixture));
    assert.equal(fixture.backdropWidth, fixture.viewportWidth);
    assert.equal(fixture.backdropHeight, fixture.viewportHeight);
    await modalBrowser.waitFor(`window.__modalBars.every(bar => getComputedStyle(bar).display === 'none')`, 'host alertdialog did not hide all bars');
    const hidden = await modalBrowser.evaluate(`({ visible: window.__modalBars.map(bar => getComputedStyle(bar).display !== 'none'),
      settingsOpen: document.querySelector('.zu-settings').classList.contains('open'),
      hostOpen: !!document.querySelector('#host-alertdialog'), backdrop: !!document.querySelector('#host-modal-backdrop') })`);
    assert.ok(hidden.hostOpen && hidden.backdrop, JSON.stringify(hidden));
    assert.deepEqual(hidden.visible, [false, false], `host alertdialog must hide both bars: ${JSON.stringify(hidden)}`);
    assert.equal(hidden.settingsOpen, false, 'hidden bar must close its plugin settings panel');
    await modalBrowser.evaluate(`document.querySelector('#host-alertdialog').remove(); document.querySelector('#host-modal-backdrop').remove();`);
    await modalBrowser.waitFor(`window.__modalBars.every(bar => bar.isConnected && getComputedStyle(bar).display !== 'none')`, 'bars did not return after host alertdialog closed');
  });
});

// Exercise the full renderer in Chromium. Hiding the pill is a safe fallback
// when an immovable card leaves no space for it below the composer.
test('pill layout safety browser regressions (isolated fixture)', { skip: skipReason, timeout: 45000 }, async t => {
  const b = await startBrowser(t);

  await t.test('absolute bottom card does not accumulate margin or cover controls', async () => {
    await reset(b, { stored: 'default' });
    const before = await b.evaluate(`(() => {
      document.querySelector('#pane-b').remove();
      const pane = document.querySelector('#pane-a'), card = document.querySelector('#card-a');
      pane.setAttribute('data-v4-composer-dock-content', 'true');
      Object.assign(pane.style, { position: 'fixed', top: 'auto', bottom: '0px', height: '230px' });
      Object.assign(card.style, { position: 'absolute', top: '124px', left: '0px', right: '0px' });
      const toolbar = card.querySelector('[class="group/toolbar"]');
      toolbar.style.justifyContent = 'center';
      window.__fixedClicks = { tool: 0, send: 0 };
      for (const name of ['tool', 'send']) {
        const button = document.createElement('button');
        button.id = 'fixed-' + name; button.textContent = name;
        button.style.cssText = 'width:120px;height:26px';
        button.addEventListener('click', () => window.__fixedClicks[name]++);
        toolbar.appendChild(button);
      }
      window.__fixedCardTop = card.getBoundingClientRect().top;
      return { cardTop: window.__fixedCardTop, margin: parseFloat(getComputedStyle(card).marginBottom),
        position: getComputedStyle(card).position, paneBottom: pane.getBoundingClientRect().bottom };
    })()`);
    assert.equal(before.position, 'absolute', JSON.stringify(before));
    assert.equal(before.margin, 0, JSON.stringify(before));
    assert.equal(before.paneBottom, 900, JSON.stringify(before));
    await choose(b, 'pill');
    await delay(60);
    const observed = await b.evaluate(`(async () => {
      const card = document.querySelector('#card-a');
      const controls = [card.querySelector('textarea'), card.querySelector('[data-testid="chat-context-usage-trigger"]'),
        document.querySelector('#fixed-tool'), document.querySelector('#fixed-send')];
      const rect = el => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
      const overlap = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 &&
        Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
      const samples = [], start = performance.now();
      while (performance.now() - start < 1300) {
        const bar = document.querySelector('#zusage-bar');
        const style = bar && getComputedStyle(bar), r = bar && rect(bar), c = rect(card);
        const visible = !!bar && bar.isConnected && style.display !== 'none' && style.visibility !== 'hidden' &&
          Number(style.opacity) > 0 && r.right > r.left && r.bottom > r.top;
        samples.push({ at: Math.round(performance.now() - start), margin: parseFloat(getComputedStyle(card).marginBottom),
          card: c, bar: r, visible, visibility: style.visibility, display: style.display,
          gapAbove: visible ? r.top - c.bottom : null,
          gapBelow: visible ? innerHeight - r.bottom : null,
          covered: controls.filter(el => visible && overlap(r, rect(el))).map(el => el.id || el.tagName),
          barHits: controls.map(el => { const r = rect(el), hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
            return visible && !!hit && (hit === bar || bar.contains(hit)); }) });
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return { samples, elapsed: performance.now() - start, fixedTop: window.__fixedCardTop,
        points: ['tool', 'send'].map(name => { const r = rect(document.querySelector('#fixed-' + name));
          return { name, x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 }; }) };
    })()`);
    for (const point of observed.points) {
      await b.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
      await b.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      await b.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    }
    const clicks = await b.evaluate('window.__fixedClicks');
    const samples = observed.samples, middle = samples[Math.floor(samples.length / 2)], last = samples[samples.length - 1];
    const problems = [], recent = samples.slice(-4).map(s => s.margin);
    if (observed.elapsed < 1000 || samples.length < 10) problems.push('observation shorter than 1s');
    if (samples.some(s => Math.abs(s.card.top - observed.fixedTop) > 1)) problems.push('absolute card moved despite fixed top');
    if (last.margin > middle.margin + 1 || Math.max(...recent) - Math.min(...recent) > 1) problems.push('margin-bottom continues to grow');
    if (samples.some(s => s.covered.length || s.barHits.some(Boolean))) problems.push('pill covers an input or toolbar control');
    if (samples.some(s => s.visible && (s.bar.top < 0 || s.bar.bottom > 900))) problems.push('visible pill leaves the viewport');
    if (clicks.tool !== 1 || clicks.send !== 1) problems.push('real pointer click did not reach both controls');
    assert.deepEqual(problems, [], JSON.stringify({ before, problems, clicks, ...observed }));
    // Unsafe layouts must degrade to the designed "safe hide" (visibility,
    // element stays mounted and can come back), not display:none disappearance.
    const lastBar = await b.evaluate(`(() => { const bar = document.querySelector('#zusage-bar');
      return { connected: !!bar && bar.isConnected, display: bar && getComputedStyle(bar).display,
        visibility: bar && getComputedStyle(bar).visibility }; })()`);
    assert.ok(lastBar.connected && lastBar.display !== 'none', JSON.stringify(lastBar));
    assert.equal(lastBar.visibility, 'hidden', JSON.stringify(lastBar));
    // Switching back to the default theme must fully restore the bar even after
    // pillUnsafe hid it (visibility is a pill-only state; regression used to
    // leave the bar permanently invisible).
    await choose(b, 'default');
    await b.waitFor(`(() => { const bar = document.querySelector('#zusage-bar'); const s = bar && getComputedStyle(bar);
      return bar && bar.isConnected && s.display !== 'none' && s.visibility === 'visible'; })()`,
      'bar did not become visible again after leaving pill theme');
  });

  await t.test('stacked pane shells contain each pill and leave the lower controls clickable', async () => {
    await b.call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
    const token = Math.random().toString(36).slice(2);
    await b.call('Page.navigate', { url: b.url + '?case=' + token });
    await b.waitFor(`document.readyState === "complete" && location.search === '?case=${token}'`);
    const before = await b.evaluate(`(() => {
      document.body.innerHTML = ${JSON.stringify(fixtureHtml)};
      localStorage.clear(); localStorage.setItem('zusage3.theme', 'pill');
      const upper = document.querySelector('#pane-a'), lower = document.querySelector('#pane-b');
      upper.setAttribute('data-testid', 'v4-pane-shell-top');
      Object.assign(upper.style, { position: 'fixed', top: '0px', bottom: 'auto', left: '50px', height: '450px',
        display: 'flex', flexDirection: 'column', justifyContent: 'end' });
      Object.assign(lower.style, { position: 'fixed', top: '450px', bottom: 'auto', left: '50px', height: '450px',
        display: 'flex', flexDirection: 'column', justifyContent: 'end' });
      upper.querySelector('textarea').setAttribute('data-testid', 'v4-composer-input');
      const action = document.createElement('button');
      action.id = 'lower-action'; action.textContent = 'Lower pane action';
      action.style.cssText = 'position:absolute;top:2px;left:120px;width:200px;height:30px';
      window.__lowerClicks = 0; action.addEventListener('click', () => window.__lowerClicks++);
      lower.appendChild(action);
      const a = upper.getBoundingClientRect(), z = lower.getBoundingClientRect();
      return { upperId: upper.getAttribute('data-pane-id'), upperTestid: upper.getAttribute('data-testid'),
        lowerId: lower.getAttribute('data-pane-id'), upper: [a.left, a.top, a.right, a.bottom],
        lower: [z.left, z.top, z.right, z.bottom] };
    })()`);
    assert.equal(before.upperId, 'a', JSON.stringify(before));
    assert.equal(before.upperTestid, 'v4-pane-shell-top', JSON.stringify(before));
    assert.equal(before.lowerId, 'b', JSON.stringify(before));
    assert.equal(before.upper[3], before.lower[1], JSON.stringify(before));
    await b.evaluate(overlay);
    await b.waitFor(`document.querySelectorAll('.zusage-root').length === 2`, 'both stacked panes must mount');
    await b.evaluate(`window.__zusageUpdate(${JSON.stringify(payload)})`);
    await delay(100);
    const observed = await b.evaluate(`(async () => {
      const upper = document.querySelector('#pane-a'), lower = document.querySelector('#pane-b');
      const action = document.querySelector('#lower-action');
      const rect = el => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
      const overlaps = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 &&
        Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
      const samples = [], start = performance.now();
      while (performance.now() - start < 1300) {
        const bars = [...document.querySelectorAll('.zusage-root')], actionRect = rect(action);
        const mapped = [document.querySelector('#zusage-bar'), bars.find(bar => bar.id !== 'zusage-bar')].map((bar, i) => {
          if (!bar) return { missing: true };
          const style = getComputedStyle(bar), r = rect(bar), pane = rect(i === 0 ? upper : lower);
          const visible = bar.isConnected && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
          return { visible, rect: r, pane, outside: visible && (r.left < pane.left - 1 || r.right > pane.right + 1 ||
            r.top < pane.top - 1 || r.bottom > pane.bottom + 1), coversLowerAction: visible && overlaps(r, actionRect) };
        });
        const x = (actionRect.left + actionRect.right) / 2, y = (actionRect.top + actionRect.bottom) / 2;
        const hit = document.elementFromPoint(x, y);
        samples.push({ at: Math.round(performance.now() - start), bars: mapped,
          lowerHit: !!hit && (hit === action || action.contains(hit)) });
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const r = rect(action);
      return { samples, elapsed: performance.now() - start, point: { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 } };
    })()`);
    await b.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...observed.point });
    await b.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...observed.point, button: 'left', clickCount: 1 });
    await b.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...observed.point, button: 'left', clickCount: 1 });
    const clicks = await b.evaluate('window.__lowerClicks');
    const problems = [];
    if (observed.elapsed < 1000) problems.push('observation shorter than 1s');
    if (observed.samples.some(s => s.bars.some(bar => bar.missing))) problems.push('a pane instance disappeared');
    if (observed.samples.some(s => s.bars.some(bar => bar.outside))) problems.push('visible pill exceeds its pane shell');
    if (observed.samples.some(s => !s.lowerHit || s.bars.some(bar => bar.coversLowerAction))) problems.push('pill covers lower pane action');
    if (clicks !== 1) problems.push('real pointer click did not reach lower pane action');
    assert.deepEqual(problems, [], JSON.stringify({ before, problems, clicks, ...observed }));
  });

  for (const startTop of [360, 420]) {
    await t.test(`plain upper textarea ${startTop < 405 ? 'starts above' : 'crosses'} the 45% threshold`, async () => {
      await b.call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
      const token = Math.random().toString(36).slice(2);
      await b.call('Page.navigate', { url: b.url + '?case=' + token });
      await b.waitFor(`document.readyState === "complete" && location.search === '?case=${token}'`);
      const before = await b.evaluate(`(() => {
        document.body.innerHTML = ${JSON.stringify(fixtureHtml)};
        localStorage.clear(); localStorage.setItem('zusage3.theme', 'pill');
        const upper = document.querySelector('#pane-a'), lower = document.querySelector('#pane-b');
        upper.setAttribute('data-testid', 'v4-pane-shell-top');
        Object.assign(upper.style, { position: 'fixed', top: '0px', bottom: 'auto', left: '50px', height: '530px',
          display: 'flex', flexDirection: 'column', justifyContent: 'end' });
        Object.assign(lower.style, { position: 'fixed', top: '580px', bottom: 'auto', left: '50px', height: '320px',
          display: 'flex', flexDirection: 'column', justifyContent: 'end' });
        const input = upper.querySelector('textarea');
        upper.style.height = (upper.getBoundingClientRect().height + ${startTop} - input.getBoundingClientRect().top) + 'px';
        window.__plainInput = input; window.__plainEvents = [];
        window.__plainObserver = new MutationObserver(records => {
          for (const record of records) for (const [kind, nodes] of [['added', record.addedNodes], ['removed', record.removedNodes]]) {
            for (const node of nodes) if (node.nodeType === 1 && node.classList.contains('zusage-root'))
              window.__plainEvents.push({ kind, id: node.id, at: Math.round(performance.now()) });
          }
        });
        window.__plainObserver.observe(document.body, { childList: true, subtree: true });
        return { top: input.getBoundingClientRect().top, threshold: innerHeight * 0.45,
          testid: input.getAttribute('data-testid'), upperId: upper.getAttribute('data-pane-id'),
          upperBottom: upper.getBoundingClientRect().bottom, lowerTop: lower.getBoundingClientRect().top };
      })()`);
      assert.equal(before.testid, null, JSON.stringify(before));
      assert.equal(before.upperId, 'a', JSON.stringify(before));
      assert.ok(Math.abs(before.top - startTop) <= 1 && before.upperBottom < before.lowerTop, JSON.stringify(before));
      await b.evaluate(overlay);
      const observed = await b.evaluate(`(async () => {
        const samples = [], start = performance.now(); let firstBars = null;
        while (performance.now() - start < 2100) {
          const bars = [...document.querySelectorAll('.zusage-root')];
          if (!firstBars && bars.length === 2 && bars.every(bar => getComputedStyle(bar).display !== 'none')) firstBars = bars;
          samples.push({ top: window.__plainInput.getBoundingClientRect().top, count: bars.length,
            positions: bars.map(bar => ({ top: bar.getBoundingClientRect().top, visible: getComputedStyle(bar).display !== 'none' })),
            connected: firstBars && firstBars.map(bar => bar.isConnected) });
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        window.__plainObserver.disconnect();
        return { elapsed: performance.now() - start, samples, events: window.__plainEvents, sameInput: window.__plainInput.isConnected };
      })()`);
      const last = observed.samples[observed.samples.length - 1];
      assert.ok(observed.elapsed >= 2000 && observed.sameInput, JSON.stringify({ before, ...observed }));
      if (startTop > before.threshold) assert.ok(observed.samples.some(s => s.top < before.threshold), `input did not cross 45%: ${JSON.stringify({ before, ...observed })}`);
      assert.equal(last.count, 2, `both panes need an instance: ${JSON.stringify({ before, ...observed })}`);
      assert.ok(last.positions.some(p => p.visible && p.top < before.lowerTop), `upper pane needs a visible pill: ${JSON.stringify({ before, ...observed })}`);
      assert.deepEqual(observed.events.map(event => event.kind), ['added', 'added'], JSON.stringify({ before, ...observed }));
      assert.ok(observed.samples.filter(s => s.connected).length > 0 && observed.samples.filter(s => s.connected)
        .every(s => s.count === 2 && s.connected.every(Boolean) && s.positions.every(p => p.visible)), JSON.stringify({ before, ...observed }));
    });
  }

  await t.test('ghosted upper composer (inert/opacity-0) is not promoted to an instance', async () => {
    // v143 added a candidate pre-filter (opacity:0/inert composers are not
    // promoted) to stop mount/unmount flapping; lock it with a real fixture —
    // without it a composer hidden by the host ghost shell spawns a bar anyway.
    await b.call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
    const token = Math.random().toString(36).slice(2);
    await b.call('Page.navigate', { url: b.url + '?case=' + token });
    await b.waitFor(`document.readyState === "complete" && location.search === '?case=${token}'`);
    const fixture = await b.evaluate(`(() => {
      document.body.innerHTML = ${JSON.stringify(fixtureHtml)};
      localStorage.clear(); localStorage.setItem('zusage3.theme', 'pill');
      const upper = document.querySelector('#pane-a');
      upper.setAttribute('data-testid', 'v4-pane-shell-top');
      Object.assign(upper.style, { position: 'fixed', top: '0px', bottom: 'auto', left: '50px', height: '530px',
        display: 'flex', flexDirection: 'column', justifyContent: 'end' });
      const input = upper.querySelector('textarea');
      input.setAttribute('inert', '');
      input.style.opacity = '0';
      window.__ghostEvents = [];
      window.__ghostObserver = new MutationObserver(records => {
        for (const record of records) for (const [kind, nodes] of [['added', record.addedNodes], ['removed', record.removedNodes]]) {
          for (const node of nodes) if (node.nodeType === 1 && node.classList.contains('zusage-root'))
            window.__ghostEvents.push({ kind, id: node.id, at: Math.round(performance.now()) });
        }
      });
      window.__ghostObserver.observe(document.body, { childList: true, subtree: true });
      return { upperInert: input.inert, upperOpacity: getComputedStyle(input).opacity };
    })()`);
    assert.equal(fixture.upperInert, true, JSON.stringify(fixture));
    assert.equal(fixture.upperOpacity, '0', JSON.stringify(fixture));
    await b.evaluate(overlay);
    await delay(1600);
    const observed = await b.evaluate(`({ events: window.__ghostEvents,
      bars: [...document.querySelectorAll('.zusage-root')].map(bar => ({ id: bar.id, display: getComputedStyle(bar).display })) })`);
    // Only the lower (visible) pane may be promoted; the ghosted composer must
    // not spawn an instance at any point (no add/remove flapping either).
    assert.equal(observed.bars.length, 1, JSON.stringify(observed));
    assert.deepEqual(observed.events.map(event => event.kind), ['added'], JSON.stringify(observed));
  });

  await t.test('zero-margin bottom dock keeps both 8px gaps after padding changes from 0 to 16', async () => {
    await reset(b, { stored: 'default' });
    const before = await b.evaluate(`(() => {
      document.querySelector('#pane-b').remove();
      const pane = document.querySelector('#pane-a'), card = document.querySelector('#card-a');
      pane.setAttribute('data-v4-composer-dock-content', 'true');
      Object.assign(pane.style, { position: 'fixed', top: 'auto', bottom: '0px', height: '230px',
        display: 'flex', flexDirection: 'column', justifyContent: 'end', paddingBottom: '0px' });
      return { margin: parseFloat(getComputedStyle(card).marginBottom), padding: parseFloat(getComputedStyle(pane).paddingBottom) };
    })()`);
    assert.equal(before.margin, 0, JSON.stringify(before));
    assert.equal(before.padding, 0, JSON.stringify(before));
    await choose(b, 'pill');
    const measure = async () => b.evaluate(`(() => {
      const pane = document.querySelector('#pane-a'), card = document.querySelector('#card-a'), bar = document.querySelector('#zusage-bar');
      const p = pane.getBoundingClientRect(), c = card.getBoundingClientRect(), r = bar.getBoundingClientRect();
      return { padding: parseFloat(getComputedStyle(pane).paddingBottom), dockHeight: p.height,
        cardHeight: c.height, barHeight: r.height, visible: getComputedStyle(bar).display !== 'none',
        above: r.top - c.bottom, below: innerHeight - r.bottom, margin: parseFloat(getComputedStyle(card).marginBottom) };
    })()`);
    await delay(1200);
    const zero = await measure();
    await b.evaluate(`document.querySelector('#pane-a').style.paddingBottom = '16px'`);
    await delay(1200);
    const sixteen = await measure();
    for (const m of [zero, sixteen]) {
      assert.ok(m.visible && m.barHeight > 0, JSON.stringify({ before, zero, sixteen }));
      assert.ok(m.dockHeight >= m.cardHeight + m.barHeight + 16, `fixture has insufficient space: ${JSON.stringify({ before, zero, sixteen })}`);
      assert.ok(Math.abs(m.above - 8) <= 1, `gap above at padding ${m.padding}: ${JSON.stringify({ before, zero, sixteen })}`);
      assert.ok(Math.abs(m.below - 8) <= 1, `gap below at padding ${m.padding}: ${JSON.stringify({ before, zero, sixteen })}`);
    }
    assert.equal(zero.padding, 0, JSON.stringify({ before, zero, sixteen }));
    assert.equal(sixteen.padding, 16, JSON.stringify({ before, zero, sixteen }));
  });

  // v232 速度柱状图：真实鼠标悬停柱体切换信息卡/cur、离开回落最新段；键盘聚焦切卡
  // 且悬停/推送期间焦点不被整卡重建销毁（事件链此前零覆盖，删除全链测试仍绿的教训）。
  await t.test('v232 speed chart: real-mouse bar hover swaps the card and focus survives rebuilds', async () => {
    await reset(b, {});
    await b.evaluate(`(() => {
      const p = ${JSON.stringify(payload)};
      const row = (p.recent || [])[0];
      const t0 = new Date(2026, 10, 3, 13, 40).getTime();
      row.avg_tps = 130.3;
      row.speed_segs = Array.from({ length: 10 }, (_, i) => ({ v: 100 + i * 2, t: t0 + i * 60000 }));
      window.__zusageUpdate(p);
    })()`);
    await b.waitFor(`!!document.querySelector('.zusage-root .zu-main .it')`, 'bar cells missing');
    const cell = await b.evaluate(`(() => {
      const r = document.querySelector('.zusage-root .zu-main .it').getBoundingClientRect();
      return { x: r.x + r.width * 0.4, y: r.y + r.height * 0.6 };
    })()`);
    await b.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cell.x, y: cell.y });
    await b.waitFor(`document.getElementById('zusage-tip') && getComputedStyle(document.getElementById('zusage-tip')).display === 'block'`, 'speed tip did not open');
    await b.waitFor(`!!document.querySelector('#zusage-tip .zu-sc-col')`, 'chart missing in speed tip');
    // v240/v242 基本面:柱数=10、默认无卡无 cur、表头文案;相邻读数/时间标签不重叠(真实 DOM 几何)
    assert.equal(await b.evaluate(`document.querySelectorAll('#zusage-tip .zu-sc-col').length`), 10, 'must render exactly 10 bars');
    assert.equal(await b.evaluate(`document.querySelector('#zusage-tip .zu-sc-card') === null && document.querySelector('#zusage-tip .zu-sc-col.cur') === null`), true, 'default state must have no info card and no cur');
    assert.equal(await b.evaluate(`document.querySelector('#zusage-tip .zu-sc-title').textContent`), '最近 10 轮');
    const noOverlap = await b.evaluate(`(() => {
      const cols = [...document.querySelectorAll('#zusage-tip .zu-sc-col')];
      const groups = [cols.map(c => c.querySelector('.zu-sc-val')),
        cols.map(c => c.querySelectorAll('.zu-sc-x b')[0]),
        cols.map(c => c.querySelectorAll('.zu-sc-x b')[1])];
      for (const g of groups) {
        const rs = g.filter(Boolean).map(el => el.getBoundingClientRect());
        rs.sort((p, q) => p.left - q.left);
        for (let i = 1; i < rs.length; i++) if (rs[i].left < rs[i - 1].right - 0.5) return false;
      }
      return true;
    })()`);
    assert.equal(noOverlap, true, 'adjacent readings/time labels must not overlap');
    const bar = await b.evaluate(`(() => {
      const r = document.querySelectorAll('#zusage-tip .zu-sc-col')[2].getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height * 0.5 };
    })()`);
    await b.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: bar.x, y: bar.y });
    await b.waitFor(`document.querySelector('#zusage-tip .zu-sc-card-k').textContent.indexOf('第 3 轮') === 0`, 'info card did not switch to seg 3');
    const curAt = await b.evaluate(`[...document.querySelectorAll('#zusage-tip .zu-sc-col')].findIndex(c => c.classList.contains('cur'))`);
    assert.equal(curAt, 2, 'cur must move to the hovered bar');
    await b.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cell.x, y: cell.y });
    await b.waitFor(`!document.querySelector('#zusage-tip .zu-sc-card')`, 'v240: info card must disappear when leaving the chart');
    // 键盘聚焦第 5 根：信息卡切换，焦点保持在柱上
    await b.evaluate(`document.querySelectorAll('#zusage-tip .zu-sc-col')[4].focus()`);
    await b.waitFor(`document.querySelector('#zusage-tip .zu-sc-card-k').textContent.indexOf('第 5 轮') === 0`, 'focus did not switch the info card');
    const focusKept = await b.evaluate(`document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute('data-i')`);
    assert.equal(focusKept, '4', 'focused bar must keep focus');
    // 聚焦期间新快照推送（render 接管 speedFollow 焦点守卫）：整卡不重建、焦点不丢
    await b.evaluate(`window.__zusageUpdate(${JSON.stringify(payload)})`);
    await delay(150);
    const focusKept2 = await b.evaluate(`document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute('data-i')`);
    assert.equal(focusKept2, '4', 'snapshot push while focused must not destroy focus');
    await b.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
  });
});

test('v146 compact theme browser behaviour (isolated fixture)', { skip: skipReason, timeout: 90000 }, async t => {
  const b = await startBrowser(t);
  // 精简模式装载（reset() 的可见等待不适用：条本就 display:none）
  await b.call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
  const token = Math.random().toString(36).slice(2);
  await b.call('Page.navigate', { url: b.url + '?case=' + token });
  await b.waitFor(`document.readyState === "complete" && location.search === '?case=${token}'`);
  await b.evaluate(`(() => {
    document.body.innerHTML = ${JSON.stringify(fixtureHtml)};
    localStorage.clear(); localStorage.setItem('zusage3.theme', 'compact');
    // v147：给工具行补前导区（真实宿主有 data-composer-leading-content + cua 入口，速率 chip 挂 git chip 左侧）
    document.querySelectorAll('[class*="group/toolbar"]').forEach(row => {
      const lead = document.createElement('span');
      lead.setAttribute('data-composer-leading-content', 'true');
      lead.style.display = 'flex';
      lead.style.alignItems = 'center';
      lead.style.gap = '4px';
      lead.style.whiteSpace = 'nowrap';
      const cua = document.createElement('button');
      cua.setAttribute('data-testid', 'v4-composer-cua-entry');
      lead.appendChild(cua);
      row.insertBefore(lead, row.firstChild);
    });
    // v149：补 renderer 桥同款 scope 属性（readPaneScope 依赖；缺了 git chip 永不挂载）
    [['a', '/repo/a'], ['b', '/repo/b']].forEach(([pid, path]) => {
      const pane = document.getElementById('pane-' + pid);
      pane.setAttribute('data-zusage-scope-version', '1');
      pane.setAttribute('data-zusage-pane-id', pid);
      pane.setAttribute('data-zusage-workspace-path', path);
      pane.setAttribute('data-zusage-workspace-identity', '');
      pane.setAttribute('data-zusage-remote-session-id', '');
    });
  })()`);
  await b.evaluate(overlay);
  await b.waitFor(`document.querySelectorAll('.zusage-root').length === 2`, 'bars did not mount');
  await b.evaluate(`window.__zusageUpdate(${JSON.stringify(payload)})`);
  await b.waitFor(`document.querySelectorAll('.zu-tsb').length === 2`, 'tps chips did not mount');

  await t.test('bar is hidden but alive on body; rate chip lives in the toolbar', async () => {
    const st = await b.evaluate(`(() => {
      const bar = document.querySelector('#zusage-bar');
      const chip = document.querySelector('.zu-tsb');
      const lead = chip && chip.closest('[data-composer-leading-content]');
      const cua = lead && lead.querySelector('[data-testid="v4-composer-cua-entry"]');
      const cs = getComputedStyle(bar);
      return { display: cs.display, visibility: cs.visibility, parent: bar.parentElement === document.body,
        theme: bar.getAttribute('data-zusage-theme'),
        chipText: chip.textContent, chipWeight: getComputedStyle(chip).fontWeight,
        inLead: !!lead, afterCua: !!(cua && cua.nextElementSibling === chip) };
    })()`);
    assert.equal(st.display, 'none', JSON.stringify(st));
    assert.equal(st.visibility, 'visible', 'hidden via display, not visibility');
    assert.equal(st.parent, true, 'bar is detached from the card onto body');
    assert.equal(st.theme, 'compact');
    assert.match(st.chipText, /92/);
    assert.equal(st.chipWeight, '700', 'explicit bold spec (quota-chip parity)');
    assert.equal(st.inLead, true, 'chip is inside the leading content group (git chip home)');
    assert.equal(st.afterCua, true, 'git absent -> chip takes the git anchor slot after the cua button');
  });

  await t.test('tooltip shows summaries + settings entry; button opens the panel', async () => {
    await b.evaluate(`(() => {
      const chip = document.querySelector('.zu-tsb');
      chip.dispatchEvent(new Event('mouseenter'));
    })()`);
    await b.waitFor(`(() => { const t = document.querySelector('.zusage-tps-tip'); return t && t.style.display === 'block' && t.textContent.includes('状态条摘要'); })()`,
      'tps tooltip did not show');
    const content = await b.evaluate(`(() => { const t = document.querySelector('.zusage-tps-tip');
      return { hasLegend: t.textContent.includes('颜色对照'), hasSettings: !!t.querySelector('.tps-cfg'),
        hasTurn: t.textContent.includes('本轮'), hasToday: t.textContent.includes('今日合计') }; })()`);
    assert.equal(content.hasLegend, true);
    assert.equal(content.hasTurn, true);
    assert.equal(content.hasToday, true);
    await b.evaluate(`document.querySelector('.zusage-tps-tip .tps-cfg').click()`);
    await b.waitFor(`[...document.querySelectorAll('.zu-settings')].some(p => p.classList.contains('open'))`,
      'settings panel did not open from the tooltip button');
    const theme = await themes(b);
    assert.deepEqual(theme, ['compact', 'compact']);
  });

  await t.test('real git chip coexists with the rate chip: mounts after it and holds position across frames', async () => {
    await b.evaluate(`(() => {
      const st = path => ({ ok: true, ts: Date.now(), branch: 'main', ins: 3, del: 1, staged: 0, unstaged: 2,
        untracked: 0, conflicts: 0, changed: 2, repoPath: path, op: null, upstream: null, ahead: 1, behind: 0,
        detached: false, noCommits: false });
      window.__zusageGitState('/repo/a', st('/repo/a'));
      window.__zusageGitState('/repo/b', st('/repo/b'));
    })()`);
    await b.waitFor(`document.querySelectorAll('.zu-git').length === 2`, 'git chips did not mount beside the rate chips');
    // v149 修正：chips 在工具行（条外），从 .zu-tsb 本体读相邻关系，而非 .zusage-root 内部
    const geo = await b.evaluate(`(() => {
      const read = () => [...document.querySelectorAll('.zu-tsb')].map(t => {
        const g = t.nextElementSibling;
        if (!g || !g.classList.contains('zu-git')) return null;
        const r1 = t.getBoundingClientRect(), r2 = g.getBoundingClientRect();
        const pane = t.closest('.pane');
        return { pane: pane ? pane.id : '?', tr: r1.left, tw: r1.width, gr: r2.left, gw: r2.width,
          doc: !!(t.compareDocumentPosition(g) & Node.DOCUMENT_POSITION_FOLLOWING) };
      }).filter(Boolean);
      read(); return new Promise(res => { let n = 0; const step = () => { n++; const snap = read();
        if (n >= 12) res(snap); else requestAnimationFrame(step); }; requestAnimationFrame(step); });
    })()`);
    assert.equal(geo.length, 2, 'both rate chips sit immediately before a git chip across frames');
    for (const [i, m] of geo.entries()) {
      assert.ok(m.tr < m.gr, `pair ${i}: rate is left of git (${JSON.stringify(m)})`);
      console.log('PAIR:', JSON.stringify(m));
    }
  });

  await t.test('v156: an empty shell bar (hot-reload placeholder era) refills in compact and never survives the switch', async () => {
    // 模拟热更占位/清子树后未填过的条面：compact 期 render 短路会让空壳一直存活
    await b.evaluate(`(() => { const m = document.querySelector('#zusage-bar .zu-main'); m.innerHTML = ''; })()`);
    await b.evaluate(`window.__zusageUpdate(${JSON.stringify(payload)})`);
    await b.waitFor(`document.querySelector('#zusage-bar .zu-main').childElementCount > 0`,
      'compact render did not refill an empty shell bar');
    await choose(b, 'default', 0);
    await b.waitFor(`(() => { const m = document.querySelector('#zusage-bar .zu-main');
      return m.childElementCount > 0 && getComputedStyle(document.querySelector('#zusage-bar')).display === 'flex'; })()`,
      'empty shell survived the switch to default');
    await choose(b, 'compact', 0);
    await b.waitFor(`getComputedStyle(document.querySelector('#zusage-bar')).display === 'none'`,
      'round-trip back to compact failed');
  });

  await t.test('switching back to default restores the bar and removes the chips', async () => {
    await choose(b, 'default', 0);
    await b.waitFor(`(() => { const bar = document.querySelector('#zusage-bar');
      return getComputedStyle(bar).display === 'flex' && !document.querySelector('.zu-tsb'); })()`,
      'bar did not come back / chip did not leave');
    await b.waitFor(`document.querySelectorAll('.zusage-root').length === 2`, 'bar count drifted');
    await choose(b, 'compact', 0);
    await b.waitFor(`(() => { const bar = document.querySelector('#zusage-bar');
      return getComputedStyle(bar).display === 'none' && document.querySelectorAll('.zu-tsb').length === 2; })()`,
      'compact round-trip failed');
  });
});

/* ---------- 速度格走真实数据链（目标 §1.2 / §4.2 / §6.2）：伪造会话 store → turn-stats.js →
   zuBarSpeedView → 展示协调器 → updateLive → 真实布局。生产阈值（防抖 180 / 最短显示 400 / 数值 600 /
   颜色 400 / 计时 1000）下按真实节奏推进：每个状态等它上屏后再量几何。断言：
   ①同一档位里图标切换（脑/扳手/闪电）不改变图标盒、不推动文字；②数值右缘不随位数/小数位变化；
   ③邻格矩形不变；④右对齐无水平位移；⑤药丸居中坐标不变；⑥工具错误徽标与速度格互不阻塞。 ---------- */
test('speed slot through the live data chain (isolated fixture)', { skip: skipReason, timeout: 180000 }, async t => {
  const b = await startBrowser(t);
  const H = (state, extra) => `P.header(${JSON.stringify(state)}, ${JSON.stringify(extra || {})})`;
  const T = text => `P.text(${JSON.stringify(text)})`;
  const TOOL = (status, extraSrc) => `P.tool(${JSON.stringify(status)}, ${extraSrc})`;
  const push = (seq, rows) => b.evaluate(`(() => { const P = window.__liveProbe; P.store.set(P.snap(${seq}, [${rows.join(', ')}])); return true; })()`);
  const geo = async () => {
    await b.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    return b.evaluate(`(${liveGeo.toString()})()`);
  };
  const face = label => b.waitFor(`(() => {
    const c = window.__liveProbe.cell && window.__liveProbe.cell();
    const l = c && c.querySelector('.zu-sp-label'), v = c && c.querySelector('.zu-sp-val');
    return !!l && !!v && l.textContent === ${JSON.stringify(label)}${label ? '' : " && !/≈/.test(v.textContent)"};
  })()`, `speed face "${label}" did not appear`, 600);
  const bind = () => b.evaluate(`(() => { const P = window.__liveProbe; P.store = P.mkStore(P.snap(1, [P.header('running'), P.text('abc')]));
    P.sessions.push({ key: '__base__ /fixture/ws', topic: 'conversation/sid_a', store: P.store }); return true; })()`);
  const right = rect => rect && Math.round((rect[0] + rect[2]) * 100) / 100;

  /* 思考 → 生成 → 读取（工具）→ 生成 → 完成；生成态内再推三次正文让数值变化。返回各态上屏后的几何。 */
  async function runChain() {
    await bind();
    await face('思考');
    const g = { think: await geo() };
    await delay(500);
    await push(2, [H('running'), T('abcdef')]);
    await face('生成');
    g.estimate = await geo();
    g.estimateTicks = [];
    for (const [i, text] of ['abcdefghi', 'abcdefghijkl', 'abcdefghijklmnopq'].entries()) {
      await delay(300);
      await push(3 + i, [H('running'), T(text)]);
      await delay(130);                       // 至少一拍 100ms 心跳
      g.estimateTicks.push(await geo());
    }
    await delay(500);
    await push(6, [H('running'), T('abcdefghijklmnopq'), TOOL('running', '{ startedAt: Date.now() }')]);
    await face('读取');
    g.tool = await geo();
    await delay(500);
    await push(7, [H('running'), T('abcdefghijklmnopqrstuvwx'), TOOL('completed', '{ startedAt: Date.now() - 1500 }')]);
    await face('生成');
    g.estimate2 = await geo();
    await push(8, [H('completedSuccess', { outputTokens: 1000, modelDurationMs: 4000, activeMs: 5000 }), T('abcdefghijklmnopqrstuvwx')]);
    await face('');
    g.final = await geo();
    return g;
  }

  /* 三种布局共用：速度格/图标盒/文字左缘/数值右缘/邻格在整个序列里不变；图标确实切换过 */
  function assertStableSlot(g, label) {
    const all = [g.think, g.estimate, ...g.estimateTicks, g.tool, g.estimate2, g.final];
    assert.ok(all.every(Boolean), `${label}: speed cell present in every state`);
    assert.deepEqual(g.think.iconKind, 'think', `${label}: thinking shows the brain icon`);
    assert.deepEqual(g.tool.iconKind, 'tool', `${label}: tool shows the wrench icon`);
    assert.deepEqual(g.final.iconKind, 'bolt', `${label}: final shows the bolt icon`);
    for (const snap of [g.think, g.tool, g.final]) {
      assert.equal(snap.iconAriaHidden, 'true', `${label}: state icon is decorative (aria-hidden); the full text lives in aria-label`);
      assert.equal(snap.focusable, 0, `${label}: speed cell is keyboard reachable (tooltip on focus)`);
    }
    assert.match(g.think.value, /^\d/, `${label}: thinking shows an elapsed time`);
    assert.match(g.estimate.value, /^≈\d/, `${label}: estimate shows ≈ value`);
    assert.deepEqual(g.tool.label, '读取', `${label}: tool label`);
    assert.doesNotMatch(g.final.value, /≈/, `${label}: final shows the real speed without ≈`);
    assert.deepEqual(g.final.label, '', `${label}: final has no label`);
    for (const snap of all) assert.equal(snap.tier, g.think.tier, `${label}: layout tier unchanged across the sequence (${snap.label}|${snap.value})`);
    for (const [name, snap] of [['estimate', g.estimate], ['tool', g.tool], ['estimate2', g.estimate2], ['final', g.final]]) {
      assert.deepEqual(snap.cell, g.think.cell, `${label}: cell box unchanged across ${name}`);
      assert.deepEqual(snap.icon, g.think.icon, `${label}: icon box unchanged across ${name} (icon switch does not push text)`);
      assert.deepEqual(snap.live, g.think.live, `${label}: text box unchanged across ${name}`);
    }
    g.estimateTicks.forEach((snap, i) => assert.deepEqual(snap.cell, g.think.cell, `${label}: cell box unchanged on value tick ${i}`));
    for (const snap of [g.think, g.estimate, ...g.estimateTicks, g.tool, g.estimate2, g.final]) {
      assert.deepEqual(snap.cells.filter(([k]) => k !== 'speed'), g.think.cells.filter(([k]) => k !== 'speed'), `${label}: neighbour cells unchanged (${snap.label}|${snap.value})`);
    }
    /* 数值右缘：宽裕/中等档里带单位的态以单位右缘为准，不带单位的态（思考/工具计时）数值右缘落在同一条线上；
     * 最窄档单位隐藏，所有态的数值右缘同线 */
    const unitShown = g.estimate.unitRect[2] > 0;
    const edge = unitShown ? right(g.estimate.unitRect) : right(g.estimate.val);
    const edgeOf = snap => unitShown && snap.unitRect && snap.unitRect[2] > 0 ? right(snap.unitRect) : right(snap.val);
    for (const [name, snap] of [['estimate2', g.estimate2], ['final', g.final], ['thinking', g.think], ['tool', g.tool]]) {
      assert.equal(edgeOf(snap), edge, `${label}: value right edge fixed (${name})`);
    }
    /* 数值位数变化（估算态连续三次推送）：右缘不动 */
    g.estimateTicks.forEach((snap, i) => assert.equal(edgeOf(snap), edge, `${label}: estimate right edge fixed on tick ${i} (${snap.value})`));
    /* 文字：标签盒吃掉数值让出的剩余空间（宽度随数值变是设计），但左缘/基线不动——图标切换与换文案都不推动文字 */
    const labelAnchor = rect => rect && [rect[0], rect[1], rect[3]];
    for (const snap of [g.estimate, ...g.estimateTicks, g.tool]) assert.deepEqual(labelAnchor(snap.labelRect), labelAnchor(g.think.labelRect), `${label}: label left edge fixed (${snap.label})`);
    assert.ok(g.think.live[0] === g.think.icon[0] + g.think.icon[2] + (g.think.live[0] - g.think.icon[0] - g.think.icon[2]), 'sanity');
    /* 无障碍：完整 aria-label、不在 live region（高频速度更新不触发重复播报）。
     * 两处全称来源不同：aria-label 跟格面（数值 = 格面此刻显示的值，随 600ms 节流）；
     * data-zu-full（「···」菜单用）跟真实视图——节流窗内领先于格面。 */
    for (const snap of all) {
      assert.match(snap.aria || '', /^生成速度 .+/, `${label}: full aria-label`);
      assert.ok(snap.full && snap.full.length > 0, `${label}: data-zu-full present`);
      assert.equal(snap.ariaLive, null, `${label}: speed cell is not a live region`);
    }
    for (const snap of [g.estimate, ...g.estimateTicks, g.estimate2, g.final]) {
      assert.ok(snap.aria.includes(String(snap.value).replace('≈', '') + ' ' + snap.unit), `${label}: aria-label carries the displayed value (${snap.aria} | ${snap.value})`);
    }
    assert.ok(g.estimateTicks.some(snap => snap.aria !== '生成速度 ' + snap.full), `${label}: inside the numeric throttle the menu text (real view) leads the aria-label (display view)`);
  }

  /* 卡片宽度决定档位：1100px=宽裕（四档的完整面）；420px=最窄档（图标+数值，标签与单位隐藏）；
     药丸按卡片宽度走自己的档位。先等档位稳定再推数据。 */
  for (const [name, opts, paneWidth, tierReady] of [
    ['default-wide', { withKernel: true }, 1100, `!bar.classList.contains('zu-tight')`],
    ['right-aligned', { withKernel: true, ls: { 'zusage3.barJust': 'end' } }, 1100, `!bar.classList.contains('zu-tight')`],
    ['default-narrow', { withKernel: true }, 420, `bar.classList.contains('zu-narrow')`],
    ['pill', { withKernel: true, stored: 'pill' }, 1100, `true`],
  ]) {
    await t.test(`${name}: icon switches and value changes never move text or neighbours`, async () => {
      await reset(b, opts);
      await b.evaluate(`document.querySelector('#pane-a').style.width = '${paneWidth}px'`);
      await b.waitFor(`(() => { const c = window.__liveProbe.cell(); const bar = c && c.closest('.zusage-root'); return !!bar && (${tierReady}); })()`, `${name}: layout tier did not settle`, 400);
      const g = await runChain();
      assertStableSlot(g, name);
      for (const snap of [g.estimate, ...g.estimateTicks, g.tool, g.estimate2, g.final]) assert.deepEqual(snap.bar, g.think.bar, `${name}: bar box unchanged (${snap.label}|${snap.value})`);
      assert.equal(g.think.tier, name === 'default-narrow' ? 'narrow' : name === 'pill' ? g.think.tier : 'wide', `${name}: expected tier`);
      if (name === 'right-aligned') {
        assert.match(g.think.barCls, /zu-just-end/, 'right alignment active');
        for (const snap of [g.estimate, ...g.estimateTicks, g.tool, g.estimate2, g.final]) assert.equal(snap.scrollLeft, 0, `${name}: no horizontal shift`);
        const last = g.think.cells[g.think.cells.length - 1];
        for (const snap of [g.estimate, g.tool, g.final]) assert.deepEqual(snap.cells[snap.cells.length - 1], last, `${name}: right-most cell fixed`);
      }
      if (name === 'pill') {
        for (const snap of [g.think, g.estimate, ...g.estimateTicks, g.tool, g.estimate2, g.final]) {
          assert.ok(Math.abs(snap.barCenter - snap.cardCenter) < 1, `${name}: pill stays centred (bar ${snap.barCenter} vs card ${snap.cardCenter})`);
        }
      }
    });
  }

  await t.test('tool error badge renders from the database snapshot without waiting for the speed coordinator', async () => {
    await reset(b, { withKernel: true });
    await bind();
    await face('思考');
    const t0 = Date.now();
    const withErrors = JSON.parse(JSON.stringify(payload));
    withErrors.recent = withErrors.recent.map(row => row.sid === 'sid_a' ? Object.assign(row, { tools: { total: 3, errors: 1, list: [] } }) : row);
    await b.evaluate(`(() => { window.__zusageUpdate(${JSON.stringify(withErrors)}); return true; })()`);
    await b.waitFor(`!!document.querySelector('#pane-a .it[data-zu-key="tools"] .eb')`, 'error badge did not render', 40);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 400, `error badge appears promptly (${elapsed}ms) while the speed cell is inside its 400ms minimum display`);
    const geo1 = await b.evaluate(`(${liveGeo.toString()})()`);
    assert.deepEqual(geo1.label, '思考', 'speed cell keeps its own cadence');
    /* 窄屏规格「工具错误不随精简隐藏」：逐级收窄卡片。窄档（zu-tight/zu-narrow）只藏次要数字，工具格还在条上时
     * 徽标必须可见；整格折进「···」是更后面的一层（按优先级折叠，非本次范围）。 */
    let sawNarrowWithTools = false;
    for (const width of [700, 620, 560, 500, 450]) {
      await b.evaluate(`document.querySelector('#pane-a').style.width = '${width}px'`);
      await delay(450);                       // 窄宽状态机 250ms 节流 + 迟滞
      const st = await b.evaluate(`(() => { const c = window.__liveProbe.cell(); const bar = c.closest('.zusage-root');
        const tools = bar.querySelector('.it[data-zu-key="tools"]'); const e = tools.querySelector('.eb');
        return { tier: bar.classList.contains('zu-narrow') ? 'narrow' : bar.classList.contains('zu-tight') ? 'tight' : 'wide',
          folded: tools.dataset.zuFolded === '1', visible: !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0 }; })()`);
      if (st.folded) continue;
      assert.ok(st.visible, `error badge visible at ${width}px (${st.tier})`);
      if (st.tier !== 'wide') sawNarrowWithTools = true;
    }
    assert.ok(sawNarrowWithTools, 'a compact tier with the tools cell still on the bar was exercised');
  });

  /* 探针报告的共用判据：同档宽度单一、邻格不动、无越界；界面字号 14px 下落在目标 §5 区间内 */
  const RANGE = { '默认 宽裕': [160, 180], '默认 中等': [112, 132], '默认 紧张': [72, 88], '默认 极窄': [32, 40],
    '药丸 宽裕': [160, 180], '药丸 中等': [112, 132], '药丸 紧张': [72, 88] };
  function checkSlotReport(report, tag) {
    assert.equal(Object.keys(report).length, 21, `${tag}: 3 interface font sizes × 7 tiers`);
    for (const [tier, r] of Object.entries(report)) {
      assert.equal(new Set(r.speedW).size, 1, `${tag} ${tier}: speed width varies with state: ${[...new Set(r.speedW)]}`);
      assert.equal(new Set(r.turnL).size, 1, `${tag} ${tier}: neighbour cell moved: ${[...new Set(r.turnL)]}`);
      assert.deepEqual(r.overflow, [], `${tag} ${tier}: value crosses the cell edge`);
    }
    for (const [tier, [lo, hi]] of Object.entries(RANGE)) {
      const w = report['default ' + tier].speedW[0];
      assert.ok(w >= lo && w <= hi, `${tag} ${tier}: ${w}px outside ${lo}–${hi}`);
    }
    return Object.fromEntries(Object.entries(report).filter(([k]) => /紧张/.test(k)).map(([k, r]) => [k, r.minLead]));
  }

  await t.test('speed slot geometry is device-pixel-ratio independent (1.25×, 1.5×, 1.75×, 2×; high-DPI scaling)', async () => {
    for (const dsf of [1.25, 1.5, 1.75, 2]) {
      await reset(b, { dsf });
      await b.evaluate(`document.querySelector('#pane-a').style.width = '1100px'`);
      await b.waitFor(`!document.querySelector('#pane-a .zusage-root').classList.contains('zu-tight')`, `dsf ${dsf}: wide tier did not settle`);
      const report = await b.evaluate(`(${speedSlotProbe.toString()})()`);
      const slack = checkSlotReport(report, `dsf ${dsf}`);
      for (const [tier, v] of Object.entries(slack)) assert.ok(v >= 4, `dsf ${dsf} ${tier}: slack ${v}px`);
      t.diagnostic(`dsf ${dsf}: narrow-tier lead ${JSON.stringify(slack)}`);
    }
    await reset(b);   // 还原 1×
  });

  await t.test('speed slot stays inside its tier box under alternative font stacks (font-metric robustness)', async () => {
    await reset(b);
    await b.evaluate(`document.querySelector('#pane-a').style.width = '1100px'`);
    await b.waitFor(`!document.querySelector('#pane-a .zusage-root').classList.contains('zu-tight')`, 'wide tier did not settle');
    /* Windows 常见字体栈放在最前：本机没装的字体回落到系统默认，断言对「装了什么」不敏感，只保证不越界 */
    const stacks = [
      '"Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif',
      '"Helvetica Neue", Helvetica, Arial, sans-serif',
      'Verdana, Tahoma, sans-serif',
      '"PingFang SC", "Hiragino Sans GB", "Heiti SC", sans-serif',
      '"Songti SC", "STSong", serif',
      'Menlo, Consolas, monospace',
    ];
    for (const stack of stacks) {
      await b.evaluate(`document.documentElement.style.setProperty('--font-sans', ${JSON.stringify(stack)})`);
      const report = await b.evaluate(`(${speedSlotProbe.toString()})()`);
      const slack = checkSlotReport(report, stack.slice(0, 28));
      t.diagnostic(`${stack.slice(0, 40)}: narrow-tier lead ${JSON.stringify(slack)}`);
      await b.evaluate(`document.documentElement.style.removeProperty('--font-sans')`);
    }
  });

  /* 持续观察的页面侧采样器（tests/speed-slot-live-watch.js，供 tests/speed-slot-live-probe.py --watch 用）：同一条数据链在
   * 观察期内走一遍，样本必须落在同一个布局签名里、宽度只有一个值、各态都采到；把速度格改成宽度随内容后，同一签名里
   * 必须出现多个宽度（工具有牙）。判定（summarize）在 Python 侧，由 tests/test_speed_slot_live_probe.py 用构造样本锁定。 */
  await t.test('speed slot watch-mode sampler: one width per layout signature through live transitions, and it sees a resizing slot', async () => {
    const watchSrc = fs.readFileSync(path.join(__dirname, 'speed-slot-live-watch.js'), 'utf8');
    for (const [label, breakSlot] of [['intact slot', false], ['slot whose width follows content', true]]) {
      await reset(b, { withKernel: true });
      await b.evaluate(`document.querySelector('#pane-a').style.width = '1100px'`);
      await b.waitFor(`(() => { const c = window.__liveProbe.cell(); const bar = c && c.closest('.zusage-root'); return !!bar && !bar.classList.contains('zu-tight'); })()`, 'wide tier did not settle', 400);
      if (breakSlot) await b.evaluate(`(() => { const s = document.createElement('style'); s.textContent = '.zusage-root .zu-main>.it.zu-speed{width:auto!important}'; document.head.appendChild(s); return true; })()`);
      await b.evaluate(`(() => { window.__watch = (${watchSrc})({ seconds: 6, every: 50 }); return true; })()`);
      await runChain();
      const out = await b.evaluate('window.__watch');
      assert.equal(await b.evaluate(`typeof window.__zuSpeedWatchStop`), 'undefined', `${label}: sampler stops and cleans up when the watch ends`);
      /* 夹具有两个分栏、两条状态条，采样器全部观察；本用例只推了 #pane-a 的那条 */
      const paneBar = await b.evaluate(`[...document.querySelectorAll('.zusage-root')].findIndex(x => x.closest('#pane-a'))`);
      assert.ok(paneBar >= 0, `${label}: pane-a bar located`);
      const ok = out.samples.filter(s => !s.none && s.b === paneBar);
      assert.ok(ok.length >= 20, `${label}: enough measurable samples (${ok.length})`);
      const sigs = [...new Set(ok.map(s => out.sigs[s.s]))];
      assert.equal(sigs.length, 1, `${label}: every sample falls in one layout signature: ${JSON.stringify(sigs)}`);
      assert.equal(sigs[0].split('|')[4], String(out.meta.width), `${label}: signature carries the window width`);
      const widths = [...new Set(ok.map(s => s.w))];
      const faces = [...new Set(ok.map(s => s.f))];
      if (breakSlot) {
        assert.ok(widths.length > 1, `${label}: sampler must see the slot resize (${widths})`);
        continue;
      }
      assert.deepEqual(widths.length, 1, `${label}: one speed width through every state (${widths})`);
      assert.ok(ok.every(s => !s.ov), `${label}: no overflow sampled`);
      for (const re of [/^think\|思考 /, /^bolt\|生成 ≈/, /^tool\|读取 /, /^bolt\|\d/]) {
        assert.ok(faces.some(f => re.test(f)), `${label}: face ${re} sampled (${faces.join(' / ')})`);
      }
    }
  });
});

/* ---------- 精简主题工具栏速率 chip（.zu-tsb）走完整数据链（specs/speed-chip-stable-slot.md） ----------
 * 宿主工具行同构（packages/ui/src/prompt-editor/ChatPromptEditor.tsx + useComposerToolbarFit.ts）：前导区可用宽度 =
 * flex:1 的 [data-composer-leading-actions]；前导内容 = 宿主按钮（可压缩的 Plan、cua）+ 本插件 chip，不收缩；尾随区在右。
 * 宿主压缩只模拟第一级：完整布局放不下时把 Plan 的文字收成图标（data-composer-compact），从完整布局量、状态粘滞，
 * 由 ResizeObserver / MutationObserver 在本插件 chip 插入之后的后续帧触发——与真宿主同一时序。 */
function tsbGeo() {
  const chip = document.querySelector('#pane-a .zu-tsb');
  if (!chip) return null;
  const r = e => { if (!e) return null; const b = e.getBoundingClientRect(); return [b.left, b.top, b.width, b.height].map(x => Math.round(x * 100) / 100); };
  const r2 = x => Math.round(x * 100) / 100;
  const lead = chip.closest('[data-composer-leading-actions]'), content = chip.closest('[data-composer-leading-content]'), root = lead && lead.parentElement;
  const live = chip.querySelector('.zu-live'), lab = chip.querySelector('.zu-sp-label'), val = chip.querySelector('.zu-sp-val'), unit = chip.querySelector('.zu-sp-unit');
  const shown = e => !!e && getComputedStyle(e).display !== 'none';
  const items = live ? [...live.children].filter(shown) : [];
  const cs = getComputedStyle(chip), box = chip.getBoundingClientRect();
  return { chip: r(chip), cua: r(chip.previousElementSibling), git: r(chip.nextElementSibling), plan: r(root && root.querySelector('.hplan')),
    room: lead ? r2(lead.getBoundingClientRect().width - (content.getBoundingClientRect().width - box.width)) : null,
    hostCompact: !!(root && (root.querySelector('[data-composer-compact]') || root.dataset.composerModelIcon || root.dataset.composerProviderCompact)),
    everCompact: !!window.__hostEverCompact,
    tier: chip.classList.contains('zu-speed-tight') ? 'tight' : chip.classList.contains('zu-speed-mid') ? 'mid' : 'wide',
    label: lab.textContent, value: val.textContent, unit: unit ? unit.textContent : null, unitShown: shown(unit), labelShown: shown(lab),
    slack: items.length ? r2((box.right - parseFloat(cs.paddingRight)) - items[items.length - 1].getBoundingClientRect().right) : null,
    labelClipped: shown(lab) && lab.scrollWidth > lab.clientWidth + 0.5,
    edge: r2((shown(unit) ? unit : val).getBoundingClientRect().right), labelLeft: shown(lab) ? r2(lab.getBoundingClientRect().left) : null,
    sameNode: chip === window.__tsbRef, aria: chip.getAttribute('aria-label'), icon: !!chip.querySelector('.ico'), focusable: chip.tabIndex };
}
/* 逐档 × 逐状态面量精简 chip：数值不越界、标签不被裁。例外只有中等档装不下的三个长标签面（两个「×12 + 四位数」、
 * 长技能名）——标签省略号是设计内的降级（完整文字在 tooltip 与 aria-label）。量完还原。 */
function tsbFaceProbe(faces) {
  const chip = document.querySelector('#pane-a .zu-tsb'), save = { html: chip.innerHTML, cls: chip.className }, bad = [];
  const clipOk = { mid: ['代理×12 1286.5', 'en Agt×12 1286.5', '技能 代码审查与修复 12s'] };
  const r2 = x => Math.round(x * 100) / 100;
  try {
    for (const [tier, cls] of [['wide', ''], ['mid', 'zu-speed-mid'], ['tight', 'zu-speed-tight']]) {
      chip.className = 'zu-tsb' + (cls ? ' ' + cls : '');
      for (const [key, html] of Object.entries(faces)) {
        chip.innerHTML = '<span class="zu-live">' + html + '</span>';
        const cs = getComputedStyle(chip), box = chip.getBoundingClientRect(), live = chip.querySelector('.zu-live'), lab = chip.querySelector('.zu-sp-label');
        const shown = e => getComputedStyle(e).display !== 'none';
        const items = [...live.children].filter(shown);
        const slack = r2((box.right - parseFloat(cs.paddingRight)) - items[items.length - 1].getBoundingClientRect().right);
        const clipped = shown(lab) && lab.scrollWidth > lab.clientWidth + 0.5;
        if (slack < -0.05 || (clipped && !(clipOk[tier] || []).includes(key))) bad.push([tier, key, slack, clipped]);
      }
    }
  } finally { chip.className = save.cls; chip.innerHTML = save.html; }
  return bad;
}

test('speed slot in the compact toolbar chip through the live data chain (isolated fixture)', { skip: skipReason, timeout: 180000 }, async t => {
  const b = await startBrowser(t);
  const hostToolbar = '<div class="group/toolbar htb"><div class="hla" data-composer-leading-actions><div class="hlc" data-composer-leading-content>' +
    '<button class="hplan" data-composer-collapse-priority="2">Plan</button><button class="hcua" data-testid="v4-composer-cua-entry">CUA</button></div></div>' +
    '<div class="hta" data-composer-trailing-actions><span><button data-testid="chat-context-usage-trigger" aria-label="上下文总量 200,000"><svg width="16" height="16"><circle></circle><circle></circle></svg></button></span></div></div>';
  const hostCss = '.htb{display:flex;align-items:center;gap:12px}.hla{display:flex;flex:1 1 0%;min-width:0;align-items:center}' +
    '.hlc{display:flex;flex:0 0 auto;align-items:center;gap:4px}.hplan{width:110px;height:24px}.hplan.wide{width:150px}.hplan[data-composer-compact]{width:36px}' +
    '.hcua{width:90px;height:24px}.hta{margin-left:auto;display:flex;flex:0 0 auto;align-items:center;justify-content:flex-end;gap:6px}';
  const gitState = { ok: true, ts: 0, branch: 'main', ins: 3, del: 1, staged: 0, unstaged: 2, untracked: 0, conflicts: 0, changed: 2,
    repoPath: '/repo/a', op: null, upstream: null, ahead: 1, behind: 0, detached: false, noCommits: false };
  const noQuota = Object.assign({}, payload, { quota: null });
  const H = (state, extra) => `P.header(${JSON.stringify(state)}, ${JSON.stringify(extra || {})})`;
  const T = text => `P.text(${JSON.stringify(text)})`;
  const TOOL = (status, extraSrc) => `P.tool(${JSON.stringify(status)}, ${extraSrc})`;
  const push = (seq, rows) => b.evaluate(`(() => { const P = window.__liveProbe; P.store.set(P.snap(${seq}, [${rows.join(', ')}])); return true; })()`);
  const geo = async () => {
    await b.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    return b.evaluate(`(${tsbGeo.toString()})()`);
  };
  const face = label => b.waitFor(`(() => {
    const c = document.querySelector('#pane-a .zu-tsb'); const l = c && c.querySelector('.zu-sp-label'), v = c && c.querySelector('.zu-sp-val');
    return !!l && !!v && l.textContent === ${JSON.stringify(label)}${label ? '' : " && !/≈/.test(v.textContent)"};
  })()`, `speed face "${label}" did not appear`, 600);
  /* 装载：精简主题 + 宿主同构工具行 + 实时数据链（桥接口 → turn-stats.js → overlay.js），分栏先开到 900px。等全部
   * chip 挂齐、宿主与 Git chip 的档位稳定后，targetRoom 给定时按实测空位换算分栏宽度（空位 = 前导区 − 同区其它内容，
   * 随分栏宽度线性变化）。最后把速率 chip 摘掉让它在最终布局里重新挂载——挂载当拍的档位判定才是被测对象。 */
  const settle = async (ms = 450) => {
    await b.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await delay(ms);
  };
  const setup = async targetRoom => {
    await b.call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
    const token = Math.random().toString(36).slice(2);
    await b.call('Page.navigate', { url: b.url + '?case=' + token });
    await b.waitFor(`document.readyState === "complete" && location.search === '?case=${token}'`);
    await b.evaluate(`(() => {
      document.body.innerHTML = ${JSON.stringify(fixtureHtml)};
      localStorage.clear(); localStorage.setItem('zusage3.theme', 'compact');
      const pane = document.getElementById('pane-a'); document.getElementById('pane-b').remove();
      pane.style.width = '900px';
      pane.querySelector('[class*="group/toolbar"]').outerHTML = ${JSON.stringify(hostToolbar)};
      const attrs = { 'data-zusage-scope-version': '1', 'data-zusage-pane-id': 'a', 'data-zusage-workspace-path': '/repo/a', 'data-zusage-workspace-identity': '', 'data-zusage-remote-session-id': '' };
      for (const [k, v] of Object.entries(attrs)) pane.setAttribute(k, v);
      const style = document.createElement('style'); style.textContent = ${JSON.stringify(hostCss)}; document.head.appendChild(style);
      window.__hostEverCompact = false;
      const root = pane.querySelector('.htb');
      const fit = () => {   // 宿主第一级压缩：从完整布局量（Plan 的完整宽度默认 110，用例可用 data-full 改）、状态粘滞
        const lead = root.querySelector('[data-composer-leading-actions]'), content = root.querySelector('[data-composer-leading-content]'), plan = root.querySelector('.hplan');
        if (content.getBoundingClientRect().width - plan.getBoundingClientRect().width + (Number(plan.dataset.full) || 110) > lead.getBoundingClientRect().width + 0.01) {
          plan.dataset.composerCompact = 'true'; window.__hostEverCompact = true;
        } else delete plan.dataset.composerCompact;
      };
      const ro = new ResizeObserver(fit);
      ro.observe(root);
      root.querySelectorAll('[data-composer-leading-actions],[data-composer-leading-content],[data-composer-trailing-actions]').forEach(e => ro.observe(e));
      new MutationObserver(fit).observe(root.querySelector('[data-composer-leading-content]'), { childList: true, subtree: true, characterData: true });
      fit();
    })()`);
    await b.evaluate(`(${liveProbeBoot.toString()})()`);
    await b.evaluate(turnStats);
    await b.evaluate(overlay);
    await b.waitFor(`document.querySelectorAll('.zusage-root').length === 1`, 'bar did not mount');
    await b.evaluate(`window.__zusageUpdate(${JSON.stringify(noQuota)})`);   // 不带额度数据：额度 chip 不挂载，尾随区定宽
    await b.waitFor(`document.querySelectorAll('.zu-tsb').length === 1`, 'rate chip did not mount');
    await b.evaluate(`window.__zusageGitState('/repo/a', Object.assign(${JSON.stringify(gitState)}, { ts: Date.now() }))`);   // ts 过期则不挂载
    await b.waitFor(`!!document.querySelector('#pane-a .zu-git')`, 'git chip did not mount beside the rate chip');
    await settle();
    let paneWidth = 900;
    if (targetRoom !== undefined) {
      const r0 = (await geo()).room;
      paneWidth = Math.round(900 - (r0 - targetRoom));
      await b.evaluate(`document.getElementById('pane-a').style.width = '${paneWidth}px'`);
      /* 收窄的过渡期：宿主先压缩、chip 每 250ms 让一档、最后宿主再展开，整个过渡在半秒内。等三方稳定
       * （连续 6 次读数相同，约 1.8 秒）再重挂 chip。 */
      let last = '', same = 0;
      for (let i = 0; i < 50 && same < 6; i++) {
        await delay(300);
        const s = await geo(), key = `${s.tier}|${s.hostCompact}|${Math.round(s.room)}`;
        same = key === last ? same + 1 : 0; last = key;
      }
      assert.equal(same, 6, `layout did not settle at target room ${targetRoom} (${last})`);
    }
    await b.evaluate(`(() => { window.__hostEverCompact = false; document.querySelector('#pane-a .zu-tsb').remove(); return true; })()`);
    await b.waitFor(`(() => { const c = document.querySelector('#pane-a .zu-tsb'); return !!c && c.nextElementSibling && c.nextElementSibling.classList.contains('zu-git'); })()`, 'rate chip did not remount immediately left of the git chip');
    await b.evaluate(`(() => { window.__tsbRef = document.querySelector('#pane-a .zu-tsb'); return true; })()`);
    return paneWidth;
  };
  const bind = () => b.evaluate(`(() => { const P = window.__liveProbe; P.store = P.mkStore(P.snap(1, [P.header('running'), P.text('abc')]));
    P.sessions.push({ key: '__base__ /repo/a', topic: 'conversation/sid_a', store: P.store }); return true; })()`);
  /* 思考 → 生成（数值换三次）→ 读取 → 生成 → 完成，返回各态上屏后的几何 */
  async function runChain() {
    await bind();
    await face('思考');
    const g = { think: await geo() };
    await delay(500);
    await push(2, [H('running'), T('abcdef')]);
    await face('生成');
    g.estimate = await geo();
    g.estimateTicks = [];
    for (const [i, text] of ['abcdefghi', 'abcdefghijkl', 'abcdefghijklmnopq'].entries()) {
      await delay(300);
      await push(3 + i, [H('running'), T(text)]);
      await delay(130);
      g.estimateTicks.push(await geo());
    }
    await delay(500);
    await push(6, [H('running'), T('abcdefghijklmnopq'), TOOL('running', '{ startedAt: Date.now() }')]);
    await face('读取');
    g.tool = await geo();
    await delay(500);
    await push(7, [H('running'), T('abcdefghijklmnopqrstuvwx'), TOOL('completed', '{ startedAt: Date.now() - 1500 }')]);
    await face('生成');
    g.estimate2 = await geo();
    await push(8, [H('completedSuccess', { outputTokens: 1000, modelDurationMs: 4000, activeMs: 5000 }), T('abcdefghijklmnopqrstuvwx')]);
    await face('');
    g.final = await geo();
    return g;
  }
  function assertStableSlot(g, label, tier) {
    const all = [g.think, g.estimate, ...g.estimateTicks, g.tool, g.estimate2, g.final];
    assert.ok(all.every(Boolean), `${label}: rate chip present in every state`);
    assert.deepEqual([g.think.label, g.estimate.label, g.tool.label, g.final.label], ['思考', '生成', '读取', ''], `${label}: labels`);
    assert.match(g.estimate.value, /^≈\d/, `${label}: estimate shows ≈ value`);
    assert.doesNotMatch(g.final.value, /≈/, `${label}: final shows the real speed without ≈`);
    for (const snap of all) {
      assert.equal(snap.tier, tier, `${label}: tier ${tier} throughout (${snap.label}|${snap.value})`);
      assert.ok(snap.sameNode, `${label}: chip node survives every state (tooltip anchor not recreated)`);
      assert.equal(snap.icon, false, `${label}: the compact chip carries no icon — state is conveyed by the label text and aria-label`);
      assert.equal(snap.focusable, 0, `${label}: chip is keyboard reachable (tooltip on focus)`);
      assert.match(snap.aria || '', /^生成速度 .+/, `${label}: full aria-label`);
      assert.ok(snap.slack >= -0.05, `${label}: value stays inside the chip (${snap.label}|${snap.value} slack ${snap.slack})`);
      assert.equal(snap.labelClipped, false, `${label}: short label not clipped (${snap.label})`);
      assert.equal(snap.unitShown, tier === 'wide' && !!snap.unit, `${label}: unit shown only in the wide tier, and only for faces that have one`);
      assert.equal(snap.labelShown, tier !== 'tight', `${label}: label hidden only in the tight tier`);
    }
    for (const key of ['chip', 'cua', 'git', 'plan']) {
      for (const snap of all) assert.deepEqual(snap[key], g.think[key], `${label}: ${key} box unchanged across ${snap.label}|${snap.value}`);
    }
    for (const snap of all) {
      assert.equal(snap.edge, g.think.edge, `${label}: value right edge fixed (${snap.label}|${snap.value})`);
      if (snap.labelLeft !== null) assert.equal(snap.labelLeft, g.think.labelLeft, `${label}: label left edge fixed (${snap.label})`);
    }
    for (const snap of all) assert.equal(snap.hostCompact, g.think.hostCompact, `${label}: host compaction state unchanged across the chain`);
  }

  /* 宽裕 161.2 / 中等 126.1 / 紧张 85.8px（chip 字号 13px）：空位决定档位；挂载当拍就选对档，chip 先让位，宿主按钮不被压缩 */
  for (const [name, room, tier] of [['wide tier', 275, 'wide'], ['mid tier', 140, 'mid'], ['tight tier', 100, 'tight'], ['narrower than the tight tier', 20, 'tight']]) {
    await t.test(`${name}: one chip width through 思考 → 生成 → 读取 → 生成 → 完成; neighbours and host controls stay put`, async () => {
      await setup(room);
      const g0 = await geo();
      assert.equal(g0.tier, tier, `${name}: tier chosen at mount (room ${g0.room}px)`);
      const g = await runChain();
      assertStableSlot(g, name, tier);
      if (tier !== 'tight' || room >= 85.8) {
        assert.equal(g0.hostCompact, false, `${name}: host controls not compacted at mount`);
        assert.equal(g.final.everCompact, false, `${name}: host compaction never observed from remount to the end`);
      }
    });
  }

  await t.test('control: with the chip pinned at the wide width the host does compact — so "never compacted" above is the chip yielding', async () => {
    await setup(140);
    assert.equal((await geo()).hostCompact, false);
    await b.evaluate(`(() => { const s = document.createElement('style'); s.id = 'pin-wide'; s.textContent = '.zu-tsb{width:12.4em!important}'; document.head.appendChild(s); return true; })()`);
    await settle();
    assert.equal((await geo()).hostCompact, true, 'host compacts its own controls when the chip does not yield');
    await b.evaluate(`document.getElementById('pin-wide').remove()`);
    await settle();
    assert.equal((await geo()).hostCompact, false, 'host expands again once the chip yields');
  });

  await t.test('widening the pane raises the tier back within a few seconds and then settles', async () => {
    const pane = await setup(100);
    assert.equal((await geo()).tier, 'tight');
    await b.evaluate(`document.getElementById('pane-a').style.width = '${pane + 300}px'`);
    await b.waitFor(`(() => { const c = document.querySelector('#pane-a .zu-tsb'); return !!c && !c.classList.contains('zu-speed-mid') && !c.classList.contains('zu-speed-tight'); })()`, 'tier did not rise back to wide', 200);
    const seen = [];
    for (let i = 0; i < 6; i++) { const s = await geo(); seen.push([s.tier, s.hostCompact]); await delay(500); }
    assert.ok(seen.every(([x, c]) => x === 'wide' && !c), `stays wide with host controls expanded (${JSON.stringify(seen)})`);
  });

  await t.test('repeated layout changes (pane width, host button width) always settle: no flip-flop between host, git chip and rate chip', async () => {
    const pane = await setup(275);
    const steps = [[pane - 140, false], [pane - 190, false], [pane - 250, true], [pane - 320, true], [pane - 200, true], [pane - 90, false], [pane, false]];
    for (const [width, wide] of steps) {
      await b.evaluate(`(() => { document.getElementById('pane-a').style.width = '${width}px';
        const p = document.querySelector('#pane-a .hplan'); p.classList.toggle('wide', ${wide}); if (${wide}) p.dataset.full = '150'; else delete p.dataset.full; return true; })()`);
      const seen = [];
      for (let i = 0; i < 12; i++) { await delay(250); const g = await geo(); seen.push([g.tier, g.hostCompact, Math.round(g.git[2]), Math.round(g.room)]); }
      const tail = JSON.stringify(seen.slice(-6));
      assert.equal(new Set(seen.slice(-6).map(x => JSON.stringify(x))).size, 1, `width ${width}, host button ${wide ? 'wide' : 'normal'}: settled for the last 1.5s (${JSON.stringify(seen)})`);
      const [tier, compact, , room] = seen[seen.length - 1];
      if (!compact) assert.ok(room + 0.5 >= [161.2, 126.1, 85.8][['wide', 'mid', 'tight'].indexOf(tier)], `${tail}: chip fits the room it settled in`);
      else assert.equal(tier, 'tight', `${tail}: the host only stays compacted once the chip cannot yield more`);
    }
  });

  await t.test('host compaction not caused by the chip: chip yields one tier, host expands again, chip does not climb back (no tug-of-war)', async () => {
    await setup(170);   // 宽裕档 161.2 装得下
    assert.equal((await geo()).tier, 'wide');
    /* 钉住 Git chip 的宽度（否则它也按自己的档位收缩，三方一起动就看不清「宿主 ↔ 速率 chip」这一条链） */
    await b.evaluate(`(() => {
      const s = document.createElement('style'); s.id = 'pin-git'; s.textContent = '#pane-a .zu-git{width:137px!important;min-width:137px!important}'; document.head.appendChild(s);
      const p = document.querySelector('#pane-a .hplan'); p.dataset.full = '150'; p.classList.add('wide');   // 宿主自己的按钮变宽 40px：空位 130，宽裕档放不下
      return true;
    })()`);
    await b.waitFor(`!!document.querySelector('#pane-a .hplan[data-composer-compact]')`, 'host did not compact its own control', 80);
    await b.waitFor(`document.querySelector('#pane-a .zu-tsb').classList.contains('zu-speed-mid')`, 'chip did not yield to the mid tier', 80);
    await b.waitFor(`!document.querySelector('#pane-a .hplan[data-composer-compact]')`, 'host controls did not expand again after the chip yielded', 80);
    const seen = [];
    for (let i = 0; i < 10; i++) { await delay(500); const s = await geo(); seen.push([s.tier, s.hostCompact]); }
    assert.ok(seen.every(([x, c]) => x === 'mid' && !c), `stays at mid with host controls expanded for 5s, past the 2s dwell (${JSON.stringify(seen)})`);
  });

  await t.test('the live width probe (tests/speed-slot-live-probe.js) measures the three compact chip tiers here and restores the chip', async () => {
    await setup(275);
    const probeSrc = fs.readFileSync(path.join(__dirname, 'speed-slot-live-probe.js'), 'utf8');
    const before = await b.evaluate(`(() => { const c = document.querySelector('#pane-a .zu-tsb'); return [c.className, c.innerHTML]; })()`);
    const out = await b.evaluate(probeSrc);
    const rows = Object.entries(out.tiers).filter(([name]) => name.includes('精简'));
    assert.equal(rows.length, 9, `3 interface font sizes × 3 compact tiers (${Object.keys(out.tiers).join(', ')})`);
    for (const [name, r] of rows) {
      assert.equal(r.speedW.length, 1, `${name}: one chip width (${r.speedW})`);
      assert.ok(r.turnL.length <= 1, `${name}: neighbour stays put (${r.turnL})`);
      assert.deepEqual(r.overflow, [], `${name}: no value crosses the chip edge`);
    }
    for (const [tier, [lo, hi]] of Object.entries({ 宽裕: [160, 180], 中等: [112, 132], 紧张: [72, 88] })) {
      const w = out.tiers['14px 精简 ' + tier].speedW[0];
      assert.ok(w >= lo && w <= hi, `14px 精简 ${tier}: ${w}px outside ${lo}–${hi}`);
    }
    assert.deepEqual(await b.evaluate(`(() => { const c = document.querySelector('#pane-a .zu-tsb'); return [c.className, c.innerHTML]; })()`), before, 'chip restored after the probe');
  });

  await t.test('every face fits its tier box under six font stacks; only three long-label faces clip in the mid tier', async () => {
    await setup(275);
    const F = (label, val, unit) => `<span class="zu-sp-label">${label}</span><span class="zu-sp-val">${val}</span>${unit ? `<span class="zu-sp-unit dim">${unit}</span>` : ''}`;
    const faces = {
      '完成 92': F('', '92', 't/s'), '完成 250.0': F('', '250.0', 't/s'), '回退 历史 201.4': F('历史', '201.4', 't/s'),
      '估算 128.6': F('生成', '≈128.6', 't/s'), '估算 9999.9': F('生成', '≈9999.9', 't/s'), '估算 12.9k': F('生成', '≈12.9k', 't/s'),
      '思考 0.5s': F('思考', '0.5s'), '思考 23:59:59': F('思考', '23:59:59'), '思考 1:05:00': F('思考', '1:05:00'), '思考 1天3时': F('思考', '1天3时'),
      '读取 01s': F('读取', '01s'), '查阅 03s': F('查阅', '03s'), '终端 12s': F('终端', '12s'), '技能 代码审查与修复 12s': F('代码审查与修复', '12s'),
      '代理 1286.5': F('代理', '≈1286.5', 't/s'), '代理×3 28.8': F('代理×3', '≈28.8', 't/s'), '代理×12 1286.5': F('代理×12', '≈1286.5', 't/s'),
      'en Hist 201.4': F('Hist', '201.4', 't/s'), 'en Gen 9999.9': F('Gen', '≈9999.9', 't/s'), 'en Think 23:59:59': F('Think', '23:59:59'),
      'en Agt×12 1286.5': F('Agt×12', '≈1286.5', 't/s'), 'en Scan 03s': F('Scan', '03s'),
    };
    const stacks = ['', '"Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif', 'Verdana, Tahoma, sans-serif',
      '"PingFang SC", "Hiragino Sans GB", "Heiti SC", sans-serif', '"Songti SC", "STSong", serif', 'Menlo, Consolas, monospace'];
    for (const stack of stacks) {
      await b.evaluate(stack ? `document.documentElement.style.setProperty('--font-sans', ${JSON.stringify(stack)})` : `document.documentElement.style.removeProperty('--font-sans')`);
      const bad = await b.evaluate(`(${tsbFaceProbe.toString()})(${JSON.stringify(faces)})`);
      assert.deepEqual(bad, [], `${stack.slice(0, 28) || 'default stack'}: clipped or overflowing faces`);
    }
  });
});
