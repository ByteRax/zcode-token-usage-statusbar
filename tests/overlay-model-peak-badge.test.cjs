const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { sliceOverlay } = require('./helpers/overlay-extract.cjs');

/* v482 模型选择器峰谷倍率徽标（specs/model-peak-factor-badge.md）：11 分片
 * syncModelPeakBadges 的行级门控与徽标渲染。数据链（快照顶层 peak.glm_plan =
 * token_pricing.peak_snapshot_segment 生产、zusage include_peak 与 speed_history 同旗、
 * serve lean/远端子查询不带）由 tests/test_token_pricing.py 与
 * tests/test_statusbar_rate.py 锁定；本文件锁 DOM 语义。 */

const slice = sliceOverlay('var ZU_PEAK_ROW_SEL', '/* ---------- v80 in-card 挂载');

const PLAN = 'account:bigmodel-individual-coding-plan';
const ROW_SEL = '[data-testid^="chat-model-select-item-"]';

function el(tag) {
  const node = {
    tagName: tag.toUpperCase(),
    children: [],
    className: '',
    style: { cssText: '' },
    attrs: {},
    parentNode: null,
    isConnected: true,
    textContent: '',
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    appendChild(c) { c.parentNode = this; this.children.push(c); },
    removeChild(c) { c.parentNode = null; this.children = this.children.filter(x => x !== c); },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    /* 只认本特性用到的选择器，其余抛错——防止实现漂移后被宽松桩掩成假绿 */
    closest(sel) {
      if (sel !== '[data-model-provider-key]') throw new Error('unexpected sel ' + sel);
      let p = this.parentNode;
      while (p) {
        if (p.attrs['data-model-provider-key'] !== undefined) return p;
        p = p.parentNode;
      }
      return null;
    },
    querySelector(sel) {
      if (sel !== '[data-zusage-peak]') throw new Error('unexpected sel ' + sel);
      const stack = [this];
      while (stack.length) {
        const n = stack.pop();
        for (const c of n.children) {
          if (c.attrs['data-zusage-peak'] !== undefined) return c;
          stack.push(c);
        }
      }
      return null;
    },
    querySelectorAll(sel) {
      if (sel !== 'span') throw new Error('unexpected sel ' + sel);
      const out = [];
      const walk = n => { for (const c of n.children) { if (c.tagName === 'SPAN') out.push(c); walk(c); } };
      walk(this);
      return out;
    },
  };
  return node;
}

/* 引擎行结构（ZCode 4.0.0 app.asar 取证）：行（button=providerMenu / div=Radix 普通下拉）
 * > 徽标容器 span.flex-1 > 名字 span[title]；分组容器带 data-model-provider-key=
 * "registry-provider:<providerId>"（行级门控第一段）。 */
function makeRow(opts) {
  const o = opts || {};
  const row = el(o.tag || 'button');
  row.attrs['data-testid'] = 'chat-model-select-item-' +
    (o.testidValue !== undefined ? o.testidValue : o.provider + '/' + o.name);
  const cont = el('span');
  cont.className = 'flex min-w-0 flex-1 items-center gap-1.5 text-left';
  const name = el('span');
  name.className = 'min-w-0 truncate';
  if (o.name !== undefined) { name.attrs['title'] = o.name; name.textContent = o.name; }
  cont.appendChild(name);
  row.appendChild(cont);
  if (o.provider) {
    const group = el('div');
    group.attrs['data-model-provider-key'] = 'registry-provider:' + o.provider;
    group.appendChild(row);
  }
  return row;
}

function findBadge(row) { return row.querySelector('[data-zusage-peak]'); }

function makeCtx(rows, opts) {
  const o = opts || {};
  const seg = { is_peak: !!o.isPeak, next_change_at: 1,
    factors: [['glm-5.4', 0.67, 2.0], ['glm-5.3', 1.0, 3.0], ['glm-5.3-flash', 0.4, 1.2],
      ['glm-5.3-flashx', 1.0, 3.0]] };
  return {
    state: { data: o.data === undefined ? { peak: { glm_plan: seg } } : o.data },
    inactive: () => false,
    effectiveQuotaProvider: () => (o.paneProvider === undefined ? '' : o.paneProvider),
    document: {
      querySelectorAll(sel) {
        if (sel !== ROW_SEL) throw new Error('unexpected ' + sel);
        return rows;
      },
      createElement: tag => el(tag),
    },
  };
}

function run(ctx) {
  vm.runInNewContext(slice + '\nthis.__api = { syncModelPeakBadges, zuPeakFormat, zuPeakMatchFactor, zuPeakFamilyOk };', ctx);
  return ctx.__api;
}

