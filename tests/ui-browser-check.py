"""Isolated desktop-overlay UI checks; requires Playwright and Chromium/Chrome.

Run from the repository root with a loopback HTTP server on port 8799:
uv run --with playwright python tests/ui-browser-check.py
No host database, credentials, installed plugin or update service is used.
"""
import json
from pathlib import Path
import subprocess

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "ui-review"
OUT.mkdir(exist_ok=True)
URL = "http://127.0.0.1:8799/tests/ui-fixture.html"

METRICS = """() => {
 const rect = e => {const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}};
 const rgb = v => {const c=document.createElement('canvas').getContext('2d');c.fillStyle=v;return c.fillStyle};
 const rgba = v => {const c=document.createElement('canvas').getContext('2d'); c.clearRect(0,0,1,1);c.fillStyle=v;c.fillRect(0,0,1,1);return [...c.getImageData(0,0,1,1).data].map((n,i)=>i===3?n/255:n)};
 const over=(a,b)=>[...a.slice(0,3).map((x,i)=>x*a[3]+b[i]*(1-a[3])),1];
 const background=e=>{const chain=[];for(let n=e;n;n=n.parentElement)chain.unshift(n);let b=[255,255,255,1];for(const n of chain)b=over(rgba(getComputedStyle(n).backgroundColor),b);return b};
 const lum=c=>c.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
 const contrast=(a,b)=>(Math.max(lum(a),lum(b))+.05)/(Math.min(lum(a),lum(b))+.05);
 const selectors=['.zusage-root .v','.zusage-root .dim','.zu-gear','.zusage-tip-root .rt-h','.zusage-tip-root .rt-row b','.zusage-tip-root .rt-row span','.zu-settings .cap','.zu-settings label em','.zu-settings .zu-navitem[aria-current]'];
 const samples=selectors.flatMap(selector=>{const e=document.querySelector(selector);if(!e||!e.getBoundingClientRect().width)return[];const s=getComputedStyle(e),b=background(e);return [{selector,color:s.color,background:b,contrast:Math.round(contrast(over(rgba(s.color),b),b)*100)/100,font:s.fontSize,weight:s.fontWeight,rect:rect(e)}]});
 const bar=document.querySelector('.zusage-root'),main=bar.querySelector('.zu-main'),panel=document.querySelector('.zu-settings'),tip=document.querySelector('.zusage-tip-root');
 return {viewport:{w:innerWidth,h:innerHeight},bar:rect(bar),gear:rect(bar.querySelector('.zu-gear')),overflow:main.scrollWidth-main.clientWidth,clipped:main.classList.contains('zu-clip'),panel:rect(panel),tip:rect(tip),rail:panel.classList.contains('zu-nav-icons'),samples,errors:window.__zusageDiag};
}"""


def start_page(browser, width=1280, theme="dark", lang="zh", font=14, baseline=None):
    page = browser.new_page(viewport={"width": width, "height": 720}, device_scale_factor=1)
    if baseline is not None:
        page.route("**/overlay.js", lambda route: route.fulfill(body=baseline, content_type="text/javascript"))
    page.goto(URL + "?theme=" + theme + "&lang=" + lang + "&font=" + str(font))
    page.wait_for_function("document.querySelector('.zusage-root')?.getBoundingClientRect().width > 0")
    page.evaluate("feedFixture()")
    return page


def capture_comparison(browser, baseline):
    reports = {}
    for label, source in [("before", baseline), ("after", None)]:
        page = start_page(browser, baseline=source)
        page.screenshot(path=str(OUT / (label + "-bar.png")))
        page.locator(".zu-main .it").nth(1).hover()
        page.locator("#zusage-tip").wait_for(state="visible")
        page.screenshot(path=str(OUT / (label + "-turn.png")))
        reports[label + "-turn"] = page.evaluate(METRICS)
        page.locator(".zu-gear").click()
        page.locator(".zu-settings.open").wait_for(state="visible")
        page.screenshot(path=str(OUT / (label + "-settings.png")))
        reports[label + "-settings"] = page.evaluate(METRICS)
        page.close()
    return reports


