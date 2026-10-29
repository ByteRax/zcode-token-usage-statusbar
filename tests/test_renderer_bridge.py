import hashlib
import json
from pathlib import Path
import re
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import renderer_bridge as bridge
import patch_install as asar

HOST = Path('/Applications/ZCode.app/Contents/Resources/app.asar')
PANE_ANCHORS = {
    '3.17.1': b'"data-testid":Gb(aBe,e),"data-session-id":t??`draft`,',
    '3.16.3': b'"data-testid":Sb(WRe,e),"data-session-id":t??`draft`,',
    '3.16.2': b'"data-testid":hb(WRe,e),"data-session-id":t??`draft`,',
    '3.16.1': b'"data-testid":vb(VRe,e),"data-session-id":t??`draft`,',
    '3.15.3': b'"data-testid":Oa(Mr,e),"data-session-id":t??`draft`,',
}


def mini_for(target):
    names = target['names']
    pane = target['pane']
    # 函数签名参数名随版本映射变化（3.17.1 起为 e,t,l,u,d），按登记条目动态生成
    signature = ','.join(pane.get(k, 't') for k in ('paneId', 'sessionId', 'workspacePath',
                                                    'workspaceIdentity', 'remoteSessionId'))
    return (f'const {names["registry"]}=new Map;'
            f'function {names["key"]}(e){{return e.workspacePath}}'
            f'function {names["topic"]}(e){{return e}}').encode() + (
                f'function SessionPane({signature}){{return {{'.encode() + PANE_ANCHORS[target['version']] +
                b'children:null}}export{ ' + names['registry'].encode() + b' };')


MINI = mini_for(bridge.NEWEST)
# 篡改用例改写最新目标的 registry 混淆名（随 NEWEST 变化，不能写死 pf）
REGISTRY = bridge.NEWEST['names']['registry'].encode()

# 自动推导的合成夹具：逐项复刻真实 bundle 的稳定形状（注册表/key/topic 绑定、
# acquire、store 生命周期、SessionPane 参数与 testid 锚点）。
RICH = (
    b'import{A as zz,C as gee}from"./parts-TEST.js";'
    b'const hf=new Map,wde=`__base__`,Tde=3e4;'
    b'function Ede(e){let t=e.workspaceIdentity?.trim()||e.workspacePath;'
    b'return`${e.remoteSessionId??`__base__`} ${t}`}'
    b'class FakeStore{getState(){return this.state}async connect(e={}){this.closed=!0}}'
    b'class FakeLayer{acquire(e){if(this.disposed)throw Error(`SessionDataLayer released`);'
    b'let t=gee(e),n=Cde(),r=this.entries.get(t);return r}}'
    b'function Cde(){return 1}'
    b'function r4({paneId:e,sessionId:t,workspacePath:c,workspaceIdentity:l,remoteSessionId:u}){'
    b'const s={key:r,layer:new FakeLayer(),refCount:1,keepWarmTimer:null,stale:!1};hf.set(r,s);'
    b'hf.get(r);hf.delete(r);'
    b'return{workspacePath:c,workspaceIdentity:l,remoteSessionId:u,'
    b'"data-testid":hb(WRe,e),"data-session-id":t??`draft`,children:null}};'
    b'export{hf};'
)
RICH_PARTS = {"/out/renderer/assets/parts-TEST.js": b'export const C = e => e;'}


def patched_module(module, target):
    anchor = PANE_ANCHORS[target['version']]
    # 属性写入名随 target 的 pane 参数映射变化（3.17.1 起为 l/u/d/e），期望值走实现同款生成
    return module.replace(anchor, anchor + bridge.pane_attributes(target)) + bridge.bridge_code(target)


def synthetic_target(target, module):
    return dict(target, sha256=hashlib.sha256(module).hexdigest())


def archive(path, module=MINI, version=bridge.HOST_VERSION, extra=None):
    target = next((item for item in bridge.HOST_TARGETS if item['version'] == version), bridge.NEWEST)
    files = {'/package.json': json.dumps({'name': '@zcode/desktop', 'version': version,
                                        'type': 'module'}).encode(),
             target['asset']: module, '/other.txt': b'third party bytes\0\xff'}
    files.update(extra or {})
    header = {'files': {}}
    payload = b''
    for name, data in files.items():
        parent = header
        parts = name.strip('/').split('/')
        for part in parts[:-1]:
            parent = parent['files'].setdefault(part, {'files': {}})
        parent['files'][parts[-1]] = {'size': len(data), 'offset': str(len(payload)),
                                     'integrity': asar.compute_integrity(data)}
        payload += data
    header['files']['alias'] = {'link': 'other.txt'}
    header['files']['external'] = {'size': 7, 'unpacked': True}
    encoded = json.dumps(header, separators=(',', ':')).encode()
    padded = (len(encoded) + 7) // 4 * 4
    path.write_bytes(struct.pack('<4I', 4, padded + 4, padded, len(encoded)) +
                     encoded + b'\0' * (padded - len(encoded) - 4) + payload)


