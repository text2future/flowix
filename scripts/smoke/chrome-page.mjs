// Layout fixtures need compositor frames. --dump-dom's virtual-time mode can
// advance timers without producing rAF/ResizeObserver callbacks, so these cases
// use a normal headless page via Chrome's built-in protocol, with no dependency.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function runRenderedPage(chrome, url, folder, budgetMs) {
  const profile = join(folder, 'chrome-profile');
  const child = spawn(chrome, [
    '--headless', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--no-default-browser-check', '--allow-file-access-from-files',
    '--disable-dev-shm-usage', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });
  let launchError;
  child.on('error', error => { launchError = error; });
  const exited = new Promise(resolve => child.once('exit', resolve));
  const deadline = Date.now() + budgetMs;
  let socket;
  const pending = new Map();
  const watchdog = setTimeout(() => {
    for (const request of pending.values()) request.reject(new Error('Chrome protocol timed out'));
    pending.clear();
    socket?.close();
    child.kill('SIGKILL');
  }, budgetMs);
  try {
    let port;
    while (!port && Date.now() < deadline) {
      if (launchError) throw launchError;
      if (child.exitCode !== null) throw new Error(`Chrome exited: ${child.exitCode}`);
      try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; }
      catch { await delay(50); }
    }
    if (!port) throw new Error('Chrome debugging port did not open');
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = pages.find(entry => entry.type === 'page');
    if (!page) throw new Error('Chrome page target missing');
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    let id = 0;
    const rejectPending = error => {
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    };
    socket.addEventListener('close', () => rejectPending(new Error('Chrome protocol connection closed')));
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const requestId = ++id;
      pending.set(requestId, { resolve, reject });
      socket.send(JSON.stringify({ id: requestId, method, params }));
    });
    const evaluate = async expression => {
      const response = await call('Runtime.evaluate', { expression, returnByValue: true });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
      return response.result.value;
    };
    await call('Page.enable');
    await call('Page.navigate', { url });
    while (Date.now() < deadline) {
      if (await evaluate('document.documentElement.dataset.smokeDone === "true"')) {
        return await evaluate('document.documentElement.outerHTML');
      }
      await delay(50);
    }
    throw new Error('Rendered page did not finish before its deadline');
  } finally {
    clearTimeout(watchdog);
    socket?.close();
    child.kill();
    if (child.pid) await exited;
  }
}
