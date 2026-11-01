"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { fetchBytes, fetchReleaseNotes, fetchReleaseNotesList, createNotesCache, createNotesService, notesTag } = require("../plugin-release.cjs");

const GITHUB_ROW = {
  tag_name: "v1.5.7", name: "v1.5.7", prerelease: false, draft: false,
  published_at: "2026-10-30T12:00:00Z", created_at: "2026-10-30T11:00:00Z",
  body: "## 本次发布\n\n- 修复安装问题\n- **注意**：需重启",
};
function notesFetchOk(row, capture) {
  return async (url, limit) => { if (capture) capture.push({ url, limit }); return Buffer.from(JSON.stringify(row)); };
}

test("notesTag only accepts stable semantic versions", () => {
  assert.equal(notesTag("1.5.7"), "v1.5.7");
  assert.equal(notesTag("v1.5.7"), null);
  assert.equal(notesTag("1.5"), null);
  assert.equal(notesTag(""), null);
  assert.equal(notesTag(null), null);
});

test("fetchReleaseNotes builds the tag URL from verified inputs and normalizes the row", async () => {
  const capture = [];
  const result = await fetchReleaseNotes({ flavor: "github", repository: "ByteRax/zcode-token-usage-statusbar", version: "1.5.7", fetch: notesFetchOk(GITHUB_ROW, capture) });
  assert.equal(result.ok, true);
  assert.deepEqual(capture, [{ url: "https://api.github.com/repos/ByteRax/zcode-token-usage-statusbar/releases/tags/v1.5.7", limit: 256 * 1024 }]);
  assert.equal(result.notes.version, "1.5.7");
  assert.equal(result.notes.tag, "v1.5.7");
  assert.equal(result.notes.repository, "ByteRax/zcode-token-usage-statusbar");
  assert.equal(result.notes.publishedAt, "2026-10-30T12:00:00Z");
  assert.equal(result.notes.url, "https://github.com/ByteRax/zcode-token-usage-statusbar/releases/tag/v1.5.7");
  assert.match(result.notes.body, /修复安装问题/);
});

test("fetchReleaseNotes uses the GitCode API host and falls back to created_at", async () => {
  const capture = [];
  const row = { ...GITHUB_ROW, published_at: null };
  const result = await fetchReleaseNotes({ flavor: "gitcode", repository: "tanranran/zcode-token-usage-statusbar", version: "1.5.7", fetch: notesFetchOk(row, capture) });
  assert.equal(result.ok, true);
  assert.equal(capture[0].url, "https://api.gitcode.com/repos/tanranran/zcode-token-usage-statusbar/releases/tags/v1.5.7");
  assert.equal(result.notes.publishedAt, "2026-10-30T11:00:00Z");
  assert.equal(result.notes.url, "https://gitcode.com/tanranran/zcode-token-usage-statusbar/releases/tag/v1.5.7");
});

test("fetchReleaseNotes rejects unverified flavors, repositories and versions before any request", async () => {
  const refused = async () => { throw new Error("must not request"); };
  for (const options of [
    { flavor: "gitee", repository: "a/b", version: "1.0.0" },
    { flavor: "github", repository: "not-a-repo", version: "1.0.0" },
    { flavor: "github", repository: "a/b", version: "1.0" },
    { flavor: "github", repository: "a/b", version: "" },
    { flavor: "github", repository: "a/b" },
  ]) {
    const result = await fetchReleaseNotes({ ...options, fetch: refused });
    assert.equal(result.ok, false, JSON.stringify(options));
    assert.equal(result.reason, "unsupported", JSON.stringify(options));
  }
});

