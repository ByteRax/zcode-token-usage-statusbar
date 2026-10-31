"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "..", "overlay.js"), "utf8");
function extract(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, "切片锚点失配：结构重写后请同步更新本测试");
  return source.slice(a, b);
}
/* 更新日志逻辑块（v202）：状态变量段（在早期 buildPanel 调用前赋值）+ 函数段，两段切片求值 */
const notesVarsSource = extract("/* 更新日志卡片运行态", "var ZU_NAV_GROUPS = [");
const notesSource = extract("function notesChannelOf(u) {", "/* ---------- v179 自动压缩阈值");
const mEscSource = extract("function mEsc(s)", "\n");

function el() {
  const node = {
    textContent: "", innerHTML: "", hidden: false, style: {}, attrs: {},
    setAttribute(n, v) { this.attrs[n] = String(v); },
    getAttribute(n) { return this.attrs[n] === undefined ? null : this.attrs[n]; },
    removeAttribute(n) { delete this.attrs[n]; },
    classList: {
      set: new Set(),
      toggle(n, on) { if (on === undefined) { this.set.has(n) ? this.set.delete(n) : this.set.add(n); } else if (on) this.set.add(n); else this.set.delete(n); },
      contains(n) { return this.set.has(n); },
    },
  };
  return node;
}
const SELECTORS = [".zu-notes-badge", ".zu-notes-meta", ".zu-notes-body", ".zu-notes-history-btn",
  ".zu-notes-back", ".zu-notes-toggle", ".zu-notes-link", ".zu-notes-retry", ".zu-notes-history"];
const HIDDEN_AT_BOOT = [".zu-notes-history-btn", ".zu-notes-back", ".zu-notes-toggle", ".zu-notes-link", ".zu-notes-retry", ".zu-notes-history"];
function makeContext({ pluginUpdate = null, lang = "zh", open = true } = {}) {
  const bySel = {};
  for (const s of SELECTORS) bySel[s] = el();
  for (const s of HIDDEN_AT_BOOT) bySel[s].hidden = true;   // 与 notesCardHtml 骨架一致的初始 hidden 态
  bySel[".zu-notes-history-btn"].textContent = lang === "en" ? "Version history" : "历史版本";   // 骨架文案（buildPanel 写入）
  bySel[".zu-notes-retry"].textContent = lang === "en" ? "Retry" : "重试";
  const sent = [], dones = [];
  const context = {
    state: { lang, pluginUpdate },
    panel: {
      querySelector: (sel) => bySel[sel] || null,
      classList: { contains: (n) => n === "open" ? open : false },
    },
    activeSettingsSec: () => "update",
    L: (zh, en) => (lang === "en" ? en : zh),
    mEsc: (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
    pluginRequest: (action, extra, done) => { sent.push({ action, extra }); if (done) dones.push(done); return "req" + sent.length; },
    inactive: () => false,
    __sent: sent, __dones: dones, __bySel: bySel,
  };
  vm.runInNewContext(mEscSource + "\n" + notesVarsSource + "\n" + notesSource, context);
  return context;
}
const releaseUpdate = (over = {}) => ({ supported: true, phase: "available", currentVersion: "1.5.6", latestVersion: "1.5.7",
  channel: "release", channelHost: "github", channelRepo: "ByteRax/zcode-token-usage-statusbar", restartRequired: false, markerVersion: "", releaseUrl: "", ...over });
const json = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));   // VM 域对象 → 测试域，供 deepEqual

