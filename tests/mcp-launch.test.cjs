'use strict';

// mcp-launch.cjs：.mcp.json 的 command=node 时的解释器回退启动器（issue #234）。
// 探测顺序、Store 桩排除、spawn 参数与 stdio/信号/退出接线全部用 stub 锁定。

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const path = require('node:path');

const { CANDIDATES, usable, defaultProbe, pickInterpreter, main } = require(path.join(__dirname, '..', 'mcp-launch.cjs'));

const PROBE_OK = { status: 0, stdout: 'Python 3.12.9\n', stderr: '' };
const STORE_STUB = { status: 49, stdout: '', stderr: 'Python was not found; run without arguments to install from the Microsoft Store...\n' };
const ENOENT = { error: Object.assign(new Error("spawn python3 ENOENT"), { code: 'ENOENT' }), status: null };

test('usable 只认退出码 0 且输出 Python 3 版本行的探测结果', () => {
  assert.equal(usable(PROBE_OK), true);
  // Python 2 残留与项目 3.8+ 要求不符，不通过。
  assert.equal(usable({ status: 0, stdout: 'Python 2.7.18\n' }), false);
  // Windows Store 桩：PATH 真实文件、存在性检查全过，只有执行能区分。
  assert.equal(usable(STORE_STUB), false);
  assert.equal(usable({ status: 0, stdout: '', stderr: '广告' }), false);
  // 退出码 0 且 stdout 非空但不是 Python 版本行的同名包装脚本不通过。
  assert.equal(usable({ status: 0, stdout: 'some wrapper banner\n' }), false);
  // 版本字样出现在行中段（无行首锚）的包装脚本同样不通过。
  assert.equal(usable({ status: 0, stdout: 'uses embedded Python 3.10 runtime\n' }), false);
  // 非完整版本号的 "Python 3" 前缀（正则的 \.\d 段）不通过。
  assert.equal(usable({ status: 0, stdout: 'Python 3\n' }), false);
  // 退出码非 0 时不看 stdout（broken shim 打印版本行也不放行）。
  assert.equal(usable({ status: 1, stdout: 'Python 3.12.9\n' }), false);
  assert.equal(usable(ENOENT), false);
  assert.equal(usable(undefined), false);
  assert.equal(usable(null), false);
});

