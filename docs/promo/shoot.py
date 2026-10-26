# -*- coding: utf-8 -*-
"""宣传图导出：Playwright 打开 promo.html（真实 overlay.js 渲染状态条），
用真实鼠标悬停「会话累计」弹出明细 tooltip，按 2 倍像素密度导出 promo.png（2560×1440）。
同时打印版面自检结果：条是否触发收缩/渐隐、tooltip 与注释是否压住正文、标注与安装区是否越界、重叠或溢出。
用法（仓库根目录）：uv run --with playwright python docs/promo/shoot.py [html] [输出] [宽] [高] [悬停项序号|none]
不传参数时默认 promo.html → promo.png 1280x720 悬停第 3 项；传 none 跳过悬停（无 tooltip 的静态版式）。
"""
import json
import pathlib
import sys

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
HTML_NAME = sys.argv[1] if len(sys.argv) > 1 else "promo.html"
OUT_NAME = sys.argv[2] if len(sys.argv) > 2 else "promo.png"
URL = (HERE / HTML_NAME).as_uri()
OUT = pathlib.Path(OUT_NAME)
if not OUT.is_absolute():
    OUT = HERE / OUT
W = int(sys.argv[3]) if len(sys.argv) > 3 else 1280
H = int(sys.argv[4]) if len(sys.argv) > 4 else 720
SCALE = 2
HOVER_ARG = sys.argv[5] if len(sys.argv) > 5 else "2"
HOVER_INDEX = None if HOVER_ARG == "none" else int(HOVER_ARG)   # 条面 .it 顺序：0 速度 1 本轮 2 会话累计 3 工具 4 今日 5 子代理

