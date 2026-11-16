'use strict';
/* v356 系统状态（issue #338，specs/statusbar-system-status.md）：
 * ① 00 分片纯函数（cfg 归一/阈值含等号/防抖/字节格式化/面串/Tooltip）VM 行为锁；
 * ② __zusageSysmon 帧入口与 inject-main sysmon 订阅链为切片/源码契约锁；
 * ③ 设置页排序卡行与配置卡结构运行时求值锁。
 * 主进程采样器纯函数在 tests/sysmon-client.test.cjs（不重复）。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'overlay.js'), 'utf8');
const { getNamedSlice } = require('./helpers/overlay-extract.cjs');
const helpers = getNamedSlice('barOrderHelpers');

function sliceText(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, 'missing source anchors: ' + start);
  return source.slice(a, b);
}
function evalHelpers(extra) {
  const ctx = extra || {};
  vm.runInNewContext(helpers + '\nglobalThis.api = {normalizeSysmonCfg, sysmonFaceHtml, sysmonTipHtml, sysmonPreviewHtml, sysSeverityOf, sysSeveritySmoothed, sysFmtBytes, sysVolPick, sysIsStale, SYSMON_ICONS, sysSevCls};', ctx);
  return ctx.api;
}
function frameOf(over) {
  return Object.assign({
    v: 1, ts: 1700000000000,
    cpu: { state: 'ok', pct: 23, cores: 8, load: [1.28, 1.11, 0.98] },
    mem: { state: 'ok', total: 17179869184, used: 10952166604, avail: 6227702580, pct: 63.8, wired: 2254857830, swap_total: 1073741824, swap_used: 644245094 },
    disk: { state: 'ok', vols: [
      { id: '/', name: '', mount: '/', role: 'system', total: 549755813888, used: 348966092800, avail: 200746721088, free_pct: 36.5 },
      { id: '/System/Volumes/Data', name: 'Data', mount: '/System/Volumes/Data', role: 'project', total: 1099511627776, used: 794568949760, avail: 304942678016, free_pct: 27.7 },
    ] },
  }, over);
}
const CFG = { metrics: { cpu: 1, mem: 1, disk: 1 }, format: 'auto', intervalMs: 5000, diskIntervalMs: 60000, warnColors: 1, projectVol: 1, systemVol: 1, thresholds: { cpuWarn: 80, cpuCrit: 90, memWarn: 85, memCrit: 90, diskFreeWarn: 15, diskFreeCrit: 10 } };

test('normalizeSysmonCfg: 缺省/clamp/枚举回退（渲染端与主进程语义对齐）', () => {
  const api = evalHelpers();
  const c = api.normalizeSysmonCfg(null);
  assert.equal(c.format, 'auto');
  assert.equal(c.intervalMs, 5000);
  assert.equal(c.diskIntervalMs, 60000);
  assert.equal(JSON.stringify(c.thresholds), '{"cpuWarn":80,"cpuCrit":90,"memWarn":85,"memCrit":90,"diskFreeWarn":15,"diskFreeCrit":10}', '跨 realm 断言用序列化（deepEqual 原型不等）');
  const bad = api.normalizeSysmonCfg({ format: 'wide', intervalMs: 1, diskIntervalMs: 9e8, thresholds: { cpuWarn: 0, cpuCrit: 401 } });
  assert.equal(bad.format, 'auto');
  assert.equal(bad.intervalMs, 2000);
  assert.equal(bad.diskIntervalMs, 600000);
  assert.equal(bad.thresholds.cpuWarn, 1);
  assert.equal(bad.thresholds.cpuCrit, 100);
  assert.equal(bad.metrics.disk, true);   // 缺 metrics 整段回缺省开
});

test('sysSeverityOf: 阈值含等号边界（spec §7.1 统一 ≥/≤）', () => {
  const api = evalHelpers();
  const sev = (f) => api.sysSeverityOf(CFG, f);
  assert.equal(sev(frameOf({ cpu: { state: 'ok', pct: 79.9 } })).cpu, 'normal');
  assert.equal(sev(frameOf({ cpu: { state: 'ok', pct: 80 } })).cpu, 'warning');
  assert.equal(sev(frameOf({ cpu: { state: 'ok', pct: 89.9 } })).cpu, 'warning');
  assert.equal(sev(frameOf({ cpu: { state: 'ok', pct: 90 } })).cpu, 'critical');
  assert.equal(sev(frameOf({ mem: { state: 'ok', total: 1, used: 0, avail: 1, pct: 85 } })).mem, 'warning');
  assert.equal(sev(frameOf({ mem: { state: 'ok', total: 1, used: 0, avail: 1, pct: 90 } })).mem, 'critical');
  const diskFree = (p) => sev(frameOf({ disk: { state: 'ok', vols: [{ id: 'x', mount: '/x', role: 'project', total: 1, used: 1 - p / 100, avail: p / 100, free_pct: p }] } }));
  assert.equal(diskFree(15.1).disk, 'normal');
  assert.equal(diskFree(15).disk, 'warning');
  assert.equal(diskFree(10).disk, 'critical');
  /* error/loading/disabled 不参与综合（不冒充正常也不冒充危险） */
  assert.equal(sev(frameOf({ cpu: { state: 'error' } })).cpu, 'normal');
  assert.equal(sev(frameOf(null)).overall, 'normal');
  const offCfg = JSON.parse(JSON.stringify(CFG)); offCfg.metrics.cpu = 0;
  assert.equal(api.sysSeverityOf(offCfg, frameOf({ cpu: { state: 'ok', pct: 99 } })).cpu, 'normal');
});

test('sysSeveritySmoothed: 预警连续 2 拍确认、危险立即生效、回落 1 拍还原', () => {
  const api = evalHelpers();
  const warnCfg = JSON.parse(JSON.stringify(CFG));
  const wFrame = frameOf({ cpu: { state: 'ok', pct: 82 } });
  const nFrame = frameOf({});
  // 首拍不亮、第二拍亮（CPU 短抖不闪黄）
  assert.equal(api.sysSeveritySmoothed(warnCfg, wFrame).cpu, 'normal');
  assert.equal(api.sysSeveritySmoothed(warnCfg, wFrame).cpu, 'warning');
  // 危险立即生效（不被防抖掩盖）
  const cFrame = frameOf({ cpu: { state: 'ok', pct: 95 } });
  assert.equal(api.sysSeveritySmoothed(warnCfg, cFrame).cpu, 'critical');
  // 回落 1 拍即还原
  assert.equal(api.sysSeveritySmoothed(warnCfg, nFrame).cpu, 'normal');
});