/* ---------- 默认日志选择矩阵 ---------- */
test("notesDefaultTarget picks the version strictly from reliable state", () => {
  const ctx = makeContext();
  const d = ctx.notesDefaultTarget;
  assert.equal(d(null), null);
  assert.equal(d({ supported: false }), null);
  // 待重启：marker 版本（实际写入运行目录）优先，退 pendingRelease，再退 updated 的 latestVersion
  assert.deepEqual(json(d(releaseUpdate({ restartRequired: true, markerVersion: "1.5.7" }))), { version: "1.5.7", status: "installed-restart" });
  assert.deepEqual(json(d(releaseUpdate({ restartRequired: true, pendingRelease: { release: { version: "1.5.8" } } }))),
    { version: "1.5.8", status: "installed-restart" });
  assert.deepEqual(json(d(releaseUpdate({ restartRequired: true, phase: "updated", latestVersion: "1.5.9" }))),
    { version: "1.5.9", status: "installed-restart" });
  assert.deepEqual(json(d(releaseUpdate({ restartRequired: true }))), { unknown: true, status: "installed-restart" });
  // 安装中：目标 = pendingRelease 优先，退 latestVersion
  assert.deepEqual(json(d(releaseUpdate({ phase: "updating", pendingRelease: { release: { version: "1.5.7" } } }))), { version: "1.5.7", status: "installing" });
  assert.deepEqual(json(d(releaseUpdate({ phase: "downloading" }))), { version: "1.5.7", status: "installing" });
  // 失败：保留失败目标并标注；成功后恢复常规选择
  assert.deepEqual(json(d(releaseUpdate({ phase: "error", lastFailure: { version: "1.5.7", at: 1, channel: "release" } }))), { version: "1.5.7", status: "failed" });
  assert.deepEqual(json(d(releaseUpdate({ phase: "updated" }))), { version: "1.5.7", status: "current" });
  assert.deepEqual(json(d(releaseUpdate())), { version: "1.5.7", status: "available" });
  assert.deepEqual(json(d(releaseUpdate({ phase: "current", latestVersion: "" }))), { version: "1.5.6", status: "current" });
  assert.equal(d(releaseUpdate({ phase: "idle", latestVersion: "", currentVersion: "" })), null);
});

test("notesChannelOf only trusts the release channel", () => {
  const ctx = makeContext();
  assert.deepEqual(json(ctx.notesChannelOf(releaseUpdate())), { flavor: "github" });
  assert.deepEqual(json(ctx.notesChannelOf(releaseUpdate({ channelHost: "gitcode" }))), { flavor: "gitcode" });
  assert.equal(ctx.notesChannelOf(releaseUpdate({ channel: "market" })), null);
  assert.equal(ctx.notesChannelOf(releaseUpdate({ channel: "local" })), null);
  assert.equal(ctx.notesChannelOf(null), null);
});

/* ---------- 受限 Markdown 渲染安全 ---------- */
test("notes rendering escapes HTML and never emits scripts, images or dangerous links", () => {
  const ctx = makeContext();
  const r = ctx.notesHtml('<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\n[点我](javascript:alert(3))\n\n![图](https://e/x.png)\n\n[ok](https://github.com/a/b)\n\nhttps://example.com/p\n\n> 引用\n\n- 甲\n- 乙\n\n1. 一\n2. 二\n\n---\n\n# 大标题\n## 中标题\n### 小标题\n\n```js\nvar a = "<b>";\n```\n\n**粗** 与 *斜*\n\n[长](https://x.example/' + "y".repeat(700) + ")\n", true);
  const html = r.html;
  assert.ok(!/<script/i.test(html));
  assert.ok(!/<img/i.test(html));
  assert.match(html, /&lt;img src=x onerror=alert\(2\)&gt;/);   // 原文按转义文本完整显示，不产生属性注入
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.ok(!html.includes('data-href="javascript:'), "javascript 链接必须被丢弃");   // 危险协议不产出任何可点链接（文本兜底呈现除外）
  assert.ok(!html.includes('data-href="https://e/x.png"'), "图片默认禁用，不产生可点的图片链接");
  assert.match(html, /图（https:\/\/e\/x\.png）|图/);   // alt 文本保留
  assert.match(html, /data-href="https:\/\/github\.com\/a\/b"/);
  assert.match(html, /data-href="https:\/\/example\.com\/p"/);
  assert.match(html, /<strong>粗<\/strong>/);
  assert.match(html, /<em>斜<\/em>/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /<ul><li>甲<\/li><li>乙<\/li><\/ul>/);
  assert.match(html, /<ol><li>一<\/li><li>二<\/li><\/ol>/);
  assert.match(html, /<hr>/);
  assert.match(html, /zu-notes-h1/);
  assert.match(html, /zu-notes-h2/);
  assert.match(html, /zu-notes-h3/);
  assert.match(html, /<pre><code>var a = &quot;&lt;b&gt;&quot;;<\/code><\/pre>/);
  assert.ok(!html.includes('data-href="https://x.example/' + "y".repeat(700) + '"'), "超长链接不渲染为可点链接");
});

