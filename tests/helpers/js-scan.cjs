'use strict';
/* 轻量 JS 词法扫描（结构锁专用）：跳过注释、字符串、模板串与正则字面量，找出 `callee(` 调用并截出
 * 整个调用的源码文本。让「每个 fetch 调用都带某选项」这类结构锁不把注释里的字样当调用、
 * 也不漏掉同一行里字符串后面的调用。
 * 不是完整解析器：正则字面量按「前一个非空白字符」启发式识别（`(,=:[!&|?{};` 与运算符之后才可能是
 * 正则），`return /re/` 这类关键字后紧跟的正则会被当成除法——结构锁只需覆盖调用形代码。
 * 后缀自增/自减后的斜杠是除号（`i++ / 2`）：若当成正则起点，后面再没有斜杠就会把文件余下部分
 * 整个吞成「正则」，其后的调用全部漏扫（结构锁假绿）。 */

const REGEX_PRECEDERS = '(,=:[!&|?{};+-*%<>~^';

function callSites(src, callee) {
  const out = [];
  const size = src.length, len = callee.length;
  const stack = [];   // 未闭合的调用：{ site, depth }，depth=调用自身左括号之前的圆括号深度
  const templateBraces = [];   // 进入 `${` 时的花括号深度栈
  /* prev/prev2：最近两个非空白字符；prevAt/prev2At：它们的下标（相邻判断用） */
  let i = 0, state = 'code', prev = '', prev2 = '', prevAt = -2, prev2At = -3, braces = 0, parens = 0, inClass = false, line = 1;
  while (i < size) {
    const c = src[i], d = src[i + 1];
    if (c === '\n') line += 1;
    if (state === 'code') {
      if (c === '/' && d === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && d === '*') { state = 'block'; i += 2; continue; }
      if (c === "'" || c === '"') { state = c; i += 1; continue; }
      if (c === '`') { state = 'template'; i += 1; continue; }
      var incDec = (prev === '+' || prev === '-') && prev2 === prev && prevAt === prev2At + 1;   // ++ / --：后缀自增自减
      if (c === '/' && (prev === '' || (REGEX_PRECEDERS.includes(prev) && !incDec))) { state = 'regex'; inClass = false; i += 1; continue; }
      if (c === '{') braces += 1;
      else if (c === '}') {
        if (templateBraces.length && templateBraces[templateBraces.length - 1] === braces) {
          templateBraces.pop(); state = 'template'; prev = '}'; i += 1; continue;
        }
        braces -= 1;
      } else if (c === '(') parens += 1;
      else if (c === ')') {
        parens -= 1;
        const open = stack[stack.length - 1];
        if (open && parens === open.depth) { open.site.text = src.slice(open.site.index, i + 1); out.push(open.site); stack.pop(); }
      } else if (src.startsWith(callee, i) && !(src[i - 1] && /[\w$]/.test(src[i - 1])) && src[i + len] === '(') {
        stack.push({ site: { index: i, line: line, text: "" }, depth: parens });
        prev = ''; i += len; continue;   // 下一轮吃到左括号
      }
      if (!/\s/.test(c)) { prev2 = prev; prev2At = prevAt; prev = c; prevAt = i; }
      i += 1; continue;
    }
    if (state === 'line') { if (c === '\n') state = 'code'; i += 1; continue; }
    if (state === 'block') { if (c === '*' && d === '/') { state = 'code'; i += 2; } else i += 1; continue; }
    if (state === "'" || state === '"') {
      if (c === '\\') i += 2;
      else { if (c === state) { state = 'code'; prev = c; } i += 1; }
      continue;
    }
    if (state === 'regex') {
      if (c === '\\') i += 2;
      else if (inClass) { if (c === ']') inClass = false; i += 1; }
      else if (c === '[') { inClass = true; i += 1; }
      else { if (c === '/') { state = 'code'; prev = '/'; } i += 1; }
      continue;
    }
    /* template */
    if (c === '\\') i += 2;
    else if (c === '`') { state = 'code'; prev = '`'; i += 1; }
    else if (c === '$' && d === '{') { templateBraces.push(braces); state = 'code'; prev = '{'; i += 2; }
    else i += 1;
  }
  return out.sort((a, b) => a.index - b.index);
}

/* require("x") 的字符串字面量模块名（动态 require 不计） */
function requiredModules(src) {
  const names = [];
  for (const site of callSites(src, "require")) {
    const m = /^require\(\s*(["'])([^"']+)\1/.exec(site.text);
    if (m) names.push(m[2]);
  }
  return names;
}

module.exports = { callSites, requiredModules };