test('sysFmtBytes 与 sysVolPick', () => {
  const api = evalHelpers();
  assert.equal(api.sysFmtBytes(0), '0K');
  assert.equal(api.sysFmtBytes(200746721088), '187G');
  assert.equal(api.sysFmtBytes(16 * 1024 * 1024 * 1024), '16G');
  assert.equal(api.sysFmtBytes(1099511627776), '1T');
  assert.equal(api.sysFmtBytes(-1), '');
  assert.equal(api.sysFmtBytes(NaN), '');
  const vols = frameOf({}).disk.vols;
  assert.equal(api.sysVolPick(vols).role, 'project');
  assert.equal(api.sysVolPick([vols[0]]).role, 'system');
  assert.equal(api.sysVolPick([]), null);
  assert.equal(api.sysVolPick(null), null);
});

test('sysmonFaceHtml: 三格式面、loading—、预警图标切换、warnColors 关闭、stale', () => {
  const api = evalHelpers();
  const f = frameOf({});
  const NOW = f.ts + 1000;   // 新鲜度按传入时钟判（不碰真实时钟）
  const full = api.sysmonFaceHtml(CFG, f, 'full', NOW);
  assert.match(full, /CPU/);
  assert.match(full, /10\.2G\/16G/);           // full：内存已用/总量
  assert.match(full, /284G/);                   // DISK=主卷（项目卷优先）可用
  assert.ok(!full.includes('zu-sys-stale'), '新鲜帧无过期类');
  assert.ok(!full.includes(' hidden'), 'full 面标签可见（aria-hidden 不算）');
  const compact = api.sysmonFaceHtml(CFG, f, 'compact', NOW);
  assert.match(compact, /64%/);                 // compact：内存百分比
  assert.ok(!compact.includes('10.2G/16G'));
  const minimal = api.sysmonFaceHtml(CFG, f, 'minimal', NOW);
  assert.match(minimal, /hidden/);              // 极简多指标隐藏标签
  const singleCfg = JSON.parse(JSON.stringify(CFG));
  singleCfg.metrics.mem = 0; singleCfg.metrics.disk = 0;
  const single = api.sysmonFaceHtml(singleCfg, f, 'minimal', NOW);
  assert.ok(!single.includes(' hidden'), '极简单指标保留指标身份（aria-hidden 不算）');
  assert.match(single, /CPU/);
  // 无帧：值显 —（loading 态），不伪造 0
  const loading = api.sysmonFaceHtml(CFG, null, 'full', NOW);
  assert.match(loading, /—/);
  // 预警：警告三角替换显示器图标 + 数值色类
  const critFrame = frameOf({ cpu: { state: 'ok', pct: 95 } });
  api.sysSeveritySmoothed(CFG, critFrame); api.sysSeveritySmoothed(CFG, critFrame);
  const crit = api.sysmonFaceHtml(CFG, frameOf({ cpu: { state: 'ok', pct: 95 } }), 'full', NOW);
  assert.match(crit, /zu-sys-crit/);
  assert.ok(crit.includes(api.SYSMON_ICONS.warn), '危险态切换警告三角图标');
  const noColorCfg = JSON.parse(JSON.stringify(CFG)); noColorCfg.warnColors = 0;
  const plain = api.sysmonFaceHtml(noColorCfg, frameOf({ cpu: { state: 'ok', pct: 95 } }), 'full', NOW);
  assert.ok(!plain.includes('zu-sys-crit'), 'warnColors 关闭不染色');
  // stale：整段降透明类
  const staleF = frameOf({}); staleF.ts = 1;
  assert.match(api.sysmonFaceHtml(CFG, staleF, 'full', NOW), /zu-sys-stale/);
  // 全关：空串（格不渲染）
  assert.equal(api.sysmonFaceHtml({ metrics: { cpu: 0, mem: 0, disk: 0 } }, f, 'full', NOW), '');
});

