const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const M = require(path.join(__dirname, "..", "model-puller.cjs"));

/* v344 增强提示词：model-puller.cjs enhanceText 的协议拼装/响应解包/fail-closed 行为。
 * 夹具沿用 model-puller.test.cjs 的 stub fetch + 临时 provider_config.json 形状；
 * enhanceText 读响应体走 res.text()（probe 走 dropBody），stub 同时给 text()。 */

const MODELS_DEV_TEST_URL = "https://models.dev.test/json";
const PLAN_ID = "account:bigmodel-individual-coding-plan";

function tmpCfgPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "zusage-enh-")), "provider_config.json");
}

function sampleCfg() {
  return {
    config: {
      providerConfigRules: {
        providerRules: [
          {
            providerId: "custom-relay",
            providerName: "我的中转",
            config: {
              access: { type: "api-key", apiKey: "sk-secret-1" },
              api: { baseUrl: "https://relay.example.com", type: "openai-chat-completions" },
            },
          },
          {
            providerId: "anthropic-relay",
            providerName: "anthropic 型中转",
            config: {
              access: { type: "api-key", apiKey: "sk-ant-1" },
              api: { baseUrl: "https://ant.example.com", type: "anthropic-messages" },
            },
          },
          {
            providerId: "responses-relay",
            providerName: "responses 型中转",
            config: {
              access: { type: "api-key", apiKey: "sk-resp-1" },
              api: { baseUrl: "https://resp.example.com", type: "openai-responses" },
            },
          },
          {
            providerId: "odd-relay",
            providerName: "未知协议",
            config: {
              access: { type: "api-key", apiKey: "sk-odd" },
              api: { baseUrl: "https://odd.example.com", type: "weird-protocol" },
            },
          },
        ],
      },
    },
  };
}

function sseRes(events) {
  if (!events.some(e => e.includes('"type":"message_start"'))) events.unshift('data: {"type":"message_start"}\n\n');
  if (!events.some(e => e.includes('"type":"content_block_start"'))) events.splice(1, 0, 'data: {"type":"content_block_start","index":0}\n\n');
  events = events.map(e => e.replace('"type":"content_block_delta","delta"', '"type":"content_block_delta","index":0,"delta"'));
  const stop = events.findIndex(e => e.includes('"type":"message_delta"'));
  if (stop >= 0) events.splice(stop, 0, 'data: {"type":"content_block_stop","index":0}\n\n');
  const enc = new TextEncoder();
  let i = 0;
  return {
    ok: true, status: 200,
    body: { getReader() { return { read: async () => (i < events.length ? { done: false, value: enc.encode(events[i++]) } : { done: true }) }; } },
  };
}

function createEnhancer(file, routes, opts) {
  const calls = [];
  const impl = async (url, requestOpts) => {
    if (url === MODELS_DEV_TEST_URL) return { ok: false, status: 503, body: { cancel() { } } };
    calls.push({ url, opts: requestOpts });
    const hit = routes.find((r) => r.url === url);
    if (!hit) throw new Error("unexpected url " + url);
    if (hit.status) return { ok: false, status: hit.status, text: async () => hit.body || "" };
    return { ok: true, status: 200, text: async () => JSON.stringify(hit.body) };
  };
  const mp = M.createModelPuller({
    customCfgPath: file, fetchImpl: impl, modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "",
    ...opts,
  });
  return { mp, calls };
}

test("enhanceUserContent wraps draft in user_draft delimiters", () => {
  const wrapped = M.enhanceUserContent("帮我写个脚本");
  assert.match(wrapped, /User draft \(JSON string\):\n"帮我写个脚本"/);
  assert.match(M.enhanceUnwrapText({ choices: [{ finish_reason: "stop", message: { content: " x " } }] }), /^x$/);
  assert.equal(M.enhanceUnwrapText({ choices: [{ finish_reason: "stop", message: { reasoning_content: "思考" } }] }), "");
  assert.equal(M.enhanceUnwrapText({ output_text: "out" }), "out");
  assert.equal(M.enhanceUnwrapText({ output: [{ content: [{ type: "output_text", text: "resp" }] }] }), "resp");
  assert.equal(M.enhanceUnwrapText({ content: [{ type: "text", text: "ant" }] }), "ant");
  assert.equal(M.stripEnhanceFences("```text\nenhanced\n```"), "enhanced");
  assert.equal(M.stripEnhanceFences("保持原样\n```js\ncode()\n```"), "保持原样\n```js\ncode()\n```");
});

