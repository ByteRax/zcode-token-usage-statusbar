"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const https = require("https");
const { EventEmitter } = require("events");
const { githubRepository, gitcodeRepository, readChannel, checkRelease, gitcodeReleaseFromCatalog, githubReleaseFromCatalog, validateGitcodeRelease, validateGithubCatalogRelease,
  downloadRelease, validateRelease, validateManifest, catalogChannel, probeRepositoryRename,
  fetchBytes, sameAssetUrl, MAX_ASSET, MAX_JSON, PLUGIN_ID } = require("../plugin-release.cjs");
const { compareVersions } = require("../plugin-updater.cjs");

function release(version, repository = "ByteRax/zcode-token-usage-statusbar") {
  const base = `https://github.com/${repository}/releases/download/v${version}/`;
  return { tag_name: "v" + version, draft: false, prerelease: false,
    assets: [{ name: `zcode-token-usage-statusbar-v${version}.zip`, state: "uploaded", size: 3,
      browser_download_url: base + `zcode-token-usage-statusbar-v${version}.zip` },
    { name: "release-manifest.json", state: "uploaded", size: 512, browser_download_url: base + "release-manifest.json" }] };
}
function fixture(t, source) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-channel-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, ".zcode", "cli", "plugins"); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "known_marketplaces.json"), JSON.stringify({ marketplaces: [{ id: "zusage-marketplace", source }] }));
  return home;
}
function channel(home) { return readChannel(home, path.join(home, ".zcode", "cli", "plugins")); }
function packageFixture() {
  const selected = validateRelease(release("1.4.0"), "ByteRax/zcode-token-usage-statusbar"), bytes = Buffer.from("zip");
  const manifest = { schemaVersion: 1, repository: selected.repository, version: selected.version, tag: selected.tag,
    pluginId: PLUGIN_ID, asset: { name: selected.archive.name, size: bytes.length,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex") } };
  const fetch = async (url) => url === selected.manifest.browser_download_url ? Buffer.from(JSON.stringify(manifest)) : bytes;
  return { selected, bytes, manifest, fetch };
}
function mockHttps(t, routes) {
  const calls = [];
  t.mock.method(https, "get", (url, options, callback) => {
    const route = routes[calls.length]; calls.push(url.href);
    assert.ok(route, `unexpected request: ${url.href}`);
    assert.equal(options.headers["User-Agent"], "zcode-token-usage-statusbar-release-updater");
    const request = new EventEmitter(); let socketTimeout;
    request.setTimeout = (ms, handler) => { assert.equal(ms, 30000); socketTimeout = handler; return request; };
    request.destroy = (error) => { queueMicrotask(() => request.emit("error", error)); return request; };
    queueMicrotask(() => {
      if (route.requestError) { request.emit("error", route.requestError); return; }
      if (route.socketTimeout) { socketTimeout(); return; }
      const response = new EventEmitter();
      response.statusCode = route.status || 200; response.headers = route.headers || {}; response.complete = route.complete !== false;
      response.resume = () => {}; response.destroy = () => { response.destroyed = true; };
      callback(response);
      if (response.statusCode !== 200 || response.destroyed) return;
      for (const chunk of route.chunks || [Buffer.from("zip")]) {
        response.emit("data", chunk); if (response.destroyed) return;
      }
      if (route.error) response.emit("error", route.error);
      else if (route.aborted) response.emit("aborted");
      else response.emit("end");
    });
    return request;
  });
  return calls;
}
test("R6 repository case is compatible but hosts tags and asset paths remain exact", () => {
  const selected = validateRelease(release("1.4.0"), "byterax/zcode-token-usage-statusbar");
  const f = packageFixture();
  validateManifest({ ...f.manifest, repository: "BYTERAX/ZCODE-TOKEN-USAGE-STATUSBAR" }, selected);
  for (const url of [selected.archive.browser_download_url.replace("github.com", "GITHUB.COM"),
    selected.archive.browser_download_url.replace("v1.4.0", "V1.4.0"), selected.archive.browser_download_url + "?x=1"]) {
    const row = release("1.4.0"); row.assets[0].browser_download_url = url;
    assert.throws(() => validateRelease(row, selected.repository));
  }
});

test("R13 redirected download shares one deadline and cancels current request", async (t) => {
  const timers = new Set(), requests = [];
  t.mock.method(global, "setTimeout", (fn, ms) => { const timer = { fn, ms }; timers.add(timer); return timer; });
  t.mock.method(global, "clearTimeout", (timer) => timers.delete(timer));
  t.mock.method(https, "get", (url, options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = (error) => { request.destroyed = true; queueMicrotask(() => request.emit("error", error)); };
    requests.push(request);
    const redirect = requests.length === 1;
    queueMicrotask(() => {
      const response = new EventEmitter(); response.headers = {}; response.destroy = () => { response.destroyed = true; };
      response.resume = () => {}; response.statusCode = redirect ? 302 : 200;
      if (redirect) response.headers.location = "https://release-assets.githubusercontent.com/fixture";
      callback(response);
    });
    return request;
  });
  const pending = fetchBytes("https://github.com/owner/repo/asset", 100);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 2); assert.equal(timers.size, 1);
  const rejected = assert.rejects(pending, /总时限/);
  [...timers][0].fn(); await rejected;
  assert.equal(requests[1].destroyed, true); assert.equal(timers.size, 0);
});

test("registered directory stays local and GitHub/git repository selects release without rebinding", (t) => {
  assert.equal(channel(fixture(t, { source: "directory", path: "/dev" })).kind, "local");
  assert.equal(channel(fixture(t, { source: "github", repo: "ByteRax/zcode-token-usage-statusbar", ref: "plugin-releases" })).repository, "ByteRax/zcode-token-usage-statusbar");
  assert.equal(channel(fixture(t, { source: "git", url: "https://github.com/ByteRax/zcode-token-usage-statusbar.git" })).kind, "release");
  assert.throws(() => channel(fixture(t, { source: "git", url: "https://gitlab.com/owner/repo.git" })), /GitHub/);
});
test("repository validation does not accept credentials, query, non-GitHub URLs or branch suffix", () => {
  assert.equal(githubRepository("git@github.com:ByteRax/project.git"), "ByteRax/project");
  for (const value of ["https://evil.com/owner/repo", "https://token@github.com/owner/repo", "owner/repo#main", "owner/repo?x=1", "../repo"]) assert.equal(githubRepository(value), null);
});
test("registered GitCode git source selects the gitcode release flavor; other hosts stay rejected", (t) => {
  const selected = channel(fixture(t, { source: "git", url: "https://gitcode.com/tanranran/zcode-token-usage-statusbar.git", ref: "plugin-releases-gitcode" }));
  assert.deepEqual({ kind: selected.kind, flavor: selected.flavor, repository: selected.repository },
    { kind: "release", flavor: "gitcode", repository: "tanranran/zcode-token-usage-statusbar" });
  const github = channel(fixture(t, { source: "git", url: "https://github.com/ByteRax/zcode-token-usage-statusbar.git" }));
  assert.equal(github.flavor, "github");
  assert.throws(() => channel(fixture(t, { source: "git", url: "https://gitlab.com/owner/repo.git" })), /GitHub\/GitCode/);
  assert.equal(gitcodeRepository("git@gitcode.com:tanranran/project.git"), "tanranran/project");
  for (const value of ["https://evil.com/owner/repo", "https://gitcode.com.evil.com/owner/repo", "owner/repo#main"]) assert.equal(gitcodeRepository(value), null);
});
test("asset URLs only match within the same release host", () => {
  const githubUrl = "https://github.com/ByteRax/zcode-token-usage-statusbar/releases/download/v1.5.2/a.zip";
  const gitcodeUrl = "https://gitcode.com/tanranran/zcode-token-usage-statusbar/releases/download/v1.5.2/a.zip";
  assert.equal(sameAssetUrl(githubUrl, githubUrl), true);
  assert.equal(sameAssetUrl(gitcodeUrl, gitcodeUrl), true);
  assert.equal(sameAssetUrl(githubUrl, gitcodeUrl), false);
  assert.equal(sameAssetUrl(gitcodeUrl.replace("gitcode.com", "file-cdn.gitcode.com"), gitcodeUrl), false);
});
test("gitcode release synthesized from the channel catalog pins repo, tag and asset names", (t) => {
  const repo = "tanranran/zcode-token-usage-statusbar";
  const sha256 = "a".repeat(64);
  const catalog = { name: "zusage-marketplace", plugins: [{ name: "zcode-token-usage-statusbar", version: "1.5.2",
    source: { source: "url", type: "zip", url: `https://gitcode.com/${repo}/releases/download/v1.5.2/zcode-token-usage-statusbar-v1.5.2.zip`,
      sha256, path: "plugins/zcode-token-usage-statusbar", stripRoot: false } }] };
  const selected = gitcodeReleaseFromCatalog(catalog, repo);
  assert.equal(selected.flavor, "gitcode");
  assert.equal(selected.version, "1.5.2");
  assert.equal(selected.tag, "v1.5.2");
  assert.equal(selected.archive.size, null);
  assert.equal(selected.archive.browser_download_url, catalog.plugins[0].source.url);
  assert.equal(selected.manifest.browser_download_url, `https://gitcode.com/${repo}/releases/download/v1.5.2/release-manifest.json`);
  assert.equal(selected.url, `https://gitcode.com/${repo}/releases/tag/v1.5.2`);
  const upstreamManifest = { schemaVersion: 1, repository: "ByteRax/zcode-token-usage-statusbar", version: "1.5.2",
    tag: "v1.5.2", pluginId: PLUGIN_ID, asset: { name: "zcode-token-usage-statusbar-v1.5.2.zip", size: 603706, sha256 } };
  validateManifest(upstreamManifest, selected);
  validateGitcodeRelease(selected);
  assert.equal(validateGitcodeRelease({ ...selected, archive: { ...selected.archive, size: 3 } }), null);
  assert.equal(validateGitcodeRelease({ ...selected, tag: "v1.5.3" }), null);
  for (const mutate of [(entry) => { entry.version = "1.5.3"; },
    (entry) => { entry.source.url = entry.source.url.replace("tanranran", "evil"); },
    (entry) => { entry.source.url = entry.source.url.replace("v1.5.2", "v1.5.3"); },
    (entry) => { entry.source.url = entry.source.url.replace("gitcode.com", "github.com"); },
    (entry) => { entry.source.sha256 = "zz".repeat(32); },
    (entry) => { entry.source.headers = {}; },
    (entry) => { entry.source.stripRoot = true; },
    (entry) => { entry.source.path = "plugins/other"; },
    (entry) => { entry.source.source = "directory"; }]) {
    const broken = JSON.parse(JSON.stringify(catalog));
    mutate(broken.plugins[0]);
    assert.throws(() => gitcodeReleaseFromCatalog(broken, repo), /GitCode 渠道清单/);
  }
  assert.throws(() => gitcodeReleaseFromCatalog(catalog, "ByteRax/zcode-token-usage-statusbar"), /不一致/);
});
test("github release synthesized from the channel catalog pins repo, tag and asset names", () => {
  const repo = "ByteRax/zcode-token-usage-statusbar";
  const sha256 = "b".repeat(64);
  const catalog = { name: "zusage-marketplace", plugins: [{ name: "zcode-token-usage-statusbar", version: "1.5.6",
    source: { source: "url", type: "zip", url: `https://github.com/${repo}/releases/download/v1.5.6/zcode-token-usage-statusbar-v1.5.6.zip`,
      sha256, path: "plugins/zcode-token-usage-statusbar", stripRoot: false } }] };
  const selected = githubReleaseFromCatalog(catalog, repo);
  assert.equal(selected.flavor, "github");
  assert.equal(selected.version, "1.5.6");
  assert.equal(selected.tag, "v1.5.6");
  assert.equal(selected.archive.size, null);
  assert.equal(selected.archive.browser_download_url, catalog.plugins[0].source.url);
  assert.equal(selected.catalogSha256, sha256);
  assert.equal(selected.manifest.browser_download_url, `https://github.com/${repo}/releases/download/v1.5.6/release-manifest.json`);
  assert.equal(selected.url, `https://github.com/${repo}/releases/tag/v1.5.6`);
  const manifest = { schemaVersion: 1, repository: repo, version: "1.5.6",
    tag: "v1.5.6", pluginId: PLUGIN_ID, asset: { name: "zcode-token-usage-statusbar-v1.5.6.zip", size: 603706, sha256 } };
  validateManifest(manifest, selected);
  assert.equal(validateGithubCatalogRelease(selected).version, "1.5.6");
  assert.equal(validateGithubCatalogRelease({ ...selected, archive: { ...selected.archive, size: 3 } }), null);
  assert.equal(validateGithubCatalogRelease({ ...selected, tag: "v1.5.7" }), null);
  assert.equal(validateGithubCatalogRelease({ ...selected, catalogSha256: undefined }), null);
  assert.equal(validateGithubCatalogRelease({ ...selected, url: selected.url.replace("github.com", "gitcode.com") }), null);
  for (const mutate of [(entry) => { entry.version = "1.5.7"; },
    (entry) => { entry.source.url = entry.source.url.replace("ByteRax", "evil"); },
    (entry) => { entry.source.url = entry.source.url.replace("v1.5.6", "v1.5.7"); },
    (entry) => { entry.source.url = entry.source.url.replace("github.com", "gitcode.com"); },
    (entry) => { entry.source.sha256 = "zz".repeat(32); },
    (entry) => { entry.source.headers = {}; },
    (entry) => { entry.source.stripRoot = true; },
    (entry) => { entry.source.path = "plugins/other"; },
    (entry) => { entry.source.source = "directory"; }]) {
    const broken = JSON.parse(JSON.stringify(catalog));
    mutate(broken.plugins[0]);
    assert.throws(() => githubReleaseFromCatalog(broken, repo), /GitHub 渠道清单/);
  }
  assert.throws(() => githubReleaseFromCatalog(catalog, "tanranran/zcode-token-usage-statusbar"), /不一致/);
});
test("formal release selection ignores screenshots, drafts and prereleases and compares numeric versions", async () => {
  const rows = [release("1.9.0"), { ...release("2.0.0"), draft: true }, { ...release("3.0.0"), prerelease: true },
    { ...release("4.0.0"), tag_name: "screenshots-v65-hover-bubble" }, release("1.10.0")];
  const selected = await checkRelease("ByteRax/zcode-token-usage-statusbar", compareVersions, async () => Buffer.from(JSON.stringify(rows)));
  assert.equal(selected.version, "1.10.0");
});
test("no proper assets or corrupted release metadata never falls back to a development branch", async () => {
  const repo = "ByteRax/zcode-token-usage-statusbar";
  await assert.rejects(checkRelease(repo, compareVersions, async () => Buffer.from("[]")), /正式 Release/);
  const bad = release("1.0.0"); bad.assets[0].browser_download_url = "https://evil.com/payload.zip";
  await assert.rejects(checkRelease(repo, compareVersions, async () => Buffer.from(JSON.stringify([bad]))), /来源/);
  await assert.rejects(fetchBytes("http://github.com/a/b", 100), /HTTPS/);
});
test("download verifies source manifest, asset hash and unpack result and cleans its temp only", async () => {
  const repo = "ByteRax/zcode-token-usage-statusbar";
  const selected = await checkRelease(repo, compareVersions, async () => Buffer.from(JSON.stringify([release("1.4.0")])));
  const bytes = Buffer.from("zip");
  const manifest = { schemaVersion: 1, repository: repo, version: "1.4.0", tag: "v1.4.0",
    pluginId: "zcode-token-usage-statusbar@zusage-marketplace", asset: { name: selected.archive.name, size: bytes.length,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex") } };
  const fetch = async (url) => url.endsWith("release-manifest.json") ? Buffer.from(JSON.stringify(manifest)) : bytes;
  let output;
  const downloaded = await downloadRelease(selected, "python3", fetch, async (command, args) => {
    assert.equal(command, "python3"); output = args[args.indexOf("--output") + 1];
    return { ok: true, marketplaceRoot: output, pluginRoot: path.join(output, "plugins", "zcode-token-usage-statusbar"), version: "1.4.0" };
  });
  assert.ok(fs.existsSync(downloaded.directory)); downloaded.cleanup(); assert.equal(fs.existsSync(downloaded.directory), false);
  assert.throws(() => validateManifest({ ...manifest, repository: "attacker/repo" }, selected), /不一致/);
  await assert.rejects(downloadRelease(selected, "python3", async (url) => url.endsWith("release-manifest.json") ? Buffer.from(JSON.stringify(manifest)) : Buffer.from("bad")), /SHA256/);
});
test("unpack result paths compare by resolved identity, tolerating Windows 8.3 short-name expansions", async (t) => {
  const f = packageFixture(), parent = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-release-test-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  t.mock.method(os, "tmpdir", () => parent);
  // Windows 上 os.tmpdir() 可能是 8.3 短路径，解包器返回 Path.resolve() 展开后的长路径：
  // 两侧字符串不等但指向同一目录。用 junction/symlink 别名作为「另一字符串形态」的可移植模拟。
  const unpackViaAlias = async (command, args) => {
    const output = args[args.indexOf("--output") + 1];
    fs.mkdirSync(path.join(output, "plugins", "zcode-token-usage-statusbar"), { recursive: true });
    const alias = path.join(path.dirname(output), "marketplace-aliased");
    fs.symlinkSync(output, alias, "junction");
    return { ok: true, version: f.selected.version, marketplaceRoot: alias,
      pluginRoot: path.join(alias, "plugins", "zcode-token-usage-statusbar") };
  };
  const downloaded = await downloadRelease(f.selected, "python3", f.fetch, unpackViaAlias);
  assert.equal(fs.realpathSync(downloaded.pluginRoot), fs.realpathSync(path.join(downloaded.marketplaceRoot, "plugins", "zcode-token-usage-statusbar")));
  downloaded.cleanup();
  assert.equal(fs.existsSync(downloaded.directory), false);
  // 归一化不得放宽校验：指向别处的解包结果即使真实存在也仍拒绝。
  const stray = path.join(parent, "stray"); fs.mkdirSync(stray, { recursive: true });
  await assert.rejects(downloadRelease(f.selected, "python3", f.fetch, async (command, args) => {
    const output = args[args.indexOf("--output") + 1];
    fs.mkdirSync(path.join(output, "plugins", "zcode-token-usage-statusbar"), { recursive: true });
    return { ok: true, version: f.selected.version, marketplaceRoot: stray,
      pluginRoot: path.join(stray, "plugins", "zcode-token-usage-statusbar") };
  }), /无效/);
  // 两侧路径都不存在时回退严格字符串比较，捏造的路径（含靠 ../ 折叠伪装期望值的写法）不得借归一化混入。
  const expectedPlugin = (output) => path.join(output, "plugins", "zcode-token-usage-statusbar");
  const ghosts = [
    (output) => ({ marketplaceRoot: path.join(path.dirname(output), "ghost"),
      pluginRoot: expectedPlugin(output) }),
    (output) => ({ marketplaceRoot: output,
      pluginRoot: expectedPlugin(output) + path.sep + ".." + path.sep + "zcode-token-usage-statusbar" }),
  ];
  for (const ghost of ghosts) {
    await assert.rejects(downloadRelease(f.selected, "python3", f.fetch, async (command, args) => {
      const output = args[args.indexOf("--output") + 1];
      return { ok: true, version: f.selected.version, ...ghost(output) };
    }), /无效/);
  }
});
test("channel rejects untrusted repositories and duplicate known marketplace identities without writing", (t) => {
  for (const source of [{ source: "github", repo: "owner/repo#main" }, { source: "git", url: "https://token@github.com/owner/repo.git" },
    { source: "git", url: "https://github.com/owner/repo.git?ref=main" }, { source: "url", url: "https://github.com/owner/repo" }]) {
    assert.throws(() => channel(fixture(t, source)), /仅支持已注册的 GitHub\/GitCode 仓库来源/);
  }
  const home = fixture(t, { source: "github", repo: "ByteRax/zcode-token-usage-statusbar" });
  const file = path.join(home, ".zcode", "cli", "plugins", "known_marketplaces.json");
  const record = JSON.parse(fs.readFileSync(file)).marketplaces[0];
  for (const duplicate of [record, { name: "zusage-marketplace", source: record.source }]) {
    const body = JSON.stringify({ marketplaces: [record, duplicate] }); fs.writeFileSync(file, body);
    assert.throws(() => channel(home), /注册来源/); assert.equal(fs.readFileSync(file, "utf8"), body);
  }
});
test("release selection paginates and refuses ambiguous pagination, absent formal releases and fetch failures", async () => {
  const repo = "ByteRax/zcode-token-usage-statusbar", calls = [];
  const first = Array.from({ length: 100 }, () => ({ tag_name: "fixture-screenshot", draft: false, prerelease: false }));
  first[0] = release("1.9.0");
  const selected = await checkRelease(repo, compareVersions, async (url, limit) => {
    calls.push(url); assert.equal(limit, 4 * 1024 * 1024);
    return Buffer.from(JSON.stringify(calls.length === 1 ? first : [release("1.10.0")]));
  });
  assert.equal(selected.version, "1.10.0");
  assert.deepEqual(calls, [1, 2].map((page) => `https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`));
  let pages = 0;
  await assert.rejects(checkRelease(repo, compareVersions, async () => { pages++; return Buffer.from(JSON.stringify(first)); }), /分页上限/);
  assert.equal(pages, 10);
  for (const rows of [[], [{ ...release("1.0.0"), draft: true }], [{ ...release("1.0.0"), prerelease: true }],
    [{ ...release("1.0.0"), assets: [] }], [{ ...release("1.0.0"), assets: [...release("1.0.0").assets, release("1.0.0").assets[0]] }]]) {
    await assert.rejects(checkRelease(repo, compareVersions, async () => Buffer.from(JSON.stringify(rows))), /正式 Release/);
  }
  for (const body of ["{bad", "{}"]) await assert.rejects(checkRelease(repo, compareVersions, async () => Buffer.from(body)));
  for (const status of [404, 429]) {
    const error = new Error(`fixture HTTP ${status}`);
    await assert.rejects(checkRelease(repo, compareVersions, async () => { throw error; }), (actual) => actual === error);
  }
});
test("release assets and manifest reject size, hash and repository identity mismatches", () => {
  const { selected, manifest } = packageFixture();
  for (const index of [0, 1]) {
    for (const patch of [{ state: "new" }, { size: 0 }, { size: 1.5 }, { size: index ? MAX_JSON + 1 : MAX_ASSET + 1 },
      { browser_download_url: "https://github.com/attacker/repo/releases/download/v1.4.0/asset.zip" }]) {
      const row = release("1.4.0"); Object.assign(row.assets[index], patch);
      assert.throws(() => validateRelease(row, selected.repository), /来源或大小/);
    }
  }
  for (const patch of [{ schemaVersion: 2 }, { repository: "attacker/repo" }, { pluginId: "other@zusage-marketplace" },
    { version: "1.5.0" }, { tag: "v1.5.0" }, ...[{ name: "other.zip" }, { size: 4 }, { sha256: "invalid" }]
      .map((asset) => ({ asset: { ...manifest.asset, ...asset } }))]) {
    assert.throws(() => validateManifest({ ...manifest, ...patch }, selected), /不一致/);
  }
});
test("download failures never unpack invalid data and clean only their temporary directory", async (t) => {
  const f = packageFixture(), parent = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-release-test-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const sentinel = path.join(parent, "keep"); fs.writeFileSync(sentinel, "fixture");
  t.mock.method(os, "tmpdir", () => parent);
  let unpacked = 0;
  const forbidden = async () => { unpacked++; throw new Error("must not unpack"); };
  for (const fetch of [async () => { throw new Error("fixture fetch failed"); },
    async () => Buffer.from("{bad"), async () => Buffer.from(JSON.stringify({ ...f.manifest, repository: "attacker/repo" })),
    async (url) => url === f.selected.manifest.browser_download_url ? Buffer.from(JSON.stringify(f.manifest)) : Buffer.from("z"),
    async (url) => url === f.selected.manifest.browser_download_url ? Buffer.from(JSON.stringify(f.manifest)) : Buffer.from("bad"),
    async (url) => { if (url === f.selected.archive.browser_download_url) throw new Error("fixture archive failed"); return Buffer.from(JSON.stringify(f.manifest)); }]) {
    await assert.rejects(downloadRelease(f.selected, "python3", fetch, forbidden));
    assert.deepEqual(fs.readdirSync(parent), ["keep"]);
  }
  assert.equal(unpacked, 0);
  for (const invalid of [null, { ok: false }, { version: "1.5.0" }, { marketplaceRoot: parent }, { pluginRoot: parent }, "throw"]) {
    let directory;
    await assert.rejects(downloadRelease(f.selected, "python3", f.fetch, async (command, args) => {
      assert.equal(command, "python3"); assert.equal(args[args.indexOf("--repository") + 1], f.selected.repository);
      const archive = args[args.indexOf("--archive") + 1], output = args[args.indexOf("--output") + 1];
      directory = path.dirname(archive); assert.ok(fs.existsSync(archive));
      if (invalid === "throw") throw new Error("fixture unpack failed");
      return invalid === null ? null : { ok: true, version: f.selected.version, marketplaceRoot: output,
        pluginRoot: path.join(output, "plugins", "zcode-token-usage-statusbar"), ...invalid };
    }), /无效|fixture unpack failed/);
    assert.equal(fs.existsSync(directory), false); assert.deepEqual(fs.readdirSync(parent), ["keep"]);
  }
  assert.equal(fs.readFileSync(sentinel, "utf8"), "fixture");
});
test("fetch mock accepts valid redirect and rejects invalid redirect destinations or loops", async (t) => {
  const routes = [], calls = mockHttps(t, routes), url = "https://github.com/owner/repo/asset.zip";
  routes.push({ status: 302, headers: { location: "https://release-assets.githubusercontent.com/fixture.zip" } }, {});
  assert.equal((await fetchBytes(url, 10)).toString(), "zip"); assert.equal(calls.length, 2);
  for (const location of [undefined, "http://github.com/owner/repo", "https://evil.invalid/asset", "https://user@github.com/a/b", "http://["]) {
    routes.push({ status: 302, headers: location === undefined ? {} : { location } });
    const before = calls.length; await assert.rejects(fetchBytes(url, 10)); assert.equal(calls.length, before + 1);
  }
  routes.push(...Array.from({ length: 4 }, () => ({ status: 302, headers: { location: "/loop" } })));
  await assert.rejects(fetchBytes(url, 10), /重定向无效/);
});
test("fetch mock rejects HTTP errors, aborted or incomplete streams, oversized bodies and socket errors", async (t) => {
  const routes = [], calls = mockHttps(t, routes), url = "https://api.github.com/repos/owner/repo/releases";
  for (const status of [403, 404, 429]) {
    routes.push({ status }); await assert.rejects(fetchBytes(url, 10), new RegExp(String(status)));
  }
  for (const [route, pattern] of [[{ aborted: true }, /中断/], [{ complete: false }, /不完整/],
    [{ headers: { "content-length": "4" } }, /不完整/], [{ headers: { "content-length": "11" } }, /大小上限/],
    [{ chunks: [Buffer.from("123456"), Buffer.from("123456")] }, /大小上限/],
    [{ requestError: new Error("fixture socket error") }, /fixture socket error/], [{ socketTimeout: true }, /请求超时/]]) {
    routes.push(route); await assert.rejects(fetchBytes(url, 10), pattern);
  }
  routes.push({ headers: { "content-length": "3" } }); assert.equal((await fetchBytes(url, 10)).toString(), "zip");
  const before = calls.length;
  for (const denied of ["http://github.com/a/b", "https://user@github.com/a/b", "https://github.com:444/a/b", "https://evil.invalid/a/b"]) {
    await assert.rejects(fetchBytes(denied, 10), /HTTPS/);
  }
  assert.equal(calls.length, before);
});

test("fetch reports cumulative byte progress per chunk only for the final 200 response", async (t) => {
  const routes = [], calls = mockHttps(t, routes), url = "https://github.com/owner/repo/asset.zip";
  routes.push({ status: 302, headers: { location: "https://release-assets.githubusercontent.com/fixture.zip" } },
    { headers: { "content-length": "6" }, chunks: [Buffer.from("zi"), Buffer.from("p-"), Buffer.from("ok")] });
  const seen = [];
  assert.equal((await fetchBytes(url, 10, (loaded, total) => seen.push([loaded, total]))).toString(), "zip-ok");
  assert.equal(calls.length, 2);
  assert.deepEqual(seen, [[2, 6], [4, 6], [6, 6]]);   // 重定向响应不产生进度；declared 来自 content-length
  routes.push({ chunks: [Buffer.from("zip")] });
  assert.equal((await fetchBytes(url, 10)).toString(), "zip");   // 不传回调仍可用
});

test("download publishes download start, byte progress and verify stage before unpacking", async () => {
  const f = packageFixture();
  const fetch = async (url, limit, onProgress) => {
    if (url === f.selected.manifest.browser_download_url) return Buffer.from(JSON.stringify(f.manifest));
    if (onProgress) { onProgress(1, f.bytes.length); onProgress(f.bytes.length, f.bytes.length); }
    return f.bytes;
  };
  const stages = [];
  let unpacked = false;
  const downloaded = await downloadRelease(f.selected, "python3", fetch, async (command, args) => {
    unpacked = true; assert.deepEqual(stages[stages.length - 1], { stage: "verify" }, "verify published before unpack");
    const output = args[args.indexOf("--output") + 1];
    return { ok: true, marketplaceRoot: output, pluginRoot: path.join(output, "plugins", "zcode-token-usage-statusbar"), version: f.selected.version };
  }, (progress) => stages.push(progress));
  downloaded.cleanup();
  assert.ok(unpacked);
  assert.deepEqual(stages, [
    { stage: "download", loaded: 0, total: f.bytes.length },
    { stage: "download", loaded: 1, total: f.bytes.length },
    { stage: "download", loaded: f.bytes.length, total: f.bytes.length },
    { stage: "verify" },
  ]);
  // 回调缺省或抛错前的旧调用形态保持可用
  const plain = await downloadRelease(f.selected, "python3", f.fetch, async (command, args) => {
    const output = args[args.indexOf("--output") + 1];
    return { ok: true, marketplaceRoot: output, pluginRoot: path.join(output, "plugins", "zcode-token-usage-statusbar"), version: f.selected.version };
  });
  plain.cleanup();
});

test("catalogChannel separates Release-pinned catalogs from source checkouts", () => {
  const catalog = (source) => ({ name: "zusage-marketplace", plugins: [{ name: "zcode-token-usage-statusbar", source }] });
  assert.equal(catalogChannel(catalog({ source: "url", type: "zip",
    url: "https://github.com/ByteRax/zcode-token-usage-statusbar/releases/download/v1.5.2/x.zip" })), "release");
  assert.equal(catalogChannel(catalog("./plugins/zcode-token-usage-statusbar")), "source");
  assert.equal(catalogChannel(catalog({ source: "git", url: "https://github.com/ByteRax/zcode-token-usage-statusbar" })), "source");
  assert.equal(catalogChannel(null), "unknown");
  assert.equal(catalogChannel({ plugins: [] }), "unknown");
  assert.equal(catalogChannel({ plugins: [{ name: "other", source: { source: "url", type: "zip" } }] }), "unknown");
});

function writeCatalog(home, catalog) {
  const dir = path.join(home, ".zcode", "cli", "plugins", "marketplaces", "zusage-marketplace");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "marketplace.json"), typeof catalog === "string" ? catalog : JSON.stringify(catalog));
}
test("readChannel routes repository sources whose cached catalog points at source code to the market channel", (t) => {
  const entry = (source) => ({ name: "zusage-marketplace", plugins: [{ name: "zcode-token-usage-statusbar", version: "1.5.2", source }] });
  const sourceCatalog = entry("./plugins/zcode-token-usage-statusbar");
  const releaseCatalog = entry({ source: "url", type: "zip", url: "https://github.com/ByteRax/zcode-token-usage-statusbar/releases/download/v1.5.2/x.zip" });
  const github = { source: "github", repo: "ByteRax/zcode-token-usage-statusbar" };
  const gitcode = { source: "git", url: "https://gitcode.com/tanranran/zcode-token-usage-statusbar.git" };
  const pick = (c) => ({ kind: c.kind, flavor: c.flavor, repository: c.repository });
  let home = fixture(t, github); writeCatalog(home, sourceCatalog);
  assert.deepEqual(pick(channel(home)), { kind: "market", flavor: "github", repository: "ByteRax/zcode-token-usage-statusbar" });
  home = fixture(t, gitcode); writeCatalog(home, sourceCatalog);
  assert.deepEqual(pick(channel(home)), { kind: "market", flavor: "gitcode", repository: "tanranran/zcode-token-usage-statusbar" });
  // Release 清单、缓存缺失、缓存损坏、市场事务进行中：都保持 release 渠道，由后续 Release 流程报出准确原因
  home = fixture(t, github); writeCatalog(home, releaseCatalog);
  assert.equal(channel(home).kind, "release");
  assert.equal(channel(fixture(t, github)).kind, "release");
  home = fixture(t, github); writeCatalog(home, "{not json");
  assert.equal(channel(home).kind, "release");
  home = fixture(t, github); writeCatalog(home, sourceCatalog);
  fs.writeFileSync(path.join(home, ".zcode", "cli", "plugins", "marketplaces", ".zusage-marketplace.transaction.json"), "{}");
  assert.equal(channel(home).kind, "release");
  // 本地目录来源不看清单
  home = fixture(t, { source: "directory", path: path.join(home, "pkg") }); writeCatalog(home, sourceCatalog);
  assert.equal(channel(home).kind, "local");
});
/* 仓库改名探测（install-release.md §6）：信号一律出自 GitHub 官方答复。两个来源——API 的当前
   full_name 与网页 301/302 的 Location；测试必须同时注入两者，默认实现会真实联网。 */
const OLD_REPO = "ByteRax/zcode-token-usage-statusbar", NEW_REPO = "ByteRax/zcode-speed-bar";
const offlineLookup = async () => { throw new Error("api offline"); };
const offlineHead = async () => { throw new Error("web offline"); };
test("repository rename probe via the web accepts only same-host GitHub redirects to a different valid repository", async () => {
  const web = (status, location) => probeRepositoryRename(OLD_REPO, async () => ({ status, location }), offlineLookup);
  assert.equal(await web(301, `https://github.com/${NEW_REPO}`), NEW_REPO);
  assert.equal(await web(302, `https://github.com/${NEW_REPO}/`), NEW_REPO);
  assert.equal(await web(307, `https://github.com/${NEW_REPO}.git`), NEW_REPO);
  assert.equal(await web(200, `https://github.com/${NEW_REPO}`), null);
  assert.equal(await web(404, null), null);
  assert.equal(await web(301, null), null);
  assert.equal(await web(301, "https://evil.com/owner/repo"), null);
  assert.equal(await web(301, "http://github.com/owner/repo"), null);
  assert.equal(await web(301, `https://github.com/${OLD_REPO}`), null);
  assert.equal(await web(301, OLD_REPO.toUpperCase()), null);
  assert.equal(await web(301, "https://github.com/only-owner"), null);
  assert.equal(await web(301, "https://github.com/a/b/extra/deep"), null);
  assert.equal(await probeRepositoryRename(OLD_REPO, offlineHead, offlineLookup), null);
  assert.equal(await probeRepositoryRename("no-slash", async () => ({ status: 301, location: `https://github.com/${NEW_REPO}` }), offlineLookup), null);
});
test("repository rename probe prefers the API answer and only falls back to the web when the API fails", async () => {
  let webCalls = 0;
  const head = async () => { webCalls++; return { status: 301, location: "https://github.com/ByteRax/from-web" }; };
  // API 给出合法的新名：定论，不再碰网页主机
  assert.equal(await probeRepositoryRename(OLD_REPO, head, async () => NEW_REPO), NEW_REPO);
  // API 答复「同名」（含大小写差异）= 未改名，同样是定论，不用网页来源去推翻它
  assert.equal(await probeRepositoryRename(OLD_REPO, head, async () => OLD_REPO), null);
  assert.equal(await probeRepositoryRename(OLD_REPO, head, async () => OLD_REPO.toUpperCase()), null);
  assert.equal(webCalls, 0);
  // API 失败（限流/不可达/404）或答复不是合法仓库名：落到网页来源
  assert.equal(await probeRepositoryRename(OLD_REPO, head, offlineLookup), "ByteRax/from-web");
  assert.equal(await probeRepositoryRename(OLD_REPO, head, async () => null), "ByteRax/from-web");
  assert.equal(await probeRepositoryRename(OLD_REPO, head, async () => "not a repository"), "ByteRax/from-web");
  assert.equal(webCalls, 3);
  // 两个来源都失败：null，由调用方原样报错
  assert.equal(await probeRepositoryRename(OLD_REPO, offlineHead, offlineLookup), null);
});
test("rename probe asks the API about the registered name first, then the web page of that same name", async () => {
  const seen = [];
  const lookup = async (repo) => { seen.push(["lookup", repo]); throw new Error("api offline"); };
  const head = async (url) => { seen.push(["head", url]); return { status: 301, location: `https://github.com/${NEW_REPO}` }; };
  assert.equal(await probeRepositoryRename(OLD_REPO, head, lookup), NEW_REPO);
  assert.deepEqual(seen, [["lookup", OLD_REPO], ["head", `https://github.com/${OLD_REPO}`]]);
});
test("web leg accepts exactly the redirect statuses and resolves a relative Location against github.com", async () => {
  const web = (status, location) => probeRepositoryRename(OLD_REPO, async () => ({ status, location }), offlineLookup);
  for (const status of [301, 302, 303, 307, 308]) assert.equal(await web(status, `https://github.com/${NEW_REPO}`), NEW_REPO, String(status));
  for (const status of [200, 204, 300, 304, 305, 306, 400, 404, 500]) assert.equal(await web(status, `https://github.com/${NEW_REPO}`), null, String(status));
  assert.equal(await web(301, `/${NEW_REPO}`), NEW_REPO);
});
test("web leg only accepts github.com itself, never look-alike or sibling hosts", async () => {
  const web = (location) => probeRepositoryRename(OLD_REPO, async () => ({ status: 301, location }), offlineLookup);
  assert.equal(await web(`https://github.com/${NEW_REPO}`), NEW_REPO);
  for (const host of ["notgithub.com", "github.com.evil.example", "api.github.com", "gist.github.com", "www.github.com", "github.community"]) {
    assert.equal(await web(`https://${host}/${NEW_REPO}`), null, host);
  }
});
test("rename probe refuses non-string or non-canonical repositories without touching either source", async () => {
  let touched = 0;
  const head = async () => { touched++; return { status: 301, location: "https://github.com/a/b" }; };
  const lookup = async () => { touched++; return "a/b"; };
  for (const bad of [null, undefined, 42, {}, "", "no-slash", "https://github.com/a/b", "a/b.git"]) {
    assert.equal(await probeRepositoryRename(bad, head, lookup), null, String(bad));
  }
  assert.equal(touched, 0);
});
/* 默认实现（不注入 head/lookup）经 mock 的 https 层覆盖：API 腿只放行 api.github.com 并校验仓库对象形状；
   网页腿走 https.request，超时要销毁请求，守卫定时器必须清理且 unref。mockHttps 只替换 https.get。 */
function mockHead(t, plans) {
  const seen = { calls: 0, destroyed: 0, resumed: 0, timeouts: [], urls: [] };
  t.mock.method(https, "request", (url, options, callback) => {
    const plan = plans[Math.min(seen.calls++, plans.length - 1)];
    seen.timeouts.push(options.timeout); seen.urls.push(String(url));
    if (plan.throwSync) throw new Error("fixture: https.request threw synchronously");
    assert.equal(options.method, "HEAD");
    assert.equal(options.headers["User-Agent"], "zcode-token-usage-statusbar-release-updater");
    const request = new EventEmitter();
    request.destroy = (error) => { seen.destroyed++; if (error) queueMicrotask(() => request.emit("error", error)); return request; };
    request.end = () => queueMicrotask(() => {
      if (plan.hang) return;   // 既不响应也不触发 timeout：只有 10s 总守卫能结算
      if (plan.timeout) { request.emit("timeout"); return; }
      if (plan.error) { request.emit("error", plan.error); return; }
      const response = new EventEmitter();
      response.statusCode = plan.status; response.headers = plan.headers || {}; response.resume = () => { seen.resumed++; };
      callback(response);
    });
    return request;
  });
  return seen;
}
test("the 10s guard settles a hanging web-leg request and destroys it", async (t) => {
  const realSet = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (fn, ms, ...rest) => realSet(fn, ms === 10000 ? 1 : ms, ...rest));   // 把 10s 守卫压到 1ms
  mockHttps(t, [{ status: 404 }]);
  const head = mockHead(t, [{ hang: true }]);
  assert.equal(await probeRepositoryRename(OLD_REPO), null);
  assert.ok(head.destroyed >= 1, "守卫触发后必须销毁挂起的请求");
});
const repoBody = (over = {}) => Buffer.from(JSON.stringify({ id: 42, name: "zcode-speed-bar", full_name: NEW_REPO,
  owner: { login: "ByteRax" }, ...over }));
