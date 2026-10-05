// Fitbit / Google Health connection (server side only).
//
// Google replaced the Fitbit Web API with the Google Health API in 2026. It
// uses Google sign-in (OAuth 2.0): you connect once from Settings, the server
// keeps the refresh token in DATA_DIR/google.json (never sent to the browser
// or synced), and each sync imports recent steps, resting heart rate, sleep,
// weight and exercise sessions.
//
// Setup: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET from a Google Cloud OAuth
// "Web application" client with the Google Health API enabled. See README.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const API = 'https://health.googleapis.com/v4/users/me/dataTypes';

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly', // steps, exercise
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly', // weight, resting HR
  'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
];

const FIRST_DAYS = 30; // history pulled on the first sync
const OVERLAP_DAYS = 3; // re-read a few days so late syncs from the watch land
const MIN_INTERVAL_MS = 10 * 60 * 1000; // automatic syncs at most this often
const STATE_TTL_MS = 10 * 60 * 1000;

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (date, n) => iso(new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400000));
const civil = (d) => (d && d.year ? `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}` : '');
const dateObj = (date) => {
  const [year, month, day] = date.split('-').map(Number);
  return { year, month, day };
};
const seconds = (dur) => (typeof dur === 'string' && dur.endsWith('s') ? Number(dur.slice(0, -1)) || 0 : 0);

