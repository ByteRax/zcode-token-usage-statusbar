# -*- coding: utf-8 -*-
"""手机构建回归：精确嵌入桌面完整产物，临时构建不改仓库根产物。"""
import contextlib
import io
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from tests.helpers.py_test_support import load_module

ROOT = Path(__file__).resolve().parents[1]
META = (
    "// ==UserScript==\n"
    "// @name         ZCode 用量状态条（远控中继接收端）\n"
    "// @description  在 ZCode Web 远程控制页面渲染 token 用量；仅在确认宿主支持后同步显示偏好\n"
    "// @downloadURL  https://raw.githubusercontent.com/ByteRax/zcode-token-usage-statusbar/main/zusage-mobile.user.js\n"
    "// @updateURL    https://raw.githubusercontent.com/ByteRax/zcode-token-usage-statusbar/main/zusage-mobile.user.js\n"
    "// ==/UserScript==\n"
)
MOBILE = META + "var DEBUG_BUILD = __ZM_DEBUG__;\nvar OVERLAY_CODE = __ZM_OVERLAY_SOURCE__;\n"


def write(root, rel, text):
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(text.encode("utf-8"))
    return path


def embedded(source):
    marker = "var OVERLAY_CODE = "
    start = source.index(marker) + len(marker)
    value, _ = json.JSONDecoder().raw_decode(source[start:])
    return value.encode("utf-8")


