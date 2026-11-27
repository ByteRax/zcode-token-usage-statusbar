"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const source = fs.readFileSync(path.join(__dirname, "..", "inject-main.cjs"), "utf8");
const flush = () => new Promise(resolve => setImmediate(resolve));
/* 夹具根：POSIX 沿用字面量 /fixture；win32 取带盘符的原生绝对路径——宿主页门（trustedSender /
 * isLocalHostPage / pollPluginRequests）按 path.relative(resourcesPath, fileURLToPath(url)) 判内外，
 * 窗口 URL 与 resourcesPath 必须同盘且都带盘符，无盘符的 file:///fixture/... 在 win32 解析即抛错、整窗被判外部页。 */
const FX = process.platform === "win32" ? path.resolve(path.sep, "fixture") : "/fixture";
const HOST_URL = require("node:url").pathToFileURL(path.join(FX, "resources", "index.html")).href;
/* mock fs 入口归一化：产品传入 path.join/path.resolve 的产物（win32 为反斜杠、带盘符），
 * 折成正斜杠、去盘符后再与 POSIX 夹具键比较。 */
const norm = p => String(p).replace(/\\/g, "/").replace(/^[a-zA-Z]:/, "");

/* v96 Git 状态旁路查询：整文件 vm 加载（同 inject-remote-recovery 模式），execFile 按 args
 * 分发夹具响应。覆盖 parseGitPorcelain/parseShortstat 纯函数、queryGitStatus 失败分类与
 * 无提交仓库回退、gitTick 的路径校验/去重/多窗口分发/非本地页忽略、git-refresh 动作路由。 */
function loadPump(respond = () => ({})) {
  const intervals = [], timers = new Map(), windows = [], execs = [];
  const watches = [], closed = [], timeouts = [], errors = [];
  const watchCtl = { fail: false };   // v420：fs.watch 建档失败开关（非致命用例）
  let id = 0;
  const state = { vanishOk: false };   // 测试可控的「目录存在性」开关（notrepo 补推用例）
  const mockFs = {
    readFileSync: file => String(file).endsWith("config.json") ? "{}" : "",
    statSync: raw => {
      const file = norm(raw);
      if (file === "/fixture/vanish") {
        if (state.vanishOk) return { isDirectory: () => true, mtimeMs: 1 };
        throw Object.assign(new Error("ENOENT: /fixture/vanish"), { code: "ENOENT" });
      }
      if (["/fixture/repo", "/fixture/repo2", "/fixture/parent", "/fixture/parent/a", "/fixture/parent/b"].includes(file)) return { isDirectory: () => true, mtimeMs: 1 };
      if (["/fixture/runtime/overlay.js", "/fixture/runtime/zusage.py"].includes(file)) return { mtimeMs: 1, size: 1 };
      throw Object.assign(new Error("ENOENT: " + file), { code: "ENOENT" });
    },
    readdirSync: dir => norm(dir) === "/fixture/parent" ? ["a", "b"] : [],
    existsSync: file => ["/fixture/parent/a/.git", "/fixture/parent/b/.git"].includes(norm(file)),
    watch: (dir, opts, fn) => {   // v420：记录建档/关闭，供 watcher 生命周期断言
      if (watchCtl.fail) throw new Error("EPERM: watch unavailable");
      watches.push({ dir, opts: opts || {}, fn });
      return { on(ev, cb) { if (ev === "error") errors.push({ dir, cb }); }, close() { closed.push(dir); } };
    },
    writeFileSync() {},
  };
  const ipc = new EventEmitter();
  const sandbox = {
    __dirname: path.join(FX, "runtime"), console: { error() {} },
    process: { resourcesPath: path.join(FX, "resources"), execPath: process.execPath, uptime: () => 1, env: {} },
    module: { exports: {} },
    setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); timers.set(++id, fn); return id; },
    clearTimeout: n => timers.delete(n),
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    require(name) {
      if (name === "fs") return mockFs;
      if (["path", "url", "crypto"].includes(name)) return require(name);
      if (name === "electron") return { app: { getPath: () => path.join(FX, "home"), on() {} }, webContents: { getAllWebContents: () => windows }, ipcMain: ipc };
      if (name === "child_process") return {
        spawn() {
          const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
          p.stdin = new EventEmitter(); p.stdin.writable = true; p.kill = () => {}; return p;
        },
        execFile(cmd, args, opts, cb) {
          execs.push({ cmd, args, opts });
          let r = {};
          try { r = respond(args) || {}; } catch (e) { r = { error: e }; }
          if (r.wait) r.wait.then(() => cb(r.error || null, r.stdout || "", r.stderr || ""));
          else cb(r.error || null, r.stdout || "", r.stderr || "");
        },
      };
      throw new Error(name);
    },
  };
  vm.runInNewContext(source, sandbox);
  function addWindow(url = HOST_URL) {
    const wc = { id: windows.length + 1, gitPaths: [], requests: [], pushes: [],
      getType: () => "window", isDestroyed: () => false, getURL: () => url,
      executeJavaScript: async js => {
        if (js.includes("__zusageGitPaths")) return JSON.stringify(wc.gitPaths);
        if (js.includes("__zusagePluginRequests")) return wc.requests.splice(0, 8);
        if (js.startsWith("window.__zusageGitState") || js.startsWith("window.__zusageUpdate") || js.startsWith("window.__zusagePluginResult")) wc.pushes.push(js);
        return "null";
      } };
    windows.push(wc); return wc;
  }
  return { api: sandbox.module.exports.__zusageTest, intervals, execs, addWindow, state, watches, closed, timeouts, errors, watchCtl, sandbox };
}

