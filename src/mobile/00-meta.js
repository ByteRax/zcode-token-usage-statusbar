// ==UserScript==
// @name         ZCode 用量状态条（远控中继接收端）
// @namespace    zusage-mobile
// @version      0.6.0
// @description  在 ZCode Web 远程控制页面渲染与桌面状态条同源的 token 用量 chips（observe-only，不向 WebSocket 写入任何字节）
// @match        https://zcode.z.ai/remote/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

/* 配套：zcode-token-usage-statusbar 桌面插件 mobile-relay 功能（specs/mobile-relay.md）。
 * 协议：官方中继 ws2 的 rpc-frame 信封内是 @zcode/rpc 二进制（[1B tag][VQL len][data]）。
 * 本脚本监听 WebSocket message，重组单分片帧，识别 EventFire(204)+魔数 id 的插件帧。
 * 官方页面 ChannelClient 对未知 id 静默丢弃，本脚本零干扰。
 *
 * 本文件是构建产物，不要直接改 docs/zusage-mobile.user.js：源码分片在 src/mobile/，
 * 回退条中「照抄桌面」的内容（格图标/格样式/TPS 色档/显示项行）由
 * scripts/build_mobile_userscript.py 从桌面 src/overlay/ 分片按锚点注释提取注入
 * （specs/mobile-userscript-build.md），桌面更新后重新构建即自动同步。 */
