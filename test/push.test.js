import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server.js';
import { encryptPayload, generateVapidKeys, vapidAuth, vapidPublicKey, validSubscription } from '../web-push.js';

// Makes a browser-side subscription (its key pair and auth secret), like a phone would.
function fakeBrowser(endpoint = 'https://push.example.net/send/abc') {
  const ecdh = crypto.createECDH('prime256v1');
  const pub = ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ecdh, subscription: { endpoint, keys: { p256dh: pub.toString('base64url'), auth: auth.toString('base64url') } } };
}

// Decrypts an aes128gcm push body the way the browser does (RFC 8291).
function decrypt(browser, body) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const uaPublic = Buffer.from(browser.subscription.keys.p256dh, 'base64url');
  const authSecret = Buffer.from(browser.subscription.keys.auth, 'base64url');
  const shared = browser.ecdh.computeSecret(asPublic);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ciphertext.subarray(-16));
  const plain = Buffer.concat([d.update(ciphertext.subarray(0, -16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2, 'last-record delimiter');
  return plain.subarray(0, -1).toString();
}

// Starts a test server on a random port with a fake push service.
function start(opts) {
  return new Promise((resolve) => {
    const server = createServer(opts);
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

describe('web push', () => {
  test('payloads decrypt in the browser and VAPID tokens verify', () => {
    const browser = fakeBrowser();
    const body = encryptPayload(browser.subscription, '{"title":"Rest over"}');
    assert.equal(body.readUInt32BE(16), 4096);
    assert.equal(decrypt(browser, body), '{"title":"Rest over"}');

    const keys = generateVapidKeys();
    const header = vapidAuth(browser.subscription.endpoint, keys, 'mailto:me@example.com', Date.parse('2026-10-05T12:00:00Z'));
    const [, jwt, k] = header.match(/^vapid t=([^,]+), k=(.+)$/);
    assert.equal(k, vapidPublicKey(keys.publicJwk));
    assert.equal(Buffer.from(k, 'base64url').length, 65);
    const [h, c, sig] = jwt.split('.');
    const claims = JSON.parse(Buffer.from(c, 'base64url'));
    assert.equal(claims.aud, 'https://push.example.net');
    assert.equal(claims.sub, 'mailto:me@example.com');
    const ok = crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: crypto.createPublicKey({ key: keys.publicJwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
    assert.ok(ok);
  });

  test('only https subscriptions with both keys are accepted', () => {
    assert.ok(validSubscription(fakeBrowser().subscription));
    assert.ok(!validSubscription(fakeBrowser('http://push.example.net/x').subscription));
    assert.ok(!validSubscription({ endpoint: 'https://push.example.net/x', keys: {} }));
    assert.ok(!validSubscription(null));
  });

  test('scheduled timer alerts are pushed on time, and can be cancelled', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-push-'));
    const sent = [];
    const browser = fakeBrowser();
    // A fake push service: records what it receives; one endpoint is gone.
    const fetch = async (url, opts) => {
      sent.push({ url, opts });
      return new Response(null, { status: url.includes('gone') ? 410 : 201 });
    };
    const ctx = await start({ dataDir: dir, password: 'pw', push: { fetch, subject: 'https://app.example' } });
    const auth = { Authorization: 'Bearer pw', 'Content-Type': 'application/json' };
    // Posts JSON to a push route with the password.
    const post = (route, body) => fetch2(`${ctx.base}/api/push/${route}`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
    const fetch2 = globalThis.fetch;
    try {
      assert.equal((await fetch2(`${ctx.base}/api/push/key`)).status, 401);
      const { publicKey } = await (await fetch2(`${ctx.base}/api/push/key`, { headers: auth })).json();
      assert.equal(Buffer.from(publicKey, 'base64url').length, 65);
      assert.equal((await post('subscribe', { subscription: { endpoint: 'http://evil.local/x', keys: {} } })).status, 400);
      assert.equal((await post('subscribe', { subscription: browser.subscription })).status, 200);
      assert.equal((await post('subscribe', { subscription: fakeBrowser('https://push.example.net/gone').subscription })).status, 200);

      // Cancelled alerts never go out.
      await post('schedule', { items: [{ at: Date.now() + 80, title: 'Never', body: '', tag: 'rest' }] });
      await post('schedule', { items: [] });
      // A real one fires after its delay.
      const res = await post('schedule', { items: [{ at: Date.now() + 80, title: 'Rest over', body: 'Bench · next set!', tag: 'rest' }] });
      assert.equal((await res.json()).scheduled, 1);
      assert.equal(sent.length, 0);
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(sent.length, 2);
      const mine = sent.find((s) => s.url === browser.subscription.endpoint);
      assert.equal(mine.opts.headers['Content-Encoding'], 'aes128gcm');
      assert.match(mine.opts.headers.Authorization, /^vapid t=/);
      assert.deepEqual(JSON.parse(decrypt(browser, mine.opts.body)), { title: 'Rest over', body: 'Bench · next set!', tag: 'rest' });

      // The endpoint that answered 410 was dropped; the test alert reaches only the live one.
      sent.length = 0;
      await post('test', {});
      assert.deepEqual(sent.map((s) => s.url), [browser.subscription.endpoint]);

      // Pending alerts survive a restart.
      await post('schedule', { items: [{ at: Date.now() + 60000, title: 'Later', body: '', tag: 'rest' }] });
      const saved = JSON.parse(fs.readFileSync(path.join(dir, 'push.json'), 'utf8'));
      assert.equal(saved.items.length, 1);
      assert.equal((fs.statSync(path.join(dir, 'push.json')).mode & 0o777).toString(8), '600');
    } finally {
      ctx.server.close();
    }
  });
});
