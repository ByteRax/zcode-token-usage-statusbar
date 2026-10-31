const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// v127（桌面）/ v94（web）：tok/s 速度十档色。TPS_BANDS 是阈值/类名/文案的唯一事实源，
// 按**原始速度值**分档（含下限、不含上限），生成中估算与完成态真实值同表；
// 无效值（负数/NaN/±Infinity）一律中性 dim 或整枚 chip 回退，绝不判成低速。
// 桌面与 web 同源语义，两文件同测；CSS 漂移检查保证 JS 类名与样式定义不脱钩。

const FILES = ['overlay.js', 'web/overlay.js'];
const LADDER = ['hot', 'warm', 'ok', 'zu-teal', 'zu-sky', 'zu-azure', 'zu-violet', 'zu-purple', 'zu-magenta', 'zu-ultra'];
const BOUNDS = [40, 70, 150, 200, 300, 500, 800, 1000, 2000];

function extract(file, lang) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const start = source.indexOf('  function zuHasMeaningfulOutput');
  const end = source.indexOf('  /* 思考态动效图标', start);
  assert.ok(start >= 0 && end > start, `提取失败: ${file} 速度分档区`);
  const api = vm.runInNewContext(
    source.slice(start, end) + '\n({ zuBarSpeedView, tpsBand, tpsBandText, tpsBandLegend, TPS_BANDS });', {
      L: (zh, en) => (lang === 'en' ? en : zh),
      zuToolVerb: (name) => name,
      Date: { now: () => 11000 },
    });
  return { source, api };
}

function completedView(api, tokenRate) {
  return api.zuBarSpeedView({ complete: true, observedLive: true, outputTokens: 100, tokenRate }, 2);
}
function estimateView(api, characterRate) {
  return api.zuBarSpeedView({ complete: false, characterRate, phase: 'writing' }, 2);
}

for (const file of FILES) {
  for (const lang of ['zh', 'en']) {
    const { source, api } = extract(file, lang);

    test(`${file}/${lang}: 十档阈值边界——含下限、不含上限，完成态按原始值分档`, () => {
      for (let i = 0; i < BOUNDS.length; i++) {
        const below = completedView(api, BOUNDS[i] - 0.02);
        const at = completedView(api, BOUNDS[i]);
        assert.equal(below.cls, LADDER[i], `${BOUNDS[i] - 0.02} t/s 应落第 ${i + 1} 档`);
        assert.equal(below.band && below.band.cls, LADDER[i]);
        assert.equal(at.cls, LADDER[i + 1], `${BOUNDS[i]} t/s 应恰好进入第 ${i + 2} 档`);
      }
      assert.equal(completedView(api, 0).cls, 'hot');        // 0 是有效速度，按低速
      assert.equal(completedView(api, 39.99).cls, 'hot');
      assert.equal(completedView(api, 1999.98).cls, 'zu-magenta');
      assert.equal(completedView(api, 5000).cls, 'zu-ultra');
      assert.equal(completedView(api, 250).text, '250.0 t/s');   // 显示格式沿用 toFixed(1)
    });

    test(`${file}/${lang}: 完成态无效值（负数/NaN/±Infinity）不判低速，回退 DB`, () => {
      for (const v of [-1, -0.5, NaN, Infinity, -Infinity]) {
        assert.equal(completedView(api, v), null, String(v));
      }
    });

    test(`${file}/${lang}: 估算态同表分档，无效估算保持中性 dim`, () => {
      assert.equal(estimateView(api, 600).cls, 'zu-azure');      // 600/2 = 300 → 高速
      assert.equal(estimateView(api, 599).cls, 'zu-sky');        // 299.5 → 快速
      assert.equal(estimateView(api, 8000).cls, 'zu-ultra');     // 4000 → Ultra
      assert.equal(estimateView(api, 20).cls, 'hot');            // 10 → 低速（估算也分档）
      for (const v of [-5, NaN, Infinity]) {
        const view = estimateView(api, v);
        assert.equal(view.cls, 'dim', String(v));
        assert.equal(view.band, null, String(v));
        assert.equal(view.phase, 'writing');
      }
    });

    test(`${file}/${lang}: 状态词阶段（思考中/工具）不分档维持 dim`, () => {
      assert.equal(api.zuBarSpeedView({ complete: false, characterRate: null, observedMs: 1000 }, 2).cls, 'dim');
      const tool = api.zuBarSpeedView(
        { complete: false, characterRate: null, runningTool: { name: 'Read', startedAt: 10000 } }, 2);
      assert.equal(tool.cls, 'dim');
      assert.equal(tool.band, undefined);
    });

    test(`${file}/${lang}: tpsBandText 输出名称+范围（tooltip 档位行），Ultra 无上限`, () => {
      assert.equal(api.tpsBandText(api.tpsBand(199.96)), lang === 'en' ? 'Brisk · 150–200 t/s' : '较快 · 150–200 t/s');
      assert.equal(api.tpsBandText(api.tpsBand(65)), lang === 'en' ? 'Moderate · 40–70 t/s' : '一般 · 40–70 t/s');
      assert.equal(api.tpsBandText(api.tpsBand(3000)), 'Ultra · ≥2000 t/s');
      // 舍入边界歧义的消解路径：原始 199.96 显示为 "200.0" 但档位按原始值落 150–200，
      // 悬停档位行（上断言）即为解释口径——数值与档位不矛盾。
      assert.equal(Number((199.96).toFixed(1)), 200);
      assert.equal(api.tpsBand(199.96).cls, 'zu-teal');
    });

    test(`${file}/${lang}: tpsBandLegend 颜色对照图例升序覆盖十档，类名与条面同源`, () => {
      const legend = api.tpsBandLegend();
      assert.ok(legend.includes(lang === 'en' ? 'Colour guide' : '颜色对照'), '图例标签缺失');
      const ranges = ['&lt;40', '40–70', '70–150', '150–200', '200–300', '300–500', '500–800', '800–1000', '1000–2000', '≥2000 Ultra'];
      let idx = -1;
      for (const r of ranges) {
        const at = legend.indexOf(r);
        assert.ok(at > idx, `图例缺 ${r} 或未按升序排列`);
        idx = at;
      }
      for (const cls of LADDER) assert.ok(legend.includes(`class="${cls}"`), `图例缺档位类 ${cls}`);
      assert.ok(legend.includes('rt-lsep'), '分隔符缺失');
      assert.ok(source.includes('.rt-legend{'), '图例 CSS 缺失');
    });

    test(`${file}/${lang}: TPS_BANDS 表完整性与半开区间口径`, () => {
      assert.equal(api.TPS_BANDS.map(b => b.lo).join(','), '2000,1000,800,500,300,200,150,70,40,0');
      assert.equal(new Set(api.TPS_BANDS.map(b => b.cls)).size, api.TPS_BANDS.length);
      for (let i = 0; i < api.TPS_BANDS.length; i++) {
        const b = api.TPS_BANDS[i];
        assert.equal(b.hi, i === 0 ? 0 : api.TPS_BANDS[i - 1].lo, `第 ${i} 档 hi 应等于上一档 lo`);
        assert.ok(b.zh && b.en, `第 ${i} 档双语名称缺失`);
      }
    });

    test(`${file}/${lang}: CSS 漂移——每个档位类在暗/浅两组样式里都有定义`, () => {
      for (const b of api.TPS_BANDS) {
        if (b.cls === 'ok' || b.cls === 'warm' || b.cls === 'hot') {
          assert.ok(source.includes(`.${b.cls}{color:#`), `${b.cls} 暗色定义缺失`);
          assert.ok(source.includes(`.zu-light .${b.cls}{color:#`), `${b.cls} 浅色定义缺失`);
          continue;
        }
        assert.ok(source.includes(`.${b.cls}{color:#`), `${b.cls} 暗色定义缺失`);
        assert.ok(source.includes(`.zu-light .${b.cls}{color:#`), `${b.cls} 浅色定义缺失`);
      }
      // Ultra：静态渐变 + ✦ 星点（AT 静音替代文本）+ 双主题渐变 + @supports 纯色回退
      // （源码在 JS 字符串里，content 的引号是 \" 转义形态）
      assert.ok(source.includes('.zu-ultra::before{content:\\"✦\\"/\\"\\"'), 'Ultra 星点缺失');
      assert.ok(source.includes('@supports(-webkit-background-clip:text)'), '渐变 @supports 缺失');
      assert.ok(source.includes('.zu-ultra{color:#a78bfa}') && source.includes('.zu-light .zu-ultra{color:#6746d2}'),
        'Ultra 纯色回退缺失');
      assert.ok(source.includes('#60a5fa') && source.includes('#3156cb'), 'Ultra 双主题渐变色缺失');
    });
  }
}