class MobileUserscriptBuildTests(unittest.TestCase):
    def setUp(self):
        self.mod = load_module("build_mobile_userscript", ROOT / "scripts" / "build_mobile_userscript.py")
        self.desktop = load_module("mobile_test_build_overlay", ROOT / "scripts" / "build_overlay.py")

    def fixture(self, root, mobile=MOBILE, overlay="(() => { window.exact = '桌面'; })();\n"):
        write(root, "src/mobile/00-meta.js", mobile)
        write(root, "src/overlay/00-boot.js", overlay)
        return root / "src/mobile", root / "src/overlay"

    def run_main(self, root, args=None):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            code = self.mod.main(args or [], root=root)
        return code, output.getvalue()

    def test_real_source_embeds_exact_desktop_assembly_for_both_variants(self):
        common, info = self.mod.assemble()
        expected, _ = self.desktop.assemble_bytes()
        self.assertEqual(embedded(common), expected)
        self.assertEqual(info["overlay_bytes"], len(expected))
        release = self.mod.finalize(common, False)
        debug = self.mod.finalize(common, True)
        self.assertEqual(embedded(release), expected)
        self.assertEqual(embedded(debug), expected)
        normalized_debug = debug.replace("var DEBUG_BUILD = true;", "var DEBUG_BUILD = false;")
        for regular, diagnostic in (self.mod.DEBUG_NAME_REPL, self.mod.DEBUG_DESC_REPL, self.mod.DEBUG_URL_REPL):
            normalized_debug = normalized_debug.replace(diagnostic, regular)
        self.assertEqual(normalized_debug, release)

    def test_variants_keep_distinct_install_and_update_urls(self):
        common, _ = self.mod.assemble()
        for debug, filename in ((False, "zusage-mobile.user.js"), (True, "zusage-mobile.debug.user.js")):
            source = self.mod.finalize(common, debug)
            header = source.split("// ==/UserScript==", 1)[0]
            expected = "https://raw.githubusercontent.com/ByteRax/zcode-token-usage-statusbar/main/" + filename
            for key in ("downloadURL", "updateURL"):
                lines = [line for line in header.splitlines() if line.startswith("// @" + key)]
                self.assertEqual(len(lines), 1)
                self.assertEqual(lines[0].split()[-1], expected)

    def test_sync_builds_root_products_and_check_is_read_only(self):
        sync = load_module("mobile_test_sync_plugin", ROOT / "sync_plugin.py")
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            self.fixture(root)
            # 构建器按自身目录定位伙伴脚本，夹具要保留实际 scripts 布局。
            (root / "scripts").mkdir(exist_ok=True)
            for name in ("build_overlay.py", "build_mobile_userscript.py"):
                shutil.copyfile(ROOT / "scripts" / name, root / "scripts" / name)
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertTrue(sync._maybe_build_bundles(root))
            overlay = (root / "overlay.js").read_bytes()
            release = root / "zusage-mobile.user.js"
            debug = root / "zusage-mobile.debug.user.js"
            self.assertEqual(embedded(release.read_text(encoding="utf-8")), overlay)
            self.assertEqual(embedded(debug.read_text(encoding="utf-8")), overlay)
            self.assertFalse((root / "docs").exists())
            self.assertFalse((root / "plugins").exists())
            release.write_bytes(release.read_bytes() + b"\n// changed\n")
            before = release.read_bytes()
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertFalse(sync._maybe_build_bundles(root, check_only=True))
            self.assertEqual(release.read_bytes(), before)

    def test_source_order_and_version_ledger_use_same_desktop_builder(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            mobile_dir, overlay_dir = self.fixture(root, overlay="// first\n")
            ledger = '  /* VERSION 台账\n   * v1 baseline\n   * → v2 newer\n   */\n  var VERSION = "v2";\n'
            write(root, "src/overlay/06-styles.js", ledger)
            write(root, "src/overlay/12-end.js", "// last\n")
            write(root, "overlay.js", "stale generated product")
            common, _ = self.mod.assemble(mobile_dir, overlay_dir)
            expected, _ = self.desktop.assemble_bytes(overlay_dir)
            self.assertEqual(embedded(common), expected)
            self.assertIn(b'var VERSION = "v2";   //v1 baseline', expected)
            self.assertNotIn(b"stale generated product", embedded(common))

    def test_embedded_literal_roundtrips_quotes_backslashes_unicode_and_html(self):
        text = '// </script> quotes " ` ${doNotRun()} \\\\ \u2028 \u2029 中文\n(() => {})();\n'
        with tempfile.TemporaryDirectory() as td:
            mobile_dir, overlay_dir = self.fixture(Path(td), overlay=text)
            common, _ = self.mod.assemble(mobile_dir, overlay_dir)
            self.assertEqual(embedded(common), text.encode("utf-8"))
            self.assertNotIn("</script>", common)

    def test_desktop_css_extraction_anchors_are_no_longer_required(self):
        with tempfile.TemporaryDirectory() as td:
            mobile_dir, overlay_dir = self.fixture(Path(td), overlay="/* no mobile anchors or MC_BANDS */\n(() => {})();\n")
            common, _ = self.mod.assemble(mobile_dir, overlay_dir)
            self.assertEqual(embedded(common), self.desktop.assemble_bytes(overlay_dir)[0])

    def test_mobile_or_desktop_invalid_sources_fail_before_writing_products(self):
        cases = [
            ("src/mobile/stray.js", b"// stray", "命名"),
            ("src/mobile/10-empty.js", b"", "为空"),
            ("src/mobile/10-invalid.js", b"\xff", "utf-8"),
            ("src/overlay/stray.js", b"// stray", "命名"),
            ("src/overlay/10-empty.js", b"", "为空"),
            ("src/overlay/10-invalid.js", b"\xff", "UTF-8"),
        ]
        for rel, data, message in cases:
            with self.subTest(rel=rel), tempfile.TemporaryDirectory() as td:
                root = Path(td)
                self.fixture(root)
                write(root, "zusage-mobile.user.js", "keep regular")
                write(root, "zusage-mobile.debug.user.js", "keep debug")
                (root / rel).write_bytes(data)
                code, output = self.run_main(root)
                self.assertEqual(code, 1)
                self.assertIn(message, output)
                self.assertEqual((root / "zusage-mobile.user.js").read_text(), "keep regular")
                self.assertEqual((root / "zusage-mobile.debug.user.js").read_text(), "keep debug")

    def test_missing_or_duplicate_overlay_placeholder_fails(self):
        for text in (MOBILE.replace("var OVERLAY_CODE = __ZM_OVERLAY_SOURCE__;", ""), MOBILE + "var OVERLAY_CODE = __ZM_OVERLAY_SOURCE__;\n"):
            with self.subTest(text=text), tempfile.TemporaryDirectory() as td:
                dirs = self.fixture(Path(td), mobile=text)
                with self.assertRaisesRegex(self.mod.BuildError, "__ZM_OVERLAY_SOURCE__"):
                    self.mod.assemble(*dirs)

    def test_debug_placeholder_and_metadata_fail_fast(self):
        for old in ("var DEBUG_BUILD = __ZM_DEBUG__;", self.mod.DEBUG_NAME_REPL[0], self.mod.DEBUG_DESC_REPL[0],
                    "// @downloadURL  " + self.mod.DEBUG_URL_REPL[0], "// @updateURL    " + self.mod.DEBUG_URL_REPL[0]):
            with self.subTest(old=old), tempfile.TemporaryDirectory() as td:
                dirs = self.fixture(Path(td), mobile=MOBILE.replace(old, ""))
                common, _ = self.mod.assemble(*dirs)
                with self.assertRaises(self.mod.BuildError):
                    self.mod.finalize(common, True)

    def test_unknown_executable_placeholder_fails(self):
        with tempfile.TemporaryDirectory() as td:
            dirs = self.fixture(Path(td), mobile=MOBILE + "var left = __ZM_UNEXPECTED__;\n")
            with self.assertRaisesRegex(self.mod.BuildError, "__ZM_UNEXPECTED__"):
                self.mod.assemble(*dirs)

    def test_build_check_and_drift_use_temporary_products(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            self.fixture(root)
            code, _ = self.run_main(root)
            self.assertEqual(code, 0)
            code, _ = self.run_main(root, ["--check"])
            self.assertEqual(code, 0)
            release, debug = root / "zusage-mobile.user.js", root / "zusage-mobile.debug.user.js"
            saved = release.read_bytes()
            release.write_bytes(saved + b"\n// drift\n")
            before = (release.read_bytes(), debug.read_bytes())
            code, output = self.run_main(root, ["--check"])
            self.assertEqual(code, 1)
            self.assertIn(release.name, output)
            self.assertEqual((release.read_bytes(), debug.read_bytes()), before, "--check must be read-only")
            self.assertEqual(self.run_main(root)[0], 0)
            self.assertEqual(release.read_bytes(), saved)
            debug.unlink()
            self.assertEqual(self.run_main(root, ["--check"])[0], 1)
            self.assertFalse(debug.exists())

    def test_actual_temporary_products_pass_node_syntax_and_check(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            shutil.copytree(ROOT / "src/mobile", root / "src/mobile")
            shutil.copytree(ROOT / "src/overlay", root / "src/overlay")
            self.assertEqual(self.run_main(root)[0], 0)
            self.assertEqual(self.run_main(root, ["--check"])[0], 0)
            for name in ("zusage-mobile.user.js", "zusage-mobile.debug.user.js"):
                result = subprocess.run(["node", "--check", str(root / name)], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_unknown_cli_option_does_not_create_products(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            self.fixture(root)
            self.assertEqual(self.run_main(root, ["--unknown"])[0], 2)
            self.assertFalse((root / "zusage-mobile.user.js").exists())
            self.assertFalse((root / "zusage-mobile.debug.user.js").exists())
            self.assertFalse((root / "docs").exists())


if __name__ == "__main__":
    unittest.main()
