const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { getNamedSlice, sliceOverlay } = require('./helpers/overlay-extract.cjs');

// 速度格稳定占位与展示协调（specs/speed-chip-stable-slot.md）：
// 外宽只随布局档位变、不随状态文字变；展示模型只读结构化字段；协调器只管展示时机。

const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');
const FACE = (label, value, unit = '', glue = false) => ({ label, value, unit, glue });   // v461：glue=标签与数值贴紧（子代理面）

/* ---------- 展示模型（07 分片实例级渲染助手区的纯函数） + 状态机（02 分片） ---------- */
const NOW = 100000;
function model(lang = 'zh') {
  const ctx = { L: (zh, en) => (lang === 'en' ? en : zh), Date: { now: () => NOW } };
  vm.runInNewContext(sliceOverlay('  var ZU_TOOL_VERBS = {', '  /* v78：消息流 loading 状态词') + '\n' +
    getNamedSlice('zuBarSpeedView') + '\n' +
    sliceOverlay('    /* ---------- 速度格稳定占位：展示模型', '    function zuSpeedFaceHtml(view, autoWidth) {') + '\n', ctx);
  return ctx;
}
const plain = (o) => JSON.parse(JSON.stringify(o));
/* 面构建函数 zuSpeedFaceHtml（依赖 ttEsc；转义不是本文件被测点，用恒等桩） */
function faceHtml(lang = 'zh') {
  const m = model(lang);
  m.ttEsc = (x) => String(x);
  vm.runInNewContext(sliceOverlay('    function zuSpeedFaceHtml(view, autoWidth) {', '    function zuSpeedIconHtml(phase) {') + '\n', m);
  return m;
}

test('展示模型住在 html() 切片夹具共用的渲染助手区（ttEsc→stubFor），布局类回归零打桩可用', () => {
  const helperSlice = sliceOverlay('    function ttEsc(', '    function stubFor(');
  for (const name of ['function zuSpeedFace(view, autoWidth)', 'function zuSpTime(ms)', 'function zuSpNum(v, est)', 'function zuSpeedFaceHtml(view, autoWidth)', 'function zuSpeedIconHtml(phase)', 'function zuSpeedCellAttrs(full, live)'])
    assert.ok(helperSlice.includes(name), name);
  assert.ok(getNamedSlice('zuBarSpeedView').includes('elapsedMs: elapsedMs'), '状态机仍在 02 分片并透出数值字段');
  assert.ok(!getNamedSlice('zuBarSpeedView').includes('function zuSpeedFace('), '展示模型不回迁状态机分片');
});

test('zuSpeedFace: 八态标签/数值/单位（zh），只读结构化字段', () => {
  const m = model('zh');
  // v461：子代理面「子·X」——单字标签 + 贴紧的间隔点 + 速率，不带单位；数量不上面（全称里才有 ×N）
  assert.deepEqual(plain(m.zuSpeedFace({ kind: 'subagent', activeCount: 3, speedValue: 128.6 })), FACE('子·', '128.6', '', true));
  assert.deepEqual(plain(m.zuSpeedFace({ kind: 'subagent', activeCount: 1, speedValue: 128.6 })), FACE('子·', '128.6', '', true), '数量不上格面：N=1 与 N>1 同面');
  assert.deepEqual(plain(m.zuSpeedFace({ kind: 'subagent', activeCount: 12, speedValue: 1286.5 })), FACE('子', '1286.5', '', true), '六字符数值带点放不下：退成不带点、同样贴紧的标签');
  assert.deepEqual(plain(m.zuSpeedFace({ kind: 'toolgroup', groupKind: 'explore', elapsedMs: 3200 })), FACE('查阅', '03s'));
  assert.deepEqual(plain(m.zuSpeedFace({ kind: 'toolgroup', groupKind: 'terminal', elapsedMs: 3200 })), FACE('终端', '03s'));
  assert.deepEqual(plain(m.zuSpeedFace({ kind: 'skill', nameText: '代码审查与修复', elapsedMs: 12500 })), FACE('代码审查与修复', '12s'));
  assert.deepEqual(plain(m.zuSpeedFace({ kind: 'tool', toolName: 'Read', elapsedMs: 1200 })), FACE('读取', '01s'));
  assert.deepEqual(plain(m.zuSpeedFace({ kind: 'tool', toolName: 'Bash', elapsedMs: 500 })), FACE('执行', '0.5s'), '不足 1 秒一位小数（时间格式表）');
  assert.deepEqual(plain(m.zuSpeedFace({ kind: 'tool', toolName: 'WebFetch', elapsedMs: null })), FACE('正在打开', ''), '缺起始时刻不显数值，标签换成四字说法（v463）');
  assert.deepEqual(plain(m.zuSpeedFace({ kind: 'tool', toolName: 'mcp__srv__tool', elapsedMs: 1000 })), FACE('srv', '01s'), 'MCP 工具取服务名');
  assert.deepEqual(plain(m.zuSpeedFace({ kind: 'tool', toolName: 'mcp__computer-use__click', elapsedMs: 1000 })), FACE('电脑', '01s'));
  assert.deepEqual(plain(m.zuSpeedFace({ kind: 'tool', toolName: 'js_repl', elapsedMs: 1000 })), FACE('代码', '01s'));
  assert.deepEqual(plain(m.zuSpeedFace({ kind: 'tool', toolName: 'NotebookEdit', elapsedMs: 1000 })), FACE('NotebookEdit', '01s'), '未登记工具显示工具名');
  assert.deepEqual(plain(m.zuSpeedFace({ kind: 'tool', toolName: '', elapsedMs: 1000 })), FACE('执行', '01s'), '空名回退「执行」');
  assert.deepEqual(plain(m.zuSpeedFace({ kind: 'thinking', elapsedMs: 393000 })), FACE('思考', '6:33'));
  assert.deepEqual(plain(m.zuSpeedFace({ kind: 'estimate', speedValue: 173.4 })), FACE('', '173.4', 't/s'), 'v454 起估算无标签');
  assert.deepEqual(plain(m.zuSpeedFace({ kind: 'avg', latest: 212.9, speedValue: 80 })), FACE('', '212.9', 't/s'), 'avg 的面数字取 latest（最后一轮真实值，v298），不取会话均');
  assert.deepEqual(plain(m.zuSpeedFace({ kind: 'real', speedValue: 250 })), FACE('', '250.0', 't/s'), 'real 恒一位小数（与 text 一致）');
  assert.deepEqual(plain(m.zuSpeedFace({ kind: 'real', db: true, speedValue: 87.3 })), FACE('', '87.3', 't/s'), 'DB 回退无标签（v452，与完成态同面）');
  assert.equal(m.zuSpeedFace({ kind: 'real', db: true, speedValue: null }), null, 'DB 回退无值不显');
  assert.equal(m.zuSpeedFace(null), null);
  /* 不解析 text：同一结构化字段配上任意 text，产出不变 */
  const a = m.zuSpeedFace({ kind: 'tool', toolName: 'Read', elapsedMs: 1200, text: '读取中 1.2s' });
  const b = m.zuSpeedFace({ kind: 'tool', toolName: 'Read', elapsedMs: 1200, text: '随便什么文案' });
  assert.deepEqual(plain(a), plain(b));
});

test('zuSpeedFace: 英文标签', () => {
  const m = model('en');
  assert.deepEqual(plain(m.zuSpeedFace({ kind: 'subagent', activeCount: 3, speedValue: 128.6 })), FACE('Ag·', '128.6', '', true));
  assert.deepEqual(plain(m.zuSpeedFace({ kind: 'subagent', activeCount: 3, speedValue: 1286.5 })), FACE('A', '1286.5', '', true), '英文六字符数值退成单字母（实测 Ag1286.5 在 14px 下仍被省略');
  assert.deepEqual(plain(m.zuSpeedFace({ kind: 'toolgroup', groupKind: 'explore', elapsedMs: 3200 })), FACE('Scan', '03s'));
  assert.deepEqual(plain(m.zuSpeedFace({ kind: 'toolgroup', groupKind: 'terminal', elapsedMs: 3200 })), FACE('Shell', '03s'));
  assert.deepEqual(plain(m.zuSpeedFace({ kind: 'tool', toolName: 'Bash', elapsedMs: 3200 })), FACE('Run', '03s'));
  assert.deepEqual(plain(m.zuSpeedFace({ kind: 'thinking', elapsedMs: 393000 })), FACE('Think', '6:33'));
  assert.deepEqual(plain(m.zuSpeedFace({ kind: 'estimate', speedValue: 173.4 })), FACE('', '173.4', 't/s'));
  assert.deepEqual(plain(m.zuSpeedFace({ kind: 'real', db: true, speedValue: 87.3 })), FACE('', '87.3', 't/s'));
  assert.equal(m.zuSpTime(90000000), '1d 1h');
});

test('v463 无计时面：已登记的短状态词换成四字说法（用户「执行 → 正在执行」），一出计时换回短状态词 + 数字', () => {
  const m = model('zh'), en = model('en');
  // [kind, 附加字段, 短 zh, 无计时 zh, 短 en, 无计时 en]
  const NAKE = [
    ['thinking', {}, '思考', '正在思考', 'Think', 'Think'],   // Thinking 在最紧的档放不下：英文不换
    ['toolgroup', { groupKind: 'explore' }, '查阅', '正在查阅', 'Scan', 'Reading'],
    ['toolgroup', { groupKind: 'terminal' }, '终端', '正在执行', 'Shell', 'Running'],
    ['tool', { toolName: 'Read' }, '读取', '正在读取', 'Read', 'Reading'],
    ['tool', { toolName: 'Write' }, '写入', '正在写入', 'Write', 'Writing'],
    ['tool', { toolName: 'Edit' }, '编辑', '正在编辑', 'Edit', 'Editing'],
    ['tool', { toolName: 'ApplyPatch' }, '编辑', '正在编辑', 'Edit', 'Editing'],
    ['tool', { toolName: 'Bash' }, '执行', '正在执行', 'Run', 'Running'],
    ['tool', { toolName: 'Grep' }, '搜索', '正在搜索', 'Find', 'Finding'],
    ['tool', { toolName: 'Glob' }, '搜索', '正在搜索', 'Find', 'Finding'],
    ['tool', { toolName: 'WebSearch' }, '搜索', '正在搜索', 'Find', 'Finding'],
    ['tool', { toolName: 'WebFetch' }, '网页', '正在打开', 'Fetch', 'Loading'],
    ['tool', { toolName: 'TodoWrite' }, '待办', '更新待办', 'Todo', 'Todo'],
    ['tool', { toolName: 'Skill' }, '技能', '正在调用', 'Skill', 'Calling'],
    ['tool', { toolName: 'ReadSessionContext' }, '上下文', '正在读取', 'Ctx', 'Loading'],
    ['tool', { toolName: 'Task' }, '代理', '正在派发', 'Agent', 'Agent'],
    ['tool', { toolName: 'SendMessage' }, '消息', '正在发送', 'Send', 'Sending'],
    ['tool', { toolName: 'TaskOutput' }, '输出', '正在查看', 'Out', 'Polling'],
    ['tool', { toolName: 'TaskStop' }, '停止', '正在停止', 'Stop', 'Halting'],
    ['tool', { toolName: 'CreateWorkflow' }, '流程', '正在启动', 'Flow', 'Starting'],
    ['tool', { toolName: 'js_repl' }, '代码', '正在运行', 'Code', 'Running'],
    ['tool', { toolName: 'mcp__computer-use__click' }, '电脑', '正在操作', 'Cua', 'Clicking'],
    ['skill', { nameText: '' }, '技能', '正在调用', 'Skill', 'Calling'],
  ];
  for (const [kind, extra, zh, zhLong, enShort, enLong] of NAKE) {
    const tag = `${kind} ${JSON.stringify(extra)}`, base = { kind, ...extra, elapsedMs: null };
    assert.deepEqual(plain(m.zuSpeedFace(base)), FACE(zhLong, ''), `${tag}: zh 无计时`);
    assert.deepEqual(plain(en.zuSpeedFace(base)), FACE(enLong, ''), `${tag}: en 无计时`);
    assert.ok(Array.from(zhLong).length <= 4, `${zhLong} 不超过四个字（更长的在固定宽里放不下）`);
    // 同一面一旦有计时：短状态词 + 数字（四字说法带数字放不下）
    assert.deepEqual(plain(m.zuSpeedFace({ ...base, elapsedMs: 3200 })), FACE(zh, '03s'), `${tag}: zh 有计时用短状态词`);
    assert.deepEqual(plain(en.zuSpeedFace({ ...base, elapsedMs: 3200 })), FACE(enShort, '03s'), `${tag}: en 有计时用短状态词`);
  }
  /* 耗时缺失或非法都算无计时 */
  for (const bad of [undefined, -5, NaN, Infinity]) assert.deepEqual(plain(m.zuSpeedFace({ kind: 'tool', toolName: 'Bash', elapsedMs: bad })), FACE('正在执行', ''), `elapsedMs ${String(bad)}`);
  assert.deepEqual(plain(m.zuSpeedFace({ kind: 'tool', toolName: '', elapsedMs: null })), FACE('正在执行', ''), '空名回退「执行」同样换');
  /* 不换的三类：技能名、MCP 服务名、未登记工具的原始名（无计时也原样） */
  assert.deepEqual(plain(m.zuSpeedFace({ kind: 'skill', nameText: 'zcode-github-release', elapsedMs: null })), FACE('zcode-github-release', ''), '技能名不换');
  assert.deepEqual(plain(m.zuSpeedFace({ kind: 'tool', toolName: 'mcp__web_reader__webReader', elapsedMs: null })), FACE('web_reader', ''), 'MCP 服务名不换');
  assert.deepEqual(plain(m.zuSpeedFace({ kind: 'tool', toolName: 'AskUserQuestion', elapsedMs: null })), FACE('AskUserQuestion', ''), '未登记工具名不换');
  /* 无标签面与子代理面不受影响 */
  assert.deepEqual(plain(m.zuSpeedFace({ kind: 'estimate', speedValue: 173.4 })), FACE('', '173.4', 't/s'));
  assert.deepEqual(plain(m.zuSpeedFace({ kind: 'subagent', activeCount: 3, speedValue: 128.6 })), FACE('子·', '128.6', '', true));
  /* 格面 HTML：仍是三个 item 的结构（空的数值位 span 保留），标签不带 glue */
  assert.equal(faceHtml('zh').zuSpeedFaceHtml({ kind: 'tool', toolName: 'Bash', elapsedMs: null }), '<span class="zu-sp-label">正在执行</span><span class="zu-sp-val"></span>');
  assert.equal(faceHtml('en').zuSpeedFaceHtml({ kind: 'tool', toolName: 'Bash', elapsedMs: null }), '<span class="zu-sp-label">Running</span><span class="zu-sp-val"></span>');
  /* 表里的中文都不超过四个字、英文互不重复到放不下由真实浏览器夹具锁定（overlay-pill-theme 静态探针） */
  const table = sliceOverlay('    var ZU_SPEED_NAKED = (function () {', '    function zuSpeedFace(view, autoWidth) {');
  const cells = [...table.matchAll(/\["([^"]+)", "([^"]+)", "([^"]+)", "([^"]+)"\]/g)].map(x => x.slice(1, 5).map(String));
  assert.equal(cells.length, 19, `ZU_SPEED_NAKED 逐行可解析（看到 ${cells.length} 行）`);
  for (const [zh, , zhLong] of cells) assert.ok(Array.from(zhLong).length <= Array.from(zh).length + 2 && Array.from(zhLong).length <= 4, `${zh} → ${zhLong}`);
  /* 英文：最紧的档（药丸宽裕 + 11px 界面字号）标签可用 44.6px；本机系统字体 14px 下自然宽 ≤ 55.5px 的词才放得下。
   * 下列词实测更宽（Thinking 58.41、Fetching 58.81、Planning 58.5、Invoking 57.01、Stopping 61.14、Searching 67.95、Scanning 62.69、
   * Operating 67.4、Dispatching 80.74、Delegating 73.11、Launching 70.11），不得写进表里；真实宽度由 overlay-pill-theme 静态探针逐档锁定 */
  const tooWide = ['Thinking', 'Fetching', 'Planning', 'Invoking', 'Stopping', 'Searching', 'Scanning', 'Operating', 'Dispatching', 'Delegating', 'Launching'];
  for (const [, , , enLong] of cells) assert.ok(!tooWide.includes(enLong), `${enLong} 在最紧的档放不下`);
});

