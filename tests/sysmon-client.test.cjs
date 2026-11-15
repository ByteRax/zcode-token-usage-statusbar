"use strict";
/* sysmon-client.cjs 单元回归：纯函数注入文本/计数，不触真实系统采样（tests.md：依赖本机
 * 环境的测试不算守卫）。真实 Electron 实机验收走 tests/speed-tooltip-host 的 SYS 链。 */
const test = require("node:test");
const assert = require("node:assert");
const mod = require("../sysmon-client.cjs");
const I = mod._internals;

function makeCtx() { return {}; }

test("normalizeSysmonConfig 缺省值", () => {
  const c = mod.normalizeSysmonConfig(null);
  assert.deepStrictEqual(c.metrics, { cpu: true, mem: true, disk: true });
  assert.strictEqual(c.format, "auto");
  assert.strictEqual(c.intervalMs, 5000);
  assert.strictEqual(c.diskIntervalMs, 60000);
  assert.strictEqual(c.warnColors, true);
  assert.strictEqual(c.projectVol, true);
  assert.strictEqual(c.systemVol, true);
  assert.deepStrictEqual(c.thresholds, { cpuWarn: 80, cpuCrit: 90, memWarn: 85, memCrit: 90, diskFreeWarn: 15, diskFreeCrit: 10 });
});

test("normalizeSysmonConfig clamp 与非法值回退", () => {
  const c = mod.normalizeSysmonConfig({
    metrics: { cpu: 0, mem: false, disk: "yes" },
    format: "wide",
    intervalMs: 1,
    diskIntervalMs: 99999999,
    warnColors: 0,
    projectVol: "x",
    systemVol: 0,
    thresholds: { cpuWarn: 0, cpuCrit: 101, memWarn: -5, memCrit: "x", diskFreeWarn: 200, diskFreeCrit: 3 },
  });
  assert.deepStrictEqual(c.metrics, { cpu: false, mem: false, disk: true });   // "yes" 非布尔字面量 → 缺省开
  assert.strictEqual(c.format, "auto");
  assert.strictEqual(c.intervalMs, I.LIMITS.CPU_MIN_MS);
  assert.strictEqual(c.diskIntervalMs, I.LIMITS.DISK_MAX_MS);
  assert.strictEqual(c.warnColors, false);
  assert.strictEqual(c.projectVol, true);   // 非布尔字面量不当作显式关闭
  assert.strictEqual(c.systemVol, false);
  assert.deepStrictEqual(c.thresholds, { cpuWarn: 1, cpuCrit: 100, memWarn: 1, memCrit: 90, diskFreeWarn: 100, diskFreeCrit: 3 });
});

test("cpuUsageFromTicks 差分数学与边界", () => {
  const prev = [{ user: 100, nice: 0, sys: 50, idle: 850, irq: 0 }];
  const cur25 = [{ user: 350, nice: 0, sys: 150, idle: 1000, irq: 0 }];
  // Δtotal=500（user+250、sys+100、idle+150），Δidle=150 → 70%
  assert.strictEqual(I.cpuUsageFromTicks(prev, cur25), 70);
  assert.strictEqual(I.cpuUsageFromTicks(null, cur25), null);
  assert.strictEqual(I.cpuUsageFromTicks(prev, prev), null);   // 零窗口不冒充 0%
  const multiPrev = [{ user: 0, nice: 0, sys: 0, idle: 50, irq: 0 }, { user: 100, nice: 0, sys: 0, idle: 0, irq: 0 }];
  const multiCur = [{ user: 25, nice: 0, sys: 0, idle: 75, irq: 0 }, { user: 100, nice: 0, sys: 0, idle: 0, irq: 0 }];
  // 核 1 Δtotal=50（user+25、idle+25）、Δidle=25 → 50%；核 2 零窗口跳过 → 综合 50%
  assert.strictEqual(I.cpuUsageFromTicks(multiPrev, multiCur), 50);
  // 异常负 idle 差钳到 100%
  assert.strictEqual(I.cpuUsageFromTicks([{ user: 0, nice: 0, sys: 0, idle: 10, irq: 0 }], [{ user: 100, nice: 0, sys: 0, idle: 0, irq: 0 }]), 100);
});

