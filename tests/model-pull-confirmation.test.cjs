"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const M = require("../model-puller.cjs");
const P = "review-provider", MID = "review-model";

function cfg({ base = "https://old.example.invalid/v1", declared = true, config = { enabled: true } } = {}) {
  return { config: { providerConfigRules: { providerRules: [{ providerId: P, config: { access: { type: "api-key", apiKey: "fake-review-key" }, api: { type: "openai-chat-completions", baseUrl: base }, personalModelIds: declared ? [MID] : [], modelOrder: declared ? [MID] : [] } }] }, modelConfigRules: { manualProviderModelRules: [], providerModelRules: declared ? [{ providerId: P, modelId: MID, config }] : [] } } };
}
function setup(t, data, fetchImpl, extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-confirm-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "provider_config.json");
  fs.writeFileSync(file, JSON.stringify(data));
  return { file, read: () => JSON.parse(fs.readFileSync(file, "utf8")), write: d => fs.writeFileSync(file, JSON.stringify(d)), mp: M.createModelPuller({ customCfgPath: file, fetchImpl, modelsDevUrl: "", modelsDevApiUrl: "", ...extra }) };
}
const good = () => ({ ok: true, status: 200, body: { cancel() {} } });
const bad = (status, text) => ({ ok: false, status, text: async () => text });
const rule = data => data.config.modelConfigRules.providerModelRules.find(r => r.providerId === P && r.modelId === MID).config;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };

test("probe refuses credential redirects for every supported protocol", async t => {
  for (const type of ["openai-chat-completions", "openai-responses", "anthropic-messages"]) {
    const data = cfg(); data.config.providerConfigRules.providerRules[0].config.api.type = type;
    let leaked = false;
    const x = setup(t, data, async (url, opts) => {
      if (opts.redirect !== "error" && opts.redirect !== "manual") leaked = true;
      return bad(307, "redirect");
    });
    assert.equal((await x.mp.probeModel(P, MID)).ok, false);
    assert.equal(leaked, false);
  }
});

test("actual non-sk credentials are removed before errors reach the renderer", async t => {
  for (const key of ["fakeReviewJwtToken.abcdef1234.567890", "short", 'review"quoted\\key']) {
    const data = cfg(); data.config.providerConfigRules.providerRules[0].config.access.apiKey = key;
    const x = setup(t, data, async () => bad(401, JSON.stringify({ error: "Invalid API key: " + key })));
    const r = await x.mp.probeModel(P, MID);
    assert.equal(JSON.stringify(r).includes(key), false);
    assert.equal(r.snippet.includes(JSON.stringify(key).slice(1, -1)), false);
  }
});

test("late path repair cannot overwrite a changed provider or use its replacement key", async t => {
  const entered = deferred(), release = deferred(), seen = [];
  const x = setup(t, cfg({ base: "https://old.example.invalid" }), async (url, opts) => {
    seen.push({ url, auth: opts.headers.Authorization });
    if (url === "https://old.example.invalid/chat/completions") return bad(405, "wrong path");
    if (url === "https://old.example.invalid/v1/chat/completions") { entered.resolve(); await release.promise; }
    return good();
  });
  const pending = x.mp.probeModel(P, MID); await entered.promise;
  const next = x.read(), p = next.config.providerConfigRules.providerRules[0].config;
  p.api.baseUrl = "https://new.example.invalid/v1"; p.access.apiKey = "replacement-secret"; x.write(next);
  release.resolve(); const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(x.read().config.providerConfigRules.providerRules[0].config.api.baseUrl, p.api.baseUrl);
  await x.mp.probeModel(P, MID);
  assert.equal(seen.some(r => r.url.startsWith("https://old.example.invalid/") && r.auth === "Bearer replacement-secret"), false);
});

test("late reasoning repair preserves a user's in-flight edit", async t => {
  const entered = deferred(), release = deferred();
  const x = setup(t, cfg(), async (url, opts) => {
    const effort = JSON.parse(opts.body).reasoning_effort;
    if (effort === "none") return bad(400, "reasoning_effort must be one of: 'minimal', 'high'; found 'none'.");
    if (effort === "minimal") { entered.resolve(); await release.promise; }
    return good();
  });
  const pending = x.mp.probeModel(P, MID); await entered.promise;
  const next = x.read(); rule(next).optionSpecs = { reasoningLevel: { values: ["high"] } }; x.write(next);
  release.resolve(); await pending;
  assert.deepEqual(rule(x.read()).optionSpecs.reasoningLevel.values, ["high"]);
});

test("explicit reasoning mappings are not guessed using the built-in transform", async t => {
  const reasoning = { values: ["off", "on"], map: '{"reasoning_effort": reasoningLevel == "off" ? "none" : "high"}' };
  const x = setup(t, cfg({ config: { enabled: true, optionSpecs: { reasoningLevel: reasoning } } }), async (url, opts) => {
    const effort = JSON.parse(opts.body).reasoning_effort;
    return effort === undefined || ["none", "high"].includes(effort) ? good() : bad(400, "Invalid reasoning_effort");
  });
  assert.equal((await x.mp.probeModel(P, MID)).ok, true);
  assert.deepEqual(rule(x.read()).optionSpecs.reasoningLevel, reasoning);
});