test('v464 长计时面：计时满 1 小时起不出文字标签（只留图标 + 时间），不足 1 小时不变，无标签面不受影响', () => {
  const m = model('zh'), en = model('en');
  const HOUR = 3600000;
  // [kind, 附加字段, 短 zh, 短 en]——四种带计时的面各取代表（技能名面也在内）
  const TIMED = [
    ['thinking', {}, '思考', 'Think'],
    ['toolgroup', { groupKind: 'explore' }, '查阅', 'Scan'],
    ['toolgroup', { groupKind: 'terminal' }, '终端', 'Shell'],
    ['tool', { toolName: 'Bash' }, '执行', 'Run'],
    ['skill', { nameText: 'zcode-github-release' }, 'zcode-github-release', 'zcode-github-release'],
  ];
  for (const [kind, extra, zh, enShort] of TIMED) {
    const tag = `${kind} ${JSON.stringify(extra)}`, base = { kind, ...extra };
    // 1 小时以内：状态词 + 数字（59:59 是固定宽里放得下的最宽数值）
    assert.deepEqual(plain(m.zuSpeedFace({ ...base, elapsedMs: HOUR - 1 })), FACE(zh, '59:59'), `${tag}: 不足 1 小时仍带状态词`);
    assert.deepEqual(plain(en.zuSpeedFace({ ...base, elapsedMs: HOUR - 1 })), FACE(enShort, '59:59'), `${tag}: en 不足 1 小时仍带状态词`);
    // 满 1 小时：写法变长（1:00:00、1:22:02，跨天 1天3时），状态词不出
    assert.deepEqual(plain(m.zuSpeedFace({ ...base, elapsedMs: HOUR })), FACE('', '1:00:00'), `${tag}: 满 1 小时不出状态词`);
    assert.deepEqual(plain(m.zuSpeedFace({ ...base, elapsedMs: 4922000 })), FACE('', '1:22:02'), `${tag}: 1:22:02`);
    assert.deepEqual(plain(m.zuSpeedFace({ ...base, elapsedMs: 97200000 })), FACE('', '1天3时'), `${tag}: 跨天`);
    assert.deepEqual(plain(en.zuSpeedFace({ ...base, elapsedMs: 4922000 })), FACE('', '1:22:02'), `${tag}: en 满 1 小时同样不出`);
  }
  /* 格面 HTML：标签 span 为空（.zu-sp-label:empty → display:none），数值紧跟图标；空 span 结构不变（原地更新按三个 span 写） */
  const h = faceHtml('zh');
  assert.equal(h.zuSpeedFaceHtml({ kind: 'thinking', elapsedMs: 4922000 }), '<span class="zu-sp-label"></span><span class="zu-sp-val">1:22:02</span>');
  assert.equal(h.zuSpeedFaceHtml({ kind: 'thinking', elapsedMs: 3599000 }), '<span class="zu-sp-label">思考</span><span class="zu-sp-val">59:59</span>');
  assert.ok(source.includes('>.zu-live>.zu-sp-label:empty{display:none}'), '空标签不占位依赖既有 :empty 规则（06 分片）');
  /* 无标签面与子代理面不受影响（没有 elapsedMs）；全称来自 text，不经展示模型 */
  assert.deepEqual(plain(m.zuSpeedFace({ kind: 'estimate', speedValue: 173.4 })), FACE('', '173.4', 't/s'));
  assert.deepEqual(plain(m.zuSpeedFace({ kind: 'subagent', activeCount: 3, speedValue: 128.6 })), FACE('子·', '128.6', '', true));
  /* 精简 chip（autoWidth=true）不在此列：按内容定宽，中等档按「Think 23:59:59」标定——长计时面照旧带状态词 */
  assert.deepEqual(plain(m.zuSpeedFace({ kind: 'thinking', elapsedMs: 4922000 }, true)), FACE('思考', '1:22:02'), '精简 chip：满 1 小时仍带状态词');
  assert.deepEqual(plain(en.zuSpeedFace({ kind: 'tool', toolName: 'Bash', elapsedMs: 97200000 }, true)), FACE('Run', '1d 3h'), '精简 chip：英文同理');
  assert.equal(h.zuSpeedFaceHtml({ kind: 'thinking', elapsedMs: 4922000 }, true), '<span class="zu-sp-label">思考</span><span class="zu-sp-val">1:22:02</span>', 'autoWidth 透传到展示模型');
});

