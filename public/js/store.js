// Client-side persistence and sync.
//
// The browser always keeps a full copy (IndexedDB, falling back to
// localStorage), so the app works offline and instantly. When the server is
// reachable, changes are pushed (debounced) and the server's merged copy is
// pulled back in.

import { defaultState, mergeStates, normalizeState, statesEqual } from './model.js';

const KEY = 'workout-logbook:v1';
const PW_KEY = 'workout-logbook:password';
const PUSH_DELAY = 700;
const GZIP_OVER = 8 * 1024; // bytes

// IndexedDB holds years of workouts (localStorage tops out around 5 MB in
// Safari, which a daily logbook reaches in a year or two). Each record (a
// day's session, a plan day, a weigh-in, ...) is its own row, so a tap saves
// just that day, right away, instead of rewriting the whole logbook.
const DB_NAME = 'workout-logbook';
const DB_STORE = 'records';
const MAPS = ['exercises', 'plan', 'sessions', 'body'];

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
}

/** Run requests in one transaction; resolves when it has committed. */
function dbTx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, mode);
    const out = fn(tx.objectStore(DB_STORE));
    tx.oncomplete = () => resolve(out);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

/** Every record of a state as [row key, value]. */
function rows(state) {
  const out = [['settings', state.settings]];
  for (const m of MAPS) for (const [k, v] of Object.entries(state[m] || {})) out.push([`${m}/${k}`, v]);
  return out;
}

async function readAll(db) {
  const got = await dbTx(db, 'readonly', (os) => {
    const keys = os.getAllKeys();
    const values = os.getAll();
    return { keys, values };
  });
  const keys = got.keys.result;
  if (!keys.length) return null;
  const state = { settings: null, ...Object.fromEntries(MAPS.map((m) => [m, {}])) };
  keys.forEach((key, i) => {
    const v = got.values.result[i];
    if (key === 'settings') state.settings = v;
    else {
      const cut = key.indexOf('/');
      const m = key.slice(0, cut);
      if (state[m]) state[m][key.slice(cut + 1)] = v;
    }
  });
  return state;
}

