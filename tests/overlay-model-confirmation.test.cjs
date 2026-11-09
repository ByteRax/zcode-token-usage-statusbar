"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { sliceOverlay } = require("./helpers/overlay-extract.cjs");

function decode(s) {
  return s.replace(/&(?:amp|lt|gt|quot|#39);/g, s => ({"&amp;":"&", "&lt;":"<", "&gt;":">", "&quot;":'"', "&#39;":"'"}[s]));
}
class Text {
  constructor(value) { this.nodeType = 3; this.nodeValue = value; this.parentElement = null; }
  get textContent() { return this.nodeValue; }
}
class Element {
  constructor(tag = "div") {
    this.tag = tag; this.nodeType = 1; this.attrs = {}; this.children = []; this.events = {};
    this.parentElement = null; this.disabled = false; this.checked = false;
    this.classList = {
      contains: s => this.className.split(/\s+/).includes(s),
      toggle: (s, on) => { const values = new Set(this.className.split(/\s+/).filter(Boolean)); on ? values.add(s) : values.delete(s); this.className = [...values].join(" "); },
    };
  }
  get className() { return this.attrs.class || ""; }
  set className(v) { this.attrs.class = v; }
  get isConnected() { return this.tag === "body" || !!(this.parentElement && this.parentElement.isConnected); }
  get firstChild() { return this.children[0] || null; }
  get lastChild() { return this.children[this.children.length - 1] || null; }
  get nextElementSibling() {
    if (!this.parentElement) return null;
    const es = this.parentElement.children.filter(x => x.nodeType === 1);
    return es[es.indexOf(this) + 1] || null;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === "checked") this.checked = true; }
  getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  appendChild(n) { if (n.parentElement) n.remove(); n.parentElement = this; this.children.push(n); return n; }
  insertBefore(n, other) { if (n.parentElement) n.remove(); n.parentElement = this; const i = this.children.indexOf(other); this.children.splice(i < 0 ? this.children.length : i, 0, n); }
  remove() { if (this.parentElement) { const p = this.parentElement; p.children.splice(p.children.indexOf(this), 1); this.parentElement = null; } }
  addEventListener(k, f) { (this.events[k] ||= []).push(f); }
  removeEventListener(k, f) { this.events[k] = (this.events[k] || []).filter(x => x !== f); }
  fire(k, target = this) { if (k === "click" && this.disabled) return; for (const f of this.events[k] || []) f({target, currentTarget:this, preventDefault(){}, stopPropagation(){}}); }
  querySelectorAll(s) {
    const matches = n => s.startsWith(".") ? n.classList.contains(s.slice(1)) : n.tag === s;
    const out = [];
    const walk = n => { for (const x of n.children) if (x.nodeType === 1) { if (matches(x)) out.push(x); walk(x); } };
    walk(this); return out;
  }
  querySelector(s) { return this.querySelectorAll(s)[0] || null; }
  get textContent() { return this.children.map(x => x.textContent).join(""); }
  set textContent(v) { this.children = []; if (v !== "") this.appendChild(new Text(String(v))); }
  set innerHTML(html) {
    this.children = [];
    const stack = [this];
    for (const token of html.match(/<[^>]*>|[^<]+/g) || []) {
      if (!token.startsWith("<")) { stack.at(-1).appendChild(new Text(decode(token))); continue; }
      if (token.startsWith("</")) { stack.pop(); continue; }
      const tag = /^<([\w-]+)/.exec(token)[1];
      const e = new Element(tag);
      const attrs = token.slice(tag.length + 1, -1);
      for (const m of attrs.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) e.setAttribute(m[1], decode(m[2] || ""));
      stack.at(-1).appendChild(e);
      if (!/^(input|br|img|hr|meta|link)$/.test(tag) && !token.endsWith("/>")) stack.push(e);
    }
  }
}
function harness(models, lang = "zh") {
  const body = new Element("body"), document = new Element("document"); document.body = body;
  document.createElement = tag => new Element(tag);
  let selected = "p1";
  const nav = new Element("button"); nav.setAttribute("data-testid", "model-provider-nav-item-custom:p1");
  const wrap = new Element("div"), host = new Element("button"); wrap.appendChild(host); body.appendChild(wrap);
  document.querySelectorAll = () => { nav.setAttribute("data-testid", "model-provider-nav-item-custom:" + selected); return [nav]; };
  document.querySelector = s => s.includes("model-provider-add-model-button") ? host : null;
  const timers = new Set(), records = [], snapshots = [];
  const sb = vm.createContext({
    document, window: {}, themeDark:true, mpModalDispose:null, mpModalThemeSync:null,
    disposed:false, inactive:() => sb.disposed,
    L:(zh,en) => lang === "en" ? en : zh,
    FATAL:{}, MY_GEN:1,
    setTimeout:(fn, delay) => { const t={fn, delay, unrefCount:0, unref(){this.unrefCount++;}}; timers.add(t); return t; },
    clearTimeout:t => timers.delete(t),
  });
  const protocol = sliceOverlay("  window.__zusagePluginRequests = [];", "  /* ---------- Git 状态 chip");
  const modal = sliceOverlay("    var mpModal = null, mpHostBtn = null;", "    /* 源列表按推送状态增量重建");
  vm.runInContext(protocol + "\n" + modal + "\nthis.api={open:openMpModal,close:cleanupMpModal,enhance:enhanceModelPuller,get:()=>mpModal};", sb);
  const push = sb.window.__zusagePluginRequests.push;
  sb.window.__zusagePluginRequests.push = function(...rs) { records.push(...rs); return push.apply(this,rs); };
  const provider = {id:"p1",name:"Provider one",modelIds:[]};
  sb.api.open(provider,models,{},false);
  const ov = sb.api.get();
  const q = s => ov.querySelector(s);
  const requests = action => records.filter(r => r.action === action);
  const reply = (req,result) => {
    snapshots.push({kind:"before-reply",action:req.action,fix:q(".zu-mp-fix").textContent,warn:q(".zu-mp-warn").textContent});
    sb.window.__zusagePluginResult({id:req.requestId,...result});
  };
  const set = (mid,value) => {
    const row=q(".zu-mp-items").querySelectorAll(".zu-mp-item").find(x=>x.getAttribute("data-mpid")===mid);
    const input=row.querySelector("input"); input.checked=value; q(".zu-mp-items").fire("change",input);
  };
  return {sb,ov,q,records,requests,reply,set,timers,snapshots,click:()=>q(".zu-mp-ok").fire("click"),switchProvider:id=>{selected=id;sb.api.enhance();}};
}

const ok = {ok:true,latencyMs:100,url:"https://relay.example/v1/chat/completions"};
const fail = {ok:false,kind:"bad_request",status:400,snippet:"invalid model"};

test("confirmation is single-flight and selection is locked while testing",()=>{
  const h=harness(["a","b","c","d","e"]); h.click(); h.click();
  assert.equal(h.q(".zu-mp-ok").disabled,true);
  assert.equal(h.requests("model-pull-probe").length,4);
  h.q(".zu-mp-none").fire("click"); h.set("a",false);
  assert.equal(h.q(".zu-mp-count").textContent,"已选中 5 / 5 个模型");
  h.reply(h.requests("model-pull-probe")[0],ok);
  assert.equal(h.requests("model-pull-probe").length,5);
  for(const r of h.requests("model-pull-probe").slice(1)) h.reply(r,ok);
  assert.equal(h.requests("model-pull-apply").length,1);
  h.reply(h.requests("model-pull-apply")[0],{ok:true});
  assert.equal(h.sb.api.get(),null); assert.equal(h.timers.size,0);
});

test("explicitly reselecting a failed model force-adds without another probe",()=>{
  for(const lang of ["zh","en"]){
    const h=harness(["bad"],lang); h.click(); h.reply(h.requests("model-pull-probe")[0],fail);
    assert.match(h.q(".zu-mp-err").textContent,/强制添加|force-add/);
    assert.equal(h.q(".zu-mp-ok").disabled,true);
    h.set("bad",true); h.click();
    assert.equal(h.requests("model-pull-probe").length,1);
    assert.equal(h.requests("model-pull-apply").length,1);
  }
});

test("bulk selection does not silently force failed models",()=>{
  const h=harness(["bad"]); h.click(); h.reply(h.requests("model-pull-probe")[0],fail);
  h.q(".zu-mp-all").fire("click"); h.click();
  assert.equal(h.requests("model-pull-probe").length,2);
  assert.equal(h.requests("model-pull-apply").length,0);
});

test("multiple unknown-action replies fall back to saving only once",()=>{
  const h=harness(["a","b","c","d","e"]); h.click();
  for(const r of [...h.requests("model-pull-probe")]) h.reply(r,{ok:false,error:"unknown action: model-pull-probe"});
  assert.equal(h.requests("model-pull-apply").length,1);
  assert.equal(h.requests("model-pull-probe").length,4);
});

test("close, replacement and dispose clear waits and suppress stale saves",()=>{
  for(const method of ["close","replace","dispose"]){
    const h=harness(["a","b","c","d","e"]); h.click();
    assert.ok([...h.timers].every(t=>t.unrefCount===1));
    if(method==="close") h.sb.api.close();
    else if(method==="replace") h.sb.api.open({id:"p2",name:"Provider two",modelIds:[]},["new"],{},false);
    else {h.sb.disposed=true;h.sb.mpModalDispose();}
    assert.equal(h.timers.size,0);
    for(const r of [...h.requests("model-pull-probe")]) h.reply(r,ok);
    assert.equal(h.requests("model-pull-apply").length,0);
    assert.equal(h.requests("model-pull-probe").length,4);
  }
});

test("failed probes still disclose committed path and spec changes",()=>{
  for(const result of [{...fail,repaired:{from:"https://relay.example",to:"https://relay.example/v1"}},{...fail,kind:"reasoning",specEnriched:["maxOutputTokens"]}]){
    const h=harness(["a"]); h.click(); h.reply(h.requests("model-pull-probe")[0],result);
    assert.match(h.q(".zu-mp-fix").textContent,/Base URL|规格补全/);
    assert.equal(h.q(".zu-mp-items").querySelector("input").checked,false);
  }
});

test("warnings and repairs remain visible until the user confirms the save",()=>{
  const h=harness(["a"]); h.click();
  h.reply(h.requests("model-pull-probe")[0],{...ok,repaired:{from:"https://relay.example",to:"https://relay.example/v1"},capabilitiesFixed:["image"],specEnriched:["contextWindow"],warnings:["toolHistory"]});
  assert.match(h.q(".zu-mp-fix").textContent,/能力匹配/);
  assert.match(h.q(".zu-mp-warn").textContent,/工具轮次可能失败/);
  assert.equal(h.requests("model-pull-apply").length,0);
  assert.equal(h.ov.isConnected,true);
  h.click(); assert.equal(h.requests("model-pull-apply").length,1);
  assert.equal(h.requests("model-pull-probe").length,1);
  h.reply(h.requests("model-pull-apply")[0],{ok:true});
  assert.equal(h.sb.api.get(),null);
});

test("25 models skip testing; 24 models preserve the four-request limit",()=>{
  const large=harness(Array.from({length:25},(_,i)=>"m"+i)); large.click();
  assert.equal(large.requests("model-pull-probe").length,0); assert.equal(large.requests("model-pull-apply").length,1);
  const edge=harness(Array.from({length:24},(_,i)=>"m"+i)); edge.click();
  assert.equal(edge.requests("model-pull-probe").length,4);
  assert.ok(edge.requests("model-pull-probe").every(r=>r.caps===true));
});