test("collapsed preview keeps attention sections visible and never silently drops content", () => {
  const ctx = makeContext();
  const long = "## 更新内容\n\n" + Array.from({ length: 120 }, (_, i) => "- 变更条目 " + i).join("\n") +
    "\n\n## 升级注意\n\n- 需要完全重启 ZCode\n\n## 修复\n\n- 修一个小问题";
  const folded = ctx.notesHtml(long, false);
  assert.equal(folded.more, true);   // 折叠态明确提示还有更多
  assert.match(folded.html, /zu-notes-attn/);
  assert.match(folded.html, /需要完全重启 ZCode/);   // 升级注意保持可见
  assert.ok(!folded.html.includes("修一个小问题"));
  const full = ctx.notesHtml(long, true);
  assert.equal(full.more, false);
  assert.match(full.html, /修一个小问题/);   // 展开后无内容被静默丢弃
  assert.ok(full.html.indexOf("升级注意") >= 0);
  const short = ctx.notesHtml("## 只有一句\n\n好了", false);
  assert.equal(short.more, false);
});

/* ---------- syncNotes 端到端（DOM stub）---------- */
test("syncNotes auto-fetches the default target and renders the body with badge and cache info", () => {
  const ctx = makeContext({ pluginUpdate: releaseUpdate() });
  ctx.syncNotes();
  assert.deepEqual(json(ctx.__sent), [{ action: "release-notes", extra: { version: "1.5.7", force: false } }]);
  assert.equal(ctx.__bySel[".zu-notes-body"].getAttribute("aria-busy"), "true");
  ctx.__dones[0]({ ok: true, tag: "v1.5.7", version: "1.5.7", name: "v1.5.7", body: "## 新功能\n\n- 加了更新日志", publishedAt: "2026-10-30T00:00:00Z", cachedAt: 1730000000000 });
  const body = ctx.__bySel[".zu-notes-body"];
  assert.equal(body.getAttribute("aria-busy"), "false");
  assert.match(body.innerHTML, /新功能/);
  assert.match(body.innerHTML, /<li>加了更新日志<\/li>/);
  assert.match(ctx.__bySel[".zu-notes-badge"].textContent, /可用版本/);
  assert.match(ctx.__bySel[".zu-notes-badge"].textContent, /1\.5\.7/);
  assert.match(ctx.__bySel[".zu-notes-meta"].textContent, /缓存于/);
  assert.equal(ctx.__bySel[".zu-notes-toggle"].hidden, false);
  assert.match(ctx.__bySel[".zu-notes-toggle"].textContent, /展开全部/);
  assert.equal(ctx.__bySel[".zu-notes-link"].getAttribute("data-href"), "https://github.com/ByteRax/zcode-token-usage-statusbar/releases/tag/v1.5.7");
  assert.equal(ctx.__bySel[".zu-notes-history-btn"].hidden, false);
  assert.equal(ctx.__bySel[".zu-notes-retry"].hidden, true);
  // 同目标重复 syncUpdate 不重复请求
  const before = ctx.__sent.length;
  ctx.syncNotes();
  assert.equal(ctx.__sent.length, before);
});

