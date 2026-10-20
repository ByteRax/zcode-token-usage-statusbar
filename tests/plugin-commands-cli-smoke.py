# -*- coding: utf-8 -*-
"""真实 ZCode.app 的离线命令回归；复用 plugin-cli-smoke 的 macOS 沙箱，不运行安装器。"""
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import re
import sys
import tempfile


REPOSITORY = Path(__file__).resolve().parents[1]
PLUGIN = "zcode-token-usage-statusbar"
COMMANDS = ("usage", "install-overlay", "uninstall-overlay")
SPEC = importlib.util.spec_from_file_location("plugin_cli_smoke", REPOSITORY / "tests/plugin-cli-smoke.py")
SMOKE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SMOKE)
require = SMOKE.require


def instrument_bundle(text):
    # 仅改临时副本的自动 main 调用并暴露现存函数；现存实现一字不改。
    # 依赖 bundle 保留的函数名标签；布局变更必须明确失败，不能退回模拟 catalog。
    exports = {}
    initializers = []
    for label in ("listZCodeCustomCommands", "loadZCodeCustomCommand", "listProtocolSlashCommands",
                  "expandCustomCommandPrompt", "expandCliCustomCommandPrompt", "parseSlashCommand",
                  "handlePluginsCommand", "normalizeMcpToolDescriptor"):
        matches = list(re.finditer(r'\br\(([\w$]+),"' + label + r'"\)', text))
        require(len(matches) == 1, "bundle 函数标签不唯一/缺失: " + label)
        match = matches[0]
        exports[label] = match.group(1)
        init = list(re.finditer(r'([\w$]+)=[\w$]\(\(\)=>\{', text[:match.start()]))
        require(bool(init), "无法定位 bundle 惰性初始化器: " + label)
        initializer = init[-1].group(1)
        if initializer not in initializers:
            initializers.append(initializer)
    entry = r';([\w$]+)\(\);async function \1\(\)\{let [\w$]+=process\.argv\.slice\(2\);'
    matches = list(re.finditer(entry, text))
    require(len(matches) == 1, "无法唯一禁用临时 bundle 的自动 CLI 入口")
    match = matches[0]
    call = ";" + match.group(1) + "();"
    require(text[match.start():].startswith(call), "自动入口调用边界不匹配")
    text = text[:match.start()] + ";" + text[match.start() + len(call):]
    trailer = "\n" + ";".join(name + "()" for name in initializers) + ";\nmodule.exports = {" + ",".join(
        label + ":" + symbol for label, symbol in exports.items()) + "};\n"
    return text + trailer


def command_fixture(cli):
    manifest = {"name": PLUGIN, "version": "1.0.0", "commands": "commands"}
    SMOKE.write_json(cli.plugin / ".zcode-plugin/plugin.json", manifest)
    SMOKE.write_json(cli.market / "marketplace.json", {
        "name": SMOKE.MARKETPLACE,
        "plugins": [{"name": PLUGIN, "version": "1.0.0", "source": "./plugins/" + PLUGIN}],
    })
    for name in COMMANDS:
        destination = cli.plugin / "commands" / (name + ".md")
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes((REPOSITORY / "plugins" / PLUGIN / "commands" / destination.name).read_bytes())
    expected = {".zcode-plugin/plugin.json", *("commands/" + name + ".md" for name in COMMANDS)}
    require({str(p.relative_to(cli.plugin)) for p in cli.plugin.rglob("*") if p.is_file()} == expected,
            "fixture 混入了 hook/MCP/安装器或其他组件")
    cli.cli("marketplace", "add", str(cli.market))
    installed = cli.cli("install", SMOKE.PLUGIN_ID)
    require(installed["ok"] is True, "临时命令插件注册失败")
    cache = cli.inside(SMOKE.target(SMOKE.read_json(cli.record_file)["plugins"])["installPath"])
    require({str(p.relative_to(cache)) for p in cache.rglob("*") if p.is_file()} == expected,
            "临时插件缓存混入了可执行组件")
    return cache


def commands_json(cli, *args):
    stdout, stderr = cli.run([SMOKE.BUNDLE, "commands", *args, "--json"])
    require(not stderr.strip(), "commands 返回意外 stderr: " + stderr)
    data = json.loads(stdout)
    require(data["cwd"] == str(cli.cwd) and not data["diagnostics"], "命令扫描 cwd/diagnostics 异常")
    return data