test("fetchReleaseNotes classifies HTTP statuses and transport failures", async () => {
  const status = (code) => Object.assign(new Error(`Release 请求失败 (${code})`), { status: code });
  assert.deepEqual(await fetchReleaseNotes({ flavor: "github", repository: "a/b", version: "1.0.0", fetch: async () => { throw status(404); } }), { ok: false, reason: "missing" });
  assert.deepEqual(await fetchReleaseNotes({ flavor: "github", repository: "a/b", version: "1.0.0", fetch: async () => { throw status(422); } }), { ok: false, reason: "missing" });
  assert.deepEqual(await fetchReleaseNotes({ flavor: "github", repository: "a/b", version: "1.0.0", fetch: async () => { throw status(403); } }), { ok: false, reason: "rate-limited" });
  assert.deepEqual(await fetchReleaseNotes({ flavor: "github", repository: "a/b", version: "1.0.0", fetch: async () => { throw status(429); } }), { ok: false, reason: "rate-limited" });
  const server = await fetchReleaseNotes({ flavor: "github", repository: "a/b", version: "1.0.0", fetch: async () => { throw status(500); } });
  assert.equal(server.ok, false); assert.equal(server.reason, "error");
  const net = await fetchReleaseNotes({ flavor: "github", repository: "a/b", version: "1.0.0", fetch: async () => { throw new Error("ECONNRESET"); } });
  assert.equal(net.ok, false); assert.equal(net.reason, "network"); assert.match(net.message, /ECONNRESET/);
});

test("fetchReleaseNotes treats tag mismatch, empty body and invalid JSON as missing/error", async () => {
  const mismatch = await fetchReleaseNotes({ flavor: "github", repository: "a/b", version: "1.0.0", fetch: notesFetchOk({ ...GITHUB_ROW, tag_name: "v9.9.9", body: "x" }) });
  assert.equal(mismatch.ok, false); assert.equal(mismatch.reason, "missing");
  const empty = await fetchReleaseNotes({ flavor: "github", repository: "a/b", version: "1.0.0", fetch: notesFetchOk({ ...GITHUB_ROW, body: "   " }) });
  assert.equal(empty.ok, false); assert.equal(empty.reason, "missing");
  const junk = await fetchReleaseNotes({ flavor: "github", repository: "a/b", version: "1.0.0", fetch: async () => Buffer.from("<html>rate limit</html>") });
  assert.equal(junk.ok, false); assert.equal(junk.reason, "error");
});

test("fetchReleaseNotesList keeps only stable v-tags, sorts numerically desc and caps entries", async () => {
  const rows = [];
  for (let i = 1; i <= 25; i++) rows.push({ tag_name: "v1.0." + i, name: "v1.0." + i, body: "x", created_at: "2026-01-01T00:00:00Z" });
  rows.unshift({ tag_name: "nightly-build", body: "x" }, { tag_name: "v2.0.0-beta.1", body: "x" },
    { tag_name: "v3.0.0", prerelease: true, body: "x" });   // prerelease 不进历史列表（与更新器候选过滤同规则）
  const result = await fetchReleaseNotesList({ flavor: "github", repository: "a/b", fetch: notesFetchOk(rows) });
  assert.equal(result.ok, true);
  assert.equal(result.releases.length, 20);
  assert.equal(result.releases[0].version, "1.0.25");   // 数值降序，不是字符串排序
  assert.equal(result.releases[1].version, "1.0.24");
  assert.ok(result.releases.every((r) => /^v\d+\.\d+\.\d+$/.test(r.tag)));
  assert.ok(!result.releases.some((r) => r.tag === "v2.0.0-beta.1"));
  assert.ok(!result.releases.some((r) => r.tag === "v3.0.0"));
});