export function createGoogleHealth({ dataDir, clientId = '', clientSecret = '', publicUrl = '', fetch: fetchImpl = globalThis.fetch }) {
  const file = path.join(dataDir, 'google.json');
  const pending = new Map(); // OAuth state -> expiry
  let saved = readSaved();
  let access = null; // { token, expires }
  let running = null;

  function readSaved() {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  async function writeSaved(next) {
    saved = next;
    if (!next) {
      await fsp.rm(file, { force: true });
      return;
    }
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    await fsp.rename(tmp, file);
  }

  const configured = () => !!(clientId && clientSecret);

  function redirectUri(req) {
    let base = publicUrl;
    if (!base && req) {
      const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (req.socket.encrypted ? 'https' : 'http');
      base = `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
    }
    return `${String(base).replace(/\/+$/, '')}/api/google/callback`;
  }

  function status(req) {
    return {
      configured: configured(),
      connected: !!saved?.refreshToken,
      needsReconnect: !!saved?.needsReconnect,
      connectedAt: saved?.connectedAt || 0,
      lastSync: saved?.lastSync || 0,
      lastError: saved?.lastError || '',
      redirectUri: redirectUri(req),
    };
  }

  /** URL to send the browser to for Google sign-in. */
  function connectUrl(req) {
    if (!configured()) throw Object.assign(new Error('Google sign-in is not set up on the server'), { status: 400 });
    const now = Date.now();
    for (const [k, exp] of pending) if (exp < now) pending.delete(k);
    const state = crypto.randomBytes(24).toString('base64url');
    pending.set(state, now + STATE_TTL_MS);
    const q = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri(req),
      response_type: 'code',
      scope: GOOGLE_SCOPES.join(' '),
      access_type: 'offline', // a refresh token, so syncing works without signing in again
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    });
    return `${AUTH_URL}?${q}`;
  }

  async function tokenRequest(params) {
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error_description || body.error || `Token request failed (${res.status})`), { oauth: body.error });
    return body;
  }

  /** Google redirected back with a code: trade it for tokens. */
  async function finishConnect(req, url) {
    const state = url.searchParams.get('state') || '';
    const exp = pending.get(state);
    pending.delete(state);
    if (!exp || exp < Date.now()) throw new Error('Sign-in expired or was started elsewhere. Try Connect again.');
    if (url.searchParams.get('error')) throw new Error(`Google said: ${url.searchParams.get('error')}`);
    const code = url.searchParams.get('code');
    if (!code) throw new Error('Google did not return a sign-in code');
    const tok = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: redirectUri(req) });
    const refreshToken = tok.refresh_token || saved?.refreshToken;
    if (!refreshToken) throw new Error('Google did not grant offline access. Remove the app at myaccount.google.com/permissions and connect again.');
    access = tok.access_token ? { token: tok.access_token, expires: Date.now() + (tok.expires_in || 3600) * 1000 } : null;
    await writeSaved({ refreshToken, scope: tok.scope || '', connectedAt: Date.now(), lastSync: 0, lastError: '' });
  }

  async function accessToken() {
    if (access && access.expires - 60000 > Date.now()) return access.token;
    try {
      const tok = await tokenRequest({ refresh_token: saved.refreshToken, grant_type: 'refresh_token' });
      access = { token: tok.access_token, expires: Date.now() + (tok.expires_in || 3600) * 1000 };
      return access.token;
    } catch (err) {
      // invalid_grant: revoked, or the 7-day limit of an app in "Testing".
      if (err.oauth === 'invalid_grant') {
        await writeSaved({ ...saved, needsReconnect: true, lastError: 'Google sign-in expired. Tap Connect to sign in again.' });
        err.status = 409; // not 401: that means "wrong app password" to the browser
      }
      throw err;
    }
  }

  async function api(method, pathname, { query, body } = {}) {
    const token = await accessToken();
    const url = `${API}/${pathname}${query ? `?${new URLSearchParams(query)}` : ''}`;
    const res = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || `Google Health API error ${res.status}`);
    return data;
  }

  /** All pages of a list call (sleep and exercise come 25 at a time). */
  async function list(type, filter) {
    const out = [];
    let pageToken = '';
    for (let page = 0; page < 40; page++) {
      const data = await api('GET', `${type}/dataPoints`, { query: { filter, pageSize: '1000', ...(pageToken ? { pageToken } : {}) } });
      out.push(...(data.dataPoints || []));
      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  }

  /** Fetch [from, to] (dates) from Google; each kind is independent. */
  async function fetchRange(from, to) {
    const days = {};
    const weights = {};
    const errors = [];
    const day = (d) => (days[d] ||= {});
    const blank = (field, value) => {
      // Dates in range with no data clear that field (e.g. a deleted activity).
      for (let d = from; d <= to; d = addDays(d, 1)) if (day(d)[field] === undefined) day(d)[field] = value;
    };
    const step = async (name, fn) => {
      try {
        await fn();
      } catch (err) {
        if (err.status === 409) throw err;
        errors.push(`${name}: ${err.message}`);
      }
    };

    await step('steps', async () => {
      const data = await api('POST', 'steps/dataPoints:dailyRollUp', {
        body: { range: { start: { date: dateObj(from) }, end: { date: dateObj(addDays(to, 1)) } }, windowSizeDays: 1 },
      });
      for (const p of data.rollupDataPoints || []) {
        const d = civil(p.civilStartTime?.date);
        if (d) day(d).steps = Number(p.steps?.countSum) || 0;
      }
      blank('steps', 0);
    });

    await step('resting heart rate', async () => {
      for (const p of await list('daily-resting-heart-rate', `daily_resting_heart_rate.date >= "${from}" AND daily_resting_heart_rate.date < "${addDays(to, 1)}"`)) {
        const r = p.dailyRestingHeartRate;
        const d = civil(r?.date);
        if (d) day(d).restingHr = Number(r.beatsPerMinute) || 0;
      }
      blank('restingHr', 0);
    });

    await step('sleep', async () => {
      // Sleep counts toward the day you woke up.
      const total = {};
      for (const p of await list('sleep', `sleep.interval.civil_end_time >= "${from}" AND sleep.interval.civil_end_time < "${addDays(to, 1)}"`)) {
        const sl = p.sleep;
        const d = civil(sl?.interval?.civilEndTime?.date);
        if (!d || sl.metadata?.nap) continue;
        total[d] = (total[d] || 0) + (Number(sl.summary?.minutesAsleep) || 0);
      }
      for (const [d, min] of Object.entries(total)) day(d).sleepMin = min;
      blank('sleepMin', 0);
    });

    await step('weight', async () => {
      const latest = {};
      for (const p of await list('weight', `weight.sample_time.civil_time >= "${from}" AND weight.sample_time.civil_time < "${addDays(to, 1)}"`)) {
        const w = p.weight;
        const d = civil(w?.sampleTime?.civilTime?.date);
        const at = Date.parse(w?.sampleTime?.physicalTime) || 0;
        // The last weigh-in of the day wins.
        if (d && w.weightGrams > 0 && (!latest[d] || at >= latest[d].at)) latest[d] = { at, grams: w.weightGrams };
      }
      for (const [d, v] of Object.entries(latest)) weights[d] = v.grams;
    });

    await step('exercise', async () => {
      const acts = {};
      for (const p of await list('exercise', `exercise.interval.civil_start_time >= "${from}" AND exercise.interval.civil_start_time < "${addDays(to, 1)}"`)) {
        const ex = p.exercise;
        const start = ex?.interval?.civilStartTime;
        const d = civil(start?.date);
        if (!d) continue;
        const m = ex.metricsSummary || {};
        const dur = seconds(ex.activeDuration) || (Date.parse(ex.interval.endTime) - Date.parse(ex.interval.startTime)) / 1000 || 0;
        const t = start.time || {};
        (acts[d] ||= []).push({
          name: ex.displayName || String(ex.exerciseType || 'Activity').replace(/_/g, ' ').toLowerCase(),
          start: t.hours !== undefined ? `${String(t.hours || 0).padStart(2, '0')}:${String(t.minutes || 0).padStart(2, '0')}` : '',
          minutes: Math.round(dur / 6) / 10,
          calories: Math.round(Number(m.caloriesKcal) || 0),
          avgHr: Number(m.averageHeartRateBeatsPerMinute) || 0,
          distanceKm: Math.round((Number(m.distanceMillimeters) || 0) / 10000) / 100,
          steps: Number(m.steps) || 0,
        });
      }
      for (const [d, list] of Object.entries(acts)) day(d).activities = list.sort((a, b) => (a.start < b.start ? -1 : 1));
      blank('activities', []);
    });

    return { days, weights, errors };
  }

  /**
   * Import recent data. Resolves to { days, weights, errors } for the caller
   * to merge into the logbook, or null when skipped (synced recently).
   */
  function sync({ force = false, today = iso(new Date()) } = {}) {
    if (!configured() || !saved?.refreshToken || saved.needsReconnect) return Promise.resolve(null);
    if (!force && Date.now() - (saved.lastSync || 0) < MIN_INTERVAL_MS) return Promise.resolve(null);
    if (running) return running;
    running = (async () => {
      const last = saved.lastSync ? iso(new Date(saved.lastSync)) : '';
      const from = last ? addDays(last, -OVERLAP_DAYS) : addDays(today, -(FIRST_DAYS - 1));
      // Ask through tomorrow: Google dates are in your time zone, the server's are UTC.
      const result = await fetchRange(from, addDays(today, 1));
      await writeSaved({ ...saved, lastSync: Date.now(), lastError: result.errors.join(' · ') });
      return result;
    })().finally(() => {
      running = null;
    });
    return running;
  }

  async function disconnect() {
    if (saved?.refreshToken) {
      // Best effort: also remove the app's access on Google's side.
      await fetchImpl(`${REVOKE_URL}?${new URLSearchParams({ token: saved.refreshToken })}`, { method: 'POST' }).catch(() => {});
    }
    access = null;
    await writeSaved(null);
  }

  return { configured, status, connectUrl, finishConnect, sync, disconnect };
}
