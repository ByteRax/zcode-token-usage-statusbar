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

ASSET = "/out/renderer/assets/styles-CSpM3qgc.js"
HOST_VERSION = "3.15.3"
ASSET_SHA256 = "e3e0496d9ba2432ca995b8fce908333c861e3ad1c3641b5751dbe06441c53ecf"
WORKTREE = Path("/Users/smzdm/Projects/AI/zcode-token-usage-statusbar/.worktrees/event-driven-stats")
MARKER = b"/* zusage-existing-conversation-store:v1"
# Appended without rewriting any original byte or existing export.
BRIDGE = rb'''
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
  const key = BYe(checked), topic = Nse(checked.sessionId);
  const entry = oE.get(key), layer = entry?.layer;
  const session = layer?.entries.get(topic), store = session?.store;
  const current = () => !!store && oE.get(key) === entry && !entry.stale &&
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
    for (const [key, entry] of oE) {
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
    """
    if operation not in ("patch", "remove"):
        raise BridgeError("Unknown operation")
    if MARKER in data:
        if data.count(MARKER) != 2 or data.count(BRIDGE) != 1:
            raise BridgeError("Bridge marker/content tampered")
        prefix, suffix = data.split(BRIDGE)
        if _digest(prefix) != ASSET_SHA256:
            raise BridgeError("Unknown or tampered original module")
        if operation == "remove":
            return prefix + suffix
        if suffix:
            raise BridgeError("Unknown patched module suffix")
        return data  # Exact repeat is idempotent.
    if _digest(data) != ASSET_SHA256:
        raise BridgeError("Unknown renderer asset hash")
    if b"getExistingConversationStore" in data:
        raise BridgeError("Export name collision")
    return data + BRIDGE if operation == "patch" else data


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
            if (package.get("name"), package.get("version"), package.get("type")) != (
                    "@zcode/desktop", HOST_VERSION, "module"):
                raise BridgeError("Unknown host package/version")
            original = _read(stream, nodes, base, ASSET)
            if (b"sourceMappingURL" in original or any(
                    path in nodes for path in (ASSET + ".map", ASSET[:-3] + ".map"))):
                raise BridgeError("Unverified source map layout")
            modified = transform_module(original, operation)
            new_header = copy.deepcopy(header)
            new_nodes = dict(asar.iter_files(new_header))
            target = nodes[ASSET]
            start, end = int(target["offset"]), int(target["offset"]) + target["size"]
            payload_size = before["size"] - base
            delta = len(modified) - len(original)
            for path, node in nodes.items():
                if node.get("unpacked") or "link" in node or "files" in node:
                    continue
                offset, size = int(node["offset"]), node["size"]
                if offset < 0 or size < 0 or offset + size > payload_size:
                    raise BridgeError("Invalid packed file bounds")
                if path != ASSET and size and offset < end and offset + size > start:
                    raise BridgeError("Overlapping packed files")
                if offset >= end and path != ASSET:
                    new_nodes[path]["offset"] = str(offset + delta)
            new_nodes[ASSET]["size"] = len(modified)
            new_nodes[ASSET]["integrity"] = asar.compute_integrity(modified)
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
