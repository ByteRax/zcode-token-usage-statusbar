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
    if (hit.reader) return { ok: false, status: hit.status, body: { dead: false, getReader() { const self = this; return { read: async () => { if (self.dead) throw new Error("body cancelled"); self.reads = (self.reads || 0) + 1; return self.reads > 1 ? { done: true } : { done: false, value: Buffer.from(hit.body || "") }; } }; }, cancel() { this.dead = true; } } };
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

  // 无 v2 config（GLr 时代常态）：OAuth 直连兜底已移除（v344 实测 500 code 1234）；
  // 本夹具无 location 键 → 零网络 plan_auth（GLr 换发路径由专用用例覆盖）
  fs.rmSync(cfg);
  const seen2 = [];
  const impl2 = async (url, requestOpts) => {
    if (url === MODELS_DEV_TEST_URL) return { ok: false, status: 503, body: { cancel() { } } };
    if (url === "https://open.bigmodel.cn/api/anthropic/v1/messages") {
      seen2.push({ headers: requestOpts.headers });
      return sseRes(['event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"套餐增强"}}\n\n', 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n', 'data: {"type":"message_stop"}\n\n']);
    }
    seen2.push({ url });
    return sseRes(['event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"套餐增强"}}\n\n', 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n', 'data: {"type":"message_stop"}\n\n']);
  };
  const mp2 = M.createModelPuller({ customCfgPath: file, fetchImpl: impl2, modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "", credentialsPath: creds, decryptValue: () => "plan-oauth-token" });
  const r2 = await mp2.enhanceText(PLAN_ID, "GLM-5.3-FlashX", "写个脚本");
  assert.equal(r2.ok, false);
  assert.equal(r2.kind, "plan_auth");
  assert.equal(seen2.length, 0, "OAuth token never leaves without a usable v2 key or GLr location");
});

test("planKeyOf: enc: v2 config key never leaves as plaintext; GLr era fails closed without location (issue #336 review, GLr update)", async () => {
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
  // enc: 密文不作明文 key；OAuth 直连兜底已随 GLr 时代移除（v344 实测 500 code 1234）——
  // 无 location 可换发 → plan_auth，密文与 OAuth token 都绝不外发
  const mp = M.createModelPuller({ customCfgPath: file, fetchImpl: capturing, modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "", credentialsPath: creds, decryptValue: () => "plan-oauth-token" });
  const r = await mp.enhanceText(PLAN_ID, "GLM-5.3-FlashX", "草稿");
  assert.equal(r.ok, false);
  assert.equal(r.kind, "plan_auth");
  assert.equal(seen.length, 0, "enc key + no location: zero network, OAuth never sent");
  // OAuth 也解不出 → plan_auth fail-closed 且零网络（原 kind "auth" 并入 plan_auth 语义）
  const mp2 = M.createModelPuller({ customCfgPath: file, fetchImpl: capturing, modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "", credentialsPath: creds, decryptValue: () => null });
  const r2 = await mp2.enhanceText(PLAN_ID, "GLM-5.3-FlashX", "草稿");
  assert.equal(r2.ok, false);
  assert.equal(r2.kind, "plan_auth");
  assert.equal(seen.length, 0, "no network without a usable credential");
});
test("fail-closed: http errors classified; classified error stays clean, bounded body goes to detail", async () => {
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
  assert.equal(r.error, "HTTP 401");   // 分类错误串保持无响应体
  assert.equal(r.detail, "unauthorized *** echo");   // D1 修复：detail 过 maskSecrets，sk- 凭据不回显   // 设置页测试用：有界原文摘录（≤500）
});

test("token usage captured from all three protocols without fabricating values", async () => {
  const file = tmpCfgPath();
  fs.writeFileSync(file, JSON.stringify(sampleCfg()));
  const routes = [
    { url: "https://relay.example.com/chat/completions", body: { choices: [{ finish_reason: "stop", message: { content: "a" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } } },
    { url: "https://relay.example.com/responses", body: { status: "completed", output_text: "b", usage: { input_tokens: 7, output_tokens: 3 } } },
  ];
  const impl = async (url) => {
    const hit = routes.find(r => url.indexOf(new URL(r.url).pathname) >= 0 || url === r.url);
    if (hit) return { ok: true, status: 200, text: async () => JSON.stringify(hit.body) };
    throw new Error("unexpected " + url);
  };
  let streamBody = null;
  const mp = M.createModelPuller({ customCfgPath: file, fetchImpl: async (url) => {
    if (url.indexOf("/chat/completions") >= 0) return { ok: true, status: 200, text: async () => JSON.stringify(routes[0].body) };
    if (url.indexOf("/responses") >= 0) return { ok: true, status: 200, text: async () => JSON.stringify(routes[1].body) };
    if (url.indexOf("/ant/") >= 0) {
      const enc = new TextEncoder();
      const frames = [
        "event: message_start\ndata: " + JSON.stringify({ type: "message_start", message: { model: "served", usage: { input_tokens: 12 } } }) + "\n\n",
        "event: content_block_start\ndata: " + JSON.stringify({ type: "content_block_start", index: 0 }) + "\n\n",
        "event: content_block_delta\ndata: " + JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "c" } }) + "\n\n",
        "event: content_block_stop\ndata: " + JSON.stringify({ type: "content_block_stop", index: 0 }) + "\n\n",
        "event: message_delta\ndata: " + JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } }) + "\n\n",
        "event: message_stop\ndata: " + JSON.stringify({ type: "message_stop" }) + "\n\n",
      ].join("");
      let cursor = 0;
      const reader = { read: async () => cursor < frames.length ? { done: false, value: enc.encode(frames[cursor++]) } : { done: true } };
      reader.cancel = function () {};
      reader.releaseLock = function () {};
      return { ok: true, status: 200, body: { getReader() { return reader; } } };
    }
    throw new Error("unexpected " + url);
  } });
  const cfgPatch = JSON.stringify({ config: { providerConfigRules: { providerRules: [
    { providerId: "r-chat", enabled: true, providerName: "Chat", config: { access: { type: "api-key", apiKey: "k" }, api: { baseUrl: "https://relay.example.com", type: "openai-chat-completions" } } },
    { providerId: "r-resp", enabled: true, providerName: "Resp", config: { access: { type: "api-key", apiKey: "k" }, api: { baseUrl: "https://relay.example.com", type: "openai-responses" } } },
    { providerId: "r-ant", enabled: true, providerName: "Ant", config: { access: { type: "api-key", apiKey: "k" }, api: { baseUrl: "https://relay.example.com/ant", type: "anthropic-messages" } } },
  ] } } });
  fs.writeFileSync(file, cfgPatch);
  const chat = await mp.enhanceText("r-chat", "m", "草稿");
  assert.deepEqual(chat.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  const resp = await mp.enhanceText("r-resp", "m", "草稿");
  assert.deepEqual(resp.usage, { inputTokens: 7, outputTokens: 3, totalTokens: 10 });
  const ant = await mp.enhanceText("r-ant", "m", "草稿");
  assert.deepEqual(ant.usage, { inputTokens: 12, outputTokens: 4, totalTokens: 16 });
});

test("http error body is read before the stream is cancelled (real undici order)", async () => {
  const file = tmpCfgPath();
  fs.writeFileSync(file, JSON.stringify(sampleCfg()));
  const { mp } = createEnhancer(file, [
    { url: "https://relay.example.com/chat/completions", status: 503, reader: true, body: '{"error":{"message":"upstream unavailable"}}' },
  ]);
  const r = await mp.enhanceText("custom-relay", "gpt-4o", "写个脚本");
  assert.equal(r.ok, false);
  assert.equal(r.error, "HTTP 503");
  assert.equal(r.detail, '{"error":{"message":"upstream unavailable"}}');
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
  // 无任何凭据（纯 start-plan 且无项目密钥）→ fail-closed plan_auth，零网络（issue #429：spec「未实现前诚实报 auth」落地）
  fs.rmSync(path.join(path.dirname(file), "config.json"));
  const mp2 = M.createModelPuller({ customCfgPath: file, fetchImpl: impl, modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "", credentialsPath: creds, decryptValue: () => null });
  seen.length = 0;
  const r2 = await mp2.enhanceText("account:bigmodel-start-plan", "GLM-5.3-Flash", "写个脚本");
  assert.equal(r2.ok, false);
  assert.equal(r2.kind, "plan_auth");
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
  // 4) 增强宿主列表同样包含凭据可用的套餐源；Start Plan 与个人档分列（计费池不同），team 去重。
  //    GLr 时代（specs/plan-glr-credential.md）：无 v2 config 时 bigmodel 家族需换发 memo 才列
  //    （同步列表门不发起网络），本夹具未换发 → bigmodel 两条都不列；zai 维持 OAuth 诚实尝试照列。
  const hosts = mp.listEnhanceHosts();
  const planHosts = hosts.filter((h) => h.id.startsWith('account:'));
  assert.deepEqual(planHosts.map((h) => h.id), [
    "account:zai-individual-coding-plan",
    "account:zai-start-plan",
  ]);
  for (const h of planHosts) { assert.equal(h.protocol, "anthropic-messages"); assert.ok(h.baseUrl.startsWith("https://")); }
  assert.equal(mp.resolveEnhanceHost("account:bigmodel-start-plan"), null);   // issue #429：无 v2 key 且无换发 memo 的 start-plan 不提供 host
  assert.equal(mp.resolveEnhanceHost("account:bigmodel-individual-coding-plan"), null);   // GLr 时代同门（曾靠必败 OAuth 兜底假列）
  const zaiStart = mp.resolveEnhanceHost("account:zai-start-plan");
  assert.ok(zaiStart && zaiStart.apiKey);   // zai 端点未实测，凭据可用即列出（planKeyOf 主进程内解析，不回渲染端）
  assert.equal(mp.resolveEnhanceHost("account:bigmodel-team-coding-plan"), null);   // team 与个人同凭据同端点，不重复列出
});

/* ---------- issue #429：纯 Start Plan 增强链凭据错配的诚实收口 ----------
 * 报告者实测：宿主 v2 config 的 builtin:bigmodel-coding-plan 条目 enabled:false 且项目 key
 * 无资源包 → planKeyOf 照取该 key → open.bigmodel.cn 恒 429 1113「余额不足或无可用资源包」，
 * 插件归一显示「HTTP 429」诱导用户当并发限流重试。修复两件事：
 * ① start-plan 无可用 v2 条目 key（缺失/disabled/enc:/空）时零网络 fail-fast 回 plan_auth
 *   （spec「未实现前诚实报 auth」落地；OAuth 兜底直连 messages 被网关 500 拒，v344 实测）；
 * ② 上游 1113/余额不足类错误体分类为 kind "balance"，不再与真实并发限流共用「HTTP 429」。 */

