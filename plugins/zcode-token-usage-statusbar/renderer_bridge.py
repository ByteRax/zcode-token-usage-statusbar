"""Offline, version-pinned renderer bridge. Never installs or loads the renderer."""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import tempfile

import patch_install as asar

WORKTREE = Path("/Users/smzdm/Projects/AI/zcode-token-usage-statusbar")
MARKER = b"/* zusage-existing-conversation-store:v1"
# 多版本指纹表（新→旧）：客户端官方升级会整体换渲染器资产与混淆名，这里按
# (版本, 资产路径, 原始 sha256, 混淆名三元组) 逐版本钉死；未登记版本一律拒绝
# （fail-closed），升级本表后才允许补丁——绝不对没验证过的 bundle 做字节手术。
HOST_TARGETS = [
    {"version": "3.16.1", "asset": "/out/renderer/assets/styles-CqgV6nRf.js",
     "sha256": "6054041f771950896c1d80bd8c32b241dde9ab414b3eb66d038ca2c578332783",
     "names": {"key": "Ode", "topic": "hee", "registry": "pf"}},
    {"version": "3.15.3", "asset": "/out/renderer/assets/styles-CSpM3qgc.js",
     "sha256": "e3e0496d9ba2432ca995b8fce908333c861e3ad1c3641b5751dbe06441c53ecf",
     "names": {"key": "BYe", "topic": "Nse", "registry": "oE"}},
]
NEWEST = HOST_TARGETS[0]
ASSET, HOST_VERSION, ASSET_SHA256 = NEWEST["asset"], NEWEST["version"], NEWEST["sha256"]
# 桥代码模板：标识符占位符按目标版本的混淆名实例化（__ZU_*__ 不与 JS 语法冲突）。
BRIDGE_TEMPLATE = rb'''
/* zusage-existing-conversation-store:v1 begin */
export function getExistingConversationStore(scope) {
  const fields = ["sessionId", "workspacePath", "workspaceIdentity", "remoteSessionId"];
  if (!scope || typeof scope !== "object" || Array.isArray(scope))
    throw new TypeError("Invalid conversation scope");
  const descriptors = Object.getOwnPropertyDescriptors(scope);
  if (Reflect.ownKeys(descriptors).some(key => !fields.includes(key)))
    throw new TypeError("Unknown conversation scope field");
  const checked = Object.create(null);
  for (const key of fields) {
    const d = descriptors[key];
    if (!d) continue;
    if (!("value" in d) || typeof d.value !== "string" ||
        !d.value.trim() || /[\x00-\x1f\x7f]/.test(d.value))
      throw new TypeError("Invalid conversation scope field");
    if ((key === "sessionId" || key === "remoteSessionId") && /\s/.test(d.value))
      throw new TypeError("Invalid conversation identifier");
    if (key === "remoteSessionId" && d.value === "__base__")
      throw new TypeError("Reserved remote identifier");
    checked[key] = d.value;
  }
  if (!checked.sessionId || !checked.workspacePath)
    throw new TypeError("Missing conversation scope field");
  const key = __ZU_KEY_FN__(checked), topic = __ZU_TOPIC_FN__(checked.sessionId);
  const entry = __ZU_REGISTRY__.get(key), layer = entry?.layer;
  const session = layer?.entries.get(topic), store = session?.store;
  const current = () => !!store && __ZU_REGISTRY__.get(key) === entry && !entry.stale &&
    !layer.disposed && layer.entries.get(topic) === session &&
    session.store === store && !store.closed;
  if (!current()) return null;
  // Only consumer reads allocate copies. Never freeze a host-owned object.
  const snapshot = (value, seen = new WeakMap()) => {
    if (value === null || typeof value !== "object") {
      if (typeof value === "function" || typeof value === "symbol")
        throw new TypeError("Unsupported snapshot value");
      return value;
    }
    if (seen.has(value)) return seen.get(value);
    const proto = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && proto !== Object.prototype && proto !== null)
      throw new TypeError("Unsupported snapshot object");
    const result = Array.isArray(value) ? [] : Object.create(null);
    seen.set(value, result);
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === "length") continue;
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (!("value" in d)) throw new TypeError("Unsupported snapshot accessor");
      Object.defineProperty(result, key, {
        value: snapshot(d.value, seen), enumerable: d.enumerable,
        writable: false, configurable: false
      });
    }
    if (Array.isArray(value)) result.length = value.length;
    return Object.freeze(result);
  };
  let stopped = false;
  const cancellations = new Set();
  const off = () => {
    if (stopped) return;
    stopped = true;
    for (const cancel of [...cancellations]) cancel();
  };
  const active = () => {
    if (stopped) return false;
    if (current()) return true;
    off();
    return false;
  };
  return Object.freeze({
    getState: () => active() ? snapshot(store.getState()) : null,
    subscribe: callback => {
      if (typeof callback !== "function") throw new TypeError("Invalid callback");
      if (!active()) return () => {};
      let cancelled = false;
      const cancel = () => {
        if (cancelled) return;
        cancelled = true;
        cancellations.delete(cancel);
        try { unsubscribe(); } catch (_) {}
      };
      const unsubscribe = store.subscribe(() => {
        if (cancelled || !active()) return;
        try {
          const result = callback();
          if (result && typeof result.then === "function")
            Promise.resolve(result).catch(() => {});
        } catch (_) {}
      });
      cancellations.add(cancel);
      return cancel;
    },
    off
  });
}
if (typeof globalThis === "object" && globalThis !== null) {
  globalThis.__zusageGetExistingConversationStore = getExistingConversationStore;
  // Read-only acceptance diagnostics: enumerate live registry keys/topics for verification.
  globalThis.__zusageConversationDiagnostics = function () {
    const keys = [], sessions = [];
    for (const [key, entry] of __ZU_REGISTRY__) {
      keys.push(key);
      const layer = entry && entry.layer;
      if (!layer || layer.disposed || entry.stale) continue;
      for (const [topic, session] of layer.entries) {
        const store = session && session.store;
        const state = store && !store.closed && store.getState();
        sessions.push({ key, topic, status: state ? (state.status || "unknown") : "unavailable",
          seq: state && state.snapshot ? state.snapshot.seq : null });
      }
    }
    return { keys, sessions };
  };
}
/* zusage-existing-conversation-store:v1 end */
'''

