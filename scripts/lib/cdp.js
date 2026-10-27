// Drive a local Chrome over the DevTools protocol with no dependencies.
// Used for screenshots and the end-to-end test.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CANDIDATES = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

export function findChrome() {
  const bin = CANDIDATES.find((p) => fs.existsSync(p));
  if (!bin) throw new Error('Chrome not found. Set CHROME=/path/to/chrome.');
  return bin;
}

// headed: headless Chrome's fake microphone delivers silence, so audio tests
// run a normal window parked off-screen instead.
export async function launch({ args = [], headed = !!process.env.HEADED, port = 9300 + Math.floor(Math.random() * 500) } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'earshot-chrome-'));
  const proc = spawn(
    findChrome(),
    [
      ...(headed ? ['--window-position=-3000,-3000', '--window-size=420,900'] : ['--headless=new']),
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--ignore-certificate-errors',
      '--autoplay-policy=no-user-gesture-required',
      ...args,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let version;
  for (let i = 0; i < 100; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!version) throw new Error('Chrome did not start');

  const close = async () => {
    const exited = new Promise((r) => proc.once('exit', r));
    proc.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  return { port, close };
}

export async function openPage(port) {
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let id = 0;
  const waiting = new Map();
  const listeners = [];
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && waiting.has(msg.id)) {
      const { resolve, reject } = waiting.get(msg.id);
      waiting.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) {
      listeners.forEach((l) => l(msg));
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      waiting.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
    });

  await send('Page.enable');
  await send('Runtime.enable');

  const page = {
    send,
    on: (fn) => listeners.push(fn),
    async viewport(width, height, { dpr = 2, mobile = false, dark = false } = {}) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile });
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
    },
    async goto(url, settleMs = 400) {
      // Hash-only changes never fire a load event, so do not wait forever.
      const loaded = new Promise((r) => {
        const fn = (m) => m.method === 'Page.loadEventFired' && r();
        listeners.push(fn);
        setTimeout(r, 4000);
      });
      await send('Page.navigate', { url });
      await loaded;
      await new Promise((r) => setTimeout(r, settleMs));
    },
    async eval(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    async screenshot(file, { fullPage = false } = {}) {
      let clip;
      if (fullPage) {
        const m = await send('Page.getLayoutMetrics');
        clip = { x: 0, y: 0, width: m.cssContentSize.width, height: m.cssContentSize.height, scale: 1 };
      }
      const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage, ...(clip ? { clip } : {}) });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
    },
    async grantMic(origin) {
      await send('Browser.grantPermissions', { origin, permissions: ['audioCapture'] }).catch(() => {});
    },
    close: () => ws.close(),
  };
  return page;
}
