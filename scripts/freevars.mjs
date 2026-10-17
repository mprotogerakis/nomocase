// Missing imports: esbuild bundles fine when a module uses a name it never imported (it becomes a global), and the
// error only shows when that code runs. Minifying renames every declared or imported name to a short one, so a long
// name still standing in the output (not after a dot, not an object key) is a global – unless it is a known one.
// Run by `npm run check`; exits 1 and names the identifiers when something is unknown.
import { build } from 'esbuild';

const KEYWORDS = `await async break case catch class const continue debugger default delete do else export extends false finally
  for function get if import in instanceof let new null of return set static super switch this throw true try typeof
  undefined var void while with yield from as`;
const GLOBALS = `globalThis window self document location navigator history console JSON Math Date Number String Boolean Array
  Object Promise Error TypeError RangeError SyntaxError RegExp Map Set WeakMap WeakSet Symbol BigInt Intl Reflect Proxy
  ArrayBuffer DataView Uint8Array Uint16Array Uint32Array Int8Array Int16Array Int32Array Float32Array Float64Array
  Uint8ClampedArray TextEncoder TextDecoder URL URLSearchParams Headers Request Response FormData Blob File FileReader
  ReadableStream WritableStream TransformStream CompressionStream DecompressionStream crypto fetch atob btoa
  structuredClone queueMicrotask setTimeout clearTimeout setInterval clearInterval performance alert confirm prompt
  addEventListener removeEventListener dispatchEvent Event CustomEvent HashChangeEvent scrollTo scrollY innerWidth
  localStorage sessionStorage PublicKeyCredential HTMLElement encodeURIComponent decodeURIComponent encodeURI decodeURI
  parseInt parseFloat isNaN isFinite NaN Infinity escape unescape Iterator AbortController AbortSignal WebSocket
  HTMLRewriter caches EventTarget DOMException MessageChannel requestAnimationFrame getComputedStyle matchMedia
  arguments constructor prototype Function`;
// object and class methods keep their names in the output (e.g. the Worker's fetch/scheduled/email handlers)
const METHODS = 'scheduled email toString toJSON valueOf then catch finally next return throw get set has';
const known = new Set(`${KEYWORDS} ${GLOBALS} ${METHODS}`.split(/\s+/).filter(Boolean));

const ENTRIES = [
  { entryPoints: ['src/worker.js'], platform: 'neutral', external: ['@simplewebauthn/*'] },
  { entryPoints: ['public/app.js'], platform: 'browser', external: ['./vendor/*'] }, // third-party code is not ours to check
];

// Code only: strings, template text, regular expressions and comments are blanked (a small lexer, enough for esbuild
// output). Template substitutions stay code.
function codeOnly(src) {
  let out = '', i = 0, last = '';
  const stack = []; // open template literals: brace depth inside their current ${…}
  const regexAllowed = () => !last || /[(,=:[!&|?{};+\-*%<>~^]$/.test(last) || /\b(return|typeof|case|in|of|delete|void|throw|new|else|do)$/.test(last);
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (stack.length && c === '}' && stack.at(-1) === 0) { stack.pop(); i++; out += ' '; i = template(i); continue; }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i = src.indexOf('*/', i + 2) + 2; continue; }
    if (c === '"' || c === "'") { i++; while (src[i] !== c) i += src[i] === '\\' ? 2 : 1; i++; out += ' 0 '; last = '0'; continue; }
    if (c === '`') { i = template(i + 1); continue; }
    if (c === '/' && regexAllowed()) {
      let inClass = false;
      for (i++; i < src.length && (src[i] !== '/' || inClass); i++) {
        if (src[i] === '\\') i++; else if (src[i] === '[') inClass = true; else if (src[i] === ']') inClass = false;
      }
      i++;
      while (/[a-z]/.test(src[i])) i++;
      out += ' 0 '; last = '0'; continue;
    }
    if (stack.length && c === '{') stack[stack.length - 1]++;
    if (stack.length && c === '}') stack[stack.length - 1]--;
    out += c; i++;
    if (!/\s/.test(c)) last = (last + c).slice(-12);
  }
  return out;
  // template text up to the closing backtick or the next ${ (then its expression is code again)
  function template(j) {
    while (j < src.length) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === '`') { out += ' 0 '; last = '0'; return j + 1; }
      if (src[j] === '$' && src[j + 1] === '{') { stack.push(0); out += ' '; last = '('; return j + 2; }
      j++;
    }
    return j;
  }
}

let problems = 0;
for (const entry of ENTRIES) {
  const { outputFiles } = await build({ ...entry, bundle: true, write: false, format: 'esm', minifyIdentifiers: true, logLevel: 'silent', outfile: 'out.js' });
  const code = codeOnly(outputFiles[0].text.replace(/^import\s*\{[^}]*\}\s*from\s*"[^"]*";?/gm, '').replace(/export\s*\{[^}]*\};?/g, ''));
  const unknown = new Map();
  for (const m of code.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const name = m[0], before = code.slice(Math.max(0, m.index - 3), m.index), after = code.slice(m.index + name.length).trimStart();
    if (name.length < 3 || known.has(name)) continue;
    if (/(?<!\.\.)\.\s*$/.test(before) || /\?\.$/.test(before)) continue; // property access (but not spread ...x)
    if (after.startsWith(':') && !after.startsWith('::')) continue; // object key (or label, or a ternary branch – rare)
    if (/^\(/.test(after) && /(?:[{},;]|\b(?:get|set|static|async))\s*$/.test(code.slice(Math.max(0, m.index - 8), m.index))) continue; // method
    unknown.set(name, (unknown.get(name) ?? 0) + 1);
  }
  if (unknown.size) {
    problems += unknown.size;
    console.error(`${entry.entryPoints[0]}: nicht deklariert/importiert? ${[...unknown.keys()].join(', ')}`);
  }
}
if (problems) process.exit(1);
console.log('free-variable check: ok');