test('v461 子代理面「子·X」：标签带 zu-sp-glue（点与数值贴紧），其余面不带；贴紧规则与 .zu-live 的 gap 同源', () => {
  const m = faceHtml('zh'), en = faceHtml('en');
  assert.equal(m.zuSpeedFaceHtml({ kind: 'subagent', activeCount: 3, speedValue: 128.6 }), '<span class="zu-sp-label zu-sp-glue">子·</span><span class="zu-sp-val">128.6</span>');
  assert.equal(m.zuSpeedFaceHtml({ kind: 'subagent', activeCount: 1, speedValue: 28.8 }), '<span class="zu-sp-label zu-sp-glue">子·</span><span class="zu-sp-val">28.8</span>', '数量不上格面');
  assert.equal(en.zuSpeedFaceHtml({ kind: 'subagent', activeCount: 3, speedValue: 128.6 }), '<span class="zu-sp-label zu-sp-glue">Ag·</span><span class="zu-sp-val">128.6</span>');
  assert.equal(m.zuSpeedFaceHtml({ kind: 'subagent', activeCount: 12, speedValue: 1286.5 }), '<span class="zu-sp-label zu-sp-glue">子</span><span class="zu-sp-val">1286.5</span>', '六字符数值：不带点、仍贴紧');
  assert.equal(m.zuSpeedFaceHtml({ kind: 'subagent', activeCount: 12, speedValue: 9999.9 }), '<span class="zu-sp-label zu-sp-glue">子</span><span class="zu-sp-val">9999.9</span>');
  assert.equal(m.zuSpeedFaceHtml({ kind: 'subagent', activeCount: 12, speedValue: 10000 }), '<span class="zu-sp-label zu-sp-glue">子·</span><span class="zu-sp-val">10.0k</span>', '万位起缩写成五字符，回到带点的面');
  assert.equal(m.zuSpeedFaceHtml({ kind: 'thinking', elapsedMs: 393000 }), '<span class="zu-sp-label">思考</span><span class="zu-sp-val">6:33</span>', '思考面不带 glue');
  assert.equal(m.zuSpeedFaceHtml({ kind: 'avg', speedValue: 128.6 }), '<span class="zu-sp-label"></span><span class="zu-sp-val">128.6</span><span class="zu-sp-unit dim">t/s</span>', '完成态不带 glue、单位仍在');
  assert.ok(!/代理/.test(m.zuSpeedFaceHtml({ kind: 'subagent', activeCount: 12, speedValue: 128.6 })), '子代理面不再出现「代理」与 ×N');
  /* 贴紧靠负外边距抵消 .zu-live 的 gap：两个数值必须相反数，且 .zu-live 的 gap 只此一处定义 */
  const glue = /\.zu-sp-label\.zu-sp-glue\{margin-right:(-?[\d.]+px)\}/.exec(source);
  const gap = /"\.zu-live\{[^}]*?gap:([\d.]+px)/.exec(source);
  assert.ok(glue && gap, `glue ${glue && glue[1]} / gap ${gap && gap[1]}`);
  assert.equal(Number(glue[1]), -Number(gap[1]), `zu-sp-glue 的外边距 ${glue[1]} 必须抵消 .zu-live 的 gap ${gap[1]}`);
  assert.equal((source.match(/"\.zu-live\{/g) || []).length, 1, '.zu-live 的 gap 只此一处定义（各档位都是 5px）');
});

test('zuSpTime: 格面紧凑时间（不足 1 秒一位小数→整数秒两位补零→分:秒→时:分:秒→天+时）', () => {
  const m = model('zh');
  const cases = [[0, '0.0s'], [49, '0.0s'], [100, '0.1s'], [500, '0.5s'], [949, '0.9s'], [999, '0.9s'], [1000, '01s'], [3200, '03s'], [9999, '09s'], [10000, '10s'],
    [59000, '59s'], [60000, '1:00'], [63000, '1:03'], [3599000, '59:59'],
    [3600000, '1:00:00'], [3661000, '1:01:01'], [3670000, '1:01:10'], [86399000, '23:59:59'],
    [86400000, '1天0时'], [129600000, '1天12时'], [90000000, '1天1时']];
  for (const [ms, want] of cases) assert.equal(m.zuSpTime(ms), want, String(ms));
  for (const bad of [null, undefined, NaN, Infinity, -1, '1200']) assert.equal(m.zuSpTime(bad), '', '非法值 ' + String(bad));
});

test('zuSpNum: 位数跨越不改变精度，万位起缩写，异常值不伪造 0', () => {
  const m = model('zh');
  const est = (v) => m.zuSpeedFace({ kind: 'estimate', speedValue: v }).value;
  assert.equal(est(9.9), '9.9'); assert.equal(est(10), '10.0'); assert.equal(est(100), '100.0'); assert.equal(est(1000), '1000.0');
  assert.equal(est(999.9), '999.9'); assert.equal(est(1000.0), '1000.0'); assert.equal(est(9999.9), '9999.9');
  assert.equal(est(10000), '10.0k'); assert.equal(est(12864), '12.9k');
  assert.equal(est(999949), '999.9k'); assert.equal(est(999999), '1.0M', '进位不跨档'); assert.equal(est(1234567), '1.2M');
  assert.equal(est(999.9e6), '999.9M'); assert.equal(est(999.96e6), '1.0B'); assert.equal(est(2.5e12), '2.5T'); assert.equal(est(1234e12), '1234T'), '超上限位数不再增长';
  assert.equal(est(1999.9), '1999.9'); assert.equal(est(2000.0), '2000.0');
  const done = (v) => m.zuSpeedFace({ kind: 'real', db: true, speedValue: v });
  assert.equal(done(9.9).value, '9.9'); assert.equal(done(10).value, '10'); assert.equal(done(100).value, '100'); assert.equal(done(1000).value, '1000');
  assert.equal(done(2000).value, '2000'); assert.equal(done(12864.4).value, '12.9k');
  for (const bad of [NaN, -1, Infinity, -Infinity, null, '5']) assert.equal(done(bad), null, '异常值不渲染（不伪造 0）' + String(bad));
  /* 缩写只作用于展示层：分档仍按原始速度值 */
  assert.equal(m.tpsBand(10000).cls, 'zu-ultra', '缩写值 10.0k 的档位仍按原始值 10000 判（≥2000 Ultra）');
  assert.equal(m.tpsBand(1500).cls, 'zu-magenta');
  assert.equal(m.tpsBand(1999.9).cls, 'zu-magenta');
  assert.equal(m.tpsBand(2000).cls, 'zu-ultra');
});

test('zuBarSpeedView 追加数值字段 elapsedMs/toolName/groupKind，text 逐字不变', () => {
  const m = model('zh');
  const tool = m.zuBarSpeedView({ complete: false, characterRate: null, runningTool: { name: 'Bash', startedAt: NOW - 3200, inputText: '{}' },
    runningGroup: null, startedAt: 0, observedMs: 0 });
  assert.equal(tool.kind, 'tool'); assert.equal(tool.text, '执行中 3.2s');
  assert.equal(tool.toolName, 'Bash'); assert.equal(tool.elapsedMs, 3200);
  assert.deepEqual(plain(m.zuSpeedFace(tool)), FACE('执行', '03s'));
  const grp = m.zuBarSpeedView({ complete: false, characterRate: null, runningTool: { name: 'Read', startedAt: NOW - 60000, inputText: '{}' },
    runningGroup: { kind: 'explore', startedAt: NOW - 63000 }, startedAt: 0, observedMs: 0 });
  assert.equal(grp.kind, 'toolgroup'); assert.equal(grp.groupKind, 'explore'); assert.equal(grp.text, '查阅·执行中 63.0s');
  assert.equal(grp.elapsedMs, 63000, '工具组计时锚定组首行');
  assert.deepEqual(plain(m.zuSpeedFace(grp)), FACE('查阅', '1:03'));
  const think = m.zuBarSpeedView({ complete: false, characterRate: null, startedAt: NOW - 39000, observedMs: 0 });
  assert.equal(think.text, '思考中…39秒'); assert.equal(think.elapsedMs, 39000);
  assert.deepEqual(plain(m.zuSpeedFace(think)), FACE('思考', '39s'));
  const noStart = m.zuBarSpeedView({ complete: false, characterRate: null, runningTool: { name: 'Read', startedAt: null, inputText: '{}' },
    runningGroup: null, startedAt: 0, observedMs: 0 });
  assert.equal(noStart.text, '读取中'); assert.equal(noStart.elapsedMs, null);
  assert.deepEqual(plain(m.zuSpeedFace(noStart)), FACE('正在读取', ''), 'v463：无计时面换成四字说法，全称 text 仍是「读取中」');
});

test('精简 chip（实时态）：面数值与档位色取同一个展示快照，全称读真实视图', () => {
  const m = faceHtml('zh');
  const sv = { kind: 'estimate', phase: 'estimate', text: '生成中… 估 1286.5 t/s', cls: 'zu-ultra', speedValue: 1286.5 };   // 真实视图：新数值、高档位
  const face = { kind: 'estimate', phase: 'estimate', text: sv.text, cls: 'ok', speedValue: 28.8 };                        // 展示视图：600ms 节流留下的旧快照
  const chip = { setAttribute(k, v) { this[k] = v; } };
  vm.runInNewContext(getNamedSlice('tpsChipFace') + '\n', {
    v: { kind: 'live', sv, face }, chip, L: (zh) => zh, tpsBand: (x) => ({ cls: 'band-' + x }),
    zuSpeedFaceHtml: m.zuSpeedFaceHtml,
  });
  assert.equal(chip.innerHTML, '<span class="zu-live ok"><span class="zu-sp-label"></span><span class="zu-sp-val">28.8</span><span class="zu-sp-unit dim">t/s</span></span>', '数值与颜色同拍：都是展示快照（不出现 1286.5，也不出现 zu-ultra）');
  assert.equal(chip['aria-label'], '生成速度 生成中… 估 1286.5 t/s', '无障碍全称读真实视图');
  assert.equal(chip.__zuSig, 'live|zu-live ok|' + chip.innerHTML.slice('<span class="zu-live ok">'.length, -'</span>'.length), '签名=种类|类串|面');
});

test('精简 chip（DB 回退态）：面数值与档位色都按最后一轮真实值，不取会话均的档', () => {
  const m = faceHtml('zh');
  const chip = { setAttribute(k, v) { this[k] = v; } };
  vm.runInNewContext(getNamedSlice('tpsChipFace') + '\n', {
    v: { kind: 'fallback', dbTps: 87.3, sessAvg: 250, band: { cls: 'zu-ultra' } }, chip, L: (zh) => zh,
    tpsBand: (x) => ({ cls: x >= 200 ? 'zu-ultra' : 'ok' }), zuSpeedFaceHtml: m.zuSpeedFaceHtml,
  });
  assert.equal(chip.innerHTML, '<span class="zu-live ok"><span class="zu-sp-label"></span><span class="zu-sp-val">87.3</span><span class="zu-sp-unit dim">t/s</span></span>');
  assert.equal(chip['aria-label'], '生成速度 87.3 t/s');
});

/* ---------- 展示协调器（08 分片实例级，时间戳显式注入） ---------- */
function coordinator(ident = 's1|t1') {
  const ctx = {
    ZU_SPEED_DISP_MS: { debounce: 180, minShow: 400, num: 600, color: 400, time: 1000 },
    bridge: { handle: { sid: ident.split('|')[0] }, turnId: ident.split('|')[1] },
  };
  vm.runInNewContext(getNamedSlice('speedDisp') + '\n', ctx);
  ctx.pick = ctx.zuSpDispPick;
  return ctx;
}
const V = (kind, extra = {}) => Object.assign({ kind, phase: null, cls: 'dim', text: kind }, extra);
const RUN = (kind) => ({ phase: kind === 'thinking' ? 'thinking' : kind === 'estimate' ? 'thinking' : 'tool' });

test('协调器：首个运行态立即上屏；运行态之间切换需候选连续保持 180ms', () => {
  const pick = coordinator().pick;
  const a = V('tool', RUN('tool'));
  assert.equal(pick(a, 1000), a, '首拍立即');
  const b = V('skill', RUN('skill'));
  assert.equal(pick(b, 1100), a, '候选仅稳定 0ms：仍显示旧态');
  assert.equal(pick(b, 1279), a, '差 1ms 不到 180ms：仍旧态');
  assert.equal(pick(b, 1280), b, '满 180ms：上屏');
});

test('协调器：防抖窗内的短命中间态不上屏，真实状态回到已展示态时候选作废（A→B→A）', () => {
  const pick = coordinator().pick;
  const a = V('tool', RUN('tool'));
  pick(a, 1000);
  const b = V('thinking', RUN('thinking'));
  assert.equal(pick(b, 1100), a);
  assert.equal(pick(a, 1200), a, '回到 A：继续显示 A');
  assert.equal(pick(b, 1300), a, 'B 再次出现：防抖从头起算（不沿用 1100 的起算点）');
  assert.equal(pick(b, 1479), a);
  assert.equal(pick(b, 1480), b);
  /* 候选期内同态数值变化（节流早退）同样作废候选 */
  const pick2 = coordinator().pick;
  const e1 = V('estimate', Object.assign(RUN('estimate'), { speedValue: 100 }));
  pick2(e1, 1000);
  const t1 = V('thinking', RUN('thinking'));
  pick2(t1, 1100);
  const e2 = V('estimate', Object.assign(RUN('estimate'), { speedValue: 130 }));
  assert.equal(pick2(e2, 1150), e1, '估算值 150ms 内被节流：显示仍是 e1');
  assert.equal(pick2(t1, 1400), e1, 'B 再来：距其首个候选已 300ms，但候选已被 A 作废，未满 180ms');
  assert.equal(pick2(t1, 1579), e1);
  assert.equal(pick2(t1, 1580), t1);
});

test('协调器：thinking/estimate 最短显示 400ms；工具类状态不被挽留', () => {
  const pick = coordinator().pick;
  const think = V('thinking', RUN('thinking'));
  pick(think, 1000);
  const est = V('estimate', RUN('estimate'));
  pick(est, 1250);
  assert.equal(pick(est, 1429), think, '差 1ms 不到 180ms 防抖：仍旧态');
  assert.equal(pick(est, 1430), est, '思考态已显示 430ms 且候选稳定 180ms：切换');
  const p2 = coordinator().pick;
  const th2 = V('thinking', RUN('thinking'));
  p2(th2, 2000);
  const tool2 = V('tool', RUN('tool'));
  assert.equal(p2(tool2, 2100), th2);
  assert.equal(p2(tool2, 2280), th2, '候选已满 180ms，但思考态才显示 280ms：保持');
  assert.equal(p2(tool2, 2399), th2);
  assert.equal(p2(tool2, 2400), tool2, '思考态满 400ms：切换');
  /* 工具态显示 120ms 后真实状态变思考：工具结束不 lingering，候选满 180ms 即切 */
  const th3 = V('thinking', RUN('thinking'));
  assert.equal(p2(th3, 2520), tool2);
  assert.equal(p2(th3, 2699), tool2);
  assert.equal(p2(th3, 2700), th3);
});

test('协调器：颜色稳定 400ms——灰↔档位色互换后至少稳定 400ms，同色切换不受约束，硬边界优先', () => {
  const pick = coordinator().pick;
  const tool = V('tool', RUN('tool'));   // 工具/思考/无速率子代理 = 灰（dim）
  assert.equal(pick(tool, 1000), tool);
  const est = V('estimate', Object.assign(RUN('estimate'), { cls: 'warm' }));
  assert.equal(pick(est, 1180), tool);
  assert.equal(pick(est, 1360), tool, '候选已满 180ms，但灰色才显示 360ms：不变色');
  assert.equal(pick(est, 1399), tool);
  assert.equal(pick(est, 1400), est, '灰色满 400ms：切到档位色');
  const think = V('thinking', RUN('thinking'));
  assert.equal(pick(think, 1580), est);
  assert.equal(pick(think, 1760), est, '候选已满 180ms，但档位色才显示 360ms');
  assert.equal(pick(think, 1799), est);
  assert.equal(pick(think, 1800), think, '档位色满 400ms（估算态最短显示 400ms 同时满足）：回到灰');
  const grp = V('toolgroup', RUN('toolgroup'));
  assert.equal(pick(grp, 1820), think);
  assert.equal(pick(grp, 2199), think, '灰→灰 同色，但思考态最短显示 400ms');
  assert.equal(pick(grp, 2200), grp, '思考态满 400ms：同色切换不再受颜色稳定约束');
  const warm = V('estimate', Object.assign(RUN('estimate'), { cls: 'warm' }));
  assert.equal(pick(warm, 2220), grp);
  assert.equal(pick(warm, 2400), warm, '灰色自 1800 起已满 400ms（同色切换不重置稳定期）');
  const hot = V('estimate', Object.assign(RUN('estimate'), { cls: 'hot' }));
  assert.equal(pick(hot, 2500), warm, '同态内换档位色走数值节流（600ms），此刻才 100ms');
  const done = V('real', { cls: 'dim' });
  assert.equal(pick(done, 2510), done, '最终态：硬边界优先于颜色稳定与数值节流');
  /* 同色切换（当前展示不是 thinking/estimate）只受防抖约束 */
  const p2 = coordinator().pick;
  assert.equal(p2(tool, 1000), tool);
  assert.equal(p2(grp, 1180), tool);
  assert.equal(p2(grp, 1360), grp, '工具→工具组 同色：防抖 180ms 即切');
});

test('协调器阈值：数值节流不短于颜色稳定期（同态换档位色时天然满足 400ms）', () => {
  const m = /var ZU_SPEED_DISP_MS = \{ debounce: (\d+), minShow: (\d+), num: (\d+), color: (\d+), time: (\d+) \};/.exec(source);
  assert.ok(m, '阈值常量在位');
  const [debounce, minShow, num, color, time] = m.slice(1).map(Number);
  assert.deepEqual([debounce, minShow, num, color, time], [180, 400, 600, 400, 1000], '目标 §7.2：防抖 180 / 最短显示 400 / 数值 600 / 颜色 400 / 计时 1000');
  assert.ok(num >= color, 'num ≥ color');
  assert.ok(minShow >= color, '最短显示不短于颜色稳定期');
});

test('协调器：最终态、身份切换、数据源切换立即上屏（硬边界优先于一切保持）', () => {
  const pick = coordinator().pick;
  const think = V('thinking', RUN('thinking'));
  pick(think, 1000);
  const done = V('real');
  assert.equal(pick(done, 1010), done, '思考态刚上屏 10ms 即会话结束：最终速度立即');
  const est = V('estimate', RUN('estimate'));
  assert.equal(pick(est, 1020), est, '离开最终态同样立即（新一轮开始）');
  assert.equal(pick(think, 1030), est, '同身份：仍在防抖窗');
  /* 身份切换：轮变化 → 立即 */
  const c2 = coordinator();
  const tool = V('tool', RUN('tool'));
  c2.pick(tool, 1000);
  assert.equal(c2.pick(think, 1100), tool, '同轮：防抖窗内保持');
  c2.bridge.turnId = 't2';
  assert.equal(c2.pick(think, 1150), think, '轮变化：立即');
  c2.bridge.handle.sid = 's2';
  assert.equal(c2.pick(tool, 1160), tool, '会话变化：立即');
  /* 实例状态各自独立 */
  const other = coordinator('s2|t1').pick;
  assert.equal(other(think, 100), think);
  /* 数据源切换：view 为 null 清缓存，下一次实时态立即 */
  const pick4 = coordinator().pick;
  pick4(think, 1000);
  assert.equal(pick4(null, 1100), null);
  assert.equal(pick4(est, 1110), est, '回退/无数据后重新出现实时态：立即');
});

test('协调器：估算数值与档位色同快照、600ms 换一次；计时每 1000ms 换一次；子代理计数即时', () => {
  const pick = coordinator().pick;
  const a = V('estimate', Object.assign(RUN('estimate'), { speedValue: 100, cls: 'warm' }));
  assert.equal(pick(a, 1000), a);
  const b = V('estimate', Object.assign(RUN('estimate'), { speedValue: 130, cls: 'warm' }));
  assert.equal(pick(b, 1300), a, '300ms 内：保持上一个快照（数值与颜色都来自 a）');
  const c = V('estimate', Object.assign(RUN('estimate'), { speedValue: 173.4, cls: 'zu-teal' }));
  assert.equal(pick(c, 1599), a);
  assert.equal(pick(c, 1600), c, '满 600ms：换成新快照（数值 173.4 与 zu-teal 同一对象）');
  const d = V('estimate', Object.assign(RUN('estimate'), { speedValue: 60, cls: 'warm' }));
  assert.equal(pick(d, 1700), c, '换过后重新起算 600ms');
  /* 计时态走 1000ms 计时节流（不是数值节流）：首拍取当前真实耗时，其后每秒换一次 */
  const t1 = V('thinking', Object.assign(RUN('thinking'), { elapsedMs: 1000 }));
  pick(t1, 3000);
  pick(t1, 3179);
  assert.equal(pick(t1, 3180), t1);
  const t2 = V('thinking', Object.assign(RUN('thinking'), { elapsedMs: 1100 }));
  assert.equal(pick(t2, 3190), t1, '同态内 10ms：不换');
  assert.equal(pick(t2, 4179), t1);
  assert.equal(pick(t2, 4180), t2, '上屏满 1000ms：换成此刻的真实耗时（不重新起算）');
  /* 子代理计数变化立即（减少与增加都即时；换新实例，避开上面思考态的最短显示） */
  const p2 = coordinator().pick;
  const s3 = V('subagent', Object.assign(RUN('subagent'), { activeCount: 3, speedValue: 128.6 }));
  assert.equal(p2(s3, 4000), s3);
  assert.equal(p2(s3, 4179), s3);
  const s2 = V('subagent', Object.assign(RUN('subagent'), { activeCount: 2, speedValue: 128.6 }));
  assert.equal(p2(s2, 4250), s2, '数量减少立即');
  const s2b = V('subagent', Object.assign(RUN('subagent'), { activeCount: 2, speedValue: 140 }));
  assert.equal(p2(s2b, 4300), s2, '数量不变：数值仍按 600ms 节流');
  const s4 = V('subagent', Object.assign(RUN('subagent'), { activeCount: 4, speedValue: 140 }));
  assert.equal(p2(s4, 4350), s4, '数量增加同样即时');
});

/* ---------- 目标 §7.3 防抖边界：计时/换手/状态进出的优先级 ---------- */
test('协调器：计时节流 1000ms——首拍取真实耗时、同态内每秒一换、无值→有值立即、状态进出不受它约束', () => {
  const pick = coordinator().pick;
  const t0 = V('tool', Object.assign(RUN('tool'), { toolName: 'Read', elapsedMs: 300 }));
  assert.equal(pick(t0, 1000), t0, '首拍即取当前真实耗时');
  const t1 = V('tool', Object.assign(RUN('tool'), { toolName: 'Read', elapsedMs: 900 }));
  assert.equal(pick(t1, 1600), t0, '同态内 600ms：不换');
  const t2 = V('tool', Object.assign(RUN('tool'), { toolName: 'Read', elapsedMs: 1300 }));
  assert.equal(pick(t2, 1999), t0);
  assert.equal(pick(t2, 2000), t2, '上屏满 1000ms：换成此刻的真实耗时（不是从 0 重新起算）');
  /* startedAt 尚未到位（宿主 inputStreaming 行不写 startedAt）→ 到位：无值→有值立即，不等节流 */
  const p2 = coordinator().pick;
  const noVal = V('tool', Object.assign(RUN('tool'), { toolName: 'Bash' }));
  assert.equal(p2(noVal, 1000), noVal);
  const hasVal = V('tool', Object.assign(RUN('tool'), { toolName: 'Bash', elapsedMs: 100 }));
  assert.equal(p2(hasVal, 1050), hasVal, '无值→有值：立即');
  assert.equal(p2(V('tool', Object.assign(RUN('tool'), { toolName: 'Bash', elapsedMs: 200 })), 1100), hasVal, '其后按 1000ms 节流');
  /* 工具结束（含报错——内核里工具一出错就不算运行中）：只受 180ms 防抖约束 */
  const think = V('thinking', RUN('thinking'));
  p2(think, 1150);
  assert.equal(p2(think, 1329), hasVal);
  assert.equal(p2(think, 1330), think, '工具结束→思考：不被计时节流/最短显示/颜色稳定挽留');
});

test('协调器：同类工具直接换手也要过 180ms 防抖（极短的新工具不闪现）；同名走同态节流', () => {
  const pick = coordinator().pick;
  const read = V('tool', Object.assign(RUN('tool'), { toolName: 'Read', elapsedMs: 3200 }));
  assert.equal(pick(read, 1000), read);
  const bash = V('tool', Object.assign(RUN('tool'), { toolName: 'Bash', elapsedMs: 100 }));
  assert.equal(pick(bash, 1100), read, '换手候选：防抖窗内仍显示上一个工具');
  assert.equal(pick(bash, 1279), read);
  assert.equal(pick(bash, 1280), bash, '满 180ms：换手（耗时取新工具的真实值，不沿用旧值）');
  const bash2 = V('tool', Object.assign(RUN('tool'), { toolName: 'Bash', elapsedMs: 1380 }));
  assert.equal(pick(bash2, 1281), bash, '同名：同态，不触发防抖（走计时节流）');
  assert.equal(pick(bash2, 2280), bash2);
  const p2 = coordinator().pick;
  p2(V('toolgroup', Object.assign(RUN('toolgroup'), { groupKind: 'explore', elapsedMs: 500 })), 1000);
  const term = V('toolgroup', Object.assign(RUN('toolgroup'), { groupKind: 'terminal', elapsedMs: 100 }));
  p2(term, 1100);   // 候选开始
  assert.equal(p2(term, 1279).groupKind, 'explore'); assert.equal(p2(term, 1280).groupKind, 'terminal', '工具组类别切换同理');
  const skA = V('skill', Object.assign(RUN('skill'), { nameText: '代码审查', elapsedMs: 500 }));
  p2(skA, 1300);
  assert.equal(p2(skA, 1479).kind, 'toolgroup'); assert.equal(p2(skA, 1480).kind, 'skill');
  const sk2 = V('skill', Object.assign(RUN('skill'), { nameText: '代码审查与修复', elapsedMs: 100 }));
  p2(sk2, 1530);
  assert.equal(p2(sk2, 1709).nameText, '代码审查'); assert.equal(p2(sk2, 1710).nameText, '代码审查与修复', '技能名切换同理');
});

test('协调器：子代理全部完成（子代理态→其它态）只受防抖约束，不被 600ms 数值节流挽留', () => {
  const pick = coordinator().pick;
  const sub = V('subagent', Object.assign(RUN('subagent'), { activeCount: 2, speedValue: 128.6, cls: 'zu-sky' }));
  assert.equal(pick(sub, 1000), sub);
  const none = V('thinking', Object.assign(RUN('thinking'), { cls: 'zu-sky' }));   // 同色：隔离出数值节流这一个变量
  pick(none, 1100);   // 候选开始
  assert.equal(pick(none, 1279), sub);
  assert.equal(pick(none, 1280), none, '全部完成：180ms 防抖后即离开子代理态');
});

/* ---------- 目标 §7.4：思考 → 工具 → 思考 → 工具 → 生成 → 工具 → 生成完成 ---------- */
function seqEnv(lang = 'zh') {
  const m = faceHtml(lang);
  vm.runInNewContext(sliceOverlay('    function zuSpeedIconHtml(phase) {', '    /* 速度格全称：aria-label 供读屏') + '\n', Object.assign(m, {
    ico: paths => '<svg class="ico" data-kind="' + (/M14\.5 2\.5a6 6 0 0 0-5\.6/.test(paths) ? 'tool' : 'bolt') + '">' + paths + '</svg>',   // 扳手与闪电按路径数据区分
    zuIcoThinking: () => '<svg class="ico" data-kind="think"></svg>',
  }));
  const iconOf = v => v ? /data-kind="([^"]+)"/.exec(m.zuSpeedIconHtml(v.phase))[1] : 'none';   // 相位为空（完成态）= 闪电
  const labelOf = v => v ? (/<span class="zu-sp-label">([^<]*)<\/span>/.exec(m.zuSpeedFaceHtml(v)) || ['', ''])[1] : '';
  const tick = (pick, script, step, end) => {
    const out = []; let last = null;
    for (let t = 0; t <= end; t += step) {
      const d = pick(script(t), t), sig = d ? iconOf(d) + '|' + labelOf(d) : 'none';
      if (sig !== last) { out.push(t + ':' + sig); last = sig; }
    }
    return out;
  };
  return { iconOf, labelOf, tick };
}
/* 估算态按「正文在流」取相位 writing（图标=闪电）；若仍是 thinking 相位则图标为脑，那是状态机既有行为 */
const seqView = (t, kind, extra = {}) => Object.assign(V(kind, RUN(kind)), { cls: kind === 'estimate' || kind === 'real' ? 'zu-sky' : 'dim', phase: kind === 'estimate' ? 'writing' : RUN(kind).phase },
  kind === 'thinking' ? { elapsedMs: t } : {}, extra);
const seqRead = (t, at) => seqView(t, 'tool', { toolName: 'Read', elapsedMs: t - at });
const seqBash = (t, at) => seqView(t, 'tool', { toolName: 'Bash', elapsedMs: t - at });

test('§7.4 状态序列（各态持续 ≥600ms）：七态按序全部上屏，图标与文字成对切换，完成态立即', () => {
  const e = seqEnv(), pick = coordinator().pick;
  const script = t => t < 700 ? seqView(t, 'thinking') : t < 1400 ? seqRead(t, 700) : t < 2100 ? seqView(t, 'thinking')
    : t < 2800 ? seqBash(t, 2100) : t < 3600 ? seqView(t, 'estimate', { speedValue: 128.6 }) : t < 4500 ? seqRead(t, 3600)
    : seqView(t, 'real', { speedValue: 201.4, latest: 201.4, phase: null });
  const shown = e.tick(pick, script, 100, 4500);
  assert.deepEqual(shown, ['0:think|思考', '900:tool|读取', '1600:think|思考', '2300:tool|执行', '3000:bolt|', '3800:tool|读取', '4500:bolt|'],
    '每个持续明显的状态都显示；切换点=真实切换 + 180ms 防抖（思考/生成态另有 400ms 最短显示）；生成完成在当拍立即');
});

test('§7.4 状态序列（中间态极短）：60ms 的工具不闪现、图标不跟着切；持续明显的工具（300ms）照常显示', () => {
  const e = seqEnv();
  /* 两个 60ms 的工具与之后一个 60ms 的工具：真实态存在但不足防抖窗，不上屏 */
  const fast = t => t < 700 ? seqView(t, 'thinking') : t < 760 ? seqRead(t, 700) : t < 820 ? seqView(t, 'thinking')
    : t < 880 ? seqBash(t, 820) : t < 1600 ? seqView(t, 'thinking') : t < 3000 ? seqView(t, 'estimate', { speedValue: 128.6 })
    : t < 3060 ? seqRead(t, 3000) : t < 3800 ? seqView(t, 'thinking') : seqView(t, 'real', { speedValue: 201.4, latest: 201.4, phase: null });
  assert.deepEqual(e.tick(coordinator().pick, fast, 20, 3800), ['0:think|思考', '1780:bolt|', '3240:think|思考', '3800:bolt|'],
    '三个 60ms 的工具都被防抖吞掉（图标不跟着切）；完成态立即');
  const mid = t => t < 700 ? seqView(t, 'thinking') : t < 1000 ? seqRead(t, 700) : t < 1600 ? seqView(t, 'thinking')
    : t < 3000 ? seqView(t, 'estimate', { speedValue: 128.6 }) : seqView(t, 'real', { speedValue: 201.4, latest: 201.4, phase: null });
  assert.deepEqual(e.tick(coordinator().pick, mid, 20, 3800), ['0:think|思考', '880:tool|读取', '1180:think|思考', '1780:bolt|'],   // 估算与完成态同面（v454）：签名相同不再单独记录
    '300ms 的工具有实际意义：照常显示，不被隐藏');
});

test('协调器只管展示时机：无定时器、不读会话存储、不含第二个 2 秒判定（目标 §7.5）', () => {
  const disp = getNamedSlice('speedDisp');
  assert.ok(!/setTimeout|setInterval|requestAnimationFrame/.test(disp), '不为速度格新建独立定时器');
  assert.ok(!/getState|\.store\b|tracker|subscribe/.test(disp), '只消费已算好的视图，不读 store');
  assert.ok(!/\b2000\b/.test(disp), '不加第二个 2 秒判定（思考中的识别条件只在状态机里）');
});

test('速度格全称两处来源分离：aria-label 取展示视图（不随高频速度更新反复播报），菜单全称取真实视图（保持最新）', () => {
  const m = faceHtml('zh');
  vm.runInNewContext(sliceOverlay('    /* 速度格全称：aria-label 供读屏', '    function ttH(t)') + '\n', Object.assign(m, { escAttr: s => String(s).replace(/"/g, '&quot;') }));
  assert.equal(m.zuSpeedCellAttrs('生成中（估算） 128.6 t/s', '生成中（估算） 173.4 t/s'),
    'aria-label="生成速度 生成中（估算） 128.6 t/s" data-zu-full="生成中（估算） 173.4 t/s"');
  assert.equal(m.zuSpeedCellAttrs('最近一段 87.3 t/s'), 'aria-label="生成速度 最近一段 87.3 t/s" data-zu-full="最近一段 87.3 t/s"', '缺省回退同一串');
  const cell = { dataset: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  m.zuSpeedCellSync(cell, '生成中（估算） 128.6 t/s', '生成中（估算） 173.4 t/s');
  m.zuSpeedCellSync(cell, '生成中（估算） 128.6 t/s', '生成中（估算） 199.9 t/s');
  assert.equal(cell.dataset.zuFull, '生成中（估算） 199.9 t/s', '菜单值随真实视图更新');
  assert.equal(cell.attrs['aria-label'], '生成速度 生成中（估算） 128.6 t/s', '读屏文案与格面同节奏：未变不重写');
});

/* ---------- 折叠段（12 分片）：速度格先降极窄再折叠 + 富余按真实内容宽 ---------- */
test('zuBarContentWidth：可见子项 rect 宽度和加 1px gap；折叠格与零宽项不计，可小于容器', () => {
  const kid = (width, folded) => ({ dataset: folded ? { zuFolded: folded } : {}, getBoundingClientRect: () => ({ width }) });
  const run = (kids) => vm.runInNewContext(getNamedSlice('speedContentWidth') + '\nzuBarContentWidth()', { main: { children: kids } });
  assert.equal(run([kid(100), kid(50)]), 151, '两格 + 1 个 gap');
  assert.equal(run([kid(100), kid(1), kid(50)]), 153, '分隔线是可见子项，照计（3 项 2 个 gap）');
  assert.equal(run([kid(100, '1'), kid(50)]), 50, '折叠格不计，也不贡献 gap');
  assert.equal(run([kid(100, '1'), kid(50, '1')]), 0, '全折叠 = 0（scrollWidth 给不出这个数）');
  assert.equal(run([kid(0), kid(50)]), 50, '零宽项（未布局）不计');
  assert.equal(run([]), 0);
});

function foldRun(W) {
  const mk = (key, w, minW) => ({ key, w, minW, dataset: { zuKey: key, zuFolded: '0' } });
  const rows = [mk('turn', 100), mk('win', 100), mk('speed', 77, 33)];
  const content = () => rows.reduce((a, el) => a + (el.dataset.zuFolded === '1' ? 0 : (el.dataset.zuSpeedMin === '1' ? el.minW : el.w)), 0);
  const main = {
    clientWidth: W,
    get scrollWidth() { return Math.max(content(), W); },   // 浏览器语义：scrollWidth 以 clientWidth 为下限（宿主实测）
  };
  const ctx = { rows, main, moreButton: { dataset: {} }, FOLD_HYS: 24,
    state: { barPriority: { turn: 'low', win: 'high', speed: 'high' } },
    zuBarContentWidth: content,   // 生产实现按可见子项 rect 求和；桩直接给内容宽
    syncSeparators() {}, L: (zh) => zh };
  vm.runInNewContext(getNamedSlice('barOrderHelpers') + '\n' + getNamedSlice('speedFoldLoop') + '\n', ctx);
  const speed = rows[2];
  return { rows, speed, minOn: ctx.speedMinOn, speedMin: speed.dataset.zuSpeedMin === '1',
    speedFolded: speed.dataset.zuFolded === '1', folded: rows.filter(r => r.dataset.zuFolded === '1').map(r => r.key) };
}

test('折叠段：装得下且富余≥24px 就停，不再多折一格（scrollWidth 以 clientWidth 为下限，旧判据从未成立）', () => {
  const a = foldRun(199);   // 277 → 折 turn(177≤200)；富余 22<24 → 再折 win
  assert.deepEqual(a.folded, ['turn', 'win'], '富余不足迟滞带：多折一格');
  const b = foldRun(200);   // 折 turn 后富余 23（含 +1 容差=24）→ 停
  assert.deepEqual(b.folded, ['turn']);
  const c = foldRun(120);   // 折 turn(177)→折 win(77≤121)，富余 43≥24：速度格原样保留
  assert.deepEqual(c.folded, ['turn', 'win']);
  assert.equal(c.speedMin, false); assert.equal(c.speedFolded, false); assert.equal(c.minOn, false);
});

test('折叠段：轮到速度格先降极窄；装得下且富余够就停在极窄', () => {
  const r = foldRun(60);    // 其余折尽后 77>61：降极窄 33≤61；解除极窄 77>37 不行 → 保持极窄；33≤37 富余够 → 不折
  assert.deepEqual(r.folded, ['turn', 'win']);
  assert.equal(r.speedMin, true, '速度格降到极窄'); assert.equal(r.speedFolded, false); assert.equal(r.minOn, true);
});

test('折叠段：极窄仍溢出或富余不足 FOLD_HYS 时照常折叠速度格（固定语义非豁免）', () => {
  const tiny = foldRun(30);    // 极窄 33>31：仍溢出 → 折叠
  assert.deepEqual(tiny.folded, ['turn', 'win', 'speed']);
  assert.equal(tiny.speedFolded, true);
  const tight = foldRun(50);   // 极窄装得下(33≤51)但富余 17<24 → 迟滞要求下仍折叠
  assert.deepEqual(tight.folded, ['turn', 'win', 'speed']);
});

test('折叠段：每轮从头重算——变宽后未轮到速度格，极窄与折叠都不留', () => {
  assert.equal(foldRun(60).speedMin, true);
  const wide = foldRun(110);   // 折 turn(177>111)→折 win(77≤111)，富余 33≥24：未轮到速度格
  assert.deepEqual(wide.folded, ['turn', 'win']);
  assert.equal(wide.speedMin, false); assert.equal(wide.speed.w, 77, '完整宽保留');
  const all = foldRun(260);    // 277>261：折 turn → 177≤261 富余 84 → 停
  assert.deepEqual(all.folded, ['turn']);
  assert.equal(all.rows[1].dataset.zuFolded, '0'); assert.equal(all.rows[2].dataset.zuFolded, '0');
});

test('折叠段：每轮重算开头清空上一轮的折叠集与速度格极窄（变宽后极窄靠这里解除，回展分支不负责）', () => {
  const mk = (ds) => ({ dataset: ds });
  const folded = mk({ zuFolded: '1', zuEndlead: '1', zuSpeedMin: '1' });   // 上一轮：极窄 + 折叠的速度格
  const plain = mk({ zuFolded: '1' });
  const clean = mk({ zuFolded: '0' });
  const rows = [folded, plain, clean], separators = [mk({ zuFolded: '1' })];
  const ctx = { rows, separators, moreButton: { dataset: { zuVisible: '1' } }, speedMinOn: true };
  vm.runInNewContext(getNamedSlice('speedFoldReset') + '\n', ctx);
  for (const r of rows) {
    assert.equal(r.dataset.zuFolded, '0'); assert.equal('zuEndlead' in r.dataset, false);
  }
  assert.equal('zuSpeedMin' in folded.dataset, false, '速度格极窄档随折叠集每轮从头重算');
  assert.equal(separators[0].dataset.zuFolded, '0');
  assert.equal(ctx.moreButton.dataset.zuVisible, '0');
  assert.equal(ctx.speedMinOn, false);
});

/* ---------- 药丸档位升降（12 分片）：条宽触顶降档、富余（含迟滞）够才升档 ---------- */
function pillEnv() {
  const W = [600, 552.4, 499.2];   // 宽裕 / 中等 / 紧张 三档的自然宽（升档判据按 3.4em、3.8em @14px = 47.6px、53.2px）
  const classes = new Set();
  const bar = {
    classList: { toggle: (k, on) => { if (on) classes.add(k); else classes.delete(k); } },
    getBoundingClientRect: () => ({ width: Math.min(W[tierOf()], avail) }),   // 条宽 = min(该档自然宽, 可用宽)
  };
  const tierOf = () => classes.has('zu-speed-tight') ? 2 : classes.has('zu-speed-mid') ? 1 : 0;
  let avail = 0;
  const ctx = { bar, Date: { now: () => 1e12 }, getComputedStyle: () => ({ fontSize: '14px' }) };
  vm.runInNewContext(getNamedSlice('speedPillTier') + '\n', ctx);
  return { sync: (a) => { avail = a; ctx.zuPillSpeedTierSync(Math.min(W[tierOf()], a), a); return tierOf(); }, tier: tierOf };
}

test('药丸档位：条宽触顶即降档（同帧降到底），不再被宽裕档撑到上限', () => {
  const e = pillEnv();
  assert.equal(e.sync(620), 0, '装得下：宽裕');
  assert.equal(e.sync(580), 1, '宽裕触顶→中等（552.4 装得下）');
  assert.equal(e.sync(540), 2, '中等仍触顶→紧张');
  assert.equal(e.sync(160), 2, '更窄：停在紧张档（原生横滚兜底）');
});

test('药丸档位：升档需「上一档宽度增量 + 24px 迟滞」都装得下，逐档回升不振荡', () => {
  const e = pillEnv();
  e.sync(540);
  assert.equal(e.tier(), 2);
  assert.equal(e.sync(570), 2, '紧张→中等需 499.2+53.2+24=576.4 ≤ 可用宽：570 不够');
  assert.equal(e.sync(580), 1, '580 够：升到中等');
  assert.equal(e.sync(580), 1, '稳定：不继续升（中等→宽裕需 624）');
  assert.equal(e.sync(630), 0, '630：升到宽裕');
  assert.equal(e.sync(630), 0);
  assert.equal(e.sync(540), 2, '再变窄：降回紧张');
  assert.equal(e.sync(630), 0, '再变宽：回到宽裕');
});

/* ---------- 精简速率 chip 档位（11 分片）：chip 先让位、不拿宿主自己的按钮换宽度；升档带迟滞与静默期 ---------- */
const TSB_EM = [12.4, 9.7, 6.6];   // 与 06 分片 .zu-tsb 三档规则同源（下方 CSS 锁交叉核对）
function tsbEnv({ host = true } = {}) {
  const classes = new Set(), toggles = [];
  const st = { lead: 400, content: 0, chipW: 0, tight: false, fs: '13px', now: 1e12, queries: 0 };
  const root = { dataset: {}, querySelector: (sel) => { st.queries++; assert.equal(sel, '[data-composer-compact]'); return st.tight ? {} : null; } };
  const lead = { parentElement: root, getBoundingClientRect: () => ({ width: st.lead }) };
  const content = { getBoundingClientRect: () => ({ width: st.content }) };
  const chip = {
    classList: { toggle: (k, on) => { toggles.push([k, on]); if (on) classes.add(k); else classes.delete(k); }, remove: (...ks) => ks.forEach(k => classes.delete(k)) },
    closest: (sel) => !host ? null : sel === '[data-composer-leading-actions]' ? lead : content,
    getBoundingClientRect: () => ({ width: st.chipW }),
  };
  const ctx = { Date: { now: () => st.now }, getComputedStyle: () => ({ fontSize: st.fs }), FOLD_HYS: 24 };
  vm.runInNewContext(getNamedSlice('tsbTier') + '\n', ctx);
  const tierOf = () => classes.has('zu-speed-tight') ? 2 : classes.has('zu-speed-mid') ? 1 : 0;
  const px = (t) => TSB_EM[t] * parseFloat(st.fs);
  /* 一次同步：chip 宽 = 当前档宽；其它内容宽度 = 前导区 − 空位（空位的定义与 chip 自身宽度无关） */
  const sync = (room, { tight = false, dt = 1000 } = {}) => {
    st.now += dt; st.tight = tight; st.chipW = px(tierOf()); st.content = st.chipW + (st.lead - room);
    toggles.length = 0;
    ctx.zuTsbTierSync(chip);
    return tierOf();
  };
  return { sync, tier: tierOf, st, ctx, chip, toggles, next: ctx.zuTsbTierNext };
}

test('精简 chip 档位纯函数：放不下就在同一次判定里降到装得下的那一档；宿主已在压缩则再让一档；升档需空位 ≥ 上一档宽度 + 迟滞且允许回升', () => {
  const { next } = tsbEnv();
  const W = TSB_EM.map(e => e * 13);   // 161.2 / 126.1 / 85.8
  assert.equal(next(0, false, W[0], 13, 24, true), 0, '宽裕装得下：不动');
  assert.equal(next(0, false, W[0] - 0.5, 13, 24, true), 1, '宽裕差 0.5px：降到中等');
  assert.equal(next(1, false, W[1] - 1, 13, 24, true), 2, '中等装不下：降到紧张');
  assert.equal(next(0, false, 100, 13, 24, true), 2, '宽裕、中等都装不下：同一次判定直接降到紧张（挂载当拍到位，宿主不必先压缩）');
  assert.equal(next(0, false, 20, 13, 24, true), 2, '连紧张档都放不下：停在紧张档，其余由宿主决定');
  assert.equal(next(2, false, -50, 13, 24, true), 2, '已是最窄档：不动');
  assert.equal(next(0, true, 400, 13, 24, true), 1, '宿主已在压缩自己的按钮：即使空位够也让位，且一次只让一档');
  assert.equal(next(1, true, 400, 13, 24, true), 2, '再让一档');
  assert.equal(next(0, true, 100, 13, 24, true), 2, '既放不下、宿主又在压缩：降到装得下的那一档为止');
  assert.equal(next(1, false, W[0] + 23, 13, 24, true), 1, '升档需空位 ≥ 上一档宽度 + 24px：差 1px 不升');
  assert.equal(next(1, false, W[0] + 24, 13, 24, true), 0, '够了：升到宽裕');
  assert.equal(next(2, false, W[1] + 23, 13, 24, true), 2, '紧张→中等同样带迟滞');
  assert.equal(next(1, false, 1000, 13, 24, false), 1, '静默期未过（刚降过档或刚见过压缩）：不升');
  assert.equal(next(2, true, 1000, 13, 24, false), 2, '宿主压缩中不升档');
  assert.equal(next(0, false, 200, 19, 24, true), 1, '档宽按 chip 字号换算：界面字号 20px 时宽裕档 235.6px，200px 装不下');
  assert.equal(next(0, false, 236, 19, 24, true), 0);
});

test('精简 chip 档位同步：挂载当拍即量、放不下就一步降到装得下的档位（先于宿主让位）；至多每 250ms 量一次；类名只在换档时写', () => {
  const e = tsbEnv();
  assert.equal(e.sync(161.2), 0, '首拍即量：空位正好等于宽裕档宽度，装得下');
  assert.equal(e.st.queries, 1, '首拍读了宿主压缩状态');
  assert.equal(e.sync(100, { dt: 249 }), 0, '250ms 内不重测（即使空间变了）');
  assert.equal(e.st.queries, 1);
  assert.equal(e.sync(100), 2, '宽裕、中等都装不下：同一拍直接降到紧张（chip 先让位，宿主不必压缩）');
  assert.deepEqual(e.toggles, [['zu-speed-mid', false], ['zu-speed-tight', true]], '换档只写两个档位类');
  e.sync(90);
  assert.deepEqual(e.toggles, [], '档位没变不写类名');
  assert.equal(e.sync(185.3, { dt: 500 }), 2, '刚降过档 1.5 秒：静默期（2 秒）内即使空间够了也不升');
  assert.equal(e.sync(185.3, { dt: 600 }), 1, '静默期满且 185.3 ≥ 中等档 + 24：升一档');
  assert.equal(e.sync(185.3), 0, '下一拍再升回宽裕（185.3 ≥ 161.2 + 24）');
});

test('精简 chip 档位同步：因放不下而降档后同样有静默期——同区的 Git/系统状态 chip 刚让出的空间不会被立刻抢回', () => {
  const e = tsbEnv();
  assert.equal(e.sync(170), 0);
  assert.equal(e.sync(140), 1, '宽裕放不下、中等装得下：降到中等');
  assert.equal(e.sync(200, { dt: 300 }), 1, '空间 0.3 秒后就够了：不升（两边同拍升档会撑破一行）');
  assert.equal(e.sync(200, { dt: 1800 }), 0, '静默期满且 200 ≥ 161.2 + 24：升回宽裕');
});

test('精简 chip 档位同步：宿主压缩 → 让位；宿主因让位而展开后不会升回去（否则两边拉锯）', () => {
  const e = tsbEnv();
  assert.equal(e.sync(170), 0, '宽裕档 161.2 装得下');
  assert.equal(e.sync(300, { tight: true }), 1, '宿主开始压缩自己的按钮（压缩后量到的空位反而变大）：chip 仍让一档');
  assert.equal(e.sync(150), 1, '宿主因 chip 让位而展开：真实空位 150 < 宽裕档 + 24，不升回');
  assert.equal(e.sync(150, { dt: 3000 }), 1, '静默期过后同样不升——升回宽裕宿主就得再压缩');
  assert.equal(e.sync(200, { dt: 3000 }), 0, '窗口拉宽到 200（≥ 161.2 + 24）：升回宽裕');
  assert.equal(e.sync(200), 0, '升回后稳定');
});

test('精简 chip 档位同步：见过宿主压缩后 2 秒内不升档（静默期），期满后仍要空位 ≥ 上一档 + 迟滞', () => {
  const e = tsbEnv();
  assert.equal(e.sync(150), 1);
  assert.equal(e.sync(150, { tight: true }), 2, '宿主因别的原因压缩：再让一档');
  assert.equal(e.sync(160), 2, '宿主展开后 1 秒内不升');
  assert.equal(e.sync(160, { dt: 1000 }), 1, '静默期满（2 秒）且 160 ≥ 中等档 126.1 + 24：升回中等');
  assert.equal(e.sync(160), 1, '160 < 宽裕档 161.2 + 24：不再升');
});

test('精简 chip 档位同步：前导区尚无尺寸不判定；找不到宿主前导区回到不分档', () => {
  const e = tsbEnv();
  e.st.lead = 0; e.st.content = 0; e.st.chipW = 0;
  e.sync(0);
  assert.equal(e.st.queries, 0, '窗口最小化/后台分栏（宽度为 0）：不读压缩状态、不降档');
  e.st.lead = 400;
  assert.equal(e.sync(100), 2, '有尺寸后照常判定，一步降到装得下的档位（上一拍没有消耗测量窗）');
  const noHost = tsbEnv({ host: false });
  noHost.sync(10);
  assert.equal(noHost.st.queries, 0, '无宿主前导区：不测量');
  assert.equal(noHost.tier(), 0, '保持宽裕档');
});

/* ---------- 窄宽探针：测量签名剔除速度格面与全称属性 ---------- */
function probeKey(html) {
  const face = source.match(/var ZU_SPEED_FACE_KEY_RE = (\/.*?\/);/);
  const attrs = source.match(/var ZU_SPEED_FULL_ATTRS_RE = (\/.*?\/);/);
  assert.ok(face && attrs, 'probe regexes declared');
  const faceRe = new Function('return ' + face[1])(), attrsRe = new Function('return ' + attrs[1])();
  return html.replace(attrsRe, '').replace(faceRe, '$1</span>');
}

test('窄宽探针测量签名剔除速度格面与全称属性：状态切换/计时/速度走字都不触发整条克隆重测', () => {
  const cell = (label, value, unit) => '<span tabindex="0" class="it zu-speed" data-zu-key="speed" aria-label="生成速度 ' + label + value + '" data-zu-full="' + label + value + '">' +
    '<svg class="ico"></svg><span class="zu-live dim"><span class="zu-sp-label">' + label + '</span><span class="zu-sp-val">' + value + '</span>' +
    (unit ? '<span class="zu-sp-unit dim">' + unit + '</span>' : '') + '</span></span>';
  const other = '<span tabindex="0" class="it" data-zu-key="turn"><span class="v">4.68万</span></span>';
  const k1 = probeKey(other + cell('查阅', '03s', ''));
  assert.equal(probeKey(other + cell('查阅', '04s', '')), k1, '计时走字：签名不变');
  assert.equal(probeKey(other + cell('生成', '≈173.4', 't/s')), k1, '状态切换：签名不变');
  assert.equal(probeKey(other + cell('思考', '1:05:00', '')), k1, '状态切换：签名不变');
  assert.ok(k1.startsWith(other), '其余格原样入键');
  assert.ok(!/03s|173\.4|1:05:00|生成速度/.test(k1), '速度面文字与全称属性不入键');
  assert.ok(k1.includes('<span class="zu-live dim"></span>'), '包装层保留为空壳');
  assert.notEqual(probeKey(other.replace('4.68万', '12.3万') + cell('查阅', '03s', '')), k1, '其它格数字变化仍触发重测');
});

/* ---------- 原地换图标（updateLive 切片） ---------- */
function swapEnv({ cellReachable = true, phase = 'tool' } = {}) {
  const calls = { render: 0, sync: [], icons: [] };
  const cell = { _html: '', dataset: {}, __tip: 'OLD' };
  const mkLive = (html) => ({ innerHTML: html, className: (html.match(/class="(zu-live[^"]*)"/) || [])[1],
    closest: sel => (sel === '.it' ? cell : null) });
  Object.defineProperty(cell, 'innerHTML', { set(v) { this._html = v; this.__live = mkLive(v.slice(v.indexOf('<span class="zu-live'))); }, get() { return this._html; } });
  cell.querySelector = sel => (sel === '.zu-live' ? cell.__live : null);
  const liveEl = { innerHTML: '<span class="zu-sp-label">思考</span><span class="zu-sp-val">03s</span>', className: 'zu-live dim zu-shimmer',
    closest: sel => (sel === '.it' && cellReachable ? cell : null) };
  const view = { cls: 'dim', text: '读取中 1.2s', phase, kind: phase === 'tool' ? 'tool' : 'estimate', word: phase === 'tool' };
  const sandbox = {
    L: (zh) => zh, Date: { now: () => 5000 },
    state: { rateLine: true, theme: 'default', data: {} }, lastView: null,
    bridge: { turnId: 'turn_x', timer: null, handle: { dead: false, charsPerToken: 2, tracker: { get: () => ({ complete: false }) } } },
    sideHandleValid: () => true, bridgeDetach: () => {}, subRateTick: () => {}, subRunningList: () => [],
    synthesizeBackgroundStats: s => s, renderSubAgentRows: () => {}, subRate: { sum: null },
    zuBarSpeedView: () => view,
    zuSpeedIconHtml: ph => { calls.icons.push(ph); return '<svg class="ico ' + (ph === 'tool' ? 'WRENCH' : 'BOLT') + '"></svg>'; },
    zuSpeedFaceHtml: v => '<span class="zu-sp-label">' + (v.word ? '读取' : '生成') + '</span><span class="zu-sp-val">01s</span>',
    zuSpeedCellSync: (c, t) => calls.sync.push([c, t]),
    buildLiveTip: v => 'TIP:' + v.text,
    syncTpsChip: () => {}, liveKindCur: 'live', livePhaseCur: 'thinking', liveStatsCur: null,
    liveTextCur: '', liveIconCur: 'think', liveEl, tipFor: { __tip: 'OTHER' }, drawTip: () => {},
    render: () => { calls.render++; },
  };
  vm.runInNewContext(getNamedSlice('updateLive') + '\nupdateLive;', sandbox)();
  return { calls, cell, sandbox, liveEl };
}

test('原地换图标：相位切换只重写本格，不整条重渲染；图标/面/全称/锚点同拍更新', () => {
  const r = swapEnv({ phase: 'tool' });
  assert.equal(r.calls.render, 0, '相位切换不再整条 render');
  assert.deepEqual(r.calls.icons, ['tool']);
  assert.ok(r.cell.innerHTML.startsWith('<svg class="ico WRENCH"></svg><span class="zu-live dim zu-shimmer">'), r.cell.innerHTML);
  assert.notEqual(r.sandbox.liveEl, r.liveEl, 'liveEl 重挂到新节点');
  assert.equal(r.sandbox.liveEl.className, 'zu-live dim zu-shimmer');
  assert.equal(r.sandbox.livePhaseCur, 'tool');
  assert.equal(r.sandbox.liveIconCur, 'tool');
  assert.deepEqual(r.calls.sync, [[r.cell, '读取中 1.2s']], '全称（aria/data-zu-full）同步到同一格元素');
  assert.equal(r.cell.__tip, 'TIP:读取中 1.2s', 'tooltip 锚点仍是同一格元素，内容取真实视图');
});

test('原地换图标：完成态相位（空串）同样原地回落闪电', () => {
  const r = swapEnv({ phase: null });
  assert.equal(r.calls.render, 0);
  assert.deepEqual(r.calls.icons, ['']);
  assert.equal(r.sandbox.liveIconCur, 'bolt');
  assert.equal(r.sandbox.livePhaseCur, '');
});

test('原地换图标：找不到格元素（VM 字符串回放夹具）时回退整条渲染，不抛错', () => {
  const r = swapEnv({ phase: 'tool', cellReachable: false });
  assert.equal(r.calls.render, 1);
  assert.deepEqual(r.calls.sync, []);
  assert.equal(r.cell.innerHTML, '');
});

/* ---------- CSS 与接线锁（结构级；几何由真实宿主实测验收） ---------- */
test('药丸升档判据的宽度增量估计 ≥ 各界面字号下的真实档宽差（偏小=升档后触顶再降档，来回振荡）', () => {
  const start = source.indexOf('速度格稳定占位（specs/speed-chip-stable-slot.md）：外宽只随布局档位变');
  const css = source.slice(start, source.indexOf('.zusage-root .eb .ico{width:12px', start));
  const em = (rule) => { const m = /width:([\d.]+)em/.exec(rule); assert.ok(css.includes(rule) && m, rule); return Number(m[1]); };
  const wideRule = '.zusage-root .zu-main>.it.zu-speed{box-sizing:border-box;width:6.6em;overflow:hidden}';
  assert.ok(css.includes(wideRule), wideRule);
  /* v459：全部格面固定宽 6.6em（随格字号缩放）——档宽差只剩缩字号差 */
  const slotPx = (fs) => 6.6 * fs;
  const wide = slotPx(14);
  /* 药丸条上没有 zu-tight 类：紧张档规则必须自带同一套缩字号公式与左内边距/间距，否则按 14px 算、数值越界；
   * 右内边距 v459 起为 0（移到格外右外边距），默认条靠 :not([data-zu-speed-min]) 规则覆盖窄档的 4px */
  const ruleOf = (sel) => css.slice(css.indexOf(sel), css.indexOf('}', css.indexOf(sel)));
  const tightRule = ruleOf('.zusage-root.zu-pill.zu-speed-tight .zu-main>.it.zu-speed{'), midRule = ruleOf('.zusage-root.zu-pill.zu-speed-mid .zu-main>.it.zu-speed{');
  const narrowRule = source.slice(source.indexOf('.zusage-root.zu-tight .zu-main>.it{'), source.indexOf('}', source.indexOf('.zusage-root.zu-tight .zu-main>.it{')));   // 默认条窄档规则在稳定占位块之前，从整份源码取
  for (const decl of ['font-size:min(var(--ui-font-size,14px),max(11px,calc(var(--ui-font-size,14px) - 2px)))', 'padding-left:4px', 'gap:3px']) {
    assert.ok(narrowRule.includes(decl) && tightRule.includes(decl) && midRule.includes(decl), `药丸中等/紧张档与默认条窄档同款：${decl}`);
  }
  for (const rule of [tightRule, midRule]) assert.ok(rule.includes('padding-right:0'), `药丸中等/紧张档右内边距为 0（v459）：${rule}`);
  const narrowFs = (ui) => Math.min(ui, Math.max(11, ui - 2));   // 紧张档字号公式（同 zu-tight；药丸条字号=界面字号）
  const est = /pillSpeedTier === 2 \? ([\d.]+) : ([\d.]+)\) \* pillSpeedEm \+ 24 <= avail/.exec(source);
  assert.ok(est, '升档判据在位');
  // v459 固定宽后真实增量只剩宽裕→中段的字号差（wide=6.6em×ui、mid/tight=6.6em×narrowFs(ui)），估计值富余即安全
  const realWideToMid = (ui) => (slotPx(ui) - slotPx(narrowFs(ui))) / ui, realMidToTight = () => 0;
  let worstA = 0, worstB = 0;
  for (let ui = 11; ui <= 40; ui++) {
    worstA = Math.max(worstA, realWideToMid(ui)); worstB = Math.max(worstB, realMidToTight(ui));
  }
  assert.ok(worstB <= Number(est[1]) + 1e-9, `中等→紧张真实增量上界 ${worstB.toFixed(3)}em ≤ 估计 ${est[1]}em`);
  assert.ok(worstA <= Number(est[2]) + 1e-9, `宽裕→中等真实增量上界 ${worstA.toFixed(3)}em ≤ 估计 ${est[2]}em`);
  /* 固定宽后增量只剩宽裕→中段的字号差（最大 13.2px），估计值富余即安全 */
});

test('速度格占位 CSS：全部格面固定宽 6.6em、右内边距 0、右侧分隔线间隙 +10px（v459）、状态词与数值之间无间隔点（v460）、左内边距 0（v462），极窄档固定', () => {
  const start = source.indexOf('速度格稳定占位（specs/speed-chip-stable-slot.md）：外宽只随布局档位变');
  assert.ok(start >= 0, 'speed slot CSS block present');
  const css = source.slice(start, source.indexOf('.zusage-root .eb .ico{width:12px', start));
  for (const rule of [
    '.zusage-root .zu-main>.it.zu-speed{box-sizing:border-box;width:6.6em;overflow:hidden}',
    ".zusage-root .zu-main>.it.zu-speed:not([data-zu-speed-min='1']){padding-right:0}",
    ".zusage-root:not(.zu-pill) .zu-main>.it.zu-speed:not([data-zu-speed-min='1']){padding-left:0}",
    ".zusage-root:not(.zu-pill) .zu-main>.it.zu-speed:not([data-zu-speed-min='1'])+.sep{box-sizing:content-box;padding-left:10px;background-clip:content-box}",
    '.zusage-root.zu-pill .zu-main>.it.zu-speed{margin-right:7px}',
    ".zusage-root .zu-main>.it.zu-speed[data-zu-speed-min='1']{width:2.75em}",
    ".zusage-root.zu-narrow .it.zu-speed:has(>.zu-live>.zu-sp-label:empty)>.zu-live>.zu-sp-unit{display:block}",
    ".zusage-root.zu-pill.zu-speed-tight .it.zu-speed:has(>.zu-live>.zu-sp-label:empty)>.zu-live>.zu-sp-unit{display:block}",
    ".zusage-root.zu-narrow.zu-sp-roomy .it.zu-speed>.zu-live>.zu-sp-label:not(:empty),.zusage-root.zu-narrow.zu-sp-roomy .it.zu-speed>.zu-live>.zu-sp-unit{display:block}",
    ':is(.zusage-root .it.zu-speed,.zu-tsb)>.zu-live{display:flex;flex:1 1 auto;min-width:0;align-items:baseline}',
    ':is(.zusage-root .it.zu-speed,.zu-tsb)>.zu-live>.zu-sp-label{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left}',
    ':is(.zusage-root .it.zu-speed,.zu-tsb)>.zu-live>.zu-sp-label:empty{display:none}',
    ':is(.zusage-root .it.zu-speed,.zu-tsb)>.zu-live>.zu-sp-val{flex:0 0 auto;white-space:nowrap;text-align:left}',
    ".zusage-root.zu-narrow .it.zu-speed>.zu-live>.zu-sp-label,.zusage-root.zu-narrow .it.zu-speed>.zu-live>.zu-sp-unit{display:none}",
    ".zusage-root .zu-main>.it.zu-speed[data-zu-speed-min='1']>.zu-live{display:none}",
    '.zusage-root.zu-pill.zu-speed-mid .zu-main>.it.zu-speed{padding-left:4px;padding-right:0;margin-right:4px;gap:3px;font-size:min(var(--ui-font-size,14px),max(11px,calc(var(--ui-font-size,14px) - 2px)))}',
    '.zusage-root.zu-pill.zu-speed-tight .zu-main>.it.zu-speed{padding-left:4px;padding-right:0;margin-right:4px;gap:3px;font-size:min(var(--ui-font-size,14px),max(11px,calc(var(--ui-font-size,14px) - 2px)))}',
    '.zusage-root.zu-pill.zu-speed-tight .it.zu-speed>.zu-live>.zu-sp-label,.zusage-root.zu-pill.zu-speed-tight .it.zu-speed>.zu-live>.zu-sp-unit{display:none}',
  ]) assert.ok(css.includes(rule), rule);
  /* v462 左内边距 0（用户指示「左侧的 padding 也去掉」）只作用于默认条：规则必须带 :not(.zu-pill)——药丸有底色与 12px 圆角，
   * 图标靠左内边距（宽裕 7px 来自基础 .it，中等/紧张 4px）离边缘；也不能做成「左内边距改左外边距」（中等/紧张档的 4px 左内边距
   * 抵消不了，会多推 7px）。仅图标档保留两侧内边距（图标靠左，不居中）。 */
  assert.ok(!css.includes(".zusage-root .zu-main>.it.zu-speed:not([data-zu-speed-min='1']){padding-left:0}"), '左内边距 0 规则不得作用于药丸');
  /* 逐条看药丸速度格规则（选择器去掉 :not(...) 组再判，否则 :not(.zu-pill) 自己会被当成药丸） */
  let pillRules = 0;
  for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/\.it\.zu-speed/.test(sel) || !/\.zu-pill/.test(sel.replace(/:not\([^)]*\)/g, ''))) continue;
    pillRules += 1;
    assert.ok(!/padding-left:0(?:;|$)/.test(body), `药丸速度格规则不得把左内边距清零：${sel}{${body}}`);
  }
  assert.ok(pillRules >= 3, `药丸速度格规则应被逐条核对（看到 ${pillRules} 条）`);
  assert.ok(!/\.it\.zu-speed\[data-zu-speed-min='1'\]\{[^}]*padding-left:0/.test(css), '仅图标档保留左内边距');
  /* v459：没有下限/上限区间——v455/v456 的 min-width/max-width 与 calc(38px + 4.8em) 上限、更早的 12.6/10.9em 档位宽都不再存在 */
  assert.ok(!/[;{]\s*(max-width|width):calc\(38px \+ 4\.8em\)/.test(css), 'v456 上限公式已废（只剩注释里的历史记录）');
  assert.ok(!/[;{]width:12\.6em|[;{]width:10\.9em|max-width:12\.6em|max-width:10\.9em/.test(css), '12.6/10.9em 档位上限已废除');
  assert.ok(!/\.it\.zu-speed[^{]*\{[^}]*max-width/.test(css), '速度格不再有 max-width（固定宽）');
  assert.ok(!css.includes('.zusage-root.zu-narrow .zu-main>.it.zu-speed{width:auto;min-width:7.2em}'), '窄档固定宽度规则已删');
  assert.ok(!css.includes(":has(>.zu-live>.zu-sp-label:empty){width:auto;min-width:6.6em}"), '完成态专用宽度规则已并入基础');
  assert.ok(!css.includes('.zu-sp-roomy .zu-main>.it.zu-speed:has('), 'roomy 不再改宽度（只管显示）');
  /* 分隔线间隙必须自带 box-sizing:content-box：.sep 是 border-box，只加内边距会把 1px 的线压成 0 宽（实机实验抓到） */
  const sepRule = css.slice(css.indexOf('.it.zu-speed:not([data-zu-speed-min=\'1\'])+.sep{'), css.indexOf('}', css.indexOf('.it.zu-speed:not([data-zu-speed-min=\'1\'])+.sep{')));
  assert.ok(/box-sizing:content-box.*padding-left:10px.*background-clip:content-box/.test(sepRule), `分隔线间隙规则三件缺一不可：${sepRule}`);
  assert.ok(!/\.it\.zu-speed[^{]*\+\.sep\{[^}]*margin/.test(css), '分隔线间隙不写 margin：折叠判据 zuBarContentWidth 不计外边距');
  /* v460：状态词与数值之间不画间隔点——v446 的「 · 」连内边距占 16px，固定宽 6.6em 里带数值的两字状态词全被省略成「思…」「执…」；
   * 基础 ::after 规则与窄档/药丸中等两条去分隔符规则都已删，加回任何一条都会让两字状态词重新被省略 */
  assert.ok(!/\.it\.zu-speed[^{]*::after/.test(css), '状态词与数值之间不画间隔点（v460）：速度格标签不得再有 ::after 规则');
  assert.ok(!source.includes('.zu-sp-label:not(:empty)::after'), '全文件不再有速度格标签的 ::after 间隔点规则（含窄档/药丸中等的去分隔符规则）');
  const tsbStart = source.indexOf('".zu-tsb{display:inline-flex;');
  const tsbCss = source.slice(tsbStart, source.indexOf('.zu-tsb:hover', tsbStart));
  const tsbEm = (rule) => { const m = /width:([\d.]+)em/.exec(rule); assert.ok(tsbCss.includes(rule) && m, rule); return Number(m[1]); };
  const tsbWide = tsbEm('"box-sizing:border-box;width:12.4em;"'), tsbMid = tsbEm('.zu-tsb.zu-speed-mid{width:9.7em}'), tsbTight = tsbEm('.zu-tsb.zu-speed-tight{width:6.6em}');
  assert.deepEqual([tsbWide, tsbMid, tsbTight], TSB_EM, '精简 chip 三档（固定宽）与判定常量 ZU_TSB_TIERS 同源');
  assert.deepEqual([tsbWide, tsbMid, tsbTight].map(e => Math.round(e * 13 * 10) / 10), [161.2, 126.1, 85.8], '精简 chip 三档不随本次改动（工具行场景仍是固定档）');
  assert.ok(!tsbCss.includes('.zu-tsb.zu-speed-tight>.zu-live{justify-content:flex-end}'), '精简紧张档数值不再靠右（成组靠左）');
  assert.ok(!/\.zusage-root[^{]*\.zu-tsb\.zu-speed-(mid|tight)/.test(source), '精简档位类不作用于状态条');
  assert.ok(!css.includes('transition'), '不得用 width transition 掩盖跳动');
  assert.ok(!/\.it\.zu-speed[^{]*\{[^}]*min-width:(?!0)/.test(css), '速度格规则不再有 min-width（固定宽；只剩 .zu-live 的 min-width:0）');
  assert.ok(!/min-width:\s*\d{3}/.test(css), '不得靠统一大 min-width 敷衍');
});

test('接线锁：tooltip 读真实视图、探针剥离、菜单读全称、折叠清理与富余测量', () => {
  assert.ok(source.includes('var tip1 = buildLiveTip(rview);'), 'tooltip 构建读真实视图（不受格面节流影响）');
  assert.ok(source.includes('liveCell.__zuTipView = rview;'), '失鲜标记记真实视图');
  assert.ok(source.includes('buildLiveTip(speedRaw), "zu-speed", zuSpeedCellAttrs(speedView.text, speedRaw && speedRaw.text))'), '整条渲染：tooltip 真实视图 + 面展示视图 + aria-label 取展示视图 / data-zu-full 取真实视图');
  assert.ok(source.includes('zuSpeedCellSync(liveCell, view.text, rview && rview.text);'), '原地更新：aria-label 取展示视图（不随 10Hz 速度更新反复播报）、菜单全称取真实视图（保持最新）');
  assert.ok(source.includes('probeMain.querySelectorAll("[data-zu-speed-min]")'), '探针剥速度格极窄档（防正反馈震荡环）');
  assert.ok(source.includes('el.removeAttribute("data-zu-speed-min")'), '探针剥的是极窄档属性本身（删错属性时震荡环修复失效）');
  assert.ok(source.includes('if (probeSpLabel && !probeSpLabel.textContent) probeSpLabel.textContent = "占位";'), '探针给完成态的空标签填占位：整条选档恒按有状态词的档位占位量，不随完成态升降档');
  /* 窄档真实空位：只在默认样式的窄档、既有 250ms 检查里判定；空位不含速度格自身；升档带 FOLD_HYS、保持只需装得下；切主题摘除 */
  const roomyAt = source.indexOf('var speedRoomy = false;');
  assert.ok(roomyAt > source.indexOf('if (state.theme === "default" && main.clientWidth > 0 && Date.now() - narrowCheckAt >= 250)') && roomyAt < source.indexOf('var rightClip = state.theme === "default" && main.scrollLeft', roomyAt), '真实空位判定在 250ms 窄宽检查块内');
  assert.ok(source.includes('if (shrink === 2 && speedRoomOthers > 0) {\n            var speedCell = main.querySelector(".it.zu-speed");'), '只在窄档、且探针已量到其它格窄面宽时判定');
  assert.ok(source.includes('var speedLeft = room - speedRoomOthers;'), '空位 = 容器宽 − 其它格未折叠时的窄面宽（探针量得，不看当前折叠后的宽）');
  assert.ok(source.includes('speedRoomOthers = probeMain.getBoundingClientRect().width - (probeSpeedCell ? probeSpeedCell.getBoundingClientRect().width : 0);'), '探针第三档：窄档总宽减去速度格自己的紧凑占位');
  assert.ok(!source.includes('speedLeft = room - (zuBarContentWidth()'), '空位不读其它格当前占的宽（折叠后会变大，与回展互相触发）');
  assert.ok(source.includes('var speedNeed = 6.6 * parseFloat(getComputedStyle(speedCell).fontSize) + 10;'), 'roomy 阈值与速度格固定宽 6.6em、分隔线间隙 10px 同源（v459）');
  assert.ok(!source.includes('38 + 4.8 * parseFloat'), 'v456 上限公式已废');
  assert.ok(source.includes('speedRoomy = speedLeft >= speedNeed + (bar.classList.contains("zu-sp-roomy") ? 0 : FOLD_HYS);'), '升档带迟滞、保持只需装得下');
  assert.ok(source.includes('main.innerHTML.replace(ZU_SPEED_FULL_ATTRS_RE, "").replace(ZU_SPEED_FACE_KEY_RE, "$1</span>")'), '测量签名剔除速度格面与全称属性');
  assert.ok(source.includes('value.textContent = (el.dataset && el.dataset.zuFull) || (el.textContent || "").trim();'), '菜单项读完整状态词');
  assert.ok(source.includes('var v = (el.dataset && el.dataset.zuFull) || (el.textContent || "").trim();'), '菜单项随拍同步完整状态词');
  assert.ok(source.includes('if (speedMinOn) { main.querySelectorAll("[data-zu-speed-min]")'), '离开折叠态清理极窄档');
  assert.ok(source.includes('aria-label="\' + escAttr(zuSpeedAria(full))'), '格带完整 aria-label');
  /* 状态图标是装饰：含义由格面文字与 aria-label 承载，读屏不重复播报图标 */
  assert.ok(/function ico\(paths\) \{\s*return '<svg class="ico" [^>]*aria-hidden="true">'/.test(source), '扳手/闪电图标 aria-hidden');
  assert.ok(/'<svg class="ico zu-think" [^>]*aria-hidden="true">'/.test(source), '思考图标 aria-hidden');
  assert.ok(!/zuSpeedFaceHtml[\s\S]{0,400}<svg/.test(source.slice(source.indexOf('function zuSpeedFaceHtml'), source.indexOf('function zuSpeedAria'))), '精简 chip 的面不带图标（含义由标签文字与 aria-label 承载）');
  assert.ok(source.includes('return { kind: "live", sv: sv, face: dsv };'), '精简 chip：面用展示视图、tooltip 用真实视图');
  assert.ok(source.includes('      if (tpsTipFor === chip) showTpsTip(chip);   // 悬停中随心跳/推送刷新：签名不变不重建\n      zuTsbTierSync(chip);'), '精简 chip：每次同步末尾跑档位（内部限频至多 250ms 一次）');
  assert.ok(source.includes('        tsbTier = 0; tsbTierAt = 0;'), '精简 chip：新挂或换宿主时档位从头量');
  assert.ok(source.includes('if (!(leadW > 0)) return;'), '精简 chip：前导区尚无尺寸不判定');
  /* 折叠富余测量：已折叠且未溢出时按内容宽取富余；重算与基线同口径（否则逐帧重算） */
  assert.ok(source.includes('var mainW = main.clientWidth;'), 'mainW 就是 .zu-main 本帧 clientWidth');
  assert.ok(source.includes('var ovNow = main.scrollWidth - mainW;'), 'per-frame overflow from mainW');
  assert.ok(source.includes('if (foldedKeys && ovNow <= 1) ovNow = zuBarContentWidth() - mainW;'), 'per-frame slack from content width');
  assert.ok(source.includes('foldTrigger = foldedKeys ? zuBarContentWidth() - main.clientWidth <= 1 - FOLD_HYS : ovEnd > 1;'), 'fold trigger baseline uses content width');
  assert.ok(source.includes('for (; fi < candidates.length && zuBarContentWidth() > main.clientWidth + 1; fi++) {'), 'fold loop overflow check uses content width');
  assert.ok(!source.includes('main.scrollWidth <= main.clientWidth + 1 - FOLD_HYS'), 'scrollWidth 以 clientWidth 为下限，不得再用它判富余');
  assert.ok(source.includes('zuPillSpeedTierSync(width, available);'), '药丸档位升降挂在药丸 track 帧');
  assert.ok(source.includes('bar.classList.remove("zu-speed-mid", "zu-speed-tight", "zu-sp-roomy");'), '切主题重置药丸档位类与窄档真实空位标记');
  assert.ok(source.includes('mainW === foldMainW'), '折叠门口同时记 .zu-main 自身宽度');
  assert.ok(source.includes('"zu-in", "zu-just-end", "zu-speed-mid", "zu-speed-tight", "zu-sp-roomy");'), '探针克隆剥药丸速度格档位类与窄档真实空位标记（残留会把自然宽量小）');
  assert.ok(source.includes('var cls = "zu-live " + (v.kind === "live" ? fv.cls + (fv.word ? " zu-shimmer" : "")'), '精简 chip：档位色取展示视图');
  assert.ok(source.includes('var face = zuSpeedFaceHtml(fv, true);'), '精简 chip：面数值取同一个展示视图（数值与颜色同快照），并传 autoWidth=true（v464：长计时面保留状态词）');
  assert.ok(source.includes('var txt = v.kind === "live" ? v.sv.text :'), '精简 chip：全称读真实视图');
  assert.ok(!source.includes('backEl.dataset.zuSpeedMin'), '回展分支不处理极窄：同轮「解除后富余够」不可达（降极窄前提是完整宽溢出），靠每轮开头清空');
  assert.ok(!source.includes('zuLiveFaceHtml('), '旧面构建函数无残留');
});
