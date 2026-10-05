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
import { fileURLToPath } from 'node:url';
import { defaultState, mergeStates, normalizeState } from './public/js/model.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_BODY = 20 * 1024 * 1024;
const BACKUPS_KEPT = 30;

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

export function createServer({ dataDir = path.join(ROOT, 'data'), password = '' } = {}) {
  const dbFile = path.join(dataDir, 'logbook.json');
  const backupDir = path.join(dataDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });

  let state = loadState(dbFile);
  // Serialize writes so concurrent requests can't interleave.
  let writeChain = Promise.resolve();

  function save(next) {
    state = next;
    const json = JSON.stringify(next);
    writeChain = writeChain.then(async () => {
      const tmp = `${dbFile}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, json);
      await fsp.rename(tmp, dbFile);
      const day = new Date().toISOString().slice(0, 10);
      await fsp.writeFile(path.join(backupDir, `logbook-${day}.json`), json);
      const old = (await fsp.readdir(backupDir)).filter((f) => f.startsWith('logbook-')).sort().slice(0, -BACKUPS_KEPT);
      await Promise.all(old.map((f) => fsp.unlink(path.join(backupDir, f))));
    });
    return writeChain;
  }

  function authorized(req) {
    if (!password) return true;
    const header = req.headers.authorization || '';
    const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
    const expected = Buffer.from(password);
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  }

  async function handleApi(req, res, url) {
    if (url.pathname === '/api/health') return sendJson(res, 200, { ok: true, auth: !!password });
    if (!authorized(req)) return sendJson(res, 401, { error: 'Password required' });

    if (url.pathname === '/api/state') {
      if (req.method === 'GET') return sendJson(res, 200, state);
      if (req.method === 'PUT' || req.method === 'POST') {
        let incoming;
        try {
          incoming = JSON.parse(await readBody(req));
        } catch (err) {
          return sendJson(res, err.status || 400, { error: err.message || 'Invalid JSON' });
        }
        // `replace` is used by "Import (replace)"; normal sync always merges,
        // so a stale device can never wipe out newer data.
        const next = url.searchParams.get('mode') === 'replace' ? normalizeState(incoming) : mergeStates(state, incoming);
        await save(next);
        return sendJson(res, 200, next);
      }
      return sendJson(res, 405, { error: 'Method not allowed' });
    }
    return sendJson(res, 404, { error: 'Not found' });
  }

  async function serveStatic(req, res, url) {
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendText(res, 403, 'Forbidden');
    try {
      const data = await fsp.readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        // Always revalidate so updates reach phones quickly; the service
        // worker handles offline use.
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      sendText(res, 404, 'Not found');
    }
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
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
  });
  server.listen(port, () => {
    console.log(`Workout Logbook running at http://localhost:${port}`);
    if (!process.env.APP_PASSWORD) console.log('Tip: set APP_PASSWORD to protect your data if this is reachable from the internet.');
  });
}