// v181（PR #157）：完成态主数字改会话加权平均（第 4 参 sessAvg，桌面快照 avg_tps），
// 「均」前缀 + 按均值分档，最近一轮真实值放 latest 供 tooltip 展开；
// 缺席/非正数回退原完成态。web/overlay.js 是独立实现，不消费该参数。
for (const lang of ['zh', 'en']) {
  const desktop = extract('overlay.js', lang).api;
  const web = extract('web/overlay.js', lang).api;
  const stats = { complete: true, observedLive: true, outputTokens: 100, tokenRate: 49.9 };
  const prefix = lang === 'en' ? 'avg ' : '均';

  test(`overlay/${lang}: 完成态主数字=会话均，按均值分档，最近一轮进 latest`, () => {
    const view = desktop.zuBarSpeedView(stats, 2, null, 85.5);
    assert.equal(view.text, `${prefix}85.5 t/s`);
    assert.equal(view.cls, 'ok');          // 85.5 落 ok 档，而非最近一轮 49.9 的 warm 档
    assert.equal(view.latest, 49.9);
    assert.equal(view.phase, null);
    const whole = desktop.zuBarSpeedView(stats, 2, null, 85);
    assert.equal(whole.text, `${prefix}85 t/s`);   // 整数不带 .0
  });

  test(`overlay/${lang}: 会话均缺席/非正数回退原完成态行为`, () => {
    for (const avg of [undefined, null, 0, -5, NaN, Infinity]) {
      const view = desktop.zuBarSpeedView(stats, 2, null, avg);
      assert.equal(view.text, '49.9 t/s');
      assert.equal(view.latest, undefined);
      assert.equal(view.cls, 'warm');
    }
  });

  test(`web/${lang}: 不消费 sessAvg，完成态仍显示最近一轮真实值`, () => {
    const view = web.zuBarSpeedView(stats, 2, null, 85.5);
    assert.equal(view.text, '49.9 t/s');
    assert.equal(view.cls, 'warm');
  });
}
