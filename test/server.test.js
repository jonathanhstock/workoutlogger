import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import zlib from 'node:zlib';
import { createServer } from '../server.js';
import { GOOGLE_SCOPES, sleepMinutes } from '../google-health.js';
import { defaultState } from '../public/js/model.js';

// Starts a test server on a random port and resolves with it and its base URL.
function start(opts) {
  return new Promise((resolve) => {
    const server = createServer(opts);
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

// Makes a fresh temporary data folder for a test server.
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
  // Sends a logbook to the test server with PUT.
  const put = (base, body, headers = {}) => fetch(`${base}/api/state`, { method: 'PUT', headers, body: JSON.stringify(body) });
  // Builds a default logbook with one session on the given date.
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

describe('Fitbit / Google Health', () => {
  const TODAY = '2026-10-05';
  // Turns YYYY-MM-DD into a Google {year, month, day} date.
  const date = (d) => {
    const [year, month, day] = d.split('-').map(Number);
    return { year, month, day };
  };

  // Builds a fake Google (sign-in plus Health API) that records every call made to it.
  function fakeGoogle({ expired = false, scope = GOOGLE_SCOPES.join(' '), sleepForbidden = false } = {}) {
    const calls = [];
    const state = { down: false }; // set to make every data call fail
    // Builds a JSON response with the given status.
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    // Answers a request the way Google would for the endpoints the app uses.
    const fetch = async (url, opts = {}) => {
      const u = new URL(url);
      const body = typeof opts.body === 'string' ? opts.body : opts.body?.toString();
      calls.push({ url: u, method: opts.method || 'GET', body, auth: opts.headers?.Authorization });
      if (u.href.startsWith('https://oauth2.googleapis.com/token')) {
        const p = new URLSearchParams(body);
        if (p.get('grant_type') === 'authorization_code') return json({ access_token: 'at1', refresh_token: 'rt-secret', expires_in: 3600, scope });
        if (expired) return json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400);
        return json({ access_token: 'at2', expires_in: 3600 });
      }
      if (u.href.startsWith('https://oauth2.googleapis.com/revoke')) return json({});
      const type = u.pathname.split('/dataTypes/')[1]?.split('/')[0];
      if (type && state.down) return json({ error: { message: 'Service unavailable' } }, 503);
      if (type === 'steps') return json({ rollupDataPoints: [{ civilStartTime: { date: date('2026-10-04') }, steps: { countSum: '9876' } }] });
      if (type === 'daily-resting-heart-rate') return json({ dataPoints: [{ dailyRestingHeartRate: { date: date('2026-10-04'), beatsPerMinute: '57' } }] });
      if (type === 'sleep') {
        if (sleepForbidden) return json({ error: { message: 'Request had insufficient authentication scopes.' } }, 403);
        // Google caps sleep pages at 25 and may reject anything larger.
        if (u.searchParams.get('pageSize') !== '25') return json({ error: { message: 'Invalid page size' } }, 400);
        // Like Google's docs suggest, sleep only comes back from "reconcile";
        // the plain list returns nothing.
        if (!u.pathname.endsWith(':reconcile')) return json({ dataPoints: [] });
        // Two pages, to check paging; a nap doesn't count. The first night has
        // no civil time, so its date comes from the end time and UTC offset.
        if (!u.searchParams.get('pageToken')) {
          return json({ dataPoints: [{ sleep: { interval: { startTime: '2026-10-04T05:30:00Z', endTime: '2026-10-04T13:00:00Z', endUtcOffset: '-25200s' }, summary: { minutesAsleep: '400' }, metadata: { mainSleep: true } } }], nextPageToken: 'p2' });
        }
        return json({ dataPoints: [{ sleep: { interval: { civilEndTime: { date: date('2026-10-04') } }, summary: { minutesAsleep: '30' }, metadata: { nap: true } } }] });
      }
      if (type === 'weight') {
        return json({
          dataPoints: [
            { weight: { weightGrams: 81646.6, sampleTime: { physicalTime: '2026-10-04T14:00:00Z', civilTime: { date: date('2026-10-04') } } } },
            { weight: { weightGrams: 81000, sampleTime: { physicalTime: '2026-10-04T07:00:00Z', civilTime: { date: date('2026-10-04') } } } },
            { weight: { weightGrams: 80000, sampleTime: { physicalTime: '2026-10-03T07:00:00Z', civilTime: { date: date('2026-10-03') } } } },
          ],
        });
      }
      if (type === 'exercise') {
        return json({
          dataPoints: [
            {
              exercise: {
                displayName: 'Weights',
                exerciseType: 'WEIGHTLIFTING',
                activeDuration: '3120s',
                interval: { startTime: '2026-10-04T13:05:00Z', endTime: '2026-10-04T14:00:00Z', civilStartTime: { date: date('2026-10-04'), time: { hours: 7, minutes: 5 } } },
                metricsSummary: { caloriesKcal: 410.4, averageHeartRateBeatsPerMinute: '121' },
              },
            },
          ],
        });
      }
      return json({ error: { message: 'unexpected' } }, 404);
    };
    return { fetch, calls, state };
  }

  test('connect, import and disconnect', async () => {
    const dir = tmpDir();
    const g = fakeGoogle();
    // A weigh-in typed by hand is never replaced by Fitbit's.
    const seed = defaultState(1);
    seed.body['2026-10-03'] = { weight: 177, updatedAt: 5 };
    fs.writeFileSync(path.join(dir, 'logbook.json'), JSON.stringify(seed));
    const ctx = await start({ dataDir: dir, password: 'pw', google: { clientId: 'cid', clientSecret: 'csec', publicUrl: 'https://app.example/', fetch: g.fetch } });
    const auth = { Authorization: 'Bearer pw' };
    try {
      let st = await (await fetch(`${ctx.base}/api/google/status`, { headers: auth })).json();
      assert.deepEqual([st.configured, st.connected, st.redirectUri], [true, false, 'https://app.example/api/google/callback']);
      assert.equal((await fetch(`${ctx.base}/api/google/connect`, { method: 'POST' })).status, 401);

      const { url } = await (await fetch(`${ctx.base}/api/google/connect`, { method: 'POST', headers: auth })).json();
      const auth1 = new URL(url);
      assert.equal(auth1.origin, 'https://accounts.google.com');
      assert.equal(auth1.searchParams.get('access_type'), 'offline');
      assert.match(auth1.searchParams.get('scope'), /googlehealth\.sleep\.readonly/);
      const state = auth1.searchParams.get('state');

      // A made-up state is refused.
      let res = await fetch(`${ctx.base}/api/google/callback?state=nope&code=x`, { redirect: 'manual' });
      assert.match(res.headers.get('location'), /google=error/);

      res = await fetch(`${ctx.base}/api/google/callback?state=${state}&code=the-code`, { redirect: 'manual' });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/?google=connected#settings');
      const tokenCall = g.calls.find((c) => c.url.pathname === '/token');
      assert.equal(new URLSearchParams(tokenCall.body).get('code'), 'the-code');
      assert.equal(new URLSearchParams(tokenCall.body).get('redirect_uri'), 'https://app.example/api/google/callback');
      // The state can't be reused.
      res = await fetch(`${ctx.base}/api/google/callback?state=${state}&code=again`, { redirect: 'manual' });
      assert.match(res.headers.get('location'), /google=error/);

      res = await fetch(`${ctx.base}/api/google/sync`, { method: 'POST', headers: auth, body: JSON.stringify({ force: true, today: TODAY }) });
      st = await res.json();
      assert.equal(st.connected, true);
      assert.equal(st.lastError, '');
      assert.equal(st.lastFound.sleep, 1);
      assert.equal(st.lastFound.steps, 1);
      assert.equal(st.lastFound.exercise, 1);
      assert.ok(!JSON.stringify(st).includes('rt-secret'));

      const s = await (await fetch(`${ctx.base}/api/state`, { headers: auth })).json();
      assert.ok(!JSON.stringify(s).includes('rt-secret'), 'tokens never reach the logbook');
      const h = s.health['2026-10-04'];
      assert.equal(h.steps, 9876);
      assert.equal(h.restingHr, 57);
      assert.equal(h.sleepMin, 400);
      assert.deepEqual(h.activities, [{ name: 'Weights', start: '07:05', minutes: 52, calories: 410, avgHr: 121, distanceKm: 0, steps: 0 }]);
      assert.deepEqual(s.body['2026-10-04'], { weight: 180, source: 'fitbit', updatedAt: s.body['2026-10-04'].updatedAt });
      assert.equal(s.body['2026-10-03'].weight, 177);
      assert.ok(fs.statSync(path.join(dir, 'google.json')).isFile());

      // A second import with the same data changes nothing.
      res = await fetch(`${ctx.base}/api/google/sync`, { method: 'POST', headers: auth, body: JSON.stringify({ force: true, today: TODAY }) });
      assert.equal((await res.json()).changed, 0);

      res = await fetch(`${ctx.base}/api/google/disconnect`, { method: 'POST', headers: auth });
      assert.equal((await res.json()).connected, false);
      assert.ok(g.calls.some((c) => c.url.pathname === '/revoke'));
      assert.ok(!fs.existsSync(path.join(dir, 'google.json')));
    } finally {
      ctx.server.close();
    }
  });

  test('sleep the user did not allow is reported, and the rest still imports', async () => {
    const dir = tmpDir();
    const g = fakeGoogle({ scope: GOOGLE_SCOPES.slice(0, 2).join(' '), sleepForbidden: true });
    const ctx = await start({ dataDir: dir, google: { clientId: 'cid', clientSecret: 'csec', publicUrl: 'https://app.example', fetch: g.fetch } });
    try {
      const { url } = await (await fetch(`${ctx.base}/api/google/connect`, { method: 'POST' })).json();
      await fetch(`${ctx.base}/api/google/callback?state=${new URL(url).searchParams.get('state')}&code=c`, { redirect: 'manual' });
      const st = await (await fetch(`${ctx.base}/api/google/sync`, { method: 'POST', body: JSON.stringify({ force: true, today: TODAY }) })).json();
      assert.deepEqual(st.missing, ['sleep']);
      assert.match(st.lastError, /^sleep: permission not allowed/);
      const s = await (await fetch(`${ctx.base}/api/state`)).json();
      assert.equal(s.health['2026-10-04'].steps, 9876);
      assert.equal(s.health['2026-10-04'].sleepMin, undefined);
    } finally {
      ctx.server.close();
    }
  });

  test('sleep minutes fall back to stages or time in bed', () => {
    assert.equal(sleepMinutes({ summary: { minutesAsleep: '412' } }), 412);
    // Still processing: no total yet, but a stage summary.
    const stagesSummary = [
      { type: 'LIGHT', minutes: '200' },
      { type: 'DEEP', minutes: '80' },
      { type: 'REM', minutes: '90' },
      { type: 'AWAKE', minutes: '40' },
    ];
    assert.equal(sleepMinutes({ summary: { stagesSummary } }), 370);
    const stages = [
      { type: 'ASLEEP', startTime: '2026-10-04T05:00:00Z', endTime: '2026-10-04T09:00:00Z' },
      { type: 'RESTLESS', startTime: '2026-10-04T09:00:00Z', endTime: '2026-10-04T09:30:00Z' },
      { type: 'ASLEEP', startTime: '2026-10-04T09:30:00Z', endTime: '2026-10-04T12:00:00Z' },
    ];
    assert.equal(sleepMinutes({ stages }), 390);
    assert.equal(sleepMinutes({ interval: { startTime: '2026-10-04T05:00:00Z', endTime: '2026-10-04T12:00:00Z' }, summary: { minutesAwake: '20' } }), 400);
    assert.equal(sleepMinutes({}), 0);
  });

  test('a failed import does not skip days the next time', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'google.json'), JSON.stringify({ refreshToken: 'rt', connectedAt: 1, lastSync: 0 }));
    const g = fakeGoogle();
    const ctx = await start({ dataDir: dir, google: { clientId: 'cid', clientSecret: 'csec', fetch: g.fetch } });
    // Runs a forced Fitbit import for TODAY and returns the status.
    const sync = async () => (await fetch(`${ctx.base}/api/google/sync`, { method: 'POST', body: JSON.stringify({ force: true, today: TODAY }) })).json();
    // The steps roll-up request says where each import starts.
    const lastStart = () => {
      const c = g.calls.filter((x) => x.url.pathname.endsWith('steps/dataPoints:dailyRollUp')).pop();
      const d = JSON.parse(c.body).range.start.date;
      return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
    };
    try {
      g.state.down = true;
      const st = await sync();
      assert.match(st.lastError, /Service unavailable/);
      assert.equal(lastStart(), '2026-09-06');
      // Google is back: the import still covers the full first 30 days.
      g.state.down = false;
      assert.equal((await sync()).lastError, '');
      assert.equal(lastStart(), '2026-09-06');
      // After a good import, the next one only re-reads the last few days.
      await sync();
      assert.ok(lastStart() > '2026-09-06');
    } finally {
      ctx.server.close();
    }
  });

  test('an expired Google sign-in asks to reconnect', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'google.json'), JSON.stringify({ refreshToken: 'old', connectedAt: 1, lastSync: 0 }));
    const g = fakeGoogle({ expired: true });
    const ctx = await start({ dataDir: dir, google: { clientId: 'cid', clientSecret: 'csec', fetch: g.fetch } });
    const res = await fetch(`${ctx.base}/api/google/sync`, { method: 'POST', body: JSON.stringify({ force: true }) });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.needsReconnect, true);
    assert.match(body.lastError, /Connect/);
    ctx.server.close();
  });

  test('without credentials it reports not configured', async () => {
    const ctx = await start({ dataDir: tmpDir() });
    const st = await (await fetch(`${ctx.base}/api/google/status`)).json();
    assert.equal(st.configured, false);
    assert.equal((await fetch(`${ctx.base}/api/google/connect`, { method: 'POST' })).status, 400);
    ctx.server.close();
  });
});