test("bigmodel start-plan without a usable v2 entry key fails fast before any request (issue #429)", async () => {
  const file = tmpCfgPath();
  fs.writeFileSync(file, JSON.stringify(sampleCfg()));
  const creds = path.join(path.dirname(file), "credentials.json");
  fs.writeFileSync(creds, JSON.stringify({ "oauth:bigmodel:access_token": "enc:bm" }));
  const cfg = path.join(path.dirname(file), "config.json");
  const seen = [];
  const impl = async (url, requestOpts) => {
    if (url === MODELS_DEV_TEST_URL) return { ok: false, status: 503, body: { cancel() { } } };
    seen.push(url);
    return sseRes(['data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"不应到达"}}\n\n', 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n', 'data: {"type":"message_stop"}\n\n']);
  };
  const mp = M.createModelPuller({ customCfgPath: file, fetchImpl: impl, modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "", credentialsPath: creds, decryptValue: () => "oauth-tok" });
  // 1) 报告者场景：coding-plan 条目存在但 enabled:false，key 无资源包——不发必败请求
  fs.writeFileSync(cfg, JSON.stringify({ provider: {
    "builtin:bigmodel-coding-plan": { options: { apiKey: "no-pack-key", baseURL: "https://open.bigmodel.cn/api/anthropic" }, enabled: false },
  } }));
  const r1 = await mp.enhanceText("account:bigmodel-start-plan", "GLM-5.3-Flash", "写个脚本");
  assert.equal(r1.ok, false);
  assert.equal(r1.kind, "plan_auth");
  assert.equal(r1.error, "plan conversation key unavailable");
  assert.equal(seen.length, 0, "disabled entry must not reach the network");
  // 2) 条目缺失（纯 start-plan 无 coding plan 条目）且 OAuth 可用：同样 fail-fast
  fs.rmSync(cfg);
  seen.length = 0;
  const r2 = await mp.enhanceText("builtin:bigmodel-start-plan", "GLM-5.3-Flash", "写个脚本");
  assert.equal(r2.ok, false);
  assert.equal(r2.kind, "plan_auth");
  assert.equal(seen.length, 0, "OAuth fallback is gateway-doomed for start-plan; fail fast");
  // 3) 条目 key 为 enc: 密文：同 fail-fast（密文不作明文外发，issue #336 review 口径）
  fs.writeFileSync(cfg, JSON.stringify({ provider: {
    "builtin:bigmodel-coding-plan": { options: { apiKey: "enc:v2:env:aa:bb.cc" }, enabled: true },
  } }));
  seen.length = 0;
  const r3 = await mp.enhanceText("account:bigmodel-start-plan", "GLM-5.3-Flash", "写个脚本");
  assert.equal(r3.ok, false);
  assert.equal(r3.kind, "plan_auth");
  assert.equal(seen.length, 0);
  // 4) 条目 enabled:true 但 apiKey 为空白串：同 fail-fast（第一轮 review MINOR-4）
  fs.writeFileSync(cfg, JSON.stringify({ provider: {
    "builtin:bigmodel-coding-plan": { options: { apiKey: "   " }, enabled: true },
  } }));
  seen.length = 0;
  const r4 = await mp.enhanceText("account:bigmodel-start-plan", "GLM-5.3-Flash", "写个脚本");
  assert.equal(r4.ok, false);
  assert.equal(r4.kind, "plan_auth");
  assert.equal(seen.length, 0);
});

test("bigmodel 1113 balance/resource-pack errors are classified as balance, not rate (issue #429)", async () => {
  const file = tmpCfgPath();
  fs.writeFileSync(file, JSON.stringify(sampleCfg()));
  const creds = path.join(path.dirname(file), "credentials.json");
  fs.writeFileSync(creds, JSON.stringify({ "oauth:bigmodel:access_token": "enc:bm" }));
  fs.writeFileSync(path.join(path.dirname(file), "config.json"), JSON.stringify({ provider: {
    "builtin:bigmodel-coding-plan": { options: { apiKey: "zcode-api-key-id.secret" }, enabled: true },
  } }));
  let calls = 0;
  const impl = async (url, requestOpts) => {
    if (url === MODELS_DEV_TEST_URL) return { ok: false, status: 503, body: { cancel() { } } };
    calls++;
    return { ok: false, status: 429, text: async () => JSON.stringify({ error: { type: "rate_limit_error", code: "1113", message: "[1113][余额不足或无可用资源包,请充值。]" }, request_id: "2026112112145981791bf98b284d31" }) };
  };
  const mp = M.createModelPuller({ customCfgPath: file, fetchImpl: impl, modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "", credentialsPath: creds, decryptValue: () => "oauth-tok" });
  const r = await mp.enhanceText("account:bigmodel-start-plan", "GLM-5.3-Flash", "写个脚本");
  assert.equal(r.ok, false);
  assert.equal(r.kind, "balance");
  assert.equal(r.status, 429);
  assert.equal(r.error, undefined, "no generic HTTP phrase; overlay kindMap carries the localized message");
  assert.match(r.detail, /余额不足/);
  assert.equal(calls, 1, "balance failures are deterministic; no retry");
  // 两条检测路径各自独立可用（第一轮 review MINOR-1：正则与 JSON code 分支此前只有合取被锁）
  const textOnly = async (url) => url === MODELS_DEV_TEST_URL
    ? { ok: false, status: 503, body: { cancel() { } } }
    : { ok: false, status: 429, text: async () => "上游网关返回：余额不足或无可用资源包，请充值。" };
  const mpText = M.createModelPuller({ customCfgPath: file, fetchImpl: textOnly, modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "", credentialsPath: creds, decryptValue: () => "oauth-tok" });
  const rText = await mpText.enhanceText("account:bigmodel-start-plan", "GLM-5.3-Flash", "写个脚本");
  assert.equal(rText.kind, "balance", "non-JSON body hits the keyword path");
  // 正则两个交替支各自独立锁（第二轮 review：单短语错误体不因另一支存在而漏锁）
  const mkSinglePhrase = (phrase) => async (url) => url === MODELS_DEV_TEST_URL
    ? { ok: false, status: 503, body: { cancel() { } } }
    : { ok: false, status: 429, text: async () => phrase };
  for (const phrase of ["无可用资源包", "余额不足"]) {
    const mpSingle = M.createModelPuller({ customCfgPath: file, fetchImpl: mkSinglePhrase(phrase), modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "", credentialsPath: creds, decryptValue: () => "oauth-tok" });
    const rSingle = await mpSingle.enhanceText("account:bigmodel-start-plan", "GLM-5.3-Flash", "写个脚本");
    assert.equal(rSingle.kind, "balance", "single-phrase body " + phrase + " still classifies as balance");
  }
  const codeOnly = async (url) => url === MODELS_DEV_TEST_URL
    ? { ok: false, status: 503, body: { cancel() { } } }
    : { ok: false, status: 429, text: async () => JSON.stringify({ error: { code: "1113", message: "insufficient balance" } }) };
  const mpCode = M.createModelPuller({ customCfgPath: file, fetchImpl: codeOnly, modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "", credentialsPath: creds, decryptValue: () => "oauth-tok" });
  const rCode = await mpCode.enhanceText("account:bigmodel-start-plan", "GLM-5.3-Flash", "写个脚本");
  assert.equal(rCode.kind, "balance", "code-only envelope without Chinese keywords hits the JSON path");
});

test("genuine rate-limit 429 without balance markers stays rate", async () => {
  const file = tmpCfgPath();
  fs.writeFileSync(file, JSON.stringify(sampleCfg()));
  const creds = path.join(path.dirname(file), "credentials.json");
  fs.writeFileSync(creds, JSON.stringify({ "oauth:bigmodel:access_token": "enc:bm" }));
  fs.writeFileSync(path.join(path.dirname(file), "config.json"), JSON.stringify({ provider: {
    "builtin:bigmodel-coding-plan": { options: { apiKey: "zcode-api-key-id.secret" }, enabled: true },
  } }));
  const impl = async (url, requestOpts) => {
    if (url === MODELS_DEV_TEST_URL) return { ok: false, status: 503, body: { cancel() { } } };
    return { ok: false, status: 429, text: async () => JSON.stringify({ error: { code: "1302", message: "[1302]请求过于频繁，请稍后再试" } }) };
  };
  const mp = M.createModelPuller({ customCfgPath: file, fetchImpl: impl, modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "", credentialsPath: creds, decryptValue: () => "oauth-tok" });
  const r = await mp.enhanceText("account:bigmodel-start-plan", "GLM-5.3-Flash", "写个脚本");
  assert.equal(r.ok, false);
  assert.equal(r.kind, "rate");
  assert.equal(r.error, "HTTP 429");
  assert.match(r.detail, /请求过于频繁/);
});

test("enhance host gating: start-plan requires the v2 entry key; zai start-plan keeps honest attempt (issue #429)", () => {
  const file = tmpCfgPath();
  fs.writeFileSync(file, JSON.stringify({ config: { providerConfigRules: { providerRules: [] } } }));
  const creds = path.join(path.dirname(file), "credentials.json");
  fs.writeFileSync(creds, JSON.stringify({ "oauth:bigmodel:access_token": "enc:bm", "oauth:zai:access_token": "enc:zai" }));
  const cfg = path.join(path.dirname(file), "config.json");
  const impl = async (url) => url === MODELS_DEV_TEST_URL ? { ok: false, status: 503, body: { cancel() { } } } : { ok: true, status: 200, body: { getReader: () => ({ read: async () => ({ done: true }) }) }, text: async () => "[]" };
  const mk = (cfgObj) => {
    fs.writeFileSync(cfg, JSON.stringify(cfgObj));
    return M.createModelPuller({ customCfgPath: file, fetchImpl: impl, modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "", credentialsPath: creds, decryptValue: () => "tok" });
  };
  // 条目 disabled：bigmodel start-plan 不再作为增强 host 提供（OAuth 兜底必败）
  let mp = mk({ provider: { "builtin:bigmodel-coding-plan": { options: { apiKey: "k" }, enabled: false } } });
  assert.equal(mp.resolveEnhanceHost("account:bigmodel-start-plan"), null);
  // 条目缺失：同上，且增强宿主列表不列 start-plan（zai 照列）
  mp = mk({ provider: {} });
  assert.equal(mp.resolveEnhanceHost("account:bigmodel-start-plan"), null);
  const hosts = mp.listEnhanceHosts().filter((h) => h.id.startsWith("account:"));
  assert.equal(hosts.some((h) => h.id === "account:bigmodel-start-plan"), false);
  assert.equal(hosts.some((h) => h.id === "account:zai-start-plan"), true, "zai start-plan endpoint untested; keep the honest attempt");
  // 条目可用：照常提供
  mp = mk({ provider: { "builtin:bigmodel-coding-plan": { options: { apiKey: "k" }, enabled: true } } });
  const resolved = mp.resolveEnhanceHost("account:bigmodel-start-plan");
  assert.equal(resolved.plan, true);
  assert.equal(resolved.apiKey, "k");
});

test("zai start-plan without a v2 entry still attempts with oauth (endpoint untested; honest attempt)", async () => {
  const file = tmpCfgPath();
  fs.writeFileSync(file, JSON.stringify(sampleCfg()));
  const creds = path.join(path.dirname(file), "credentials.json");
  fs.writeFileSync(creds, JSON.stringify({ "oauth:zai:access_token": "enc:zai" }));
  const seen = [];
  const impl = async (url, requestOpts) => {
    if (url === MODELS_DEV_TEST_URL) return { ok: false, status: 503, body: { cancel() { } } };
    seen.push({ url, headers: requestOpts.headers });
    return sseRes(['data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"zai 尝试"}}\n\n', 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n', 'data: {"type":"message_stop"}\n\n']);
  };
  const mp = M.createModelPuller({ customCfgPath: file, fetchImpl: impl, modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "", credentialsPath: creds, decryptValue: () => "zai-oauth-tok" });
  const r = await mp.enhanceText("account:zai-start-plan", "GLM-5.3-Flash", "写个脚本");
  assert.equal(r.ok, true);
  assert.equal(seen[0].url, "https://api.z.ai/api/anthropic/v1/messages");
  assert.equal(seen[0].headers.Authorization, "Bearer zai-oauth-tok");
});

/* ---------- GLr 凭据换发（specs/plan-glr-credential.md）：3.19.1 宿主运行时解析对等 ----------
 * 宿主 3.19.x 把 builtin 套餐 access 改为 zhipu-account 运行时换发（POST access_tokens，
 * Bearer OAuth），v2/config.json 不再存在——插件的「条目 key → OAuth 兜底」双路全灭。
 * 本组用例锁：location 扫描/解密、换发、runtime 权威路由、memo、fail-closed。 */

const GLR_LOCATION_ACCOUNT = "74117772185376524";
function glrLocationKeyName(origin, family, accountId, team, usageScene, planType) {
  return "project-key-location:v1:" + encodeURIComponent(JSON.stringify([origin, family, accountId, team, usageScene, planType]));
}
const GLR_LOC_KEY = glrLocationKeyName("https://bigmodel.cn", "bigmodel", GLR_LOCATION_ACCOUNT, null, 1, "non-team");
const GLR_LOC_JSON = JSON.stringify({ organizationId: "org-9", projectId: "proj-8", apiKeyId: "key-7" });
const GLR_EXCHANGE_URL = "https://bigmodel.cn/api/biz/v1/organization/org-9/projects/proj-8/api_keys/key-7/access_tokens";
const GLR_RUNTIME_DIR = process.platform === "win32" ? "windows-x86_64" : process.platform === "darwin" ? "darwin-arm64" : "linux-x86_64";
function writeRuntimeBuiltin(dir, version, startPlanBase) {
  const p = path.join(dir, "runtime", "provider", GLR_RUNTIME_DIR, version, "endpoint-abc", "zcode-builtin.json");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ schemaVersion: 1, revision: 44, config: { providerConfigRules: { providerRules: [
    { providerId: "account:bigmodel-start-plan", config: { api: { type: "anthropic-messages", baseUrl: startPlanBase } } },
    { providerId: "account:bigmodel-individual-coding-plan", config: { api: { type: "anthropic-messages", baseUrl: "https://open.bigmodel.cn/api/anthropic" } } },
  ] } } }));
  return p;
}
function glrFixture(opts) {
  const o = opts || {};
  const file = tmpCfgPath();
  fs.writeFileSync(file, JSON.stringify(sampleCfg()));
  const dir = path.dirname(file);
  const creds = {};
  creds["oauth:bigmodel:access_token"] = "enc:oauth-" + (o.oauthTag || "1");
  if (!o.noLocation) creds[GLR_LOC_KEY] = "enc:loc-1";
  if (!o.noSessionJwt) creds["zcodejwttoken"] = "enc:session-jwt-1";   // zcode.z.ai 路由的会话凭据（补篇）
  fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify(creds));
  if (!o.noDeviceMid) fs.writeFileSync(path.join(dir, "telemetry-state.json"), JSON.stringify({ deviceMid: "dev-mid-1" }));
  if (o.runtimeBase !== false) writeRuntimeBuiltin(dir, o.runtimeVersion || "3.19.1", o.startPlanBase || "https://zcode.z.ai/api/v1/zcode-plan/anthropic");
  const decryptValue = (enc) => {
    if (enc === "enc:loc-1") return GLR_LOC_JSON;
    if (enc === "enc:loc-2") return JSON.stringify({ organizationId: "org-9", projectId: "proj-8", apiKeyId: "key-8" });
    if (enc === "enc:loc-bad") return JSON.stringify({ organizationId: "org-bad", projectId: "proj-bad", apiKeyId: "key-bad" });
    if (enc === "enc:session-jwt-1") return "zc-session-jwt-1";
    if (String(enc).indexOf("enc:oauth-") === 0) return "glr-oauth-" + String(enc).slice(10);
    return null;
  };
  const calls = [];
  let exchangeDrops = 0;   // 非 ok 换发响应的 body.cancel 计数（dropBody 卫生锁，review R2-B5）
  const sse = ['data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"glr 增强"}}\n\n', 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n', 'data: {"type":"message_stop"}\n\n'];
  const impl = async (url, requestOpts) => {
    if (url === MODELS_DEV_TEST_URL) return { ok: false, status: 503, body: { cancel() { } } };
    calls.push({ url, opts: requestOpts });
    if (url.indexOf("/access_tokens") > 0 && url !== GLR_EXCHANGE_URL) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 200, data: { enabled: true, token: "glr-tok-rotated" } }) };   // 同键换信封后的新 apiKeyId（R2-B1）
    }
    if (url === GLR_EXCHANGE_URL) {
      if (o.exchangeStatus) return { ok: false, status: o.exchangeStatus, text: async () => o.exchangeBody || "", body: { cancel() { exchangeDrops++; } } };
      if (o.exchangeDisabled) return { ok: true, status: 200, text: async () => JSON.stringify({ code: 200, msg: "操作成功", data: { enabled: false, accessToken: "x" } }) };
      if (o.exchangeBadShape) return { ok: true, status: 200, text: async () => JSON.stringify({ code: 200, data: { accessToken: 42 } }) };
      if (o.exchangeBadCode) return { ok: true, status: 200, text: async () => JSON.stringify({ code: 500, data: { enabled: true, accessToken: "glr-tok-1" } }) };
      if (o.exchangeTokenPadded) return { ok: true, status: 200, text: async () => JSON.stringify({ code: 200, data: { enabled: true, token: "  glr-tok-1  " } }) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 200, msg: "操作成功", data: { enabled: true, accessToken: o.exchangeToken || "glr-tok-1" } }) };
    }
    if (url.indexOf("/v1/messages") > 0) {
      const isZcode = url.indexOf("zcode.z.ai") > 0;
      const st = isZcode ? o.zcodeMessagesStatus : o.bigmodelMessagesStatus;
      if (st) return { ok: false, status: st, text: async () => (isZcode ? o.zcodeMessagesBody : o.bigmodelMessagesBody) || "" };
      if (o.messagesStatus) return { ok: false, status: o.messagesStatus, text: async () => o.messagesBody || "" };
      return sseRes(sse);
    }
    throw new Error("unexpected url " + url);
  };
  const mp = M.createModelPuller({ customCfgPath: file, fetchImpl: impl, modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "", credentialsPath: path.join(dir, "credentials.json"), decryptValue, hostVersion: "3.19.1" });
  return { mp, calls, dir, get exchangeDrops() { return exchangeDrops; }, setOauthTag: (t) => { creds["oauth:bigmodel:access_token"] = "enc:oauth-" + t; fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify(creds)); }, setLocEnvelope: (env) => { creds[GLR_LOC_KEY] = env; fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify(creds)); } };
}

