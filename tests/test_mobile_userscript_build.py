# -*- coding: utf-8 -*-
"""油猴脚本构建链测试（specs/mobile-userscript-build.md）。

docs/zusage-mobile.user.js 是编译产物：手机特有逻辑在 src/mobile/ 分片，「照抄桌面」
内容（图标/格样式/TPS 色档/显示项行）从 src/overlay/ 06/07 分片锚点提取。本测试覆盖：
- 真实源码上的完整构建输出契约（图标集、色档展开数、显示项行）；
- 用临时夹具验证提取改写规则与 fail-fast（锚点缺失/声明失配/占位符丢失/重复）——
  桌面重构删锚点时构建必须红，不允许静默漂移。
"""
import sys
import tempfile
import unittest
from pathlib import Path

TESTS = Path(__file__).resolve().parent
ROOT = TESTS.parent
sys.path.insert(0, str(TESTS / "helpers"))

from py_test_support import load_module  # noqa: E402


def write(tmp, rel, text):
    p = tmp / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8", newline="\n")
    return p


MOBILE_FALLBACK = (
    "// ==UserScript==\n"
    "// @name         ZCode 用量状态条（远控中继接收端）\n"
    "// @description  在 ZCode Web 远程控制页面渲染与桌面状态条同源的 token 用量 chips"
    "（observe-only，不向 WebSocket 写入任何字节）\n"
    "// ==/UserScript==\n"
    "// mobile fallback ui\n"
    "var DEBUG_BUILD = __ZM_DEBUG__;\n"
    "/*@zm-icons speed,turn@*/\n"
    "var ICONS = __ZM_ICONS__;\n"
    "/*@zm-show-keys turn@*/\n"
    "var SHOW_ROWS = __ZM_SHOW_ROWS__;\n"
    'var CSS = "a{" +\n  "__ZM_CELL_CSS__" +\n  "__ZM_BAND_CSS__" +\n"b}";\n'
)

OVL06 = (
    "var css = \n"
    "      /*zm-cell-css-begin：锚点*/\n"
    '      ".it{display:flex;gap:5px}" +\n'
    '      ".it:hover,.it:focus-visible{background:var(--color-hover,x)}" +\n'
    '      ".zu-gear{width:26px}" +\n'
    '      /* v319 注释里的引号 "158.9 t/s" 不得混进 CSS */\n'
    '      ".zusage-root .it{line-height:1.3}" +\n'
    '      ".zusage-root .it>span:not(.eb):not(.zu-live){display:inline-flex}" +\n'
    '      ".sep{width:1px}" +\n'
    '      ".k{color:a}.v{color:b}" +\n'
    '      ".dim{color:c}" +\n'
    '      ".eb{background:e}" +\n'
    '      ".eb .ico{color:x}" +\n'
    "      /*zm-cell-css-end*/\n"
    "      /*zm-band-css-begin*/\n"
    '      ".ok{color:#3ecf8e}.warm{color:#f5b944}.hot{color:#ff6b57}" +\n'
    '      ".zu-teal{color:#2dd4bf}" +\n'
    '      ".zu-ultra{color:#a78bfa}.zu-ultra::before{content:\\"✦\\"/\\"\\";margin-right:2px}" +\n'
    '      "@supports(-webkit-background-clip:text){" +\n'
    '      ".zu-ultra{background:linear-gradient(100deg,a 0%,b 50%);-webkit-background-clip:text}" +\n'
    "      /*zm-band-css-end*/\n"
    "      /*zm-band-css-light-begin*/\n"
    '      ".zu-light .ok{color:#0f9d6c}" +\n'
    '      ".zu-light .zu-teal{color:#087d74}" +\n'
    "      /*zm-band-css-light-end*/\n"
    "      /*zm-show-rows-begin*/\n"
    "      settingRow('<input type=\"checkbox\" data-k=\"turn\">', L(\"本轮\", \"Turn\"), L(\"本轮描述\", \"desc\")) +\n"
    "      settingRow('<input type=\"checkbox\" data-k=\"subRate\">', L(\"子代理行内速率\", \"Rate\"), L(\"速率描述\", \"d2\")) +\n"
    "      /*zm-show-rows-end*/\n"
)

OVL07 = (
    "var chip = it(ico(/*zm-ico:speed*/'<path d=\"M13.5\"/>') + x;\n"
    "var t = it(ico(/*zm-ico:turn*/'<rect/>') + y;\n"
    "var kpi = { speed: '<path d=\"OTHER\"/>' };   // 无锚点的同 id 串不得被收\n"
)

