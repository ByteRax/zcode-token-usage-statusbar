const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// v99/v89 起：中文「X 时 X 分 X 秒」/英文「X h X m X s」，空格分隔，零段照旧省略（仅全零显示 0 秒/0 s）
const cases = [
  [0, '0 秒', '0 s'],
  [999, '0 秒', '0 s'],
  [1000, '1 秒', '1 s'],
  [3100, '3 秒', '3 s'],
  [59999, '59 秒', '59 s'],
  [60000, '1 分', '1 m'],
  [60999, '1 分', '1 m'],
  [61000, '1 分 1 秒', '1 m 1 s'],
  [70000, '1 分 10 秒', '1 m 10 s'],
  [120000, '2 分', '2 m'],
  [3599999, '59 分 59 秒', '59 m 59 s'],
  [3600000, '1 时', '1 h'],
  [3600999, '1 时', '1 h'],
  [3601000, '1 时 1 秒', '1 h 1 s'],
  [3610000, '1 时 10 秒', '1 h 10 s'],
  [3660000, '1 时 1 分', '1 h 1 m'],
  [3670000, '1 时 1 分 10 秒', '1 h 1 m 10 s'],
  [7200000, '2 时', '2 h'],
  [90061000, '25 时 1 分 1 秒', '25 h 1 m 1 s'],
];

for (const file of ['overlay.js', 'web/overlay.js']) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const start = source.indexOf('  var DEFAULT_CHARS_PER_TOKEN = 2;');
  const end = source.indexOf('  /* 思考态动效图标', start);
  assert.ok(start >= 0 && end > start, `提取失败: ${file} zuBarSpeedView`);

  for (const lang of ['zh', 'en']) {
    test(`${file}: ${lang} thinking timer localizes h/m/s units and omits zero units`, () => {
      const speedView = vm.runInNewContext(source.slice(start, end) + '\nzuBarSpeedView;', {
        L: (zh, en) => lang === 'en' ? en : zh,
      });
      for (const [observedMs, zhExpected, enExpected] of cases) {
        const view = speedView({ complete: false, characterRate: null, observedMs });
        const prefix = lang === 'en' ? 'thinking…' : '思考中…';
        const expected = lang === 'en' ? enExpected : zhExpected;
        assert.equal(view.text, prefix + expected, `${observedMs}ms`);
        assert.equal(view.phase, 'thinking');
        assert.equal(view.cls, 'dim');
      }
    });
  }
}

/* v116：思考计时锚定 turnHeader.startedAt（宿主创建 header 恒写入，重绑不清零）；
 * 缺字段或时钟未及起点回退 observedMs。桌面与 Web 同源语义，两文件同测。 */
test('overlay.js & web/overlay.js: thinking timer anchors to startedAt when present, falls back to observedMs', () => {
  for (const file of ['overlay.js', 'web/overlay.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const start = source.indexOf('  var DEFAULT_CHARS_PER_TOKEN = 2;');
    const end = source.indexOf('  /* 思考态动效图标', start);
    assert.ok(start >= 0 && end > start, `提取失败: ${file} zuBarSpeedView`);
    const NOW = 36610000;   // 固定时钟，避开真实墙钟抖动
    const speedView = vm.runInNewContext(source.slice(start, end) + '\nzuBarSpeedView;', {
      L: (zh) => zh,
      Date: { now: () => NOW },
    });
    // startedAt 存在：锚定 now-startedAt（1 时 1 分 10 秒），忽略 observedMs
    let v = speedView({ complete: false, characterRate: null, observedMs: 3000, startedAt: NOW - 3670000 });
    assert.equal(v.text, '思考中…1 时 1 分 10 秒', `${file} anchor`);
    // startedAt 缺席（tracker 对非有限数归一为 null，turn-stats.js:122）：回退 observedMs
    v = speedView({ complete: false, characterRate: null, observedMs: 999, startedAt: null });
    assert.equal(v.text, '思考中…0 秒', `${file} fallback`);
    // startedAt 在当前时钟之后（时钟漂移/异常）：回退 observedMs，不出负数
    v = speedView({ complete: false, characterRate: null, observedMs: 4200, startedAt: NOW + 5000 });
    assert.equal(v.text, '思考中…4 秒', `${file} future-startedAt fallback`);
  }
});
