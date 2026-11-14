/* 实际构建结果契约；不改工作树根产物，使用当前源码构建两个变体。 */
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const build = spawnSync(process.env.ZUSAGE_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-B', '-c', `
import base64, importlib.util, json, pathlib, sys
root = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location('mobile_build', root / 'scripts/build_mobile_userscript.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
common, info = mod.assemble()
print(json.dumps({'release':mod.finalize(common, False),'debug':mod.finalize(common, True),'desktop':base64.b64encode(mod.desktop_bytes()).decode('ascii')}))
`, ROOT], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, maxBuffer: 32 * 1024 * 1024 });
assert.equal(build.status, 0, build.stderr || build.error?.message);
const products = JSON.parse(build.stdout);
function embedded(source) {
  const prefix = 'var OVERLAY_CODE = ', start = source.indexOf(prefix);
  assert.ok(start >= 0);
  const match = source.slice(start + prefix.length).match(/^"(?:[^"\\]|\\.)*"/);
  assert.ok(match);
  return JSON.parse(match[0]);
}
function boot(source) {
  const nodes = [], timers = new Map(), updates = [], embeddedScripts = [];
  let context, nextTimer = 0;
  function node(tag) {
    const el = { tag, style: {}, className: '', textContent: '', children: [], parentNode: null,
      appendChild(child) {
        this.children.push(child); child.parentNode = this;
        if (child.tag === 'script') {
          embeddedScripts.push(child.textContent);
          new vm.Script(child.textContent, { filename: 'embedded-desktop-overlay.js' });
          assert.equal(context.__zusageMobileMode, true);
          context.__zusageOverlay = true;
          context.__zusageUpdate = value => updates.push(value);
          context.__zusageDispose = () => { context.__zusageOverlay = false; };
        }
      },
      removeChild(child) { this.children = this.children.filter(item => item !== child); child.parentNode = null; },
    };
    nodes.push(el); return el;
  }
  const document = { readyState: 'complete', createElement: node, head: node('head'), body: node('body'), documentElement: node('html'),
    addEventListener() {}, removeEventListener() {} };
  class WS { static OPEN = 1; constructor() { this.readyState = 1; } }
  const sandbox = { document, WebSocket: WS, URL, location: { href: 'https://zcode.z.ai/remote/' },
    localStorage: { getItem() { return null; }, setItem() {} }, console: { info() {} },
    addEventListener() {}, removeEventListener() {}, setInterval: fn => { timers.set(++nextTimer, fn); return nextTimer; },
    setTimeout: fn => { timers.set(++nextTimer, fn); return nextTimer; }, clearInterval: id => timers.delete(id), clearTimeout: id => timers.delete(id),
    fetch() { throw new Error('user script must not download a UI'); } };
  sandbox.window = sandbox; context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: 'built-userscript.js' });
  return { nodes, document, updates, embeddedScripts, timers, context };
}

test('both constructed variants embed byte-identical desktop assemble_bytes output', () => {
  const desktop = Buffer.from(products.desktop, 'base64');
  for (const source of [products.release, products.debug]) {
    assert.deepEqual(Buffer.from(embedded(source), 'utf8'), desktop);
    new vm.Script(source, { filename: 'built-userscript.js' });
  }
});

test('release and debug differ only by metadata and their debug switch', () => {
  const normalized = products.debug.replace('var DEBUG_BUILD = true;', 'var DEBUG_BUILD = false;')
    .replace('// @name         ZCode 用量状态条（远控中继接收端·调试版）', '// @name         ZCode 用量状态条（远控中继接收端）')
    .replace('// @description  调试版：默认显示排障面板（帧统计/overlay 加载状态）；日常使用请安装正式版 zusage-mobile.user.js',
      '// @description  在 ZCode Web 远程控制页面渲染 token 用量；仅在确认宿主支持后同步显示偏好')
    .replaceAll('https://raw.githubusercontent.com/ByteRax/zcode-token-usage-statusbar/main/zusage-mobile.debug.user.js',
      'https://raw.githubusercontent.com/ByteRax/zcode-token-usage-statusbar/main/zusage-mobile.user.js');
  assert.equal(normalized, products.release);
});

test('install and update metadata point each variant at its root Raw URL', () => {
  for (const [variant, filename] of [['release', 'zusage-mobile.user.js'], ['debug', 'zusage-mobile.debug.user.js']]) {
    const header = products[variant].split('// ==/UserScript==')[0];
    const expected = 'https://raw.githubusercontent.com/ByteRax/zcode-token-usage-statusbar/main/' + filename;
    for (const key of ['downloadURL', 'updateURL']) {
      const lines = header.split('\n').filter(line => line.startsWith('// @' + key));
      assert.equal(lines.length, 1);
      assert.equal(lines[0].trim().split(/\s+/).at(-1), expected);
    }
  }
});

test('actual release activates the embedded desktop code with waiting and no receiver UI', () => {
  const h = boot(products.release);
  assert.equal(h.embeddedScripts.length, 1);
  assert.equal(h.embeddedScripts[0], embedded(products.release));
  assert.equal(h.updates.length, 1); assert.equal(h.updates[0].mobile.state, 'waiting');
  assert.equal(h.nodes.filter(el => el.parentNode).length, 0, 'formal receiver creates no status/settings/debug DOM');
  assert.equal(h.timers.size, 2);
  h.context.__zmDispose(); assert.equal(h.timers.size, 0);
});

test('actual debug creates only its diagnostic panel and toggle, cleaned by dispose', () => {
  const h = boot(products.debug);
  const attached = h.nodes.filter(el => el.parentNode);
  assert.deepEqual(attached.map(el => el.className || el.tag).sort(), ['style', 'zm-dbg', 'zm-toggle']);
  assert.match(attached.find(el => el.className === 'zm-dbg').textContent, /内嵌桌面 overlay/);
  assert.equal(h.embeddedScripts[0], embedded(products.debug));
  h.context.__zmDispose(); assert.equal(h.nodes.filter(el => el.parentNode).length, 0);
});