test("notes cache persists per identity, truncates bodies, evicts oldest and survives corruption", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-notes-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "plugin-notes-cache.json");
  let time = 1000;
  const cache = createNotesCache({ file, now: () => time, ttlMs: 60000, maxEntries: 2, maxBodyChars: 8 });
  assert.equal(cache.key("github", "a/b", "1.0.0"), "github|a/b|1.0.0");
  assert.equal(cache.get(cache.key("github", "a/b", "1.0.0")), null);
  cache.put(cache.key("github", "a/b", "1.0.0"), { tag: "v1.0.0", body: "1234567890ABC" });
  const row = cache.get(cache.key("github", "a/b", "1.0.0"));
  assert.equal(row.notes.body, "12345678");   // 超长正文截断进缓存
  assert.equal(row.notes.truncated, true);
  assert.equal(cache.fresh(cache.key("github", "a/b", "1.0.0")), true);
  time += 60001;
  assert.equal(cache.fresh(cache.key("github", "a/b", "1.0.0")), false);   // TTL 过期但不删除，供 stale 降级
  assert.equal(cache.get(cache.key("github", "a/b", "1.0.0")) !== null, true);
  cache.put(cache.key("github", "a/b", "0.9.0"), { tag: "v0.9.0", body: "old" });
  cache.put(cache.key("gitcode", "a/b", "1.0.0"), { tag: "v1.0.0", body: "other" });   // 同版本不同来源是不同身份
  assert.equal(cache.get(cache.key("github", "a/b", "1.0.0")), null);   // 超出 maxEntries：最旧的 github|1.0.0 被逐出
  assert.equal(cache.get(cache.key("gitcode", "a/b", "1.0.0")).notes.body, "other");
  fs.writeFileSync(file, "{corrupt");
  time = 1000;
  const broken = createNotesCache({ file, now: () => time });
  assert.equal(broken.get(broken.key("github", "a/b", "1.0.0")), null);   // 损坏文件按空缓存处理，不抛错
  broken.put(broken.key("github", "a/b", "1.0.0"), { tag: "v1.0.0", body: "fresh" });
  assert.equal(createNotesCache({ file, now: () => time }).get("github|a/b|1.0.0").notes.body, "fresh");   // 写入即重建
});

test("notes service dedupes concurrent fetches for the same identity", async () => {
  let calls = 0, release;
  const gate = new Promise((done) => { release = done; });
  const service = createNotesService({
    fetch: async (url) => {
      calls++;
      const tag = decodeURIComponent(url.split("/tags/")[1] || "v?");
      await gate;
      return Buffer.from(JSON.stringify({ ...GITHUB_ROW, tag_name: tag }));
    },
  });
  const first = service.getNotes({ flavor: "github", repository: "a/b", version: "1.5.7" });
  const second = service.getNotes({ flavor: "github", repository: "a/b", version: "1.5.7" });
  const other = service.getNotes({ flavor: "github", repository: "a/b", version: "1.5.6" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls, 2);   // 同身份去重，不同版本各自请求
  release();
  const a = await first, b = await second;
  assert.equal((await other).ok, true);
  assert.equal(a.ok, true); assert.equal(b.ok, true);
  assert.equal(a.body, b.body); assert.equal(a.tag, b.tag);   // 平铺形状：正文在顶层
});

test("notes service serves fresh cache, falls back to stale cache on failure and honors force", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-notes-svc-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let time = 1000, fail = false, calls = 0;
  const cache = createNotesCache({ file: path.join(dir, "cache.json"), now: () => time, ttlMs: 60000 });
  const service = createNotesService({ fetch: async () => { calls++; if (fail) throw new Error("down"); return Buffer.from(JSON.stringify(GITHUB_ROW)); }, cache });
  const first = await service.getNotes({ flavor: "github", repository: "a/b", version: "1.5.7" });
  assert.equal(first.ok, true); assert.equal(first.fromCache, undefined); assert.equal(calls, 1);
  const fresh = await service.getNotes({ flavor: "github", repository: "a/b", version: "1.5.7" });
  assert.equal(fresh.fromCache, true); assert.equal(calls, 1);   // 新鲜缓存不发请求
  time += 61000; fail = true;
  const stale = await service.getNotes({ flavor: "github", repository: "a/b", version: "1.5.7" });
  assert.equal(stale.ok, true); assert.equal(stale.stale, true);   // 失效网络退回旧值并标 stale
  assert.equal(stale.fromCache, true); assert.match(stale.body, /修复安装问题/);
  const forced = await service.getNotes({ flavor: "github", repository: "a/b", version: "1.5.7", force: true });
  assert.equal(forced.ok, false);   // force 绕过缓存降级：如实报错，不让用户重试拿到假成功
  assert.equal(forced.reason, "network");
  fail = false;
  const recovered = await service.getNotes({ flavor: "github", repository: "a/b", version: "1.5.7", force: true });
  assert.equal(recovered.ok, true); assert.equal(recovered.fromCache, undefined);
});

