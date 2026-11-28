# -*- coding: utf-8 -*-
"""手机中继的入口字节往返、代际识别与统一归档 CLI。"""
import contextlib
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path, PurePosixPath
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import patch_install as pi  # noqa: E402
from tests.helpers.py_test_support import PLUGIN_ROOT, load_module, make_asar  # noqa: E402

STASH_ANCHOR = b"relayProtocol=Ce,Q.disposeBridge"
STASH_INJECT = (b"(globalThis.__zusageRelayStash=globalThis.__zusageRelayStash||[])"
                b".push({p:Ce.protocol,b:Q}),")
UPLINK_ANCHOR = b'onRawTransportPayload:s(ve=>Fg(ye,ve),"onRawTransportPayload")'
ROUTE = (b'function Fg(h,y){let D=h.currentBridge;return!D||D.degraded?!1:'
         b'D.relayProtocol?.acceptPayload(y)??!1}')
SYNTHETIC_BODY = (
    b'function attach(){let re=new MessagePortProtocol(p),Ce=vy({bridgeSessionId:Q.bridgeSessionId,'
    b'sendFrame:s(je=>rr(h,je))});return Q.hostEntryId=ie.entryId,Q.relayProtocol=Ce,'
    b'Q.disposeBridge=()=>{Nr.dispose()},h.status="active"}'
    b'let s=(f,n)=>f;let ye={},wD=()=>{},Ni=()=>{};'
    + ROUTE + b'new X({onPayload:s(ve=>wD(ye,ve),"onPayload"),' + UPLINK_ANCHOR + b'});'
    b'function other(){let Q=1,Ce=2;return Q+Ce;}'
)
OLD_LOADER_LINE = (b'\n;import("file:///E:/x/inject-main.cjs").then(() => null, (e) => '
                   b'console.error("[zusage] load failed", e));')
PKG = {"name": "@zcode/desktop", "type": "module", "version": "9.9.9"}
PINNED_PKG = dict(PKG, version="9.9.8")
HOST_TAIL = b"\n// unrelated host tail\n"
UNPATCHED = "not patched; install can add it"
UPGRADABLE = "can be upgraded or completed"
AFTER_ASSET = "/out/main/after.bin"
AFTER_BYTES = b"\x00after the entry\xff"

LEGACY_HOOK = (b'onRawTransportPayload:s(ve=>(ve&&ve.zuUp?((globalThis.'
               b'__zusageRelayUplinkQueue=globalThis.__zusageRelayUplinkQueue||[]).push(ve),'
               b'true):0)||Fg(ye,ve),"onRawTransportPayload")')
# 无代际 marker 的持久 v2 字节来自旧版格式。
OLD_V2_HOOK = (b'onRawTransportPayload:s(ve=>(ve&&ve.zuUp?((__zuBridge)=>'
               b'((globalThis.__zusageRelayUplinkQueue=globalThis.__zusageRelayUplinkQueue||[]).push('
               b'{frame:ve,b:__zuBridge,relay:__zuBridge?__zuBridge.relayProtocol:void 0}),true))'
               b'(ye.currentBridge):0)||Fg(ye,ve),"onRawTransportPayload")')
MARKED_HOOK = (b'onRawTransportPayload:(globalThis.__zusageRelayUplinkGeneration=2,'
               + OLD_V2_HOOK.split(b":", 1)[1] + b")")


def entry_with(*, stash=False, uplink=UPLINK_ANCHOR):
    body = SYNTHETIC_BODY
    if stash:
        body = body.replace(STASH_ANCHOR, b"relayProtocol=Ce," + STASH_INJECT + b"Q.disposeBridge", 1)
    return body.replace(UPLINK_ANCHOR, uplink, 1)


def marked_entry():
    return entry_with(stash=True, uplink=MARKED_HOOK)


