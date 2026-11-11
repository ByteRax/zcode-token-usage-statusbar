  /* ---------- 实例工厂（v61.1）：一个 pane 一套 条/面板/气泡/tooltip/定位循环。
   * slot 0 保留 #zusage-bar/#zusage-tip 兼容 id（泵热更新按它清理），其余实例仅类名。 */
  function spawnInstance(pid, slot) {
    /* VERSION 台账（按合入顺序顺延，每行一项；build_overlay.py 构建时自动收敛为同行注释）：
     * v82 统计行锚点深度查找（新会话结构嵌套在 group/assistant-turn 内容列内）→ v83 万/亿单位开关（默认开、仅中文）+ K/M/B 的 B 档
     * → v84 主标签页远端路由（工作台分组唯一主绑定上报 + 迟到载荷守卫，issue #30）→ v85 回答末尾统计行跟随万/亿开关 + tok→token
     * → v86 历史轮 tracker 无记录（窗口滑出/换代/热更）或缺输出字段不再翻成"本轮统计不可用"，加 det 诊断
     * → v87 主叶归属增 last-session 回退（组零证据时唯一远端记录放行，issue #30 复测：单会话主标签页不建组）→ v88 运行态心跳与两处扫描 tick 2s→0.5s（富文本重试 6→24 次等价放大）→ v89 ⚙ 面板更新进度：downloading 阶段文案 + 下载（字节）/安装（校验→安装→同步）双进度条，缺 progress 的旧主进程自动隐藏
     * → v90 主标签页/分栏归属改按本窗会话节点身份（renderer 桥按版本/资产/锚点写 SessionPane 属性，移除 workbench-groups/last-session 共享回退）+ 心跳 0.5s→0.1s（扫描维持 0.5s）→ v91 设置页/权限面板冒条修复（PR #44：inSettingsView 三处派发排除 + anchorCardOf 面板锚点改判）收编收尾：排除标记并集（settings-page testid + content/panel 双 frame）、track 显隐第四处防御
     * → v92 ⚙ 更新区固定显示可复制的重装口令（源码安装无法自动更新时引导用户发给 agent）→ v93 原生上下文按钮（chat-context-usage-trigger）增强：环填充/四档色/右侧百分比镜像状态条上下文格（ctxBandOf 同源），cw 缺失还原原生形态
     * → v94 状态条删除「上下文容量」格（UI+tooltip，该口径由原生按钮增强承载），⚙ 面板同步去掉「上下文」开关，子代理格改始终展示（零值也显示）→ v95 ⚙ 更新区去掉 v92 重装口令提示块（源码清单的仓库来源改由宿主插件管理器直接更新，不再报渠道不一致），更新来源文案增「仓库源码」分支→ v96 套餐额度 chip（默认关）：挂原生上下文按钮左侧（wrapper 内前插，与按钮增强同款双 reapply/还原），数据来自主进程 quota 字段（解密宿主 OAuth 凭据直查 monitor 端点，账号级套餐池口径），会话首个 main_turn 完成前不显示；自绘 tooltip 走 rateTip 独立浮层模式；chip 改多窗分段：每窗一段（中文 5小时/7天，英文 5h/7d）各自按 80/95/100 档位色，分隔符 |；余额类型单段渲染就绪（余额 ¥100.00，阶段 3 数据源接入即用）；去掉环形，容器不着色
     * → v97 子代理速率（T1+T2）：zusage sub 汇总加 rate_avg/每子代理 tps_avg（已完成段加权平均，口径同 _turn_rate），子代理格 tooltip/明细面板展示；Agent 运行期主 chip 附加「子代理运行中 · 估 X t/s」——turn-stats 透传 subagent 行 childSessionId，overlay 据此用同款 zuTryBindStore 绑子代理会话 store 做字符增量估算（运行中请求未入库，DB 无实时数据；150s 采样实锤零 running 行），思考文本不进 rows 时退回纯状态词；工具动词「正在运行子智能体」压成「子代理运行中」（web 同步文案）；同日多槽位化：turn-stats 暴露 runningSubagents 全集（并行时 rowId 前 8 个），每子代理独立绑定/2s 节流，主 chip 显示合计速率（并行 ≥2 时动词后缀 ×N），chip tooltip 与子代理明细面板逐个实时展示运行中估算（tooltip 随原地改字同步 __tip 重画；面板 800ms tick 原地刷新 .subrate，汇总页运行块含 DB 尚无记录的新子代理）
     * → v98 额度实时选源恢复（v4-model-config 观察 + quota-providers 全窗快照上报 + byProvider 定向刷新、空选择 fail-closed）与 sub2api 额度 UI（今日/本月窗口、窗口行内金额明细、Key 总额度、订阅截止、账户余额标题）
     * → v99（主线并流）tooltip 伪边界 leave 过滤：Chrome 悬停链收缩/重算会补发 DOM 内部的 documentElement/tip mouseleave，tipLeaveAt 贴边判定后取触发时刻最深 :hover 元素甄别，仍悬停在本档具体元素上即伪 leave 一律忽略交回 mousemove 流（主线 v100 滚动豁免=本链 v106 同义，不另列）
     * → v99.1（主线并流）apiKey 模式 BigModel/Z.ai（bigmodel-api[-N]/zai-api[-N]）额度 chip 标题家族判定（issue #68；数据链在 quota-client）
     * → v99.2 思考中计时随语言本地化（中文「1 时 2 分 3 秒」/英文「1 h 2 m 3 s」，空格分隔、零段照旧省略）；回答末尾行采样时刻改完整中文日期时间（⏱ 2026 年 10 月 23 日 11 点 20 分 28 秒，token_rate.py format_turn_line 同步改版）
     * → v100 设置面板分区导航（ZCode 设置侧栏同款：左栏三组分区导航 + 内容区单分区显隐，激活项 aria-current="page"，选择持久化 zusage3.sec；面板窄于 620px 时导航收成 icon rail）
     * → v101 设置面板高度在打开瞬间按内容自然高锁定（切分区不再抖动，resize 只收紧不放大）
     * → v102 额度源预设模板（CC Switch/magpie 同款选模板只填 Key：官方域变体 chip 一键写入 secrets baseUrl，minimax 可信域机制推广到 siliconflow 币种随域；deepseek/openrouter/kimi/anthropic/mimo/volcano 附控制台取 Key 链接，走 openExternal 桥）
     * → v103 额度源列表卡片化布局（每源圆角卡片+间距，凭据框限宽 420px，长说明段落补水平边距；纯 CSS，结构行为不变）
     * → v104 源状态文案补 disabled=已关闭映射 + 主进程对显式关闭源统一报 disabled（修「开关已关却显示待查询」矛盾）；刷新/获取 Key 按钮补 title 提示，关闭源的刷新按钮禁用
     * → v105 「上下文容量」弹层（hover-card-content）内压缩上下文按钮：命中率行下方全宽胶囊按钮（原生 secondary 配色全走客户端语义变量），弹层关即卸载（Radix 无 forceMount）故 body MutationObserver + heavy 对账双触发、DOM 存在性幂等（多实例安全），插入锚=「剩余额度」border-t 段前（缺则容器尾）+位置兜回；点击弹原生 AlertDialog 视格确认框（遮罩/Esc/外点关闭、Enter 确认），确认后优先走 fiber 上原生残留的 onSendCompressionCommand("/compact")（SessionPane 压缩入口，不动输入框草稿），缺失回落官方 E2E 输入桥 __zcodeLexicalInputE2E.setText + 发送键（Lexical 直写 DOM 不生效，禁用该路径；草稿非空拒绝）
     * → v106 额度 tooltip 滚动豁免：hideTipsOnScroll 不再收 quotaTip（chip 固定 composer 工具行与 gitTip 同理），修思考中流式输出自动滚动致悬停弹出即灭；chip 随宿主重建 detach（无 mouseleave）由 scanRateLines 加 isConnected 健康检查兜底收起
     * → v107 压缩确认框补行为提示：压缩进行中发送新消息/停止会打断压缩（实测 16:27 新 turn 启动同秒 compact turn TURN_CANCELLED，cancelled_by_user=1；引擎对该次摘要流挂起 134s 无首 token 也不重试 retryable=0），确认框加 hint 行中性告知
     * → v108 压缩主通道按用户指定改为字面 "/compact" 输入提交（E2E 桥 setText+发送键；流式中 v4-stop 可见/草稿非空/发送键 disabled 三重拒绝），fiber 命令信封降兜底；hint 升级为「通常需 2-4 分钟且无进度反馈」（DB 实证：全库 compact 请求无首 token 但正常完成，72s-9.6min，14:44 同会话同模型 165s 成功先例；16:25/16:43 两次「卡住」实为 2m20s 被新消息 TURN_CANCELLED，非故障）
     * → v109 压缩主通道按用户指定改回直接调会话发送接口（fiber onSendCompressionCommand 命令信封：不碰输入框/发送键、流式中交引擎排队，修字面输入通道在生成中被发送键禁用卡住的问题），字面 "/compact" 输入提交降兜底（三重门控仅作用于兜底）
     * → v110 压缩提交函数改在弹框打开瞬间（弹层必存活、锚点几何可信）解析并缓存，修复确认时弹层已被 Radix 卸载、几何重解析退化为「离视口左上角最近」致多分栏把 /compact 发进错误会话（P1）；兜底字面输入通道的流式/发送键/草稿三重门控全部前置到 setText 之前（拒绝不再残留草稿）；Enter 确认限定焦点在弹框内（无焦点陷阱下防焦点外 Enter 误触发确认）
     * → v111 额度 chip 默认展示：quota_enabled 缺省开（显式 false 才关，真值链在 inject-main）；chip 二级门控 not_configured/unsupported 从静默隐藏改中性灰提示「额度 未配置/暂不支持」（源被 ⚙ 显式关闭仍隐藏），tooltip 补 info 分支引导配置
     * → v112 Start Plan 免费档池（quota-client 新增 zcode-start 适配器走 zcode.z.ai billing/balance 独立链，与 coding plan 的 monitor 端点分池；选源路由与 quotaFamily 判定补 start-plan 分支修 start-plan pane 误读 GLM Coding Max 池；chip 增「套餐」分段（windows.plan，one_time 发放池聚合已用%），tooltip 套餐池行按 expires 标记切「到期」措辞）
     * → v113 夜间审计加固：quotaBalanceText 内建转义（currency 是远程响应字符串，chip/tooltip 双 innerHTML sink；parts label/amount 单次转义修双重转义；「其他源」行标签转义归位；aria-label 走 plain 纯文本变体不读实体）→quotaTip 补内容签名幂等 __zuTipSig（同 gitTip，悬停期间周期对账不再打断文本选择）→子代理明细面板数据签名幂等（滚动位置/选择不被每 1.5s 推送整面板重建重置；运行中估算仍由面板 800ms tick 原地刷新）→额度 chip 签名重写保留 zu-qbusy（点击刷新动画不被推送截断，同 git chip）→⚙ 源列表 id/label/preset/keyUrl 属性级转义 aEsc（custom:<providerId> 可含用户自定义名）→live 速度 span 的 speedView.text 过 ttEsc（工具名是宿主/MCP 可控字符串）→渲染桥两处订阅回调尾部 updateLive() try 包裹（异常不冒进宿主 store 通知分发，诊断键 subLiveErr/bridgeLiveErr 记录）
     * → v114 积压清单清扫：remoteCache/remoteTodayCache/richTextCache/richTextAttempts 上限淘汰（长会话防无界增长）；dispose 清理补 __zusageDeliverTurnText/__zusageSidWs/__zusagePaneScopes（旧代闭包自卫之外的清理完整性）；诊断 lsVals 只转储 zusage 命名空间的 localStorage 键（宿主其余键值不进 diag 文件）
     * → v115 渲染循环省电（上游 xhwxt PR #26/#28 同源问题）：幽灵子树/遮挡命中/模态判定加 TTL 缓存（120/150ms，命中绑定元素矩形+模式），track 在 document.hidden 时整帧跳过；未采纳其 600ms↔2s 调度降频（heavy 600ms 对账是与 render 并列的 React 重写兜底契约，降频会让增强节点裸奔 2s）
     * → v116 「思考中」卡死修复（源码复核定案）：v87 合成分支条件收紧——仅「空窗口非终态（draft 空窗，v87 本意）或 control.phase=running」才合成思考中，删除「行非空」析取项（宿主 wire 快照 rows.window 恒为全序尾 60 行，末轮超窗的闲置会话整窗无 turnHeader，旧条件使其永久点亮思考中、切回重绑重新计时）；思考计时锚定 turnHeader.startedAt（宿主创建 header 恒写入，重绑不清零，缺字段回退首观测）→ v117 悬停命中区扩到整栏（fork lliangworld b21e3cf0 同源收编）：条目空隙/分隔符按 sep 中线就近归属、尾部空隙归末位条目，⚙ 与空条面维持保持不动；防闪烁改由节流+幂等承担
     * → v118 无障碍与主题重构（并行会话批次）：条目可聚焦（span tabindex / zu-sub 真按钮 + aria-label）、键盘可达 tooltip（focusin/focusout + Escape 收起）、focus-visible 焦点环、SVG 图标与思考动画改 currentColor 随主题、⚙ 面板请求-回执协议（requestId + __zusagePluginResult，feedbackVersion 1）、quota 源操作错误语义、统计行开关即时重扫
     * → v119 插件自动检查改为每 1 小时，更新区双语提示更新器变更需完全退出并重开
     * → v120 Git 手动刷新改请求-回执协议（askGitRefresh 带 path/requestId，主桥 gitTick 完成后经 __zusagePluginResult 回执、在途请求合并等待，按请求 path 校验结果）+ 状态条 aria-live sr-only 播报区（套餐额度查询中/Git 刷新状态）+ ⚙ 面板高度上限 82vh→90vh + 模态判定改按可见 dialog（display/visibility/opacity 过滤）
     * → v121 状态条 .ico 与 ⚙ 齿轮图标盒由 calc(字号+4px) 改为等宿主字号（24 格线性图标墨迹只占盒 75–83%，18px 顶满 1.3 行盒显大，且加法常量令比例随字号漂移 1.33×→1.20×；用户实机定 1.0×，.eb .ico 12px 特例不变）
     * → v122 Git chip 展开测量完整宽度并留 32px 迟滞余量，切断宿主 compact 反馈环（issue #100）
     * → v123 Git chip 锚点按电脑操作→上下文→模式→思考回退，排除隐藏探针并随可见锚点迁移（issue #103）
     * → v124 Git chip 固定左侧操作区，移除右侧上下文/思考回退
     * → v125 思考计时中文全紧邻「7分16秒」（时段间空格去除，用户要求；英文「7 m 16 s」不动）
     * → v126 思考计时英文数字与单位紧邻「7m 16s」（时段间留空格，用户要求）
     * → v127 tok/s 速度十档色（TPS_BANDS 唯一事实源，原始值分档含下限不含上限：<40 低速红 / 40–70 一般黄 / 70–150 流畅绿沿用原三档类名与实测色，150 起新增蓝紫系 zu-teal/zu-sky/zu-azure/zu-violet/zu-purple/zu-magenta，≥2000 Ultra 静态蓝紫渐变 + ✦ 星点（::before content:"✦"/"" AT 静音、@supports 外纯紫回退，浅色组同名覆盖渐变）；估算态与完成态同表分档（用户规格，原「估算态不分档」废止），无效值（负数/NaN/±∞）一律中性 dim 或回退 DB 绝不判低速，DB 回退分支负数/非有限不再渲染 chip；tooltip 档位行改动态「名称 · lo–hi t/s」消解 toFixed 舍入边界歧义，另加静态「颜色对照」图例（十档数值↔颜色升序一览，档位类与条面同源随主题切换）；额度正常态改额度蓝 #78a9ff/浅 #315fc4（.zu-qseg 专属基色，不碰全局 .ok——上下文与速度前三档仍绿），周期标签拆 zu-qlabel 子节点中性次级色常规字重（textContent/aria/tooltip 不变），quotaSegs 补 isFinite 门防 NaN/±∞ 落正常蓝；正常态再改 CCometixLine 同源柔和低饱和（用户规格）：普通窗灰蓝 #8abbd0/浅 #276f86、7 天窗按 quotaSegs 结构化 key 挂 zu-qweekly 淡紫 #b69ad8/浅 #76509f（不匹配显示文本），周期标签与数值同色成组仅标签降字重，上下文按钮正常绿改 #72c9a2/浅 #187b58（限按钮作用域，速度与全局 .ok 不动））
     * → v129 模型拉取分区（收编 HHQ-666/zcode-model-puller，MIT）：⚙ 基础组新分区列宿主 provider_config.json 的 API Key 型自定义供应商，经主进程拉取其 /models（候选端点探测、OpenAI data/Ollama models/顶层数组形状解析、Bearer+x-api-key 双头），弹窗勾选（已添加/新模型徽标、搜索过滤、全选/清空/仅选新、选中计数）后经 model-pull-apply 最小写回（personalModelIds+modelOrder 追加、providerModelRules 复制同供应商模板条目、同目录原子替换+滚动备份 .zusage-bak、未知键保留）；key 只在主进程内存、只发该 baseUrl 本域，不回渲染端不进日志；请求回执 20s 兜底超时（旧主进程无 action 时提示完全重启而非永久 loading）
     * → v130 拉取算法吸收 GLQQX/zcode-model-discovery-patch 与 linguo2625469/zcode-patcher：字段别名全集（id/modelId/name/model、context_length/contextWindow/context_window/limit/limits、max_completion_tokens/max_output_tokens/maxOutputTokens/limit/limits/top_provider、payload 增 result 形状）、多模态感知（architecture.input_modalities/input_modalities/modalities.input + vision/supports_vision 布尔 ⇒ 宿主 inputFormat 稀疏能力位，缺位写实 false）、思考档位感知（supported_efforts 去重截 16 ⇒ reasoningLevel.values）、models.dev 公共目录补缺（并行拉取 5s 超时失败静默降级、id 精确→basename 唯一匹配、字段级供应商优先、key 与本机数据绝不发往目录、进程内 1h 缓存）、applyModels 按模型写实 config（contextWindow/inputFormat/optionSpecs；元数据走主进程 fetchCache 闭环、渲染端只回传 id 无法注入字段；模板带 map 表达式的 optionSpecs 整体不覆盖防 values 换名失配；无依据字段保持模板原样、不编造默认值）；弹窗行新增 ctx/out 可见小字与档位 title，分区说明补 models.dev 联网披露；review 修复：勾选表/已添加表/metaById 改 null 原型（模型 id 来自远端，__proto__ 等键静默失败丢勾选态）、实例 dispose 同步摘除模型拉取弹窗与 Esc 监听（原仅整体 dispose 摘除，pane 关闭后弹窗跨代泄漏且确认回调 inactive 早退卡保存中文案）、重开面板停在模型拉取分区时立即刷新列表、请求兜底超时 20s→25s（主进程最坏双端点 20s 防假超时）、主进程响应体 8MB 限长解析与 tmp 文件名带 pid 防双实例竞写
     * → v131 额度/上下文五档色（用户规格 2026-10-27）：CTX_BANDS/QUOTA_BANDS 唯一事实源（{min,cls} 有序表，bandOf 从高到低首个命中），阈值 30/50/80/90（含下限不含上限）——额度 calm/norm/mid/high/crit=emerald/sky/amber/orange/rose（暗 400/浅 700），上下文 calm/norm/mid/high/crit=slate/indigo/violet/orange/red；data-zusage-band 与 zu-qb-* CSS 双主题成对；pct span 与 SVG 环一律继承按钮 currentColor（.zu-ctxpct.ok 系独立色废止）；tabular-nums 原已覆盖 .zu-quota/.zu-ctxpct；v92 百万窗口提前预警（40/60）与 v127 额度正常态灰蓝/7 天窗淡紫（按窗口类型着色）随「仅按百分比」规格废止；额度 ≥100% 满档保留呼吸闪烁特效（zu-qb-exc，用户规格；90–99 为 crit 纯色）；压缩过程态（exc）优先档保留；余额/Key 额度段挂 calm 档色
     * → v132 模型拉取挂载点迁移（用户指令）：⚙ 设置分区删除（ZU_SECTIONS/section/ensureMpProviders/syncMpList/startMpFetch/mpFeedback 全撤），改挂官方「模型设置⇒自定义供应商」的「+ 添加模型」按钮左侧（锚 data-testid=model-provider-add-model-button，额度 chip 同款 enhance/restore 契约：render/heavy 双对账+位置兜回+自清选择器 .zu-mp-host）；供应商归属优先读设置页表单 http(s) Base URL 归一化匹配（唯一命中直拉），否则单供应商直用/多供应商弹 zu-mp-pick 选择列表/无供应商弹提示；按钮视觉复刻原生 secondary 视格（同页 Tailwind utility bg-secondary h-7 rounded-lg），⚡ 图标 stroke currentColor；弹窗抽通用壳 openMpShell（勾选弹窗/供应商选择/错误提示共用），apply 成功关弹窗由宿主自动刷新列表；供应商归属改主判定=当前选择的供应商（读宿主源码定案：导航项 testid=model-provider-nav-item-<nodeKey>、custom 项 nodeKey=custom:<providerId>、选中项 data-state=selected），providerId 精确匹配不受编辑草稿影响；Base URL 匹配降兜底（专用 testid model-provider-base-url-input 优先于表单启发式），弹窗对齐 HHQ 形态（⚡统计标题/搜索占位/仅选新模型计数/已选中 n 个模型/蓝实底确认钮）并自带 .zu-light 随宿主主题实时换装；review 二轮修复：上下文按钮浅色档补 data-zusage-armed 特异性（浅色主题 norm~crit 曾被暗色 0,3,0 规则恒胜）、model-puller 非 ok 响应体显式 cancel（undici 连接卫生）、宿主按钮 ml-auto（锚容器 justify-between 三子项均匀分布致按钮居中）、确认钮改固定蓝 #3B82F6/#2563EB（客户端 --color-brand 深色主题是白系，白底白字隐形）、拉取按钮仅在选中的是 custom 供应商时挂载（锚 testid 全局唯一，内置/套餐页同 testid）、拉取中按钮文本「拉取中…」+图标旋转（原透明度脉冲无感知）
     * → v133 Git 计数缩写（用户规格 2026-10-28）：chip/tooltip 的行数·条目·↑↓·冲突计数 <1万原值，≥1万 中文（cnUnits 判定）万/亿、英文 k/M/B（k 门槛刻意抬到 1万，与 token fmt 的 K≥1000 不同，小写 k 至多两位小数去尾零紧邻）；仓库个数与 aria 播报保持原值
     * → v134 额度与上下文保留既有阈值并统一绿黄红三档视觉；统一字号为宿主基准减 1px，周期标签加粗并微调分隔符
     * → v136 编辑项目弹窗源文件夹行在名称下方显示完整路径（纯 CSS ::after attr(title)，零 DOM 注入 React 无感；.truncate 限定本地行、排除 fixedFolder break-all 全路径行防重复，多文件夹每行各取各的 title；长路径自动换行不做省略号（宿主 truncate 的 nowrap 继承进伪元素须显式 white-space:normal）；规则挂条样式表、由 <html> data-zusage-pp 门控，⚙ 通用区「项目完整路径」开关 zusage3.projPath 默认开即时生效；顺带清理未提交编辑遗留的 spawnInstance 陈旧重复块 566 行死代码并复原被覆写的 issue #55 注释）
     * → v137 源文件夹行点击即用系统文件管理器打开该目录（用户规格 2026-10-28，mac/Win 双平台）：主通道宿主桥 openInFileManager（Windows shell.openPath / macOS open 带 Finder 与 shell 双回退，raw path 免编码），旧主进程降级 openExternalFile、openExternal(file:)（白名单含 file:）；远程项目编辑器按 virtual-project-existing 标记排除，fixedFolder 行不在选择器内；多 pane 重复委托 500ms 同路径去重，document click 监听随实例 dispose 摘除；行加 cursor:pointer
     * → v138 重置卡倒计时改时分秒全档恒显（并行会话 rstmerge 线并流收编，用户规格 2026-10-28：精确到秒、随 600ms 对账实时逐秒跳动，rstSpanText 中文数字单位紧邻「3时05分30秒」、英文数字单位紧邻+时段间空格「3h 05m 30s」；rst tooltip 补 Escape 收起（v118 键盘可达契约）；⚙ 倒计时阈值语义不变——并流时保留 rstCdh 持久化，对方运行目录构建因旧基线缺失而误删，其 18:42 rstmerge 部署曾覆盖本项目 v136/v137 后经本线合并恢复）
     * → v139 合并 fork/main v1.5.5 线（PR #121 重置卡徽标、#122 倒计时秒级、#123 templateRules 回填、安装修复与 v1.5.5 发版）时收编遗漏的 model-puller 套餐源判定（4e431cc：detectSelectedCustomProviderId 带 anchor，BigModel 付费套餐详情页按 GLM Coding Max 付费卡区分放行、Start Plan 免费卡页不放行；挂载门控 btn 先查 + mpAnchor 诊断）——本项目快照缺该段曾致 overlay-model-pull 挂载契约测试红；overlay 版本线自此与对方 v136 撞号线并流，按合入顺序顺延
     * → v140 收口审查修复：openProjFolder 对 invoke 通道（openInFileManager/openExternalFile）挂空 catch——旧主进程无 handler 时异步 reject 会刷 unhandled rejection；review-fix-merge 流程产物
     * → v141 ⚙ 更新区在 API 限流且渠道清单兜底也失败时引导 GitCode 镜像口令（清单兜底本体在 plugin-updater/plugin-release 主进程链）
     * → v142 ⚙ 通用「状态条样式」双主题 opt-in（zusage3.theme 独立持久化，默认关=现状）：药丸形态=所属输入卡下方居中、内容定宽，.zu-pill 经 --zu-pill-* 逐项拷贝所属视觉表面（Highspeed 外壳优先）计算样式，随宿主主题/hover/focus/Highspeed 实时跟随——pillSurface 统一取色/定位/让位锚点，body 子树 MutationObserver + 祖先属性观察捕捉外壳原位增删与搬移（不依赖 600ms 对账），80ms 过渡采样按目标计数、表面搬离自动停止；条面精简：缓存命中率/请求次数/轮数/耗时/首字收进 tooltip（0 命中也显示 0%），窄窗 .zu-main 横向滚动 + focusin 滚入可视区、切回默认复位 scrollLeft，不触发默认态收缩/渐隐；⚙ 面板宽度在药丸下跟随所属卡（不再跨分栏），主题 radio 按实例分组 name 防多面板互斥；数据重建先绑 __tip 再恢复焦点，aria-describedby/tooltip 不丢；modalOpen 豁免 zusage-panel 自有面板（修设置面板被误判宿主模态整条收起）
     * → v143 药丸收口审查（review-fix-merge）：8px 双间距按宿主实测几何收敛——adjustPillBottom 沿所属 pane/dock 实测矩形补足让位并带 floor/不增长护栏，无法让位的绝对定位布局 visibility 安全隐藏（无每帧显隐抖动）；pillMarginTarget 落在 .chat-composer-input-surface，Highspeed 退出后默认卡重解析（composerCardOf 优先原生 data-testid 输入框）、宿主 margin 变更原值+优先级还原；悬停 tooltip 在 pill 下实时刷新隐藏明细并保留选区/滚动，焦点恢复区分 Escape 关闭与悬停接管；modalOpen 纳入 alertdialog；协调器候选补可见性过滤且已绑定输入框豁免 45% 阈值（上下分栏不再反复挂卸）；表面祖先观察改快照重建防泄漏
     * → v144 ⚙ radio 对齐修复：.zu-settings-langs/.zu-theme-options 的 label 显式声明 flex+align-items:center+gap:6px——原 label 继承 .panel label 的 flex-start 顶对齐（gap 14px），radio 圆钮相对文字中线偏上约 4.5px；新规则 (0,2,1) 特异性覆盖 (0,1,1) 基础规则，实测居中 delta=0
     * → v145 切回默认主题补还原 bar.style.visibility（pillUnsafe 安全隐藏是 pill 专属态，写入点仅 track 的 pill 分支；此前 pill 隐藏态下切回默认条永久不可见，十路评审 P1）
     * → v146 精简模式（theme 第三档 compact）：条永久隐藏但保留 DOM（<style>/ariaLive 随条存活、heavy 保条对抗 React 清子树）；生成速度改挂工具行 .zu-tsb（重置卡左侧，挂载/位置兜回/签名幂等照重置卡同款），内容=zuBarSpeedView 桥两态或 tpsBand DB 回退、无有效样本不渲染（用户拍板）；tooltip=速度读数+状态条摘要（本轮/会话/工具/今日/子代理，逐格开关继续生效、子代理行点击开明细）+tpsBandLegend+「打开设置」按钮（镜像齿轮开启分支，面板精简下贴输入卡定位）；updateLive 10Hz 心跳原地跟随；非精简主题 syncTpsChip 门控摘除；诊断 mode=compact
     * → v147 精简模式速率 chip 挪前导区（用户规格）：git chip 左侧——git 在时插其前、git 不在时占其锚位（cua-entry 后方/前导区末尾），两侧位置兜回收敛为 [锚][速率][git]（git 兜回容忍速率占相邻位防逐拍拉锯）；前导区发现失败回落尾随区（重置卡/额度组左侧）
     * → v148 精简速率 tooltip「打开设置」按钮右对齐（用户规格）：footer 改 flex 布局，说明文本 tps-note-t 占据剩余宽度、按钮 margin-left:auto 推至最右，长文本换行不断布局
     * → v149 精简速率 tooltip 摘要行单位 tok→token（用户规格，与回答末尾统计行的 token 措辞对齐）
     * → v150 修复精简模式 git chip 永不挂载（用户报告）：v147 的 git 兜回容忍条款（速率占锚位时不挪）误拦首次挂载——速率 chip 常驻锚位时 enhanceGitChip 每拍判"已就位"跳过插入；改为 chip 未连入 DOM 时无条件首挂（落速率后再由速率兜回收敛 [锚][速率][git]），容忍只用于已挂载的位置保持
     * → v151 工具状态词改版（用户规格）：Bash 动词「正在执行」→「工作中」，未知工具回退同改（正在执行 X→工作中 X）；工具计时分隔去中点（正在读取 · 4.3s→正在读取 4.3s 一并生效）
     * → v152 工具动词 Read「正在读取」→「读取中」（用户规格）
     * → v153 工具执行状态词定稿（用户规格）：Bash 与未知工具回退「工作中」→「执行中」（无名词回退英文 Working→Executing 对齐）
     * → v154 工具动词全面改「X中」体例（用户规格）：写入中/编辑中/搜索中/获取网页中/更新待办中/读取待办中/运行技能中/读取上下文中/发送消息中/获取任务输出中/停止任务中/编写工作流中（Read 读取中、Bash 执行中、Agent 子代理运行中此前已改；英文标签不变）
     * → v155 审查修复批（review-fix）：①compact 下 positionSubPanel 被隐藏条僵尸 .zu-sub 抢锚（零矩形把明细面板钉左上角）——chip 优先锚；②速率 tooltip 内容含秒表，悬停中 10Hz 整片重建吃掉「打开设置」/子代理行点击——显示中内容变化冻结只跟位置；③track compact 早退补两面板周期跟随；④自清选择器补 .zu-tsb、跨代采纳 chip 统一挂装（__zuWired 防重）修复热更后悬停/键盘失效；⑤closeSettings 焦点归还校验 offsetParent（compact 下不落隐藏 gear）；⑥enhanceGitChip 重复 var slotNode 清理。Web 同批：①③⑤（mousemove chips 归属校验只接本实例）+chip focus/blur 键盘可达对齐桌面
     * → v156 上下文按钮增强开关（issue #141）：⚙ 通用区新增「上下文按钮增强」checkbox（localStorage zusage3.ctxEnh，缺省开、仅显式 "0" 关），关闭走 enhanceCtxButton 关闭分支还原原生环/百分比且重置卡徽标继续维护（restore 顺带清徽标后立即重挂）
     * → v157 修复精简→默认切换残留空壳细线（用户报告）：compact 期 render 短路会让空壳条面（热更占位/清子树后未填过）因签名相等一直存活、切回默认露出细线数十秒；①离开精简立即恢复 display（compactHid 区分初载 none，初载不提前露条保 pill 定位契约）；②离开精简强制条面重建一次（lastHtml 清空）；③compact 短路加 main.children.length 门——空壳先补一次完整渲染（条隐藏不可见）；④render 公共尾部补 syncTpsChip（短路/直通两路都经）→ v158 并流 fork/main cmdkW 线（PR #140，原线 v146 与主线 v146 精简模式撞号按合入顺序顺延）：宿主命令中心（⌘K 搜索弹框）加宽加高开关（⚙ 通用区，zusage3.cmdkW 缺省开）：条样式表规则 max-width:max(32rem,80vw)!important（原生上限=宿主 quickPickDialogClassName 的 max-w-lg=512px，弹框基础类自带 w-full 窄窗本就满宽，故小窗保持原样）与高度同规格（弹框根 max(90dvh,calc(100dvh-6rem)) 不低于原生上限，cmdk 列表 440px 硬顶放宽为 max(440px,calc(90dvh-15rem)) 小窗保底），<html> data-zusage-cmdk 属性门控（applyCmdkW，与 v136 projPath 同款），:has(>[data-slot=command][cmdk-root]) 只命中 cmdk 弹框——命令中心/任务搜索/快捷指令共用该样式常量一并放宽，设置页等普通 Dialog 不受影响
     * → v159 重启提醒开关（issue #139）：⚙ 插件更新区新增「更新后提醒重启」复选框（zu-restart-notice），经主桥 restart-notice 动作原子写运行时 config.json 的 restart_notice（缺省开、显式 false 才关、异常值不静默）；session-start hook 的 session_notice 读同一键，关闭后每个新会话不再注入 🔴 重启/安装提醒引用块（/install-overlay 命令行输出与自动安装失败、桥补装的故障提示不受控）——工作流模式多会话不再被逐会话植入提醒 
     * → v160 Skill 运行期状态词显示「技能名·执行中」（用户规格，如「查阅·执行中」+计时）：turn-stats runningTool 透出截 160 字的 inputText，overlay 端 zuSkillName 提取 JSON name 字段（正则兜底、控制字符拒绝、超 24 字省略号截断），取不到回退「运行技能中」→ v161 状态条新增「项目累计」格：会话累计右侧渲染本项目（session.project_id）全部会话聚合（含子代理，口径同 session_usage；远端/不在本地库无字段不渲染），⚙ 状态条显示加「项目累计」开关（show.proj，默认开），精简摘要加同款行
     * → v162 状态词流光（用户规格）：速率 chip 纯状态词态（思考中…/工具动词/技能名·执行中）复刻宿主 .zcode-loading-label 同款流光——subtle→foreground→subtle 渐变 background-clip:text、1.4s 横向扫光、reduced-motion 停用；类名/关键帧自有命名（zu-shimmer/zu-loading-shimmer）不依赖宿主全局类；带 t/s 数值的估算/真实/DB 回退态不含
     * → v163 会话累计/项目累计 tooltip 增按模型明细行（top 8 按总量降序 + 「另有 N 个模型」，轻量行无 models 字段不显示）→ v164 tooltip 收口（用户规格）：模型明细全量展示去「另有」折叠、总和行置顶、键列自适应宽不换行、时间范围行 sticky 吸底（rt-pin，五个 tooltip 统一）→ v165 模型明细表格化对齐（rt-models display:table，整块共享最宽键列，token/次数列纵向对齐）→ v166 会话累计/项目累计时间范围精确到秒（fmtStartS，用户规格；其余三格保持到分）→ v167 模型行去 rt-atom（Chromium 表格内在宽度在 inline-block 边界断行致数值折行，真实浏览器实测）+ 带 rt-models 的 tooltip 宽度帽放宽 860px（zu-tip-wide，取最宽一行）→ v168 格面计数改 fmt 万/亿口径（用户规格：≥1万 N.NN万、≥1亿 N.NN亿；本轮次/会话轮次/项目会话次/工具总数四处，tooltip 与精简摘要保持原值）→ v169 同容器双条去重（Windows 用户报告：最小化/还原窗口来回切出现两根状态条）——宿主窗口状态切换可能短暂保留旧视图副本/重建编辑框，协调器瞬态出现两实例两根条落进同一张卡；heavy 对账每拍扫描：同卡可见 .zusage-root >1 或两根 body 兜底条矩形重叠过半时，data-zusage-slot 大者 hideBar 让位（对手消失经 track 自动复显；拆分窗格各卡各条不受影响）
     * → v170 tooltip 计数同口径（用户规格）：各 tooltip 标题/规模/工具/请求行与模型行、精简摘要行的次数/轮数/会话数全部走 fmt；子代理明细面板保持原值
     * → v171 修 issue #147（社区 @Mc-GrowlR 报告并给出方案，Windows 10 + ZCode 3.17.1）：划词 side chat 面板容器无 data-pane-id，被协调器 auto 兜底键当作独立 pane，同窗出现第二条状态条（Radix presence 常驻挂载，面板收起后幽灵 composer 仍持续命中扫描）；窗口存在真实 pane 键时丢弃 auto 键——老宿主全部候选均为 auto（单键）单实例行为不变、shadow/iframe 空文档兜底不受影响
     * → v172 待重启/待更新改由 ⚙ 齿轮红点提醒（restartNotice 开关改为控制红点；会话内文字重启提醒取消，plugin-updater 推送 markerAt 作红点代际，点进「插件更新」分区记为已查看）+ ⚙ 更新页「重启 ZCode」按钮（二次确认，主进程 relaunch 动作）+ 移除自动安装开关（hook 未注入一律自动装，auto_enabled/INSTALL_MESSAGE 会话出口删除）   // 悬停 ⚙ 面板可见；版本号随代际递增
     * → v173 强制 K/M/B 单位开关
     * → v174 辅助对话独立状态条（宿主 tabId 成键 + 实例配额 4+1、桥 scope 精确绑定、确定性统计行按会话根归属）→ v175 辅助对话回答末尾富文本与主分栏同规则（显式本地 scope + isCurrentTurn 活跃轮限定 + --current 的 promptTs 守卫；修宿主 modelDurationMs 只累计高速供应商致占位行永久「生成时长缺失」；富文本收集后统一发起、同 SID 只追活跃轮且 epoch 粘滞防多轮搅动）
     * → v177 review 修复批（10-agent 全量 review 闭环）：双条去重抑制不再被 track 每帧复显打穿（v169 Windows 双条场景实际失效的根因，复显前查 dupSuppress、heavy 每拍重评估解除）；精简下速率 chip 被摘除后子代理明细面板保持原位（不再回落隐藏条内全零 .zu-sub 抢锚钉视口左上角，web v103 同款）；精简短路块恢复 syncTpsChip 数据点 reapply（2976478 挪公共尾部后短路 return 到不了、与 git chip 不对称）；relaunch 无回执 4s 提示主进程可能是旧版需手动完全退出（旧 pollPluginRequests 白名单外动作静默丢弃）；待办红点指纹改分量级比较（更新装完后 latestVersion 分量退出不再误复亮）且 ack 幂等早退前先收敛本窗口红点；cnNum 切换补富文本 unitEpoch 在途竞态守卫（同 forceKmb）；detRootEl 落在宿主 data-session-id 写入窗口期时 heavy 按拍补算自愈；精简说明文案对齐 v147 挂载位（前导区 Git 左侧）→ v179 自动压缩阈值注入：⚙ 开关+模式+数值+状态行（enginePatch 随插件状态回推，__zusagePluginState 种子+拷贝行同 v172 纪律），主进程 engine-patch.cjs 按引擎 SHA256 白名单对 glm/zcode.cjs 打阈值改道补丁（锚点唯一性+use strict 指令位校验 fail-closed，hook 缺席/返回空双兜回 fail-open），阈值 autocompact.json 由引擎 hook 每轮决策 mtime 缓存读取——数值热生效、补丁冷生效（已运行 agent 子进程下个 spawn 起用）；ctx 按钮 hover 面板加「自动压缩 ~X%」行（acInfoText 按标称窗口口径，21K 预留近似还原）；关闭开关=按当前内容反向还原引擎字节；阈值任何形式钳 1% effective 地板防连环压缩→rapid-refill 熔断→ v180 重启按钮错位守卫（issue #158）：主进程 pushPluginState 携带 relaunchSupported 能力标记（与 relaunch 分支同文件、天然同步），浮层缺标记时隐藏按钮并显示「完全退出后重开」指引（syncUpdate + 点击守卫双处）；主进程 pollPluginRequests 白名单外动作兜底回执 unknown action，重启回执明确区分「主进程是旧版本」
     * → v183 子代理行内实时速率 chip（v4 Agent 行 testid 后缀即 childSessionId、与 v97 槽位键同源：运行期读槽位估算、完成后读泵快照 sub.list 真实加权速率；TPS 十档色；悬停 tooltip）
     * → v184 ⚙ 新增「子代理行内速率」开关（state.show.subRate，zusage3.show 整包持久、默认开；只门控行内展示）
     * → v185 实机修复批+review 修复批：后台子代理在宿主注册表无现成 store（运行期估算自 v97 起从未真正工作）→桥 v2 acquire 访问器按已验证 scope 解析子会话租约（仅 sess_subagent_ 前缀+本地）；tooltip 构建器改收数据包（buildTip(el.__zuT) 约定）；截断改从尾部取（保最新派发 8 个）；SUBRATE_DIAG 提模块级；诊断按 handle 判绑定；实例 dispose 摘行内 chip→ v186 本会话平均 token/s（PR #157 收编）：状态栏完成态主数字改会话加权平均（zusage avg_tps：Σ有效输出÷Σ生成窗口，main_turn 段、不含子代理），「均」前缀+按均值分档，最近一段/最近一轮退 tooltip；速率行/CLI 加「会话均」，精简 chip 同步；updateLive 会话归属取本 pane 行（lastView.session），缺席回退原行为→ v187 补回 v181 工具组状态词（PR #161 合并时 turn-stats runningGroupOf 块与 overlay 消费分支遗漏入库，仅存于运行目录热修副本）：turn-stats 复刻宿主 exploreGroup/executeGroup 合成规则（≥2 连续同类行成组、半截 JSON defer 透明、startedAt 锚定组首行），运行行落组尾时状态词显「查阅·执行中/终端·执行中」替代逐工具动词，计时从组头起算
     * → v188 自动压缩阈值注入按验收反馈简化：开关默认开（主进程 auto_compact_patch 缺省开、显式 false 关）；UI 只留百分比数值（留空=跟随引擎默认），模式下拉移除（引擎层 enabled:false/tokens/buffer 协议保留兼容，配置文件手写仍生效）；标题改「自动压缩上下文阈值注入/压缩上下文阈值数值」；状态行补 14px 水平内边距与 label 文本对齐
     * → v189 hover 面板阈值信息行移到「压缩上下文」按钮上方并追加下划线「调整」链接：点击复用 gear.click 完整路径打开 ⚙、切「通用」分区、scrollIntoView(nearest) 定位阈值数值行并高亮 3 秒（.zu-ac-flash，计时器实例级归属 dispose 清理）；info 结构改首文本节点+常驻链接（整行 textContent 覆盖会抹掉链接）
     * → v190 三处验收微调：hover 阈值行 text-align:left（与卡内其它行对齐）；高亮改琥珀左条+淡底（--color-brand 在宿主主题是白色系，outline 描边观感像输入框焦点）；⚙ 注入开关关闭或主进程未加载时数值行整行 hidden
     * → v191 hover 阈值行 token 数改走 fmt()：万/亿/K·M·B 与状态条、tooltip 同一转换链（跟随中文单位开关与强制 KMB 开关，中文至多两位小数去尾零）
     * → v192 hover 阈值行布局：去掉自加 6px 下边距（间距交给宿主 space-y-3 的 12px 节奏，与「平均缓存命中率」行 pt-3 距分割线一致）；行改 flex 两端对齐，「调整」链接居右
     * → v193 修 v192 贴按钮：宿主 space-y-3 是 Tailwind v4 :where() 零权重 margin-bottom，行上自写 margin 会按类名权重压掉它（v190 的 6px 显挤、v192 的 margin:0 贴紧同因）——删掉 margin 声明整段回落容器原生 12px 节奏
     * → v194 阈值百分比改总窗口口径+数值行 30-99 校验：设置 91=原生按钮走到 91% 触发、hover 显示 91%（旧口径按扣除 21K 输出预留后的有效窗口算，设置值与显示差约 2 个点被判为割裂）；引擎 hook 以 eff+21K 近似还原标称窗口并钳在 eff 内，writeConfig 白名单收紧 30-99，已打补丁引擎下次启动按 PROLOGUE_V1 原位换装新 hook；⚙ 数值超范围实时提示并拒绝提交
     * → v195 hover 卡新增新手说明行：阈值行下方小字（.zu-ac-hint，随行同生命周期）解释口径与后果——「按窗口总量计算（与顶部百分比同口径）；走到该比例时客户端会自动压缩较早的对话内容以腾出空间」；margin-top 收紧 space-y 间距（space-y v4 只写 margin-bottom，top 无冲突）
     * → v196 「调整」失灵诊断面包屑（下版移除）：openAcThresholdSettings 在 enter/after-gear/+150ms/row 各点写 __zusageDiag.acOpen（面板态、gear 可见性、条 display、分区、代际），closeSettings 写 acClose 调用者栈；v197 实证 acOpen 为空=点击未到达处理函数
     * → v198 修「调整」失灵：链接监听改 pointerdown（宿主疑似 mousedown 即关 hover 卡、click 到来前链接已被摘）+ 行级 click 兜底 + 捕获期点击写 localStorage 并在说明行回显（命中标绿/落空标红，诊断下版移除）
     * → v199 清理 v196-v198 诊断：acOpen/acClose/acClick 面包屑、localStorage 回显、命中/落空着色全摘；保留 v198 修复本体（pointerdown 主监听 + 行级 click 委托兜底），实机验收=电脑操作点击「调整」面板弹出且阈值行琥珀高亮
     * → v200 上下文按钮增强显示层优先镜像原生 aria-label 已用/总量（宿主 taskUsage，压缩后立即回落；issue #172 曾停在 DB 最近完成请求旧值 16.4%），解析不出回退 lastBand DB 口径（ctxOv/nativeCtxVal 优先级只作用兜底），exc 过程态档位仍优先，还原路径共用同一解析器（英文 UI restore 顺带修对）
     * → v201 合流：v200 撞号顺延（v200 已被并行线 issue #174 压缩按钮开关占用，8e6e1c0 先合入）
     * → v202 预估费用行：四格 tooltip（本轮/会话/项目/今日）按 models.dev 官方牌价估算费用（token_pricing.py 内置表 326 条 + serve 内 12h 同步 models.dev 与 er-api 汇率，pricing-cache.json 落盘），快照加 cost_usd（USD）与 fx，展示层 ×汇率显 ¥（无汇率降级 $），会话/项目模型明细行尾加各模型费用，「价格来源 models.dev」脚注可点（openExternal），费用行尾空心问号图标悬停弹说明小气泡（价格来源/计算公式/汇率来源三行，fxTip 独立浮层 + mouseover/out 委托 + 180ms 悬停桥，主 tip 收起/重建时同步收），汇率源主源失败兜底 exchangerate.fun（自定义 fx.url 不启用），⚙ 通用区开关默认开，本库口径：裸输入=input−cache_read−cache_creation 全价、缓存分价、output 已含思考不另计
     * → v203 红点仅承载待重启（发现新版未安装、更新成功且已热重载均不亮；分量级已读比较保留以兼容旧 seen 串）+ ⚙ 带待重启红点点击直接落「插件更新」分区（激活即 ack）+ 设置页新增「已更新成功，点击重启 ZCode 即可生效」提示条（旧主进程降级回原文字指引），分区切换提取 activateSettingsSec 单一出口
     * → v209 额度 chip .zu-quota 与重置卡徽标 .zu-ctxrst 左右内边距 6px→3px + 模型选择触发按钮（chat-model-select-trigger）左内边距减半：文本态 8→4px、图标态 6→3px（!important 压宿主 group 变体）（用户规格 2026-11-02）
     * → v210 时间范围行全部精确到秒（v166 会话/项目累计先行的 fmtStartS 扩展到本轮/今日合计与速率 tooltip 最近一段；fmtStart 仅剩「最后活动」行）（用户规格 2026-11-02）
     * → v211 本轮 tooltip「单次耗时/首字延迟」改「平均耗时/平均延迟」（zusage 快照 last_turn 新增 avg_duration_ms/avg_ttft_ms，对 model_usage 该轮已完成 main_turn 行 >0 样本求均值；turn_usage.ttft_ms 聚合列实测口径不明不可依赖，旧快照缺字段整行不渲染）+ 本轮格面移除时长/首字两段（耗时只在 tooltip），精简摘要「本轮」行时长随同改平均（用户规格 2026-11-02）
     * → v212 Git chip 分隔符 .zu-git-sep 间距收紧：字面「 · 」改纯点+左右 2px 内边距（多仓段与 ?N 未跟踪段两处同源；用户规格 2026-11-02）
     * → v213 状态条格序调整：今日合计提前到会话累计之后（速度→本轮→会话→今日→项目→工具→子代理→⚙），速率 tooltip「状态条摘要」行序随同对齐（用户规格 2026-11-02）
     * → v214 项目累计统计卡改版：tooltip 重构为「标题+统计范围（全部请求·含子代理）、总用量/请求次数/预估费用三 KPI（费用旁统一说明问号）、输入(命中率)/输出(含思考)/缓存写入明细、会话·轮·工具·重试规模行、模型四列表格（默认 6 项可展开全部，排序对副本）、时间范围（em dash）」，作用域 .zu-project-tip + :has 样式（不动共享 .tip/.rt-* 规则），展开态实例级归属键（sid:started）局部更新不重建整卡，触发项 zu-pj-item 标记，卡片内 Escape 关闭并归还焦点，focusout 进卡片不误关，positionTip 钳底边，费用全链复用 v202（0 有效/缺失 —/开关关整格收）
     * → v215 六统计卡统计卡化：本轮/会话累计/今日合计/子代理四格 tooltip 统一 zu-stat-tip 视觉体系（速度统计卡公共构造：scope 标签+双读数 hero 主读数档位色、两行五列网格窄窗重排、速度卡宽帽 760px :has 作用域；明细面板内模型行问号图标弹费用说明气泡，复用 fxTip 单例同款委托）（用户规格 2026-11-02）
     * → v215.1 速度卡去费用行与模型明细（用户规格：速度 tooltip 只留读数与时间范围，费用唯一承接处=各卡明细面板与 fxTip 气泡）
     * → v217 子代理统一浮层：.zu-sub-pop 双栏单组件替代「悬停五段卡 tooltip+点击独立明细面板」两套旧 UI（preview/pinned 状态机：悬停预览、首次点击固定、面板内操作转固定、Escape/关闭/外点统一收且焦点归还+500ms 悬停抑制；选中按 sid 维护、运行中未入库槽位进导航、签名幂等重建保滚动、会话切换即关、入口断连即关；任务页 _sub_item 逐任务模型用量表/预估费用/平均速率档色行/最后活动全格式时间，zusage sub.list 单项同步扩展；精简入口 chip.__zuOpenSub 归一指向同一浮层）（实机验收 2026-11-03）
     * → v218 速度卡三修（实机反馈）：悬停冻结 updateLive tipFor 判定改 contains（旧恒 false 致悬停中 tooltip 不冻结）；右格「最近一段」改读 lastView.last.tps（zuBarSpeedView 无 latest 字段恒缺）；图例 ≥2000 Ultra 改渐变圆点并禁 ✦ 伪元素（星点破形）
     * → v219 ⚙「状态条样式」（默认/药丸/精简单选+精简说明行）从「通用」分区移入「状态条显示」分区卡首，纯分区归属调整，控件与持久化行为不变
     * → v222 速度卡 tooltip 补「时间范围」行（用户规格，参考四格 tooltip 同款式）：主数字为会话均/桥态取会话累计口径（started→last_at，与会话累计 tooltip 同源），「最近一段」回退态保持段范围；起点缺失整行不渲染（半程范围无意义）；三处 speedCardHTML 调用点（桥态 buildLiveTip/DB 回退/精简 chip）同批生效
     * → v223 ⚙ 面板关闭按钮命中区外扩（原并行线编号 v220，合入顺延；::after inset:-6px、hover 反馈同步，约 20×24px→32×36px）：按钮四周 head 空白点击原本无反应，用户实测「悬停 × 上点不动、不灵敏」；CDP 真实点击定责为命中区过小（事件链与面板几何均无缺陷），纯命中区修复，不改布局与视觉
     * → v224 速度卡悬停实时刷新二次修复（实机反馈）：v218 只改了 tipFor 判定，新 tip 串仍写到格内 .zu-live span，而 __tip 宿主与 drawTip 读取都在 .it 格元素上——条件每 tick 命中、重画的仍是整条渲染时的旧串，悬停中「当前读数」冻结在最后一次整条渲染的值（chip 已跳动、tooltip 停在「思考中…2秒」）；改写回格元素（liveEl.closest(".it")），悬停中每 tick 跟手重画，未悬停也保持新鲜
     * → v225（v224 并行线 PR #198 先合入，本线顺延）⚙ 自动压缩状态行区分「引擎被单独热更」（issue #191）：桌面 build 已登记而引擎 sha 脱钩时明示热更事实与漂移 sha 前 12 位（引擎补丁新增 drifted 字段，主进程传入 appVersion 按点分界前缀匹配登记表），替代误导性的"版本不在支持名单"；lastError 后缀此时与 sha 重复不再拼接；fail-closed 判定不变
     * → v226 ⚙ 两项（用户需求 2026-11-03；v226 已被并行线自动压缩状态行占用，顺延）：①六格显示开关（本轮/会话累计/项目累计/工具调用/今日合计/子代理）全部关闭时样式自动转精简（边缘触发只在「变得全关」那一拍切档，zusage3.autoCompact 记录来源主题 default|pill，重开任一格恢复、面板手动改档即解除；药丸来源同样触发）②默认样式新增「水平对齐」三选一（zusage3.barJust：均分 space-between 缺省不挂类/居左 flex-start/居右——居右不用字面 flex-end，LTR 下 start 侧溢出不可滚动也不计入 scrollWidth 会废掉收缩检测与 .zu-clip 渐隐，改首格 margin-left:auto 等效右聚拢、溢出方向与兜底不变；设置块仅默认档显示，applyBarTheme 随档显隐并同步条上 zu-just-* 类）
     * → v227 预估费用说明气泡悬停保活（fxTip 是 body 级独立浮层、挂在主 tip 之外：指针从 ? 图标移入气泡被文档 mousemove「条外」分支按 left-bar 强制收主 tip、hideTip 同步收气泡，v202 起悬停说明气泡即灭；子代理浮层路径同被 preview-leave 倒计时收走面板。mousemove 处理器节流前新增分支：fxTip 显示中且目标在气泡内视同仍在 tooltip 上——保住主 tip 与气泡、取消越顶宽限与子代理面板延迟关闭，离开气泡回落原判定）
     * → v228 速度 chip 完成态去「· 近X」尾缀（用户规格；编号顺延避让已合并的 v226(PR #200)与 v227(PR #202 fx-tip-keepalive)）：条面格与精简 chip 同批去掉 dbTps 尾缀，主数字只显会话均（或最近一段）；「最近一段」读数保留在 tooltip 右格不受影响
     * → v230 压缩轮不再显示「本轮统计不可用」（编号顺延：原 v238 号，v229 已由并行合入的 PR #207 占用、v231 起由并行未合线自占）：上下文压缩（手动/自动同链）是 query_source='compact' 的辅助轮（DB 有完整数字且已计入今日/会话累计，但消息流无正文、header 零输出），旧逻辑按 v74 零输出明示规则误插误导占位——实测压缩轮投影=turnHeader+timelineMarker(marker.type='compact') 而 header.executionKind 恒 'agent'（ek 探针证伪初版假设），turn-stats get() 以 isCompact 识别，overlay 对压缩完成轮不新插/撤下已插行（宿主「上下文已压缩」提示已承载语义）；kinds/tmr 为 det 诊断字段；v74 真实零输出轮行为不变
     * → v231 统计卡标题拼接名称与垂直居中（用户规格三轮迭代一并入库；编号顺延避让并行已合入的 v229(PR #207, issue #205)——v228 后 overlay 台账实际未占用，按共享代际台账撞号声明让号）：①项目累计卡拼项目名——zusage _project_usage 附 name=启动目录末段（正反斜杠归一，缺目录/旧快照判空不渲染），.zu-pj-pname 字号颜色同规模行 .zu-pj-scale；②会话累计卡拼会话名——快照行 title 三处本就产出，纯渲染端：statHead 加可选第三参仅会话累计卡传、/\s+/g 压空白、缺 title 判空不渲染，.zu-st-name 360px 省略号；③名称与标题垂直居中——标题容器带名称时切 .zu-tt-name（display:flex;align-items:center），行内 baseline/bottom 对齐会被 18px 大字 descent 拖得视觉偏低（实机指认），flex 子项自动块化、省略号仍成立
     * → v232 速度 tooltip「最近 20 段」柱状图：zusage 快照 session 行新增 speed_segs=最近 ≤20 条已完成 main_turn 有效速度段（_row_gen_ms 窗口与 avg_tps 同款口径、辅助源/子代理/碎段不计，v 保留原始浮点供档位与柱高按原始值判断；speedCardHTML 带 segs 时切「左读数卡+右图表」布局——左卡=当前读数/档位胶囊/加权平均说明，「最近一段」右格由最新柱承载，无 segs 的旧快照/远端旧版保持 v215 原布局），柱顶读数恒一位小数与柱同轴心、最新段加粗，Y 轴 0 起整洁刻度并按「信息卡横向覆盖最右约 1/3 柱」约束迭代刻度保证最高柱读数不被压住，X 轴=分段真实完成时间本地时区 MM-DD HH:mm 稀疏显示、首末恒留，最新段描边高亮+「最新」徽标，柱体颜色沿用 TPS_BANDS 档位类（ultra 渐变深浅主题显式 border-box 覆盖防 clip:text 裁没），段值 ≥1000 t/s（读数 6 字符）或窄窗口（plot min-width+横滚）保读数永不重叠；柱级悬停/键盘焦点弹信息卡——tip 本体委托 + 实例闭包存悬停段下标经 speedTipRebuild 编进串（签名幂等重建不丢状态、离开回落最新段、会话切换重置），render 接管对速度格补 drawTip 使打开中随快照跟手（焦点/选区在 tip 内时跳过），图表横滚位置跨重建保留；精简 chip tooltip 不带图表
     * → v233 速度卡三删+读数自适应（用户规格）：①删「统计会话全部已完成请求：工具等待不计，不含子代理。」口径行（DB 回退与精简摘要两处，Σ输出÷Σ生成耗时等其余口径保留）；②删柱状图「最新」徽标（最新段描边与加粗读数保留，plot 高 200→184）；③删「每段完成后更新；不足 20 段时显示实际数量。」脚注（live/回退两处）；④左卡「当前读数」估宽分级自适应（超长状态词降字号+允许换行，不再被 156px 左卡裁切；分级实现见同批改动）
     * → v234 柱状图 20 段→14 段、释放空间给左卡（用户规格）：zusage 新常量 _SPEED_SEGS_MAX=14（与 last.tps 回查的 _TPS_LOOKBACK 分离，扫描窗 42 行凑 14 条有效段）+ speedSegsOf 渲染端截 14 + 两处口径行「最近 20 段：…」改 14；左卡 156→300px（内宽 278），主数字删 +12px 覆盖回基础 ui+22 大字，估宽分级阈值重算 ≤7.5/≤11.5、fit2 +6→+10px；plot min-width 600→420（pitch≥30）、wide 780→560、xEvery 估算基数 620→460/最小标签距 44→30（14 柱满宽全显时间标签）
     * → v235 速度 tooltip 多状态结构化重构（用户设计图规格）：zuBarSpeedView 追加结构化字段 kind/statusText/nameText/nameFull/elapsedText/speedValue/speedIsEstimated/speedSource/activeCount/noteText（八类 tool/toolgroup/skill/subagent/thinking/estimate/avg/real，text/cls/phase/band/latest 逐字保留、状态判断不解析文案）；speedCardHTML 新增 o.status 分层左卡模板（zu-sl-status 状态标题+子代理 ×N 徽标 / zu-sl-name 名称两行省略+title 全名 / zu-sl-main 主数值或计时 / zu-sl-unit / zu-sl-note 辅助），数值型走档位色、工具/Skill/思考/子代理保持 dim，o.main 拼装路径为精简 chip 等旧调用方保留；子代理估速前缀 ≈、无效估速显「估算中…」不补 0；buildLiveTip/fallback 传结构化状态，scope 标签按真实状态映射（工具执行中/工具组执行中/Skill 执行中/子代理运行中/思考中/生成中估算/会话平均/本轮真实速度），思考态左卡内嵌脑动效图标；柱状图 14→17 段（_SPEED_SEGS_MAX=17、渲染端截 17、口径行改 17），plot min-width 420→500/wide 560→680/xEvery 基数 460→500/最小标签距 30→29 配平左卡 300→250px
     * → v236 速度 tooltip 三修（用户实机反馈）：①信息卡改为悬停/键盘聚焦柱体时才渲染（默认不再常驻最新段上方，cur 高亮随之仅悬停态、latest 描边保留）；②X 轴时间标签最小距 29→44（17 柱 pitch≈29 必隔列、间距 ×2，修复标签拥挤）；③非 wide 图表删 plot min-width（随容器压缩+稀疏标签兜底），任何窗口宽度不出横向滚动条（wide ≥1000 t/s 保留横滚），速度卡宽帽 860→1040
     * → v237 修时间标签裁半（用户实机截图）：v236 的 border-box 配平让 X 轴行内容区只剩 20px、两行时间（25px）被 wrap 的 overflow-y:hidden 裁掉半行——X 行 24→29px（4 padding+25 两行）、plot 高 184→189，列配平随之 160+29
     * → v239 速度 tooltip 100% 复刻设计图（用户拍板以设计图为准，撤销 v233 删口径/v236 悬停才显卡）：信息卡恒在（默认最新段带「（最新）」+虚线引线连柱，悬停切段）、左卡状态图标+「当前读数」标签+档位色状态标题、颜色对照单行横排、统计口径左标题右分段+时间范围同卡、带图表时不渲染脚注
     * → v240 柱状图 17→10 段（zusage _SPEED_SEGS_MAX=10、渲染端截 10、口径文案同改）、柱宽 max-width 22→15px（-30%）、信息卡恢复仅悬停/聚焦才显示（撤销 v239 常驻）、左卡下半区加「峰值/最低/最新」概览填空、速度卡宽帽 1040→860、plot min-width 500→340
     * → v241 速度 tooltip 按设计图复刻：柱状图取当前会话最近 10 次（可跨天）、左卡标题行/主读数/说明行文案按设计图对齐（工具组「查阅」、Skill「执行中」、说明行统一「X · 正在执行」）、前缀「估/均」小号灰字、主体区垂直居中填空
     * → v242 速度 tooltip review 修复批（十 subagent 审查）：focusout/mouseout relatedTarget 守卫修 Tab 跨柱焦点断裂与双重建闪烁、render 接管 pill 主题补焦点守卫、wide 横滚复活（plot 420）、spanFrom 收严最坏一半 + CARD_H 36（实高 35.6 校准）、real 去档位胶囊、skill 标题统一无空格「·执行中」、工具组 statusText 回归完整短语、liveScopeMap real/estimate 用词对齐、「当前读数」标签与有效数值同门（修 subagent 数值误杀回归）、左卡 border-box 250/双规则合并/padding 12、标题档位色与单行省略、浅色 ultra 图例圆点 clip 修正、hero :has 单列、柱 role=img、17 段/常驻卡/帽 1040 等过期注释清理、测试补八态直调/概览三格/前缀/（最新）角标/图例行/几何不重叠断言
     * → v243 更新日志「发布页」链接 GitCode 渠道改指 /releases 列表页（tag 深链页对本项目 API 创建的 Release 一律「找不到或无权限」，GitCode 平台路由 bug 2026-11-04 实测；GitHub 渠道保持精确 tag 深链；镜像/未核实回退路径同规）
     * → v244 重启按钮反馈与延迟（用户报告「点击没反应、等很久才退出」——大头是宿主 app.quit 优雅退出链要关窗并逐个终止会话/扩展子进程，可达数十秒，插件无法绕过）：确认发送即「正在重启…」+禁用+预期文案替代「发出即恢复」伪装无反应，4s 无回执/失败/90s 仍存活三路还原（ok 后挂 90s 兜底防 quit 被会话/扩展阻止永久卡死；4s 超时已还原则不再挂）；syncUpdate 重绘保持禁用与提示；主进程 relaunch 固定 300ms 延迟改回执送达后 30ms 退出（800ms 渲染端无响应硬兜底）；v245（同批提交）quit 前 hide 全部窗口——退出屏障期窗口不再可见干等，主进程 15s unhide 哨兵在 quit 未发生时恢复可见
     * → v246 用户手改批：速度图未悬停（hoverIdx<0）不渲染信息卡、span 只按 capOut 留柱顶读数净空，刻度基数补 6/7.5 防跳档空旷；X 轴同日去重（仅首枚显示标签柱与跨日首柱渲染日期行，其余同日只显 HH:mm）；本轮/今日合计首格改「总用量」、今日缓存命中率并入 grid3 输入列副行、本轮平均耗时/延迟/总耗时行改 --sub 弱化段、会话累计 scale 行分隔符改前缀式并删末项请求数、工具表 <50ms 显「<0.1s」弱化、子代理浮层 KPI 副行改命中率/含思考/缓存写入+平均速率并入 KPI、项目卡范围+scope 合并单胶囊+隐藏「按用量排序」+子代理浮层模型表去底色改行线、本轮输出速度单位 tok/s→t/s、图例 ultra 点隐藏与 inline 间距收紧、tbody scrollbar-gutter:stable
     * → v247 悬浮窗口激活方式（issue 用户反馈：滑过误触遮挡）：⚙ 通用新增「点击激活悬浮窗口」开关（zusage3.tipClick 缺省关=停留 1 秒、仅显式 "1" 开=点击）；统计卡/子代理浮层 closed→open 改由独立 1000ms 定时器承接（排程置于 150ms 节流之前防快速滑入静止后永不触发、按命中元素 key 去重续期、到点按当前坐标 elementFromPoint 重命中抗 render 1.5s 重建 + :hover 最深元素复核），已开 tip 切相邻格保持即时，键盘 focusin 即时打开不变，取消统一落 hideTip/各 return 分支，定时器随 dispose 清理；点击模式 bar.click 接管 .it 并用 focusTipAt 避开 focusin→click 首击抵消（复用移出条面/Escape 关闭链，不另起 pin），fxTip/速度信息卡/工具栏 chip 与宿主原生 hover-card 不在本次范围→ v248 预估费用说明气泡「当前模型」随卡携带模型上下文（上一会话已完成、已部署未提交，与已合入的 v249（PR #224）并行开发，随本批补录入库）：四个统计卡与子代理浮层汇总的 KPI 费用问号随卡携带模型上下文（fxqIcon：data-model/data-rates=按用量最多模型+data-mcount+data-mscope），单模型显该模型四价、多模型沿项目卡口径显「计价范围」、无模型明细不显模型行，default 借 last 分支删除
     * → v249 用户裁定简化：「点击激活悬浮窗口」关闭（缺省）不再做停留 1 秒，恢复即时悬停原语义（v247 的 1000ms 定时器链 HOVER_OPEN_DELAY_MS/hoverSchedule/hoverCheck/hoverCancel 整体移除，mousemove 恢复 v246 逐行为）；开关开启仍为点击激活（bar.click 接管 .it + focusTipAt 防首击抵消、子代理 preview 关闭改 pinned 打开），设置项/文档口径同步为「悬停立即显示 ↔ 点击才打开」两态
     * → v250 速度柱状图按轮聚合+悬停卡全格式时间与轮明细+柱间距收紧（用户三项规格；编号顺延避让已合入的 v249「点击激活简化」PR #224）：zusage _speed_segments 改按 turn_id 合并一次提问的全部请求（v=Σ有效输出÷Σ生成窗口、逐问同口径），随段携带 m/i/o/n/c 供悬停信息卡渲染 模型/Token 用量（含输入·输出拆分）/请求次数/预估费用（数字格式化经 o.fmtTok/fmtCnt/fmtMoney 回调，费用随 state.cost 门控，旧快照缺字段按行省略，CARD_H 按实际明细行数校准）；悬停卡时间改全格式 yyyy-MM-dd HH:mm:ss；X 轴每个显示标签恒带月日两行（同日去重废止）；柱宽 calc(20%+12px) 使柱白任意宽度恒精确收紧 20%；段→轮措辞（最近 N 轮/第 N 轮）
     * → v251 套餐额度显示口径开关（⚙ 套餐额度分区「显示剩余额度」，zusage3.quotaRemain 缺省关=已用%，纯渲染偏好不进 config.json）：开启后 chip 面分段数字与 aria、tooltip 窗口行/Key 总额度行/其他源摘要行改按剩余%（100−已用 同一窗口池补数，quotaRemainPct 钳 [0,100]）打头，绝对值窗口行内 已用/剩余 明细互换顺序；档位色恒按已用原始值判定（quota.md 契约）不随口径反转；余额/Key 剩余额度单段与团队/未配置/错误形态不受影响
     * → v252 模型拉取同步提供商侧配置（issue #236）：零兄弟供应商首拉写实最小骨架+有据元数据（contextWindow/inputFormat/档位/输出上限），档位按强度梯排序（宿主默认档=values 末项），Copilot capabilities 别名，api.json 档位目录按需后台补缺（大体量不阻塞，缓存后下次拉取生效），套餐源接目录补缺；弹窗行「未获取配置」中性提示+脚注披露只增不覆盖；档位索引落运行目录缓存（24h stale-while-revalidate 跨重启复用），目录后台补拉时行内「档位补拉中…」状态+脚注说明
     * → v253 本轮/今日合计 tooltip 模型明细改项目卡式四列表格（zu-pj-mhead+statTable，费用列随 state.cost 门控；本轮 rt-models 行式退役，精简摘要保留）+ 本轮 tooltip 删「速度＝Σ…未参与测速」口径行（unrated_output 字段照旧生产）
     * → v254 生成速度 Tooltip 全面重构（范围/时间双 Tab 共 20 组合 + 按时间/会话/项目维度：zusage 新增真实库有界轮表 speed_history（短键+索引表+2s 缓存，单一 Σ有效输出÷Σ生成窗口口径，旧 speed_segs 契约不动），渲染端纯函数聚合；16 根细柱定宽居中、十档 TPS_BANDS 同源、删除均值虚线/统计口径大段/底部时间行/图表预览；右上角日历时间胶囊（title 全格式）、左卡历史均值与生成中估算分离、柱 hover 五字段自定义卡（时间区间/档位速度/多模型/Token 总量含输入输出/预估费用缺失态）、单行十档图例、空桶显空柱不显 0、远端身份下「全部」清晰降级、旧快照/精简 chip 回退原布局；Tab/dim/柱 hover 全走 tip 本体既有事件委托与签名幂等重建，不新增 IPC/定时器/全局监听）
     * → v255 真实宿主验收三修（X 轴短时分标签+30px 裁切杜绝长时间戳重叠、左卡实时状态降为独立 note 且标题中性化「当前筛选 · 历史统计」避免工具执行中配历史均值语义错位、V2 实时状态变量更名 spdLiveStatus 与 buildLiveTip 旧局部同名隔离）
     * → v256 修复「速度 Tooltip 有时新、有时旧」（用户实机报告）：根因=统一轮表只在 serve 常驻链产出，主进程常驻进程空闲回收/重启/降级时回退 zusage.py json 一次性帧缺 speed_history，spdRebuildOr 返回 null 整卡回退旧版；①zusage snapshot 增显式 include_speed_history 门控，serve 与桌面 json 都产出轮表（远端子进程 ZUSAGE_REMOTE_CHILD=1 排除，CLI/MCP/远端 stdout 契约不变）；②overlay __zusageUpdate 粘性保留最近一份有界轮表，缺字段帧不再闪回旧卡（空轮表不粘性）；③精简模式 tpsChipTipHTML 与 tpsTip 浮层补齐 V2 接线（双 Tab/维度/柱 hover 全走浮层本体委托、状态落 chip 数据包、V2 卡放行签名重建），V2 宽帽规则补 .zusage-tps-tip 宿主；冷文件 inject-main 未改，热重载即生效
     * → v257 追堵「首帧缺轮表」（用户 11:21 再现旧卡，渲染端 diag 实证已 v256）：v256 粘性只在代际内有效，热重载/重启后的新代际粘性为空，而 `_speed_history_safe` 在完成轮瞬间的 WAL 写窗口偶发抛错返回 None——首帧恰逢失败时无值可粘，仍回退旧卡。①safe 失败先短重试一次（50ms，新常驻进程首查撞写窗口时多半已放行；缓存 TTL 内不重扫），再失败跨 dbkey 回退最近一次成功轮表（`_SPEED_HISTORY_STALE_MS` 10 分钟上限，轮表是历史统计分钟级陈旧可接受，下一帧成功即覆盖）；②`__zusageUpdate` 帧级诊断 `FATAL.spdFrame`（has/sticky/turns，原地更新）——再出现象 diag 直接区分「数据链缺帧」与「粘性未建立」，不再靠截图反推
     * → v258 spdTip 取证诊断（用户 11:37 在 v257+首帧 has=1 下仍见旧卡，数据/代码/本地模拟三查均无异常，纯推理到头）：buildLiveTip/html(d)/tpsChipTipHTML 三条速度 tooltip 路径在 V2 成功时记 `FATAL.spdTip={t,src:"v2-live|v2-html|v2-chip",turns}`、回退时记 `{src:"fb-live|fb-html|fb-chip",turns,range,period,sid尾8}`，spdRebuildOr null 分支加 `FATAL.spdNull`（typeof FATAL 守卫不破坏 VM 切片）——diag 直接给出真实路径与当时轮表长度，定位后移除
     * → v259 宿主多视图顶部 48px [app-region:drag] 标题栏拖拽条穿透上层浮层（Electron 拖拽区按几何命中，覆盖层未显式 no-drag 不阻挡）：面板 top:8px 时头部 ✕ 落在条内，真实点击被窗口拖拽吞掉（新建任务页实报「设置关闭无效」，面板内导航点击正常与症状吻合）；.zusage-panel（设置+子代理浮层）/.tip（全部 tooltip 根）/.zu-mp-ov/.zu-compact-dlg/.zu-rot-pk-dlg 显式 -webkit-app-region:no-drag，把自身矩形从拖拽区减掉（宿主自家浮层与全屏屏障同款修法，app.asar 实证）
     * → v260 静态桥缺席兜底（同内容仓库版记 v258，合入时按合入顺序归一；G2 跨版本免重打桥）：readFiberPaneScope 沿 React fiber 回溯 SessionPane 作用域（detOwnerOf/sidePaneKeyOf 的 tabId 同款兜底；限深 24、撞外层会话/分栏根止步、多候选歧义拒绝，校验与静态属性分支同规）；turn-stats.js 运行时合成 BRIDGE_TEMPLATE v2 同契约三访问器（Map.prototype 一次性探针捕获宿主注册表 + installRuntimeBridge 注入口）
     * → v261 spdRender 取证补强（老会话完成态仍见旧卡而 spdTip 恒被 v2-live 每 tick 覆盖，hover 瞬间的整条渲染记录无法存活）：html(d) 整条渲染专记 `FATAL.spdRender={t,src:v2-html|fb-html,pane,sid尾8,turns,hasH,range,period,dim}`（独立字段不被覆盖），spdTip/spdRender 均带 pane 实例标识（多实例共享 diag 分不清写入者），spdRebuildOr null 分支补 spdNull 原因取证（typeof FATAL 守卫）；本版=运行目录 v260 合流超集基线 + 本诊断（v260 已含速度线全部修复与并行线 v259/v260 桥兜底）
     * → v262 根治「空渲染污染共享数据」（spdRender 铁证定案：用户复现时刻整条渲染 hasH:false / spdNull hType:undefined，而前后帧 has=1——`render(d)` 首行无条件 `state.data = d`，实例 spawn 首渲染/桥空窗的 `render(state.data || {session:{},...})` 把空对象写进共享数据、抹掉统一轮表，窗口内 hover 即 fb-html 旧卡；切会话 tab 触发 pane 重建恰好高频制造该窗口，故「老会话旧卡、新会话正常」）：render 改条件写 `if (d && d.session && d.session.sid) state.data = d`——空对象渲染不再抹掉轮表，spawn 实例后续 updateLive 直接用上一真帧渲染（比旧行为更快出 V2）；真帧写入链（__zusageUpdate 外层）不变
     * → v263 根治「范围/时间 Tab 点击无效」（用户实报 P0）：①根因=生成中 updateLive 每 100ms 重编 V2 整卡（估算/计时走字让 tipSig 每 tick 变化），mousedown 命中的按钮在 mouseup 前被 innerHTML 替换、click 落到共同祖先 closest(".zu-sv-tab") 为 null；Tab 切换提前到 tip pointerdown 委托（重建窗口前同步生效，click 保留键盘/兜底，同值幂等共存），按下即进 600ms 交互冻结保下拉展开；②updateLive 冻结扩 mouseInBar（悬停保活不整卡重绘，数字冻结在进入时刻，typeof 守卫兼容 VM 切片）；③compact tpsTip 面：Tab 同款 pointerdown（tpsTabActivate）+ showTpsTip 撤销 v255 对 V2 卡的冻结放行（悬停中统一冻结，交互路径清 __zuTipSig 天然放行）；④视觉 12 项（视觉审查 Agent 实测截图清单）：Tab 选中态纯白改柔和强调 rgba(87,200,255,.14)+恒字重 600 防跳动、hover 补背景反馈，左卡删「Σ有效输出 ÷ Σ生成耗时」公式行、标题改弱化「历史统计 · 不含进行中请求」（.zu-sl-title 仅本卡作用域覆写，旧八态卡不动）、主数字 +22px，X 轴跨日首柱两行 MM/DD+HH:mm 且跨日柱稀疏化必显、xEvery 8⇒6 收紧标签间隙，图例 Ultra 补 ✦，维度下拉补 ▾ chevron，标题 +6px/时间胶囊 padding 4px 10px，间距归 8/12 节奏，柱组居中+删 --zu-sv-n 死配置
     * → v264 第二根因收口（实机点击仍关 tooltip 定案）：tip 内控件点击 ⇒ pointerdown 处理器同步重编 innerHTML ⇒ 被点按钮 detach ⇒ 焦点跌落 body ⇒ focusout(relatedTarget=null) 曾无条件 mouseInBar=false + hideTip(true,"focus-leave") 强制关 tooltip——切换生效了用户也看不见（旧版 click-only 同样中招，这是「Tab 点击无效」体感的第二半）。修复：mouseInBar（指针悬停在条面/tooltip 上）时降级 hideTip(false) 交总闸拦截，指针真正移开由 mousemove 判定；纯键盘 mouseInBar 已 false 维持原强制关。行为级回归：切片派发 focusout 断言悬停中 [false,"focus-leave"]/离场 [true,"focus-leave"]
     * → v265 按下即建总闸（实机第 4 次点击实验定案的第三根因）：tooltip 常经 focusin 打开（点击 .it 聚焦），快速移动/合成指针下 mousemove 采样可能全部被 150ms 节流丢弃、mouseInBar 停留 false，随后一次快照推送的 render-orphan 接管失败即关掉正在交互的 tooltip，点击 Tab 落在消息区；pointerdown 委托开头 mouseInBar=true + cancelTipGrace，「指针按在 tip 内」先于一切判定生效，render-orphan 受总闸拦截，下一 mousemove 重新判定
     * → v266 render-orphan 悬停保留（第三根因彻底收口）：生成中宿主 phase 切换（思考↔工具↔正文）每次走 render 慢路径整条重建条面，条目结构变化时接管失败曾直接 hideTip(false,"render-orphan")——快速移动/合成指针下 mouseInBar 常 false（mousemove 采样被 150ms 节流丢弃，tooltip 经 focusin 打开），悬停中的 tooltip 随每次 phase 切换闪断、点击 Tab 落在消息区（实机第 4/5 次点击实验定案）。修复：mousemove 处理器开头（节流前）记 lastPt；接管失败时指针仍在 tip 覆盖矩形内则保留旧内容原地显示（不重画、不收），指针一动由 mousemove 重新判定；条外维持原收起
     * → v267 lastPt typeof 守卫（v266 裸引用打破 overlay-fx-tip-keepalive/overlay-tip-activation 的 mousemove 切片沙箱，与 v265 mouseInBar 同款教训：实例作用域新增变量一律 typeof 守卫或同步补切片夹具）
     * → v268 粘性跨代际（用户实报「速度 tooltips 现在变成老版本了」定案）：v255 粘性是模块级变量，热重载/重启后新代际为 null，新代际首帧恰逢 serve 空闲回收/重启窗口（本地实测 serve pid 数分钟内 8576⇒11362 频繁重启；json 链本地实测 1268 轮/197 会话产出正常）即回退旧卡；修复 = 粘性写 window.__zusageSpdSticky（旧实例不清除、新实例继承，跨热重载/重启持久）+ 四处 V2 消费点（buildLiveTip v2h / html(d) spdRebuildOr / tpsTip 数据包）统一 lastSpeedHistory 兜底——帧缺轮表时以最近一份有界轮表顶上（历史统计分钟级陈旧可接受，v257 同取舍），下一帧成功即覆盖
     * → v269 lastSpeedHistory typeof 守卫（第三次同款教训：v268 三处裸引用打破 overlay-speed-chart 旧图切片沙箱 3 例——实例/模块新增变量被切片引用必须 typeof 守卫已三令五申）
     * → v270 用户实机验收四修：①「项目」范围按用户口径重定义=全部项目对比（原当前项目与「会话」差异过小，用户实报「应该是取 zcode 所有的项目」；默认维度按项目，dims=[project,time]，不再按 panePid 过滤，切到项目时 session 维度归 project）；②维度切换后 Tab 无效——结合①数据差异过小造成「无反应」假象，随①消除；③右上时间胶囊月日前带年（跨年两端各自带年）；④hover 卡时间行同日区间压缩（右侧只补时分秒）+ zu-sv-twrap 允许换行，长区间不再省略号截断
     * → v271 点击任意位置关闭根治（用户实报）：tip 内按压后 1.2s 硬保活窗——hideTip 对非 win-leave/escape 的 force 一律降级交总闸（left-bar 命中区边缘误判/焦点跌落/宿主重渲染等任何路径）、focusout 在窗内直接不关；pointerdown 记 lastTipDownAt（typeof 守卫兼容切片）；win-leave（真失焦）与 Escape 保留立即收
     * → v272 维度切换功能移除（用户裁定）：图表恒按时间聚合——删图表头维度下拉（tip+tpsTip 两处 change 委托、dimSel 拼装、四条 CSS）、speedTabActivate/tpsTabActivate 的 dim 归位规则；「项目」范围恢复当前项目语义（恒时间维度下「全部项目」与「全部」完全等价），标题加「当前项目 ·」前缀；speedSel.dim 结构保留恒 time（会话切换重置兼容）
     * → v273 自适应布局+稀疏可视化+筛选栏重设计（用户 8 张截图 Goal）：①plot 自适应——删 inline 定宽，in-flow spacer（max(240, n*30+12)px）撑宽 + min-width:calc(100% - 30px) 拉满容器，柱组 flex 居中，多桶 spacer 触发横滚，网格/Y 轴/hover 共享同一 plot 坐标系（少柱不再左侧堆积大空白）；②hover 卡锚点改中心相对式 left:calc(50% + off)（plot 宽不再可算）；③today 有效桶 ≤3 且全桶 ≥4 默认聚焦有效时段，图表头「显示完整时间轴/仅显示有记录时段」次级按钮切换（speedSel.focus，切筛选重置，不改统计口径），聚焦带「仅显示有记录时段」提示；④数据覆盖提示 zu-sc-cov：今天「有记录 x/M 小时」、近 7 天「仅 x/7 天有记录」、本月「本月 x/N 天有记录」（分母=已发生时段，不含未来）；⑤筛选工具栏两端对齐——范围组左、时间组右（.zu-sv-time margin-left:auto），删分隔符，与统计卡/图表两缘对齐；⑥左卡精简——删「不含进行中请求」，实时状态并入标题行右侧轻量 zu-sl-sub（不再混入指标间），单柱时峰值/最低/最新 zu-sl-solo 弱化；⑦时间胶囊智能格式——同日「MM/DD HH:MM – HH:MM」、跨日不带年、跨月/跨年两端带年（v270 全带年撤销）；会话切换 speedSel.focus 重置
     * → v274 完整规格补齐（第二轮 Goal）：①spdChartLayout 统一布局参数入口（colPitch/spacerW/xEvery/valEvery 单处决定）；②柱顶数值稀疏化 valShown——n>8 按 ceil(n/8) 抽稀、首末与悬停柱恒显，16 柱不再数值重叠（hover 卡兜底完整值）；③最新柱 latest 弱化描边；④单点/双点 coverage 追加「暂无足够数据观察趋势」；⑤空态追加「尝试选择更长时间范围」弱化引导；⑥bkeys 截尾仅剩 recent（v273 聚焦改造时已自然移除非 recent 截断，超宽由 spacer 横滚承接不丢桶）
     * → v275 点击偶发关闭+快速切换卡死双修（用户实报）：①tip 原生 pointermove 直接保活（mousemove 处理器 150ms 节流采样盲区让 mouseInBar 停留 false，left-bar 等 force 路径就能关掉交互中 tooltip；pointermove 高频纯赋值绕开节流盲区，总闸始终可靠）；②整卡重编 rAF 合并 scheduleSpeedRebuild——快速来回切 Tab 每次指针按下同步 innerHTML 重建形成重建风暴（卡死体感），同帧多次切换只重建一次，切片沙箱无 rAF 自动退回同步（既有 pointerdown 契约测试不变）；③dispose 取消待合并 rAF；④tipStats.hideSeq 最近 8 次收起原因序列（diag 定性偶发关闭）
     * → v276 撤销 v275 的 rAF 合并（用户实报「会话切到项目卡死」定案）：被遮挡窗口的渲染帧暂停让 rAF 永不执行（本机 ZCode 常被 Chrome/飞书遮挡），切 Tab 排程的重编永不落地、tooltip 僵在旧内容；恢复同步重编（单次 1-3ms 可承受，「重建风暴」为伪问题），保留 v275 的 pointermove 保活与 hideSeq 诊断——遮挡环境一切交互路径必须同步落地
     * → v277 win-leave 降级可取消宽限（用户实报「点击 tab 仍自动关闭」，hideSeq 铁证 win-leave）：点击 Tab 引发的合成 documentElement mouseleave/瞬态 blur 与真离开在触发点无法区分，tipBoundaryHide 立即 force 关把正常交互打死；降级为 400ms 可取消宽限（cancelTipGrace 共用定时器，pointermove/mousemove 落回即取消），真离开半秒后收；取证 cause 带触发源（blur/edge）与 document.hasFocus 焦点态
     * → v278 更新失败可见性（issue #247）：updater 检查/安装失败落盘 plugin-update.json lastError（成功即清），⚙ 更新区在非 error 相位显示「上次更新失败」行；hook 链按 HOST_TARGETS 判已装版本 × 宿主 build 未登记适配时强制立即升级 + 会话明确提示（去重），marketplace 刷新重试 + 清单新鲜度校验点名宿主 CLI 静默失败
     * → v279 速度卡 Header 单行重构（第三轮 UI Goal §3/§5/§7）：标题居左、范围/时间双 Tab 组成连续操作区整体靠右，旧独立筛选行与顶部时间胶囊删除，窄窗 flex-wrap 整体降级不裁剪；统计时间迁至图表标题栏右端轻量文字（calendar 图标 + 紧凑区间 + title 完整 YYYY-MM-DD HH:mm:ss 区间），单位 t/s 紧随图表标题；左卡标题层改「平均速度」+ 小号「历史统计」标识（.zu-sl-k 行删除）；旧图共享类仅 .zu-sv-root/.zu-sv-chart 作用域覆写不受影响
     * → v280 速度卡横滚位置记忆（用户实报 全部×全部 拉到末尾、关闭 tooltip 再开回到开头）：speedCardV2HTML 根节点携带 data-sv-key=范围|时间 选择键；tpsTip 重编分支（showTpsTip 非冻结路径）重建前从旧 DOM 捕获 .zu-sc-wrap scrollLeft 连同键存储、键同才回填（hover/心跳重编不跳回头部、关闭再开含数据刷新后恢复原位、切范围/时间键变自动归零）；全量 tip drawTip 横滚保留从 keepTop-only 扩展到重开路径并加同键守卫（v232 盲恢复改键同回填，V1 旧图无 zu-sv-root 键按空串键行为不变）
     * → v281 速度卡专项双修（第三轮专项 Goal）：P1 图表列宽稳定——V2 注入样式由仅钳 max-width 改 width+max-width 同值 !important（width=min(960px,calc(100vw-24px))、border-box，压过 .tip 的 width:max-content 与 tpsTip 内联 max-width:520），右图表列 flex:1 1 0 + min-width:0、滚动容器定宽 100%，列宽不再随 plot spacer（n×30+12）与图表头文案反向撑缩，Tab 切换整卡宽度恒定（视口足宽恒 960、窄窗恒 vw-24）；P0 hover 信息卡裁剪根治——卡从 .zu-sv-plot（被 .zu-sc-wrap overflow 滚动容器裁剪）移到 body 级 Portal .zu-sv-portal（模块单例、类名挂 .zusage-quota-tip 复用 boot 旧代清理链、pointer-events:none、z-index 同 tooltip 层 2147483646 且 DOM 序在后），内容经 SPD_PORTAL 侧信道（纯字符串、VM 切片安全、消费即清）由 showTpsTip/zuSpeedChartPick/speedRebuildNow 渲染定位，按柱体 getBoundingClientRect 右上⇒左上⇒钳边避让视口（safe 10px），横向滚动 capture 相重定位（柱滚出 wrap 视口即收），切 Tab/hover=-1/收起路径（hideTpsTip/hideTip）立即隐藏不留孤儿
     * → v282 档位说明浮层与 Tab 低对比选中专项（第四轮 UI Goal）：底部常驻十档图例整体移除（.zu-sv-legend 包装/分割线/占位全删，整卡高度由 Header+统计主体决定），改由图表标题栏「单位：t/s」旁问号按钮承载——hover/focus 即显不点击、Escape 只收浮层、icon→卡保活（延时收+卡内取消）、柱体 Portal 互斥（双方 show 互收防双层浮窗）、按柱体 rect 下方→上方→钳边定位、body 级浮层脱离 overflow 裁剪 + 显示移尾（B1 同款）+ dispose/热更双清理链；十档内容 spdLegendCardHTML 自 TPS_BANDS 升序生成（颜色/星标/边界与柱体、chip 同源唯一事实），当前档位高亮读按钮 data-sv-band（整卡重编自动更新、空数据不高亮）；Tab 选中态对齐 Hover 低对比背景（去 rgba(87,200,255) 蓝块：on=白 .07/浅色黑 .06 + 发丝内描边区分持续选中，on:hover .09/.07 轻微提亮，字重恒 600 维持 v263 防选中加宽纪律）
     * → v283 档位说明浮层微调（用户反馈）：最大宽度 560→800px（仍钳 calc(100vw-24px)）；显示时左缘对齐宿主 conversation-bottom-dock-transition（composer 容器）而非整窗口/图标锚定，dock 缺失回退图标左缘、越出右缘钳边（与 v282 避让策略叠加）
     * → v284 主卡定宽 800+左缘对齐宿主 dock（用户反馈澄清：上轮 800/dock 对齐实为主 tooltip 而非档位浮层）：V2 注入样式定宽 960→800（width+max-width 同值 !important 不变）；tpsTip 链 showTpsTip 在 V2 卡圤位后左缘改对齐 conversation-bottom-dock-transition（缺失回退 chip 锚定，垂直不变）；全量 tip 链 drawTip 渲染 V2 内容时写 tip.__zuDockLeft、positionTip 每帧消费（rAF 跟随不回退回 chip 锚定），非 V2 内容 null 走原锚定
     * → v285 速度卡左缘对齐锚元素（用户反馈：热重载后仍居中，指定基于 .it 速度格左侧对齐）：废弃 v284 的 conversation-bottom-dock-transition 宿主类名依赖（实测未生效），改为 positionTip 在 V2 卡（tip.__zuAlignLeft，drawTip 按 .zu-sv-root 置位）时 left=锚元素（.it 格）左缘钳边；tpsTip 紧凑链删 v284 dock 覆盖（原本就是 chip 左缘钳边）；档位说明浮层左缘改对齐主 tooltip 容器左缘（与主卡构图一致，替换 v283 dock 对齐）
     * → v286 图表标题栏精修（第五轮 UI Goal）：标题 600/+2（V2 作用域覆写，不过重）；「单位：t/s」收为轻量「t/s」徽章（弱化前景+微亮底+圆角 5px，视觉优先级 标题＞单位＞档位入口）；问号换专用 Speed Bands SVG（细圆环+三级递增速度柱，currentColor 继承按钮色态，18px 视觉/26px 命中），aria-label 改「查看速度档位说明」；十档浮层/互斥/保活/清理链全部沿用 v282 机制不变
     * → v287 修复批：速度卡远端判定改只认快照 remote 标（本地 scoped 行也带 workspace_identity，旧判定把本地 pane 选「全部」误降级为本会话并显「远端会话仅显示本会话历史」）；精简链 tpsTabActivate 聚焦按钮改 t0.speedHover=-1（原 t.speedHover 在声明前引用必抛 TypeError，0 也会误高亮第 0 柱）
     * → v288 会话累计模型明细费用列随 ⚙ 预估费用开关门控（原 v215 内联四列表漏门控，v253 共享 statModelsTable 收编时漏掉本卡——开关关闭后仍渲染「预估费用」表头与 ¥ 单元格；换 statModelsTable(sess.models) 与本轮/今日同源，关时收三列、空明细整块不渲染）
     * → v289 火山方舟额度修复（issue #260/#261）：tooltip「其他源」行抽公共 helper otherSourcesRow 并在 info（未配置/暂不支持）分支同样渲染——主源不可展示时后台已查询成功的源（如火山 AK/SK）不再被提前 return 吞掉；其他源标签对复合源 id（vendor:providerId）回退裸厂商键查找；剩余口径（quotaRemain）在其他源行保持不变
     * → v290 速度卡交互与标签（2026-11-08 用户规格）：图表区滚轮横滚（tpsTip 本体 wheel 委托，deltaY→scrollLeft，不可横滚不拦截）；每柱恒显时间标签（8px 下 5 字符可容纳，稀疏化废弃）
     * → v291 速度历史热力图（本月月历/全部历史 GitHub 风格双形态，档位色同源 TPS_BANDS、无记录中性灰、未来弱日期号）+ FATAL.gen 代际号进 diag（重注入取证不依赖计数字段归零）+ 首开/键变滚到最右
     * → v292 月历定稿第一轮：标题去粒度词改「范围 · 时间 · 平均速度」三段式；整卡定高 315px 四形态同高；跨月占位不越出星期对齐
     * → v293 月历设计图规格：列头周首日号与格中心对齐、7 行 1fr 铺满、滚动条样式落元素本体（v293.1）
     * → v294 月历格专项：低饱和档位底 22% 混卡片色（v294.1 拍板去左色条靠底色辨档）、文字统一吃前景色、space-between 布局+min-height 治越界、容器查询三档字号
     * → v295 月历布局铺满（6 列×行 1fr 均分、紧凑态隐数字 hover 兜底）+ 柱状图系列修订八项：顺序时间恢复（v295.7 撤 v290 倒序）、柱距 24px 恒显时间（v295.17）、Y 轴刻度列外移滚动容器（v295.18）、首开滚最右（v295.13）等
     * → v296 热力图「全部历史」改最近 365 天窗口（周日起对齐补齐、窗外透明占位、无数据卡覆盖统计 v296.1）+ 方格随容器宽自适应横滚
     * → v297 热力图动态字号（6~14px 纯算术择优、宿主量测 __zusageSpdMonRect 一次回写、今日格加深 v297.1、分段高度诊断 v297.2、⚙ 面板同款 v297.3）
     * → v298 chip 主数字改最后一轮真实速度（去「均」前缀，tooltip 左卡保留会话加权均，两处各自成立；无最后一轮真实值时面留空不显会话均）+ Y 轴刻度锁定柱区基线（v298.1）+ 左卡标题随时间 Tab 五命名（v298.2）+ 档位徽标下模型名（v298.4）+ 量测时机挂 display:block 后（08）
     * → v299 本轮 tooltip 紧凑化（三行 KPI 家族首卡：statKpi 辅助行参数、模型表 headRight/tableOnly、工具/重试迁模型标题行右）
     * → v300 会话累计卡紧凑化（同三行 KPI 形态）+ 会话总耗时跨会话长时长换算 + zusage 会话级平均耗时/平均首字延迟/Σ生成耗时聚合（>0 门控，旧快照降级）
     * → v301 今日合计卡紧凑化 + 三张统计卡共用 KPI SVG 图标（KPI_ICON_PATHS）+ zusage 今日聚合扩平均耗时/首字延迟列 + 缓存命中率入输入格副行
     * → v302 统计卡行结构定名（请求次数/请求轮数/请求会话层级行、「总耗时」「平均输出速度」统一命名）+ zusage 今日去重会话数与 Σ工具调用（v302.2）+ 会话/今日模型标题行右并入工具统计（v302.3）
     * → v303 项目累计卡紧凑化（根类并入 .zu-stat-tip--project 统计卡家族）+ zusage _project_usage 新聚合（平均耗时/平均首字延迟/总耗时/跨分片合成 avg_tps）+ 刻度列外移联动（v303.3/v303.4）
     * → v304 工具调用卡紧凑化（定宽四列+sticky 表头+行 hover）+ statKpi 标题图标参数 + zusage 子代理单任务耗时/轮数聚合（v304.1）+ 模型名立方体 SVG 胶囊（v304.2）
     * → v305 收口审查修复批（review-fix-merge）：轮播可视化编辑器 when: 键白名单+提示行转义（堵存储型注入面）；手写显式 false 高级条件保存保留、false 不再渲染为勾选态；热力图「共 N 天」覆盖统计 var 提升修复（原恒退兜底文案）且分母对齐可视窗口；今日 tooltip 轮数/会话数旧远端缺字段显 —；今日/项目 avg 耗时与项目 avg_tps 过滤 main_turn（与 avg_tps 同口径）；devKeepTip 持久化+re-click 放行；__zusageSpdMonRect 代际清理；speed_v2 聚焦切换测试随功能移除删除；未编号同批内容——轮播自定义短语可视化编辑器+文本模式、内置词包拆独立分片 04-rotator-builtin-packs.js（16 包）、⚙ 轮播分区「原作者」按钮、速度卡覆盖提示/聚焦按钮移除（2026-11-07 文案批）
     * → v306 精简 tooltip 幽灵行框修复（\x01 结构化 HTML 哨兵只在主链 drawTip 被 tip.firstChild.slice(1) 剥除，精简链 showTpsTip 直塞 innerHTML 不剥——控制字符落成文本节点被 .tip 的 white-space:pre-line 撑出 ~20px 幽灵行框，V2 卡定高 300+overflow:hidden 下整卡下坠、底部被裁，实报上下 padding 不对称；补齐同语义 charCodeAt 剥除）+ 状态轮播主开关默认关闭（2026-11-09 用户规格：新用户/从未写过设置的用户不自动启用，显式开/关过的存量配置经 loadRotatorConfig 布尔覆盖原样保留）+ 速率 chip 右键直开设置（2026-11-09 用户规格：精简下 chip 是唯一常驻入口，contextmenu 镜像 .tps-cfg 路径——先收 tooltip 再开面板，并压掉宿主原生右键菜单）
     * → v307 速度 tooltip 左卡「生成中估 X t/s」note 行删除（2026-11-09 用户规格）：生成中估算只留标题旁「生成中（估算）」徽标，瞬时估算值不再与历史均值同卡并列；完成态会话均被误标「生成中估」的边界（v298 speedValue 保留 avg 语义 × v263 门控只看 speedValue>0）一并消失（.zu-sl-note CSS 保留——旧版 speedCardHTML 回退卡仍用）；未编号同批内容——速度卡模型行原生 title 改纯 CSS data-tip 伪元素气泡（2026-11-09 用户实报：宿主内原生 title 不弹——生成期重建打断驻留 + Electron 宿主对 title 气泡不可靠，同轮播 zu-rot-tipt 先例）+ 悬停模型列表不省略（spdAggregate 增 withNames 仅整体口径产出全量 modelNames，消费点唯一带 fallback）+ 模型行补 aria-label 全名单（伪元素 content:attr 不进可访问树）
     * → v308 切换任务主线程阻塞修复（用户实报「来回切换任务卡很久才反应」）：gitMount 的 live() 幽灵判定从裸 inGhostSubtree 改走 ghostOf 120ms TTL 缓存——裸调用逐祖先 getComputedStyle 强制样式重算，恰在切换的 React 重挂风暴（样式树最脏）里被 render/heavy 高频触发，CDP CPU 采样归因 inGhostSubtree 436ms/9.4s 近乎全部经 gitMount→live（每次切换聚集 ~48ms，与长任务 72-102ms 时刻逐一吻合），缓存路径实测仅 2ms；判定语义与 track 每帧 ghostOf(composer) 同款；未编号同批内容——.zu-sv-bars 由 space-between 改 flex-start + 两侧 5px padding（修少柱如「最近 3 轮」柱顶 nowrap 数值越缘撑出 ~2px 横向滚动）+ 单柱 zu-sl-solo 弱化移除（2026-11-09 用户规格，含 CSS）+ 合入审查撤销同批误入的 hovFreeze 悬停冻结（08 分片 render 接管链：与已合并 v224「悬停中 tooltip 随快照跟手刷新」契约冲突致 pill-theme 4 例红，其原生 title 驻留动机已被 v307 data-tip 气泡消解，净 diff 与 fork/main 逐字节一致）
     * → v309 拉取模型「确认添加并保存」先探测后保存（用户实报 OpenHub-Gemini Base URL 少 /v1：宿主实际请求 {base}/chat/completions 得 405，界面报 "Model request failed."）：勾选 ≤24 个时逐模型 model-pull-probe （主进程按宿主同款 URL 语义发最小对话请求——openai 两型不自动补 /v1、anthropic 归一化补 /v1 拼/messages、套餐源=套餐 baseUrl+messages+Bearer；刻意不走 candidateUrls 兼容改写以复现宿主真实路径），行内状态 chip （检测中/可用+延迟/失败，title=分类原因+实际 URL+脱敏摘录）并发 4 刷新，全过自动写入、有失败自动取消勾选保留弹窗（可重新勾选强制添加，旧主进程 unknown action 降级直接保存；inject-main 白名单加 model-pull-probe，model-puller 增 probeModel/分类/脱敏）
     * → v310 拉取模型探测体验收口（用户实测两报）：①失败原因悬停不显示——v309 在 chip 上挂的原生 title 在 Electron 宿主内不弹（v307 同款实证），改 data-tip 伪元素气泡（从 chip 左侧水平弹出、行内垂直居中，避开 .zu-mp-items 的 overflow:auto 裁剪，双语 aria-label 同步）；②路径错配自动修复而非红字提示——主进程探测 404/405 时对 ±/v1 邻域候选实测，命中即把新 Base URL 读-改-原子写回 provider_config（与 applyModels 共享 applyBusy 写闸、同供应商单飞：全选模型同 URL 全失败只测一轮只写一次），模型按新 base 重试，弹窗绿字披露 「已自动修复 Base URL 并写入供应商配置」（.zu-mp-fix），修复候选也失败时失败原因附「已尝试自动修复」；探测 ask 兜底 25s 改 65s（探测+修复+重试最坏约 45s 不能被错杀）；修复限定 openai 两型（anthropic 型宿主自动补 /v1 无此错配、套餐源 baseUrl 不代改）
     * → v311 辅助档位写实（用户实报：添加后宿主「测试模型」报 reasoning_effort "none" 被上游拒绝——宿主 testModelConnectivity 绑 values[0] 最低档，openai 两型内置 catch-all 把默认最低档 disabled 映射成 wire "none"（zcode-builtin.json modelApiRules[2]/[3] 同款语义），Gemini 严格上游只收 minimal..max；探测链基础连通后追加辅助档位验证：按 catch-all 同款语义发 values[0] 等效 wire 值，被 400 拒绝时从错误文案解析上游接受集（解析失败退化为逐候选实测），验证后写实合法档位表——模型规则已存在直接写规则（values-only 稀疏合法、带 map 自洽结构不动），未落盘模型写 fetchCache 元数据由 applyModels 统一落盘（绝不在探测路径新建规则防双写重复），绿字披露「思考档位写入 minimal/…」；失败新增 reasoning 类文案附上游接受集；错误摘录保留完整脱敏文本供解析
     * → v312 输入类型/模型能力自动匹配（用户实报：拉取后能力区全空）。宿主侧定案（源码+内置配置审计）：modelRules 的 `.*` catch-all 对所有模型显式设保守默认（text-only、json-schema/联网/中段系统全 false），**无协议级推导**、能力位必须逐模型证据；个人稀疏规则字段级覆盖合法。证据源三路：①目录一致性收割——同名模型多 provider 收录的歧义守卫改为「可加证据字段全命中一致才采纳」（modalities 收 inputFormat 含 PDF；tool_call 只采显式 false；structured_output 只采 true），mergedMeta 第三参最低优先级并入；②确认流能力实测（caps 标志显式携带才跑，仅 chat-completions、仅正证据 2xx 写 true、4xx/网络失败不写保守默认）：图片 content part / response_format json_schema / 对话中 system 消息三项 6s 探测（2026-11-09 真实中转实测三项可判定；PDF 的 OpenAI wire type:"file" 部分中转不认故 PDF 只走目录；视频/音频/联网搜索无廉价如实验证不探测），写目标与 v311 同款双路径（已存在规则合并 properties 叶子且用户显式 false 不覆盖；未落盘写 fetchCache 由 applyModels 落盘）；③弹窗行内徽标（图/PDF/JSON）+ 绿字披露「能力匹配：图片/结构化输出/中段系统消息」；探测兜底 65s 放宽 90s
     * → v313 工具历史回灌探测（用户实报：配置就绪后真实对话 Turn execution failed 400001——实弹二分定位为 OpenHub 中转全部 Gemini 系通道（3.5/3.7/3.8，流式与否）拒收 assistant tool_calls + role:tool 历史形状（C4-C7 全变体 400），与插件写入无关（裸形状同样拒），Anthropic 线同病；工具结果折进 user 消息反而 200（Gemini 原生映射）；同站 qwen3.8-max 正常=通道级缺陷。宿主侧无配置解（supportsToolCall:false 会令宿主对带工具请求直接报错更糟），落为警告性质：确认流第 4 项 6s 探测发最小工具历史形状，4xx 确定性拒绝才警告（超时/网络/5xx 不定不警），琥珀 .zu-mp-warn 披露「代理任务在工具轮次会失败，纯对话可用」，绝不写任何配置位，结论按拉取会话 fetchCache 去重（裸探测无会话不去重）
     * → v314 规格补全（用户实报 maxOutputTokens 89642 超上游 65536 上限 400）：宿主预算链定案——wire 输出预算 baseline=已解析 optionSpecs.maxOutputTokens.max（未写=内置 catch-all 128000），预轮 cap=min(baseline, 窗口−用量−1000) 只下调不设上限（model-token-limits.ts resolveModelStepMaxOutputTokens），超 spec.max 是宿主侧硬拒绝非钳制——所以「不写输出上限规格」会让请求预算完全脱缰。applyModels 是 append-only：先添加的模型在目录证据迟到时永远拿不到写实，v314 在确认流探测路径用拉取会话元数据补「缺失」键（properties.contextWindow / optionSpecs.maxOutputTokens.max，绝不覆盖已写数值、带 map 自洽结构不动、applyBusy 写闸），绿字披露「规格补全：输出上限/上下文窗口」；当日已手修用户配置 max=65536（上游 400 报错自证上限，中转 max_tokens=65536 实测 200）；收口审查补齐：禁止凭据重定向并按实际 key 脱敏、供应商来源与档位 CAS 守卫、缓存身份绑定及已验证路径迁移、自定义 map 不猜测、供应商显式能力优先且 false 保留、修复后补规格、工具限流不误警告、确认单批互斥和逐项强制添加、关键披露停留至再次确认、关窗清理等待与模块 dispose 失效
     * → v315 「原作者」悬停提示被滚动区顶缘裁剪修复（用户实报截图：气泡向上弹、只露底边一线）——cap 内触发点（原作者/自定义短语模式切换）气泡翻到触发元素下方 `bottom:auto;top:calc(100% + 6px)`，右对齐保留；cap 贴 .zu-settings-body（overflow:auto）顶缘是根因；向下弹常规布局落进分区卡片区域可见，纯 CSS 无视口碰撞翻转、cap 滚动至贴滚动区底缘时对称受限（v310 .zu-mp 左弹先例同款取舍）
     * → v316 「压缩上下文」按钮视格重做（用户规格）：全宽 40px 胶囊、无边框、中性深灰半透明底（暗色=白叠加 6.5%/hover 10%/active 14%，浅色=黑叠加 5%/8%/12%，html.dark 分组自动跟随明暗与 zai 主题）、13px/600 文字（字号走 --ui-font-size 令牌 calc(-1px)，随宿主界面字号缩放）+ 18px 收缩双箭头 SVG（currentColor，flex+gap 8px 图文整体居中、nowrap）、focus-visible 焦点环（宿主无 --color-focus-ring 走 fallback）与 :disabled 半透明；reduced-motion 组整体移到全部受控规则之后（@media 不增特异性，置于按钮 transition/弹框 animation 基础规则之前会被同特异性后置规则压成死代码，review 实锤修复），弹框动画一并恢复实效；注入/判定/确认弹框/提交通道逻辑全不动
     * → v317 ⚙ 面板上层 body 级弹框内按下不再联动关闭设置面板（用户实报：词包「查看」弹框点遮罩/✕ 连设置一起关）——面板外点 mousedown 判定按 e.target 向上匹配弹框根类名（.zu-rot-pk-dlg/.zu-mp-ov）：遮罩关闭监听与面板判定同在 mousedown、target 阶段先执行并已把 rotPkDlg/mpModal 置 null，变量 contains 守卫对遮罩路径失效（✕ 走 click 判定故 contains 版已好、遮罩仍坏），closest 沿已 detach 的残留子树仍命中；弹框外点击照常关面板、无 closest 的 target 按弹框外处理
     * → v318 chip 字体切 sans（用户实报 Windows 上 chip 数字与中文大小不一，mac 无此问题，最终方案）：宿主 --font-mono 首选 ui-monospace——Windows 落到 Consolas（内置浏览器实测 13px 数字墨迹约 8px），中文回退 Microsoft YaHei UI（11~12px），条/chip/tooltip 内中文显大 ~40%；原生 UI 无此问题靠 sans 配对（Segoe 数字 10px + 雅黑 11~12px，配比 1.1）。缩放面路线三轮实机回退后整体废弃：ZuCJKFit CJK 面（90/82/76%；82% 真机像素测量实测配比仍 1.2 嫌数字小，76% 后数字锐利但配比失衡）与 ZuNumFit 数字面（ASCII 110%，实报数字边缘发虚——size-adjust 缩放路径光栅化比原生整数尺寸软，canvas 拉普拉斯方差实测低于原生面）全部删除。定稿=条/chip/tooltip 全部 30 处 mono font-family 换 var(--font-sans,…)+ 既有 tabular-nums 保留（含 01 模块 rateTip 内联 cssText 兜底，被 quotaTip/rstTip/tpsTip 整体复制）：Windows Segoe tnum 实测生效（13px 同 7 位任意数字恒 56.12px）数字刷新不抖宽，Segoe 数字 10px + 雅黑 11~12px 配比 1.1 与原生同源，零缩放零模糊零调参；mac SF Pro+苹方天然同构（用户实测无失衡），Linux system-ui tnum 未实机验收；⚙ mono 域（06 设置面板 .zu-src-field、.zu-mp-*、.zu-notes-* 与 05 rotator 编辑器 .zu-rot-*）仍走 mono 令牌
     * → v319 速度格数字与单位加距 4px（用户实报 "158.9t/s" 贴字，且「修改过程中对的、判定生效又变回去」——两条渲染路径只有一条有空格）：①实时桥路径 zuBarSpeedView text="… t/s" 有空格但切 sans 后 Segoe 空格 7.15px→~3.7px 视觉贴字，.zu-live 加 word-spacing:4px（用户实机逐档对比定稿）；②无桥 DB 回退路径 chipFace（07）数字直拼 '<span class="dim">t/s</span>' 根本无空格字符、word-spacing 对其无效——补空格后与①渲染一致；用户看到的「忽对忽错」=生成中走①、完成/无桥走②
     * → v320 「不在本地库」提示与 ⚙「数据库统计」注记不再写死 ~/.zcode 路径（issue #279：宿主 dataBaseDir 迁移后旧提示误导）：tooltip 改中性描述并指引重装/更新、⚙ 注记改「只读本地用量库（默认 ~/.zcode/...，跟随宿主 dataBaseDir 迁移）」；用量链 DB 路径解析本体在 zusage.py / token_rate.py / inject-main.cjs（非浮层），此为配套文案
     * → v321 速度格贴字真根因修复：`.zusage-root .it>span:not(.eb)` 的 inline-flex 把速度格也 flex 化，flex 剥离文本 item 尾随空格——数字态（数字+span.dim 两 item）空格 spaceW=0、v319 的 word-spacing 无效（CDP 实测墨迹间隙 0），状态词态单文本 item 不受影响故「动态对、停止贴」；选择器豁免 .zu-live（外部 flex item 布局块化等价、零变化），空格与 word-spacing:4px 恢复生效，间隔与动态态一致 ~7.7px
     * → v322 速度格 word-spacing 4px→2px（用户实机目测：7.7px 偏宽，收窄到 ~5.7px）
     * → v323 速度格 word-spacing 2px→1px（用户实机继续收窄：~4.7px）
     * → v324 完成态数字与 t/s 零间隔：chipFace 去除空格字符（7.7→5.7→4.7px 逐档后用户定稿 0）。动态态（单文本 "… t/s"）仍空格+word-spacing:1px ~4.7px；word-spacing 对完成态无空格文本不再生效（CSS 保留无害）
     * → v325 动态态 word-spacing 1px→4px（用户实机回定；完成态零间隔不受影响——无空格字符可加距）
     * → v326 数字与 t/s 间距改用 inline-flex+gap:5px+baseline：去除 word-spacing（用户实测调值无视觉变化——完成态无空格、动态态单文本）。动态态整条渲染（07 render live 分支）与原地更新（08）统一走 zuLiveFaceHtml 拆「数字+dim」两 item，gap 才有 item 可分；状态词态保持单文本。完成态 v324 曾零间隔，v326 起与动态态统一 5px（用户屏幕验证接受）；函数声明必须实例级（html(d) 分支块内是 Annex B 块级声明，live 分支 TypeError / 08 ReferenceError，实测 44 测试红）
     * → v327 V2 左卡标题行防破版（另一台机器实报截图：--ui-font-size≈20px 浅色主题下「最近18轮平均速度」截断+「思考中」竖排折行）：标题行需求宽随字号线性增长而卡内宽固定 184px（实测 14px 需 151.1 余量 33、ui≥17 必溢出），.zu-sv-root .zu-sl-sub 加 flex:0 0 auto+white-space:nowrap——状态词永不收缩竖排，溢出收缩由标题独享 ellipsis 降级；本机默认字号视觉零变化，CSS 契约断言锁定
     * → v328 宿主卡顿治理（specs/perf-lag-reduction.md）：流式期间插件在宿主渲染线程的工作量与会话文本量/历史轮数解耦——①turn-stats ingest 字符计数改无分配码点计数+按行缓存（原 Array.from(text).length 整串拆数组，单次 0.35→4.1ms 且跑在宿主 store 通知链内，现 0.02→0.4ms）；②spdUnpack 按 speed_history 引用 WeakMap 缓存（6000 轮单次 ~5ms，占速度卡生成 95%）；③updateLive 快路径未悬停本格不再每拍白建整张 V2 速度卡（只记 view 标失鲜，drawTip 打开瞬间 liveTipRefresh 补建，兜底 1s 保鲜；悬停仍每拍）；④非 live 会话数据帧未变时 500ms 内心跳不重复整条 render（原每 100ms 全量重建 tooltip 串+五个 enhance*）；⑤轮播主开关关闭态 65ms 帧步降为 1s（仅剩遗留 DOM 还原的整文档查询）
     * → v329 修复项目累计 tooltip 点击「查看全部模型」异常收起与同模型大小写重复：①根因=按钮未在 pointerdown/mousedown 阶段阻止默认/冒泡，且 hideTip 1.2s 保活因 mouseInBar=false 被绕过导致 left-bar 误杀 tooltip；在 pointerdown/mousedown 增加对 .zu-pj-more 的委托与阻止默认行为，hideTip/tipLeaveAt/mousemove 硬保活 1.2s 不受 mouseInBar 干扰；②zusage.py 聚合与计费统一对 model_id 大小写归一化（优先保留大写/官方名，合并同模型如 GLM-5.3 与 glm-5.3，费用累加不漏）。
     * → v330 宿主 3.18.0 loading 行结构适配：①chat-loading 行 label 类由 .zcode-loading-label 换成 .animated-gradient-text、spinner 图标位由 span.grid 换成带 data-chat-loading-icon 属性的 span（.font-mono 耗时格未变），轮播挂载/还原选择器双兼容（chatLoadingLabelOf/chatLoadingPixelGridOf，旧结构优先），label 未命中时不再隐藏宿主耗时格（宿主再改结构时退化为保留原生计时）；②「我方最后写入」基准由模块级单例改挂 label 自身 data-zu-last-text 属性，修多个 loading 行并存（多分栏并发请求）时后处理行的宿主文案快照被词组污染；③「拉取模型」选中套餐源而列表暂不含它（套餐 token 的解密密钥异步到位）时重问一次、仍没有则提示凭据暂不可用，不再落到「只有一个供应商就用它」而改投别的供应商；⚙ 额度披露文案补充钥匙串密钥的读取。
     */
    var VERSION = "v330";
    /* issue #55：这三个 var 必须先于下方 buildPanel() 的调用完成赋值——var 只提升声明不提升
     * 赋值，而 buildPanel → syncUpdate 首轮执行就会读它们（赋值语句曾排在调用点之后，
     * v1.5.2 首轮读到 undefined 抛 TypeError 拖垮实例创建）。配套函数是声明有提升，留在原位。 */
    var instanceDisposed = false, heavyTimer = 0, frame = 0, themeObserver = null;
    var detRootEl = null;   // v174：本实例会话根（最近 data-session-id 祖先），随 setComposer 更新
    var globalListeners = [];
    function listenGlobal(target, type, fn, capture) {
      target.addEventListener(type, fn, capture);
      globalListeners.push([target, type, fn, capture]);
    }
    function inactive() { return instanceDisposed || stale(); }
    /* ---------- 状态（实例级） ---------- */
    var excOn = false,    // 本 pane 会话处于"上下文超限被拒"状态（render 时按 picked 会话计算）
      excGone = false,    // 用户点 ✕ 关闭了本次气泡；超限解除后自动复位
      nativeCtxVal = 0,   // 本 pane 输入框卡片上读到的原生上下文总量
      lastSub = null,     // 子代理明细面板数据源
      instSid = "",       // 本 pane 当前会话（composer 祖先链 data-session-id）
      pendingSid = "", wantedEl = null, scopeStamp = "",   // 协调器派发的最新 composer/会话
      shrink = 0,         // 分级收缩（v66）：1 = 内容超卡片宽，「本轮/会话累计」缓存命中率已让位
      fadeOn = false,     // 收缩后仍超宽：右缘渐隐（.zu-clip）
      bridge = { handle: null, turnId: "", timer: 0 },   // v71 本 pane 的 renderer store 订阅
      lastBand = null,    // v92：本 pane 上下文分档（ctxBandOf 结果，原生按钮增强的数据源）
      ctxBtnCache = null,   // v92：本实例上次增强的原生按钮（还原/对账引用，不依赖 cardCache 存活）
      lastQuota = null, lastQuotaAll = null, lastResets = null, quotaProvider = "", quotaModel = "", quotaFallback = "", quotaChipCache = null,
      quotaSourceId = "", quotaSelection = null, quotaPaneRoot = null, quotaSelectionObserver = null, quotaMarkerSeen = false,   // 当前 pane 模型选择与额度来源
      gitChipCache = null, gitRefreshPath = "", gitRefreshRequestId = "",   // Git chip 节点与刷新状态
      liveTextCur = "", liveStatsCur = null, liveKindCur = "fallback", liveEl = null,   // v72：合并「生成速度」用
      livePhaseCur = "", liveIconCur = "bolt",   // v77：当前 chip 阶段与图标（think=思考动效/bolt=闪电）——相位切换需整条重渲染
      tpsChipCache = null, lastView = null,   // v146：精简模式工具行速率 chip 与最近一次 render 会话视图（chip tooltip 摘要数据源）
      speedChartHover = -1, speedTipSess = "", speedTipRebuild = null,   // v232 速度柱状图：悬停段下标（-1=最新段）/归属会话守卫/tip 重建闭包
      speedSel = { range: "recent", period: "recent", dim: "time" },   // v254 双 Tab + 维度（实例级，会话切换重置）
      speedInteractAt = 0,   // v254 最近一次 Tab/维度/柱 hover 交互时刻（updateLive 短冻结防打断）
      compactHid = false;   // v156：display:none 是否由精简模式设置（区分初载 none，避免切档前提前露条）

    /* ---------- DOM ---------- */
    /* 样式表挂在 bar 内部而非 head：React 可能清理 head 里的外来 style，
     * CSS 一旦失效条就退化成 static 占位元素（"输入框下方空白"的历史根因）。 */
    var style = document.createElement("style");
    style.textContent =
      /* 胶囊条：半透明底 + 微边框（v80 起仅 below-card 兜底形态用；in-card 形态由
       * .zusage-root.zu-in 全部抹平）。配色全量跟随客户端主题（v58）：颜色一律
       * var(--color-*, 旧值兜底) 引用客户端语义变量（<html> 的 .dark 类翻转整套值，
       * zai-light/zai-dark 特殊主题同样自动适配）；color-mix 处加同值前置声明，
       * 不支持 color-mix 的旧引擎落到实色行不至于透明。 */
      /* v315 chip 字体定稿（Windows 混排失衡的最终方案）：宿主 --font-mono 首选 ui-monospace，
       * Windows 落到 Consolas（13px 数字墨迹约 8px）而中文回退 Microsoft YaHei UI（11~12px），
       * mono 混排中文比数字显大 ~40%；原生 UI 无此问题靠的是 sans 配对（Segoe 数字 10px +
       * 雅黑 11~12px，配比 1.1）。中间迭代全部撤销：size-adjust 缩放面三轮实机回退
       * （ZuNumFit 数字面 110% 光栅化发虚→撤；CJK 面 90/82/76% 越调整条越小且 82% 实测
       * 配比仍 1.2 嫌数字小），最终定稿=借用宿主原生配对：条/chip/tooltip 字族
       * var(--font-sans,…)+tabular-nums——零缩放零模糊零调参，跨平台天然协调（mac
       * SF Pro+苹方即用户实测无失衡的组合）。tabular-nums 是宽度稳定的关键：Segoe tnum
       * 实测生效（13px 同 7 位任意数字恒 56.12px），每秒刷新的速度数字不抖宽；Linux
       * system-ui 的 tnum 未实机验收。⚙ mono 域（06 的 .zu-src-field、.zu-mp-*、.zu-notes-* 与 05 的 rotator 编辑器
       * .zu-rot-textarea/.zu-rot-cp-chip/.zu-rot-cp-phitem code）仍走 mono 令牌。 */
      ".zusage-root{position:fixed;box-sizing:border-box;" +
      "font-family:var(--font-sans,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);" +
      "font-size:var(--ui-font-size,14px);line-height:1.3;" +
      "font-variant-numeric:tabular-nums;color:var(--color-foreground-subtle,#8791a3);" +
      "background:rgba(15,18,25,.86);background:color-mix(in srgb,var(--color-background,#0f1219) 86%,transparent);" +
      "backdrop-filter:blur(14px) saturate(1.3);-webkit-backdrop-filter:blur(14px) saturate(1.3);" +
      "border:1px solid var(--color-border,rgba(255,255,255,.07));border-radius:9px;padding:2px 6px;user-select:none;" +
      "box-shadow:inset 0 1px 0 rgba(255,255,255,.05),0 4px 14px rgba(0,0,0,.38),0 1px 3px rgba(0,0,0,.28);" +
      "display:flex;align-items:center;gap:2px;white-space:nowrap;" +
      /* 条不用 overflow:hidden：超宽截断由 #zu-main 自己负责（渐隐 .zu-clip）。 */
      "z-index:50}" +
      /* in-card 形态（v80）：条挂在输入卡片内部 group/toolbar 工具行之后自占一行，
       * 与对话框融为一体——背景/边框/阴影/毛玻璃全抹掉（用户指定），宽度交由卡片
       * flex-col 的 stretch 撑满内宽（min/max-width 不再写死）。 */
      ".zusage-root.zu-in{position:static;background:none;border:0;border-radius:0;padding:1px 0 0;" +
      "box-shadow:none;backdrop-filter:none;-webkit-backdrop-filter:none;min-width:0;max-width:none;z-index:auto}" +
      ".zusage-root.zu-pill{width:max-content;min-width:0;max-width:calc(100vw - 16px);padding:2px 6px;" +
      "background:var(--zu-pill-bg,var(--color-input,var(--color-background,#13161e)));" +
      "border-width:var(--zu-pill-border-width,1px);border-style:var(--zu-pill-border-style,solid);" +
      "border-color:var(--zu-pill-border-color,var(--color-input-border,var(--color-border,transparent)));" +
      "border-radius:var(--zu-pill-radius,12px);backdrop-filter:none;-webkit-backdrop-filter:none}" +
      ".zusage-root.zu-pill .zu-main{flex:0 1 auto;justify-content:flex-start;overflow-x:auto;scrollbar-width:thin}" +
      ".zusage-root.zu-pill .ico{color:var(--color-brand,#3b82f6)}" +
      ".zu-main{overflow:hidden;min-width:0;flex:1 1 auto;display:flex;align-items:center;gap:1px;justify-content:space-between}" +
      /* v226 水平对齐（仅默认档挂类）：居左直接改 justify；居右不用字面 flex-end——LTR 下 start 侧
       * 溢出不可滚动也不计入 scrollWidth，收缩检测会失效、左格无声硬裁、.zu-clip 渐隐错边；改用首格
       * margin-left:auto 吸收自由空间等效右聚拢，溢出时 auto 归零、内容右向溢出，收缩/渐隐兜底不变 */
      ".zusage-root.zu-just-start .zu-main{justify-content:flex-start}" +
      ".zusage-root.zu-just-end .zu-main > :first-child{margin-left:auto}" +
      /* 收缩兜底（v66）：分级收缩后仍装不下时右缘 26px 渐隐，替代生硬的截断 */
      ".zu-main.zu-clip{-webkit-mask-image:linear-gradient(90deg,#000 calc(100% - 26px),transparent);" +
      "mask-image:linear-gradient(90deg,#000 calc(100% - 26px),transparent)}" +
      /* zu-main 不得带 .it class：querySelectorAll('.it') 收集 tooltip 时会把它算进第 0 位，
       * tips 全部错位一位且末项为 null —— v31"悬停只有空胶囊/内容错位"的根因 */
      ".it{display:flex;align-items:center;gap:5px;padding:2px 7px;border:0;border-radius:7px;" +
      "background:transparent;color:inherit;font:inherit;line-height:inherit;text-align:left;white-space:nowrap;" +
      "transition:background-color .12s ease-out,color .12s ease-out}" +
      ".it:hover,.it:focus-visible{background:var(--color-hover,rgba(255,255,255,.06))}" +
      ".it:focus-visible,.zu-gear:focus-visible{outline:2px solid var(--color-input-border-focused,var(--color-brand,#57c8ff))!important;outline-offset:2px}" +
      ".zu-gear{flex:0 0 auto;position:relative;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;" +
      "border:0;background:transparent;color:var(--color-foreground-subtle,#a1a1a1);font:inherit;line-height:1;cursor:pointer}" +
      ".zu-gear>svg{width:var(--ui-font-size,14px);height:var(--ui-font-size,14px);display:block;transform:translateY(-.5px)}" +
      /* v172 待办红点：待重启/有新版时亮（syncUpdate 按 restartRequired/phase 控制），crit 色呼吸 */
      ".zu-gear-dot{position:absolute;top:1px;right:1px;width:7px;height:7px;border-radius:50%;background:#ff6b57;display:none;animation:zupulse 1.6s ease-in-out infinite}" +
      ".zu-gear:hover{color:var(--color-foreground,#e9edf4);background:var(--color-hover,rgba(255,255,255,.07))}" +
      ".it.zu-sub{appearance:none;-webkit-appearance:none;cursor:pointer}" +
      ".it.zu-sub:focus-visible{outline:2px solid var(--color-input-border-focused,var(--color-brand,#57c8ff))!important;outline-offset:2px}" +
      ".sep{width:1px;height:15px;background:var(--color-border,rgba(255,255,255,.09));flex:0 0 auto;margin:0 3px}" +
      ".k{color:var(--color-foreground-subtle,#a1a1a1)}.v{color:var(--color-foreground,#e9edf4);font-weight:600}" +
      /* v319：数字与 t/s 同文本节点（"158.9 t/s"），切 sans 后 Segoe 空格（~3.7px）比
       * Consolas（7.15px）窄一半，视觉贴字——word-spacing 加距（用户实机逐档对比后定稿 4px），不改字符串
       * （text 经 ttEsc 转义、aria/tooltip 同串不受 DOM 改动影响） */
      /* v326：数字与 t/s 间距唯一机制=inline-flex+gap（word-spacing 已除——完成态无空格字符、动态态单文本调值无视觉效果，用户实测）；baseline 对齐防 flex 拉伸错位 */
      ".zu-live{color:var(--color-foreground,#e9edf4);font-weight:600;display:inline-flex;gap:5px;align-items:baseline}" +
      /* v176 子代理行内速率 chip：挂宿主 v4 Agent 行 .tool-summary-content 之后，颜色走
       * TPS 十档类（与条面同源），数字 tabular 不抖宽；cursor:help 提示可悬停看口径。 */
      ".zu-subrate{flex:0 0 auto;white-space:nowrap;cursor:help;font-size:12px;line-height:1.4;font-weight:600;font-variant-numeric:tabular-nums}" +
      /* v159 状态词流光（用户规格）：复刻宿主 .zcode-loading-label 同款参数——subtle→foreground→subtle
       * 横向渐变 background-clip:text 扫光 1.4s；类名/关键帧自有命名，不依赖宿主全局类防其改版。
       * reduced-motion 停动画（与宿主一致，渐变停在可见段）。 */
      "@keyframes zu-loading-shimmer{0%{background-position:200% 0}to{background-position:-200% 0}}" +
      ".zu-live.zu-shimmer{background-image:linear-gradient(90deg,var(--color-foreground-subtle,#8791a3) 35%,var(--color-foreground,#e9edf4) 50%,var(--color-foreground-subtle,#8791a3) 65%);color:#0000;-webkit-text-fill-color:transparent;background-position:200% 0;background-size:200% 100%;-webkit-background-clip:text;background-clip:text;font-weight:500;animation:1.4s linear infinite zu-loading-shimmer;display:inline-block}" +
      "@media (prefers-reduced-motion:reduce){.zu-live.zu-shimmer{animation:none;background-position:50% 0}}"+
      ".dim{color:var(--color-foreground-subtle,#a1a1a1);font-weight:400}" +
      /* 三档状态色刻意不走客户端变量（v58.1）：terminal-bright-* 是语法高亮色板，
       * 绿档在条面小字号/细进度条上发白（用户实测）；改用高对比自调档，
       * 浅色加深版在 .zu-light 组。 */
      ".ok{color:#3ecf8e}.warm{color:#f5b944}.hot{color:#ff6b57}" +
      /* v127 速度十档新增蓝紫系（阈值唯一事实源 = JS TPS_BANDS，CSS 只按类给色）。
       * ≥2000 Ultra：静态蓝紫渐变（background-clip:text 染字），@supports 外回退
       * 中间站纯紫；✦ 星点用 content:"✦"/"" 生成——替代文本为空，屏幕阅读器读不到、
       * 不占 textContent（原地改字路径零改动），静态无动画不发光。 */
      ".zu-teal{color:#2dd4bf}.zu-sky{color:#38bdf8}.zu-azure{color:#6d9fff}" +
      ".zu-violet{color:#9b8cff}.zu-purple{color:#bb86fc}.zu-magenta{color:#d88cff}" +
      ".zu-ultra{color:#a78bfa}.zu-ultra::before{content:\"✦\"/\"\";margin-right:2px}" +
      "@supports(-webkit-background-clip:text){" +
      ".zu-ultra{background:linear-gradient(100deg,#60a5fa 0%,#a78bfa 50%,#c084fc 100%);" +
      "-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}" +
      ".zu-ultra::before{background:linear-gradient(100deg,#60a5fa 0%,#a78bfa 50%,#c084fc 100%);" +
      "-webkit-background-clip:text;background-clip:text}}" +
      /* 超限=亮红呼吸闪烁（v38 定性"亮红闪烁优先于一切档位"，v54 落成动画） */
      "@keyframes zuexc{0%,100%{opacity:1}50%{opacity:.4}}" +
      ".exc{color:var(--color-destructive,#ff2d55);text-shadow:0 0 8px rgba(255,45,85,.5);animation:zuexc 1.1s ease-in-out infinite}" +
      ".btn{cursor:pointer;padding:2px 6px;border-radius:6px;color:var(--color-foreground-subtle,#7e8899);" +
      "transition:background-color .12s ease-out,color .12s ease-out}" +
      ".btn:hover{color:var(--color-foreground,#e9edf4);background:var(--color-hover,rgba(255,255,255,.07))}" +
      ".btn:active{transform:scale(.96)}" +
      /* 图标盒 = 宿主字号（.zu-gear>svg 同值）：24 格线性图标墨迹只占盒的 75%–83%，等字号盒下墨迹介于数字字高与中文字面之间；
       * 不加 +Npx 常量——加法会让比例随字号漂移（14px 时 1.29×、20px 时 1.2×）。数字字面略高于行盒中心，轮廓上移半像素作光学校正。 */
      ".zusage-root .ico{display:block;width:var(--ui-font-size,14px);height:var(--ui-font-size,14px);" +
      "flex:0 0 auto;align-self:center;overflow:visible;color:var(--color-foreground-subtle,#a1a1a1);opacity:1;transform:translateY(-.5px)}" +
      /* v321：速度格 .zu-live 豁免 flex——inline-flex 容器会把文本 item 的尾随空格剥离，
       * 数字态（"128.6 "+<span.dim>t/s）两 item 结构下空格根本不渲染、word-spacing 完全无效
       *（CDP 实测 spaceW=0、墨迹间隙 0，即用户「动态对、停止贴」的真根因；状态词态是单文本
       * item 不受影响）。豁免后内部回块级流，空格恢复渲染，v319 的 word-spacing:4px 真正生效，
       * 间隔=动态态的 ~7.7px。.zu-live 作为 .it 的 flex item 会被块化，外部布局零变化。 */
      ".zusage-root .it{line-height:1.3}.zusage-root .it>span:not(.eb):not(.zu-live){display:inline-flex;align-items:center;min-height:1.3em}" +
      ".zusage-root .eb .ico{width:12px;height:12px;transform:none}" +
      ".zusage-root .zu-think{color:var(--color-brand,#8171e8);opacity:1}" +
      /* 工具错误数徽标 */
      ".eb{background:rgba(255,107,87,.14);background:color-mix(in srgb,var(--color-destructive,#ff6b57) 14%,transparent);" +
      "color:var(--color-destructive,#ff8a73);border-radius:999px;padding:0 6px;line-height:16px;font-weight:600;display:inline-flex;align-items:center;gap:2px}" +
      ".eb .ico{color:inherit}" +
      /* v92 原生上下文按钮增强（原状态条「上下文容量」格 v93 删除，档位口径由本处承载）：四档色由 data-zusage-band 驱动 —— React
       * 不清理非 props 的手动属性；!important 压原生 text-success/text-warning/
       * text-foreground-subtle 变调；静态几何（r/描边/圆帽/透明度）用 CSS 覆盖
       * presentation attribute（永远生效），动态 pathLength/dasharray 由
       * enhanceCtxButton 写入。exc 复用 zuexc 呼吸闪烁。数值挂按钮内（环右侧）：
       * 悬停自动享受原生 hover:bg-hover 与「上下文容量」面板，width 由固定方形放开。 */
      "[data-testid=chat-context-usage-trigger][data-zusage-armed]{color:#3ecf8e!important;" +
      "width:auto!important;min-width:1.75rem;padding:0 3px;gap:4px}" +
      "[data-testid=chat-context-usage-trigger][data-zusage-armed][data-zusage-band=norm]{color:#3ecf8e!important}" +
      "[data-testid=chat-context-usage-trigger][data-zusage-armed][data-zusage-band=mid],[data-testid=chat-context-usage-trigger][data-zusage-armed][data-zusage-band=high]{color:#f5b944!important}" +
      "[data-testid=chat-context-usage-trigger][data-zusage-armed][data-zusage-band=crit]{color:#ff6b57!important}" +
      "[data-testid=chat-context-usage-trigger][data-zusage-armed][data-zusage-band=exc]{color:var(--color-destructive,#ff2d55)!important;" +
      "text-shadow:0 0 8px rgba(255,45,85,.5);animation:zuexc 1.1s ease-in-out infinite}" +
      "[data-testid=chat-context-usage-trigger][data-zusage-armed]>svg:not(.animate-spin) circle{opacity:1;stroke-width:3;r:9px}" +
      "[data-testid=chat-context-usage-trigger][data-zusage-armed]>svg:not(.animate-spin) circle:first-of-type{stroke:var(--color-hover,rgba(255,255,255,.1))}" +
      "[data-testid=chat-context-usage-trigger][data-zusage-armed]>svg:not(.animate-spin) circle:last-of-type{stroke:currentColor;stroke-linecap:round}" +
      /* v133：与额度 chip 同字体（14px 加粗，v315 起字族 sans+tabular-nums；显式声明不依赖按钮的 text-ui-base 链） */
      ".zu-ctxpct{display:inline-flex;align-items:center;flex:0 0 auto;" +
      "font-family:var(--font-sans,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);font-size:calc(var(--text-ui-base,var(--ui-font-size,14px)) - 1px);font-weight:700;font-variant-numeric:tabular-nums}" +
      /* 浅色档（与 .zu-light 组同源深化值）：标记由 enhanceCtxButton 随 bar 主题同步到
       * button（pct span 与环都在按钮内，同为 data-zusage-light 后代）。 */
      /* 浅色档必须带 [data-zusage-armed] 补足特异性（0,3,0）：否则暗色三属性档位规则
       * (0,3,0) 恒胜浅色两属性规则 (0,2,0)，浅色主题下 norm~crit 全部显示暗色档色 */
      "[data-zusage-light][data-zusage-armed][data-zusage-band=calm],[data-zusage-light][data-zusage-armed][data-zusage-band=norm]{color:#0f9d6c!important}" +
      "[data-zusage-light][data-zusage-armed][data-zusage-band=mid],[data-zusage-light][data-zusage-armed][data-zusage-band=high]{color:#b6791a!important}" +
      "[data-zusage-light][data-zusage-armed][data-zusage-band=crit]{color:#d8482f!important}" +
      "[data-zusage-light][data-zusage-armed][data-zusage-band=exc]{text-shadow:none}" +
      /* v131 pct span 与环一律继承按钮 currentColor（band 色唯一来源=上方 data-zusage-band
       * 规则），图标与文字天然同色；v127 的 .zu-ctxpct.ok/warm/hot 独立色随五档规格废止 */
      "[data-zusage-light] .zu-ctxpct.exc{text-shadow:none}" +
      /* v135 重置卡徽标（.zu-ctxrst，pct 右侧）：字体与 .zu-ctxpct 同链（14px 加粗，v315 起 sans
       * tabular-nums）；三档色沿用额度三色（用户规格 2026-10-28），crit 加 zupulse 呼吸
       * （与 .zu-quota.zu-qbusy 同动画）；浅色档由按钮 data-zusage-light 后代选择器换装 */
      ".zu-ctxrst{display:inline-flex;align-items:center;flex:0 0 auto;white-space:nowrap;" +
      "height:1.75rem;padding:0 3px;border-radius:.5rem;cursor:default;" +   /* 左右 3px（用户规格 2026-11-02，原 6px） */
      "font-family:var(--font-sans,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);font-size:calc(var(--text-ui-base,var(--ui-font-size,14px)) - 1px);font-weight:700;font-variant-numeric:tabular-nums}" +
      ".zu-ctxrst:hover{background:var(--color-hover,rgba(255,255,255,.08))}" +   // 与额度/Git chip 同款 hover 视格（用户反馈 2026-10-28）
      ".zu-ctxrst>svg{margin-right:3px}" +   // 图标↔数字间距（用户规格 2026-10-28 调优）
      ".zu-ctxrst.zu-rst-calm{color:#3ecf8e}" +
      ".zu-ctxrst.zu-rst-mid{color:#f5b944}" +
      ".zu-ctxrst.zu-rst-crit{color:#ff6b57;animation:zupulse 1s ease-in-out infinite}" +
      "[data-zusage-light] .zu-ctxrst.zu-rst-calm{color:#0f9d6c}" +
      "[data-zusage-light] .zu-ctxrst.zu-rst-mid{color:#b6791a}" +
      "[data-zusage-light] .zu-ctxrst.zu-rst-crit{color:#d8482f}" +
      /* v209 模型选择触发按钮（chat-model-select-trigger）左内边距减半（用户规格 2026-11-02）：
       * 文本态 pl-2 8px→4px；图标态（composer-model-icon）px-1.5 6px→3px。宿主 group 变体
       * 选择子特异性可达 (0,3,0)，用 !important 压制；图标态由第二条（同为 important、特异性
       * 更高）覆盖第一条取 3px。纯 CSS 不动宿主 DOM，随 <style> 生命周期生效/消失。 */
      "[data-testid=chat-model-select-trigger]{padding-left:4px!important}" +
      "[data-composer-model-icon=true] [data-testid=chat-model-select-trigger]{padding-left:3px!important}" +
      /* v136 编辑项目弹窗源文件夹完整路径（⚙ 通用区开关，纯 CSS 伪元素，零 DOM 注入）：
       * 宿主行的 span 恒挂完整路径 title、正文只显示末段（getPathLeaf）；::after 取
       * attr(title) 在名称下方补一行完整路径——不插任何节点，React 调和/增删文件夹/
       * 重开弹窗都无感，无需观察器与对账。.truncate 正向限定本地行（fixedFolder 远端行
       * 用 break-all 直接显示全路径，排除防重复）；多文件夹每行各取各的 title。宿主
       * truncate 的 nowrap 继承进伪元素，须显式 white-space:normal 恢复换行（用户规格
       * 2026-10-28：长路径自动换行、不做省略号）；break-all 与宿主 fixedFolder 行同款。
       * 规则由 <html> 的 data-zusage-pp 门控（applyProjPath），关闭即整体失效。 */
      '[data-zusage-pp="1"] [data-testid=virtual-project-root-name].truncate::after{content:attr(title);' +
      "display:block;white-space:normal;word-break:break-all;" +
      "font-size:var(--text-ui-sm,calc(var(--ui-font-size,14px) - 2px));line-height:1.45;" +
      "color:var(--color-foreground-subtle,#8791a3)}" +
      "[data-zusage-pp=\"1\"] [data-testid=virtual-project-root-name].truncate{cursor:pointer}" +   // v137：整行可点开文件管理器
      /* v146 宿主命令中心（⌘K 搜索弹框）加宽加高（⚙ 通用区开关）：宽度上限是宿主共享常量
       * quickPickDialogClassName 的 max-w-lg=512px（ZCode packages/ui quickpick/quickPickStyles.ts），
       * 弹框基础类自带 w-full + left-1/2 -translate-x-1/2（窄窗本就满宽），故只放宽 max-width：
       * max(32rem,80vw) 小窗保持原样、大窗放宽到窗口 80%。高度同规格：实际高度由 cmdk 列表
       * 驱动，其原生 max-h-[min(440px,calc(100dvh-15rem))] 的 440px 硬顶（CommandCenterDialog
       * commandCenterListClassName）才是"矮"的主因，放宽为 max(440px,calc(90dvh-15rem))
       * （15rem 沿用宿主非列表段余量结构），小窗 90dvh-15rem<440px 时保持原样；弹框根上限
       * 取 max(90dvh,calc(100dvh-6rem))——不低于原生 sm:max-h-[calc(100dvh-6rem)]，任何窗口
       * 不缩矮，根 90dvh 顶住时列表 overflow-y-auto 收缩滚动。:has 限定 cmdk 弹框（命令中心/
       * 任务搜索/快捷指令三弹框共用该样式常量，一并放宽），设置页等普通 Dialog 不含
       * cmdk-root 不受影响。属性值必须带引号：未加引号的数字值会让 Chrome 丢弃整条规则
       * （v136 实测）。规则由 <html> 的 data-zusage-cmdk 门控（applyCmdkW），关闭即整体失效。 */
      "[data-zusage-cmdk=\"1\"] div[data-slot=dialog-content]:has(>[data-slot=command][cmdk-root])" +
      "{max-width:max(32rem,80vw)!important;max-height:max(90dvh,calc(100dvh - 6rem))!important}" +
      "[data-zusage-cmdk=\"1\"] [data-slot=dialog-content] [cmdk-list]" +
      "{max-height:max(440px,calc(90dvh - 15rem))!important}" +
      /* v96 Git 状态 chip（工具行「电脑操作」按钮右侧）：外形对齐原生 ghost 按钮（h-7/rounded-lg/
       * px-1.5/gap-1）；配色移植 cc-pretty-statusline 的 git 段——图标+分支名暗灰，+插入绿 /
       * -删除红 / ?未跟踪黄，括号与 ↑↓ 随暗灰；浅色档（Catppuccin Latte 同源值）由 syncCtxLite
       * 写在 chip 自身的 data-zusage-light 切换。 */
      ".zu-git{display:inline-flex;align-items:center;gap:4px;height:1.75rem;padding:0 .375rem;border-radius:.5rem;" +
      "flex:0 0 auto;box-sizing:border-box;cursor:pointer;user-select:none;white-space:nowrap;outline:none;" +
      "font-family:var(--font-sans,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);" +
      "font-size:var(--ui-font-size,14px);line-height:1;font-variant-numeric:tabular-nums;color:#afafb2;transition:background-color .15s}" +
      ".zu-git:hover,.zu-git:focus-visible{background:var(--color-hover,rgba(255,255,255,.08))}" +
      ".zu-git:focus-visible,.zu-quota:focus-visible{outline:2px solid var(--color-input-border-focused,var(--color-brand,#57c8ff))!important;outline-offset:2px}" +
      ".zu-git>svg{width:16px;height:16px;flex:0 0 auto}" +
      ".zu-git .zu-git-ins{color:#aae6aa}" +
      ".zu-git .zu-git-del{color:#f09696}" +
      ".zu-git .zu-git-unt{color:#f0e6a0}" +
      ".zu-git-conflict{color:#f09696}" +
      ".zu-git-warn{color:#f0e6a0}" +
      ".zu-git-op{color:#afafb2}" +
      ".zu-git-sep{opacity:.6;padding:0 2px}" +   /* v212 间距收紧（用户规格 2026-11-02）：原靠字面空格「 · 」，视觉偏宽；改纯点+2px 内边距 */
      ".zu-git.zu-compact .zu-git-name,.zu-git.zu-compact .zu-git-ab{display:none}" +
      ".zu-git.zu-compact.zu-git-multi .zu-git-d{display:none}" +   // v96 multi 紧凑：聚合计数段一并收起（单仓紧凑保留行数段）
      "@keyframes zugitspin{to{transform:rotate(360deg)}}" +
      ".zu-git.zu-gbusy>svg{animation:zugitspin .8s linear infinite}" +
      ".zu-git[data-zusage-light]{color:#6c6f85}" +
      ".zu-git[data-zusage-light] .zu-git-ins{color:#2da587}" +
      ".zu-git[data-zusage-light] .zu-git-del{color:#d20f39}" +
      ".zu-git[data-zusage-light] .zu-git-unt{color:#df8e1d}" +
      ".zu-git[data-zusage-light] .zu-git-conflict{color:#d20f39}" +
      ".zu-git[data-zusage-light] .zu-git-warn{color:#946200}" +
      ".zu-git[data-zusage-light] .zu-git-op{color:#626579}" +
      /* v96 multi：脏仓段黄（有冲突时 .zu-conflict 整段红）+ 聚合改动计数 M 黄；浅色档同源深化/加浓值 */
      ".zu-git .zu-git-dirty{color:#f0e6a0}" +
      ".zu-git.zu-conflict .zu-git-dirty{color:#f09696}" +
      ".zu-git .zu-git-m{color:#f0e6a0}" +
      ".zu-git[data-zusage-light] .zu-git-dirty{color:#df8e1d}" +
      ".zu-git[data-zusage-light].zu-conflict .zu-git-dirty{color:#d20f39}" +
      ".zu-git[data-zusage-light] .zu-git-m{color:#df8e1d}" +
      /* v96 套餐额度 chip（原生上下文按钮左侧，wrapper 内前插）：多窗分段样式——每个窗口
       * 一段（中文 5小时/7天，英文 5h/7d）各自按 QUOTA_BANDS 上档位色；余额类型单段
       * （阶段 3 数据源接入即显示）；容器不着色，颜色只落在分段上。 */
      /* v133 字体显式声明（用户规格 2026-10-28 定稿；v315 起字族 sans）：14px（--ui-font-size）+ 加粗 + tabular-nums +
       * tabular-nums，额度与上下文百分比两处恒等——不再靠继承（工具栏容器字号偏小、
       * 与带 text-ui-base 的按钮不等高，实测两段字号不一致）。 */
      ".zu-quota{display:inline-flex;align-items:center;gap:5px;height:1.75rem;padding:0 3px;border-radius:.5rem;cursor:pointer;user-select:none;flex:0 0 auto;" +   /* 左右 3px（用户规格 2026-11-02，原 6px；.zu-tsb 不随动） */
      "font-family:var(--font-sans,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);font-size:calc(var(--text-ui-base,var(--ui-font-size,14px)) - 1px);font-weight:700;font-variant-numeric:tabular-nums}" +
      ".zu-quota:hover,.zu-quota:focus-visible{background:var(--color-hover,rgba(255,255,255,.08));outline:none}" +
      /* 额度 chip 三档视觉（用户规格 2026-10-28）：绿/黄/红映射 QUOTA_BANDS 五档阈值——
       * calm+norm(<50) 绿、mid+high(50–89) 黄、crit(90–99) 红，阈值表不动仅色值收敛；
       * exc(≥100) 独立异常态仍走 destructive+光晕+呼吸（视觉归红）。dim=无数据中性态保留。 */
      ".zu-qseg{white-space:nowrap}" +
      ".zu-qseg.zu-qb-calm,.zu-qseg.zu-qb-norm{color:#3ecf8e}" +
      ".zu-qseg.zu-qb-mid,.zu-qseg.zu-qb-high{color:#f5b944}" +
      ".zu-qseg.zu-qb-crit{color:#ff6b57}" +
      ".zu-qseg.zu-qb-exc{color:var(--color-destructive,#ff2d55);text-shadow:0 0 8px rgba(255,45,85,.5);animation:zuexc 1.1s ease-in-out infinite}" +   /* ≥100% 满档：呼吸闪烁保留（用户规格） */
      ".zu-qseg.dim{color:#9a9a9a}" +   /* v111 中性提示段（额度 未配置/暂不支持） */
      ".zu-qsep{color:var(--color-foreground-subtle,rgba(255,255,255,.28));font-weight:400;font-size:.8em;line-height:1;transform:translateY(-1px)}" +
      ".zu-quota.zu-qstale{opacity:.6}" +
      ".zu-quota.zu-qbusy{animation:zupulse 1s ease-in-out infinite}" +
      ".zu-quota .zu-qwarn{font-size:.85em;line-height:1}" +
      ".zu-quota[data-zusage-light] .zu-qseg.zu-qb-calm,.zu-quota[data-zusage-light] .zu-qseg.zu-qb-norm{color:#0f9d6c}" +
      ".zu-quota[data-zusage-light] .zu-qseg.zu-qb-mid,.zu-quota[data-zusage-light] .zu-qseg.zu-qb-high{color:#b6791a}" +
      ".zu-quota[data-zusage-light] .zu-qseg.zu-qb-crit{color:#d8482f}" +
      ".zu-quota[data-zusage-light] .zu-qseg.zu-qb-exc{text-shadow:none}" +
      ".zu-quota[data-zusage-light] .zu-qseg.dim{color:#8a8a8a}" +
      /* v146 精简模式速率 chip（.zu-tsb）：挂工具行、重置卡左侧；字体显式规格与 .zu-quota
       * 同源（--text-ui-base-1px + 700 + tabular-nums，用户规格 2026-10-28 对齐；v315 起字族 sans）。
       * 速率色档复用全局 .ok/.warm/.hot 与 TPS 十档类（含 Ultra 渐变 ✦）；浅色组靠 chip
       * 自身的 .zu-light 类补链（条隐藏后 .zu-light 祖先缺失）。 */
      ".zu-tsb{display:inline-flex;align-items:center;gap:5px;height:1.75rem;padding:0 6px;border-radius:.5rem;cursor:pointer;user-select:none;flex:0 0 auto;" +
      "font-family:var(--font-sans,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);font-size:calc(var(--text-ui-base,var(--ui-font-size,14px)) - 1px);font-weight:700;font-variant-numeric:tabular-nums}" +
      ".zu-tsb:hover,.zu-tsb:focus-visible{background:var(--color-hover,rgba(255,255,255,.08));outline:none}" +
      /* 阶段 3 ⚙ 源列表（v103 布局）：每源一张圆角小卡片（dsh QuotaCard 同款），卡片间距与
       * 内边距呼吸开；凭据框限宽不拉满；说明段落（card 直子 pnote）补水平边距 */
      ".zu-src-list{display:flex;flex-direction:column;gap:8px;padding:4px 12px 12px}" +
      ".zu-src-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;padding:10px 12px 11px;" +
      "border:1px solid var(--color-border,rgba(255,255,255,.08));border-radius:10px}" +
      ".zu-src-name{display:flex;align-items:center;gap:8px;flex:0 0 auto;font-weight:600}" +
      ".zu-src-status{flex:1 1 auto;min-width:0;color:var(--color-foreground-subtle,#a1a1a1);font-size:calc(var(--ui-font-size,14px) - 1px)}" +
      ".zu-src-feedback:empty{display:none}.zu-src-feedback{flex-basis:100%;min-height:1.35em;color:var(--color-foreground-subtle,#a1a1a1);font-size:calc(var(--ui-font-size,14px) - 2px);overflow-wrap:anywhere}" +
      ".zu-feedback-error{color:var(--color-destructive,#d8482f)}" +
      ".zu-src-refresh{background:none;border:none;color:inherit;cursor:pointer;font-size:14px;line-height:1;padding:2px 4px}" +
      ".zu-src-refresh:disabled{opacity:.4;cursor:default}" +
      ".zu-src-refresh[aria-busy=true]{animation:zupulse 1s ease-in-out infinite;cursor:progress}" +
      ".zu-src-refresh:hover{color:var(--color-foreground,#fafafa)}" +
      ".zu-src-fields{flex-basis:100%;display:flex;gap:8px;flex-wrap:wrap}" +
      ".zu-src-field{flex:1 1 220px;max-width:420px;min-width:0;background:var(--color-input,rgba(0,0,0,.25));border:1px solid var(--color-foreground-subtle,#8791a3);border-radius:6px;color:inherit;padding:4px 9px;font-family:var(--font-mono,monospace);font-size:calc(var(--ui-font-size,14px) - 2px)}" +
      /* v102 预设模板：官方域变体一键填充 chip + 控制台取 Key 链接 */
      ".zu-src-presets{flex-basis:100%;display:flex;gap:6px;flex-wrap:wrap;align-items:center}" +
      ".zu-src-preset{background:none;border:1px solid var(--color-border,rgba(255,255,255,.14));border-radius:999px;" +
      "color:var(--color-foreground-subtle,#8791a3);font:inherit;font-size:calc(var(--ui-font-size,14px) - 2px);line-height:1.4;padding:1px 9px;cursor:pointer}" +
      ".zu-src-preset:hover{color:var(--color-foreground,#e9edf4);border-color:var(--color-border-hover,rgba(255,255,255,.22))}" +
      ".zu-src-preset.on{color:var(--color-brand,#57c7ff);border-color:var(--color-brand,#57c7ff)}" +
      ".zu-src-keyurl{background:none;border:0;color:var(--color-brand,#57c7ff);font:inherit;font-size:calc(var(--ui-font-size,14px) - 2px);line-height:1.4;padding:2px 4px;cursor:pointer;white-space:nowrap}" +
      ".zu-src-keyurl:hover{text-decoration:underline}" +
      /* v128 模型拉取：供应商行卡片 + body 级选择弹窗（.panel 同族变量配色，浅深主题随变量） */
      ".zu-mp-list{display:flex;flex-direction:column;gap:8px;padding:4px 0 0}" +
      ".zu-mp-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:10px 12px;border:1px solid var(--color-border,rgba(255,255,255,.08));border-radius:10px}" +
      ".zu-mp-pick{width:100%;text-align:left;font:inherit;color:inherit;cursor:pointer}" +
      ".zu-mp-pick:hover{background:var(--color-hover,rgba(255,255,255,.06))}" +
      ".zu-mp-sub{color:var(--color-foreground-subtle,#8791a3);font-size:calc(var(--ui-font-size,14px) - 2px)}" +
      ".zu-mp-note{line-height:1.6;color:var(--color-foreground-subtle,#a1a1a1);overflow-wrap:anywhere}" +
      /* v132 弹窗视格对齐宿主设置页（用户指令）：宿主令牌映射——容器=bg-input+border-input-border
       * rounded-lg、行=px-3 py-2+border-b 分隔、控件高 h-8、徽标=bg-surface+text-ui-xs/sm、
       * 正文=ui 字体（模型 id 才 mono），字号/间距全部跟随 --ui-font-size */
      ".zu-mp-ov{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2147483647;display:flex;align-items:center;justify-content:center}" +
      ".zu-mp-modal{position:relative;display:flex;flex-direction:column;gap:10px;width:min(520px,calc(100vw - 48px));max-height:76vh;" +
      "background:rgba(19,22,30,.97);background:color-mix(in srgb,var(--color-card,#13161e) 97%,transparent);" +
      "backdrop-filter:blur(18px) saturate(1.3);-webkit-backdrop-filter:blur(18px) saturate(1.3);" +
      "border:1px solid var(--color-border,rgba(255,255,255,.09));border-radius:12px;padding:16px;" +
      "font-family:var(--font-sans,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);" +
      "font-size:var(--ui-font-size,14px);line-height:1.55;color:var(--color-foreground,#c6cdd9);" +
      "box-shadow:0 12px 32px rgba(0,0,0,.5)}" +
      ".zu-mp-head{display:flex;align-items:flex-start;gap:8px}" +
      ".zu-mp-title{flex:1;font-weight:600;color:var(--color-foreground,#eef2f8);font-size:calc(var(--ui-font-size,14px) + 1px);overflow-wrap:anywhere}" +
      ".zu-mp-head2{display:flex;align-items:center;gap:8px;padding-right:28px}" +
      ".zu-mp-close{position:absolute;top:12px;right:12px;background:none;border:none;color:var(--color-foreground-subtle,#8791a3);font-size:14px;line-height:1.4;cursor:pointer;padding:2px 6px}" +
      ".zu-mp-close:hover{color:var(--color-foreground,#fafafa)}" +
      ".zu-mp-tools{display:flex;flex-wrap:wrap;gap:8px;align-items:center}" +
      ".zu-mp-search{flex:1 1 160px;min-width:0;height:32px;background:var(--color-input,rgba(0,0,0,.3));border:1px solid var(--color-input-border,rgba(255,255,255,.14));color:var(--color-foreground,#e9edf4);border-radius:8px;padding:0 12px;font:inherit;outline:none;transition:border-color .15s}" +
      ".zu-mp-search::placeholder{color:var(--color-foreground-subtlest,#6b7484)}" +
      ".zu-mp-search:focus{border-color:var(--color-input-border-focused,var(--color-brand,#57c7ff))}" +
      ".zu-mp-quick{display:flex;gap:6px}" +
      ".zu-mp-quick button{font:inherit;font-size:calc(var(--ui-font-size,14px) - 1px);color:var(--color-foreground,#e9edf4);background:var(--color-secondary,rgba(255,255,255,.08));border:1px solid transparent;border-radius:8px;padding:0 10px;height:28px;cursor:pointer;white-space:nowrap;transition:background-color .15s}" +
      ".zu-mp-quick button:hover{background:var(--color-secondary-hover,rgba(255,255,255,.14))}" +
      ".zu-mp-items{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;background:var(--color-input,rgba(0,0,0,.25));border:1px solid var(--color-input-border,rgba(255,255,255,.12));border-radius:8px;scrollbar-width:thin}" +
      ".zu-mp-item{display:flex;align-items:center;gap:8px;padding:8px 12px;margin:0;cursor:pointer}" +
      ".zu-mp-item:not(:last-child){border-bottom:1px solid var(--color-input-border,rgba(255,255,255,.08))}" +
      ".zu-mp-item:hover{background:var(--color-hover,rgba(255,255,255,.05))}" +
      ".zu-mp-item input[type=checkbox]{accent-color:var(--color-brand,#57c7ff);margin-top:0}" +
      ".zu-mp-id{flex:1;min-width:0;font-family:var(--font-mono,Consolas,Menlo,monospace);font-size:var(--ui-font-size,14px);color:var(--color-foreground,#e9edf4);overflow-wrap:anywhere}" +
      ".zu-mp-meta{flex:0 0 auto;display:inline-flex;align-items:center;height:20px;padding:0 6px;border:1px solid var(--color-border,rgba(255,255,255,.1));border-radius:6px;background:var(--color-surface,rgba(255,255,255,.04));color:var(--color-foreground-subtle,#8791a3);font-family:var(--font-mono,Consolas,Menlo,monospace);font-size:calc(var(--ui-font-size,14px) - 2px);white-space:nowrap}" +
      ".zu-mp-badge{flex:0 0 auto;display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:6px;font-size:calc(var(--ui-font-size,14px) - 3px);line-height:1;white-space:nowrap}" +
      ".zu-mp-badge.zu-mp-old{color:var(--color-foreground-subtle,#8791a3);border:1px solid var(--color-border,rgba(255,255,255,.12));background:var(--color-surface,rgba(255,255,255,.03))}" +
      ".zu-mp-badge.zu-mp-new{color:#34D399;border:1px solid rgba(52,211,153,.45);background:rgba(52,211,153,.08)}" +   /* v132 新模型=emerald（HHQ 同源），浅色组换 700 档 */
      ".zu-mp-tst{flex:0 0 auto;position:relative;display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:6px;font-size:calc(var(--ui-font-size,14px) - 3px);line-height:1;white-space:nowrap}" +   /* v309 探测状态 chip（徽标前惰性插入，data-tip 承载原因） */
      ".zu-mp-tst.zu-mp-tst-run{color:var(--color-foreground-subtle,#8791a3);border:1px dashed var(--color-border,rgba(255,255,255,.25));background:transparent}" +
      ".zu-mp-tst.zu-mp-tst-ok{color:#34D399;border:1px solid rgba(52,211,153,.45);background:rgba(52,211,153,.08)}" +
      ".zu-mp-tst.zu-mp-tst-fail{color:#f87171;border:1px solid rgba(248,113,113,.5);background:rgba(248,113,113,.1);cursor:help}" +
      /* v310 原因气泡：宿主内原生 title 不弹（v307 实证），data-tip 伪元素从 chip 左侧
       * 水平弹出、行内垂直居中——列表容器 overflow:auto 只在上下方向裁剪，左弹不越界 */
      ".zu-mp-tst[data-tip]:hover::after{content:attr(data-tip);position:absolute;top:50%;right:calc(100% + 8px);transform:translateY(-50%);z-index:80;max-width:340px;width:max-content;padding:7px 10px;border:1px solid var(--color-popover-border,var(--color-border,rgba(255,255,255,.14)));border-radius:8px;background:var(--color-popover,#20242e);color:var(--color-popover-foreground,var(--color-foreground,#e9edf4));font-size:calc(var(--ui-font-size,14px) - 2px);line-height:1.5;white-space:pre-line;text-align:left;box-shadow:0 6px 18px rgba(0,0,0,.28);pointer-events:none}" +
      ".zu-mp-fix:empty{display:none}.zu-mp-fix{color:#34D399;overflow-wrap:anywhere;font-size:calc(var(--ui-font-size,14px) - 1px)}" +   /* v310 自动修复披露（绿=已写入，与 .zu-mp-err 红区并排） */
      ".zu-mp-warn:empty{display:none}.zu-mp-warn{color:#f5b944;overflow-wrap:anywhere;font-size:calc(var(--ui-font-size,14px) - 1px)}" +   /* v313 通道缺陷警告（琥珀=可用但有关键限制，档位色同额度黄） */
      ".zu-mp-bolt{width:18px;height:18px;flex:0 0 auto;color:#3B82F6}" +   /* 标题 ⚡（HHQ 同款蓝），浅色组换 600 档 */
      ".zu-mp-close-abs{position:absolute;top:12px;right:12px}" +
      ".zu-mp-host[aria-busy=true]{cursor:progress;opacity:.7}" +
      "@keyframes zumpspin{to{transform:rotate(360deg)}}" +
      ".zu-mp-host[aria-busy=true] svg{animation:zumpspin .9s linear infinite}" +
      ".zu-mp-err:empty{display:none}.zu-mp-err{color:var(--color-destructive,#d8482f);min-height:1.2em;overflow-wrap:anywhere;font-size:calc(var(--ui-font-size,14px) - 1px)}" +
      ".zu-mp-foot{display:flex;align-items:center;gap:10px;padding-top:2px}" +
      ".zu-mp-count{flex:1;color:var(--color-foreground-subtle,#8791a3);font-size:calc(var(--ui-font-size,14px) - 1px)}" +
      ".zu-mp-actions{display:flex;gap:8px}" +
      ".zu-mp-actions button{font:inherit;font-size:var(--ui-font-size,14px);color:var(--color-foreground,#e9edf4);background:var(--color-secondary,rgba(255,255,255,.08));border:1px solid transparent;border-radius:8px;height:32px;padding:0 10px;cursor:pointer;transition:background-color .15s}" +
      ".zu-mp-actions button:hover{background:var(--color-secondary-hover,rgba(255,255,255,.14))}" +
      /* 确认钮=宿主原生 default variant 令牌（bg-primary/text-primary-foreground/hover:/80，h-8 px-2.5） */
      ".zu-mp-actions .zu-mp-ok{color:var(--color-primary-foreground,#fff);background:var(--color-primary,#3B82F6);padding:0 10px}" +
      ".zu-mp-actions .zu-mp-ok:hover{background:color-mix(in srgb,var(--color-primary,#3B82F6) 80%,transparent)}" +
      ".zu-mp-actions button:disabled{opacity:.5;cursor:default}" +
      /* v132 浅色主题组：弹窗自带 .zu-light（openMpShell 按宿主 <html>.dark 同步，applyTheme 实时换装）——
       * 变量令牌随宿主翻转，此处只覆盖变量缺失的固定色 */
      ".zu-mp-ov.zu-light .zu-mp-modal{color:#1e293b;box-shadow:0 12px 32px rgba(0,0,0,.18)}" +
      ".zu-mp-ov.zu-light .zu-mp-title{color:#0f172a}" +
      ".zu-mp-ov.zu-light .zu-mp-sub,.zu-mp-ov.zu-light .zu-mp-count,.zu-mp-ov.zu-light .zu-mp-note{color:#64748b}" +
      ".zu-mp-ov.zu-light .zu-mp-search{background:#fff;border-color:#cbd5e1;color:#0f172a}" +
      ".zu-mp-ov.zu-light .zu-mp-search::placeholder{color:#94a3b8}" +
      ".zu-mp-ov.zu-light .zu-mp-quick button{color:#0f172a;background:#f1f5f9}" +
      ".zu-mp-ov.zu-light .zu-mp-quick button:hover{background:#e2e8f0}" +
      ".zu-mp-ov.zu-light .zu-mp-items{background:#fff;border-color:#e2e8f0}" +
      ".zu-mp-ov.zu-light .zu-mp-item:not(:last-child){border-bottom-color:#f1f5f9}" +
      ".zu-mp-ov.zu-light .zu-mp-item:hover{background:#f8fafc}" +
      ".zu-mp-ov.zu-light .zu-mp-id{color:#0f172a}" +
      ".zu-mp-ov.zu-light .zu-mp-meta{background:#f8fafc;border-color:#e2e8f0;color:#64748b}" +
      ".zu-mp-ov.zu-light .zu-mp-close{color:#64748b}.zu-mp-ov.zu-light .zu-mp-close:hover{color:#0f172a}" +
      ".zu-mp-ov.zu-light .zu-mp-badge.zu-mp-old{color:#94a3b8;border-color:#e2e8f0;background:#f1f5f9}" +
      ".zu-mp-ov.zu-light .zu-mp-badge.zu-mp-new{color:#059669;border-color:#6ee7b7;background:#ecfdf5}" +
      ".zu-mp-ov.zu-light .zu-mp-tst.zu-mp-tst-run{color:#64748b;border-color:#cbd5e1}" +
      ".zu-mp-ov.zu-light .zu-mp-tst.zu-mp-tst-ok{color:#059669;border-color:#6ee7b7;background:#ecfdf5}" +
      ".zu-mp-ov.zu-light .zu-mp-tst.zu-mp-tst-fail{color:#dc2626;border-color:#fca5a5;background:#fef2f2}" +
      ".zu-mp-ov.zu-light .zu-mp-tst[data-tip]:hover::after{background:#fff;color:#0f172a;border-color:#e2e8f0;box-shadow:0 6px 18px rgba(15,23,42,.12)}" +
      ".zu-mp-ov.zu-light .zu-mp-fix{color:#059669}" +
      ".zu-mp-ov.zu-light .zu-mp-warn{color:#b45309}" +
      ".zu-mp-ov.zu-light .zu-mp-actions button{color:#0f172a;background:#f1f5f9}" +
      ".zu-mp-ov.zu-light .zu-mp-actions button:hover{background:#e2e8f0}" +
      ".zu-mp-ov.zu-light .zu-mp-bolt{color:#2563EB}" +
      /* 子代理运行中呼吸灯 */
      "@keyframes zupulse{0%,100%{opacity:1}50%{opacity:.2}}" +
      ".dot{animation:zupulse 1.6s ease-in-out infinite;font-size:var(--ui-font-size,14px);line-height:1}" +
      /* 面板（v80 起 fixed 挂 body）：原 absolute 挂 bar、bottom:calc(100%+10px) 向上展开，
       * 但 in-card 形态下条长在输入卡片（overflow-hidden）内部，面板会被卡片裁掉——
       * 照 .tip/.zusage-exc 的 body+fixed 模式迁移，left/top 由 position*Panel 每帧按条矩形写。 */
      ".panel{position:fixed;background:rgba(19,22,30,.97);" +
      "background:color-mix(in srgb,var(--color-card,#13161e) 96%,transparent);" +
      "backdrop-filter:blur(18px) saturate(1.3);-webkit-backdrop-filter:blur(18px) saturate(1.3);" +
      "border:1px solid var(--color-border,rgba(255,255,255,.09));border-radius:12px;padding:12px 14px;display:none;" +
      "flex-direction:column;gap:4px;" +
      "font-family:var(--font-sans,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);" +
      "font-size:calc(var(--ui-font-size,14px) - 1px);line-height:1.6;color:var(--color-foreground,#c6cdd9);" +
      "box-shadow:inset 0 1px 0 rgba(255,255,255,.05),0 12px 32px rgba(0,0,0,.5),0 2px 8px rgba(0,0,0,.35);" +
      "min-width:280px;max-width:480px;max-height:72vh;overflow:auto;white-space:normal;z-index:2147483647;" +
      "scrollbar-width:thin;scrollbar-color:var(--color-border,rgba(255,255,255,.14)) transparent}" +
      ".panel.open{display:flex}" +
      /* v259：宿主多视图顶部有 48px [app-region:drag] 标题栏拖拽条（app.asar 实证，新建任务页无条件）；
       * Electron 拖拽区按几何命中、穿透上层未显式标注 no-drag 的元素——面板 top:8px 时头部（✕ 关闭钮）
       * 正落在条内，真实点击被窗口拖拽吞掉（「点击关闭无效」）。与宿主自家浮层同款修法：
       * 浮层根显式 no-drag 把自身矩形从拖拽区减掉（面板/子代理浮层、tooltip、mp 与压缩全屏遮罩）。 */
      ".zusage-panel,.tip,.zu-mp-ov,.zu-compact-dlg,.zu-rot-pk-dlg{-webkit-app-region:no-drag}" +
      ".zu-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}" +
      ".panel::-webkit-scrollbar{width:8px}" +
      ".panel::-webkit-scrollbar-thumb{background:var(--color-border,rgba(255,255,255,.14));border-radius:999px}" +
      ".panel label{display:flex;align-items:flex-start;gap:8px;cursor:pointer;padding:5px 8px;margin:0 -8px;" +
      "border-radius:8px;transition:background-color .12s ease-out}" +
      ".panel input[type=text]{width:110px;background:var(--color-input,rgba(0,0,0,.3));border:1px solid var(--color-foreground-subtle,#8791a3);" +
      "color:var(--color-foreground,#e9edf4);border-radius:6px;padding:2px 7px;font:inherit;outline:none}" +
      ".panel input[type=text]:focus{border-color:var(--color-brand,#57c7ff);box-shadow:0 0 0 2px rgba(87,199,255,.15)}" +
      ".panel .hr{border-top:1px solid var(--color-border,rgba(255,255,255,.08));margin:5px 0}" +
      ".panel .cap{color:var(--color-foreground-subtlest,#6b7484);margin:4px 0 2px;font-size:calc(var(--ui-font-size,14px) - 2px);letter-spacing:.08em}" +
      ".panel .phead{font-weight:600;color:var(--color-foreground,#eef2f8);font-size:calc(var(--ui-font-size,14px) + 2px);margin-bottom:7px;display:flex;align-items:center;gap:8px}" +
      ".panel .pver{color:var(--color-brand,#57c7ff);font-weight:400;font-size:calc(var(--ui-font-size,14px) - 2px);background:rgba(87,199,255,.12);background:color-mix(in srgb,var(--color-brand,#57c7ff) 12%,transparent);border-radius:999px;padding:1px 8px}" +
      ".panel label em{font-style:normal;color:var(--color-foreground-subtle,#6f7989);display:block}" +
      ".panel input[type=checkbox]{accent-color:var(--color-brand,#57c7ff);margin-top:3px}" +
      ".panel .pnote{line-height:1.6;color:var(--color-foreground-subtle,#6f7989);margin-top:3px}" +
      ".panel .zu-update-actions{display:flex;gap:8px;margin:5px 0}" +
      ".panel .zu-update-actions button{font:inherit;color:var(--color-foreground,#e9edf4);background:var(--color-hover,rgba(255,255,255,.07));border:1px solid var(--color-border,rgba(255,255,255,.14));border-radius:6px;padding:3px 10px;cursor:pointer}" +
      ".panel .zu-update-actions button:disabled{opacity:.5;cursor:default}" +
      /* v172 重启按钮：待重启时高亮；二次确认待命中强调色 */
      ".panel .zu-update-actions button[data-update=relaunch].zu-rr-armed{border-color:#ff6b57;color:#ff6b57}" +
      /* v208 已更新待重启提示条：与红点/armed 按钮同色系淡底强调 */
      ".panel .zu-upd-banner{margin:2px 0 5px;padding:5px 9px;border:1px solid rgba(255,107,87,.45);border-radius:6px;background:rgba(255,107,87,.12);color:#ff6b57;font-weight:600}" +
      ".panel .zu-upd-banner[hidden]{display:none}" +
      ".panel .zu-update-status{overflow-wrap:anywhere;white-space:pre-line}" +
      /* 更新进度（v89）：下载条按字节，安装条按校验/安装/同步三段推进；宿主安装器没有
       * 字节进度，用扫光动画表示仍在活动。主进程未推送 progress（旧版 updater）时整块隐藏。 */
      ".panel .zu-update-progress{display:flex;flex-direction:column;gap:6px;margin:6px 0 2px}" +
      ".panel .zu-update-progress[hidden]{display:none}" +
      ".panel .zu-progress-row{display:flex;align-items:center;gap:8px;font-size:calc(var(--ui-font-size,14px) - 1px);color:var(--color-foreground-subtle,#6f7989)}" +
      ".panel .zu-progress-label{flex:0 0 2.5em}" +
      ".panel .zu-progress-track{flex:1;height:6px;border-radius:999px;background:var(--color-hover,rgba(255,255,255,.08));overflow:hidden}" +
      ".panel .zu-progress-fill{height:100%;width:0;border-radius:999px;background:var(--color-brand,#57c7ff);transition:width .2s ease}" +
      ".panel .zu-progress-fill.active{background-image:linear-gradient(90deg,transparent 0,rgba(255,255,255,.4) 50%,transparent 100%);background-size:48px 100%;background-repeat:no-repeat;animation:zuProgressSweep 1.1s linear infinite}" +
      ".panel .zu-progress-value{flex:0 0 auto;min-width:3em;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}" +
      "@keyframes zuProgressSweep{from{background-position:-48px 0}to{background-position:calc(100% + 48px) 0}}" +
      /* v202 更新日志卡片：与更新卡片同款圆角边框；正文随设置内容区滚动，卡内不再开滚动条 */
      ".zu-settings .zu-notes-card{margin-top:12px;padding:12px 14px}" +
      ".zu-settings .zu-notes-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}" +
      ".zu-settings .zu-notes-title{font-weight:600;color:var(--color-foreground,#eef2f8);font-size:calc(var(--ui-font-size,14px) + 1px)}" +
      ".zu-settings .zu-notes-badge{font-size:calc(var(--ui-font-size,14px) - 2px);color:var(--color-brand,#57c7ff);background:color-mix(in srgb,var(--color-brand,#57c7ff) 12%,transparent);border-radius:999px;padding:1px 8px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".zu-settings .zu-notes-badge.zu-notes-warn{color:#d97706;background:color-mix(in srgb,#d97706 12%,transparent)}" +
      ".zu-settings .zu-notes-history-btn{margin-left:auto;font:inherit;font-size:calc(var(--ui-font-size,14px) - 2px);color:var(--color-foreground,#e9edf4);background:var(--color-hover,rgba(255,255,255,.07));border:1px solid var(--color-border,rgba(255,255,255,.14));border-radius:6px;padding:2px 10px;cursor:pointer}" +
      ".zu-settings .zu-notes-meta{color:var(--color-foreground-subtle,#6f7989);font-size:calc(var(--ui-font-size,14px) - 2px);margin-top:3px;overflow-wrap:anywhere}" +
      ".zu-settings .zu-notes-body{margin-top:8px;font-size:calc(var(--ui-font-size,14px) - 1px);color:var(--color-foreground,#c6cdd9);line-height:1.65;overflow-wrap:anywhere;min-width:0}" +
      ".zu-settings .zu-notes-body p{margin:4px 0}" +
      ".zu-settings .zu-notes-body ul,.zu-settings .zu-notes-body ol{margin:4px 0;padding-left:1.5em}" +
      ".zu-settings .zu-notes-body blockquote{margin:4px 0;padding:2px 10px;border-left:3px solid var(--color-border,rgba(255,255,255,.14));color:var(--color-foreground-subtle,#8d95a5)}" +
      ".zu-settings .zu-notes-body pre{background:var(--color-input,rgba(0,0,0,.25));border:1px solid var(--color-border,rgba(255,255,255,.1));border-radius:8px;padding:8px 10px;overflow-x:auto;font-family:var(--font-mono,Consolas,Menlo,'Microsoft YaHei UI',monospace);font-size:calc(var(--ui-font-size,14px) - 2px)}" +
      ".zu-settings .zu-notes-body code{font-family:var(--font-mono,Consolas,Menlo,'Microsoft YaHei UI',monospace);font-size:calc(var(--ui-font-size,14px) - 2px);background:var(--color-hover,rgba(255,255,255,.08));border-radius:4px;padding:0 4px}" +
      ".zu-settings .zu-notes-body pre code{background:none;padding:0}" +
      ".zu-settings .zu-notes-body hr{border:0;border-top:1px solid var(--color-border,rgba(255,255,255,.12));margin:8px 0}" +
      ".zu-settings .zu-notes-h{font-weight:600;color:var(--color-foreground,#eef2f8);margin:10px 0 4px;line-height:1.4}" +
      ".zu-settings .zu-notes-h1{font-size:calc(var(--ui-font-size,14px) + 2px)}" +
      ".zu-settings .zu-notes-h2{font-size:calc(var(--ui-font-size,14px) + 1px)}" +
      ".zu-settings .zu-notes-h3{font-size:var(--ui-font-size,14px)}" +
      ".zu-settings .zu-notes-lnk{background:none;border:0;padding:0;font:inherit;color:var(--color-brand,#57c7ff);text-decoration:underline;cursor:pointer;overflow-wrap:anywhere;text-align:left}" +
      ".zu-settings .zu-notes-attn{border:1px solid color-mix(in srgb,#d97706 45%,transparent);background:color-mix(in srgb,#d97706 8%,transparent);border-radius:8px;padding:6px 10px;margin:6px 0}" +
      ".zu-settings .zu-notes-more{color:var(--color-foreground-subtle,#6f7989);font-size:calc(var(--ui-font-size,14px) - 2px);margin-top:4px}" +
      ".zu-settings .zu-notes-foot{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:8px}" +
      ".zu-settings .zu-notes-foot button{font:inherit;font-size:calc(var(--ui-font-size,14px) - 2px);color:var(--color-foreground,#e9edf4);background:var(--color-hover,rgba(255,255,255,.07));border:1px solid var(--color-border,rgba(255,255,255,.14));border-radius:6px;padding:3px 10px;cursor:pointer}" +
      ".zu-settings .zu-notes-foot button:disabled{opacity:.5;cursor:default}" +
      ".zu-settings .zu-notes-link{border-color:var(--color-brand,#57c7ff);color:var(--color-brand,#57c7ff);background:none}" +
      ".zu-settings .zu-notes-history{margin-top:8px;border-top:1px solid var(--color-border,rgba(255,255,255,.09));padding-top:6px;display:flex;flex-direction:column;gap:2px}" +
      ".zu-settings .zu-notes-hist-item{display:flex;align-items:baseline;gap:8px;width:100%;text-align:left;font:inherit;font-size:calc(var(--ui-font-size,14px) - 1px);color:var(--color-foreground,#c6cdd9);background:none;border:0;border-radius:6px;padding:4px 6px;cursor:pointer}" +
      ".zu-settings .zu-notes-hist-item:hover{background:var(--color-hover,rgba(255,255,255,.07))}" +
      ".zu-settings .zu-notes-hist-ver{flex:0 0 auto;font-family:var(--font-mono,Consolas,Menlo,'Microsoft YaHei UI',monospace);font-variant-numeric:tabular-nums}" +
      ".zu-settings .zu-notes-hist-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--color-foreground-subtle,#8d95a5)}" +
      ".zu-settings .zu-notes-hist-note{color:var(--color-foreground-subtle,#6f7989);font-size:calc(var(--ui-font-size,14px) - 2px);padding:2px 6px}" +
      ".panel.zu-settings{box-sizing:border-box;min-width:0;max-width:none;" +
      "max-height:min(90vh,var(--zu-settings-height,90vh));padding:0;gap:0;overflow:hidden;line-height:1.5}" +
      ".zu-settings .zu-settings-head{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:12px;" +
      "padding:14px 16px;border-bottom:1px solid var(--color-border,rgba(255,255,255,.09))}" +
      ".zu-settings .phead{margin:0;font-size:var(--ui-font-size,14px);font-weight:600}" +
      ".zu-settings .zu-settings-close{position:relative;background:none;border:0;font:inherit;color:var(--color-foreground-subtle,#8791a3);" +
      "padding:2px 6px;border-radius:6px;cursor:pointer}" +
      /* v223：命中区外扩——按钮本体仅约 20×24px，悬停点击常落在四周 head 空白上无反应
         （用户反馈「不灵敏」）；::after 外扩 6px 扩大命中与 hover 反馈，不改布局。 */
      ".zu-settings .zu-settings-close::after{content:\"\";position:absolute;inset:-6px;border-radius:9px}" +
      ".zu-settings .zu-settings-close:hover::after{background:var(--color-hover,rgba(255,255,255,.07))}" +
      ".zu-settings .zu-settings-close:hover{background:var(--color-hover,rgba(255,255,255,.07))}" +
      /* 分区布局（v100）：左栏分组导航 + 右侧内容区（一次只显示一个分区），ZCode 设置页同款双栏 */
      ".zu-settings .zu-settings-layout{flex:1;min-height:0;display:flex}" +
      ".zu-settings .zu-settings-nav{flex:0 0 auto;width:164px;overflow-y:auto;padding:2px 8px 12px;scrollbar-width:thin;" +
      "scrollbar-color:var(--color-foreground-subtlest,#6b7484) transparent;border-right:1px solid var(--color-border,rgba(255,255,255,.09))}" +
      ".zu-settings .zu-settings-nav::-webkit-scrollbar{width:8px}" +
      ".zu-settings .zu-settings-nav::-webkit-scrollbar-thumb{background:var(--color-foreground-subtlest,#6b7484);border:2px solid transparent;background-clip:padding-box;border-radius:999px}" +
      ".zu-settings .zu-settings-navgroup+.zu-settings-navgroup{margin-top:16px}" +
      ".zu-settings .zu-navcap{padding:0 10px 5px;font-size:calc(var(--ui-font-size,14px) - 2px);font-weight:500;letter-spacing:0;" +
      "color:var(--color-remote-foreground-muted,#8d95a5)}" +
      /* 导航项：ZCode 侧栏同款 32px 行 + 12px 圆角 + surface-hover 激活底；图标恒为前景色 */
      ".zu-settings .zu-navitem{display:flex;align-items:center;gap:8px;width:100%;height:32px;padding:0 10px;border:0;border-radius:12px;" +
      "background:none;font:inherit;font-size:var(--ui-font-size,14px);line-height:1.4;text-align:left;cursor:pointer;position:relative;" +
      "color:var(--color-remote-foreground-muted,#8d95a5);transition:background-color .12s ease-out,color .12s ease-out}" +
      /* v172 「插件更新」导航红点：与齿轮红点同待办、同 ack */
      ".zu-settings .zu-nav-dot{position:absolute;top:5px;right:7px;width:6px;height:6px;border-radius:50%;background:#ff6b57;display:none}" +
      ".zu-settings .zu-navitem:hover,.zu-settings .zu-navitem[aria-current]{background:var(--color-surface-hover,rgba(255,255,255,.08));color:var(--color-foreground,#e9edf4)}" +
      ".zu-settings .zu-navitem[aria-current]{box-shadow:none;font-weight:500}" +
      ".zu-settings .zu-navitem:focus-visible{outline:2px solid var(--color-input-border-focused,var(--color-brand,#57c8ff))!important;outline-offset:2px}" +
      ".zu-settings .zu-nav-ic{flex:0 0 16px;display:inline-flex;align-items:center;justify-content:center;color:var(--color-foreground,#e9edf4)}" +
      ".zu-settings .zu-nav-ic svg{width:16px;height:16px;display:block}" +
      ".zu-settings .zu-nav-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      /* 窄条收成 icon rail（ZCode max-lg icon-only 同语义；阈值由 syncSettingsScroll 按面板实测宽切换） */
      ".zu-settings.zu-nav-icons .zu-settings-nav{width:52px;padding:2px 6px 12px}" +
      ".zu-settings.zu-nav-icons .zu-navitem{justify-content:center;padding:0}" +
      ".zu-settings.zu-nav-icons .zu-nav-label,.zu-settings.zu-nav-icons .zu-navcap{" +
      "position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}" +
      ".zu-settings .zu-settings-body{flex:1;min-width:0;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;" +
      "padding:16px clamp(16px,2vw,28px) 20px;scrollbar-width:thin;scrollbar-color:var(--color-foreground-subtlest,#6b7484) transparent}" +
      ".zu-settings .zu-settings-section{width:min(100%,960px);margin:0 auto}" +
      ".zu-settings .zu-settings-card{width:100%}" +
      ".zu-settings-body::-webkit-scrollbar{width:8px}" +
      ".zu-settings-body::-webkit-scrollbar-thumb{background:var(--color-foreground-subtlest,#6b7484);border:2px solid var(--color-card,#13161e);border-radius:999px}" +
      ".zu-settings.zu-settings-more .zu-settings-body{mask-image:linear-gradient(#000 calc(100% - 16px),transparent)}" +
      /* 分区标题（v100）：单分区视图下 cap 即该页标题，提级为前景色 + 略大字号 */
      ".zu-settings .cap{margin:0 0 8px;letter-spacing:0;color:var(--color-foreground,#e9edf4);font-weight:600;" +
      "font-size:calc(var(--ui-font-size,14px) + 1px)}" +
      ".zu-settings .zu-settings-card{border:1px solid var(--color-card-border,var(--color-border,rgba(255,255,255,.09)));border-radius:12px;" +
      "background:var(--color-card,var(--color-surface,rgba(255,255,255,.04)));overflow:hidden}" +
      ".zu-settings label{align-items:flex-start;gap:14px;margin:0;padding:12px 14px;border-radius:0}" +
      ".zu-settings label>span{padding-top:1px}" +
      ".zu-settings label>input{flex:0 0 auto;margin-top:4px}" +
      ".zu-settings label em{max-width:72ch}" +
      ".zu-settings .zu-settings-detail{max-width:88ch}" +
      ".zu-settings .zu-settings-card>label+label{border-top:1px solid var(--color-border,rgba(255,255,255,.09))}" +
      ".zu-settings label>span{flex:1;min-width:0;font-weight:500}" +
      ".zu-settings label em{font-weight:400;margin-top:2px;font-size:calc(var(--ui-font-size,14px) - 2px);line-height:1.5}" +
      ".zu-settings input[type=checkbox]{appearance:none;-webkit-appearance:none;order:2;position:relative;flex:0 0 28px;" +
      "width:28px;height:16px;margin:0;border:1px solid var(--color-border,rgba(255,255,255,.18));border-radius:999px;" +
      "background:var(--color-input,rgba(255,255,255,.12));border-color:var(--color-foreground-subtle,#8791a3);cursor:pointer}" +
      ".zu-settings input[type=checkbox]::before{content:'';position:absolute;left:2px;top:2px;width:10px;height:10px;" +
      "border-radius:50%;background:var(--color-foreground-subtle,#8791a3)}" +
      ".zu-settings input[type=checkbox]:checked{background:var(--color-brand,#57c7ff);border-color:var(--color-brand,#57c7ff)}" +
      ".zu-settings input[type=checkbox]:checked::before{left:14px;background:var(--color-background,#13161e)}" +
      ".zu-settings input:focus-visible,.zu-settings button:focus-visible{outline:2px solid var(--color-input-border-focused,var(--color-brand,#57c7ff))!important;outline-offset:2px}" +
      ".zu-settings input:disabled{opacity:.4;cursor:default}" +
      ".zu-settings .zu-ctxov{order:2;box-sizing:border-box;width:120px;min-width:0;padding:5px 7px}" +
      ".zu-settings .zu-ac-value{order:2;box-sizing:border-box;width:120px;min-width:0;padding:5px 7px}" +
      ".zu-settings .zu-ac-status{font-size:12px;line-height:1.5;opacity:.75;white-space:pre-wrap;word-break:break-word;padding:2px 14px 8px}" +
      ".zu-settings .zu-ac-status.zu-ac-warn{opacity:1;color:#d97706}" +
      ".zu-settings .zu-settings-langs,.zu-settings .zu-theme-options{display:flex;gap:8px;padding:10px 12px}" +
      ".zu-settings .zu-settings-langs label,.zu-settings .zu-theme-options label{flex:1;display:flex;align-items:center;gap:6px;padding:5px 8px;border:1px solid var(--color-border,rgba(255,255,255,.14));border-radius:6px}" +
      ".zu-settings .zu-theme-title{padding:12px 14px 0;font-weight:500}" +
      ".zu-settings input[type=radio]{accent-color:var(--color-brand,#57c7ff);margin:0}" +
      ".zu-settings .zu-settings-detail{padding:0 12px 10px}" +
      ".zu-settings .zu-settings-card>.pnote{padding:2px 12px 4px}" +
      ".zu-settings .zu-settings-detail .pnote{font-size:calc(var(--ui-font-size,14px) - 2px)}" +
      ".zu-settings .zu-settings-foot{flex:0 0 auto;display:flex;align-items:center;gap:10px;border-top:1px solid var(--color-border,rgba(255,255,255,.09));padding:9px 12px}" +
      ".zu-settings .zu-settings-scroll{display:block;flex:1;min-width:0;width:auto;border:0;background:none;font:inherit;" +
      "font-size:calc(var(--ui-font-size,14px) - 2px);color:var(--color-brand,#57c7ff);padding:2px;cursor:pointer}" +
      ".zu-settings .zu-settings-scroll:disabled{color:var(--color-foreground-subtle,#8791a3);cursor:default}" +
      /* 反馈按钮（v70）：常驻底栏右缘，点击经 window.open 交由系统默认浏览器打开 issues */
      ".zu-settings .zu-settings-feedback-status{flex:0 1 auto;min-width:0;color:var(--color-foreground-subtle,#a1a1a1);font-size:calc(var(--ui-font-size,14px) - 2px);overflow-wrap:anywhere}" +
      ".zu-settings .zu-settings-feedback{flex:0 0 auto;font:inherit;font-size:calc(var(--ui-font-size,14px) - 2px);" +
      "color:var(--color-foreground,#e9edf4);background:var(--color-hover,rgba(255,255,255,.07));" +
      "border:1px solid var(--color-border,rgba(255,255,255,.14));border-radius:6px;padding:3px 10px;cursor:pointer}" +
      /* 子代理明细面板（v49）：点击条目弹出的固定面板（与设置面板同机制，互斥打开）；
       * 面板不随鼠标消失，绕开悬停+tab 的全部几何问题。 */
      ".zu-sub{cursor:pointer}" +
      ".zu-sub:hover .v{color:var(--color-foreground,#fff)}" +
      /* v217 子代理统一浮层（.zu-sub-pop）：悬停预览/点击固定共用同一双栏组件。
       * 外壳=标题栏 54px / 左导航 28% / 右内容 / 底部说明 42px；面板 .panel 基础
       * 之上覆写：清 padding/gap、限宽高、字体走 UI sans（数值列单独 mono）。 */
      ".panel.zu-sub-pop{width:680px;max-width:calc(100vw - 24px);height:auto;min-height:0;max-height:calc(100vh - 24px);padding:0;gap:0;border-radius:14px;overflow:hidden;font-family:var(--font-sans,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);font-size:var(--ui-font-size,14px);line-height:1.55}" +
      ".zu-sph{flex:0 0 auto;display:flex;align-items:center;gap:10px;height:44px;padding:0 14px;border-bottom:1px solid var(--color-border,rgba(255,255,255,.09))}" +
      ".zu-sph-t{font-size:calc(var(--ui-font-size,14px) + 4px);font-weight:700;color:var(--color-foreground,#f1f2f3)}" +
      ".zu-sph-scope{margin-left:auto;font-size:calc(var(--ui-font-size,14px) - 2px);color:var(--color-foreground-subtle,#a8aaae);border:1px solid var(--color-border,rgba(255,255,255,.16));border-radius:999px;padding:2px 11px;white-space:nowrap}" +
      ".zu-sph-x{display:flex;align-items:center;justify-content:center;background:none;border:0;color:var(--color-foreground-subtle,#a8aaae);cursor:pointer;padding:5px;border-radius:7px}" +
      ".zu-sph-x:hover{color:var(--color-foreground,#f1f2f3);background:var(--color-hover,rgba(255,255,255,.08))}" +
      ".zu-spb{flex:1 1 auto;min-height:0;display:flex}" +
      ".zu-spnav{flex:0 0 160px;min-width:0;display:flex;flex-direction:column;background:rgba(0,0,0,.16);border-right:1px solid var(--color-border,rgba(255,255,255,.09));padding:10px 0 6px}" +
      ".zu-light .zu-spnav{background:rgba(0,0,0,.035)}" +
      ".zu-spnav-item{display:block;width:calc(100% - 14px);margin:1px 7px;padding:5px 8px 5px 9px;text-align:left;background:none;border:0;border-left:2px solid transparent;border-radius:0 8px 8px 0;color:var(--color-foreground-subtle,#a8aaae);font:inherit;font-size:calc(var(--ui-font-size,14px) - 2px);line-height:1.45;cursor:pointer}" +
      ".zu-spnav-item:hover{color:var(--color-foreground,#f1f2f3);background:var(--color-hover,rgba(255,255,255,.06))}" +
      ".zu-spnav-item.on{color:#b6a1f2;background:rgba(182,161,242,.14);border-left-color:#b6a1f2;font-weight:600}" +
      ".zu-light .zu-spnav-item.on{color:#6f54c8;background:rgba(111,84,200,.10);border-left-color:#6f54c8}" +
      ".zu-spnav-item:focus-visible{outline:2px solid var(--color-brand,#a3cfff);outline-offset:-2px}" +
      ".zu-spnav-label{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;overflow-wrap:anywhere;word-break:break-word}" +
      ".zu-spnav-live{display:block;font-size:calc(var(--ui-font-size,14px) - 2px);font-weight:400;color:#3ecf8e;margin-top:1px}" +
      ".zu-light .zu-spnav-live{color:#0c8a63}" +
      ".zu-spnav-h{padding:8px 16px 2px;font-size:calc(var(--ui-font-size,14px) - 2px);letter-spacing:.06em;color:var(--color-foreground-subtlest,#6b7484)}" +
      ".zu-spnav-list{flex:1 1 auto;min-height:0;overflow-y:auto;padding-bottom:4px}" +
      ".zu-spbody{flex:1 1 auto;min-width:0;overflow-y:auto;max-height:calc(100vh - 100px);padding:12px 14px}" +
      ".zu-spnav-list::-webkit-scrollbar,.zu-spbody::-webkit-scrollbar{width:8px}" +
      ".zu-spnav-list::-webkit-scrollbar-thumb,.zu-spbody::-webkit-scrollbar-thumb{background:var(--color-border,rgba(255,255,255,.14));border-radius:999px}" +
      ".zu-spview-head{display:flex;align-items:baseline;gap:10px;margin-bottom:10px}" +
      ".zu-spview-head h3{margin:0;font-size:calc(var(--ui-font-size,14px) + 2px);font-weight:700;color:var(--color-foreground,#f1f2f3);min-width:0;overflow-wrap:anywhere}" +
      ".zu-spsub{color:var(--color-foreground-subtle,#a8aaae);font-size:calc(var(--ui-font-size,14px) - 2px);white-space:nowrap;flex:0 0 auto}" +
      ".zu-spstate{margin-left:auto;display:flex;align-items:center;gap:7px;color:var(--color-foreground-subtle,#a8aaae);font-size:calc(var(--ui-font-size,14px) - 2px);white-space:nowrap;flex:0 0 auto}" +
      ".zu-spstate .dot{width:7px;height:7px;border-radius:50%;background:var(--color-foreground-subtlest,#6b7484)}" +
      ".zu-spstate.run .dot{background:#3ecf8e}" +
      ".zu-light .zu-spstate.run .dot{background:#0c8a63}" +
      ".zu-sp-kpis3{display:grid;grid-template-columns:1fr 1fr 1fr;background:var(--color-surface,rgba(255,255,255,.035));border:1px solid var(--color-border,rgba(255,255,255,.07));border-radius:8px;padding:8px 0;margin-bottom:8px}" +
      ".zu-sp-kpi{min-width:0;padding:2px 12px}" +
      ".zu-sp-kpi + .zu-sp-kpi{border-left:1px solid var(--color-border,rgba(255,255,255,.08))}" +
      ".zu-sp-kpi .k{font-size:calc(var(--ui-font-size,14px) - 3px);color:var(--color-foreground-subtle,#a8aaae);margin-bottom:2px;display:flex;align-items:center;gap:4px;min-width:0;white-space:nowrap}" +".zu-sp-kpi .k svg{flex:none;opacity:.85}" +".zu-sp-kpi .k .hit{color:#4ade80;font-weight:600;font-size:calc(var(--ui-font-size,14px) - 3px);white-space:nowrap}" +
      ".zu-sp-kpi .v{font-family:var(--font-sans,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);font-variant-numeric:tabular-nums;font-size:calc(var(--ui-font-size,14px) + 8px);font-weight:700;color:var(--color-foreground,#f1f2f3);line-height:1.3}" +
      ".zu-sp-kpi .v small{font-size:calc(var(--ui-font-size,14px) - 2px);font-weight:600;color:var(--color-foreground-subtle,#a8aaae);margin-left:4px}" +".zu-sp-kpis3--mid .zu-sp-kpi .v{font-size:calc(var(--ui-font-size,14px) + 6px)}" +".zu-sp-kpis3--duo{grid-template-columns:1fr 1fr}" +".zu-sp-kpis3--duo .zu-sp-kpi:only-child{grid-column:1/-1;border-left:0}" +
      ".zu-sp-kpi .u{font-size:calc(var(--ui-font-size,14px) - 3px);color:var(--color-foreground-subtlest,#6b7484);margin-top:2px}" +
      ".zu-sp-kpi .u .hit{color:#4ade80;font-weight:600}" +
      ".zu-sp-models{margin-top:10px;border-top:1px solid var(--color-border,rgba(255,255,255,.09));padding-top:10px}" +
      ".zu-sp-models h4{margin:0 0 7px;font-size:var(--ui-font-size,14px);font-weight:700;color:var(--color-foreground,#f1f2f3)}" +
      ".zu-sp-models table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}" +
      ".zu-sp-models thead th{background:none;text-align:right;font-weight:500;color:var(--color-foreground-subtle,#a8aaae);font-size:calc(var(--ui-font-size,14px) - 3px);padding:0 6px 5px;border-bottom:1px solid var(--color-border,rgba(255,255,255,.14));white-space:nowrap}" +
      ".zu-sp-models thead th:first-child{text-align:left;padding-left:2px}" +
      ".zu-sp-models td{padding:4px 6px;border-top:1px solid var(--color-border,rgba(255,255,255,.08));text-align:right;color:var(--color-foreground,#e6e9ef);font-family:var(--font-sans,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);font-size:calc(var(--ui-font-size,14px) - 1px);white-space:nowrap}" +
      ".zu-sp-models tr:first-child td{border-top:0}" +
      ".zu-sp-models td:first-child{text-align:left;padding-left:2px;font-family:inherit;color:var(--color-foreground,#f1f2f3);white-space:normal;overflow-wrap:anywhere}" +
      ".zu-sp-meta{display:flex;flex-wrap:wrap;gap:4px 16px;align-items:baseline;margin-top:10px;padding-top:10px;border-top:1px solid var(--color-border,rgba(255,255,255,.09));color:var(--color-foreground-subtle,#a8aaae);font-size:calc(var(--ui-font-size,14px) - 3px)}" +
      ".zu-sp-meta b{font-family:var(--font-sans,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);font-variant-numeric:tabular-nums;font-weight:600;color:var(--color-foreground,#e6e9ef)}" +
      ".zu-spf{flex:0 0 auto;display:flex;align-items:center;gap:8px;min-height:34px;padding:8px 14px;border-top:1px solid var(--color-border,rgba(255,255,255,.09));color:var(--color-foreground-subtle,#a8aaae);font-size:calc(var(--ui-font-size,14px) - 1px)}" +
      "@media (max-width:700px){.zu-spb{flex-direction:column}.zu-spnav{flex:0 0 auto;max-height:150px;border-right:0;border-bottom:1px solid var(--color-border,rgba(255,255,255,.09))}.zu-spnav-list{overflow-y:auto}.zu-spbody{flex:1 1 auto}}" +
      /* 自绘 tooltip（v31）：向上弹出（原生 title 方向不可控且会被窗口下缘遮挡），
       * 支持多 tab；white-space:pre-line 保留数据里的 \n 换行。
       * v32：fixed 挂 body —— 原 absolute 挂 bar，被页面消息流的层叠上下文盖住
       * （diag 实证 disp=block 但不可见），挂 body 用视口坐标独立定位。
       * v81：底色/边框/文字改宿主 Radix Tooltip 同款（bg-tooltip + border-border +
       * text-tooltip-foreground，反色底：暗色主题白底黑字、浅色主题黑底白字），
       * 内部次级文字用宿主 tooltip-tag 系变量；毛玻璃在实色底下无意义，删。 */
      ".tip{position:fixed;background:var(--color-tooltip,#171717);" +
      "border:1px solid var(--color-popover-border,var(--color-border,transparent));border-radius:10px;padding:10px 13px;" +
      "font-family:var(--font-sans,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);" +
      "font-variant-numeric:tabular-nums;" +
      "font-size:calc(var(--ui-font-size,14px) - 1px);line-height:1.55;color:var(--color-tooltip-foreground,#fafafa);" +
      "box-shadow:0 10px 28px rgba(0,0,0,.5),0 2px 6px rgba(0,0,0,.3);" +
      "white-space:pre-line;z-index:2147483646;width:max-content;max-width:min(560px,calc(100vw - 24px));max-height:calc(100vh - 24px);overflow:auto;display:none;scrollbar-width:thin}" +
      /* 结构化 tooltip：标签次于标题，数值回到高对比前景；长说明自然折行。 */
      ".tip .rt-h{font-weight:600;color:var(--color-tooltip-foreground,#fafafa);margin:0 0 8px}" +
      ".tip .rt-row{display:flex;gap:12px;margin:4px 0;align-items:flex-start}" +
      ".tip .rt-row b{flex:0 0 auto;min-width:86px;white-space:nowrap;color:var(--color-tooltip-tag-foreground,#a6a6a6);font-weight:500}" +
      /* v164 模型名等长键不换行（键列随内容加宽）；rt-pin 吸底行遮住滚过的内容并分隔 */
      ".tip .rt-pin{position:sticky;bottom:0;z-index:1;background:var(--color-tooltip,#171717);margin-top:6px;padding-top:7px;border-top:1px solid var(--color-popover-border,var(--color-border,transparent))}" +
      /* v165 模型明细表格化：整块共享最宽键列，token/次数列纵向对齐 */
      ".tip .rt-models{display:table;margin:5px 0 2px}" +
      ".tip .rt-models .rt-row{display:table-row;margin:0}" +
      ".tip .rt-models .rt-row b{display:table-cell;padding:2.5px 14px 2.5px 0;white-space:nowrap}" +
      ".tip .rt-models .rt-row span{display:table-cell;white-space:nowrap}" +
      ".tip .rt-tool{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:16px;margin:5px 0;align-items:baseline}.tip .rt-tool-name{overflow-wrap:anywhere}.tip .rt-tool>.rt-atom{text-align:right}" +
      ".tip .rt-atom{display:inline-block;white-space:nowrap}" +
      ".tip .rt-row span{min-width:0;color:var(--color-tooltip-foreground,#fafafa);overflow-wrap:normal}" +
      ".tip .rt-note{margin-top:8px;padding-top:7px;border-top:1px solid var(--color-popover-border,var(--color-border,transparent));color:var(--color-tooltip-tag-foreground,#a6a6a6);overflow-wrap:anywhere}" +
      /* v127 颜色对照图例：档位类（.zu-teal 等）与条面同源，tip 内直接生效、随 .zu-light 切浅色 */
      ".tip .rt-legend{display:flex;flex-wrap:wrap;gap:3px 10px;margin-top:8px;padding-top:7px;" +
      "border-top:1px solid var(--color-popover-border,var(--color-border,transparent));font-weight:600}" +
      ".tip .rt-legend b{color:var(--color-tooltip-tag-foreground,#a6a6a6);font-weight:500;margin-right:2px}" +
      ".tip .rt-lsep{color:var(--color-tooltip-tag-foreground,#a6a6a6);font-weight:400}" +
      ".ttabs{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:7px}" +
      ".ttab{font:inherit;border:0;text-align:left;cursor:pointer;padding:2px 10px;border-radius:999px;background:var(--color-tooltip-tag,#262626);" +
      "color:var(--color-tooltip-tag-foreground,#a6a6a6);white-space:nowrap;font-size:calc(var(--ui-font-size,14px) - 1px);" +
      "transition:background-color .12s ease-out,color .12s ease-out}" +
      ".ttab:hover{color:var(--color-tooltip-foreground,#fafafa);background:color-mix(in srgb,var(--color-tooltip-foreground,#fafafa) 12%,transparent)}" +
      ".ttab.on{background:color-mix(in srgb,var(--color-brand,#5ac8ff) 16%,transparent);color:var(--color-brand,#5ac8ff)}" +
      ".tbody{max-height:60vh;overflow:auto;scrollbar-width:thin;scrollbar-gutter:stable}" +
      /* v214 项目累计统计卡（作用域 .zu-project-tip；:has 定位本条，不动共享 .tip/.rt-* 规则）。
       * 字体分层：标题/标签/说明用宿主 sans 令牌，数值用 mono + tabular-nums（局部例外，
       * 其余 tooltip 仍统一 mono）。颜色全部沿用 tooltip 语义变量，浅色经 .zu-light 成套切换。 */
      ".zusage-tip-root:has(.zu-project-tip){max-width:min(840px,calc(100vw - 24px))}" +
      ".zusage-tip-root:has(.zu-project-tip) .tbody{padding:12px 15px}" +
      ".zu-project-tip{font-family:var(--font-sans,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);font-size:calc(var(--ui-font-size,14px) + 1px);line-height:1.5;color:var(--color-tooltip-foreground,#fafafa)}" +
      ".zu-pj-head{display:flex;align-items:baseline;justify-content:space-between;gap:14px;margin-bottom:8px}" +
      ".zu-pj-title{font-size:calc(var(--ui-font-size,14px) + 4px);font-weight:700;letter-spacing:.5px}" +
      ".zu-pj-range{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;font-size:calc(var(--ui-font-size,14px) - 2px);color:var(--color-tooltip-foreground,#fafafa);opacity:.72;border:1px solid var(--color-popover-border,rgba(255,255,255,.16));border-radius:999px;padding:2px 10px}" +
      ".zu-pj-scope{color:inherit}" +
      ".zu-pj-sub{color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-pj-sub::before{content:'· ';opacity:.6}" +
      ".zu-pj-kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:0 9px;background:rgba(255,255,255,.045);border-radius:8px;padding:7px 9px}" +
      ".zu-light .zu-pj-kpis{background:rgba(0,0,0,.045)}" +
      ".zu-pj-kpi{min-width:0}" +
      ".zu-pj-kpi + .zu-pj-kpi{border-left:1px solid var(--color-popover-border,rgba(255,255,255,.12));padding-left:9px}" +
      ".zu-light .zu-pj-kpi + .zu-pj-kpi{border-left-color:rgba(0,0,0,.12)}" +
      ".zu-pj-k{font-size:calc(var(--ui-font-size,14px) - 2px);color:var(--color-tooltip-tag-foreground,#a6a6a6);display:flex;align-items:center;gap:5px}" +
      ".zu-pj-v{font-family:var(--font-sans,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);font-variant-numeric:tabular-nums;font-size:calc(var(--ui-font-size,14px) + 15px);font-weight:700;margin-top:4px;white-space:nowrap}" +
      ".zu-pj-details{display:grid;grid-template-columns:repeat(3,1fr);gap:0 18px;margin-top:16px}" +
      ".zu-pj-detail .zu-pj-k{margin-bottom:2px}" +
      ".zu-pj-dv{font-family:var(--font-sans,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);font-variant-numeric:tabular-nums;font-size:calc(var(--ui-font-size,14px) + 7px);font-weight:600;white-space:nowrap}" +
      ".zu-pj-dsub{font-size:calc(var(--ui-font-size,14px) - 2px);color:var(--color-tooltip-tag-foreground,#a6a6a6);margin-top:2px}" +
      ".zu-pj-hit{color:#4ade80;font-weight:600}" +
      ".zu-pj-scale{margin-top:14px;font-size:calc(var(--ui-font-size,14px) - 1px);color:var(--color-tooltip-tag-foreground,#a6a6a6);display:flex;flex-wrap:wrap;column-gap:8px}" +
      /* v229：标题旁项目名，字号/颜色同规模行（.zu-pj-scale）；父级 .zu-pj-title 的 700/.5px 须显式还原。
         v230.1 垂直居中：标题容器带名称时切 flex（.zu-tt-name），名称为 flex 子项中心对齐——
         行内 baseline/bottom 对齐会被 18px 大字的 descent 拖得视觉偏低（用户实机指认） */
      ".zu-tt-name{display:flex;align-items:center}" +
      ".zu-pj-pname{font-size:calc(var(--ui-font-size,14px) - 1px);font-weight:400;letter-spacing:normal;color:var(--color-tooltip-tag-foreground,#a6a6a6);margin-left:8px}" +
      ".zu-pj-mhead{display:flex;align-items:baseline;justify-content:space-between;margin:9px 0 4px}" +
      ".zu-pj-mtitle{font-size:calc(var(--ui-font-size,14px) + 2px);font-weight:700}" +
      ".zu-pj-morder{display:none}" +
      ".zu-pj-table{width:100%;border-collapse:collapse;font-size:var(--ui-font-size,14px)}" +
      ".zu-pj-table th{font-weight:500;color:var(--color-tooltip-tag-foreground,#a6a6a6);text-align:right;padding:0 10px 7px;border-bottom:1px solid var(--color-popover-border,rgba(255,255,255,.14));white-space:nowrap}" +
      ".zu-light .zu-pj-table th{border-bottom-color:rgba(0,0,0,.14)}" +
      ".zu-pj-table th:first-child{text-align:left;padding-left:2px}" +
      ".zu-pj-table td{padding:7px 10px;border-top:1px solid var(--color-popover-border,rgba(255,255,255,.08));height:32px;box-sizing:border-box;text-align:right;font-family:var(--font-sans,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);font-variant-numeric:tabular-nums;white-space:nowrap}" +
      ".zu-light .zu-pj-table td{border-top-color:rgba(0,0,0,.08)}" +
      ".zu-pj-table tr:first-child td{border-top:0}" +
      ".zu-pj-table td:first-child{text-align:left;font-family:var(--font-sans,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);padding-left:2px;max-width:300px;overflow:hidden;text-overflow:ellipsis}" +
      ".zu-pj-more{display:block;margin:10px auto 0;background:none;border:0;color:var(--color-brand,#a3cfff);font:inherit;font-size:var(--ui-font-size,14px);cursor:pointer;padding:4px 12px;border-radius:8px}" +
      ".zu-pj-more:hover{text-decoration:underline}" +
      ".zu-pj-time{display:flex;flex-wrap:wrap;gap:2px 10px;margin-top:7px;padding-top:6px;border-top:1px solid var(--color-popover-border,rgba(255,255,255,.12));font-size:calc(var(--ui-font-size,14px) - 2px);color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-light .zu-pj-time{border-top-color:rgba(0,0,0,.12)}" +
      ".zu-pj-time b{font-weight:500}" +
      ".zu-pj-time span{font-family:var(--font-sans,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);font-variant-numeric:tabular-nums}" +
      /* v215 六统计卡（生成速度/本轮/会话累计/工具调用/今日合计/子代理）：作用域
       * .zu-stat-tip + 类型修饰；:has 定位本条，不动共享 .tip/.rt-* 规则；字体分层同项目卡。 */
      ".zusage-tip-root:has(.zu-stat-tip){max-width:min(840px,calc(100vw - 24px))}" +
      ".zusage-tip-root:has(.zu-stat-tip) .tbody{padding:12px 15px}" +
      ".zu-stat-tip{font-family:var(--font-sans,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);font-size:calc(var(--ui-font-size,14px) + 1px);line-height:1.5;color:var(--color-tooltip-foreground,#fafafa)}" +
      ".zu-stat-head{display:flex;align-items:baseline;justify-content:space-between;gap:14px;margin-bottom:8px}" +
      ".zu-stat-title{font-size:calc(var(--ui-font-size,14px) + 4px);font-weight:700;letter-spacing:.5px}" +
      ".zu-stat-scope{font-size:calc(var(--ui-font-size,14px) - 2px);color:var(--color-tooltip-foreground,#fafafa);opacity:.72;border:1px solid var(--color-popover-border,rgba(255,255,255,.16));border-radius:999px;padding:2px 10px;white-space:nowrap}" +
      ".zu-light .zu-stat-scope{border-color:rgba(0,0,0,.2)}" +
      ".zu-stat-kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:0 9px;background:rgba(255,255,255,.045);border-radius:8px;padding:7px 9px}" +
      ".zu-light .zu-stat-kpis{background:rgba(0,0,0,.045)}" +
      ".zu-stat-kpis.cols2{grid-template-columns:repeat(2,1fr)}" +
      ".zu-stat-kpis.zu-stat-kpis--sub{background:rgba(255,255,255,.025);padding:6px 9px;margin-top:16px}" +
      ".zu-light .zu-stat-kpis.zu-stat-kpis--sub{background:rgba(0,0,0,.025)}" +
      ".zu-stat-kpis.zu-stat-kpis--sub .zu-stat-v{font-size:calc(var(--ui-font-size,14px) + 7px);font-weight:600}" +
      ".zu-stat-kpis.zu-stat-kpis4{grid-template-columns:repeat(4,1fr);gap:0 8px}" +
      ".zu-stat-kpis.zu-stat-kpis4 .zu-stat-kpi + .zu-stat-kpi{padding-left:8px}" +
      ".zu-stat-kpis.zu-stat-kpis4 .zu-stat-v{font-size:calc(var(--ui-font-size,14px) + 4px);white-space:normal;overflow-wrap:break-word}" +
      ".zu-stat-kpis.zu-stat-kpis4 .zu-stat-v small{display:block;font-size:calc(var(--ui-font-size,14px) - 2px);margin-top:1px}" +
      ".zu-stat-kpi{min-width:0}" +
      ".zu-stat-kpi + .zu-stat-kpi{border-left:1px solid var(--color-popover-border,rgba(255,255,255,.12));padding-left:9px}" +
      ".zu-light .zu-stat-kpi + .zu-stat-kpi{border-left-color:rgba(0,0,0,.12)}" +
      ".zu-stat-k{font-size:calc(var(--ui-font-size,14px) - 2px);color:var(--color-tooltip-tag-foreground,#a6a6a6);display:flex;align-items:center;gap:5px}" +
      ".zu-stat-v{font-family:var(--font-sans,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);font-variant-numeric:tabular-nums;font-size:calc(var(--ui-font-size,14px) + 15px);font-weight:700;margin-top:4px;white-space:nowrap}" +
      ".zu-stat-v small{font-size:calc(var(--ui-font-size,14px) + 2px);font-weight:600;color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-stat-v.err,.zu-stat-kpi.err .zu-stat-v{color:#ff6b57}" +
      ".zu-light .zu-stat-v.err,.zu-light .zu-stat-kpi.err .zu-stat-v{color:#d8482f}" +
      ".zu-stat-grid2{display:grid;grid-template-columns:repeat(2,1fr);gap:0 9px;margin-top:8px}" +
      ".zu-stat-grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:0 18px;margin-top:12px}" +
      ".zu-stat-dv{font-family:var(--font-sans,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);font-variant-numeric:tabular-nums;font-size:calc(var(--ui-font-size,14px) + 7px);font-weight:600;white-space:nowrap;margin-top:2px}" +
      ".zu-stat-dsub{font-size:calc(var(--ui-font-size,14px) - 2px);color:var(--color-tooltip-tag-foreground,#a6a6a6);margin-top:2px}" +
      ".zu-stat-dsub .hit{color:#4ade80;font-weight:600}" +
      ".zu-stat-scale{margin-top:7px;font-size:calc(var(--ui-font-size,14px) - 1px);color:var(--color-tooltip-tag-foreground,#a6a6a6);display:flex;flex-wrap:wrap;column-gap:8px}" +
      /* v230：会话累计标题旁会话名，字号/颜色同规模行（.zu-stat-scale）；v230.1 垂直居中走
         .zu-tt-name 容器 flex；ellipsis 仍需块级盒（flex 子项自动块化，省略号成立） */
      ".zu-st-name{font-size:calc(var(--ui-font-size,14px) - 1px);font-weight:400;letter-spacing:normal;color:var(--color-tooltip-tag-foreground,#a6a6a6);margin-left:8px;max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".zu-stat-note{font-size:calc(var(--ui-font-size,14px) - 2px);color:var(--color-tooltip-tag-foreground,#a6a6a6);margin-top:6px}" +
      ".zu-stat-time .zu-stat-note{flex:0 0 100%;margin-top:4px}" +
      ".zu-stat-time{display:flex;flex-wrap:wrap;gap:4px 10px;margin-top:14px;padding-top:12px;border-top:1px solid var(--color-popover-border,rgba(255,255,255,.12));font-size:calc(var(--ui-font-size,14px) - 2px);color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-light .zu-stat-time{border-top-color:rgba(0,0,0,.12)}" +
      ".zu-stat-time b{font-weight:500}" +
      ".zu-stat-time span{font-family:var(--font-sans,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);font-variant-numeric:tabular-nums}" +
      ".zu-stat-table{width:100%;border-collapse:collapse;font-size:var(--ui-font-size,14px)}" +
      ".zu-stat-table th{font-weight:500;color:var(--color-tooltip-tag-foreground,#a6a6a6);text-align:right;padding:0 10px 7px;border-bottom:1px solid var(--color-popover-border,rgba(255,255,255,.14));white-space:nowrap}" +
      ".zu-light .zu-stat-table th{border-bottom-color:rgba(0,0,0,.14)}" +
      ".zu-stat-table th:first-child{text-align:left;padding-left:2px}" +
      ".zu-stat-table td{padding:7px 10px;border-top:1px solid var(--color-popover-border,rgba(255,255,255,.08));height:32px;box-sizing:border-box;text-align:right;font-family:var(--font-sans,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);font-variant-numeric:tabular-nums;white-space:nowrap}" +
      ".zu-light .zu-stat-table td{border-top-color:rgba(0,0,0,.08)}" +
      ".zu-stat-table tr:first-child td{border-top:0}" +
      ".zu-stat-table td:first-child{text-align:left;font-family:var(--font-sans,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);padding-left:2px;max-width:300px;overflow:hidden;text-overflow:ellipsis}" +
      ".zu-stat-table td.err{color:#ff6b57;font-weight:600}" +
      ".zu-light .zu-stat-table td.err{color:#d8482f}" +
      ".zu-stat-table td.dim0{color:var(--color-tooltip-tag-foreground,#a6a6a6);opacity:.7}" +
      ".zu-stat-more{display:block;margin:10px auto 0;background:none;border:0;color:var(--color-brand,#a3cfff);font:inherit;font-size:var(--ui-font-size,14px);cursor:pointer;padding:4px 12px;border-radius:8px}" +
      ".zu-stat-more:hover{text-decoration:underline}" +
      ".zu-speed-hero:has(.zu-sl-body){grid-template-columns:1fr}" +
      ".zu-speed-hero{display:grid;grid-template-columns:1fr 1fr;gap:0 9px;background:rgba(255,255,255,.045);border-radius:8px;padding:8px 9px}" +
      ".zu-light .zu-speed-hero{background:rgba(0,0,0,.045)}" +
      ".zu-speed-hero .zu-stat-kpi + .zu-stat-kpi{border-left:1px solid var(--color-popover-border,rgba(255,255,255,.12));padding-left:9px}" +
      ".zu-light .zu-speed-hero .zu-stat-kpi + .zu-stat-kpi{border-left-color:rgba(0,0,0,.12)}" +
      ".zu-speed-main{font-family:var(--font-sans,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);font-variant-numeric:tabular-nums;font-size:calc(var(--ui-font-size,14px) + 22px);font-weight:700;line-height:1.15;margin-top:4px;white-space:nowrap}" +
      ".zu-speed-main small{font-size:calc(var(--ui-font-size,14px) + 4px);font-weight:600;color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-speed-sub{font-family:var(--font-sans,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);font-variant-numeric:tabular-nums;font-size:calc(var(--ui-font-size,14px) + 11px);font-weight:700;margin-top:4px;white-space:nowrap}" +
      ".zu-speed-sub small{font-size:calc(var(--ui-font-size,14px) - 1px);font-weight:600;color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-speed-bandtag{display:inline-block;margin-top:8px;font-family:var(--font-sans,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);font-size:calc(var(--ui-font-size,14px) - 1px);border:1px solid var(--color-popover-border,rgba(255,255,255,.16));border-radius:999px;padding:2px 10px}" +
      ".zu-legend-head{display:flex;align-items:baseline;justify-content:space-between;margin:18px 0 8px}" +
      ".zu-legend-title{font-size:calc(var(--ui-font-size,14px) + 2px);font-weight:700}" +
      ".zu-legend-unit{font-size:calc(var(--ui-font-size,14px) - 2px);color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-legend-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:8px 10px}" +
      "@media (max-width:760px){.zusage-tip-root:has(.zu-stat-tip) .zu-legend-grid{grid-template-columns:repeat(3,1fr)}}" +
      ".zu-legend-item{display:flex;align-items:center;gap:7px;min-width:0;padding:3px 6px;border-radius:8px;border:1px solid transparent}" +
      ".zu-legend-item.cur{border-color:var(--color-popover-border,rgba(255,255,255,.35));background:rgba(255,255,255,.05)}" +
      ".zu-light .zu-legend-item.cur{background:rgba(0,0,0,.05)}" +
      ".zu-legend-dot{flex:0 0 auto;width:9px;height:9px;border-radius:50%}" +
      ".zu-legend-item b{font-family:var(--font-sans,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);font-variant-numeric:tabular-nums;font-weight:600;font-size:calc(var(--ui-font-size,14px) - 1px);white-space:nowrap}" +
      ".zu-legend-item .dot-c{background:currentColor}" +
      ".zu-legend-dot.zu-ultra{display:none;background:linear-gradient(100deg,#60a5fa 0%,#a78bfa 50%,#c084fc 100%)}" +
      ".zu-legend-dot.zu-ultra::before{content:none}" +
      /* v246 用户规格：图例 Ultra 档只留文字，色点整体隐藏；渐变/clip 规则保留供恢复。
       * 档位说明弹层例外（2026-11-07 用户规格）：色点 visibility:hidden 占位，
       * 「≥2000」与其他项文字同一起点（display:none 会左移 12px 破坏列对齐）。 */
      ".zu-sv-li .zu-legend-dot.zu-ultra{display:inline-block;visibility:hidden}" +
      /* Ultra 星点是 .zu-ultra::before 伪元素（v127 档位体系），弹层内一并去除
       * （2026-11-07 用户规格：≥2000 前不带 logo）；文字起点仍由上方占位规则对齐。 */
      ".zu-sv-li b.zu-ultra::before{content:none}" +
      /* ---------- v254 速度 Tooltip 重构样式（仅 .zu-sv-root 作用域，不碰旧图） ---------- */
      ".zu-sv-root{display:flex;flex-direction:column;gap:0}" +
      /* v278：单行 Header——标题居左、双 Tab 组整体靠右（filter margin-left:auto）；
       * 窄窗 wrap 后 Tab 组整体换行仍右对齐。统计时间轻量化（去胶囊底/边框），
       * 图表标题栏右端 + title 完整区间。 */
      ".zu-sv-head{display:flex;align-items:center;flex-wrap:wrap;gap:6px 12px;margin-bottom:10px}" +
      ".zu-sv-title{font-weight:700;font-size:calc(var(--ui-font-size,14px) + 6px);letter-spacing:.2px}" +
      ".zu-sv-range{display:inline-flex;align-items:center;gap:5px;flex:0 0 auto;max-width:60%;margin-left:auto;" +
        "font-family:var(--font-sans,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);font-variant-numeric:tabular-nums;" +
        "font-size:calc(var(--ui-font-size,14px) - 3px);color:var(--color-tooltip-tag-foreground,#a6a6a6);white-space:nowrap}" +
      ".zu-sv-range svg{width:13px;height:13px;flex:0 0 auto;opacity:.75}" +
      ".zu-sv-range span{overflow:hidden;text-overflow:ellipsis}" +
      ".zu-sv-filter{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-left:auto;justify-content:flex-end}" +
      ".zu-sv-flabel{font-size:calc(var(--ui-font-size,14px) - 3px);color:var(--color-tooltip-tag-foreground,#a6a6a6);flex:0 0 auto}" +
      ".zu-sv-time{display:flex;align-items:center;gap:6px;margin-left:14px}" +
      ".zu-sv-tabs{display:flex;flex:0 1 auto;flex-wrap:wrap;gap:2px;padding:2px;border-radius:9px;" +
        "background:rgba(255,255,255,.045);border:1px solid var(--color-popover-border,rgba(255,255,255,.1))}" +
      ".zu-light .zu-sv-tabs{background:rgba(0,0,0,.04)}" +
      ".zu-sv-tab{appearance:none;border:0;background:transparent;color:var(--color-tooltip-tag-foreground,#a6a6a6);" +
        "font-family:inherit;font-size:calc(var(--ui-font-size,14px) - 2px);line-height:1.4;font-weight:600;padding:6px 10px;border-radius:7px;cursor:pointer;white-space:nowrap}" +
      ".zu-sv-tab:hover{color:var(--color-foreground,#e9edf4);background:rgba(255,255,255,.06)}" +
      ".zu-light .zu-sv-tab:hover{background:rgba(0,0,0,.05)}" +
      /* v263：选中态改柔和强调（宿主 --color-brand 在当前主题解析为近白，直接当底色
       * 会出大面积纯白块——固定强调色深浅主题都可预期）；字重恒 600 防选中加粗跳动。 */
      /* v282：选中态对齐 Hover 低对比背景（去高饱和蓝块）：同 hover 底色系 + 略亮 +
       * 发丝内描边区分「暂时 hover/持续选中」；字重恒 600（v263 防选中加宽跳动纪律）。 */
      ".zu-sv-tab.on{background:rgba(255,255,255,.07);color:var(--color-foreground,#e9edf4);box-shadow:inset 0 0 0 1px rgba(255,255,255,.08)}" +
      ".zu-light .zu-sv-tab.on{background:rgba(0,0,0,.06);color:var(--color-foreground,#1c212b);box-shadow:inset 0 0 0 1px rgba(15,23,42,.08)}" +
      ".zu-sv-tab.on:hover{background:rgba(255,255,255,.09)}" +
      ".zu-light .zu-sv-tab.on:hover{background:rgba(0,0,0,.07)}" +
      ".zu-sv-tab:focus-visible{outline:2px solid var(--color-brand,#a3cfff);outline-offset:1px}" +
      ".zu-sv-notice{flex:0 0 100%;font-size:calc(var(--ui-font-size,14px) - 3px);color:var(--color-tooltip-tag-foreground,#a6a6a6);margin-top:2px}" +
      /* v274：左卡按内容自然高，不再强制撑满图表高度（§11.2） */
      /* v281 P1：右图表列弹性占满剩余宽度且 min-width:0——列宽只由 tip 定宽决定，
       * 不再被 plot max-content/图表头文案反向撑缩（宽随 Tab 跳动的根因） */
      /* 左卡撑满 body 高度（2026-11-07 用户规格，收回 v274「自然高」）：
       * zu-sl-body flex:1 吸收富余高，主数字居中、峰值/最低/最新钉底 */
      ".zu-sv-root .zu-speed-body{gap:12px;align-items:stretch;flex:1;min-height:0}" +
      /* v292：整卡定高 315 后图表列纵向布局——head 自然高、图表区吃剩余 */
      ".zu-sv-chart{display:flex;flex-direction:column;min-height:0;" +
        "border:1px solid var(--color-popover-border,rgba(255,255,255,.14));" +
        "border-radius:12px;padding:10px 12px;box-sizing:border-box}" +
      ".zu-light .zu-sv-chart{border-color:rgba(15,23,42,.14)}" +
      ".zu-sv-chart .zu-sc-wrap{flex:1;min-height:0;padding:5px 0;box-sizing:border-box}" +
      ".zu-sv-root .zu-speed-chart{flex:1 1 0;min-width:0;max-width:100%}" +
      ".zu-sv-root .zu-sv-left{flex:0 0 210px;gap:0}" +
      /* v295.1（定高 300）：左卡内容紧凑化——主数字 +22px 会让 stats 行溢出卡底
       * 被 tip 裁切，降至 +12px 并收紧间距 */
      ".zu-sv-root .zu-sv-left .zu-sl-main{font-size:calc(var(--ui-font-size,14px) + 12px)}" +
      ".zu-sv-root .zu-sv-left .zu-sl-body{gap:6px}" +
      ".zu-sv-root .zu-sv-left .zu-sl-main{font-size:calc(var(--ui-font-size,14px) + 22px)}" +
      /* v278：左卡标题升为「平均速度」（.zu-sl-title 是旧卡八态共用类，只在本卡
       * 作用域覆写），「历史统计」降为小号标识；实时状态仍为行尾轻量标识 */
      ".zu-sv-root .zu-sl-title{font-weight:600;font-size:calc(var(--ui-font-size,14px) - 1px);color:var(--color-foreground,#e9edf4)}" +
      /* v327：状态词恒不收缩不折行——大字号（--ui-font-size≥17）下标题行溢出时
       * 收缩由标题独享（ellipsis 降级），状态词不出现竖排破版（他机实报） */
      ".zu-sv-root .zu-sl-sub{margin-left:6px;flex:0 0 auto;white-space:nowrap;font-weight:400;font-size:calc(var(--ui-font-size,14px) - 3px);color:var(--color-tooltip-tag-foreground,#a6a6a6);opacity:.85}" +
      ".zu-sv-root .zu-sv-left .zu-sl-body{justify-content:center}" +
      /* 标题栏贴图表左缘（Y 轴刻度同侧，不再缩进 30px）；基类 baseline 改 center，
       * 标题/单位徽章/档位按钮/时间文字垂直居中（基类为旧图保留不动）。 */
      ".zu-sv-chart .zu-sc-head{margin-left:0;align-items:center;flex-wrap:wrap;row-gap:2px}" +
            /* v286：标题 600/+2（不过重）；单位「t/s」轻量徽章（弱化前景+微亮底，
       * 视觉优先级 标题＞单位＞档位入口）；问号换 Speed Bands SVG，命中区 26px。 */
      ".zu-sv-chart .zu-sc-title{font-weight:600;font-size:calc(var(--ui-font-size,14px) + 2px);line-height:1.3}" +
      ".zu-sv-chart .zu-sc-unit{margin-left:9px;background:rgba(255,255,255,.05);border-radius:5px;padding:2px 7px;" +
        "font-size:calc(var(--ui-font-size,14px) - 3px);color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-light .zu-sv-chart .zu-sc-unit{background:rgba(0,0,0,.05)}" +
      /* min-width 取 max(300px, 100%-30px)：宽窗拉满图表列（2026-11-07 用户规格，
       * 少柱不再缩在左侧 300px 死区——原 calc 与后方 300px 兜底同特异性分层，
       * 后者按序胜出把拉宽压死，现合并单点声明）；窄窗回 300px 横滚兜底 */
      ".zu-sv-plotrow{display:flex;align-items:stretch;flex:1;min-height:0;min-width:0}" +
      /* v295.18（用户规格）：Y 轴刻度列固定（移出滚动容器，宽 30px），同「全部」
       * 热力图左侧星期列模式；plot 不再留 30px 缩进 */
      ".zu-sv-gutcol{flex:0 0 30px;position:relative;padding:5px 0;box-sizing:border-box}" +
      ".zu-sv-gutcol .zu-sc-gutter{position:absolute;left:0;top:5px;bottom:33px;width:30px}" +
      /* v303.3：-30px 右缩进移除——v295.18 刻度列已外移出滚动容器（兄弟节点），
       * 该缩进残留使柱区永远差 30px 不到右缘（用户实报红框） */
      ".zu-sv-plot{position:relative;height:100%;margin-left:0;min-width:max(300px,100%);width:max-content;max-width:none;box-sizing:content-box}" +
      ".zu-sv-spacer{display:block;height:0}" +
      /* 覆盖提示 .zu-sc-cov 与聚焦切换 .zu-sv-focus 样式随 2026-11-07 文案批一并删除 */
      ".zu-sv-plot .zu-sc-grid{height:calc(100% - 28px)}" +
      ".zu-sv-plot .zu-sc-gutter{height:calc(100% - 28px)}" +
      /* 柱组左对齐（2026-11-08 用户规格，收回 v273 少柱居中；2026-11-09 用户规格
       * 落地为 flex-start：space-between 在少柱时把首末柱推到 plot 两缘，用户实报
       * 改居左、贴 Y 轴起排，多桶横滚态密度不变）。
       * padding 0 5px：柱顶 nowrap 数值（5 字符 ~27px > 24px 列宽）越缘 ~1.5px
       * 会在 .zu-sc-wrap 撑出 ~2px 可滚区（用户实报「最近 3 轮」横向可滚一点点）
       * ——两侧各留 5px 呼吸边距（容 6 字符粗体值），溢出归零即无横滚 */
      ".zu-sv-bars{position:absolute;inset:0;display:flex;align-items:flex-end;justify-content:flex-start;gap:0;padding:0 5px}" +
      /* 细柱定宽：少量柱不拉伸、数据多时横滚，柱组居中 */
      ".zu-sv-bars .zu-sc-col{flex:0 0 24px;height:100%}" +
      ".zu-sv-bars .zu-sc-vz{flex:1 1 auto;height:auto}" +
      ".zu-sv-bars .zu-sc-bar{width:14px;max-width:14px}" +
      ".zu-sv-bars .zu-sc-x{height:16px;flex:0 0 16px;width:24px;max-width:24px;" +
        "overflow:visible;justify-content:flex-start;align-items:flex-end;font-size:7px}" +
      ".zu-sv-bars .zu-sc-x b{display:block;width:100%;overflow:hidden;text-overflow:clip;text-align:center;line-height:14px}" +
      ".zu-sv-bars .zu-sc-col.empty .zu-sc-bar{background:transparent;box-shadow:none}" +
      ".zu-sv-bars .zu-sc-col.cur .zu-sc-val{font-weight:700}" +
      ".zu-sv-chart .zu-sc-wrap{overflow-x:auto;overflow-y:hidden;width:100%;min-width:0;max-width:100%}" +
      /* v290 隐藏横向滚动条（2026-11-08 用户规格）：V2 作用域 only（旧图共享类不动），
       * 滚轮横滚（同批 wheel 委托）不受隐藏影响；条带 8px 视觉错位随之消失 */
      ".zu-sv-chart .zu-sc-wrap::-webkit-scrollbar{display:none}" +
      /* v281 P0：hover 五字段信息卡改宿主于 body 级 Portal（.zu-sv-portal，
       * pointer-events:none 纯展示不拦鼠标；表面样式由 .zu-sv-card 自带，
       * 定位由 spdHoverPortalPlace 按柱体 rect 避让视口边界）。
       * 旧 .zu-sv-card-anchor（plot 内绝对定位，被 .zu-sc-wrap overflow 裁剪）删除。 */
      ".zu-sv-card{width:252px;box-sizing:border-box;" +
        "background:var(--color-popover,#1c212b);border:1px solid var(--color-popover-border,rgba(255,255,255,.18));" +
        "border-radius:9px;padding:7px 10px;box-shadow:0 8px 22px rgba(0,0,0,.42);display:flex;flex-direction:column;gap:3px}" +
      ".zu-light .zu-sv-card{box-shadow:0 8px 22px rgba(15,23,42,.18)}" +
      ".zu-sv-crow{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:10px;line-height:1.35}" +
      ".zu-sv-crow>span{flex:0 0 auto;color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-sv-crow>b{min-width:0;text-align:right;font-family:var(--font-sans,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);font-variant-numeric:tabular-nums;" +
        "font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--color-foreground,#e9edf4)}" +
      ".zu-sv-crow>b small{display:block;font-size:9px;font-weight:400;color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-sv-crow>b.zu-sv-twrap{white-space:normal;word-break:break-all;line-height:1.35;text-align:right}" +
      /* v273 ⑥ 的单柱 zu-sl-solo 弱化（opacity:.55）已按 2026-11-09 用户规格删除——
       * 近 7 天/本月/全部聚合后常只有一根柱，峰值/最低/最新档位色不再随柱数弱化 */
      ".zu-sv-cval{font-size:12px!important;font-weight:700!important}" +
      ".zu-sv-off{opacity:.75}" +
      ".zu-sv-partial{font-style:normal;font-weight:400;opacity:.75;margin-left:3px}" +
      ".zu-sv-empty{display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:4px 8px;height:100%;color:var(--color-tooltip-tag-foreground,#a6a6a6);" +
        "font-size:calc(var(--ui-font-size,14px) - 1px)}" +
      ".zu-sv-empty-hint{font-size:calc(var(--ui-font-size,14px) - 3px);opacity:.8}" +
      ".zu-sv-bars .zu-sc-col.latest .zu-sc-bar{box-shadow:0 0 0 1.5px var(--color-popover-border,rgba(255,255,255,.28))}" +
      ".zu-light .zu-sv-bars .zu-sc-col.latest .zu-sc-bar{box-shadow:0 0 0 1.5px rgba(15,23,42,.22)}" +
      /* v282：底部常驻档位说明移除——.zu-sv-legend 包装/分割线/占位全删；
       * .zu-sv-li / .zu-legend-dot（含 .cur 轻微强调与 Ultra 星标）保留，由
       * 档位说明浮层（.zu-sv-legend-tip）复用，TPS_BANDS 单一事实源不变。 */
      /* v286：命中区 26px（图标 18px 居中、align-self:center 免在 baseline 行内撑高标题） */
      ".zu-sv-legend-btn{appearance:none;border:0;background:transparent;color:var(--color-tooltip-tag-foreground,#a6a6a6);" +
        "width:26px;height:26px;padding:0;margin-left:4px;display:inline-flex;align-items:center;justify-content:center;align-self:center;cursor:help;border-radius:5px}" +
      ".zu-sv-legend-btn svg{width:18px;height:18px}" +
      ".zu-sv-legend-btn:hover,.zu-sv-legend-btn:focus-visible{color:var(--color-foreground,#e9edf4);background:rgba(255,255,255,.06)}" +
      ".zu-light .zu-sv-legend-btn:hover,.zu-light .zu-sv-legend-btn:focus-visible{background:rgba(0,0,0,.05)}" +
      ".zu-sv-legend-btn:focus-visible{outline:2px solid var(--color-brand,#a3cfff);outline-offset:1px}" +
      /* 2026-11-07 用户规格：宽度自适应内容（.tip 基类 max-content 生效），
       * 仅留窄窗安全钳；替代此前的定宽 430 与更早的 max-width 800 */
      ".zu-sv-legend-tip{max-width:calc(100vw - 24px);white-space:normal;z-index:2147483646}" +
      ".zu-sv-lg-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:8px}" +
      ".zu-sv-lg-title{font-weight:600;font-size:calc(var(--ui-font-size,14px) - 1px)}" +
      ".zu-sv-lg-sub{font-size:calc(var(--ui-font-size,14px) - 3px);color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-sv-lg-items{display:grid;grid-template-columns:repeat(3,auto);gap:8px 12px;justify-content:start;align-items:center}" +
      ".zu-sv-li{display:flex;align-items:center;gap:3px;padding:1px 4px;border-radius:7px;border:1px solid transparent}" +
      ".zu-sv-li.cur{border-color:var(--color-popover-border,rgba(255,255,255,.35));background:rgba(255,255,255,.05)}" +
      ".zu-light .zu-sv-li.cur{background:rgba(0,0,0,.05)}" +
      ".zu-sv-li b{font-family:var(--font-sans,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);font-variant-numeric:tabular-nums;" +
        "font-weight:600;font-size:calc(var(--ui-font-size,14px) - 3px);white-space:nowrap}" +
      "@media (max-width:780px){.zu-sv-root .zu-sv-left{flex:0 0 190px}}" +
      /* ---------- v291 热力图（本月月历 / 全部历史 GitHub 风格） ----------
       * 颜色=档位类 currentColor（与柱体/图例唯一事实源 TPS_BANDS 同源）：历史格
       * 实底（GitHub 风格）；月历格 v294 起低饱和混色+左色条（见下方 v294 注释块）。
       * 无记录=中性灰（不等于零速）、未来=弱日期号无速度、当日=柔和描边。
       * 历史网格 --zu-hm-w 列（列=周）撑出横滚，月历恒 7 列 1fr 平分 4~6 行。 */
      ".zu-hm-sub{margin-left:8px;font-size:calc(var(--ui-font-size,14px) - 3px);font-weight:400;color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      /* v294 月历格专项（用户 Goal）：①低饱和档位底=档位色 22% 混入卡片色（不再纯色
       * 填满），档位强调改左侧 3px 色条；②文字统一吃 tooltip 前景（高对比），绝不吃
       * currentColor（亮底浅字对比不足的根因）；③上下 space-between 布局（日期左上/
       * 速度左下），line-height 1.1~1.15 + min-height:0——越界根因是 flex 子项默认
       * min-height:auto 不可低于内容高 + 默认行高过大，矮行时内容溢出格底；④容器查询
       * 三档字号（阈值按 7 列+6×8px gap 折算格宽 90/56px），container-type 只锁 inline
       * 轴，1fr 行高 flex 链不受影响。 */
      ".zu-hm-cal{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0;" +
        "container-type:inline-size;container-name:hmcal}" +
      ".zu-hm-month .zu-sc-wrap{display:flex;flex-direction:column}" +
      ".zu-hm-week{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:8px;margin-bottom:5px;" +
        "font-size:calc(var(--ui-font-size,14px) - 5px);color:var(--color-tooltip-tag-foreground,#a6a6a6);text-align:center}" +
      ".zu-hm-grid{display:grid;gap:6px}" +
      ".zu-hm-grid--mon{gap:8px}" +
      /* 行高 1fr 自适应（v292 定高 315）：行数由 builder 经 --zu-hm-rows 携带 */
      ".zu-hm-grid--mon{min-height:0;grid-template-columns:repeat(7,minmax(0,1fr));" +
        "gap:8px}" +
      /* v295（用户规格）：6 列 × 行 1fr 均分铺满全卡（不留空隙、不再要求正方）；
       * 容器查询阈值随 7 列折算（格宽 90/56 → 容器 678/440），300 小卡常态=紧凑
       * 以下（格 ~41px），格内数字隐藏、hover 兜底完整值 */
      ".zu-hm-grid--mon{flex:1;min-height:0;grid-template-rows:repeat(var(--zu-hm-rows,5),minmax(0,1fr))}" +
      ".zu-hm-pad{display:block;min-height:1px}" +
      /* 格基础：上下两端对齐、min-width:0、border-box；基础不声明 color（档位类让位
       * 教训 v291）；无记录=中性弱底、未来=更低对比度底（虚线框按规格移除降噪） */
      ".zu-hm-cell{position:relative;display:flex;flex-direction:column;justify-content:space-between;" +
        "min-width:0;min-height:0;box-sizing:border-box;border-radius:8px;" +
        "padding:var(--hm-pady,4px) var(--hm-padx,6px);" +
        "background:rgba(255,255,255,.045)}" +
      ".zu-light .zu-hm-cell{background:rgba(0,0,0,.04)}" +
      ".zu-hm-cell.void{color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-hm-cell.fut{color:var(--color-tooltip-tag-foreground,#a6a6a6);background:rgba(255,255,255,.02)}" +
      ".zu-light .zu-hm-cell.fut{background:rgba(0,0,0,.02)}" +
      /* 日期（辅助信息）：11px 级/500/1.15，无记录与未来格靠 color 弱化 */
      ".zu-hm-cell .zu-hm-d{flex:0 0 auto;font-size:var(--hm-df,10px);font-weight:500;line-height:1;" +
        "white-space:nowrap;color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      /* 速度：16px 级/600/1.1/tabular-nums，高对比前景、左对齐、底部留 padding */
      ".zu-hm-cell .zu-hm-v{flex:0 0 auto;min-height:0;font-weight:600;line-height:1;" +
        "font-variant-numeric:tabular-nums;text-align:left;white-space:nowrap;" +
        "font-size:var(--hm-f4,14px);color:var(--color-tooltip-foreground,#fff)}" +
      ".zu-hm-cell.len5 .zu-hm-v{font-size:var(--hm-f5,13px)}" +
      ".zu-hm-cell.len6 .zu-hm-v{font-size:var(--hm-f6,12px)}" +
      /* 数据格：档位色 22% 混卡片底（v294.1 用户拍板：左色条移除，靠底色色相辨档） */
      ".zu-hm-grid--mon .zu-hm-cell.data{background:color-mix(in srgb,currentColor 22%,var(--color-popover,#1c212b))}" +
      ".zu-hm-grid--mon .zu-hm-cell.data .zu-hm-d{color:var(--color-tooltip-foreground,#e9edf4);opacity:.75}" +
      /* 当日：1px 柔和半透明主题蓝内描边（不用纯白粗框）；hover：轻提亮；
       * cur（委托契约类）内描边克制，today+cur 组合不叠出发光 */
      /* v297.1（用户拍板）：今日格不加描边——背景在自身基础上加深 10%
       * （数据格 22%→32% 档位混色；无数据格中性灰加深） */
      ".zu-hm-cell.data.zu-hm-today{background:color-mix(in srgb,currentColor 32%,var(--color-popover,#1c212b))}" +
      ".zu-hm-cell.void.zu-hm-today{background:color-mix(in srgb,var(--color-tooltip-tag-foreground,#a6a6a6) 14%,var(--color-popover,#1c212b))}" +
      ".zu-hm-cell:hover{filter:brightness(1.07)}" +
      /* v294.1（用户拍板）：hover 不加边框强调——委托契约类 .cur 保留（JS 状态机），
       * 仅 today 自身的柔和内描边在悬停时保持 */
      ".zu-hm-cell:focus-visible{outline:2px solid var(--color-brand,#a3cfff);outline-offset:1px}" +
      /* Ultra 档抑制（QA review）：全局 .zu-ultra 的 -webkit-text-fill-color:transparent
       * 是继承属性，会把格内文字染透明；全局 ✦ 伪元素会进历史 20px 小格。月历格
       * 左色条 ::before 已被 (0,4,0) 规则覆写不受影响 */
      ".zu-hm-cell{-webkit-text-fill-color:initial}" +
      ".zu-hm-cell::before{content:none}" +
      /* v297：旧「容器查询三档 + tight 隐藏数字」整体移除——离散档位无法满足
       * 「最大可容纳字号」要求，改由 builder 按实测格尺寸逐长度桶计算字号
       * （6~14px、0.5px 步进），极矮行压日期字号与 padding、不隐藏数字 */      ".zu-hm-note{flex:0 0 auto;margin-top:8px;font-size:calc(var(--ui-font-size,14px) - 3px);color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-hm-outer{display:flex;gap:6px;min-width:0;flex:1;min-height:0;container-type:inline-size;container-name:hmhist}" +
      /* v296：方格大小/间距随容器宽自适应（窄容器缩格缩距，超长部分横向滚动） */
      "@container hmhist (max-width:560px){.zu-hm-grid--hist{gap:2px}.zu-hm-grid--hist .zu-hm-cell{max-width:16px;border-radius:2px}}" +
      ".zu-hm-wds{display:grid;grid-template-rows:repeat(7,1fr);gap:3px;padding-top:34px;flex:0 0 auto;" +
        "font-size:calc(var(--ui-font-size,14px) - 6px);color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-hm-wds span{display:flex;align-items:center}" +
      ".zu-hm-hist .zu-sc-wrap{width:100%;min-width:0;display:flex;flex-direction:column}" +
      ".zu-hm-scroll{min-width:100%;flex:1;display:flex;flex-direction:column;min-height:0}" +
      ".zu-hm-months{display:grid;grid-template-columns:repeat(var(--zu-hm-w,1),minmax(12px,1fr));" +
        "grid-template-rows:14px;gap:3px;width:100%;min-width:calc(var(--zu-hm-w,1)*15px);" +
        "margin-bottom:5px;align-items:end}" +
      ".zu-hm-ml{grid-row:1;white-space:nowrap;font-size:calc(var(--ui-font-size,14px) - 5px);line-height:14px;" +
        "color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      /* 列头日期数字行（v293）：每列周首日号，与格子列中心对齐 */
      ".zu-hm-days{display:grid;grid-template-columns:repeat(var(--zu-hm-w,1),minmax(12px,1fr));" +
        "grid-template-rows:12px;gap:3px;width:100%;min-width:calc(var(--zu-hm-w,1)*15px);" +
        "height:12px;margin-bottom:3px}" +
      ".zu-hm-dn{grid-row:1;text-align:center;font-variant-numeric:tabular-nums;" +
        "font-size:calc(var(--ui-font-size,14px) - 6px);line-height:12px;" +
        "color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      /* v292 复验抓出的致命布局错（v291 起即错）：历史网格是「一列=一周、7 行=星期」，
 * 必须 column-major——此前用 template-columns:repeat(周数) 的 row-major 实际把
 * 每行排成 N 个连续日期（62 周时形似 GitHub 网格骗过目检，5 周短历史才暴露）。 */
      "/* 7 行 1fr 平分图表卡剩余高度（v293 用户规格：铺满、不超高） */" +
      ".zu-hm-grid--hist{grid-auto-flow:column;flex:1;min-height:0;" +
        "grid-template-rows:repeat(7,minmax(0,1fr));" +
        "grid-auto-columns:minmax(12px,1fr);gap:3px;" +
        "width:100%;min-width:calc(var(--zu-hm-w,1)*15px)}" +
      ".zu-hm-grid--hist .zu-hm-cell{border-radius:4px;padding:0;max-width:20px;width:100%;justify-self:center}" +
      ".zu-hm-grid--hist .zu-hm-cell.data{background:currentColor}" +
      ".zu-hm-grid--hist .zu-hm-cell.void{background:#484848}" +
      ".zu-hm-grid--hist .zu-hm-cell.zu-hm-today{box-shadow:inset 0 0 0 1.5px var(--color-popover-border,rgba(255,255,255,.4))}" +
      /* Ultra 档历史格显式渐变底（background-clip:text 全局规则不适用于色块盒子）；
       * 月历格 v294 起改低饱和混色+左色条（::before 渐变覆写在上方月历段） */
      ".zu-hm-grid--hist .zu-hm-cell.data.zu-ultra{" +
        "background:linear-gradient(100deg,#60a5fa 0%,#a78bfa 50%,#c084fc 100%)}" +
      ".zu-light .zu-hm-grid--hist .zu-hm-cell.data.zu-ultra{" +
        "background:linear-gradient(100deg,#3156cb 0%,#6746d2 50%,#9139bf 100%)}" +
      /* v232 速度柱状图：左读数卡 + 右「最近 10 段」图表。柱体颜色走档位类 currentColor
       * （与图例色点同套路），其余配色全走语义令牌（浅色自动适配）；plot min-width +
       * 横滚保证窄窗口下柱顶读数永不挤压重叠。 */
      ".zu-speed-body{display:flex;gap:10px;align-items:stretch}" +
      /* v242:合并 v232 基座与 v239 边框规则;border-box 下 250px=外观盒(内容 220),padding 12 让左卡总高贴近图表列 ~217px */
      ".zu-speed-left{flex:0 0 250px;min-width:0;box-sizing:border-box;display:flex;flex-direction:column;justify-content:flex-start;background:rgba(255,255,255,.045);border:1px solid var(--color-popover-border,rgba(255,255,255,.12));border-radius:12px;padding:12px;overflow:hidden}" +
      ".zu-light .zu-speed-left{background:rgba(0,0,0,.045)}" +
      /* v233 主读数估宽分级：fit2 中长状态词缩号并允许换行；fit3 更长再缩 + break-word。
       * 只挂左卡作用域，legacy hero（无图表旧快照）维持原 nowrap 大字不动。 */
      ".zu-speed-left .zu-speed-fit2{font-size:calc(var(--ui-font-size,14px) + 10px);white-space:normal;line-height:1.25}" +
      /* v235 结构化左卡分层节点：状态标题/名称/主数值/单位/辅助说明各自独立，
       * 数值型走档位色（st.band），工具/Skill/思考/子代理保持中性 dim 语义 */
      ".zu-sl-status{display:flex;align-items:center;gap:6px;font-size:calc(var(--ui-font-size,14px) - 1px);color:var(--color-foreground-subtle,#8791a3);min-width:0}" +
      ".zu-sl-status .ico{width:20px;height:20px;flex:0 0 auto}" +
      ".zu-sl-count{flex:0 0 auto;font-size:calc(var(--ui-font-size,14px) - 4px);font-weight:700;line-height:1.5;border:1px solid currentColor;border-radius:999px;padding:0 6px}" +
      ".zu-sl-main{margin-top:8px;font-family:var(--font-sans,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);font-variant-numeric:tabular-nums;font-size:calc(var(--ui-font-size,14px) + 22px);font-weight:700;line-height:1.1;white-space:nowrap}" +
      ".zu-sl-unit{font-size:calc(var(--ui-font-size,14px) + 4px);font-weight:600;color:var(--color-tooltip-tag-foreground,#a6a6a6);margin-left:4px}" +
      ".zu-sl-val.dim,.zu-sl-estdim{color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-sl-note{margin-top:8px;font-size:calc(var(--ui-font-size,14px) - 2px);color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-speed-left .zu-speed-fit3{font-size:calc(var(--ui-font-size,14px) - 1px);white-space:normal;line-height:1.3;word-break:break-word}" +
      ".zu-speed-note{margin-top:8px;font-size:calc(var(--ui-font-size,14px) - 2px);color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-speed-left .zu-speed-bandtag{font-size:calc(var(--ui-font-size,14px) - 3px);padding:2px 8px;white-space:nowrap}" +
      /* v298.4：档位徽标下方模型名行（V2 左卡）——小字、超长省略 + title 全名 */
      /* v304.2：模型名胶囊化（26px 高/13px 圆角/立方体 SVG 14px/名称省略 title 全文；
       * 主题随卡内既有 .zu-light 显式覆写口径，与 .zu-sc-unit 徽章同语言） */
      ".zu-sl-model{display:inline-flex;align-items:center;gap:6px;max-width:100%;min-width:0;height:26px;box-sizing:border-box;padding:0 10px;margin-top:8px;" +
        "border:1px solid var(--color-popover-border,rgba(255,255,255,.14));border-radius:13px;background:rgba(255,255,255,.05);" +
        "color:var(--color-tooltip-tag-foreground,#a6a6a6);font-size:calc(var(--ui-font-size,14px) - 3px);white-space:nowrap}" +
      ".zu-light .zu-sl-model{border-color:rgba(15,23,42,.14);background:rgba(0,0,0,.05)}" +
      ".zu-sl-model svg{flex:none;opacity:.85}" +
      ".zu-sl-model span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      /* 2026-11-09 用户实报：宿主内原生 title 气泡不弹（同轮播设置分区先例，v268）——
       * 模型行全名列表改纯 CSS data-tip 伪元素气泡（zu-rot-tipt 同款）。
       * .zu-sv-left 放开卡片 overflow:hidden（V2 作用域，V1 老卡单 .zu-speed-left
       * 不受影响）——否则气泡被卡片裁掉；卡内内容本就自带省略/换行自裁剪。 */
      ".zu-sv-left{overflow:visible}" +
      ".zu-sv-left .zu-sl-model{position:relative}" +
      ".zu-sv-left .zu-sl-model[data-tip]:hover::after{content:attr(data-tip);position:absolute;bottom:calc(100% + 6px);left:0;z-index:60;max-width:280px;width:max-content;padding:6px 10px;border:1px solid var(--color-popover-border,var(--color-border,rgba(255,255,255,.14)));border-radius:8px;background:var(--color-popover,#20242e);color:var(--color-popover-foreground,var(--color-foreground,#e9edf4));font-size:calc(var(--ui-font-size,14px) - 2px);line-height:1.5;white-space:normal;text-align:left;box-shadow:0 6px 18px rgba(0,0,0,.28);pointer-events:none}" +
      ".zu-speed-chart{flex:1 1 auto;min-width:0;position:relative}" +
      /* v239（设计图复刻）：左卡深色玻璃卡 + 状态图标/当前读数标签；信息卡虚线引线；图例/口径行布局 */
      ".zu-sl-stats{padding-top:10px;display:flex;gap:6px;border-top:1px solid var(--color-border,rgba(255,255,255,.1))}" +
      ".zu-sl-stat{flex:1 1 0;min-width:0;display:flex;flex-direction:column;gap:2px}" +
      ".zu-sl-stat i{font-style:normal;font-size:calc(var(--ui-font-size,14px) - 3px);color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-sl-stat b{font-family:var(--font-sans,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);font-variant-numeric:tabular-nums;font-size:calc(var(--ui-font-size,14px) + 1px);font-weight:700}" +
      ".zu-sl-status span{min-width:0}" +
      /* v241：标题 15px 加粗；Skill 长名两行省略；主体区在剩余高度内垂直居中（填空旷），前缀「估/均」小号灰字 */
      /* v242:标题色不设 color——无档态继承 .zu-sl-status 中性灰,数值态由档位类直接着色(ultra 走渐变字) */
      ".zu-sl-title{font-weight:600;font-size:calc(var(--ui-font-size,14px) + 1px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      ".zu-sl-status--wrap .zu-sl-title{font-size:calc(var(--ui-font-size,14px) - 1px);line-height:1.3;overflow-wrap:anywhere;white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}" +
      ".zu-sl-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;justify-content:center;align-items:flex-start}" +
      ".zu-sl-body .zu-sl-main{margin-top:0}" +
      ".zu-sl-pre{font-size:calc(var(--ui-font-size,14px) + 4px);font-weight:600;color:var(--color-tooltip-tag-foreground,#a6a6a6);margin-right:6px}" +
            ".zu-sl-k{margin-top:4px;font-size:calc(var(--ui-font-size,14px) - 2px);color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-sc-lead{position:absolute;width:0;border-left:1px dashed currentColor;opacity:.7;pointer-events:none;transform:translateX(-.5px)}" +
      ".zu-legend-row{display:flex;align-items:center;gap:12px;margin:14px 0 4px;padding-top:10px;border-top:1px solid var(--color-popover-border,rgba(255,255,255,.12))}" +
      ".zu-legend-row .zu-legend-title{flex:0 0 auto}" +
      ".zu-legend-grid.zu-legend-inline{display:flex;flex-wrap:wrap;flex:1 1 auto;justify-content:flex-start;gap:4px 4px}" +
      ".zu-legend-inline .zu-legend-item{gap:4px;padding:2px 4px}" +
      ".zu-legend-inline .zu-legend-item b{font-size:calc(var(--ui-font-size,14px) - 2px);letter-spacing:-.25px}" +
      ".zu-basis{display:flex;align-items:flex-start;gap:16px;margin-top:8px;padding-top:10px;border-top:1px solid var(--color-popover-border,rgba(255,255,255,.12))}" +
      ".zu-basis .zu-legend-title{flex:0 0 auto}" +
      ".zu-basis-v{flex:1 1 auto;min-width:0;display:flex;flex-wrap:wrap;gap:4px 0;font-size:calc(var(--ui-font-size,14px) - 2px);color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-basis-v>span+span{margin-left:12px;padding-left:12px;border-left:1px solid var(--color-popover-border,rgba(255,255,255,.16))}" +
      ".zu-basis-v .zu-pj-time{flex:0 0 100%;margin-top:4px;padding-top:0;border-top:0}" +
      ".zu-sc-head{display:flex;align-items:baseline;gap:8px;margin:0 0 6px 30px}" +
      ".zu-sc-title{font-weight:700;font-size:calc(var(--ui-font-size,14px) + 1px);white-space:nowrap}" +
      ".zu-sc-sub{color:var(--color-tooltip-tag-foreground,#a6a6a6);font-size:calc(var(--ui-font-size,14px) - 3px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      ".zu-sc-unit{margin-left:auto;flex:0 0 auto;color:var(--color-tooltip-tag-foreground,#a6a6a6);font-size:calc(var(--ui-font-size,14px) - 3px)}" +
      ".zu-sc-wrap{overflow-x:auto;overflow-y:hidden}" +
      ".zu-sc-wrap::-webkit-scrollbar{height:8px}" +
      ".zu-sc-wrap::-webkit-scrollbar-thumb{background:var(--color-border,rgba(255,255,255,.14));border-radius:999px}" +
      /* v236：非 wide 图表不设 min-width——随容器压缩、靠稀疏时间标签兜底，任何窗口
       * 宽度都不出横向滚动条（用户规格）；wide（≥1000 t/s 读数 6 字符）保留横滚 */
      /* plot 高 = 160 柱区 + 29 X 轴（v237：border-box 下 X 行须 29px 才装得下两行时间，
       * 否则第二行被 wrap 的 overflow-y:hidden 裁半）；柱区/网格/沟槽顶锚 160px——列内容
       * 恰好填满 189，任何 flex-shrink 都会把柱区压短、柱体悬空离基线（实测教训），vz 显式 shrink:0 */
      /* v240/v242：帽 860（chart≈560）满宽无横滚；plot min-width 340 仅窄窗兜底——pitch<44
       * 阈值时公式会隔列显标签;wide(≥1000 t/s)加宽 420 横滚,读数 6 字符不挤压 */
      ".zu-sc-plot{position:relative;height:189px;margin-left:30px;min-width:340px}" +
      /* v242:wide(≥1000 t/s 读数 6 字符)横滚兜底加宽——340 下 pitch 34 时相邻读数间隙仅 1-3px */
      ".zu-sc-wrap.wide .zu-sc-plot{min-width:420px}" +
      ".zu-sc-grid{position:absolute;top:0;left:0;right:0;height:160px}" +
      ".zu-sc-grid i{position:absolute;left:0;right:0;border-top:1px dashed var(--color-border,rgba(255,255,255,.1))}" +
      ".zu-sc-grid i[data-base]{border-top:1px solid var(--color-border,rgba(255,255,255,.16))}" +
      ".zu-sc-gutter{position:absolute;left:-30px;top:0;height:160px;width:26px}" +
      ".zu-sc-gutter i{position:absolute;right:5px;transform:translateY(50%);font-style:normal;font-variant-numeric:tabular-nums;font-size:10px;line-height:1;color:var(--color-tooltip-tag-foreground,#a6a6a6);white-space:nowrap}" +
      ".zu-sc-gutter i.top{transform:none}" +
      /* bars 容器占满 plot 189（列内容 vz160+x29 恰好填满、零压缩），
       * grid/gutter 才是顶锚 160 的柱区——两者高度角色不能对调 */
      ".zu-sc-bars{position:absolute;inset:0;display:flex;align-items:stretch}" +
      /* 列内盒全部 border-box + 固定 flex-basis：160+24 恰好 184、零 flex-shrink——
       * content-box 下溢出的分数压缩会在各列产生 ±2px 取整差（柱底不齐，实测） */
      ".zu-sc-col,.zu-sc-col *{box-sizing:border-box}" +
      ".zu-sc-col{flex:1 1 0;min-width:0;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;outline:none}" +
      ".zu-sc-vz{display:flex;flex-direction:column;justify-content:flex-end;align-items:center;width:100%;height:160px;flex:0 0 160px}" +
      ".zu-sc-val{font-variant-numeric:tabular-nums;font-size:10px;line-height:1.2;letter-spacing:-.1px;color:var(--color-foreground,#e9edf4);margin-bottom:4px;white-space:nowrap}" +
      ".zu-sc-val.latest{font-weight:700}" +
      /* v250（用户规格）：柱间距收紧 20%——列宽 pitch 的柱白 = pitch−柱宽，柱宽改
       * calc(20% + 12px) 后白 = 0.8×pitch−12 = 旧白（pitch−15）×0.8，任意宽度恒精确 −20% */
      ".zu-sc-bar{display:block;width:100%;max-width:calc(20% + 12px);min-height:2px;border-radius:2.5px 2.5px 0 0;background:currentColor}" +
      ".zu-sc-bar.zu-ultra{background:linear-gradient(100deg,#60a5fa 0%,#a78bfa 50%,#c084fc 100%)}" +
      ".zu-sc-bar.zu-ultra::before{content:none}" +
      ".zu-sc-col.latest .zu-sc-bar{box-shadow:0 0 0 1px currentColor}" +
      ".zu-sc-col.cur .zu-sc-bar{box-shadow:0 0 0 1.3px currentColor,0 0 9px -2px currentColor}" +
      ".zu-sc-col:focus-visible .zu-sc-bar{box-shadow:0 0 0 1.5px var(--color-brand,#a3cfff),0 0 9px -2px var(--color-brand,#a3cfff)}" +
      ".zu-sc-x{height:29px;padding-top:4px;flex:0 0 29px;display:flex;flex-direction:column;align-items:center;gap:1px;font-variant-numeric:tabular-nums;font-size:10px;line-height:1.25;color:var(--color-tooltip-tag-foreground,#a6a6a6);white-space:nowrap}" +
      /* 信息卡挂 plot 内（top:0 相对柱区顶）：横滚时随内容滚动，盖住的列永远受
       * span capIn 约束（挂图表视口右缘会盖住滚动窗内的无约束高柱，review 实测） */
      ".zu-sc-card{position:absolute;top:0;right:0;z-index:2;pointer-events:none;background:var(--color-popover,#1c212b);border:1px solid var(--color-popover-border,rgba(255,255,255,.16));border-radius:8px;padding:3px 8px;box-shadow:0 4px 14px rgba(0,0,0,.35);max-width:210px}" +
      ".zu-light .zu-sc-card{box-shadow:0 4px 14px rgba(15,23,42,.16)}" +
      /* 卡片字号固定 px：几何是 Y 轴约束的输入（CARD_H=36，v242 校准实高 35.6px），不随宿主字号漂移 */
      ".zu-sc-card-k{font-size:10px;line-height:1.2;color:var(--color-tooltip-tag-foreground,#a6a6a6);white-space:nowrap}" +
      ".zu-sc-card-v{font-variant-numeric:tabular-nums;font-size:13px;font-weight:700;line-height:1.2;white-space:nowrap}" +
      ".zu-sc-card-v i{font-style:normal;font-size:10px;font-weight:600;margin-left:5px;opacity:.9}" +
      /* v250 轮明细行（模型/Token/请求·费用）：行高 12+行距 2=14px 是 CARD_H 的输入；
       * 模型名等超长 ellipsis（全文在 title），数字等宽 */
      ".zu-sc-card-m{font-size:10px;line-height:1.2;margin-top:2px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      ".tbody::-webkit-scrollbar{width:8px}" +
      ".tbody::-webkit-scrollbar-thumb{background:var(--color-border,rgba(255,255,255,.14));border-radius:999px}" +
      /* 超限告警气泡（v39）：挂 body 的独立浮层（与 .tip 同套路，免受条面重建影响），
       * 红边警示 + 建议步骤 + 可点击复制的会话 ID；user-select:text 允许手动选中兜底。
       * 底色 = 客户端 destructive 掺背景色：深色下深红黑、浅色下淡粉，自动适配。 */
      ".zusage-exc{position:fixed;max-width:470px;" +
      "background:linear-gradient(180deg,rgba(41,18,22,.98),rgba(27,14,16,.98));" +
      "background:linear-gradient(180deg,color-mix(in srgb,var(--color-destructive,#ff2d55) 10%,var(--color-background,#1b0e10)),color-mix(in srgb,var(--color-destructive,#ff2d55) 5%,var(--color-background,#1b0e10)));" +
      "border:1px solid rgba(255,45,85,.4);border-color:color-mix(in srgb,var(--color-destructive,#ff2d55) 40%,transparent);" +
      "border-radius:12px;padding:12px 15px;" +
      "font-family:var(--font-sans,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);" +
      "font-size:calc(var(--ui-font-size,14px) - 1px);line-height:1.7;color:var(--color-foreground,#e9edf4);" +
      "box-shadow:0 12px 32px rgba(0,0,0,.5),0 4px 18px rgba(255,45,85,.12);white-space:normal;z-index:2147483647;" +
      "user-select:text;display:none}" +
      ".zusage-exc .xb-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}" +
      ".zusage-exc .xb-title{font-weight:700;color:var(--color-destructive,#ff5c77)}" +
      ".zusage-exc .xb-step{color:var(--color-foreground-subtle,#c6cdd9)}" +
      ".zusage-exc .xb-close{cursor:pointer;color:var(--color-foreground-subtlest,#8791a5);padding:2px 5px;border-radius:6px;font-size:calc(var(--ui-font-size,14px) + 2px);line-height:1}" +
      ".zusage-exc .xb-close:hover{color:var(--color-foreground,#fff);background:var(--color-hover,rgba(255,255,255,.08))}" +
      ".zusage-exc .xb-sid{color:var(--color-brand,#57c7ff);cursor:pointer;text-decoration:underline dotted}" +
      ".zusage-exc .xb-sid:hover{text-decoration-style:solid}" +
      ".zusage-exc .xb-copied{color:#3ecf8e;margin-left:6px;display:none}" +
      /* 白色主题程度性覆盖（v58.1）：颜色已全量走客户端变量随 .dark 自动翻转，
       * 这里只兜两类 —— 程度差（浅色下阴影/内高光减重、红字光晕收掉）与
       * 三档状态色加深版（高对比自调档，见 .ok 注释）。 */
      /* :not(.zu-in) 保特异性：in-card 形态（v80）自身声明 box-shadow:none 且定义在前，
       * 同特异性的浅色阴影会反超——透明无框条上浮出一圈浅影（review 抓获） */
      ".zusage-root.zu-light:not(.zu-in){box-shadow:inset 0 1px 0 rgba(255,255,255,.85),0 4px 14px rgba(15,23,42,.12),0 1px 3px rgba(15,23,42,.08)}" +
      ".zusage-root.zu-pill,.zusage-root.zu-pill.zu-light{box-shadow:none}" +
      ".tip.zu-pill-skin{background:var(--color-popover,var(--color-card,var(--color-background,#171717)));" +
      "border-color:var(--color-popover-border,var(--color-border,transparent));color:var(--color-foreground,#fafafa)}" +
      ".tip.zu-pill-skin .rt-h,.tip.zu-pill-skin .rt-row span{color:var(--color-foreground,#fafafa)}" +
      ".tip.zu-pill-skin .rt-row b,.tip.zu-pill-skin .rt-note,.tip.zu-pill-skin .rt-legend b,.tip.zu-pill-skin .rt-lsep{color:var(--color-foreground-subtle,#a1a1a1)}" +
      ".tip.zu-pill-skin .ttab{background:var(--color-hover,rgba(128,128,128,.12));color:var(--color-foreground-subtle,#a1a1a1)}" +
      ".tip.zu-pill-skin .ttab:hover{color:var(--color-foreground,#fafafa)}" +
      ".tip.zu-pill-skin .ttab.on{color:var(--color-brand,#3b82f6)}" +
      ".panel.zu-light{box-shadow:inset 0 1px 0 rgba(255,255,255,.9),0 12px 32px rgba(15,23,42,.14),0 2px 8px rgba(15,23,42,.08)}" +
      /* v81：反色底后 tip 的 inset 白高光在浅色主题（黑底 tip）上违和，浅色只调淡外阴影 */
      ".tip.zu-light{box-shadow:0 10px 28px rgba(15,23,42,.16),0 2px 6px rgba(15,23,42,.08)}" +
      ".zusage-exc.zu-light{box-shadow:0 12px 32px rgba(15,23,42,.14),0 4px 18px rgba(220,38,38,.1)}" +
      ".zu-light .exc{text-shadow:none}" +
      ".zu-light .ok{color:#0f9d6c}.zu-light .warm{color:#b6791a}.zu-light .hot{color:#d8482f}" +
      /* v127 速度新七档浅色深化值（规格初稿；150 以下沿用上面既有三档实测值不动）。
       * Ultra 浅色渐变同名覆盖（特异性更高），@supports 外回退纯紫 #6746d2。 */
      ".zu-light .zu-teal{color:#087d74}.zu-light .zu-sky{color:#0875a8}.zu-light .zu-azure{color:#405fd0}" +
      ".zu-light .zu-violet{color:#6249c6}.zu-light .zu-purple{color:#8042bd}.zu-light .zu-magenta{color:#9638a8}" +
      ".zu-light .zu-ultra{color:#6746d2}" +
      /* v232 柱体 Ultra 浅色渐变：特异性 (0,3,0) 压过上面 (0,2,0) 的 clip:text 组——
       * 柱体是无文字的盒子，被 text 裁剪会整根隐形（图例圆点同款教训）。 */
      ".zu-light .zu-sc-bar.zu-ultra{background:linear-gradient(100deg,#3156cb 0%,#6746d2 50%,#9139bf 100%);-webkit-background-clip:border-box;background-clip:border-box}" +
      /* v242:图例 ultra 圆点同款修正——下方 @supports 的 .zu-light .zu-ultra (0,2,0) 靠后,
       * 会把 (0,2,0) 圆点渐变裁到 text 上(9px 空盒=隐形),须 (0,3,0) 压回 border-box */
      ".zu-light .zu-legend-dot.zu-ultra{background:linear-gradient(100deg,#3156cb 0%,#6746d2 50%,#9139bf 100%);-webkit-background-clip:border-box;background-clip:border-box}" +
      /* background 简写会把 background-clip 重置回 border-box，浅色规则特异性更高——
       * 这里必须连带重申 clip，否则渐变整块糊在字底（截图验收抓获）。 */
      "@supports(-webkit-background-clip:text){" +
      ".zu-light .zu-ultra{background:linear-gradient(100deg,#3156cb 0%,#6746d2 50%,#9139bf 100%);" +
      "-webkit-background-clip:text;background-clip:text}" +
      ".zu-light .zu-ultra::before{background:linear-gradient(100deg,#3156cb 0%,#6746d2 50%,#9139bf 100%);" +
      "-webkit-background-clip:text;background-clip:text}}" +
      ".zu-light .xb-copied{color:#0c8a63}" +
      /* v105 压缩上下文：弹层内胶囊按钮 + 确认弹框。v316 按钮视格重做（用户规格）：
       * 全宽 40px 胶囊、无边框、中性深灰半透明底——暗色=白色叠加（hover 提亮/active 再亮一档），
       * 浅色=黑色叠加（hover/active 对应加深），html.dark 分组自动跟随明暗与 zai 主题；
       * 字号走 --ui-font-size 令牌（默认档恰 13px，随宿主界面字号设置缩放，overlay-ui §2）；
       * 文字色仍走 --color-foreground 正常前景；仅键盘聚焦给 focus-visible 焦点环
       * （宿主无 --color-focus-ring 变量，fallback 落实色）。弹框配色仍全量引用客户端语义变量。 */
      ".zu-compact-btn{display:flex;align-items:center;justify-content:center;gap:8px;box-sizing:border-box;" +
      "width:100%;min-width:0;height:40px;padding:0 12px;border:0;border-radius:9999px;" +
      "background:rgba(255,255,255,.065);color:var(--color-foreground,#fafafa);" +
      "font-family:inherit;font-size:calc(var(--ui-font-size,14px) - 1px);font-weight:600;line-height:1;white-space:nowrap;cursor:pointer;" +
      "transition:background-color .15s ease}" +
      ".zu-compact-btn:hover{background:rgba(255,255,255,.10)}" +
      ".zu-compact-btn:active{background:rgba(255,255,255,.14)}" +
      ".zu-compact-btn:focus-visible{outline:2px solid var(--color-focus-ring,#78aaff);outline-offset:2px}" +
      ".zu-compact-btn:disabled{opacity:.5;cursor:not-allowed}" +
      ".zu-compact-btn svg{width:18px;height:18px;flex:0 0 18px}" +
      "html:not(.dark) .zu-compact-btn{background:rgba(0,0,0,.05)}" +
      "html:not(.dark) .zu-compact-btn:hover{background:rgba(0,0,0,.08)}" +
      "html:not(.dark) .zu-compact-btn:active{background:rgba(0,0,0,.12)}" +
      /* v193 布局：行上不得写任何 margin——宿主 body 的 space-y-3 是 Tailwind v4
       * :where() 零权重规则（margin-bottom 打在非末尾子元素上），自写 margin 会按
       * 类名权重压掉它（v190 的 6px 显挤、v192 的 margin:0 贴紧按钮都是这个坑）；
       * 不声明即回落容器原生 12px 节奏，与「平均缓存命中率」行距分割线同源。
       * 行内 flex 两端对齐，「调整」链接贴右缘。 */
      ".zu-ac-info{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:12px;line-height:1.4;opacity:.7}" +
      ".zu-ac-link{text-decoration:underline;cursor:pointer;opacity:.9;flex:none}" +
      ".zu-ac-link:hover{opacity:1;color:var(--color-brand,#57c7ff)}" +
      /* v195 说明行：space-y v4 只写 margin-bottom，margin-top 无冲突可安全收紧间距 */
      ".zu-ac-hint{margin-top:-8px;font-size:11px;line-height:1.45;opacity:.6}" +
      /* v190：高亮改琥珀左条+淡底（--color-brand 在宿主主题可能是白色系，描边观感像输入框焦点） */
      ".zu-settings label.zu-ac-flash{background:rgba(245,185,68,.10);box-shadow:inset 3px 0 0 #f5b944;" +
      "border-radius:6px;transition:background .3s,box-shadow .3s}" +
      ".zu-compact-dlg{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;" +
      "background:rgba(0,0,0,.6);animation:zuCptFade .1s ease-out}" +
      ".zu-compact-card{box-sizing:border-box;width:min(92vw,384px);padding:20px;border-radius:16px;" +
      "background:var(--color-popover,#fff);color:var(--color-foreground,#0a0a0a);" +
      "border:1px solid var(--color-border,rgba(0,0,0,.1));box-shadow:0 25px 50px -12px rgba(0,0,0,.45);" +
      "font-family:inherit;font-size:14px;line-height:1.5;animation:zuCptZoom .1s ease-out}" +
      ".zu-compact-title{font-size:16px;font-weight:600}" +
      ".zu-compact-desc{padding-top:8px;color:var(--color-foreground-subtle,#8791a3)}" +
      ".zu-compact-desc b{color:var(--color-foreground,#0a0a0a);font-weight:500;font-variant-numeric:tabular-nums}" +
      ".zu-compact-hint{margin-top:8px;font-size:12.5px;line-height:1.45;color:var(--color-foreground-subtle,#8791a3);opacity:.85}" +
      ".zu-compact-err{display:none;margin-top:10px;padding:8px 10px;border-radius:8px;background:rgba(220,38,38,.1);color:#dc2626;font-size:13px}" +
      ".zu-compact-err.on{display:block}" +
      ".zu-compact-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}" +
      ".zu-compact-foot button{height:36px;padding:0 16px;border-radius:8px;font-family:inherit;font-size:14px;cursor:pointer;" +
      "transition:background .15s,opacity .15s}" +
      ".zu-compact-cancel{background:transparent;border:1px solid var(--color-border,rgba(0,0,0,.1));color:var(--color-foreground,#0a0a0a)}" +
      ".zu-compact-cancel:hover{background:var(--color-hover,#e5e5e5)}" +
      ".zu-compact-ok{border:0;background:var(--color-primary,#0a0a0a);color:var(--color-primary-foreground,#fff)}" +
      ".zu-compact-ok:hover{opacity:.8}" +
      ".zu-compact-ok:disabled{opacity:.5;cursor:default}" +
      "@keyframes zuCptFade{from{opacity:0}to{opacity:1}}" +
      "@keyframes zuCptZoom{from{opacity:0;transform:scale(.95)}to{opacity:1;transform:scale(1)}}" +
      /* 减少动态偏好：关闭呼吸/闪烁/弹框动画与悬浮过渡。整组必须排在全部受控规则
       * 之后——@media 不增特异性，同特异性按源序后者胜，放前面会被后置基础规则
       * 压成死代码（v316 按钮 transition、v105 弹框 animation 均实证过）。 */
      "@media (prefers-reduced-motion:reduce){.exc,.dot,.zu-compact-dlg,.zu-compact-card{animation:none}" +
      ".it,.btn,.ttab,.panel label,.zu-compact-btn{transition:none}}";

    /* 结构：条撑满卡片宽后 .zu-main 占满剩余宽、条目+分隔线默认 space-between 均匀分布
     * （v226 可经 ⚙「水平对齐」改居左/居右，均分仍为缺省），⚙ 落在最右缘（内容超宽时分级收缩、
     * 极限右缘渐隐 .zu-clip）；面板 fixed 挂 body，由 position*Panel 按条矩形定位在条上方（v80 迁移，见挂载处注） */
    var bar = document.createElement("div");
    bar.className = "zusage-root";
    bar.setAttribute("data-zusage-slot", String(slot));   // v169：多实例去重判据（Windows 最小化/还原双条 dedup 用）
    if (slot === 0) bar.id = "zusage-bar";
    bar.style.display = "none";   // 定位成功前不显示（避免占位）
    bar.innerHTML = '<span class="zu-main">…</span>' +
      '<button type="button" class="btn zu-gear" aria-label="' + L("打开状态条设置", "Open status bar settings") + '" aria-expanded="false" aria-haspopup="dialog">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M9.5 2h5l.6 2.5 1.7 1 2.5-.7 2.5 4.4-1.9 1.8v2l1.9 1.8-2.5 4.4-2.5-.7-1.7 1-.6 2.5h-5l-.6-2.5-1.7-1-2.5.7-2.5-4.4L4.1 13v-2L2.2 9.2l2.5-4.4 2.5.7 1.7-1z"/><circle cx="12" cy="12" r="3.5"/></svg>' +
      '<span class="zu-gear-dot" aria-hidden="true"></span></button>';
    var ariaLiveState = document.createElement("span");
    ariaLiveState.className = "zu-sr-only";
    ariaLiveState.setAttribute("role", "status");
    ariaLiveState.setAttribute("aria-live", "polite");
    ariaLiveState.setAttribute("aria-atomic", "true");
    bar.appendChild(ariaLiveState);
    var panel = document.createElement("div");
    panel.className = "panel zu-settings";
    /* issue #55：这三个 var 必须先于下方 buildPanel() 的调用完成赋值——var 只提升声明不提升
     * 赋值，而 buildPanel → syncUpdate 首轮执行就会读它们（赋值语句曾排在调用点之后，
     * v1.5.2 首轮读到 undefined 抛 TypeError 拖垮实例创建）。配套函数是声明有提升，留在原位。 */
    var srcListSig = "", sourceFeedback = {};
    var SRC_FIELD_LABELS = {
      apiKey: L("API Key", "API Key"), cookie: L("控制台 Cookie", "Console Cookie"), token: L("Token", "Token"),
      accessKeyId: L("AccessKeyId", "AccessKeyId"), secretAccessKey: L("SecretAccessKey", "SecretAccessKey"),
      planCredits: L("套餐 Credits 总量", "Plan credits"), planStart: L("计费锚日 YYYY-MM-DD", "Billing anchor day"),
    };
    var PROGRESS_STAGES = ["download", "verify", "install", "sync"];
    function settingRow(input, title, note) {
      return '<label>' + input + '<span>' + title + '<em>' + note + '</em></span></label>';
    }
    /* v202 更新日志卡片骨架（随语言由 buildPanel 重建；内容由 syncNotes 按状态幂等填充） */
    function notesCardHtml() {
      return '<div class="zu-settings-card zu-notes-card">' +
      '<div class="zu-notes-head"><span class="zu-notes-title">' + L("更新日志", "Release notes") + '</span>' +
      '<span class="zu-notes-badge"></span>' +
      '<button type="button" class="zu-notes-back" hidden></button>' +
      '<button type="button" class="zu-notes-history-btn" hidden>' + L("历史版本", "Version history") + '</button></div>' +
      '<div class="zu-notes-meta" role="status" aria-live="polite"></div>' +
      '<div class="zu-notes-body" aria-busy="false"></div>' +
      '<div class="zu-notes-foot">' +
      '<button type="button" class="zu-notes-toggle" hidden></button>' +
      '<button type="button" class="zu-notes-link" hidden></button>' +
      '<button type="button" class="zu-notes-retry" hidden>' + L("重试", "Retry") + '</button></div>' +
      '<div class="zu-notes-history" hidden></div></div>';
    }
    /* 更新日志卡片运行态（必须在下方早期 buildPanel() 调用前赋值——var 不提升初始值，issue #55 同款时序） */
    var notesSel = { version: "", explicit: false };   // 用户粘性选择：explicit 时轮询不切回默认
    var notesReqSeq = 0, notesListSeq = 0;
    var notesLoadedVersion = "", notesAutoTriedVersion = "", notesRequestedAt = 0;
    var NOTES_LOADING_TIMEOUT_MS = 120000;   // 回执丢失（切页/销毁静默丢弃）时由轮询驱动的 syncNotes 降级为可重试
    var notesResult = null, notesError = null;   // 与 notesLoadedVersion 配对的最近一次拉取结果
    var notesExpanded = false, notesBodySig = "";
    var notesHistory = null, notesHistoryError = null, notesHistoryState = "", notesHistorySig = "";
    /* ---------- 分区导航（v100，ZCode 设置侧栏同款交互）：左栏三组、内容区单分区显隐 ---------- */
    var ZU_NAV_GROUPS = [
      { id: "basics", zh: "基础", en: "Basics" },
      { id: "data", zh: "数据与统计", en: "Data & stats" },
      { id: "maint", zh: "维护", en: "Maintenance" },
    ];
    var ZU_SECTIONS = [
      { id: "display", group: "basics", zh: "状态条显示", en: "Display items",
        icon: '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>' },
      { id: "general", group: "basics", zh: "通用", en: "General",
        icon: '<path d="M4 7h4m5 0h7M4 17h9m5 0h2"/><circle cx="10.5" cy="7" r="2.5"/><circle cx="15.5" cy="17" r="2.5"/>' },
      { id: "rotator", group: "basics", zh: "状态轮播", en: "Status rotator",
        icon: '<path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83"/>' },
      { id: "stats", group: "data", zh: "回答统计", en: "Reply statistics",
        icon: '<path d="M4 4v16h16M8 16v-4m5 4V7m5 9v-6"/>' },
      { id: "quota", group: "data", zh: "套餐额度", en: "Plan quota",
        icon: '<path d="M4.2 18a9 9 0 1 1 15.6 0M12 13l4-4M6 18h12"/><circle cx="12" cy="13" r="1"/>' },
      { id: "update", group: "maint", zh: "插件更新", en: "Plugin updates",
        icon: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 21H3v-5"/>' },
      { id: "about", group: "maint", zh: "关于数据", en: "About the data",
        icon: '<circle cx="12" cy="12" r="9"/><path d="M11 11h1v6m-1 0h3m-2-10v.1"/>' },
    ];
    function activeSettingsSec() {
      for (var i = 0; i < ZU_SECTIONS.length; i++) if (ZU_SECTIONS[i].id === state.settingsSec) return state.settingsSec;
      return ZU_SECTIONS[0].id;
    }
    function secOpen(id) { return activeSettingsSec() === id ? "" : " hidden"; }
    function navHtml() {
      var active = activeSettingsSec();
      var html = '<nav class="zu-settings-nav" aria-label="' + L("设置分区", "Settings sections") + '">';
      for (var g = 0; g < ZU_NAV_GROUPS.length; g++) {
        var grp = ZU_NAV_GROUPS[g], gid = "zu-navgroup-" + grp.id;
        html += '<div class="zu-settings-navgroup" role="group" aria-labelledby="' + gid + '">' +
          '<div class="zu-navcap" id="' + gid + '">' + L(grp.zh, grp.en) + '</div>';
        for (var s = 0; s < ZU_SECTIONS.length; s++) {
          var it = ZU_SECTIONS[s];
          if (it.group !== grp.id) continue;
          html += '<button type="button" class="zu-navitem" data-sec="' + it.id + '"' + (it.id === active ? ' aria-current="page"' : '') +
            ' title="' + L(it.zh, it.en) + '"><span class="zu-nav-ic" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' + it.icon + '</svg></span>' +
            '<span class="zu-nav-label">' + L(it.zh, it.en) + '</span>' +
            (it.id === "update" ? '<span class="zu-nav-dot" aria-hidden="true"></span>' : '') + '</button>';
        }
        html += '</div>';
      }
      return html + '</nav>';
    }
    /* 面板文案可随语言重建（事件走 panel 级委托，重建不丢监听） */
    function buildPanel() {
      var oldBody = panel.querySelector(".zu-settings-body");
      var scrollTop = oldBody ? oldBody.scrollTop : 0;
      panel.innerHTML =
      '<div class="zu-settings-head"><div class="phead">' + L("状态条设置", "Status bar settings") + '<span class="pver zu-settings-version"></span></div>' +
      '<button type="button" class="zu-settings-close" aria-label="' + L("关闭设置", "Close settings") + '">✕</button></div>' +
      '<div class="zu-settings-layout">' + navHtml() +
      '<div class="zu-settings-body" tabindex="0" role="region" aria-label="' + L("状态条设置选项", "Status bar settings options") + '">' +
      '<section class="zu-settings-section" data-sec="display"' + secOpen("display") + '><div class="cap">' + L("状态条显示", "Display items") + '</div><div class="zu-settings-card">' +
      '<div class="zu-theme-title">' + L("状态条样式", "Status bar style") + '</div>' +
      '<div class="zu-theme-options" role="radiogroup" aria-label="' + L("状态条样式", "Status bar style") + '">' +
      '<label><input type="radio" class="zu-theme-choice" name="zu-theme-' + slot + '" value="default"><span>' + L("默认", "Default") + '</span></label>' +
      '<label><input type="radio" class="zu-theme-choice" name="zu-theme-' + slot + '" value="pill"><span>' + L("药丸", "Pill") + '</span></label>' +
      '<label><input type="radio" class="zu-theme-choice" name="zu-theme-' + slot + '" value="compact"><span>' + L("精简", "Compact") + '</span></label></div>' +
      '<div class="pnote">' + L("精简：隐藏悬浮条，生成速度移到输入框工具行前导区（Git 状态左侧），悬停它可看各格摘要并打开本设置。六个格全部关闭时自动转为精简，重新打开任一格即恢复原样式。", "Compact: hides the floating bar; the generation speed moves into the composer toolbar's leading group (left of the Git status chip) — hover it for cell summaries and a shortcut to these settings. With all six cells off the style switches to Compact automatically, and restores once any cell is turned back on.") + '</div>' +
      '<div class="zu-just-block"' + (state.theme === "default" ? '' : ' style="display:none"') + '>' +
      '<div class="zu-theme-title">' + L("水平对齐", "Horizontal alignment") + '</div>' +
      '<div class="zu-theme-options" role="radiogroup" aria-label="' + L("水平对齐", "Horizontal alignment") + '">' +
      '<label><input type="radio" class="zu-just-choice" name="zu-just-' + slot + '" value="between"' + (state.barJust === "between" ? " checked" : "") + '><span>' + L("均分对齐", "Space between") + '</span></label>' +
      '<label><input type="radio" class="zu-just-choice" name="zu-just-' + slot + '" value="start"' + (state.barJust === "start" ? " checked" : "") + '><span>' + L("居左对齐", "Align left") + '</span></label>' +
      '<label><input type="radio" class="zu-just-choice" name="zu-just-' + slot + '" value="end"' + (state.barJust === "end" ? " checked" : "") + '><span>' + L("居右对齐", "Align right") + '</span></label></div>' +
      '<div class="pnote">' + L("仅默认样式生效：均分为格铺满整条，居左/居右时格靠一侧聚拢，⚙ 齿轮仍在最右。", "Applies to the Default style only: space between spreads the cells across the bar; left/right packs them to one side — the gear stays at the far right.") + '</div></div>' +
      settingRow('<input type="checkbox" data-k="turn">', L("本轮", "Current turn"), L("tokens、请求次数、耗时与首字延迟", "Tokens, requests, duration and first-token latency")) +
      settingRow('<input type="checkbox" data-k="win">', L("会话累计", "Session total"), L("当前会话的 tokens、轮数与请求次数", "Tokens, turns and requests in this session")) +
      settingRow('<input type="checkbox" data-k="proj">', L("项目累计", "Project total"), L("本项目所有会话的消耗（含子代理），按目录归属", "Usage across all sessions in this project (sub-agents incl.), grouped by directory")) +
      settingRow('<input type="checkbox" data-k="tools">', L("工具调用", "Tool calls"), L("悬停查看各工具明细与错误", "Hover for per-tool details and errors")) +
      settingRow('<input type="checkbox" data-k="today">', L("今日合计", "Today's total"), L("今天所有会话的消耗", "Usage across all sessions today")) +
      settingRow('<input type="checkbox" data-k="sub">', L("子代理", "Sub-agents"), L("悬停或点击状态条上的子代理查看统计", "Hover or click the bar item for sub-agent stats")) +
      settingRow('<input type="checkbox" data-k="subRate">', L("子代理行内速率", "Sub-agent row rate"), L("在会话流的 Agent 工具行内实时显示各子代理 tok/s（运行期估算，完成后切换为真实平均速率；悬停看明细）。默认开启。", "Shows each sub-agent's live tok/s inside its Agent tool row (running estimate, actual average after completion; hover for details). On by default.")) +
      settingRow('<input type="checkbox" data-k="git">', L("Git 状态", "Git status"), L("工具行显示当前分支、↑领先 ↓落后与未提交改动（+插入行 -删除行 ?未跟踪）；优先挂在「电脑操作」右侧，缺失时留在左侧操作区末尾；仅本地仓库", "Branch, ↑ahead ↓behind and uncommitted changes (+ins -del ?untracked) in the toolbar; beside Computer Use, or at the end of the left action group when unavailable; local repositories only")) +
      '</div></section>' +
      '<section class="zu-settings-section" data-sec="general"' + secOpen("general") + '><div class="cap">' + L("通用", "General") + '</div><div class="zu-settings-card">' +
      settingRow('<input type="text" class="zu-ctxov" inputmode="numeric" aria-label="' + L("上下文窗口", "Context window") + '" placeholder="' + L("自动（按模型）", "Auto (model)") + '">', L("上下文窗口", "Context window"), L("留空自动识别，优先使用客户端数值；手动值以 token 为单位，按整数读取", "Leave empty for automatic detection, preferring the client value; manual values are read as integer tokens")) +
      settingRow('<input type="checkbox" class="zu-ctx-enh">', L("上下文按钮增强", "Context button enhancement"), L("在输入框上下文按钮上显示环形用量填充、档位颜色与百分比；关闭即还原原生形态（重置卡徽标不受影响）。默认开启。", "Adds a ring fill, tier color and percentage to the context button; off restores the native look (reset card badge is unaffected). On by default.")) +
      settingRow('<input type="checkbox" class="zu-cpt-btn">', L("压缩上下文按钮", "Compact context button"), L("在「上下文容量」弹层内显示「压缩上下文」按钮（点击后需二次确认，把会话历史总结压缩以释放上下文窗口）。关闭即不再显示；自动压缩阈值行不受影响，位置上移补位。默认开启。", "Shows the Compact context button inside the context-usage popup (with a confirmation step that summarizes the conversation to free context window space). Off hides it; the auto-compact threshold row is unaffected and moves up into the button's place. On by default.")) +
      settingRow('<input type="checkbox" class="zu-cost-enable">', L("预估费用", "Estimated cost"), L("悬停本轮/会话累计/项目累计/今日合计时显示按 models.dev 官方模型价格估算的费用（USD×汇率折 ¥；无汇率时显示 $ 原值；模型匹配不到价格按默认均价估算）。启动后每 12 小时静默同步一次价表与汇率，只下载不上传，可在配置文件关闭。默认开启。", "Shows estimated cost when hovering the stat cells, priced at official models.dev rates (USD × exchange rate as ¥; falls back to $ without a rate; unmatched models use a default average). The price table and FX rate sync silently every 12h after startup — download only, nothing uploaded; can be disabled in the config file. On by default.")) +
      settingRow('<input type="checkbox" class="zu-tip-click">', L("点击激活悬浮窗口", "Click to open popups"), L("开启后状态条统计卡与子代理面板改为点击才打开（再点同一格、按 Escape 或移出条面收起）；关闭时悬停立即显示。键盘 Tab 聚焦两种模式下都即时打开。默认关闭。", "On: bar stat cards and the sub-agent panel open on click only (click the same cell again, press Escape or move off the bar to close); off: they show immediately on hover. Keyboard Tab focus opens immediately in both modes. Off by default.")) +
      /* v297.3：开发者调试开关——tooltip 常驻（移出条面/窗口不自动关闭，Escape 仍可关） */
      settingRow('<input type="checkbox" class="zu-dev-keep-tip">', L("开发者：悬浮窗常驻", "Developer: keep tooltip visible"), L("开启后悬浮窗移出条面/移出窗口都不会自动关闭，用于截图与布局调试定位；按 Escape 或点击「关闭设置」等既有入口仍可关闭。仅调试用途，常开会影响日常使用。默认关闭。", "On: the tooltip stays open when the pointer leaves the bar or the window, for screenshot and layout debugging; Escape and the usual close paths still work. Debugging aid only — leaving it on gets in the way of daily use. Off by default.")) +
      /* v179 自动压缩阈值注入 → v188 按验收反馈简化：只留百分比（留空=跟随引擎默认），
         开关默认开（主进程 auto_compact_patch 缺省开）；标题带「上下文」限定。 */
      settingRow('<input type="checkbox" class="zu-ac-enable">', L("自动压缩上下文阈值注入", "Auto-compact context threshold injection"), L("给客户端引擎打补丁，把「到达阈值自动压缩上下文」的触发点改为可配置（引擎内置约在窗口 83% 处）。默认开启；补丁按引擎版本白名单注入，不支持的版本自动跳过并提示，关闭开关即还原引擎。开关对新会话生效；下方数值改完即生效（留空=跟随引擎默认）。只影响桌面客户端内置引擎，终端 CLI 不受影响。", "Patches the client engine so the auto-compact trigger point becomes configurable (the built-in engine fires around 83% of the window). On by default; patching is allow-listed per engine build, unsupported builds are skipped with a notice, and turning the switch off restores the engine. New sessions pick up the patch; the value below applies immediately (leave empty to follow the engine default). Only the desktop client's built-in engine is affected; the terminal CLI is not.")) +
      settingRow('<input type="text" class="zu-ac-value" inputmode="numeric" aria-label="' + L("压缩上下文阈值数值", "Context compaction threshold value") + '" placeholder="' + L("留空=跟随引擎默认", "Empty = engine default") + '">', L("压缩上下文阈值数值（%）", "Context compaction threshold value (%)"), L("压缩触发点占总窗口的百分比，取 30-99；留空=跟随引擎默认。任何形式都会被钳到不早于有效窗口的 1%，避免连环压缩。", "Compaction trigger as a percentage of the full context window, 30-99; leave empty to follow the engine default. Any form is clamped to no earlier than 1% of the effective window to prevent compaction loops.")) +
      '<div class="zu-ac-status" role="status"></div>' +
      /* 万/亿开关只在中文界面出现（英文始终 K/M/B，见 fmt），因此文案不走 L() */
      (state.lang === "en" ? "" : settingRow('<input type="checkbox" class="zu-cn-num">', "中文单位（万/亿）", "token 数量以万/亿显示，默认开启")) +
      settingRow('<input type="checkbox" class="zu-force-kmb">', L("强制 K/M/B 单位", "Force K/M/B units"), L("token 数量使用 K/M/B，默认关闭；不影响请求数和 Git 计数。", "Use K/M/B for token amounts; off by default. Request and Git counts are unaffected.")) +
      settingRow('<input type="checkbox" class="zu-pp-enable">', L("项目完整路径", "Full project paths"), L("「编辑项目」弹窗的源文件夹在名称下方显示完整路径；长路径自动换行，多文件夹逐行显示。点击文件夹行会用系统文件管理器打开该目录（macOS Finder / Windows 资源管理器；远程项目的路径在本机无意义，不响应）。默认开启。", "Shows the full path below each folder name in the Edit Project dialog; long paths wrap, one block per folder. Click a folder row to open it in your file manager (Finder on macOS, Explorer on Windows; remote project paths are skipped). On by default.")) +
      settingRow('<input type="checkbox" class="zu-cmdk-widen">', L("命令中心加宽", "Wider command center"), L("把宿主 ⌘K 搜索弹框（命令中心、任务搜索等）放宽到窗口宽度的 80%、高度的 80%；小窗口保持原生尺寸。关闭后恢复原生尺寸。默认开启。", "Widens the host ⌘K search dialogs (command center, task search, …) to 80% of the window width and height; small windows keep the native size. Turning it off restores the native size. On by default.")) +
      '<div class="zu-settings-langs"><label><input type="radio" name="zu-lang" value="zh"><span>中文</span></label>' +
      '<label><input type="radio" name="zu-lang" value="en"><span>English</span></label></div></div></section>' +
      (typeof zuRotatorSectionHtml === "function" ? zuRotatorSectionHtml(secOpen("rotator") === "") : "") +
      '<section class="zu-settings-section" data-sec="stats"' + secOpen("stats") + '><div class="cap">' + L("回答统计", "Reply statistics") + '</div><div class="zu-settings-card">' +
      settingRow('<input type="checkbox" class="zu-rate-line">', L("回答末尾追加统计行", "Append stats to each reply"), L("切换后立即重扫：关闭会撤下插件生成的统计行，开启会补回可用记录。下一次提问沿用该设置；历史正文和已缓存统计行不重算。", "Rescans immediately: off removes plugin-generated lines; on restores available records. Applies to the next prompt; historical text and cached statistics are not recalculated.")) +
      '</div></section>' +
      '<section class="zu-settings-section" data-sec="quota"' + secOpen("quota") + '><div class="cap">' + L("套餐额度", "Plan quota") + '</div><div class="zu-settings-card">' +
      settingRow('<input type="checkbox" class="zu-quota-enable">', L("显示套餐额度", "Show plan quota"), L("在输入框上下文按钮左侧显示当前登录账号编码套餐的已用比例与重置时间（含 Start Plan 免费档池的已用比例与到期时间；账号级套餐池，不是单个模型独享）。默认开启，关闭即停查询。点击 chip 立即刷新。", "Shows the signed-in account's coding-plan usage and reset time left of the context button (plus the Start Plan free tier's usage and expiry; account-level pool, not per model). On by default; turning it off stops the queries. Click the chip to refresh.")) +
      settingRow('<input type="checkbox" class="zu-quota-remain">', L("显示剩余额度", "Show remaining quota"), L("把额度 chip 与悬停明细改为按剩余比例展示（剩余% = 100 − 已用%，同一额度窗口的补数）；段位颜色仍按已用量判定：剩得越少越红。账户余额与 Key 剩余额度本身就是剩余口径，不受影响。默认关闭（显示已用）。", "Switches the quota chip and its hover details to remaining percentages (remaining% = 100 − used%, the complement of the same window); segment colors still follow the used amount — the less left, the redder. Account balance and remaining key quota are already remaining-based and unaffected. Off by default (shows used).")) +
      settingRow('<input type="checkbox" class="zu-rst-enable">', L("重置卡徽标", "Reset card badge"), L("在额度 chip 左侧显示账号可用的额度重置卡（次数、到期倒计时，悬停看每张卡明细）。默认开启。独立于额度开关：关闭「显示套餐额度」后，本开关开启时仍查询重置卡（仅官方 reset/status 只读接口，发往 zcode.z.ai）。需要 ZCode 登录态；仅 API Key 用户与团队套餐无重置卡。", "Shows available quota reset cards left of the quota chip (count, countdown; hover for per-card details). On by default. Independent of the quota toggle: when the quota chip is off, this keeps polling the official read-only reset/status endpoint (zcode.z.ai). Requires the ZCode sign-in; API-key-only users and team plans have no reset cards.")) +
      settingRow('<input type="text" class="zu-rst-cdh" inputmode="numeric" aria-label="' + L("重置倒计时阈值（小时）", "Reset countdown threshold (hours)") + '">', L("倒计时阈值（小时）", "Countdown threshold (hours)"), L("重置卡剩余时间短于该值时在徽标上显示倒计时，默认 24（1–168）。", "Show a countdown on the badge when a card has less time left than this, in hours; default 24 (1–168).")) +
      '<div class="pnote">' + L("开启后主进程读取本机 ZCode 登录凭据（~/.zcode/v2/credentials.json；ZCode 3.18.0 起解密它所需的密钥取自系统钥匙串或宿主 managed secret，在 ZCode 进程内读取）查询官方套餐接口：凭据仅在内存使用、不落盘、不进日志与诊断：内置套餐发往 bigmodel.cn / api.z.ai 官方域，Start Plan 免费档发往 zcode.z.ai；自定义供应商余额用其自己的 key，只发其官方域（api.deepseek.com、openrouter.ai、api.siliconflow.cn、api.minimaxi.com、api.kimi.com、api.commandcode.ai、api.cline.bot、api.anthropic.com、platform.xiaomimimo.com、open.volcengineapi.com、opencode.ai 等）或你配置的中转站本域。套餐支持 BigModel / Z.ai 个人档与多家 Token Plan/余额（见下方数据源列表）；团队套餐暂不支持，识别不了余额形状的中转不显示。启用 Anthropic 源时会读取本机 Claude Code 的登录凭据（~/.claude/.credentials.json）查询其官方用量接口，同样仅在内存使用。",
        "When on, credentials are read in memory to query plan/balance endpoints and never reach disk, logs or diagnostics (since ZCode 3.18.0 the key that decrypts the sign-in credentials is read from the OS keychain or the host's managed secret, inside the ZCode process): built-in plans go to bigmodel.cn / api.z.ai, the Start Plan free tier to zcode.z.ai; custom-provider lookups use that provider's own key and go only to its official domain (api.deepseek.com, openrouter.ai, api.siliconflow.cn, api.minimaxi.com, api.kimi.com, api.commandcode.ai, api.cline.bot, api.anthropic.com, platform.xiaomimimo.com, open.volcengineapi.com, opencode.ai, ...) or the relay base URL you configured — never anywhere else. Multiple Token Plan / balance vendors are supported (see the source list below); team plans are not. Enabling the Anthropic source additionally reads the local Claude Code credential (~/.claude/.credentials.json) for its official usage endpoint, in memory only.") + '</div>' +
      '<div class="zu-src-list"></div>' +
      '<div class="pnote">' + L("每个数据源独立启用、独立刷新；凭据只保存在本机 quota-secrets.json（0600），不进日志与诊断。标 * 的厂商为源码转写适配，未经真实账号实测。", "Each source has its own toggle and refresh; credentials stay in the local quota-secrets.json (0600), never in logs or diagnostics. Vendors marked * are ported from reference projects without live verification.") + '</div></div></section>' +
      '<section class="zu-settings-section" data-sec="update"' + secOpen("update") + '><div class="cap">' + L("插件更新", "Plugin updates") + '</div><div class="zu-settings-card">' +
      settingRow('<input type="checkbox" class="zu-auto-update">', L("自动更新", "Automatic updates"), L("每 1 小时检查并安装新版，默认开启", "Check and install every hour; on by default")) +
      settingRow('<input type="checkbox" class="zu-restart-notice">', L("更新后在状态条显示红点提醒", "Show a status bar badge after updates"), L("插件的更新包含需重启 ZCode 的文件时，状态条 ⚙ 与左侧「插件更新」项显示红点，点进「插件更新」分区后消失；关闭后不再显示。更新成功且无需重启（已自动热重载）不显示红点。", "When an update includes files that need a ZCode restart, the status bar gear and the Plugin updates entry show a red dot until you open that section; turn off to hide. No dot when an update finished without a restart (hot-reloaded automatically).")) +
      '<div class="pnote">' + L("更新器变更需完全退出并重开 ZCode 后生效；客户端关闭期间不检查。", "Updater changes take effect after fully quitting and reopening ZCode; no checks run while the app is closed.") + '</div>' +
      '<div class="zu-settings-detail"><div class="zu-upd-banner" hidden></div><div class="zu-update-actions"><button type="button" data-update="check">' + L("检查更新", "Check for updates") + '</button><button type="button" data-update="update">' + L("立即更新", "Update now") + '</button><button type="button" data-update="relaunch">' + L("重启 ZCode", "Restart ZCode") + '</button></div>' +
      '<div class="pnote zu-update-status" role="status" aria-live="polite"></div>' +
      '<div class="zu-update-progress" hidden>' +
      '<div class="zu-progress-row" data-progress="download"><span class="zu-progress-label">' + L("下载", "Download") + '</span><div class="zu-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100"><div class="zu-progress-fill"></div></div><span class="zu-progress-value"></span></div>' +
      '<div class="zu-progress-row" data-progress="install"><span class="zu-progress-label">' + L("安装", "Install") + '</span><div class="zu-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100"><div class="zu-progress-fill"></div></div><span class="zu-progress-value"></span></div>' +
      '</div>' +
      '<div class="pnote">' + L("仅更新此插件。GitHub/GitCode 来源会联网，本地目录来源只检查本地文件，不上传用量数据。", "Only this plugin is updated. GitHub/GitCode sources use the network; directory sources check local files. Usage data is never uploaded.") + '</div></div>' +
      /* v202 更新日志卡片：骨架静态，内容由 syncNotes 按状态填充（幂等签名，不抢滚动/焦点） */
      notesCardHtml() + '</section>' +
      '<section class="zu-settings-section" data-sec="about"' + secOpen("about") + '><div class="cap">' + L("关于数据", "About the data") + '</div><div class="pnote">' +
      L("数据库统计：只读本地用量库（默认 ~/.zcode/cli/db/db.sqlite，跟随宿主 dataBaseDir 迁移），请求完成后入库；总 token 为输入加输出，缓存已含在输入中，思考已含在输出中。", "Database statistics: read-only from the local usage database (default ~/.zcode/cli/db/db.sqlite; follows the host dataBaseDir migration), written after requests complete. Total tokens = input + output; cache is included in input and thinking in output.") + '</div><div class="pnote">' +
      L("生成速度：只读渲染器状态桥在生成时按字符增量估算，完成后切换为真实速度；桥不可用时回退数据库最近有效段。", "Generation speed: the read-only renderer bridge estimates from text deltas while running and uses actual speed after completion; without the bridge it falls back to the latest valid database segment.") + '</div><div class="pnote">' +
      L("联网边界：额度源查询对应账号的套餐或余额接口；插件更新可联网下载代码与读取发布日志（源码渠道为注册仓库的同号 Release 参考）。额度不是本地 token 统计推算值。SSH 数据查询使用已配置通道。", "Network boundaries: quota sources query account plan/balance endpoints; plugin updates can download code and read release notes (source channels read the registered repo's same-version release as reference). Quota is not inferred from local token usage. SSH statistics use configured connections.") + '</div></section></div></div>' +
      '<div class="zu-settings-foot"><button type="button" class="zu-settings-scroll"></button>' +
      '<span class="zu-settings-feedback-status" role="status" aria-live="polite"></span>' +
      '<button type="button" class="zu-settings-feedback">' + L("反馈问题", "Report an issue") + '</button></div>';
      panel.querySelectorAll('input[name=zu-lang]').forEach(function (r) {
        r.checked = state.lang === r.value;
      });
      panel.querySelectorAll('.zu-theme-choice').forEach(function (r) {
        r.checked = state.theme === r.value;
      });
      panel.querySelectorAll('.zu-just-choice').forEach(function (r) {
        r.checked = state.barJust === r.value;
      });
      /* 重建后回填全部控件状态（语言切换路径不走 syncPanel）：checkbox 按 state.show、
         上下文窗口输入框按 state.ctxOv——否则切语言后勾选态清空、首次点击语义反转 */
      panel.querySelectorAll("input[type=checkbox][data-k]").forEach(function (cb) {
        cb.checked = !!state.show[cb.dataset.k];
      });
      var ovInput = panel.querySelector(".zu-ctxov");
      if (ovInput) ovInput.value = state.ctxOv;
      var kmbBox = panel.querySelector(".zu-force-kmb");
      if (kmbBox) kmbBox.checked = !!state.forceKmb;
      var cnBox = panel.querySelector(".zu-cn-num");
      if (cnBox) cnBox.checked = !!state.cnNum;
      var ppBox = panel.querySelector(".zu-pp-enable");
      if (ppBox) ppBox.checked = !!state.projPath;
      var ctxEnhBox = panel.querySelector(".zu-ctx-enh");
      if (ctxEnhBox) ctxEnhBox.checked = !!state.ctxEnh;
      var cptBox = panel.querySelector(".zu-cpt-btn");
      if (cptBox) cptBox.checked = !!state.ctxCpt;
      var costBox = panel.querySelector(".zu-cost-enable");
      if (costBox) costBox.checked = !!state.cost;
      var cwBox = panel.querySelector(".zu-cmdk-widen");
      if (cwBox) cwBox.checked = !!state.cmdkW;
      var tipClickBox = panel.querySelector(".zu-tip-click");
      if (tipClickBox) tipClickBox.checked = !!state.tipClick;
      var qrBox = panel.querySelector(".zu-quota-remain");
      if (qrBox) qrBox.checked = !!state.quotaRemain;
      if (typeof zuRotatorSyncPanel === "function") zuRotatorSyncPanel(panel);
      syncUpdate();
      panel.querySelector(".zu-settings-body").scrollTop = scrollTop;
      if (panel.setAttribute) panel.setAttribute("aria-label", L("状态条设置", "Status bar settings"));
      syncSettingsScroll();
    }
    function syncSettingsScroll() {
      var body = panel.querySelector(".zu-settings-body");
      var button = panel.querySelector(".zu-settings-scroll");
      if (!body || !button) return;
      /* 窄面板（<620px）导航收成 icon rail：ZCode max-lg icon-only 同语义，按面板实测宽切换 */
      panel.classList.toggle("zu-nav-icons", !!panel.offsetWidth && panel.offsetWidth < 620);
      var overflow = body.scrollHeight > body.clientHeight + 2;
      var more = overflow && body.scrollHeight - body.clientHeight - body.scrollTop > 2;
      panel.classList.toggle("zu-settings-more", more);
      button.disabled = !more;
      var text = more ? L("↓ 下方还有设置 · 滚动或点击查看更多", "↓ More settings below · scroll or click to see more") :
        overflow ? L("✓ 已到底部 · 所有设置已展示", "✓ End of settings") : L("所有设置已展示", "All settings are visible");
      if (button.textContent !== text) button.textContent = text;
    }
    function positionSettingsPanel() {
      if (!panel.classList.contains("open")) return;
      var br = bar.getBoundingClientRect();
      var panelCard = state.theme === "pill" ? (pillSurface || cardCache) : null;
      if (state.theme === "compact" && !panelCard && cardCache && cardCache.isConnected) panelCard = cardCache;   // v146：条隐藏时对齐输入卡（几何/宽度锚）
      var cardRect = panelCard ? panelCard.getBoundingClientRect() : null;
      var anchorTop = cardRect ? cardRect.top : br.top;
      var height = Math.max(0, Math.floor(anchorTop - 18));
      /* 打开时以视口高度提供稳定阅读区域，切页不缩放；可用空间减少时只收紧。 */
      if (!panel.style.height) {
        var preferred = Math.floor((typeof innerHeight === "number" ? innerHeight : window.innerHeight) * .9);
        panel.style.height = Math.max(0, Math.min(preferred, height)) + "px";
      } else if ((parseInt(panel.style.height, 10) || 0) > height) {
        panel.style.height = height + "px";
      }
      var value = height + "px";
      if (panel.style.getPropertyValue("--zu-settings-height") !== value) panel.style.setProperty("--zu-settings-height", value);
      var panelWidth = cardRect ? Math.min(cardRect.width, Math.max(0, innerWidth - 16))
        : (br.width || Math.min(560, Math.max(0, innerWidth - 16)));   // v146：精简且无卡片时给可用宽兜底（条 rect 为 0）
      value = panelWidth + "px";
      if (panel.style.width !== value) panel.style.width = value;
      /* v80：面板 fixed 挂 body——视口坐标贴条上沿（原 absolute 语义 bottom:100%+10px），
       * 左缘随条、可视区内夹紧；top 用开启后的实测面板高，避免底部悬空/重叠。 */
      var left = Math.max(8, Math.min(Math.round(cardRect ? cardRect.left : br.left), innerWidth - Math.round(panelWidth) - 8));
      if (panel.style.left !== left + "px") panel.style.left = left + "px";
      var top = Math.max(8, Math.round(anchorTop - panel.offsetHeight - 10));
      if (panel.style.top !== top + "px") panel.style.top = top + "px";
      syncSettingsScroll();
    }
    var previousPanelFocus = null;
    function closeSettings(restoreFocus) {
      panel.classList.remove("open");
      /* 轮播实时预览定时器随面板关闭即停（不靠 tick 的 hidden 跳过空转）；panelEl 归属守卫防跨实例误杀 */
      if (typeof rotPreview !== "undefined" && rotPreview.timer && rotPreview.panelEl === panel) { clearInterval(rotPreview.timer); rotPreview.timer = null; }
      panel.setAttribute("aria-modal", "false");
      gear.setAttribute("aria-expanded", "false");
      if (restoreFocus !== false) {
        var target = previousPanelFocus && previousPanelFocus.isConnected && previousPanelFocus.offsetParent ? previousPanelFocus : null;   // v155：归还目标不可见（如 compact 下的隐藏 gear）不强行 focus
        if (!target && gear.offsetParent) target = gear;
        if (target) { try { target.focus(); } catch (e) { } }
      }
      previousPanelFocus = null;
    }
    panel.addEventListener("scroll", syncSettingsScroll, true);
    panel.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        closeSettings(true);
        e.stopPropagation();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
        var nav = panel.querySelector(".zu-settings-nav");
        var buttons = nav ? nav.querySelectorAll(".zu-navitem") : [];
        var current = Array.prototype.indexOf.call(buttons, document.activeElement);
        if (current < 0 || !buttons.length) return;
        if (e.key === "Home") current = 0;
        else if (e.key === "End") current = buttons.length - 1;
        else current = (current + (e.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length;
        e.preventDefault();
        buttons[current].focus();
      }
    });
    buildPanel();
    /* v80：面板挂 body（fixed 视口坐标），不再挂 bar——条长进输入卡片（overflow-hidden）
     * 内部后，absolute 面板会被卡片裁掉。同 .tip 挂 body 的先例；.zusage-panel 类供
     * 全局清理与 isOwnOverlay 命中。 */
    panel.className = "panel zu-settings zusage-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "false");
    panel.setAttribute("aria-label", L("状态条设置", "Status bar settings"));
    document.body.appendChild(panel);
    /* 子代理统一浮层（v217，原 v49 明细面板节点原位改造）：悬停预览/点击固定共用，
     * 与设置面板同款 .panel 机制 + zusage-panel 全局清理命中；非模态 dialog（同设置面板） */
    var subPanel = document.createElement("div");
    subPanel.className = "panel zu-sub-pop zusage-panel";
    subPanel.setAttribute("role", "dialog");
    subPanel.setAttribute("aria-modal", "false");
    subPanel.setAttribute("aria-label", L("子代理", "Sub-agents"));
    document.body.appendChild(subPanel);
    /* v215：面板内模型行 ? 图标 → 费用说明气泡（复用 fxTip 单例与 tip 同款委托；
     * 仅 data-model 上下文有效，随面板元素移除一并回收，无需独立 dispose） */
    subPanel.addEventListener("mouseover", function (e) {
      var q = e.target && e.target.closest && e.target.closest(".tip-fxq");
      if (q) {
        cancelFxHide();
        var dm = q.getAttribute && q.getAttribute("data-model");
        var info = { type: "default" };
        if (dm) {
          var dr = q.getAttribute("data-rates");
          var parsed = null;
          try { parsed = dr ? JSON.parse(dr) : null; } catch (e1) { parsed = null; }
          var mc = parseInt(q.getAttribute("data-mcount") || "1", 10) || 1;   // v248：汇总 KPI 多模型 → 计价范围
          info = mc > 1
            ? { type: "scope", count: mc, scope: q.getAttribute("data-mscope") || "" }
            : { type: "model", model: dm, rates: parsed };
        }
        showFxTip(q, info);
      }
    });
    subPanel.addEventListener("mouseout", function (e) {
      if (!(e.target && e.target.closest && e.target.closest(".tip-fxq"))) return;
      var to = e.relatedTarget;
      if (to && (to === fxTip || (fxTip.contains && fxTip.contains(to)))) return;
      scheduleFxHide();
    });
    /* 自绘 tooltip：向上弹出（v45 起配空中走廊，移入点击不再被移开即隐掐断）；取代原生 title（方向不可控，在窗口底边会朝下被遮挡） */
    /* 自绘 tooltip 挂 body（fixed 视口坐标）：挂 bar 内会被消息流的层叠上下文盖住（v31 实证） */
    var tip = document.createElement("div");
    tip.className = "tip zusage-tip-root";
    tip.id = slot === 0 ? "zusage-tip" : "zusage-tip-" + slot;
    tip.setAttribute("role", "tooltip");
    tip.style.display = "none";
    /* v281：图表横向滚动时按柱体新 rect 重定位 Portal（柱滚出可视区即收） */
    tip.addEventListener("scroll", function () {
      if (tipFor) spdHoverPortalPlace(tip, speedChartHover);
    }, true);
    document.body.appendChild(tip);
    /* 预估费用 ? 图标 → 说明小气泡（fxTip 模块级单例；mouseover 委托，innerHTML 重建不丢）。
     * mouseout 移入气泡本体时保持（relatedTarget 判定），离开延迟收起（scheduleFxHide）。 */
    tip.addEventListener("mouseover", function (e) {
      var q = e.target && e.target.closest && e.target.closest(".tip-fxq");
      if (q) {
        cancelFxHide();
        /* v214.1 气泡上下文：明细行 icon（data-model）→ 该模型单价；项目卡内 → 项目计价范围；
         * v248 KPI icon 另带 data-mcount>1 → 计价范围行（scope 名词随 data-mscope）。 */
        var info = { type: "default" };
        var inProject = !!(q.closest && q.closest(".zu-project-tip"));
        var dm = q.getAttribute && q.getAttribute("data-model");
        if (dm) {
          /* 单价随 icon 的 data-rates 属性携带（生成时已绑定该行模型），零跨语境查找 */
          var dr = q.getAttribute("data-rates");
          var parsed = null;
          try { parsed = dr ? JSON.parse(dr) : null; } catch (e) { parsed = null; }
          var mc = parseInt(q.getAttribute("data-mcount") || "1", 10) || 1;
          info = mc > 1
            ? { type: "scope", count: mc, scope: q.getAttribute("data-mscope") || "" }
            : { type: "model", model: dm, rates: parsed };
        } else if (inProject) {
          var pjModels = (lastView && lastView.session && lastView.session.project && lastView.session.project.models) || [];
          info = { type: "project", count: pjModels.length };
        }
        showFxTip(q, info);
      }
    });
    /* v214 项目卡展开/收起：局部更新模型区（projTipApplyModels），不整卡重建 */
    /* v329：展开/收起委托共用函数（pointerdown 提前生效 + 阻止宿主失焦 + 配合 click 幂等防重复翻转） */
    var lastMoreDownAt = 0;
    function projTipMoreActivate(e) {
      var btn = e.target && e.target.closest && e.target.closest(".zu-pj-more");
      if (!btn) return false;
      e.stopPropagation();
      if (e.preventDefault) e.preventDefault();
      if (e.type === "pointerdown" && e.button) return true;   // 右/中键不翻转
      if (e.type === "pointerdown") {
        lastMoreDownAt = Date.now();
      } else if (lastMoreDownAt) {
        /* pointerdown 已翻转：其后的 click 一次性吞掉（与按住时长无关；3s 过期兜底拖出松开无 click 的残留） */
        var swallow = Date.now() - lastMoreDownAt < 3000;
        lastMoreDownAt = 0;
        if (swallow) return true;
      }
      projTipExpanded = !projTipExpanded;
      projTipApplyModels(btn);
      return true;
    }
    /* v276：整卡重编同步执行——v275 曾用 rAF 合并「重建风暴」，但被遮挡窗口的
     * 渲染帧暂停会让 rAF 永不执行（本机 ZCode 常被 Chrome/飞书遮挡），切 Tab 后
     * tooltip 僵在旧内容（用户实报「会话切到项目卡死」）。同步重编单次 1-3ms
     * 可承受，是被遮挡窗口下唯一可靠路径；连点去抖不再需要。 */
    var speedRebuildNow = function () {
      if (tipFor && typeof speedTipRebuild === "function") {
        tipFor.__tip = speedTipRebuild(speedChartHover, speedSel);
        drawTip(tipFor, true);
        spdHoverPortalSync(tip, speedChartHover);   /* v281：切 Tab 旧卡立即失效（§7.3） */
      }
    };
    /* v263：Tab 切换共用函数。生成中 updateLive 每 100ms 重编整卡（估算/计时走字让
     * tipSig 每 tick 变化 → innerHTML 重建），mousedown 命中的按钮在 mouseup 前被替换，
     * click 落到共同祖先、closest(".zu-sv-tab") 为 null——用户实报「Tab 点击无效」的根因。
     * pointerdown 在重建窗口之前同步完成切换（此时按钮节点必然存活）；与 click 委托
     * 幂等共存（重建未发生时 click 再跑一遍同值切换无害），键盘 Enter 只发 click 走原路径。 */
    function speedTabActivate(e) {
      var tab = e.target && e.target.closest && e.target.closest(".zu-sv-tab");
      if (!tab) return false;
      e.stopPropagation();
      var grp = tab.getAttribute("data-sv-group"), val = tab.getAttribute("data-sv-val");
      if ((grp === "range" && SPD_RANGES.indexOf(val) >= 0) ||
          (grp === "period" && SPD_PERIODS.indexOf(val) >= 0)) {
        speedSel[grp] = val;
        speedChartHover = -1; speedInteractAt = Date.now();
        /* v272：维度切换移除，dim 恒 time，无需按范围归位 */
        speedRebuildNow();
      }
      return true;
    }
    /* 任何按下交互（含维度 select、柱）都立即进入 600ms 交互冻结：原生下拉展开期间
     * 页面不收 mousemove，若中途重建整卡会销毁展开中的 select——按下即冻结补住这条缝。 */
    /* v275：指针在 tip 内的原生 pointermove 直接保活——mousemove 处理器有 150ms
     * 节流采样盲区，快速移入/静止时 mouseInBar 可能停留 false，left-bar 等 force
     * 路径就能关掉用户正在交互的 tooltip（用户实报「有时候点击 tab 直接关闭」）；
     * pointermove 高频纯赋值无开销，绕开节流盲区让总闸始终可靠。 */
    tip.addEventListener("pointermove", function () {
      mouseInBar = true;
      cancelTipGrace();
    });
    /* v277：入口活体检查方案下无宽限期，focusin 无需保活（edge 真离开时焦点随走） */
    tip.addEventListener("pointerdown", function (e) {
      /* v265：按下即建总闸——快速移动/合成指针下 mousemove 采样可能全部被 150ms
       * 节流丢弃，mouseInBar 停留 false（tooltip 常经 focusin 打开，不经 mousemove），
       * 一次快照推送的 render-orphan 就能关掉正在交互的 tooltip，点击落在消息区。
       * 「指针按在 tip 内」这一事实本身就是最强保活信号，先于一切判定生效。 */
      mouseInBar = true;
      cancelTipGrace();
      lastTipDownAt = Date.now();
      speedInteractAt = Date.now();
      if (projTipMoreActivate(e)) return;
      speedTabActivate(e);
    });
    tip.addEventListener("mousedown", function (e) {
      /* v329：防止 tip 内交互元素在 mousedown 冒泡至宿主导致编辑器失焦或关闭卡片 */
      var t = e.target;
      if (!t || !t.closest) return;
      var interactive = t.closest(".zu-pj-more") || t.closest(".zu-sv-tab");
      if (interactive) {
        e.stopPropagation();
        if (e.preventDefault) e.preventDefault();
      }
    });
    tip.addEventListener("click", function (e) {
      if (projTipMoreActivate(e)) return;
      /* v254 速度 Tooltip 双 Tab：事件委托挂 tip 本体，改实例闭包选择后经
       * speedTipRebuild 整卡重编（签名幂等），旧 hover 卡随筛选切换自动收起。
       * v263：鼠标路径已提前到 pointerdown（见上），此处保留键盘 Enter 与兜底。 */
      speedTabActivate(e);
    });
    /* 项目卡内部 Escape：先收档位说明浮层（v282，只收浮层不关卡）、再收费用说明
     * （fxTip），否则关卡；关闭后焦点归还仍存活的触发项。 */
    tip.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (spdLegendTip.style.display === "block") { spdLegendTipHide(); return; }
      if (fxTip.style.display === "block") { hideFxTip(); return; }
      var back = tipFor;
      hideTip(true, "escape");
      restoringFocus = true;
      try { if (back && back.focus) back.focus(); } finally { setTimeout(function () { restoringFocus = false; }, 0); }
    });
    tip.addEventListener("mouseout", function (e) {
      if (!(e.target && e.target.closest && e.target.closest(".tip-fxq"))) return;
      var to = e.relatedTarget;
      if (to && (to === fxTip || (fxTip.contains && fxTip.contains(to)))) return;
      scheduleFxHide();
    });
    /* v232 速度柱状图悬停/键盘焦点：委托挂 tip 本体（innerHTML 重建不丢，tip.remove()
     * 随实例消亡、无需进 dispose）。悬停段下标存实例闭包，经 speedTipRebuild 整卡重编
     * （cur 类与信息卡随串自愈 → 数据刷新整卡重建不丢悬停状态）；v240 起 -1/离开=不显示信息卡。 */
    function zuSpeedChartPick(idx) {
      if (idx === speedChartHover) return;
      /* v291：热力图格子（.zu-hm-cell）与柱体（.zu-sc-col）共用同一悬停/焦点契约 */
      var hadFocus = tip.contains(document.activeElement) &&
        document.activeElement.closest && document.activeElement.closest(".zu-sc-col,.zu-hm-cell");
      speedChartHover = idx; speedInteractAt = Date.now();
      if (tipFor && typeof speedTipRebuild === "function") {
        var t2 = speedTipRebuild(speedChartHover, speedSel);
        if (t2 && tipFor.__tip !== undefined) {
          tipFor.__tip = t2;
          drawTip(tipFor, true);
          /* innerHTML 重建会销毁聚焦的柱节点（焦点落 body、Tab 序断裂）——归位 */
          if (hadFocus && idx >= 0) {
            var nu2 = tip.querySelector('.zu-sc-col[data-i="' + idx + '"],.zu-hm-cell[data-i="' + idx + '"]');
            if (nu2 && nu2.focus) nu2.focus();
          }
        }
        spdHoverPortalSync(tip, idx);   /* v281：Portal 卡渲染+定位（idx=-1 即收起） */
      }
    }
    tip.addEventListener("mouseover", function (e) {
      var col = e.target && e.target.closest && e.target.closest(".zu-sc-col,.zu-hm-cell");
      if (col) zuSpeedChartPick(parseInt(col.getAttribute("data-i"), 10) || 0);
      var lb = e.target && e.target.closest && e.target.closest(".zu-sv-legend-btn");
      if (lb) spdLegendTipShow(lb);   /* v282：问号 hover 即显档位说明 */
    });
    /* v290 图表区滚轮横滚（2026-11-08 用户规格）：wheel 委托在 tip 本体（随 tip.remove()
     * 消亡，非全局监听）——指针在 .zu-sc-wrap 上且确可横滚时 deltaY 换算 scrollLeft，
     * preventDefault 阻止页面竖滚；不可横滚不拦截，默认行为照旧。 */
    tip.addEventListener("wheel", function (e) {
      var wrap = e.target && e.target.closest && e.target.closest(".zu-sc-wrap");
      if (!wrap || wrap.scrollWidth <= wrap.clientWidth + 1) return;
      var d = (e.deltaY || 0) + (e.deltaX || 0);
      if (!d) return;
      wrap.scrollLeft += d;
      e.preventDefault();
    }, { passive: false });
    tip.addEventListener("mouseout", function (e) {
      var to = e.relatedTarget;
      var lb = e.target && e.target.closest && e.target.closest(".zu-sv-legend-btn");
      if (lb) {   /* v282：icon→卡保活；icon→柱体由 Portal show 侧互斥立即收 */
        if (!(to && to.closest && (to.closest(".zu-sv-legend-btn") || to.closest(".zu-sv-legend-tip"))))
          spdLegendTipScheduleHide();
        return;
      }
      var col = e.target && e.target.closest && e.target.closest(".zu-sc-col,.zu-hm-cell");
      if (!col) return;
      /* v242:移入另一根柱时同样交给 mouseover 切段,避免 out(-1)→in(B) 双重整卡重建闪烁 */
      if (to && to.closest && to.closest(".zu-sc-col,.zu-hm-cell")) return;
      zuSpeedChartPick(-1);
    });
    tip.addEventListener("focusin", function (e) {
      var col = e.target && e.target.closest && e.target.closest(".zu-sc-col,.zu-hm-cell");
      if (col) zuSpeedChartPick(parseInt(col.getAttribute("data-i"), 10) || 0);
      var lb = e.target && e.target.closest && e.target.closest(".zu-sv-legend-btn");
      if (lb) spdLegendTipShow(lb);   /* v282：键盘聚焦问号同样显示 */
    });
    tip.addEventListener("focusout", function (e) {
      var col = e.target && e.target.closest && e.target.closest(".zu-sc-col,.zu-hm-cell");
      /* v242:relatedTarget 落在另一根柱上时不得收卡重建——focusout 先于 focusin,
       * 此处重建会销毁即将接收焦点的目标柱(焦点跌落 body、Tab 序断裂) */
      if (col && !(e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest(".zu-sc-col,.zu-hm-cell"))) zuSpeedChartPick(-1);
      var lb = e.target && e.target.closest && e.target.closest(".zu-sv-legend-btn");
      if (lb && !(e.relatedTarget && e.relatedTarget.closest && (e.relatedTarget.closest(".zu-sv-legend-btn") || e.relatedTarget.closest(".zu-sv-legend-tip"))))
        spdLegendTipScheduleHide();
    });


    bar.appendChild(style);           // 样式随条走，不进 head（防清理）
    /* 内联兜底：即使样式表意外失效，定位行为也不退化。
     * z-index 50：压得过聊天列表/输入框外层容器（Tailwind z-20），又不盖权限菜单等弹层（实测值）。 */
    bar.style.position = "fixed";
    bar.style.zIndex = "50";
    document.body.appendChild(bar);

    /* ---------- 超限告警气泡（v39）：当前会话"上下文超限被拒"时自动弹出，随条定位 ---------- */
    var excBubble = document.createElement("div");
    excBubble.className = "zusage-exc";
    /* 文案只进 textContent/静态 innerHTML；会话 ID 是动态数据，一律走 textContent 防注入。
     * 面板语言切换时 rebuildExcBubble() 重建气泡文案。 */
    var excSid, excCopied;
    function rebuildExcBubble() {
      if (excCopied) clearTimeout(excCopied.timer);
      excBubble.innerHTML =
      '<div class="xb-head"><span class="xb-title">' + L("⚠ 上下文超限", "⚠ Context over limit") + '</span>' +
      '<span class="xb-close" aria-label="' + L("关闭，本次不再提醒", "Close; do not remind again this session") + '">✕</span></div>' +
      '<div class="xb-step">' + L("最近一次请求因超出上下文窗口容量被拒绝，本轮对话暂时无法继续。建议依次尝试：",
        "The latest request was rejected for exceeding the context window; this turn cannot continue for now. Try these in order:") + '</div>' +
      '<div class="xb-step">' + L("① 回滚上一轮对话，去掉超限的那次请求后继续；",
        "① Roll back the previous turn, drop the over-limit request and continue;") + '</div>' +
      '<div class="xb-step">' + L("② 换用上下文窗口更大的模型继续，或压缩 / 精简本会话；",
        "② Continue with a larger-window model, or compress / trim this session;") + '</div>' +
      '<div class="xb-step">' + L("③ 仍无法解决时，新开一个对话，把下面的会话 ID（必要时连同工作区路径）发给它，让新会话读取本会话的记录文件接手修复。",
        "③ If that still fails, start a new conversation and send it the session ID below (workspace path if needed) — the new session can pick up this session's rollout files to take over.") + '</div>' +
      '<div>' + L("会话 ID：", "Session ID: ") + '<span class="xb-sid"></span><span class="xb-copied">' + L("已复制", "Copied") + '</span></div>';
      excSid = excBubble.querySelector(".xb-sid");
      excCopied = excBubble.querySelector(".xb-copied");
      excSid.addEventListener("click", onExcSidCopy);
      excBubble.querySelector(".xb-close").addEventListener("click", onExcClose);
    }
    function onExcSidCopy() {
      if (inactive() || !excSid.textContent) return;
      try {
        var ta = document.createElement("textarea");
        ta.value = excSid.textContent;
        ta.style.cssText = "position:fixed;left:-9999px;top:0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      } catch (e) { }
      excCopied.style.display = "inline";
      clearTimeout(excCopied.timer);
      excCopied.timer = setTimeout(function () { excCopied.style.display = "none"; }, 1500);
    }
    function onExcClose() {
      if (inactive()) return;
      excGone = true;
      syncExcBubble();
    }
    rebuildExcBubble();
    document.body.appendChild(excBubble);

    /* ---------- 主题跟随（v58）：深浅由客户端根元素 .dark 类驱动 ----------
     * 客户端主题切换时往 <html> 挂/摘 .dark（zai-dark 时挂；theme-zai-* 同步），整套
     * CSS 变量（--color-background/foreground/border/hover/card/destructive/brand/
     * terminal-* …）随级联翻转，上面的配色自动换装 —— 本块只负责观察 .dark 摘挂，
     * 同步 .zu-light（仅剩阴影/光晕程度性覆盖）。观察类属性而非 matchMedia：
     * 信号源与变量翻转同源，客户端强制浅色+系统深色等错位态不会劈叉。 */
    var rootEl = document.documentElement;
    function themeIsDark() {
      try { return rootEl.classList.contains("dark"); } catch (e) { return true; }
    }
    var themeDark = themeIsDark();
    function applyTheme() {
      bar.classList.toggle("zu-light", !themeDark);
      tip.classList.toggle("zu-light", !themeDark);
      excBubble.classList.toggle("zu-light", !themeDark);
      /* v80：面板挂 body 后不在 bar 的 zu-light 作用域内，自带类（.panel.zu-light） */
      panel.classList.toggle("zu-light", !themeDark);
      subPanel.classList.toggle("zu-light", !themeDark);
      if (mpModalThemeSync) mpModalThemeSync(!themeDark);   // v132：模型拉取弹窗随主题实时换装
    }
    try {
      themeObserver = new MutationObserver(function () {
        var d = themeIsDark();
        if (d !== themeDark) { themeDark = d; applyTheme(); }
        queuePillSurface();
      });
      themeObserver.observe(rootEl, { attributes: true, attributeFilter: ["class", "style"] });
    } catch (e) { }
    applyTheme();

    var $ = function (id) { return bar.querySelector(id); };
    var main = bar.querySelector(".zu-main"), gear = bar.querySelector(".zu-gear");
    /* v172 跨窗口红点收敛：其它窗口 ack 写 zusage3.updSeen 后本实例重算（storage 只在其它窗口触发；
       实例级注册，随 disposeOverlay 的 globalListeners 统一清理） */
    listenGlobal(window, "storage", function (e) {
      if (!e || e.key !== LS.updSeen) return;
      instances.forEach(function (inst) { try { inst.syncUpdate(); } catch (e) { } });
    });

