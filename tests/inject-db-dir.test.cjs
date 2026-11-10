const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { sliceInject } = require('./helpers/overlay-extract.cjs');

// issue #279：dbDir() 走 resolveHostDataBaseDir()（与 resolveHostQuotaPaths 同序：
// setting.json dataBaseDir 绝对值 > ZCODE_DATA_BASE_DIR env > home），迁移后
// dbStamp / db watcher 跟随新库。切出「db 活动戳」整段在受控桩下跑各分支。
const block = sliceInject('/* db 活动戳', '/* 远端状态按');

function makeHome(settingJson) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zusage-dbdir-'));
  if (settingJson !== undefined) {
    fs.mkdirSync(path.join(home, '.zcode', 'v2'), { recursive: true });
    fs.writeFileSync(path.join(home, '.zcode', 'v2', 'setting.json'),
      typeof settingJson === 'string' ? settingJson : JSON.stringify(settingJson));
  }
  return home;
}

// statPaths 记录 dbStamp 实际探测的文件路径，证明监听/活动戳跟随解析后的目录
function runBlock({ env = {}, home = '/fake-home', settingJson, statPaths } = {}) {
  const sandbox = vm.createContext({
    process: { env },
    path,
    fs: {
      existsSync: (p) => fs.existsSync(p),
      readFileSync: (p, enc) => fs.readFileSync(p, enc),
      statSync: (p) => {
        if (statPaths) statPaths.push(String(p));
        return { mtimeMs: 42 };
      },
    },
    app: { getPath: (name) => (name === 'home' ? home : '/fake-' + name) },
    LOG: () => {},
  });
  vm.runInContext(block + '\nthis.__api = { dbDir, dbStamp, resolveHostDataBaseDir };', sandbox);
  return sandbox.__api;
}

test('默认无 setting.json 无 env：回落 <home>/.zcode/cli/db', () => {
  const api = runBlock({ env: {}, home: '/fake-home' });
  assert.equal(api.resolveHostDataBaseDir(), '/fake-home');
  assert.equal(api.dbDir(), path.join('/fake-home', '.zcode', 'cli', 'db'));
});

test('setting.json 的绝对 dataBaseDir 生效（经 ZCODE_DESKTOP_HOME_DIR 定位引导文件）', () => {
  const migrated = fs.mkdtempSync(path.join(os.tmpdir(), 'zusage-mig-'));
  const home = makeHome({ dataBaseDir: migrated });
  const api = runBlock({ env: { ZCODE_DESKTOP_HOME_DIR: home }, home: '/fake-home' });
  assert.equal(api.resolveHostDataBaseDir(), migrated);
  assert.equal(api.dbDir(), path.join(migrated, '.zcode', 'cli', 'db'));
});

test('setting.json 优先于 ZCODE_DATA_BASE_DIR env（同宿主 setDataBaseDir > env）', () => {
  const home = makeHome({ dataBaseDir: '/from/setting' });
  const api = runBlock({ env: { ZCODE_DESKTOP_HOME_DIR: home, ZCODE_DATA_BASE_DIR: '/from/env' } });
  assert.equal(api.dbDir(), path.join('/from/setting', '.zcode', 'cli', 'db'));
});

test('相对 dataBaseDir 不采纳：回落 env，env 缺省回落 home', () => {
  const home = makeHome({ dataBaseDir: 'relative/dir' });
  const api = runBlock({ env: { ZCODE_DESKTOP_HOME_DIR: home, ZCODE_DATA_BASE_DIR: '/from/env' } });
  assert.equal(api.dbDir(), path.join('/from/env', '.zcode', 'cli', 'db'));
  // env 缺省回落 home——ZCODE_DESKTOP_HOME_DIR 本身是 home 覆盖（resolveHostQuotaPaths 同款）
  const api2 = runBlock({ env: { ZCODE_DESKTOP_HOME_DIR: home }, home: '/fake-home' });
  assert.equal(api2.dbDir(), path.join(home, '.zcode', 'cli', 'db'));
});

test('损坏的 setting.json 不抛错，按无迁移处理', () => {
  const home = makeHome('{broken json');
  const api = runBlock({ env: { ZCODE_DESKTOP_HOME_DIR: home, ZCODE_DATA_BASE_DIR: '/from/env' } });
  assert.equal(api.dbDir(), path.join('/from/env', '.zcode', 'cli', 'db'));
});

test('Windows 盘符 dataBaseDir 被采纳为基目录', () => {
  const home = makeHome({ dataBaseDir: 'D:\\zcode-data' });
  const api = runBlock({ env: { ZCODE_DESKTOP_HOME_DIR: home }, home: '/fake-home' });
  assert.equal(api.resolveHostDataBaseDir(), 'D:\\zcode-data');
});

test('dbStamp 探测解析后目录下的 db.sqlite/-wal/-shm', () => {
  const migrated = fs.mkdtempSync(path.join(os.tmpdir(), 'zusage-mig2-'));
  const home = makeHome({ dataBaseDir: migrated });
  const statPaths = [];
  const api = runBlock({ env: { ZCODE_DESKTOP_HOME_DIR: home }, statPaths });
  assert.equal(api.dbStamp(), 42);
  assert.deepEqual(statPaths, ['db.sqlite', 'db.sqlite-wal', 'db.sqlite-shm']
    .map((f) => path.join(migrated, '.zcode', 'cli', 'db', f)));
});