def mobile_variants():
    return {
        "pristine": SYNTHETIC_BODY,
        "stash-only": entry_with(stash=True),
        "uplink-only": entry_with(uplink=MARKED_HOOK),
        "v1-uplink-only": entry_with(uplink=LEGACY_HOOK),
        "v1": entry_with(stash=True, uplink=LEGACY_HOOK),
        "old-v2": entry_with(stash=True, uplink=OLD_V2_HOOK),
        "marked-v2": marked_entry(),
    }


def read_asset(path, asset):
    with path.open("rb") as stream:
        header, base = pi.read_header(stream)
        node = dict(pi.iter_files(header))[asset]
        stream.seek(base + int(node["offset"]))
        return stream.read(node["size"])


def process_env():
    return {key: os.environ[key] for key in ("PATH", "SystemRoot") if key in os.environ}


class TransformTests(unittest.TestCase):
    def test_apply_splices_only_at_full_anchors(self):
        decoy = b'function decoy(){Q.relayProtocol=Ce,Q.other=1;}'
        self.assertEqual(pi.inject_for(STASH_ANCHOR), STASH_INJECT)
        before = decoy + SYNTHETIC_BODY
        patched = pi.transform_mobile_entry(before, "apply")
        self.assertEqual(patched, decoy + marked_entry())
        self.assertEqual(pi.transform_mobile_entry(patched, "remove"), before)

    def test_apply_and_remove_round_trip_known_generations_and_partial_entries(self):
        for name, body in mobile_variants().items():
            for tail in (b"", OLD_LOADER_LINE + b"\n"):
                with self.subTest(generation=name, has_loader_tail=bool(tail)):
                    self.assertEqual(pi.transform_mobile_entry(body + tail, "apply"),
                                     marked_entry() + tail)
                    self.assertEqual(pi.transform_mobile_entry(body + tail, "remove"),
                                     SYNTHETIC_BODY + tail)

    def test_missing_or_ambiguous_anchors_and_unverified_routes_are_rejected(self):
        new_stash_anchor = b"function otherAttach(){return A.relayProtocol=B,A.disposeBridge=()=>{}}"
        cases = {
            "missing stash anchor": SYNTHETIC_BODY.replace(STASH_ANCHOR, b"relayProtocol=Ce,Q.other"),
            "ambiguous stash anchor": SYNTHETIC_BODY + new_stash_anchor,
            "missing uplink anchor": SYNTHETIC_BODY.replace(UPLINK_ANCHOR, b"onRawTransportPayload:noop"),
            "ambiguous uplink anchor": SYNTHETIC_BODY + b"new X({" + UPLINK_ANCHOR + b"});",
            "unverified route": SYNTHETIC_BODY.replace(ROUTE, b"function Fg(h,y){return true}"),
            "ambiguous route": SYNTHETIC_BODY + ROUTE,
            "same shape but wrong routing function": SYNTHETIC_BODY.replace(b"function Fg(", b"function OtherFg("),
        }
        for name, body in cases.items():
            with self.subTest(case=name), self.assertRaises(pi.RelayPatchError):
                pi.transform_mobile_entry(body, "apply")

        # 已识别的注入也要在剥离后验证原路由。
        damaged = marked_entry().replace(ROUTE, b"function Fg(h,y){return true}")
        with self.assertRaises(pi.RelayPatchError):
            pi.transform_mobile_entry(damaged, "remove")

    def test_unpinned_apply_rejects_duplicate_replacement_bytes(self):
        # The extra text matches the replacement bytes without the bridge prefix.
        body = b"// " + STASH_ANCHOR + b"\n" + SYNTHETIC_BODY
        for kwargs in ({"package": PKG}, {"target": {"anchor": STASH_ANCHOR, "anchor2": UPLINK_ANCHOR}}):
            with self.subTest(**kwargs), self.assertRaisesRegex(pi.RelayPatchError, "Missing or duplicate relay anchor"):
                pi.transform_mobile_entry(body, "apply", **kwargs)

    def test_unknown_duplicate_or_mixed_injections_are_rejected(self):
        full = marked_entry()
        marker = b"globalThis.__zusageRelayUplinkGeneration=2,"
        cases = {
            "unknown generation": full.replace(marker, marker.replace(b"=2", b"=3")),
            "duplicate marker": full.replace(marker, marker * 2),
            "duplicate uplink": full + b"new X({" + pi.inject_for_uplink(UPLINK_ANCHOR) + b"});",
            "mixed generations": full + b"new X({" + LEGACY_HOOK + b"});",
            "unknown uplink shape": full.replace(b"relay:__zuBridge?", b"relay:__unknown?"),
            "detached stash": full.replace(STASH_INJECT, b"") + b"void (" + STASH_INJECT + b"0);",
        }
        for name, body in cases.items():
            self.assertNotEqual(body, full, name)
            for operation in ("apply", "remove"):
                with self.subTest(case=name, operation=operation), self.assertRaises(pi.RelayPatchError):
                    pi.transform_mobile_entry(body, operation)

    def run_hook(self, script):
        node = shutil.which("node")
        if not node:
            self.skipTest("本机 PATH 无 node，跳过注入钩子 JS 行为校验")
        hook = pi.inject_for_uplink(UPLINK_ANCHOR).decode("utf-8")
        proc = subprocess.run([node, "-e", script.replace("HOOK", hook)], capture_output=True,
                              text=True, encoding="utf-8", env=process_env(), timeout=20)
        self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_uplink_generation_and_reference_binding(self):
        self.run_hook(r'''
const assert = require("node:assert/strict");
let calls = [], reads = 0;
const a = {relayProtocol: {id: "a"}}, b = {relayProtocol: {id: "b"}};
let active = a;
const ye = {get currentBridge() { reads++; return active; }};
const s = (fn, tag) => { assert.equal(tag, "onRawTransportPayload"); return fn; };
const Fg = (runtime, frame) => { calls.push([runtime, frame]); return "host-result"; };
const hook = ({HOOK}).onRawTransportPayload;
assert.equal(globalThis.__zusageRelayUplinkGeneration, 2);
assert.equal(calls.length, 0);
const first = {zuUp: 2}, second = {zuUp: 1}, noBridge = {zuUp: true};
assert.equal(hook(first), true);
const oldRelay = a.relayProtocol;
a.relayProtocol = {id: "replacement"};
active = b;
assert.equal(hook(second), true);
active = undefined;
assert.equal(hook(noBridge), true);
const noRelay = {zuUp: 1};
active = {};
assert.equal(hook(noRelay), true);
const q = globalThis.__zusageRelayUplinkQueue;
assert.equal(q.length, 4);
assert.deepEqual(Object.keys(q[0]), ["frame", "b", "relay"]);
assert.equal(q[0].frame, first); assert.equal(q[0].b, a); assert.equal(q[0].relay, oldRelay);
assert.equal(q[1].frame, second); assert.equal(q[1].b, b); assert.equal(q[1].relay, b.relayProtocol);
assert.equal(q[2].frame, noBridge); assert.equal(q[2].b, undefined); assert.equal(q[2].relay, undefined);
assert.equal(q[3].frame, noRelay); assert.equal(q[3].b, active); assert.equal(q[3].relay, undefined);
assert.equal(reads, 4); assert.equal(calls.length, 0);
for (const v of [null, {}, {zuUp: 0}]) assert.equal(hook(v), "host-result");
assert.equal(calls.length, 3); assert.equal(calls[0][0], ye); assert.equal(calls[0][1], null);
assert.equal(q.length, 4); assert.equal(reads, 4);
''')