test("openai chat-completions: url/headers/body shape and content unwrap", async () => {
  const file = tmpCfgPath();
  fs.writeFileSync(file, JSON.stringify(sampleCfg()));
  const { mp, calls } = createEnhancer(file, [
    { url: "https://relay.example.com/chat/completions", body: { choices: [{ finish_reason: "stop", message: { content: "更清晰的提示词" } }] } },
  ]);
  const r = await mp.enhanceText("custom-relay", "gpt-4o", "写个脚本");
  assert.equal(r.ok, true);
  assert.equal(r.text, "更清晰的提示词");
  assert.equal(r.model, "gpt-4o");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://relay.example.com/chat/completions");
  assert.equal(calls[0].opts.headers.Authorization, "Bearer sk-secret-1");
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.model, "gpt-4o");
  assert.equal(body.stream, false);
  assert.ok(body.max_tokens >= 1024 && body.max_tokens <= 4096, "max_tokens out of sane range: " + body.max_tokens);
  assert.equal(body.messages[0].role, "system");
  assert.match(body.messages[0].content, /Prompt Engineering Expert/);
  assert.match(body.messages[1].content, /User draft \(JSON string\):\n"写个脚本"/);
});

test("anthropic-messages: /v1/messages path, top-level system, dual auth headers", async () => {
  const file = tmpCfgPath();
  fs.writeFileSync(file, JSON.stringify(sampleCfg()));
  const sse = sseRes([
    'event: message_start\ndata: {"type":"message_start"}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"润色"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"结果"}}\n\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ]);
  const seen = [];
  const impl = async (url, requestOpts) => {
    if (url === MODELS_DEV_TEST_URL) return { ok: false, status: 503, body: { cancel() { } } };
    seen.push({ url, headers: requestOpts.headers, body: JSON.parse(requestOpts.body) });
    return url.indexOf("/v1/messages") > 0 ? sse : null;
  };
  const mp = M.createModelPuller({ customCfgPath: file, fetchImpl: impl, modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "" });
  const r = await mp.enhanceText("anthropic-relay", "glm-4.6", "写个脚本");
  assert.equal(r.ok, true);
  assert.equal(r.text, "润色结果");
  assert.equal(seen[0].url, "https://ant.example.com/v1/messages");
  assert.equal(seen[0].headers["x-api-key"], "sk-ant-1");
  assert.equal(seen[0].headers["anthropic-version"], "2023-06-01");
  assert.equal(seen[0].body.stream, true);
  assert.match(seen[0].body.system, /Prompt Engineering Expert/);
  assert.equal(seen[0].body.messages.length, 1);
  assert.equal(seen[0].body.messages[0].role, "user");
});

test("openai responses: /responses with message-shaped input", async () => {
  const file = tmpCfgPath();
  fs.writeFileSync(file, JSON.stringify(sampleCfg()));
  const { mp, calls } = createEnhancer(file, [
    { url: "https://resp.example.com/responses", body: { status: "completed", output_text: "resp 结果" } },
  ]);
  const r = await mp.enhanceText("responses-relay", "gpt-4o", "写个脚本");
  assert.equal(r.ok, true);
  assert.equal(r.text, "resp 结果");
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(Array.isArray(body.input), true);
  assert.equal(body.input[0].role, "system");
});

test("plan source uses anthropic endpoint + decrypted oauth token", async () => {
  const file = tmpCfgPath();
  fs.writeFileSync(file, JSON.stringify({
    config: { providerConfigRules: { providerRules: [{ providerId: PLAN_ID, config: { personalModelIds: ["GLM-5.3-FlashX"] } }] } },
  }));
  const creds = path.join(path.dirname(file), "credentials.json");
  fs.writeFileSync(creds, JSON.stringify({ "oauth:bigmodel:access_token": "enc:xxx" }));
  // 宿主同款 v2 config（builtin provider options.apiKey 明文）优先于 OAuth token
  const cfg = path.join(path.dirname(file), "config.json");
  fs.writeFileSync(cfg, JSON.stringify({ provider: { "builtin:bigmodel-coding-plan": { name: "BigModel - Coding Plan", kind: "anthropic", options: { apiKey: "v2-key-1", baseURL: "https://open.bigmodel.cn/api/anthropic" }, enabled: true } } }));
  const seen = [];
  const impl = async (url, requestOpts) => {
    if (url === MODELS_DEV_TEST_URL) return { ok: false, status: 503, body: { cancel() { } } };
    if (url === "https://open.bigmodel.cn/api/anthropic/v1/messages") {
      seen.push({ headers: requestOpts.headers, body: JSON.parse(requestOpts.body) });
      return sseRes(['event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"套餐增强"}}\n\n', 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n', 'event: message_stop\ndata: {"type":"message_stop"}\n\n']);
    }
    throw new Error("unexpected url " + url);
  };
  const mp = M.createModelPuller({ customCfgPath: file, fetchImpl: impl, modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "", credentialsPath: creds, decryptValue: () => "plan-oauth-token" });
  const r = await mp.enhanceText(PLAN_ID, "GLM-5.3-FlashX", "写个脚本");
  assert.equal(r.ok, true);
  assert.equal(r.text, "套餐增强");
  assert.equal(seen[0].headers.Authorization, "Bearer v2-key-1");   // 宿主同款 key 优先
  assert.equal(seen[0].headers["x-api-key"], "v2-key-1");
  assert.ok(seen[0].body.max_tokens >= 1024 && seen[0].body.max_tokens <= 4096, "max_tokens out of sane range");
  assert.equal(seen[0].body.stream, true);
  assert.equal(seen[0].body.messages[0].role, "user");   // anthropic 路径 user 消息（system 在顶层）

  // 无 v2 config 时回退 OAuth token
  fs.rmSync(cfg);
  const seen2 = [];
  const impl2 = async (url, requestOpts) => {
    if (url === MODELS_DEV_TEST_URL) return { ok: false, status: 503, body: { cancel() { } } };
    if (url === "https://open.bigmodel.cn/api/anthropic/v1/messages") {
      seen2.push({ headers: requestOpts.headers });
      return sseRes(['event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"套餐增强"}}\n\n', 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n', 'data: {"type":"message_stop"}\n\n']);
    }
    throw new Error("unexpected url " + url);
  };
  const mp2 = M.createModelPuller({ customCfgPath: file, fetchImpl: impl2, modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "", credentialsPath: creds, decryptValue: () => "plan-oauth-token" });
  const r2 = await mp2.enhanceText(PLAN_ID, "GLM-5.3-FlashX", "写个脚本");
  assert.equal(r2.ok, true);
  assert.equal(seen2[0].headers.Authorization, "Bearer plan-oauth-token");   // OAuth 兜底
});

test("planKeyOf: enc: v2 config key never leaves as plaintext; falls back to oauth or auth (issue #336 review)", async () => {
  const file = tmpCfgPath();
  fs.writeFileSync(file, JSON.stringify({
    config: { providerConfigRules: { providerRules: [{ providerId: PLAN_ID, config: { personalModelIds: ["GLM-5.3-FlashX"] } }] } },
  }));
  const creds = path.join(path.dirname(file), "credentials.json");
  fs.writeFileSync(creds, JSON.stringify({ "oauth:bigmodel:access_token": "enc:bm" }));
  fs.writeFileSync(path.join(path.dirname(file), "config.json"), JSON.stringify({ provider: {
    "builtin:bigmodel-coding-plan": { options: { apiKey: "enc:v2:env:aa:bb.cc" } },   // 密文形态（宿主未解密直写）
  } }));
  const seen = [];
  const capturing = async (url, requestOpts) => {
    if (url === MODELS_DEV_TEST_URL) return { ok: false, status: 503, body: { cancel() { } } };
    seen.push({ url, headers: requestOpts.headers });
    return sseRes(['data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n', 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n', 'data: {"type":"message_stop"}\n\n']);
  };
  // enc: 密文不作明文 key → 回退 credentials.json OAuth 明文
  const mp = M.createModelPuller({ customCfgPath: file, fetchImpl: capturing, modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "", credentialsPath: creds, decryptValue: () => "plan-oauth-token" });
  const r = await mp.enhanceText(PLAN_ID, "GLM-5.3-FlashX", "草稿");
  assert.equal(r.ok, true);
  assert.equal(seen[0].headers.Authorization, "Bearer plan-oauth-token");
  assert.doesNotMatch(seen[0].headers.Authorization, /enc:/);
  // OAuth 也解不出 → auth fail-closed 且零网络
  seen.length = 0;
  const mp2 = M.createModelPuller({ customCfgPath: file, fetchImpl: capturing, modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "", credentialsPath: creds, decryptValue: () => null });
  const r2 = await mp2.enhanceText(PLAN_ID, "GLM-5.3-FlashX", "草稿");
  assert.equal(r2.ok, false);
  assert.equal(r2.kind, "auth");
  assert.equal(seen.length, 0, "no network without a usable credential");
});
test("fail-closed: http errors classified without exposing response body", async () => {
  const file = tmpCfgPath();
  fs.writeFileSync(file, JSON.stringify(sampleCfg()));
  const { mp } = createEnhancer(file, [
    { url: "https://relay.example.com/chat/completions", status: 401, body: "unauthorized sk-secret-1 echo" },
  ]);
  const r = await mp.enhanceText("custom-relay", "gpt-4o", "写个脚本");
  assert.equal(r.ok, false);
  assert.equal(r.kind, "auth");
  assert.equal(r.status, 401);
  assert.equal(r.snippet, undefined);
});

test("fail-closed: missing key, unknown protocol, provider not found, empty draft", async () => {
  const file = tmpCfgPath();
  fs.writeFileSync(file, JSON.stringify(sampleCfg()));
  const { mp } = createEnhancer(file, []);
  const noKey = await mp.enhanceText("no-base", "m", "写个脚本");
  assert.equal(noKey.ok, false);
  assert.equal(noKey.kind, "provider");
  const odd = await mp.enhanceText("odd-relay", "m", "写个脚本");
  assert.equal(odd.ok, false);
  assert.equal(odd.kind, "unsupported");
  const missing = await mp.enhanceText("ghost-provider", "m", "写个脚本");
  assert.equal(missing.ok, false);
  assert.equal(missing.kind, "provider");
  const empty = await mp.enhanceText("custom-relay", "gpt-4o", "   ");
  assert.equal(empty.ok, false);
  assert.equal(empty.kind, "invalid_input");
  const badModel = await mp.enhanceText("custom-relay", "", "写个脚本");
  assert.equal(badModel.ok, false);
  assert.equal(badModel.kind, "invalid_model");
});

test("fail-closed: invalid json and empty completion", async () => {
  const file = tmpCfgPath();
  fs.writeFileSync(file, JSON.stringify(sampleCfg()));
  const broken = async (url, requestOpts) => {
    if (url === MODELS_DEV_TEST_URL) return { ok: false, status: 503, body: { cancel() { } } };
    return { ok: true, status: 200, text: async () => "not-json" };
  };
  const mp1 = M.createModelPuller({ customCfgPath: file, fetchImpl: broken, modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "" });
  const bad = await mp1.enhanceText("custom-relay", "gpt-4o", "写个脚本");
  assert.equal(bad.ok, false);
  assert.equal(bad.kind, "parse");
  const { mp } = createEnhancer(file, [
    { url: "https://relay.example.com/chat/completions", body: { choices: [{ finish_reason: "stop", message: { content: "" } }] } },
  ]);
  const empty = await mp.enhanceText("custom-relay", "gpt-4o", "写个脚本");
  assert.equal(empty.ok, false);
  assert.equal(empty.kind, "empty");
});

test("reasoning-only model does not expose reasoning as a completion", async () => {
  const file = tmpCfgPath();
  fs.writeFileSync(file, JSON.stringify(sampleCfg()));
  const { mp } = createEnhancer(file, [
    { url: "https://relay.example.com/chat/completions", body: { choices: [{ finish_reason: "stop", message: { content: "", reasoning_content: "```text\n思考后的结果\n```" } }] } },
  ]);
  const r = await mp.enhanceText("custom-relay", "gpt-4o", "写个脚本");
  assert.equal(r.ok, false);
  assert.equal(r.kind, "empty");
});

test("response body abort returns cancelled instead of parse error", async () => {
  const file = tmpCfgPath();
  fs.writeFileSync(file, JSON.stringify(sampleCfg()));
  let ready;
  const reading = new Promise((resolve) => { ready = resolve; });
  let calls = 0;
  const impl = async (url, opts) => {
    calls++;
    return { ok: true, status: 200, text: () => new Promise((resolve, reject) => {
      ready();
      opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    }) };
  };
  const mp = M.createModelPuller({ customCfgPath: file, fetchImpl: impl, modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "" });
  const ctl = new AbortController();
  const pending = mp.enhanceText("custom-relay", "gpt-4o", "草稿", { signal: ctl.signal });
  await reading;
  ctl.abort();
  const result = await pending;
  assert.equal(result.kind, "cancelled");
  assert.equal(calls, 1);
});

test("SSE reader failure retries without returning partial output", async () => {
  const file = tmpCfgPath();
  fs.writeFileSync(file, JSON.stringify(sampleCfg()));
  let calls = 0;
  const impl = async () => {
    calls++;
    if (calls === 1) {
      let read = 0;
      return { ok: true, body: { getReader: () => ({ read: async () => {
        if (read++) throw new Error("connection reset");
        return { done: false, value: new TextEncoder().encode('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n') };
      } }) } };
    }
    return sseRes(['data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"complete"}}\n\n', 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n', 'data: {"type":"message_stop"}\n\n']);
  };
  const mp = M.createModelPuller({ customCfgPath: file, fetchImpl: impl, modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "" });
  const result = await mp.enhanceText("anthropic-relay", "m", "草稿");
  assert.equal(result.text, "complete");
  assert.equal(calls, 2);
});

test("5xx transient failure retries once and succeeds", async () => {
  const file = tmpCfgPath();
  fs.writeFileSync(file, JSON.stringify(sampleCfg()));
  const attempts = [];
  const flaky = async (url, requestOpts) => {
    if (url === MODELS_DEV_TEST_URL) return { ok: false, status: 503, body: { cancel() { } } };
    if (url.indexOf("/chat/completions") > 0) {
      attempts.push(url);
      if (attempts.length === 1) return { ok: false, status: 500, text: async () => '{"error":{"message":"网络错误，请稍后重试"}}' };
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "重试成功" } }] }) };
    }
    throw new Error("unexpected url " + url);
  };
  const mp = M.createModelPuller({ customCfgPath: file, fetchImpl: flaky, modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "" });
  const r = await mp.enhanceText("custom-relay", "gpt-4o", "写个脚本");
  assert.equal(r.ok, true);
  assert.equal(r.text, "重试成功");
  assert.equal(attempts.length, 2);
});

test("4xx auth failure does not retry", async () => {
  const file = tmpCfgPath();
  fs.writeFileSync(file, JSON.stringify(sampleCfg()));
  let calls = 0;
  const unauthorized = async (url) => {
    if (url === MODELS_DEV_TEST_URL) return { ok: false, status: 503, body: { cancel() { } } };
    if (url.indexOf("/chat/completions") > 0) { calls++; return { ok: false, status: 401, text: async () => "unauthorized" }; }
    throw new Error("unexpected url " + url);
  };
  const mp = M.createModelPuller({ customCfgPath: file, fetchImpl: unauthorized, modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "" });
  const r = await mp.enhanceText("custom-relay", "gpt-4o", "写个脚本");
  assert.equal(r.ok, false);
  assert.equal(r.kind, "auth");
  assert.equal(calls, 1);
});

test("external signal abort cancels in-flight request without retry", async () => {
  const file = tmpCfgPath();
  fs.writeFileSync(file, JSON.stringify(sampleCfg()));
  let calls = 0;
  const impl = async (url, requestOpts) => {
    if (url === MODELS_DEV_TEST_URL) return { ok: false, status: 503, body: { cancel() { } } };
    calls++;
    await new Promise((resolve, reject) => {   // 挂起直到 signal abort（真实 fetch 的 abort 行为）
      const sig = requestOpts.signal;
      if (sig.aborted) return reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
      sig.addEventListener("abort", () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" })), { once: true });
    });
    throw Object.assign(new Error("unreachable"), { name: "AbortError" });
  };
  const mp = M.createModelPuller({ customCfgPath: file, fetchImpl: impl, modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "" });
  const ctl = new AbortController();
  const p1 = mp.enhanceText("custom-relay", "gpt-4o", "写个脚本", { signal: ctl.signal });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls, 1);
  ctl.abort();
  const r = await p1;
  assert.equal(r.ok, false);
  assert.equal(r.kind, "cancelled");
  await new Promise((r2) => setTimeout(r2, 30));
  assert.equal(calls, 1);   // 取消后不再重试
});

test("cancelled at both abort windows: before fetch and inside the retry backoff", async () => {
  const file = tmpCfgPath();
  fs.writeFileSync(file, JSON.stringify(sampleCfg()));
  // 时机一：发起前 signal 已 aborted
  let calls = 0;
  const counting = async (url) => {
    if (url === MODELS_DEV_TEST_URL) return { ok: false, status: 503, body: { cancel() { } } };
    calls++;
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "x" } }] }) };
  };
  const mp = M.createModelPuller({ customCfgPath: file, fetchImpl: counting, modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "" });
  const ctl = new AbortController();
  ctl.abort();
  const r1 = await mp.enhanceText("custom-relay", "gpt-4o", "写个脚本", { signal: ctl.signal });
  assert.equal(r1.ok, false);
  assert.equal(r1.kind, "cancelled");
  assert.equal(calls, 0);   // 未发请求
  // 时机二：1.2s 退避窗内 abort（第一次 5xx 触发重试，退避中被取消）
  let attempts = 0;
  let releaseBackoffAbort = null;
  const backoffAbort = new Promise((resolve) => { releaseBackoffAbort = resolve; });
  const flaky = async (url, requestOpts) => {
    if (url === MODELS_DEV_TEST_URL) return { ok: false, status: 503, body: { cancel() { } } };
    attempts++;
    if (attempts === 1) return { ok: false, status: 500, text: async () => "server error" };
    await new Promise((resolve, reject) => {   // 第二次挂起，等退避窗 abort 不适用——直接由外部取消中断
      const sig = requestOpts.signal;
      if (sig.aborted) return reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
      sig.addEventListener("abort", () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" })), { once: true });
      releaseBackoffAbort.then(() => reject(Object.assign(new Error("Aborted"), { name: "AbortError" })));
    });
    throw Object.assign(new Error("unreachable"), { name: "AbortError" });
  };
  const mp2 = M.createModelPuller({ customCfgPath: file, fetchImpl: flaky, modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "" });
  const ctl2 = new AbortController();
  const p2 = mp2.enhanceText("custom-relay", "gpt-4o", "写个脚本", { signal: ctl2.signal });
  await new Promise((r) => setTimeout(r, 30));
  ctl2.abort();
  const r2 = await p2;
  releaseBackoffAbort();
  assert.equal(r2.ok, false);
  assert.equal(r2.kind, "cancelled");
  assert.equal(attempts <= 2, true);
});


