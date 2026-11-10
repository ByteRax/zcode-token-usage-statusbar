const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { sliceInject } = require('./helpers/overlay-extract.cjs');

// issue #279 查漏补缺：dbDir() 镜像宿主 agent 会话库解析（v3.17.1
// onboarding/localUsageEvidence.resolveAgentSessionDbPath：写库方 agent 不消费
// dataBaseDir）——env ZCODE_SESSION_DB_PATH/ZCODE_SESSION_DB（双别名键序取后）>
// ~/.zcode/cli/config.json 的 storage.sessionDbPath > dataBaseDir 迁移目录
// （库存在才用，3.17.x 兼容）> ~/.zcode/cli/db。切出「db 活动戳」整段跑各分支。
const block = sliceInject('/* db 活动戳', '/* 远端状态按');

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zusage-dbdir-'));
  fs.mkdirSync(path.join(home, '.zcode', 'v2'), { recursive: true });
  fs.mkdirSync(path.join(home, '.zcode', 'cli'), { recursive: true });
  return home;
}

function writeJson(file, value, { bom = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  fs.writeFileSync(file, bom ? '\uFEFF' + body : body);
}

function touchDb(base) {
  const db = path.join(base, '.zcode', 'cli', 'db', 'db.sqlite');
  fs.mkdirSync(path.dirname(db), { recursive: true });
  fs.writeFileSync(db, '');
  return db;
}

// statPaths 记录 dbStamp 实际探测的文件路径，证明监听/活动戳跟随解析后的目录
function runBlock({ env = {}, home = '/fake-home', statPaths } = {}) {
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
  vm.runInContext(block + '\nthis.__api = { dbDir, dbStamp, resolveHostDbDir };', sandbox);
  return sandbox.__api;
}

test('默认无任何配置：回落 <home>/.zcode/cli/db', () => {
  const home = makeHome();
  const api = runBlock({ env: { ZCODE_DESKTOP_HOME_DIR: home } });
  assert.equal(api.resolveHostDbDir(), path.join(home, '.zcode', 'cli', 'db'));
});

test('env ZCODE_SESSION_DB_PATH 显式库路径最高优先', () => {
  const home = makeHome();
  const db = touchDb('/tmp/ztus-explicit');
  const api = runBlock({ env: { ZCODE_DESKTOP_HOME_DIR: home, ZCODE_SESSION_DB_PATH: db } });
  assert.equal(api.resolveHostDbDir(), path.dirname(db));
});

test('env 双别名按 env 键序取后者（宿主 adapter 赋值序同款）', () => {
  const home = makeHome();
  const a = touchDb('/tmp/ztus-alias-a');
  const b = touchDb('/tmp/ztus-alias-b');
  const api = runBlock({ env: { ZCODE_DESKTOP_HOME_DIR: home, ZCODE_SESSION_DB_PATH: a, ZCODE_SESSION_DB: b } });
  assert.equal(api.resolveHostDbDir(), path.dirname(b));
  const api2 = runBlock({ env: { ZCODE_DESKTOP_HOME_DIR: home, ZCODE_SESSION_DB: b, ZCODE_SESSION_DB_PATH: a } });
  assert.equal(api2.resolveHostDbDir(), path.dirname(a));
});

test('env ~/ 展开为 home，相对值忽略回落', () => {
  const home = makeHome();
  const api = runBlock({ env: { ZCODE_DESKTOP_HOME_DIR: home, ZCODE_SESSION_DB_PATH: '~/custom/db.sqlite' } });
  assert.equal(api.resolveHostDbDir(), path.join(home, 'custom'));
  const api2 = runBlock({ env: { ZCODE_DESKTOP_HOME_DIR: home, ZCODE_SESSION_DB_PATH: 'relative/db.sqlite' } });
  assert.equal(api2.resolveHostDbDir(), path.join(home, '.zcode', 'cli', 'db'));
});

test('~/.zcode/cli/config.json 的 storage.sessionDbPath 次优先', () => {
  const home = makeHome();
  writeJson(path.join(home, '.zcode', 'cli', 'config.json'), { storage: { sessionDbPath: '~/custom/db.sqlite' } });
  const api = runBlock({ env: { ZCODE_DESKTOP_HOME_DIR: home } });
  assert.equal(api.resolveHostDbDir(), path.join(home, 'custom'));
});

test('CLI config 损坏/相对值不致命，继续回落', () => {
  const home = makeHome();
  writeJson(path.join(home, '.zcode', 'cli', 'config.json'), '{broken');
  let api = runBlock({ env: { ZCODE_DESKTOP_HOME_DIR: home } });
  assert.equal(api.resolveHostDbDir(), path.join(home, '.zcode', 'cli', 'db'));
  writeJson(path.join(home, '.zcode', 'cli', 'config.json'), { storage: { sessionDbPath: 'relative/db.sqlite' } });
  api = runBlock({ env: { ZCODE_DESKTOP_HOME_DIR: home } });
  assert.equal(api.resolveHostDbDir(), path.join(home, '.zcode', 'cli', 'db'));
});

test('dataBaseDir 迁移目录：库存在才用（3.17.x 兼容），无库回落 HOME', () => {
  const home = makeHome();
  const migrated = fs.mkdtempSync(path.join(os.tmpdir(), 'zusage-mig-'));
  writeJson(path.join(home, '.zcode', 'v2', 'setting.json'), { dataBaseDir: migrated });
  let api = runBlock({ env: { ZCODE_DESKTOP_HOME_DIR: home } });
  assert.equal(api.resolveHostDbDir(), path.join(home, '.zcode', 'cli', 'db'));
  const db = touchDb(migrated);
  api = runBlock({ env: { ZCODE_DESKTOP_HOME_DIR: home } });
  assert.equal(api.resolveHostDbDir(), path.dirname(db));
});

test('ZCODE_DATA_BASE_DIR env 作为迁移标记同样走存在性分支；setting.json 优先', () => {
  const home = makeHome();
  const migrated = fs.mkdtempSync(path.join(os.tmpdir(), 'zusage-mig2-'));
  const db = touchDb(migrated);
  const api = runBlock({ env: { ZCODE_DESKTOP_HOME_DIR: home, ZCODE_DATA_BASE_DIR: migrated } });
  assert.equal(api.resolveHostDbDir(), path.dirname(db));
  writeJson(path.join(home, '.zcode', 'v2', 'setting.json'), { dataBaseDir: migrated });
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'zusage-mig3-'));
  const db2 = touchDb(other);
  const api2 = runBlock({ env: { ZCODE_DESKTOP_HOME_DIR: home, ZCODE_DATA_BASE_DIR: other } });
  assert.equal(api2.resolveHostDbDir(), path.dirname(db));
});

