'use strict';
/* 生成速度 Tooltip 真实 Electron 视觉/几何 QA harness（QA 专用，非分发清单成员）。
 * 运行见 README.md。要点：
 * - 运行目录 overlay.js 原文注入（真实 IIFE/CSS/状态条）；
 * - SPD_V2 纯函数块 + TPS_BANDS/tpsBand/tpsBandText + Portal/档位浮层宿主函数原文切片装配；
 * - 夹具确定性表驱动（无随机数），轮表 delta 编码（首轮绝对、其后增量）；
 * - live 实时链（2026-11-08）：生产同款 zusage.py serve 常驻泵拉真实当前会话快照，
 *   泵帧直推 overlay __zusageUpdate（生产泵语义）；夹具步骤自动丢弃真实帧；
 * - 交互走 sendInputEvent 真实输入事件；几何断言（__zuDiag）优先于截图。
 * 环境变量：ZU_OVERLAY（默认 ~/.zcode/zcode-token-usage-statusbar/overlay.js）、
 *   ZU_ZUSAGE（默认同目录 zusage.py）、ZU_PYTHON（默认 python3）。
 */
const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const OUT = __dirname;
const OVERLAY_SRC = process.env.ZU_OVERLAY ||
  path.join(os.homedir(), '.zcode', 'zcode-token-usage-statusbar', 'overlay.js');
const ZUSAGE_PY = process.env.ZU_ZUSAGE ||
  path.join(os.homedir(), '.zcode', 'zcode-token-usage-statusbar', 'zusage.py');
const PYTHON = process.env.ZU_PYTHON || 'python3';

/* 从 overlay.js 原文做花括号配平提取（函数体切片，QA 用生产原码而非复刻） */
function extractBraced(src, startIdx) {
  let i = src.indexOf('{', startIdx);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) return src.slice(startIdx, i + 1); }
  }
  throw new Error('unbalanced braces at ' + startIdx);
}

function buildV2Slice() {
  const src = fs.readFileSync(OVERLAY_SRC, 'utf8');
  const a1 = src.indexOf('var TPS_BANDS = [');
  if (a1 < 0) throw new Error('TPS_BANDS not found — 确认 ZU_OVERLAY 指向运行目录 overlay.js');
  const tpsBands = src.slice(a1, src.indexOf('];', a1) + 2);
  const tpsBand = extractBraced(src, src.indexOf('function tpsBand('));
  const tpsBandText = extractBraced(src, src.indexOf('function tpsBandText('));
  const END = '/* SPD_V2_BLOCK_END */';
  const e = src.indexOf(END);
  if (e < 0) throw new Error('SPD_V2_BLOCK_END not found');
  const spdBlock = src.slice(src.indexOf('var SPD_RANGES'), e + END.length);
  /* Portal / 档位说明浮层宿主函数原文（含其依赖的模块级计时器变量声明） */
  const hostFns = extractBraced(src, src.indexOf('function spdHoverPortalHide(')) + '\n' +
    extractBraced(src, src.indexOf('function spdHoverPortalPlace(')) + '\n' +
    extractBraced(src, src.indexOf('function spdHoverPortalSync(')) + '\n' +
    extractBraced(src, src.indexOf('function spdLegendCardHTML(')) + '\n' +
    extractBraced(src, src.indexOf('function spdLegendTipHide(')) + '\n' +
    extractBraced(src, src.indexOf('function spdLegendTipScheduleHide(')) + '\n' +
    extractBraced(src, src.indexOf('function spdLegendTipShow(')) + '\n' +
    'var SPD_LEGEND_HIDE_MS = 180, spdLegendHideTimer = 0;';
  return tpsBands + '\n' + tpsBand + '\n' + tpsBandText + '\n' + spdBlock +
    '\nwindow.__SPD = { speedCardV2HTML: speedCardV2HTML, spdAnalyze: spdAnalyze,' +
    ' spdLegendCardHTML: spdLegendCardHTML, getPortal: function(){ return SPD_PORTAL; } };' +
    '\nwindow.__PORTAL_SRC = ' + JSON.stringify(hostFns) + ';';
}

app.setPath('userData', path.join(os.tmpdir(), 'zu-spd-host-ud-' + Date.now()));

