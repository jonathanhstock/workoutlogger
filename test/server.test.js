import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import zlib from 'node:zlib';
import { createServer } from '../server.js';
import { defaultState } from '../public/js/model.js';

function start(opts) {
  return new Promise((resolve) => {
    const server = createServer(opts);
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-test-'));

describe('server without password', () => {
  let ctx;
  let dir;
  before(async () => {
    dir = tmpDir();
    ctx = await start({ dataDir: dir });
  });
  after(() => ctx.server.close());

  test('serves the app', async () => {
    const res = await fetch(`${ctx.base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /Workout Logbook/);
    const js = await fetch(`${ctx.base}/js/model.js`);
    assert.match(js.headers.get('content-type'), /javascript/);
  });

  test('compresses app files and answers revalidation with 304', async () => {
    // Node's fetch decodes gzip/br itself; check headers and decoded body.
    const res = await fetch(`${ctx.base}/js/app.js`, { headers: { 'accept-encoding': 'br, gzip' } });
    assert.equal(res.headers.get('content-encoding'), 'br');
    assert.match(res.headers.get('vary'), /Accept-Encoding/);
    const etag = res.headers.get('etag');
    assert.ok(etag);
    assert.match(await res.text(), /import \* as M/);
    const gz = await fetch(`${ctx.base}/css/app.css`, { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(gz.headers.get('content-encoding'), 'gzip');
    const again = await fetch(`${ctx.base}/js/app.js`, { headers: { 'if-none-match': etag } });
    assert.equal(again.status, 304);
    const missing = await fetch(`${ctx.base}/nope.js`);
    assert.equal(missing.status, 404);
  });

  test('accepts gzipped sync bodies and gzips the reply', async () => {
    const mine = defaultState(1);
    mine.sessions['2026-11-01'] = { date: '2026-11-01', name: 'Gz', dayType: 'training', notes: '', entries: [], updatedAt: 100 };
    const res = await fetch(`${ctx.base}/api/state`, {
      method: 'PUT',
      headers: { 'content-encoding': 'gzip', 'accept-encoding': 'gzip' },
      body: zlib.gzipSync(JSON.stringify(mine)),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-encoding'), 'gzip');
    assert.ok((await res.json()).sessions['2026-11-01']);
    const bad = await fetch(`${ctx.base}/api/state`, { method: 'PUT', headers: { 'content-encoding': 'gzip' }, body: 'not gzip' });
    assert.equal(bad.status, 400);
  });

  test('health reports no auth', async () => {
    const res = await fetch(`${ctx.base}/api/health`);
    assert.deepEqual(await res.json(), { ok: true, auth: false });
  });

  test('GET state returns a default logbook', async () => {
    const s = await (await fetch(`${ctx.base}/api/state`)).json();
    assert.equal(s.schemaVersion, 2);
    assert.ok(s.exercises['incline-machine-press']);
    assert.equal(s.settings.unit, 'lb');
  });

  test('PUT merges and persists to disk', async () => {
    const mine = defaultState(1);
    mine.sessions['2026-10-05'] = { date: '2026-10-05', name: 'Push', dayType: 'training', notes: '', entries: [], updatedAt: 100 };
    let res = await fetch(`${ctx.base}/api/state`, { method: 'PUT', body: JSON.stringify(mine) });
    assert.equal(res.status, 200);

    // Another device sends an older copy without that session: it must not be lost.
    const other = defaultState(1);
    other.sessions['2026-10-06'] = { date: '2026-10-06', name: 'Pull', dayType: 'training', notes: '', entries: [], updatedAt: 50 };
    res = await fetch(`${ctx.base}/api/state`, { method: 'PUT', body: JSON.stringify(other) });
    const merged = await res.json();
    assert.ok(merged.sessions['2026-10-05']);
    assert.ok(merged.sessions['2026-10-06']);

    await new Promise((r) => setTimeout(r, 50));
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'logbook.json'), 'utf8'));
    assert.ok(onDisk.sessions['2026-10-06']);
    assert.ok(fs.readdirSync(path.join(dir, 'backups')).length >= 1);
  });

  test('data survives a restart', async () => {
    await new Promise((r) => setTimeout(r, 50));
    const again = await start({ dataDir: dir });
    const s = await (await fetch(`${again.base}/api/state`)).json();
    again.server.close();
    assert.ok(s.sessions['2026-10-05']);
  });

  test('replace mode overwrites', async () => {
    const fresh = defaultState(1);
    const res = await fetch(`${ctx.base}/api/state?mode=replace`, { method: 'PUT', body: JSON.stringify(fresh) });
    const s = await res.json();
    assert.deepEqual(s.sessions, {});
  });

  test('rejects invalid JSON', async () => {
    const res = await fetch(`${ctx.base}/api/state`, { method: 'PUT', body: '{nope' });
    assert.equal(res.status, 400);
  });

  test('blocks path traversal', async () => {
    const status = await new Promise((resolve, reject) => {
      const url = new URL(ctx.base);
      const sock = net.connect(Number(url.port), url.hostname, () => sock.write('GET /../server.js HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
      let buf = '';
      sock.on('data', (d) => (buf += d));
      sock.on('end', () => resolve(Number(buf.split(' ')[1])));
      sock.on('error', reject);
    });
    assert.ok(status === 403 || status === 404, `status ${status}`);
    const enc = await fetch(`${ctx.base}/%2e%2e/server.js`);
    assert.ok(enc.status === 403 || enc.status === 404);
  });

  test('unknown files 404', async () => {
    assert.equal((await fetch(`${ctx.base}/nope.txt`)).status, 404);
    assert.equal((await fetch(`${ctx.base}/api/nope`)).status, 404);
  });
});

describe('server with password', () => {
  let ctx;
  before(async () => {
    ctx = await start({ dataDir: tmpDir(), password: 'hunter2' });
  });
  after(() => ctx.server.close());

  test('requires the password for data', async () => {
    assert.equal((await fetch(`${ctx.base}/api/state`)).status, 401);
    assert.equal((await fetch(`${ctx.base}/api/state`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await fetch(`${ctx.base}/api/state`, { headers: { Authorization: 'Bearer hunter2' } })).status, 200);
  });

  test('locks out an address after repeated wrong passwords', async () => {
    const other = await start({ dataDir: tmpDir(), password: 'pw' });
    let last;
    for (let i = 0; i < 11; i++) last = (await fetch(`${other.base}/api/state`, { headers: { Authorization: 'Bearer nope' } })).status;
    assert.equal(last, 429);
    // Even the right password is refused during the lockout.
    assert.equal((await fetch(`${other.base}/api/state`, { headers: { Authorization: 'Bearer pw' } })).status, 429);
    other.server.close();
  });

  test('health and the app shell stay public', async () => {
    assert.deepEqual(await (await fetch(`${ctx.base}/api/health`)).json(), { ok: true, auth: true });
    assert.equal((await fetch(`${ctx.base}/`)).status, 200);
  });
});

describe('corrupt data file', () => {
  test('is preserved, not overwritten', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'logbook.json'), '{broken');
    const orig = console.error;
    console.error = () => {};
    const ctx = await start({ dataDir: dir });
    console.error = orig;
    ctx.server.close();
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('logbook.json.corrupt-')));
  });
});

describe('saving', () => {
  const put = (base, body, headers = {}) => fetch(`${base}/api/state`, { method: 'PUT', headers, body: JSON.stringify(body) });
  const withSessionOn = (date, t) => {
    const s = defaultState(1);
    s.sessions[date] = { date, name: 'X', dayType: 'training', notes: '', entries: [], updatedAt: t };
    return s;
  };

  test('a failed write does not block later saves', async () => {
    const dir = tmpDir();
    const ctx = await start({ dataDir: dir });
    const orig = console.error;
    console.error = () => {};
    try {
      // Backups failing (backups/ is now a file) must not fail the sync.
      fs.rmSync(path.join(dir, 'backups'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'backups'), '');
      assert.equal((await put(ctx.base, withSessionOn('2026-10-01', 10))).status, 200);
      // The main file can't be written (a folder is in the way): 500...
      const db = path.join(dir, 'logbook.json');
      fs.rmSync(db);
      fs.mkdirSync(db);
      fs.writeFileSync(path.join(db, 'x'), '');
      assert.equal((await put(ctx.base, withSessionOn('2026-10-02', 20))).status, 500);
      // ...and once it's fixed, the next sync saves everything, even with no new changes.
      fs.rmSync(db, { recursive: true });
      assert.equal((await put(ctx.base, withSessionOn('2026-10-02', 20))).status, 200);
      const onDisk = JSON.parse(fs.readFileSync(db, 'utf8'));
      assert.ok(onDisk.sessions['2026-10-01'] && onDisk.sessions['2026-10-02']);
    } finally {
      console.error = orig;
      ctx.server.close();
    }
  });

  test('answers 204 when the app already has everything', async () => {
    const ctx = await start({ dataDir: tmpDir() });
    const mine = withSessionOn('2026-10-03', 30);
    const first = await put(ctx.base, mine, { 'x-sync-unchanged': 'empty' });
    assert.equal(first.status, 204);
    // Something newer on the server: the full merged copy comes back.
    await put(ctx.base, withSessionOn('2026-10-04', 40));
    const second = await put(ctx.base, mine, { 'x-sync-unchanged': 'empty' });
    assert.equal(second.status, 200);
    assert.ok((await second.json()).sessions['2026-10-04']);
    ctx.server.close();
  });
});
