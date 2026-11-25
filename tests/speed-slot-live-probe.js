/* 速度格实机量宽探针（specs/speed-chip-stable-slot.md）——在 ZCode 渲染进程里执行的表达式，由
   tests/speed-slot-live-probe.py 经 CDP(9229) 送入。对当前页面的第一条状态条：逐档（默认四档 + 药丸三档）
   × 三种界面字号（当前值 / 11px / 20px）× 全部状态面，把速度格的格面换成各种状态文案后量矩形。
   页面里有精简主题的工具栏速率 chip（.zu-tsb）时，另量它的三档（精简主题下状态条隐藏且可能没有速度格，
   此时只量 chip）。
   同一个同步表达式里临时显示条并切换档位类，量完全部还原（中间不让出事件循环，不会画到屏幕上）。
   面分两类记宽（specs/speed-chip-stable-slot.md「占位」）：带状态词的面记 speedW / turnL，
   完成态（无状态词）记 plainW / plainTurnL——v459 起全部格面固定宽，两类都必须等于 6.6em × 格字号
   （极窄档 2.75em）。精简 chip v466 起按内容定宽、档位 em（12.4/9.7/6.6em）只是上限：宽度随面变，只查越界。
   状态面与 zuSpeedFaceHtml 同构、不经数据链；数据链的行为由 tests/overlay-pill-theme.test.cjs 锁定。 */
