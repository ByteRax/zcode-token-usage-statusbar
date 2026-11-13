/* 油猴接收端（docs/zusage-mobile.user.js）0.5.0 编译产物契约：
 * 手机端不再自渲染，加载桌面插件同一份 overlay.js，把中继帧里的 zusage 快照
 * 喂给它的 window.__zusageUpdate（样式/图标/完整 ⚙ 设置面板/tooltip 全量同源）；
 * overlay 加载失败回落旧 chips 条。
 * 0.5.0 起产物由 scripts/build_mobile_userscript.py 从 src/mobile/ 分片 + 桌面分片
 * 锚点提取生成（specs/mobile-userscript-build.md）——本文件同时锁产物注入段与
 * 桌面分片锚点的存在性（锚点被桌面重构删除时，即使不跑构建，Node 回归也红）。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'docs', 'zusage-mobile.user.js'), 'utf8');
const uiShard = fs.readFileSync(path.join(ROOT, 'src', 'mobile', '40-fallback-ui.js'), 'utf8');
const ovl06 = fs.readFileSync(path.join(ROOT, 'src', 'overlay', '06-instance-dom-and-styles.js'), 'utf8');
const ovl07 = fs.readFileSync(path.join(ROOT, 'src', 'overlay', '07-instance-render-and-tips.js'), 'utf8');
const mobileSrcDir = path.join(ROOT, 'src', 'mobile');

test('loads desktop overlay.js from CDN with raw fallback', () => {
  assert.match(source, /cdn\.jsdelivr\.net\/gh\/ByteRax\/zcode-token-usage-statusbar@main\/overlay\.js/);
  assert.match(source, /raw\.githubusercontent\.com\/ByteRax\/zcode-token-usage-statusbar\/main\/overlay\.js/);
  assert.match(source, /function loadOverlay\(\)/);
});

test('snap frames feed the desktop overlay via window.__zusageUpdate', () => {
  assert.match(source, /if \(body\.snap\) applySnap\(body\);/);
  assert.match(source, /d\.mine = \(body\.target && body\.target\.taskId\) \|\| body\.mine \|\| "";/);
  assert.match(source, /window\.__zusageUpdate\(d\);/);
  assert.match(source, /if \(root\) root\.style\.display = "none";/);   // 桌面条接管后隐藏旧条
});

test('falls back to legacy chips bar when overlay fails to load', () => {
  assert.match(source, /overlayLoading = false; renderDebug\(\); render\(\); return;/);
  assert.match(source, /if \(root\) root\.style\.display = "";/);
});

test('debug panel reports desktop overlay load state', () => {
  assert.match(source, /desktop overlay  : /);
});

test('product carries no build placeholders', () => {
  // 只断言可执行替换点形态——分片注释里的占位符名是文档，会随产物保留
  for (const p of ['"__ZM_CELL_CSS__"', '"__ZM_BAND_CSS__"', 'var ICONS = __ZM_ICONS__',
    'var SHOW_ROWS = __ZM_SHOW_ROWS__', 'var DEBUG_BUILD = __ZM_DEBUG__']) {
    assert.ok(!source.includes(p), `产物残留占位符 ${p}（手改产物或构建漏替换）`);
  }
});

test('release/debug variants differ only in the build switch and metadata', () => {
  const dbg = fs.readFileSync(path.join(ROOT, 'docs', 'zusage-mobile.debug.user.js'), 'utf8');
  assert.match(source, /var DEBUG_BUILD = false;/);          // 正式版：零调试痕迹
  assert.ok(!source.includes('·调试版'));
  assert.match(dbg, /var DEBUG_BUILD = true;/);              // 调试版：默认显示排障面板
  assert.match(dbg, /@name         ZCode 用量状态条（远控中继接收端·调试版）/);   // 篡改猴按 name+namespace 识别身份
  assert.match(dbg, /@noframes/);
});

test('debug DOM creation is guarded by DEBUG_BUILD (feature notices stay unguarded)', () => {
  const ui = fs.readFileSync(path.join(mobileSrcDir, '40-fallback-ui.js'), 'utf8');
  assert.match(ui, /if \(DEBUG_BUILD\) \{\s*\n\s*dbg = document\.createElement\("div"\);/);   // 面板+☰ 只在调试变体创建
  assert.match(ui, /if \(!DEBUG_BUILD \|\| !dbg \|\| !prefs\.debug\) return;/);               // renderDebug 守卫
  assert.match(ui, /if \(DEBUG_BUILD\) toggle\.style\.display = "block";/);                   // ☰ 随首帧数据出现
  // 「未捕获中继连接，请刷新页面」是功能提示，不属于调试面板：正式版保留在状态条上
  assert.match(ui, /未捕获中继连接（注入过晚），请刷新页面/);
});



test('v346：上行配置门控存在，且不新增任何设置块', () => {
  const ui = fs.readFileSync(path.join(mobileSrcDir, '40-fallback-ui.js'), 'utf8');
  const loader = fs.readFileSync(path.join(mobileSrcDir, '20-overlay-loader.js'), 'utf8');
  // 上行：配置载荷 = overlay 的 zusage3 显示偏好（复用桌面设置面板，不另立开关）
  assert.match(loader, /function readOverlayPrefs\(\)/);
  assert.match(loader, /g\("zusage3\.show", "\{\}"\)/);
  assert.match(loader, /zuCfg: \{ gen: gen, prefs: readOverlayPrefs\(\) \}/);
  // 能力握手：无 zuUpCap 零上行（安全门）
  assert.match(loader, /if \(Date\.now\(\) - lastCapAt > 45000\) return false;/);
  assert.match(loader, /noteDownlink\(body\)/);
  // 无新增设置 UI（回退条面板无"移动端推送"块、无额外浮标/注入块）
  for (const absent of ['data-zusage-push', 'PUSH_ROWS', 'zm-cfg', 'ensurePushBlock', 'data-p="live"', 'data-p="turns"']) {
    assert.ok(!ui.includes(absent), `不应新增设置: ${absent}`);
  }
  // 估算/统计行仍为已回退状态
  for (const absent of ['estTick', 'estState', 'data-zusage-mstat', 'turnLineText']) {
    assert.ok(!ui.includes(absent), `回退残留: ${absent}`);
  }
});

test('product injects desktop-extracted icons, cell css, bands and show rows', () => {
  assert.match(source, /speed: '<path d="M13\.5 2 3\.5 13\.5H11L10 22l10\.5-12H13l\.5-8z"\/>'/);   // 桌面 07 锚点提取
  assert.match(source, /\.zm-root \.it\{display:flex;align-items:center;gap:5px/);                // 桌面 06 cell 提取
  assert.match(source, /\.zm-root \.zm-band-zu-azure\{color:#6d9fff\}\.zm-root \.zm-tone-zu-azure\{color:#6d9fff\}/);
  assert.match(source, /\.zm-light \.zm-band-ok\{color:#0f9d6c\}/);
  assert.match(source, /data-k="sub"><span>子代理<em>悬停或点击状态条上的子代理查看统计<\/em>/); // 桌面 settingRow 提取
});

test('mobile fragments declare icon ids and show keys (build fail-fast contract)', () => {
  const ui = fs.readFileSync(path.join(mobileSrcDir, '40-fallback-ui.js'), 'utf8');
  assert.match(ui, /\/\*@zm-icons speed,turn,win,today,proj,tools,sub@\*\//);
  assert.match(ui, /\/\*@zm-show-keys turn,win,proj,today,tools,sub@\*\//);
});

test('desktop fragments keep extraction anchors (deletion must fail the build)', () => {
  for (const id of ['speed', 'turn', 'win', 'today', 'proj', 'tools', 'sub']) {
    assert.ok(ovl07.includes(`/*zm-ico:${id}*/`), `07 分片缺 /*zm-ico:${id}*/ 锚点`);
  }
  for (const a of ['/*zm-cell-css-begin', '/*zm-cell-css-end',
    '/*zm-band-css-begin', '/*zm-band-css-end',
    '/*zm-band-css-light-begin', '/*zm-band-css-light-end',
    '/*zm-show-rows-begin', '/*zm-show-rows-end']) {
    assert.ok(ovl06.includes(a), `06 分片缺锚点 ${a}`);
  }
  assert.match(fs.readFileSync(path.join(ROOT, 'src', 'overlay', '13-mobile-chips.js'), 'utf8'),
    /var MC_BANDS = \[/);
});
