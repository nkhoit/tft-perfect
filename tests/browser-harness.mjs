import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  const found = candidates.find(candidate => fs.existsSync(candidate));
  assert.ok(found, 'Chrome is required for browser verification');
  return found;
}

export async function waitFor(check, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw lastError || new Error('Timed out waiting for browser state');
}

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    this.socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error('Chrome DevTools connection closed'));
      }
      this.pending.clear();
    });
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
  }

  call(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'Browser evaluation failed');
    }
    return result.result.value;
  }

  close() {
    this.socket.close();
  }
}

export async function launchBrowser() {
  const appPort = await freePort();
  const debugPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tftkit-chrome-'));
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const server = spawn(python, ['serve.py'], {
    cwd: ROOT,
    env: { ...process.env, TFT_PORT: String(appPort) },
    stdio: 'ignore',
  });
  await waitFor(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${appPort}/traits/`)).ok;
    } catch {
      return false;
    }
  });

  const chrome = spawn(chromePath(), [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'ignore' });
  const target = await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const targets = await response.json();
      return targets.find(entry => entry.type === 'page');
    } catch {
      return null;
    }
  });
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.call('Page.enable');
  await cdp.call('Runtime.enable');
  return {
    appPort,
    cdp,
    async cleanup() {
      try {
        await Promise.race([
          cdp.call('Browser.close'),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Browser close timed out')), 2000)),
        ]);
      } catch {
        if (!chrome.killed) chrome.kill();
      }
      cdp.close();
      await Promise.race([
        new Promise(resolve => chrome.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 3000)),
      ]);
      if (!server.killed) server.kill();
      await Promise.race([
        new Promise(resolve => server.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 1000)),
      ]);
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          fs.rmSync(profile, { recursive: true, force: true });
          break;
        } catch (error) {
          if (attempt === 9) throw error;
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }
    },
  };
}

export async function loadExplorer(session) {
  await session.cdp.call('Page.navigate', {
    url: `http://127.0.0.1:${session.appPort}/traits/`,
  });
  try {
    await waitFor(() => session.cdp.evaluate(
      `Boolean(document.querySelector('#list .comp .upgradepath:not(:disabled)'))`));
  } catch (error) {
    const state = await session.cdp.evaluate(`({
      status: document.querySelector('#status')?.textContent,
      count: document.querySelectorAll('#list .comp').length,
      searchUtils: typeof SearchUtils,
      scheduler: typeof SolverScheduler,
      version: typeof SearchUtils === 'object' ? SearchUtils.algorithmVersion : null,
      body: document.body?.innerText.slice(0, 500),
    })`);
    throw new Error(`${error.message}: ${JSON.stringify(state)}`);
  }
}