class ArchiveFixture(unittest.TestCase):
    package = PKG

    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="mobile relay ")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.home = self.root / "home"
        self.runtime = self.root / "runtime"
        self.archive_dir = self.root / "client" / "resources"
        for directory in (self.home, self.runtime, self.archive_dir):
            directory.mkdir(parents=True)
        (self.runtime / "inject-main.cjs").write_bytes(b"// fixture loader\n")
        (self.runtime / "config.json").write_bytes(b'{"lang":"en"}')

    def isolated_env(self):
        return dict(process_env(), HOME=str(self.home), USERPROFILE=str(self.home),
                    PYTHONIOENCODING="utf-8", PYTHONDONTWRITEBYTECODE="1", ZUSAGE_NO_MONITOR="1")

    def archive(self, name="app.asar", body=SYNTHETIC_BODY, *, extras=None):
        files = {pi.ASSET.lstrip("/"): body,
                 AFTER_ASSET.lstrip("/"): AFTER_BYTES,
                 "package.json": json.dumps(self.package).encode("utf-8")}
        files.update(extras or {})
        return make_asar(self.archive_dir / name, files=files)

    def snapshot(self):
        return {p.relative_to(self.root): p.read_bytes() for p in self.root.rglob("*") if p.is_file()}

    def with_loader(self, body):
        url = (self.runtime / "inject-main.cjs").as_uri()
        return body + pi.INJECT_LINE_TMPL.format(url=url).encode("utf-8")

    def assert_archive(self, path, body):
        self.assertEqual(pi.entry_bytes_of(path), body)
        self.assertEqual(read_asset(path, AFTER_ASSET), AFTER_BYTES)
        self.assertEqual(read_asset(path, "/package.json"), json.dumps(self.package).encode("utf-8"))

    def assert_no_pending(self):
        self.assertEqual(list(self.archive_dir.glob("app.asar.zusage.tmp*")), [])

    def assert_check(self, path, status, *, injected):
        before = self.snapshot()
        stdout = self.run_command(path, "check")
        self.assertIn("asar:", stdout)
        self.assertIn("Injection: " + ("injected" if injected else "not injected"), stdout.splitlines())
        self.assertIn(f"Mobile relay patch: {status}", stdout.splitlines())
        self.assertEqual(self.snapshot(), before)

    def assert_round_trip(self, path, *, initial_status, old_loader, host_tail=b""):
        self.assert_check(path, initial_status, injected=old_loader)
        self.run_command(path, "install")
        self.assert_archive(path, self.with_loader(marked_entry() + host_tail))
        self.assert_no_pending()
        self.assert_check(path, "patched", injected=True)
        before = path.read_bytes()
        self.run_command(path, "install")
        self.assertEqual(path.read_bytes(), before)
        self.run_command(path, "remove")
        self.assert_archive(path, SYNTHETIC_BODY + host_tail)
        self.assert_check(path, UNPATCHED, injected=False)
        self.assert_no_pending()


