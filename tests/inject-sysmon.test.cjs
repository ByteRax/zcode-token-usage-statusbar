"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("vm");

const { getInjectSlice } = require("./helpers/overlay-extract.cjs");

/* sysmon 订阅接线单测（v358，specs/statusbar-system-status.md「采样器缺席自愈」）：
 * sysmon-client.cjs 是热模块，运行目录缺文件（Windows 实测部署缺口）时首个 sysmon-sub
 * 拿到 ok:false——handler 必须仍把 want 记进 sysmonSubs 并留档 cfg/projectPath，
 * 热换重建实例后按现存订阅重放（setSubscribed(true) + 回放 meta），格自愈。
 * sysmonSubs/sysmonClient/sysmonSubMeta 声明在切片外（:171-173），经沙箱注入替身。 */
const source = getInjectSlice("sysmonBlock");

function makeWc(id, pushes) {
  return {
    id,
    isDestroyed: () => false,
    executeJavaScript: async (js) => { pushes.push(js); return undefined; },
  };
}

/* sandbox 工厂：modError.error 非 null 时 require("./sysmon-client.cjs") 抛错（缺文件）；
 * 测试置 null 模拟热模块补上。clientFactory 记录 createSysmonClient 参数。 */
function makeSandbox({ modError = { error: null }, clientFactory = null, webContentsList = [], gitPathOk = () => true } = {}) {
  const deliveries = [], log = [];
  const sb = {
    sysmonSubs: new Map(),
    sysmonClient: null,
    sysmonSubMeta: null,
    loadedHashes: {},
    webContents: { getAllWebContents: () => webContentsList },
    isMainWindowState: () => true,
    isLocalHostPage: () => true,
    deliverPluginRequest: (wc, requestId, result) => deliveries.push({ requestId, result: { ...result } }),
    gitPathOk,
    LOG: (...a) => log.push(a.join(" ")),
    JSON, Date, Map, Array, Object, Promise, setTimeout, clearTimeout,
    require: (id) => {
      if (id !== "./sysmon-client.cjs") throw new Error("unexpected require: " + id);
      if (modError.error) { const e = new Error(modError.error); e.code = "MODULE_NOT_FOUND"; throw e; }
      return { createSysmonClient: (opts) => {
        const stub = {
          opts,
          applyConfigArgs: [],
          subscribed: null,
          setSubscribed(want) { this.subscribed = want; },
          applyConfig(cfg, projectPath) { this.applyConfigArgs.push([cfg, projectPath]); },
          onFrame(f) { opts.onFrame(f); },
        };
        if (clientFactory) clientFactory(stub);
        return stub;
      } };
    },
  };
  vm.runInNewContext(source, sb);
  return { sb, deliveries, log, modError };
}

const subOf = (sb, id) => sb.sysmonSubs.get(id);

test("sysmon-sub with sampler file missing still records the subscription and replies ok:false", () => {
  const { sb, deliveries } = makeSandbox({ modError: { error: "Cannot find module './sysmon-client.cjs'" } });
  const wc = makeWc(7, []);
  const cfgArg = { intervalMs: 4000 };
  sb.handleSysmonRequest({ want: true, cfg: cfgArg, projectPath: "D:\\proj" }, wc);
  assert.equal(subOf(sb, 7), true, "缺席也必须记账：热换重放路径靠 sysmonWantAny()");
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].result.ok, false);
  assert.match(deliveries[0].result.error, /sysmon unavailable/);
  assert.equal(sb.sysmonSubMeta.cfg, cfgArg, "cfg 按引用留档");
  assert.equal(sb.sysmonSubMeta.hasProjectPath, true);   // 跨 VM 域对象逐字段断言（原型不同，deepStrictEqual 会拒绝同形对象）
  assert.equal(sb.sysmonSubMeta.projectPath, "D:\\proj");
});