/* host.html 模板中的 __OVERLAY_URL__ 替换为运行目录 overlay.js 的 file:// URL，
 * 生成 host.final.html（gitignore）后加载——页面以原文注入运行目录脚本。
 * URL 追加 ?v=<mtimeMs> 防陈旧缓存：部署后首跑曾出现渲染落后一拍的旧 CSS
 * （实测 2026-11-08），查询串改变缓存键且 file: 解析忽略之，成本为零。 */
function buildHostFinal() {
  const tpl = fs.readFileSync(path.join(OUT, 'host.html'), 'utf8');
  const url = 'file://' + path.resolve(OVERLAY_SRC).split(path.sep).join('/') +
    '?v=' + fs.statSync(OVERLAY_SRC).mtimeMs;
  fs.writeFileSync(path.join(OUT, 'host.final.html'), tpl.split('__OVERLAY_URL__').join(url));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- live 实时泵（生产 inject-main v8 同款 serve 行协议） ----------
 * spawn zusage.py serve，stdin 空行请求 = 最近活跃会话快照，stdout 一行 JSON 响应。
 * 请求-响应严格一对一，用 promise 队列对齐；serve 在 stdin EOF（harness 退出）自清理。 */
let pumpProc = null;
let pumpBuf = '';
let pumpWaiters = [];   // 每个请求的 resolve，按 FIFO 对齐响应行
let pumpMode = 'live';  // 当前步骤数据模式：live 步骤推帧，夹具步骤停推
let pumpLastPayload = null;

function startPump() {
  if (!fs.existsSync(ZUSAGE_PY)) return false;
  try {
    pumpProc = spawn(PYTHON, [ZUSAGE_PY, 'serve'], { windowsHide: true });
  } catch (e) {
    console.error('PUMP_SPAWN_FAIL', String(e).slice(0, 120));
    return false;
  }
  pumpProc.stdout.setEncoding('utf8');
  pumpProc.stdout.on('data', chunk => {
    pumpBuf += chunk;
    let idx;
    while ((idx = pumpBuf.indexOf('\n')) >= 0) {
      const line = pumpBuf.slice(0, idx);
      pumpBuf = pumpBuf.slice(idx + 1);
      const w = pumpWaiters.shift();
      if (w) w(line);
    }
  });
  pumpProc.stderr.setEncoding('utf8');
  pumpProc.stderr.on('data', d => console.error('PUMP_STDERR', String(d).slice(0, 160)));
  pumpProc.on('exit', (code) => { pumpProc = null; if (code && code !== 0) console.error('PUMP_EXIT', code); });
  return true;
}
function pumpRequest() {
  return new Promise(resolve => {
    pumpWaiters.push(resolve);
    try { pumpProc.stdin.write('\n'); } catch (e) { pumpWaiters.pop(); resolve(null); }
  });
}
/* 拉一帧真实快照并推给页面（mine=会话 SID，生产泵同款）；失败不中断链 */
async function pumpPushFrame(wc) {
  if (!pumpProc) return null;
  const line = await Promise.race([pumpRequest(), sleep(4000).then(() => null)]);
  if (line == null) return null;
  let snap;
  try { snap = JSON.parse(line); } catch (e) { return null; }
  if (snap.error || !snap.session || !snap.session.sid) return null;
  snap.mine = snap.session.sid;   // 生产泵 v34：payload.mine=窗口焦点会话
  /* 生产主桥推帧时补 remote_evidence（inject-main.cjs 同名字段）；QA 页无 renderer 桥、
   * 无远端证据 → false：overlay sessionFor 才允许按本地身份匹配（否则 fail-closed 全零） */
  snap.remote_evidence = false;
  pumpLastPayload = snap;
  await wc.executeJavaScript('window.__zusageUpdate(' + JSON.stringify(snap) + ')', true);
  return snap;
}
function stopPump() {
  if (pumpProc) { try { pumpProc.stdin.end(); } catch (e) { } pumpProc = null; }
}

/* 真实输入事件（页面坐标系）；每步开始先把指针归中性区，防上一步悬停残留污染 */
async function send(wc, type, x, y) {
  wc.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
  await sleep(80);
}
async function center(wc, expr) {
  const r = await wc.executeJavaScript(expr, true);
  return r ? { x: r.x + r.w / 2, y: r.y + r.h / 2 } : null;
}

async function runChain(wc, win, steps, log) {
  const preShots = {};   /* v299：turnTip 在开卡瞬间即拍（共享捕获窗口有收起竞态） */
  for (const st of steps) {
    pumpMode = (st.live || st.fixture === 'live') ? 'live' : 'fixture';
    await send(wc, 'mouseMove', 620, 140);   // 步前鼠标归中性区
    if (st.reload) {
      await win.loadFile(path.join(OUT, 'host.final.html'));
      await sleep(500);
      await wc.executeJavaScript('window.__zuReady(' + JSON.stringify(V2SLICE) + ')', true);
      await sleep(200);
    }
    await wc.executeJavaScript(`window.__zuScenario(${JSON.stringify(st)})`, true);
    await sleep(400);
    if (pumpMode === 'live') {
      /* live 步骤：拉真实当前会话快照推给页面（reload 后页面 live 缓存已清空，
       * 必须先到帧再 mount；夹具步骤不推，页面守卫丢弃在途帧） */
      const fr = await pumpPushFrame(wc);
      if (!fr) log.push({ shot: st.shot, liveErr: 'no live frame' });
      await sleep(400);
    }
    if (st.open !== false) {
      const ok = await wc.executeJavaScript(
        `window.__zuMount(${JSON.stringify(st.sel || {})}, ${st.hover == null ? -1 : st.hover})`, true);
      await sleep(st.wait || 500);
      if (!ok) { log.push({ shot: st.shot, error: 'mount failed' }); continue; }
      if (st.liveWait) {
        /* 实时观察窗口：挂卡状态下周期收帧，验证状态条/V2 卡随会话更新 */
        const end = Date.now() + st.liveWait;
        while (Date.now() < end) {
          await sleep(2000);
          if (pumpMode === 'live') await pumpPushFrame(wc);
        }
      }
    }
    for (const sel of (st.clicks || [])) {
      const p = await center(wc, `window.__zuRectOf(${JSON.stringify(sel)})`);
      if (!p) { log.push({ shot: st.shot, error: 'no ' + sel }); continue; }
      await send(wc, 'mouseMove', p.x, p.y);
      await send(wc, 'mouseDown', p.x, p.y);
      await send(wc, 'mouseUp', p.x, p.y);
      await sleep(st.clickWait || 650);
    }
    if (st.scrollEnd) {
      await wc.executeJavaScript('window.__zuScrollEnd()', true);
      await sleep(400);
    }
    if (st.wheel) {   /* v290：图表区滚轮 → 横滚。sendInputEvent('mouseWheel') 在此环境
      * 连原生滚动都不触发（实测 scrollLeft 恒 0），故用合成 WheelEvent 走
      * 复刻 tip 的生产同款委托（冒泡 + cancelable 等价真实滚轮路径） */
      const wr = await wc.executeJavaScript(`(function () {
        var wrap = document.querySelector('.zu-sc-wrap');
        if (!wrap) return { err: 'no wrap' };
        var ticks = ${st.wheel.ticks || 3}, dy = ${st.wheel.deltaY || 120};
        for (var i = 0; i < ticks; i++)
          wrap.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, bubbles: true, cancelable: true }));
        return { scrollW: wrap.scrollWidth, clientW: wrap.clientWidth, scrollLeft: wrap.scrollLeft };
      })()`, true);
      log.push({ shot: st.shot, wheelProbe: wr });
    }
    if (st.hoverLegend) {
      const lb = await center(wc, `window.__zuRectOf('.zu-sv-legend-btn')`);
      if (lb) { await send(wc, 'mouseMove', lb.x, lb.y); await sleep(650); }
    }
    if (st.hoverBar != null) {
      const b = await center(wc, `window.__zuBarRect(${st.hoverBar})`);
      if (b) { await send(wc, 'mouseMove', b.x, b.y); await sleep(600); }
    }
    if (st.hoverCell != null) {   /* v291：热力图格子悬停（data-i 定位） */
      const b = await center(wc, `window.__zuCellRect(${st.hoverCell})`);
      if (!b) { log.push({ shot: st.shot, error: 'no cell ' + st.hoverCell }); continue; }
      await send(wc, 'mouseMove', b.x, b.y); await sleep(600);
    }
    if (st.padProbe) {
      const probe = await wc.executeJavaScript(`(function(){
        var tips = document.querySelectorAll('.zusage-tip-root, .zusage-tps-tip'), tip = null;
        for (var i = 0; i < tips.length; i++) if (tips[i].offsetWidth > 0) { tip = tips[i]; break; }
        if (!tip) return { err: 'no visible tip', n: tips.length };
        var q = function(sel) { return tip.querySelector(sel); };
        var info = function(el, name) {
          if (!el) return null;
          var cs = getComputedStyle(el), r = el.getBoundingClientRect();
          return { name: name, pad: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].join(' '),
            rect: [Math.round(r.x), Math.round(r.width)].join('x'),
            ovf: [el.scrollWidth, el.clientWidth].join('/') };
        };
        var out = [info(tip, 'tipRoot:' + tip.className.slice(0, 60))];
        out.push(info(tip.firstElementChild, 'firstChild'));
        out.push(info(q('.zu-sv-root'), 'svRoot'));
        out.push(info(q('.zu-speed-body'), 'body'));
        out.push(info(q('.zu-sv-left'), 'left'));
        out.push(info(q('.zu-sv-chart'), 'chart'));
        out.push(info(q('.zu-sc-head'), 'chartHead'));
        out.push(info(q('.zu-sc-wrap'), 'wrap'));
        out.push(info(q('.zu-sv-bars'), 'bars'));
        out.push(info(q('.zu-sv-plotrow'), 'plotrow'));
        out.push(info(q('.zu-sv-gutcol'), 'gutcol'));
        out.push(info(q('.zu-sv-plot'), 'plot'));
        var sp = q('.zu-sv-spacer');
        out.push(sp ? { name: 'spacer', rect: [Math.round(sp.getBoundingClientRect().x), sp.style.width].join(' ') } : { name: 'spacer', rect: 'none' });
        var wrapEl = q('.zu-sc-wrap');
        out.push({ name: 'wrapScroll', rect: wrapEl ? wrapEl.scrollLeft + ' sl / ' + wrapEl.scrollWidth + ' sw / ' + wrapEl.clientWidth + ' cw' : null });
        var plotEl = q('.zu-sv-plot');
        if (plotEl) { var pcs = getComputedStyle(plotEl); out.push({ name: 'plotStyle', rect: [pcs.marginLeft, pcs.marginRight, pcs.borderLeftWidth, pcs.borderRightWidth, pcs.boxSizing, pcs.minWidth].join(' ') }); }
        out.push(info(q('.zu-sv-head'), 'svHead'));
        var tabs = tip.querySelectorAll('.zu-sv-tabs');
        if (tabs.length) out.push(info(tabs[tabs.length - 1], 'timeTabs'));
        var tr2 = tip.getBoundingClientRect();
        out.push({ name: 'gaps', rect: 'left=' + Math.round(tr2.left) + ' right=' + Math.round(window.innerWidth - tr2.right) + ' vw=' + window.innerWidth + ' w=' + Math.round(tr2.width) });
        return out;
      })()`, true);
      log.push({ shot: st.shot, padProbe: probe });
      try { preShots[st.shot] = await wc.capturePage(); } catch (e) { }
    }
    if (st.subPop) {   /* v304：子代理统一浮层（悬停开预览→点击固定→可切任务），开板即拍 */
      const b = await center(wc, `(function(){ var els = document.querySelectorAll('.it.zu-sub'); for (var i = 0; i < els.length; i++) { var r = els[i].getBoundingClientRect(); if (r.width) return { x: r.x, y: r.y, w: r.width, h: r.height }; } return null; })()`);   // .zu-sub 无 __tip/文本签名，按类名直查（center() 契约=原始 rect）
      if (!b) { log.push({ shot: st.shot, error: 'no .zu-sub' }); continue; }
      const isOpen = async () => (await wc.executeJavaScript(`(function(){ var p = document.querySelector('.zu-sub-pop'); return p && p.classList.contains('open') && p.offsetWidth > 0; })()`, true));
      for (let a = 0; a < 3 && !(await isOpen()); a++) {   /* 开板重试：悬停预览→点击固定 */
        await send(wc, 'mouseMove', b.x, b.y);
        await sleep(650);
        await send(wc, 'mouseDown', b.x, b.y);
        await send(wc, 'mouseUp', b.x, b.y);
        await sleep(450);
        if (!(await isOpen())) {   /* 兜底：合成事件直发（冒泡到 bar，target 契约与真实输入一致） */
          await wc.executeJavaScript(`(function(){ var el = document.querySelector('.it.zu-sub'); if (!el) return; var r = el.getBoundingClientRect(); var x = r.x + r.width / 2, y = r.y + r.height / 2; el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y })); el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y })); })()`, true);
          await sleep(450);
        }
      }
      if (st.subTask != null) {
        const nb = await center(wc, `(function(){ var els = document.querySelectorAll('.zu-spnav-list .zu-spnav-item'); var el = els[${st.subTask}]; if (!el) return null; var r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);   // 面板挂 body，__zuRectOf 复刻容器作用域不覆盖（center() 契约=原始 rect）
        if (nb) { await send(wc, 'mouseMove', nb.x, nb.y); await sleep(250); await send(wc, 'mouseDown', nb.x, nb.y); await send(wc, 'mouseUp', nb.x, nb.y); await sleep(500); }
        else log.push({ shot: st.shot, error: 'no nav item ' + st.subTask, diag: await wc.executeJavaScript(`(function(){ return { lists: document.querySelectorAll('.zu-spnav-list').length, items: document.querySelectorAll('.zu-spnav-item').length, bodyCls: (document.querySelector('.zu-sub-pop .zu-spbody') || {}).className || null }; })()`, true) });
      }
      const chk = await wc.executeJavaScript(`(function(){ var p = document.querySelector('.zu-sub-pop'); return p && p.classList.contains('open') ? { w: p.offsetWidth, h: p.offsetHeight } : null; })()`, true);
      if (chk) {
        log.push({ shot: st.shot, subPop: chk });
        try { preShots[st.shot] = await wc.capturePage(); } catch (e) { }
      } else log.push({ shot: st.shot, error: 'sub panel not open', diag: await wc.executeJavaScript(`(function(){ var ps = document.querySelectorAll('.zu-sub-pop'); return { n: ps.length, cls: ps[0] ? ps[0].className : null, subs: document.querySelectorAll('.it.zu-sub').length, tipClick: !!(window.costTest && window.costTest.state) ? 'n/a' : 'n/a' }; })()`, true) });
    }
    if (st.turnTip != null) {   /* v299：本轮 tooltip（键盘焦点路径开卡，生产 focusin 同源） */
      let r = null, got = false;
      for (let a = 0; a < 3; a++) {   /* 捕获窗口有竞态：未开则重聚焦 */
        r = await wc.executeJavaScript('window.__zuOpenTurn(' + JSON.stringify(st.turnTip) + ')', true);
        if (!r || !r.ok) { log.push({ shot: st.shot, error: 'turn chip not found' }); break; }
        await sleep(400);
        const chk = await wc.executeJavaScript('window.__zuAfterTurn()', true);
        if (chk && chk.disp === 'block') {
          /* 开卡即拍（v301 前移）：窗口 blur（win-leave:blur）会在后续 mouseMove/二次
           * 确认间隙收卡，确认 block 后第一时间抓帧最稳 */
          try { preShots[st.shot] = await wc.capturePage(); got = true; } catch (e) { }
          break;
        }
      }
      log.push({ shot: st.shot, turnProbe: r });
      if (!r || !r.ok) { log.push({ shot: st.shot, error: 'turn chip not found' }); continue; }
      if (!got) {
        /* 步前「鼠标归中性区」的 move 是异步投递，会在聚焦开卡后迟到触发 left-bar 收起——
         * 鼠标跟落到 chip 上（hitItemFor→showTipFor 同格保活），悬停+焦点双保险 */
        const pr = await wc.executeJavaScript(`window.__zuItRect(${JSON.stringify(st.turnTip)})`, true);
        if (pr) await send(wc, 'mouseMove', Math.round(pr.x), Math.round(pr.y));
        await sleep(400);
        const chk = await wc.executeJavaScript('window.__zuAfterTurn()', true);
        if (chk && chk.disp === 'block') {
          try { preShots[st.shot] = await wc.capturePage(); } catch (e) { }
        }
      }
    }
    await sleep(300);
    if (st.turnTip != null) log.push({ shot: st.shot, afterCapture: await wc.executeJavaScript('window.__zuAfterTurn()', true) });
    const diag = await wc.executeJavaScript('window.__zuDiag()', true);
    let img = preShots[st.shot] || null;
    for (let a = 0; a < 3 && !img; a++) {   /* Viz 合成器瞬态失败重试（实测偶发 UnknownVizError） */
      try { img = await wc.capturePage(); } catch (e) { await sleep(400); }
    }
    if (img) fs.writeFileSync(path.join(OUT, 'shots', st.shot), img.toPNG());
    log.push(Object.assign({ shot: st.shot, shotErr: img ? 0 : 'capture failed' }, diag));
  }
}

let V2SLICE = '';
app.whenReady().then(async () => {
  buildHostFinal();
  V2SLICE = buildV2Slice();
  const win = new BrowserWindow({ width: 1240, height: 820, show: true,
    webPreferences: { contextIsolation: false, sandbox: false } });
  const wc = win.webContents;
  wc.on('console-message', (e, lv, msg, line, src) => {
    if (lv >= 3) console.error('PAGE_ERROR', String(msg).slice(0, 200), src && String(src).split('/').pop() + ':' + line);
  });
  await win.loadFile(path.join(OUT, 'host.final.html'));
  await sleep(500);
  await wc.executeJavaScript('window.__zuReady(' + JSON.stringify(V2SLICE) + ')', true);
  await sleep(200);
  const log = [];

  /* 链 LIVE（2026-11-08）：真实当前会话数据。生产同款 serve 泵拉最近活跃会话快照，
   * 状态条/今日/工具/V2 卡全部为跑链瞬间的真实值——与真机同屏直接对比。
   * 当前会话轮数不足时 V2 卡呈真实稀疏形态（非回归，夹具链覆盖边界场景）。 */
  if (!process.env.ZU_U_ONLY && startPump()) {   /* ZU_T_ONLY 也起泵：T 链 live 帧要真实今日数据 */
    await sleep(300);   // serve 首帧就绪
    if (!process.env.ZU_T_ONLY && !process.env.ZU_P_ONLY && !process.env.ZU_SUB_ONLY) {   /* T/P/SUB_ONLY 各只跑自家链：live L 链跳过 */
      await runChain(wc, win, [
        { live: true, theme: 'dark', shot: 'live-01-open-dark.png' },
        { live: true, theme: 'dark', hoverBar: 0, shot: 'live-02-hover-bar.png' },
        { live: true, theme: 'dark', liveWait: 8000, shot: 'live-03-realtime-8s.png' },
        { live: true, theme: 'light', shot: 'live-04-light.png' },
        { live: true, theme: 'dark', lang: 'en', shot: 'live-05-en.png' },
      ], log);
      await win.setSize(620, 820);
      await runChain(wc, win, [{ live: true, theme: 'dark', tipRight: true, shot: 'live-06-narrow.png' }], log);
      await win.setSize(1240, 820);
      if (!process.env.ZU_T_ONLY && !process.env.ZU_P_ONLY && !process.env.ZU_SUB_ONLY) stopPump();   /* T/P/SUB 链还要吃泵帧 */
    }
  } else {
    console.error('PUMP_UNAVAILABLE zusage.py not found at', ZUSAGE_PY, '— live 链跳过');
  }

  /* 链 T（v301）：今日合计 450 自适应（三行 KPI + 八枚 KPI 图标，live 泵真实今日数据） */
  await runChain(wc, win, [
    { live: true, turnTip: 'zu-stat-tip--today', shot: 't1-today-open.png' },
    { live: true, turnTip: 'zu-stat-tip--tools', shot: 't2-tools-open.png' },
  ], log);
  if (process.env.ZU_T_ONLY) {   /* 只测今日合计 tooltip：跑完 T 链即退出（泵保持开启供真实今日数据） */
    console.log('DONE ' + JSON.stringify(log));
    app.exit(0);
  }

  /* 链 P（v303）：项目累计 450 自适应（四行 KPI + 11 图标，live 泵真实项目聚合） */
  await runChain(wc, win, [
    { live: true, turnTip: 'zu-project-tip', shot: 'p1-project-open.png' },
  ], log);
  if (process.env.ZU_P_ONLY) {   /* 只测项目累计 tooltip：跑完 P 链即退出（泵保持开启） */
    console.log('DONE ' + JSON.stringify(log));
    app.exit(0);
  }

  /* 链 SPD-PAD（临时诊断）：量速度卡各层 padding 与横向溢出 */
  await runChain(wc, win, [
    { live: true, theme: 'dark', shot: 'spd-pad.png', padProbe: true },
  ], log);
  await win.setSize(764, 820);
  await runChain(wc, win, [
    { live: true, theme: 'dark', shot: 'spd-pad-narrow.png', padProbe: true },
  ], log);
  await win.setSize(1240, 820);
  if (process.env.ZU_SPDPROBE) {
    console.log('DONE ' + JSON.stringify(log));
    app.exit(0);
  }

  /* 链 SUB（v304）：子代理统一浮层 680 自适应（夹具子代理数据：汇总+单任务两拍） */
  await runChain(wc, win, [
    { reload: true, fixture: 'recent16', subPop: true, shot: 'sub1-summary.png' },
    { fixture: 'recent16', subPop: true, subTask: 0, shot: 'sub2-task.png' },
  ], log);
  if (process.env.ZU_SUB_ONLY) {   /* 只测子代理面板：跑完 SUB 链即退出 */
    console.log('DONE ' + JSON.stringify(log));
    app.exit(0);
  }

  /* 链 U（v299）：本轮 tooltip 500×350 紧凑布局（单模型设计图形态 / 10 模型区内滚） */
  await runChain(wc, win, [
    { reload: true, fixture: 'recent16', shot: 'u0-warm.png' },
    { turnTip: 'zu-stat-tip--turn', shot: 'u1-turn-open.png' },
  ], log);
  await runChain(wc, win, [
    { reload: true, fixture: 'recent16', turnVariant: 'multi', shot: 'u2-warm-multi.png' },
    { turnVariant: 'multi', turnTip: 'zu-stat-tip--turn', shot: 'u3-turn-multi.png' },
  ], log);
  /* 链 S（v300）：会话累计 450 自适应（与本轮同款紧凑三行 KPI） */
  await runChain(wc, win, [
    { turnTip: 'zu-stat-tip--session', shot: 's1-session-open.png' },
  ], log);
  if (process.env.ZU_U_ONLY) {   /* 只测本轮 tooltip：跑完 U 链即退出，不跑其它链 */
    console.log('DONE ' + JSON.stringify(log));
    app.exit(0);
  }

  /* 链 A：基础视觉（默认/柱 hover/窄窗/浅色/英文） */
  await runChain(wc, win, [
    { fixture: 'recent16', theme: 'dark', shot: '01-open-dark.png' },
    { fixture: 'recent16', theme: 'dark', hoverBar: 3, shot: '02-hover-card.png' },
  ], log);
  await win.setSize(620, 820);
  await runChain(wc, win, [{ fixture: 'recent16', theme: 'dark', tipRight: true, shot: '03-narrow.png' }], log);
  await win.setSize(1240, 820);
  await runChain(wc, win, [
    { fixture: 'recent16', theme: 'light', shot: '04-light.png' },
    { fixture: 'recent16', theme: 'dark', lang: 'en', shot: '05-en.png' },
  ], log);

  /* 链 B：稀疏聚焦（2026-11-07 覆盖提示/聚焦切换按钮移除后无完整轴切换场景） */
  await runChain(wc, win, [
    { reload: true, fixture: 'sparse2', theme: 'dark', sel: { period: 'today' }, shot: '06-today-sparse.png' },
  ], log);
  await runChain(wc, win, [
    { reload: true, fixture: 'projWeek', theme: 'dark',
      clicks: ['[data-sv-val="project"]', '[data-sv-val="week"]'], shot: '08-project-week.png' },
  ], log);
  await runChain(wc, win, [
    { reload: true, fixture: 'singleDay', theme: 'dark',
      clicks: ['[data-sv-val="project"]', '[data-sv-val="week"]'], shot: '09-single-day.png' },
  ], log);
  await runChain(wc, win, [
    { reload: true, fixture: 'hist30', theme: 'dark',
      clicks: ['[data-sv-val="all"]', '[data-sv-val="month"]'], shot: '10-month-many.png' },
  ], log);

  /* 链 M（v291）：本月月历热力图（密集/数据格悬停/无记录格/稀疏/英文）+
   * 全部历史热力图（约 400 天密集横滚/首开滚到最右/数据格悬停/浅色/短历史/滚轮横滚） */
  await runChain(wc, win, [
    { reload: true, fixture: 'month20', theme: 'dark', sel: { range: 'all', period: 'month' }, shot: 'm1-month-dense.png' },
    { fixture: 'month20', theme: 'dark', sel: { range: 'all', period: 'month' }, hoverCell: 7, shot: 'm2-month-hover-today.png' },
    { fixture: 'month20', theme: 'dark', sel: { range: 'all', period: 'month' }, hoverCell: 2, shot: 'm3-month-hover-void.png' },
    { reload: true, fixture: 'singleDay', theme: 'dark', sel: { range: 'all', period: 'month' }, shot: 'm4-month-sparse.png' },
    { reload: true, fixture: 'recent16', theme: 'dark', sel: { range: 'session', period: 'month' }, shot: 'm5-month-session-range.png' },
    { reload: true, fixture: 'month20', theme: 'dark', lang: 'en', sel: { range: 'all', period: 'month' }, shot: 'm6-month-en.png' },
    { reload: true, fixture: 'month20', theme: 'light', sel: { range: 'all', period: 'month' }, shot: 'm7-month-light.png' },
    { reload: true, fixture: 'month20', theme: 'dark', sel: { range: 'all', period: 'month' }, narrow: 560, shot: 'm8-month-narrow.png' },
  ], log);
  await runChain(wc, win, [
    { reload: true, fixture: 'hist400', theme: 'dark', sel: { range: 'all', period: 'all' }, shot: 'h10-hist400-dark.png' },
    { fixture: 'hist400', theme: 'dark', sel: { range: 'all', period: 'all' }, hoverCell: 399, shot: 'h11-hist400-hover.png' },
    { reload: true, fixture: 'hist400', theme: 'light', sel: { range: 'all', period: 'all' }, shot: 'h12-hist400-light.png' },
    { reload: true, fixture: 'singleDay', theme: 'dark', sel: { range: 'all', period: 'all' }, shot: 'h13-hist-sparse.png' },
    { reload: true, fixture: 'hist400', theme: 'dark', sel: { range: 'all', period: 'all' },
      wheel: { ticks: 6, deltaY: 240 }, shot: 'h14-hist-wheel.png' },
    { reload: true, fixture: 'hist400', theme: 'dark', lang: 'en', sel: { range: 'all', period: 'all' }, shot: 'h15-hist-en.png' },
  ], log);

  /* 链 G：Tab 切换宽度稳定性 + hover 边界（首柱/末柱/滚后末柱） */
  await runChain(wc, win, [
    { reload: true, fixture: 'recent16', theme: 'dark', sel: { period: 'recent' }, shot: 'g1-recent.png' },
    { fixture: 'recent16', theme: 'dark', sel: { period: 'today' }, shot: 'g2-today.png' },
    { fixture: 'recent16', theme: 'dark', sel: { period: 'week' }, shot: 'g3-week.png' },
    { fixture: 'recent16', theme: 'dark', sel: { period: 'month' }, shot: 'g4-month.png' },
    { fixture: 'hist30', theme: 'dark', sel: { range: 'all', period: 'all' }, shot: 'g5-all.png' },
    { reload: true, fixture: 'recent16', theme: 'dark', hoverBar: 0, shot: 'h1-first-bar.png' },
    { fixture: 'recent16', theme: 'dark', hoverBar: 15, shot: 'h2-last-bar.png' },
    { reload: true, fixture: 'hist30', theme: 'dark', sel: { range: 'all', period: 'all' },
      hoverBar: 29, scrollEnd: true, shot: 'h3-scrolled-last.png' },
  ], log);

  /* 链 W（v290）：图表区真实滚轮 → 横滚（hist30 桶宽超容器，wrapScrollLeft 应 > 0） */
  await runChain(wc, win, [
    { reload: true, fixture: 'hist30', theme: 'dark', sel: { range: 'all', period: 'all' },
      wheel: { ticks: 4, deltaY: 160 }, shot: 'w1-wheel-scroll.png' },
  ], log);

  /* 链 L：档位说明浮层（开/浅色/窄窗）+ 柱体互斥 + 滚后末柱 */
  for (let pass = 0; pass < 2; pass++) {
    await runChain(wc, win, [
      { reload: pass === 0, fixture: 'recent16', theme: 'dark', hoverLegend: true, shot: 'l1-legend-open.png' },
      { fixture: 'recent16', theme: 'light', hoverLegend: true, shot: 'l2-legend-light.png' },
      { fixture: 'recent16', theme: 'dark', hoverLegend: true, hoverBar: 7, shot: 'l3-legend-then-bar.png' },
    ], log);
  }
  await win.setSize(620, 820);
  await runChain(wc, win, [
    { fixture: 'recent16', theme: 'dark', tipRight: true, scrollEnd: true, hoverLegend: true,
      shot: 'l4-narrow-legend.png' },
  ], log);
  await win.setSize(1240, 820);

  console.log('DONE ' + JSON.stringify(log, null, 1));
  app.exit(0);
}).catch(e => { console.error('FATAL', e && e.stack || e); app.exit(1); });