CHECK_JS = """() => {
  const R = el => { const r = el.getBoundingClientRect(); return {l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height}; };
  const hit = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
  const bar = document.getElementById('zusage-bar');
  const main = document.querySelector('#zusage-bar .zu-main');
  const tip = document.getElementById('zusage-tip');
  const its = [...main.querySelectorAll('.it')];
  const installEl = document.querySelector('.pm-install');
  const out = {
    bar: R(bar), card: R(document.querySelector('.pm-composer')), win: R(document.querySelector('.pm-win')),
    barFont: getComputedStyle(bar).fontFamily.slice(0, 40), barFontSize: getComputedStyle(bar).fontSize,
    overflowPx: main.scrollWidth - main.clientWidth, clipped: main.classList.contains('zu-clip'),
    items: its.map(e => e.textContent.trim()),
    tipVisible: !!tip && getComputedStyle(tip).display !== 'none', tip: tip ? R(tip) : null,
    tipText: tip ? tip.innerText.replace(/\\n+/g, ' | ') : '',
    pingfang: document.fonts.check('16px "PingFang SC"'),
    problems: [],
  };
  const solid = [...document.querySelectorAll('.pm-user, .pm-steps, .pm-bot p, #pm-rate')].map(e => [e.className || e.id, R(e)]);
  const notes = [...document.querySelectorAll('.pm-note')].map(e => ['note:' + e.textContent, R(e)]);
  const labels = [...document.querySelectorAll('.pm-label')].map(e => ['label:' + e.textContent, R(e)]);
  const install = installEl ? R(installEl) : null;
  if (out.tip) solid.forEach(([n, r]) => { if (hit(out.tip, r)) out.problems.push('tooltip 压住 ' + n); });
  notes.forEach(([n, r]) => {
    solid.concat(out.tip ? [['tooltip', out.tip]] : []).forEach(([m, s]) => { if (hit(r, s)) out.problems.push(n + ' 压住 ' + m); });
    if (r.r > out.card.r || r.l < out.card.l) out.problems.push(n + ' 超出对话列');
  });
  labels.forEach(([n, r], i) => {
    labels.slice(i + 1).forEach(([m, s]) => { if (hit(r, s)) out.problems.push(n + ' 与 ' + m + ' 重叠'); });
    if (install && r.b + 12 > install.t) out.problems.push(n + ' 离安装区过近');
  });
  if (R(document.querySelector('.pm-head')).b + 12 > out.win.t) out.problems.push('标题区离窗口过近');
  if (install && install.b > innerHeight - 12) out.problems.push('安装区离画布底边过近');
  document.querySelectorAll('.pm-ihead > *, .pm-ct, .pm-chip, .pm-cnote').forEach(e => {
    // nowrap 文字溢出时元素框不变，要量文字本身的范围；卡片内文字距左右边框至少 12px、上下至少 8px
    const rg = document.createRange(); rg.selectNodeContents(e);
    const t = rg.getBoundingClientRect(), r = R(e), right = Math.max(t.right, r.r), bottom = Math.max(t.bottom, r.b);
    const card = e.closest('.pm-card'), box = R(card || e.closest('.pm-ihead'));
    if (right > box.r - (card ? 12 : 0) || bottom > box.b - (card ? 8 : 0)) out.problems.push('安装区文字溢出/贴边：' + e.textContent.slice(0, 18));
  });
  out.cards = [...document.querySelectorAll('.pm-card')].map(c => {
    const rg = document.createRange(); rg.selectNodeContents(c.querySelector('.pm-cin'));
    const box = R(c), t = rg.getBoundingClientRect();
    return {w: box.w, padL: Math.round(t.left - box.l), padR: Math.round(box.r - t.right), padT: Math.round(t.top - box.t), padB: Math.round(box.b - t.bottom)};
  });
  // 社交图特有的卡片（.pm-feat / .pm-cta）：同样按文字实际范围查溢出/贴边
  document.querySelectorAll('.pm-feat-t b, .pm-feat-t span, .pm-cta-t b, .pm-cta-t span, .pm-cta-tag').forEach(e => {
    const rg = document.createRange(); rg.selectNodeContents(e);
    const t = rg.getBoundingClientRect(), box = R(e.closest('.pm-feat, .pm-cta'));
    if (t.right > box.r - 10 || t.bottom > box.b - 8) out.problems.push('卡片文字溢出/贴边：' + e.textContent.slice(0, 18));
  });
  [...document.querySelectorAll('.pm-feat')].forEach((a, i, arr) => {
    arr.slice(i + 1).forEach(b => { if (hit(R(a), R(b))) out.problems.push('feature 卡片重叠'); });
  });
  // 卡片必须装得进网格容器：容器声明的高度比内容矮时卡片会溢出、压到下面的版块
  // （CSS grid 的 1fr 行不会因为内容变高而撑大固定高度的容器）
  const featsEl = document.querySelector('.pm-feats');
  if (featsEl) {
    const fb = R(featsEl);
    [...featsEl.querySelectorAll('.pm-feat')].forEach((c, i) => {
      const cb = R(c);
      if (cb.b > fb.b + 0.5) out.problems.push('feature 卡片 ' + (i + 1) + ' 超出网格容器 ' + Math.round(cb.b - fb.b) + 'px');
    });
  }
  // 纵向堆叠的大版块（标题区/功能格/状态条窗口/CTA，按存在与否自动跳过）依次检查不重叠与间距。
  // 必须把名字和矩形配成对再过滤，不能用平行数组——某些版式（16:9 的两份）没有 .pm-feats，
  // 过滤后下标会与选择器数组错位，报错信息就会张冠李戴。
  const stack = [['标题区', '.pm-head'], ['功能格', '.pm-feats'], ['状态条窗口', '.pm-win'], ['CTA', '.pm-cta']]
    .map(([name, sel]) => { const el = document.querySelector(sel); return el ? { name, sel, r: R(el) } : null; })
    .filter(Boolean);
  for (let i = 1; i < stack.length; i++) {
    const gap = stack[i].r.t - stack[i - 1].r.b;
    if (gap < 0) out.problems.push('版块纵向重叠：' + stack[i - 1].name + ' 底部压到 ' + stack[i].name);
    // 纯堆叠的社交版式（有 .pm-cta）里，两版块贴得比 16px 还近会连成一块（已过验收的
    // 16:9/4:3 版式最小间距是 20px，不受影响）；16:9 的 README 版是"标题紧接窗口"的既有
    // 版式，也不受这条约束
    else if (installEl === null && document.querySelector('.pm-cta') && gap < 16) {
      out.problems.push('版块间距过小：' + stack[i - 1].name + ' 与 ' + stack[i].name + ' 仅 ' + Math.round(gap) + 'px');
    }
  }
  if (stack.length && document.querySelector('.pm-cta')) {
    // 顶/底留白失衡只在"全靠纵向堆叠四块、下面没有其它内容"的社交图版式里有意义；
    // GitHub 版（promo.html/promo.en.html）win 下面还有安装区，不受这条约束
    const topGap = stack[0].r.t, bottomGap = innerHeight - stack[stack.length - 1].r.b;
    out.stackMargins = { top: Math.round(topGap), bottom: Math.round(bottomGap) };
    if (bottomGap > topGap * 3.2 || topGap > bottomGap * 3.2) out.problems.push('顶/底留白明显失衡：top=' + Math.round(topGap) + ' bottom=' + Math.round(bottomGap));
  }
  [...document.querySelectorAll('.pm-head, .pm-win, .pm-install, .pm-label, .pm-note, .pm-feats, .pm-cta, .pm-foot, #zusage-bar, #zusage-tip')].forEach(e => {
    const r = R(e); if (r.l < 0 || r.t < 0 || r.r > innerWidth || r.b > innerHeight) out.problems.push('越出画布 ' + (e.id || e.className));
  });
  if (out.bar.b > out.win.b - 2) out.problems.push('状态条贴住/越出窗口底边');
  if (out.overflowPx > 0 || out.clipped) out.problems.push('条面内容超宽（收缩/渐隐）');
  if (!out.items.some((t, i) => i === 1 && /%/.test(t)) || !out.items.some((t, i) => i === 2 && /%/.test(t))) out.problems.push('缓存命中率被收缩隐藏');
  return out;
}"""

with sync_playwright() as p:
    try:
        browser = p.chromium.launch()
    except Exception:   # 未执行 playwright install 时改用本机 Google Chrome
        browser = p.chromium.launch(channel="chrome")
    page = browser.new_page(viewport={"width": W, "height": H}, device_scale_factor=SCALE)
    page.goto(URL, wait_until="load")
    page.wait_for_function("window.__promoReady === true", timeout=20000)
    if HOVER_INDEX is not None:
        # 先停在页面顶部空白处再移向目标：跨过 overlay 150ms 的 mousemove 节流窗口
        page.mouse.move(W / 2, 6)
        page.wait_for_timeout(300)
        box = page.locator("#zusage-bar .zu-main .it").nth(HOVER_INDEX).bounding_box()
        x, y = box["x"] + box["width"] * 0.38, box["y"] + box["height"] * 0.62
        page.mouse.move(x, y)
        page.wait_for_selector("#zusage-tip", state="visible", timeout=5000)
        page.wait_for_timeout(500)
        if page.evaluate("typeof window.__promoAfterHover === 'function'"):
            page.evaluate("([x, y]) => window.__promoAfterHover(x, y)", [x, y])
        page.wait_for_timeout(300)
    else:
        page.wait_for_timeout(300)
    report = page.evaluate(CHECK_JS)
    page.screenshot(path=str(OUT))
    browser.close()

print(json.dumps(report, ensure_ascii=False, indent=1))
print("saved ->", OUT)
sys.exit(1 if report["problems"] else 0)