test("late-arriving sampler hot-loads, replays recorded meta and starts sampling for the waiting window", () => {
  const pushes = [];
  const wc = makeWc(7, pushes);
  const { sb, deliveries, modError } = makeSandbox({ modError: { error: "ENOENT" }, webContentsList: [wc] });
  sb.handleSysmonRequest({ want: true, cfg: { intervalMs: 4000 }, projectPath: "D:\\proj" }, wc);
  assert.equal(deliveries[0].result.ok, false);   // 首次缺席：ok:false

  // 模拟热换块（inject-main.cjs hotReloadMainModulesOnce 的 sysmon 分支）：重建 → sysmonWantAny → sync
  modError.error = null;   // sysmon-client.cjs 热补到位
  const client = sb.createSysmonClientInstance();
  assert.ok(client);
  assert.deepEqual(client.applyConfigArgs, [[{ intervalMs: 4000 }, "D:\\proj"]], "热换重建必须回放缺席期留档的 cfg/projectPath");
  assert.equal(sb.sysmonWantAny(), true);
  sb.sysmonSyncSubscribed();
  assert.equal(client.subscribed, true, "按现存订阅重放：自动开始采样");

  // 帧只推给已订阅窗口：走 pushSysmonTo 信任门落到 executeJavaScript
  client.onFrame({ v: 1, ts: 1, cpu: { state: "ok", pct: 1 }, mem: { state: "ok" }, disk: { state: "ok", vols: [] } });
  assert.equal(pushes.length, 1);
  assert.match(pushes[0], /^window\.__zusageSysmon && window\.__zusageSysmon\(/);
});

test("want=false unsubscribes even while the sampler is unavailable", () => {
  const { sb, deliveries } = makeSandbox({ modError: { error: "ENOENT" } });
  const wc = makeWc(9, []);
  sb.handleSysmonRequest({ want: true, projectPath: "D:\\proj" }, wc);
  const metaBefore = sb.sysmonSubMeta;   // 变异守卫：meta 只随 want:true 更新，摘订阅不得覆盖留档
  sb.handleSysmonRequest({ want: false }, wc);
  assert.equal(sb.sysmonSubMeta, metaBefore, "want=false 不得覆盖最近 want 留档");
  assert.equal(subOf(sb, 9), false);
  assert.equal(deliveries[1].result.ok, true, "摘订阅不依赖采样器可用性");
});

test("happy path unchanged: existing client gets req cfg/projectPath applied and replies ok:true", () => {
  const wc = makeWc(3, []);
  let created = 0;
  const { sb, deliveries } = makeSandbox({ clientFactory: () => { created++; }, webContentsList: [wc] });
  const existing = sb.createSysmonClientInstance();   // 冷启动已建好实例
  created = 0;   // 后续断言只看 handleSysmonRequest 是否重复建实例
  sb.handleSysmonRequest({ want: true, cfg: { intervalMs: 2000 }, projectPath: "D:\\proj" }, wc);
  assert.deepEqual(existing.applyConfigArgs, [[{ intervalMs: 2000 }, "D:\\proj"]]);
  assert.equal(created, 0, "已有实例不得重复建");
  assert.equal(subOf(sb, 3), true);
  assert.equal(existing.subscribed, true);
  assert.equal(deliveries[0].result.ok, true);
});

test("request without projectPath keeps previous projectPath on replay (hasProjectPath guard)", () => {
  const wc = makeWc(5, []);
  const { sb, modError } = makeSandbox({ modError: { error: "ENOENT" }, webContentsList: [wc] });
  sb.handleSysmonRequest({ want: true, cfg: null, projectPath: "D:\\first" }, wc);
  sb.handleSysmonRequest({ want: true }, wc);   // 无 projectPath 字段（兼容老渲染端形状）
  assert.equal(sb.sysmonSubMeta.cfg, null);
  assert.equal(sb.sysmonSubMeta.hasProjectPath, false);   // 跨 VM 域对象逐字段断言（原型不同，deepStrictEqual 会拒绝同形对象）
  assert.equal(sb.sysmonSubMeta.projectPath, "");
  modError.error = null;
  const client = sb.createSysmonClientInstance();
  assert.deepEqual(client.applyConfigArgs, [[null, undefined]], "回放时不得把空串当路径清掉项目卷标注");
});

test("invalid projectPath guard precedes accounting: nothing recorded, reply ok:false", () => {
  const { sb, deliveries } = makeSandbox({ modError: { error: "ENOENT" }, gitPathOk: () => false });
  const wc = makeWc(11, []);
  sb.handleSysmonRequest({ want: true, projectPath: "bad<path" }, wc);
  assert.equal(subOf(sb, 11), undefined);
  assert.equal(sb.sysmonSubMeta, null);
  assert.equal(deliveries[0].result.ok, false);
  assert.match(deliveries[0].result.error, /invalid project path/);
});

test("onFrame pushes only to windows with want=true recorded", () => {
  const pushes1 = [], pushes2 = [];
  const subbed = makeWc(1, pushes1), other = makeWc(2, pushes2);
  const { sb } = makeSandbox({ webContentsList: [subbed, other] });
  const client = sb.createSysmonClientInstance();
  sb.handleSysmonRequest({ want: true }, subbed);   // 只订阅 wc1
  client.onFrame({ v: 1, ts: 2, cpu: { state: "loading" }, mem: { state: "loading" }, disk: { state: "loading", vols: [] } });
  assert.equal(pushes1.length, 1, "已订阅窗口收帧");
  assert.equal(pushes2.length, 0, "未订阅窗口不收帧");
});

test("frames stop after the sole subscriber unsubscribes (want map drives delivery)", () => {
  const pushes = [];
  const wc = makeWc(4, pushes);
  const { sb } = makeSandbox({ webContentsList: [wc] });
  const client = sb.createSysmonClientInstance();
  sb.handleSysmonRequest({ want: true }, wc);
  sb.handleSysmonRequest({ want: false }, wc);
  client.onFrame({ v: 1, ts: 3, cpu: { state: "loading" }, mem: { state: "loading" }, disk: { state: "loading", vols: [] } });
  assert.equal(pushes.length, 0, "摘订阅后 onFrame 不再外发");
});