test("GLr: start-plan zcode.z.ai route rides session JWT + device mid; exchange never fires for that route", async () => {
  const { mp, calls } = glrFixture();
  const r = await mp.enhanceText("account:bigmodel-start-plan", "GLM-5.3-Flash", "写个脚本");
  assert.equal(r.ok, true, "enhance should succeed via session JWT: " + JSON.stringify(r).slice(0, 200));
  assert.equal(r.text, "glr 增强");
  assert.equal(calls.filter((c) => c.url.indexOf("/access_tokens") > 0).length, 0, "GLr exchange not used for zcode.z.ai route (its token is bigmodel.cn-scoped, 401s there)");
  const messages = calls.find((c) => c.url.indexOf("/v1/messages") > 0);
  assert.equal(messages.url, "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages", "runtime config is the authoritative route for start-plan");
  assert.equal(messages.opts.headers.Authorization, "Bearer zc-session-jwt-1", "session JWT auth (GLr/OAuth tokens 401 on zcode.z.ai)");
  assert.equal(messages.opts.headers["X-Device-Mid"], "dev-mid-1", "device mid is mandatory on zcode.z.ai");
  assert.equal(messages.opts.headers["User-Agent"], "ZCode");
  assert.equal(messages.opts.headers["anthropic-version"], "2023-06-01");
});

test("GLr: memo reuses token within TTL; oauth change forces re-exchange", async () => {
  const f = glrFixture();
  await f.mp.enhanceText("account:bigmodel-individual-coding-plan", "GLM-5.3-Flash", "第一次");
  await f.mp.enhanceText("account:bigmodel-individual-coding-plan", "GLM-5.3-Flash", "第二次");
  assert.equal(f.calls.filter((c) => c.url === GLR_EXCHANGE_URL).length, 1, "second enhance reuses memoized token");
  f.setOauthTag("2");
  const r3 = await f.mp.enhanceText("account:bigmodel-individual-coding-plan", "GLM-5.3-Flash", "第三次");
  assert.equal(r3.ok, true);
  assert.equal(f.calls.filter((c) => c.url === GLR_EXCHANGE_URL).length, 2, "oauth fingerprint change re-exchanges");
  const second = f.calls.filter((c) => c.url === GLR_EXCHANGE_URL)[1];
  assert.equal(second.opts.headers.Authorization, "Bearer glr-oauth-2");
});

test("GLr: exchange failures fail closed to plan_auth with zero messages traffic", async () => {
  for (const variant of [{ exchangeStatus: 404 }, { exchangeStatus: 401 }, { exchangeDisabled: true }, { exchangeBadShape: true }, { noLocation: true }]) {
    const f = glrFixture(variant);
    const r = await f.mp.enhanceText("account:bigmodel-individual-coding-plan", "GLM-5.3-Flash", "写个脚本");
    assert.equal(r.ok, false, JSON.stringify(variant));
    assert.equal(r.kind, "plan_auth", JSON.stringify(variant));
    assert.equal(f.calls.filter((c) => c.url.indexOf("/v1/messages") > 0).length, 0, "no messages call after exchange failure: " + JSON.stringify(variant));
    if (variant.exchangeStatus) assert.equal(f.exchangeDrops, 1, "non-ok exchange body cancelled: " + JSON.stringify(variant));
  }
  // zcode.z.ai 会话凭据缺失 + 无 location → plan_auth 零网络（无任何可换发凭据）
  for (const variant of [{ noSessionJwt: true, noLocation: true }, { noDeviceMid: true, noLocation: true }]) {
    const f = glrFixture(variant);
    const r = await f.mp.enhanceText("account:bigmodel-start-plan", "GLM-5.3-Flash", "写个脚本");
    assert.equal(r.ok, false, JSON.stringify(variant));
    assert.equal(r.kind, "plan_auth", JSON.stringify(variant));
    assert.equal(f.calls.length, 0, "zero network without session credential: " + JSON.stringify(variant));
  }
  // 会话凭据缺失但 location 在：GLr 直接改走表值路由（open.bigmodel.cn）为主路由 → 200
  const fAlt = glrFixture({ noSessionJwt: true });
  const rAlt = await fAlt.mp.enhanceText("account:bigmodel-start-plan", "GLM-5.3-Flash", "写个脚本");
  assert.equal(rAlt.ok, true, "session-less start-plan rides GLr on open.bigmodel.cn");
  const altMsg = fAlt.calls.find((c) => c.url.indexOf("/v1/messages") > 0);
  assert.equal(altMsg.url, "https://open.bigmodel.cn/api/anthropic/v1/messages", "table route is primary when no session cred");
  assert.equal(altMsg.opts.headers.Authorization, "Bearer glr-tok-1");
  assert.equal(fAlt.calls.filter((c) => c.url.indexOf("zcode.z.ai") > 0).length, 0, "zcode.z.ai never attempted without session cred");
  const fAlt2 = glrFixture({ noDeviceMid: true });
  const rAlt2 = await fAlt2.mp.enhanceText("account:bigmodel-start-plan", "GLM-5.3-Flash", "写个脚本");
  assert.equal(rAlt2.ok, true, "no device mid also rides GLr table route");
});

test("GLr: individual coding plan rides runtime route too; v2 entry key still wins without exchange (3.18 parity)", async () => {
  const a = glrFixture();
  const ra = await a.mp.enhanceText("account:bigmodel-individual-coding-plan", "GLM-5.3-Flash", "写个脚本");
  assert.equal(ra.ok, true);
  const ma = a.calls.find((c) => c.url.indexOf("/v1/messages") > 0);
  assert.equal(ma.url, "https://open.bigmodel.cn/api/anthropic/v1/messages");
  assert.equal(ma.opts.headers.Authorization, "Bearer glr-tok-1");
  const b = glrFixture({});
  fs.writeFileSync(path.join(b.dir, "config.json"), JSON.stringify({ provider: {
    "builtin:bigmodel-coding-plan": { options: { apiKey: "v2-entry-key" }, enabled: true },   // v2ConfigKey 同名条目（individual/team 共用）
  } }));
  const rb = await b.mp.enhanceText("account:bigmodel-individual-coding-plan", "GLM-5.3-Flash", "写个脚本");
  assert.equal(rb.ok, true);
  assert.equal(b.calls.filter((c) => c.url === GLR_EXCHANGE_URL).length, 0, "v2 key short-circuits exchange");
  const mb = b.calls.find((c) => c.url.indexOf("/v1/messages") > 0);
  assert.equal(mb.opts.headers.Authorization, "Bearer v2-entry-key");
});

