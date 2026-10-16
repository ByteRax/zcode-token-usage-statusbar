# -*- coding: utf-8 -*-
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))
import symlink_support  # noqa: E402
spec = importlib.util.spec_from_file_location("release_tool_test", ROOT / "release_tool.py")
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)
REPO = "ByteRax/zcode-token-usage-statusbar"

# An executable gh stub; all GitHub calls below are isolated and have no network access.
GH_STUB = r'''#!/usr/bin/env python3
import json, os, pathlib, sys
root = pathlib.Path(os.environ["STUB_ROOT"])
args = sys.argv[1:]
with (root / "gh.log").open("a") as log:
    log.write(json.dumps(args) + "\n")
mode = os.environ.get("STUB_MODE", "ok")
state_path = root / "gh-state.json"
state = json.loads(state_path.read_text()) if state_path.exists() else {}
def emit(value):
    print(json.dumps(value))
def release(draft):
    body = state.get("body")
    if mode == "baddraftbody" and draft or mode == "badfinalbody" and not draft:
        body = "Unreviewed release notes"
    elif mode == "missingdraftbody" and draft or mode == "missingfinalbody" and not draft:
        body = None
    elif mode == "normalizedbody" and isinstance(body, str):
        body = body.replace("\r\n", "\n").rstrip() + "\r\n \t"
    elif mode == "leadingbody" and draft:
        body = " " + body
    elif mode == "linewhitespacebody" and draft:
        body = body.replace("\r\n", " \r\n")
    return {"draft": draft, "prerelease": False, "tag_name": "v1.2.3", "body": body,
            "assets": state.get("assets", [])}
if args[:2] == ["auth", "status"]:
    sys.exit(1 if mode == "noauth" else 0)
if args[0] == "api":
    endpoint = args[1]
    if "/releases/assets/" in endpoint:
        asset_id = int(endpoint.rsplit("/", 1)[1])
        data = pathlib.Path(state["paths"][str(asset_id)]).read_bytes()
        sys.stdout.buffer.write(b"tampered" if mode == "badhash" else data)
    elif endpoint.endswith("/releases/tags/v1.2.3"):
        emit(release(state.get("draft", True)))
    elif "/git/ref/tags/" in endpoint:
        head = (root / "head").read_text().strip()
        emit({"object": {"type": "commit", "sha": "0" * 40 if mode == "badtag" else head}})
    elif endpoint.endswith("/commits/v1.2.3"):
        emit({"sha": (root / "head").read_text().strip()})
    elif "/releases?" in endpoint:
        emit([[release(state["draft"])]] if "draft" in state else
             [[{"tag_name": "v1.2.3", "draft": True}]] if mode == "exists" else [[]])
    else:
        emit({"full_name": "ByteRax/zcode-token-usage-statusbar", "permissions": {"push": mode != "readonly"}})
elif args[:2] == ["release", "create"]:
    state["draft"] = True
    state["body"] = pathlib.Path(args[args.index("--notes-file") + 1]).read_bytes().decode("utf-8")
elif args[:2] == ["release", "upload"]:
    server = root / "gh-assets"
    server.mkdir(exist_ok=True)
    state["paths"] = {}
    state["assets"] = []
    for i, p in enumerate(args[3:5], 1):
        data = pathlib.Path(p).read_bytes()
        stored = server / str(i)
        stored.write_bytes(data)
        state["paths"][str(i)] = str(stored)
        state["assets"].append({"id": i, "name": pathlib.Path(p).name,
                                "size": len(data), "state": "uploaded"})
elif args[:2] == ["release", "edit"]:
    state["draft"] = mode == "badpublish"
else:
    sys.exit("unexpected gh command: " + repr(args))
state_path.write_text(json.dumps(state))
'''


class ReleaseToolTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.root = self.base / "repo"
        self.root.mkdir()
        for name in tool.NAMES:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            source = ROOT / name
            # 归一成 LF：夹具不随开发者检出的行尾变化（Windows 旧检出可能仍是 CRLF）。
            content = source.read_bytes().replace(b"\r\n", b"\n") if source.is_file() else b"// fixture source\n"
            path.write_bytes(content)
        helper = (ROOT / "release_unpack.py").read_bytes().replace(b"\r\n", b"\n")
        (self.root / tool.PREFIX / "release_unpack.py").write_bytes(helper)
        manifest = {"name": tool.PLUGIN, "version": "1.2.3", "commands": "commands", "skills": "skills"}
        for name in (".zcode-plugin/plugin.json", ".claude-plugin/plugin.json"):
            (self.root / tool.PREFIX / name).write_text(json.dumps(manifest))
        market = {"name": "zusage-marketplace", "plugins": [{"name": tool.PLUGIN, "version": "1.2.3",
                  "source": "./plugins/" + tool.PLUGIN}]}
        (self.root / "marketplace.json").write_text(json.dumps(market))
        for name in tool.SYNC_FILES:
            (self.root / name).write_bytes((self.root / tool.PREFIX / name).read_bytes())
        script = (ROOT / "release_tool.py").read_bytes()
        (self.root / "release_tool.py").write_bytes(script)
        (self.root / "sync_plugin.py").write_text("# fixture\n")
        self.git("init", "--quiet")
        self.git("config", "user.name", "Release Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        self.git("add", ".")
        self.git("commit", "--quiet", "-m", "fixture")
        self.git("tag", "v1.2.3")
        self.git("remote", "add", "origin", "https://github.com/xhwxt/zcode-token-usage-statusbar.git")
        self.git("remote", "add", "writable", "git@github.com:" + REPO + ".git")
        (self.base / "head").write_text(self.git("rev-parse", "HEAD").strip())
        bin_dir = self.base / "bin"
        bin_dir.mkdir()
        gh = bin_dir / "gh"
        gh.write_text(GH_STUB)
        gh.chmod(0o755)
        if os.name == "nt":
            # Windows 的 CreateProcess 解析不了无扩展名的 shebang 脚本（gh stub）：
            # 垫片把 gh 命令改派给本进程的 Python 解释器执行 stub。仅测试进程内生效，
            # 真机上 gh.exe 由 GitHub CLI 官方安装，不受影响。
            real_run = tool.run

            def run_via_python(root, *args, **kwargs):
                if args and args[0] == "gh":
                    args = (sys.executable, str(gh), *args[1:])
                return real_run(root, *args, **kwargs)

            tool.run = run_via_python
            self.addCleanup(setattr, tool, "run", real_run)
        self.env = mock.patch.dict(os.environ, {"PATH": str(bin_dir) + os.pathsep + os.environ["PATH"],
                                  "STUB_ROOT": str(self.base), "STUB_MODE": "ok"})
        self.env.start()
        self.addCleanup(self.env.stop)
        built = tool.build(self.root, REPO, self.base / "out")
        self.asset = Path(built["zip"])
        self.manifest = Path(built["manifest"])
        self.notes_file = self.base / "notes.md"
        self.notes = "## 更新说明\r\n\r\n- 修复发布正文校验。\r\n- 保留完整 Markdown 和 UTF-8 说明。\r\n"
        self.notes_file.write_bytes(self.notes.encode("utf-8"))

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.root, stderr=subprocess.PIPE).decode()

    def calls(self):
        path = self.base / "gh.log"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def assert_no_publish(self):
        self.assertFalse(any(c[0] == "release" for c in self.calls()), self.calls())

    def refresh_hash(self):
        manifest = json.loads(self.manifest.read_text())
        data = self.asset.read_bytes()
        manifest["asset"].update(size=len(data), sha256=hashlib.sha256(data).hexdigest())
        self.manifest.write_text(json.dumps(manifest))

    def rewrite_zip(self, change):
        with zipfile.ZipFile(self.asset) as archive:
            entries = [(info, archive.read(info)) for info in archive.infolist()]
        with zipfile.ZipFile(self.asset, "w") as archive:
            for index, (info, data) in enumerate(entries):
                info, data = change(index, info, data)
                archive.writestr(info, data)
        self.refresh_hash()

    def test_deterministic_exact_source_only_and_full_paths(self):
        plugin = self.root / tool.PREFIX
        for name in ("config.json", "runtime/usage.db", "__pycache__/secret.pyc", ".git/config", ".DS_Store"):
            path = plugin / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("PRIVATE-USAGE-TOKEN")
        for name in tool.NAMES:
            path = self.root / name
            os.utime(path, (1800000000, 1800000000))
            path.chmod(0o600)
        result = tool.build(self.root, REPO, self.base / "again")
        self.assertEqual(self.asset.read_bytes(), Path(result["zip"]).read_bytes())
        self.assertEqual(self.manifest.read_bytes(), Path(result["manifest"]).read_bytes())
        self.assertTrue(Path(result["zip"]).is_absolute())
        with zipfile.ZipFile(self.asset) as archive:
            self.assertEqual(archive.namelist(), list(tool.NAMES))
            self.assertIn(tool.PREFIX + "release_unpack.py", archive.namelist())
            self.assertNotIn("release_tool.py", archive.namelist())
            self.assertFalse(any("skills/github-release/" in name or name.startswith(".zcode/")
                                 for name in archive.namelist()))
        self.assertNotIn(b"PRIVATE-USAGE-TOKEN", self.asset.read_bytes())

    def test_official_catalog_url_hash_path_and_internal_market_stays_local(self):
        catalog = json.loads((self.asset.parent / "marketplace-release.json").read_text())
        entry = catalog["plugins"][0]
        digest = json.loads(self.manifest.read_text())["asset"]["sha256"]
        self.assertEqual(entry["version"], "1.2.3")
        self.assertEqual(entry["source"], {"source": "url", "type": "zip",
            "url": f"https://github.com/{REPO}/releases/download/v1.2.3/{self.asset.name}",
            "sha256": digest, "path": "plugins/" + tool.PLUGIN, "stripRoot": False})
        with zipfile.ZipFile(self.asset) as archive:
            self.assertEqual(archive.read("LICENSE"), (self.root / "LICENSE").read_bytes())
            self.assertEqual(json.loads(archive.read("marketplace.json"))["plugins"][0]["source"],
                             "./plugins/" + tool.PLUGIN)
        self.assertEqual(json.loads((self.root / "marketplace.json").read_text())["plugins"][0]["source"],
                         "./plugins/" + tool.PLUGIN)

    def test_existing_output_never_overwritten(self):
        before = self.asset.read_bytes()
        with self.assertRaisesRegex(tool.ReleaseError, "already exists"):
            tool.build(self.root, REPO, self.asset.parent)
        self.assertEqual(before, self.asset.read_bytes())

    def test_versions_and_identity_mismatch(self):
        for version in ("1.2", "01.2.3", "1.2.3-beta", "v1.2.3", "1.2.4"):
            with self.subTest(version=version), self.assertRaises(tool.ReleaseError):
                tool.build(self.root, REPO, self.base / ("bad-" + version), version)
        path = self.root / tool.PREFIX / ".claude-plugin/plugin.json"
        value = json.loads(path.read_text())
        value["version"] = "1.2.4"
        path.write_text(json.dumps(value))
        with self.assertRaisesRegex(tool.ReleaseError, "manifests"):
            tool.build(self.root, REPO, self.base / "mismatch")

    def test_marketplace_mismatch_and_sync_drift(self):
        path = self.root / "marketplace.json"
        value = json.loads(path.read_text())
        value["plugins"][0]["version"] = "1.2.4"
        path.write_text(json.dumps(value))
        with self.assertRaisesRegex(tool.ReleaseError, "marketplace"):
            tool.build(self.root, REPO, self.base / "market-bad")
        value["plugins"][0]["version"] = "1.2.3"
        path.write_text(json.dumps(value))
        (self.root / "runtime_lock.py").write_text("drift")
        with self.assertRaisesRegex(tool.ReleaseError, "copy drift"):
            tool.build(self.root, REPO, self.base / "drift")

    @unittest.skipUnless(symlink_support.can_create_symlinks(),
                         "os.symlink requires SeCreateSymbolicLinkPrivilege on Windows")
    def test_symlinks_anywhere_rejected(self):
        (self.root / tool.PREFIX / "hidden-config").symlink_to(self.manifest)
        with self.assertRaisesRegex(tool.ReleaseError, "symlink"):
            tool.build(self.root, REPO, self.base / "symlink")

    def test_asset_hash_and_repository_mismatch(self):
        with self.assertRaisesRegex(tool.ReleaseError, "repository"):
            tool.verify(self.asset, self.manifest, "other/repo")
        with self.asset.open("ab") as stream:
            stream.write(b"corrupt")
        with self.assertRaisesRegex(tool.ReleaseError, "hash"):
            tool.verify(self.asset, self.manifest, REPO)

    def test_unsafe_zip_paths_duplicates_and_secret_rejected(self):
        original = self.asset.read_bytes()
        for name in ("../secret", "/absolute", "plugins\\secret", "marketplace.json",
                     tool.PREFIX + "runtime/usage.db"):
            with self.subTest(name=name):
                self.asset.write_bytes(original)
                self.rewrite_zip(lambda i, info, data: (zipfile.ZipInfo(name), data) if i == 0 else (info, data))
                with self.assertRaises(tool.ReleaseError):
                    tool.verify(self.asset, self.manifest, REPO)

    def test_zip_symlink_and_unsupported_compression_rejected(self):
        def symlink(index, info, data):
            if index == 0:
                info.external_attr = (stat.S_IFLNK | 0o777) << 16
            return info, data
        original = self.asset.read_bytes()
        self.rewrite_zip(symlink)
        with self.assertRaisesRegex(tool.ReleaseError, "non-regular|symlink/device"):
            tool.verify(self.asset, self.manifest, REPO)
        self.asset.write_bytes(original)
        def unsupported(index, info, data):
            info.compress_type = zipfile.ZIP_BZIP2
            return info, data
        self.rewrite_zip(unsupported)
        with self.assertRaisesRegex(tool.ReleaseError, "unsupported"):
            tool.verify(self.asset, self.manifest, REPO)

    def test_zip_manifest_version_corruption_with_valid_outer_hash_rejected(self):
        def mismatch(index, info, data):
            if info.filename.endswith("/.zcode-plugin/plugin.json"):
                value = json.loads(data)
                value["version"] = "1.2.4"
                data = json.dumps(value).encode()
            return info, data
        self.rewrite_zip(mismatch)
        with self.assertRaisesRegex(tool.ReleaseError, "manifests.*disagree"):
            tool.verify(self.asset, self.manifest, REPO)

    def test_verify_reuses_unpack_for_invalid_mcp_and_missing_hook_references(self):
        original = self.asset.read_bytes()
        cases = [(".mcp.json", b"not JSON", "Expecting value"),
                 ("hooks/hooks.json", json.dumps({"hooks": {"SessionStart": [{"hooks": [{
                     "command": "python3", "args": ["${ZCODE_PLUGIN_ROOT}/hooks/missing.py"]}]}]}}).encode(),
                  "missing or unsafe declared")]
        for name, replacement, message in cases:
            with self.subTest(name=name):
                self.asset.write_bytes(original)
                self.rewrite_zip(lambda i, info, data: (info, replacement)
                                 if info.filename == tool.PREFIX + name else (info, data))
                with self.assertRaisesRegex(tool.ReleaseError, message):
                    tool.verify(self.asset, self.manifest, REPO)
                self.assert_no_publish()

    def test_verify_rejects_duplicate_json_keys_even_with_correct_outer_hash(self):
        self.rewrite_zip(lambda i, info, data: (info, b'{"mcpServers":{},"mcpServers":{}}')
                         if info.filename == tool.PREFIX + ".mcp.json" else (info, data))
        with self.assertRaisesRegex(tool.ReleaseError, "duplicate JSON key"):
            tool.verify(self.asset, self.manifest, REPO)

    def test_verify_rejects_json_size_and_high_compression_ratio(self):
        original = self.asset.read_bytes()
        oversized = json.dumps({"padding": "x" * tool.MAX_MANIFEST}).encode()
        self.rewrite_zip(lambda i, info, data: (info, oversized)
                         if info.filename == tool.PREFIX + ".mcp.json" else (info, data))
        with self.assertRaisesRegex(tool.ReleaseError, "JSON exceeds"):
            tool.verify(self.asset, self.manifest, REPO)
        self.asset.write_bytes(original)
        def bomb(index, info, data):
            if info.filename == tool.PREFIX + "README.md":
                info.compress_type = zipfile.ZIP_DEFLATED
                data = b"x" * (2 * 1024 * 1024)
            return info, data
        self.rewrite_zip(bomb)
        with self.assertRaisesRegex(tool.ReleaseError, "compression ratio"):
            tool.verify(self.asset, self.manifest, REPO)

    def test_verify_rejects_boolean_numeric_manifest_equivalence(self):
        def bool_identity(index, info, data):
            if info.filename.endswith("/.zcode-plugin/plugin.json") or info.filename.endswith("/.claude-plugin/plugin.json"):
                value = json.loads(data)
                value["testIdentity"] = True if "/.zcode-plugin/" in info.filename else 1
                data = json.dumps(value).encode()
            return info, data
        self.rewrite_zip(bool_identity)
        with self.assertRaisesRegex(tool.ReleaseError, "plugin manifests disagree"):
            tool.verify(self.asset, self.manifest, REPO)

    def test_runtime_helper_drift_rejected_and_whitelist_matches_unpacker(self):
        spec = importlib.util.spec_from_file_location("release_unpack_contract_test", ROOT / "release_unpack.py")
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        self.assertEqual(set(tool.NAMES), set(helper.ALLOWED_FILES))
        (self.root / tool.PREFIX / "release_unpack.py").write_text("drift")
        with self.assertRaisesRegex(tool.ReleaseError, "runtime copy drift: release_unpack.py"):
            tool.build(self.root, REPO, self.base / "helper-drift")

    def test_verify_uses_trusted_helper_not_zip_code_and_cleans_temporary_output(self):
        marker = self.base / "untrusted-code-executed"
        malicious = f'from pathlib import Path\nPath({str(marker)!r}).write_text("executed")\n'.encode()
        self.rewrite_zip(lambda i, info, data: (info, malicious)
                         if info.filename == tool.PREFIX + "release_unpack.py"
                         else (info, data))
        original = tool.tempfile.TemporaryDirectory
        directories = []
        def owned_directory(*args, **kwargs):
            temporary = original(*args, **kwargs)
            directories.append(Path(temporary.name))
            return temporary
        with mock.patch.object(tool.tempfile, "TemporaryDirectory", side_effect=owned_directory):
            tool.verify(self.asset, self.manifest, REPO)
            self.rewrite_zip(lambda i, info, data: (info, b"not JSON")
                             if info.filename == tool.PREFIX + ".mcp.json" else (info, data))
            with self.assertRaises(tool.ReleaseError):
                tool.verify(self.asset, self.manifest, REPO)
        self.assertEqual(len(directories), 2)
        self.assertTrue(all(not directory.exists() for directory in directories))
        self.assertFalse(marker.exists())
        self.assertTrue(self.asset.exists())

    def test_oversize_limits_fail_closed(self):
        with mock.patch.object(tool, "MAX_ASSET", 10), self.assertRaisesRegex(tool.ReleaseError, "oversize"):
            tool.verify(self.asset, self.manifest, REPO)
        with mock.patch.object(tool, "MAX_MANIFEST", 10), self.assertRaisesRegex(tool.ReleaseError, "oversize"):
            tool.verify(self.asset, self.manifest, REPO)
        with mock.patch.object(tool, "MAX_TOTAL", 10), self.assertRaisesRegex(tool.ReleaseError, "oversize"):
            tool.verify(self.asset, self.manifest, REPO)

    def test_dry_run_reports_only_plan(self):
        plan = tool.publish(self.root, REPO, self.asset, self.manifest, notes_file=self.notes_file)
        self.assertTrue(plan["dryRun"])
        self.assertEqual(plan["repository"], REPO)
        self.assertEqual(plan["tag"], "v1.2.3")
        self.assertEqual(plan["notesFile"], str(self.notes_file))
        self.assertEqual(plan["notes"], self.notes)
        self.assertEqual(plan["commands"][0][-2:], ["--notes-file", str(self.notes_file)])
        self.assertNotIn("--notes", plan["commands"][0])
        self.assert_no_publish()

    def test_missing_notes_file_rejected_before_preflight(self):
        for path in (None, self.base / "missing.md"):
            with self.subTest(path=path), self.assertRaisesRegex(tool.ReleaseError, "--notes-file|regular source"):
                tool.publish(self.root, REPO, self.asset, self.manifest, True, REPO + "/v1.2.3",
                             notes_file=path)
        self.assertEqual(self.calls(), [])

    def test_empty_and_placeholder_notes_rejected(self):
        for notes in ("", " \t\r\n", "1.2.3", "v1.2.3\n", tool.PLUGIN,
                      tool.PLUGIN + " v1.2.3\n", tool.PLUGIN + " 1.2.3",
                      "# " + tool.PLUGIN + " v1.2.3\n", "## v1.2.3\n",
                      "zusage-marketplace v1.2.3", "Release v1.2.3"):
            with self.subTest(notes=notes):
                self.notes_file.write_text(notes, encoding="utf-8")
                with self.assertRaisesRegex(tool.ReleaseError, "empty or placeholder"):
                    tool.publish(self.root, REPO, self.asset, self.manifest, True, REPO + "/v1.2.3",
                                 notes_file=self.notes_file)
        self.assertEqual(self.calls(), [])

    def test_single_line_markdown_link_placeholders_rejected(self):
        labels = ("1.2.3", "v1.2.3", tool.PLUGIN, "zusage-marketplace",
                  tool.PLUGIN + " v1.2.3", "Release v1.2.3")
        cases = [wrapper.format(label) for label in labels for wrapper in (
            "[{}](https://example.invalid)",
            "## **[{}](https://example.invalid/releases(v1))**")]
        cases.extend(("[" + tool.PLUGIN + "](https://example.invalid) [v1.2.3](https://example.invalid)",
                      "[**v1.2.3**](https://example.invalid)",
                      "[zusage-marketplace](https://example.invalid \"Release notes\")"))
        for notes in cases:
            with self.subTest(notes=notes):
                self.notes_file.write_text(notes + "\n", encoding="utf-8")
                with self.assertRaisesRegex(tool.ReleaseError, "empty or placeholder"):
                    tool.publish(self.root, REPO, self.asset, self.manifest, True, REPO + "/v1.2.3",
                                 notes_file=self.notes_file)
        self.assertEqual(self.calls(), [])

    def test_substantive_notes_with_markdown_links_preserved(self):
        for notes in ("[修复发布校验](https://example.invalid)",
                      "[v1.2.3](https://example.invalid) 修复资产校验。",
                      "[v1.2.3](https://example.invalid)\n\n- 修复资产校验。\n"):
            with self.subTest(notes=notes):
                self.notes_file.write_bytes(notes.encode("utf-8"))  # 字节落盘：Windows 文本模式会把 \n 转 \r\n
                plan = tool.publish(self.root, REPO, self.asset, self.manifest, notes_file=self.notes_file)
                self.assertEqual(plan["notes"], notes)
        self.assert_no_publish()

    def test_deep_and_angle_url_link_placeholders_rejected_before_preflight(self):
        destinations = ("https://example.invalid/a(b(c(d(e))))",
                        "<https://example.invalid/a(b(c))>",
                        "<https://example.invalid/a(b(c>",
                        '<https://example.invalid/a(b(c))> "Release (notes"',
                        r"https://example.invalid/a\(b(c(d))\)")
        with mock.patch.object(tool, "preflight") as preflight:
            for label in ("v1.2.3", tool.PLUGIN, tool.PLUGIN + " v1.2.3"):
                for destination in destinations:
                    notes = f"[{label}]({destination})\n"
                    with self.subTest(notes=notes):
                        self.notes_file.write_text(notes, encoding="utf-8")
                        with self.assertRaisesRegex(tool.ReleaseError, "empty or placeholder"):
                            tool.publish(self.root, REPO, self.asset, self.manifest, notes_file=self.notes_file)
            preflight.assert_not_called()
        self.assertEqual(self.calls(), [])

    def test_deep_and_angle_url_substantive_notes_preserved(self):
        for notes in ("[修复发布校验](https://example.invalid/a(b(c(d))))",
                      "[修复发布校验](<https://example.invalid/a(b(c))>)",
                      "[v1.2.3](<https://example.invalid/a(b(c))>) 修复资产校验。",
                      "[v1.2.3](https://example.invalid/a(b(c))) (修复资产校验。)",
                      '[v1.2.3](<https://example.invalid/a(b(c))> "Release (notes")\n\n- 修复资产校验。\n'):
            with self.subTest(notes=notes):
                self.notes_file.write_bytes(notes.encode("utf-8"))  # 字节落盘：Windows 文本模式会把 \n 转 \r\n
                plan = tool.publish(self.root, REPO, self.asset, self.manifest, notes_file=self.notes_file)
                self.assertEqual(plan["notes"], notes)
        self.assert_no_publish()

    def test_unclosed_link_and_label_max_bound_complete_within_timeout(self):
        script = r'''
import importlib.util, sys
from pathlib import Path
from unittest import mock
spec = importlib.util.spec_from_file_location("bounded_notes_test", sys.argv[1])
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)
asset, manifest, notes_file = map(Path, sys.argv[2:])
seed = "[v1.2.3]("
notes = seed * (tool.MAX_MANIFEST // len(seed))
cases = (seed * 29100, notes + "x" * (tool.MAX_MANIFEST - len(notes)),
         "[" * tool.MAX_MANIFEST)
with mock.patch.object(tool, "preflight", return_value="0" * 40):
    for notes in cases:
        assert len(notes.encode("utf-8")) <= tool.MAX_MANIFEST
        notes_file.write_text(notes, encoding="utf-8")
        plan = tool.publish(asset.parent, "ByteRax/zcode-token-usage-statusbar", asset, manifest,
                            notes_file=notes_file)
        assert plan["dryRun"] and plan["notes"] == notes
print("bounded unclosed notes completed")
'''
        result = subprocess.run([sys.executable, "-B", "-c", script, str(ROOT / "release_tool.py"),
                                 str(self.asset), str(self.manifest), str(self.notes_file)],
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("bounded unclosed notes completed", result.stdout)
        self.assertEqual(self.calls(), [])

    def test_unclosed_suffix_preserved_without_unwrapping_later_links(self):
        suffix = "[broken](<unfinished [v1.2.3](https://example.invalid)"
        for prefix in ("", "[修复](https://example.invalid) "):
            notes = prefix + suffix
            with self.subTest(notes=notes):
                self.notes_file.write_text(notes, encoding="utf-8")
                with mock.patch.object(tool.re, "fullmatch", wraps=tool.re.fullmatch) as fullmatch, \
                        mock.patch.object(tool, "preflight", return_value="0" * 40):
                    plan = tool.publish(self.root, REPO, self.asset, self.manifest, notes_file=self.notes_file)
                self.assertEqual(fullmatch.call_args.args[1], ("修复 " if prefix else "") + suffix)
                self.assertEqual(plan["notes"], notes)
        self.assertEqual(self.calls(), [])

    def test_notes_require_bounded_regular_utf8_file(self):
        self.notes_file.write_bytes(b"\xff")
        with self.assertRaises(UnicodeDecodeError):
            tool.publish(self.root, REPO, self.asset, self.manifest, notes_file=self.notes_file)
        self.notes_file.write_bytes(b"x" * (tool.MAX_MANIFEST + 1))
        with self.assertRaisesRegex(tool.ReleaseError, "oversize"):
            tool.publish(self.root, REPO, self.asset, self.manifest, notes_file=self.notes_file)
        self.assertEqual(self.calls(), [])

    @unittest.skipUnless(symlink_support.can_create_symlinks(),
                         "os.symlink requires SeCreateSymbolicLinkPrivilege on Windows")
    def test_notes_must_be_regular_source_file(self):
        self.notes_file.unlink()
        self.notes_file.symlink_to(self.manifest)
        with self.assertRaisesRegex(tool.ReleaseError, "regular source"):
            tool.publish(self.root, REPO, self.asset, self.manifest, notes_file=self.notes_file)
        self.assertEqual(self.calls(), [])

    def test_publish_requires_both_explicit_approvals(self):
        for confirm in (None, "origin/v1.2.3", REPO + "/v1.2.4"):
            with self.subTest(confirm=confirm), self.assertRaisesRegex(tool.ReleaseError, "--confirm"):
                tool.publish(self.root, REPO, self.asset, self.manifest, True, confirm,
                             notes_file=self.notes_file)
        self.assert_no_publish()

    def test_dirty_and_untracked_relevant_git_never_publish(self):
        (self.root / "runtime_lock.py").write_text("dirty")
        with self.assertRaises(tool.ReleaseError):
            tool.publish(self.root, REPO, self.asset, self.manifest, True, REPO + "/v1.2.3",
                             notes_file=self.notes_file)
        self.git("checkout", "--", "runtime_lock.py")
        (self.root / tool.PREFIX / "local.py").write_text("untracked")
        with self.assertRaisesRegex(tool.ReleaseError, "dirty or untracked"):
            tool.publish(self.root, REPO, self.asset, self.manifest, notes_file=self.notes_file)
        self.assert_no_publish()

    def test_noauth_readonly_tag_mismatch_and_existing_draft_never_publish(self):
        for mode in ("noauth", "readonly", "badtag", "exists"):
            with self.subTest(mode=mode), mock.patch.dict(os.environ, {"STUB_MODE": mode}):
                with self.assertRaises(tool.ReleaseError):
                    tool.publish(self.root, REPO, self.asset, self.manifest, True, REPO + "/v1.2.3",
                             notes_file=self.notes_file)
        self.assert_no_publish()

    def test_explicit_remote_not_automatically_origin(self):
        self.git("remote", "remove", "writable")
        with self.assertRaisesRegex(tool.ReleaseError, "configured GitHub remote"):
            tool.publish(self.root, REPO, self.asset, self.manifest, notes_file=self.notes_file)
        self.assertEqual(self.calls(), [])

    def test_stub_publish_draft_upload_verify_then_publish(self):
        plan = tool.publish(self.root, REPO, self.asset, self.manifest, True, REPO + "/v1.2.3",
                             notes_file=self.notes_file)
        self.assertFalse(plan["dryRun"])
        calls = self.calls()
        write_positions = [i for i, c in enumerate(calls) if c[0] == "release"]
        self.assertEqual([calls[i][1] for i in write_positions], ["create", "upload", "edit"])
        self.assertIn("--draft", calls[write_positions[0]])
        self.assertIn("--verify-tag", calls[write_positions[0]])
        between = calls[write_positions[1] + 1:write_positions[2]]
        self.assertEqual(sum("/releases/assets/" in c[1] for c in between), 2)
        self.assertIn("--draft=false", calls[write_positions[2]])
        self.assertTrue(calls[-1][1].endswith("/releases/tags/v1.2.3"))
        self.assertFalse(any("--clobber" in c or "--force" in c for c in calls))

    def test_original_assets_replaced_after_preflight_upload_only_verified_snapshot(self):
        expected = {self.asset.name: self.asset.read_bytes(), self.manifest.name: self.manifest.read_bytes()}
        original_preflight = tool.preflight
        original_read = tool.read_file
        reads = []
        checked = []
        def tracked_read(path, *args):
            if path in (self.asset, self.manifest):
                reads.append(path)
            return original_read(path, *args)
        def replacing_preflight(root, repo, manifest, asset):
            head = original_preflight(root, repo, manifest, asset)
            checked.append(asset)
            self.rewrite_zip(lambda i, info, data: (info, b"unreviewed release content\n")
                             if info.filename == tool.PREFIX + "token_rate.py" else (info, data))
            return head
        with mock.patch.object(tool, "verify", wraps=tool.verify) as verify, \
                mock.patch.object(tool, "preflight", side_effect=replacing_preflight), \
                mock.patch.object(tool, "read_file", side_effect=tracked_read):
            plan = tool.publish(self.root, REPO, self.asset, self.manifest, True, REPO + "/v1.2.3",
                                notes_file=self.notes_file)
        self.assertFalse(plan["dryRun"])
        self.assertEqual(reads, [self.asset, self.manifest])
        upload = next(call for call in self.calls() if call[:2] == ["release", "upload"])
        snapshots = [Path(path) for path in upload[3:5]]
        self.assertEqual(verify.call_args.args[:2], tuple(snapshots))
        self.assertEqual(checked, snapshots[:1])
        self.assertEqual(snapshots[0].parent, snapshots[1].parent)
        create = next(call for call in self.calls() if call[:2] == ["release", "create"])
        notes_snapshot = Path(create[create.index("--notes-file") + 1])
        self.assertEqual(notes_snapshot, snapshots[0].parent / "release-notes.md")
        self.assertEqual([path.name for path in snapshots], [self.asset.name, self.manifest.name])
        self.assertNotEqual(snapshots[0], self.asset)
        self.assertNotEqual(snapshots[1], self.manifest)
        state = json.loads((self.base / "gh-state.json").read_text())
        self.assertFalse(state["draft"])
        for entry in state["assets"]:
            self.assertEqual(Path(state["paths"][str(entry["id"])]).read_bytes(), expected[entry["name"]])
        self.assertNotEqual(self.asset.read_bytes(), expected[self.asset.name])
        self.assertNotEqual(self.manifest.read_bytes(), expected[self.manifest.name])
        self.assertFalse(snapshots[0].parent.exists())

    def test_original_assets_deleted_after_upload_do_not_affect_download_verification(self):
        expected = {self.asset.name: self.asset.read_bytes(), self.manifest.name: self.manifest.read_bytes()}
        original_run = tool.run
        def deleting_run(root, *args):
            result = original_run(root, *args)
            if args[:3] == ("gh", "release", "upload"):
                self.asset.unlink()
                self.manifest.unlink()
            return result
        with mock.patch.object(tool, "run", side_effect=deleting_run):
            plan = tool.publish(self.root, REPO, self.asset, self.manifest, True, REPO + "/v1.2.3",
                                notes_file=self.notes_file)
        self.assertFalse(plan["dryRun"])
        state = json.loads((self.base / "gh-state.json").read_text())
        self.assertFalse(state["draft"])
        for entry in state["assets"]:
            self.assertEqual(Path(state["paths"][str(entry["id"])]).read_bytes(), expected[entry["name"]])

    def test_changed_notes_input_uses_reviewed_snapshot_and_reads_once(self):
        original_run = tool.run
        original_read = tool.read_file
        reads = []
        snapshots = []
        def tracked_read(path, *args):
            if path == self.notes_file:
                reads.append(path)
            return original_read(path, *args)
        def changing_run(root, *args):
            if args[:3] == ("git", "rev-parse", "--show-toplevel"):
                self.notes_file.write_text("Unreviewed changes", encoding="utf-8")
            if args[:3] == ("gh", "release", "create"):
                snapshot = Path(args[args.index("--notes-file") + 1])
                snapshots.append(snapshot)
                self.assertNotEqual(snapshot, self.notes_file)
                self.assertEqual(snapshot.read_bytes(), self.notes.encode("utf-8"))
            return original_run(root, *args)
        with mock.patch.object(tool, "read_file", side_effect=tracked_read), \
                mock.patch.object(tool, "run", side_effect=changing_run):
            plan = tool.publish(self.root, REPO, self.asset, self.manifest, True, REPO + "/v1.2.3",
                                notes_file=self.notes_file)
        self.assertEqual(len(reads), 1)
        self.assertEqual(len(snapshots), 1)
        self.assertFalse(snapshots[0].exists())
        self.assertEqual(plan["notes"], self.notes)
        self.assertEqual(json.loads((self.base / "gh-state.json").read_text())["body"], self.notes)

    def test_draft_body_mismatch_leaves_draft_and_never_rebuilds(self):
        for mode in ("baddraftbody", "missingdraftbody", "leadingbody", "linewhitespacebody"):
            with self.subTest(mode=mode), mock.patch.dict(os.environ, {"STUB_MODE": mode}):
                with self.assertRaisesRegex(tool.ReleaseError, "draft body disagrees"):
                    tool.publish(self.root, REPO, self.asset, self.manifest, True, REPO + "/v1.2.3",
                                 notes_file=self.notes_file)
                state = json.loads((self.base / "gh-state.json").read_text())
                self.assertTrue(state["draft"])
                self.assertEqual([c[1] for c in self.calls() if c[0] == "release"], ["create", "upload"])
                with self.assertRaisesRegex(tool.ReleaseError, "already exists"):
                    tool.publish(self.root, REPO, self.asset, self.manifest, True, REPO + "/v1.2.3",
                                 notes_file=self.notes_file)
                self.assertEqual([c[1] for c in self.calls() if c[0] == "release"], ["create", "upload"])
                (self.base / "gh-state.json").unlink()
                (self.base / "gh.log").unlink()

    def test_final_body_mismatch_fails_acceptance(self):
        for mode in ("badfinalbody", "missingfinalbody"):
            with self.subTest(mode=mode), mock.patch.dict(os.environ, {"STUB_MODE": mode}):
                with self.assertRaisesRegex(tool.ReleaseError, "published release body disagrees"):
                    tool.publish(self.root, REPO, self.asset, self.manifest, True, REPO + "/v1.2.3",
                                 notes_file=self.notes_file)
                self.assertEqual([c[1] for c in self.calls() if c[0] == "release"],
                                 ["create", "upload", "edit"])
                (self.base / "gh-state.json").unlink()
                (self.base / "gh.log").unlink()

    def test_draft_and_final_body_allow_only_crlf_and_trailing_whitespace(self):
        with mock.patch.dict(os.environ, {"STUB_MODE": "normalizedbody"}):
            plan = tool.publish(self.root, REPO, self.asset, self.manifest, True, REPO + "/v1.2.3",
                                notes_file=self.notes_file)
        self.assertFalse(plan["dryRun"])
        self.assertEqual(plan["notes"], self.notes)

    def test_failed_remote_asset_verification_leaves_draft(self):
        with mock.patch.dict(os.environ, {"STUB_MODE": "badhash"}):
            with self.assertRaisesRegex(tool.ReleaseError, "hash disagrees"):
                tool.publish(self.root, REPO, self.asset, self.manifest, True, REPO + "/v1.2.3",
                             notes_file=self.notes_file)
        self.assertEqual([c[1] for c in self.calls() if c[0] == "release"], ["create", "upload"])
        self.assertTrue(json.loads((self.base / "gh-state.json").read_text())["draft"])

    def test_malformed_manifest_objects_rejected(self):
        for value in ([], {"repository": REPO, "version": "1.2.3", "tag": "v1.2.3", "schemaVersion": 1,
                          "pluginId": tool.PLUGIN_ID, "asset": []}):
            self.manifest.write_text(json.dumps(value))
            with self.subTest(value=value), self.assertRaises(tool.ReleaseError):
                tool.verify(self.asset, self.manifest, REPO)

    def test_encrypted_zip_flag_rejected(self):
        data = bytearray(self.asset.read_bytes())
        local = data.index(b"PK\x03\x04")
        central = data.index(b"PK\x01\x02")
        for position in (local + 6, central + 8):
            flags = int.from_bytes(data[position:position + 2], "little") | 1
            data[position:position + 2] = flags.to_bytes(2, "little")
        self.asset.write_bytes(data)
        self.refresh_hash()
        with self.assertRaisesRegex(tool.ReleaseError, "encrypted"):
            tool.verify(self.asset, self.manifest, REPO)

    def test_missing_or_wrong_local_tag_never_publish(self):
        self.git("tag", "-d", "v1.2.3")
        with self.assertRaises(tool.ReleaseError):
            tool.publish(self.root, REPO, self.asset, self.manifest, notes_file=self.notes_file)
        self.assertEqual(self.calls(), [])

    def test_source_must_be_committed_at_head(self):
        path = self.root / tool.PREFIX / "token_rate.py"
        path.write_text("uncommitted source\n")
        built = tool.build(self.root, REPO, self.base / "dirty-out")
        with self.assertRaisesRegex(tool.ReleaseError, "dirty or untracked"):
            tool.publish(self.root, REPO, Path(built["zip"]), Path(built["manifest"]), True, REPO + "/v1.2.3",
                         notes_file=self.notes_file)
        self.assertEqual(self.calls(), [])

    def test_crlf_checkout_is_rejected_with_line_ending_hint(self):
        # Windows 旧检出（autocrlf）：git 视为干净、清洗后 OID 等于 HEAD，但发布包会装进
        # CRLF 字节，同一 tag 跨平台产物不同。须逐字节拦下并提示重新检出。
        self.git("config", "core.autocrlf", "true")
        self.git("rm", "--cached", "-r", "-q", ".")
        self.git("reset", "--quiet", "--hard")
        self.assertIn(b"\r\n", (self.root / tool.PREFIX / "token_rate.py").read_bytes())
        self.assertEqual(self.git("status", "--porcelain"), "")
        built = tool.build(self.root, REPO, self.base / "crlf-out")
        with self.assertRaisesRegex(tool.ReleaseError, "line endings differ from HEAD"):
            tool.publish(self.root, REPO, Path(built["zip"]), Path(built["manifest"]), True, REPO + "/v1.2.3",
                         notes_file=self.notes_file)
        self.assertEqual(self.calls(), [])

    def test_publish_postcondition_checked(self):
        with mock.patch.dict(os.environ, {"STUB_MODE": "badpublish"}):
            with self.assertRaisesRegex(tool.ReleaseError, "published release state"):
                tool.publish(self.root, REPO, self.asset, self.manifest, True, REPO + "/v1.2.3",
                             notes_file=self.notes_file)

    def test_cli_publish_requires_notes_file_even_for_dry_run(self):
        for mode in ([], ["--dry-run"], ["--publish", "--confirm", REPO + "/v1.2.3"]):
            stderr = __import__("io").StringIO()
            with self.subTest(mode=mode), contextlib.redirect_stderr(stderr):
                with self.assertRaises(SystemExit) as error:
                    tool.main(["publish", "--root", str(self.root), "--repo", REPO,
                               "--zip", str(self.asset), "--manifest", str(self.manifest), *mode])
            self.assertEqual(error.exception.code, 2)
            self.assertIn("--notes-file", stderr.getvalue())
        self.assertEqual(self.calls(), [])

    def test_cli_notes_file_and_complete_dry_run_body(self):
        for mode in ([], ["--dry-run"]):
            stdout = __import__("io").StringIO()
            with self.subTest(mode=mode), contextlib.redirect_stdout(stdout):
                code = tool.main(["publish", "--root", str(self.root), "--repo", REPO,
                                  "--zip", str(self.asset), "--manifest", str(self.manifest),
                                  "--notes-file", str(self.notes_file), *mode])
            self.assertEqual(code, 0)
            plan = json.loads(stdout.getvalue())
            self.assertTrue(plan["dryRun"])
            self.assertEqual(plan["notesFile"], str(self.notes_file))
            self.assertEqual(plan["notes"], self.notes)
            self.assertEqual(plan["commands"][0][-2:], ["--notes-file", str(self.notes_file)])
        self.assert_no_publish()

    def test_cli_publish_passes_notes_file_and_approvals(self):
        with contextlib.redirect_stdout(__import__("io").StringIO()):
            code = tool.main(["publish", "--root", str(self.root), "--repo", REPO,
                              "--zip", str(self.asset), "--manifest", str(self.manifest),
                              "--notes-file", str(self.notes_file), "--publish", "--confirm", REPO + "/v1.2.3"])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads((self.base / "gh-state.json").read_text())["body"], self.notes)

    def test_cli_build_and_verify_do_not_require_notes_file(self):
        for args in (["build", "--out", str(self.base / "cli-out")],
                     ["verify", "--zip", str(self.asset), "--manifest", str(self.manifest)]):
            with self.subTest(command=args[0]), contextlib.redirect_stdout(__import__("io").StringIO()):
                self.assertEqual(tool.main([*args, "--root", str(self.root), "--repo", REPO]), 0)
        self.assertEqual(self.calls(), [])

    def test_cli_failure_reports_nonzero_without_side_effect(self):
        with contextlib.redirect_stderr(__import__("io").StringIO()):
            code = tool.main(["publish", "--root", str(self.root), "--repo", REPO,
                              "--zip", str(self.asset), "--manifest", str(self.manifest),
                              "--notes-file", str(self.notes_file), "--publish"])
        self.assertEqual(code, 1)
        self.assertEqual(self.calls(), [])


if __name__ == "__main__":
    unittest.main()