test("default rename lookup follows api.github.com's 301 and accepts a self-consistent repository object", async (t) => {
  const head = mockHead(t, [{ status: 404 }]);
  const calls = mockHttps(t, [
    { status: 301, headers: { location: "https://api.github.com/repositories/42" } },
    { chunks: [repoBody()] }]);
  assert.equal(await probeRepositoryRename(OLD_REPO), NEW_REPO);
  assert.deepEqual(calls, [`https://api.github.com/repos/${OLD_REPO}`, "https://api.github.com/repositories/42"]);
  assert.equal(head.calls, 0);   // API 给出定论，不碰网页主机
});
test("default rename lookup rejects forged or shapeless answers and falls back to the web leg", async (t) => {
  const forged = {
    shapeless: { full_name: "evil/pkg" },
    "message plus full_name": { message: "Not Found", full_name: "evil/pkg" },
    "full_name disagrees with owner/name": { id: 7, name: "pkg", full_name: "evil/pkg", owner: { login: "ByteRax" } },
    "non-integer id": { id: "7", name: "zcode-speed-bar", full_name: NEW_REPO, owner: { login: "ByteRax" } },
    "missing owner": { id: 7, name: "zcode-speed-bar", full_name: NEW_REPO },
    "fractional id": { id: 7.5, name: "zcode-speed-bar", full_name: NEW_REPO, owner: { login: "ByteRax" } },
    // 以下两例的 full_name 与「owner/name 拼接」自洽：只有 login/name 的 typeof 校验能拦下它们
    "non-string login": { id: 7, name: "zcode-speed-bar", full_name: "123/zcode-speed-bar", owner: { login: 123 } },
    "non-string name": { id: 7, name: 456, full_name: "ByteRax/456", owner: { login: "ByteRax" } },
  };
  for (const [label, body] of Object.entries(forged)) {
    await t.test(label, async (st) => {
      const head = mockHead(st, [{ status: 404 }]);
      mockHttps(st, [{ chunks: [Buffer.from(JSON.stringify(body))] }]);
      assert.equal(await probeRepositoryRename(OLD_REPO), null);
      assert.equal(head.calls, 1);   // API 答复被拒 → 落到网页腿（这里 404 → null）
    });
  }
});
test("default rename lookup treats an oversized answer as an API failure", async (t) => {
  const head = mockHead(t, [{ status: 404 }]);
  // 合法的仓库对象 + 超过 MAX_JSON 的填充：若上限失效，它会被接受并返回 NEW_REPO，而不是落到 null
  mockHttps(t, [{ chunks: [repoBody({ pad: "x".repeat(MAX_JSON) })] }]);
  assert.equal(await probeRepositoryRename(OLD_REPO), null);
  assert.equal(head.calls, 1);
});
test("default rename lookup accepts an answer of exactly MAX_JSON bytes and refuses one byte more", async (t) => {
  const sized = (delta) => {
    const base = JSON.stringify({ id: 42, name: "zcode-speed-bar", full_name: NEW_REPO, owner: { login: "ByteRax" }, pad: "" }).length;
    return Buffer.from(JSON.stringify({ id: 42, name: "zcode-speed-bar", full_name: NEW_REPO, owner: { login: "ByteRax" },
      pad: "x".repeat(MAX_JSON - base + delta) }));
  };
  assert.equal(sized(0).length, MAX_JSON);
  await t.test("exactly MAX_JSON bytes", async (st) => {
    mockHead(st, [{ status: 404 }]);
    mockHttps(st, [{ chunks: [sized(0)] }]);
    assert.equal(await probeRepositoryRename(OLD_REPO), NEW_REPO);
  });
  await t.test("MAX_JSON + 1 bytes", async (st) => {
    const head = mockHead(st, [{ status: 404 }]);
    mockHttps(st, [{ chunks: [sized(1)] }]);
    assert.equal(await probeRepositoryRename(OLD_REPO), null);
    assert.equal(head.calls, 1);
  });
});
test("default rename lookup accepts a case-only difference between full_name and owner/name and returns full_name as served", async (t) => {
  mockHead(t, [{ status: 404 }]);
  mockHttps(t, [{ chunks: [repoBody({ owner: { login: "byterax" }, name: "ZCODE-SPEED-BAR" })] }]);   // full_name 仍是 NEW_REPO
  assert.equal(await probeRepositoryRename(OLD_REPO), NEW_REPO);
});
test("default rename lookup follows a redirect only within api.github.com", async (t) => {
  for (const host of ["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com",
    "gitcode.com", "file-cdn.gitcode.com", "api.gitcode.com", "evil.example"]) {
    await t.test(host, async (st) => {
      const head = mockHead(st, [{ status: 404 }]);
      const calls = mockHttps(st, [{ status: 301, headers: { location: `https://${host}/x` } }]);
      assert.equal(await probeRepositoryRename(OLD_REPO), null);
      assert.deepEqual(calls, [`https://api.github.com/repos/${OLD_REPO}`]);   // 没有第二跳请求
      assert.equal(head.calls, 1);
    });
  }
});
/* 网页腿的结算路径：守卫推到 10 分钟，只剩各自的事件能让 promise 结算——3 秒内不结算即视为挂起。 */
const settleWithin = (promise, ms) => Promise.race([promise, new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`probe did not settle within ${ms}ms`)), ms);
  if (typeof timer.unref === "function") timer.unref();
})]);
function pushGuardOut(t) {
  const realSet = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (fn, ms, ...rest) => realSet(fn, ms === 10000 ? 600000 : ms, ...rest));
}
test("a socket timeout settles the web leg by itself, long before the 10s guard", async (t) => {
  pushGuardOut(t);
  mockHttps(t, [{ status: 404 }]);
  const head = mockHead(t, [{ timeout: true }]);
  assert.equal(await settleWithin(probeRepositoryRename(OLD_REPO), 3000), null);
  assert.ok(head.destroyed >= 1);
});
test("a request-level error settles the web leg", async (t) => {
  pushGuardOut(t);
  mockHttps(t, [{ status: 404 }]);
  mockHead(t, [{ error: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) }]);
  assert.equal(await settleWithin(probeRepositoryRename(OLD_REPO), 3000), null);
});
test("a synchronous throw from https.request settles the web leg", async (t) => {
  pushGuardOut(t);
  mockHttps(t, [{ status: 404 }]);
  mockHead(t, [{ throwSync: true }]);
  assert.equal(await settleWithin(probeRepositoryRename(OLD_REPO), 3000), null);
});
test("default web leg ignores a non-redirect status even when it carries a Location header", async (t) => {
  mockHttps(t, [{ status: 404 }]);
  mockHead(t, [{ status: 200, headers: { location: `https://github.com/${NEW_REPO}` } }]);
  assert.equal(await probeRepositoryRename(OLD_REPO), null);
});
test("default web leg resolves a 301; a socket timeout destroys the request; the guard timer is always cleared and unref'd", async (t) => {
  const timers = [], cleared = [];
  const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
  t.mock.method(globalThis, "setTimeout", (fn, ms, ...rest) => { const timer = realSet(fn, ms, ...rest); if (ms === 10000) timers.push(timer); return timer; });
  t.mock.method(globalThis, "clearTimeout", (timer) => { cleared.push(timer); return realClear(timer); });
  await t.test("301 Location", async (st) => {
    mockHttps(st, [{ status: 404 }]);
    const head = mockHead(st, [{ status: 301, headers: { location: `https://github.com/${NEW_REPO}` } }]);
    assert.equal(await probeRepositoryRename(OLD_REPO), NEW_REPO);
    assert.equal(head.destroyed, 0);
    assert.deepEqual(head.urls, [`https://github.com/${OLD_REPO}`]);   // 探测的是注册名自己的网页
    assert.ok(head.timeouts.every((ms) => ms > 0 && ms < 10000), "socket 空闲超时必须设置且短于 10s 总守卫");
    assert.equal(head.resumed, 1, "响应体必须被消费，socket 才能归还");
  });
  await t.test("socket timeout", async (st) => {
    mockHttps(st, [{ status: 404 }]);
    const head = mockHead(st, [{ timeout: true }]);
    assert.equal(await probeRepositoryRename(OLD_REPO), null);
    assert.ok(head.destroyed >= 1, "超时必须销毁请求");
  });
  assert.equal(timers.length, 2);
  for (const timer of timers) {
    assert.ok(cleared.includes(timer), "守卫定时器必须在结算后清理");
    assert.equal(timer.hasRef(), false, "守卫定时器必须 unref，防止挂起事件循环");
  }
});
