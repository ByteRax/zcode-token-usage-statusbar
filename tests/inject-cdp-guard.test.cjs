const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { getInjectSlice } = require('./helpers/overlay-extract.cjs');

// 切出 CDP 调试口块（注释首 → catch 收尾），在受控桩下跑各分支
const block = getInjectSlice('cdpSwitchBlock');

function runBlock({ env = {}, commandLine } = {}) {
  calls = [];
  const sandbox = vm.createContext({
    process: { env },
    LOG: (...args) => { calls.push(['log', ...args]); },
    app: { commandLine: commandLine === undefined ? undefined : commandLine },
  });
  vm.runInContext(block, sandbox);
}
const switches = (over = {}) => ({
  appendSwitch: (...args) => calls.push(['append', ...args]),
  hasSwitch: () => false,
  ...over,
});
let calls;

test('CDP 9229：env 逃生口 ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT=1 时跳过', () => {
  calls = [];
  runBlock({ env: { ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: '1' }, commandLine: switches() });
  assert.deepStrictEqual(calls, []);
});

test('CDP 9229：env 非 "1"（如 "0"）不视为关闭，与宿主同款语义', () => {
  calls = [];
  runBlock({ env: { ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: '0' }, commandLine: switches() });
  assert.deepStrictEqual(calls, [['append', 'remote-debugging-port', '9229']]);
});

test('CDP 9229：用户显式已传 --remote-debugging-port 时不覆盖', () => {
  calls = [];
  runBlock({ commandLine: { hasSwitch: () => true, appendSwitch: (...a) => calls.push(['append', ...a]) } });
  assert.deepStrictEqual(calls, []);
});

test('CDP 9229：常规路径按名追加', () => {
  calls = [];
  runBlock({ commandLine: switches() });
  assert.deepStrictEqual(calls, [['append', 'remote-debugging-port', '9229']]);
});

test('CDP 9229：stub 缺 commandLine 时退回 catch 日志路径，不抛出', () => {
  calls = [];
  assert.doesNotThrow(() => runBlock({ commandLine: undefined }));
  assert.strictEqual(calls.filter(c => c[0] === 'log').length, 1);
});

test('CDP 9229：commandLine 存在但缺 hasSwitch（旧桩形态）仍照旧 append', () => {
  calls = [];
  runBlock({ commandLine: { appendSwitch: (...a) => calls.push(['append', ...a]) } });
  assert.deepStrictEqual(calls, [['append', 'remote-debugging-port', '9229']]);
});
