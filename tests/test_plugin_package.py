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
        self.assertNotIn("plugin_auto_install_overlay", config)   # v172：自动安装恒开，开关已移除
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

    def test_standalone_runtime_files_cover_finalize_toolchain(self):
        # issue #163：待替换包的手动收尾命令（install --finalize）只依赖运行目录内的
        # 这套脚本；独立安装链的运行清单缺任一个，clone 被删/移动后失败提示里的命令
        # 就再也无法执行，pending 永久搁浅、状态条永不出现。插件链（overlay_install）
        # 早已同款在列，独立链不得再回退。
        install_spec = importlib.util.spec_from_file_location("standalone_finalize_toolchain_test", ROOT / "install.py")
        standalone = importlib.util.module_from_spec(install_spec)
        install_spec.loader.exec_module(standalone)
        for name in ("patch_install.py", "install_monitor.py", "runtime_lock.py"):
            self.assertIn(name, standalone.RUNTIME_FILES)
            self.assertTrue((ROOT / name).is_file())

    def test_cold_files_literals_agree(self):
        # v172：run_hook 的 cold_files 提醒清单随会话内文字提醒一起移除，只剩 sync_runtime
        # 一处（写 marker 用）；将来若新增提醒清单，须恢复「两处字面量一致」断言
        src = (PLUGIN / "overlay_install.py").read_text(encoding="utf-8")
        literals = re.findall(r"cold_files = \{([^}]+)\}", src)
        self.assertEqual(len(literals), 1, msg="cold_files 字面量应恰一处（sync_runtime 写 marker）；文字提醒清单已随 v172 移除")
        self.assertTrue(literals[0], msg="提取到的 cold_files 字面量为空")

    def test_six_distribution_manifests_agree_with_sync_plugin(self):
        sync_spec = importlib.util.spec_from_file_location("sync_plugin_manifest_test", ROOT / "sync_plugin.py")
        sync_mod = importlib.util.module_from_spec(sync_spec)
        sync_spec.loader.exec_module(sync_mod)
        self.assertEqual(sync_mod.check_manifests(ROOT), [])

    def test_modular_overlay_sources_assemble_byte_identically(self):
        build_spec = importlib.util.spec_from_file_location("build_overlay_test", ROOT / "scripts" / "build_overlay.py")
        build_mod = importlib.util.module_from_spec(build_spec)
        build_spec.loader.exec_module(build_mod)
        assembled, parts = build_mod.assemble_bytes(ROOT / "src" / "overlay")
        self.assertEqual(len(parts), 19)   # 04- 前缀七文件（词包+速度 V3 五分片+rotator 数据）；v384 增至 19
        self.assertEqual(assembled, (ROOT / "overlay.js").read_bytes())
        self.assertEqual(assembled, (PLUGIN / "overlay.js").read_bytes())
        self.assertEqual(build_mod.main(["--check"], root=ROOT), 0)

    def test_modular_quota_sources_assemble_byte_identically(self):
        build_spec = importlib.util.spec_from_file_location("build_quota_test", ROOT / "scripts" / "build_quota.py")
        build_mod = importlib.util.module_from_spec(build_spec)
        build_spec.loader.exec_module(build_mod)
        assembled, parts = build_mod.assemble_bytes(ROOT / "src" / "quota")
        self.assertEqual(len(parts), 6)
        self.assertEqual(assembled, (ROOT / "quota-client.cjs").read_bytes())
        self.assertEqual(assembled, (PLUGIN / "quota-client.cjs").read_bytes())
        self.assertEqual(build_mod.main(["--check"], root=ROOT), 0)

    def test_modular_puller_sources_assemble_byte_identically(self):
        build_spec = importlib.util.spec_from_file_location("build_puller_test", ROOT / "scripts" / "build_puller.py")
        build_mod = importlib.util.module_from_spec(build_spec)
        build_spec.loader.exec_module(build_mod)
        assembled, parts = build_mod.assemble_bytes(ROOT / "src" / "puller")
        self.assertEqual(len(parts), 4)
        self.assertEqual(assembled, (ROOT / "model-puller.cjs").read_bytes())
        self.assertEqual(assembled, (PLUGIN / "model-puller.cjs").read_bytes())
        self.assertEqual(build_mod.main(["--check"], root=ROOT), 0)

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


