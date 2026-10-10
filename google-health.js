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

// What each permission brings in, for "not allowed" messages in Settings.
const SCOPE_LABELS = {
  [GOOGLE_SCOPES[0]]: 'steps and workouts',
  [GOOGLE_SCOPES[1]]: 'weight and resting heart rate',
  [GOOGLE_SCOPES[2]]: 'sleep',
};

// Sleep and exercise lists allow at most 25 per page; others go up to 10000.
const PAGE_SIZE = { sleep: 25, exercise: 25 };

const FIRST_DAYS = 30; // history pulled on the first sync
const OVERLAP_DAYS = 3; // re-read a few days so late syncs from the watch land
const MAX_DAYS = 90; // the longest range Google's daily roll-up accepts
const MIN_INTERVAL_MS = 10 * 60 * 1000; // automatic syncs at most this often
const STATE_TTL_MS = 10 * 60 * 1000;

// Formats a Date as a YYYY-MM-DD string (UTC).
const iso = (d) => d.toISOString().slice(0, 10);
// Returns the YYYY-MM-DD date n days after the given one.
const addDays = (date, n) => iso(new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400000));
// Turns a Google {year, month, day} date into YYYY-MM-DD, or '' if missing.
const civil = (d) => (d && d.year ? `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}` : '');
// Turns YYYY-MM-DD into the {year, month, day} object Google expects.
const dateObj = (date) => {
  const [year, month, day] = date.split('-').map(Number);
  return { year, month, day };
};
/**
 * Minutes asleep in one Google Health sleep session. Uses Google's summary,
 * falling back to the stages (still processing) or the time in bed.
 */
export function sleepMinutes(sl) {
  const sum = sl?.summary || {};
  const asleep = Number(sum.minutesAsleep) || 0;
  if (asleep) return asleep;
  const awake = new Set(['AWAKE', 'RESTLESS', 'SLEEP_STAGE_TYPE_UNSPECIFIED']);
  const fromSummary = (sum.stagesSummary || []).filter((x) => !awake.has(x.type)).reduce((a, x) => a + (Number(x.minutes) || 0), 0);
  if (fromSummary) return fromSummary;
  const fromStages = (sl?.stages || []).filter((x) => !awake.has(x.type)).reduce((a, x) => a + Math.max(0, Date.parse(x.endTime) - Date.parse(x.startTime)) / 60000, 0);
  if (fromStages) return Math.round(fromStages);
  const inBed = Number(sum.minutesInSleepPeriod) || Math.max(0, Date.parse(sl?.interval?.endTime) - Date.parse(sl?.interval?.startTime)) / 60000 || 0;
  return Math.max(0, Math.round(inBed - (Number(sum.minutesAwake) || 0)));
}

/**
 * The local date (YYYY-MM-DD) a sleep session ended, from Google's civil end
 * time or, if that's missing, the end timestamp plus its UTC offset.
 */
export function wakeDate(sl) {
  const c = civil(sl?.interval?.civilEndTime?.date);
  if (c) return c;
  const end = Date.parse(sl?.interval?.endTime);
  if (!end) return '';
  return iso(new Date(end + seconds(sl.interval.endUtcOffset) * 1000));
}

// Converts a Google duration string like "3120s" (or "-25200s") into seconds.
const seconds = (dur) => (typeof dur === 'string' && dur.endsWith('s') ? Number(dur.slice(0, -1)) || 0 : 0);

