# 发布前检查

在发布 worktree 根目录执行，只读。

## VERSION 代际检查

`overlay.js` 里 `var VERSION = "vNN";` 同一行的注释是代际台账（`// vA … → vB …`，热修可用 `v99.1` 这样的小数号）。要求台账按时间线严格递增、末项等于 `VERSION`。并行线各自递增会出现「同号不同义」，热修条目也可能被插到台账最前面，发版前必须发现。根 `overlay.js` 与插件副本是否一致由 `python3 sync_plugin.py --check` 负责，这里只查根文件：

```bash
python3 -B - <<'PY'
import re
line = next(l for l in open("overlay.js", encoding="utf-8") if "var VERSION =" in l)
cur = re.search(r'VERSION = "v(\d+(?:\.\d+)?)"', line).group(1)
items = re.findall(r'(?://\s*|→\s*)v(\d+(?:\.\d+)?)', line)
key = lambda s: tuple(int(p) for p in s.split("."))
bad = [(a, b) for a, b in zip(items, items[1:]) if key(a) >= key(b)]
ok = not bad and items[-1] == cur
why = "; ".join("v%s 之后出现 v%s" % p for p in bad[:3]) or "末项 v%s 不等于 VERSION" % items[-1]
print("VERSION=v%s 链长=%d %s" % (cur, len(items), "OK" if ok else "不连贯: " + why))
PY
```

发现撞号或乱序：按合入时间线重排（例如把前置的 `v99.1` 条目移到 `v99` 与 `v100` 之间），改根 `overlay.js` 后 `python3 sync_plugin.py`，并同步所有断言该代际号的测试。`web/overlay.js` 有独立 `VERSION`，不在此检查内。

## 升级链验证

在野旧版本用**自带的** `release_unpack.py` 校验下载的新 ZIP。包内文件集变化而两份 manifest 没声明 `packageLayout`，旧解包器会按自己的历史文件集精确比对而拒绝：v1.4.4 与 v1.5.0 各新增了包内文件却未声明，致使 ≤1.4.5 的在野版本无法升级到 v1.5.0。`build` 现在会拦声明漂移，但解包器兼容性仍须实测。

`build` 之后、发布之前，在项目 worktree 里用历史 tag 的解包器各校验一次，**任何一版拒绝或取不到都不得发布**。tag 列表写字面量（zsh 不会拆分未加引号的变量），`vLAST` 换成上一个正式 tag，其间发过版的 tag 一并加入：

```bash
OUT=/new/artifact-directory          # build 的输出目录
FAIL=0
for PREV in v1.4.0 v1.4.5 vLAST; do
  U=$(mktemp -d)
  if git show "${PREV}:release_unpack.py" > "$U/unpack.py" \
     && python3 -B "$U/unpack.py" --archive "$OUT/zcode-token-usage-statusbar-vX.Y.Z.zip" --manifest "$OUT/release-manifest.json" \
          --repository OWNER/REPO --version X.Y.Z --output "$U/out" >"$U/log" 2>&1; then
    echo "${PREV} 解包器：通过"
  else
    echo "${PREV} 解包器：拒绝或无法取得（$(tail -1 "$U/log" 2>/dev/null | cut -c1-80)）"; FAIL=1
  fi
  rm -rf "$U"
done
[ "$FAIL" = 0 ] && echo "升级链验证：全部通过" || { echo "升级链验证：失败，禁止发布"; false; }
```

- 变量必须写成 `${PREV}`：zsh 会把 `$PREV:release_unpack.py` 里的 `:r` 当作路径修饰符吞掉，得到空文件。
- `git show` 失败（tag 写错、忘改 `vLAST`）会走「拒绝或无法取得」分支并置 `FAIL=1`，不会假通过；最后一行以非零退出码结束，不必只靠读文本判定。
- `--output` 必须是尚不存在的目录，所以用 `$U/out`。
- v1.4.0 是最早含 `packageLayout` 宽松分支的在野解包器，v1.4.5 是 1.4 线末版。
- 发布并推送渠道之后，对**真实下载的资产**再跑一遍同样的循环（`OUT` 换成下载目录）。

## 重启要求

主进程加载的冷文件变更后，用户必须完全退出 ZCode 再启动，更新说明必须写明。权威清单是 `plugin-updater.cjs` 里的 `cold` 判定（先 `grep -n cold plugin-updater.cjs` 核对清单没有漂移，当前为 `inject-main.cjs`、`plugin-updater.cjs`、`plugin-release.cjs`、`plugin-storage.cjs`、`quota-client.cjs`）。改写 `app.asar` 的注入/渲染端桥文件同样需要完全重启。用上一正式 tag 到发布提交的 diff 判定，不凭印象：

```bash
git diff --name-only PREV_TAG..TARGET -- inject-main.cjs plugin-updater.cjs plugin-release.cjs plugin-storage.cjs quota-client.cjs renderer_bridge.py patch_install.py
```

有输出：「安装与升级注意」写明「完全退出 ZCode（所有窗口，托盘退出而非只关窗口）再重新打开」，只关窗口、刷新页面或重开会话无效。无输出：只涉及热更新文件，也要按 `AGENTS.md` §3 确认实际加载路径后再写「无需重启」。