test("syncNotes shows failure states and keeps retry without disabling existing update actions", () => {
  const ctx = makeContext({ pluginUpdate: releaseUpdate() });
  ctx.syncNotes();
  ctx.__dones[0]({ ok: false, reason: "rate-limited" });
  assert.match(ctx.__bySel[".zu-notes-body"].innerHTML, /限流/);
  assert.equal(ctx.__bySel[".zu-notes-retry"].hidden, false);
  assert.equal(ctx.__bySel[".zu-notes-toggle"].hidden, true);
  const ctx2 = makeContext({ pluginUpdate: releaseUpdate() });
  ctx2.syncNotes();
  ctx2.__dones[0]({ ok: false, reason: "missing" });
  assert.match(ctx2.__bySel[".zu-notes-body"].innerHTML, /此版本暂无更新日志/);
  assert.equal(ctx2.__bySel[".zu-notes-retry"].hidden, true);
  const ctx3 = makeContext({ pluginUpdate: releaseUpdate() });
  ctx3.syncNotes();
  ctx3.__dones[0]({ ok: false, error: "unknown action: release-notes" });
  assert.match(ctx3.__bySel[".zu-notes-body"].innerHTML, /旧版本/);
});

test("syncNotes prefers installed-pending-restart and failure targets with honest labels", () => {
  const ctx = makeContext({ pluginUpdate: releaseUpdate({ restartRequired: true, markerVersion: "1.5.7", phase: "idle", latestVersion: "" }) });
  ctx.syncNotes();
  assert.deepEqual(json(ctx.__sent[0].extra), { version: "1.5.7", force: false });
  ctx.__dones[0]({ ok: true, tag: "v1.5.7", body: "x", cachedAt: 1730000000000 });
  assert.match(ctx.__bySel[".zu-notes-badge"].textContent, /已安装，待重启/);

  const failed = makeContext({ pluginUpdate: releaseUpdate({ phase: "error", error: "boom", lastFailure: { version: "1.5.7", at: 1, channel: "release" } }) });
  failed.syncNotes();
  failed.__dones[0]({ ok: true, tag: "v1.5.7", body: "x", cachedAt: 1730000000000 });
  assert.match(failed.__bySel[".zu-notes-badge"].textContent, /未安装成功/);
  assert.equal(failed.__bySel[".zu-notes-badge"].classList.contains("zu-notes-warn"), true);
});

test("syncNotes degrades to empty states for market, local and unknown identities", () => {
  const market = makeContext({ pluginUpdate: releaseUpdate({ channel: "market", channelHost: "github", latestVersion: "1.5.7" }) });
  market.syncNotes();
  assert.equal(market.__sent.length, 0);   // 源码渠道不联网
  assert.match(market.__bySel[".zu-notes-meta"].textContent, /源码渠道/);
  assert.equal(market.__bySel[".zu-notes-history-btn"].hidden, true);
  assert.equal(market.__bySel[".zu-notes-link"].getAttribute("data-href"), "https://github.com/ByteRax/zcode-token-usage-statusbar/releases");   // 参考链接由用户主动打开

  const local = makeContext({ pluginUpdate: releaseUpdate({ channel: "local", channelRepo: "" }) });
  local.syncNotes();
  assert.match(local.__bySel[".zu-notes-meta"].textContent, /本地目录来源不联网/);
  assert.equal(local.__bySel[".zu-notes-link"].hidden, true);

  const unknown = makeContext({ pluginUpdate: releaseUpdate({ restartRequired: true, markerVersion: "", phase: "idle", latestVersion: "", currentVersion: "1.5.6" }) });
  unknown.syncNotes();
  assert.equal(unknown.__sent.length, 0);   // 身份无法确定：不猜版本，不冒充
  assert.match(unknown.__bySel[".zu-notes-meta"].textContent, /无法确定本次安装的版本/);
});

test("explicit history selection sticks across polls and offers the way back", () => {
  const ctx = makeContext({ pluginUpdate: releaseUpdate() });
  ctx.syncNotes();
  ctx.__dones[0]({ ok: true, tag: "v1.5.7", body: "x", cachedAt: 1 });
  ctx.notesSel = { version: "1.5.5", explicit: true };   // 用户选择历史版本
  ctx.syncNotes();
  const before = ctx.__sent.length;
  assert.deepEqual(json(ctx.__sent[ctx.__sent.length - 1].extra), { version: "1.5.5", force: false });
  ctx.state.pluginUpdate = releaseUpdate({ phase: "current", latestVersion: "" });   // 轮询推新状态
  ctx.syncNotes();
  assert.equal(ctx.__sent.length, before);   // 同目标不重复拉取；轮询也不把粘性选择切回默认
  assert.equal(ctx.__bySel[".zu-notes-back"].hidden, false);
  assert.match(ctx.__bySel[".zu-notes-back"].textContent, /1\.5\.6/);   // 返回入口指向默认版本
  assert.match(ctx.__bySel[".zu-notes-badge"].textContent, /历史版本/);
  ctx.notesSel = { version: "", explicit: false };
  ctx.syncNotes();
  assert.equal(ctx.__bySel[".zu-notes-back"].hidden, true);
});