def bundle_probe(cli, probe_bundle, tools):
    mcp = SMOKE.read_json(REPOSITORY / "plugins" / PLUGIN / ".mcp.json")
    probe_input = {"plugin": PLUGIN, "serverKeys": list(mcp["mcpServers"]), "tools": tools}
    harness = cli.root / "command-probe.cjs"
    harness.write_text(r"""
const assert = require('node:assert/strict');
const api = require(process.argv[2]);
const input = JSON.parse(process.argv[3]);
const options = { env: process.env, homeDirectory: process.env.HOME, workingDirectory: process.cwd() };
(async () => {
  // 真实 handler 无条件 await getApp；仅提供内存桩，绝不调用宿主 App。
  let getAppCalls = 0;
  const context = { getApp: async () => {
    getAppCalls++;
    return new Proxy({}, { get(target, key) {
      if (key === 'then') return undefined; // Promise 解析空对象，不是宿主方法。
      throw new Error('Host App access is forbidden: ' + String(key));
    } });
  } };
  const usage = 'Usage: /plugins [list|enable <plugin>|disable <plugin>|uninstall <plugin> --force]';
  const unsupportedChatCommands = [];
  for (const args of [
    'marketplace add ByteRax/zcode-token-usage-statusbar#plugin-releases',
    'marketplace add /absolute/path/to/zcode-token-usage-statusbar',
    'install zcode-token-usage-statusbar@zusage-marketplace',
    'marketplace update zusage-marketplace',
  ]) {
    for (const alias of ['plugin', 'plugins']) {
      const command = '/' + alias + ' ' + args;
      const parsed = api.parseSlashCommand(command);
      assert.deepEqual(parsed, { args, name: 'plugins', rawName: alias, type: 'known' });
      const result = await api.handlePluginsCommand(parsed.args, context);
      assert.deepEqual(result, { mode: undefined, response: usage });
      unsupportedChatCommands.push({ command, parsedName: parsed.name, response: result.response });
    }
  }
  assert.equal(getAppCalls, unsupportedChatCommands.length);
  assert.deepEqual(input.serverKeys, ['zusage']);
  assert.deepEqual(input.tools.map(tool => tool.name), ['token_usage']);
  const serverName = 'plugin:' + input.plugin + ':' + input.serverKeys[0];
  const descriptor = api.normalizeMcpToolDescriptor(serverName, input.tools[0]);
  assert.equal(descriptor.serverName, serverName);
  assert.equal(descriptor.toolName, 'token_usage');
  assert.equal(descriptor.name, 'mcp__plugin_zcode-token-usage-statusbar_zusage__token_usage');
  assert.equal(descriptor.name.length, 59);
  assert.ok(descriptor.name.length <= 64);
  const listed = await api.listZCodeCustomCommands(options);
  assert.deepEqual(listed.diagnostics, []);
  const catalog = await api.listProtocolSlashCommands(options);
  const expanded = [], missing = [];
  for (const name of ['usage', 'install-overlay', 'uninstall-overlay']) {
    const command = await api.loadZCodeCustomCommand({ ...options, name: '/' + name });
    assert.equal(command.metadata.name, name);
    const args = name === 'usage' ? 'days:3' : 'offline-smoke-no-execution';
    const core = api.expandCustomCommandPrompt({ command, args });
    const cli = api.expandCliCustomCommandPrompt({ command, args });
    assert.equal(core.prompt, cli.prompt);
    assert.equal(core.argumentCount, 1);
    assert.equal(core.usedArgumentsPlaceholder, true);
    assert.ok(core.prompt.startsWith('Run custom command /' + name + '.'));
    assert.ok(core.prompt.includes('用户附加要求：' + args));
    assert.ok(!core.prompt.includes('$ARGUMENTS'));
    expanded.push({ name, disableNonInteractive: command.metadata.disableNonInteractive,
      firstLine: core.prompt.split('\n')[0], argumentCount: core.argumentCount,
      usedArgumentsPlaceholder: core.usedArgumentsPlaceholder, coreMatchesCli: true });
    const prefixed = '/zcode-token-usage-statusbar:' + name;
    await assert.rejects(() => api.loadZCodeCustomCommand({ ...options, name: prefixed }),
      { message: 'Custom command not found: zcode-token-usage-statusbar:' + name });
    missing.push(prefixed);
  }
  console.log(JSON.stringify({ listed: listed.commands.map(c => ({ name: c.name,
    path: c.path, disableNonInteractive: c.disableNonInteractive })), catalog, expanded, missing,
    unsupportedChatCommands, appAccess: { getAppStubCalls: getAppCalls, hostAppAccess: false },
    mcpDescriptor: { serverName: descriptor.serverName, toolName: descriptor.toolName,
      name: descriptor.name, nameLength: descriptor.name.length, maximumNameLength: 64 },
    boundary: 'Actual bundle catalog + pure parsing/handler with memory App stub + descriptor/text expansion; no NDJSON session/UI/model execution' }));
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
""", encoding="utf-8")
    stdout, stderr = cli.run([harness, probe_bundle, json.dumps(probe_input)])
    warning = (r"\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n"
               r"\(Use `ZCode --trace-warnings \.\.\.` to show where the warning was created\)\n")
    require(not stderr.strip() or re.fullmatch(warning, stderr), "bundle probe 返回意外 stderr: " + stderr)
    require(not Path(cli.env["ZCODE_SESSION_DB_PATH"]).exists(), "纯函数 probe 不应创建会话数据库")
    result = json.loads(stdout)
    result["initializationStderr"] = stderr.strip()
    return result


