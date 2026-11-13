"""Offline mobile-relay stash injection: pinned fingerprints for the desktop main bundle.

桌面主进程 app.asar 的 out/main/index.js 里，webRemoteControlManager 创建桥接协议后
（Q.relayProtocol=Ce 赋值链）没有任何对外暴露点；mobile-relay 需要拿到
relayProtocol.protocol（AcknowledgedRelayProtocol 的合法 send/onMessage 入口，
seq/ack 语义归宿主协议栈）才能把用量 chips 推上官方中继。本模块按
MOBILE_RELAY_TARGETS 指纹表在锚点后注入一段逗号表达式，把
{p: <relay>.protocol, b: <bridge>} push 进 globalThis.__zusageRelayStash：
mobile-relay.cjs（主进程热换模块）消费 stash 推送，宿主 bundle 其余字节不动。

第二注入（uplink，specs/mobile-relay.md「上行」）：把 transport options 的
onRawTransportPayload 箭头函数包一层——载荷带 zuUp 标记时推入
globalThis.__zusageRelayUplinkQueue 并返回 true（帧在 acceptPayload 严格 seq 校验
之前被消费，官方 ack/水位零接触），其余帧原样走官方路径。油猴上行的安全门是
mobile-relay 下行帧里的 zuUpCap 能力标记（无补丁宿主收不到 → 油猴零上行）。

机制镜像 renderer_bridge.py：剥 patch_install 注入尾缀后按原始前缀 SHA256 校验、
表外版本走严格推导、asar 单拼接重写（offset 位移 + integrity 重算）、
同目录 stage + os.replace 原子替换、replace-failed 移交待替换链。
与 renderer_bridge 的差异：目标是主 bundle（会被 patch_install 追加尾缀，须兼容
有/无尾缀两种形态）；补丁是锚点处中段注入（非尾缀桥块）；remove 反向剥离注入即可。
补丁的存在不产生任何数据流（stash/队列无人生产即闲置），运行时开关由
mobile-relay.cjs 读 config 的 mobile_relay.enabled 控制，本模块不读配置。
"""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import struct
import tempfile
import time

import patch_install as asar

WORKTREE = Path(__file__).resolve().parent
ASSET = "/out/main/index.js"
# 注入表达式（逗号表达式元素，求值后结果被丢弃）：stash 属宿主 bundle，本项目只 append。
STASH = "__zusageRelayStash"
# patch_install 的注入尾缀（entry 末尾 dynamic import 行）；剥掉后才是原始前缀。
_INJECT_TAIL_RE = re.compile(
    rb'\n;import\("[^"]*"\)\.then\(\(\) => null, \(e\) => console\.error\([^\n]*\);\s*$')
# 桥接创建点：bridge.relayProtocol=<sym>,bridge.disposeBridge=...（混淆名随版本轮换）
_ANCHOR_RE = re.compile(rb"\b(\w+)\.relayProtocol=(\w+),\1\.disposeBridge\b")
# 注入串自身即补丁标记（符号随锚点）；remove/检测按它定位，不依赖原始锚点连续存在
_INJECT_RE = re.compile(
    rb"\(globalThis\.__zusageRelayStash=globalThis\.__zusageRelayStash\|\|\[\]\)"
    rb"\.push\(\{p:(\w+)\.protocol,b:(\w+)\}\),")
# uplink 钩子原始锚点：onRawTransportPayload:s(ve=>Fg(ye,ve),"onRawTransportPayload")
# ——包装符号(s)/箭头参数(ve)/原调用(Fg)/运行时(ye)随版本轮换，稳定的是属性名与
# 字符串标签；body 必须恰为「单次调用」形态（3.18.1 实测），复杂化时 derive 拒绝。
_UPLINK_ANCHOR_RE = re.compile(
    rb'onRawTransportPayload:(\w+)\((\w+)=>(\w+)\((\w+),\2\),"onRawTransportPayload"\)')
# 注入的中段（箭头 => 之后、原调用之前）；remove 按它还原成 `param=>`
_UPLINK_MID_RE = re.compile(
    rb'\((\w+)&&\1\.zuUp\?\(\(globalThis\.'
    rb'__zusageRelayUplinkQueue=globalThis\.__zusageRelayUplinkQueue\|\|\[\]\)\.push\(\1\),'
    rb'true\):0\)\|\|')