test("GLr: runtime config missing falls back to table baseUrl; highest version dir wins", async () => {
  const a = glrFixture({ runtimeBase: false });
  const ra = await a.mp.enhanceText("account:bigmodel-individual-coding-plan", "GLM-5.3-Flash", "写个脚本");
  assert.equal(ra.ok, true);
  const ma = a.calls.find((c) => c.url.indexOf("/v1/messages") > 0);
  assert.equal(ma.url, "https://open.bigmodel.cn/api/anthropic/v1/messages");
  const b = glrFixture({ runtimeVersion: "3.18.0", startPlanBase: "https://open.bigmodel.cn/api/anthropic" });   // 两版本都官方域：本例只锁 semver 排序（review R2-A3）
  writeRuntimeBuiltin(b.dir, "3.19.1", "https://zcode.z.ai/api/v1/zcode-plan/anthropic");
  const rb = await b.mp.enhanceText("account:bigmodel-start-plan", "GLM-5.3-Flash", "写个脚本");
  assert.equal(rb.ok, true);
  const mb = b.calls.find((c) => c.url.indexOf("/v1/messages") > 0);
  assert.equal(mb.url, "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages", "highest version dir wins");
});

test("GLr: exchange respects external abort", async () => {
  const file = tmpCfgPath();
  fs.writeFileSync(file, JSON.stringify(sampleCfg()));
  const dir = path.dirname(file);
  fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify({ "oauth:bigmodel:access_token": "enc:oauth-1", [GLR_LOC_KEY]: "enc:loc-1" }));
  let releaseExchange;
  const gate = new Promise((resolve) => { releaseExchange = resolve; });
  const ctl = new AbortController();
  const impl = async (url, requestOpts) => {
    if (url === MODELS_DEV_TEST_URL) return { ok: false, status: 503, body: { cancel() { } } };
    if (url === GLR_EXCHANGE_URL) {
      await new Promise((resolve, reject) => {
        const sig = requestOpts.signal;
        if (sig.aborted) return reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
        sig.addEventListener("abort", () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" })), { once: true });
        gate.then(() => resolve({ ok: true, status: 200, text: async () => JSON.stringify({ code: 200, data: { enabled: true, token: "late" } }) }));
      });
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 200, data: { enabled: true, token: "late" } }) };
    }
    throw new Error("unexpected " + url);
  };
  const mp = M.createModelPuller({ customCfgPath: file, fetchImpl: impl, modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "", credentialsPath: path.join(dir, "credentials.json"), decryptValue: (enc) => (enc === "enc:loc-1" ? GLR_LOC_JSON : String(enc).indexOf("enc:oauth-") === 0 ? "glr-oauth-1" : null), hostVersion: "3.19.1" });
  const p = mp.enhanceText("account:bigmodel-start-plan", "GLM-5.3-Flash", "写个脚本", { signal: ctl.signal });
  await new Promise((r) => setTimeout(r, 30));
  ctl.abort();
  const r = await p;
  assert.equal(r.kind, "cancelled");
  releaseExchange();
});

test("GLr: host list gates by route — zcode.z.ai sync via session JWT, bigmodel.cn after memoized exchange", async () => {
  const f = glrFixture({});
  const before = f.mp.listEnhanceHosts().filter((h) => h.id.indexOf("bigmodel") >= 0).map((h) => h.id);
  assert.deepEqual(before, ["account:bigmodel-start-plan"], "zcode.z.ai route is sync-gated by session JWT+device mid");
  await f.mp.enhanceText("account:bigmodel-individual-coding-plan", "GLM-5.3-Flash", "预热换发");
  const after = f.mp.listEnhanceHosts().filter((h) => h.id.indexOf("bigmodel") >= 0).map((h) => h.id);
  assert.deepEqual(after, ["account:bigmodel-individual-coding-plan", "account:bigmodel-start-plan"], "individual appears after memoized exchange");
  const resolved = f.mp.resolveEnhanceHost("account:bigmodel-start-plan");
  assert.equal(resolved.plan, true);
  assert.equal(resolved.apiKey, "zc-session-jwt-1");   // 会话 JWT 进 host（主进程内，不回渲染端）
  // 无设备号：会话凭据不完整 → start-plan 不列（缺 X-Device-Mid 必被 3001 拒）
  fs.rmSync(path.join(f.dir, "telemetry-state.json"));
  assert.equal(f.mp.resolveEnhanceHost("account:bigmodel-start-plan"), null);
});

/* ---------- 第一轮 review 收口（A/B/D 三路 MINOR）：安全性质回归锁与边角 ---------- */

