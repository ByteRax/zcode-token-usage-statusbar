// 模型拉取渲染端纯函数回归（v130）：按仓库切片测试纪律（sessionFor 先例）从 overlay.js
// 源码按字节切出 mEsc / mpMetaParts 在沙箱执行。XSS 转义与元数据格式是弹窗 innerHTML
// 拼接的最后一道闸，锁在这里；切片与生产同源，函数体内的 L() 用同款真值链提供。
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("vm");
const fs = require("fs");
const path = require("path");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "overlay.js"), "utf8");

function sliceFunction(name) {
  const marker = "function " + name + "(";
  const start = SOURCE.indexOf(marker);
  assert.ok(start > 0, "source slice not found: " + name);
  const end = SOURCE.indexOf("\n    }", start);   // 函数体内部缩进 ≥6 空格，4 空格 } 即函数收尾
  assert.ok(end > start, "slice end not found: " + name);
  return SOURCE.slice(start, end + 6);
}

function sliceNamed(name) {   // 与 sliceFunction 同款；用于多入口定位（matchProviderByBaseUrl 等纯函数）
  return sliceFunction(name);
}

function loadMpHelpers(lang) {
  const sandbox = vm.createContext({});
  // L 与生产同构：闭包引用 state（overlay.js 顶部原样），不依赖调用接收者
  const code = "var state = { lang: " + JSON.stringify(lang === "en" ? "en" : "zh") + " };\n" +
    "function L(zh, en) { return state.lang === 'en' ? en : zh; }\n" +
    sliceFunction("mEsc") + "\n" + sliceFunction("mpMetaParts") +
    "\nthis.__mp = { mEsc: mEsc, mpMetaParts: mpMetaParts };";
  vm.runInContext(code, sandbox);
  return sandbox.__mp;
}

test("mEsc escapes all HTML-sensitive characters", () => {
  const mp = loadMpHelpers("zh");
  assert.equal(mp.mEsc('<img src=x onerror="a&b\'">'), "&lt;img src=x onerror=&quot;a&amp;b&#39;&quot;&gt;");
  assert.equal(mp.mEsc(null), "");
  assert.equal(mp.mEsc(42), "42");
  assert.equal(mp.mEsc("plain-id.v1"), "plain-id.v1");
});

test("mpMetaParts: ctx/out visible, reasoning in title, empty yields null", () => {
  const mp = loadMpHelpers("zh");
  assert.deepEqual(mp.mpMetaParts(null), null);
  assert.deepEqual(mp.mpMetaParts({}), null);
  const full = mp.mpMetaParts({ contextWindow: 262144, maxOutputTokens: 32000, efforts: ["off", "high"] });
  assert.equal(full.visible, "上下文 262k · 输出 32k");
  assert.equal(full.title, "ctx 262k · out 32k · 思考档位 off/high");
  const onlyEfforts = mp.mpMetaParts({ efforts: ["low"] });
  assert.equal(onlyEfforts.visible, "");
  assert.equal(onlyEfforts.title, "思考档位 low");
  const mBand = mp.mpMetaParts({ contextWindow: 1048576 });
  assert.equal(mBand.visible, "上下文 1M");
  assert.equal(mBand.title, "ctx 1M");
});

test("mpMetaParts: english wording follows lang", () => {
  const mp = loadMpHelpers("en");
  const full = mp.mpMetaParts({ contextWindow: 262144, maxOutputTokens: 32000 });
  assert.equal(full.visible, "ctx 262k · out 32k");
  assert.equal(full.title, "ctx 262k · out 32k");
});

/* ---------- v132 宿主设置页挂载契约 ---------- */

test("matchProviderByBaseUrl: normalizes trailing slash/case, unique hit only", () => {
  const start = SOURCE.indexOf("function matchProviderByBaseUrl(");
  const end = SOURCE.indexOf("\n    }", start);
  const code = SOURCE.slice(start, end + 6) + "\nthis.f = matchProviderByBaseUrl;";
  const sb = vm.createContext({});
  vm.runInContext(code, sb);
  const f = sb.f;
  const providers = [
    { id: "a", baseUrl: "https://bxai.333122.xyz" },
    { id: "b", baseUrl: "https://api.other.com/v1" },
  ];
  assert.equal(f(providers, "https://bxai.333122.xyz/").id, "a");   // 尾斜杠归一
  assert.equal(f(providers, "HTTPS://BXAI.333122.XYZ").id, "a");   // 大小写归一
  assert.equal(f(providers, "https://api.other.com/v1").id, "b");
  assert.equal(f(providers, "https://unknown.io"), null);   // 未命中
  assert.equal(f(providers, ""), null);
  assert.equal(f(providers, "https://bxai.333122.xyz") && null, null);
  // 双命中（同 baseUrl 两供应商）拒绝：归属歧义交由选择列表
  const dup = [{ id: "x", baseUrl: "https://d.io" }, { id: "y", baseUrl: "https://d.io/" }];
  assert.equal(f(dup, "https://d.io"), null);
});