# 指纹表（新→旧）：版本以 asar package.json 为准，SHA 是剥尾缀后的原始 bundle。
MOBILE_RELAY_TARGETS = [
    {
        "version": "3.18.1",
        "asset": ASSET,
        # 剥 patch_install 注入尾缀后的原始 bundle 指纹（以实测为准；尾缀差异
        # 不影响——校验永远发生在剥尾缀之后）
        "sha256": "9f414b7c9391de3a92d6373511df1374a6f270ae260ce802647ef0a05fe5cde8",
        "anchor": b"relayProtocol=Ce,Q.disposeBridge",
        "anchor2": b'onRawTransportPayload:s(ve=>Fg(ye,ve),"onRawTransportPayload")',
    },
]


class RelayPatchError(ValueError):
    pass


def _digest(data):
    return hashlib.sha256(data).hexdigest()


def _read(stream, nodes, base, path):
    node = nodes.get(path)
    if not node or "offset" not in node or node.get("unpacked") or "link" in node:
        raise RelayPatchError(f"Missing packed file: {path}")
    stream.seek(base + int(node["offset"]))
    data = stream.read(node["size"])
    if len(data) != node["size"]:
        raise RelayPatchError(f"Truncated file: {path}")
    return data


def inject_for(anchor):
    """锚点 → 注入表达式。锚点形如 relayProtocol=<r>,<b>.disposeBridge；
    注入串插在 `relayProtocol=<r>,` 之后，捕获 <r>.protocol 与 <b> 整体。
    两侧都必须显式 globalThis.：主 bundle 是 ESM（严格模式），对未声明标识符
    赋值会 ReferenceError 炸掉桥接创建点。"""
    m = re.fullmatch(rb"relayProtocol=(\w+),(\w+)\.disposeBridge", anchor)
    if not m:
        raise RelayPatchError("Malformed anchor")
    relay, bridge = m.group(1), m.group(2)
    g = b"globalThis." + STASH.encode()
    return b"(" + g + b"=" + g + b"||[]).push({p:" + relay + b".protocol,b:" + bridge + b"}),"


def inject_for_uplink(anchor2):
    """锚点2 → 包裹后的钩子表达式：在箭头 `=>` 之后插入 zuUp 分流中段，
    原调用与其余字节原样保留（splice，不重建）。带 zuUp 标记的载荷推入
    globalThis.__zusageRelayUplinkQueue 并返回 true（帧在 acceptPayload 严格校验
    之前被消费），其余走原钩子。"""
    m = _UPLINK_ANCHOR_RE.fullmatch(anchor2)
    if not m:
        raise RelayPatchError("Malformed uplink anchor")
    arrow = b"onRawTransportPayload:" + m.group(1) + b"(" + m.group(2) + b"=>"
    mid = (b"(" + m.group(2) + b"&&" + m.group(2) + b".zuUp?(("
           b"globalThis.__zusageRelayUplinkQueue=globalThis.__zusageRelayUplinkQueue||[]).push("
           + m.group(2) + b"),true):0)||")
    return arrow + mid + anchor2[len(arrow):]


def _strip_injects(prefix):
    """剥离两段注入，得到与原始 bundle 逐字节一致的 pristine 前缀。"""
    marks = _INJECT_RE.findall(prefix)
    if len(marks) > 1:
        raise RelayPatchError("Stash inject not unique")
    if marks:
        match = _INJECT_RE.search(prefix)
        prefix = prefix[:match.start()] + prefix[match.end():]
    umarks = _UPLINK_MID_RE.findall(prefix)
    if len(umarks) > 1:
        raise RelayPatchError("Uplink inject not unique")
    if umarks:
        prefix = _UPLINK_MID_RE.sub(b"", prefix, count=1)
    return prefix


def _derive_uplink_anchor(prefix):
    """表外版本的 uplink 锚点推导：全 bundle 唯一的 onRawTransportPayload 单调用形态。"""
    matches = _UPLINK_ANCHOR_RE.findall(prefix)
    if len(matches) != 1:
        raise RelayPatchError("Uplink anchor not derivable (missing or ambiguous)")
    wrapper, param, fn, runtime = matches[0]
    return (b"onRawTransportPayload:" + wrapper + b"(" + param + b"=>" + fn
            + b"(" + runtime + b"," + param + b'),"onRawTransportPayload")')


def _split_tail(data):
    """剥 patch_install 注入尾缀（有则剥，无则原样）。返回 (前缀, 尾缀)。"""
    m = _INJECT_TAIL_RE.search(data)
    if not m:
        return data, b""
    return data[:m.start()], data[m.start():]


