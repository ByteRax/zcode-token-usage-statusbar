/* Shared sample frames for the README covers and feature close-ups. */
const promoLabels = Object.fromEntries(Object.entries({
  speed: ["生成速度", "Speed"], turn: ["本轮用量", "This turn"],
  win: ["会话累计", "Session total"], today: ["今日合计", "Today"],
  proj: ["项目累计", "Project total"], tools: ["工具调用", "Tools"],
  sub: ["子智能体", "Subagents"], sysmon: ["系统状态", "System"],
}).map(([key, labels]) => [key, labels[document.documentElement.lang === "en" ? 1 : 0]]));

function promoData(session, payload, now) {
  const english = document.documentElement.lang === "en";
  const provider = "account:bigmodel-individual-coding-plan";
  session.last.provider_id = provider;
  session.avg_tps = 97.5;
  session.cost_usd = 6.32;
  session.last_turn.cost_usd = 6.05;
  session.project = {
    name: "zcode-token-usage-statusbar", sessions: 1613, requests: 87600,
    total: 16979000000, input: 16894000000, output: 85450500, cache_read: 16363000000,
    cost_usd: 2580.6,
  };
  payload.fx = { rate: 7.21, currency: "CNY" };
  payload.remote_evidence = false;
  payload.provider_fallback = provider;
  payload.speed_history = {
    sid: session.sid, sids: [session.sid], snames: [session.title],
    pids: [["zcode-token-usage-statusbar", "zcode-token-usage-statusbar"]],
    mnames: ["GLM-5.3-FlashX", "GLM-5.4", "GLM-5.3", "claude-sonnet-5-5"],
    mkeys: [
      provider + "\u001fGLM-5.3-FlashX", provider + "\u001fGLM-5.4",
      provider + "\u001fGLM-5.3", "custom:claude\u001fclaude-sonnet-5-5",
    ],
    turns: [139, 98, 79, 142, 103, 81, 95, 138, 84, 97, 112, 98].map((speed, i) => {
      const t = now - (12 - i) * 300000;
      const out = speed * 12;
      const m = i % 4;
      return { s: 0, t: i ? 300000 : t, b: t - 12000, out, ms: 12000,
        i: out * 45, o: out, n: 6, msl: [[m, out, 12000, 6]], c: 0.38, cf: 1 };
    }),
  };
  payload.quota = {
    status: "ok", fetchedAt: now,
    windows: { fiveHour: { percent: 18, resetsAt: now + 3600000 }, weekly: { percent: 42, resetsAt: now + 86400000 } },
    resets: { bigmodel: { fiveHour: [{ expireAt: now + 22216000 }, { expireAt: now + 22216000 }], week: [] } },
  };
  window.__zusagePluginState = { quotaEnabled: true };
  const sys = {
    v: 1, ts: now,
    cpu: { state: "ok", pct: 24, cores: 14, load: [7.77, 7.02, 8.09] },
    mem: { state: "ok", total: 51539607552, used: 33608117452, avail: 17931490100, pct: 65 },
    disk: { state: "ok", vols: [
      { id: "/", name: "Macintosh HD", mount: "/", role: "system", total: 994662584320, used: 740881960960, avail: 253780623360, free_pct: 25.5 },
    ] },
  };
  const git = { ok: true, branch: "main", ahead: 1, behind: 0, ins: 380, del: 453, untracked: 7, staged: 0, unstaged: 6, ts: now };
  return function feed() {
    if (!window.__zusageUpdate) return;
    window.__zusageUpdate(payload);
    window.__zusageSysmon(sys);
    window.__zusageGitState("/demo/zcode-token-usage-statusbar", git);
  };
}
