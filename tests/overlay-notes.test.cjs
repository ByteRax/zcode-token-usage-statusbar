"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("vm");
const { sliceOverlay } = require("./helpers/overlay-extract.cjs");

function extract(start, end) {
  return sliceOverlay(start, end);
}
/* 更新日志逻辑块（v202）：状态变量段（在早期 buildPanel 调用前赋值）+ 函数段，两段切片求值 */
const notesVarsSource = extract("/* 更新日志卡片运行态", "var ZU_NAV_GROUPS = [");
const notesSource = extract("function notesChannelOf(u) {", "/* ---------- v179 自动压缩阈值");
const mEscSource = extract("function mEsc(s)", "\n");
/* v413 齿轮悬停更新日志卡：独立段落切片（位于 notesDefaultTarget 与 notesPickTarget 之间）。
 * 起始锚点取段内首条 var（段首注释在 01 分片壳层有相似文字，且注释中部起切会丢 /* 开符） */
const updNoteSource = extract("var updNoteState = ", "function notesPickTarget(u) {");

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
    /* v413 齿轮悬停卡桩：updDotOn 在 09 分片更早段落（本切片外），01 分片壳函数以桩捕获调用 */
    gear: null,
    __dotOn: false,
    updDotOn: function () { return context.__dotOn; },
    updNoteTipFor: null,
    __shown: [], __renders: [], __hides: [],
    showUpdNoteTip: function (el2) { context.__shown.push(el2); },
    scheduleUpdNoteHide: function () { context.__hides.push(1); },
    renderUpdNoteTip: function () { context.__renders.push(context.gear ? context.gear.__zuUpdHtml : null); },
    __sent: sent, __dones: dones, __bySel: bySel,
  };
  context.gear = {};
  vm.runInNewContext(mEscSource + "\n" + notesVarsSource + "\n" + notesSource, context);
  return context;
}
function makeUpdContext({ dotOn = true, pluginUpdate, open = false } = {}) {
  const ctx = makeContext({ pluginUpdate, open });
  ctx.__dotOn = dotOn;
  vm.runInContext(updNoteSource, ctx);
  return ctx;
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

test("notesChannelOf flags verified release channels, passes market as reference", () => {
  const ctx = makeContext();
  assert.deepEqual(json(ctx.notesChannelOf(releaseUpdate())), { flavor: "github", verified: true });
  assert.deepEqual(json(ctx.notesChannelOf(releaseUpdate({ channelHost: "gitcode" }))), { flavor: "gitcode", verified: true });
  assert.deepEqual(json(ctx.notesChannelOf(releaseUpdate({ channel: "market" }))), { flavor: "github", verified: false });   // 源码渠道：同号 Release 参考正文
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

/* ---------- v419 Markdown 升级：嵌套列表/任务清单/表格/删除线 ---------- */
test("nested lists, task lists, tables and strikethrough render per the GFM subset", () => {
  const ctx = makeContext();
  const md = [
    "- 顶层",
    "  - 二级",
    "    - 三级",
    "- 顶层乙",
    "",
    "1. 步骤一",
    "2. 步骤二",
    "",
    "- [x] 已完成",
    "- [ ] 未完成",
    "- [x]无空格不算任务",
    "",
    "| 功能 | 状态 | 说明 |",
    "| :--- | ---: | :---: |",
    "| 表格 | 完成 | 支持 \\| 转义 |",
    "| <script>x</script> | [b](javascript:alert(1)) | [ok](https://x.y/z) |",
    "",
    "~~删除线~~ 与 单~波~ 不变",
    "",
    "**粗 *斜* 粗**",
    "",
    "| 只有表头行没有分隔行 | 不是表格 |",
  ].join("\n");
  const html = ctx.notesHtml(md, true).html;
  // 嵌套列表：li 内嵌 ul，三级成树；回落后的顶层乙仍是根级兄弟
  assert.match(html, /<ul><li>顶层<ul><li>二级<ul><li>三级<\/li><\/ul><\/li><\/ul><\/li><li>顶层乙<\/li><\/ul>/);
  assert.match(html, /<ol><li>步骤一<\/li><li>步骤二<\/li><\/ol>/);
  // 任务清单：checkbox 取代字面 [x]/[ ]；无空格的 [x]前缀仍按普通文本
  assert.match(html, /<input type="checkbox" disabled checked>已完成<\/li>/);
  assert.match(html, /<input type="checkbox" disabled>未完成<\/li>/);
  assert.ok(!html.includes("[x] 已完成") && !html.includes("[ ] 未完成"), "任务标记不得按字面残留");
  assert.match(html, /<li>\[x\]无空格不算任务<\/li>/);
  // 表格：thead/tbody、对齐样式贯穿整列、\| 转义
  assert.match(html, /<table><thead><tr><th style="text-align:left">功能<\/th><th style="text-align:right">状态<\/th><th style="text-align:center">说明<\/th><\/tr><\/thead><tbody><tr><td style="text-align:left">表格<\/td><td style="text-align:right">完成<\/td><td style="text-align:center">支持 \| 转义<\/td><\/tr>/);
  // 表格单元格走同一转义/链接白名单
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.ok(!html.includes('data-href="javascript:'), "单元格内 javascript 链接必须被丢弃");
  assert.match(html, /<td style="text-align:center"><button type="button" class="zu-notes-lnk" data-href="https:\/\/x\.y\/z">ok<\/button><\/td>/);
  // 删除线只认双波浪
  assert.match(html, /<del>删除线<\/del>/);
  assert.match(html, /单~波~/);
  // 加粗内嵌斜体
  assert.match(html, /<strong>粗 <em>斜<\/em> 粗<\/strong>/);
  // 无分隔行不成表
  assert.ok(!html.includes("<th>只有表头行"), "缺分隔行的管道行不得成表");
});

test("markdown upgrade keeps hostile inputs bounded (bold/strike/pipe floods)", () => {
  const ctx = makeContext();
  /* 管道表在前（~~ 洪流以 ~~~ 起头会成围栏吞掉后续行，故置尾；全部仍须即时完成且无脚本） */
  const floods = "| a | a |\n| - | - |\n| " + "x|".repeat(4000) + "\n" + "[x]".repeat(4000) + "\n" +
    "**" + "*".repeat(4000) + "\n" + "~~" + "~".repeat(4000) + "\n";
  const t0 = Date.now();
  const out = ctx.notesHtml(floods, true);
  assert.ok(Date.now() - t0 < 2000, "洪水输入必须即时完成");
  assert.ok(!/<script/i.test(out.html));
  assert.match(out.html, /<th>a<\/th>/);   // 无对齐冒号的朴素分隔行也成表（结构存在）
});

test("v445: heading line with a long space run renders in linear time (the old lazy heading regex was cubic)", () => {
  const ctx = makeContext();
  const t0 = Date.now();
  const out = ctx.notesHtml("# a" + " ".repeat(4000) + "x", true);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 1000, "标题行空格串必须即时完成（实测 " + elapsed + "ms）");
  assert.match(out.html, /zu-notes-h1">a {4000}x</, "仍是标题，正文原样");
  // 关闭 # 串与尾部空白照常收掉；只有 # 与空格的行不是标题
  assert.match(ctx.notesHtml("## 标题  ###   \n", true).html, /zu-notes-h2">标题</);
  assert.doesNotMatch(ctx.notesHtml("# \n#\n", true).html, /zu-notes-h/);
});

test("v445: a heading that contains U+2028/U+2029 is still a heading (capture class is [\\s\\S]; `.` cannot cross line separators)", () => {
  const ctx = makeContext();
  for (const sep of ["\u2028", "\u2029"]) {
    const html = ctx.notesHtml("# a" + sep + "b\n\n正文", true).html;
    const expect = new RegExp('zu-notes-h1">a' + (sep === "\u2028" ? "\\u2028" : "\\u2029") + 'b<');
    assert.match(html, expect, "U+" + sep.charCodeAt(0).toString(16) + " 不得让标题行降级成正文");
    assert.doesNotMatch(html, /<p>[^<]*#\s*a/, "没有被当成普通段落");
  }
  // 正文只有 # 的标题（旧正则的惰性捕获至少留一个字符）：保留原样，不渲染成空标题
  assert.match(ctx.notesHtml("# #\n", true).html, /zu-notes-h1">#</, "「# #」保留一个 #");
  assert.match(ctx.notesHtml("## a ###", true).html, /zu-notes-h2">a</, "普通闭合串照常剥掉");
});

test("v445: every remaining text exit of the restricted markdown escapes HTML (review mutation gaps)", () => {
  const ctx = makeContext();
  const payload = '<img src=x onerror=alert(1)>';
  const cases = {
    "text between inline marks": "a **b** " + payload + " `c`",
    "inline code": "`" + payload + "`",
    "image alt": "![" + payload + "](https://e/x.png)",
    "rejected link text": "[" + payload + "](javascript:alert(3))",
    "list item": "- " + payload + "\n  - [ ] " + payload,
    "heading": "## " + payload,
  };
  for (const [where, md] of Object.entries(cases)) {
    const html = ctx.notesHtml(md, true).html;
    assert.ok(!html.includes("<img"), where + "：不得产出原始 <img");
    assert.match(html, /&lt;img/, where + "：载荷以转义文本出现");
  }
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

test("market channel shows the same-version release as labeled reference content", () => {
  const market = makeContext({ pluginUpdate: releaseUpdate({ channel: "market", channelHost: "github", latestVersion: "1.5.7" }) });
  market.syncNotes();
  assert.deepEqual(json(market.__sent), [{ action: "release-notes", extra: { version: "1.5.7", force: false } }]);   // 源码渠道拉同号 Release
  market.__dones[0]({ ok: true, tag: "v1.5.7", version: "1.5.7", body: "## 内容\n\n- 条目", cachedAt: 1730000000000,
    url: "https://github.com/ByteRax/zcode-token-usage-statusbar/releases/tag/v1.5.7", verified: false });
  assert.match(market.__bySel[".zu-notes-meta"].textContent, /参考：同号 Release/);   // 不冒充本渠道已核实内容
  assert.match(market.__bySel[".zu-notes-meta"].textContent, /GitHub/);
  assert.equal(market.__bySel[".zu-notes-link"].getAttribute("data-href"), "https://github.com/ByteRax/zcode-token-usage-statusbar/releases/tag/v1.5.7");
  assert.match(market.__bySel[".zu-notes-link"].textContent, /未核实/);
  assert.equal(market.__bySel[".zu-notes-history-btn"].hidden, false);

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
  // 3) GitCode market 来源：拉取流 + 参考标注，链接落到 gitcode 列表页（tag 深链页是平台 bug 页不可达）
  const gc = makeContext({ pluginUpdate: releaseUpdate({ channel: "market", channelHost: "gitcode", channelRepo: "tanranran/zcode-token-usage-statusbar", latestVersion: "1.5.7" }) });
  gc.syncNotes();
  gc.__dones[0]({ ok: true, tag: "v1.5.7", version: "1.5.7", body: "x", cachedAt: 1,
    url: "https://gitcode.com/tanranran/zcode-token-usage-statusbar/releases/tag/v1.5.7", verified: false });
  assert.equal(gc.__bySel[".zu-notes-link"].getAttribute("data-href"), "https://gitcode.com/tanranran/zcode-token-usage-statusbar/releases");
  assert.match(gc.__bySel[".zu-notes-meta"].textContent, /参考/);
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

test("idle without a check shows the current installed version's notes (user rule)", () => {
  const d = makeContext().notesDefaultTarget;
  assert.deepEqual(json(d({ supported: true, phase: "idle", currentVersion: "1.5.9", channel: "", latestVersion: "" })),
    { version: "1.5.9", status: "current" });   // 未触发检查更新：当前已装版本即目标
  assert.equal(d({ supported: true, phase: "idle", currentVersion: "", channel: "" }), null);
});

test("syncNotes fetches current-version notes before any check and derives source from the verified reply", () => {
  const ctx = makeContext({ pluginUpdate: { supported: true, phase: "idle", currentVersion: "1.5.9", latestVersion: "",
    channel: "", channelHost: "", channelRepo: "", restartRequired: false, markerVersion: "" } });
  ctx.syncNotes();
  assert.deepEqual(json(ctx.__sent), [{ action: "release-notes", extra: { version: "1.5.9", force: false } }]);   // 渠道未知也发起，由主进程门控
  ctx.__dones[0]({ ok: true, tag: "v1.5.9", version: "1.5.9", name: "v1.5.9", body: "## 内容\n\n- 条目",
    url: "https://github.com/ByteRax/zcode-token-usage-statusbar/releases/tag/v1.5.9", cachedAt: 1730000000000 });
  assert.match(ctx.__bySel[".zu-notes-badge"].textContent, /当前版本/);
  assert.match(ctx.__bySel[".zu-notes-badge"].textContent, /1\.5\.9/);
  assert.match(ctx.__bySel[".zu-notes-meta"].textContent, /GitHub/);   // 来源从已验证回复 URL 推导
  assert.equal(ctx.__bySel[".zu-notes-link"].getAttribute("data-href"), "https://github.com/ByteRax/zcode-token-usage-statusbar/releases/tag/v1.5.9");
  assert.equal(ctx.__bySel[".zu-notes-history-btn"].hidden, false);   // 回复证实为 Release 渠道
});

test("unsupported-channel and missing replies keep honest states at idle", () => {
  const ctx = makeContext({ pluginUpdate: { supported: true, phase: "idle", currentVersion: "1.5.9", latestVersion: "",
    channel: "", channelHost: "", channelRepo: "", restartRequired: false, markerVersion: "" } });
  ctx.syncNotes();
  ctx.__dones[0]({ ok: false, reason: "unsupported-channel" });
  assert.match(ctx.__bySel[".zu-notes-body"].innerHTML, /当前来源暂不支持在线日志/);
  assert.equal(ctx.__bySel[".zu-notes-history-btn"].hidden, true);   // 未证实是 Release 渠道，不提供历史
  assert.equal(ctx.__bySel[".zu-notes-link"].hidden, true);

  const ctx2 = makeContext({ pluginUpdate: { supported: true, phase: "idle", currentVersion: "1.5.9", latestVersion: "",
    channel: "", channelHost: "", channelRepo: "", restartRequired: false, markerVersion: "" } });
  ctx2.syncNotes();
  ctx2.__dones[0]({ ok: false, reason: "missing" });
  assert.match(ctx2.__bySel[".zu-notes-body"].innerHTML, /此版本暂无更新日志/);
  assert.equal(ctx2.__bySel[".zu-notes-history-btn"].hidden, false);   // missing 恰好证实是 Release 渠道：可转历史版本
});

test("mirror fallback replies label the actual source and point the link at the reachable mirror releases page", () => {
  const ctx = makeContext({ pluginUpdate: releaseUpdate() });   // verified github 渠道
  ctx.syncNotes();
  ctx.__dones[0]({ ok: true, tag: "v1.5.7", version: "1.5.7", body: "## x\n\n- a", cachedAt: 1730000000000, mirror: true,
    url: "https://gitcode.com/tanranran/zcode-token-usage-statusbar/releases/tag/v1.5.7" });
  assert.match(ctx.__bySel[".zu-notes-meta"].textContent, /GitCode 镜像/);
  assert.match(ctx.__bySel[".zu-notes-meta"].textContent, /限流回退/);
  assert.equal(ctx.__bySel[".zu-notes-link"].getAttribute("data-href"),
    "https://gitcode.com/tanranran/zcode-token-usage-statusbar/releases");   // 来源域的 tag 深链页不可达，落到列表页
  assert.equal(ctx.__bySel[".zu-notes-badge"].classList.contains("zu-notes-warn"), false);   // verified 渠道不因镜像回退变成参考态
});

/* ---------- v413 齿轮悬停更新日志卡 ---------- */
const restartUpdate = (over = {}) => ({ supported: true, phase: "updated", currentVersion: "1.5.7", latestVersion: "1.5.8",
  channel: "release", channelHost: "github", channelRepo: "ByteRax/zcode-token-usage-statusbar",
  restartRequired: true, markerVersion: "1.5.8", ...over });

test("gear hover card gates strictly on the restart dot and closed panel", () => {
  const u = restartUpdate();
  const ctx1 = makeUpdContext({ dotOn: false, pluginUpdate: u });
  ctx1.onGearUpdEnter();
  assert.equal(ctx1.__sent.length, 0);
  assert.equal(ctx1.__shown.length, 0);
  const ctx2 = makeUpdContext({ dotOn: true, pluginUpdate: u, open: true });
  ctx2.onGearUpdEnter();
  assert.equal(ctx2.__sent.length, 0);
  assert.equal(ctx2.__shown.length, 0);
  const ctx3 = makeUpdContext({ dotOn: true, pluginUpdate: u });
  ctx3.onGearUpdEnter();
  assert.equal(ctx3.__sent.length, 1);
  assert.equal(ctx3.__sent[0].action, "release-notes");
  assert.equal(ctx3.__sent[0].extra.version, "1.5.8");   // 待重启 = marker 版本（VM realm 对象勿用 deepEqual）
  assert.equal(ctx3.__sent[0].extra.force, false);
  assert.equal(ctx3.__shown.length, 1);
  assert.match(ctx3.gear.__zuUpdHtml, /v1\.5\.8 更新日志/);
  assert.match(ctx3.gear.__zuUpdHtml, /正在加载更新日志/);
  assert.equal(ctx3.updNoteTipFor, null);   // 实例侧不碰 01 分片的 tip 目标（由 show 桩接管）
});

test("gear hover card renders version date body once notes arrive; duplicate ensures dedupe", () => {
  const ctx = makeUpdContext({ dotOn: true, pluginUpdate: restartUpdate() });
  ctx.onGearUpdEnter();
  assert.equal(ctx.__sent.length, 1);
  assert.equal(ctx.updNoteEnsure(), false);   // 同版本加载中不再发
  ctx.__dones[0]({ ok: true, version: "1.5.8", tag: "v1.5.8", name: "v1.5.8", publishedAt: "2026-11-19T00:00:00.000Z",
    body: "# 新功能\n\n- 工具升级期间旧版本继续可用\n\n## 问题修复\n\n- 修复登录失败", url: "https://github.com/x/releases/tag/v1.5.8" });
  const html = ctx.gear.__zuUpdHtml;
  assert.match(html, /v1\.5\.8 更新日志/);
  assert.match(html, /已安装待重启/);
  assert.match(html, /2026/);   // 日期行（具体本地化格式不锁）
  assert.match(html, /zu-notes-h1/);
  assert.match(html, /修复登录失败/);
  assert.doesNotMatch(html, /正在加载更新日志/);
  ctx.updNotePrefetch();   // 红点仍在：重复预取不再发请求
  assert.equal(ctx.__sent.length, 1);
});

test("stale reply for an old target is dropped by the seq guard", () => {
  const ctx = makeUpdContext({ dotOn: true, pluginUpdate: restartUpdate() });
  ctx.onGearUpdEnter();   // v1.5.8, seq=1
  const oldDone = ctx.__dones[0];
  ctx.state.pluginUpdate = restartUpdate({ markerVersion: "1.5.9", latestVersion: "1.5.9" });
  ctx.updNotePrefetch();   // v1.5.9, seq=2
  assert.equal(ctx.__sent.length, 2);
  oldDone({ ok: true, version: "1.5.8", tag: "v1.5.8", body: "old" });
  assert.equal(ctx.updNoteState.version, "1.5.9");
  assert.equal(ctx.updNoteState.loading, true);   // 旧回包不覆盖新目标
});

test("failure states render reason plus settings pointer; mirror and unverified get honest labels", () => {
  const ctx = makeUpdContext({ dotOn: true, pluginUpdate: restartUpdate() });
  ctx.onGearUpdEnter();
  ctx.__dones[0]({ ok: false, reason: "rate-limited" });
  assert.match(ctx.gear.__zuUpdHtml, /暂时无法获取（API 限流）/);
  assert.match(ctx.gear.__zuUpdHtml, /插件更新/);
  assert.equal(ctx.updNoteEnsure(), false);   // 失败同版本不重发（重试入口在设置页）
  const ctx2 = makeUpdContext({ dotOn: true, pluginUpdate: restartUpdate() });
  ctx2.onGearUpdEnter();
  ctx2.__dones[0]({ ok: true, version: "1.5.8", tag: "v1.5.8", body: "hello", mirror: true });
  assert.match(ctx2.gear.__zuUpdHtml, /GitCode 镜像/);
  const ctx3 = makeUpdContext({ dotOn: true, pluginUpdate: restartUpdate({ channel: "market" }) });
  ctx3.onGearUpdEnter();
  ctx3.__dones[0]({ ok: true, version: "1.5.8", tag: "v1.5.8", body: "hello", verified: false });
  assert.match(ctx3.gear.__zuUpdHtml, /参考：同号 Release/);
});

test("unknown pending version identity keeps the card silent", () => {
  const ctx = makeUpdContext({ dotOn: true, pluginUpdate: restartUpdate({ markerVersion: "", latestVersion: "" }) });
  ctx.onGearUpdEnter();
  assert.equal(ctx.__sent.length, 0);
  assert.equal(ctx.__shown.length, 0);
});

test("v413 wiring: boot sweep, cleanup chain, tip shell, prefetch hook and gear bindings", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const read = (f) => fs.readFileSync(path.join(__dirname, "..", "src", "overlay", f), "utf8");
  assert.ok(read("00-boot-state-i18n.js").includes(".zusage-upd-note-tip"), "热更清扫选择器缺 v413 卡宿主类");
  const tips = read("01-git-and-doc-tooltips.js");
  assert.ok(tips.includes('className = "tip zusage-quota-tip zusage-upd-note-tip"'), "tip 壳未挂清理宿主类");
  assert.ok(tips.includes("hideUpdNoteTip();\n    updNoteTip.remove();"), "cleanupRateTip 清理链缺 v413 卡");
  assert.ok(tips.includes('e.target.closest(".zu-notes-lnk")'), "tip 链接点击委托缺失");
  assert.ok(/function showUpdNoteTip[\s\S]{0,300}cancelUpdNoteHide\(\)/.test(tips), "show 路径未取消在途收起（重入闪烁）");
  assert.ok(tips.includes("Math.max(8, Math.min(Math.round(r.right - tw)"), "tip 左缘 8px 视口钳边缺失");
  const dom = read("06-instance-dom-and-styles.js");
  assert.ok(dom.includes('var VERSION = "v474"'), "VERSION 未升 v474");
  assert.ok(dom.includes(".zusage-upd-note-tip .zu-un-body"), "tip 作用域样式缺失");
  const notes = read("09-instance-settings-and-notes.js");
  assert.ok(notes.includes('typeof pluginRequest === "function") updNotePrefetch()'), "syncUpdate 预取钩子缺失");
  assert.ok(notes.includes('gear.addEventListener("mouseenter", onGearUpdEnter)'), "齿轮悬停绑定缺失");
  assert.ok(notes.includes('typeof hideUpdNoteTip === "function") hideUpdNoteTip()'), "开面板收卡缺失");
});

test("first-tick spawn before module assignment: ensure lazy-inits instead of crashing spawn (3.19.1 coordErr)", () => {
  const ctx = makeUpdContext({ dotOn: true, pluginUpdate: restartUpdate() });
  ctx.updNoteState = undefined;   // 模拟 IIFE 同步首拍：tick→spawnInstance→buildPanel→syncUpdate 早于模块级赋值（var 只提升声明）
  assert.doesNotThrow(() => ctx.updNoteEnsure());   // 懒初始化兜底，不拖垮实例创建
  assert.equal(ctx.__sent.length, 1);
  assert.equal(ctx.__sent[0].action, "release-notes");
  assert.equal(ctx.__sent[0].extra.version, "1.5.8");
  assert.equal(ctx.updNoteState.version, "1.5.8");   // 状态重建
  assert.equal(ctx.updNoteState.loading, true);
});

test("prefetch hook failure is isolated from syncUpdate and recorded in diag", () => {
  const syncSource = extract("    function updFingerprint(u) {", "    function syncPanel() {");
  const status = {};
  const relaunch = { disabled: false, classList: { toggle: () => {} } };
  const context = {
    state: { pluginUpdate: restartUpdate(), rateLine: true, restartNotice: true },
    panel: { querySelector: (sel) => sel === ".zu-update-status" ? status : sel === "[data-update=relaunch]" ? relaunch : { textContent: "", hidden: false, checked: false, disabled: false, style: {}, dataset: {}, classList: { toggle: () => {}, contains: () => false } } },
    gear: { querySelector: () => null },
    LS: { updSeen: "zusage3.updSeen" },
    localStorage: { getItem: () => null, setItem: () => {} },
    L: (zh, en) => zh,
    /* 预取链异常源：pluginRequest 在 updNoteEnsure 内同步抛（切片自带的 updNotePrefetch 声明提升会
     * 遮蔽沙箱同名桩，不能用作注入点；原崩形态 updNoteState 未赋值已被 v414 懒初始化堵死） */
    pluginRequest: function () { throw new TypeError("Cannot read properties of undefined (reading 'version')"); },
    __zusageDiag: {},
  };
  context.window = context;   // catch 内层经 window.__zusageDiag 落诊断（生产 window 恒在）
  vm.runInNewContext(syncSource + "\nsyncUpdate();", context);   // 无 try 包裹时此处会向外抛
  assert.match(String(context.__zusageDiag.updNoteErr), /reading 'version'/);
});

test("gear hover card title escapes the pending version (feed-sourced markerVersion)", () => {
  const ctx = makeUpdContext({ dotOn: true, pluginUpdate: restartUpdate({ markerVersion: '1.5.<b onerror="x()">' }) });
  ctx.onGearUpdEnter();
  ctx.__dones[0]({ ok: true, version: ctx.updNoteState.version, tag: "vx", body: "hello" });
  const html = ctx.gear.__zuUpdHtml;
  assert.ok(html.includes("&lt;b onerror=&quot;x()&quot;&gt;"), "版本号未经转义直进 innerHTML");
  assert.doesNotMatch(html, /<b onerror=/);
});

test("gear hover card converts a lost reply into a readable timeout error", () => {
  const ctx = makeUpdContext({ dotOn: true, pluginUpdate: restartUpdate() });
  ctx.onGearUpdEnter();   // loading 中
  ctx.updNoteState.at = Date.now() - 121000;   // 越过 NOTES_LOADING_TIMEOUT_MS(120s)
  const html = ctx.updNoteHtml();
  assert.doesNotMatch(html, /正在加载更新日志/);
  assert.match(html, /暂时无法获取更新日志/);
  assert.match(html, /详情见 ⚙ → 插件更新/);
});

test("gear hover card surfaces the legacy main-process note for unknown actions", () => {
  const ctx = makeUpdContext({ dotOn: true, pluginUpdate: restartUpdate() });
  ctx.onGearUpdEnter();
  ctx.__dones[0]({ ok: false, reason: "error", error: "unknown action: release-notes" });
  assert.match(ctx.gear.__zuUpdHtml, /当前主进程为旧版本/);
});
