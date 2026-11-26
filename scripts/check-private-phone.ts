import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request } from 'node:https';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { hashPassword } from '../server/remote/password';
import { ensureServerCert, tlsPaths } from '../server/remote/tls';

async function port(): Promise<number> {
  const socket = createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const address = socket.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((ok, fail) => socket.close(err => err ? fail(err) : ok()));
  return address.port;
}

async function main() {
  const home = await mkdtemp(join(tmpdir(), 'habblaud-tls-'));
  try {
    const tls = tlsPaths(join(home, 'tls'));
    ensureServerCert(tls, { ips: ['127.0.0.1'], dns: ['localhost'] });
    const password = randomBytes(32).toString('base64url');
    const remotePort = await port();
    let localPort = await port();
    while (localPort === remotePort) localPort = await port();
    const ca = await readFile(tls.caCert);
    const origin = 'https://127.0.0.1:' + remotePort;
    const office = spawn(process.execPath, [resolve('dist/server/index.js')], {
      env: { PATH: process.env.PATH, HOME: home, HABBLAUD_DATA_DIR: join(home, 'office'), HABBLAUD_IN_DOCKER: '0',
        HABBLAUD_PORT: String(localPort), HABBLAUD_HOST: '127.0.0.1', HABBLAUD_REMOTE_HOST: '127.0.0.1',
        HABBLAUD_WORLD: '0', HABBLAUD_UPDATE_CHECK: '0', HABBLAUD_REMOTE_ALLOW: 'none', HABBLAUD_REMOTE_PORT: String(remotePort),
        HABBLAUD_REMOTE_TLS_DIR: tls.serverDir, HABBLAUD_REMOTE_USER: 'operator', HABBLAUD_REMOTE_PASSWORD_HASH: await hashPassword(password) },
      stdio: 'ignore',
    });
    const closed = once(office,'exit');
    function api(path: string, cookie?: string, data?: object) {
      return new Promise<{ status: number; cookie: string }>((ok, fail) => {
        const req = request(origin + path, { ca, method: data ? 'POST' : 'GET',
          headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) } }, res => {
          res.resume();
          res.on('end', () => ok({ status: res.statusCode ?? 0, cookie: res.headers['set-cookie']?.[0] ?? '' }));
        });
        req.setTimeout(5000, () => req.destroy(new Error('TLS request timed out')));
        req.on('error',fail);
        req.end(data ? JSON.stringify(data) : undefined);
      });
    }
    try {
      let ready = false;
      for (let i = 0; i < 100; i++) {
        if (office.exitCode !== null) throw new Error('Office stopped before the phone listener opened');
        try {
          ready = (await api('/api/snapshot')).status === 401;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ECONNREFUSED') throw err;
        }
        if (ready) break;
        await delay(100);
      }
      assert(ready,'Expected a CA-verified TLS connection and an authentication challenge');
      const login = await api('/api/remote/login', undefined, { user:'operator', password });
      assert.equal(login.status,200);
      assert.match(login.cookie,/; Secure/i);
      assert.match(login.cookie,/; HttpOnly/i);
      const cookie = login.cookie.split(';')[0];
      assert.equal((await api('/api/snapshot',cookie)).status,200);
      assert.equal((await api('/api/remote/logout',cookie,{})).status,200);
      assert.equal((await api('/api/snapshot',cookie)).status,401);
      console.log('Private phone HTTPS passed: trusted CA, login, secure cookie, live snapshot and logout revocation.');
    } finally {
      if (office.exitCode === null && office.signalCode === null) office.kill('SIGTERM');
      await closed;
    }
  } finally {
    await rm(home,{recursive:true,force:true});
  }
}
main().catch(err => { console.error(err.message); process.exitCode = 1; });