OVL13 = 'var MC_BANDS = ["zu-ultra", "zu-teal", "ok", "warm", "hot"];\n'


class MobileUserscriptBuildTests(unittest.TestCase):
    def setUp(self):
        self.mod = load_module("build_mobile_userscript", ROOT / "scripts" / "build_mobile_userscript.py")

    def test_real_source_assemble_contract(self):
        """真实仓库源码：图标 7 键、色档 10 档×2 类×2 深浅=40 条、cell 白名单、显示项 6 行；
        assemble 返回共同主体（仅余 __ZM_DEBUG__ 占位），finalize 产出正式/调试两变体。"""
        common, info = self.mod.assemble()
        self.assertEqual(info["desktop_only_keys"], ["git", "subRate", "wfChip"])
        for k in ("speed", "turn", "win", "today", "proj", "tools", "sub"):
            self.assertIn(f"{k}: '<", common, f"图标 {k} 未注入")
        for probe in (
            ".zm-root .it{display:flex",
            ".zm-root .it:hover,.zm-root .it:focus-visible{",
            ".zm-root .it{line-height:1.3}",
            ".zm-root .it>span:not(.eb):not(.zu-live){display:inline-flex",
            ".zm-root .sep{width:1px;height:15px",
            ".zm-root .eb{background:rgba(255,107,87,.14)",
            ".zm-root .zm-band-ok{color:#3ecf8e}.zm-root .zm-tone-ok{color:#3ecf8e}",
            ".zm-root .zm-band-zu-teal{color:#2dd4bf}",
            ".zm-light .zm-band-ok{color:#0f9d6c}.zm-light .zm-tone-ok{color:#0f9d6c}",
            'data-k="turn"><span>本轮<em>tokens、请求次数、耗时与首字延迟</em>',
            'data-k="sub"><span>子代理<em>悬停或点击状态条上的子代理查看统计</em>',
        ):
            self.assertIn(probe, common, f"共同主体缺少注入段特征: {probe}")
        for absent in ("zm-tone-mute", "158.9 t/s", "zusage-root", ".zu-gear{flex:0 0 auto;position:relative"):
            self.assertNotIn(absent, common, f"共同主体不应包含: {absent}")
        for p in ('"__ZM_CELL_CSS__"', '"__ZM_BAND_CSS__"', "var ICONS = __ZM_ICONS__",
                  "var SHOW_ROWS = __ZM_SHOW_ROWS__"):
            self.assertNotIn(p, common, f"占位符未替换: {p}")
        self.assertIn("var DEBUG_BUILD = __ZM_DEBUG__;", common)   # 唯一留给 finalize 的占位
        release = self.mod.finalize(common, False)
        debug = self.mod.finalize(common, True)
        self.assertIn("var DEBUG_BUILD = false;", release)
        self.assertNotIn("·调试版", release)
        self.assertIn("var DEBUG_BUILD = true;", debug)
        self.assertIn("·调试版", debug)
        # 两变体除 3 处元数据/开关外逐字节一致（共享全部提取与逻辑）
        self.assertEqual(
            release.replace("var DEBUG_BUILD = false;", "").replace(
                "// @name         ZCode 用量状态条（远控中继接收端）", "").replace(
                "// @description  在 ZCode Web 远程控制页面渲染与桌面状态条同源的 token 用量 chips"
                "（observe-only，不向 WebSocket 写入任何字节）", ""),
            debug.replace("var DEBUG_BUILD = true;", "").replace(
                "// @name         ZCode 用量状态条（远控中继接收端·调试版）", "").replace(
                "// @description  调试版：默认显示排障面板（帧统计/overlay 加载状态）；"
                "日常使用请安装正式版 zusage-mobile.user.js", ""),
        )

    def _fixture(self, tmp, ovl06=OVL06, ovl07=OVL07, ovl13=OVL13, mobile=MOBILE_FALLBACK):
        mdir = tmp / "mobile-src"
        mdir.mkdir()
        (mdir / "00-meta.js").write_text("// meta\n", encoding="utf-8")
        (mdir / "10-ui.js").write_text(mobile, encoding="utf-8")
        return self.mod.assemble(
            src_dir=mdir,
            ovl06_path=write(tmp, "06.js", ovl06),
            ovl07_path=write(tmp, "07.js", ovl07),
            ovl13_path=write(tmp, "13.js", ovl13),
        )

    def test_fixture_rewrite_rules(self):
        """夹具：白名单过滤（.zu-gear/.eb .ico/注释引号丢弃）、前缀改写、色档展开、::before/@supports 丢弃。"""
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            src, _ = self._fixture(Path(td))
        for probe in (
            ".zm-root .it{display:flex;gap:5px}",
            ".zm-root .it:hover,.zm-root .it:focus-visible{background:var(--color-hover,x)}",
            ".zm-root .it{line-height:1.3}",
            ".zm-root .it>span:not(.eb):not(.zu-live){display:inline-flex}",
            ".zm-root .sep{width:1px}",
            ".zm-root .k{color:a}.zm-root .v{color:b}",
            ".zm-root .dim{color:c}",
            ".zm-root .eb{background:e}",
            ".zm-root .zm-band-ok{color:#3ecf8e}.zm-root .zm-tone-ok{color:#3ecf8e}",
            ".zm-root .zm-band-zu-teal{color:#2dd4bf}.zm-root .zm-tone-zu-teal{color:#2dd4bf}",
            ".zm-light .zm-band-ok{color:#0f9d6c}",
            "data-k=\"turn\"><span>本轮<em>本轮描述</em>",
        ):
            self.assertIn(probe, src, f"夹具产物缺少: {probe}")
        for absent in (".zu-gear{", ".eb .ico", "158.9 t/s", "::before", "@supports", "linear-gradient",
                       "subRate", "OTHER"):
            self.assertNotIn(absent, src, f"夹具产物不应包含: {absent}")
        # DEBUG_BUILD 开关经 finalize 落值；夹具无 @name 元数据行，调试变体仅开关不同
        self.assertIn("var DEBUG_BUILD = false;", self.mod.finalize(src, False))
        self.assertIn("var DEBUG_BUILD = true;", self.mod.finalize(src, True))

    def test_fail_fast_missing_icon_anchor(self):
        """07 分片删锚点（桌面重构）→ 构建报错且点名缺失 id。"""
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            with self.assertRaisesRegex(self.mod.BuildError, "turn"):
                self._fixture(Path(td), ovl07=OVL07.replace("/*zm-ico:turn*/", ""))

    def test_fail_fast_missing_css_anchor(self):
        with tempfile.TemporaryDirectory() as td:
            with self.assertRaises(self.mod.BuildError):
                self._fixture(Path(td), ovl06=OVL06.replace("/*zm-cell-css-begin：锚点*/", ""))

    def test_fail_fast_decl_key_not_on_desktop(self):
        with tempfile.TemporaryDirectory() as td:
            mobile = MOBILE_FALLBACK.replace("/*@zm-show-keys turn@*/", "/*@zm-show-keys turn,win@*/")
            with self.assertRaisesRegex(self.mod.BuildError, "win"):
                self._fixture(Path(td), mobile=mobile)

    def test_fail_fast_missing_placeholder(self):
        with tempfile.TemporaryDirectory() as td:
            mobile = MOBILE_FALLBACK.replace('"__ZM_CELL_CSS__" +\n', "")
            with self.assertRaisesRegex(self.mod.BuildError, "__ZM_CELL_CSS__"):
                self._fixture(Path(td), mobile=mobile)

    def test_fail_fast_duplicate_placeholder(self):
        with tempfile.TemporaryDirectory() as td:
            mobile = MOBILE_FALLBACK + '"__ZM_CELL_CSS__";\n'
            with self.assertRaisesRegex(self.mod.BuildError, "__ZM_CELL_CSS__"):
                self._fixture(Path(td), mobile=mobile)

    def test_band_extraction_driven_by_mc_bands(self):
        """色档提取由 13 分片 MC_BANDS 驱动（唯一事实源）：档位不在 MC_BANDS 内不展开。"""
        import tempfile
        ovl13 = 'var MC_BANDS = ["zu-teal"];\n'
        with tempfile.TemporaryDirectory() as td:
            src, _ = self._fixture(Path(td), ovl13=ovl13)
            self.assertIn(".zm-root .zm-band-zu-teal{color:#2dd4bf}", src)
            self.assertNotIn("zm-band-ok", src)

    def test_check_detects_product_drift(self):
        """产物被手改（A5）：--check 红。"""
        import subprocess
        target = ROOT / "docs" / "zusage-mobile.user.js"
        saved = target.read_bytes()
        try:
            target.write_bytes(saved + b"\n// drift\n")
            r = subprocess.run(
                [sys.executable, str(ROOT / "scripts" / "build_mobile_userscript.py"), "--check"],
                capture_output=True, text=True,
            )
            self.assertNotEqual(r.returncode, 0, "产物漂移时 --check 必须红")
        finally:
            target.write_bytes(saved)


if __name__ == "__main__":
    unittest.main()