test('门控通过的套餐行按当前时段挂徽标，未收录模型不显示（精确等值防子串误命中）', () => {
  const r54 = makeRow({ provider: PLAN, name: 'GLM-5.4' });
  const r53 = makeRow({ provider: PLAN, name: 'GLM-5.3', tag: 'div' });   // 普通下拉 Radix div 同样处理
  const rFlash = makeRow({ provider: PLAN, name: 'GLM-5.3-Flash' });
  const rFlashX = makeRow({ provider: PLAN, name: 'GLM-5.3-FlashX' });
  const rHigh = makeRow({ provider: PLAN, name: 'GLM-5.3-Highspeed' });
  const api = run(makeCtx([r54, r53, rFlash, rFlashX, rHigh], { isPeak: true }));
  api.syncModelPeakBadges();
  assert.equal(findBadge(r54).textContent, '2.00×');
  assert.equal(findBadge(r53).textContent, '3.00×');
  assert.equal(findBadge(rFlash).textContent, '1.20×');
  assert.equal(findBadge(rFlashX).textContent, '3.00×', '体验版独立键（flash×2.5）不串 flash 档');
  assert.equal(findBadge(rHigh), null);
  assert.equal(findBadge(r54).attrs['title'], '高峰 2.00× · 非高峰 0.67×（额度消耗倍率，高峰：周一至五 14:00–18:00）');
  assert.match(findBadge(r54).style.cssText, /margin-left:auto/);
  assert.match(findBadge(r54).style.cssText, /tabular-nums/);
});

test('非高峰时段显示低档值', () => {
  const r54 = makeRow({ provider: PLAN, name: 'GLM-5.4' });
  const api = run(makeCtx([r54], { isPeak: false }));
  api.syncModelPeakBadges();
  assert.equal(findBadge(r54).textContent, '0.67×');
  // 恒两位小数：0.67 本两位；2.00/3.00/1.00/1.20/0.40 见各用例
});

test('行级门控：非 GLM 计划族一律 no-op，绝不摘除他人已挂徽标', () => {
  const rApi = makeRow({ provider: 'bigmodel', name: 'GLM-5.4' });   // API key：无 account: 前缀
  const rOther = makeRow({ provider: 'account:openai-coding-plan', name: 'GLM-5.4' });
  const rStart = makeRow({ provider: 'account:zai-start-plan', name: 'GLM-5.4' });   // start-plan 无系数
  const foreign = el('span');
  foreign.setAttribute('data-zusage-peak', '1');
  foreign.textContent = '9×';
  rApi.children[0].appendChild(foreign);
  const api = run(makeCtx([rApi, rOther, rStart], { isPeak: true }));
  api.syncModelPeakBadges();
  assert.equal(findBadge(rOther), null);
  assert.equal(findBadge(rStart), null);
  assert.equal(findBadge(rApi), foreign, '门控不过的实例对既有徽标整体 no-op（防多实例互踩）');
  assert.equal(foreign.textContent, '9×');
});

test('分组祖先缺失时回退行 testid value 的 provider 段', () => {
  const row = makeRow({ testidValue: 'account:zai-team-coding-plan/GLM-5.4', name: 'GLM-5.4' });
  const api = run(makeCtx([row], { isPeak: true }));
  api.syncModelPeakBadges();
  assert.equal(findBadge(row).textContent, '2.00×');
});

test('行级两段都判不出时回退本 pane 身份', () => {
  const hit = makeRow({ testidValue: 'plain-model', name: 'GLM-5.4' });
  const api = run(makeCtx([hit], { isPeak: true, paneProvider: PLAN }));
  api.syncModelPeakBadges();
  assert.ok(findBadge(hit), 'pane 为 GLM 计划族时挂徽标');
  const miss = makeRow({ testidValue: 'plain-model', name: 'GLM-5.4' });
  const api2 = run(makeCtx([miss], { isPeak: true, paneProvider: 'account:anthropic-coding-plan' }));
  api2.syncModelPeakBadges();
  assert.equal(findBadge(miss), null, 'pane 非 GLM 计划族不挂');
});

test('React 复用行：同一徽标节点原位更新文本与 title，不重挂', () => {
  const row = makeRow({ provider: PLAN, name: 'GLM-5.4' });
  const ctx = makeCtx([row], { isPeak: true });
  const api = run(ctx);
  api.syncModelPeakBadges();
  const first = findBadge(row);
  assert.equal(first.textContent, '2.00×');
  ctx.state.data.peak.glm_plan.is_peak = false;               // 快照刷新翻档
  const nameSpan = row.children[0].children[0];
  nameSpan.attrs['title'] = 'GLM-5.3';                        // React 复用整行换名（含 testid）
  row.attrs['data-testid'] = 'chat-model-select-item-' + PLAN + '/GLM-5.3';
  api.syncModelPeakBadges();
  const second = findBadge(row);
  assert.equal(second, first, '原位更新同一节点');
  assert.equal(second.textContent, '1.00×');
  assert.match(second.attrs['title'], /高峰 3.00× · 非高峰 1.00×/);
});

test('模型不再命中（复用换名为未收录）时摘除徽标', () => {
  const row = makeRow({ provider: PLAN, name: 'GLM-5.4' });
  const ctx = makeCtx([row], { isPeak: true });
  const api = run(ctx);
  api.syncModelPeakBadges();
  assert.ok(findBadge(row));
  row.children[0].children[0].attrs['title'] = 'GLM-5.3-Highspeed';
  row.attrs['data-testid'] = 'chat-model-select-item-' + PLAN + '/GLM-5.3-Highspeed';
  api.syncModelPeakBadges();
  assert.equal(findBadge(row), null, '门控通过实例按数据失配摘除');
});

