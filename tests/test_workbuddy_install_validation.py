# -*- coding: utf-8 -*-
"""Isolated WorkBuddy installer validation; never touches the real home."""
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("wb_installer", ROOT / "scripts/install_workbuddy_plugin.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class WorkBuddyInstallValidationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        (self.base / "plugins").mkdir()
        self.env = mock.patch.dict(os.environ, {"WORKBUDDY_HOME": str(self.base)})
        self.env.start()
        self.addCleanup(self.env.stop)

    def write_inputs(self, ip, settings, km=None):
        for path, data in ((self.base / "plugins/known_marketplaces.json",
                            {"other": {}} if km is None else km),
                           (self.base / "plugins/installed_plugins.json", ip),
                           (self.base / "settings.json", settings)):
            path.write_text(json.dumps(data), encoding="utf-8")

    def snapshot(self):
        return {str(p.relative_to(self.base)): p.read_bytes() if p.is_file() else None
                for p in self.base.rglob("*")}

    def test_invalid_nested_fields_leave_everything_untouched(self):
        cases = [({"plugins": value}, {}) for value in (None, [], "bad")]
        cases += [({}, {"enabledPlugins": value}) for value in (None, [], "bad")]
        cases += [({"plugins": {installer.KEY: value}}, {}) for value in ({}, "bad", ["bad"])]
        for ip, settings in cases:
            with self.subTest(ip=ip, settings=settings):
                self.write_inputs(ip, settings)
                before = self.snapshot()
                self.assertEqual(installer.install(), 1)
                self.assertEqual(self.snapshot(), before)

    def test_uninstall_invalid_fields_preserves_all_data(self):
        for ip, settings in (({"plugins": []}, {}), ({}, {"enabledPlugins": None})):
            with self.subTest(ip=ip, settings=settings):
                self.write_inputs(ip, settings)
                before = self.snapshot()
                self.assertEqual(installer.uninstall(), 1)
                self.assertEqual(self.snapshot(), before)

    def test_uninstall_rejects_corrupt_file_without_writes(self):
        self.write_inputs({}, {})
        (self.base / "settings.json").write_text("{", encoding="utf-8")
        before = self.snapshot()
        self.assertEqual(installer.uninstall(), 1)
        self.assertEqual(self.snapshot(), before)

    def test_uninstall_rejects_top_level_non_object(self):
        cases = [("known_marketplaces.json", value) for value in ([], "bad")]
        cases += [("installed_plugins.json", value) for value in ([], "bad")]
        cases += [("settings.json", value) for value in ([], "bad")]
        for filename, value in cases:
            with self.subTest(filename=filename, value=value):
                self.write_inputs(value if filename == "installed_plugins.json" else {"plugins": {}},
                                  value if filename == "settings.json" else {"enabledPlugins": {}},
                                  km=value if filename == "known_marketplaces.json" else None)
                before = self.snapshot()
                self.assertEqual(installer.uninstall(), 1)
                self.assertEqual(self.snapshot(), before)

    def test_install_rejects_top_level_non_object(self):
        cases = [("known_marketplaces.json", []), ("known_marketplaces.json", "bad"),
                 ("installed_plugins.json", []), ("installed_plugins.json", "bad"),
                 ("settings.json", []), ("settings.json", "bad")]
        for filename, value in cases:
            with self.subTest(filename=filename, value=value):
                self.write_inputs(value if filename == "installed_plugins.json" else {"plugins": {}},
                                  value if filename == "settings.json" else {"enabledPlugins": {}},
                                  km=value if filename == "known_marketplaces.json" else None)
                before = self.snapshot()
                self.assertEqual(installer.install(), 1)
                self.assertEqual(self.snapshot(), before)

    def test_check_rejects_top_level_non_object(self):
        cases = [("known_marketplaces.json", []), ("known_marketplaces.json", "bad"),
                 ("installed_plugins.json", []), ("installed_plugins.json", "bad"),
                 ("settings.json", []), ("settings.json", "bad")]
        for filename, value in cases:
            with self.subTest(filename=filename, value=value):
                self.write_inputs(value if filename == "installed_plugins.json" else {"plugins": {}},
                                  value if filename == "settings.json" else {"enabledPlugins": {}},
                                  km=value if filename == "known_marketplaces.json" else None)
                before = self.snapshot()
                self.assertEqual(installer.check(), 1)
                self.assertEqual(self.snapshot(), before)

    def test_check_invalid_fields_reports_failure_without_crash(self):
        cases = [({"plugins": value}, {}) for value in (None, [], "bad", ["bad"])]
        cases += [({}, {"enabledPlugins": value}) for value in (None, [], "bad")]
        cases += [({"plugins": {installer.KEY: value}}, {})
                  for value in ({}, "bad", ["bad"],
                                [{"installPath": 123}], [{"installPath": None}])]
        for ip, settings in cases:
            with self.subTest(ip=ip, settings=settings):
                self.write_inputs(ip, settings)
                before = self.snapshot()
                self.assertEqual(installer.check(), 1)
                self.assertEqual(self.snapshot(), before)

    def test_check_ready_installation_returns_zero(self):
        self.write_inputs({"plugins": {installer.KEY: [{"installPath": str(self.base / "cache")}]}},
                          {"enabledPlugins": {installer.KEY: True}})
        (self.base / "plugins" / "known_marketplaces.json").write_text(
            json.dumps({"other": {}, installer.MARKET: {}}), encoding="utf-8")
        for name in ("usage_mcp.py", "zusage.py", "token_pricing.py",
                     ".codebuddy-plugin/plugin.json", "commands/usage.md"):
            path = self.base / "cache" / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("# ok", encoding="utf-8")
        self.assertEqual(installer.check(), 0)

    def test_install_rejects_missing_registration_files(self):
        self.write_inputs({}, {})
        for missing in ("settings.json", "plugins/known_marketplaces.json",
                        "plugins/installed_plugins.json"):
            with self.subTest(missing=missing):
                path = self.base / missing
                keep = path.read_bytes()
                path.unlink()
                before = self.snapshot()
                self.assertEqual(installer.install(), 1)
                self.assertEqual(self.snapshot(), before)
                path.write_bytes(keep)

    def test_check_flags_invalid_install_path_when_otherwise_ready(self):
        import contextlib
        import io

        for rec in ([{"version": "1.0.0"}], [{"installPath": ""}], [{"installPath": 7}]):
            with self.subTest(rec=rec):
                self.write_inputs({"plugins": {installer.KEY: rec}},
                                  {"enabledPlugins": {installer.KEY: True}},
                                  km={"other": {}, installer.MARKET: {}})
                before = self.snapshot()
                out = io.StringIO()
                with contextlib.redirect_stdout(out):
                    self.assertEqual(installer.check(), 1)
                self.assertIn("installPath 缺失或非法，未就绪", out.getvalue())
                self.assertEqual(self.snapshot(), before)

    def test_top_level_null_rejected_without_writes(self):
        for filename in ("settings.json", "plugins/known_marketplaces.json",
                         "plugins/installed_plugins.json"):
            with self.subTest(filename=filename):
                self.write_inputs({}, {})
                path = self.base / filename
                keep = path.read_bytes()
                path.write_text("null", encoding="utf-8")
                before = self.snapshot()
                self.assertEqual(installer.install(), 1)
                self.assertEqual(installer.uninstall(), 1)
                self.assertEqual(installer.check(), 1)
                self.assertEqual(self.snapshot(), before)
                path.write_bytes(keep)

    def test_check_cache_probe_requires_existing_dir_and_files(self):
        self.write_inputs({}, {}, km={"other": {}, installer.MARKET: {}})
        cache = self.base / "cache"
        names = ("usage_mcp.py", "zusage.py", "token_pricing.py",
                 ".codebuddy-plugin/plugin.json", "commands/usage.md")

        def set_install_path(value):
            (self.base / "plugins" / "installed_plugins.json").write_text(
                json.dumps({"plugins": {installer.KEY: [{"installPath": value}]}}),
                encoding="utf-8")
            (self.base / "settings.json").write_text(
                json.dumps({"enabledPlugins": {installer.KEY: True}}), encoding="utf-8")

        set_install_path(str(self.base / "no-such-cache"))
        self.assertEqual(installer.check(), 1)
        for name in names:
            path = cache / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("# ok", encoding="utf-8")
        set_install_path(str(cache))
        self.assertEqual(installer.check(), 0)
        for name in names:
            path = cache / name
            keep = path.read_text(encoding="utf-8")
            path.unlink()
            self.assertEqual(installer.check(), 1)
            path.write_text(keep, encoding="utf-8")

    def test_check_rejects_corrupt_file_reporting_cause(self):
        import contextlib
        import io

        self.write_inputs({}, {})
        (self.base / "plugins" / "installed_plugins.json").write_text("{", encoding="utf-8")
        before = self.snapshot()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(installer.check(), 1)
        self.assertIn("无法读取或解析", out.getvalue())
        self.assertEqual(self.snapshot(), before)

    def test_install_then_uninstall_keeps_other_entries(self):
        self.write_inputs({"plugins": {"other": []}}, {"enabledPlugins": {"other": True}})
        self.assertEqual(installer.install(), 0)
        self.assertEqual(installer.uninstall(), 0)
        ip = json.loads((self.base / "plugins/installed_plugins.json").read_text())
        settings = json.loads((self.base / "settings.json").read_text())
        self.assertEqual(ip["plugins"], {"other": []})
        self.assertEqual(settings["enabledPlugins"], {"other": True})

    def test_valid_and_missing_fields_install_preserving_existing_data(self):
        self.write_inputs({"plugins": {"other": [], installer.KEY: [{"installedAt": "original"}]}},
                          {"enabledPlugins": {"other": False}})
        self.assertEqual(installer.install(), 0)
        ip = json.loads((self.base / "plugins/installed_plugins.json").read_text())
        settings = json.loads((self.base / "settings.json").read_text())
        self.assertEqual(ip["plugins"][installer.KEY][0]["installedAt"], "original")
        self.assertEqual(ip["plugins"]["other"], [])
        self.assertIs(settings["enabledPlugins"]["other"], False)
        self.write_inputs({"plugins": {installer.KEY: [{"version": "0.9"}]}}, {})
        self.assertEqual(installer.install(), 0)
        ip = json.loads((self.base / "plugins/installed_plugins.json").read_text())
        self.assertIsInstance(ip["plugins"][installer.KEY][0]["installedAt"], str)
        self.write_inputs({}, {})
        self.assertEqual(installer.install(), 0)
        self.write_inputs({"plugins": {installer.KEY: []}}, {})
        self.assertEqual(installer.install(), 0)