test("notes service caches the release list separately from per-version notes", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-notes-list-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let calls = 0;
  const cache = createNotesCache({ file: path.join(dir, "cache.json") });
  const row = { tag_name: "v1.5.7", body: "x", created_at: "2026-10-30T00:00:00Z" };
  const service = createNotesService({
    fetch: async (url) => { calls++; return Buffer.from(JSON.stringify(url.includes("/releases/tags/") ? row : [row])); }, cache,
  });
  const first = await service.getList({ flavor: "github", repository: "a/b" });
  const second = await service.getList({ flavor: "github", repository: "a/b" });
  assert.equal(first.ok, true); assert.equal(second.fromCache, true); assert.equal(calls, 1);
  assert.equal(first.releases[0].tag, "v1.5.7");
  const note = await service.getNotes({ flavor: "github", repository: "a/b", version: "1.5.7" });
  assert.equal(calls, 2);   // 列表缓存不替代单版本正文拉取
  assert.equal(note.ok, true);
});

test("fetchBytes honors the injected host list and keeps release downloads unchanged", async () => {
  await assert.rejects(() => fetchBytes("https://evil.example/x", 100, undefined, ["api.github.com"]), /拒绝非 GitHub\/GitCode/);
  await assert.rejects(() => fetchBytes("https://api.gitcode.com/x", 100, undefined, ["api.github.com"]), /拒绝非 GitHub\/GitCode/);
  await assert.rejects(() => fetchBytes("http://api.github.com/x", 100, undefined, ["api.github.com"]), /拒绝非 GitHub\/GitCode/);
});
test("fresh fetch and cache hits share the same body cap (truncation is not cache-only)", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-notes-cap-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cache = createNotesCache({ file: path.join(dir, "cache.json"), maxBodyChars: 32 });
  const service = createNotesService({
    fetch: async () => Buffer.from(JSON.stringify({ ...GITHUB_ROW, body: "A".repeat(1000) })), cache,
  });
  const fresh = await service.getNotes({ flavor: "github", repository: "a/b", version: "1.5.7" });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.body.length, 32);   // 新鲜路径同样被截断，杜绝 ~255KB 直达渲染
  assert.equal(fresh.truncated, true);
  const cached = await service.getNotes({ flavor: "github", repository: "a/b", version: "1.5.7", force: false });
  assert.equal(cached.body.length, 32);
});

test("notes and list cache slots are namespaced and never collide on crafted versions", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-notes-key-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cache = createNotesCache({ file: path.join(dir, "cache.json") });
  const rows = [{ tag_name: "v1.5.7", body: "x", created_at: "2026-10-30T00:00:00Z" }];
  const service = createNotesService({
    fetch: async (url) => Buffer.from(JSON.stringify(url.includes("/releases/tags/") ? rows[0] : rows)), cache,
  });
  await service.getList({ flavor: "github", repository: "a/b" });
  const crafted = await service.getNotes({ flavor: "github", repository: "a/b", version: "|list" });
  assert.equal(crafted.ok, false);   // 不与列表缓存槽碰撞（键命名空间 n:/list）
  assert.equal(crafted.reason, "unsupported");   // 非稳定版本在形状门前被拒
});