test('sysmonTipHtml: 紧凑结构（v362）、动态刷新说明、条件行、磁盘表与转义', () => {
  const api = evalHelpers({ L: (zh, en) => zh });
  const NOW = 1700000000000 + 1000;   // 新鲜度按传入时钟判（不碰真实时钟）
  const html = api.sysmonTipHtml(CFG, frameOf({}), NOW);
  assert.match(html, /系统状态/);
  assert.match(html, /zu-sys-local/);                    // 「本机」低对比标签
  assert.match(html, /title="CPU\/内存每 5s · 磁盘每 60s"/);   // 按 cfg 动态，不写死
  assert.match(html, />5s · 60s</);                       // 可见文案紧凑（刷新说明换时钟图标）
  assert.ok(!html.includes('M3 12a9 9'), '刷新箭头图标已换时钟（纯说明非按钮）');
  assert.match(html, /zu-sys-grid/);                      // 三区 Grid（标签列|主数值|右侧辅助）
  assert.match(html, /zu-sys-big">23%</);                 // CPU 主数值直读百分比
  assert.ok(!html.includes('整机使用率'), '去「整机使用率」前缀（主数值即使用率）');
  assert.match(html, /8 核/);
  assert.match(html, /Load 1m\/5m\/15m <b>1\.28 \/ 1\.11 \/ 0\.98<\/b>/);   // 恒两位小数
  const oneDecimal = api.sysmonTipHtml(CFG, frameOf({ cpu: { state: 'ok', pct: 10, cores: 4, load: [1.9, 2, 2.3] } }), NOW);
  assert.match(oneDecimal, /1\.90 \/ 2\.00 \/ 2\.30/, 'Load 一位数补齐两位（列宽稳定）');
  assert.match(html, /Wired 2\.1G/);
  assert.match(html, /Swap 614M \/ 1G/);
  assert.match(html, /当前： 项目卷/);                     // 主卷角色入区头（重复挂载点行删除）
  assert.ok(!html.includes('zu-sys-main'), '旧 flex 行结构已移除（Grid 替代）');
  assert.match(html, /项目卷 Data/);
  assert.match(html, /zu-sys-vrowon/);                    // 当前监控卷轻高亮行
  assert.ok(!html.includes('zu-sys-cur'), '旧大灰底高亮类已替换');
  // 图例精简（v362）：三色点 + ⓘ 按钮；阈值明细收进内联展开区
  assert.match(html, /data-zu-sys-th aria-expanded="false"/);
  assert.match(html, /data-zu-sys-thexp hidden/);
  assert.match(html, /zu-sys-tht/);                       // 展开区阈值表
  assert.match(html, /≥80%/);                             // 阈值动态读取 cfg
  assert.ok(!html.includes('预警（'), '图例不再内联阈值长文案');
  assert.ok(!html.includes('数据已过期'), '新鲜帧无过期注记');
  // 条件行：无 Wired/Swap 不伪造；load 缺席整行隐藏；Windows load null 同效
  const bare = api.sysmonTipHtml(CFG, frameOf({
    mem: { state: 'ok', total: 8589934592, used: 2147483648, avail: 6442450944, pct: 25, wired: null, swap_total: null, swap_used: null },
    cpu: { state: 'ok', pct: 10, cores: 4, load: null },
  }), NOW);
  assert.ok(!bare.includes('Wired'), '无 Wired 不渲染假值');
  assert.ok(!bare.includes('Swap '), '无 Swap 不渲染假值');
  assert.ok(!bare.includes('Load 1m'), '无负载整行隐藏');
  // Swap 有效 0 值显示（与 null 不可用区分，v362 number 判定）
  const swap0 = api.sysmonTipHtml(CFG, frameOf({
    mem: { state: 'ok', total: 8589934592, used: 2147483648, avail: 6442450944, pct: 25, wired: null, swap_total: 1073741824, swap_used: 0 },
  }), NOW);
  assert.match(swap0, /Swap 0K \/ 1G/, 'swap_used=0 是有效值（Linux 未用交换）');
  // 过期注记 + 采样秒数动态化
  const cfg2 = JSON.parse(JSON.stringify(CFG)); cfg2.intervalMs = 3000;
  const staleF = frameOf({}); staleF.ts = 1;
  assert.match(api.sysmonTipHtml(cfg2, staleF), /title="CPU\/内存每 3s/);
  assert.match(api.sysmonTipHtml(cfg2, staleF), /数据已过期/);
  // 卷名转义
  const evil = frameOf({ disk: { state: 'ok', vols: [{ id: '/x', name: '<script>alert(1)</script>', mount: '/x', role: 'project', total: 1, used: 0, avail: 1, free_pct: 100 }] } });
  const escaped = api.sysmonTipHtml(CFG, evil, NOW);
  assert.ok(!escaped.includes('<script>'), '卷名用户数据必须转义');
  assert.ok(escaped.includes('&lt;script&gt;'));
  // 采集中
  assert.match(api.sysmonTipHtml(CFG, null, NOW), /采集中/);
});

test('sysmonTipHtml: APFS 共享容器（v362）——同容器次行不重复容量、独立卷不合并、warnColors 关中性化', () => {
  const api = evalHelpers({ L: (zh, en) => zh });
  const NOW = 1700000000000 + 1000;
  /* 情况 B：不同 APFS 卷共享同一容器（container 字段由后端标注，前端只认字段不猜容量） */
  const GB = 926 * 1024 * 1024 * 1024;   // sysFmtBytes 是 1024 进制，字面 926G 对齐
  const shared = api.sysmonTipHtml(CFG, frameOf({ disk: { state: 'ok', vols: [
    { id: '/', mount: '/', role: 'system', container: 'disk3', total: GB, used: 532 * 1024 ** 3, avail: 394 * 1024 ** 3, free_pct: 42.5 },
    { id: '/System/Volumes/Data', mount: '/System/Volumes/Data', role: 'project', container: 'disk3', total: GB, used: 532 * 1024 ** 3, avail: 394 * 1024 ** 3, free_pct: 42.5 },
  ] } }), NOW);
  assert.match(shared, /APFS 共享/, '同容器首行带徽记');
  assert.equal((shared.match(/APFS 共享/g) || []).length, 1, '徽记只挂首行（次行已有共享说明，双徽记冗余）');
  assert.ok(shared.includes('共享容器空间'), '次行显共享说明');
  assert.equal((shared.match(/共享容器空间/g) || []).length, 1, '仅 follower 行显共享说明（角色分配锁定）');
  assert.equal((shared.match(/926G/g) || []).length, 1, '同容器容量数值只出现一次（不重复展示误导「磁盘翻倍」）');
  assert.ok(shared.indexOf('926G') < shared.indexOf('共享容器空间'), '首行显容量、次行显共享（先标 seenC 再算 follower 的变异在此变红）');
  /* 情况 D：两行容量完全相同但无 container 字段（不同盘巧合/无法判定）——保守保留两行真实数据 */
  const twin = api.sysmonTipHtml(CFG, frameOf({ disk: { state: 'ok', vols: [
    { id: '/x1', mount: '/x1', role: 'system', total: GB, used: 532 * 1024 ** 3, avail: 394 * 1024 ** 3, free_pct: 42.5 },
    { id: '/x2', mount: '/x2', role: 'project', total: GB, used: 532 * 1024 ** 3, avail: 394 * 1024 ** 3, free_pct: 42.5 },
  ] } }), NOW);
  assert.equal((twin.match(/926G/g) || []).length, 2, '无共享证据不合并（容量相同不作为判据）');
  assert.ok(!twin.includes('APFS 共享'));
  /* warnColors 关：点转中性灰 + 注记，避免误以为仍会变色 */
  const noColor = JSON.parse(JSON.stringify(CFG)); noColor.warnColors = 0;
  const nc = api.sysmonTipHtml(noColor, frameOf({}), NOW);
  assert.match(nc, /zu-sys-legend nocolor/);
  assert.match(nc, /颜色提示已关闭/);
});

test('sysmonPreviewHtml: 跟随显示格式、全关空状态、无帧采集中尾注（v362）', () => {
  const api = evalHelpers({ L: (zh) => zh });
  const NOW = 1700000000000 + 1000;
  const f = frameOf({});
  // auto 以 full 演示：内存显已用/总量（full 特征），compact 显百分比
  assert.match(api.sysmonPreviewHtml(CFG, f, NOW), /10\.2G\/16G/, 'auto 预览按 full 面');
  const compactCfg = JSON.parse(JSON.stringify(CFG)); compactCfg.format = 'compact';
  assert.match(api.sysmonPreviewHtml(compactCfg, f, NOW), /64%/);
  assert.ok(!api.sysmonPreviewHtml(compactCfg, f, NOW).includes('10.2G/16G'), '预览跟随显示格式切换');
  // 全关：明确空状态（不是「采集中」也不是假 0）
  const off = api.sysmonPreviewHtml({ metrics: { cpu: 0, mem: 0, disk: 0 } }, f, NOW);
  assert.match(off, /全部指标已关闭/);
  // 无帧：有指标开 + 「—」占位 + 采集中尾注；有帧无尾注
  const noFrame = api.sysmonPreviewHtml(CFG, null, NOW);
  assert.match(noFrame, /采集中/);
  assert.ok(!api.sysmonPreviewHtml(CFG, f, NOW).includes('采集中'), '有帧不加采集中尾注');
});

test('hideTip 行为（v362）：收起时清 __zuSysExp（重开默认收起）', () => {
  const seg = sliceText('    function hideTip(force, cause) {', '    function positionTip(el, keepTop) {');
  const hides = [];
  const ctx = {
    state: { devKeepTip: 0 },
    tip: { style: { display: 'block' }, __zuSysExp: true, __zuSpeedSize: {}, querySelector: () => null, removeAttribute: () => {} },
    tipStats: { hides: 0, lastHide: '', hideSeq: [] },
    tipFor: { removeAttribute: () => {} },
    tipSig: 'x',
    tipGraceTimer: 0,
    rateTipFor: null,
    spdHoverPortalHide: () => {},
    spdLegendTipHide: () => {},
    hideFxTip: () => {},
    hideSubPop: () => {},
    subPopOpen: () => false,
    hideGitTip: () => {},
    hideQuotaTip: () => {},
    hideRstTip: () => {},
    sysmonWantRecalc: () => hides.push(1),
  };
  vm.runInNewContext(seg + '\nglobalThis.h = hideTip;', ctx);
  ctx.h(true, 'escape');
  assert.equal(ctx.tip.__zuSysExp, false, '关闭即收起阈值说明（标志清零）');
  assert.equal(ctx.tip.style.display, 'none');
  // 保活早退路径不清零（devKeepTip 拦截时状态保持）
  const ctx2 = JSON.parse(JSON.stringify(ctx));
  ctx2.tip.__zuSysExp = true; ctx2.state.devKeepTip = 1;
  const ctx2ref = ctx2;
  vm.runInNewContext(seg + '\nglobalThis.h = hideTip;', ctx2ref);
  ctx2ref.h(true, 'left-bar');
  assert.equal(ctx2ref.tip.__zuSysExp, true, 'devKeepTip 拦截路径不动展开态');
});

test('ⓘ 切换行为（v362）：click 委托 toggle + 重定位（行为级锁，替代纯源码 match）', () => {
  const a = source.indexOf('    tip.addEventListener("click", function (e) {');
  const b = source.indexOf('speedTabActivate(e);\n    });', a);
  assert.ok(a >= 0 && b > a, 'click 委托切片锚点');
  const seg = source.slice(a, b + 'speedTabActivate(e);\n    });'.length);
  const calls = [];
  const box = { hidden: true };
  const btnEl = { setAttribute: (k, v) => calls.push(['aria', v]) };
  const tipForObj = { keepTop: 1 };
  const tipObj = {
    __zuSysExp: false,
    querySelector: (sel) => sel === '[data-zu-sys-thexp]' ? box : (sel === '[data-zu-sys-th]' ? btnEl : null),
    addEventListener: (type, fn) => { tipObj['on' + type] = fn; },
  };
  const ctx = {
    tip: tipObj,
    tipFor: tipForObj,
    positionTip: (el, keepTop) => calls.push(['pos', el === tipForObj, keepTop]),
    projTipTabActivate: () => false,
    projTipMoreActivate: () => false,
    speedTabActivate: () => calls.push(['speed']),
    L: (zh) => zh,
  };
  vm.runInNewContext(seg + '\nglobalThis.install = function () {};', ctx);
  const handler = tipObj.onclick;
  assert.ok(handler, 'click 监听已挂');
  const target = { closest: (sel) => sel === '[data-zu-sys-th]' ? btnEl : null };
  handler({ target });
  assert.equal(tipObj.__zuSysExp, true, '第一次点击展开');
  assert.equal(box.hidden, false);
  const posCall = calls.find((c) => c[0] === 'pos');
  assert.ok(posCall, '展开后触发重定位');
  assert.deepEqual([...posCall], ['pos', true, true], '重定位传 tipFor + keepTop');
  handler({ target });
  assert.equal(tipObj.__zuSysExp, false, '第二次点击收起（toggle 而非单向赋值）');
  assert.equal(box.hidden, true);
  // 非 ⓘ 点击不进分支（落到 speedTabActivate）
  const callsLen = calls.length;
  handler({ target: { closest: () => null } });
  assert.equal(tipObj.__zuSysExp, false, '非 ⓘ 点击不改展开态');
  assert.ok(calls.length > callsLen && calls[calls.length - 1][0] === 'speed', '落到速度 Tab 分支');
});

test('09 阈值校验 change 分支（v362）：非法不写入+回填+红边、合法回填 clamp 生效值', () => {
  const a = source.indexOf('if (t2.classList && (t2.classList.contains("zu-syscfg-int")');
  const b = source.indexOf('if (t2.classList.contains("zu-theme-choice")) {', a);
  assert.ok(a >= 0 && b > a, '阈值校验切片锚点');
  /* 切片是「if (…) { … }」语句块：包成宿主可调函数执行 */
  const wrapped = 'globalThis.branch = function (t2, panel, state, L, normalizeSysmonCfg, persistSysmonCfg, sysmonWantRecalc, renderAll, sysmonApplyFace) {\n' +
    source.slice(a, b) + '\n};';
  function branch(t2, ctx) {
    ctx.branch(t2, ctx.panel, ctx.state, ctx.L, ctx.normalizeSysmonCfg, ctx.persistSysmonCfg, ctx.sysmonWantRecalc, ctx.renderAll, ctx.sysmonApplyFace);
  }
  function makeEnv(value, thKey, cfgOver) {
    const cfg = JSON.parse(JSON.stringify(CFG));
    if (cfgOver) cfg.thresholds = Object.assign(cfg.thresholds, cfgOver);
    const st = { sysmonCfg: cfg };
    const errBox = { hidden: true, textContent: '' };
    const t2 = {
      value, badAdded: undefined,
      classList: { contains: (c) => c === 'zu-syscfg-th', add: () => { t2.badAdded = true; }, remove: () => { t2.badAdded = false; } },
      getAttribute: (k) => k === 'data-th' ? thKey : null,
    };
    const panel = {
      querySelector: (sel) => sel === '[data-zu-sys-therr]' ? errBox : null,
      querySelectorAll: (sel) => sel === '.zu-syscfg-th.zu-syscfg-bad' ? (t2.badAdded ? [t2] : []) : [],
    };
    const persisted = [];
    const issCtx2 = { L: (zh) => zh };
    vm.runInNewContext(sliceText('  function sysThresholdIssues(cfg) {', '  /* 阈值明细表（ⓘ 展开区内容') + '\nglobalThis.f = sysThresholdIssues;', issCtx2);
    const ctx = {
      panel, state: st, L: (zh) => zh, persistSysmonCfg: () => persisted.push(1),
      sysThresholdIssues: issCtx2.f,   // 生产函数切片（09 分支体直接调用）
      sysmonWantRecalc: () => {}, renderAll: () => {}, sysmonApplyFace: () => {},
      normalizeSysmonCfg: (r) => {
        const c = JSON.parse(JSON.stringify(r));
        const cl = (v, lo, hi, d) => { const n = Math.floor(Number(v)); return isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
        if (c.intervalMs !== undefined) c.intervalMs = cl(c.intervalMs, 2000, 60000, 5000);
        if (c.diskIntervalMs !== undefined) c.diskIntervalMs = cl(c.diskIntervalMs, 30000, 600000, 60000);
        if (c.thresholds) for (const k of Object.keys(c.thresholds)) c.thresholds[k] = cl(c.thresholds[k], k.indexOf('diskFree') === 0 ? 0 : 1, 100, c.thresholds[k]);
        return c;
      },
    };
    vm.runInNewContext(wrapped + '\nglobalThis.branch = branch;', ctx);
    return { ctx, t2, errBox, persisted, st };
  }
  // ① 非法候选：不写入、回填原生效值、红边+红字
  const e1 = makeEnv('99', 'cpuWarn', { cpuWarn: 80, cpuCrit: 90 });
  branch(e1.t2, e1.ctx);
  assert.equal(e1.st.sysmonCfg.thresholds.cpuWarn, 80, '非法候选不写入 state');
  assert.equal(e1.t2.value, '80', '回填原生效值');
  assert.equal(e1.t2.badAdded, true, '输入框红边');
  assert.equal(e1.errBox.hidden, false, '错误行显示');
  assert.match(e1.errBox.textContent, /已保留原值/);
  assert.equal(e1.persisted.length, 0, '非法路径不持久化');
  // ② 合法写入：回填 clamp 生效值（越界 500 → 100）
  const e2 = makeEnv('500', 'cpuCrit', {});
  branch(e2.t2, e2.ctx);
  assert.equal(e2.st.sysmonCfg.thresholds.cpuCrit, 100, 'clamp 写入');
  assert.equal(e2.t2.value, '100', '回填实际生效值');
  assert.equal(e2.t2.badAdded, false, '无红边');
  assert.equal(e2.errBox.hidden, true);
  assert.equal(e2.persisted.length, 1, '合法路径持久化');
  // ③ 跨字段修复：warn 残留红边后，crit 改到 96 使 95<96 关系合法 → 残留红边统一清除
  const e3 = makeEnv('96', 'cpuCrit', { cpuWarn: 95, cpuCrit: 90 });
  const warnBox = { badAdded: true, classList: { remove: () => { warnBox.badAdded = false; } } };
  e3.ctx.panel.querySelectorAll = (sel) => sel === '.zu-syscfg-th.zu-syscfg-bad' ? [warnBox] : [];
  branch(e3.t2, e3.ctx);
  assert.equal(warnBox.badAdded, false, '关系恢复合法后残留红边统一清除');
  assert.equal(e3.st.sysmonCfg.thresholds.cpuCrit, 96);
  // ④ 间隔输入 clamp 回填生效值
  const intCtx = makeEnv('1', null);
  intCtx.t2.classList = { contains: (c) => c === 'zu-syscfg-int', add: () => {}, remove: () => {} };
  delete intCtx.t2.getAttribute;
  branch(intCtx.t2, intCtx.ctx);
  assert.equal(intCtx.st.sysmonCfg.intervalMs, 2000, '间隔 clamp 到下限');
  assert.equal(intCtx.t2.value, '2', '回填生效秒数');
});

test('sysThresholdIssues 与展开区标红（v362）：关系非法标红不改写', () => {
  const seg = sliceText('  function sysThresholdIssues(cfg) {', '  /* 阈值明细表（ⓘ 展开区内容');
  const ctx = { L: (zh) => zh };
  vm.runInNewContext(seg + '\nglobalThis.issues = sysThresholdIssues;', ctx);
  assert.deepEqual([...ctx.issues(CFG)], [], '合法配置零问题');
  const bad1 = JSON.parse(JSON.stringify(CFG)); bad1.thresholds.cpuWarn = 95;   // warn >= crit
  assert.deepEqual([...ctx.issues(bad1)], ['CPU：预警阈值需小于危险阈值']);
  const bad2 = JSON.parse(JSON.stringify(CFG)); bad2.thresholds.diskFreeWarn = 5;   // warn <= crit（可用率方向）
  assert.deepEqual([...ctx.issues(bad2)], ['磁盘可用率：预警阈值需大于危险阈值']);
  const both = JSON.parse(JSON.stringify(CFG)); both.thresholds.memWarn = 90; both.thresholds.diskFreeCrit = 20;
  assert.equal(ctx.issues(both).length, 2, '多指标问题并列');
  // 展开区：非法阈值标红（展示层反馈，不写回配置）
  const api = evalHelpers({ L: (zh) => zh });
  const tbl = api.sysmonTipHtml(bad1, frameOf({}), 1700000000000 + 1000);
  assert.match(tbl, /zu-sys-thbad/);
});

test('__zusageSysmon 帧入口：非法帧拒绝、合法帧写诊断并逐实例 tick', () => {
  const ticks = [];
  const ctx = {
    window: {},
    instances: [{ sysmonTick: () => ticks.push(1) }, { sysmonTick: () => ticks.push(2) }, {}],
    FATAL: { gen: 1 },
    sysFrame: null,
    stale: () => false,
    state: { sysmonCfg: JSON.parse(JSON.stringify(CFG)) },   // 帧入口推进防抖读 cfg
  };
  const seg = sliceText('  window.__zusageSysmon = function (frame) {', '  window.__zusagePluginRequests = [];');
  vm.runInNewContext(helpers + '\n' + seg + '\nglobalThis.h = window.__zusageSysmon;', ctx);   // 帧入口推进防抖需 helpers 内的 sysSeveritySmoothed
  ctx.h(null); ctx.h({}); ctx.h({ cpu: {} });   // 缺字段帧整体拒绝
  assert.equal(ctx.FATAL.sysFrame, undefined);
  assert.equal(ticks.length, 0);
  ctx.h(frameOf({}));
  assert.equal(ticks.length, 2, '合法帧逐实例 sysmonTick');
  assert.equal(ctx.FATAL.sysFrame.has, 1);
  assert.equal(ctx.FATAL.sysFrame.want, 0, 'want 分量按订阅签名写实（review：死字段修复）');
  // stale 代际拒绝
  const ctx2 = { window: {}, instances: [{ sysmonTick: () => ticks.push(9) }], FATAL: {}, sysFrame: null, stale: () => true };
  vm.runInNewContext(seg + '\nglobalThis.h = window.__zusageSysmon;', ctx2);
  ctx2.h(frameOf({}));
  assert.equal(ticks.length, 2);
});

test('防抖按采样拍推进（review M2）：face/tip 消费不推进计数，帧入口每帧一次', () => {
  // 真帧入口路径：warning 帧 ×1 → 面不亮；×2（两拍）→ 亮（调用多少次 face 都不影响）
  const ctx = { window: {}, instances: [], FATAL: {}, sysFrame: null, stale: () => false,
    state: { sysmonCfg: JSON.parse(JSON.stringify(CFG)) } };
  vm.runInNewContext(helpers + '\n' + sliceText('  window.__zusageSysmon = function (frame) {', '  window.__zusagePluginRequests = [];')
    + '\nglobalThis.h = window.__zusageSysmon; globalThis.face = sysmonFaceHtml;', ctx);
  const warnFrame = frameOf({ cpu: { state: 'ok', pct: 85 } });
  ctx.h(warnFrame);
  const face1 = ctx.face(CFG, warnFrame, 'full', warnFrame.ts + 10);
  // face 用共享帧引用时读快照：1 拍未确认 → 无 warn
  assert.ok(!face1.includes('zu-sys-warn'), '预警 1 拍不亮（消费端不推进）');
  ctx.h(warnFrame);   // 第二拍
  const face2 = ctx.face(CFG, warnFrame, 'full', warnFrame.ts + 10);
  assert.match(face2, /zu-sys-warn/, '连续 2 拍确认后亮');
  // 危险仍立即生效（不被防抖掩盖）：crit 帧推进 1 拍即亮
  const critFrame = frameOf({ cpu: { state: 'ok', pct: 95 } });
  ctx.h(critFrame);
  const face3 = ctx.face(CFG, critFrame, 'full', critFrame.ts + 10);
  assert.match(face3, /zu-sys-crit/, '危险立即生效');
});

test('源码契约：条面格门控/远程排除/原地刷新/窄宽钩子/订阅链', () => {
  assert.match(source, /barItemKey = "sysmon";/, 'html() 注册 sysmon 格 key');
  assert.match(source, /state\.show\.sysmon && !d\.remote && !d\.not_local/, '仅本地 scope 渲染（远端/不在本地库排除）');
  assert.match(source, /function sysmonApplyFace\(\)/, '原地刷新函数');
  assert.match(source, /try \{ sysmonApplyFace\(\); \} catch \(e\) \{ \}   \/\/ v356/, '窄宽档位切换钩子驱动 auto 重绘');
  assert.match(source, /var probeSys = probeMain\.querySelector\('\.it\[data-zu-key="sysmon"\]'\);[\s\S]*?sysmonFaceHtml\(state\.sysmonCfg, sysFrame, "full"\)/, '探针副本内 sysmon 固定 full 面（档位↔面宽震荡环修复）');
  assert.match(source, /sysmonTick: function \(\)/, 'api 暴露 sysmonTick');
  assert.match(source, /sysmonInterested: function \(\)/, 'api 上报订阅意愿');
  assert.match(source, /window\.__zusageSysmon = function/, '帧入口');
  const injectSrc = fs.readFileSync(path.join(root, 'inject-main.cjs'), 'utf8');
  assert.match(injectSrc, /"sysmon-client\.cjs"/, 'inject-main 登记热模块');
  assert.match(injectSrc, /action === "sysmon-sub"/, 'pluginRequest 订阅动作');
  assert.match(injectSrc, /action === "sysmon-refresh"/, 'pluginRequest 手动刷新动作');
  assert.match(source, /zu-sysm,\.zusage-sysmon-tip/, 'boot 旧代清理串含新浮层类');
  assert.match(source, /mis = wrap\.lastElementChild !== chip && !\(sysmonChipCache && wrap\.lastElementChild === sysmonChipCache\)/, 'git 兜回容忍 sysmon 收尾（防拉锯）');
  assert.match(source, /else mis = slotNode !== chip && !\(tpsChipCache && slotNode === tpsChipCache\);/, 'chip 判位与插入方向一致（review M1：防逐拍空转）');
  assert.match(source, /chip\.__zuWired = true;/, 'chip 采纳遗留节点统一重接线（review：__zuWired 守卫）');
  assert.match(source, /onSysChipKeyup/, 'Space keyup 激活对齐 git chip（review）');
  assert.match(source, /state\.sysmonCfg = normalizeSysmonCfg\(sc/, '设置输入裸赋值后再 clamp（review M3）');
  assert.match(source, /sysSevSnapshot = sysSeveritySmoothed\(state\.sysmonCfg, frame\);/, '防抖按采样拍推进（review M2：帧入口单点推进）');
  assert.match(source, /restoreSysmonChip\(\);   \/\/ v356/, 'dispose 摘除系统状态 chip');
  /* v362 接线契约：ⓘ 切换/重建恢复/关闭清零/mousedown 名单/后端容器标注 */
  assert.match(source, /tip\.__zuSysExp = !tip\.__zuSysExp/, '全量 tip ⓘ 切换委托（只挂 click：toggle 非同值幂等）');
  assert.match(source, /if \(tipFor\) positionTip\(tipFor, true\);/, 'ⓘ 切换后重定位（展开 +124px 防底边越出视口）');
  assert.match(source, /function placeSysTip\(chip\)/, 'sysTip 定位提函数（show 与 ⓘ 切换共用）');
  assert.match(source, /if \(tip\.__zuSysExp\) \{[\s\S]{0,200}data-zu-sys-thexp[\s\S]{0,120}hidden = false/, 'drawTip 重建后恢复展开态');
  assert.match(source, /tip\.__zuSysExp = false;   \/\/ v362：关闭即收起阈值说明/, 'hideTip 清展开态（重开默认收起）');
  assert.match(source, /sysTip\.__zuSysExp = !sysTip\.__zuSysExp/, '精简 chip sysTip ⓘ 切换委托');
  assert.match(source, /t\.closest\("\.zu-sv-tab"\) \|\| t\.closest\("\[data-zu-sys-th\]"\)/, 'mousedown 名单含阈值按钮（防焦点逸出关 tooltip）');
  assert.match(source, /sysmonPreviewHtml\(cfgL, sysFrame\)/, '07 预览行走共享函数（跟随显示格式）');
  const clientSrc = fs.readFileSync(path.join(root, 'sysmon-client.cjs'), 'utf8');
  assert.match(clientSrc, /markDarwinContainer\(vols\)/, '采样器 darwin 分支标注 APFS 共享容器');
  assert.match(clientSrc, /process\.platform === "darwin"\) markDarwinContainer/, '仅 darwin 标注（Linux/Windows 不受影响）');
});

test('inject-main sysmon 订阅链：want 记账/配置透传/非法 projectPath 拒绝', () => {
  const inject = fs.readFileSync(path.join(root, 'inject-main.cjs'), 'utf8');
  const a = inject.indexOf('function handleSysmonRequest(req, wc) {');
  const b = inject.indexOf('/* ---------- v202 更新日志', a);
  assert.ok(a >= 0 && b > a, 'handleSysmonRequest 切片锚点');
  const seg = inject.slice(a, b);
  const subs = new Map();
  const calls = { apply: [], sub: [], delivered: [] };
  const ctx = {
    sysmonSubs: subs,
    sysmonClient: { applyConfig: (c, p) => calls.apply.push([c, p]), setSubscribed: (w) => calls.sub.push(w) },
    gitPathOk: (p) => p === '/ok',
    deliverPluginRequest: (wc, id, result) => calls.delivered.push(result),
  };
  ctx.sysmonWantAny = () => { for (const v of ctx.sysmonSubs.values()) { if (v) return true; } return false; };
  ctx.sysmonSyncSubscribed = () => { calls.sub.push(ctx.sysmonWantAny()); };
  vm.runInNewContext(seg + '\nglobalThis.h = handleSysmonRequest;', ctx);
  const wc = { id: 7 };
  ctx.h({ want: true, cfg: { intervalMs: 3000 }, projectPath: '/ok' }, wc);
  assert.equal(subs.get(7), true);
  assert.equal(calls.delivered[0].ok, true);
  assert.equal(calls.apply[0][0].intervalMs, 3000, 'cfg 透传采样器');
  assert.equal(calls.apply[0][1], '/ok');
  assert.deepEqual(calls.sub, [true], '任一订阅即开采样');
  ctx.h({ want: true, projectPath: 'bad path' }, wc);
  assert.equal(calls.delivered[1].ok, false, '非法 projectPath 拒绝');
  assert.equal(subs.get(7), true, '拒绝时不改记账');
  ctx.h({ want: false }, wc);
  assert.equal(subs.get(7), false);
  assert.deepEqual(calls.sub, [true, false], '末订阅停采样');
  assert.equal(calls.delivered[2].ok, true);
  ctx.h({ want: false }, { id: 99 });   // 重复 want=false 幂等
  assert.equal(subs.get(99), false);
});

test('设置页：排序卡出现系统状态行、配置卡结构与双回填契约', () => {
  const state = {
    show: { sysmon: 0 }, lang: 'zh',
    barOrder: ['speed', 'turn', 'win', 'today', 'proj', 'tools', 'sub', 'sysmon'],
    barPriority: { speed: 'high', turn: 'high', win: 'normal', today: 'normal', proj: 'normal', tools: 'low', sub: 'low', sysmon: 'low' },
    sysmonCfg: JSON.parse(JSON.stringify(CFG)),
  };
  const ctx = {
    state, slot: 3, L: (zh) => zh,
    ZU_BAR_TITLES: { speed: ['生成速度'], turn: ['本轮'], win: ['会话累计'], today: ['今日合计'], proj: ['项目累计'], tools: ['工具调用'], sub: ['子代理'], sysmon: ['系统状态'] },
    sysFrame: null,
  };
  const seg = sliceText('    function barOrderSettingsHtml() {', '    /* 面板文案可随语言重建');
  vm.runInNewContext(helpers + '\n' + seg + '\nglobalThis.h = barOrderSettingsHtml; globalThis.sys = sysmonSettingsHtml;', ctx);
  const card = ctx.h();
  assert.match(card, /data-zu-layout-key="sysmon"/, '排序卡自动出现系统状态行');
  assert.match(card, /data-k="sysmon"/, '显示开关走既有 data-k 通道');
  assert.match(card, /实时监控本机 CPU、内存和磁盘资源/, '排序卡说明');
  assert.match(card, /name="zu-prio-3-sysmon"/, '优先级 radio 带实例槽位');
  const cfgCard = ctx.sys();
  assert.match(cfgCard, /zu-syscfg-prev/, '真实数据预览行');
  assert.match(cfgCard, /data-sysm="cpu"/);
  assert.match(cfgCard, /class="zu-syscfg-fmt"/);
  assert.match(cfgCard, /zu-syscfg-int/);
  assert.match(cfgCard, /zu-syscfg-dint/);
  assert.match(cfgCard, /data-sysm="projectVol"/);
  assert.match(cfgCard, /data-th="cpuWarn"/);
  assert.match(cfgCard, /data-th="diskFreeCrit"/);
  assert.match(cfgCard, /value="80"/);
  /* v362 Grid 重构：分组小节标题 + 阈值三列表 + 单位固定后缀 + 输入框显式边框 */
  assert.match(cfgCard, /zu-syscfg-cap">监控指标/);
  assert.match(cfgCard, /zu-syscfg-cap">显示方式/);
  assert.match(cfgCard, /zu-syscfg-cap">采样频率/);
  assert.match(cfgCard, /zu-syscfg-cap">磁盘监控范围/);
  assert.match(cfgCard, /zu-syscfg-ths/);
  assert.match(cfgCard, /zu-syscfg-thh">预警阈值/);
  assert.match(cfgCard, /zu-syscfg-thh">危险阈值/);
  assert.match(cfgCard, /zu-syscfg-thl">CPU 使用率/);
  assert.match(cfgCard, /zu-syscfg-thl">内存使用率/);
  assert.match(cfgCard, /zu-syscfg-thl">磁盘可用率/);
  assert.match(cfgCard, /zu-syscfg-unit">%</);
  assert.match(cfgCard, /zu-syscfg-unit">秒/);
  assert.match(source, /\.zu-syscfg \.zu-syscfg-item>input\[type=checkbox\]\{order:0/, 'checkbox order:0 抵消通用 order:2（开关回到文字前；规则在 CSS 不在 HTML 产物）');
  assert.match(source, /\.zu-syscfg \.zu-syscfg-item\{display:inline-flex/, 'item 双类前缀 (0,2,0)（降级单类会输给通用 label>span 的 flex:1，review A3）');
  assert.match(source, /\.zu-layout-card:not\(\.zu-syscfg\)/, 'refreshLayoutEditor 显式排除系统状态卡（防 DOM 序耦合，review A2）');
  assert.match(source, /sysTip\.contains\(e\.relatedTarget\)/, 'chip blur relatedTarget 守卫（焦点入浮层不收卡）');
  assert.match(source, /\.zu-syscfg-num\{width:56px;height:28px;[\s\S]*?border:1px solid/, '数字输入框显式边框/高度');
  assert.match(cfgCard, /自动适配（推荐）/, '显示格式短文案（长示例移帮助行）');
  assert.match(cfgCard, /同一挂载点或同一设备的重复卷自动去重/, '磁盘目标说明');
  // 阈值关系校验：合法 cfg 初始 hidden；非法 cfg 初始即提示
  assert.match(cfgCard, /data-zu-sys-therr hidden/);
  const badState = JSON.parse(JSON.stringify(state));
  badState.sysmonCfg.thresholds.cpuWarn = 95;
  /* spCtx/ctxBad 的 sysThresholdIssues 一律用生产函数切片（手写桩会与生产漂移成假绿，review D3） */
  const issCtx = { L: (zh) => zh };
  vm.runInNewContext(sliceText('  function sysThresholdIssues(cfg) {', '  /* 阈值明细表（ⓘ 展开区内容') + '\nglobalThis.f = sysThresholdIssues;', issCtx);
  const sysThresholdIssuesProd = issCtx.f;
  const ctxBad = Object.assign({}, ctx, { state: badState, sysThresholdIssues: sysThresholdIssuesProd });
  vm.runInNewContext(helpers + '\n' + seg + '\nglobalThis.h = barOrderSettingsHtml; globalThis.sys = sysmonSettingsHtml;', ctxBad);
  assert.match(ctxBad.sys(), /data-zu-sys-therr>CPU：预警阈值需小于危险阈值/, 'LS 遗留非法阈值初始即提示');
  // 无 sysFrame 时预览显 — 占位（不用演示数字冒充真实采集结果）
  assert.match(cfgCard, /zu-syscfg-prev/);
  assert.match(cfgCard, /—</);
  assert.ok(!cfgCard.includes('value="23"'), '预览绝不出现演示数字');
  // syncPanel 回填：帧数据有 sysmonCfg 时按值填充
  const mBoxes = ['cpu', 'mem', 'disk'].map((k) => ({ checked: false, getAttribute: () => k }));
  const thBoxes = [{ k: 'cpuWarn', value: '', getAttribute: () => 'cpuWarn' }, { k: 'memCrit', value: '', getAttribute: () => 'memCrit' }];
  const fmtSel = { value: '' };   // 桩固定引用：断言读同一次填充结果
  const panel = {
    querySelectorAll(sel) {
      if (sel === '.zu-syscfg-m') return mBoxes;
      if (sel === '.zu-syscfg-vol') return [
        { checked: false, getAttribute: () => 'projectVol' },
        { checked: false, getAttribute: () => 'systemVol' }];
      if (sel === '.zu-syscfg-th') return thBoxes;
      return [];
    },
    querySelector(sel) {
      if (sel === '.zu-syscfg-warn') return { checked: false };
      if (sel === '.zu-syscfg-fmt') return fmtSel;
      if (sel === '.zu-syscfg-int') return { value: '' };
      if (sel === '.zu-syscfg-dint') return { value: '' };
      return { value: '', checked: false };   // 其余 syncPanel 控件桩（.zu-ctxov 等）
    },
  };
  const spCtx = {
    panel, state,
    zuBarOrderNormalize: (r) => r, zuBarPriorityNormalize: (r) => r || {},
    refreshLayoutEditor: () => {}, syncUpdate: () => {}, LS: {}, persistSysmonCfg: () => {},
    normalizeSysmonCfg: (r) => r,
    sysThresholdIssues: sysThresholdIssuesProd,
    zuRotatorSyncPanel: null, epReconcile: null, epSyncDirtyStatus: null,
  };
  const spA = source.indexOf('    function syncPanel() {');
  const spB = source.indexOf('    var relaunchAckTimer = 0;', spA);
  assert.ok(spA >= 0 && spB > spA, 'syncPanel 切片锚点');
  vm.runInNewContext(source.slice(spA, spB) + '\nglobalThis.sp = syncPanel;', spCtx);
  spCtx.sp();
  assert.equal(panel.querySelectorAll('.zu-syscfg-m')[2].checked, true, '磁盘开关按 cfg 回填');
  assert.equal(panel.querySelectorAll('.zu-syscfg-th')[1].value, '90', '阈值按 cfg 回填');
  assert.equal(panel.querySelector('.zu-syscfg-fmt').value, 'auto');
});

test('chip blur 守卫（v362 review C5）：焦点移入 sysTip 不收卡、真离开才收', () => {
  /* 切片锚点（review C5 配方）：产物缩进比分片少 2 空格；__zuWired 在 git chip 区还有一处，
   * 须以 sysmonChipCache 赋值点为界 lastIndexOf 取 sysmon 侧接线块 */
  const b = source.indexOf('        sysmonChipCache = chip;');
  assert.ok(b > 0, 'sysmonChipCache 锚点');
  const a = source.lastIndexOf('        if (!chip.__zuWired) {', b);
  assert.ok(a > 0 && a < b, '__zuWired 接线块锚点');
  const seg = source.slice(a, b + '        sysmonChipCache = chip;'.length);
  const handlers = {};
  const hides = [];
  const chip = {
    addEventListener: (type, fn) => { handlers[type] = fn; },
  };
  const ctx = {
    chip,
    sysTip: { contains: (t) => t === 'inTip' },
    hideSysTip: () => hides.push(1),
    onSysChipEnter: () => {}, hideSysTipSoon: () => {},
    onSysChipKey: () => {}, onSysChipKeyup: () => {}, onSysChipClick: () => {},
  };
  vm.runInNewContext(seg + '\nglobalThis.wire = () => {};', ctx);
  assert.ok(handlers.blur, 'blur 监听已挂');
  /* 焦点移入浮层内部：不收（Windows 上 button mousedown 即移焦，blur 先于 click 的病灶） */
  handlers.blur({ relatedTarget: 'inTip' });
  assert.deepEqual(hides, [], 'relatedTarget 在 sysTip 内不收卡');
  /* 焦点真离开（relatedTarget null 或浮层外）：收 */
  handlers.blur({ relatedTarget: null });
  assert.deepEqual(hides, [1], 'relatedTarget null 收卡');
  handlers.blur({ relatedTarget: 'elsewhere' });
  assert.deepEqual(hides, [1, 1], '浮层外目标收卡');
});
