# -*- coding: utf-8 -*-
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugins" / "zcode-token-usage-statusbar"


class PluginPackageTests(unittest.TestCase):
    def test_manifest_identity_version_and_resources_agree(self):
        manifest = json.loads((PLUGIN / ".zcode-plugin" / "plugin.json").read_text(encoding="utf-8"))
        compatibility = json.loads((PLUGIN / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8"))
        marketplace = json.loads((ROOT / "marketplace.json").read_text(encoding="utf-8"))
        entry = next(p for p in marketplace["plugins"] if p["name"] == manifest["name"])
        self.assertEqual(manifest, compatibility)
        self.assertEqual(manifest["name"], PLUGIN.name)
        self.assertEqual(manifest["version"], entry["version"])
        self.assertEqual((ROOT / entry["source"]).resolve(), PLUGIN)
        for component in ("commands", "skills"):
            self.assertTrue((PLUGIN / manifest[component]).is_dir())
        self.assertTrue((PLUGIN / ".mcp.json").is_file())
        self.assertTrue((PLUGIN / "hooks" / "hooks.json").is_file())
        self.assertTrue((PLUGIN / "restart_notice.py").is_file())

    def test_default_update_setting_and_bilingual_panel_copy_agree(self):
        config = json.loads((ROOT / "config.example.json").read_text(encoding="utf-8"))
        self.assertIs(config["plugin_auto_update"], True)
        self.assertIs(config["plugin_auto_install_overlay"], True)
        overlay = (ROOT / "overlay.js").read_text(encoding="utf-8")
        self.assertIn("每 1 小时检查并安装新版，默认开启", overlay)
        self.assertIn("Check and install every hour; on by default", overlay)
        self.assertNotIn("每 24 小时检查", overlay)
        self.assertNotIn("Check and install every 24 hours", overlay)
        self.assertIn("更新器变更需完全退出并重开 ZCode 后生效", overlay)
        self.assertIn("Updater changes take effect after fully quitting and reopening ZCode", overlay)
        self.assertIn("cb.disabled = !active;", overlay)
        self.assertIn("stable GitHub Release (validated ZIP and SHA256)", overlay)
        self.assertIn("stable GitCode Release (validated ZIP and SHA256)", overlay)
        # v95：来源前缀与渠道名分开本地化，新增仓库源码（market 渠道）分支
        self.assertIn('L("更新来源：", "Update source: ")', overlay)
        self.assertIn('L("本地目录市场", "local directory marketplace")', overlay)
        self.assertIn("GitHub repository source (updated directly by the plugin manager)", overlay)
        self.assertIn("GitCode repository source (updated directly by the plugin manager)", overlay)
        self.assertNotIn("zu-update-fallback", overlay)
        self.assertIn("Release version:", overlay)
        self.assertIn("Turning automatic updates off stops future installs; an install already started will finish", overlay)

    def test_updater_is_packaged_and_runtime_sync_never_includes_config(self):
        spec = importlib.util.spec_from_file_location("plugin_installer_package_test", PLUGIN / "overlay_install.py")
        installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(installer)
        self.assertIn("plugin-updater.cjs", installer.RUNTIME_FILES)
        self.assertIn("runtime_lock.py", installer.RUNTIME_FILES)
        self.assertNotIn("config.json", installer.RUNTIME_FILES)
        self.assertNotIn("plugin-update.json", installer.RUNTIME_FILES)
        for name in ("inject-main.cjs", "plugin-updater.cjs", "plugin-release.cjs", "plugin-storage.cjs", "release_unpack.py", "runtime_lock.py", "usage_stats.py", "turn-stats.js", "overlay.js"):
            self.assertIn(name, installer.RUNTIME_FILES)
            self.assertEqual((ROOT / name).read_bytes(), (PLUGIN / name).read_bytes())

    def test_release_skill_requires_post_release_pr_merge_and_verification(self):
        text = (ROOT / ".zcode/skills/zcode-github-release/SKILL.md").read_text(encoding="utf-8")
        section = text.split("## 发布后合并源码 PR\n", 1)[1].split("## 收尾\n", 1)[0]
        self.assertIn("创建并合并源码 PR → 验收合并结果", text)
        self.assertIn("完整正式发版默认包含发布后源码 PR 的创建与合并", text)
        for requirement in ("gh pr list", "gh pr create", "gh pr merge", "--match-head-commit",
                            "statusCheckRollup", "MERGED", "远端 base tip", "不移动已发布 tag"):
            self.assertIn(requirement, section)
        self.assertIn("仅预演、仅 Release、仅修改说明或用户明确禁止合并时不执行", text)
        self.assertIn("只进入 PR", section)

    def test_release_skill_is_project_only_and_uses_root_tools(self):
        skill = ROOT / ".zcode" / "skills" / "zcode-github-release"
        text = (skill / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("name: zcode-github-release", text)
        self.assertIn("--repo OWNER/REPO --out", text)
        self.assertIn("plugin-releases", text)
        self.assertIn("--publish", text)
        self.assertIn("仅供所在仓库使用", text)
        self.assertFalse((skill / "scripts").exists())
        self.assertFalse((PLUGIN / "skills" / "github-release").exists())
        self.assertTrue((skill / "references" / "release-contract.md").is_file())
        for name in ("release_tool.py", "release_unpack.py"):
            self.assertTrue((ROOT / name).is_file())


if __name__ == "__main__":
    unittest.main()
