// Headless Chrome over the DevTools protocol for the browser tests (no test framework, no puppeteer).
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const sleep = ms => new Promise(r => setTimeout(r, ms));

// dialogs: every alert/confirm/prompt text (prompts with their default value), accepted automatically.
// errors: uncaught exceptions and console.error output of the page.
export async function openBrowser({ width = 1400, height = 1000, args = [], timeout = 60e3 } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'nomocase-chrome-'));
  const port = 9222 + Math.floor(Math.random() * 1000);
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run',
    `--window-size=${width},${height}`, ...args, 'about:blank'], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    target = (await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json()).catch(() => []))?.find(t => t.type === 'page');
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let seq = 0;
  const waiting = new Map(), dialogs = [], errors = [];
  // Every call has an answer within `timeout`, or the test fails naming it (a lost request must not hang the whole run).
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`${method}: keine Antwort nach ${timeout / 1000} s ${params.expression?.slice(0, 120) ?? ''}`)); }, timeout);
    waiting.set(id, m => { clearTimeout(timer); waiting.delete(id); if (m.error) reject(new Error(`${method}: ${m.error.message}`)); else resolve(m.result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.addEventListener('message', ({ data }) => {
    const m = JSON.parse(data);
    if (m.id) waiting.get(m.id)?.(m);
    if (m.method === 'Page.javascriptDialogOpening') {
      dialogs.push([m.params.message, m.params.defaultPrompt].filter(Boolean).join(' '));
      cdp('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); // the page may be navigating away already
    }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map(a => a.value ?? a.description).join(' '));
  });
  await cdp('Page.enable');
  await cdp('Runtime.enable');

  const evaluate = async expr => {
    const r = await cdp('Runtime.evaluate', { expression: `(async () => (${expr}))()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`evaluate: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  const waitFor = async (expr, what) => {
    for (let i = 0; i < 150; i++) { // 15 s: against production every step is a round trip to the EU database
      if (await evaluate(expr).catch(() => false)) return;
      await sleep(100);
    }
    throw new Error(`Timeout: ${what} (Dialoge: ${dialogs.join(' | ') || '–'}; Fehler: ${errors.join(' | ') || '–'})`);
  };
  return {
    cdp, evaluate, waitFor, dialogs, errors,
    click: selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`),
    navigate: url => cdp('Page.navigate', { url }),
    async setFile(selector, path) {
      const { root } = await cdp('DOM.getDocument');
      const { nodeId } = await cdp('DOM.querySelector', { nodeId: root.nodeId, selector });
      await cdp('DOM.setFileInputFiles', { nodeId, files: [path].flat() }); // one path or several
    },
    async close() {
      ws.close();
      const exited = new Promise(r => chrome.once('exit', r));
      chrome.kill();
      await exited;
      rmSync(profile, { recursive: true, force: true });
    },
  };
}
