# -*- coding: utf-8 -*-
"""发布包压缩（specs/release-channel-slim.md）：build 的 ZIP 成员一律 DEFLATE-9，
旧版解包器的宽松分支照常接受，同机重建逐字节可复现，按内容对账能认出「压缩方式不同、内容相同」。
用真实检出做完整构建（每个用例一次到两次，不碰任何已安装目录）。"""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from tests.helpers.py_test_support import load_module  # noqa: E402

REPO = "ByteRax/zcode-token-usage-statusbar"
# v1.4.0 是最早含 packageLayout 宽松分支的在野解包器：冻结它那个年代的文件集白名单
LEGACY_PLUGIN_FILES = (
    ".claude-plugin/plugin.json", ".mcp.json", ".zcode-plugin/plugin.json", "README.md",
    "commands/install-overlay.md", "commands/uninstall-overlay.md", "commands/usage.md",
    "hooks/hooks.json", "hooks/prompt-submit.py", "hooks/session-start.py",
    "inject-main.cjs", "install_monitor.py", "overlay.js", "overlay_install.py",
    "patch_install.py", "plugin-release.cjs", "plugin-storage.cjs", "plugin-updater.cjs",
    "plugin_auto_update.py", "release_unpack.py", "restart_notice.py", "runtime_lock.py",
    "skills/zcode-token-usage/SKILL.md", "token_rate.py", "usage_mcp.py", "zusage.py",
)
LEGACY_BOOTSTRAP_FILES = (
    ".zcode-plugin/plugin.json", ".claude-plugin/plugin.json", "overlay_install.py",
    "inject-main.cjs", "overlay.js", "zusage.py", "patch_install.py", "install_monitor.py",
    "plugin-updater.cjs", "plugin-release.cjs", "plugin-storage.cjs", "runtime_lock.py",
    "release_unpack.py", "plugin_auto_update.py", "restart_notice.py",
)


class ReleaseZipDeflateTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="release-deflate-")
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.tool = load_module("release_zip_deflate_tool", ROOT / "release_tool.py")

    def build(self, name):
        return self.tool.build(ROOT, REPO, self.base / name)

    def members(self, path):
        with zipfile.ZipFile(path) as archive:
            return [member for member in archive.infolist() if not member.is_dir()]

    def test_members_are_deflated_and_the_package_still_verifies(self):
        built = self.build("out")
        members = self.members(built["zip"])
        self.assertEqual({member.compress_type for member in members}, {zipfile.ZIP_DEFLATED})
        raw = sum(member.file_size for member in members)
        packed = sum(member.compress_size for member in members)
        self.assertLess(packed, raw / 2, f"压缩后 {packed} 字节，未压缩 {raw} 字节")
        manifest = self.tool.verify(Path(built["zip"]), Path(built["manifest"]), REPO)
        self.assertEqual(manifest["asset"]["size"], Path(built["zip"]).stat().st_size)
        self.assertEqual(manifest["asset"]["sha256"], hashlib.sha256(Path(built["zip"]).read_bytes()).hexdigest())
        catalog = json.loads(Path(built["catalog"]).read_text(encoding="utf-8"))
        self.assertEqual(catalog["plugins"][0]["source"]["sha256"], manifest["asset"]["sha256"])

    def test_manifest_and_catalog_are_lf_on_every_platform(self):
        # Windows 文本模式把 \n 写成 \r\n：清单经 git hash-object --stdin 原样进渠道分支，构建产物
        # 的字节也随平台漂移。写入侧一旦退回平台文本模式，Windows 上必红
        built = self.build("out")
        for key in ("manifest", "catalog"):
            self.assertNotIn(b"\r", Path(built[key]).read_bytes(), key)

    def test_same_machine_rebuild_is_byte_identical(self):
        first, second = self.build("first"), self.build("second")
        self.assertEqual(Path(first["zip"]).read_bytes(), Path(second["zip"]).read_bytes())
        self.assertEqual(Path(first["manifest"]).read_bytes(), Path(second["manifest"]).read_bytes())
        self.assertEqual(Path(first["catalog"]).read_bytes(), Path(second["catalog"]).read_bytes())

    def test_legacy_unpacker_wide_branch_accepts_the_deflated_package(self):
        built = self.build("out")
        unpack = load_module("release_zip_deflate_unpack", ROOT / "release_unpack.py")
        prefix = unpack.PREFIX
        allowed = frozenset(("marketplace.json", "LICENSE") + tuple(prefix + name for name in LEGACY_PLUGIN_FILES))
        bootstrap = frozenset(("marketplace.json", "LICENSE") + tuple(prefix + name for name in LEGACY_BOOTSTRAP_FILES))
        version = json.loads(Path(built["manifest"]).read_text(encoding="utf-8"))["version"]
        with mock.patch.object(unpack, "ALLOWED_FILES", allowed), \
                mock.patch.object(unpack, "REQUIRED_FILES", allowed), \
                mock.patch.object(unpack, "BOOTSTRAP_FILES", bootstrap):
            result = unpack.unpack(Path(built["zip"]), Path(built["manifest"]), REPO, version,
                                   self.base / "unpacked")
        self.assertTrue(result["ok"])
        self.assertEqual(result["version"], version)
        # 解出来的每个文件都与源码逐字节一致：压缩只改了传输形态
        root = self.base / "unpacked"
        # 归档成员名恒为正斜杠；relative_to() 在 Windows 上给反斜杠，比对前归一
        unpacked = {path.relative_to(root).as_posix(): path.read_bytes() for path in root.rglob("*") if path.is_file()}
        self.assertEqual({member.filename for member in self.members(built["zip"])}, set(unpacked))
        self.assertEqual(unpacked[prefix + "overlay.js"], (ROOT / "plugins" / "zcode-token-usage-statusbar" / "overlay.js").read_bytes())

    def stored_twin(self, built, name):
        """同一份内容按不压缩方式重打一份：字节不同、成员内容相同。"""
        target = self.base / name
        target.mkdir()
        asset = target / Path(built["zip"]).name
        with zipfile.ZipFile(built["zip"]) as original, zipfile.ZipFile(asset, "x", zipfile.ZIP_STORED) as twin:
            for member in self.members(built["zip"]):
                info = zipfile.ZipInfo(member.filename, date_time=(1980, 1, 1, 0, 0, 0))
                info.create_system = 3
                info.external_attr = member.external_attr
                twin.writestr(info, original.read(member), compress_type=zipfile.ZIP_STORED)
        manifest = json.loads(Path(built["manifest"]).read_text())
        payload = asset.read_bytes()
        manifest["asset"].update(size=len(payload), sha256=hashlib.sha256(payload).hexdigest())
        (target / "release-manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
        return asset, target / "release-manifest.json"

    def test_reconcile_recovers_the_channel_catalog_across_compression_methods(self):
        built = self.build("out")
        published_asset, published_manifest = self.stored_twin(built, "published")
        self.assertNotEqual(published_asset.read_bytes(), Path(built["zip"]).read_bytes())
        catalog = self.base / "catalog.json"
        result = self.tool.reconcile(REPO, Path(built["zip"]), Path(built["manifest"]),
                                     published_asset, published_manifest, catalog)
        self.assertFalse(result["byteIdentical"])
        published_sha = json.loads(published_manifest.read_text())["asset"]["sha256"]
        self.assertEqual(result["sha256"], published_sha, "清单必须指向线上托管的那份包")
        self.assertEqual(json.loads(catalog.read_text())["plugins"][0]["source"]["sha256"], published_sha)


if __name__ == "__main__":
    unittest.main()
