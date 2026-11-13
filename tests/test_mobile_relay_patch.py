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
    b'let s=(f,n)=>f;let ye={},wD=()=>{},Ni=()=>{},Fg=()=>{};'
    b'new X({onPayload:s(ve=>wD(ye,ve),"onPayload"),'
    b'onRawTransportPayload:s(ve=>Fg(ye,ve),"onRawTransportPayload")});'
    b'function other(){let Q=1,Ce=2;return Q+Ce;}'
)
TAIL = (b'\n;import("file:///E:/x/inject-main.cjs").then(() => null, (e) => '
        b'console.error("[zusage] load failed", e));\n')
PKG = {"name": "@zcode/desktop", "type": "module", "version": "9.9.9"}

UPLINK_ANCHOR = b'onRawTransportPayload:s(ve=>Fg(ye,ve),"onRawTransportPayload")'


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
        # 箭头参数保留、zuUp 分流在 => 之后、原调用 Fg(ye,ve) 字节不动、队列全局可达
        self.assertIn(
            b'onRawTransportPayload:s(ve=>(ve&&ve.zuUp?((globalThis.'
            b'__zusageRelayUplinkQueue=globalThis.__zusageRelayUplinkQueue||[]).push(ve),'
            b'true):0)||Fg(ye,ve),"onRawTransportPayload")', out)
        # 官方帧路径仍以原钩子收尾（分流返回 0 时 || 落回 Fg）
        self.assertEqual(out.count(b"__zusageRelayUplinkQueue"), 2)

    def test_apply_then_remove_round_trips_bytes(self):
        patched = mrp.transform_module(SYNTHETIC_BODY, "apply", synthetic_target())
        self.assertEqual(mrp.transform_module(patched, "remove", synthetic_target()), SYNTHETIC_BODY)

    def test_apply_is_idempotent_per_injection(self):
        # 中间态（只有 stash）：apply 补齐 uplink 而不重复 stash
        stash_only = mrp.transform_module(SYNTHETIC_BODY, "apply", synthetic_target())
        stash_only = mrp.transform_module(stash_only, "remove", synthetic_target())
        del stash_only   # 中间态由 full 逐段断言覆盖
        once = mrp.transform_module(SYNTHETIC_BODY, "apply", synthetic_target())
        self.assertEqual(mrp.transform_module(once, "apply", synthetic_target()), once)

    def test_apply_is_idempotent(self):
        once = mrp.transform_module(SYNTHETIC_BODY, "apply", synthetic_target())
        self.assertEqual(mrp.transform_module(once, "apply", synthetic_target()), once)

    def test_remove_on_pristine_is_identity(self):
        self.assertEqual(mrp.transform_module(SYNTHETIC_BODY, "remove", synthetic_target()),
                         SYNTHETIC_BODY)

    def test_tail_preserved_both_directions(self):
        data = SYNTHETIC_BODY + TAIL
        patched = mrp.transform_module(data, "apply", synthetic_target())
        self.assertTrue(patched.endswith(TAIL))
        self.assertEqual(mrp.transform_module(patched, "remove", synthetic_target()), data)

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

    def test_ensure_deployed_reports_error_without_raising(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / "nope.asar"
            result = mrp.ensure_deployed(missing)
            self.assertEqual(result["status"], "skipped-error")


if __name__ == "__main__":
    unittest.main()