class SyncPluginManifestFlagTests(unittest.TestCase):
    """--verify-manifests 曾是幽灵旗标：脚本不识别时未知参数静默走写入同步路径，
    期待只读校验的维护者会被无提示覆盖根产物/插件副本（review 事后发现的 MAJOR）。"""

    @staticmethod
    def _load_sync_plugin():
        spec = importlib.util.spec_from_file_location("sync_plugin_under_test", ROOT / "sync_plugin.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    def test_verify_manifests_is_read_only_and_green_on_clean_tree(self):
        import contextlib
        import io
        mod = self._load_sync_plugin()
        watched = [ROOT / "overlay.js", ROOT / "zusage.py", PLUGIN / "overlay.js", PLUGIN / "zusage.py"]
        before = {p: p.read_bytes() for p in watched}
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = mod.main(verify_manifests=True)
        self.assertEqual(rc, 0, buf.getvalue())
        self.assertIn("6 处分发清单一致", buf.getvalue())
        self.assertNotIn("已同步", buf.getvalue(), "verify mode must not copy plugin copies")
        for p in watched:
            self.assertEqual(p.read_bytes(), before[p], f"verify mode must not rewrite {p.name}")

    def test_verify_manifests_reports_drift_as_failure(self):
        import contextlib
        import io
        from unittest import mock
        mod = self._load_sync_plugin()
        buf = io.StringIO()
        with mock.patch.object(mod, "check_manifests", return_value=["fake: drift"]):
            with contextlib.redirect_stdout(buf):
                rc = mod.main(verify_manifests=True)
        self.assertEqual(rc, 1, buf.getvalue())
        self.assertIn("清单漂移", buf.getvalue())

    def test_unknown_flag_is_refused_instead_of_silent_sync(self):
        result = subprocess.run(
            [sys.executable, "-B", str(ROOT / "sync_plugin.py"), "--verify-manifest-typo"],
            capture_output=True, text=True, cwd=ROOT,
        )
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("未知参数", result.stderr)
        self.assertIn("--verify-manifests", result.stderr)


class AntiReworkContractTests(unittest.TestCase):
    """由近一个月高频 Bug / 回滚 / 多轮 Review 返工根因沉淀出的自动化防复发门禁。"""

    @staticmethod
    def _find_bare_tempfile_violations(source_text, label="<inline>"):
        import ast
        forbidden_attrs = {"mkstemp", "mkdtemp", "NamedTemporaryFile", "TemporaryDirectory"}
        tree = ast.parse(source_text, filename=label)
        violations = []
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module == "tempfile":
                for alias in node.names:
                    if alias.name in forbidden_attrs:
                        violations.append(f"{label}:{node.lineno} imports tempfile.{alias.name}")
            elif isinstance(node, ast.Call):
                func = node.func
                if (isinstance(func, ast.Attribute)
                        and isinstance(func.value, ast.Name)
                        and func.value.id == "tempfile"
                        and func.attr in forbidden_attrs):
                    violations.append(f"{label}:{node.lineno} calls tempfile.{func.attr}")
                elif isinstance(func, ast.Name) and func.id in forbidden_attrs:
                    violations.append(f"{label}:{node.lineno} calls {func.id}")
        return violations

    def test_runtime_python_modules_forbid_bare_tempfile_mkstemp_and_mkdtemp(self):
        # 根因（issue #360 / PR #361）：Windows 受保护目录上 os.access 看不见 ACL 恒返 True，
        # 标准库 tempfile.mkstemp / mkdtemp / NamedTemporaryFile / TemporaryDirectory 在旧版
        # Python 上会吞 PermissionError 重试 TMP_MAX (2^31-1) 次导致进程永久挂起。
        # 全部分发与运行链 .py 文件必须统一使用 runtime_lock.bounded_mkstemp / bounded_tempdir。
        sync_spec = importlib.util.spec_from_file_location("sync_plugin_for_ast_guard", ROOT / "sync_plugin.py")
        sync_mod = importlib.util.module_from_spec(sync_spec)
        sync_spec.loader.exec_module(sync_mod)
        runtime_py_files = [ROOT / "install.py"]
        for rel in sync_mod.FILES:
            if rel.endswith(".py"):
                runtime_py_files.append(ROOT / rel)
        for rel in sync_mod.PLUGIN_ONLY_FILES:
            if rel.endswith(".py"):
                runtime_py_files.append(PLUGIN / rel)
        violations = []
        for path in runtime_py_files:
            violations.extend(
                self._find_bare_tempfile_violations(path.read_text(encoding="utf-8"), str(path.relative_to(ROOT)))
            )
        self.assertEqual(violations, [], "运行/安装链严禁裸调 tempfile.mkstemp/mkdtemp，请改用 runtime_lock.bounded_mkstemp/bounded_tempdir")
        # 负向变异自检：确认 AST 守卫能捕获属性调用、裸名调用与 from tempfile import 别名导入
        self.assertTrue(self._find_bare_tempfile_violations("import tempfile\ntempfile.mkstemp()\n", "mut1"))
        self.assertTrue(self._find_bare_tempfile_violations("from tempfile import mkdtemp as md\n", "mut2"))
        self.assertTrue(self._find_bare_tempfile_violations("NamedTemporaryFile()\n", "mut3"))

    def test_sync_plugin_wires_desktop_shard_builders_only(self):
        # 根因：分片化后若 sync_plugin._maybe_build_bundles 漏接任一构建器，分片改动不会进入根产物与插件副本。
        from unittest import mock
        sync_spec = importlib.util.spec_from_file_location("sync_plugin_builder_wire_test", ROOT / "sync_plugin.py")
        sync_mod = importlib.util.module_from_spec(sync_spec)
        sync_spec.loader.exec_module(sync_mod)
        called = []

        def fake_load(name, path):
            m = mock.MagicMock()
            m.main.side_effect = lambda argv, root=None: (called.append((Path(path).name, list(argv))), 0)[1]
            return m

        with mock.patch.object(sync_mod, "_load_module", side_effect=fake_load):
            self.assertTrue(sync_mod._maybe_build_bundles(ROOT, check_only=True))
        self.assertEqual(
            called,
            [
                ("build_overlay.py", ["--check"]),
                ("build_quota.py", ["--check"]),
                ("build_puller.py", ["--check"]),
            ],
        )

    def test_build_puller_rejects_unknown_flags_stray_files_and_drift(self):
        # 行为级守卫：锁定新增 build_puller.py 的未知参数拒绝、杂散文件防丢片与漂移检测。
        build_spec = importlib.util.spec_from_file_location("build_puller_guard_test", ROOT / "scripts" / "build_puller.py")
        build_mod = importlib.util.module_from_spec(build_spec)
        build_spec.loader.exec_module(build_mod)
        self.assertEqual(build_mod.main(["--unknown-flag"], root=ROOT), 2)
        with tempfile.TemporaryDirectory() as tmp:
            tmp_root = Path(tmp)
            src_dir = tmp_root / "src" / "puller"
            src_dir.mkdir(parents=True)
            (src_dir / "00-part.cjs").write_text("// ok\n", encoding="utf-8")
            (src_dir / "stray.cjs").write_text("// stray\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "stray\\.cjs"):
                build_mod.assemble_bytes(src_dir)
            (src_dir / "stray.cjs").unlink()
            (tmp_root / "model-puller.cjs").write_text("// stale\n", encoding="utf-8")
            self.assertEqual(build_mod.main(["--check"], root=tmp_root), 1)
            self.assertEqual(build_mod.main([], root=tmp_root), 0)
            self.assertEqual(build_mod.main(["--check"], root=tmp_root), 0)

    def test_overlay_own_layer_modals_have_boot_cleanup_and_exemption_symmetry(self):
        # 根因（v317 / v334 / v342）：新增全屏弹层/遮罩若漏挂 00 启动自清选择器、isOwnOverlay()、
        # OWN_LAYER_SEL（modalOpen 豁免）或 12 dispose()，会导致打开弹窗时设置面板被自动收起或热更残留。
        boot_src = (ROOT / "src" / "overlay" / "00-boot-state-i18n.js").read_text(encoding="utf-8")
        sub_src = (ROOT / "src" / "overlay" / "10-instance-subpanel-and-composer.js").read_text(encoding="utf-8")
        dispose_src = (ROOT / "src" / "overlay" / "12-instance-mount-and-boot.js").read_text(encoding="utf-8")
        m_boot = re.search(r'document\.querySelectorAll\("([^"]+)"\)\.forEach\(function\s*\(el\)\s*\{\s*el\.remove\(\);', boot_src)
        self.assertIsNotNone(m_boot, "00-boot-state-i18n.js 必须包含启动自清 querySelectorAll(...).remove()")
        boot_selectors = {s.strip() for s in m_boot.group(1).split(",") if s.strip()}
        m_own = re.search(r'var OWN_LAYER_SEL = "([^"]+)";', sub_src)
        self.assertIsNotNone(m_own, "10-instance-subpanel-and-composer.js 必须定义 OWN_LAYER_SEL")
        own_selectors = [s.strip() for s in m_own.group(1).split(",") if s.strip()]
        m_is_own = re.search(r'function isOwnOverlay\(el\)\s*\{.*?el\.closest\("([^"]+)"\)', sub_src, re.S)
        self.assertIsNotNone(m_is_own, "10-instance-subpanel-and-composer.js 必须定义 isOwnOverlay")
        is_own_selectors = {s.strip() for s in m_is_own.group(1).split(",") if s.strip()}
        for sel in own_selectors:
            self.assertIn(sel, boot_selectors, f"OWN_LAYER_SEL 中的 {sel} 必须在 00 启动自清选择器集合中精确登记")
            if sel != ".zusage-panel":
                self.assertIn(sel, is_own_selectors, f"OWN_LAYER_SEL 中的 {sel} 必须在 isOwnOverlay() 中豁免")
        m_dispose = re.search(r'function dispose\(\)\s*\{(.*?)\n    \}', dispose_src, re.S)
        self.assertIsNotNone(m_dispose, "12-instance-mount-and-boot.js 必须定义 dispose()")
        dispose_body = m_dispose.group(1)
        for cleanup_call in ("closeCompactDlg()", "cleanupMpModal()", "panel.remove()", "subPanel.remove()", "tip.remove()"):
            self.assertIn(cleanup_call, dispose_body, f"dispose() 必须调用 {cleanup_call} 清理实例浮层/弹窗")

    def test_three_way_db_path_override_contract_is_locked(self):
        # 根因（issue #279 / #294 / #314）：本地库路径解析横跨 zusage.py、token_rate.py、inject-main.cjs，
        # 任一端漏同步 hosts.zcode.db_path 都会造成静默错读或主桥去重戳失灵。
        zusage_src = (ROOT / "zusage.py").read_text(encoding="utf-8")
        rate_src = (ROOT / "token_rate.py").read_text(encoding="utf-8")
        inject_src = (ROOT / "inject-main.cjs").read_text(encoding="utf-8")
        test_src = (ROOT / "tests" / "test_token_rate_db_override.py").read_text(encoding="utf-8")
        self.assertIn("def zcode_db_path(", zusage_src)
        self.assertIn("def _configured_db_path(", rate_src)
        self.assertIn("function resolveConfiguredDbPath(", inject_src)
        self.assertRegex(inject_src, r"function dbFile\(\)\s*\{[^}]*resolveConfiguredDbPath\(\)")
        self.assertIn("def test_node_inject_main_matches_python_across_all_scenarios(", test_src)


if __name__ == "__main__":
    unittest.main()
