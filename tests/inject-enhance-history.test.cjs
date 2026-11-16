const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { sliceInject } = require('./helpers/overlay-extract.cjs');

// v363 review：增强历史「在本机保存增强历史」缺省语义翻转为开启（配置无 saveHistory
// 键即读盘+落盘，仅显式 false 关闭）。变异猎杀证明既有套件对 5 处判定翻转零敏感，
// 本文件锁定：归一化三态、读盘门/落盘门两态、读回 30 天/100 条裁剪（review 补），
// 以及渲染端复选框初始化同谓词（源码锁）。
const viewBlock = sliceInject('const enhanceInFlight = new Map()', 'function validEnhanceUrl');
const historyBlock = sliceInject('/* ---------- 增强历史（spec: 增强历史记录）', '/* 取消在途增强');

function makeRuntime(t, providerJson) {
  const here = fs.mkdtempSync(path.join(os.tmpdir(), 'zusage-ehdef-'));
  t.after(() => fs.rmSync(here, { recursive: true, force: true }));
  if (providerJson !== undefined) fs.writeFileSync(path.join(here, 'enhance-provider.json'), JSON.stringify(providerJson), { mode: 0o600 });   // readEnhanceProvider 拒绝权限位过开的文件
  const sandbox = vm.createContext({
    process: { platform: 'darwin' },
    path, fs, Date, JSON, Math,
    HERE: here,
    LOG: () => {},
    modelPuller: null,   // enhanceProviderView 仅读其真值；行为用例不依赖
  });
  vm.runInContext(viewBlock + '\n' + historyBlock + '\nthis.__api = { readEnhanceProvider, enhanceProviderView, loadEnhanceHistoryDisk, persistEnhanceHistory, addEnhanceHistory, enhanceHistory };', sandbox);
  return { api: sandbox.__api, here };
}

function writeHistory(here, records) {
  fs.writeFileSync(path.join(here, 'enhance-history.json'), JSON.stringify(records), { mode: 0o600 });
}

function rec(daysAgo, i) {
  return { id: 'h-' + i, source: 'chat', status: 'success', originalText: 'o' + i, enhancedText: 'e' + i, createdAt: new Date(Date.now() - daysAgo * 86400000).toISOString() };
}

test('enhanceProviderView: 配置缺 saveHistory 键（含文件不存在）归一为开启', (t) => {
  const { api } = makeRuntime(t, undefined);
  assert.equal(api.enhanceProviderView().saveHistory, true, '文件不存在=缺省开启');
  const { api: api2 } = makeRuntime(t, { version: 1, revision: 0, mode: 'default' });
  assert.equal(api2.enhanceProviderView().saveHistory, true, '显式对象无键=缺省开启');
});

test('enhanceProviderView: 显式 false 关闭、显式 true 开启', (t) => {
  const { api } = makeRuntime(t, { version: 1, revision: 0, mode: 'default', saveHistory: false });
  assert.equal(api.enhanceProviderView().saveHistory, false);
  const { api: api2 } = makeRuntime(t, { version: 1, revision: 0, mode: 'default', saveHistory: true });
  assert.equal(api2.enhanceProviderView().saveHistory, true);
});

test('读盘门: 缺省开启时启动加载磁盘历史；显式 false 不读盘（关闭态重启即清空契约）', (t) => {
  const records = [rec(0, 1), rec(1, 2), rec(2, 3)];
  const a = makeRuntime(t, { version: 1, revision: 0, mode: 'default' });
  writeHistory(a.here, records);
  a.api.loadEnhanceHistoryDisk();
  assert.equal(a.api.enhanceHistory.length, 3, '缺省开启：读回 3 条');

  const b = makeRuntime(t, { version: 1, revision: 0, mode: 'default', saveHistory: false });
  writeHistory(b.here, records);
  b.api.loadEnhanceHistoryDisk();
  assert.equal(b.api.enhanceHistory.length, 0, '显式关闭：不读盘');
});

test('读回裁剪: 超期（30 天）与超量（100 条）在读回时即裁剪并回写磁盘', (t) => {
  const { api, here } = makeRuntime(t, { version: 1, revision: 0, mode: 'default' });
  const records = [];
  for (let i = 0; i < 105; i++) records.push(rec(0, i));      // 105 条新鲜
  records.push(rec(40, 200));                                  // 1 条 40 天前
  writeHistory(here, records);
  api.loadEnhanceHistoryDisk();
  assert.equal(api.enhanceHistory.length, 100, '读回仅保留最新 100 条');
  assert.ok(!api.enhanceHistory.some(r => r.id === 'h-200'), '超期记录不进内存');
  assert.ok(api.enhanceHistory.every(r => r.id !== undefined), '对象白名单过滤生效');
  const onDisk = JSON.parse(fs.readFileSync(path.join(here, 'enhance-history.json'), 'utf8'));
  assert.equal(onDisk.length, 100, '裁剪结果回写磁盘');
  assert.ok(!onDisk.some(r => r.id === 'h-200'), '超期记录从磁盘清除');
});

test('落盘门: 缺省开启写出历史文件；显式 false 只留内存不落盘', (t) => {
  const a = makeRuntime(t, { version: 1, revision: 0, mode: 'default' });
  const r1 = a.api.addEnhanceHistory({ originalText: 'o', enhancedText: 'e' });
  assert.equal(r1.ok, true);
  const file = path.join(a.here, 'enhance-history.json');
  assert.ok(fs.existsSync(file), '缺省开启：落盘');
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, '历史文件 0600');

  const b = makeRuntime(t, { version: 1, revision: 0, mode: 'default', saveHistory: false });
  const r2 = b.api.addEnhanceHistory({ originalText: 'o', enhancedText: 'e' });
  assert.equal(r2.ok, true);
  assert.equal(b.api.enhanceHistory.length, 1, '内存保留');
  assert.ok(!fs.existsSync(path.join(b.here, 'enhance-history.json')), '显式关闭：不写盘');
});

test('渲染端 EP 分区复选框初始化与主进程同谓词（!== false，源码锁）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'overlay', '09-instance-settings-and-notes.js'), 'utf8');
  assert.match(src, /saveBox\.checked = ep\.saveHistory !== false;/, '复选框缺省视为开启');
});
