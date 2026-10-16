---
description: 从本机 ZCode 桌面客户端卸载悬浮用量状态条（重启客户端生效，此后 hook 不再提示）
---
从本机 ZCode 桌面客户端卸载 zcode-token-usage-statusbar 的悬浮状态条。

执行：用 Bash 运行（插件根目录 = 本命令文件所在目录的上一级）：

    python3 "<插件根目录>/overlay_install.py" remove

结果处理：

- 成功（含"当前 asar 未注入"）：告知用户「重启 ZCode 后浮层消失」。卸载会写豁免标记，SessionStart hook 此后不再提示、也不再自动安装。
- 权限不足（Linux `/opt` 等系统位置）：若当前确未注入，安装器会自动免 root 放行并写豁免标记，无需 sudo。只有确已注入时才会要求 sudo；把安装器输出的 `sudo env HOME="$HOME" PATH="$PATH" python3 ... remove` 原样转述给用户执行（务必保留 `HOME`/`PATH`，否则 sudo 默认会重置它们导致找不到 node/运行时目录）。
- 失败（替换失败待收尾）：让用户完全退出 ZCode 后重跑同一条命令。
- 若用户只是暂时不想看到提示（不想卸载浮层）：改为创建豁免标记即可，不要执行 remove：
  `mkdir -p ~/.zcode/zcode-token-usage-statusbar && touch ~/.zcode/zcode-token-usage-statusbar/.plugin-overlay-optout`
  说明：删除该文件可恢复提示。

用户附加要求：$ARGUMENTS