def transform_module(data, operation, target=None):
    """apply：stash 注入 + uplink 钩子包裹（各自幂等，允许只差一段的中间态）；
    remove：反向剥离两段。尾缀（第三方注入行）透传。

    补丁检测以注入串自身为准（regex），remove 不依赖原始锚点在补丁后内容中
    仍然连续存在（注入恰好插在锚点中间）。"""
    if operation not in ("apply", "remove"):
        raise RelayPatchError("Unknown operation")
    prefix, tail = _split_tail(data)
    if operation == "remove":
        marks = _INJECT_RE.findall(prefix)
        if len(marks) > 1:
            raise RelayPatchError("Stash inject not unique")
        umarks = _UPLINK_MID_RE.findall(prefix)
        if len(umarks) > 1:
            raise RelayPatchError("Uplink inject not unique")
        if marks:
            match = _INJECT_RE.search(prefix)
            prefix = prefix[:match.start()] + prefix[match.end():]
        if umarks:
            prefix = _UPLINK_MID_RE.sub(b"", prefix, count=1)
        return prefix + tail
    # apply：两段各自幂等
    result = prefix
    if not _INJECT_RE.search(result):
        anchor = (target or {}).get("anchor")
        if anchor is None:
            anchor = _derive_anchor(result)
        if result.count(anchor) != 1:
            raise RelayPatchError("Missing or duplicate relay anchor")
        inject = inject_for(anchor)
        split = anchor.split(b",", 1)[0] + b","   # relayProtocol=<sym>,
        if split + anchor[len(split):] != anchor:
            # 防御：锚点逗号拆分假设被破坏时立即拒绝，不产出错位注入
            raise RelayPatchError("Anchor split invariant broken")
        result = result.replace(split, split + inject, 1)
    if not _UPLINK_MID_RE.search(result):
        anchor2 = (target or {}).get("anchor2")
        if anchor2 is None:
            anchor2 = _derive_uplink_anchor(result)
        if result.count(anchor2) != 1:
            raise RelayPatchError("Missing or duplicate uplink anchor")
        result = result.replace(anchor2, inject_for_uplink(anchor2), 1)
    return result + tail


def _derive_anchor(prefix):
    """表外版本的严格推导：全 bundle 唯一的 bridge.relayProtocol 赋值锚点。"""
    matches = _ANCHOR_RE.findall(prefix)
    if len(matches) != 1:
        raise RelayPatchError("Relay anchor not derivable (missing or ambiguous)")
    bridge, relay = matches[0]   # 捕获组1=桥接宿主对象（Q），组2=relay 协议实例（Ce）
    return b"relayProtocol=" + relay + b"," + bridge + b".disposeBridge"


def _resolve_target(package, data):
    """指纹表优先；表外版本推导锚点。已打补丁的资产先剥离两段注入得到原始前缀
    再做 SHA/锚点校验（注入恰好插在锚点中间，未剥离时锚点不连续）。"""
    version = package.get("version")
    prefix, _tail = _split_tail(data)
    pristine = _strip_injects(prefix)
    target = next((t for t in MOBILE_RELAY_TARGETS if t["version"] == version), None)
    if target is not None:
        if _digest(pristine) != target["sha256"]:
            raise RelayPatchError(f"asset hash mismatch for pinned version {version}")
        if pristine.count(target["anchor"]) != 1:
            raise RelayPatchError("Pinned anchor drift")
        if pristine.count(target.get("anchor2", b"\x00")) != 1:
            raise RelayPatchError("Pinned uplink anchor drift")
        return dict(target, derived=False)
    anchor = _derive_anchor(pristine)
    anchor2 = _derive_uplink_anchor(pristine)
    return {"version": version, "asset": ASSET, "anchor": anchor,
            "anchor2": anchor2, "derived": True}


