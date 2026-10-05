// Zero-dependency server: serves the app and stores the logbook as JSON.
//
//   node server.js                       # http://localhost:3000
//   PORT=8080 DATA_DIR=/data APP_PASSWORD=secret node server.js
//
// Data lives in DATA_DIR/logbook.json. Every write is atomic (temp file +
// rename) and a dated backup is kept per day in DATA_DIR/backups.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { defaultState, mergeStates, normalizeState, statesEqual } from './public/js/model.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_BODY = 20 * 1024 * 1024;
const BACKUPS_KEPT = 30;
const MAX_FAILURES = 10;
const LOCKOUT_MS = 15 * 60 * 1000;

const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.webmanifest', '.svg']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function createServer({ dataDir = path.join(ROOT, 'data'), password = '', trustProxy = false } = {}) {
  const dbFile = path.join(dataDir, 'logbook.json');
  const backupDir = path.join(dataDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });

  let state = loadState(dbFile);
  // Serialize writes so concurrent requests can't interleave.
  let writeChain = Promise.resolve();
  let unsaved = false; // the last write failed; retry on the next sync

  function save(next) {
    state = next;
    const json = JSON.stringify(next);
    // A failed write must not block every later one, so each link starts
    // from a settled chain. The caller still sees its own write's error.
    const write = writeChain.catch(() => {}).then(async () => {
      const tmp = `${dbFile}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, json);
      await fsp.rename(tmp, dbFile);
      unsaved = false;
      // Backups are a bonus: a failure there shouldn't fail the sync.
      try {
        const day = new Date().toISOString().slice(0, 10);
        await fsp.writeFile(path.join(backupDir, `logbook-${day}.json`), json);
        const old = (await fsp.readdir(backupDir)).filter((f) => f.startsWith('logbook-')).sort().slice(0, -BACKUPS_KEPT);
        await Promise.all(old.map((f) => fsp.unlink(path.join(backupDir, f))));
      } catch (err) {
        console.error('Backup failed', err);
      }
    });
    write.catch(() => {
      unsaved = true;
    });
    writeChain = write;
    return write;
  }

  // Slow down password guessing: after too many failures from one address,
  // refuse further attempts for a while.
  const failures = new Map(); // ip -> { count, first, until }
  const clientIp = (req) => (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';

  function authorized(req) {
    if (!password) return true;
    const header = req.headers.authorization || '';
    const given = crypto.createHash('sha256').update(header.startsWith('Bearer ') ? header.slice(7) : '').digest();
    const expected = crypto.createHash('sha256').update(password).digest();
    return crypto.timingSafeEqual(given, expected);
  }

  async function handleApi(req, res, url) {
    if (url.pathname === '/api/health') return sendJson(res, 200, { ok: true, auth: !!password });
    const ip = clientIp(req);
    const f = failures.get(ip);
    if (f && f.until > Date.now()) return sendJson(res, 429, { error: 'Too many attempts. Try again later.' });
    if (!authorized(req)) {
      const t = Date.now();
      const fresh = !f || t - f.first > LOCKOUT_MS;
      const count = fresh ? 1 : f.count + 1;
      failures.set(ip, { count, first: fresh ? t : f.first, until: count >= MAX_FAILURES ? t + LOCKOUT_MS : 0 });
      if (failures.size > 10000) failures.clear();
      return sendJson(res, 401, { error: 'Password required' });
    }
    if (f) failures.delete(ip);

    if (url.pathname === '/api/state') {
      if (req.method === 'GET') return sendJson(res, 200, state, req);
      if (req.method === 'PUT' || req.method === 'POST') {
        let incoming;
        try {
          incoming = JSON.parse(await readBody(req, req.headers['content-encoding'] === 'gzip'));
        } catch (err) {
          return sendJson(res, err.status || 400, { error: err.message || 'Invalid JSON' });
        }
        // `replace` is used by "Import (replace)"; normal sync always merges,
        // so a stale device can never wipe out newer data.
        const replace = url.searchParams.get('mode') === 'replace';
        const theirs = normalizeState(incoming);
        const next = replace ? theirs : mergeStates(state, theirs);
        // Only touch the disk when something actually changed.
        if (replace || unsaved || !statesEqual(next, state)) await save(next);
        // The app asks for an empty reply when it already has everything,
        // which spares the phone from parsing the whole logbook again.
        if (req.headers['x-sync-unchanged'] === 'empty' && statesEqual(next, theirs)) {
          res.writeHead(204, { 'Cache-Control': 'no-store' });
          return res.end();
        }
        return sendJson(res, 200, next, req);
      }
      return sendJson(res, 405, { error: 'Method not allowed' });
    }
    return sendJson(res, 404, { error: 'Not found' });
  }

  // App files never change while the server runs, so each one is read and
  // compressed once, then served from memory with an ETag. Phones revalidate
  // with a tiny 304 instead of downloading the file again.
  const files = new Map(); // abs path -> Promise<{ type, etag, raw, gzip, br }>

  function loadFile(file) {
    if (!files.has(file)) {
      const p = fsp.readFile(file).then((raw) => {
        const ext = path.extname(file);
        const f = { type: MIME[ext] || 'application/octet-stream', etag: `"${crypto.createHash('sha1').update(raw).digest('base64url').slice(0, 20)}"`, raw };
        if (COMPRESSIBLE.has(ext) && raw.length > 512) {
          f.gzip = zlib.gzipSync(raw, { level: 9 });
          f.br = zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } });
        }
        return f;
      });
      p.catch(() => files.delete(file));
      files.set(file, p);
    }
    return files.get(file);
  }

  async function serveStatic(req, res, url) {
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      return sendText(res, 400, 'Bad request');
    }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendText(res, 403, 'Forbidden');
    let f;
    try {
      f = await loadFile(file);
    } catch {
      return sendText(res, 404, 'Not found');
    }
    const headers = {
      'Content-Type': f.type,
      // Always revalidate so updates reach phones quickly; the ETag makes
      // that a 304 when nothing changed. The service worker handles offline.
      'Cache-Control': 'no-cache',
      ETag: f.etag,
      'X-Content-Type-Options': 'nosniff',
    };
    if (f.gzip) headers.Vary = 'Accept-Encoding';
    if (req.headers['if-none-match'] === f.etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    const enc = f.gzip ? pickEncoding(req) : '';
    const body = enc === 'br' ? f.br : enc === 'gzip' ? f.gzip : f.raw;
    if (enc) headers['Content-Encoding'] = enc;
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else if (req.method === 'GET' || req.method === 'HEAD') await serveStatic(req, res, url);
      else sendText(res, 405, 'Method not allowed');
    } catch (err) {
      console.error(err);
      if (!res.headersSent) sendJson(res, 500, { error: 'Server error' });
      else res.end();
    }
  });
}

function loadState(file) {
  try {
    return normalizeState(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // Keep the unreadable file instead of overwriting it.
      const aside = `${file}.corrupt-${Date.now()}`;
      fs.copyFileSync(file, aside);
      console.error(`Could not read ${file} (${err.message}); saved a copy to ${aside}`);
    }
    return defaultState(0);
  }
}

function readBody(req, gzipped = false) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => Object.assign(new Error('Body too large'), { status: 413 });
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(tooLarge());
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (!gzipped) return resolve(buf.toString('utf8'));
      // The phone gzips large syncs; cap the unzipped size too.
      zlib.gunzip(buf, { maxOutputLength: MAX_BODY }, (err, out) => {
        if (err) reject(err.code === 'ERR_BUFFER_TOO_LARGE' ? tooLarge() : Object.assign(new Error('Invalid gzip body'), { status: 400 }));
        else resolve(out.toString('utf8'));
      });
    });
    req.on('error', reject);
  });
}

function pickEncoding(req) {
  const accept = String(req?.headers['accept-encoding'] || '');
  if (/\bbr\b/.test(accept)) return 'br';
  if (/\bgzip\b/.test(accept)) return 'gzip';
  return '';
}

function sendJson(res, status, body, req) {
  let data = Buffer.from(JSON.stringify(body));
  const headers = { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' };
  // The logbook grows over time; gzip makes each sync a fraction of the size.
  if (req && data.length > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
    data = zlib.gzipSync(data, { level: 6 });
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
  }
  headers['Content-Length'] = data.length;
  res.writeHead(status, headers);
  res.end(data);
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  const server = createServer({
    dataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : undefined,
    password: process.env.APP_PASSWORD || '',
    // Hosts like Render put the real client address in X-Forwarded-For.
    trustProxy: process.env.TRUST_PROXY === '1' || !!process.env.RENDER,
  });
  server.listen(port, () => {
    console.log(`Workout Logbook running at http://localhost:${port}`);
    if (!process.env.APP_PASSWORD) console.log('Tip: set APP_PASSWORD to protect your data if this is reachable from the internet.');
  });
}
