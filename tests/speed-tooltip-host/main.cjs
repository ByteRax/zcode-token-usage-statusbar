'use strict';
/* 生成速度 Tooltip 真实 Electron 视觉/几何 QA harness（QA 专用，非分发清单成员）。
 * 运行见 README.md。要点：
 * - 运行目录 overlay.js 原文注入（真实 IIFE/CSS/状态条）；
 * - SPD_V2 纯函数块 + TPS_BANDS/tpsBand/tpsBandText + Portal/档位浮层宿主函数原文切片装配；
 * - 夹具确定性表驱动（无随机数），轮表 delta 编码（首轮绝对、其后增量）；
 * - 交互走 sendInputEvent 真实输入事件；几何断言（__zuDiag）优先于截图。
 * 环境变量：ZU_OVERLAY（默认 ~/.zcode/zcode-token-usage-statusbar/overlay.js）。
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const OUT = __dirname;
const OVERLAY_SRC = process.env.ZU_OVERLAY ||
  path.join(os.homedir(), '.zcode', 'zcode-token-usage-statusbar', 'overlay.js');

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
 * 生成 host.final.html（gitignore）后加载——页面以原文注入运行目录脚本。 */
function buildHostFinal() {
  const tpl = fs.readFileSync(path.join(OUT, 'host.html'), 'utf8');
  const url = 'file://' + path.resolve(OVERLAY_SRC).split(path.sep).join('/');
  fs.writeFileSync(path.join(OUT, 'host.final.html'), tpl.split('__OVERLAY_URL__').join(url));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
  for (const st of steps) {
    await send(wc, 'mouseMove', 620, 140);   // 步前鼠标归中性区
    if (st.reload) {
      await win.loadFile(path.join(OUT, 'host.final.html'));
      await sleep(500);
      await wc.executeJavaScript('window.__zuReady(' + JSON.stringify(V2SLICE) + ')', true);
      await sleep(200);
    }
    await wc.executeJavaScript(`window.__zuScenario(${JSON.stringify(st)})`, true);
    await sleep(400);
    if (st.open !== false) {
      const ok = await wc.executeJavaScript(
        `window.__zuMount(${JSON.stringify(st.sel || {})}, ${st.hover == null ? -1 : st.hover})`, true);
      await sleep(st.wait || 500);
      if (!ok) { log.push({ shot: st.shot, error: 'mount failed' }); continue; }
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
    if (st.hoverLegend) {
      const lb = await center(wc, `window.__zuRectOf('.zu-sv-legend-btn')`);
      if (lb) { await send(wc, 'mouseMove', lb.x, lb.y); await sleep(650); }
    }
    if (st.hoverBar != null) {
      const b = await center(wc, `window.__zuBarRect(${st.hoverBar})`);
      if (b) { await send(wc, 'mouseMove', b.x, b.y); await sleep(600); }
    }
    await sleep(300);
    const diag = await wc.executeJavaScript('window.__zuDiag()', true);
    const img = await wc.capturePage();
    fs.writeFileSync(path.join(OUT, 'shots', st.shot), img.toPNG());
    log.push(Object.assign({ shot: st.shot }, diag));
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

  /* 链 B：稀疏/聚焦/完整时间轴/单柱/多桶横滚（真实点击 Tab 切换） */
  await runChain(wc, win, [
    { reload: true, fixture: 'sparse2', theme: 'dark', sel: { period: 'today' }, shot: '06-today-sparse.png' },
    { fixture: 'sparse2', theme: 'dark', sel: { period: 'today' }, clicks: ['.zu-sv-focus'], shot: '07-today-full-axis.png' },
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
