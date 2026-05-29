import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const baseUrl = process.env.NOISE_HTTP_URL || 'http://localhost:3000';
const edgePath = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const viewport = { width: 390, height: 844 };
const runId = Date.now();

class CdpPage {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
    });

    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error('CDP WebSocket failed')), { once: true });
    });

    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 2,
      mobile: true
    });
    await this.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    this.ws.send(JSON.stringify({ id, method, params }));

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  async navigate(url) {
    await this.send('Page.navigate', { url });
    await this.waitFor('document.readyState === "complete" || document.readyState === "interactive"');
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'Runtime evaluation failed');
    }
    return result.result.value;
  }

  async waitFor(expression, timeoutMs = 5000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const ok = await this.eval(`Boolean(${expression})`);
      if (ok) return;
      await delay(80);
    }
    throw new Error(`Timed out waiting for ${expression}`);
  }

  async fill(selector, value) {
    await this.eval(`
      (() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        element.value = ${JSON.stringify(value)};
        element.dispatchEvent(new Event('input', { bubbles: true }));
      })()
    `);
  }

  async click(selector) {
    await this.eval(`
      (() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) throw new Error('Missing selector: ${selector}');
        element.click();
      })()
    `);
  }

  async screenshot(fileName) {
    const result = await this.send('Page.captureScreenshot', {
      format: 'png'
    });
    await fs.writeFile(path.join(root, fileName), Buffer.from(result.data, 'base64'));
  }

  close() {
    this.ws?.close();
  }
}

const browserA = await launchEdge(9331, `.edge-visual-${runId}-a`);
const browserB = await launchEdge(9332, `.edge-visual-${runId}-b`);

try {
  const pageA = await openCdpPage(9331);
  const pageB = await openCdpPage(9332);

  await pageA.navigate(baseUrl);
  await pageA.waitFor('document.querySelector("#nameInput")');
  await pageA.waitFor('document.querySelector("#createBtn") && !document.querySelector("#createBtn").disabled');
  await pageA.fill('#nameInput', 'Visual A');
  await pageA.click('#createBtn');
  await pageA.waitFor('document.querySelector("#copyCode")');

  const roomCode = await pageA.eval('document.querySelector("#copyCode").textContent.trim()');

  await pageB.navigate(`${baseUrl}?room=${roomCode}`);
  await pageB.waitFor('document.querySelector("#nameInput")');
  await pageB.waitFor('document.querySelector("#joinBtn") && !document.querySelector("#joinBtn").disabled');
  await pageB.fill('#nameInput', 'Visual B');
  await pageB.click('#joinBtn');

  await Promise.all([
    pageA.waitFor('document.querySelector(".rule-card")'),
    pageB.waitFor('document.querySelector(".rule-card")')
  ]);

  await pageA.screenshot('noise-game-mobile.png');

  await pageA.click('button[data-number="4"]');
  await pageB.click('button[data-number="8"]');
  await delay(120);
  await assertEnabledAfterPick(pageB, 'B');
  await pageB.click('#submitNumber');
  await delay(300);
  await assertEnabledAfterPick(pageA, 'A');
  await pageA.click('#submitNumber');

  await Promise.all([
    pageA.waitFor('document.querySelector("#submitNoise")'),
    pageB.waitFor('document.querySelector("#submitNoise")')
  ]);

  await pageA.eval(`
    (() => {
      const firstNoise = document.querySelector('button.noise-button:not(.none)');
      if (firstNoise) firstNoise.click();
    })()
  `);
  await pageA.click('#submitNoise');
  await pageB.click('#submitNoise');
  await pageA.waitFor('document.querySelector(".result-banner")');
  await delay(650);
  await pageA.screenshot('noise-result-mobile.png');

  const metrics = await pageA.eval(`JSON.stringify({
    width: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    result: document.querySelector('.result-title')?.textContent || ''
  })`);

  console.log(JSON.stringify({ roomCode, ...JSON.parse(metrics) }, null, 2));
  pageA.close();
  pageB.close();
} finally {
  browserA.kill();
  browserB.kill();
}

async function launchEdge(port, profileName) {
  const profilePath = path.join(root, profileName);
  await fs.mkdir(profilePath, { recursive: true });

  const child = spawn(edgePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profilePath}`,
    `--window-size=${viewport.width},${viewport.height}`,
    'about:blank'
  ], {
    detached: false,
    stdio: 'ignore'
  });

  await waitForDebugger(port);
  return child;
}

async function openCdpPage(port) {
  const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
  const pageTarget = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
  if (!pageTarget) throw new Error(`No page target on port ${port}`);

  const page = new CdpPage(pageTarget.webSocketDebuggerUrl);
  await page.connect();
  return page;
}

async function waitForDebugger(port) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    try {
      await fetchJson(`http://127.0.0.1:${port}/json/version`);
      return;
    } catch (error) {
      await delay(100);
    }
  }
  throw new Error(`Edge debugging port ${port} did not open`);
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function assertEnabledAfterPick(page, label) {
  const debug = JSON.parse(await page.eval(`JSON.stringify({
    submitDisabled: document.querySelector('#submitNumber')?.disabled ?? null,
    selectedCards: Array.from(document.querySelectorAll('.card-button.selected')).map((item) => item.textContent.trim()),
    status: document.querySelector('.status-line')?.textContent || '',
    action: document.querySelector('#submitNumber')?.textContent || ''
  })`));

  if (debug.submitDisabled) {
    throw new Error(`${label} submitNumber stayed disabled: ${JSON.stringify(debug)}`);
  }
}