def bridge_code(target):
    names = target["names"]
    return (BRIDGE_TEMPLATE
            .replace(b"__ZU_KEY_FN__", names["key"].encode())
            .replace(b"__ZU_TOPIC_FN__", names["topic"].encode())
            .replace(b"__ZU_REGISTRY__", names["registry"].encode()))

# 最新目标的桥正文（CLI 默认 / 测试兼容别名）
BRIDGE = bridge_code(NEWEST)


def target_for_module(data):
    """按资产内容定位目标：已打补丁的模块按桥正文反查，干净模块按 sha 反查。"""
    if MARKER in data:
        for target in HOST_TARGETS:
            if data.count(bridge_code(target)) == 1:
                return target
        return None
    digest = _digest(data)
    for target in HOST_TARGETS:
        if digest == target["sha256"]:
            return target
    return None


class BridgeError(ValueError):
    pass


def _digest(data):
    return hashlib.sha256(data).hexdigest()


def _read(stream, nodes, base, path):
    node = nodes.get(path)
    if not node or "offset" not in node or node.get("unpacked") or "link" in node:
        raise BridgeError(f"Missing packed file: {path}")
    stream.seek(base + int(node["offset"]))
    data = stream.read(node["size"])
    if len(data) != node["size"]:
        raise BridgeError(f"Truncated file: {path}")
    if "integrity" in node:
        integrity = node["integrity"]
        block = integrity.get("blockSize")
        if (integrity.get("algorithm") != "SHA256" or type(block) is not int or block <= 0 or
                integrity.get("hash") != _digest(data) or
                integrity.get("blocks") != [_digest(data[i:i + block])
                                           for i in range(0, len(data), block)]):
            raise BridgeError(f"Invalid integrity: {path}")
    return data


