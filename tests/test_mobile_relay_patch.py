# -*- coding: utf-8 -*-
"""mobile_relay_patch：主 bundle stash 注入 + uplink 钩子包裹的登记/校验/往返与尾缀兼容。

锁定契约（specs/mobile-relay.md）：
- apply 注入两段：stash push（relayProtocol 锚点后）与 onRawTransportPayload zuUp
  分流包裹（箭头 => 后 splice，原调用字节不动）；remove 精确反向还原原字节；
- patch_install 注入尾缀（entry 末尾 dynamic import 行）两种形态（有/无）都兼容且透传；
- 登记版本按剥两段注入后的原始前缀 SHA256 校验，漂移拒绝；
- 表外版本走唯一锚点严格推导（两段各自），歧义拒绝；
- rewrite 只产出到新文件；ensure_deployed 就地原子替换且幂等。
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import mobile_relay_patch as mrp                     # noqa: E402
from helpers import py_test_support as pts           # noqa: E402

# 合成主 bundle：锚点唯一的桥接创建点 + transport options 的 raw 钩子（uplink 锚点）
# + 干扰项（同符号但非 disposeBridge 上下文）
SYNTHETIC_BODY = (
    b'function attach(){let re=new MessagePortProtocol(p),Ce=vy({bridgeSessionId:Q.bridgeSessionId,'
    b'sendFrame:s(je=>rr(h,je))});return Q.hostEntryId=ie.entryId,Q.relayProtocol=Ce,'
    b'Q.disposeBridge=()=>{Nr.dispose()},h.status="active"}'
    b'let s=(f,n)=>f;let ye={},wD=()=>{},Ni=()=>{};'
    b'function Fg(h,y){let D=h.currentBridge;return!D||D.degraded?!1:D.relayProtocol?.acceptPayload(y)??!1}'
    b'new X({onPayload:s(ve=>wD(ye,ve),"onPayload"),'
    b'onRawTransportPayload:s(ve=>Fg(ye,ve),"onRawTransportPayload")});'
    b'function other(){let Q=1,Ce=2;return Q+Ce;}'
)
TAIL = (b'\n;import("file:///E:/x/inject-main.cjs").then(() => null, (e) => '
        b'console.error("[zusage] load failed", e));\n')
PKG = {"name": "@zcode/desktop", "type": "module", "version": "9.9.9"}

UPLINK_ANCHOR = b'onRawTransportPayload:s(ve=>Fg(ye,ve),"onRawTransportPayload")'
LEGACY_HOOK = (b'onRawTransportPayload:s(ve=>(ve&&ve.zuUp?((globalThis.'
               b'__zusageRelayUplinkQueue=globalThis.__zusageRelayUplinkQueue||[]).push(ve),'
               b'true):0)||Fg(ye,ve),"onRawTransportPayload")')
# 旧 v2（无代际 marker）的完整持久钩子字节：当前已安装客户端的现状。
OLD_V2_HOOK = (b'onRawTransportPayload:s(ve=>(ve&&ve.zuUp?((__zuBridge)=>'
               b'((globalThis.__zusageRelayUplinkQueue=globalThis.__zusageRelayUplinkQueue||[]).push('
               b'{frame:ve,b:__zuBridge,relay:__zuBridge?__zuBridge.relayProtocol:void 0}),true))'
               b'(ye.currentBridge):0)||Fg(ye,ve),"onRawTransportPayload")')


def legacy_patch(data, stash=True):
    if stash:
        anchor = synthetic_target()["anchor"]
        split = b"relayProtocol=Ce,"
        data = data.replace(anchor, split + mrp.inject_for(anchor) + b"Q.disposeBridge")
    return data.replace(UPLINK_ANCHOR, LEGACY_HOOK)


def old_v2_patch(data, stash=True):
    if stash:
        anchor = synthetic_target()["anchor"]
        split = b"relayProtocol=Ce,"
        data = data.replace(anchor, split + mrp.inject_for(anchor) + b"Q.disposeBridge")
    return data.replace(UPLINK_ANCHOR, OLD_V2_HOOK)


def archive(path, body):
    return pts.make_asar(path, files={"out/main/index.js": body,
                                     "package.json": json.dumps(PKG).encode()})


def archive_body(path):
    import patch_install as asar
    with path.open("rb") as stream:
        header, base = asar.read_header(stream)
        return mrp._read(stream, dict(asar.iter_files(header)), base, mrp.ASSET)


def synthetic_target():
    return {"version": "9.9.9", "asset": mrp.ASSET,
            "sha256": mrp._digest(SYNTHETIC_BODY),
            "anchor": b"relayProtocol=Ce,Q.disposeBridge", "anchor2": UPLINK_ANCHOR}


class TransformTests(unittest.TestCase):
    def test_apply_inserts_stash_after_assignment(self):
        out = mrp.transform_module(SYNTHETIC_BODY, "apply", synthetic_target())
        # get-or-create 模式引用 stash 两次，push 元素唯一
        self.assertEqual(out.count(b"push({p:Ce.protocol,b:Q})"), 1)
        # 注入位于 relayProtocol=Ce 之后、Q.disposeBridge 之前
        self.assertLess(out.index(b"Q.relayProtocol=Ce,"), out.index(b"__zusageRelayStash"))
        self.assertLess(out.index(b"__zusageRelayStash"), out.index(b"Q.disposeBridge="))

    def test_apply_wraps_raw_hook_with_zuup_branch(self):
        out = mrp.transform_module(SYNTHETIC_BODY, "apply", synthetic_target())
        self.assertIn(b"{frame:ve,b:__zuBridge,relay:__zuBridge?__zuBridge.relayProtocol:void 0}", out)
        self.assertEqual(out.count(b"__zusageRelayUplinkQueue"), 2)
        self.assertIn(b"(ye.currentBridge):0)||Fg(ye,ve)", out)

    def test_apply_then_remove_round_trips_bytes(self):
        patched = mrp.transform_module(SYNTHETIC_BODY, "apply", synthetic_target())
        self.assertEqual(mrp.transform_module(patched, "remove", synthetic_target()), SYNTHETIC_BODY)

    def test_apply_is_idempotent_per_injection(self):
        full = mrp.transform_module(SYNTHETIC_BODY, "apply", synthetic_target())
        stash_only = full.replace(mrp.inject_for_uplink(UPLINK_ANCHOR), UPLINK_ANCHOR)
        uplink_only = full.replace(mrp.inject_for(synthetic_target()["anchor"]), b"")
        for partial in (stash_only, uplink_only, legacy_patch(SYNTHETIC_BODY),
                        legacy_patch(SYNTHETIC_BODY, stash=False)):
            with self.subTest(partial=partial):
                self.assertEqual(mrp.transform_module(partial, "apply", synthetic_target()), full)
                self.assertEqual(mrp.transform_module(partial, "remove", synthetic_target()), SYNTHETIC_BODY)

    def test_apply_is_idempotent(self):
        once = mrp.transform_module(SYNTHETIC_BODY, "apply", synthetic_target())
        self.assertEqual(mrp.transform_module(once, "apply", synthetic_target()), once)

    def test_marked_generation_is_set_before_first_frame(self):
        hook = mrp.inject_for_uplink(UPLINK_ANCHOR).decode()
        self.assertIn("globalThis.__zusageRelayUplinkGeneration=2", hook)
        script = r'''
const assert = require("node:assert/strict");
let calls = 0;
const s = (fn, tag) => { assert.equal(tag, "onRawTransportPayload"); return fn; };
const Fg = (runtime, frame) => { calls++; return "host-result"; };
const ye = {currentBridge: undefined};
const options = ({HOOK});
assert.equal(globalThis.__zusageRelayUplinkGeneration, 2);
assert.equal(calls, 0);
assert.equal(options.onRawTransportPayload({zuUp: 1}), true);
assert.equal(calls, 0);
assert.equal(options.onRawTransportPayload({plain: true}), "host-result");
assert.equal(calls, 1);
'''.replace("HOOK", hook)
        subprocess.run(["node", "-e", script], check=True, capture_output=True, text=True,
                       env=dict(os.environ))

    def test_old_v2_upgrades_to_marked_and_round_trips(self):
        full = mrp.transform_module(SYNTHETIC_BODY, "apply", synthetic_target())
        old = old_v2_patch(SYNTHETIC_BODY)
        self.assertNotIn(b"__zusageRelayUplinkGeneration", old)
        # 旧 v2 与完整新代等价地剥离/升级；apply 后与直接打新代逐字节一致
        self.assertEqual(mrp.transform_module(old, "apply", synthetic_target()), full)
        self.assertEqual(mrp.transform_module(old, "remove", synthetic_target()), SYNTHETIC_BODY)
        self.assertEqual(mrp.transform_module(full, "remove", synthetic_target()), SYNTHETIC_BODY)

    def test_unknown_generation_marker_rejected(self):
        full = mrp.transform_module(SYNTHETIC_BODY, "apply", synthetic_target())
        for bad in (full.replace(b"__zusageRelayUplinkGeneration=2",
                                 b"__zusageRelayUplinkGeneration=3"),
                    full.replace(b"(globalThis.__zusageRelayUplinkGeneration=2,",
                                 b"(globalThis.__zusageRelayUplinkGeneration=2,"
                                 b"globalThis.__zusageRelayUplinkGeneration=2,")):
            for operation in ("apply", "remove"):
                with self.subTest(operation=operation, bad=bad):
                    with self.assertRaises(mrp.RelayPatchError):
                        mrp.transform_module(bad, operation, synthetic_target())


    def test_remove_on_pristine_is_identity(self):
        self.assertEqual(mrp.transform_module(SYNTHETIC_BODY, "remove", synthetic_target()),
                         SYNTHETIC_BODY)

    def test_tail_preserved_both_directions(self):
        data = SYNTHETIC_BODY + TAIL
        patched = mrp.transform_module(data, "apply", synthetic_target())
        self.assertTrue(patched.endswith(TAIL))
        self.assertEqual(mrp.transform_module(patched, "remove", synthetic_target()), data)

    def test_stash_inserts_only_at_full_anchor(self):
        decoy = b'function decoy(){Q.relayProtocol=Ce,Q.other=1;}'
        body = decoy + SYNTHETIC_BODY
        patched = mrp.transform_module(body, "apply", synthetic_target())
        self.assertTrue(patched.startswith(decoy))
        self.assertEqual(mrp.transform_module(patched, "remove"), body)

    def test_runtime_behavior_and_reference_binding(self):
        hook = mrp.inject_for_uplink(UPLINK_ANCHOR).decode()
        script = r'''
const assert = require("node:assert/strict");
let calls = [], reads = 0;
const a = {relayProtocol: {id: "a"}}, b = {relayProtocol: {id: "b"}};
let active = a;
const ye = {get currentBridge() { reads++; return active; }};
const s = f => f;
const Fg = (runtime, frame) => { calls.push([runtime, frame]); return "host-result"; };
const hook = ({HOOK}).onRawTransportPayload;
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
'''.replace("HOOK", hook)
        subprocess.run(["node", "-e", script], check=True, capture_output=True, text=True,
                       env=dict(os.environ))

    def test_duplicate_mixed_or_unknown_injections_refused(self):
        full = mrp.transform_module(SYNTHETIC_BODY, "apply", synthetic_target())
        v2 = mrp.inject_for_uplink(UPLINK_ANCHOR)
        bad_cases = [full + full, full + LEGACY_HOOK, full + v2,
                     full.replace(b"relay:__zuBridge?", b"relay:__unknown?")]
        for bad in bad_cases:
            for operation in ("apply", "remove"):
                with self.subTest(operation=operation, bad=bad):
                    with self.assertRaises(mrp.RelayPatchError):
                        mrp.transform_module(bad, operation, synthetic_target())

    def test_missing_or_duplicate_anchor_refused(self):
        bad = synthetic_target()
        with self.assertRaises(mrp.RelayPatchError):
            mrp.transform_module(b"nothing here", "apply", bad)
        doubled = SYNTHETIC_BODY + SYNTHETIC_BODY
        with self.assertRaises(mrp.RelayPatchError):
            mrp.transform_module(doubled, "apply", bad)


class ResolveTests(unittest.TestCase):
    def test_pinned_sha_verified_on_tail_stripped_prefix(self):
        # 登记条目 sha 是剥尾缀后的原始前缀：带尾缀的资产也能通过校验
        with mock.patch.object(mrp, "MOBILE_RELAY_TARGETS", [synthetic_target()]):
            target = mrp._resolve_target(PKG, SYNTHETIC_BODY + TAIL)
        self.assertFalse(target["derived"])
        self.assertEqual(target["anchor"], b"relayProtocol=Ce,Q.disposeBridge")

    def test_pinned_hash_mismatch_refused(self):
        entry = synthetic_target()
        entry["sha256"] = "0" * 64
        with mock.patch.object(mrp, "MOBILE_RELAY_TARGETS", [entry]):
            with self.assertRaises(mrp.RelayPatchError):
                mrp._resolve_target(PKG, SYNTHETIC_BODY)

    def test_unknown_version_derives_unique_anchor(self):
        target = mrp._resolve_target(PKG, SYNTHETIC_BODY)   # 9.9.9 不在真实登记表
        self.assertTrue(target["derived"])
        self.assertEqual(target["anchor"], b"relayProtocol=Ce,Q.disposeBridge")
        self.assertEqual(target["anchor2"], UPLINK_ANCHOR)

    def test_derived_route_requires_verified_unique_shape(self):
        route = (b'function Fg(h,y){let D=h.currentBridge;return!D||D.degraded?!1:'
                 b'D.relayProtocol?.acceptPayload(y)??!1}')
        for body in (SYNTHETIC_BODY.replace(route, b'function Fg(h,y){return true}'),
                     SYNTHETIC_BODY + route):
            with self.subTest(body=body), self.assertRaises(mrp.RelayPatchError):
                mrp._resolve_target(PKG, body)

    def test_pinned_resolves_both_generations_and_rejects_drift(self):
        with mock.patch.object(mrp, "MOBILE_RELAY_TARGETS", [synthetic_target()]):
            new = mrp.transform_module(SYNTHETIC_BODY, "apply", synthetic_target())
            for body in (legacy_patch(SYNTHETIC_BODY), old_v2_patch(SYNTHETIC_BODY), new):
                self.assertFalse(mrp._resolve_target(PKG, body + TAIL)["derived"])
                with self.assertRaises(mrp.RelayPatchError):
                    mrp._resolve_target(PKG, body + b" ")

    def test_ambiguous_anchor_refused(self):
        # 两个同构赋值链 → 推导歧义，fail-closed 拒绝
        ambiguous = SYNTHETIC_BODY + SYNTHETIC_BODY
        with mock.patch.object(mrp, "MOBILE_RELAY_TARGETS", []):
            with self.assertRaises(mrp.RelayPatchError):
                mrp._resolve_target(PKG, ambiguous)


class RewriteTests(unittest.TestCase):
    def test_rewrite_produces_valid_patched_archive(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = pts.make_asar(Path(tmp) / "src.asar", files={
                "out/main/index.js": SYNTHETIC_BODY,
                "package.json": __import__("json").dumps(PKG).encode(),
            })
            out = Path(tmp) / "dst.asar"
            result = mrp.rewrite_asar(src, out, "apply")
            self.assertEqual(result["status"], "patched")
            self.assertTrue(out.exists())
            # 从产物中读回目标文件验证内容与结构
            import patch_install as asar
            with out.open("rb") as stream:
                header, base = asar.read_header(stream)
                nodes = dict(asar.iter_files(header))
                data = mrp._read(stream, nodes, base, "/out/main/index.js")
            self.assertIn(b"__zusageRelayStash", data)
            # remove 往返：二次重写回原始字节
            out2 = Path(tmp) / "dst2.asar"
            mrp.rewrite_asar(out, out2, "remove")
            with out2.open("rb") as stream:
                header, base = asar.read_header(stream)
                nodes = dict(asar.iter_files(header))
                data = mrp._read(stream, nodes, base, "/out/main/index.js")
            self.assertEqual(data, SYNTHETIC_BODY)

    def test_rewrite_refuses_existing_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = pts.make_asar(Path(tmp) / "src.asar", files={
                "out/main/index.js": SYNTHETIC_BODY,
                "package.json": __import__("json").dumps(PKG).encode(),
            })
            out = Path(tmp) / "dst.asar"
            out.write_bytes(b"x")
            with self.assertRaises(mrp.RelayPatchError):
                mrp.rewrite_asar(src, out, "apply")

    def test_rewrite_moves_later_offsets(self):
        # 目标文件之后还有第二个文件：offset 位移后必须仍可读取
        with tempfile.TemporaryDirectory() as tmp:
            src = pts.make_asar(Path(tmp) / "src.asar", files={
                "out/main/index.js": SYNTHETIC_BODY,
                "out/main/after.js": b"console.log('after');",
                "package.json": __import__("json").dumps(PKG).encode(),
            })
            out = Path(tmp) / "dst.asar"
            mrp.rewrite_asar(src, out, "apply")
            import patch_install as asar
            with out.open("rb") as stream:
                header, base = asar.read_header(stream)
                nodes = dict(asar.iter_files(header))
                self.assertEqual(mrp._read(stream, nodes, base, "/out/main/after.js"),
                                 b"console.log('after');")


class CliApplyTests(unittest.TestCase):
    def test_cli_conflicts_preserve_archive_and_pending_files(self):
        for conflict in ("tmp", "sidecar", "both"):
            with self.subTest(conflict=conflict), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                path = archive(root / "custom.asar", SYNTHETIC_BODY)
                pending = root / "app.asar.zusage.tmp"
                sidecar = root / "app.asar.zusage.tmp.json"
                if conflict in ("tmp", "both"):
                    pending.write_bytes(b"user pending bytes")
                if conflict in ("sidecar", "both"):
                    sidecar.write_bytes(b"invalid or publishing journal")
                before = {p: p.read_bytes() for p in (path, pending, sidecar) if p.exists()}
                env = {"PATH": os.environ.get("PATH", ""), "SYSTEMROOT": os.environ.get("SYSTEMROOT", ""),
                       "PYTHONDONTWRITEBYTECODE": "1", "HOME": str(root)}
                proc = subprocess.run([sys.executable, "-B", str(ROOT / "mobile_relay_patch.py"),
                                       "apply", "--asar", str(path)],
                                      capture_output=True, text=True, encoding="utf-8", env=env, check=True)
                self.assertEqual(json.loads(proc.stdout)["status"], "deferred")
                self.assertEqual({p: p.read_bytes() for p in before}, before)
                self.assertEqual(pending.exists(), conflict in ("tmp", "both"))
                self.assertEqual(sidecar.exists(), conflict in ("sidecar", "both"))
                self.assertEqual(list(root.glob(".mobile-relay-*")), [])

    def test_apply_checks_pending_while_holding_target_lock(self):
        import contextlib
        import runtime_lock
        with tempfile.TemporaryDirectory() as tmp:
            path = archive(Path(tmp) / "app.asar", SYNTHETIC_BODY)
            locked = []
            @contextlib.contextmanager
            def lock(lock_path):
                self.assertEqual(lock_path, path.with_name(path.name + ".zusage.lock"))
                locked.append(True)
                try:
                    yield
                finally:
                    locked.pop()
            original_lstat = Path.lstat
            def lstat(candidate, *args, **kwargs):
                if candidate.name in ("app.asar.zusage.tmp", "app.asar.zusage.tmp.json"):
                    self.assertTrue(locked)
                return original_lstat(candidate, *args, **kwargs)
            with mock.patch.object(runtime_lock, "file_lock", lock), mock.patch.object(Path, "lstat", lstat):
                self.assertEqual(mrp.main(["apply", "--asar", str(path)]), 0)
            self.assertEqual(mrp.check_deployed(path)["status"], "patched")

    def test_pending_appearing_at_lock_acquisition_blocks_apply(self):
        import contextlib
        import runtime_lock
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = archive(root / "app.asar", SYNTHETIC_BODY)
            original = path.read_bytes()
            pending = root / "app.asar.zusage.tmp"
            @contextlib.contextmanager
            def lock(_path):
                pending.write_bytes(b"created by previous lock owner")
                yield
            with mock.patch.object(runtime_lock, "file_lock", lock):
                self.assertEqual(mrp.apply_cli(path)["status"], "deferred")
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(pending.read_bytes(), b"created by previous lock owner")
            self.assertEqual(list(root.glob(".mobile-relay-*")), [])

    def test_apply_preserves_old_stage_and_cleans_only_own_failed_stage(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = archive(root / "app.asar", SYNTHETIC_BODY)
            original = path.read_bytes()
            old_stage = root / ".mobile-relay-user"
            old_stage.write_bytes(b"user data")
            os.utime(old_stage, (1, 1))
            with mock.patch.object(mrp.os, "replace", side_effect=PermissionError("locked")):
                self.assertEqual(mrp.apply_cli(path)["status"], "deferred")
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(old_stage.read_bytes(), b"user data")
            self.assertEqual(list(root.glob(".mobile-relay-*")), [old_stage])
            self.assertEqual(mrp.apply_cli(path)["status"], "patched")
            self.assertEqual(old_stage.read_bytes(), b"user data")


class EnsureDeployedTests(unittest.TestCase):
    def test_ensure_deployed_patches_in_place_and_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = pts.make_asar(Path(tmp) / "app.asar", files={
                "out/main/index.js": SYNTHETIC_BODY + TAIL,   # 已带 patch_install 尾缀
                "package.json": __import__("json").dumps(PKG).encode(),
            })
            first = mrp.ensure_deployed(src)
            self.assertEqual(first["status"], "patched")
            check = mrp.check_deployed(src)
            self.assertEqual(check["status"], "patched")
            self.assertTrue(check["derived"])   # 9.9.9 走推导
            second = mrp.ensure_deployed(src)
            self.assertEqual(second["status"], "present")
            removed = mrp.remove_deployed(src)
            self.assertEqual(removed["status"], "removed")
            # 还原后字节与原始一致（含尾缀）
            import patch_install as asar
            with src.open("rb") as stream:
                header, base = asar.read_header(stream)
                nodes = dict(asar.iter_files(header))
                self.assertEqual(mrp._read(stream, nodes, base, "/out/main/index.js"),
                                 SYNTHETIC_BODY + TAIL)

    def test_check_upgrade_and_remove_legacy_archive(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = archive(Path(tmp) / "app.asar", legacy_patch(SYNTHETIC_BODY) + TAIL)
            check = mrp.check_deployed(path)
            self.assertEqual((check["status"], check["stash"], check["uplink"],
                              check["uplink_generation"]), ("partial", True, True, 1))
            self.assertEqual(mrp.ensure_deployed(path)["status"], "patched")
            check = mrp.check_deployed(path)
            self.assertEqual((check["status"], check["uplink_generation"]), ("patched", 2))
            self.assertEqual(mrp.ensure_deployed(path)["status"], "present")
            self.assertEqual(mrp.remove_deployed(path)["status"], "removed")
            self.assertEqual(archive_body(path), SYNTHETIC_BODY + TAIL)
            self.assertEqual(mrp.remove_deployed(path)["status"], "absent")
            self.assertEqual(mrp.check_deployed(path)["status"], "absent")

    def test_remove_legacy_directly(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = archive(Path(tmp) / "legacy.asar", legacy_patch(SYNTHETIC_BODY) + TAIL)
            self.assertEqual(mrp.remove_deployed(path)["status"], "removed")
            self.assertEqual(archive_body(path), SYNTHETIC_BODY + TAIL)
            self.assertEqual(mrp.check_deployed(path)["status"], "absent")

    def test_check_partial_and_corrupt_generations(self):
        new = mrp.transform_module(SYNTHETIC_BODY, "apply", synthetic_target())
        stash_only = new.replace(mrp.inject_for_uplink(UPLINK_ANCHOR), UPLINK_ANCHOR)
        uplink_only = new.replace(mrp.inject_for(synthetic_target()["anchor"]), b"")
        with tempfile.TemporaryDirectory() as tmp:
            for i, (body, expected) in enumerate(((stash_only, None), (uplink_only, 2),
                                                   (legacy_patch(SYNTHETIC_BODY, False), 1))):
                path = archive(Path(tmp) / (str(i) + ".asar"), body)
                result = mrp.check_deployed(path)
                self.assertEqual((result["status"], result["uplink_generation"]),
                                 ("partial", expected))
                self.assertEqual(mrp.ensure_deployed(path)["status"], "patched")
                self.assertEqual(archive_body(path), new)
            bad = archive(Path(tmp) / "bad.asar", new + LEGACY_HOOK)
            self.assertEqual(mrp.check_deployed(bad)["status"], "error")
            self.assertEqual(mrp.ensure_deployed(bad)["status"], "skipped-error")
            self.assertEqual(mrp.remove_deployed(bad)["status"], "error")

    def test_check_marks_new_generation_and_removes_byte_exact(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = archive(Path(tmp) / "app.asar", SYNTHETIC_BODY + TAIL)
            self.assertEqual(mrp.ensure_deployed(path)["status"], "patched")
            body = archive_body(path)
            self.assertIn(mrp.inject_for_uplink(UPLINK_ANCHOR), body)
            self.assertIn(b"globalThis.__zusageRelayUplinkGeneration=2", body)
            check = mrp.check_deployed(path)
            self.assertEqual((check["status"], check["stash"], check["uplink"],
                              check["uplink_generation"], check["marked"]),
                             ("patched", True, True, 2, True))
            self.assertEqual(mrp.remove_deployed(path)["status"], "removed")
            self.assertEqual(archive_body(path), SYNTHETIC_BODY + TAIL)
            self.assertNotIn(b"__zusageRelayUplinkGeneration", archive_body(path))
            self.assertEqual(mrp.remove_deployed(path)["status"], "absent")

    def test_check_old_v2_then_upgrade_adds_marker(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = archive(Path(tmp) / "app.asar", old_v2_patch(SYNTHETIC_BODY) + TAIL)
            check = mrp.check_deployed(path)
            self.assertEqual((check["status"], check["uplink_generation"], check["marked"]),
                             ("patched", 2, False))
            self.assertEqual(mrp.ensure_deployed(path)["status"], "patched")
            check = mrp.check_deployed(path)
            self.assertEqual((check["status"], check["marked"]), ("patched", True))
            self.assertEqual(mrp.ensure_deployed(path)["status"], "present")
            self.assertEqual(mrp.remove_deployed(path)["status"], "removed")
            self.assertEqual(archive_body(path), SYNTHETIC_BODY + TAIL)

    def test_remove_failure_cleans_only_its_own_stage(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = archive(root / "app.asar",
                           mrp.transform_module(SYNTHETIC_BODY, "apply", synthetic_target()))
            original = path.read_bytes()
            old_stage = root / ".mobile-relay-user"
            old_stage.write_bytes(b"user data")
            os.utime(old_stage, (1, 1))
            with mock.patch.object(mrp.os, "replace", side_effect=PermissionError("locked")):
                result = mrp.remove_deployed(path)
            self.assertEqual(result["status"], "error")
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(old_stage.read_bytes(), b"user data")
            self.assertEqual(list(root.glob(".mobile-relay-*")), [old_stage])
            self.assertEqual(mrp.remove_deployed(path)["status"], "removed")
            self.assertEqual(archive_body(path), SYNTHETIC_BODY)

    def test_ensure_deployed_reports_error_without_raising(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / "nope.asar"
            result = mrp.ensure_deployed(missing)
            self.assertEqual(result["status"], "skipped-error")


if __name__ == "__main__":
    unittest.main()