class PinnedArchiveTests(ArchiveFixture):
    package = PINNED_PKG

    def setUp(self):
        super().setUp()
        env = mock.patch.dict(os.environ, self.isolated_env(), clear=True)
        env.start()
        self.addCleanup(env.stop)
        # Only this independent installer instance gets the fixture table and process stub.
        self.installer = load_module("pinned_mobile_archive_installer", ROOT / "patch_install.py")
        self.installer.client_running = lambda: False

    def pin(self, original, *, anchor=STASH_ANCHOR, anchor2=UPLINK_ANCHOR):
        self.installer.MOBILE_RELAY_TARGETS = [{
            "version": self.package["version"], "asset": pi.ASSET,
            "sha256": hashlib.sha256(original).hexdigest(),
            "anchor": anchor, "anchor2": anchor2,
        }]

    def run_command(self, path, command, *, exit_code=0):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            result = self.installer.main([command, "--asar", str(path), "--runtime", str(self.runtime)])
        stdout = output.getvalue()
        if command == "check":
            self.assertIsNone(result, stdout)
        else:
            self.assertIs(result, exit_code == 0, stdout)
        return stdout

    def assert_loader_only(self, body, reason, *, has_mobile_markers, old_loader=False):
        path = self.archive(body=body + (OLD_LOADER_LINE if old_loader else b""))
        self.assert_check(path, f"unavailable ({reason})", injected=old_loader)
        install = self.run_command(path, "install")
        self.assertIn(f"Could not verify the remote control relay layout ({reason})", install)
        self.assert_archive(path, self.with_loader(body))
        self.assert_check(path, f"unavailable ({reason})", injected=True)
        if has_mobile_markers:
            before = path.read_bytes()
            remove = self.run_command(path, "remove", exit_code=1)
            self.assertIn(f"Cannot safely remove the mobile relay patch: {reason}", remove.splitlines())
            self.assertEqual(path.read_bytes(), before)
        else:
            self.run_command(path, "remove")
            self.assert_archive(path, body)
            self.assert_check(path, f"unavailable ({reason})", injected=False)
        self.assert_no_pending()

    def test_pinned_archive_round_trip_upgrades_known_and_partial_injections(self):
        self.pin(SYNTHETIC_BODY + HOST_TAIL)
        for generation, body in mobile_variants().items():
            initial = {"pristine": UNPATCHED, "marked-v2": "patched"}.get(generation, UPGRADABLE)
            for tail in (b"", OLD_LOADER_LINE):
                with self.subTest(generation=generation, old_loader=bool(tail)):
                    path = self.archive(body=body + HOST_TAIL + tail)
                    self.assert_round_trip(path, initial_status=initial, old_loader=bool(tail), host_tail=HOST_TAIL)

    def test_pinned_archive_removes_known_and_partial_injections_directly(self):
        self.pin(SYNTHETIC_BODY + HOST_TAIL)
        for generation, body in mobile_variants().items():
            if generation == "pristine":
                continue
            for tail in (b"", OLD_LOADER_LINE):
                with self.subTest(generation=generation, old_loader=bool(tail)):
                    path = self.archive(body=body + HOST_TAIL + tail)
                    self.run_command(path, "remove")
                    self.assert_archive(path, SYNTHETIC_BODY + HOST_TAIL)
                    self.assert_check(path, UNPATCHED, injected=False)
                    self.assert_no_pending()

    def test_pinned_archive_rejects_non_anchor_digest_drift(self):
        self.pin(SYNTHETIC_BODY + HOST_TAIL)
        reason = f"asset hash mismatch for pinned version {self.package['version']}"
        for generation, body in mobile_variants().items():
            with self.subTest(generation=generation):
                drifted = body.replace(b"function other()", b"function changedOther()", 1) + HOST_TAIL
                self.assertNotEqual(drifted, body + HOST_TAIL)
                has_mobile_markers = generation != "pristine"
                self.assert_loader_only(drifted, reason, has_mobile_markers=has_mobile_markers,
                                        old_loader=has_mobile_markers)

    def test_pinned_archive_rejects_unknown_generation_marker_with_matching_digest(self):
        body = SYNTHETIC_BODY + b"\nglobalThis.__zusageRelayUplinkGeneration=3;\n"
        self.pin(body)
        self.assert_loader_only(body, "Unknown or duplicate uplink generation marker", has_mobile_markers=True)

    def test_pinned_archive_rejects_anchor_uniqueness_failures_with_matching_digest(self):
        # The pin hashes exactly the restored original for each case, so the target
        # reaches the two anchor checks rather than being rejected by the SHA gate.
        cases = (
            ("missing-stash", b"", {"anchor": b"relayProtocol=Z,Q.disposeBridge"}, "Pinned anchor drift"),
            ("duplicate-stash", b"\nfunction decoy(){return Q.relayProtocol=Ce,Q.disposeBridge=()=>{}}\n",
             {}, "Pinned anchor drift"),
            ("missing-uplink", b"", {"anchor2": UPLINK_ANCHOR.replace(b"Fg", b"OtherFg")},
             "Pinned uplink anchor drift"),
            ("duplicate-uplink", b"\nnew X({" + UPLINK_ANCHOR + b"});\n", {}, "Pinned uplink anchor drift"),
        )
        for label, suffix, anchors, reason in cases:
            self.pin(SYNTHETIC_BODY + suffix, **anchors)
            for body in (SYNTHETIC_BODY, marked_entry()):
                has_mobile_markers = body != SYNTHETIC_BODY
                with self.subTest(anchor=label, has_mobile_markers=has_mobile_markers):
                    self.assert_loader_only(body + suffix, reason, has_mobile_markers=has_mobile_markers)