test("host mount contract: anchor testid, left-insert, secondary look, currentColor icon, cleanup", () => {
  assert.match(SOURCE, /MP_HOST_ANCHOR = '\[data-testid="model-provider-add-model-button"\]'/);
  assert.match(SOURCE, /wrap\.insertBefore\(mine, btn\)/);   // 「添加模型」左侧
  assert.match(SOURCE, /disabled:opacity-50 ml-auto/);   // 锚容器 justify-between：ml-auto 吃掉剩余空间贴紧右侧按钮，不被均匀分布到行中
  assert.match(SOURCE, /zu-mp-host group\/host inline-flex shrink-0 items-center justify-center/);
  assert.match(SOURCE, /bg-secondary text-foreground hover:bg-secondary\/80/);   // 原生 secondary 视格
  assert.match(SOURCE, /stroke="currentColor"[^>]*aria-hidden="true"[^>]*><path d="M4\.9 19\.1C1 15\.2 1 8\.8 4\.9 4\.9"/);   // ⚡ 图标 currentColor
  assert.match(SOURCE, /\.zusage-git-tip,\.zusage-panel,\.zu-mp-host,\.zu-mp-ov,\[data-zusage-deterministic\]/);   // 热更自清含宿主按钮与弹窗遮罩
  assert.match(SOURCE, /enhanceModelPuller\(\);   \/\/ v132：宿主设置页「拉取模型」按钮 reapply/);
  assert.match(SOURCE, /enhanceModelPuller\(\);   \/\/ v132：宿主设置页按钮 DOM 对账点/);
  assert.match(SOURCE, /if \(inactive\(\)\) \{ restoreModelPuller\(\); return; \}   \/\/ 热更后旧实例闭包不得再开弹窗/);
  // 锚 testid 全局唯一：内置/套餐页不挂按钮（选中的不是 custom 供应商即 restore）
  assert.match(SOURCE, /if \(!detectSelectedCustomProviderId\(\)\) \{ restoreModelPuller\(\); return; \}/);
  assert.match(SOURCE, /\.zu-mp-actions \.zu-mp-ok\{color:var\(--color-primary-foreground,#fff\);background:var\(--color-primary,#3B82F6\)/);   // 宿主原生 primary 令牌（default variant：bg-primary/text-primary-foreground）
  // 按钮 loading：拉取中切文本「拉取中…」+ 图标旋转（原透明度脉冲无感知）
  assert.match(SOURCE, /function setMpHostBusy\(btn, busy\)/);
  assert.match(SOURCE, /btn\.lastChild\.nodeValue = L\("拉取中…", "Pulling…"\)/);
  assert.match(SOURCE, /\.zu-mp-host\[aria-busy=true\] svg\{animation:zumpspin/);
  // loading 覆盖全程：list 回调不解除，fetch 回调（弹窗出现/失败）才解除
  assert.match(SOURCE, /if \(provider\) startMpHostFetch\(provider, self\);   \/\/ busy 延续到 fetch 回调/);
  assert.match(SOURCE, /cleanupMpModal\(\);   \/\/ 写回完成：宿主模型列表数秒内自动刷新/);
  // 弹窗主题自适应（HHQ 形态）：自带 .zu-light 随 <html>.dark 换装（openMpShell 同步 + applyTheme 实时挂钩）
  assert.match(SOURCE, /ov\.classList\.toggle\("zu-light", !themeDark\)/);
  assert.match(SOURCE, /if \(mpModalThemeSync\) mpModalThemeSync\(!themeDark\)/);
  assert.match(SOURCE, /\.zu-mp-ov\{position:fixed;inset:0;background:rgba\(0,0,0,\.45\);z-index:2147483647/);   // 遮罩全屏定位（重写丢失曾致弹窗不可见）
  assert.match(SOURCE, /\.zu-mp-modal\{position:relative/);
  assert.match(SOURCE, /\.zu-mp-ov\.zu-light \.zu-mp-modal\{color:#1e293b/);
  assert.match(SOURCE, /\.zu-mp-ov\.zu-light \.zu-mp-badge\.zu-mp-new\{color:#059669/);   // 新模型徽标浅色 emerald-600
  assert.match(SOURCE, /确认添加并保存/);   // 确认钮文案（样式断言见 103 行 primary 令牌）
  assert.match(SOURCE, /选择要同步的模型 \(共/);   // HHQ 同款标题统计
  assert.match(SOURCE, /已选中 " \+ n \+ " \/ " \+ models\.length \+ " 个模型/);
  assert.match(SOURCE, /确认添加并保存/);
  // 供应商归属主判定=当前选择的供应商（宿主源码定案：custom 项 nodeKey=custom:<providerId>，选中 data-state=selected）
  assert.match(SOURCE, /function detectSelectedCustomProviderId\(\)/);
  assert.match(SOURCE, /\[data-testid\^="model-provider-nav-item-"\]\[data-state="selected"\]/);
  assert.match(SOURCE, /\^model-provider-nav-item-custom:\(\.\+\)\$/);
  assert.match(SOURCE, /function matchProviderById\(providers, providerId\)/);
  assert.match(SOURCE, /matchProviderById\(providers, detectSelectedCustomProviderId\(\)\)/);   // 主判定先于 Base URL 兜底
  assert.match(SOURCE, /\[data-testid="model-provider-base-url-input"\]/);   // Base URL 专用 testid 优先于启发式
  assert.doesNotMatch(SOURCE, /data-sec="models"/);   // ⚙ 分区已撤
  assert.doesNotMatch(SOURCE, /function (?:ensureMpProviders|syncMpList|startMpFetch)\b/);   // 旧列表逻辑仅存于台账注释
  assert.doesNotMatch(SOURCE, /ensureMpProviders\(\)|syncMpList\(\)|startMpFetch\(/);
});