def transform_module(data, operation):
    """Remove only the exact bridge after an exact known original prefix.

    A third-party suffix is retained on removal, but never admitted for patching.
    目标版本按模块内容自动定位（桥正文反查 / sha 反查），未知内容 fail-closed。
    """
    if operation not in ("patch", "remove"):
        raise BridgeError("Unknown operation")
    target = target_for_module(data)
    if target is None:
        raise BridgeError("Unknown renderer asset hash")
    bridge = bridge_code(target)
    if MARKER in data:
        if data.count(MARKER) != 2 or data.count(bridge) != 1:
            raise BridgeError("Bridge marker/content tampered")
        prefix, suffix = data.split(bridge)
        if _digest(prefix) != target["sha256"]:
            raise BridgeError("Unknown or tampered original module")
        if operation == "remove":
            return prefix + suffix
        if suffix:
            raise BridgeError("Unknown patched module suffix")
        return data  # Exact repeat is idempotent.
    if b"getExistingConversationStore" in data:
        raise BridgeError("Export name collision")
    return data + bridge if operation == "patch" else data


def _resolve_target_from(package):
    """按 package.json dict 选目标；版本未登记即拒绝（fail-closed）。"""
    version = package.get("version")
    for target in HOST_TARGETS:
        if version == target["version"]:
            return target
    raise BridgeError(f"Unknown host version: {version}")


def _resolve_target(stream, nodes, base):
    """读 asar 的 package.json，按已登记版本选目标；版本未登记即拒绝。"""
    package = json.loads(_read(stream, nodes, base, "/package.json"))
    version = package.get("version")
    for target in HOST_TARGETS:
        if version == target["version"]:
            return target
    raise BridgeError(f"Unknown host version: {version}")


def _output_path(source, output):
    if Path(output).is_symlink():
        raise BridgeError("Output is a symlink")
    source, output = Path(source).resolve(), Path(output).resolve()
    roots = (WORKTREE.resolve(), Path(tempfile.gettempdir()).resolve())
    if source == output or not any(output.is_relative_to(root) for root in roots):
        raise BridgeError("Output must be a new worktree/temporary file, never an installation")
    # Even a copied application in the authorized roots is not an output target.
    if any(part.endswith(".app") for part in output.parts) or output.parent.name.lower() == "resources":
        raise BridgeError("Refusing application installation directory")
    if output.exists() or Path(output).is_symlink():
        raise BridgeError("Output already exists")
    if not output.parent.is_dir():
        raise BridgeError("Output directory does not exist")
    return source, output


