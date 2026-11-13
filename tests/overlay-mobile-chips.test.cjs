/* 13-mobile-chips 的 DOM 采集口径锁（specs/mobile-relay.md「DOM 快路径」与「样式复用」）。
 * 桌面状态条的 .it 原样 textContent 直推手机端会产生三类不一致，本测试钉住修法：
 *  1) 子代理格不再跳过（0.2.4 起完全照抄桌面 chip 集，含子代理）；
 *  2) 工具格是 <span class=v>717</span><span class=eb>15</span>，textContent 拼成
 *     "71715" → 只剥离尾部错误数作 err 字段，.dim「N次」保留；
 *  3) 按桌面 DOM 拆 {v 主值, dim 后缀}，速度格 .zu-live 单串拆数字+t/s；
 *  4) id 与桌面 state.show 键对齐（turn/win/today/proj/tools/sub）。
 * 采集逻辑在 overlay.js 的 boot 闭包内，这里按源码契约断言（与 overlay 套件同风格）。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');

test('mobile chips: subagent cell included (0.2.4 full desktop copy)', () => {
  assert.doesNotMatch(source, /classList\.contains\("zu-sub"\)\) continue;/);
  assert.match(source, /"子代理": "sub"/);
});

test('mobile chips: tools value strips only the trailing error count, keeps dim text', () => {
  assert.match(source, /var ebEl = el\.querySelector\("\.eb"\);/);
  // 只在尾部匹配时剥离，不能统一只取 .v（那会丢掉「N次 / N轮 N次」dim 文本）
  assert.match(source, /if \(ebText && value\.slice\(-ebText\.length\) === ebText\) value = value\.slice\(0, -ebText\.length\)\.trim\(\);/);
  assert.match(source, /if \(ebText && ebText !== "0"\) detail =/);
});

test('mobile chips: value split into v/dim like desktop DOM', () => {
  assert.match(source, /var vText = vEl \? \(vEl\.textContent \|\| ""\)\.trim\(\) : value;/);
  assert.match(source, /var dimText = dimEls\.length \? \(dimEls\[dimEls\.length - 1\]\.textContent \|\| ""\)\.trim\(\) : "";/);
  assert.match(source, /var sm = vText\.match\(/);   // 速度格 "170.4t/s" 拆数字 + t/s
  assert.match(source, /vText = sm\[1\]; dimText = "t\/s";/);
  assert.match(source, /chip\.dim = dimText;/);
});

test('mobile chips: stable ids aligned with desktop state.show keys', () => {
  assert.match(source, /var mcIds = \{ "本轮": "turn", "会话": "win", "会话累计": "win", "今日": "today", "今日合计": "today", "项目": "proj", "项目累计": "proj", "工具": "tools", "子代理": "sub", "速度": "speed", "额度": "quota" \};/);
});
