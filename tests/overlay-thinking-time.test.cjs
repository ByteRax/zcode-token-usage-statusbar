const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const cases = [
  [0, '0s'],
  [999, '0s'],
  [1000, '1s'],
  [3100, '3s'],
  [59999, '59s'],
  [60000, '1m'],
  [60999, '1m'],
  [61000, '1m:1s'],
  [70000, '1m:10s'],
  [120000, '2m'],
  [3599999, '59m:59s'],
  [3600000, '1h'],
  [3600999, '1h'],
  [3601000, '1h:1s'],
  [3610000, '1h:10s'],
  [3660000, '1h:1m'],
  [3670000, '1h:1m:10s'],
  [7200000, '2h'],
  [90061000, '25h:1m:1s'],
];

for (const file of ['overlay.js', 'web/overlay.js']) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const start = source.indexOf('  var DEFAULT_CHARS_PER_TOKEN = 2;');
  const end = source.indexOf('  /* 思考态动效图标', start);
  assert.ok(start >= 0 && end > start, `提取失败: ${file} zuBarSpeedView`);

  for (const lang of ['zh', 'en']) {
    test(`${file}: ${lang} thinking timer uses whole h:m:s and omits zero units`, () => {
      const speedView = vm.runInNewContext(source.slice(start, end) + '\nzuBarSpeedView;', {
        L: (zh, en) => lang === 'en' ? en : zh,
      });
      for (const [observedMs, expected] of cases) {
        const view = speedView({ complete: false, characterRate: null, observedMs });
        const prefix = lang === 'en' ? 'thinking…' : '思考中…';
        assert.equal(view.text, prefix + expected, `${observedMs}ms`);
        assert.equal(view.phase, 'thinking');
        assert.equal(view.cls, 'dim');
      }
    });
  }
}