def rewrite_asar(source, output, operation="patch"):
    """Copy the payload with one splice; preserve links, unpacked metadata and holes."""
    source, output = _output_path(source, output)
    before = asar.source_fingerprint(source)
    stage = None
    try:
        with source.open("rb") as stream:
            header, base = asar.read_header(stream)
            nodes = dict(asar.iter_files(header))
            package = json.loads(_read(stream, nodes, base, "/package.json"))
            if (package.get("name"), package.get("type")) != ("@zcode/desktop", "module"):
                raise BridgeError("Unknown host package")
            target = _resolve_target_from(package)
            asset_path = target["asset"]
            original = _read(stream, nodes, base, asset_path)
            if (b"sourceMappingURL" in original or any(
                    path in nodes for path in (asset_path + ".map", asset_path[:-3] + ".map"))):
                raise BridgeError("Unverified source map layout")
            modified = transform_module(original, operation)
            new_header = copy.deepcopy(header)
            new_nodes = dict(asar.iter_files(new_header))
            asset_node = nodes[asset_path]
            start, end = int(asset_node["offset"]), int(asset_node["offset"]) + asset_node["size"]
            payload_size = before["size"] - base
            delta = len(modified) - len(original)
            for path, node in nodes.items():
                if node.get("unpacked") or "link" in node or "files" in node:
                    continue
                offset, size = int(node["offset"]), node["size"]
                if offset < 0 or size < 0 or offset + size > payload_size:
                    raise BridgeError("Invalid packed file bounds")
                if path != asset_path and size and offset < end and offset + size > start:
                    raise BridgeError("Overlapping packed files")
                if offset >= end and path != asset_path:
                    new_nodes[path]["offset"] = str(offset + delta)
            new_nodes[asset_path]["size"] = len(modified)
            new_nodes[asset_path]["integrity"] = asar.compute_integrity(modified)
            encoded = json.dumps(new_header, ensure_ascii=False, separators=(",", ":")).encode()
            padded = (len(encoded) + 7) // 4 * 4
            fd, name = tempfile.mkstemp(prefix=".renderer-bridge-", dir=output.parent)
            stage = Path(name)
            with os.fdopen(fd, "wb") as dest:
                dest.write(struct.pack("<4I", 4, padded + 4, padded, len(encoded)))
                dest.write(encoded)
                dest.write(b"\0" * (padded - len(encoded) - 4))
                stream.seek(base)
                remaining = start
                while remaining:
                    chunk = stream.read(min(asar.BLOCK, remaining))
                    if not chunk:
                        raise BridgeError("Truncated payload")
                    dest.write(chunk)
                    remaining -= len(chunk)
                dest.write(modified)
                stream.seek(base + end)
                shutil.copyfileobj(stream, dest, asar.BLOCK)
                dest.flush()
                os.fsync(dest.fileno())
        if asar.source_fingerprint(source) != before:
            raise BridgeError("Source archive changed")
        # Exclusive publication: never overwrite an existing path, including races.
        os.link(stage, output)
        return output
    finally:
        if stage is not None:
            stage.unlink(missing_ok=True)


def ensure_deployed(asar_path):
    """插件安装/更新链专用：确认目标 asar 带桥，没有则就地补打。

    与 rewrite_asar（CLI/测试，只输出到工作区/临时目录）不同，本函数就是为写
    安装目录设计的：借用 patch_install 同一把 app.asar.zusage.lock 跨进程锁，
    输出临时文件在 asar 同目录后 os.replace 原子换。任何失败都不抛出——桥只是
    实时统计的增强，绝不影响安装/更新主流程。返回状态 dict：
      {"status": "patched"|"present"|"skipped-unknown"|"skipped-error",
       "version": <客户端版本>, "detail": <说明>}
    """
    try:
        from runtime_lock import file_lock
        asar_path = Path(asar_path)
        with asar_path.open("rb") as stream:
            header, base = asar.read_header(stream)
            nodes = dict(asar.iter_files(header))
            package = json.loads(_read(stream, nodes, base, "/package.json"))
        version = package.get("version")
        target = next((item for item in HOST_TARGETS if item["version"] == version), None)
        if target is None:
            return {"status": "skipped-unknown", "version": version,
                    "detail": "host version not pinned; add it to HOST_TARGETS first"}
        asset_path = target["asset"]
        with asar_path.open("rb") as stream:
            original = _read(stream, nodes, base, asset_path)
        if MARKER in original:
            # 已带桥：内容校验交给 transform_module（remove 幂等语义同样成立）
            transform_module(original, "remove")
            return {"status": "present", "version": target["version"], "detail": "bridge already deployed"}
        if _digest(original) != target["sha256"]:
            return {"status": "skipped-unknown", "version": target["version"],
                    "detail": "asset hash mismatch for pinned version (host build drift)"}
        if b"getExistingConversationStore" in original:
            return {"status": "skipped-error", "version": target["version"],
                    "detail": "export name collision in pristine module"}
        with file_lock(asar_path.with_name(asar_path.name + ".zusage.lock")):
            fd, name = tempfile.mkstemp(prefix=".zusage-bridge-", dir=str(asar_path.parent))
            stage = Path(name)
            try:
                with os.fdopen(fd, "wb") as dest, asar_path.open("rb") as stream:
                    _rewrite_to(stream, base, nodes, header, asset_path, original,
                                transform_module(original, "patch"), dest)
                    dest.flush()
                    os.fsync(dest.fileno())
                os.replace(stage, asar_path)
                stage = None
            finally:
                if stage is not None:
                    stage.unlink(missing_ok=True)
        return {"status": "patched", "version": target["version"], "detail": "bridge deployed"}
    except Exception as error:  # 安装链的旁路增强：任何异常都只报告
        return {"status": "skipped-error", "version": None, "detail": str(error)}