// Creates the Fitbit / Google Health connection: sign-in, token storage and data import.
export function createGoogleHealth({ dataDir, clientId = '', clientSecret = '', publicUrl = '', fetch: fetchImpl = globalThis.fetch }) {
  const file = path.join(dataDir, 'google.json');
  const pending = new Map(); // OAuth state -> expiry
  let saved = readSaved();
  let access = null; // { token, expires }
  let running = null;

  // Reads the saved sign-in (refresh token and sync info) from google.json, if any.
  function readSaved() {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  // Saves the sign-in to google.json (owner-only), or deletes the file when given null.
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

  // Tells whether the Google client id and secret are set on the server.
  const configured = () => !!(clientId && clientSecret);

  // Builds the address Google sends the browser back to after sign-in.
  function redirectUri(req) {
    let base = publicUrl;
    if (!base && req) {
      const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (req.socket.encrypted ? 'https' : 'http');
      base = `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
    }
    return `${String(base).replace(/\/+$/, '')}/api/google/callback`;
  }

  // Describes the connection for Settings without exposing any token.
  function status(req) {
    return {
      configured: configured(),
      connected: !!saved?.refreshToken,
      needsReconnect: !!saved?.needsReconnect,
      connectedAt: saved?.connectedAt || 0,
      lastSync: saved?.lastSync || 0,
      lastError: saved?.lastError || '',
      lastFound: saved?.lastFound || null,
      // Permissions left unticked on Google's consent screen.
      missing: saved?.scope ? GOOGLE_SCOPES.filter((sc) => !saved.scope.split(' ').includes(sc)).map((sc) => SCOPE_LABELS[sc]) : [],
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

  // Posts a form to Google’s token endpoint and returns the parsed reply.
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

  // Returns a valid access token, refreshing it with the saved refresh token when needed.
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

  // Calls a Google Health API data type endpoint and returns its JSON.
  async function api(method, pathname, { query, body } = {}) {
    const token = await accessToken();
    const url = `${API}/${pathname}${query ? `?${new URLSearchParams(query)}` : ''}`;
    const res = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 403) throw new Error('permission not allowed. Tap Connect and allow it on Google\'s screen.');
    if (!res.ok) throw new Error(data.error?.message || `Google Health API error ${res.status}`);
    return data;
  }

  /**
   * All pages of a list call (sleep and exercise come 25 at a time). `how` is
   * `dataPoints` (one source's records) or `dataPoints:reconcile` (merged).
   */
  async function list(type, filter, how = 'dataPoints') {
    const out = [];
    let pageToken = '';
    for (let page = 0; page < 40; page++) {
      const data = await api('GET', `${type}/${how}`, { query: { filter, pageSize: String(PAGE_SIZE[type] || 1000), ...(pageToken ? { pageToken } : {}) } });
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
    // What Google returned, shown in Settings to tell "no data" from "not working".
    const found = { steps: 0, restingHr: 0, sleep: 0, weight: 0, exercise: 0 };
    // Returns the import record for a date, creating it if needed.
    const day = (d) => (days[d] ||= {});
    // Fills a field on every date in range that got no data, so stale values clear.
    const blank = (field, value) => {
      // Dates in range with no data clear that field (e.g. a deleted activity).
      for (let d = from; d <= to; d = addDays(d, 1)) if (day(d)[field] === undefined) day(d)[field] = value;
    };
    // Runs one data kind’s import, collecting its error instead of stopping the rest.
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
        if (d && Number(p.steps?.countSum)) found.steps++;
      }
      blank('steps', 0);
    });

    await step('resting heart rate', async () => {
      for (const p of await list('daily-resting-heart-rate', `daily_resting_heart_rate.date >= "${from}" AND daily_resting_heart_rate.date < "${addDays(to, 1)}"`)) {
        const r = p.dailyRestingHeartRate;
        const d = civil(r?.date);
        if (d) day(d).restingHr = Number(r.beatsPerMinute) || 0;
        if (d) found.restingHr++;
      }
      blank('restingHr', 0);
    });

    await step('sleep', async () => {
      // Google's docs point sleep at the "reconcile" call (one merged stream
      // across devices); the plain list is a fallback. Each is tried with a
      // date filter and a timestamp filter, until one returns sessions.
      const civilFilter = `sleep.interval.civil_end_time >= "${from}" AND sleep.interval.civil_end_time < "${addDays(to, 1)}"`;
      const timeFilter = `sleep.interval.end_time >= "${addDays(from, -1)}T00:00:00Z" AND sleep.interval.end_time < "${addDays(to, 2)}T00:00:00Z"`;
      let sessions = null;
      const failures = [];
      for (const [how, filter] of [
        ['dataPoints:reconcile', civilFilter],
        ['dataPoints:reconcile', timeFilter],
        ['dataPoints', civilFilter],
        ['dataPoints', timeFilter],
      ]) {
        try {
          const got = (await list('sleep', filter, how)).filter((p) => p.sleep);
          sessions = got;
          if (got.length) break;
        } catch (err) {
          if (err.status === 409) throw err;
          failures.push(err.message);
        }
      }
      // Nothing found and something failed: report it rather than clearing
      // sleep that was imported before.
      if (!sessions?.length && failures.length) throw new Error(failures[0]);
      // Sleep counts toward the day you woke up.
      const total = {};
      const seen = new Set();
      for (const p of sessions) {
        const sl = p.sleep;
        const key = `${sl.interval?.startTime}|${sl.interval?.endTime}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const d = wakeDate(sl);
        // Naps don't count, but the night's main sleep always does.
        if (!d || d < from || d > to || (sl.metadata?.nap && !sl.metadata?.mainSleep)) continue;
        total[d] = (total[d] || 0) + sleepMinutes(sl);
        found.sleep++;
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
      found.weight = Object.keys(latest).length;
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
      found.exercise = Object.values(acts).reduce((n, a) => n + a.length, 0);
      for (const [d, list] of Object.entries(acts)) day(d).activities = list.sort((a, b) => (a.start < b.start ? -1 : 1));
      blank('activities', []);
    });

    return { days, weights, errors, found };
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
      // Start from the last import that fully worked (minus a few days for
      // late watch syncs), so a failed import never leaves a gap. Google's
      // daily roll-ups cover at most 90 days. A last import dated after
      // `today` (a clock or time-zone skew) never pushes the start past it.
      const good = saved.lastGood ? [iso(new Date(saved.lastGood)), today].sort()[0] : '';
      const from = [good ? addDays(good, -OVERLAP_DAYS) : addDays(today, -(FIRST_DAYS - 1)), addDays(today, -(MAX_DAYS - 2))].sort().pop();
      // Ask through tomorrow: Google dates are in your time zone, the server's are UTC.
      const result = { ...(await fetchRange(from, addDays(today, 1))), from, to: today };
      // Disconnected while this ran: don't bring the file back.
      if (!saved?.refreshToken) return result;
      const t = Date.now();
      await writeSaved({
        ...saved,
        lastSync: t,
        ...(result.errors.length ? {} : { lastGood: t }),
        lastError: result.errors.join(' · '),
        lastFound: { ...result.found, from: result.from, to: result.to },
      });
      return result;
    })().finally(() => {
      running = null;
    });
    return running;
  }

  // Revokes the Google sign-in and forgets the saved token.
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
