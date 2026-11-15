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
  vm.runInNewContext(helpers + '\nglobalThis.api = {normalizeSysmonCfg, sysmonFaceHtml, sysmonTipHtml, sysSeverityOf, sysSeveritySmoothed, sysFmtBytes, sysVolPick, sysIsStale, SYSMON_ICONS, sysSevCls};', ctx);
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

test('sysmonTipHtml: 结构、动态刷新说明、条件行、磁盘表与转义', () => {
  const api = evalHelpers({ L: (zh, en) => zh });
  const NOW = 1700000000000 + 1000;   // 新鲜度按传入时钟判（不碰真实时钟）
  const html = api.sysmonTipHtml(CFG, frameOf({}), NOW);
  assert.match(html, /系统状态/);
  assert.match(html, /实时 5s · 磁盘 60s/);   // 按 cfg 动态，不写死
  assert.match(html, /整机使用率/);
  assert.match(html, /8 核/);
  assert.match(html, /Load 1m\/5m\/15m/);
  assert.match(html, /Wired 2\.1G/);
  assert.match(html, /Swap 614M \/ 1G/);
  assert.match(html, /zu-sys-vols/);
  assert.match(html, /项目卷 Data/);
  assert.match(html, /zu-sys-cur/);            // 项目卷高亮行
  assert.match(html, /预警（/);
  assert.match(html, /CPU ≥80%/);              // 图例按阈值动态生成
  assert.match(html, /磁盘可用 ≤10%/);
  assert.ok(!html.includes('数据已过期'), '新鲜帧无过期注记');
  // 条件行：无 Wired/Swap 不伪造；load 缺席整行隐藏；Windows load null 同效
  const bare = api.sysmonTipHtml(CFG, frameOf({
    mem: { state: 'ok', total: 8589934592, used: 2147483648, avail: 6442450944, pct: 25, wired: null, swap_total: null, swap_used: null },
    cpu: { state: 'ok', pct: 10, cores: 4, load: null },
  }), NOW);
  assert.ok(!bare.includes('Wired'), '无 Wired 不渲染假值');
  assert.ok(!bare.includes('Swap '), '无 Swap 不渲染假值');
  assert.ok(!bare.includes('Load 1m'), '无负载整行隐藏');
  // 过期注记 + 采样秒数动态化
  const cfg2 = JSON.parse(JSON.stringify(CFG)); cfg2.intervalMs = 3000;
  const staleF = frameOf({}); staleF.ts = 1;
  assert.match(api.sysmonTipHtml(cfg2, staleF), /实时 3s/);
  assert.match(api.sysmonTipHtml(cfg2, staleF), /数据已过期/);
  // 卷名转义
  const evil = frameOf({ disk: { state: 'ok', vols: [{ id: '/x', name: '<script>alert(1)</script>', mount: '/x', role: 'project', total: 1, used: 0, avail: 1, free_pct: 100 }] } });
  const escaped = api.sysmonTipHtml(CFG, evil, NOW);
  assert.ok(!escaped.includes('<script>'), '卷名用户数据必须转义');
  assert.ok(escaped.includes('&lt;script&gt;'));
  // 采集中
  assert.match(api.sysmonTipHtml(CFG, null, NOW), /采集中/);
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