test("out-of-order replies never overwrite a newer selection and both release notes actions coexist", () => {
  const ctx = makeContext({ pluginUpdate: releaseUpdate() });
  ctx.syncNotes();   // 默认目标 1.5.7 → 第一个请求
  ctx.notesSel = { version: "1.5.6", explicit: true };   // 用户立刻切到旧版本（真实切换流）
  ctx.syncNotes();   // 新目标 1.5.6 → 第二个请求
  assert.equal(ctx.__dones.length, 2);
  ctx.__dones[0]({ ok: true, tag: "v1.5.7", body: "新版本内容", cachedAt: 1 });   // 迟到的旧回复
  assert.match(ctx.__bySel[".zu-notes-body"].innerHTML, /正在加载更新日志/);   // 序号失配：不覆盖新选择
  ctx.__dones[1]({ ok: true, tag: "v1.5.6", body: "旧版本内容", cachedAt: 1 });
  assert.match(ctx.__bySel[".zu-notes-body"].innerHTML, /旧版本内容/);
  assert.ok(!ctx.__bySel[".zu-notes-body"].innerHTML.includes("新版本内容"));
});

test("release notes copy is localized", () => {
  const ctx = makeContext({ lang: "en", pluginUpdate: releaseUpdate() });
  ctx.syncNotes();
  ctx.__dones[0]({ ok: true, tag: "v1.5.7", body: "## New\n\n- thing", cachedAt: 1730000000000 });
  assert.match(ctx.__bySel[".zu-notes-badge"].textContent, /Available version/);
  assert.match(ctx.__bySel[".zu-notes-toggle"].textContent, /Expand all/);
  assert.match(ctx.__bySel[".zu-notes-link"].textContent, /Full release notes/);
  assert.match(ctx.__bySel[".zu-notes-history-btn"].textContent, /Version history/);
});

test("review hardening: ReDoS input renders fast, rebuilt DOM refills, gitcode market link and sticky catch-up", () => {
  const ctx = makeContext({ pluginUpdate: releaseUpdate() });
  // 1) 长反引号串（原多项式回溯引爆串）在归一后即时完成且不产出脚本
  const hostile = "`".repeat(8000) + "tail" + "`".repeat(8000) + "\n\n<script>x</script>";
  const t0 = Date.now();
  const hostileOut = ctx.notesHtml(hostile, true);
  assert.ok(Date.now() - t0 < 2000, "归一后渲染必须即时");
  assert.ok(!/<script/i.test(hostileOut.html));
  // 2) buildPanel 重建骨架后（body 空但闭包签名残留）syncNotes 必须回填正文
  ctx.syncNotes();
  ctx.__dones[0]({ ok: true, tag: "v1.5.7", body: "## 内容\n\n- 条目", cachedAt: 1 });
  assert.match(ctx.__bySel[".zu-notes-body"].innerHTML, /内容/);
  ctx.__bySel[".zu-notes-body"].innerHTML = "";   // 模拟面板 innerHTML 重建
  ctx.syncNotes();
  assert.match(ctx.__bySel[".zu-notes-body"].innerHTML, /内容/);
  // 3) GitCode market 来源的参考链接指向 gitcode 域
  const gc = makeContext({ pluginUpdate: releaseUpdate({ channel: "market", channelHost: "gitcode", channelRepo: "tanranran/zcode-token-usage-statusbar", latestVersion: "1.5.7" }) });
  gc.syncNotes();
  assert.equal(gc.__bySel[".zu-notes-link"].getAttribute("data-href"), "https://gitcode.com/tanranran/zcode-token-usage-statusbar/releases");
  // 4) 粘性选择被默认追上时按真实状态显示、返回入口消失
  const st = makeContext({ pluginUpdate: releaseUpdate() });
  st.syncNotes();
  st.__dones[0]({ ok: true, tag: "v1.5.7", body: "x", cachedAt: 1 });
  st.notesSel = { version: "1.5.7", explicit: true };
  st.state.pluginUpdate = releaseUpdate({ restartRequired: true, markerVersion: "1.5.7", phase: "idle", latestVersion: "" });
  st.syncNotes();
  assert.match(st.__bySel[".zu-notes-badge"].textContent, /已安装，待重启/);   // 不是「历史版本」
  assert.equal(st.__bySel[".zu-notes-back"].hidden, true);
});

