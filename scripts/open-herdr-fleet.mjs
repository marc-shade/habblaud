// Open the local fleet canvas from a Herdr panel, shortcut or terminal.
import { execFile } from 'node:child_process';
import { mkdir, lstat, realpath } from 'node:fs/promises';
import { connect } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const self = fileURLToPath(import.meta.url);
const viewer = await realpath(join(dirname(self), 'herdr-fleet.mjs'));
const root = dirname(dirname(viewer));
const fleetTab = 'Fleet office';
const agent = process.argv[2] || null;
const locked = process.argv[3] === '--locked';
const env = {
  ...process.env,
  PATH: [process.env.PATH, join(homedir(), '.local/bin')].filter(Boolean).join(':'),
};
const run = async (bin, args) =>
  (await execute(bin, args, { env, timeout: 15000, maxBuffer: 8 * 1024 * 1024 })).stdout;
const app = (command, args) => run('herdr-app', ['do', command, JSON.stringify(args)]);

async function inspect() {
  const { spaces } = JSON.parse(await run('herdr-app', ['ls']));
  const local = spaces.filter((space) => !space.machine);
  const panes = local.flatMap((space) =>
    space.tabs.flatMap((tab) => tab.terminals.map((pane) => ({ space, tab, pane }))),
  );
  const results = await Promise.all(
    panes.map(async (row) => {
      const address = row.pane.terminal;
      let term;
      try {
        term = JSON.parse(await run('hc', ['get', address, '--json']));
      } catch (error) {
        // A pane may have been removed after the app listed it. Surface all other Core errors.
        if (error.code !== 3) throw error;
        let detail;
        try {
          detail = JSON.parse(error.stderr).error;
        } catch {
          throw error;
        }
        if (detail?.kind === 'not_found' && detail.message === 'no terminal ' + JSON.stringify(address))
          return null;
        throw error;
      }
      const fg = term.foreground;
      let active = false;
      if (
        term.state === 'live' &&
        fg?.argv?.[1] &&
        basename(fg.argv[0]) === 'node' &&
        Number.isSafeInteger(fg.pid) &&
        fg.pid > 0
      ) {
        const entry = resolve(fg.cwd || term.cwd || '/', fg.argv[1]);
        active = entry === viewer || (await realpath(entry).catch(() => null)) === viewer;
      }
      const owned = term.labels?.['habblaud.fleet'] === viewer || term.argv?.includes(viewer);
      // An idle, directly owned login shell may be left after a Core restart.
      const resting =
        owned &&
        term.state === 'live' &&
        fg?.pid === term.pid &&
        ['sh', 'bash', 'zsh', 'fish', 'nu', 'dash', 'ksh'].includes(basename(fg.argv[0]).replace(/^-/, ''));
      return { ...row, active, resting, term };
    }),
  );
  return { local, results: results.filter(Boolean) };
}

async function navigate(pid) {
  const path = join(tmpdir(), 'habblaud-herdr-' + process.getuid() + '-' + pid + '.sock');
  const stat = await lstat(path);
  if (!stat.isSocket() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600)
    throw new Error('Fleet viewer control socket has unexpected ownership or permissions');
  await new Promise((resolve, reject) => {
    const socket = connect(path);
    const fail = (error) => {
      socket.destroy();
      reject(error);
    };
    let response = '';
    socket.setTimeout(15000, () => fail(new Error('The fleet viewer did not confirm navigation')));
    socket.on('error', fail);
    socket.on('end', () => reject(new Error('The fleet viewer closed before confirming navigation')));
    socket.on('connect', () => socket.write(JSON.stringify({ agent }) + '\n'));
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      response += chunk;
      if (response.length > 4096) return fail(new Error('Invalid fleet viewer response'));
      const end = response.indexOf('\n');
      if (end < 0) return;
      try {
        const reply = JSON.parse(response.slice(0, end));
        if (reply.ok === false && reply.reason === 'starting')
          throw Object.assign(new Error('Fleet canvas is still starting'), { code: 'VIEWER_STARTING' });
        if (reply.ok !== true) throw new Error(reply.error || 'Fleet navigation failed');
        socket.destroy();
        resolve();
      } catch (error) {
        fail(error);
      }
    });
  });
}

async function focus(row) {
  if (row.tab.settled) await app('tab.unsettle', { id: row.tab.id });
  await app('pane.focus', { pane: row.pane.pane });
}

async function open() {
  let { local, results } = await inspect();
  let live = results.find((row) => row.active && row.tab.active) || results.find((row) => row.active);
  let recovered;
  if (!live) {
    const argv = [process.execPath, viewer];
    recovered = results.find((row) => row.resting);
    if (recovered) {
      // Keep the managed tab ID and its recovered shell. Send nothing to shell input.
      await focus(recovered);
      await app('terminal.open', { place: 'right', folder: root, argv });
    } else {
      const space =
        local.find((s) => s.tabs.some((t) => t.name === 'Habblaud')) ||
        local.find((s) => s.active) ||
        local[0];
      if (space) await app('tab.new', { space: space.id, name: fleetTab, folder: root, argv });
      else await app('space.new', { machine: '', name: 'Habblaud', tab: fleetTab, folder: root, argv });
    }
    for (let n = 0; n < 30 && !live; n++) {
      await delay(200);
      live = (await inspect()).results.find((row) => row.active);
    }
    if (!live) throw new Error('Herdr opened a terminal, but the fleet viewer did not start');
  }
  // The foreground PID identifies the viewer even when another tab has the same name.
  for (let n = 0; ; n++) {
    try {
      await navigate(live.term.foreground.pid);
      break;
    } catch (error) {
      if (!['ENOENT', 'ECONNREFUSED', 'VIEWER_STARTING'].includes(error.code) || n >= 60) throw error;
      await delay(200);
    }
  }
  if (live.term.labels?.['habblaud.fleet'] !== viewer)
    await run('hc', ['label', live.pane.terminal, 'habblaud.fleet=' + viewer]);
  await focus(live);
  if (recovered && live.tab.id === recovered.tab.id) await app('pane.zoom', { pane: live.pane.pane });
  console.log(
    JSON.stringify({
      space: live.space.id,
      tab: live.tab.id,
      terminal: live.pane.terminal,
      pid: live.term.foreground.pid,
      agent,
    }),
  );
}

try {
  if (
    process.argv.length > (locked ? 4 : 3) ||
    (agent !== null && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}:[0-9a-f]{24}$/.test(agent))
  )
    throw new Error('Expected an optional local fleet agent ID');
  if (locked) await open();
  else if (
    process.platform === 'darwin' &&
    JSON.parse(await run('herdr-app', ['commands'])).some((command) => command.name === 'habblaud.open')
  ) {
    process.stdout.write(await app('habblaud.open', agent === null ? {} : { agent }));
  } else {
    // Serialize independent key, CLI and panel launches. Kernel locks release on exit.
    const mac = process.platform === 'darwin';
    const cache = process.env.XDG_CACHE_HOME || join(homedir(), mac ? 'Library/Caches' : '.cache');
    const dir = join(cache, 'habblaud');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const args = [
      ...(mac ? ['-k', '-t', '45'] : ['-w', '45']),
      join(dir, 'fleet-launch.lock'),
      process.execPath,
      self,
      agent || '',
      '--locked',
    ];
    const { stdout } = await execute(mac ? '/usr/bin/lockf' : 'flock', args, { timeout: 90000 });
    process.stdout.write(stdout);
  }
} catch (error) {
  console.error(error.stderr?.trim() || error.message);
  process.exitCode = 1;
}