test("GLr security: hostile origin in location key name is rejected with zero network (review D-1/B-2)", async () => {
  for (const evil of ["https://evil.com", "https://bigmodel.cn.evil.com", "https://evil.com/bigmodel.cn", "https://bigmodel.cn@evil.com", "http://bigmodel.cn"]) {
    const file = tmpCfgPath();
    fs.writeFileSync(file, JSON.stringify(sampleCfg()));
    const dir = path.dirname(file);
    const evilKey = glrLocationKeyName(evil, "bigmodel", GLR_LOCATION_ACCOUNT, null, 1, "non-team");
    fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify({ "oauth:bigmodel:access_token": "enc:oauth-1", [evilKey]: "enc:loc-1" }));
    const calls = [];
    const mp = M.createModelPuller({ customCfgPath: file, fetchImpl: async (url, requestOpts) => { calls.push({ url, opts: requestOpts }); return sseRes(['data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}\n\n', 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n', 'data: {"type":"message_stop"}\n\n']); }, modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "", credentialsPath: path.join(dir, "credentials.json"), decryptValue: (enc) => (enc === "enc:loc-1" ? GLR_LOC_JSON : String(enc).indexOf("enc:oauth-") === 0 ? "glr-oauth-1" : null), hostVersion: "3.19.1" });
    const r = await mp.enhanceText("account:bigmodel-individual-coding-plan", "GLM-5.3-Flash", "写个脚本");
    assert.equal(r.ok, false, evil);
    assert.equal(r.kind, "plan_auth", evil);
    assert.equal(calls.length, 0, "zero outbound requests for hostile origin " + evil);
  }
});

test("GLr security: family/team/usageScene filters each reject decoy keys (review B-1/A-5/D-3)", async () => {
  const decoys = {
    family: glrLocationKeyName("https://bigmodel.cn", "othermodel", "999", null, 1, "non-team"),
    teamString: glrLocationKeyName("https://bigmodel.cn", "bigmodel", "999", "solo", 1, "non-team"),
    usageScene: glrLocationKeyName("https://bigmodel.cn", "bigmodel", "999", null, 2, "non-team"),
  };
  // 干扰键在前 + 解出不同三元组：若任一过滤被删，换发会打 org-bad 而非 org-9
  for (const [name, decoyKey] of Object.entries(decoys)) {
    const file = tmpCfgPath();
    fs.writeFileSync(file, JSON.stringify(sampleCfg()));
    const dir = path.dirname(file);
    fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify({
      [decoyKey]: "enc:loc-bad",
      [GLR_LOC_KEY]: "enc:loc-1",
      "oauth:bigmodel:access_token": "enc:oauth-1",
    }));
    const calls = [];
    const mp = M.createModelPuller({ customCfgPath: file, fetchImpl: async (url, requestOpts) => { calls.push({ url, opts: requestOpts }); return url === GLR_EXCHANGE_URL ? { ok: true, status: 200, text: async () => JSON.stringify({ code: 200, data: { enabled: true, token: "glr-tok-1" } }) } : sseRes(['data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}\n\n', 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n', 'data: {"type":"message_stop"}\n\n']); }, modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "", credentialsPath: path.join(dir, "credentials.json"), decryptValue: (enc) => (enc === "enc:loc-1" ? GLR_LOC_JSON : enc === "enc:loc-bad" ? JSON.stringify({ organizationId: "org-bad", projectId: "proj-bad", apiKeyId: "key-bad" }) : String(enc).indexOf("enc:oauth-") === 0 ? "glr-oauth-1" : null), hostVersion: "3.19.1" });
    const r = await mp.enhanceText("account:bigmodel-individual-coding-plan", "GLM-5.3-Flash", "写个脚本");
    assert.equal(r.ok, true, name);
    const exchange = calls.find((c) => c.url.indexOf("/access_tokens") > 0);
    assert.equal(exchange.url, GLR_EXCHANGE_URL, "decoy " + name + " must not be consumed");
  }
  // 仅 team 字符串键、无合规键：不消费、零网络（防御纵深，A-5/D-3）
  const file = tmpCfgPath();
  fs.writeFileSync(file, JSON.stringify(sampleCfg()));
  const dir = path.dirname(file);
  fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify({
    [decoys.teamString]: "enc:loc-1",
    "oauth:bigmodel:access_token": "enc:oauth-1",
  }));
  const calls = [];
  const mp = M.createModelPuller({ customCfgPath: file, fetchImpl: async (url, requestOpts) => { calls.push({ url }); return sseRes(['data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}\n\n', 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n', 'data: {"type":"message_stop"}\n\n']); }, modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "", credentialsPath: path.join(dir, "credentials.json"), decryptValue: (enc) => (enc === "enc:loc-1" ? GLR_LOC_JSON : String(enc).indexOf("enc:oauth-") === 0 ? "glr-oauth-1" : null), hostVersion: "3.19.1" });
  const r = await mp.enhanceText("account:bigmodel-individual-coding-plan", "GLM-5.3-Flash", "写个脚本");
  assert.equal(r.kind, "plan_auth");
  assert.equal(calls.length, 0, "string-team key must not be exchanged");
});

test("GLr: wrong envelope code with valid token stays plan_auth; padded token is trimmed (review B-3/B-4)", async () => {
  const bad = glrFixture({ exchangeBadCode: true });
  const rBad = await bad.mp.enhanceText("account:bigmodel-individual-coding-plan", "GLM-5.3-Flash", "写个脚本");
  assert.equal(rBad.ok, false);
  assert.equal(rBad.kind, "plan_auth");
  assert.equal(bad.calls.filter((c) => c.url.indexOf("/v1/messages") > 0).length, 0);
  const padded = glrFixture({ exchangeTokenPadded: true });
  const rPad = await padded.mp.enhanceText("account:bigmodel-individual-coding-plan", "GLM-5.3-Flash", "写个脚本");
  assert.equal(rPad.ok, true);
  const messages = padded.calls.find((c) => c.url.indexOf("/v1/messages") > 0);
  assert.equal(messages.opts.headers.Authorization, "Bearer glr-tok-1", "token trimmed before use");
});

test("GLr: expired memo drops the sync host list entry and forces re-exchange (review B-5/R2-B2)", async () => {
  const f = glrFixture({});
  await f.mp.enhanceText("account:bigmodel-individual-coding-plan", "GLM-5.3-Flash", "预热换发");
  assert.equal(f.mp.listEnhanceHosts().some((h) => h.id === "account:bigmodel-individual-coding-plan"), true);
  const realNow = Date.now;
  Date.now = () => realNow() + 11 * 60 * 1000;   // 前拨 11 分钟越过 10 分钟 TTL
  try {
    assert.equal(f.mp.listEnhanceHosts().some((h) => h.id === "account:bigmodel-individual-coding-plan"), false, "expired memo must not list the host");
    assert.equal(f.mp.listEnhanceHosts().some((h) => h.id === "account:bigmodel-start-plan"), true, "start-plan rides session JWT, unaffected by exchange memo TTL");
    const rExpired = await f.mp.enhanceText("account:bigmodel-individual-coding-plan", "GLM-5.3-Flash", "过期后重试");
    assert.equal(rExpired.ok, true);
    assert.equal(f.calls.filter((c) => c.url === GLR_EXCHANGE_URL).length, 2, "expired memo re-exchanges on the enhance path too");
  } finally {
    Date.now = realNow;
  }
});

test("GLr: zcode.z.ai 3012 (405) falls back to open.bigmodel.cn + GLr token (dual-route)", async () => {
  const f = glrFixture({ zcodeMessagesStatus: 405, zcodeMessagesBody: JSON.stringify({ code: 3012, msg: "This client is not supported. Please use the official ZCode client." }) });
  const r = await f.mp.enhanceText("account:bigmodel-start-plan", "GLM-5.3-Flash", "写个脚本");
  assert.equal(r.ok, true, "dual-route fallback succeeds: " + JSON.stringify(r).slice(0, 160));
  assert.equal(r.text, "glr 增强");
  const msgCalls = f.calls.filter((c) => c.url.indexOf("/v1/messages") > 0);
  assert.equal(msgCalls.length, 2, "primary zcode then fallback bigmodel.cn");
  assert.equal(msgCalls[0].url, "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages");
  assert.equal(msgCalls[0].opts.headers.Authorization, "Bearer zc-session-jwt-1");
  assert.equal(msgCalls[0].opts.headers["X-Device-Mid"], "dev-mid-1");
  assert.equal(msgCalls[1].url, "https://open.bigmodel.cn/api/anthropic/v1/messages");
  assert.equal(msgCalls[1].opts.headers.Authorization, "Bearer glr-tok-1", "fallback rides GLr token");
  assert.equal(msgCalls[1].opts.headers["X-Device-Mid"], undefined, "device mid is zcode.z.ai-only");
  assert.equal(f.calls.filter((c) => c.url.indexOf("/access_tokens") > 0).length, 1, "exchange fires once for the fallback leg");
});

test("GLr: dual-route with 1113 on fallback surfaces balance; double failure keeps primary path", async () => {
  const f = glrFixture({ zcodeMessagesStatus: 405, bigmodelMessagesStatus: 429, bigmodelMessagesBody: JSON.stringify({ error: { code: "1113", message: "[1113][余额不足或无可用资源包,请充值。]" } }) });
  const r = await f.mp.enhanceText("account:bigmodel-start-plan", "GLM-5.3-Flash", "写个脚本");
  assert.equal(r.ok, false);
  assert.equal(r.kind, "balance", "fallback 1113 is the actionable outcome for pure start-plan accounts");
  const f2 = glrFixture({ zcodeMessagesStatus: 405, bigmodelMessagesStatus: 400 });   // 400 非重试类：计数确定
  const r2 = await f2.mp.enhanceText("account:bigmodel-start-plan", "GLM-5.3-Flash", "写个脚本");
  assert.equal(r2.ok, false);
  assert.equal(r2.kind, "path", "double failure keeps the primary diagnostic");
  assert.equal(f2.calls.filter((c) => c.url.indexOf("/v1/messages") > 0).length, 2);
});

test("GLr: same-key envelope swap invalidates memo and re-exchanges to the new apiKeyId (review R2-B1)", async () => {
  const f = glrFixture();
  await f.mp.enhanceText("account:bigmodel-individual-coding-plan", "GLM-5.3-Flash", "第一次");
  assert.equal(f.calls.filter((c) => c.url === GLR_EXCHANGE_URL).length, 1);
  // 宿主同键名重发 location（换 apiKeyId）：信封串变化即失效，重换发打新 key
  f.setLocEnvelope("enc:loc-2");
  const r2 = await f.mp.enhanceText("account:bigmodel-individual-coding-plan", "GLM-5.3-Flash", "第二次");
  assert.equal(r2.ok, true);
  const exchanges = f.calls.filter((c) => c.url.indexOf("/access_tokens") > 0);
  assert.equal(exchanges.length, 2, "envelope swap re-exchanges");
  assert.equal(exchanges[1].url, "https://bigmodel.cn/api/biz/v1/organization/org-9/projects/proj-8/api_keys/key-8/access_tokens", "new apiKeyId rides the re-exchange");
});

test("GLr: foreign-platform runtime dirs are ignored (review B-6)", async () => {
  const foreign = GLR_RUNTIME_DIR === "windows-x86_64" ? "linux-x86_64" : "windows-x86_64";
  const file = tmpCfgPath();
  fs.writeFileSync(file, JSON.stringify(sampleCfg()));
  const dir = path.dirname(file);
  fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify({ "oauth:bigmodel:access_token": "enc:oauth-1", [GLR_LOC_KEY]: "enc:loc-1" }));
  const foreignDir = path.join(dir, "runtime", "provider", foreign, "9.9.9", "endpoint-zzz");
  fs.mkdirSync(foreignDir, { recursive: true });
  /* 干扰数据用白名单内官方域（仅路径不同）：本例只锁平台前缀过滤，与白名单防线不混淆（review R2-A3） */
  fs.writeFileSync(path.join(foreignDir, "zcode-builtin.json"), JSON.stringify({ config: { providerConfigRules: { providerRules: [
    { providerId: "account:bigmodel-individual-coding-plan", config: { api: { type: "anthropic-messages", baseUrl: "https://zcode.z.ai/api/foreign-path" } } },
  ] } } }));
  writeRuntimeBuiltin(dir, "3.19.1", "https://zcode.z.ai/api/v1/zcode-plan/anthropic");
  const calls = [];
  const mp = M.createModelPuller({ customCfgPath: file, fetchImpl: async (url, requestOpts) => { calls.push({ url, opts: requestOpts }); return url === GLR_EXCHANGE_URL ? { ok: true, status: 200, text: async () => JSON.stringify({ code: 200, data: { enabled: true, token: "glr-tok-1" } }) } : sseRes(['data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}\n\n', 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n', 'data: {"type":"message_stop"}\n\n']); }, modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "", credentialsPath: path.join(dir, "credentials.json"), decryptValue: (enc) => (enc === "enc:loc-1" ? GLR_LOC_JSON : String(enc).indexOf("enc:oauth-") === 0 ? "glr-oauth-1" : null), hostVersion: "3.19.1" });
  const r = await mp.enhanceText("account:bigmodel-individual-coding-plan", "GLM-5.3-Flash", "写个脚本");
  assert.equal(r.ok, true);
  const messages = calls.find((c) => c.url.indexOf("/v1/messages") > 0);
  assert.equal(messages.url, "https://open.bigmodel.cn/api/anthropic/v1/messages", "own-platform dir wins; foreign dir ignored");
});

test("GLr security: runtime route baseUrl outside official domains falls back to table value (review D-1)", async () => {
  const file = tmpCfgPath();
  fs.writeFileSync(file, JSON.stringify(sampleCfg()));
  const dir = path.dirname(file);
  fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify({ "oauth:bigmodel:access_token": "enc:oauth-1", [GLR_LOC_KEY]: "enc:loc-1" }));
  const badDir = path.join(dir, "runtime", "provider", GLR_RUNTIME_DIR, "3.19.1", "endpoint-abc");
  fs.mkdirSync(badDir, { recursive: true });
  fs.writeFileSync(path.join(badDir, "zcode-builtin.json"), JSON.stringify({ config: { providerConfigRules: { providerRules: [
    { providerId: "account:bigmodel-individual-coding-plan", config: { api: { type: "anthropic-messages", baseUrl: "https://evil.com/api/anthropic" } } },
  ] } } }));
  const calls = [];
  const mp = M.createModelPuller({ customCfgPath: file, fetchImpl: async (url, requestOpts) => { calls.push({ url, opts: requestOpts }); return url === GLR_EXCHANGE_URL ? { ok: true, status: 200, text: async () => JSON.stringify({ code: 200, data: { enabled: true, token: "glr-tok-1" } }) } : sseRes(['data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}\n\n', 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n', 'data: {"type":"message_stop"}\n\n']); }, modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "", credentialsPath: path.join(dir, "credentials.json"), decryptValue: (enc) => (enc === "enc:loc-1" ? GLR_LOC_JSON : String(enc).indexOf("enc:oauth-") === 0 ? "glr-oauth-1" : null), hostVersion: "3.19.1" });
  const r = await mp.enhanceText("account:bigmodel-individual-coding-plan", "GLM-5.3-Flash", "写个脚本");
  assert.equal(r.ok, true);
  const messages = calls.find((c) => c.url.indexOf("/v1/messages") > 0);
  assert.equal(messages.url, "https://open.bigmodel.cn/api/anthropic/v1/messages", "evil runtime route rejected; table fallback used");
  assert.ok(!calls.some((c) => c.url.indexOf("evil.com") >= 0), "no request ever leaves to evil.com");
});

/* ---------- 合并后置 review（A/B/D 三路）收口：per-leg 脱敏、zcode 路由仅认会话 JWT、边界锁 ---------- */

test("R3-MAJOR: fallback-leg balance detail masks the GLr token actually sent (per-leg secret)", async () => {
  const f = glrFixture({ zcodeMessagesStatus: 405, bigmodelMessagesStatus: 429, bigmodelMessagesBody: JSON.stringify({ error: { code: "1113", message: "余额不足或无可用资源包 echo=glr-tok-1" } }) });
  const r = await f.mp.enhanceText("account:bigmodel-start-plan", "GLM-5.3-Flash", "写个脚本");
  assert.equal(r.ok, false);
  assert.equal(r.kind, "balance");
  assert.ok(r.detail && r.detail.indexOf("余额不足") >= 0, "upstream body rides detail");
  assert.equal(r.detail.indexOf("glr-tok-1"), -1, "fallback-leg token must be masked with its own secret");
  assert.equal(r.detail.indexOf("zc-session-jwt-1"), -1, "primary credential must not leak either");
});

test("R3: zcode route is session-JWT-only; v2 entry key never sent there (review A-MINOR-1)", async () => {
  // 会话可用：entry key 存在也不上 zcode 路由（无设备头的 entry key 恒 400 code 3001）
  const a = glrFixture({});
  fs.writeFileSync(path.join(a.dir, "config.json"), JSON.stringify({ provider: {
    "builtin:bigmodel-coding-plan": { options: { apiKey: "v2-entry-key" }, enabled: true },
  } }));
  const ra = await a.mp.enhanceText("account:bigmodel-start-plan", "GLM-5.3-Flash", "写个脚本");
  assert.equal(ra.ok, true);
  const msgA = a.calls.find((c) => c.url.indexOf("/v1/messages") > 0);
  assert.equal(msgA.url, "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages");
  assert.equal(msgA.opts.headers.Authorization, "Bearer zc-session-jwt-1", "session JWT wins on the zcode route even with an entry key");
  assert.equal(a.calls.filter((c) => c.url.indexOf("/access_tokens") > 0).length, 0, "no exchange needed on session route");
  // 会话不可用：entry key 迁移表值路由（open.bigmodel.cn 接受项目 key），零换发零 zcode 尝试
  const b = glrFixture({ noSessionJwt: true });
  fs.writeFileSync(path.join(b.dir, "config.json"), JSON.stringify({ provider: {
    "builtin:bigmodel-coding-plan": { options: { apiKey: "v2-entry-key" }, enabled: true },
  } }));
  const rb = await b.mp.enhanceText("account:bigmodel-start-plan", "GLM-5.3-Flash", "写个脚本");
  assert.equal(rb.ok, true);
  const msgB = b.calls.find((c) => c.url.indexOf("/v1/messages") > 0);
  assert.equal(msgB.url, "https://open.bigmodel.cn/api/anthropic/v1/messages", "entry key rides the table route when session is unavailable");
  assert.equal(msgB.opts.headers.Authorization, "Bearer v2-entry-key");
  assert.equal(b.calls.filter((c) => c.url.indexOf("zcode.z.ai") > 0).length, 0, "zcode route never attempted without a session credential");
  assert.equal(b.calls.filter((c) => c.url.indexOf("/access_tokens") > 0).length, 0, "entry key short-circuits exchange");
});

test("R3-RECIPE-1: enc:-shaped session JWT is never sent; fails closed to GLr/plan_auth", async () => {
  const file = tmpCfgPath();
  fs.writeFileSync(file, JSON.stringify(sampleCfg()));
  const dir = path.dirname(file);
  fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify({
    "oauth:bigmodel:access_token": "enc:oauth-1",
    "zcodejwttoken": "enc:v1:still.cipher.text",   // 敌意/双重包裹信封
    [GLR_LOC_KEY]: "enc:loc-1",
  }));
  writeRuntimeBuiltin(dir, "3.19.1", "https://zcode.z.ai/api/v1/zcode-plan/anthropic");   // 必须让 zcode 会话路由真被走到（review R2-B：缺此行锁空转）
  const calls = [];
  const mp = M.createModelPuller({ customCfgPath: file, fetchImpl: async (url, requestOpts) => { calls.push({ url, opts: requestOpts }); return url === GLR_EXCHANGE_URL ? { ok: true, status: 200, text: async () => JSON.stringify({ code: 200, data: { enabled: true, accessToken: "glr-tok-1" } }) } : sseRes(['data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}\n\n', 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n', 'data: {"type":"message_stop"}\n\n']); }, modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "", credentialsPath: path.join(dir, "credentials.json"), decryptValue: (enc) => (enc === "enc:loc-1" ? GLR_LOC_JSON : String(enc).indexOf("enc:oauth-") === 0 ? "glr-oauth-1" : null), hostVersion: "3.19.1" });
  const r = await mp.enhanceText("account:bigmodel-start-plan", "GLM-5.3-Flash", "写个脚本");
  assert.equal(r.ok, true, "migrates to GLr on the table route");
  const msgCalls = calls.filter((c) => c.url.indexOf("/v1/messages") > 0);
  assert.equal(msgCalls.length, 1);
  assert.equal(msgCalls[0].url, "https://open.bigmodel.cn/api/anthropic/v1/messages", "cipher JWT never rides the zcode route");
  assert.equal(msgCalls[0].opts.headers.Authorization, "Bearer glr-tok-1");
  assert.ok(!calls.some((c) => c.opts && c.opts.headers && String(c.opts.headers.Authorization || "").indexOf("enc:") === 0), "no envelope-shaped credential ever leaves");
  // 无 location 兜底：plan_auth 零网络（RECIPE-1 原形）
  fs.rmSync(path.join(dir, "credentials.json"));
  fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify({ "oauth:bigmodel:access_token": "enc:oauth-1", "zcodejwttoken": "enc:v1:still.cipher.text" }));
  const calls2 = [];
  const mp2 = M.createModelPuller({ customCfgPath: file, fetchImpl: async (url, requestOpts) => { calls2.push({ url }); return sseRes(['data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}\n\n', 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n', 'data: {"type":"message_stop"}\n\n']); }, modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "", credentialsPath: path.join(dir, "credentials.json"), decryptValue: (enc) => (String(enc).indexOf("enc:oauth-") === 0 ? "glr-oauth-1" : null), hostVersion: "3.19.1" });
  const r2 = await mp2.enhanceText("account:bigmodel-start-plan", "GLM-5.3-Flash", "写个脚本");
  assert.equal(r2.kind, "plan_auth");
  assert.equal(calls2.length, 0, "zero network with cipher JWT and no location");
});

test("R3-RECIPE-2: zcode 5xx stays on primary (retry semantics) without dual-route fallback", async () => {
  const f = glrFixture({ zcodeMessagesStatus: 502, bigmodelMessagesStatus: 401 });
  const r = await f.mp.enhanceText("account:bigmodel-start-plan", "GLM-5.3-Flash", "写个脚本");
  assert.equal(r.ok, false);
  assert.equal(r.kind, "server", "server-class primary failure retries in place, never engages the fallback");
  const msgCalls = f.calls.filter((c) => c.url.indexOf("/v1/messages") > 0);
  assert.equal(msgCalls.length, 2, "both attempts on the primary leg");
  assert.ok(msgCalls.every((c) => c.url.indexOf("zcode.z.ai") > 0), "no bigmodel.cn call for server-class failure");
});

test("R3-RECIPE-3: zcode 403 keeps primary diagnosis without fallback (401-only auth fallback)", async () => {
  const f = glrFixture({ zcodeMessagesStatus: 403 });
  const r = await f.mp.enhanceText("account:bigmodel-start-plan", "GLM-5.3-Flash", "写个脚本");
  assert.equal(r.ok, false);
  assert.equal(r.kind, "auth");
  assert.equal(f.calls.filter((c) => c.url.indexOf("/v1/messages") > 0).length, 1, "single call, no fallback for 403");
});

test("R3: fallback leg runs a single attempt (wall-clock bound)", async () => {
  const f = glrFixture({ zcodeMessagesStatus: 405, bigmodelMessagesStatus: 500 });
  const r = await f.mp.enhanceText("account:bigmodel-start-plan", "GLM-5.3-Flash", "写个脚本");
  assert.equal(r.ok, false);
  assert.equal(r.kind, "path", "double failure keeps the primary diagnostic");
  assert.equal(f.calls.filter((c) => c.url.indexOf("/v1/messages") > 0).length, 2, "primary 405 (1, non-retry) + fallback 500 (1, single-attempt cap); old code retried the 500 for 3");
});

test("R3: host-source direct path carries X-Device-Mid from the announced host (adjacent-MAJOR lock)", async () => {
  const f = glrFixture({});
  const host = f.mp.resolveEnhanceHost("account:bigmodel-start-plan");
  assert.equal(host.baseUrl, "https://zcode.z.ai/api/v1/zcode-plan/anthropic");
  assert.equal(host.deviceMid, "dev-mid-1", "session host announces its device mid");
  const r = await f.mp.enhanceText("enhance-custom", "GLM-5.3-Flash", "直连草稿", {
    enhanceProvider: { apiKey: host.apiKey, baseUrl: host.baseUrl, protocol: host.protocol, deviceMid: host.deviceMid },
  });
  assert.equal(r.ok, true, "direct path works on the zcode route: " + JSON.stringify(r).slice(0, 160));
  const msg = f.calls.find((c) => c.url.indexOf("/v1/messages") > 0);
  assert.equal(msg.url, "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages");
  assert.equal(msg.opts.headers.Authorization, "Bearer zc-session-jwt-1");
  assert.equal(msg.opts.headers["X-Device-Mid"], "dev-mid-1", "direct requests carry the announced device mid (was the 400 dead-end)");
});

/* ---------- issue #440：OAuth-only + Windows 增强链死路修复 ----------
 * 路径2：宿主「Coding Plan API-Key」登录规则的 access.type 是 zhipu-coding-plan-api-key
 * （宿主 schema 与 api-key 同型枚举、合并同分支处理），此前被「provider is not api-key type」
 * 拒之门外；路径3：宿主设置页添加的供应商只落 v2/config.json 的 provider.<id> 条目，
 * 不进 provider_config.json 规则——增强链此前一律 provider not found。 */

const ZHIPU_PLAN_RULE = {
  providerId: "bigmodel-api",
  providerName: "Coding Plan Key",
  config: {
    access: { type: "zhipu-coding-plan-api-key", apiKey: "zplan-key-1" },
    api: { baseUrl: "https://open.bigmodel.cn/api/anthropic", type: "anthropic-messages" },
  },
};

test("issue440: enc:-shaped rule key is refused before any request (review A-1/D-1)", async () => {
  const file = tmpCfgPath();
  const cfg = sampleCfg();
  cfg.config.providerConfigRules.providerRules.push({
    providerId: "cipher-plan-rule",
    providerName: "密文规则",
    config: {
      access: { type: "zhipu-coding-plan-api-key", apiKey: "enc:v1:cipher.text" },
      api: { baseUrl: "https://open.bigmodel.cn/api/anthropic", type: "anthropic-messages" },
    },
  });
  fs.writeFileSync(file, JSON.stringify(cfg));
  const calls = [];
  const mp = M.createModelPuller({
    customCfgPath: file,
    fetchImpl: async (url) => { calls.push(url); throw new Error("unexpected request " + url); },
    modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "",
  });
  const r = await mp.enhanceText("cipher-plan-rule", "glm-4.6", "写个脚本");
  assert.equal(r.ok, false);
  assert.equal(r.kind, "auth", "ciphertext rule key reports auth, never sent");
  assert.equal(mp.resolveEnhanceHost("cipher-plan-rule"), null, "ciphertext rule not listed / not direct-connectable");
  assert.equal(calls.length, 0, "zero network");
});

test("issue440: zhipu-coding-plan-api-key rule enhances with its own key/baseUrl", async () => {
  const file = tmpCfgPath();
  const cfg = sampleCfg();
  cfg.config.providerConfigRules.providerRules.push(ZHIPU_PLAN_RULE);
  fs.writeFileSync(file, JSON.stringify(cfg));
  const calls = [];
  const mp = M.createModelPuller({
    customCfgPath: file,
    fetchImpl: async (url, requestOpts) => {
      if (url === MODELS_DEV_TEST_URL) return { ok: false, status: 503, body: { cancel() { } } };
      calls.push({ url, opts: requestOpts });
      return sseRes([
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"润色"}}\n\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ]);
    },
    modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "",
  });
  const r = await mp.enhanceText("bigmodel-api", "glm-4.6", "写个脚本");
  assert.equal(r.ok, true, "coding-plan api-key rule enhances: " + JSON.stringify(r).slice(0, 160));
  assert.equal(calls[0].url, "https://open.bigmodel.cn/api/anthropic/v1/messages");
  assert.equal(calls[0].opts.headers["x-api-key"], "zplan-key-1");
  const host = mp.resolveEnhanceHost("bigmodel-api");
  assert.ok(host && host.apiKey === "zplan-key-1" && host.protocol === "anthropic-messages"
    && host.baseUrl === "https://open.bigmodel.cn/api/anthropic", "custom picker resolves the coding-plan rule");
  assert.ok(mp.listEnhanceHosts().some((h) => h.id === "bigmodel-api" && h.protocol === "anthropic-messages"),
    "host list surfaces the coding-plan rule");
});

test("issue440: unsupported access types stay rejected", async () => {
  const file = tmpCfgPath();
  const cfg = sampleCfg();
  cfg.config.providerConfigRules.providerRules.push({
    providerId: "oauth-plan",
    providerName: "OAuth 型",
    config: {
      access: { type: "zhipu-account", apiKey: "should-not-leave" },
      api: { baseUrl: "https://open.bigmodel.cn/api/anthropic", type: "anthropic-messages" },
    },
  });
  fs.writeFileSync(file, JSON.stringify(cfg));
  const calls = [];
  const mp = M.createModelPuller({
    customCfgPath: file,
    fetchImpl: async (url) => { calls.push(url); throw new Error("unexpected request " + url); },
    modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "",
  });
  const r = await mp.enhanceText("oauth-plan", "glm-4.6", "写个脚本");
  assert.equal(r.ok, false);
  assert.equal(r.kind, "provider", "zhipu-account (OAuth runtime exchange) stays out of the rule path");
  assert.equal(mp.resolveEnhanceHost("oauth-plan"), null);
  assert.equal(calls.length, 0, "zero network for unsupported access types");
});

const V2_FIXTURE_ENTRIES = {
  "11111111-2222-3333-4444-555555555555": { name: "宿主中转", kind: "openai-compatible", options: { apiKey: "sk-v2-1", baseURL: "https://v2.example.com/v1" } },
  "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee": { name: "宿主 anthropic", kind: "anthropic", options: { apiKey: "sk-v2-ant", baseURL: "https://v2ant.example.com" } },
  "cccccccc-dddd-eeee-ffff-000000000000": { name: "宿主 responses", kind: "openai", options: { apiKey: "sk-v2-resp", baseURL: "https://v2resp.example.com/v1" } },
  "dddddddd-eeee-ffff-0000-111111111111": { name: "禁用条目", kind: "openai-compatible", enabled: false, options: { apiKey: "sk-v2-off", baseURL: "https://off.example.com/v1" } },
  "eeeeeeee-ffff-0000-1111-222222222222": { name: "密文条目", kind: "openai-compatible", options: { apiKey: "enc:v1:cipher.text", baseURL: "https://cipher.example.com/v1" } },
  "ffffffff-0000-1111-2222-333333333333": { name: "缺地址", kind: "openai-compatible", options: { apiKey: "sk-v2-nobase" } },
  "00000000-1111-2222-3333-444444444444": { name: "空 key", kind: "openai-compatible", options: { apiKey: "   ", baseURL: "https://empty.example.com/v1" } },
  "00000000-1111-2222-3333-555555555555": { name: "缺 options", kind: "openai-compatible" },
  "00000000-1111-2222-3333-666666666666": { name: "未知协议 kind", kind: "gemini-cli", options: { apiKey: "sk-v2-unknown", baseURL: "https://unknown.example.com/v1" } },
  "00000000-1111-2222-3333-777777777777": { name: "缺 kind", options: { apiKey: "sk-v2-nokind", baseURL: "https://nokind.example.com/v1" } },
  "builtin:not-a-plan": { name: "builtin 命名空间", kind: "openai-compatible", options: { apiKey: "sk-v2-builtin", baseURL: "https://builtin.example.com/v1" } },
  "account:some-other-plan": { name: "account 命名空间", kind: "openai-compatible", options: { apiKey: "sk-v2-account", baseURL: "https://acct.example.com/v1" } },
  "custom-relay": { name: "v2 同 id 条目", kind: "openai-compatible", options: { apiKey: "sk-v2-dup", baseURL: "https://dup.example.com/v1" } },
  "disabled-relay": { name: "禁用规则同名条目", kind: "openai-compatible", options: { apiKey: "sk-v2-revive", baseURL: "https://revive.example.com/v1" } },
};

function writeV2Cfg(file) {
  fs.writeFileSync(path.join(path.dirname(file), "config.json"), JSON.stringify({ provider: V2_FIXTURE_ENTRIES }));
}

test("issue440: v2 config.json custom provider entries enhance via host kind mapping", async () => {
  const file = tmpCfgPath();
  const cfg = sampleCfg();
  cfg.config.providerConfigRules.providerRules.push({
    providerId: "disabled-relay",
    providerName: "已禁用规则",
    config: { enabled: false, access: { type: "api-key", apiKey: "sk-disabled" }, api: { baseUrl: "https://disabled.example.com", type: "openai-chat-completions" } },
  });
  fs.writeFileSync(file, JSON.stringify(cfg));
  writeV2Cfg(file);
  const calls = [];
  const mp = M.createModelPuller({
    customCfgPath: file,
    fetchImpl: async (url, requestOpts) => {
      if (url === MODELS_DEV_TEST_URL) return { ok: false, status: 503, body: { cancel() { } } };
      calls.push({ url, opts: requestOpts });
      if (url.indexOf("/chat/completions") > 0) return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "润色" } }] }) };
      if (url.indexOf("/responses") > 0) return { ok: true, status: 200, text: async () => JSON.stringify({ status: "completed", output_text: "resp 结果" }) };
      return sseRes([
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"流式"}}\n\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ]);
    },
    modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "",
  });
  const r = await mp.enhanceText("11111111-2222-3333-4444-555555555555", "gpt-4o", "写个脚本");
  assert.equal(r.ok, true, "openai-compatible entry rides chat-completions: " + JSON.stringify(r).slice(0, 160));
  assert.equal(calls[0].url, "https://v2.example.com/v1/chat/completions");
  assert.equal(calls[0].opts.headers.Authorization, "Bearer sk-v2-1");
  const r2 = await mp.enhanceText("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "glm-4.6", "写个脚本");
  assert.equal(r2.ok, true, "anthropic entry rides /v1/messages: " + JSON.stringify(r2).slice(0, 160));
  assert.ok(calls.some((c) => c.url === "https://v2ant.example.com/v1/messages"));
  const r3 = await mp.enhanceText("cccccccc-dddd-eeee-ffff-000000000000", "gpt-5.1", "写个脚本");
  assert.equal(r3.ok, true, "openai entry rides /responses (host j8c mapping): " + JSON.stringify(r3).slice(0, 160));
  assert.ok(calls.some((c) => c.url === "https://v2resp.example.com/v1/responses"));
  /* 未知 kind 与缺 kind 都按宿主 j8c 缺省落 chat-completions（review B 变异 M02 锁定） */
  const r4 = await mp.enhanceText("00000000-1111-2222-3333-666666666666", "gpt-4o", "写个脚本");
  assert.equal(r4.ok, true, "unknown kind falls back to chat-completions (host j8c default): " + JSON.stringify(r4).slice(0, 160));
  assert.ok(calls.some((c) => c.url === "https://unknown.example.com/v1/chat/completions"));
  const r5 = await mp.enhanceText("00000000-1111-2222-3333-777777777777", "gpt-4o", "写个脚本");
  assert.equal(r5.ok, true, "missing kind falls back to chat-completions: " + JSON.stringify(r5).slice(0, 160));
  assert.ok(calls.some((c) => c.url === "https://nokind.example.com/v1/chat/completions"));
  /* 规则与 v2 条目同 id 时规则优先（enhanceText 与列表两口一致） */
  const dup = await mp.enhanceText("custom-relay", "gpt-4o", "写个脚本");
  assert.equal(dup.ok, true);
  const dupCall = calls.find((c) => c.url === "https://relay.example.com/chat/completions");
  assert.ok(dupCall, "rule keeps its own endpoint when a v2 entry shares the id");
  assert.equal(dupCall.opts.headers.Authorization, "Bearer sk-secret-1", "rule key wins over the same-id v2 entry");
  /* 禁用规则不再挡在 v2 条目前面（review A-3：与 resolveEnhanceHost 同门） */
  const revived = await mp.enhanceText("disabled-relay", "gpt-4o", "写个脚本");
  assert.equal(revived.ok, true, "disabled rule gives way to the same-id v2 entry: " + JSON.stringify(revived).slice(0, 160));
  const revivedCall = calls.find((c) => c.url === "https://revive.example.com/v1/chat/completions");
  assert.ok(revivedCall, "v2 entry endpoint used");
  assert.equal(revivedCall.opts.headers.Authorization, "Bearer sk-v2-revive", "v2 entry key used, disabled rule key never sent");
  const before = calls.length;
  for (const id of ["dddddddd-eeee-ffff-0000-111111111111", "eeeeeeee-ffff-0000-1111-222222222222", "ffffffff-0000-1111-2222-333333333333", "00000000-1111-2222-3333-444444444444", "00000000-1111-2222-3333-555555555555", "builtin:not-a-plan", "account:some-other-plan", "no-such-entry"]) {
    const bad = await mp.enhanceText(id, "gpt-4o", "写个脚本");
    assert.equal(bad.ok, false, id + " must fail closed");
    assert.equal(bad.kind, "provider", id + " reports provider not found");
  }
  assert.equal(calls.length, before, "fail-closed entries never hit the network");
  const byId = new Map(mp.listEnhanceHosts().map((h) => [h.id, h]));
  assert.equal(byId.get("11111111-2222-3333-4444-555555555555").protocol, "openai-chat-completions");
  assert.equal(byId.get("11111111-2222-3333-4444-555555555555").name, "宿主中转");
  assert.equal(byId.get("cccccccc-dddd-eeee-ffff-000000000000").protocol, "openai-responses");
  assert.equal(byId.get("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee").protocol, "anthropic-messages");
  assert.equal(byId.get("00000000-1111-2222-3333-666666666666").protocol, "openai-chat-completions", "unknown kind lists as chat-completions");
  assert.equal(byId.get("00000000-1111-2222-3333-777777777777").protocol, "openai-chat-completions", "missing kind lists as chat-completions");
  assert.equal(byId.get("dddddddd-eeee-ffff-0000-111111111111"), undefined, "disabled entry not listed");
  assert.equal(byId.get("eeeeeeee-ffff-0000-1111-222222222222"), undefined, "cipher-key entry not listed");
  assert.equal(byId.get("ffffffff-0000-1111-2222-333333333333"), undefined, "baseURL-less entry not listed");
  assert.equal(byId.get("00000000-1111-2222-3333-444444444444"), undefined, "blank-key entry not listed");
  assert.equal(byId.get("00000000-1111-2222-3333-555555555555"), undefined, "options-less entry not listed");
  assert.equal(byId.get("builtin:not-a-plan"), undefined, "builtin: namespace stays with the plan chain");
  assert.equal(byId.get("account:some-other-plan"), undefined, "account: namespace stays with the plan chain (host B8c admission)");
  const dupHosts = mp.listEnhanceHosts().filter((h) => h.id === "custom-relay");
  assert.equal(dupHosts.length, 1, "rule and same-id v2 entry never list twice");
  assert.equal(dupHosts[0].name, "我的中转", "rule wins the listing");
  assert.equal(byId.get("disabled-relay").name, "已禁用规则", "disabled rule still lends its display name; endpoint comes from the v2 entry");
});

/* ---------- 团队套餐 PAT 三步换发（issue #442）：GLr location 只承载个人项目三元组
 * （键名 team===null），旧实现对团队 providerId 恒取个人凭据——团队会话增强打个人池，
 * 个人池无资源包即 1113。团队链=额度链同款三步换发（setting.json 选择 → getCustomerInfo
 * → api_keys 找 zcode-team-api-key → access_tokens 换 PAT），PAT 打 messages 端点。 */

const TEAM_ORG = "org-team-9";
const TEAM_PROJECT = "proj-team-8";
const TEAM_CUSTOMER_URL = "https://bigmodel.cn/api/biz/customer/getCustomerInfo";
const teamKeysUrlFor = (org, project) => "https://bigmodel.cn/api/biz/v1/organization/" + encodeURIComponent(org) + "/projects/" + encodeURIComponent(project) + "/api_keys";
const TEAM_KEYS_URL = teamKeysUrlFor(TEAM_ORG, TEAM_PROJECT);
const TEAM_PAT_URL = TEAM_KEYS_URL + "/tk-1/access_tokens";

function teamFixture(opts) {
  const o = opts || {};
  const file = tmpCfgPath();
  fs.writeFileSync(file, JSON.stringify(sampleCfg()));
  const dir = path.dirname(file);
  const coords = o.coords || { organizationId: TEAM_ORG, projectId: TEAM_PROJECT };
  const keysUrl = teamKeysUrlFor(coords.organizationId, coords.projectId);
  const patUrl = keysUrl + "/tk-1/access_tokens";
  const creds = {};
  creds["oauth:bigmodel:access_token"] = "enc:oauth-1";
  if (!o.noLocation) creds[GLR_LOC_KEY] = "enc:loc-1";   // 个人 location 在盘：团队链绝不能拿它换发
  fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify(creds));
  if (!o.noSelection) {
    fs.writeFileSync(path.join(dir, "setting.json"), JSON.stringify(
      o.selectionJson !== undefined ? o.selectionJson
        : o.legacyOnly
          ? { modelProviderFamilySelectedKeys: { bigmodel: "team-plan:builtin:bigmodel-coding-plan:团队显示:" + encodeURIComponent(coords.organizationId) + ":" + encodeURIComponent(coords.projectId) } }
          : { providerFamilyConnectionSelections: { bigmodel: { kind: "team-coding-plan", organizationId: coords.organizationId, projectId: coords.projectId } } }));
  }
  const calls = [];
  const sse = ['data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"team 增强"}}\n\n', 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n', 'data: {"type":"message_stop"}\n\n'];
  const impl = async (url, requestOpts) => {
    if (url === MODELS_DEV_TEST_URL) return { ok: false, status: 503, body: { cancel() { } } };
    calls.push({ url, opts: requestOpts });
    if (url === TEAM_CUSTOMER_URL) {
      if (o.customerStatus) return { ok: false, status: o.customerStatus, text: async () => "", body: { cancel() { } } };
      /* 超限载荷必须是合法 JSON（review round2-B A7）：非法体会被 JSON.parse 兜住，上限成为
       * plan_auth 与采信之间唯一屏障时，变异「上限放大/删除」才会红。 */
      if (o.customerHuge) return { ok: true, status: 200, text: async () => JSON.stringify({ code: 200, data: { organizations: o.customerOrgs || [{ organizationId: coords.organizationId, projects: [{ projectId: coords.projectId }] }], pad: "x".repeat(262145) } }) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 200, data: { organizations: o.customerOrgs || [{ organizationId: coords.organizationId, projects: [{ projectId: coords.projectId }] }] } }) };
    }
    if (url === keysUrl) {
      if (o.keysStatus) return { ok: false, status: o.keysStatus, text: async () => "", body: { cancel() { } } };
      if (o.keysHuge) return { ok: true, status: 200, text: async () => JSON.stringify({ code: 200, data: [{ name: "zcode-team-api-key", keyType: 2, apiKeyId: "tk-1", pad: "x".repeat(262145) }] }) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 200, data: o.teamKeys || [{ name: "zcode-team-api-key", keyType: 2, apiKeyId: "tk-1", apiKey: "id.secret" }] }) };
    }
    if (url === patUrl) {
      if (o.patStatus) return { ok: false, status: o.patStatus, text: async () => "", body: { cancel() { } } };
      if (o.patHuge) return { ok: true, status: 200, text: async () => JSON.stringify({ code: 200, msg: "操作成功", data: { enabled: true, accessToken: "team-pat-1", pad: "x".repeat(65537) } }) };
      if (o.patDisabled) return { ok: true, status: 200, text: async () => JSON.stringify({ code: 200, data: { enabled: false, accessToken: "x" } }) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 200, msg: "操作成功", data: { enabled: true, accessToken: "team-pat-1", expiresIn: o.patShortTtl ? 60 : undefined, expiresAt: o.patShortTtl ? undefined : Date.now() + 3600 * 1000 } }) };
    }
    if (url === GLR_EXCHANGE_URL) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 200, msg: "操作成功", data: { enabled: true, accessToken: "glr-tok-1" } }) };
    }
    if (url.indexOf("/v1/messages") > 0) return sseRes(sse);
    throw new Error("unexpected url " + url);
  };
  const mp = M.createModelPuller({
    customCfgPath: file, fetchImpl: impl, modelsDevUrl: MODELS_DEV_TEST_URL, modelsDevApiUrl: "",
    credentialsPath: path.join(dir, "credentials.json"), settingPath: path.join(dir, "setting.json"),
    decryptValue: (enc) => (enc === "enc:loc-1" ? GLR_LOC_JSON : String(enc).indexOf("enc:oauth-") === 0 ? "glr-oauth-1" : null),
    hostVersion: "3.19.1",
  });
  return { mp, calls, dir, keysUrl, patUrl };
}

test("Team: bigmodel team enhance exchanges the team PAT and rides it on open.bigmodel.cn", async () => {
  const f = teamFixture();
  const r = await f.mp.enhanceText("account:bigmodel-team-coding-plan", "GLM-5.3-Flash", "写个脚本");
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 200));
  assert.equal(r.text, "team 增强");
  assert.equal(f.calls.filter((c) => c.url === GLR_EXCHANGE_URL).length, 0, "individual GLr location never used for team");
  const msgs = f.calls.filter((c) => c.url.indexOf("/v1/messages") > 0);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].url, "https://open.bigmodel.cn/api/anthropic/v1/messages");
  assert.equal(msgs[0].opts.headers.Authorization, "Bearer team-pat-1");
  assert.equal(msgs[0].opts.headers["x-api-key"], "team-pat-1", "anthropic dual header like the individual GLr leg");
  /* 三步顺序与头形对齐额度链 ensureTeamPat（裸业务 token 查存在性、团队头列 key、Bearer 换 PAT） */
  const ci = f.calls.findIndex((c) => c.url === TEAM_CUSTOMER_URL);
  const ki = f.calls.findIndex((c) => c.url === TEAM_KEYS_URL);
  const pi = f.calls.findIndex((c) => c.url === TEAM_PAT_URL);
  assert.ok(ci >= 0 && ki > ci && pi > ki, "customer info -> api_keys -> access_tokens order");
  assert.equal(f.calls[ci].opts.headers.authorization, "glr-oauth-1", "bare business token on getCustomerInfo (quota chain parity)");
  assert.equal(f.calls[ki].opts.headers.authorization, "glr-oauth-1");
  assert.equal(f.calls[ki].opts.headers["Bigmodel-Organization"], TEAM_ORG);
  assert.equal(f.calls[ki].opts.headers["Bigmodel-Project"], TEAM_PROJECT);
  assert.equal(f.calls[pi].opts.method, "POST");
  assert.equal(f.calls[pi].opts.headers.Authorization, "Bearer glr-oauth-1");
  assert.deepEqual(JSON.parse(f.calls[pi].opts.body), { clientType: "zcode", clientVersion: "3.19.1" });
  assert.equal(f.mp.listEnhanceHosts().some((h) => /team/.test(h.id)), false, "team stays out of the sync host announcement list");
});

test("Team: v2 entry key is the individual project key and is never used for team enhance", async () => {
  const f = teamFixture();
  fs.writeFileSync(path.join(f.dir, "config.json"), JSON.stringify({ provider: {
    "builtin:bigmodel-coding-plan": { options: { apiKey: "v2-entry-key" }, enabled: true },
  } }));
  const r = await f.mp.enhanceText("account:bigmodel-team-coding-plan", "GLM-5.3-Flash", "写个脚本");
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 200));
  const msg = f.calls.find((c) => c.url.indexOf("/v1/messages") > 0);
  assert.equal(msg.opts.headers.Authorization, "Bearer team-pat-1", "shared entry key (individual pool) bypassed for team");
  assert.equal(f.calls.filter((c) => c.url === GLR_EXCHANGE_URL).length, 0, "individual GLr exchange never fires for team");
});

test("Team: PAT memo reused within expiry", async () => {
  const f = teamFixture();
  const r1 = await f.mp.enhanceText("account:bigmodel-team-coding-plan", "GLM-5.3-Flash", "第一次");
  assert.equal(r1.ok, true);
  const r2 = await f.mp.enhanceText("account:bigmodel-team-coding-plan", "GLM-5.3-Flash", "第二次");
  assert.equal(r2.ok, true);
  assert.equal(f.calls.filter((c) => c.url === TEAM_PAT_URL).length, 1, "second enhance reuses memoized PAT");
  assert.equal(f.calls.filter((c) => c.url === TEAM_CUSTOMER_URL).length, 1, "three-step chain not re-run either");
});

test("Team: PAT within the 2-minute refresh lead (or expired) forces re-exchange; expiresIn alias honored", async () => {
  /* 短 TTL 经 expiresIn 别名下发（60s < 120s lead）：变异「memo 去掉过期检查」在此变红
   * （review B-A4）——第二次 enhance 必须重跑三步链，否则过期 PAT 会被复用到 401。 */
  const f = teamFixture({ patShortTtl: true });
  const r1 = await f.mp.enhanceText("account:bigmodel-team-coding-plan", "GLM-5.3-Flash", "第一次");
  assert.equal(r1.ok, true);
  const r2 = await f.mp.enhanceText("account:bigmodel-team-coding-plan", "GLM-5.3-Flash", "第二次");
  assert.equal(r2.ok, true, JSON.stringify(r2).slice(0, 160));
  assert.equal(f.calls.filter((c) => c.url === TEAM_PAT_URL).length, 2, "PAT inside refresh lead re-exchanges");
});

test("Team: legacy modelProviderFamilySelectedKeys selection rides the same three-step chain", async () => {
  /* review A/D：额度链 teamSelectionOf 认 legacy 键——仅写旧键的宿主上额度 chip 显示团队
   * 额度，增强链不同门就会恒 plan_auth（两链读同一字段必须同口径）。 */
  const f = teamFixture({ legacyOnly: true });
  const r = await f.mp.enhanceText("account:bigmodel-team-coding-plan", "GLM-5.3-Flash", "写个脚本");
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 200));
  assert.equal(f.calls.filter((c) => c.url === TEAM_PAT_URL).length, 1);
  assert.equal(f.calls.find((c) => c.url.indexOf("/v1/messages") > 0).opts.headers.Authorization, "Bearer team-pat-1");
});

test("Team: org/project with reserved chars are percent-encoded into the api_keys URL", async () => {
  /* review B-D12：坐标进 URL path 前必须 encodeURIComponent——夹具按编码后 URL 桩定，
   * 生产编码不一致时请求落空（unexpected url → plan_auth），用例即红。 */
  const f = teamFixture({ coords: { organizationId: "org team/evil", projectId: "proj+域" } });
  const r = await f.mp.enhanceText("account:bigmodel-team-coding-plan", "GLM-5.3-Flash", "写个脚本");
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 200));
  assert.equal(f.keysUrl, "https://bigmodel.cn/api/biz/v1/organization/org%20team%2Fevil/projects/proj%2B%E5%9F%9F/api_keys");
  assert.ok(f.calls.some((c) => c.url === f.keysUrl), "encoded keys URL requested verbatim");
  assert.ok(f.calls.some((c) => c.url === f.patUrl), "encoded PAT URL requested verbatim");
});