def remove_deployed(asar_path):
    """卸载链对称清理：只剥离本项目的桥（按指纹表逐版本识别），其余内容不动。
    与 ensure_deployed 同样的锁/原子替换/不抛出约定，状态 dict 同构。"""
    try:
        from runtime_lock import file_lock
        asar_path = Path(asar_path)
        with asar_path.open("rb") as stream:
            header, base = asar.read_header(stream)
            nodes = dict(asar.iter_files(header))
            package = json.loads(_read(stream, nodes, base, "/package.json"))
        version = package.get("version")
        target = next((item for item in HOST_TARGETS if item["version"] == version), None)
        if target is None:
            return {"status": "skipped-unknown", "version": version,
                    "detail": "host version not pinned; nothing to remove"}
        asset_path = target["asset"]
        with asar_path.open("rb") as stream:
            original = _read(stream, nodes, base, asset_path)
        if MARKER not in original:
            return {"status": "absent", "version": target["version"], "detail": "no bridge present"}
        restored = transform_module(original, "remove")
        with file_lock(asar_path.with_name(asar_path.name + ".zusage.lock")):
            fd, name = tempfile.mkstemp(prefix=".zusage-bridge-", dir=str(asar_path.parent))
            stage = Path(name)
            try:
                with os.fdopen(fd, "wb") as dest, asar_path.open("rb") as stream:
                    _rewrite_to(stream, base, nodes, header, asset_path, original, restored, dest)
                    dest.flush()
                    os.fsync(dest.fileno())
                os.replace(stage, asar_path)
                stage = None
            finally:
                if stage is not None:
                    stage.unlink(missing_ok=True)
        return {"status": "removed", "version": target["version"], "detail": "bridge removed"}
    except Exception as error:
        return {"status": "skipped-error", "version": None, "detail": str(error)}


def _rewrite_to(stream, base, nodes, header, asset_path, original, modified, dest):
    """把单拼接结果写入 dest（调用方负责锁与原子发布）。"""
    before = {"size": None}
    new_header = copy.deepcopy(header)
    new_nodes = dict(asar.iter_files(new_header))
    asset_node = nodes[asset_path]
    start, end = int(asset_node["offset"]), int(asset_node["offset"]) + asset_node["size"]
    delta = len(modified) - len(original)
    for path, node in nodes.items():
        if node.get("unpacked") or "link" in node or "files" in node:
            continue
        offset, size = int(node["offset"]), node["size"]
        if path != asset_path and offset >= end:
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
            raise BridgeError("Truncated payload")
        dest.write(chunk)
        remaining -= len(chunk)
    dest.write(modified)
    stream.seek(base + end)
    shutil.copyfileobj(stream, dest, asar.BLOCK)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("patch", "remove"))
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    try:
        print(rewrite_asar(args.source, args.output, args.operation))
    except (BridgeError, OSError, KeyError, AssertionError, struct.error) as error:
        parser.exit(1, f"renderer bridge refused: {error}\n")


if __name__ == "__main__":
    main()