test('setting.json 相对/波浪号 dataBaseDir 不入存在性分支', () => {
  const home = makeHome();
  writeJson(path.join(home, '.zcode', 'v2', 'setting.json'), { dataBaseDir: 'relative/dir' });
  let api = runBlock({ env: { ZCODE_DESKTOP_HOME_DIR: home } });
  assert.equal(api.resolveHostDbDir(), path.join(home, '.zcode', 'cli', 'db'));
  writeJson(path.join(home, '.zcode', 'v2', 'setting.json'), { dataBaseDir: '~/abs-sub' });
  api = runBlock({ env: { ZCODE_DESKTOP_HOME_DIR: home } });
  assert.equal(api.resolveHostDbDir(), path.join(home, '.zcode', 'cli', 'db'));
});

test('setting.json 带 UTF-8 BOM 仍能读出 dataBaseDir；损坏不致命', () => {
  const home = makeHome();
  const migrated = fs.mkdtempSync(path.join(os.tmpdir(), 'zusage-mig4-'));
  const db = touchDb(migrated);
  writeJson(path.join(home, '.zcode', 'v2', 'setting.json'), { dataBaseDir: migrated }, { bom: true });
  const api = runBlock({ env: { ZCODE_DESKTOP_HOME_DIR: home } });
  assert.equal(api.resolveHostDbDir(), path.dirname(db));
  writeJson(path.join(home, '.zcode', 'v2', 'setting.json'), '{broken');
  const api2 = runBlock({ env: { ZCODE_DESKTOP_HOME_DIR: home, ZCODE_DATA_BASE_DIR: migrated } });
  assert.equal(api2.resolveHostDbDir(), path.dirname(db));
});

test('dbStamp 探测解析后目录下的 db.sqlite/-wal/-shm', () => {
  const home = makeHome();
  const db = touchDb('/tmp/ztus-stamp');
  const statPaths = [];
  const api = runBlock({ env: { ZCODE_DESKTOP_HOME_DIR: home, ZCODE_SESSION_DB_PATH: db }, statPaths });
  assert.equal(api.dbStamp(), 42);
  assert.deepEqual(statPaths, ['db.sqlite', 'db.sqlite-wal', 'db.sqlite-shm']
    .map((f) => path.join(path.dirname(db), f)));
});
