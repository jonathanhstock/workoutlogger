// Timer notifications (server side): Web Push with no dependencies.
//
// When the app goes to the background with a rest or interval timer running,
// it sends the server the times its timers will end. The server pushes a
// notification to the phone at each of those times, so you get an alert with
// the app closed or the screen locked. (On iPhone this needs the app added to
// the Home Screen; Apple only allows web push there.)
//
// Encryption follows RFC 8291 (aes128gcm) and authentication RFC 8292
// (VAPID), using only node:crypto. Keys, subscriptions and pending alerts live
// in DATA_DIR/push.json.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_ITEMS = 60; // a long HIIT session has one alert per interval switch
const MAX_SUBSCRIPTIONS = 10;
const LATE_MS = 60 * 1000; // after a restart, alerts this late still go out
const TTL_SEC = 120; // a timer alert is useless after a couple of minutes

// Encodes bytes as base64url (no padding).
const b64u = (buf) => Buffer.from(buf).toString('base64url');

/** Creates a VAPID key pair (P-256) and returns it as JWKs. */
export function generateVapidKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { publicJwk: publicKey.export({ format: 'jwk' }), privateJwk: privateKey.export({ format: 'jwk' }) };
}

/** The raw uncompressed public key (65 bytes, base64url) the browser subscribes with. */
export function vapidPublicKey(publicJwk) {
  return b64u(Buffer.concat([Buffer.from([4]), Buffer.from(publicJwk.x, 'base64url'), Buffer.from(publicJwk.y, 'base64url')]));
}

/** Builds the VAPID Authorization header for a push service endpoint (RFC 8292). */
export function vapidAuth(endpoint, keys, subject, now = Date.now()) {
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const key = crypto.createPrivateKey({ key: keys.privateJwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${vapidPublicKey(keys.publicJwk)}`;
}

/** Encrypts a payload for one browser subscription (RFC 8291, aes128gcm). */
export function encryptPayload(subscription, payload) {
  const uaPublic = Buffer.from(subscription.keys.p256dh, 'base64url');
  const authSecret = Buffer.from(subscription.keys.auth, 'base64url');
  const ecdh = crypto.createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = crypto.randomBytes(16);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // A single record: the payload followed by the 0x02 "last record" delimiter.
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

/** Checks that a browser subscription looks valid (an https endpoint and both keys). */
export function validSubscription(s) {
  try {
    return !!(s && /^https:\/\//.test(s.endpoint) && new URL(s.endpoint) && Buffer.from(s.keys?.p256dh || '', 'base64url').length === 65 && Buffer.from(s.keys?.auth || '', 'base64url').length >= 16);
  } catch {
    return false;
  }
}

/**
 * Creates the timer notification service: keys, subscriptions and the
 * schedule of pending alerts, with timeouts that send each alert on time.
 */
export function createWebPush({ dataDir, subject = 'mailto:workout-logbook@example.com', fetch: fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  const file = path.join(dataDir, 'push.json');
  let data = read();
  if (!data.keys) {
    data.keys = generateVapidKeys();
    write();
  }
  const timers = new Map(); // item id -> timeout
  armAll();

  // Reads push.json, or starts empty.
  function read() {
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { keys: d.keys, subscriptions: Array.isArray(d.subscriptions) ? d.subscriptions : [], items: Array.isArray(d.items) ? d.items : [] };
    } catch {
      return { keys: null, subscriptions: [], items: [] };
    }
  }

  // Saves push.json (owner-only, written atomically).
  function write() {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  // Sets a timeout for every pending alert; drops ones that are long overdue.
  function armAll() {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    const t = now();
    data.items = data.items.filter((it) => it.at > t - LATE_MS);
    for (const it of data.items) arm(it);
  }

  // Sets the timeout that sends one alert at its time.
  function arm(it) {
    const delay = Math.max(0, it.at - now());
    // setTimeout tops out around 24.8 days; timer alerts are minutes away.
    const t = setTimeout(() => fire(it.id), Math.min(delay, 2 ** 31 - 1));
    t.unref?.();
    timers.set(it.id, t);
  }

  // Sends a due alert to every subscribed device, then forgets it.
  async function fire(id) {
    timers.delete(id);
    const it = data.items.find((x) => x.id === id);
    if (!it) return;
    data.items = data.items.filter((x) => x.id !== id);
    write();
    await sendAll({ title: it.title, body: it.body, tag: it.tag });
  }

  /** Pushes one notification to every subscribed device; drops subscriptions the push service says are gone. */
  async function sendAll(message) {
    const payload = JSON.stringify(message);
    const gone = [];
    await Promise.all(
      data.subscriptions.map(async (sub) => {
        try {
          const res = await fetchImpl(sub.endpoint, {
            method: 'POST',
            headers: {
              Authorization: vapidAuth(sub.endpoint, data.keys, subject, now()),
              'Content-Encoding': 'aes128gcm',
              'Content-Type': 'application/octet-stream',
              TTL: String(TTL_SEC),
              Urgency: 'high',
              Topic: String(message.tag || 'timer').replace(/[^\w-]/g, '').slice(0, 32) || 'timer',
            },
            body: encryptPayload(sub, payload),
          });
          if (res.status === 404 || res.status === 410) gone.push(sub.endpoint);
          else if (!res.ok) console.error(`Push failed (${res.status}) for ${new URL(sub.endpoint).host}`);
        } catch (err) {
          console.error('Push failed', err.message);
        }
      }),
    );
    if (gone.length) {
      data.subscriptions = data.subscriptions.filter((s) => !gone.includes(s.endpoint));
      write();
    }
    return { sent: data.subscriptions.length };
  }

  /** Adds (or refreshes) a device's subscription. */
  function subscribe(sub) {
    if (!validSubscription(sub)) throw Object.assign(new Error('Invalid push subscription'), { status: 400 });
    const clean = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } };
    data.subscriptions = [clean, ...data.subscriptions.filter((s) => s.endpoint !== sub.endpoint)].slice(0, MAX_SUBSCRIPTIONS);
    write();
  }

  /** Removes a device's subscription. */
  function unsubscribe(endpoint) {
    data.subscriptions = data.subscriptions.filter((s) => s.endpoint !== endpoint);
    write();
  }

  /**
   * Replaces the pending alerts with `items` ([{ at, title, body, tag }]);
   * an empty list cancels them all.
   */
  function schedule(items) {
    const t = now();
    data.items = (Array.isArray(items) ? items : [])
      .filter((it) => it && Number(it.at) > t - 5000 && Number(it.at) < t + 24 * 3600 * 1000)
      .slice(0, MAX_ITEMS)
      .map((it, i) => ({ id: `${Number(it.at)}-${i}`, at: Number(it.at), title: String(it.title || 'Timer').slice(0, 80), body: String(it.body || '').slice(0, 200), tag: String(it.tag || 'timer').slice(0, 40) }));
    write();
    armAll();
    return data.items.length;
  }

  return {
    publicKey: () => vapidPublicKey(data.keys.publicJwk),
    subscribed: (endpoint) => data.subscriptions.some((s) => s.endpoint === endpoint),
    subscribe,
    unsubscribe,
    schedule,
    pending: () => data.items.map(({ at, title, body, tag }) => ({ at, title, body, tag })),
    sendAll,
    /** Stops all pending timeouts (for tests and shutdown). */
    close() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}