(() => {
  const bar = document.querySelector('.zusage-root');
  const tsb = document.querySelector('.zu-tsb');
  if (!bar && !tsb) return { error: '页面上没有状态条（.zusage-root）也没有精简速率 chip（.zu-tsb）' };
  const F = (label, val, unit) => '<span class="zu-sp-label">' + label + '</span><span class="zu-sp-val">' + val + '</span>' +
    (unit ? '<span class="zu-sp-unit dim">' + unit + '</span>' : '');
  const G = (label, val) => '<span class="zu-sp-label zu-sp-glue">' + label + '</span><span class="zu-sp-val">' + val + '</span>';   // v461 子代理面「子·X」：与 zuSpeedFaceHtml 同构（标签带 zu-sp-glue）
  const faces = {
    '完成 201': F('', '201', 't/s'), '回退 201.4': F('', '201.4', 't/s'), '完成 9.9': F('', '9.9', 't/s'), '完成 250.0': F('', '250.0', 't/s'),
    '估算 128.6': F('生成', '128.6', 't/s'), '估算 9999.9': F('生成', '9999.9', 't/s'), '估算 12.9k': F('生成', '12.9k', 't/s'),
    '思考 0.5s': F('思考', '0.5s'), '思考 6:33': F('思考', '6:33'), '思考 23:59:59': F('思考', '23:59:59'), '思考 1:05:00': F('思考', '1:05:00'),
    '思考 1天3时': F('思考', '1天3时'), '工具 读取': F('读取', '01s'), '工具组 查阅': F('查阅', '03s'), '技能 长名': F('代码审查与修复', '12s'),
    '子代理 ·128.6': G('子·', '128.6'), '子代理 ·28.8': G('子·', '28.8'), '子代理 1286.5': G('子', '1286.5'),
    'en Think': F('Think', '23:59:59'), 'en Ag·': G('Ag·', '128.6'), 'en A': G('A', '1286.5'), 'en Gen': F('Gen', '9999.9', 't/s'), 'en skill': F('code-review-and-fix', '12s'),
  };
  const R = e => e.getBoundingClientRect();
  const r2 = x => Math.round(x * 100) / 100;
  /* 量一个盒子：逐状态面换内容后记宽度、邻格 left、两侧余量与越界。setFace 每次对当前在 DOM 里的节点操作 */
  const measure = (box, setFace, neighbour, rowName) => {
    const row = {};
    for (const [key, html] of Object.entries(faces)) {
      setFace(html);
      const cs = getComputedStyle(box), rect = R(box), live = box.querySelector('.zu-live');
      if (!live) continue;
      const items = [...live.children].filter(e => getComputedStyle(e).display !== 'none');
      const label = live.querySelector('.zu-sp-label');
      const plain = !label || !label.textContent;   // 完成态（无状态词）：单独一组记宽
      (plain ? (row.plainW = row.plainW || []) : (row.speedW = row.speedW || [])).push(r2(rect.width));
      if (neighbour) (plain ? (row.plainTurnL = row.plainTurnL || []) : (row.turnL = row.turnL || [])).push(r2(R(neighbour).left));
      if (items.length) {
        /* 越界判数值本体（.zu-sp-val）；unit 允许在长数值面裁尾（dim 辅助） */
        const valEl = live.querySelector('.zu-sp-val');
        const slack = valEl ? (rect.right - parseFloat(cs.paddingRight)) - R(valEl).right : (rect.right - parseFloat(cs.paddingRight)) - R(items[items.length - 1]).right;   // 数值右缘余量（<0 即数字被裁）
        const lead = R(items[0]).left - R(live).left;                                                  // 左侧余量（内容成组靠左后恒为 0，<0 即越界）
        row.minSlack = Math.min(row.minSlack === undefined ? 99 : row.minSlack, r2(slack));
        row.minLead = Math.min(row.minLead === undefined ? 99 : row.minLead, r2(lead));
        if (slack < -0.05 || lead < -0.05) { (row.overflow = row.overflow || []).push(key); row.overflowPx = row.overflowPx || {}; row.overflowPx[key] = r2(Math.min(slack, lead)); }
      }
    }
    if (!row.speedW && !row.plainW) return null;
    row.fs = getComputedStyle(box).fontSize;
    row.speedW = [...new Set(row.speedW || [])];
    row.plainW = [...new Set(row.plainW || [])];
    row.turnL = [...new Set(row.turnL || [])];
    row.plainTurnL = [...new Set(row.plainTurnL || [])];
    row.overflow = row.overflow || [];
    row.overflowPx = row.overflowPx || {};
    return row;
  };
  const res = {};
  const setVar = v => { if (v) document.documentElement.style.setProperty('--ui-font-size', v); else if (save.rootVar) document.documentElement.style.setProperty('--ui-font-size', save.rootVar); else document.documentElement.style.removeProperty('--ui-font-size'); };
  const baseUi = getComputedStyle(document.documentElement).getPropertyValue('--ui-font-size').trim() || '14px';
  const barMain = bar && bar.querySelector('.zu-main');
  const speed = barMain && barMain.querySelector('.it.zu-speed');
  const barOk = !!(speed && speed.querySelector('.zu-live'));
  const origLive = barOk ? speed.querySelector('.zu-live').outerHTML : null;
  const save = { barStyle: bar ? bar.getAttribute('style') : null, barCls: bar ? bar.className : null, rootVar: document.documentElement.style.getPropertyValue('--ui-font-size') };
  const tsbSave = tsb ? { cls: tsb.className, live: tsb.querySelector('.zu-live') ? tsb.querySelector('.zu-live').outerHTML : null, prev: tsb.previousElementSibling } : null;
  try {
    if (barOk) {
      bar.style.display = '';
      const lock = Math.round(R(bar.parentElement).width) + 'px';
      const tiers = [
        ['默认 宽裕', [], null, ''], ['默认 中等', ['zu-tight'], null, ''], ['默认 紧张', ['zu-tight', 'zu-narrow'], null, ''], ['默认 极窄', ['zu-tight', 'zu-narrow'], '1', ''],
        ['药丸 宽裕', ['zu-pill'], null, 'pill'], ['药丸 中等', ['zu-pill', 'zu-speed-mid'], null, 'pill'], ['药丸 紧张', ['zu-pill', 'zu-speed-tight'], null, 'pill'],
      ];
      const setFace = html => {
        const cur = speed.querySelector('.zu-live');
        if (cur) cur.outerHTML = '<span class="zu-live zu-sky">' + html + '</span>'; else speed.insertAdjacentHTML('beforeend', '<span class="zu-live zu-sky">' + html + '</span>');
      };
      for (const ui of [null, '11px', '20px']) {
        setVar(ui);
        for (const [name, cls, min, mode] of tiers) {
          bar.className = 'zusage-root' + (mode === 'pill' ? ' zu-pill' : ' zu-in') + cls.map(c => ' ' + c).join('');
          bar.style.minWidth = mode === 'pill' ? '' : lock;
          bar.style.maxWidth = mode === 'pill' ? '' : lock;
          if (min) speed.dataset.zuSpeedMin = min; else delete speed.dataset.zuSpeedMin;
          const turn = barMain.querySelector('.it[data-zu-key="turn"]');
          res[(ui || baseUi) + ' ' + name] = measure(speed, setFace, turn);
        }
      }
    }
    if (tsb) {
      const setFace = html => {
        const cur = tsb.querySelector('.zu-live');
        if (cur) cur.outerHTML = '<span class="zu-live zu-sky">' + html + '</span>'; else tsb.insertAdjacentHTML('beforeend', '<span class="zu-live zu-sky">' + html + '</span>');
      };
      for (const ui of [null, '11px', '20px']) {
        setVar(ui);
        for (const [name, cls] of [['精简 宽裕', ''], ['精简 中等', 'zu-speed-mid'], ['精简 紧张', 'zu-speed-tight']]) {
          tsb.className = 'zu-tsb' + (cls ? ' ' + cls : '');
          res[(ui || baseUi) + ' ' + name] = measure(tsb, setFace, tsbSave.prev);
        }
      }
    }
    const fontSource = barOk ? speed : tsb;
    return { meta: { uiFont: baseUi, dpr: devicePixelRatio, font: getComputedStyle(fontSource).fontFamily.slice(0, 90),
      platform: navigator.platform || '', lang: document.documentElement.lang || '', hidden: document.hidden }, tiers: res };
  } finally {
    setVar(null);
    if (bar) {
      bar.setAttribute('style', save.barStyle || '');
      bar.className = save.barCls;
      if (origLive) {
        const cur = speed.querySelector('.zu-live');
        if (cur) cur.outerHTML = origLive; else speed.insertAdjacentHTML('beforeend', origLive);
      }
      if (speed) delete speed.dataset.zuSpeedMin;
    }
    if (tsb) {
      tsb.className = tsbSave.cls;
      const cur = tsb.querySelector('.zu-live');
      if (tsbSave.live) { if (cur) cur.outerHTML = tsbSave.live; else tsb.insertAdjacentHTML('beforeend', tsbSave.live); }
      else if (cur) cur.remove();
    }
  }
})()
