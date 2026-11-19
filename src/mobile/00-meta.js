// ==UserScript==
// @name         ZCode 用量状态条（远控中继接收端）
// @namespace    zusage-mobile
// @version      0.1.1
// @description  在 ZCode Web 远程控制页面渲染 token 用量；仅在确认宿主支持后同步显示偏好
// @downloadURL  https://raw.githubusercontent.com/ByteRax/zcode-token-usage-statusbar/main/zusage-mobile.user.js
// @updateURL    https://raw.githubusercontent.com/ByteRax/zcode-token-usage-statusbar/main/zusage-mobile.user.js
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
 * 本文件是构建产物：源码分片在 src/mobile/，构建时直接嵌入与桌面
 * build_overlay.assemble_bytes 相同的完整 overlay。接收端仅适配传输与诊断，
 * 状态条、图标、样式、设置和 tooltip 均由同一份桌面代码创建，不提供独立 fallback。 */