test('快照无 peak 段整体静默（旧 Python/非桌面链）', () => {
  const row = makeRow({ provider: PLAN, name: 'GLM-5.4' });
  const api = run(makeCtx([row], { data: { session: {} } }));
  api.syncModelPeakBadges();
  assert.equal(findBadge(row), null);
});

test('格式化与匹配工具函数', () => {
  const api = run(makeCtx([], {}));
  assert.equal(api.zuPeakFormat(2.0), '2.00×');
  assert.equal(api.zuPeakFormat(0.67), '0.67×');
  assert.equal(api.zuPeakFormat(1), '1.00×');
  assert.equal(api.zuPeakFormat(0.4), '0.40×');
  assert.equal(api.zuPeakFormat(1.2), '1.20×');
  const factors = [['glm-5.4', 0.67, 2.0], ['glm-5.3', 1.0, 3.0], ['glm-5.3-flash', 0.4, 1.2],
    ['glm-5.3-flashx', 1.0, 3.0]];
  assert.equal(api.zuPeakMatchFactor('GLM-5.3-Flash', factors)[2], 1.2);
  assert.equal(api.zuPeakMatchFactor('GLM-5.3-FlashX', factors)[1], 1.0, 'flashx 命中自身键（体验版）');
  /* 键身份断言：flashx 系数恰与 glm-5.3 同为 1.0/3.0，值断言杀不死「子串先命中 glm-5.3」
   * 类变异（变异审查缺口⑦）——必须锁返回条目的键 */
  assert.equal(api.zuPeakMatchFactor('GLM-5.3-FlashX', factors)[0], 'glm-5.3-flashx');
  assert.equal(api.zuPeakMatchFactor('GLM-5.3-Flash', factors)[0], 'glm-5.3-flash');
  assert.equal(api.zuPeakMatchFactor('GLM-5.3-Highspeed', factors), null);
  assert.equal(api.zuPeakFamilyOk('account:zai-team-coding-plan'), true);
  assert.equal(api.zuPeakFamilyOk('account:bigmodel-individual-coding-plan'), true);
  assert.equal(api.zuPeakFamilyOk('account:zai-start-plan'), false, 'start-plan 无官方系数');
  assert.equal(api.zuPeakFamilyOk('bigmodel'), false, 'API key 无 account: 前缀');
  assert.equal(api.zuPeakFamilyOk(''), false);
});

test('徽标自身 title 不被当模型名（防挂摘振荡）', () => {
  const row = makeRow({ testidValue: 'plain-model' });   // testid 无 / 段、名字 span 无 title 的漂移形态
  const cont = row.children[0];
  cont.children[0].textContent = 'GLM-5.4';
  const stale = el('span');
  stale.setAttribute('data-zusage-peak', '1');
  stale.setAttribute('title', '高峰 3.00× · 非高峰 1.00×（额度消耗倍率）');
  stale.textContent = '3.00×';
  cont.appendChild(stale);
  const api = run(makeCtx([row], { isPeak: true, paneProvider: PLAN }));
  api.syncModelPeakBadges();
  api.syncModelPeakBadges();   // 第二拍不复现「摘除→下拍重挂」振荡
  const badge = findBadge(row);
  assert.ok(badge, 'textContent 精确命中后徽标应稳定保留');
  assert.match(badge.attrs['title'], /周一至五/);
});

test('ZCode 4.0 冒号编码 testid（custom:account%3A...）无需祖先键或斜杠', () => {
  const row = makeRow({
    testidValue: 'custom:account%3Abigmodel-individual-coding-plan:GLM-5.4',
    title: 'GLM-5.4',
  });
  const api = run(makeCtx([row], { isPeak: false, paneProvider: '' }));
  api.syncModelPeakBadges();
  api.syncModelPeakBadges();
  const badge = findBadge(row);
  assert.ok(badge, '应从冒号格式解码出 account:bigmodel-individual-coding-plan 与 GLM-5.4');
  assert.equal(badge.textContent, '0.67×');
});

test('span 回退跳过外层容器 textContent 与能力徽标，优先取内层 title/叶子', () => {
  const row = makeRow({ testidValue: 'plain-model' });
  const cont = row.children[0];
  cont.textContent = 'GLM-5.3-Flash视觉';   // 模拟外层 span.flex-1 拼接后的 textContent
  cont.children[0].setAttribute('title', 'GLM-5.3-Flash');
  cont.children[0].textContent = 'GLM-5.3-Flash';
  const api = run(makeCtx([row], { isPeak: false, paneProvider: PLAN }));
  api.syncModelPeakBadges();
  api.syncModelPeakBadges();
  const badge = findBadge(row);
  assert.ok(badge, '应取内层 title 而非外层拼接 textContent');
  assert.equal(badge.textContent, '0.40×');
});
