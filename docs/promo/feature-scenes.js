/* Host fixtures for features that augment a native ZCode surface. The current
 * overlay adds the controls, badges and tooltips to these sample elements. */
function featureScene(name, usage) {
  const english = document.documentElement.lang === "en";
  const l = (zh, en) => english ? en : zh;
  const pane = document.querySelector(".pm-col");
  const add = (html, parent = pane) => {
    parent.insertAdjacentHTML("beforeend", html);
    return parent.lastElementChild;
  };
  if (name === "peak-factor") {
    const provider = "account:bigmodel-individual-coding-plan";
    const factors = [["GLM-5.4", 0.67, 2], ["GLM-5.3", 1, 3], ["GLM-5.3-Flash", 0.4, 1.2]];
    PAYLOAD.peak = { glm_plan: { factors, is_peak: false } };
    add(`<div class="demo-host" data-model-provider-key="${provider}">
      <strong>GLM Coding Plan</strong>
      ${factors.map(([model]) => `<div class="demo-row" data-testid="chat-model-select-item-${provider}/${model}"><span class="flex-1">${model}</span></div>`).join("")}</div>`);
  }
  if (name === "model-pull") {
    add(`<div class="demo-host"><div class="demo-row">
      <span data-testid="model-provider-nav-item-custom:demo" data-state="selected">${l("自定义供应商", "Custom provider")}</span>
      <button data-testid="model-provider-add-model-button">${l("添加模型", "Add model")}</button></div></div>`);
    const provider = { id: "demo", name: l("示例供应商", "Example provider"), baseUrl: "https://example.com/v1", modelIds: ["glm-5.4"] };
    const results = {
      "model-pull-list": { providers: [provider] },
      "model-pull-fetch": { models: ["glm-5.4", "glm-5.3-flash"], metaById: {
        "glm-5.4": { contextWindow: 200000, maxOutput: 32768, reasoningEfforts: ["high", "max"] },
      } },
      "model-pull-probe": {},
    };
    setInterval(() => {
      for (const req of window.__zusagePluginRequests.splice(0)) {
        if (results[req.action]) window.__zusagePluginResult({ id: req.requestId, ok: true, ...results[req.action] });
      }
    }, 40);
  }
  if (name === "project-folder") {
    window.zcode = { openInFileManager() {} };
    const project = add(`<div class="demo-host" data-project-host="local">
      <div class="demo-row" data-testid="virtual-project-row"><strong>zcode-token-usage-statusbar</strong><button id="demo-project-menu">⋯</button></div>
      <div role="menu" data-radix-menu-content aria-labelledby="demo-project-menu">
        <div class="demo-row" role="menuitem" data-testid="virtual-project-edit"><span>${l("编辑项目", "Edit project")}</span></div>
        <div class="demo-row" role="menuitem" data-testid="virtual-project-worktrees"><span>Worktrees</span></div>
      </div></div>`, document.body);
    project.querySelector("[data-testid=virtual-project-row]").__reactFiber$demo = {
      memoizedProps: { project: { roots: [{ rootPath: "/demo/zcode-token-usage-statusbar" }] } },
    };
  }
  if (name === "search") {
    add(`<div class="demo-host demo-search" data-slot="dialog-content"><div data-slot="command" cmdk-root>
      <strong>${l("命令中心", "Command center")}</strong>
      <div class="demo-row demo-query">${l("搜索文件、任务或命令…", "Search files, tasks or commands…")}</div>
      <div cmdk-list><div class="demo-row">src/overlay/04-speed-v3-charts.js · 生成速度 V3 日历与趋势图表渲染</div>
      <div class="demo-row">src/overlay/11-instance-toolbar-chips.js · 上下文构成明细、压缩与额度徽标</div></div></div></div>`);
  }
  if (name === "ssh") {
    pane.dataset.zusageWorkspaceIdentity = "remote:ssh:demo";
    pane.dataset.zusageRemoteSessionId = SESS.sid;
    Object.assign(SESS, { remote: true, remote_host: "build.zcode.dev", workspace_identity: "remote:ssh:demo", remote_target: "demo" });
    PAYLOAD.scope_bindings = { "workspace-main": "remote:ssh:demo" };
    PAYLOAD.remote_today = PAYLOAD.today;
  }
  if (name === "usage-query") {
    const output = add('<div class="demo-host demo-terminal"><code></code><pre></pre></div>');
    output.querySelector("code").textContent = "$ python3 zusage.py today";
    output.querySelector("pre").textContent = usage;
  }
  if (name === "prompt-enhance") {
    pane.querySelector("textarea").value = l(
      "深度分析这周一到周五的所有会话，找出任务耗时特别长的原因",
      "Analyze all sessions from Monday to Friday and identify why tasks took unusually long"
    );
    const records = [
      {
        id: "eh_1", source: "chat", providerName: "account:bigmodel-individual-coding-plan", modelId: "GLM-5.4",
        originalText: l("请你深度分析并扫描这周一到周五的所有会话，分析为什么任务都变得耗时特别长", "Scan all sessions from Monday to Friday and analyze why tasks took unusually long"),
        enhancedText: l("请你深度分析并扫描这周一到周五的所有会话记录，找出任务耗时特别长的原因。请逐条分析每个耗时异常的会话，归纳共性问题（如上下文过大、工具重试等）。", "Scan all session records from Mon–Fri to identify why tasks took unusually long. Analyze outlier sessions and summarize root causes (e.g., large context, tool retries)."),
        usage: { totalTokens: 91 }, createdAt: new Date(NOW - 3600000).toISOString(), durationMs: 4800,
      },
      {
        id: "eh_2", source: "chat", providerName: "account:bigmodel-individual-coding-plan", modelId: "GLM-5.4",
        originalText: l("会话累计 tooltips 标题后面的项目名称超长时会导致样式错乱，请检查修复", "Long project names in Session Total tooltip headers break layout; please inspect and fix"),
        enhancedText: l("修复「会话累计」tooltips 的样式问题：当标题后面的项目名称超长时，tooltip 布局出现错乱。请定位相关组件与样式代码并补齐回归测试。", "Fix the Session Total tooltip layout when the project name in the header is very long. Locate the header styles, add truncation/wrapping, and add regression tests."),
        usage: { totalTokens: 215 }, createdAt: new Date(NOW - 7200000).toISOString(), durationMs: 4000,
      },
    ];
    setInterval(() => {
      for (const req of (window.__zusagePluginRequests || []).splice(0)) {
        if (req.action === "enhance-history-list") {
          window.__zusagePluginResult({ id: req.requestId, ok: true, total: 2, records });
        }
      }
    }, 30);
  }
  feed();
}