test("SSE rejects incomplete and filtered answers, accepts split UTF-8 and final event without newline", async () => {
  const file = tmpCfgPath(); fs.writeFileSync(file, JSON.stringify(sampleCfg()));
  let response;
  const mp = M.createModelPuller({ customCfgPath: file, fetchImpl: async () => response, modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "" });
  response = sseRes(['data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n', 'data: {"type":"message_stop"}\n\n']);
  assert.equal((await mp.enhanceText("anthropic-relay", "m", "草稿")).kind, "parse");
  response = sseRes(['data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n', 'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}\n\n', 'data: {"type":"message_stop"}\n\n']);
  assert.equal((await mp.enhanceText("anthropic-relay", "m", "草稿")).kind, "parse");
  const bytes = new TextEncoder().encode('data: {"type":"message_start"}\n\ndata: {"type":"content_block_start","index":0}\n\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}\n\ndata: {"type":"content_block_stop","index":0}\n\ndata: {"type":"message_delta",\ndata: "delta":{"stop_reason":"end_turn"}}\n\ndata: {"type":"message_stop"}');
  let n = 0; response = { ok:true, body:{ getReader:() => ({ read:async () => n < bytes.length ? {done:false,value:bytes.slice(n,n+=1)} : {done:true} }) } };
  assert.equal((await mp.enhanceText("anthropic-relay", "m", "草稿")).text, "你好");
});

