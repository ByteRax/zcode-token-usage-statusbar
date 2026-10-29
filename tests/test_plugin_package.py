# -*- coding: utf-8 -*-
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
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
        for name in ("inject-main.cjs", "plugin-updater.cjs", "plugin-release.cjs", "plugin-storage.cjs", "quota-client.cjs", "model-puller.cjs", "release_unpack.py", "runtime_lock.py", "usage_stats.py", "turn-stats.js", "overlay.js"):
            self.assertIn(name, installer.RUNTIME_FILES)
            self.assertEqual((ROOT / name).read_bytes(), (PLUGIN / name).read_bytes())

    def test_runtime_files_cover_inject_main_relative_requires(self):
        spec = importlib.util.spec_from_file_location("plugin_installer_package_test", PLUGIN / "overlay_install.py")
        installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(installer)
        install_spec = importlib.util.spec_from_file_location("standalone_installer_package_test", ROOT / "install.py")
        standalone = importlib.util.module_from_spec(install_spec)
        install_spec.loader.exec_module(standalone)
        self.assertTrue(re.findall(r"require\(['\"]\./", (ROOT / "inject-main.cjs").read_text(encoding="utf-8")))
        # 注入行指向运行时目录：inject-main.cjs 及其已登记模块的相对 require 依赖（含传递）
        # 必须全数在两份运行清单里，缺一个就是运行目录缺文件、主进程静默加载失败（issue #127）
        for runtime_files, label in ((installer.RUNTIME_FILES, "overlay_install.py"), (standalone.RUNTIME_FILES, "install.py")):
            missing = set()
            for name in ("inject-main.cjs",) + tuple(f for f in runtime_files if f.endswith(".cjs")):
                text = (ROOT / name).read_text(encoding="utf-8")
                missing.update(dep for dep in re.findall(r"require\(['\"]\./([^'\"]+)['\"]\)", text)
                               if dep not in runtime_files)
            self.assertEqual(sorted(missing), [], label)

    def test_cold_files_literals_agree(self):
        # overlay_install.py 两处 cold_files（sync_runtime 写 marker 与 run_hook 组提醒文案）
        # 语义同一：漏改任一处时重启记录与提醒单侧失效，钉住两处字面量一致
        src = (PLUGIN / "overlay_install.py").read_text(encoding="utf-8")
        literals = [set(re.findall(r'"([^"]+)"', block)) for block in re.findall(r"cold_files = \{([^}]+)\}", src)]
        self.assertEqual(len(literals), 2)
        self.assertTrue(literals[0])
        self.assertEqual(literals[0], literals[1])

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


class ReleaseLedgerTests(unittest.TestCase):
    def run_check(self, root):
        document = (ROOT / ".zcode/skills/zcode-github-release/references/pre-publish-checks.md").read_text(encoding="utf-8")
        section = document.split("## VERSION 代际检查\n", 1)[1].split("## 升级链验证\n", 1)[0]
        scripts = re.findall(r"(?ms)^python3 -B - <<'PY'\n(.*?)^PY$", section)
        self.assertEqual(len(scripts), 1, "VERSION 检查必须有且只有一个 Python heredoc")
        env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONDONTWRITEBYTECODE="1")
        return subprocess.run([sys.executable, "-B", "-c", scripts[0]], cwd=str(root),
                              env=env, capture_output=True, encoding="utf-8", timeout=5)

    def test_documented_check_accepts_current_overlay(self):
        result = self.run_check(ROOT)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertRegex(result.stdout, r"VERSION=v[0-9]+(?:\.[0-9]+)? 链长=[0-9]+ OK")
        self.assertEqual(result.stderr, "")

    def test_documented_check_validates_mutated_ledgers(self):
        cases = [
            ("numeric order", 'var VERSION = "v10"; // v9 old → v10 new', True),
            ("hotfix order", 'var VERSION = "v100"; // v99 old → v99.1 fix → v99.2 fix → v100 new', True),
            ("numeric hotfix order", 'var VERSION = "v99.10"; // v99.2 old → v99.10 new', True),
            ("parenthesized label", 'var VERSION = "v99.1"; // v99（旧）→ v99.1（修复）', True),
            ("duplicate", 'var VERSION = "v10"; // v9 old → v9 duplicate → v10 new', False),
            ("out of order", 'var VERSION = "v10"; // v9.1 old → v9 older → v10 new', False),
            ("wrong final label", 'var VERSION = "v10"; // v9 old', False),
            ("empty ledger", 'var VERSION = "v10"; //', False),
            ("missing labels", 'var VERSION = "v10"; // no entries', False),
            ("missing first label", 'var VERSION = "v10"; // old → v10 new', False),
            ("missing middle label", 'var VERSION = "v10"; // v9 old → missing label → v10 new', False),
            ("missing version prefix", 'var VERSION = "v10"; // v9 old → 9.1 missing-prefix → v10 new', False),
            ("uppercase prefix", 'var VERSION = "v10"; // v9 old → V9.1 fix → v10 new', False),
            ("empty middle entry", 'var VERSION = "v10"; // v9 old → → v10 new', False),
            ("missing trailing label", 'var VERSION = "v10"; // v9 old → v10 new → missing label', False),
            ("trailing arrow", 'var VERSION = "v10"; // v9 old → v10 new →', False),
            ("unspaced version labels", 'var VERSION = "v10"; // v9（旧）→v9.1（修复）→v10（新）', True),
            ("description arrows", 'var VERSION = "v10"; // v9 tok→token、6→24 次 → v10 安装→同步', True),
            ("letter suffix", 'var VERSION = "v100"; // v99 old → v99b fix → v100 new', False),
            ("extra numeric component", 'var VERSION = "v100"; // v99 old → v99.1.2 fix → v100 new', False),
            ("malformed label", 'var VERSION = "v100"; // v99 old → vbad fix → v100 new', False),
            ("missing declaration", '// no VERSION declaration', False),
            ("invalid declaration", 'var VERSION = "v99b"; // v99 old', False),
            ("duplicate declarations", 'var VERSION = "v10"; // v10 first\nvar VERSION = "v10"; // v10 second', False),
            ("semicolon duplicate", 'var VERSION = "v10"; // v10 first\n;var VERSION = "v9"; // v9 second', False),
            ("block comment duplicate", 'var VERSION = "v10"; // v10 first\n/* second */ var VERSION = "v9";', False),
            ("multi-variable duplicate", 'var VERSION = "v10"; // v10 first\nvar unused = 0, VERSION = "v9";', False),
            ("let duplicate", 'var VERSION = "v10"; // v10 first\nfunction other() { let VERSION = "v9"; }', False),
            ("same-line duplicate", 'var VERSION = "v10"; var VERSION = "v9"; // v9 second', False),
            ("reassignment", 'var VERSION = "v10"; // v10 first\nVERSION = "v9";', False),
            ("missing inline ledger", 'var VERSION = "v10";', False),
            ("missing source", None, False),
            ("invalid UTF-8", b"\xff", False),
        ]
        for name, content, valid in cases:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                if isinstance(content, bytes):
                    (root / "overlay.js").write_bytes(content)
                elif content is not None:
                    (root / "overlay.js").write_text(content + "\n", encoding="utf-8")
                result = self.run_check(root)
                if valid:
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.assertIn(" OK", result.stdout)
                else:
                    self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.assertIn("VERSION 台账检查失败", result.stdout)
                    self.assertNotIn(" OK", result.stdout)
                self.assertEqual(result.stderr, "", result.stderr)


if __name__ == "__main__":
    unittest.main()