def check_matrix(browser):
    reports = []
    for theme in ["dark", "light", "inverse"]:
        for lang in ["zh", "en"]:
            for width, font in [(1280, 14), (560, 20)]:
                page = start_page(browser, width, theme, lang, font)
                page.locator(".zu-main .it").nth(1).hover()
                page.locator("#zusage-tip").wait_for(state="visible")
                report = page.evaluate(METRICS)
                report.update({"theme": theme, "lang": lang, "font": font})
                assert report["gear"]["x"] + report["gear"]["w"] <= width, report
                assert report["tip"]["x"] >= 0 and report["tip"]["x"] + report["tip"]["w"] <= width, report
                for sample in report["samples"]:
                    assert sample["contrast"] >= 4.5, sample
                # A real pointer can cross the existing corridor and remain on the tooltip.
                tip = page.locator("#zusage-tip").bounding_box()
                page.mouse.move(tip["x"] + tip["width"] / 2, tip["y"] + tip["height"] / 2, steps=10)
                page.wait_for_timeout(450)
                assert page.locator("#zusage-tip").is_visible()
                # Gear Enter opens settings; nav Enter switches sections and preserves panel height.
                page.locator(".zu-gear").focus()
                page.keyboard.press("Enter")
                page.locator(".zu-settings.open").wait_for(state="visible")
                height = page.locator(".zu-settings").bounding_box()["height"]
                quota_nav = page.locator('.zu-navitem[data-sec="quota"]')
                quota_nav.focus()
                page.keyboard.press("Enter")
                assert quota_nav.get_attribute("aria-current") == "page"
                assert page.locator(".zu-settings").bounding_box()["height"] == height
                page.locator('.zu-navitem[data-sec="general"]').hover()
                focus_state = quota_nav.evaluate("e=>({focused:e===document.activeElement,visible:e.matches(':focus-visible'),shadow:getComputedStyle(e).boxShadow})")
                assert focus_state["focused"] and focus_state["visible"] and "inset" in focus_state["shadow"], focus_state
                page.keyboard.press("Escape")
                assert page.locator(".zu-gear").evaluate("e=>e===document.activeElement")
                assert not page.locator(".zu-settings").evaluate("e=>e.classList.contains('open')")
                page.locator(".zu-gear").focus()
                page.keyboard.press("Enter")
                page.locator(".zu-settings.open").wait_for(state="visible")
                page.locator('.zu-navitem[data-sec="quota"]').click()
                if width < 620:
                    assert page.locator(".zu-settings").evaluate("e=>e.classList.contains('zu-nav-icons')")
                    assert page.locator('.zu-navitem[data-sec="quota"]').get_attribute("title")
                report["settings"] = page.evaluate(METRICS)
                page.screenshot(path=str(OUT / (theme + "-" + lang + "-" + str(width) + ".png")))
                page.keyboard.press("Escape")
                assert page.locator(".zu-gear").evaluate("e=>e===document.activeElement")
                assert not page.locator(".zu-settings").evaluate("e=>e.classList.contains('open')")
                page.locator(".zu-sub").focus()
                page.keyboard.press("Space")
                page.locator(".subp.open").wait_for(state="visible")
                page.keyboard.press("Escape")
                assert page.locator(".zu-sub").evaluate("e=>e===document.activeElement")
                report["keyboard"] = "Enter/Space/Escape and focus return passed"
                reports.append(report)
                page.close()
    return reports


def check_feedback(browser):
    page = start_page(browser)
    page.locator(".zu-gear").click()
    page.locator('.zu-navitem[data-sec="quota"]').click()
    page.locator(".zu-quota-enable").uncheck()
    request = page.evaluate("__zusagePluginRequests.findLast(r=>r.action==='quota')")
    assert request["enabled"] is False
    page.evaluate("id=>__zusagePluginResult({id,ok:false})", request["requestId"])
    assert page.locator(".zu-quota-enable").is_checked()
    assert "保存失败" in page.locator(".zu-settings-feedback-status").inner_text()
    field = page.locator('.zu-src-field[data-src="minimax"]')
    field.fill("fixture-only-secret")
    page.locator(".zu-settings .cap").filter(has_text="套餐额度").click()
    request = page.evaluate("__zusagePluginRequests.findLast(r=>r.action==='quota-src-key')")
    page.evaluate("id=>__zusagePluginResult({id,ok:false})", request["requestId"])
    assert "操作失败" in page.locator('.zu-src-row[data-src="minimax"] .zu-src-feedback').inner_text()
    page.screenshot(path=str(OUT / "save-failure.png"))
    page.evaluate("() => {UI_SOURCE.busy=true; __zusagePluginUpdate({...UI_STATE,quotaSources:[{...UI_SOURCE}]})}")
    assert page.locator('.zu-src-refresh[data-src="minimax"]').is_disabled()
    assert "查询中" in page.locator('.zu-src-status').inner_text()
    page.evaluate("() => {UI_SOURCE.busy=false;UI_SOURCE.status='network_error';__zusagePluginUpdate({...UI_STATE,quotaSources:[{...UI_SOURCE}]})}")
    assert not page.locator('.zu-src-refresh[data-src="minimax"]').is_disabled()
    assert "查询失败" in page.locator('.zu-src-status').inner_text()
    page.locator('.zu-navitem[data-sec="general"]').click()
    page.locator('input[name="zu-lang"][value="zh"]').focus()
    page.keyboard.press("ArrowRight")
    assert page.locator('input[name="zu-lang"][value="en"]').is_checked()
    assert page.locator('input[name="zu-lang"][value="en"]').evaluate("e=>e===document.activeElement")
    assert page.locator('.zu-gear').get_attribute('aria-label') == 'Open status bar settings'
    page.keyboard.press("Escape")
    assert page.locator('.zu-gear').evaluate("e=>e===document.activeElement")
    page.close()
    return "save failure, rollback, source querying and failure passed"


with sync_playwright() as p:
    try:
        browser = p.chromium.launch()
    except Exception:
        browser = p.chromium.launch(channel="chrome")
    baseline = subprocess.check_output(["git", "show", "HEAD:overlay.js"], cwd=ROOT)
    report = {"scope": "isolated browser fixture; no Electron or live accounts", "comparison": capture_comparison(browser, baseline), "matrix": check_matrix(browser), "feedback": check_feedback(browser)}
    browser.close()
    (OUT / "metrics.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print("UI checks passed:", len(report["matrix"]), "theme/language/viewport cases; screenshots and metrics in", OUT)