test("cache load rejects oversized bodies and out-of-range timestamps", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-notes-load-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "cache.json");
  const cache = createNotesCache({ file, now: () => 1000, maxBodyChars: 16 });
  cache.put("github|a/b|n:1.0.0", { tag: "v1.0.0", body: "ok" });
  const disk = JSON.parse(fs.readFileSync(file, "utf8"));
  disk.entries["github|a/b|n:9.9.9"] = { notes: { tag: "v9.9.9", body: "X".repeat(64) }, fetchedAt: 1000 };
  disk.entries["github|a/b|n:9.9.8"] = { notes: { tag: "v9.9.8", body: "ok" }, fetchedAt: 9e15 };   // 超出 Date 上限
  fs.writeFileSync(file, JSON.stringify(disk));
  const reloaded = createNotesCache({ file, now: () => 1000, maxBodyChars: 16 });
  assert.equal(reloaded.get("github|a/b|n:9.9.9"), null);   // 超大 body 拒绝
  assert.equal(reloaded.get("github|a/b|n:9.9.8"), null);   // 越界时间戳拒绝
  assert.equal(reloaded.get("github|a/b|n:1.0.0").notes.body, "ok");   // 合法条目保留
});

test("github rate-limited notes fall back to the official GitCode mirror", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-notes-mirror-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hosts = [];
  const rateLimited = Object.assign(new Error("Release 请求失败 (403)"), { status: 403 });
  const service = createNotesService({
    fetch: async (url) => {
      hosts.push(new URL(url).hostname);
      if (new URL(url).hostname === "api.github.com") throw rateLimited;   // 主源限流
      return Buffer.from(JSON.stringify({ ...GITHUB_ROW, body: "镜像正文" }));
    },
  });
  const r = await service.getNotes({ flavor: "github", repository: "ByteRax/zcode-token-usage-statusbar", version: "1.5.7" });
  assert.equal(r.ok, true);
  assert.equal(r.mirror, true);   // 镜像回退标记（浮层据此标注实际来源）
  assert.equal(r.body, "镜像正文");
  assert.deepEqual(hosts, ["api.github.com", "api.gitcode.com"]);
  assert.equal(new URL(r.url).hostname, "gitcode.com");
  // 无镜像可供回退的形态不跳：gitcode 渠道限流保持限流（不得反向跳 github）
  const hostsGc = [];
  const gcService = createNotesService({
    fetch: async (url) => { hostsGc.push(new URL(url).hostname); throw Object.assign(new Error("Release 请求失败 (429)"), { status: 429 }); },
  });
  const gc = await gcService.getNotes({ flavor: "gitcode", repository: "tanranran/zcode-token-usage-statusbar", version: "1.5.7" });
  assert.equal(gc.ok, false); assert.equal(gc.reason, "rate-limited");
  assert.deepEqual(hostsGc, ["api.gitcode.com"]);   // 只有 gitcode 一跳
  // 主源成功时不触发镜像
  const hosts2 = [];
  const ok = createNotesService({ fetch: async (url) => { hosts2.push(new URL(url).hostname); return Buffer.from(JSON.stringify(GITHUB_ROW)); } });
  const good = await ok.getNotes({ flavor: "github", repository: "ByteRax/zcode-token-usage-statusbar", version: "1.5.7" });
  assert.equal(good.ok, true); assert.equal(good.mirror, undefined);
  assert.deepEqual(hosts2, ["api.github.com"]);
});

test("mirror 404 is authoritative: missing beats the primary rate limit", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-notes-404-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const service = createNotesService({
    fetch: async (url) => {
      if (new URL(url).hostname === "api.github.com") throw Object.assign(new Error("Release 请求失败 (403)"), { status: 403 });
      throw Object.assign(new Error("Release 请求失败 (404)"), { status: 404 });   // 镜像确认该版本从未发布
    },
  });
  const r = await service.getNotes({ flavor: "github", repository: "ByteRax/zcode-token-usage-statusbar", version: "1.5.9" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "missing");   // 显示「此版本暂无更新日志」而非误导性的限流重试
  assert.equal(r.mirror, true);
});

test("both sides rate-limited keeps the honest rate-limited state", async () => {
  const rateLimited = Object.assign(new Error("Release 请求失败 (429)"), { status: 429 });
  const service = createNotesService({ fetch: async () => { throw rateLimited; } });
  const r = await service.getNotes({ flavor: "github", repository: "ByteRax/zcode-token-usage-statusbar", version: "1.5.7" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "rate-limited");   // 双侧失败不虚报，浮层仍可重试
});
