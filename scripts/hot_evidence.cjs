#!/usr/bin/env node
/* 热重载取证（开发侧工具，不进任何分发清单）：经本机调试端口读每个页面里的浮层代际与版本，
 * 输出一行 JSON，供 scripts/deploy_hot.py 在部署前后各取一次做比对。只读，除这一条求值外不发别的命令。
 *
 * 用法：node scripts/hot_evidence.cjs [端口]    端口默认 9229（inject-main.cjs 顶层开启的 remote-debugging-port）
 * 调试端口不可达，或当前 Node 没有内置 fetch/WebSocket 时，非零退出并在 stderr 说明原因。 */
'use strict';

const port = Number(process.argv[2] || 9229);
const EXPRESSION = 'JSON.stringify({gen: window.__zusageGen ?? null,'
  + ' version: (window.__zusageDiag && window.__zusageDiag.version) || null})';
const EVAL_TIMEOUT_MS = 5000;

function evaluate(target) {
  return new Promise((resolve) => {
    const base = { title: String(target.title || ''), url: String(target.url || '') };
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const timer = setTimeout(() => { ws.close(); resolve({ ...base, error: 'timeout' }); }, EVAL_TIMEOUT_MS);
    const done = (row) => { clearTimeout(timer); try { ws.close(); } catch (_) { /* 已关闭 */ } resolve(row); };
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: EXPRESSION, returnByValue: true } }));
    });
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      let value = null;
      try { value = JSON.parse(message.result && message.result.result && message.result.result.value); } catch (_) { /* 页面里没有浮层 */ }
      done(value ? { ...base, gen: value.gen, version: value.version } : { ...base, error: 'no overlay' });
    });
    ws.addEventListener('error', () => done({ ...base, error: 'socket error' }));
  });
}

async function main() {
  if (typeof fetch !== 'function' || typeof WebSocket !== 'function') {
    console.error('当前 Node 没有内置 fetch/WebSocket（需要 Node 22 及以上）');
    process.exit(2);
  }
  let targets;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
    targets = (await response.json()).filter((target) => target.type === 'page' && target.webSocketDebuggerUrl);
  } catch (error) {
    console.error(`调试端口 ${port} 不可达：${error.message}`);
    process.exit(2);
  }
  console.log(JSON.stringify(await Promise.all(targets.map(evaluate))));
}

main();
