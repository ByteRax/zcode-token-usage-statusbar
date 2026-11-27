"""Capture the README's linked close-ups with the current overlay and demo data.

Run from the repo root: uv run --with playwright python docs/promo/shoot_features.py
Pass an output directory to preview the whole set without touching the README assets.
"""
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1]))
import zusage


def sample_usage(language):
    with sqlite3.connect(":memory:") as db:
        db.execute("""create table model_usage (
            status, completed_at, input_tokens, output_tokens, cache_read_input_tokens,
            computed_total_tokens, duration_ms, reasoning_tokens, retry_count, cache_creation_input_tokens
        )""")
        db.executemany("insert into model_usage values ('completed', ?, ?, ?, ?, ?, ?, ?, 0, 0)", [
            (int(time.time() * 1000), 312000, 2320, 302600, 314320, 29100, 800),
        ] * 121)
        zusage._LANG = language
        return zusage.render_today(db)


def cell(key):
    return f'.it[data-zu-key="{key}"]'


def capture(page, name):
    tooltip = "#zusage-tip"
    targets = {
        "system": (cell("sysmon"), ".zusage-sysmon-tip:visible, #zusage-tip:visible"),
        "prompt-enhance": (".zu-enhance", ".zusage-enhance-tip:visible"),
        "estimated-cost": (cell("win"), tooltip),
        "today": (cell("today"), tooltip),
        "subagents": (".zu-sub", ".zu-sub-pop.open"),
        "ssh": (cell("system"), ".pm-composer", tooltip),
    }
    if name in targets:
        anchor, *crop = targets[name]
        page.mouse.move(640, 12)
        page.wait_for_timeout(220)
        page.locator(anchor).hover()
        if name == "prompt-enhance":
            page.wait_for_selector(".zu-eh-card", state="visible", timeout=3000)
        return crop
    if name == "model-pull":
        page.locator(".zu-mp-host").click()
        return [".zu-mp-modal", ".zu-mp-item"]
    if name == "peak-factor":
        return [".demo-host", "[data-zusage-peak]"]
    if name == "project-folder":
        return [".demo-host", "[data-zusage-open-folder]"]
    if name == "search":
        page.wait_for_function('document.querySelector(".demo-search").getBoundingClientRect().width >= innerWidth * .79')
        return [".demo-search"]
    if name == "usage-query":
        return [".demo-terminal"]
    raise ValueError(f"Unknown feature {name!r}")


def shoot(page, selectors, output):
    boxes = []
    for selector in selectors:
        target = page.locator(selector).first
        target.wait_for(state="visible", timeout=3000)
        boxes.append(target.bounding_box())
    width, height = page.viewport_size["width"], page.viewport_size["height"]
    x = max(0, min(box["x"] for box in boxes) - 10)
    y = max(0, min(box["y"] for box in boxes) - 10)
    right = min(width, max(box["x"] + box["width"] for box in boxes) + 10)
    bottom = min(height, max(box["y"] + box["height"] for box in boxes) + 10)
    assert all(0 <= box["x"] < width and 0 <= box["y"] < height and
               box["x"] + box["width"] <= width and box["y"] + box["height"] <= height
               for box in boxes), selectors
    clip = {"x": x, "y": y, "width": right - x, "height": bottom - y}
    if output.suffix.lower() == ".webp":
        tmp = output.with_suffix(".tmp.png")
        page.screenshot(path=str(tmp), clip=clip)
        subprocess.run(["cwebp", "-quiet", "-m", "6", "-q", "75", str(tmp), "-o", str(output)], check=True)
        tmp.unlink()
    else:
        page.screenshot(path=str(output), clip=clip)


FEATURES = (
    "system", "model-pull", "prompt-enhance", "estimated-cost", "today", "peak-factor",
    "project-folder", "search", "ssh", "subagents", "usage-query",
)


if __name__ == "__main__":
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "features"
    failures = []
    with sync_playwright() as p:
        try:
            browser = p.chromium.launch()
        except Exception:
            browser = p.chromium.launch(channel="chrome")
        for lang, filename in (("zh", "promo.html"), ("en", "promo.en.html")):
            directory = out if lang == "zh" else out / "en"
            directory.mkdir(parents=True, exist_ok=True)
            usage = sample_usage(lang)
            for name in sys.argv[2:] or FEATURES:
                viewport = {"width": 1280, "height": 720}
                page = browser.new_page(viewport=viewport, device_scale_factor=2)
                errors = []
                page.set_default_timeout(3500)
                page.on("pageerror", lambda exc: errors.append(str(exc)))
                try:
                    page.goto((HERE / filename).as_uri())
                    page.add_style_tag(path=HERE / "feature-scenes.css")
                    page.add_script_tag(path=HERE / "feature-scenes.js")
                    page.wait_for_function("typeof window.__zusageUpdate === 'function'")
                    page.evaluate("([name, usage]) => featureScene(name, usage)", [name, usage])
                    if name != "ssh":
                        page.wait_for_function("window.__promoReady === true", timeout=3500)
                    selectors = capture(page, name)
                    shoot(page, selectors, directory / f"{name}.webp")
                    if errors:
                        raise RuntimeError(errors)
                    print(f"{lang}/{name}: OK", flush=True)
                except Exception as exc:
                    failures.append(f"{lang}/{name}: {exc}")
                    print(failures[-1], flush=True)
                finally:
                    page.close()
        browser.close()
    if failures:
        sys.exit(f"{len(failures)} close-up(s) failed")