test("Team: oversized step responses fail closed (size caps)", async () => {
  for (const variant of [{ customerHuge: true }, { keysHuge: true }, { patHuge: true }]) {
    const f = teamFixture(variant);
    const r = await f.mp.enhanceText("account:bigmodel-team-coding-plan", "GLM-5.3-Flash", "写个脚本");
    assert.equal(r.ok, false, JSON.stringify(variant));
    assert.equal(r.kind, "plan_auth", JSON.stringify(variant));
    assert.equal(f.calls.filter((c) => c.url.indexOf("/v1/messages") > 0).length, 0, "no messages after oversized body: " + JSON.stringify(variant));
  }
});

test("Team: fail-closed matrix — no selection/bad org/missing team key/pat failures all plan_auth with zero messages", async () => {
  for (const variant of [
    { noSelection: true },
    { selectionJson: {} },
    /* kind 判定的可观测变体必须带坐标（review B-A1：缺坐标时 org/project 门先拦，变异不可见） */
    { selectionJson: { providerFamilyConnectionSelections: { bigmodel: { kind: "individual-coding-plan", organizationId: TEAM_ORG, projectId: TEAM_PROJECT } } } },
    { selectionJson: { providerFamilyConnectionSelections: { bigmodel: { kind: "team-coding-plan", organizationId: "", projectId: TEAM_PROJECT } } } },
    { customerStatus: 404 },
    { customerOrgs: [{ organizationId: "other-org", projects: [{ projectId: TEAM_PROJECT }] }] },
    { customerOrgs: [{ organizationId: TEAM_ORG, projects: [{ projectId: "other-project" }] }] },
    { keysStatus: 500 },
    /* 形状错误条目复用 tk-1（review B-A3：不同 id 会被 URL 层 throw 掩盖选择层失效） */
    { teamKeys: [{ name: "other-key", keyType: 2, apiKeyId: "tk-1" }] },
    { teamKeys: [{ name: "zcode-team-api-key", keyType: 1, apiKeyId: "tk-1" }] },
    { teamKeys: [{ name: "zcode-team-api-key", keyType: 2 }] },
    { patStatus: 404 },
    { patDisabled: true },
  ]) {
    const f = teamFixture(variant);
    const r = await f.mp.enhanceText("account:bigmodel-team-coding-plan", "GLM-5.3-Flash", "写个脚本");
    assert.equal(r.ok, false, JSON.stringify(variant));
    assert.equal(r.kind, "plan_auth", JSON.stringify(variant));
    assert.equal(f.calls.filter((c) => c.url.indexOf("/v1/messages") > 0).length, 0, "no messages call after team chain failure: " + JSON.stringify(variant));
  }
});