def _rewrite_to(stream, base, nodes, header, asset_path, original, modified, dest):
    """单拼接重写：目标区间替换、后方 offset 位移、integrity 重算。"""
    new_header = copy.deepcopy(header)
    new_nodes = dict(asar.iter_files(new_header))
    asset_node = nodes[asset_path]
    start, end = int(asset_node["offset"]), int(asset_node["offset"]) + asset_node["size"]
    delta = len(modified) - len(original)
    payload_size = stream.seek(0, os.SEEK_END) - base
    for path, node in nodes.items():
        if node.get("unpacked") or "link" in node or "files" in node:
            continue
        offset, size = int(node["offset"]), node["size"]
        if offset < 0 or size < 0 or offset + size > payload_size:
            raise RelayPatchError("Invalid packed file bounds")
        if path != asset_path and size and offset < end and offset + size > start:
            raise RelayPatchError("Overlapping packed files")
        if offset >= end and path != asset_path:
            new_nodes[path]["offset"] = str(offset + delta)
    new_nodes[asset_path]["size"] = len(modified)
    new_nodes[asset_path]["integrity"] = asar.compute_integrity(modified)
    encoded = json.dumps(new_header, ensure_ascii=False, separators=(",", ":")).encode()
    padded = (len(encoded) + 7) // 4 * 4
    dest.write(struct.pack("<4I", 4, padded + 4, padded, len(encoded)))
    dest.write(encoded)
    dest.write(b"\0" * (padded - len(encoded) - 4))
    stream.seek(base)
    remaining = start
    while remaining:
        chunk = stream.read(min(asar.BLOCK, remaining))
        if not chunk:
            raise RelayPatchError("Truncated payload")
        dest.write(chunk)
        remaining -= len(chunk)
    dest.write(modified)
    stream.seek(base + end)
    shutil.copyfileobj(stream, dest, asar.BLOCK)


def _load(source):
    """打开 asar 并完成目标解析；返回重写所需全部上下文。"""
    stream = source.open("rb")
    try:
        header, base = asar.read_header(stream)
        nodes = dict(asar.iter_files(header))
        package = json.loads(_read(stream, nodes, base, "/package.json"))
        if (package.get("name"), package.get("type")) != ("@zcode/desktop", "module"):
            raise RelayPatchError("Unknown host package")
        original = _read(stream, nodes, base, ASSET)
        target = _resolve_target(package, original)
        if b"sourceMappingURL" in original or any(
                path in nodes for path in (ASSET + ".map", ASSET[:-3] + ".map")):
            raise RelayPatchError("Unverified source map layout")
        return stream, base, nodes, header, package, original, target
    except Exception:
        stream.close()
        raise


def rewrite_asar(source, output, operation="apply"):
    """CLI/测试用：产出新 asar 文件，绝不就地改（输出必须在临时目录/工作区）。"""
    source, output = Path(source), Path(output)
    if output.exists():
        raise RelayPatchError("Output already exists")
    before = asar.source_fingerprint(source)
    stream, base, nodes, header, _package, original, target = _load(source)
    stage = None
    try:
        modified = transform_module(original, operation, target)
        fd, name = tempfile.mkstemp(prefix=".mobile-relay-", dir=str(output.parent))
        stage = Path(name)
        with os.fdopen(fd, "wb") as dest:
            _rewrite_to(stream, base, nodes, header, ASSET, original, modified, dest)
            dest.flush()
            os.fsync(dest.fileno())
        if asar.source_fingerprint(source) != before:
            raise RelayPatchError("Source archive changed")
        os.chmod(stage, stat.S_IMODE(source.stat().st_mode))
        os.link(stage, output)
        return {"status": "patched" if operation == "apply" else "removed",
                "version": target.get("version"), "detail": "ok", "output": str(output)}
    finally:
        if stage is not None:
            stage.unlink(missing_ok=True)
        stream.close()


_STALE_SECONDS = 600


def _sweep_stale_stages(directory):
    now = time.time()
    for stale in Path(directory).glob(".mobile-relay-*"):
        try:
            if now - stale.stat().st_mtime > _STALE_SECONDS:
                stale.unlink()
        except OSError:
            pass