def read(path, name=bridge.ASSET):
    with path.open('rb') as stream:
        h, b = asar.read_header(stream)
        return bridge._read(stream, dict(asar.iter_files(h)), b, name)


def metadata(path):
    with path.open('rb') as stream:
        h, _ = asar.read_header(stream)
        return dict(asar.iter_files(h))


class RendererBridgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='renderer-bridge-test-')
        self.root = Path(self.tmp.name)
        self.src = self.root / 'input.asar'
        archive(self.src)
        # 多版本化后指纹在 HOST_TARGETS 表里：夹具把表整体换成 MINI 的合成目标
        self.pin = patch.object(bridge, 'HOST_TARGETS', [synthetic_target(bridge.NEWEST, MINI)])
        self.pin.start()
        self.addCleanup(self.pin.stop)
        self.addCleanup(self.tmp.cleanup)

    def test_micro_roundtrip_integrity_and_other_files(self):
        before = self.src.read_bytes()
        out = bridge.rewrite_asar(self.src, self.root / 'patched.asar')
        expected = patched_module(MINI, bridge.NEWEST)
        self.assertEqual(read(out), expected)
        self.assertEqual(metadata(out)[bridge.ASSET]['integrity'],
                         asar.compute_integrity(expected))
        restored = bridge.rewrite_asar(out, self.root / 'restored.asar', 'remove')
        self.assertEqual(read(restored), MINI)
        self.assertEqual(self.src.read_bytes(), before)
        for path, node in metadata(self.src).items():
            if path != bridge.ASSET:
                after = metadata(out)[path].copy()
                original = node.copy()
                after.pop('offset', None)
                original.pop('offset', None)
                self.assertEqual(after, original)
                if 'offset' in node:
                    self.assertEqual(read(out, path), read(self.src, path))

    def test_repeated_patch_and_remove(self):
        out = bridge.rewrite_asar(self.src, self.root / 'one.asar')
        repeat = bridge.rewrite_asar(out, self.root / 'two.asar')
        self.assertEqual(read(repeat), read(out))
        self.assertEqual(read(repeat).count(b'export function getExistingConversationStore'), 1)
        self.assertEqual(bridge.transform_module(MINI, 'remove'), MINI)

    def test_unknown_hash_and_version(self):
        for module, version in [(MINI + b' ', bridge.HOST_VERSION), (MINI, '3.15.4')]:
            archive(self.src, module, version)
            with self.assertRaises(bridge.BridgeError):
                bridge.rewrite_asar(self.src, self.root / 'no.asar')
            self.assertFalse((self.root / 'no.asar').exists())

    def test_tampering_and_third_party(self):
        for data in [MINI + bridge.BRIDGE, patched_module(MINI, bridge.NEWEST)]:
            for tampered in [data.replace(b'const key', b'const KEY'),
                             data.replace(b'const ' + REGISTRY, b'const ' + REGISTRY.upper()),
                             data + bridge.BRIDGE]:
                self.assertIsNone(bridge.target_for_module(tampered))
                for operation in ['patch', 'remove']:
                    with self.assertRaises(bridge.BridgeError):
                        bridge.transform_module(tampered, operation)
            third_party = b'\n;globalThis.thirdParty = 1;'
            self.assertEqual(bridge.transform_module(data + third_party, 'remove'), MINI + third_party)
            with self.assertRaises(bridge.BridgeError):
                bridge.transform_module(data + third_party, 'patch')

    def test_both_versions_scope_patch_upgrade_and_roundtrip(self):
        self.pin.stop()
        targets = [synthetic_target(target, mini_for(target)) for target in bridge.HOST_TARGETS]
        with patch.object(bridge, 'HOST_TARGETS', targets):
            for target in targets:
                with self.subTest(version=target['version']):
                    module = mini_for(target)
                    expected = patched_module(module, target)
                    legacy = module + bridge.bridge_code(target)
                    for data in [module, legacy, expected]:
                        self.assertEqual(bridge.target_for_module(data), target)
                        self.assertEqual(bridge.transform_module(data, 'patch'), expected)
                        self.assertEqual(bridge.transform_module(data, 'remove'), module)
                    self.assertEqual(expected.count(bridge.pane_attributes(target)), 1)
                    archive(self.src, module, target['version'])
                    out = bridge.rewrite_asar(self.src, self.root / f'{target["version"]}.asar')
                    self.assertEqual(read(out, target['asset']), expected)

    def test_scope_tamper_is_refused(self):
        data = patched_module(MINI, bridge.NEWEST)
        anchor = PANE_ANCHORS[bridge.HOST_VERSION]
        attrs = bridge.pane_attributes(bridge.NEWEST)
        path_name = bridge.NEWEST['pane']['workspacePath'].encode()
        for tampered in [data.replace(b'"data-zusage-scope-version":"1"',
                                      b'"data-zusage-scope-version":"2"'),
                         data.replace(b'"data-zusage-workspace-path":' + path_name + b'??``',
                                      b'"data-zusage-workspace-path":zz??``'),
                         data.replace(attrs, attrs[:-1]),
                         data.replace(anchor + attrs,
                                      anchor + attrs + attrs),
                         data.replace(anchor, b'"data-session-id":t??`draft`,')]:
            self.assertIsNone(bridge.target_for_module(tampered))
            for operation in ['patch', 'remove']:
                with self.assertRaises(bridge.BridgeError):
                    bridge.transform_module(tampered, operation)
        with self.assertRaises(bridge.BridgeError):
            bridge.transform_module(data.replace(bridge.BRIDGE, b''), 'patch')

    def test_missing_and_duplicate_anchor_fail_closed(self):
        anchor = PANE_ANCHORS[bridge.HOST_VERSION]
        for module in [MINI.replace(anchor, b'"data-session-id":t??`draft`,'),
                       MINI.replace(anchor, anchor + anchor)]:
            target = synthetic_target(bridge.NEWEST, module)
            with patch.object(bridge, 'HOST_TARGETS', [target]):
                for data in [module, module + bridge.BRIDGE]:
                    self.assertIsNone(bridge.target_for_module(data))
                    for operation in ['patch', 'remove']:
                        with self.assertRaises(bridge.BridgeError):
                            bridge.transform_module(data, operation)

    def test_integrity_tamper(self):
        raw = self.src.read_bytes().replace(b'third party bytes', b'third party BYTES')
        # Only modified nodes are integrity checked; unrelated data is copied verbatim.
        self.src.write_bytes(raw.replace(MINI, MINI.replace(REGISTRY, REGISTRY.upper(), 1)))
        with self.assertRaisesRegex(bridge.BridgeError, 'integrity'):
            bridge.rewrite_asar(self.src, self.root / 'no.asar')

    def test_output_restrictions(self):
        for output in [self.src, HOST, HOST.with_name('bridge.asar'),
                       self.root / 'copy.app' / 'bridge.asar', self.root / 'Resources' / 'bridge.asar']:
            with self.assertRaises(bridge.BridgeError):
                bridge.rewrite_asar(self.src, output)
        existing = self.root / 'exists.asar'
        existing.write_bytes(b'keep')
        with self.assertRaises(bridge.BridgeError):
            bridge.rewrite_asar(self.src, existing)
        self.assertEqual(existing.read_bytes(), b'keep')
        link = self.root / 'dangling.asar'
        link.symlink_to(self.root / 'new-target.asar')
        with self.assertRaises(bridge.BridgeError):
            bridge.rewrite_asar(self.src, link)
        self.assertFalse((self.root / 'new-target.asar').exists())

    def test_map_layout_refused(self):
        for name in [bridge.ASSET + '.map', bridge.ASSET[:-3] + '.map']:
            archive(self.src, extra={name: b'{"version":3}'})
            with self.assertRaisesRegex(bridge.BridgeError, 'source map'):
                bridge.rewrite_asar(self.src, self.root / 'no.asar')
        mapped = MINI + b'\n//# sourceMappingURL=x.map'
        with patch.object(bridge, 'HOST_TARGETS', [synthetic_target(bridge.NEWEST, mapped)]):
            archive(self.src, mapped)
            with self.assertRaisesRegex(bridge.BridgeError, 'source map'):
                bridge.rewrite_asar(self.src, self.root / 'no.asar')

    @unittest.skipUnless(shutil.which('node'), 'Node required')
    def test_node_syntax(self):
        self.pin.stop()
        for target in bridge.HOST_TARGETS:
            with self.subTest(version=target['version']):
                pristine = mini_for(target)
                pinned = synthetic_target(target, pristine)
                module = self.root / f'{target["version"]}.mjs'
                with patch.object(bridge, 'HOST_TARGETS', [pinned]):
                    module.write_bytes(bridge.transform_module(pristine, 'patch'))
                subprocess.run(['node', '--check', str(module)], check=True, capture_output=True)

    @unittest.skipUnless(shutil.which('node'), 'Node required')
    def test_scope_props_track_current_pane_and_clear_remote_values(self):
        self.pin.stop()
        assertions = r'''
const first = SessionPane('pane-1','session-1','/workspace','remote:ssh:server','remote-1');
assert.equal(first['data-zusage-scope-version'],'1');
assert.equal(first['data-session-id'],'session-1');
assert.equal(first['data-zusage-workspace-path'],'/workspace');
assert.equal(first['data-zusage-workspace-identity'],'remote:ssh:server');
assert.equal(first['data-zusage-remote-session-id'],'remote-1');
assert.equal(first['data-zusage-pane-id'],'pane-1');
const next = SessionPane('pane-2',null,null,undefined,null);
assert.equal(next['data-session-id'],'draft');
for (const key of ['workspace-path','workspace-identity','remote-session-id'])
  assert.equal(next['data-zusage-' + key],'');
assert.equal(next['data-zusage-pane-id'],'pane-2');
'''
        for target in bridge.HOST_TARGETS:
            with self.subTest(version=target['version']):
                module = mini_for(target)
                with patch.object(bridge, 'HOST_TARGETS', [synthetic_target(target, module)]):
                    patched = bridge.transform_module(module, 'patch')
                text = patched.decode().replace('export function', 'function')
                text = text.replace('export{ ' + target['names']['registry'] + ' };', '')
                fixture = 'const vb=()=>"pane", Oa=vb, hb=vb, Sb=vb, Gb=vb, VRe=null, Mr=null, WRe=null, aBe=null;\n' + text + assertions
                script = self.root / f'{target["version"]}-props.cjs'
                script.write_text('const vm=require("node:vm");vm.runInNewContext(' +
                                  json.dumps(fixture) + ',{assert:require("node:assert/strict")});')
                result = subprocess.run(['node', str(script)], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)

    @unittest.skipUnless(HOST.is_file() and shutil.which('node'), 'Read-only host archive and Node required')
    def test_actual_host_archive_roundtrip_and_vm(self):
        self.pin.stop()
        # Hash all packed files without evaluating any renderer or accessing its database.
        before = asar.source_fingerprint(HOST)
        original = bridge.transform_module(read(HOST), 'remove')
        self.assertEqual(hashlib.sha256(original).hexdigest(), bridge.ASSET_SHA256)
        out = bridge.rewrite_asar(HOST, self.root / 'host-patched.asar')
        module = self.root / 'host-patched.mjs'
        module.write_bytes(read(out))
        subprocess.run(['node', '--check', str(module)], check=True, capture_output=True)
        restored = bridge.rewrite_asar(out, self.root / 'host-restored.asar', 'remove')
        self.assertEqual(read(restored), original)
        old_nodes, new_nodes = metadata(HOST), metadata(out)
        self.assertEqual(set(old_nodes), set(new_nodes))
        with HOST.open('rb') as src, out.open('rb') as dst:
            _, base1 = asar.read_header(src)
            _, base2 = asar.read_header(dst)
            for name, node in old_nodes.items():
                if name == bridge.ASSET:
                    continue
                new = new_nodes[name]
                self.assertEqual({k: v for k, v in node.items() if k != 'offset'},
                                 {k: v for k, v in new.items() if k != 'offset'})
                if node.get('unpacked') or 'link' in node:
                    continue
                src.seek(base1 + int(node['offset']))
                dst.seek(base2 + int(new['offset']))
                remaining = node['size']
                while remaining:
                    count = min(asar.BLOCK, remaining)
                    self.assertEqual(src.read(count), dst.read(count), name)
                    remaining -= count
        self.assertEqual(asar.source_fingerprint(HOST), before)
        text = original.decode()
        names = bridge.NEWEST['names']
        # key 函数体含模板插值花括号；用下一个 function 边界截取
        key_start = text.index(f'function {names["key"]}(e)')
        key = text[key_start:text.index('function ', key_start + 1)]
        methods = text[text.index('getState(){return this.state}'):
                       text.index('async connect(e={})', text.index('getState(){return this.state}'))]
        # 新包 topic 函数为跨资产 import 别名；契约恒为 conversation/<id>，夹具内联同款实现
        topic = f'function {names["topic"]}(e){{return `conversation/${{e}}`;}}'
        # VM_ASSERTIONS 以 pf/Ode/hee 书写；按当前目标的混淆名起别名
        aliases = ''.join(f'const {alias} = {real};\n' for alias, real in
                          (('pf', names['registry']), ('Ode', names['key']), ('hee', names['topic']))
                          if alias != real)
        fixture = (f'const {names["registry"]} = new Map();\n' + key + topic + '\n' + aliases +
                   'class FixtureStore {\n' + methods +
                   '\n}\n' + bridge.BRIDGE.decode().replace('export function', 'function'))
        script = self.root / 'fixture.cjs'
        script.write_text('const vm = require("node:vm");\nvm.runInNewContext(' +
                          json.dumps(fixture + VM_ASSERTIONS) +
                          ', {assert: require("node:assert/strict"), console});\n')
        result = subprocess.run(['node', str(script)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('VM contract passed', result.stdout)

    @unittest.skipUnless(HOST.is_file(), 'Read-only host archive required')
    def test_derive_matches_pinned_host_entry(self):
        # 自动推导必须能复现人工登记的指纹（真机 bundle 是唯一权威样本）
        self.pin.stop()
        pristine = bridge.transform_module(read(HOST), 'remove')
        self.assertEqual(hashlib.sha256(pristine).hexdigest(), bridge.ASSET_SHA256)
        derived = bridge.derive_target(bridge.HOST_VERSION, pristine, bridge.ASSET,
                                       set(metadata(HOST)))
        self.assertEqual(derived['version'], bridge.NEWEST['version'])
        self.assertEqual(derived['asset'], bridge.NEWEST['asset'])
        self.assertEqual(derived['sha256'], bridge.NEWEST['sha256'])
        self.assertEqual(derived['names'], bridge.NEWEST['names'])
        self.assertEqual(derived['pane'], bridge.NEWEST['pane'])
        self.assertTrue(derived['derived'])
        # 已补过桥的真机安装同样能推导：按指纹还原原始模块后再出条目
        installed = bridge.derive_from_asar(HOST)
        self.assertEqual(installed['names'], bridge.NEWEST['names'])
        self.assertEqual(installed['pane'], bridge.NEWEST['pane'])
        self.assertEqual(installed['sha256'], bridge.NEWEST['sha256'])


class DeriveTests(unittest.TestCase):
    """表外版本的严格推导与就地自动补丁（合成 asar，不碰真机安装）。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='bridge-derive-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.target = self.root / 'app.asar'
        archive(self.target, RICH, '9.9.9', RICH_PARTS)

    def test_auto_patch_present_remove_cycle(self):
        result = bridge.ensure_deployed(self.target)
        self.assertEqual(result['status'], 'patched', result)
        self.assertIn('auto-derived', result['detail'])
        self.assertIn(bridge.MARKER, read(self.target))
        self.assertEqual(bridge.ensure_deployed(self.target)['status'], 'present')
        removed = bridge.remove_deployed(self.target)
        self.assertEqual(removed['status'], 'removed', removed)
        self.assertIn('auto-derived', removed['detail'])
        self.assertEqual(read(self.target), RICH)
        self.assertEqual(bridge.remove_deployed(self.target)['status'], 'skipped-unknown')

    @unittest.skipUnless(shutil.which('node'), 'Node required')
    def test_auto_patch_module_parses(self):
        self.assertEqual(bridge.ensure_deployed(self.target)['status'], 'patched')
        module = self.root / 'auto.mjs'
        module.write_bytes(read(self.target))
        subprocess.run(['node', '--check', str(module)], check=True, capture_output=True)

    def test_strip_refuses_tampered_or_truncated_bridge(self):
        derived = bridge.derive_target('9.9.9', RICH,
                                       "/out/renderer/assets/styles-n-UNIiNg.js", set(RICH_PARTS))
        patched = bridge.transform_module(RICH, 'patch', derived)
        self.assertEqual(bridge._strip_auto_bridge(patched), RICH)
        for name, mutate in {
            'duplicate end marker': lambda data: data.replace(bridge.END, bridge.END + bridge.END),
            'missing trailing newline': lambda data: data[:-1],
            'altered pane attribute': lambda data: data.replace(
                b'"data-zusage-pane-id":e,', b'"data-zusage-pane-id":"x",'),
        }.items():
            with self.subTest(name):
                mutated = mutate(patched)
                self.assertNotEqual(mutated, patched)
                with self.assertRaises(bridge.BridgeError):
                    bridge._strip_auto_bridge(mutated)

    def test_remove_rechecks_source_fingerprint_before_publish(self):
        self.assertEqual(bridge.ensure_deployed(self.target)['status'], 'patched')
        calls = []

        def drifting(path):
            calls.append(path)
            return {'size': len(calls)}

        with patch.object(bridge.asar, 'source_fingerprint', drifting), \
                patch.object(bridge.os, 'replace') as publish:
            result = bridge.remove_deployed(self.target)
        self.assertEqual(result['status'], 'skipped-error', result)
        publish.assert_not_called()
        self.assertIn(bridge.MARKER, self.target.read_bytes())

    def test_one_bridged_among_multiple_assets_is_not_present(self):
        multi = self.root / 'multi.asar'
        derived = bridge.derive_target('9.9.9', RICH,
                                       "/out/renderer/assets/styles-n-UNIiNg.js", set(RICH_PARTS))
        archive(multi, bridge.transform_module(RICH, 'patch', derived), '9.9.9',
                dict(RICH_PARTS, **{'/out/renderer/assets/styles-second.js': RICH}))
        before = multi.read_bytes()
        result = bridge.ensure_deployed(multi)
        self.assertEqual(result['status'], 'skipped-unknown')
        self.assertIn('unpatched derivable', result['detail'])
        self.assertEqual(multi.read_bytes(), before)

    def test_bridged_plus_unrelated_asset_stays_present(self):
        # 无关的 styles-* chunk 不可推导时不能把幂等 present 变成每次跳过
        multi = self.root / 'multi-unrelated.asar'
        archive(multi, RICH, '9.9.9',
                dict(RICH_PARTS, **{'/out/renderer/assets/styles-second.js': b'export const x=1;'}))
        self.assertEqual(bridge.ensure_deployed(multi)['status'], 'patched')
        self.assertEqual(bridge.ensure_deployed(multi)['status'], 'present')

    def test_cli_derive_rejects_source_map_sideload(self):
        mapped = self.root / 'mapped.asar'
        archive(mapped, RICH, '9.9.9',
                dict(RICH_PARTS, **{bridge.ASSET + '.map': b'{}'}))
        with self.assertRaises(bridge.BridgeError):
            bridge.derive_from_asar(mapped)

    def test_derive_refuses_unverified_shapes(self):
        asset = "/out/renderer/assets/styles-n-UNIiNg.js"
        anchor = b'"data-testid":hb(WRe,e),"data-session-id":t??`draft`,'
        cases = {
            'duplicate anchor': RICH.replace(anchor, anchor + anchor),
            'duplicate session attribute': RICH.replace(
                b'"data-session-id":t??`draft`,', b'"data-session-id":t??`draft`,"data-session-id":t??`draft`,', 1),
            'missing topic import': RICH.replace(b'import{A as zz,C as gee}from"./parts-TEST.js";', b''),
            'missing store state': RICH.replace(b'getState(){return this.state}', b''),
            'missing closed flag': RICH.replace(b'this.closed=!0', b''),
            'source map': RICH + b'\n//# sourceMappingURL=styles-TEST.js.map',
            'testid pane mismatch': RICH.replace(b'"data-testid":hb(WRe,e)', b'"data-testid":hb(WRe,x)'),
            'unexpected registry entry': RICH.replace(b'stale:!1', b'stale:0'),
            'ambiguous component params': RICH.replace(
                b'function Cde(){return 1}',
                b'function Cde(){return 1}function wrap({paneId:x,sessionId:y,workspacePath:z,'
                b'workspaceIdentity:w,remoteSessionId:v}){return 0}'),
            'non-ascii import source': RICH.replace(b'./parts-TEST.js', b'./parts-\xff.js'),
            'already bridged': RICH + b'\n/* zusage-existing-conversation-store:v1 begin */',
        }
        for name, module in cases.items():
            with self.subTest(name):
                with self.assertRaises(bridge.BridgeError):
                    bridge.derive_target('9.9.9', module, asset, set(RICH_PARTS))
        # topic import 存在但目标 chunk 不在归档里：拒绝
        with self.assertRaises(bridge.BridgeError):
            bridge.derive_target('9.9.9', RICH, asset, set())

    def test_ambiguous_renderer_assets_refuse(self):
        ambiguous = self.root / 'ambiguous.asar'
        clone = RICH.replace(b'"data-testid":hb(WRe,e)', b'"data-testid":zz(QQ,e)')
        archive(ambiguous, RICH, '9.9.9',
                dict(RICH_PARTS, **{'/out/renderer/assets/styles-second.js': clone}))
        result = bridge.ensure_deployed(ambiguous)
        self.assertEqual(result['status'], 'skipped-unknown')
        self.assertIn('ambiguous', result['detail'])

    def test_cli_derive_prints_pasteable_entry(self):
        command = [sys.executable, '-B', str(Path(bridge.__file__).resolve()),
                   'derive', str(self.target)]
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("'version': '9.9.9'", result.stdout)
        self.assertIn("'registry': 'hf'", result.stdout)
        self.assertIn("b'\"data-testid\":hb(WRe,e),\"data-session-id\":t??`draft`,'", result.stdout)
        # 已自动补过桥的归档也能推导（按标记还原）
        self.assertEqual(bridge.ensure_deployed(self.target)['status'], 'patched')
        after = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(after.returncode, 0, after.stderr)
        self.assertIn("'registry': 'hf'", after.stdout)


class EnsureDeployedTests(unittest.TestCase):
    """插件安装链的 in-place 部署 API：真实读写临时 asar，不碰真机安装。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='bridge-ensure-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.target = self.root / 'app.asar'
        archive(self.target)
        self.pin = patch.object(bridge, 'HOST_TARGETS', [synthetic_target(bridge.NEWEST, MINI)])
        self.pin.start()
        self.addCleanup(self.pin.stop)

    def test_patch_present_remove_absent_lifecycle(self):
        # 就地替换不得把安装目录 asar 的权限降成 mkstemp 的 0600
        self.target.chmod(0o644)
        result = bridge.ensure_deployed(self.target)
        self.assertEqual(result["status"], "patched")
        self.assertEqual(result["version"], bridge.HOST_VERSION)
        self.assertEqual(stat.S_IMODE(self.target.stat().st_mode), 0o644)
        self.assertIn(".zusage.lock".replace(".zusage", "zusage"), str(list(self.root.iterdir()) or ""))  # 锁文件随 asar 命名
        with self.target.open('rb') as stream:
            header, base = asar.read_header(stream)
            data = bridge._read(stream, dict(asar.iter_files(header)), base, bridge.ASSET)
        self.assertIn(bridge.MARKER, data)
        # 幂等：已带桥再 ensure → present，不重写
        self.assertEqual(bridge.ensure_deployed(self.target)["status"], "present")
        # 卸载对称清理 → removed → 还原为干净模块 → absent
        self.assertEqual(bridge.remove_deployed(self.target)["status"], "removed")
        self.assertEqual(stat.S_IMODE(self.target.stat().st_mode), 0o644)
        with self.target.open('rb') as stream:
            header, base = asar.read_header(stream)
            data = bridge._read(stream, dict(asar.iter_files(header)), base, bridge.ASSET)
        self.assertEqual(hashlib.sha256(data).hexdigest(), hashlib.sha256(MINI).hexdigest())
        self.assertEqual(bridge.remove_deployed(self.target)["status"], "absent")

    def test_upgrade_old_bridge_atomically_for_both_versions(self):
        self.pin.stop()
        targets = [synthetic_target(target, mini_for(target)) for target in bridge.HOST_TARGETS]
        with patch.object(bridge, 'HOST_TARGETS', targets):
            for target in targets:
                with self.subTest(version=target['version']):
                    module = mini_for(target)
                    archive(self.target, module + bridge.bridge_code(target), target['version'])
                    before = self.target.read_bytes()
                    real_replace = bridge.os.replace

                    def replace(stage, destination):
                        self.assertEqual(Path(destination), self.target)
                        self.assertEqual(self.target.read_bytes(), before)
                        self.assertEqual(read(Path(stage), target['asset']), patched_module(module, target))
                        real_replace(stage, destination)

                    with patch.object(bridge.os, 'replace', side_effect=replace) as publish:
                        result = bridge.ensure_deployed(self.target)
                    self.assertEqual(result['status'], 'patched')
                    self.assertEqual(result['version'], target['version'])
                    publish.assert_called_once()
                    self.assertEqual(read(self.target, target['asset']), patched_module(module, target))
                    deployed = self.target.read_bytes()
                    with patch.object(bridge.os, 'replace') as publish:
                        self.assertEqual(bridge.ensure_deployed(self.target)['status'], 'present')
                    publish.assert_not_called()
                    self.assertEqual(self.target.read_bytes(), deployed)
                    self.assertEqual(bridge.remove_deployed(self.target)['status'], 'removed')
                    self.assertEqual(read(self.target, target['asset']), module)
                    self.assertEqual(read(self.target, '/other.txt'), b'third party bytes\0\xff')
                    self.assertFalse(list(self.root.glob('.zusage-bridge-*')))

    def test_upgrade_failure_leaves_old_archive_intact(self):
        archive(self.target, MINI + bridge.BRIDGE)
        before = self.target.read_bytes()
        with patch.object(bridge.os, 'replace', side_effect=OSError('publication failed')):
            result = bridge.ensure_deployed(self.target)
        # 发布被拒的新契约：stage 保留移交（issue #67），由调用方转存待替换链或清理
        self.assertEqual(result['status'], 'replace-failed')
        self.assertTrue(Path(result['stage']).is_file())
        self.assertIn('publication failed', result['detail'])
        self.assertEqual(self.target.read_bytes(), before)
        Path(result['stage']).unlink()
        # stage 构建或发布前的其它异常仍走 skipped-error 且不残留
        with patch.object(bridge, '_rewrite_to', side_effect=OSError('disk error')):
            result = bridge.ensure_deployed(self.target)
        self.assertEqual(result['status'], 'skipped-error')
        self.assertEqual(self.target.read_bytes(), before)
        self.assertFalse(list(self.root.glob('.zusage-bridge-*')))

    def test_ensure_rejects_tampering_and_suffix_without_writes(self):
        suffix = b'\n;globalThis.thirdParty = 1;'
        current = patched_module(MINI, bridge.NEWEST)
        for module in [MINI + bridge.BRIDGE + suffix, current + suffix,
                       current.replace(b'"data-zusage-scope-version":"1"',
                                       b'"data-zusage-scope-version":"2"'),
                       current.replace(b'const key', b'const KEY')]:
            archive(self.target, module)
            before = self.target.read_bytes()
            with patch.object(bridge.os, 'replace') as publish:
                self.assertEqual(bridge.ensure_deployed(self.target)['status'], 'skipped-error')
            publish.assert_not_called()
            self.assertEqual(self.target.read_bytes(), before)

    def test_unknown_version_and_unreadable_path_never_raise(self):
        unknown = self.root / 'unknown.asar'
        archive(unknown, version='9.9.9')
        result = bridge.ensure_deployed(unknown)
        self.assertEqual(result["status"], "skipped-unknown")
        self.assertEqual(result["version"], '9.9.9')
        self.assertEqual(bridge.ensure_deployed(self.root / 'missing.asar')["status"], "skipped-error")
        self.assertEqual(bridge.remove_deployed(self.root / 'missing.asar')["status"], "skipped-error")
        # 其它文件在桥旁不受影响：unknown 归档未被改写
        self.assertEqual(bridge.remove_deployed(unknown)["status"], "skipped-unknown")

    def test_asset_drift_for_pinned_version_fails_closed(self):
        # 版本已登记但资产内容与指纹不符（宿主 build 漂移）：拒绝手术
        drifted = self.root / 'drift.asar'
        archive(drifted, module=MINI + b' ')
        result = bridge.ensure_deployed(drifted)
        self.assertEqual(result["status"], "skipped-unknown")
        self.assertIn("hash mismatch", result["detail"])


VM_ASSERTIONS = r''' 
(async () => {
 const scope = {sessionId:'session',workspacePath:'/workspace with spaces',remoteSessionId:'remote'};
 const store = new FixtureStore();
 store.listeners = new Set(); store.liveDeltaListeners = new Set();
 store.modelTransitionListeners = new Set(); store.closed = false;
 store.state = {snapshot:{sessionId:'session',seq:1,rows:[{text:'host'}]},status:'live'};
 store.state.circular = store.state;
 const session = {store,refCount:2};
 const layer = {entries:new Map([[hee(scope.sessionId),session]]),disposed:false};
 const entry = {layer,refCount:3,stale:false};
 pf.set(Ode(scope),entry);
 let rpc = 0;
 store.connect = store.close = layer.acquire = () => {rpc++;throw Error('Forbidden lifecycle');};
 const handle = getExistingConversationStore(scope);
 assert.deepEqual(Object.keys(handle).sort(), ['getState','off','subscribe']);
 assert(Object.isFrozen(handle));
 assert.equal(session.store,store);
 const state = handle.getState();
 assert.notEqual(state,store.state); assert.equal(state.circular,state);
 assert(Object.isFrozen(state.snapshot.rows[0]));
 try {state.snapshot.rows[0].text='consumer';state.snapshot.rows.push({});} catch (_) {}
 assert.equal(store.state.snapshot.rows[0].text,'host');
 assert(!Object.isFrozen(store.state.snapshot));
 store.state.snapshot.rows[0].text='new';
 assert.equal(handle.getState().snapshot.rows[0].text,'new');
 assert.equal(state.snapshot.rows[0].text,'host');
 let calls=0; const off = handle.subscribe(() => calls++);
 handle.subscribe(() => {throw Error('consumer error');});
 handle.subscribe(async () => {throw Error('async consumer error');});
 store.setState({status:'live'}); assert.equal(calls,1);
 off(); off(); store.setState({status:'live'}); assert.equal(calls,1);
 handle.off();handle.off(); assert.equal(store.listeners.size,0);
 assert.equal(handle.getState(),null);
 assert.equal(entry.refCount,3);assert.equal(session.refCount,2);assert.equal(rpc,0);
 for (const invalid of [null, [], {}, {...scope,sessionId:''}, {...scope,remoteSessionId:'__base__'},
   {...scope,sessionId:'a b'}, {...scope,workspaceIdentity:3}, {...scope,extra:true},
   {...scope,workspacePath:'\0'}, {...scope,get sessionId(){throw Error('getter');}}])
   assert.throws(() => getExistingConversationStore(invalid), /scope|identifier/);
 assert.equal(getExistingConversationStore({...scope,remoteSessionId:'other'}),null);
 assert.equal(getExistingConversationStore({...scope,workspacePath:'/other'}),null);
 assert.equal(getExistingConversationStore({...scope,sessionId:'missing'}),null);
 for (const mode of ['closed','stale','disposed','replaced','sessionReplaced','storeReplaced']) {
   const h = getExistingConversationStore(scope); const cancel = h.subscribe(() => {throw Error('stale');});
   if(mode==='closed')store.closed=true;
   if(mode==='stale')entry.stale=true;
   if(mode==='disposed')layer.disposed=true;
   if(mode==='replaced')pf.set(Ode(scope),{...entry});
   if(mode==='sessionReplaced')layer.entries.set(hee(scope.sessionId),{store});
   if(mode==='storeReplaced')session.store={closed:false};
   assert.equal(getExistingConversationStore(scope) === null, ['closed','stale','disposed'].includes(mode));
   assert.equal(h.getState(),null);cancel();h.off();assert.equal(store.listeners.size,0);
   store.closed=false;entry.stale=false;layer.disposed=false;session.store=store;
   pf.set(Ode(scope),entry);layer.entries.set(hee(scope.sessionId),session);
 }
 const h = getExistingConversationStore(scope);h.subscribe(()=>{calls++;});
 store.closed=true;store.setState({status:'closed'});assert.equal(store.listeners.size,0);
 assert.equal(h.getState(),null);store.closed=false;store.setState({status:'live'});
 assert.equal(entry.refCount,3);assert.equal(session.refCount,2);assert.equal(rpc,0);
 const identityScope = {...scope,workspaceIdentity:' identity '};
 pf.set(Ode(identityScope),entry);
 assert(getExistingConversationStore({...identityScope,workspacePath:'/different'}));
 assert.equal(typeof globalThis.__zusageGetExistingConversationStore,'function');
 assert.equal(typeof globalThis.__zusageConversationDiagnostics,'function');
 const diag = globalThis.__zusageConversationDiagnostics();
 assert(diag.keys.includes(Ode(scope)));
 const live = diag.sessions.find(item => item.topic === hee(scope.sessionId));
 assert(live && live.status === 'live' && live.seq === 1);
 assert(diag.keys.includes(Ode(identityScope)));
 await new Promise(resolve => setTimeout(resolve,0));
 console.log('VM contract passed');
})().catch(error => { throw error; });
'''.replace('setTimeout(resolve,0)', 'Promise.resolve().then(resolve)')


if __name__ == '__main__':
    unittest.main()