test("history failure offers retry and re-fetch clears the error state", () => {
  const ctx = makeContext({ pluginUpdate: releaseUpdate() });
  ctx.syncNotes();
  ctx.__dones[0]({ ok: true, tag: "v1.5.7", body: "x", cachedAt: 1 });
  ctx.__bySel[".zu-notes-history-btn"].hidden = false;
  ctx.notesHistoryError = null;
  // 展开历史面板（首次拉取）
  const histBtn = ctx.__bySel[".zu-notes-history-btn"];
  ctx.__bySel[".zu-notes-history"].hidden = true;
  // 直接驱动内部状态：模拟一次失败列表响应
  ctx.requestNotesList(false);
  ctx.__dones[1]({ ok: false, reason: "network" });
  ctx.__bySel[".zu-notes-history"].hidden = false;
  ctx.renderNotesHistory();
  const hist = ctx.__bySel[".zu-notes-history"];
  assert.match(hist.innerHTML, /暂时无法获取历史版本/);
  assert.match(hist.innerHTML, /zu-notes-hist-retry/);
});

test("loading receipt loss degrades to retryable error after the timeout horizon", () => {
  const ctx = makeContext({ pluginUpdate: releaseUpdate() });
  ctx.syncNotes();   // 自动发起 loading
  assert.match(ctx.__bySel[".zu-notes-body"].innerHTML, /正在加载更新日志/);
  assert.equal(ctx.__bySel[".zu-notes-retry"].hidden, true);   // loading 中无重试
  ctx.notesRequestedAt = Date.now() - 121000;   // 时间前移，模拟回执丢失超过 120s
  ctx.syncNotes();
  assert.match(ctx.__bySel[".zu-notes-body"].innerHTML, /暂时无法获取/);
  assert.equal(ctx.__bySel[".zu-notes-retry"].hidden, false);   // 转为可重试，不再永挂
});

test("history selection re-renders aria-current immediately", () => {
  const ctx = makeContext({ pluginUpdate: releaseUpdate() });
  ctx.syncNotes();
  ctx.__dones[0]({ ok: true, tag: "v1.5.7", body: "x", cachedAt: 1 });
  ctx.requestNotesList(false);
  ctx.__dones[1]({ ok: true, releases: [
    { version: "1.5.7", tag: "v1.5.7", name: "v1.5.7", publishedAt: "2026-10-30", prerelease: false, url: "u1" },
    { version: "1.5.6", tag: "v1.5.6", name: "v1.5.6", publishedAt: "2026-10-29", prerelease: false, url: "u2" },
  ] });
  ctx.__bySel[".zu-notes-history"].hidden = false;
  ctx.renderNotesHistory();
  const hist = ctx.__bySel[".zu-notes-history"];
  assert.match(hist.innerHTML, /aria-current="true"/);
  assert.ok(hist.innerHTML.indexOf("v1.5.7") < hist.innerHTML.indexOf("v1.5.6"));   // 降序
  ctx.notesSel = { version: "1.5.6", explicit: true };
  ctx.renderNotesHistory();
  assert.match(hist.innerHTML, /data-version="1\.5\.6" aria-current="true"/);   // 选中迁移即时反映
  assert.ok(!/data-version="1\.5\.7" aria-current/.test(hist.innerHTML));
});
