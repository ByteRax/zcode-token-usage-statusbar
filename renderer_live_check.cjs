#!/usr/bin/env node
/* 手动验收工具（不进入任何发布白名单）：复制宿主应用到临时目录、换入补丁 ASAR、
 * 带 --remote-debugging-port 启动，用 CDP 在真实 renderer 中验证只读访问器：
 * 模块加载、scope 命中、快照读取、订阅通知。结束后杀进程并清理副本。 */
'use strict';
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const WORKTREE = __dirname;   // 仓库根（曾硬编码原维护者机器的 worktree，其它环境必失败）
const HOST_ASAR = '/Applications/ZCode.app/Contents/Resources/app.asar';
const HOST_APP = '/Applications/ZCode.app';
const LIVE_DIR = path.join(os.tmpdir(), 'zusage-live-check');
const LIVE_APP = path.join(LIVE_DIR, 'ZUsageLive.app');
const PORT = 9333;

function log(step, detail) { console.log(`[live-check] ${step}${detail ? ': ' + detail : ''}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForPage(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const pages = list.filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
      if (pages.length) return pages;
    } catch (_) { /* not up yet */ }
    await sleep(1000);
  }
  throw new Error('renderer page target not found in time');
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  return new Promise((resolve, reject) => {
    ws.onerror = () => reject(new Error('cdp socket error'));
    ws.onopen = () => resolve({
      evaluate: (expression) => new Promise((res) => {
        const id = ++seq;
        pending.set(id, res);
        ws.send(JSON.stringify({ id, method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true } }));
      }),
      close: () => ws.close(),
    });
  });
}

const VERIFY = `(async () => {
  const api = globalThis.__zusageGetExistingConversationStore;
  const diagFn = globalThis.__zusageConversationDiagnostics;
  const report = { hasApi: typeof api === 'function', hasDiagnostics: typeof diagFn === 'function',
    location: location.href, title: document.title };
  if (!diagFn) return report;
  const diag = diagFn();
  report.keys = diag.keys; report.sessions = diag.sessions;
  report.attempts = [];
  if (!api) return report;
  let best = null;
  for (const item of diag.sessions) {
    const sid = String(item.topic).startsWith('conversation/') ? String(item.topic).slice(13) : String(item.topic);
    const space = String(item.key).indexOf(' ');
    const remote = space < 0 ? '__base__' : String(item.key).slice(0, space);
    const workspace = space < 0 ? '' : String(item.key).slice(space + 1);
    const scopes = remote === '__base__'
      ? [{ sessionId: sid, workspacePath: workspace }, { sessionId: sid, workspaceIdentity: workspace }]
      : [{ sessionId: sid, workspacePath: workspace, remoteSessionId: remote },
         { sessionId: sid, workspaceIdentity: workspace, remoteSessionId: remote }];
    for (const scope of scopes) {
      let handle = null, error = null, snap = null;
      try { handle = api(scope); } catch (e) { error = String((e && e.message) || e); }
      if (handle) { try { snap = handle.getState(); } catch (e) { error = String((e && e.message) || e); } }
      const snapshot = snap && snap.snapshot ? {
        sessionId: snap.sessionId, seq: snap.snapshot.seq, status: snap.status,
        rows: snap.snapshot.rows && Array.isArray(snap.snapshot.rows.window) ? snap.snapshot.rows.window.length : null,
        kinds: snap.snapshot.rows && Array.isArray(snap.snapshot.rows.window)
          ? snap.snapshot.rows.window.slice(0, 12).map((r) => r && r.kind) : null } : null;
      report.attempts.push({ scope, matched: !!handle, error, snapshot });
      if (handle && !best && snapshot) best = { scope, handle };
      else if (handle) handle.off();
    }
  }
  if (best) {
    let notifications = 0;
    const off = best.handle.subscribe(() => { notifications += 1; });
    await new Promise((resolve) => Promise.resolve().then(resolve));
    await new Promise((resolve) => setTimeout(resolve, 6000));
    off(); best.handle.off();
    report.liveSubscribe = { scope: best.scope, notifications, frozen: true };
  }
  return report;
})()`;

async function main() {
  const report = { startedAt: new Date().toISOString() };
  try {
    fs.rmSync(LIVE_DIR, { recursive: true, force: true });
    fs.mkdirSync(LIVE_DIR, { recursive: true });
    const patched = path.join(LIVE_DIR, 'patched.asar');
    log('patch', `writing isolated patched archive`);
    execFileSync('python3', [path.join(WORKTREE, 'renderer_bridge.py'), 'patch', HOST_ASAR, patched],
                 { stdio: 'inherit' });
    log('copy', `duplicating host app (read-only source)`);
    execFileSync('cp', ['-R', HOST_APP, LIVE_APP], { stdio: 'inherit' });
    execFileSync('cp', [patched, path.join(LIVE_APP, 'Contents/Resources/app.asar')], { stdio: 'inherit' });
    // Modified archive invalidates the original signature; re-sign ad-hoc so macOS
    // launches the throwaway copy instead of showing an "app is damaged" dialog.
    log('codesign', 'ad-hoc re-sign of the temporary copy only');
    execFileSync('xattr', ['-dr', 'com.apple.quarantine', LIVE_APP], { stdio: 'inherit' });
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', LIVE_APP], { stdio: 'inherit' });
    // Isolated HOME: the running real instance must not be disturbed, and the copy
    // must not contend for the real user's data locks. Login state is carried via a copy.
    const home = path.join(LIVE_DIR, 'home');
    fs.mkdirSync(path.join(home, 'Library/Application Support'), { recursive: true });
    // 登录态取本机当前用户（曾硬编码原维护者 HOME，其它机器上必失败）
    execFileSync('cp', ['-R', path.join(os.homedir(), 'Library/Application Support/ZCode'),
      path.join(home, 'Library/Application Support/ZCode')], { stdio: 'inherit' });
    const binary = path.join(LIVE_APP, 'Contents/MacOS/ZCode');
    log('launch', `${binary} --remote-debugging-port=${PORT} (isolated HOME ${home})`);
    const child = spawn(binary, [`--remote-debugging-port=${PORT}`],
      { detached: true, stdio: 'ignore', env: { ...process.env, HOME: home } });
    child.unref();
    const pages = await waitForPage(120000);
    report.pages = pages.map((p) => ({ title: p.title, url: p.url.slice(0, 120) }));
    log('pages', report.pages.map((p) => p.title).join(' | '));
    for (const page of pages.slice(0, 2)) {
      log('verify', page.title);
      const session = await cdp(page.webSocketDebuggerUrl);
      const result = await session.evaluate(VERIFY);
      report.results = report.results || [];
      report.results.push({ page: page.title, result });
      log('result', JSON.stringify({ hasApi: result.hasApi, keys: result.keys, sessions: result.sessions,
        matched: (result.attempts || []).filter((a) => a.matched).length,
        notifications: result.liveSubscribe && result.liveSubscribe.notifications }));
      session.close();
    }
    if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch (_) {} try { child.kill('SIGTERM'); } catch (_) {} }
    await sleep(2000);
  } finally {
    fs.rmSync(LIVE_DIR, { recursive: true, force: true });
    log('cleanup', 'temporary app copy removed');
  }
  report.finishedAt = new Date().toISOString();
  const out = path.join(WORKTREE, '.baseline', 'live-check.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  log('report', out);
}
main().catch((error) => { console.error('[live-check] failed:', error); process.exitCode = 1; });
