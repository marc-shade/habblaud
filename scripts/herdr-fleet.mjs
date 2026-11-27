// Display the live fleet office in Herdr's Kitty-graphics terminal. The browser
// runs with an ephemeral profile and Playwright's private pipe; no debug port.
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, openSync, writeSync } from 'node:fs';
import { chmod } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { emitKeypressEvents } from 'node:readline';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const fleet = 'http://127.0.0.1:4749';
const arg = process.argv[2] || fleet + '/';
const target = new URL(arg);
if (target.origin !== fleet || target.pathname !== '/' || target.username || target.password)
  throw new Error('Expected the local Habblaud fleet URL');
target.searchParams.set('lang', 'en');
const input = process.stdin,
  output = process.stdout;
if (!input.isTTY || !output.isTTY) throw new Error('Open this program in a Herdr terminal');
const browserPath = [
  process.env.HABBLAUD_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].find((p) => p && existsSync(p));
if (!browserPath) throw new Error('A local Chromium browser is required');

const CSI = '\x1b[';
const ST = '\x1b\\';
const kitty = (p) => '\x1b_G' + p + ST;
let browser,
  page,
  context,
  stopped = false,
  activeId = 0,
  cols = 0,
  rows = 0,
  viewport,
  geometry,
  ready = false;
let previousHash = '',
  sequence = Promise.resolve(),
  carry = '',
  pressed = null,
  lastClick = null,
  pendingHover = null,
  immediate = true;