def ensure_deployed(asar_path):
    """安装/更新链专用：确认目标 asar 带 stash 注入，没有则就地补打。

    与 renderer_bridge.ensure_deployed 同款约定：patch_install 同一把
    app.asar.zusage.lock 跨进程锁、同目录 stage + os.replace 原子替换、
    任何失败只报告不抛出（本注入是 mobile-relay 的增强，绝不影响安装主流程）。
    replace-failed 时移交 stage 给待替换链（调用方转存或删除）。
    """
    stage = None
    stream = None
    try:
        from runtime_lock import file_lock
        asar_path = Path(asar_path)
        with file_lock(asar_path.with_name(asar_path.name + ".zusage.lock")):
            _sweep_stale_stages(asar_path.parent)
            before = asar.source_fingerprint(asar_path)
            stream, base, nodes, header, package, original, target = _load(asar_path)
            version = package.get("version")
            modified = transform_module(original, "apply", target)
            stream.close()   # Windows：replace 前必须释放源句柄
            stream = None
            if modified == original:
                return {"status": "present", "version": version, "detail": "stash already deployed"}
            fd, name = tempfile.mkstemp(prefix=".mobile-relay-", dir=str(asar_path.parent))
            stage = Path(name)
            with os.fdopen(fd, "wb") as dest, asar_path.open("rb") as rstream:
                _rewrite_to(rstream, base, nodes, header, ASSET, original, modified, dest)
                dest.flush()
                os.fsync(dest.fileno())
            if asar.source_fingerprint(asar_path) != before:
                raise RelayPatchError("Source archive changed")
            os.chmod(stage, stat.S_IMODE(asar_path.stat().st_mode))
            try:
                os.replace(stage, asar_path)
            except OSError as error:
                handover = {"status": "replace-failed", "version": version,
                            "detail": str(error), "stage": str(stage), "source": before}
                stage = None   # 已移交，finally 不得清理
                return handover
            stage = None
        return {"status": "patched", "version": target.get("version"),
                "detail": "derived stash deployed" if target.get("derived") else "stash deployed"}
    except PermissionError as error:
        return {"status": "skipped-error", "version": None, "detail": str(error), "permission": True}
    except Exception as error:  # 旁路增强：任何异常都只报告
        return {"status": "skipped-error", "version": None, "detail": str(error)}
    finally:
        if stream is not None:
            stream.close()


def check_deployed(asar_path):
    """只读自检：patched（两段齐）/partial（缺一段，apply 可补）/absent/error。"""
    try:
        asar_path = Path(asar_path)
        stream, _base, _nodes, _header, package, original, target = _load(asar_path)
        stream.close()
        prefix, _tail = _split_tail(original)
        stash_present = bool(_INJECT_RE.search(prefix))
        uplink_present = bool(_UPLINK_MID_RE.search(prefix))
        if stash_present and uplink_present:
            status = "patched"
        elif stash_present or uplink_present:
            status = "partial"
        else:
            status = "absent"
        return {"status": status, "stash": stash_present, "uplink": uplink_present,
                "version": package.get("version"),
                "derived": bool(target.get("derived")), "detail": "ok"}
    except Exception as error:
        return {"status": "error", "version": None, "detail": str(error)}


def remove_deployed(asar_path):
    """卸载链对称清理：只剥离本项目的 stash 注入，其余字节（含第三方尾缀）不动。"""
    stage = None
    stream = None
    try:
        from runtime_lock import file_lock
        asar_path = Path(asar_path)
        with file_lock(asar_path.with_name(asar_path.name + ".zusage.lock")):
            before = asar.source_fingerprint(asar_path)
            stream, base, nodes, header, _package, original, target = _load(asar_path)
            modified = transform_module(original, "remove", target)
            stream.close()   # Windows：replace 前必须释放源句柄
            stream = None
            if modified == original:
                return {"status": "absent", "version": target.get("version"), "detail": "nothing to remove"}
            fd, name = tempfile.mkstemp(prefix=".mobile-relay-", dir=str(asar_path.parent))
            stage = Path(name)
            with os.fdopen(fd, "wb") as dest, asar_path.open("rb") as rstream:
                _rewrite_to(rstream, base, nodes, header, ASSET, original, modified, dest)
                dest.flush()
                os.fsync(dest.fileno())
            if asar.source_fingerprint(asar_path) != before:
                raise RelayPatchError("Source archive changed")
            os.chmod(stage, stat.S_IMODE(asar_path.stat().st_mode))
            os.replace(stage, asar_path)
            stage = None
        return {"status": "removed", "version": target.get("version"), "detail": "ok"}
    except Exception as error:
        return {"status": "error", "version": None, "detail": str(error)}
    finally:
        if stream is not None:
            stream.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("command", choices=("check", "apply", "remove", "rewrite"))
    parser.add_argument("--asar", required=True)
    parser.add_argument("--output", help="rewrite 命令的目标路径（须不存在）")
    args = parser.parse_args(argv)
    if args.command == "check":
        print(json.dumps(check_deployed(args.asar), ensure_ascii=False))
        return 0
    if args.command == "rewrite":
        if not args.output:
            parser.error("rewrite requires --output")
        print(json.dumps(rewrite_asar(args.asar, args.output,
                                      "apply"), ensure_ascii=False))
        return 0
    fn = ensure_deployed if args.command == "apply" else remove_deployed
    print(json.dumps(fn(args.asar), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