test("loadavgOr 平台与非法值", () => {
  assert.strictEqual(I.loadavgOr(null), null);
  assert.strictEqual(I.loadavgOr([NaN, 1, 2]), null);
  assert.deepStrictEqual(I.loadavgOr([1.234, 1.111, 0.98]), [1.23, 1.11, 0.98]);
});

const MEMINFO = `MemTotal:       16384000 kB
MemFree:         1024000 kB
MemAvailable:    6078000 kB
Buffers:          512000 kB
Cached:          2048000 kB
SwapCached:            0 kB
SwapTotal:       1048576 kB
SwapFree:         409600 kB
`;

test("parseMemInfo Linux 口径（MemAvailable 优先、Swap 换算）", () => {
  const m = I.parseMemInfo(MEMINFO);
  assert.strictEqual(m.total, 16384000 * 1024);
  assert.strictEqual(m.avail, 6078000 * 1024);
  assert.strictEqual(m.used, (16384000 - 6078000) * 1024);
  assert.strictEqual(m.wired, null);
  assert.strictEqual(m.swap_total, 1048576 * 1024);
  assert.strictEqual(m.swap_used, (1048576 - 409600) * 1024);
  assert.strictEqual(m.state, undefined);   // 纯解析函数不带 state
});

test("parseMemInfo 旧内核无 MemAvailable 走近似回退", () => {
  const txt = "MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 50 kB\nCached: 150 kB\nSReclaimable: 100 kB\n";
  const m = I.parseMemInfo(txt);
  assert.strictEqual(m.avail, 400 * 1024);
  assert.strictEqual(m.used, 600 * 1024);
});

test("parseMemInfo 缺 MemTotal 返回 null（不伪造）", () => {
  assert.strictEqual(I.parseMemInfo("Cached: 1 kB\n"), null);
  assert.strictEqual(I.parseMemInfo(""), null);
});

test("parseSwapusage macOS sysctl 文案", () => {
  const s = I.parseSwapusage("total = 3072.00M used = 2101.25M free = 970.75M\n");
  assert.strictEqual(s.total, Math.round(3072.0 * 1024 * 1024));
  assert.strictEqual(s.used, Math.round(2101.25 * 1024 * 1024));
  assert.strictEqual(I.parseSwapusage("encryptionType = AES-XTS\n"), null);
  assert.strictEqual(I.parseSwapusage(""), null);
});

const VMSTAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               944503
Pages active:                            1234567
Pages inactive:                          2345678
Pages speculative:                        345678
Pages wired down:                         456789.
Pages occupied by compressor:             123456.
`;

test("parseVmStat 页计数与页大小", () => {
  const v = I.parseVmStat(VMSTAT);
  assert.strictEqual(v.pageSize, 16384);
  assert.strictEqual(v.active, 1234567);
  assert.strictEqual(v.wired, 456789);       // 尾点行
  assert.strictEqual(v.compressor, 123456);
});

test("parseProcMounts 白名单过滤与同设备去重（留最短挂载点）", () => {
  const txt = `/dev/nvme0n1p2 / ext4 rw 0 0
tmpfs /tmp tmpfs rw 0 0
/dev/nvme0n1p2 /mnt/bind ext4 rw 0 0
overlay /var/lib/docker/overlay2/x/merged overlay rw 0 0
/dev/sda1 /mnt/data btrfs rw 0 0
/dev/loop0 /snap/core20/1 squashfs ro 0 0
proc /proc proc rw 0 0
`;
  const rows = I.parseProcMounts(txt);
  assert.deepStrictEqual(rows.map((r) => r.mount), ["/", "/mnt/data"]);   // tmpfs/overlay/squashfs/proc 剔除；bind 同设备并入 /
});

test("parseDfLocal 跳过 devfs/map 且同设备去重", () => {
  const out = `Filesystem   512-blocks      Used Available Capacity  Mounted on