/* ---------- parseGitPorcelain ---------- */

test("parseGitPorcelain: upstream with ahead/behind, per-code counts, rename and conflict", async () => {
  const { api } = loadPump();
  const r = api.parseGitPorcelain("## main...origin/main [ahead 2, behind 1]\x00M  a.py\x00 M b.py\x00?? c.py\x00R  newd.txt\x00oldd.txt\x00DD e.py\x00A  f.py\x00");
  assert.deepEqual({ ...r }, { branch: "main", upstream: "origin/main", ahead: 2, behind: 1,
    detached: false, noCommits: false, staged: 3, unstaged: 1, untracked: 1, conflicts: 1, changed: 5 });
});

test("parseGitPorcelain: collectFiles gathers labeled entries with cap and true total", async () => {
  const { api } = loadPump();
  /* 欠帽段：55 条 M + 5 条特殊状态 = 恰 60 条全收，逐状态验证标签 */
  const lines = ["## main"];
  for (let i2 = 0; i2 < 55; i2++) lines.push("M  f" + i2 + ".py");
  lines.push("?? u0.md", "D  del.js", "R  new.txt", "old.txt", "DD c.py", "A  add.py");
  const r = api.parseGitPorcelain(lines.join("\x00"), true);   // v433：-z NUL 分段（rename 占两个 token）
  assert.equal(r.files.length, 60);
  assert.equal(r.ft, 60, "ft=真实总条目数（changed+untracked）");
  /* VM realm 对象跨上下文 deepEqual 会因原型不等误报，展开成宿主对象再比 */
  assert.deepEqual({ ...r.files[0] }, { p: "f0.py", s: "modified" });
  assert.deepEqual({ ...r.files[55] }, { p: "u0.md", s: "untracked" });
  assert.deepEqual({ ...r.files[56] }, { p: "del.js", s: "deleted" });
  assert.deepEqual({ ...r.files[57] }, { p: "old.txt -> new.txt", s: "renamed" });   // rename 显示串=旧名 -> 新名（-z 双字段拼合）
  assert.deepEqual({ ...r.files[58] }, { p: "c.py", s: "conflict" });
  assert.deepEqual({ ...r.files[59] }, { p: "add.py", s: "added" });
  /* 超帽段：70 条 M + 5 条特殊 = 75 条，只收前 60，ft 仍报真实总数 */
  const big = ["## main"];
  for (let i3 = 0; i3 < 70; i3++) big.push("M  g" + i3 + ".py");
  big.push("?? u0.md", "D  del.js", "R  new.txt", "old.txt", "DD c.py", "A  add.py");
  const b = api.parseGitPorcelain(big.join("\x00"), true);
  assert.equal(b.files.length, 60, "明细帽 60 条");
  assert.equal(b.ft, 75, "超出帽后 ft 仍为真实总数（渲染端据以显「另有 N 项」）");
  const small = api.parseGitPorcelain("## main\x00M  a.py\x00?? b.md\x00", true);
  assert.equal(small.ft, 2);
  assert.deepEqual([...small.files].map(f => ({ ...f })), [{ p: "a.py", s: "modified" }, { p: "b.md", s: "untracked" }]);
  const none = api.parseGitPorcelain("## main\x00", true);
  assert.deepEqual([...none.files], []);   // 干净仓库：空数组（渲染端按 length 隐藏小节）
});

test("parseGitPorcelain: multi-repo pipeline keeps counts only (no files field)", async () => {
  const { api } = loadPump();
  const r = api.parseGitPorcelain("## main\x00M  a.py\x00?? b.md\x00");
  assert.equal(r.files, undefined, "多仓逐仓管线不收明细");
  assert.equal(r.ft, undefined);
});

test("parseGitPorcelain: numstatMap attaches per-file add/del, rename keyed by new name (v425)", async () => {
  const { api } = loadPump();
  const map = { "a": { ins: 3, del: 1 }, "new.txt": { ins: 2, del: 2 } };
  const r = api.parseGitPorcelain("## main\x00M  a\x00R  new.txt\x00old.txt\x00?? u.md\x00", true, map);
  assert.deepEqual([...r.files].map(f => ({ ...f })), [
    { p: "a", s: "modified", add: 3, del: 1 },
    { p: "old.txt -> new.txt", s: "renamed", add: 2, del: 2 },   // -z：XY 段=新名（映射键），下一段=旧名（显示串拼合）
    { p: "u.md", s: "untracked" },   // 未跟踪不在 numstat，无计数（行尾省略）
  ]);
  const noMap = api.parseGitPorcelain("## main\x00M  a\x00", true);
  assert.equal(noMap.files[0].add, undefined, "缺省不附计数（多仓/旧主进程形状不变）");
});

test("parseGitPorcelain: bare branch without upstream tracks nothing", async () => {
  const { api } = loadPump();
  const r = api.parseGitPorcelain("## main\x00");
  assert.deepEqual([r.branch, r.upstream, r.ahead, r.behind], ["main", "", 0, 0]);
});

test("parseGitPorcelain: detached HEAD and ahead-only tracking", async () => {
  const { api } = loadPump();
  const d = api.parseGitPorcelain("## HEAD (no branch)\x00");
  assert.deepEqual([d.detached, d.branch, d.upstream], [true, "", ""]);
  const a = api.parseGitPorcelain("## feat/x...origin/feat/x [ahead 3]\x00");
  assert.deepEqual([a.branch, r_up(a)], ["feat/x", "origin/feat/x"]);
  assert.deepEqual([a.ahead, a.behind], [3, 0]);
  function r_up(x) { return x.upstream; }
});