test('defaultProbe 以 --version 探测且 windowsHide', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-launch-probe-'));
  try {
    // 不能用 node -e：node 会把尾部的 --version 当自身旗标拦截，须用脚本文件。
    const fake = path.join(tmp, 'fake-interpreter.cjs');
    fs.writeFileSync(fake, [
      "if (process.argv.includes('--version')) process.stdout.write('Python 3.12.9 (fake)\\n');",
      '',
    ].join('\n'));
    const picked = { command: process.execPath, args: [fake] };
    const result = defaultProbe(picked);
    assert.equal(result.status, 0);
    assert.match(String(result.stdout), /^Python 3\./);
    assert.equal(usable(result), true);
    // 探测参数锁定：--version 在位、Windows 隐藏窗口（可注入 spawnSync 才锁得住）。
    const recorded = [];
    defaultProbe(picked, (cmd, args, options) => {
      recorded.push([cmd, args, options]);
      return PROBE_OK;
    });
    assert.equal(recorded.length, 1);
    assert.deepEqual(recorded[0][1], [fake, '--version']);
    assert.equal(recorded[0][2].windowsHide, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('探测候选与 hooks 回退链同序：python3 → python → py -3', () => {
  assert.deepEqual(CANDIDATES.map((c) => c.command), ['python3', 'python', 'py']);
  assert.deepEqual(CANDIDATES[2].args, ['-3']);
});

test('pickInterpreter 首个可用者胜出且不再探测后续候选', () => {
  const probed = [];
  const picked = pickInterpreter((candidate) => {
    probed.push(candidate.command);
    return candidate.command === 'python3' ? PROBE_OK : ENOENT;
  });
  assert.deepEqual(picked, { command: 'python3', args: [] });
  assert.deepEqual(probed, ['python3']);
});

test('pickInterpreter 跳过缺失的 python3 与 Store 桩 python，落到 py -3', () => {
  const probed = [];
  const picked = pickInterpreter((candidate) => {
    probed.push(candidate.command);
    if (candidate.command === 'python3') return ENOENT;
    if (candidate.command === 'python') return STORE_STUB;
    return PROBE_OK;
  });
  assert.deepEqual(picked, { command: 'py', args: ['-3'] });
  assert.deepEqual(probed, ['python3', 'python', 'py']);
});

test('pickInterpreter 全部候选不可用时返回 undefined', () => {
  assert.equal(pickInterpreter(() => ENOENT), undefined);
});

function fakeStd() { return new PassThrough(); }

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = fakeStd();
  child.stdout = fakeStd();
  child.stderr = fakeStd();
  child.kills = [];
  child.kill = (signal) => { child.kills.push(signal); return true; };
  return child;
}

function fakeIo() {
  return { stdin: fakeStd(), stdout: fakeStd(), stderr: fakeStd() };
}

// 让 stderr 的诊断写入同时可断言；main 只认流对象，不设额外回调通道。
function spying(stream, log) {
  const original = stream.write.bind(stream);
  stream.write = (chunk, ...rest) => { log.push(String(chunk)); return original(chunk, ...rest); };
  return stream;
}

test('main 缺脚本路径参数时诊断并以 127 退出，不 spawn', () => {
  const io = fakeIo();
  const written = [];
  spying(io.stderr, written);
  const spawned = [];
  const exits = [];
  main(['node', 'mcp-launch.cjs'], {
    ...io,
    spawn: (...args) => { spawned.push(args); return fakeChild(); },
    exit: (code) => exits.push(code),
    onSignal: () => {},
  });
  assert.deepEqual(exits, [127]);
  assert.equal(spawned.length, 0);
  assert.match(written.join(''), /missing usage_mcp\.py path/);
});

test('main 无可用解释器时诊断候选清单并以 127 退出', () => {
  const io = fakeIo();
  const written = [];
  spying(io.stderr, written);
  const spawned = [];
  const exits = [];
  main(['node', 'mcp-launch.cjs', '/plugin/usage_mcp.py'], {
    ...io,
    spawn: (...args) => { spawned.push(args); return fakeChild(); },
    runProbe: () => ENOENT,
    exit: (code) => exits.push(code),
    onSignal: () => {},
  });
  assert.deepEqual(exits, [127]);
  assert.equal(spawned.length, 0);
  assert.match(written.join(''), /tried python3, python, py -3/);
});

test('main 用选中的解释器 spawn 脚本，stdio 全管道且 Windows 隐藏窗口', () => {
  const io = fakeIo();
  const spawned = [];
  const child = fakeChild();
  main(['node', 'mcp-launch.cjs', '/plugin/usage_mcp.py'], {
    ...io,
    spawn: (...args) => { spawned.push(args); return child; },
    runProbe: () => PROBE_OK,
    exit: () => {},
    onSignal: () => {},
  });
  assert.equal(spawned.length, 1);
  const [command, args, options] = spawned[0];
  assert.equal(command, 'python3');
  assert.deepEqual(args, ['/plugin/usage_mcp.py']);
  assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(options.windowsHide, true);
});

test('main 按探测结果透传 py -3 的参数形态', () => {
  const io = fakeIo();
  const spawned = [];
  main(['node', 'mcp-launch.cjs', '/plugin/usage_mcp.py'], {
    ...io,
    spawn: (...args) => { spawned.push(args); return fakeChild(); },
    runProbe: (candidate) => (candidate.command === 'py' ? PROBE_OK : ENOENT),
    exit: () => {},
    onSignal: () => {},
  });
  assert.deepEqual(spawned[0][1], ['-3', '/plugin/usage_mcp.py']);
});

test('main 接线：stdin→child.stdin、child.stdout/stderr→进程 stdout/stderr', () => {
  const io = fakeIo();
  const child = fakeChild();
  const piped = [];
  const track = (source) => { source.pipe = (dest) => { piped.push([source, dest]); return dest; }; return source; };
  track(io.stdin); track(child.stdin); track(child.stdout); track(child.stderr);
  main(['node', 'mcp-launch.cjs', '/plugin/usage_mcp.py'], {
    ...io,
    spawn: () => child,
    runProbe: () => PROBE_OK,
    exit: () => {},
    onSignal: () => {},
  });
  assert.deepEqual(piped, [[io.stdin, child.stdin], [child.stdout, io.stdout], [child.stderr, io.stderr]]);
});

test('main 注册 SIGINT/SIGTERM/SIGHUP 转发到子进程', () => {
  const io = fakeIo();
  const child = fakeChild();
  const registered = {};
  const handlers = {};
  main(['node', 'mcp-launch.cjs', '/plugin/usage_mcp.py'], {
    ...io,
    spawn: () => child,
    runProbe: () => PROBE_OK,
    exit: () => {},
    onSignal: (signal, handler) => { registered[signal] = true; handlers[signal] = handler; },
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    assert.equal(registered[signal], true, signal);
    handlers[signal]();
  }
  assert.deepEqual(child.kills, ['SIGINT', 'SIGTERM', 'SIGHUP']);
});

test('main 在 child close 后先排空管道再退出，异常退出码为 1', async () => {
  for (const [closeCode, expected] of [[0, 0], [null, 1], [2, 2]]) {
    const io = fakeIo();
    const child = fakeChild();
    const exits = [];
    main(['node', 'mcp-launch.cjs', '/plugin/usage_mcp.py'], {
      ...io,
      spawn: () => child,
      runProbe: () => PROBE_OK,
      exit: (code) => exits.push(code),
      onSignal: () => {},
    });
    child.emit('close', closeCode, closeCode === null ? 'SIGKILL' : null);
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(exits, [expected], `close(${closeCode})`);
  }
});

test('main 的退出发生在 stdout/stderr 排空回调之后（顺序锁定）', async () => {
  const io = fakeIo();
  const child = fakeChild();
  const events = [];
  const tracking = (stream, label) => {
    const original = stream.write.bind(stream);
    stream.write = (chunk, ...rest) => {
      const cb = rest.find((item) => typeof item === 'function');
      const wrapped = cb
        ? (...cbArgs) => { events.push(`drained:${label}`); return cb(...cbArgs); }
        : undefined;
      return original(chunk, wrapped);
    };
    return stream;
  };
  main(['node', 'mcp-launch.cjs', '/plugin/usage_mcp.py'], {
    stdin: io.stdin,
    stdout: tracking(io.stdout, 'stdout'),
    stderr: tracking(io.stderr, 'stderr'),
    spawn: () => child,
    runProbe: () => PROBE_OK,
    exit: (code) => events.push(`exit:${code}`),
    onSignal: () => {},
  });
  child.emit('close', 0, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['drained:stdout', 'drained:stderr', 'exit:0']);
});

test('child.stdin EPIPE（Python 先死、宿主仍有在途写入）不崩溃，退出仍由 close 驱动', async () => {
  const io = fakeIo();
  const child = fakeChild();
  const exits = [];
  main(['node', 'mcp-launch.cjs', '/plugin/usage_mcp.py'], {
    ...io,
    spawn: () => child,
    runProbe: () => PROBE_OK,
    exit: (code) => exits.push(code),
    onSignal: () => {},
  });
  child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  io.stdin.emit('error', Object.assign(new Error('read EPIPE'), { code: 'EPIPE' }));
  child.emit('close', 0, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(exits, [0]);
});

test('main spawn 失败（error 事件）时诊断并以 127 退出', () => {
  const io = fakeIo();
  const child = fakeChild();
  const written = [];
  spying(io.stderr, written);
  const exits = [];
  main(['node', 'mcp-launch.cjs', '/plugin/usage_mcp.py'], {
    ...io,
    spawn: () => child,
    runProbe: () => PROBE_OK,
    exit: (code) => exits.push(code),
    onSignal: () => {},
  });
  child.emit('error', new Error('spawn python3 ENOENT'));
  assert.deepEqual(exits, [127]);
  assert.match(written.join(''), /failed to start python3/);
});

// stub 锁不住真实管道行为：本机有可用 Python 时才跑这一条（按环境跳过需报告）；
// timeout 防止极端环境下真实管道挂起拖死整个套件。
test('端到端：launcher 真实拉起 Python 并透传 stdin/stdout', { skip: pickInterpreter() === undefined ? '本机无可用 Python 解释器' : false, timeout: 15000 }, async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const { spawn } = require('node:child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-launch-e2e-'));
  t.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
  const script = path.join(tmp, 'echo.py');
  fs.writeFileSync(script, 'import sys\nsys.stdout.write(sys.stdin.readline())\n');
  const launcher = path.join(__dirname, '..', 'mcp-launch.cjs');
  const child = spawn(process.execPath, [launcher, script], { stdio: ['pipe', 'pipe', 'pipe'] });
  const chunks = [];
  child.stdout.on('data', (chunk) => chunks.push(chunk));
  const closed = new Promise((resolve) => child.on('close', resolve));
  child.stdin.end('ping-through\n');
  const code = await closed;
  assert.equal(code, 0);
  assert.equal(Buffer.concat(chunks).toString(), 'ping-through\n');
});
