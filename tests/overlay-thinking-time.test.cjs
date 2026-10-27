const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// v126/桌面·web v93 起：中文数字与单位、时间段之间全部紧邻「1时1分10秒」，零段照旧省略（仅全零显示 0秒/0s）；
// 英文数字与单位紧邻、时段间留空格「1h 1m 10s」（v126 用户要求）
const cases = [
  [0, '0 秒', '0s'],
  [999, '0 秒', '0s'],
  [1000, '1 秒', '1s'],
  [3100, '3 秒', '3s'],
  [59999, '59 秒', '59s'],
  [60000, '1 分', '1m'],
  [60999, '1 分', '1m'],
  [61000, '1 分 1 秒', '1m 1s'],
  [70000, '1 分 10 秒', '1m 10s'],
  [120000, '2 分', '2m'],
  [3599999, '59 分 59 秒', '59m 59s'],
  [3600000, '1 时', '1h'],
  [3600999, '1 时', '1h'],
  [3601000, '1 时 1 秒', '1h 1s'],
  [3610000, '1 时 10 秒', '1h 10s'],
  [3660000, '1 时 1 分', '1h 1m'],
  [3670000, '1 时 1 分 10 秒', '1h 1m 10s'],
  [7200000, '2 时', '2h'],
  [90061000, '25 时 1 分 1 秒', '25h 1m 1s'],
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
        const expected = lang === 'en' ? enExpected : zhExpected.replace(/ /g, '');
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
    // startedAt 存在：锚定 now-startedAt（1时1分10秒），忽略 observedMs
    let v = speedView({ complete: false, characterRate: null, observedMs: 3000, startedAt: NOW - 3670000 });
    assert.equal(v.text, '思考中…1时1分10秒', `${file} anchor`);
    // startedAt 缺席（tracker 对非有限数归一为 null，turn-stats.js:122）：回退 observedMs
    v = speedView({ complete: false, characterRate: null, observedMs: 999, startedAt: null });
    assert.equal(v.text, '思考中…0秒', `${file} fallback`);
    // startedAt 在当前时钟之后（时钟漂移/异常）：回退 observedMs，不出负数
    v = speedView({ complete: false, characterRate: null, observedMs: 4200, startedAt: NOW + 5000 });
    assert.equal(v.text, '思考中…4秒', `${file} future-startedAt fallback`);
  }
});