test("parseGitPorcelain: gone upstream and no-commits / initial-commit headers", async () => {
  const { api } = loadPump();
  const g = api.parseGitPorcelain("## main...origin/main [gone]\x00");
  assert.deepEqual([g.upstream, g.ahead, g.behind], ["origin/main", 0, 0]);
  const nc = api.parseGitPorcelain("## No commits yet on main\x00?? x\x00");
  assert.deepEqual([nc.noCommits, nc.branch, nc.untracked], [true, "main", 1]);
  const ic = api.parseGitPorcelain("## Initial commit on dev\x00");
  assert.deepEqual([ic.noCommits, ic.branch], [true, "dev"]);
});

test("parseGitPorcelain: tolerates trailing NUL, header-only and empty input (-z)", async () => {
  const { api } = loadPump();
  const r = api.parseGitPorcelain("## main\x00M  a\x00?? b\x00\x00");
  assert.deepEqual([r.branch, r.staged, r.untracked], ["main", 1, 1]);
  assert.deepEqual({ ...api.parseGitPorcelain("") },
    { branch: "", upstream: "", ahead: 0, behind: 0, detached: false, noCommits: false, staged: 0, unstaged: 0, untracked: 0, conflicts: 0, changed: 0 });
});

/* ---------- parseNumstat（v425 替代 parseShortstat）---------- */

test("parseNumstat: totals, binary dash rows, rename arrow keying, tab-in-path", async () => {
  const { api } = loadPump();
  const r = api.parseNumstat("12\t4\ta.py\x00-\t-\tbin.dat\x002\t1\t\x00old.md\x00new.md\x003\t0\tspace\tname.txt\x00");
  assert.equal(r.ins, 17, "二进制 - 计 0，其余求和（总量与 shortstat 口径等价）");
  assert.equal(r.del, 5);
  assert.deepEqual({ ...r.map["a.py"] }, { ins: 12, del: 4 });
  assert.equal(r.map["bin.dat"], undefined, "二进制不入映射（渲染端行尾省略）");
  assert.deepEqual({ ...r.map["new.md"] }, { ins: 2, del: 1 }, "-z rename 三段 NUL（空路径段为信号，旧名在前取后段新名）");
  assert.deepEqual({ ...r.map["space\tname.txt"] }, { ins: 3, del: 0 }, "路径含制表符不截断");
  const empty = api.parseNumstat("");
  assert.deepEqual([empty.ins, empty.del, Object.keys(empty.map).length], [0, 0, 0]);
  const m = api.mergeNumstat(api.parseNumstat("1\t2\ta.py\x00"), api.parseNumstat("5\t0\ta.py\x003\t1\tb.py\x00"));
  assert.deepEqual([m.ins, m.del], [9, 3], "无提交仓库两段合并总量");
  assert.deepEqual({ ...m.map["a.py"] }, { ins: 6, del: 2 }, "同路径跨段计数相加");
  assert.deepEqual({ ...m.map["b.py"] }, { ins: 3, del: 1 });
});

test("parseNumstat/parseGitPorcelain: paths named __proto__ or constructor are ordinary keys (no prototype pollution, no phantom counts)", async () => {
  // 复盘 MINOR：map 曾是普通对象——"__proto__" 文件会改掉它的原型，mergeNumstat 的 for...in
  // 随之枚举出假键 ins/del，名为 ins/del 的文件拿到幻影「无计数」
  const { api } = loadPump();
  const r = api.parseNumstat("5\t2\t__proto__\x001\t1\tconstructor\x003\t0\tins\x00");
  assert.equal(Object.getPrototypeOf(r.map), null, "映射是无原型对象");
  assert.deepEqual(Object.keys(r.map).sort(), ["__proto__", "constructor", "ins"], "三个路径都是自有键");
  assert.deepEqual([r.map.__proto__.ins, r.map.__proto__.del], [5, 2], "__proto__ 是普通键");
  assert.deepEqual([r.map.constructor.ins, r.map.constructor.del], [1, 1], "constructor 是普通键（不命中 Object.prototype）");
  const m = api.mergeNumstat(api.parseNumstat("1\t0\t__proto__\x00"), r);
  assert.equal(Object.getPrototypeOf(m.map), null);
  assert.deepEqual([m.map.__proto__.ins, m.map.__proto__.del], [6, 2], "跨段合并：仍是普通键且计数相加");
  assert.equal(Object.keys(m.map).length, 3, "合并不枚举出假键");
  // 文件行附计数：命中才有 add/del；不在 numstat 里的未跟踪不带幻影值
  const st = api.parseGitPorcelain("## main\0 M __proto__\0 M constructor\0?? new.txt\0", true, m.map);
  const rows = [...st.files].map((f) => ({ ...f }));
  assert.deepEqual([rows[0].p, rows[0].add, rows[0].del], ["__proto__", 6, 2]);
  assert.deepEqual([rows[1].p, rows[1].add, rows[1].del], ["constructor", 1, 1]);
  assert.deepEqual([rows[2].p, rows[2].add, rows[2].del], ["new.txt", undefined, undefined]);
});

test("parseNumstat: quotepath=false keeps raw UTF-8 paths for porcelain matching", async () => {
  const { api } = loadPump();
  const r = api.parseNumstat("1\t0\t说明.md\x00");
  assert.ok(r.map["说明.md"], "非 ASCII 路径原样入表");
});