test("Team: planGLrTokenOf hard-guards teamPat sources (defense-in-depth anchor)", () => {
  /* review B-B7：守卫行是闭包私有、公共面不可观测——用源码锚点锁「未来新增第二调用方
   * 也不会对团队源拿个人 location 换发」（构建产物是提交物，build_puller --check 保证分片一致）。 */
  const built = fs.readFileSync(path.join(__dirname, "..", "model-puller.cjs"), "utf8");
  const i = built.indexOf("async function planGLrTokenOf");
  assert.ok(i > 0, "planGLrTokenOf anchor");
  assert.match(built.slice(i, i + 400), /src\.teamPat/, "teamPat guard inside planGLrTokenOf");
});

test("Team: individual coding plan still rides its own GLr location on the same fixture", async () => {
  const f = teamFixture();
  const r = await f.mp.enhanceText("account:bigmodel-individual-coding-plan", "GLM-5.3-Flash", "写个脚本");
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 200));
  assert.equal(f.calls.filter((c) => c.url === GLR_EXCHANGE_URL).length, 1, "individual exchange fires for individual provider");
  assert.equal(f.calls.filter((c) => c.url === TEAM_CUSTOMER_URL).length, 0, "team chain never fires for individual provider");
  const msg = f.calls.find((c) => c.url.indexOf("/v1/messages") > 0);
  assert.equal(msg.opts.headers.Authorization, "Bearer glr-tok-1");
});
