import { hostname } from 'node:os';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createStaticHandler } from '../http/static';
import { createRequestGuard } from '../http/guard';
import { LineBuffer } from '../sources/tail';
import { parseFrame, Projection, type Peer } from './projection';

interface Target {
  name: string;
  node?: string;
  claudeHome?: string;
  codexHome?: string;
  agyLog?: string;
  agyBrain?: string;
}
const root = fileURLToPath(new URL('../../', import.meta.url));
const argv = parseArgs({
  options: { config: { type: 'string' }, local: { type: 'string' }, port: { type: 'string' } },
}).values;
const targets: Target[] = JSON.parse(readFileSync(argv.config || resolve(root, 'fleet.json'), 'utf8'));
const validName = (v: unknown) => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(v);
if (
  !Array.isArray(targets) ||
  !targets.length ||
  targets.some(
    (t) =>
      !t ||
      !validName(t.name) ||
      (t.node !== undefined && !/^\/[A-Za-z0-9_./+-]+$/.test(t.node)) ||
      [t.claudeHome, t.codexHome, t.agyLog, t.agyBrain].some(
        (v) => v !== undefined && (typeof v !== 'string' || !v.startsWith('/')),
      ),
  ) ||
  new Set(targets.map((t) => t.name)).size !== targets.length ||
  (argv.local && !targets.some((t) => t.name === argv.local))
)
  throw new Error('Invalid fleet inventory or local node name');
const port = Number(argv.port ?? 4749);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
const collector = readFileSync(resolve(root, 'dist/server/collector.js'));
const projection = new Projection();
const peers = new Map<string, Peer>();
const running = new Set<ChildProcessWithoutNullStreams>();
const clients = new Set<ServerResponse>();
const retries = new Set<NodeJS.Timeout>();
let stopping = false;
let snapshot = projection.build([]);
function publish() {
  snapshot = projection.build(peers.values());
  const message = 'event: snapshot\ndata: ' + JSON.stringify(snapshot) + '\n\n';
  for (const res of clients) {
    if (res.writableLength > 1024 * 1024) res.destroy();
    else res.write(message);
  }
}

function connect(target: Target, failures = 0) {
  if (stopping) return;
  const peer = peers.get(target.name)!;
  const { name, node, ...paths } = target;
  const encoded = Buffer.from(JSON.stringify(paths)).toString('base64');
  const local = name === (argv.local ?? hostname().split('.')[0]);
  const binary = node || (local ? process.execPath : 'node');
  const command = [binary, '--input-type=module', '-', encoded];
  const child = local
    ? spawn(binary, command.slice(1))
    : spawn('ssh', [
        '-T',
        '-o',
        'StrictHostKeyChecking=yes',
        '-o',
        'UpdateHostKeys=no',
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=7',
        '-o',
        'ServerAliveInterval=10',
        '-o',
        'ServerAliveCountMax=2',
        name,
        'exec ' + command.join(' '),
      ]);
  running.add(child);
  // SSH diagnostics may contain private local paths. Only connection state goes to the browser.
  child.stderr.resume();
  child.on('error', () => child.kill());
  child.stdin.on('error', () => child.kill());
  child.stdin.end(collector);
  const lines = new LineBuffer(4 * 1024 * 1024);
  let last = Date.now();
  let healthy = false;
  const watchdog = setInterval(() => {
    if (Date.now() - last > (healthy ? 20000 : 90000)) child.kill();
  }, 4000);
  child.stdout.on('data', (chunk: Buffer) => {
    try {
      const batch = lines.push(chunk);
      if (batch.discarded) throw new Error('Frame too large');
      for (const line of batch.lines) {
        const frame = parseFrame(line.toString());
        healthy = true;
        last = Date.now();
        peer.frame = frame;
        peer.status = { name, state: 'online', sources: frame.sources, lastSeen: last };
        publish();
      }
    } catch {
      child.kill();
    }
  });
  child.once('close', () => {
    clearInterval(watchdog);
    running.delete(child);
    delete peer.frame;
    peer.status = { ...peer.status, state: 'offline', sources: [] };
    publish();
    if (!stopping) {
      const next = healthy ? 0 : Math.min(failures + 1, 5);
      const timer = setTimeout(
        () => {
          retries.delete(timer);
          connect(target, next);
        },
        Math.min(30000, 1000 * 2 ** next),
      );
      retries.add(timer);
    }
  });
}
const staticFiles = createStaticHandler(resolve(root, 'dist/client'));
const guard = createRequestGuard();
const server = createServer((req, res) => {
  if (guard(req, res)) return;
  const route = (req.url || '/').split('?')[0];
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return;
  }
  if (route === '/api/snapshot' || route === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(route === '/api/health' ? { nodes: snapshot.nodes } : snapshot));
  } else if (route === '/api/stream' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    res.write('event: snapshot\ndata: ' + JSON.stringify(snapshot) + '\n\n');
    clients.add(res);
    res.once('close', () => clients.delete(res));
  } else if (route === '/' || route === '/fleet.html' || route.startsWith('/assets/') || route.startsWith('/bundle/')) {
    staticFiles(req, res, route === '/' ? '/fleet.html' : route);
  } else {
    res.writeHead(404);
    res.end();
  }
});
server.on('error', (e) => {
  console.error(e.message);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  console.log('Fleet office http://127.0.0.1:' + (typeof address === 'object' && address ? address.port : port));
  for (const t of targets)
    peers.set(t.name, { status: { name: t.name, state: 'connecting', sources: [], lastSeen: null } });
  publish();
  targets.forEach((t) => connect(t));
});
function stop() {
  stopping = true;
  retries.forEach(clearTimeout);
  running.forEach((c) => c.kill());
  clients.forEach((r) => r.end());
  server.close();
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
