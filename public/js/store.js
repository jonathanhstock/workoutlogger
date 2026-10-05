// Client-side persistence and sync.
//
// The browser always keeps a full copy in localStorage, so the app works
// offline and instantly. When the server is reachable, changes are pushed
// (debounced) and the server's merged copy is pulled back in.

import { defaultState, mergeStates, normalizeState, statesEqual } from './model.js';

const KEY = 'workout-logbook:v1';
const PW_KEY = 'workout-logbook:password';
const PUSH_DELAY = 700;

export function createStore({ onChange, onSyncStatus }) {
  let state = load();
  let pushTimer = null;
  let dirty = false;
  let serverAvailable = null; // null = unknown
  let status = 'local';

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) return normalizeState(JSON.parse(raw));
    } catch (err) {
      console.warn('Could not read saved data', err);
    }
    // Defaults are stamped with time 0 so that, on a brand-new device, any
    // real data already on the server wins the merge.
    return defaultState(0);
  }

  function persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (err) {
      console.error('Could not save locally', err);
      setStatus('error', 'Could not save on this device (storage full?)');
    }
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
    const headers = { 'Content-Type': 'application/json' };
    const pw = password();
    if (pw) headers.Authorization = `Bearer ${pw}`;
    const res = await fetch(`api/state${query}`, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
    if (res.status === 401) throw Object.assign(new Error('Password required'), { auth: true });
    if (!res.ok) throw new Error(`Server error ${res.status}`);
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
        const changed = absorb(remote);
        setStatus('synced');
        if (changed) onChange?.({ remote: true });
      } catch (err) {
        if (err.auth) setStatus('auth', 'Enter your password in Settings to sync');
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
          state = await api('PUT', state, '?mode=replace');
          persist();
          setStatus('synced');
        } catch {
          setStatus('offline', 'Imported on this device; server not updated');
        }
      }
    },
    /** Detect the server and do a first full sync. */
    async init() {
      try {
        const res = await fetch('api/health', { cache: 'no-store' });
        const ct = res.headers.get('content-type') || '';
        serverAvailable = res.ok && ct.includes('json');
      } catch {
        serverAvailable = null; // offline right now; try again later
      }
      if (serverAvailable === false) {
        setStatus('local', 'No server: data is stored on this device only');
        return;
      }
      await sync();
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