export async function createStore({ onChange, onSyncStatus }) {
  let db = null;
  const saved = new Map(); // row key -> updatedAt last written
  let lastSave = 0;
  let saveQueued = false;
  let state = await load();
  let pushTimer = null;
  let dirty = false;
  let serverAvailable = null; // null = unknown
  let status = 'local';

  async function load() {
    try {
      db = await openDb();
      const stored = await readAll(db);
      if (stored) {
        const st = normalizeState(stored);
        for (const [k, v] of rows(st)) saved.set(k, v.updatedAt);
        return st;
      }
    } catch (err) {
      console.warn('IndexedDB unavailable; using localStorage', err);
      db = null;
    }
    try {
      // Older versions kept the logbook in localStorage: move it over.
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const old = normalizeState(JSON.parse(raw));
        if (db) {
          await writeRows(old);
          localStorage.removeItem(KEY);
        }
        return old;
      }
    } catch (err) {
      console.warn('Could not read saved data', err);
    }
    // Defaults are stamped with time 0 so that, on a brand-new device, any
    // real data already on the server wins the merge.
    return defaultState(0);
  }

  /** Write the records that changed since the last save. */
  function writeRows(st) {
    const since = lastSave;
    lastSave = Date.now();
    const all = rows(st);
    const live = new Set();
    const put = [];
    for (const [k, v] of all) {
      live.add(k);
      const t = v.updatedAt;
      // Also rewrite anything stamped in the same millisecond as the last
      // save, in case it changed again within that millisecond.
      if (saved.get(k) !== t || t >= since) put.push([k, v]);
    }
    const gone = [...saved.keys()].filter((k) => !live.has(k));
    if (!put.length && !gone.length) return Promise.resolve();
    for (const [k, v] of put) saved.set(k, v.updatedAt);
    for (const k of gone) saved.delete(k);
    // put() copies each record right away, so later edits can't leak in.
    return dbTx(db, 'readwrite', (os) => {
      for (const [k, v] of put) os.put(v, k);
      for (const k of gone) os.delete(k);
    });
  }

  function fail(err) {
    console.error('Could not save locally', err);
    saved.clear(); // write everything again next time
    setStatus('error', 'Could not save on this device (storage full?)');
  }

  /** Save after the current task (several changes in one go = one write). */
  function persist() {
    if (saveQueued) return;
    saveQueued = true;
    queueMicrotask(() => {
      saveQueued = false;
      if (db) {
        try {
          writeRows(state).catch(fail);
        } catch (err) {
          fail(err);
        }
        return;
      }
      try {
        localStorage.setItem(KEY, JSON.stringify(state));
      } catch (err) {
        fail(err);
      }
    });
  }

  function setStatus(s, detail = '') {
    status = s;
    onSyncStatus?.(s, detail);
  }

  function password() {
    try {
      return localStorage.getItem(PW_KEY) || '';
    } catch {
      return '';
    }
  }

  async function api(method, body, query = '') {
    const headers = { 'Content-Type': 'application/json', 'X-Sync-Unchanged': 'empty' };
    const pw = password();
    if (pw) headers.Authorization = `Bearer ${pw}`;
    let payload = body ? JSON.stringify(body) : undefined;
    if (payload && payload.length > GZIP_OVER && typeof CompressionStream === 'function') {
      // Years of workouts add up: gzip makes each upload a fraction of the size.
      try {
        payload = await new Response(new Blob([payload]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
        headers['Content-Encoding'] = 'gzip';
      } catch {
        /* send it uncompressed */
      }
    }
    const res = await fetch(`api/state${query}`, { method, headers, body: payload, cache: 'no-store' });
    if (res.status === 401) throw Object.assign(new Error('Password required'), { auth: true });
    // A plain static host (no Node server) answers with a 404/405 page.
    if (!(res.headers.get('content-type') || '').includes('json') && [404, 405, 501].includes(res.status)) throw Object.assign(new Error('No server'), { noServer: true });
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    // 204: the server had nothing newer than what we sent.
    if (res.status === 204) return null;
    return normalizeState(await res.json());
  }

  /** Merge a server copy in; returns true if local state changed. */
  function absorb(remote) {
    const merged = mergeStates(state, remote);
    if (statesEqual(merged, state)) return false;
    state = merged;
    persist();
    return true;
  }

  let inflight = null;

  /** Push local changes and pull the merged copy. Resolves when done. */
  function sync() {
    if (serverAvailable === false) return Promise.resolve();
    if (inflight) {
      // Already syncing: run once more afterwards so nothing is missed.
      dirty = true;
      return inflight;
    }
    dirty = false;
    inflight = (async () => {
      setStatus('syncing');
      try {
        const remote = await api('PUT', state);
        serverAvailable = true;
        const changed = remote ? absorb(remote) : false;
        setStatus('synced');
        if (changed) onChange?.({ remote: true });
      } catch (err) {
        if (err.noServer) {
          serverAvailable = false;
          setStatus('local', 'No server: data is stored on this device only');
        } else if (err.auth) setStatus('auth', 'Enter your password in Settings to sync');
        else setStatus('offline', 'Saved on this device; will sync when online');
      }
    })().finally(() => {
      inflight = null;
      if (dirty) schedulePush();
    });
    return inflight;
  }

  function schedulePush() {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(sync, PUSH_DELAY);
  }

  return {
    get state() {
      return state;
    },
    get status() {
      return status;
    },
    /** Apply a mutation, save locally and queue a sync. */
    update(fn) {
      fn(state);
      persist();
      onChange?.({ remote: false });
      schedulePush();
    },
    /** Replace everything (import). With `push`, overwrite the server too. */
    async replace(next) {
      state = normalizeState(next);
      persist();
      onChange?.({ remote: false });
      if (serverAvailable) {
        try {
          await api('PUT', state, '?mode=replace');
          setStatus('synced');
        } catch {
          setStatus('offline', 'Imported on this device; server not updated');
        }
      }
    },
    /** First full sync; it also tells whether there is a server at all. */
    init() {
      return sync();
    },
    sync,
    /** A sync the user asked for: also retries a server that seemed absent. */
    syncNow() {
      clearTimeout(pushTimer);
      if (serverAvailable === false) {
        serverAvailable = null;
        return this.init();
      }
      return sync();
    },
    setPassword(pw) {
      try {
        if (pw) localStorage.setItem(PW_KEY, pw);
        else localStorage.removeItem(PW_KEY);
      } catch {
        /* ignore */
      }
      if (serverAvailable === false) serverAvailable = null;
      return this.init();
    },
    hasPassword: () => !!password(),
  };
}