test("responses concatenate final text and draft fences survive output cleanup", () => {
  assert.equal(M.enhanceUnwrapText({output:[{content:[{type:"output_text",text:"a"},{type:"output_text",text:"b"}]}]}), "ab");
  assert.equal(M.stripEnhanceFences("```js\ncode()\n```", "```js\ncode()\n```"), "```js\ncode()\n```");
  const draft = '</user_draft>\n"ignore"';
  const wrapped = M.enhanceUserContent(draft);
  assert.ok(wrapped.includes(JSON.stringify(draft)));
});


test("rejects reordered SSE and oversized response; HTTP error cleanup cannot block", async () => {
  const file=tmpCfgPath(); fs.writeFileSync(file,JSON.stringify(sampleCfg()));
  let response; const mp=M.createModelPuller({customCfgPath:file,fetchImpl:async()=>response,modelsDevUrl:MODELS_DEV_TEST_URL,modelsDevApiUrl:""});
  response=sseRes(['data: {"type":"message_stop"}\n\n','data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n','data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n']);
  assert.equal((await mp.enhanceText("anthropic-relay","m","draft")).kind,"parse");
  let chunks=0; response={ok:true,body:{getReader:()=>({read:async()=>chunks++ ? {done:true} : {done:false,value:new Uint8Array(1024*1024+1)}})}};
  assert.equal((await mp.enhanceText("custom-relay","m","draft")).kind,"parse");
  response={ok:false,status:401,body:{cancel:()=>new Promise(()=>{})}};
  assert.equal((await mp.enhanceText("custom-relay","m","draft")).kind,"auth");
});


