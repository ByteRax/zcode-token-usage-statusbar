/* CDP 9229 即时取证探针（QA 用，非分发清单成员）：读渲染端 sysmon 状态。
 * 用法：node cdp-probe.cjs [pageUrl片段]。Node ≥22 内置 WebSocket（EventTarget API），零依赖。 */
const http = require("http");
const want = process.argv[2] || "";
http.get("http://127.0.0.1:9229/json/list", (res) => {
  let buf = "";
  res.on("data", (c) => { buf += c; });
  res.on("end", () => {
    let pages;
    try { pages = JSON.parse(buf).filter((p) => p.type === "page"); }
    catch (e) { console.log("BAD_ENDPOINT", buf.slice(0, 80)); process.exit(1); }
    const page = want ? pages.find((p) => (p.url || "").includes(want)) : pages[0];
    if (!page) { console.log("NO_PAGE", pages.map((p) => (p.url || "").slice(0, 50))); process.exit(1); }
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: {
        expression: "JSON.stringify({gen: window.__zusageGen||null, ver: (window.__zusageDiag&&window.__zusageDiag.mount&&window.__zusageDiag.mount.version)||null, sysmonEntry: typeof window.__zusageSysmon, sysFrame: !!(window.__zusageDiag&&window.__zusageDiag.sysFrame), show: (function(){try{return !!JSON.parse(localStorage.getItem('zusage3.show')||'{}').sysmon}catch(e){return null}})(), url: location.href.slice(0,60)})",
        returnByValue: true } }));
    });
    ws.addEventListener("message", (ev) => {
      const d = JSON.parse(ev.data);
      if (d.id === 1) { console.log("RESULT", d.result && d.result.result && d.result.result.value); process.exit(0); }
    });
  });
}).on("error", (e) => { console.log("CDP_DOWN", e.message); process.exit(1); });
setTimeout(() => { console.log("TIMEOUT"); process.exit(1); }, 8000);