class ArchiveCliTests(ArchiveFixture):
    script_root = ROOT

    def run_command(self, path, command, *, exit_code=0):
        argv = [sys.executable, "-B", str(self.script_root / "patch_install.py"), command,
                "--asar", str(path), "--runtime", str(self.runtime)]
        proc = subprocess.run(argv, cwd=self.root, env=self.isolated_env(), stdin=subprocess.DEVNULL,
                              capture_output=True, text=True, encoding="utf-8", timeout=30)
        self.assertEqual(proc.returncode, exit_code, f"stdout={proc.stdout!r}\nstderr={proc.stderr!r}")
        return proc.stdout

    def test_root_cli_round_trip_on_unregistered_version(self):
        self.assertNotIn(self.package["version"], {target["version"] for target in pi.MOBILE_RELAY_TARGETS})
        for tail in (b"", OLD_LOADER_LINE):
            with self.subTest(old_loader=bool(tail)):
                path = self.archive("custom client.asar", body=SYNTHETIC_BODY + tail + HOST_TAIL)
                self.assert_round_trip(path, initial_status=UNPATCHED, old_loader=bool(tail), host_tail=HOST_TAIL)

    def test_plugin_cli_uses_same_commands_without_forwarding_script(self):
        self.assertFalse((PLUGIN_ROOT / "mobile_relay_patch.py").exists())
        self.script_root = PLUGIN_ROOT
        self.assert_round_trip(self.archive(), initial_status=UNPATCHED, old_loader=False)

    def test_check_reports_legacy_or_partial_patch_and_preserves_pending_pair(self):
        (self.archive_dir / "app.asar.zusage.tmp").write_bytes(b"existing pending file")
        (self.archive_dir / "app.asar.zusage.tmp.json").write_bytes(b"{}")
        (self.runtime / ".plugin-restart-required").write_bytes(b'{"state":"pending-install"}')
        for generation, entry in mobile_variants().items():
            if generation not in ("pristine", "marked-v2"):
                with self.subTest(generation=generation):
                    self.assert_check(self.archive(body=entry + OLD_LOADER_LINE), UPGRADABLE, injected=True)

    def test_check_rejects_invalid_archive_but_only_reports_unknown_mobile_layout(self):
        invalid = self.archive_dir / "invalid.asar"
        invalid.write_bytes(b"not an asar")
        before = self.snapshot()
        self.assertIn("failed to read asar", self.run_command(invalid, "check", exit_code=1))
        self.assertEqual(self.snapshot(), before)
        unknown = marked_entry().replace(b"__zusageRelayUplinkGeneration=2", b"__zusageRelayUplinkGeneration=3")
        path = self.archive(body=unknown + OLD_LOADER_LINE)
        self.assert_check(path, "unavailable (Unknown or duplicate uplink inject)", injected=True)
        self.run_command(path, "install")
        self.assert_archive(path, self.with_loader(unknown))
        before = path.read_bytes()
        self.run_command(path, "remove", exit_code=1)
        self.assertEqual(path.read_bytes(), before)

    def test_source_map_layout_does_not_allow_rewriting_existing_hooks(self):
        legacy = entry_with(stash=True, uplink=LEGACY_HOOK)
        asset = PurePosixPath(pi.ASSET.lstrip("/"))
        for label, body, extras in (
            ("directive", legacy + b"\n//# sourceMappingURL=index.js.map\n", {}),
            ("appended map", legacy, {f"{asset}.map": b"{}"}),
            ("suffix map", legacy, {str(asset.with_suffix(".map")): b"{}"}),
        ):
            with self.subTest(source_map=label):
                path = self.archive(body=body, extras=extras)
                self.assert_check(path, "unavailable (Unverified source map layout)", injected=False)
                self.run_command(path, "install")
                self.assert_archive(path, self.with_loader(body))
                before = path.read_bytes()
                self.run_command(path, "remove", exit_code=1)
                self.assertEqual(path.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