/* ---------- queryGitStatus ---------- */

test("queryGitStatus: one status + one diff HEAD call with locked-down env, merged result", async () => {
  const respond = args => args.includes("status")
    ? { stdout: "## main...origin/main [ahead 2]\x00 M a\x00" }
    : { stdout: "12\t4\ta\x00" };
  const { api, execs } = loadPump(respond);
  const st = await api.queryGitStatus("/fixture/repo");
  assert.equal(st.ok, true);
  assert.deepEqual([st.branch, st.ahead, st.ins, st.del, st.unstaged], ["main", 2, 12, 4, 1]);
  /* v411 接线断言：单仓查询必须收逐文件明细（collectFiles=true 漏传即红，审查 MAJOR-1） */
  assert.equal(st.ft, 1);
  assert.deepEqual({ ...st.files[0] }, { p: "a", s: "modified", add: 12, del: 4 }, "v425：numstat 命中即附每文件 ±N");
  assert.equal(typeof st.ts, "number");
  assert.deepEqual(execs.map(e => [...e.args]), [
    ["-C", "/fixture/repo", "-c", "core.quotepath=false", "status", "--porcelain", "--branch", "-z"],
    ["-C", "/fixture/repo", "-c", "core.quotepath=false", "diff", "HEAD", "--numstat", "-z"],
  ]);
  assert.equal(execs[0].cmd, "git");
  assert.equal(execs[0].opts.env.GIT_OPTIONAL_LOCKS, "0");
  assert.equal(execs[0].opts.env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(execs[0].opts.env.LC_ALL, "C");
  assert.equal(execs[0].opts.timeout, 8000);
  assert.equal(execs[0].opts.windowsHide, true);
});

test("queryGitStatus: exit-128 not-a-repository maps to notrepo without running diff", async () => {
  const respond = () => ({ error: { code: 128 }, stderr: "fatal: not a git repository (or any of the parent directories): .git" });
  const { api, execs } = loadPump(respond);
  const st = await api.queryGitStatus("/fixture/repo");
  assert.deepEqual([st.ok, st.reason], [false, "notrepo"]);
  assert.equal(execs.length, 1);
});

test("queryGitStatus: ENOENT maps to nogit (single attempt, no diff)", async () => {
  const respond = () => ({ error: { code: "ENOENT" } });
  const { api, execs } = loadPump(respond);
  const st = await api.queryGitStatus("/fixture/repo");
  assert.deepEqual([st.ok, st.reason], [false, "nogit"]);
  assert.equal(execs.length, 1);
});

test("queryGitStatus: timed-out diff HEAD reports timeout without the two-call fallback", async () => {
  const respond = args => args.includes("status")
    ? { stdout: "## main\x00" }
    : { error: { killed: true } };
  const { api, execs } = loadPump(respond);
  const st = await api.queryGitStatus("/fixture/repo");
  assert.deepEqual([st.ok, st.reason], [false, "timeout"]);
  assert.equal(execs.length, 2, "status + diff HEAD，超时不走回退");
});

test("queryGitStatus: commit-less repo falls back to unstaged + cached numstat merge", async () => {
  const respond = args => {
    const cmd = args.join(" ");   // Array.includes 按整元素比较，"–cached"/"HEAD" 需按整串子串判断
    if (cmd.includes(" status ")) return { stdout: "## No commits yet on main\x00A  g.txt\x00" };
    if (cmd.includes("--cached")) return { stdout: "1\t0\tf.txt\x00" };
    if (cmd.includes(" HEAD ")) return { error: { code: 128 }, stderr: "fatal: ambiguous argument 'HEAD': unknown revision" };
    return { stdout: "2\t0\tg.txt\x00" };
  };
  const { api, execs } = loadPump(respond);
  const st = await api.queryGitStatus("/fixture/repo");
  assert.equal(st.ok, true);
  assert.deepEqual([st.noCommits, st.branch, st.ins, st.del], [true, "main", 3, 0]);
  assert.deepEqual({ ...st.files[0] }, { p: "g.txt", s: "added", add: 2, del: 0 }, "两段 numstat 逐路径合并后仍按路径附带");
  assert.deepEqual(execs.map(e => e.args.filter(a => a !== "-C" && a !== "/fixture/repo")).map(a => [...a]), [
    ["-c", "core.quotepath=false", "status", "--porcelain", "--branch", "-z"],
    ["-c", "core.quotepath=false", "diff", "HEAD", "--numstat", "-z"],
    ["-c", "core.quotepath=false", "diff", "--numstat", "-z"],
    ["-c", "core.quotepath=false", "diff", "--cached", "--numstat", "-z"],
  ]);
});

/* ---------- gitTick / 推送 / 动作路由 ---------- */

test("gitTick: dedupes valid local paths, filters invalid ones, pushes to each declaring window", async () => {
  const respond = args => args.includes("status") ? { stdout: "## main\x00" } : { stdout: "" };
  const h = loadPump(respond);
  const a = h.addWindow(), b = h.addWindow(), web = h.addWindow("https://example.com/");
  a.gitPaths = ["/fixture/repo", "relative", "/missing/repo", "/fixture/repo"];
  b.gitPaths = ["/fixture/repo"];
  web.gitPaths = ["/fixture/repo"];   // 非 file: 页面不读不推
  await h.api.gitTick(false); await flush();
  assert.equal(h.execs.filter(e => e.args.includes("status")).length, 1, "同仓库多窗口只查一次；非法/相对/不存在路径被过滤");
  const pick = wc => wc.pushes.find(js => js.startsWith("window.__zusageGitState && window.__zusageGitState(\"/fixture/repo\""));
  assert.ok(pick(a), "窗口 a 收到推送");
  assert.ok(pick(b), "窗口 b 收到推送");
  assert.equal(web.pushes.filter(js => js.includes("__zusageGitState")).length, 0, "外部页面不推");
  const payload = JSON.parse(pick(a).match(/^window\.__zusageGitState && window\.__zusageGitState\("\/fixture\/repo",(.*?)\)$/)[1]);
  assert.equal(payload.ok, true);
  assert.equal(payload.branch, "main");
});

test("gitTick: two distinct repositories each get one query", async () => {
  const respond = args => args.includes("status") ? { stdout: "## main\x00" } : { stdout: "" };
  const h = loadPump(respond);
  const wc = h.addWindow();
  wc.gitPaths = ["/fixture/repo", "/fixture/repo2"];
  await h.api.gitTick(false); await flush();
  const queried = h.execs.filter(e => e.args.includes("status")).map(e => e.args[1]);
  assert.deepEqual(queried.sort(), ["/fixture/repo", "/fixture/repo2"]);
  assert.equal(wc.pushes.filter(js => js.includes("__zusageGitState")).length, 2);
});

test("gitTick: no wanted paths means no git processes at all", async () => {
  const h = loadPump(() => { throw new Error("should not exec"); });
  h.addWindow();
  const wc = h.addWindow();
  wc.gitPaths = [];
  await h.api.gitTick(false); await flush();
  assert.equal(h.execs.length, 0);
});

test("gitTick: vanished declared paths get one notrepo push; recovery re-arms the notice", async () => {
  const respond = args => args.includes("status") ? { stdout: "## main\x00" } : { stdout: "" };
  const h = loadPump(respond);
  const wc = h.addWindow();
  wc.gitPaths = ["/fixture/repo", "/fixture/vanish"];
  h.state.vanishOk = false;
  await h.api.gitTick(false); await flush();
  const vanishPushes = () => wc.pushes.filter(js => js.includes("/fixture/vanish"));
  assert.equal(vanishPushes().length, 1, "消失的已声明路径补推一次 notrepo（chip 摘除，不残留删除前状态）");
  assert.match(vanishPushes()[0], /"ok":false/);
  assert.match(vanishPushes()[0], /notrepo/);
  wc.pushes.length = 0;
  await h.api.gitTick(false); await flush();
  assert.equal(vanishPushes().length, 0, "同一消失路径不逐拍重推");
  h.state.vanishOk = true;
  await h.api.gitTick(false); await flush();
  const repo2like = wc.pushes.filter(js => js.includes("/fixture/vanish") && /"ok":true/.test(js));
  assert.ok(repo2like.length >= 1, "目录恢复后正常查询并推送成功态");
  wc.pushes.length = 0;
  h.state.vanishOk = false;
  await h.api.gitTick(false); await flush();
  assert.equal(vanishPushes().length, 1, "再次消失重新通知（恢复即解除去重）");
});

test("gitTick: vanished path notifies every declaring window independently", async () => {
  const respond = args => args.includes("status") ? { stdout: "## main\x00" } : { stdout: "" };
  const h = loadPump(respond);
  const a = h.addWindow(), b = h.addWindow();
  a.gitPaths = ["/fixture/vanish"];
  b.gitPaths = ["/fixture/vanish"];
  h.state.vanishOk = false;
  await h.api.gitTick(false); await flush();
  const pushesOf = wc => wc.pushes.filter(js => js.includes("/fixture/vanish") && /notrepo/.test(js));
  assert.equal(pushesOf(a).length, 1, "窗口 A 补推一次");
  assert.equal(pushesOf(b).length, 1, "窗口 B 独立补推一次（去重按窗口×路径，不是全局路径）");
  a.pushes.length = b.pushes.length = 0;
  await h.api.gitTick(false); await flush();
  assert.equal(pushesOf(a).length + pushesOf(b).length, 0, "两窗都不逐拍重推");
  h.state.vanishOk = true;
  await h.api.gitTick(false); await flush();
  h.state.vanishOk = false;
  a.pushes.length = b.pushes.length = 0;
  await h.api.gitTick(false); await flush();
  assert.equal(pushesOf(a).length, 1, "恢复后 A 再消失重新通知");
  assert.equal(pushesOf(b).length, 1, "恢复后 B 再消失重新通知");
});

test("manual Git refresh waits for the follow-up tick when a poll is already running", async () => {
  let releaseFirst;
  let statusCalls = 0;
  const h = loadPump(args => {
    if (!args.includes("status")) return { stdout: "" };
    statusCalls++;
    if (statusCalls === 1) return { wait: new Promise(resolve => { releaseFirst = resolve; }), stdout: "## main\x00" };
    return { stdout: "## main\x00" };
  });
  const wc = h.addWindow();
  wc.gitPaths = ["/fixture/repo"];
  const first = h.api.gitTick(false);
  await flush();
  const refresh = h.api.gitTick(true, "manual-refresh-1", wc, "/fixture/repo");
  await flush();
  assert.equal(wc.pushes.some(js => js.includes("manual-refresh-1")), false, "busy poll must not acknowledge before the follow-up query");
  releaseFirst();
  await Promise.all([first, refresh]);
  await flush();
  assert.equal(statusCalls, 2, "manual refresh runs a second query after the existing poll");
  assert.ok(wc.pushes.some(js => js.includes("manual-refresh-1") && js.includes('"ok":true')));
});

test("manual Git refresh fails when its requested path is absent or query fails", async () => {
  const noPath = loadPump(() => ({ stdout: "## main\x00" }));
  const noPathWc = noPath.addWindow();
  await noPath.api.gitTick(true, "manual-empty", noPathWc, "/fixture/missing");
  await flush();
  assert.ok(noPathWc.pushes.some(js => js.includes("manual-empty") && js.includes("no paths") && js.includes('"ok":false')));

  const noPaths = loadPump(() => ({ stdout: "" }));
  const noPathsWc = noPaths.addWindow();
  await noPaths.api.gitTick(true, "manual-no-paths", noPathsWc, "");
  await flush();
  assert.ok(noPathsWc.pushes.some(js => js.includes("manual-no-paths") && js.includes("no paths") && js.includes('"ok":false')));

  const failed = loadPump(args => args.includes("status") ? { error: { code: 128 }, stderr: "fatal: not a git repository" } : { stdout: "" });
  const failedWc = failed.addWindow();
  failedWc.gitPaths = ["/fixture/repo"];
  await failed.api.gitTick(true, "manual-failed", failedWc, "/fixture/repo");
  await flush();
  assert.ok(failedWc.pushes.some(js => js.includes("manual-failed") && js.includes("query failed") && js.includes('"ok":false')));

  const multi = loadPump(args => {
    const cmd = args.map(norm).join(" ");   // 子仓 -C 路径是 path.join 产物：归一化后按 POSIX 夹具键分发
    if (cmd.includes("status") && cmd.includes("/fixture/parent")) return { error: { code: 128 }, stderr: "fatal: not a git repository" };
    if (cmd.includes("status") && cmd.includes("/fixture/parent/a")) return { stdout: "## main\x00" };
    if (cmd.includes("status") && cmd.includes("/fixture/parent/b")) return { error: { killed: true } };
    return { stdout: "" };
  });
  const multiWc = multi.addWindow();
  multiWc.gitPaths = ["/fixture/parent"];
  await multi.api.gitTick(true, "manual-multi-failed", multiWc, "/fixture/parent");
  await flush();
  assert.ok(multiWc.pushes.some(js => js.includes("manual-multi-failed") && js.includes("query failed") && js.includes("\"ok\":false")));
});

test("pollPluginRequests routes git-refresh to an immediate tick", async () => {
  const respond = args => args.includes("status") ? { stdout: "## main\x00" } : { stdout: "" };
  const h = loadPump(respond);
  const wc = h.addWindow();
  wc.gitPaths = ["/fixture/repo"];
  wc.requests = [{ action: "git-refresh" }];
  const poll = h.intervals.find(i => i.ms === 1000);
  assert.ok(poll, "pollPluginRequests 定时器已注册");
  await poll.fn(); await flush();
  assert.ok(h.execs.some(e => e.args.includes("status")));
  assert.ok(wc.pushes.some(js => js.includes("__zusageGitState")));
  assert.equal(wc.requests.length, 0, "请求已被 splice 消费");
});

/* ---------- v420 fs watch 刷新链（specs/git-chip-host-sync.md）---------- */

test("debounce tick colliding with an in-flight tick re-runs after it settles (v433)", async () => {
  let releaseFirst;
  let statusCalls = 0;
  const h = loadPump(args => {
    if (!args.includes("status")) return { stdout: "" };
    statusCalls++;
    if (statusCalls === 1) return { wait: new Promise(resolve => { releaseFirst = resolve; }), stdout: "## main\x00" };
    return { stdout: "## main\x00" };
  });
  const wc = h.addWindow();
  wc.gitPaths = ["/fixture/repo"];
  const first = h.api.gitTick(false);   // 首查在途
  await flush();
  await h.api.gitTick(false);           // 防抖 tick 撞在途：v433 起置 pending，不再静默丢弃
  await flush();
  assert.equal(statusCalls, 1, "在途期间不并发第二查");
  releaseFirst();
  await first; await flush();
  assert.equal(statusCalls, 2, "撞在途的防抖 tick 在结算后补跑（无条件 gitRefreshPending）");
});

test("git refresh has no polling interval; ticks are fs-watch driven (v420)", async () => {
  const h = loadPump();
  assert.equal(h.intervals.some(i => i.ms === 10000), false, "10s 轮询定时器已移除");
});

test("gitTick registers workspace watcher plus deduped .git metadata watchers", async () => {
  const respond = args => {
    const cmd = args.join(" ");
    if (cmd.includes("status")) return { stdout: "## main\x00" };
    if (cmd.includes("rev-parse")) return { stdout: "/fixture/repo/.git\n/fixture/repo/.git\n" };
    return { stdout: "" };
  };
  const h = loadPump(respond);
  const base = h.watches.length;   // 模块加载期其它链路的 watcher 记录作基线
  const wc = h.addWindow();
  wc.gitPaths = ["/fixture/repo"];
  await h.api.gitTick(false); await flush();
  const dirs = h.watches.slice(base).map(w => w.dir).sort();
  assert.deepEqual(dirs, ["/fixture/repo", "/fixture/repo/.git"], "工作区 + 元数据目录都已监听（相同目录去重）");
  const ws = h.watches.slice(base).find(w => w.dir === "/fixture/repo");
  assert.equal(ws.opts.recursive, true, "非 Linux 平台工作区递归监听");
  assert.equal(h.watches.slice(base).find(w => w.dir === "/fixture/repo/.git").opts.recursive, true, "元数据目录恒递归");
});

test("gitTick resolves a relative git-common-dir against the workspace path", async () => {
  const respond = args => {
    const cmd = args.join(" ");
    if (cmd.includes("status")) return { stdout: "## main\x00" };
    if (cmd.includes("rev-parse")) return { stdout: "/fixture/repo/.git\n../common/.git\n" };
    return { stdout: "" };
  };
  const h = loadPump(respond);
  const base = h.watches.length;
  const wc = h.addWindow();
  wc.gitPaths = ["/fixture/repo"];
  await h.api.gitTick(false); await flush();
  const dirs = h.watches.slice(base).map(w => w.dir).sort();
  assert.deepEqual(dirs, [path.resolve("/fixture/repo", "../common/.git"), "/fixture/repo", "/fixture/repo/.git"].sort(), "相对 --git-common-dir 按工作区 resolve（宿主同款，此处指向外部 common dir）");
});

test("workspace watch events arm a 60s trailing debounce that runs one full tick", async () => {
  const respond = args => args.includes("status") ? { stdout: "## main\x00" } : { stdout: "" };
  const h = loadPump(respond);
  const wc = h.addWindow();
  wc.gitPaths = ["/fixture/repo"];
  await h.api.gitTick(false); await flush();
  h.execs.length = 0; wc.pushes.length = 0;
  const before = h.timeouts.length;
  h.watches.find(w => w.dir === "/fixture/repo").fn("change");
  h.watches.find(w => w.dir === "/fixture/repo").fn("rename");
  const armed = h.timeouts.slice(before).filter(t => t.ms === 60000);
  assert.equal(armed.length, 2, "每个事件各重挂一次 60s 计时器（第二次 clearTimeout 重置第一次——尾随防抖）");
  assert.equal(h.execs.length, 0, "防抖期内不查询");
  armed[armed.length - 1].fn();
  await flush();
  assert.ok(h.execs.some(e => e.args.includes("status")), "静默满 60s 后全路径查询一轮");
  assert.ok(wc.pushes.some(js => js.includes("__zusageGitState")), "结果照常推送");
});

test("Linux keeps the workspace watcher non-recursive (host parity)", async () => {
  const respond = args => args.includes("status") ? { stdout: "## main\x00" } : { stdout: "" };
  const h = loadPump(respond);
  h.sandbox.process.platform = "linux";
  const wc = h.addWindow();
  wc.gitPaths = ["/fixture/repo"];
  await h.api.gitTick(false); await flush();
  assert.equal(h.watches.find(w => w.dir === "/fixture/repo").opts.recursive, false, "Linux 工作区禁递归（防慢挂载阻塞）");
});

test("watcher runtime error unhooks the path so the next tick rebuilds (v433)", async () => {
  const respond = args => args.includes("status") ? { stdout: "## main\x00" } : { stdout: "" };
  const h = loadPump(respond);
  const wc = h.addWindow();
  wc.gitPaths = ["/fixture/repo"];
  await h.api.gitTick(false); await flush();
  const countRepo = () => h.watches.filter(w => w.dir === "/fixture/repo").length;
  assert.equal(countRepo(), 1, "前置：工作区 watcher 已建");
  const err = h.errors.find(e => e.dir === "/fixture/repo");
  assert.ok(err, "error 回调已挂");
  err.cb(); await flush();   // 模拟运行期错误（目录被删重建等）
  await h.api.gitTick(false); await flush();
  assert.equal(countRepo(), 2, "摘档后下轮 tick 重建（死 watcher 不再占位冻结自动刷新）");
});

test("watchers are closed when a path leaves the union and not closed twice", async () => {
  const respond = args => args.includes("status") ? { stdout: "## main\x00" } : { stdout: "" };
  const h = loadPump(respond);
  const wBase = h.watches.length, cBase = h.closed.length;
  const wc = h.addWindow();
  wc.gitPaths = ["/fixture/repo", "/fixture/repo2"];
  await h.api.gitTick(false); await flush();
  assert.equal(h.watches.length - wBase, 2, "两仓库各建工作区 watcher（rev-parse 空输出无元数据监听）");
  wc.gitPaths = ["/fixture/repo"];
  await h.api.gitTick(false); await flush();
  assert.deepEqual(h.closed.slice(cBase).sort(), ["/fixture/repo2"], "路径离开并集后 watcher 关闭");
  await h.api.gitTick(false); await flush();
  assert.equal(h.closed.length - cBase, 1, "仍在并集内的 watcher 不重复关闭");
});

test("in-flight watcher resolution for a departed path is discarded (v433)", async () => {
  let revRelease;
  const revWait = new Promise(resolve => { revRelease = resolve; });
  const respond = args => {
    const cmd = args.join(" ");
    if (cmd.includes("status")) return { stdout: "## main\x00" };
    if (cmd.includes("rev-parse")) return { wait: revWait, stdout: "/fixture/repo/.git\x00/fixture/repo/.git\x00" };
    return { stdout: "" };
  };
  const h = loadPump(respond);
  const wc = h.addWindow();
  wc.gitPaths = ["/fixture/repo"];
  await h.api.gitTick(false); await flush();   // 解析在途（rev-parse 挂起）
  wc.gitPaths = [];
  await h.api.gitTick(false); await flush();   // 路径离开并集
  revRelease();
  await flush();
  assert.equal(h.watches.filter(w => w.dir === "/fixture/repo").length, 0, "离开并集后完成的在途解析不得建档");
  wc.gitPaths = ["/fixture/repo"];
  await h.api.gitTick(false); await flush();
  assert.ok(h.watches.some(w => w.dir === "/fixture/repo"), "路径回归后下轮 tick 重建");
});

test("fs.watch creation failure is non-fatal: query and push still work", async () => {
  const respond = args => args.includes("status") ? { stdout: "## main\x00" } : { stdout: "" };
  const h = loadPump(respond);
  const baseline = h.watches.length;   // 模块加载期其它链路（db 目录等）已有 watcher 记录
  h.watchCtl.fail = true;
  const wc = h.addWindow();
  wc.gitPaths = ["/fixture/repo"];
  await h.api.gitTick(false); await flush();
  assert.equal(h.watches.length, baseline, "git 路径未建任何 watcher");
  assert.ok(wc.pushes.some(js => js.includes("__zusageGitState") && js.includes('"ok":true')), "查询与推送不受影响（宿主同策略，不回退轮询）");
});

/* ---------- 2026-10-24 夜间扫描回归：IPC 门控与窗口表清理 ---------- */

/* 自含 harness：同 loadPump，但暴露 ipc 与窗口数组，直接驱动宿主同步通道处理器 */
function loadPumpIpc() {
  const intervals = [], timers = new Map(), windows = []; let id = 0;
  const mockFs = {
    readFileSync: file => String(file).endsWith("config.json") ? "{}" : "",
    statSync: () => ({ mtimeMs: 1, size: 1 }), existsSync: () => false,
    watch: () => ({ on() {} }), writeFileSync() {},
  };
  const ipc = new EventEmitter();
  const sandbox = {
    __dirname: path.join(FX, "runtime"), console: { error() {} },
    Buffer,
    process: { resourcesPath: path.join(FX, "resources"), execPath: process.execPath, uptime: () => 1, env: {} },
    module: { exports: {} },
    setTimeout: (fn, ms) => { timers.set(++id, fn); return id; },
    clearTimeout: n => timers.delete(n),
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    require(name) {
      if (name === "fs") return mockFs;
      if (["path", "url", "crypto"].includes(name)) return require(name);
      if (name === "electron") return { app: { getPath: () => path.join(FX, "home"), on() {} }, webContents: { getAllWebContents: () => windows }, ipcMain: ipc };
      if (name === "child_process") return {
        spawn() {
          const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
          p.stdin = new EventEmitter(); p.stdin.writable = true; p.kill = () => {}; return p;
        },
        execFile(cmd, args, opts, cb) { cb(null, "", ""); },
      };
      throw new Error(name);
    },
  };
  vm.runInNewContext(source, sandbox);
  return { api: sandbox.module.exports.__zusageTest, ipc, windows };
}

const trustedSenderFor = id => ({ id, getType: () => "window", isDestroyed: () => false,
  getURL: () => HOST_URL });

test("active-task-session IPC is gated by trustedSender like its sibling host channels", () => {
  const { api, ipc } = loadPumpIpc();
  ipc.emit("zcode:sync-active-task-session", { sender: trustedSenderFor(7) }, "sid_ok");
  assert.equal(api.ipcState().activeSid.get(7), "sid_ok", "trusted main-window file sender accepted");
  const external = { id: 8, getType: () => "window", isDestroyed: () => false,
    getURL: () => "https://evil.example/" };
  ipc.emit("zcode:sync-active-task-session", { sender: external }, "sid_evil");
  assert.equal(api.ipcState().activeSid.has(8), false, "external page cannot set the window session");
});

test("per-window maps are pruned when a window disappears", async () => {
  const { api, ipc, windows } = loadPumpIpc();
  const wc = trustedSenderFor(3);
  ipc.emit("zcode:sync-web-remote-control-workspaces", { sender: wc },
    [{ workspacePath: "/a", kind: "local", workspaceIdentity: "" }]);
  ipc.emit("zcode:sync-web-remote-control-tasks", { sender: wc },
    [{ taskId: "t1", workspaceKind: "local" }]);
  assert.equal(api.ipcState().windowWorkspaces.has(3), true);
  assert.equal(api.ipcState().windowTasks.has(3), true);
  // 至少一个存活窗口（id 99）：maybeSpawn 才会走到修剪段；id 3 从未注册进 getAllWebContents
  windows.push({ id: 99, getType: () => "window", isDestroyed: () => false,
    getURL: () => HOST_URL, executeJavaScript: async () => "null" });
  await api.maybeSpawn();
  assert.equal(api.ipcState().windowWorkspaces.has(3), false, "workspaces pruned");
  assert.equal(api.ipcState().windowTasks.has(3), false, "tasks pruned");
});

test("usage snapshots are never pushed into external pages (data-plane gate parity)", () => {
  const { api, ipc, windows } = loadPumpIpc();
  const local = { id: 21, getType: () => "window", isDestroyed: () => false,
    getURL: () => HOST_URL, pushes: [],
    executeJavaScript: async js => { if (js.startsWith("window.__zusageUpdate")) local.pushes.push(js); return "null"; } };
  const external = { id: 22, getType: () => "window", isDestroyed: () => false,
    getURL: () => "https://evil.example/", pushes: [],
    executeJavaScript: async js => { if (js.startsWith("window.__zusageUpdate")) external.pushes.push(js); return "null"; } };
  windows.push(local, external);
  api.handlePayload({ recent: [] });
  return new Promise(resolve => {
    setTimeout(() => {
      assert.ok(local.pushes.length >= 1, "local host page receives the snapshot");
      assert.equal(external.pushes.length, 0, "external page must not receive usage data");
      resolve();
    }, 20);
  });
});
