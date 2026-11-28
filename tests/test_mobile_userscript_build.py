# -*- coding: utf-8 -*-
"""油猴脚本构建回归：临时构建验证完整桌面产物按字节嵌入。"""
import contextlib
import io
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from tests.helpers.py_test_support import load_module

ROOT = Path(__file__).resolve().parents[1]
FIXTURE_DESCRIPTION = "// @description  临时构建夹具\n"
META = (
    "// ==UserScript==\n"
    "// @name         ZCode 用量状态条（远控中继接收端）\n"
    f"{FIXTURE_DESCRIPTION}"
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

    def test_current_source_builds_both_variants_with_exact_overlay_and_raw_urls(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            shutil.copytree(ROOT / "src/mobile", root / "src/mobile")
            shutil.copytree(ROOT / "src/overlay", root / "src/overlay")
            code, output = self.run_main(root)
            self.assertEqual(code, 0, output)
            release = (root / "zusage-mobile.user.js").read_bytes().decode("utf-8")
            debug = (root / "zusage-mobile.debug.user.js").read_bytes().decode("utf-8")

        expected_overlay, _ = self.desktop.assemble_bytes()
        variants = []
        for source, filename, flag in ((release, "zusage-mobile.user.js", "false"),
                                       (debug, "zusage-mobile.debug.user.js", "true")):
            self.assertTrue(embedded(source) == expected_overlay, f"{filename} 内嵌 overlay 字节不一致")
            header, end, body = source.partition("// ==/UserScript==")
            self.assertTrue(end, f"{filename} 缺少元数据结束标记")
            lines = header.splitlines()
            metadata = {}
            for key in ("name", "description", "downloadURL", "updateURL"):
                matches = [line for line in lines if line.split()[:2] == ["//", "@" + key]]
                self.assertEqual(len(matches), 1, f"{filename} @{key}")
                field = matches[0].split(maxsplit=2)
                self.assertEqual(len(field), 3, f"{filename} @{key} 缺少值")
                metadata[key] = field[2]
                lines.remove(matches[0])
            url = "https://raw.githubusercontent.com/ByteRax/zcode-token-usage-statusbar/main/" + filename
            self.assertEqual(metadata["downloadURL"], url)
            self.assertEqual(metadata["updateURL"], url)
            switch = f"var DEBUG_BUILD = {flag};"
            self.assertEqual(body.count(switch), 1, filename)
            variants.append((metadata, lines, body.replace(switch, "var DEBUG_BUILD = false;", 1)))

        release_meta, release_header, release_body = variants[0]
        debug_meta, debug_header, debug_body = variants[1]
        for key in ("name", "description"):
            self.assertNotEqual(release_meta[key], debug_meta[key], key)
        self.assertEqual(release_header, debug_header)
        self.assertTrue(release_body == debug_body, "两版主体只应在调试开关处不同")

    def test_desktop_sync_preserves_mobile_release_snapshots(self):
        sync = load_module("mobile_test_sync_plugin", ROOT / "sync_plugin.py")
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            self.fixture(root)
            (root / "scripts").mkdir()
            for name in ("build_overlay.py", "build_mobile_userscript.py"):
                shutil.copyfile(ROOT / "scripts" / name, root / "scripts" / name)
            self.assertEqual(self.run_main(root)[0], 0)
            products = [root / name for name in (self.mod.TARGET.name, self.mod.TARGET_DEBUG.name)]

            def snapshot():
                return [(p.read_bytes(), p.stat().st_mtime_ns) for p in products]

            before = snapshot()
            write(root, "src/overlay/00-boot.js", "(() => { window.exact = 'updated'; })();\n")
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertTrue(sync._maybe_build_bundles(root))
                self.assertTrue(sync._maybe_build_bundles(root, check_only=True))
            overlay = (root / "overlay.js").read_bytes()
            self.assertIn(b"'updated'", overlay)
            self.assertEqual(snapshot(), before)
            self.assertEqual(self.run_main(root, ["--check"])[0], 1)
            self.assertEqual(snapshot(), before)
            self.assertEqual(self.run_main(root)[0], 0)
            self.assertEqual(self.run_main(root, ["--check"])[0], 0)
            for product in products:
                self.assertEqual(embedded(product.read_text(encoding="utf-8")), overlay)

    def test_source_order_and_version_ledger_use_same_desktop_builder(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            # fixture 同时含 06-+12- 分片会触发 build_overlay 的 _CLOSURE_ANCHORS 双层闭包
            # 校验（ac502a3 起），三处锚点字符串需在夹具内容中齐备
            mobile_dir, overlay_dir = self.fixture(root, overlay="(function () {\n// first\n")
            ledger = ('  /* VERSION 台账\n   * v1 baseline\n   * → v2 newer\n   */\n'
                      '  var VERSION = "v2";\n'
                      '  function spawnInstance(scope) { return scope; }\n')
            write(root, "src/overlay/06-styles.js", ledger)
            write(root, "src/overlay/12-end.js", "instances.push(api);\n})();\n")
            write(root, "overlay.js", "stale generated product")
            common = self.mod.assemble(mobile_dir, overlay_dir)
            expected, _ = self.desktop.assemble_bytes(overlay_dir)
            self.assertEqual(embedded(common), expected)
            self.assertIn(b'var VERSION = "v2";   //v1 baseline', expected)
            self.assertNotIn(b"stale generated product", embedded(common))

    def test_embedded_literal_roundtrips_quotes_backslashes_unicode_and_html(self):
        text = '// </script> quotes " ` ${doNotRun()} \\\\ \u2028 \u2029 中文\n(() => {})();\n'
        with tempfile.TemporaryDirectory() as td:
            mobile_dir, overlay_dir = self.fixture(Path(td), overlay=text)
            common = self.mod.assemble(mobile_dir, overlay_dir)
            self.assertEqual(embedded(common), text.encode("utf-8"))
            self.assertNotIn("</script>", common)

    def test_desktop_css_extraction_anchors_are_no_longer_required(self):
        with tempfile.TemporaryDirectory() as td:
            mobile_dir, overlay_dir = self.fixture(Path(td), overlay="/* no mobile anchors or MC_BANDS */\n(() => {})();\n")
            common = self.mod.assemble(mobile_dir, overlay_dir)
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
        required = ("var DEBUG_BUILD = __ZM_DEBUG__;", self.mod.DEBUG_NAME_REPL[0], FIXTURE_DESCRIPTION,
                    "// @downloadURL  " + self.mod.DEBUG_URL_REPL[0], "// @updateURL    " + self.mod.DEBUG_URL_REPL[0])
        cases = {f"missing {line}": MOBILE.replace(line, "") for line in required}
        cases["duplicate @description"] = MOBILE.replace(FIXTURE_DESCRIPTION, FIXTURE_DESCRIPTION * 2)
        for label, text in cases.items():
            with self.subTest(label=label), tempfile.TemporaryDirectory() as td:
                dirs = self.fixture(Path(td), mobile=text)
                common = self.mod.assemble(*dirs)
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