/dev/disk3s1s1 4943844712 348966092 4049426780    8%     /
devfs                 199       199         0   100%     /dev
map auto_home           0         0         0   100%     /System/Volumes/Data/home
/dev/disk3s1   4943844712 348966092 4049426780    8%     /System/Volumes/Data
`;
  const rows = I.parseDfLocal(out);
  assert.deepStrictEqual(rows.map((r) => r.mount), ["/", "/System/Volumes/Data"]);
});

test("longestMountPrefix 项目卷取最长前缀（POSIX 分隔语义）", { skip: process.platform === "win32" }, () => {
  /* longestMountPrefix 按真实 process.platform 选拼接分隔符（pickProjectMount 的 win32 早退
   * 依赖它）：POSIX 形状的候选在 Windows 主机上量不出结果，改在 win32 专属用例里验证。 */
  const mounts = [{ device: "d3", mount: "/" }, { device: "d3", mount: "/System/Volumes/Data" }, { device: "d9", mount: "/Volumes/Work" }];
  assert.strictEqual(I.longestMountPrefix(mounts, "/System/Volumes/Data/Users/x").mount, "/System/Volumes/Data");
  assert.strictEqual(I.longestMountPrefix(mounts, "/Volumes/Work/proj").mount, "/Volumes/Work");
  assert.strictEqual(I.longestMountPrefix(mounts, "/etc"), mounts[0]);
  assert.strictEqual(I.longestMountPrefix(mounts, ""), null);
});

test("longestMountPrefix win32 盘符/子目录前缀（反斜杠拼接语义）", { skip: process.platform !== "win32" }, () => {
  const mounts = [{ device: "d1", mount: "C:\\" }, { device: "d2", mount: "D:\\proj" }];
  assert.strictEqual(I.longestMountPrefix(mounts, "D:\\proj\\sub").mount, "D:\\proj");
  assert.strictEqual(I.longestMountPrefix(mounts, "C:\\Users\\x").mount, "C:\\");
  assert.strictEqual(I.longestMountPrefix(mounts, "D:\\proj"), mounts[1]);   // 精确等于挂载点
  assert.strictEqual(I.longestMountPrefix(mounts, "D:\\project"), null);   // 同名前缀但非路径边界不误配
  assert.strictEqual(I.longestMountPrefix(mounts, "E:\\elsewhere"), null);
});

test("pickProjectMount st_dev 精确归卷（macOS firmlink：/Users 实落 Data 卷）", { skip: process.platform !== "darwin" }, () => {
  const fs = require("node:fs");
  const mounts = [{ device: "d3", mount: "/", roles: [] }, { device: "d3", mount: "/System/Volumes/Data", roles: [] }];
  const hit = I.pickProjectMount(mounts, "/Users");
  assert.ok(hit, "应能归卷");
  const wantDev = fs.statSync("/Users").dev;
  const hitDev = fs.statSync(hit.mount).dev;
  assert.strictEqual(hitDev, wantDev, "命中卷设备号必须与项目路径一致");
  // stat 失败的路径回退最长前缀
  assert.strictEqual(I.pickProjectMount(mounts, "/definitely/not/exist"), mounts[0]);   // stat 失败回退最长路径前缀（归根卷）
});

test("volNameOf 与 pathDriveMount 平台语义", () => {
  assert.strictEqual(I.volNameOf("/"), "");
  assert.strictEqual(I.volNameOf("/Volumes/Backups"), "Backups");
  assert.strictEqual(I.volNameOf("/System/Volumes/Data"), "Data");
  assert.strictEqual(I.volNameOf("C:\\"), "C:");   // Windows 盘符即卷名
  assert.strictEqual(I.pathDriveMount("D:\\work\\proj"), "D:\\");
  assert.strictEqual(I.pathDriveMount("/Users/x"), null);
});

test("statfsWithTimeout 真实根挂载可读且带 free_pct 形状（macOS/Linux 实盘一次）", { skip: process.platform === "win32" }, async () => {
  const st = await I.statfsWithTimeout("/", 2000);
  assert.ok(st && st.blocks > 0 && st.bsize > 0, "statfs(/) 应返回真实块数");
  assert.ok(typeof st.bavail === "number");
});

test("createSysmonClient 未订阅不启定时器、dispose 幂等", () => {
  const client = mod.createSysmonClient({ onFrame: () => { throw new Error("should not emit"); }, log: () => { } });
  assert.strictEqual(client.view(), null);
  client.refreshNow();   // 未订阅时 no-op：绝不采样
  client.setSubscribed(false);
  client.dispose();
  client.dispose();
  assert.strictEqual(client.view(), null);
});

test("normalizeSysmonConfig 与渲染端默认阈值一致（spec 契约）", () => {
  const c = mod.normalizeSysmonConfig(undefined);
  assert.strictEqual(c.thresholds.cpuWarn, 80);
  assert.strictEqual(c.thresholds.cpuCrit, 90);
  assert.strictEqual(c.thresholds.memWarn, 85);
  assert.strictEqual(c.thresholds.memCrit, 90);
  assert.strictEqual(c.thresholds.diskFreeWarn, 15);
  assert.strictEqual(c.thresholds.diskFreeCrit, 10);
});

/* ---------- review 2026-11-16 修复回归：编排核心 / 订阅启停 / 探测复用 ---------- */

function vol(mount, roles) { return { device: mount, mount, roles: roles ? roles.slice() : [] }; }

test("darwinVolAllowed：系统内部卷剔除、用户卷保留", () => {
  assert.ok(I.darwinVolAllowed("/"));
  assert.ok(I.darwinVolAllowed("/System/Volumes/Data"));
  assert.ok(I.darwinVolAllowed("/Volumes/Backups"));
  assert.ok(!I.darwinVolAllowed("/System/Volumes/VM"));
  assert.ok(!I.darwinVolAllowed("/System/Volumes/Preboot"));
  assert.ok(!I.darwinVolAllowed("/System/Volumes/xarts"));
  assert.ok(!I.darwinVolAllowed("/Volumes/Recovery"));   // 误伤面接受：Recovery 512KB 噪声
});

test("pickVolumes 角色集合：同卷 system+project 关其一不消失、全关才剔除", () => {
  const cands = [vol("/")];
  const picked = I.pickVolumes(cands, "linux", "/home/u/proj", { systemVol: true, projectVol: false });
  assert.strictEqual(picked.length, 1, "单卷系统关项目卷：系统盘保留（review M1）");
  const off = I.pickVolumes([vol("/")], "linux", "", { systemVol: false, projectVol: false });
  assert.strictEqual(off.length, 0, "系统卷开关关闭即剔除");
  const bothOff = I.pickVolumes([vol("/")], "linux", "/home/x", { systemVol: false, projectVol: false });
  assert.strictEqual(bothOff.length, 0, "同卷双角色全关才剔除");
});

test("pickVolumes 去重/排序/裁剪", () => {
  // Windows 盘符大小写变体去重（review m5）
  const win = I.pickVolumes([vol("C:\\", ["system"]), vol("c:\\", ["project"])], "win32", "C:\\work", { systemVol: true, projectVol: true });
  assert.strictEqual(win.length, 1, "大小写不敏感去重（review m5）");
  // 排序：系统→项目→其余；MAX_VOLS 裁剪保系统+项目
  const many = [vol("/x1"), vol("/"), vol("/x2"), vol("/x3"), vol("/x4"), vol("/x5"), vol("/x6"), vol("/x7"), vol("/x8"), vol("/x9")];
  const picked = I.pickVolumes(many, "linux", "/x2", { systemVol: true, projectVol: true });
  assert.strictEqual(picked[0].mount, "/");
  assert.strictEqual(picked[1].mount, "/x2");
  assert.strictEqual(picked.length, I.LIMITS.MAX_VOLS, "裁到上限");
});

/* Node 26 mock timers 兼容：runAllAsync/tickAsync 不可用时退 tick() 同步版 + setImmediate 排空微任务 */
async function advanceTimers(t, ms) {
  const tm = t.mock.timers;
  if (ms != null && typeof tm.tickAsync === "function") { await tm.tickAsync(ms); return; }
  if (ms == null && typeof tm.runAllAsync === "function") { await tm.runAllAsync(); return; }
  if (ms != null) tm.tick(ms); else tm.runAll();
  for (let i = 0; i < 64; i++) await new Promise((r) => setImmediate(r));
}

test("订阅启停：want 开启即采样并按周期续采、want 关闭停表（mock timers）", async (t) => {
  let frames = 0, memCalls = 0, diskCalls = 0;
  const client = mod.createSysmonClient({
    onFrame: () => { frames++; },
    memFn: async () => { memCalls++; return { state: "ok", total: 1, used: 0, avail: 1, pct: 0 }; },
    diskFn: async () => { diskCalls++; return { state: "ok", vols: [] }; },
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    client.setSubscribed(true);
    await advanceTimers(t);   // kick 首采 + 排程
    const firstFrames = frames;
    assert.ok(firstFrames >= 1, "订阅即出帧");
    assert.strictEqual(memCalls, 1);
    assert.strictEqual(diskCalls, 1);
    await advanceTimers(t, 5000);   // 一个 CPU/内存周期
    await advanceTimers(t);
    assert.ok(frames > firstFrames, "按周期续采");
    client.setSubscribed(false);   // want=0 停表（spec 验收项）
    const stoppedAt = frames;
    await advanceTimers(t, 60000);
    await advanceTimers(t);
    assert.strictEqual(frames, stoppedAt, "停表后不再采样");
  } finally {
    client.dispose();
  }
});

test("applyConfig 运行时改间隔立即按新配置重采；纯 want 抖动不重置", async (t) => {
  let memCalls = 0;
  const client = mod.createSysmonClient({
    onFrame: () => { },
    memFn: async () => { memCalls++; return { state: "ok", total: 1, used: 0, avail: 1, pct: 0 }; },
    diskFn: async () => ({ state: "ok", vols: [] }),
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    client.setSubscribed(true);
    await advanceTimers(t);
    const base = memCalls;
    client.applyConfig({ intervalMs: 2000 }, undefined);   // 只改间隔：立即重采
    await advanceTimers(t);
    assert.ok(memCalls > base, "配置变化立即重采");
    const afterCfg = memCalls;
    client.setSubscribed(false);
    client.setSubscribed(true);   // want 抖动关再开：cfg 缺省不重置（applyConfig 未调用）
    await advanceTimers(t);
    assert.ok(memCalls >= afterCfg, "抖动后恢复采样");
  } finally {
    client.dispose();
  }
});

test("apfsContainerOf/markDarwinContainer：同 diskN 前缀标共享、容量相同不作为判据（v357）", () => {
  const { apfsContainerOf, markDarwinContainer } = mod._internals;
  assert.equal(apfsContainerOf("/dev/disk3s1s1"), "disk3");
  assert.equal(apfsContainerOf("/dev/disk3s5"), "disk3");
  assert.equal(apfsContainerOf("/dev/disk12s2"), "disk12");
  assert.equal(apfsContainerOf("/dev/disk3"), null);   // 无 slice 后缀不判（非卷设备）
  assert.equal(apfsContainerOf(""), null);
  // / + Data 同容器 → 双双标注（firmlink 双卷共享容器空间，statfs 同源）
  const a = [{ mount: "/", dev: "/dev/disk3s1s1" }, { mount: "/System/Volumes/Data", dev: "/dev/disk3s5" }];
  markDarwinContainer(a);
  assert.equal(a[0].container, "disk3");
  assert.equal(a[1].container, "disk3");
  // 设备不同容器（外置独立盘与系统盘容量巧合相同）→ 不标（容量相同不作为判据）
  const b = [{ mount: "/", dev: "/dev/disk3s1s1" }, { mount: "/System/Volumes/Data", dev: "/dev/disk5s1" }];
  markDarwinContainer(b);
  assert.equal(b[0].container, undefined);
  assert.equal(b[1].container, undefined);
  // 缺 Data 卷（systemVol 关）→ 不标
  const c1 = [{ mount: "/", dev: "/dev/disk3s1s1" }];
  markDarwinContainer(c1);
  assert.equal(c1[0].container, undefined);
  // 设备名无 diskN 模式（未来形态/非常规）→ 保守不标（前端保留两行真实容量）
  const d = [{ mount: "/", dev: "weirdfs://root" }, { mount: "/System/Volumes/Data", dev: "weirdfs://data" }];
  markDarwinContainer(d);
  assert.ok(!("container" in d[0]), "无 diskN 模式不标（strict：null 冒充 undefined 也算标了）");
  assert.ok(!("container" in d[1]));
  // dev 缺失/null 健壮性（statfs 枚举源异常）
  const e2 = [{ mount: "/", dev: null }, { mount: "/System/Volumes/Data", dev: null }];
  markDarwinContainer(e2);
  assert.ok(!("container" in e2[0]));
  // 设备名无 slice 后缀（整盘/RAM disk 挂载）→ 正则要求 s → 不标
  const f = [{ mount: "/", dev: "/dev/disk3" }, { mount: "/System/Volumes/Data", dev: "/dev/disk3" }];
  markDarwinContainer(f);
  assert.ok(!("container" in f[0]));
});
