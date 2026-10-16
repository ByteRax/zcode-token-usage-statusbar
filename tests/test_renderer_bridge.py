import hashlib
import json
from pathlib import Path
import re
import shutil
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
MINI = b'const oE=new Map;function BYe(e){return e.workspacePath}function Nse(e){return e}export{ oE };'


def archive(path, module=MINI, version=bridge.HOST_VERSION, extra=None):
    files = {'/package.json': json.dumps({'name': '@zcode/desktop', 'version': version,
                                        'type': 'module'}).encode(),
             bridge.ASSET: module, '/other.txt': b'third party bytes\0\xff'}
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
        self.pin = patch.object(bridge, 'ASSET_SHA256', hashlib.sha256(MINI).hexdigest())
        self.pin.start()
        self.addCleanup(self.pin.stop)
        self.addCleanup(self.tmp.cleanup)

    def test_micro_roundtrip_integrity_and_other_files(self):
        before = self.src.read_bytes()
        out = bridge.rewrite_asar(self.src, self.root / 'patched.asar')
        self.assertEqual(read(out), MINI + bridge.BRIDGE)
        self.assertEqual(metadata(out)[bridge.ASSET]['integrity'],
                         asar.compute_integrity(MINI + bridge.BRIDGE))
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
        data = MINI + bridge.BRIDGE
        for tampered in [data.replace(b'const key', b'const KEY'),
                         data.replace(MINI, MINI + b' '), data + bridge.BRIDGE]:
            with self.assertRaises(bridge.BridgeError):
                bridge.transform_module(tampered, 'remove')
        third_party = b'\n;globalThis.thirdParty = 1;'
        self.assertEqual(bridge.transform_module(data + third_party, 'remove'), MINI + third_party)
        with self.assertRaises(bridge.BridgeError):
            bridge.transform_module(data + third_party, 'patch')

    def test_integrity_tamper(self):
        raw = self.src.read_bytes().replace(b'third party bytes', b'third party BYTES')
        # Only modified nodes are integrity checked; unrelated data is copied verbatim.
        self.src.write_bytes(raw.replace(MINI, MINI.replace(b'oE', b'OE', 1)))
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
        with patch.object(bridge, 'ASSET_SHA256', hashlib.sha256(mapped).hexdigest()):
            archive(self.src, mapped)
            with self.assertRaisesRegex(bridge.BridgeError, 'source map'):
                bridge.rewrite_asar(self.src, self.root / 'no.asar')

    @unittest.skipUnless(shutil.which('node'), 'Node required')
    def test_node_syntax(self):
        module = self.root / 'bridge.mjs'
        module.write_bytes(MINI + bridge.BRIDGE)
        subprocess.run(['node', '--check', str(module)], check=True, capture_output=True)

    @unittest.skipUnless(HOST.is_file() and shutil.which('node'), 'Read-only host archive and Node required')
    def test_actual_host_archive_roundtrip_and_vm(self):
        self.pin.stop()
        # Hash all packed files without evaluating any renderer or accessing its database.
        before = asar.source_fingerprint(HOST)
        original = read(HOST)
        if bridge.MARKER in original:
            # Already-deployed host: strip the deployed bridge to recover the clean module.
            prefix, suffix = original.split(bridge.BRIDGE)
            original = prefix + suffix
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
        # BYe contains template interpolation braces; use its next-function boundary.
        key = text[text.index('function BYe(e)'):text.index('function VYe(e)')]
        methods = text[text.index('getState(){return this.state}'):
                       text.index('async connect(e={})', text.index('getState(){return this.state}'))]
        imported = read(HOST, '/out/renderer/assets/parts-1PK4PulD.js').decode()
        alias = re.search(r'export\{.*?\b(\w+) as C,', imported).group(1)
        topic_start = imported.index('function ' + alias + '(e)')
        topic = imported[topic_start:imported.index('function ', topic_start + 1)]
        fixture = ('const oE = new Map();\n' + key + topic +
                   '\nconst Nse = ' + alias + ';\nclass FixtureStore {\n' + methods +
                   '\n}\n' + bridge.BRIDGE.decode().replace('export function', 'function'))
        script = self.root / 'fixture.cjs'
        script.write_text('const vm = require("node:vm");\nvm.runInNewContext(' +
                          json.dumps(fixture + VM_ASSERTIONS) +
                          ', {assert: require("node:assert/strict"), console});\n')
        result = subprocess.run(['node', str(script)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('VM contract passed', result.stdout)


VM_ASSERTIONS = r'''
(async () => {
 const scope = {sessionId:'session',workspacePath:'/workspace with spaces',remoteSessionId:'remote'};
 const store = new FixtureStore();
 store.listeners = new Set(); store.liveDeltaListeners = new Set();
 store.modelTransitionListeners = new Set(); store.closed = false;
 store.state = {snapshot:{sessionId:'session',seq:1,rows:[{text:'host'}]},status:'live'};
 store.state.circular = store.state;
 const session = {store,refCount:2};
 const layer = {entries:new Map([[Nse(scope.sessionId),session]]),disposed:false};
 const entry = {layer,refCount:3,stale:false};
 oE.set(BYe(scope),entry);
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
   if(mode==='replaced')oE.set(BYe(scope),{...entry});
   if(mode==='sessionReplaced')layer.entries.set(Nse(scope.sessionId),{store});
   if(mode==='storeReplaced')session.store={closed:false};
   assert.equal(getExistingConversationStore(scope) === null, ['closed','stale','disposed'].includes(mode));
   assert.equal(h.getState(),null);cancel();h.off();assert.equal(store.listeners.size,0);
   store.closed=false;entry.stale=false;layer.disposed=false;session.store=store;
   oE.set(BYe(scope),entry);layer.entries.set(Nse(scope.sessionId),session);
 }
 const h = getExistingConversationStore(scope);h.subscribe(()=>{calls++;});
 store.closed=true;store.setState({status:'closed'});assert.equal(store.listeners.size,0);
 assert.equal(h.getState(),null);store.closed=false;store.setState({status:'live'});
 assert.equal(entry.refCount,3);assert.equal(session.refCount,2);assert.equal(rpc,0);
 const identityScope = {...scope,workspaceIdentity:' identity '};
 oE.set(BYe(identityScope),entry);
 assert(getExistingConversationStore({...identityScope,workspacePath:'/different'}));
 assert.equal(typeof globalThis.__zusageGetExistingConversationStore,'function');
 assert.equal(typeof globalThis.__zusageConversationDiagnostics,'function');
 const diag = globalThis.__zusageConversationDiagnostics();
 assert(diag.keys.includes(BYe(scope)));
 const live = diag.sessions.find(item => item.topic === Nse(scope.sessionId));
 assert(live && live.status === 'live' && live.seq === 1);
 assert(diag.keys.includes(BYe(identityScope)));
 await new Promise(resolve => setTimeout(resolve,0));
 console.log('VM contract passed');
})().catch(error => { throw error; });
'''.replace('setTimeout(resolve,0)', 'Promise.resolve().then(resolve)')


if __name__ == '__main__':
    unittest.main()
