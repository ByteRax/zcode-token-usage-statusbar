"""Compose the README covers from the reviewed CDP crops in features/live.

Run with: uv run --with playwright python docs/promo/shoot_cover.py [output_directory]
"""
import subprocess
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

here = Path(__file__).resolve().parent
out = Path(sys.argv[1]) if len(sys.argv) > 1 else here
out.mkdir(parents=True, exist_ok=True)


def save_shot(page, target):
    if target.suffix.lower() == ".webp":
        tmp = target.with_suffix(".tmp.png")
        page.screenshot(path=str(tmp))
        subprocess.run(["cwebp", "-quiet", "-m", "6", "-q", "75", str(tmp), "-o", str(target)], check=True)
        tmp.unlink()
    else:
        page.screenshot(path=str(target))


with sync_playwright() as p:
    try:
        browser = p.chromium.launch()
    except Exception:
        browser = p.chromium.launch(channel='chrome')
    page = browser.new_page(viewport={'width': 1280, 'height': 720}, device_scale_factor=2)
    for lang, name in [('zh', 'promo.webp'), ('en', 'promo.en.webp')]:
        page.goto((here / 'cover-live.html').as_uri() + '?lang=' + lang)
        problems = page.evaluate("""() => [...document.querySelectorAll('header, figure, img, footer')].filter(el => {
            const r = el.getBoundingClientRect();
            return r.bottom > innerHeight || r.right > innerWidth || r.width === 0 ||
                (el instanceof HTMLImageElement && el.naturalWidth === 0)
        }).map(el => el.outerHTML.slice(0, 100))""")
        assert not problems, problems
        save_shot(page, out / name)
        print(name, 'problems: []')