def scope_probe(cli):
    # 复制真实 MCP 分派函数，数据渲染用内存桩替代；不连接任何真实数据库/配置/网络。
    module = cli.root / "usage_mcp.py"
    module.write_bytes((REPOSITORY / "plugins" / PLUGIN / "usage_mcp.py").read_bytes())
    harness = cli.root / "scope-probe.py"
    harness.write_text(r"""
import importlib.util
import json
import sys
import types
stub = types.ModuleType('zusage')
stub.L = lambda zh, en: zh
class Connection:
    closed = False
    def close(self): self.closed = True
connections = []
def connect():
    connection = Connection()
    connections.append(connection)
    return connection
stub.connect = connect
for name in ('current', 'today', 'days', 'sessions', 'models', 'session_detail', 'workspace'):
    setattr(stub, 'render_' + name, lambda con, *args, name=name: [name, *args])
sys.modules['zusage'] = stub
spec = importlib.util.spec_from_file_location('usage_mcp', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
cases = {'current': ['current'], 'now': ['current'], 'today': ['today'], 'week': ['days', 7],
    'days:3': ['days', 3], 'sessions': ['sessions', 10], 'sessions:5': ['sessions', 5],
    'models': ['models', 7], 'models:14': ['models', 14],
    'session:abc': ['session_detail', 'abc'], 'workspace:demo': ['workspace', 'demo']}
for scope, expected in cases.items():
    actual = module.tool_token_usage(scope)
    assert actual == expected, (scope, actual, expected)
    assert connections[-1].closed
assert module.tool_token_usage() == ['current']
assert '未知 scope' in module.tool_token_usage('unsupported')
assert all(con.closed for con in connections)
print(json.dumps({'cases': cases, 'tools': module.TOOLS}))
""", encoding="utf-8")
    stdout, _ = cli.run(["-e", "require('node:child_process').execFileSync(process.argv[1], "
                         "['-I', '-B', process.argv[2], process.argv[3]], {stdio: 'inherit'});",
                         sys.executable, harness, module])
    return json.loads(stdout)


def document_errors():
    errors = []
    for filename in ("README.md", "README.zh-CN.md", "README.en.md", "plugins/" + PLUGIN + "/README.md",
                     "docs/user-guide.md"):
        text = (REPOSITORY / filename).read_text(encoding="utf-8")
        if re.search(r"/plugins?\s+(?:marketplace\s+(?:add|update)|install)\b", text):
            errors.append(filename + " 仍推荐无效聊天安装/更新命令")
        if re.search(r"\bv1\.4\.[01]\b", text) or "尚未发布到正式渠道" in text or "not yet published to the stable channel" in text:
            errors.append(filename + " 仍使用过期正式版说明")
        if "#plugin-releases" not in text:
            errors.append(filename + " 未说明当前正式渠道")
        if "/" + PLUGIN + ":" in text:
            errors.append(filename + " 仍包含旧插件前缀命令")
        for name in COMMANDS:
            if "/" + name not in text:
                errors.append(filename + " 未说明裸名 /" + name)
    guide = (REPOSITORY / "docs/user-guide.md").read_text(encoding="utf-8")
    if "`startup|resume`" not in guide or "startup|clear|resume" in guide:
        errors.append("user-guide.md 的 SessionStart matcher 与真实配置不一致")
    if "宿主不支持的 `clear` matcher" in guide or "不依赖独立 `clear` 事件" not in guide or "清空后新会话走 `startup`" not in guide:
        errors.append("user-guide.md 未准确说明清空后的 startup 派发边界")
    for filename in ("restart_notice.py", "overlay_install.py"):
        text = (REPOSITORY / "plugins" / PLUGIN / filename).read_text(encoding="utf-8")
        if "/" + PLUGIN + ":" in text:
            errors.append(filename + " 的用户提醒仍包含旧插件前缀命令")
        for name in COMMANDS[1:]:
            if "/" + name not in text:
                errors.append(filename + " 的用户提醒未使用裸名 /" + name)
    usage = (REPOSITORY / "plugins" / PLUGIN / "commands/usage.md").read_text(encoding="utf-8")
    body = usage.split("---", 2)[2]
    for token in ('"current"', '"days:N"', '"sessions:N"', '"models:N"', '"workspace:<目录关键词>"'):
        if token not in body:
            errors.append("usage.md 正文未明确分派 " + token)
    if '"week" → scope=week（子命令 days 7）' not in body:
        errors.append("usage.md 未明确 week 的真实 CLI 回退 days 7")
    return errors