const buttonName = ['left', 'middle', 'right'];
const namedKeys = {
  return: 'Enter',
  enter: 'Enter',
  escape: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  tab: 'Tab',
  space: 'Space',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  insert: 'Insert',
};
// Node's stdout is synchronous on Unix terminals. A full PTY would block
// signals and control requests inside write(2). Open the same device with
// independent file flags so the parent shell keeps its normal settings.
const device = execFileSync('/usr/bin/tty', { stdio: [output.fd, 'pipe', 'pipe'], encoding: 'utf8' }).trim();
const ttyFd = openSync(device, constants.O_WRONLY | constants.O_NOCTTY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
const ttyStat = fstatSync(ttyFd);
if (!ttyStat.isCharacterDevice() || ttyStat.rdev !== fstatSync(output.fd).rdev) {
  closeSync(ttyFd);
  throw new Error('Could not reopen the fleet terminal');
}
let pendingWrite = Promise.resolve();
let terminalError;
let originalInputMode;
const inputMode = (...args) =>
  execFileSync('/bin/stty', args, { stdio: [input.fd, 'pipe', 'pipe'], encoding: 'utf8' }).trim();
async function writeTerminal(data, keepWriting) {
  const bytes = Buffer.from(data);
  let offset = 0;
  while (offset < bytes.length && keepWriting()) {
    try {
      offset += writeSync(ttyFd, bytes, offset, Math.min(16384, bytes.length - offset));
    } catch (error) {
      if (error.code === 'EINTR') continue;
      if (error.code !== 'EAGAIN' && error.code !== 'EWOULDBLOCK') throw error;
      await delay(8);
    }
  }
  return offset === bytes.length;
}
function write(data) {
  const next = pendingWrite.then(() => writeTerminal(data, () => !stopped));
  pendingWrite = next.catch((error) => {
    terminalError = error;
    stopped = true;
  });
  return next;
}
function enqueue(callback) {
  pendingHover = null;
  sequence = sequence
    .then(async () => {
      if (ready && !stopped) {
        await callback();
        immediate = true;
      }
    })
    .catch((e) => {
      if (!stopped) failure(e);
    });
}
function failure(e) {
  if (stopped) return;
  ready = false;
  previousHash = '';
  pendingHover = null;
  const reason = String(e.message || e)
    .split('\n')[0]
    .replace(/[^\x20-\x7e]/g, ' ')
    .slice(0, 100);
  if (activeId) void write(kitty('a=d,d=I,i=' + activeId + ',q=2'));
  activeId = 0;
  void write(CSI + 'H' + CSI + '2K' + 'Fleet connection interrupted. Reconnecting: ' + reason);
}
function resize() {
  const c = Math.max(2, output.columns || 80),
    r = Math.max(2, output.rows || 24);
  if (c !== cols || r !== rows) {
    cols = c;
    rows = r;
    geometry = null;
    previousHash = '';
    void write(CSI + '14t'); // Read pixel geometry from the terminal when supported.
  }
  const w = geometry?.w || c * 9,
    h = geometry?.h || r * 18;
  const scale = Math.min(1, 1920 / w, 1200 / h);
  viewport = { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}
function mouse(code, c, r, release) {
  if (!ready || !viewport) return;
  const x = Math.max(0, Math.min(viewport.width - 1, ((c - 0.5) * viewport.width) / cols));
  const y = Math.max(0, Math.min(viewport.height - 1, ((r - 0.5) * viewport.height) / rows));
  const b = code & 3;
  if ((code & 32) && !(code & 64) && b === 3) {
    // Only consecutive, unpressed motion can be replaced. Every other input
    // and IPC command is an ordering barrier, including a pending button press.
    if (pendingHover) {
      pendingHover.x = x;
      pendingHover.y = y;
    } else {
      const hover = { x, y };
      enqueue(async () => {
        if (pendingHover === hover) pendingHover = null;
        await page.mouse.move(hover.x, hover.y);
      });
      pendingHover = hover;
    }
    return;
  }
  const at = performance.now();
  enqueue(async () => {
    await page.mouse.move(x, y);
    if (pressed && Math.hypot(x - pressed.x, y - pressed.y) > 4) pressed.dragged = true;
    if (code & 64) {
      lastClick = null;
      await page.mouse.wheel(b >= 2 ? (b === 2 ? -75 : 75) : 0, b <= 1 ? (b === 0 ? -75 : 75) : 0);
    } else if (!(code & 32)) {
      if (release) {
        if (!pressed) return;
        await page.mouse.up({ button: pressed.button, clickCount: pressed.count });
        lastClick = !pressed.dragged && pressed.count === 1 ? { button: pressed.button, x, y, at } : null;
        pressed = null;
      } else if (buttonName[b]) {
        if (pressed) await page.mouse.up({ button: pressed.button, clickCount: pressed.count });
        const button = buttonName[b];
        const repeat = lastClick?.button === button && at - lastClick.at <= 500 &&
          Math.hypot(x - lastClick.x, y - lastClick.y) <= 4;
        lastClick = null;
        pressed = { button, count: repeat ? 2 : 1, x, y, dragged: false };
        await page.mouse.down({ button, clickCount: pressed.count });
      }
    }
  });
}
const keys = new PassThrough();
emitKeypressEvents(keys);
keys.on('keypress', (str, key) => {
  if (!key) return;
  if (key.ctrl && key.name === 'c') {
    stopped = true;
    return;
  }
  const name = namedKeys[key.name] || (/^f\d+$/i.test(key.name || '') ? key.name.toUpperCase() : key.name);
  if (!key.ctrl && !key.meta && str && [...str].every((ch) => ch >= ' ' && ch !== '\x7f')) {
    enqueue(() => page.keyboard.type(str));
    return;
  }
  if (!name) return;
  const parts = [
    ...(key.ctrl ? ['Control'] : []),
    ...(key.meta ? ['Alt'] : []),
    ...(key.shift ? ['Shift'] : []),
    name,
  ];
  enqueue(() => page.keyboard.press(parts.join('+')));
});
function receive(chunk) {
  carry += chunk;
  // Fragmented terminal replies, SGR pointer events and bracketed paste are common.
  while (carry) {
    const esc = carry.indexOf('\x1b');
    if (esc < 0) {
      keys.write(carry);
      carry = '';
      return;
    }
    if (esc > 0) {
      keys.write(carry.slice(0, esc));
      carry = carry.slice(esc);
      continue;
    }
    if (carry.startsWith(CSI + '200~')) {
      const end = carry.indexOf(CSI + '201~', 6);
      if (end < 0) return;
      const paste = carry.slice(6, end);
      enqueue(() => page.keyboard.insertText(paste));
      carry = carry.slice(end + 6);
      continue;
    }
    const match = /^\x1b\[<([0-9]+);([0-9]+);([0-9]+)([mM])/.exec(carry);
    if (match) {
      mouse(+match[1], +match[2], +match[3], match[4] === 'm');
      carry = carry.slice(match[0].length);
      continue;
    }
    const pixels = /^\x1b\[4;(\d+);(\d+)t/.exec(carry);
    if (pixels) {
      if (+pixels[1] > 0 && +pixels[2] > 0) geometry = { w: +pixels[2], h: +pixels[1] };
      carry = carry.slice(pixels[0].length);
      continue;
    }
    if (/^\x1b\[(?:<[0-9;]*|[0-9;]*)$/.test(carry)) return;
    const keyseq = /^\x1b(?:\[[0-9;]*[A-Za-z~]|O[A-Za-z]|.)?/s.exec(carry)[0];
    keys.write(keyseq);
    carry = carry.slice(keyseq.length);
  }
}
async function frame(bytes) {
  const hash = createHash('sha256')
    .update(bytes)
    .update(cols + ',' + rows)
    .digest('hex');
  if (hash === previousHash) return;
  const id = activeId === 71 ? 72 : 71;
  const data = bytes.toString('base64'),
    blocks = [CSI + '1;1H'];
  for (let at = 0; at < data.length; at += 4096) {
    const first = at === 0 ? 'a=T,f=100,t=d,q=2,C=1,i=' + id + ',p=1,c=' + cols + ',r=' + rows + ',' : '';
    blocks.push(kitty(first + 'm=' + (at + 4096 < data.length ? 1 : 0) + ';' + data.slice(at, at + 4096)));
  }
  if (activeId) blocks.push(kitty('a=d,d=I,i=' + activeId + ',q=2'));
  if (!(await write(blocks.join('')))) return;
  previousHash = hash;
  activeId = id;
}
async function connect() {
  if (!browser?.isConnected()) {
    browser = await chromium.launch({
      executablePath: browserPath,
      headless: true,
      args: ['--disable-background-networking', '--disable-component-update'],
    });
    context = null;
    page = null;
  }
  if (!context) {
    context = await browser.newContext({
      viewport,
      locale: 'en-US',
      serviceWorkers: 'block',
      acceptDownloads: false,
    });
    await context.route('**/*', (r) =>
      new URL(r.request().url()).origin === fleet ? r.continue() : r.abort(),
    );
    await context.routeWebSocket('**/*', (socket) => socket.close());
  }
  if (!page || page.isClosed()) {
    page = await context.newPage();
    page.on('popup', (p) => {
      void p.close().catch(failure);
    });
    page.on('crash', () => {
      void page.close().catch(failure);
      failure(new Error('The browser tab crashed'));
    });
    page.setDefaultTimeout(5500);
  }
  const response = await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 8000 });
  if (!response?.ok()) throw new Error('Fleet is unavailable');
  await page.locator('canvas').first().waitFor({ state: 'visible' });
  pressed = null;
  lastClick = null;
  pendingHover = null;
  ready = true;
  previousHash = '';
}
// A launcher that has positively identified this process may select a visible
// agent or Overview. The peer cannot supply a URL, browser command or script.
const socketPath = join(tmpdir(), 'habblaud-herdr-' + process.getuid() + '-' + process.pid + '.sock');
const clients = new Set();
const controls = createServer((socket) => {
  clients.add(socket);
  socket.once('close', () => clients.delete(socket));
  let request = '',
    received = false;
  socket.setEncoding('utf8');
  socket.setTimeout(8000, () => socket.destroy());
  socket.on('error', () => socket.destroy());
  socket.on('data', (chunk) => {
    if (received) return;
    request += chunk;
    if (request.length > 512) {
      socket.destroy();
      return;
    }
    if (!request.includes('\n')) return;
    received = true;
    const reply = (ok, reason) => socket.end(JSON.stringify({ ok, reason }) + '\n');
    let agent;
    try {
      ({ agent } = JSON.parse(request.trim()));
    } catch {
      reply(false);
      return;
    }
    if (
      agent !== null &&
      (typeof agent !== 'string' || !/^[a-zA-Z0-9._-]{1,128}:[a-f0-9]{24}$/.test(agent))
    ) {
      reply(false);
      return;
    }
    pendingHover = null;
    sequence = sequence
      .then(async () => {
        if (stopped) {
          reply(false);
          return;
        }
        if (!ready || !activeId) {
          reply(false, 'starting');
          return;
        }
        const selector = agent === null ? '#overview' : 'button[data-agent="' + agent + '"]';
        await page.locator(selector).click({ timeout: 2000 });
        if (agent === null) target.searchParams.delete('agent');
        else target.searchParams.set('agent', agent);
        immediate = true;
        reply(true);
      })
      .catch(() => reply(false));
  });
});
try {
  // Set owner-only access at bind time, before accepting a local client.
  const oldMask = process.umask(0o077);
  try {
    controls.listen(socketPath);
    await once(controls, 'listening');
  } finally {
    process.umask(oldMask);
  }
  await chmod(socketPath, 0o600);
  for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT'])
    process.on(sig, () => {
      stopped = true;
    });
  // libuv waits for pending terminal output in setRawMode(false). Restore
  // the exact input flags immediately even if the terminal stops consuming.
  originalInputMode = inputMode('-g');
  inputMode('raw', '-echo');
  input.setEncoding('utf8');
  input.on('data', receive);
  await write(
    CSI +
      '?1049h' +
      CSI +
      '?25l' +
      CSI +
      '?1003h' +
      CSI +
      '?1006h' +
      CSI +
      '?2004h' +
      CSI +
      '2J' +
      CSI +
      'H' +
      'Opening Habblaud fleet…',
  );
  resize();
  while (!stopped) {
    try {
      resize();
      if (!ready) await connect();
      const size = page.viewportSize();
      if (size.width !== viewport.width || size.height !== viewport.height)
        await page.setViewportSize(viewport);
      await frame(await page.screenshot({ type: 'png', timeout: 5000, scale: 'css' }));
      for (let i = 0; i < 8 && !stopped && !immediate; i++) await delay(50);
      immediate = false;
    } catch (e) {
      if (!stopped) {
        failure(e);
        await delay(1500);
      }
    }
  }
} finally {
  stopped = true;
  controls.close();
  for (const client of clients) client.destroy();
  input.pause();
  await pendingWrite;
  // A stop can interrupt a Kitty payload. End it before restoring the
  // screen, and give an undrained terminal a bounded opportunity to recover.
  const deadline = performance.now() + 250;
  try {
    if (originalInputMode) inputMode(...(process.platform === 'linux' ? ['-drain'] : []), originalInputMode);
    if (!terminalError) {
      const reset = ST + kitty('a=d,d=I,i=71,q=2') + kitty('a=d,d=I,i=72,q=2') +
        CSI + '?2004l' + CSI + '?1006l' + CSI + '?1003l' + CSI + '?25h' + CSI + '?1049l';
      await writeTerminal(reset, () => performance.now() < deadline);
    }
  } finally {
    closeSync(ttyFd);
    await browser?.close();
  }
  if (terminalError) throw terminalError;
}
