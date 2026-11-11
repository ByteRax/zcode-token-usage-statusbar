// 模型拉取渲染端纯函数回归（v130）：按仓库切片测试纪律（sessionFor 先例）从 overlay.js
// 源码按字节切出 mEsc / mpMetaParts 在沙箱执行。XSS 转义与元数据格式是弹窗 innerHTML
// 拼接的最后一道闸，锁在这里；切片与生产同源，函数体内的 L() 用同款真值链提供。
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("vm");
const { readOverlaySource, sliceOverlay } = require("./helpers/overlay-extract.cjs");

const SOURCE = readOverlaySource();

function sliceFunction(name) {
  return sliceOverlay("function " + name + "(", "\n    }", { includeEnd: true });
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

test("mpMetaParts: ctx/out visible, reasoning in title; missing meta yields neutral hint (#236)", () => {
  const mp = loadMpHelpers("zh");
  const hint = mp.mpMetaParts(null);
  assert.equal(hint.visible, "未获取配置");   // #236：无元数据不再静默，中性提示不报红
  assert.ok(hint.title.indexOf("默认") >= 0);
  assert.equal(mp.mpMetaParts({}).visible, "未获取配置");   // 空元数据同款（无任何证据）
  const fetching = mp.mpMetaParts(null, true);   // #236：目录后台补拉中给「档位补拉中」状态
  assert.equal(fetching.visible, "档位补拉中…");
  assert.ok(fetching.title.indexOf("重新拉取") >= 0);
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
  assert.equal(mp.mpMetaParts(null).visible, "no config fetched");   // #236 中性提示双语
  assert.equal(mp.mpMetaParts(null, true).visible, "efforts pulling…");   // 补拉中状态双语
});

/* ---------- #236 弹窗披露 ---------- */

test("model pull modal discloses append-only and default-keep semantics (#236)", () => {
  assert.match(SOURCE, /仅新增写入/);
  assert.match(SOURCE, /不会被覆盖/);
  assert.match(SOURCE, /保持 ZCode 默认值/);
  assert.match(SOURCE, /class="zu-mp-note"/);   // 脚注复用中性提示样式（不改 CSS）
  assert.match(SOURCE, /档位目录正在后台补拉/);   // 目录补拉状态脚注（#236 缓存与进度）
  assert.match(SOURCE, /effortsFetching/);   // 状态标志从 fetch 回调透传进弹窗
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
  assert.match(SOURCE, /if \(!detectSelectedCustomProviderId\(btn\)\) \{ restoreModelPuller\(\); return; \}/);
  assert.match(SOURCE, /\.zu-mp-actions \.zu-mp-ok\{color:var\(--color-primary-foreground,#fff\);background:var\(--color-primary,#3B82F6\)/);   // 宿主原生 primary 令牌（default variant：bg-primary/text-primary-foreground）
  // 按钮 loading：拉取中切文本「拉取中…」+ 图标旋转（原透明度脉冲无感知）
  assert.match(SOURCE, /function setMpHostBusy\(btn, busy\)/);
  assert.match(SOURCE, /btn\.lastChild\.nodeValue = L\("拉取中…", "Pulling…"\)/);
  assert.match(SOURCE, /\.zu-mp-host\[aria-busy=true\] svg\{animation:zumpspin/);
  // loading 覆盖全程：list 回调不解除，fetch 回调（弹窗出现/失败）才解除
  assert.match(SOURCE, /if \(pick\.provider\) startMpHostFetch\(pick\.provider, self\);   \/\/ busy 延续到 fetch 回调/);
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
  assert.match(SOURCE, /function detectSelectedCustomProviderId\(anchor\)/);   // 接收锚按钮：共享 nodeKey 页按详情内容（付费卡文案）区分归属
  assert.match(SOURCE, /indexOf\("GLM Coding Max"\) >= 0/);
  assert.match(SOURCE, /account:bigmodel-individual-coding-plan" : ""/);   // 纯 Start Plan 页返回空（不显示按钮）
  assert.match(SOURCE, /\[data-testid\^="model-provider-nav-item-"\]\[data-state="selected"\]/);
  assert.ok(SOURCE.indexOf('^custom:(.+)$/.exec(nodeKey)') >= 0);   // nodeKey 已剥 testid 前缀（源码字面量断言，避免转义歧义）
  assert.match(SOURCE, /function matchProviderById\(providers, providerId\)/);
  assert.match(SOURCE, /askMpList\(self, false, detectSelectedCustomProviderId\(self\)\);/);   // 点击时同步采样选中项；选择规则的行为断言见文件尾
  assert.match(SOURCE, /\[data-testid="model-provider-base-url-input"\]/);   // Base URL 专用 testid 优先于启发式
  assert.doesNotMatch(SOURCE, /data-sec="models"/);   // ⚙ 分区已撤
  assert.doesNotMatch(SOURCE, /function (?:ensureMpProviders|syncMpList|startMpFetch)\b/);   // 旧列表逻辑仅存于台账注释
  assert.doesNotMatch(SOURCE, /ensureMpProviders\(\)|syncMpList\(\)|startMpFetch\(/);
});

/* ---------- v309 确认前自动探测 ---------- */

test("confirm flow probes picked models first; all-pass saves, failures uncheck and keep dialog", () => {
  assert.match(SOURCE, /MP_TEST_MAX = 24, MP_TEST_CONC = 4/);   // 上限防全选大列表阻塞；并发 4
  assert.match(SOURCE, /mpAsk\("model-pull-probe", \{ providerId: provider\.id, model: m, caps: true \}/);   // 逐模型探测
  assert.match(SOURCE, /function mpProbeThenApply\(/);
  assert.match(SOURCE, /function mpApply\(/);
  assert.match(SOURCE, /if \(!failed\.length && !repairs\.length && !toolHistoryWarned\) \{ mpApply\(picked\); return; \}/);   // 无需确认的全过路径自动写入
  assert.match(SOURCE, /sel\[failed\[j\]\] = false;/);   // 失败自动取消勾选
  assert.match(SOURCE, /重新勾选可强制添加/);   // 可强制添加的出路保留
  assert.match(SOURCE, /indexOf\("unknown action"\) === 0/);   // 旧主进程降级为直接保存
  assert.match(SOURCE, /已跳过自动检测/);
  assert.match(SOURCE, /zu-mp-tst-run/);
  assert.match(SOURCE, /zu-mp-tst-ok/);
  assert.match(SOURCE, /zu-mp-tst-fail/);
  assert.match(SOURCE, /picked\.length > MP_TEST_MAX/);   // 超限不阻塞：直接保存
  assert.match(SOURCE, /if \(inactive\(\) \|\| mpModal !== ov\) \{ closed = true; return; \}/);   // 弹窗关闭后不再起下一轮
});

test("probe chip styles ship in both themes", () => {
  assert.match(SOURCE, /\.zu-mp-tst\{flex:0 0 auto;position:relative;display:inline-flex/);
  assert.match(SOURCE, /\.zu-mp-tst\.zu-mp-tst-fail\{color:#f87171/);
  assert.match(SOURCE, /\.zu-mp-ov\.zu-light \.zu-mp-tst\.zu-mp-tst-ok\{color:#059669/);
  assert.match(SOURCE, /\.zu-mp-ov\.zu-light \.zu-mp-tst\.zu-mp-tst-fail\{color:#dc2626/);
});

test("mpProbeFailText: path kind carries the actual requested URL and /v1 hint; bilingual", () => {
  function loadText(lang) {
    const sandbox = vm.createContext({});
    const code = "var state = { lang: " + JSON.stringify(lang) + " };\n" +
      "function L(zh, en) { return state.lang === 'en' ? en : zh; }\n" +
      sliceFunction("mpProbeFailText") + "\nthis.__t = mpProbeFailText;";
    vm.runInContext(code, sandbox);
    return sandbox.__t;
  }
  const zh = loadText("zh");
  const path405 = zh({ kind: "path", status: 405, url: "https://relay.example.com/chat/completions", snippet: "<html>405</html>" });
  assert.ok(path405.indexOf("路径不匹配（HTTP 405）") >= 0);
  assert.ok(path405.indexOf("宿主实际请求 https://relay.example.com/chat/completions") >= 0);   // 实际请求 URL 是本功能诊断价值核心
  assert.ok(path405.indexOf("/v1") >= 0);   // OpenAI 兼容需 /v1 结尾的修复指引
  assert.ok(path405.indexOf("Anthropic 协议由客户端自动补 /v1") >= 0);   // anthropic 型补 /v1 是宿主行为，不能误导用户去手写
  const auth = zh({ kind: "auth", status: 401, snippet: "Invalid token sk-***" });
  assert.ok(auth.indexOf("鉴权失败") >= 0 && auth.indexOf("HTTP 401") >= 0);
  assert.ok(zh({ kind: "timeout" }).indexOf("15 秒") >= 0);
  assert.ok(zh({ kind: "http", status: 418 }).indexOf("HTTP 418") >= 0);
  const en = loadText("en");
  assert.ok(en({ kind: "path", status: 404, url: "https://x/v1/chat/completions" }).indexOf("actually requests https://x/v1/chat/completions") >= 0);
  assert.ok(en({ kind: "auth", status: 403 }).indexOf("API key invalid") >= 0);
});

/* ---------- v310 失败原因 data-tip 气泡（原生 title 宿主不弹）+ 路径错配自动修复披露 ---------- */

test("probe chip reason rides data-tip bubble, not native title (v307 precedent)", () => {
  assert.match(SOURCE, /node\.setAttribute\("data-tip", tip\)/);
  assert.match(SOURCE, /node\.removeAttribute\("data-tip"\)/);
  assert.match(SOURCE, /node\.setAttribute\("aria-label", text \+ " " \+ tip\)/);   // 伪元素不进可访问树（v307 同款补偿）
  assert.doesNotMatch(SOURCE, /node\.setAttribute\("title"/);   // title 形态不得回潮
  assert.match(SOURCE, /\.zu-mp-tst\[data-tip\]\:hover\:\:after\{content:attr\(data-tip\)/);   // 气泡规则
  assert.match(SOURCE, /right:calc\(100% \+ 8px\);transform:translateY\(-50%\)/);   // 左侧水平弹出避开 overflow:auto 裁剪
  assert.match(SOURCE, /white-space:pre-line/);   // 多行原因（URL+摘录）
  assert.match(SOURCE, /\.zu-mp-ov\.zu-light \.zu-mp-tst\[data-tip\]\:hover\:\:after\{background:#fff/);   // 浅色气泡
  assert.match(SOURCE, /position:relative;display:inline-flex/);   // chip 自身是气泡锚点
});

test("path mismatch auto-repair is disclosed in green and config writes stay visible", () => {
  assert.match(SOURCE, /zu-mp-fix/);   // 修复披露节点（绿字，与红字失败区并排）
  assert.match(SOURCE, /已自动匹配配置（已有模型已写入，新模型保存时写入）/);   // v312 起披露句头泛化（修复 + 能力匹配）
  assert.match(SOURCE, /Base URL " \+ result\.repaired\.from \+ " → " \+ result\.repaired\.to/);   // URL 修复项
  assert.match(SOURCE, /思考档位 → /);   // 档位写实披露项（effortFixed）
  assert.match(SOURCE, /result\.effortFixed\.values\.join\("\/"\)/);   // 档位表以 / 连接进披露
  assert.match(SOURCE, /kind === "reasoning"/);   // 档位修复不成给专属失败文案（含上游接受集）
  assert.match(SOURCE, /思考档位被上游拒绝/);
  assert.match(SOURCE, /result\.repaired\.from && result\.repaired\.to/);   // repaired 去重入披露
  assert.match(SOURCE, /已尝试自动修复（候选也失败）/);   // 修复候选失败也在失败原因里披露
  assert.match(SOURCE, /}, 90000\)/);   // 探测 ask 兜底放宽：探测+修复+重试+能力实测最坏约 70s（v312）
  assert.match(SOURCE, /zu-mp-fix:empty\{display:none\}/);   // 空披露不占位
});

/* ---------- v312 输入类型/模型能力自动匹配 ---------- */

test("capability match rides the confirm probe and is disclosed; meta shows badges", () => {
  assert.match(SOURCE, /model: m, caps: true/);   // 确认流显式携带能力实测标志
  assert.match(SOURCE, /result\.capabilitiesFixed/);
  assert.match(SOURCE, /能力匹配：/);
  assert.match(SOURCE, /已自动匹配配置（已有模型已写入，新模型保存时写入）/);   // 披露句头从「修复」泛化为「匹配」（v312）
  assert.match(SOURCE, /}, 90000\)/);   // 探测+修复+重试+能力实测最坏约 70s，兜底 90s
  assert.match(SOURCE, /zu-sv-left \.zu-sl-model\[data-tip\]|zu-mp-tst\[data-tip\]/);   // data-tip 气泡契约仍在
  assert.match(SOURCE, /caps\.push\(L\("图", "img"\)\)/);   // 行内徽标：图/PDF/JSON
  assert.match(SOURCE, /caps\.push\("PDF"\)/);
  assert.match(SOURCE, /caps\.push\("JSON"\)/);
});

test("mpMetaParts appends capability badges after ctx/out (existing copy unchanged)", () => {
  const mp = loadMpHelpers("zh");
  const plain = mp.mpMetaParts({ contextWindow: 1048576, maxOutputTokens: 65536 });
  assert.equal(plain.visible, "上下文 1M · 输出 66k");   // 无能力证据时与 v309 完全同形
  const full = mp.mpMetaParts({ contextWindow: 1048576, inputFormat: { supportsImage: true, supportsPdf: true }, supportsJsonSchemaOutput: true });
  assert.ok(full.visible.indexOf("上下文 1M") === 0);
  assert.ok(full.visible.indexOf("图·PDF·JSON") > 0);
  assert.ok(full.title.indexOf("图/PDF/JSON") > 0);
  const en = loadMpHelpers("en");
  const enFull = en.mpMetaParts({ inputFormat: { supportsImage: true }, supportsJsonSchemaOutput: true });
  assert.ok(enFull.visible.indexOf("img·JSON") >= 0);
});

/* ---------- v313 工具历史通道缺陷琥珀警告 ---------- */

test("tool-history channel defect warns amber without failing the probe", () => {
  assert.match(SOURCE, /zu-mp-warn/);
  assert.match(SOURCE, /zu-mp-warn:empty\{display:none\}/);
  assert.match(SOURCE, /toolHistoryWarned/);
  assert.match(SOURCE, /该模型通道拒绝了测试用工具调用历史/);   // 警告限于已观测的测试结果，不推广厂商或其它通道
  assert.match(SOURCE, /result\.warnings && result\.warnings\.indexOf\("toolHistory"\) >= 0/);
  assert.match(SOURCE, /\.zu-mp-ov\.zu-light \.zu-mp-warn\{color:#b45309\}/);   // 浅色琥珀
});

/* ---------- v314 规格补全披露 ---------- */

test("spec backfill is disclosed with per-key labels", () => {
  assert.match(SOURCE, /specEnriched/);
  assert.match(SOURCE, /规格补全：/);
  assert.match(SOURCE, /specSeen\[result\.specEnriched\[sk\]\] = 1/);
});


/* ---------- 供应商选择与列表重问（v330）----------
 * 套餐源（account:*）的 token 要用系统钥匙串里的密钥解密，密钥异步到位，「列出供应商」可能
 * 暂时不含它。选中的是套餐源而列表里没有它时：稍等重问一次，仍没有就提示凭据暂不可用——
 * 不得落到「只有一个供应商就用它」的兜底，那会把拉取请求改投到用户的另一个供应商。 */
const PLAN = { id: "account:bigmodel-individual-coding-plan", name: "BigModel Coding Plan", baseUrl: "https://open.bigmodel.cn/api/anthropic" };
const RELAY = { id: "my-relay", name: "My Relay", baseUrl: "https://relay.example.com/v1" };
const OTHER = { id: "other", name: "Other", baseUrl: "https://other.example.com/v1" };

function loadMpPicker(selected) {
  const calls = { ask: [], fetch: [], notice: [], chooser: [], busy: [], timers: [], restored: 0 };
  const env = { active: true };
  let selectedNow = () => selected.id || "";
  if (typeof selected.id === "function") selectedNow = selected.id;   // 动态选中态：模拟等待期间宿主重渲染把选中项读丢
  const sandbox = vm.createContext({
    inactive: () => !env.active,
    restoreModelPuller: () => { calls.restored += 1; },
    setMpHostBusy: (btn, busy) => calls.busy.push(busy),
    mpAsk: (action, payload, cb) => calls.ask.push({ action, cb }),
    openMpNotice: (text) => calls.notice.push(text),
    mpErrorText: () => "error-text",
    detectSelectedCustomProviderId: () => selectedNow(),
    detectMpProviderBaseUrl: () => selected.baseUrl || "",
    startMpHostFetch: (provider) => calls.fetch.push(provider.id),
    openMpProviders: (list) => calls.chooser.push(list.map((x) => x.id)),
    setTimeout: (fn, ms) => { calls.timers.push({ fn, ms }); return calls.timers.length; },
  });
  vm.runInContext("var state = { lang: 'zh' };\nfunction L(zh, en) { return state.lang === 'en' ? en : zh; }\n" +
    ["matchProviderById", "matchProviderByBaseUrl", "pickMpProvider", "askMpList"].map(sliceFunction).join("\n") +
    "\nthis.__mp = { pickMpProvider: pickMpProvider, askMpList: askMpList };", sandbox);
  const answer = (providers) => calls.ask[calls.ask.length - 1].cb({ ok: true, providers });
  return { mp: sandbox.__mp, calls, env, answer };
}

test("pickMpProvider: 选中项按 id 命中优先；选中套餐源却不在列表里是 pending，不兜底", () => {
  const { mp } = loadMpPicker({});
  const plain = (v) => JSON.parse(JSON.stringify(v));
  assert.deepEqual(plain(mp.pickMpProvider([RELAY, PLAN], PLAN.id, "")), { provider: PLAN });
  assert.deepEqual(plain(mp.pickMpProvider([RELAY, OTHER], OTHER.id, RELAY.baseUrl)), { provider: OTHER });   // id 先于 Base URL
  assert.deepEqual(plain(mp.pickMpProvider([RELAY], PLAN.id, "")), { pending: true });                          // 唯一供应商也不拿来顶替套餐源
  assert.deepEqual(plain(mp.pickMpProvider([RELAY], PLAN.id, RELAY.baseUrl)), { pending: true });               // Base URL 碰巧相符同样不顶替
  assert.deepEqual(plain(mp.pickMpProvider([], PLAN.id, "")), { pending: true });
  assert.deepEqual(plain(mp.pickMpProvider([RELAY, OTHER], "", OTHER.baseUrl)), { provider: OTHER });           // 未识别选中项：Base URL 兜底
  assert.deepEqual(plain(mp.pickMpProvider([RELAY], "", "")), { provider: RELAY });                             // 未识别选中项且只有一个：沿用既有兜底
  assert.deepEqual(plain(mp.pickMpProvider([RELAY, OTHER], "", "")), { provider: null });                       // 多个且无法判定：交给选择弹窗
});

test("askMpList: 套餐源首次缺席则重问一次，到位后拉的是套餐源", () => {
  const { mp, calls, answer } = loadMpPicker(PLAN);
  mp.askMpList({}, false);
  assert.equal(calls.ask.length, 1);
  assert.equal(calls.ask[0].action, "model-pull-list");
  answer([RELAY]);                                   // 钥匙串密钥还没进缓存：列表只有中转
  assert.deepEqual(calls.fetch, []);
  assert.deepEqual(calls.notice, []);
  assert.equal(calls.timers.length, 1);
  assert.equal(calls.timers[0].ms, 400);
  calls.timers[0].fn();
  assert.equal(calls.ask.length, 2);
  answer([RELAY, PLAN]);
  assert.deepEqual(calls.fetch, [PLAN.id]);
  assert.deepEqual(calls.notice, []);
  assert.equal(calls.timers.length, 1);
});

test("askMpList: 套餐源重问后仍缺席——提示凭据暂不可用，绝不改投到别的供应商", () => {
  for (const listed of [[RELAY], [], [RELAY, OTHER]]) {
    const { mp, calls, answer } = loadMpPicker(PLAN);
    mp.askMpList({}, false);
    answer(listed);
    calls.timers[0].fn();
    answer(listed);
    assert.deepEqual(calls.fetch, [], "未向任何供应商发起拉取：" + JSON.stringify(listed.map((x) => x.id)));
    assert.deepEqual(calls.chooser, []);
    assert.deepEqual(calls.notice, ["当前套餐的登录凭据暂时不可用，请稍后重试。"]);
    assert.deepEqual(calls.busy, [false]);          // 按钮 loading 解除
    assert.equal(calls.timers.length, 1);           // 只重问一次
  }
});

test("askMpList: 重问等待期间实例失活则收手，不再发第二次请求", () => {
  const { mp, calls, env, answer } = loadMpPicker(PLAN);
  mp.askMpList({}, false);
  answer([RELAY]);
  env.active = false;
  calls.timers[0].fn();
  assert.equal(calls.ask.length, 1);
  assert.equal(calls.restored, 1);
  assert.deepEqual(calls.fetch, []);
});

test("askMpList: 自定义供应商路径不变——命中即拉、无供应商给添加指引、无法判定开选择弹窗", () => {
  const hit = loadMpPicker(RELAY);
  hit.mp.askMpList({}, false);
  hit.answer([OTHER, RELAY]);
  assert.deepEqual(hit.calls.fetch, [RELAY.id]);
  assert.equal(hit.calls.timers.length, 0);

  const none = loadMpPicker({});
  none.mp.askMpList({}, false);
  none.answer([]);
  assert.equal(none.calls.notice.length, 1);
  assert.match(none.calls.notice[0], /未找到 API Key 型自定义供应商/);
  assert.deepEqual(none.calls.busy, [false]);

  const many = loadMpPicker({});
  many.mp.askMpList({}, false);
  many.answer([RELAY, OTHER]);
  assert.deepEqual(many.calls.chooser, [[RELAY.id, OTHER.id]]);
  assert.deepEqual(many.calls.fetch, []);

  const failed = loadMpPicker(RELAY);
  failed.mp.askMpList({}, false);
  failed.calls.ask[0].cb({ ok: false, error: "x" });
  assert.deepEqual(failed.calls.notice, ["error-text"]);
});

test("askMpList: 判定沿用点击时刻的选中项——等待期间选中态变化（读丢或变成别的供应商）都不改投", () => {
  for (const later of ["", RELAY.id]) {   // 等待期间宿主重渲染把选中项读丢 / 用户切到了别的供应商
    const seen = [];
    const { mp, calls, answer } = loadMpPicker({ id: () => (seen.push(1), seen.length === 1 ? PLAN.id : later) });
    mp.askMpList({}, false, seen.length === 0 ? undefined : PLAN.id);   // 点击时采样（loadMpPicker 的入口在 mp.askMpList 内已采样；这里显式传点击值）
    answer([RELAY]);
    assert.equal(calls.timers.length, 1, later);
    calls.timers[0].fn();
    answer([RELAY]);
    assert.deepEqual(calls.fetch, [], "不得改投到唯一的自定义供应商：" + JSON.stringify(later));
    assert.deepEqual(calls.notice, ["当前套餐的登录凭据暂时不可用，请稍后重试。"], later);
  }
});