test("supplier capability values outrank conflicting catalog values", async t => {
  const x = setup(t, cfg({ declared: false }), async url => ({ ...good(), json: async () => url === "https://catalog.example.invalid"
    ? { [MID]: { id: MID, structured_output: true, tool_call: false } }
    : { data: [{ id: MID, structured_output: false, tool_call: true }] } }), { modelsDevUrl: "https://catalog.example.invalid" });
  await x.mp.fetchModels(P); await x.mp.applyModels(P, [MID]);
  assert.notEqual(rule(x.read()).properties.supportsJsonSchemaOutput, true);
  assert.notEqual(rule(x.read()).properties.supportsToolCall, false);
});

test("explicit false metadata is not overridden by generic positive probes", async t => {
  let imageProbes = 0;
  const x = setup(t, cfg({ declared: false }), async (url, opts) => {
    if (url.endsWith("/models")) return { ...good(), json: async () => ({ data: [{ id: MID, input_modalities: ["text"], structured_output: false }] }) };
    const body = JSON.parse(opts.body);
    if (Array.isArray(body.messages?.[0]?.content)) imageProbes++;
    assert.equal(body.response_format, undefined);
    return good();
  });
  await x.mp.fetchModels(P); await x.mp.probeModel(P, MID, { caps: true }); await x.mp.applyModels(P, [MID]);
  assert.equal(imageProbes, 0);
  assert.equal(rule(x.read()).properties.inputFormat.supportsImage, false);
  assert.equal(rule(x.read()).properties.supportsJsonSchemaOutput, false);
});

test("verified path repair still backfills missing output limits", async t => {
  const x = setup(t, cfg({ base: "https://old.example.invalid" }), async url => {
    if (url.endsWith("/models")) return { ...good(), json: async () => ({ data: [{ id: MID, contextWindow: 1000000, maxOutputTokens: 65536 }] }) };
    return url === "https://old.example.invalid/chat/completions" ? bad(405, "wrong path") : good();
  });
  await x.mp.fetchModels(P); const r = await x.mp.probeModel(P, MID, { caps: true });
  assert.equal(r.ok, true); assert.equal(rule(x.read()).optionSpecs?.maxOutputTokens?.max, 65536);
});

test("cached specs cannot enrich a replacement provider endpoint", async t => {
  const x = setup(t, cfg(), async url => url.endsWith("/models")
    ? { ...good(), json: async () => ({ data: [{ id: MID, maxOutputTokens: 128000 }] }) } : good());
  await x.mp.fetchModels(P);
  const next = x.read(); next.config.providerConfigRules.providerRules[0].config.api.baseUrl = "https://new.example.invalid/v1"; x.write(next);
  await x.mp.probeModel(P, MID, { caps: true });
  assert.equal(rule(x.read()).optionSpecs?.maxOutputTokens?.max, undefined);
});

test("un-added capability updates retain the tool-history session marker", async t => {
  let hits = 0;
  const x = setup(t, cfg({ declared: false }), async (url, opts) => {
    if (url.endsWith("/models")) return { ...good(), json: async () => ({ data: [MID] }) };
    if (JSON.parse(opts.body).tools) { hits++; return bad(400, "Invalid tool history"); }
    return good();
  });
  await x.mp.fetchModels(P);
  await x.mp.probeModel(P, MID, { caps: true }); await x.mp.probeModel(P, MID, { caps: true });
  assert.equal(hits, 1);
});

test("tool-history rate limiting is uncertain, not an incompatibility warning", async t => {
  let hits = 0;
  const x = setup(t, cfg(), async (url, opts) => {
    if (url.endsWith("/models")) return { ...good(), json: async () => ({ data: [MID] }) };
    if (JSON.parse(opts.body).tools) { hits++; return bad(429, "rate limit"); }
    return good();
  });
  await x.mp.fetchModels(P);
  assert.equal((await x.mp.probeModel(P, MID, { caps: true })).warnings, undefined);
  await x.mp.probeModel(P, MID, { caps: true }); assert.equal(hits, 2);
});

test("a failed model's shared path test cannot veto another model", async t => {
  const entered = deferred(), release = deferred();
  const x = setup(t, cfg({ base: "https://old.example.invalid" }), async (url, opts) => {
    const mid = JSON.parse(opts.body).model;
    if (url === "https://old.example.invalid/chat/completions") return bad(405, "path");
    if (mid === "missing") { entered.resolve(); await release.promise; return bad(404, "unknown model"); }
    return good();
  });
  const a = x.mp.probeModel(P, "missing"); await entered.promise;
  const b = x.mp.probeModel(P, MID); release.resolve();
  const results = await Promise.all([a, b]); assert.equal(results[1].ok, true);
});

test("disposed module ignores pending probe results", async t => {
  const entered = deferred(), release = deferred();
  const x = setup(t, cfg({ base: "https://old.example.invalid" }), async url => {
    if (url.endsWith("/v1/chat/completions")) { entered.resolve(); await release.promise; return good(); }
    return bad(405, "path");
  });
  const pending = x.mp.probeModel(P, MID); await entered.promise;
  assert.equal(typeof x.mp.dispose, "function"); x.mp.dispose(); release.resolve();
  assert.equal((await pending).ok, false);
  assert.equal(x.read().config.providerConfigRules.providerRules[0].config.api.baseUrl, "https://old.example.invalid");
});
