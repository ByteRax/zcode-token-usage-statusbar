/* 速度格持续观察（specs/speed-chip-stable-slot.md）——tests/speed-slot-live-probe.py --watch 经 CDP(9229) 送入渲染进程的表达式，
   调用形如 (<本文件>)({ seconds: 60, every: 100 })，返回观察结束后的样本。观察期间定时读取页面上每一条状态条的速度格：
   宽度、位置、格面（图标种类 + 标签/数值/单位文字）、数值是否越界，外加与速度格自身宽度无关的布局签名（档位类、最窄标记、
   格字号、条父元素宽度、窗口内宽、界面字号、像素比、面类别）——宽度若随内容变，会落进同一签名；判定在 Python 侧 summarize()。
   面类别（第 8 段 plain / tag）：只用于报告（v458 起全部格面固定宽，判定按前 7 段归组，跨面类别宽度不同即异常，
   specs/speed-chip-stable-slot.md「占位」）；zu-sp-roomy（窄档真实空位）算档位类，进第 1 段。
   只读：不改页面、不写入数据；到时自停并清掉定时器；重复启动先停上一次。窗口隐藏时页面定时器被宿主节流，样本会变稀
   （带 hid 标记）；速度格不可见（被折叠或宽度为 0）的拍只记原因，不计入判定。最窄档只显示图标，格面靠图标种类区分。 */
OPTS => new Promise(resolve => {
  if (typeof window.__zuSpeedWatchStop === 'function') window.__zuSpeedWatchStop();
  const every = Math.max(50, Number(OPTS.every) || 100), seconds = Math.min(600, Math.max(1, Number(OPTS.seconds) || 30));
  const r2 = x => Math.round(x * 100) / 100;
  const TIER = ['zu-pill', 'zu-tight', 'zu-narrow', 'zu-speed-mid', 'zu-speed-tight', 'zu-sp-roomy'];
  const uiFont = () => getComputedStyle(document.documentElement).getPropertyValue('--ui-font-size').trim();
  const sigs = [], samples = [];
  const sigId = sig => { const i = sigs.indexOf(sig); return i < 0 ? sigs.push(sig) - 1 : i; };
  const tick = () => {
    const t = Date.now(), ui = uiFont(), hid = document.hidden ? 1 : 0;
    const bars = document.querySelectorAll('.zusage-root');
    if (!bars.length) samples.push({ t, b: 0, none: 'nobar', hid });
    bars.forEach((bar, b) => {
      const speed = bar.querySelector('.zu-main > .it.zu-speed'), box = speed && speed.getBoundingClientRect();
      if (!speed) { samples.push({ t, b, none: 'nocell', hid }); return; }
      if (!box.width) { samples.push({ t, b, none: getComputedStyle(speed).display === 'none' ? 'folded' : 'invisible', hid }); return; }
      const ico = speed.querySelector('.ico'), live = speed.querySelector('.zu-live');
      const liveOn = !!live && getComputedStyle(live).display !== 'none';
      const items = liveOn ? [...live.children].filter(e => getComputedStyle(e).display !== 'none') : [];
      const icon = !ico ? 'none' : ico.classList.contains('zu-think') ? 'think' : /M14\.5 2\.5a6 6/.test(ico.innerHTML) ? 'tool' : 'bolt';
      const face = icon + '|' + items.map(e => e.textContent).filter(Boolean).join(' ');
      let ov = 0;
      if (items.length) {
        const contentRight = box.right - parseFloat(getComputedStyle(speed).paddingRight), liveLeft = live.getBoundingClientRect().left;
        if (contentRight - items[items.length - 1].getBoundingClientRect().right < -0.05 || items[0].getBoundingClientRect().left - liveLeft < -0.05) ov = 1;
      }
      const label = live ? live.querySelector('.zu-sp-label') : null;
      const plain = !label || !label.textContent;   // 面类别：无状态词（完成态）/ 有状态词
      const sig = TIER.filter(c => bar.classList.contains(c)).join(' ') + '|' + (speed.dataset.zuSpeedMin || '') + '|' +
        getComputedStyle(speed).fontSize + '|' + r2(bar.parentElement.getBoundingClientRect().width) + '|' + window.innerWidth + '|' + ui + '|' + devicePixelRatio + '|' + (plain ? 'plain' : 'tag');
      samples.push({ t, b, hid, s: sigId(sig), w: r2(box.width), l: r2(box.left), f: face, ov });
    });
  };
  let timer = 0, deadline = 0;
  const stop = () => { clearInterval(timer); clearTimeout(deadline); delete window.__zuSpeedWatchStop; };
  window.__zuSpeedWatchStop = stop;
  timer = setInterval(tick, every);
  deadline = setTimeout(() => { tick(); stop(); resolve({ meta: { seconds, every, uiFont: uiFont(), dpr: devicePixelRatio, width: window.innerWidth,
    platform: navigator.platform || '', hiddenAtEnd: document.hidden, tsb: document.querySelectorAll('.zu-tsb').length }, sigs, samples }); }, seconds * 1000);
  tick();
})