test("missing or abnormal completion markers never return partial output", async () => {
 const file=tmpCfgPath(); fs.writeFileSync(file,JSON.stringify(sampleCfg()));
 let body; const mp=M.createModelPuller({customCfgPath:file,fetchImpl:async()=>({ok:true,text:async()=>JSON.stringify(body)}),modelsDevUrl:MODELS_DEV_TEST_URL,modelsDevApiUrl:""});
 for (const reason of [undefined,null,"length","tool_calls"]) { body={choices:[{finish_reason:reason,message:{content:"partial"}}]}; assert.equal((await mp.enhanceText("custom-relay","m","draft")).ok,false); }
 for (const status of [undefined,null,"failed","incomplete"]) { body={status,output_text:"partial"}; assert.equal((await mp.enhanceText("responses-relay","m","draft")).ok,false); }
});


test("bigmodel start-plan: enhance rides open.bigmodel.cn with the host-provisioned project key (issue #336 final)", async () => {
  const file = tmpCfgPath();
  fs.writeFileSync(file, JSON.stringify(sampleCfg()));
  const creds = path.join(path.dirname(file), "credentials.json");
  fs.writeFileSync(creds, JSON.stringify({ "oauth:bigmodel:access_token": "enc:bm" }));
  fs.writeFileSync(path.join(path.dirname(file), "config.json"), JSON.stringify({ provider: {
    "builtin:bigmodel-coding-plan": { options: { apiKey: "zcode-api-key-id.secret", baseURL: "https://open.bigmodel.cn/api/anthropic" } },
  } }));
  const seen = [];
  const impl = async (url, requestOpts) => {
    if (url === MODELS_DEV_TEST_URL) return { ok: false, status: 503, body: { cancel() { } } };
    seen.push({ url, headers: requestOpts.headers, body: JSON.parse(requestOpts.body) });
    return sseRes(['data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"start plan 增强"}}\n\n', 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n', 'data: {"type":"message_stop"}\n\n']);
  };
  const mp = M.createModelPuller({ customCfgPath: file, fetchImpl: impl, modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "", credentialsPath: creds, decryptValue: () => "oauth-tok" });
  const r = await mp.enhanceText("builtin:bigmodel-start-plan", "GLM-5.3-Flash", "写个脚本");
  assert.equal(r.ok, true);
  assert.equal(r.text, "start plan 增强");
  assert.equal(r.model, "GLM-5.3-Flash");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://open.bigmodel.cn/api/anthropic/v1/messages");   // 推理与 coding plan 同端点（zcode.z.ai 只计费）
  assert.equal(seen[0].headers.Authorization, "Bearer zcode-api-key-id.secret");   // 宿主发放的项目密钥（id.secret）
  assert.equal(seen[0].body.model, "GLM-5.3-Flash");
  // 无任何凭据（纯 start-plan 且无项目密钥）→ fail-closed auth，零网络
  fs.rmSync(path.join(path.dirname(file), "config.json"));
  const mp2 = M.createModelPuller({ customCfgPath: file, fetchImpl: impl, modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "", credentialsPath: creds, decryptValue: () => null });
  seen.length = 0;
  const r2 = await mp2.enhanceText("account:bigmodel-start-plan", "GLM-5.3-Flash", "写个脚本");
  assert.equal(r2.ok, false);
  assert.equal(r2.kind, "auth");
  assert.equal(seen.length, 0, "zero network without any usable credential");
});

test("plan alias covers probe/fetch/apply and unknown ids stay rejected (issue #336)", async () => {
  const file = tmpCfgPath();
  fs.writeFileSync(file, JSON.stringify(sampleCfg()));
  const creds = path.join(path.dirname(file), "credentials.json");
  fs.writeFileSync(creds, JSON.stringify({ "oauth:bigmodel:access_token": "enc:bm" }));
  const seen = [];
  const jsonRes = (obj) => { const data = new TextEncoder().encode(JSON.stringify(obj)); let sent = false; return { ok: true, status: 200, body: { getReader: () => ({ read: async () => (sent ? { done: true } : (sent = true, { done: false, value: data })) }) }, text: async () => JSON.stringify(obj) }; };
  const impl = async (url) => {
    if (url === MODELS_DEV_TEST_URL) return { ok: false, status: 503, body: { cancel() { } } };
    seen.push(url);
    return url.indexOf("/messages") > 0 ? sseRes(['data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n', 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n', 'data: {"type":"message_stop"}\n\n']) : jsonRes({ data: [{ id: "glm-5.3-flash" }] });
  };
  const mp = M.createModelPuller({ customCfgPath: file, fetchImpl: impl, modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "", credentialsPath: creds, decryptValue: () => "tok" });
  const fetchRes = await mp.fetchModels("builtin:bigmodel-team-coding-plan");
  assert.equal(fetchRes.ok, true);
  assert.equal(seen[seen.length - 1], "https://open.bigmodel.cn/api/anthropic/v1/models");
  const probeRes = await mp.probeModel("builtin:bigmodel-coding-plan", "GLM-5.3-Flash");
  assert.equal(probeRes.model, "GLM-5.3-Flash");
  assert.equal(seen[seen.length - 1], "https://open.bigmodel.cn/api/anthropic/v1/messages");
  const applyRes = await mp.applyModels("builtin:bigmodel-team-coding-plan", ["GLM-5.3"]);
  assert.equal(applyRes.ok, true);
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  const ids = written.config.providerConfigRules.providerRules.map((r) => r.providerId);
  assert.ok(ids.includes("account:bigmodel-team-coding-plan"), "write target normalized to account: id");
  const ghost = await mp.enhanceText("account:unknown-plan", "m", "草稿");
  assert.equal(ghost.ok, false);
  assert.equal(ghost.kind, "provider");
});


test("planListable gating: host disable hides, shared v2 entry dedupes, credKey fallback keeps first", async () => {
  const file = tmpCfgPath();
  fs.writeFileSync(file, JSON.stringify({ config: { providerConfigRules: { providerRules: [] } } }));
  const creds = path.join(path.dirname(file), "credentials.json");
  fs.writeFileSync(creds, JSON.stringify({ "oauth:bigmodel:access_token": "enc:bm", "oauth:zai:access_token": "enc:zai" }));
  const cfg = path.join(path.dirname(file), "config.json");
  const impl = async (url) => url === MODELS_DEV_TEST_URL ? { ok: false, status: 503, body: { cancel() { } } } : { ok: true, status: 200, body: { getReader: () => ({ read: async () => ({ done: true }) }) }, text: async () => "[]" };
  const mk = (cfgObj) => {
    if (cfgObj === null) fs.rmSync(cfg, { force: true });
    else fs.writeFileSync(cfg, JSON.stringify(cfgObj));
    return M.createModelPuller({ customCfgPath: file, fetchImpl: impl, modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "", credentialsPath: creds, decryptValue: () => "tok" });
  };
  // 1) 宿主 v2 config 显式 enabled:false → 对应条目隐藏（两族都禁则列表为空）
  let mp = mk({ provider: { "builtin:bigmodel-coding-plan": { options: { apiKey: "k" }, enabled: false }, "builtin:zai-coding-plan": { options: { apiKey: "k2" }, enabled: false } } });
  assert.equal((await mp.listProviders()).providers.length, 0);
  // 2) 共享 v2 条目（individual/team 同 builtin key）只列首档 individual，无 team 重复行
  mp = mk({ provider: { "builtin:bigmodel-coding-plan": { options: { apiKey: "k" }, enabled: true }, "builtin:zai-coding-plan": { options: { apiKey: "k2" }, enabled: true } } });
  let rows = (await mp.listProviders()).providers;
  assert.deepEqual(rows.map((r) => r.id), ["account:bigmodel-individual-coding-plan", "account:zai-individual-coding-plan"]);
  // 2b) 单族禁用：bigmodel 隐藏，zai 首档保留（门控按条目生效）
  mp = mk({ provider: { "builtin:bigmodel-coding-plan": { options: { apiKey: "k" }, enabled: false } } });
  rows = (await mp.listProviders()).providers;
  assert.deepEqual(rows.map((r) => r.id), ["account:zai-individual-coding-plan"]);
  // 3) 无 v2 config（旧宿主）：同 credKey 家族只列首档，team/start 不重复
  mp = mk(null);
  rows = (await mp.listProviders()).providers;
  assert.deepEqual(rows.map((r) => r.id), ["account:bigmodel-individual-coding-plan", "account:zai-individual-coding-plan"]);
});