def main():
    require(sys.platform == "darwin", "仅支持 macOS sandbox-exec；禁止无沙箱回退")
    original = SMOKE.BUNDLE
    for path in (SMOKE.EXECUTABLE, original, SMOKE.SANDBOX):
        require(path.is_file(), "本机必需文件不存在: " + str(path))
    require(os.access(SMOKE.EXECUTABLE, os.X_OK) and os.access(SMOKE.SANDBOX, os.X_OK), "隔离执行器不可用")
    with (SMOKE.EXECUTABLE.parents[1] / "Info.plist").open("rb") as stream:
        info = plistlib.load(stream)
    with tempfile.TemporaryDirectory(prefix="zusage-command-cli-smoke-") as temporary:
        parent = Path(temporary).resolve()
        cli = SMOKE.IsolatedCLI(parent, "commands")
        cli.preflight()
        bundle_dir = cli.root / "glm"
        bundle_dir.mkdir()
        SMOKE.BUNDLE = bundle_dir / "zcode.cjs"
        bundle_text = original.read_text(encoding="utf-8")
        SMOKE.BUNDLE.write_text(bundle_text, encoding="utf-8")
        probe_bundle = bundle_dir / "command-catalog-probe.cjs"
        probe_bundle.write_text(instrument_bundle(bundle_text), encoding="utf-8")
        cache = command_fixture(cli)
        listing = commands_json(cli, "list")
        rows = listing["commands"]
        require(sorted(row["name"] for row in rows) == sorted(COMMANDS), "实际注册名不等于三个裸名")
        inspected = []
        for name in COMMANDS:
            inspection = commands_json(cli, "inspect", "/" + name)["command"]
            require(inspection["metadata"]["path"] == str(cache / "commands" / (name + ".md")),
                    "命令被其他根遮蔽")
            require(not inspection["truncated"] and "$ARGUMENTS" in inspection["content"], "命令正文不完整")
            inspected.append(inspection["metadata"])
            prefixed = "/" + PLUGIN + ":" + name
            stdout, stderr = cli.run([SMOKE.BUNDLE, "commands", "inspect", prefixed, "--json"], expected=1)
            require(not stdout.strip() and "Custom command not found: " + prefixed in stderr,
                    "旧前缀名不是明确的 not-found")
        scope_result = scope_probe(cli)
        probe = bundle_probe(cli, probe_bundle, scope_result["tools"])
        require(sorted(row["name"] for row in probe["listed"]) == sorted(COMMANDS), "CLI 与 bundle 发现结果不同")
        scopes = scope_result["cases"]
        report = {"appVersion": info["CFBundleShortVersionString"], "appBuild": info["CFBundleVersion"],
                  "isolation": cli.isolation, "commandsList": rows, "commandsInspect": inspected,
                  "bundleProbe": probe, "mcpScopeDispatch": scopes, "overlayInstallerExecuted": False,
                  "sessionOrModelStarted": False, "allTestCodeCopiedToTemporaryRoot": True}
        print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
        errors = document_errors()
        catalog_errors = []
        visible = {row["name"]: row for row in probe["catalog"]}
        for name in COMMANDS:
            if name not in visible or visible[name].get("source") != "custom":
                catalog_errors.append("protocol slash catalog 未显示 /" + name)
            else:
                require(visible[name]["inputHint"].startswith("/" + name), "catalog 的 inputHint 非裸名")
        require(not any(name.startswith(PLUGIN + ":") for name in visible), "catalog 出现旧前缀名")
    require(not parent.exists(), "临时目录未自动清理")
    require(not catalog_errors, "命令 catalog 回归失败（真实引擎行为，优先修复）: " + "; ".join(catalog_errors))
    require(not errors, "文档断言失配（与 catalog 行为无关，对齐文档或断言）: " + "; ".join(errors))
    print(json.dumps({"ok": True, "temporaryRootRemoved": True, "temporaryRoot": str(parent)}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("FAIL（停止执行，无隔离回退）: " + str(error), file=sys.stderr)
        sys.exit(1)
