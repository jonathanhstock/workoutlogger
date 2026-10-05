// Core data model and pure logic for the logbook.
// Shared by the browser app, the Node server (for merging) and the tests,
// so nothing in here may touch the DOM, storage or the network.

export const SCHEMA_VERSION = 1;

export const KINDS = {
  strength: 'Strength',
  cardio: 'Cardio',
  vacuum: 'Stomach vacuum',
};

export const DAY_TYPES = {
  training: 'Training',
  active: 'Active rest',
  rest: 'Rest',
};

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function now() {
  return Date.now();
}

const pad = (n) => String(n).padStart(2, '0');

/** Local calendar date as YYYY-MM-DD. */
export function toISODate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayISO() {
  return toISODate(new Date());
}

/** Parse YYYY-MM-DD as a local date at noon (noon avoids DST edge cases). */
export function parseISODate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}

export function isISODate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(parseISODate(s).getTime());
}

export function addDays(iso, n) {
  const d = parseISODate(iso);
  d.setDate(d.getDate() + n);
  return toISODate(d);
}

export function weekdayOf(iso) {
  return parseISODate(iso).getDay();
}

export function startOfWeek(iso, weekStart = 1) {
  const diff = (weekdayOf(iso) - weekStart + 7) % 7;
  return addDays(iso, -diff);
}

export function daysBetween(a, b) {
  return Math.round((parseISODate(b) - parseISODate(a)) / 86400000);
}

export function clampNum(v, min = 0, max = 100000) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/** Round away floating point noise (e.g. 0.1 + 0.2). */
export function round(n, digits = 2) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

const clone = (o) => JSON.parse(JSON.stringify(o));

// ---------------------------------------------------------------------------
// Default state
// ---------------------------------------------------------------------------

const DEFAULT_EXERCISES = [
  ['bench', 'Bench Press', 'strength', 'Chest'],
  ['incline-db', 'Incline Dumbbell Press', 'strength', 'Chest'],
  ['ohp', 'Overhead Press', 'strength', 'Shoulders'],
  ['lateral-raise', 'Lateral Raise', 'strength', 'Shoulders'],
  ['pushdown', 'Triceps Pushdown', 'strength', 'Arms'],
  ['deadlift', 'Deadlift', 'strength', 'Back'],
  ['pullup', 'Pull-up', 'strength', 'Back'],
  ['row', 'Barbell Row', 'strength', 'Back'],
  ['lat-pulldown', 'Lat Pulldown', 'strength', 'Back'],
  ['curl', 'Dumbbell Curl', 'strength', 'Arms'],
  ['squat', 'Back Squat', 'strength', 'Legs'],
  ['rdl', 'Romanian Deadlift', 'strength', 'Legs'],
  ['leg-press', 'Leg Press', 'strength', 'Legs'],
  ['leg-curl', 'Leg Curl', 'strength', 'Legs'],
  ['calf-raise', 'Calf Raise', 'strength', 'Legs'],
  ['treadmill', 'Treadmill', 'cardio', 'Cardio'],
  ['incline-walk', 'Incline Walk', 'cardio', 'Cardio'],
  ['bike', 'Stationary Bike', 'cardio', 'Cardio'],
  ['stairmaster', 'Stairmaster', 'cardio', 'Cardio'],
  ['rower', 'Rowing Machine', 'cardio', 'Cardio'],
  ['vacuum-standing', 'Stomach Vacuum (standing)', 'vacuum', 'Core'],
  ['vacuum-kneeling', 'Stomach Vacuum (kneeling)', 'vacuum', 'Core'],
  ['vacuum-lying', 'Stomach Vacuum (lying)', 'vacuum', 'Core'],
];

function planItem(exerciseId, kind, t) {
  return { id: uid(), exerciseId, ...defaultTarget(kind), ...t };
}

/** A starter split the user can freely edit. Keyed by weekday (0 = Sunday). */
function defaultPlan(ts) {
  const day = (name, dayType, items) => ({ name, dayType, items, updatedAt: ts });
  const s = (id, sets, reps, weight = 0) => planItem(id, 'strength', { sets, reps, weight });
  const c = (id, minutes, distance = 0) => planItem(id, 'cardio', { minutes, distance });
  const v = (id, sets, holdSec) => planItem(id, 'vacuum', { sets, holdSec });
  return {
    1: day('Push', 'training', [s('bench', 4, 8), s('ohp', 3, 8), s('incline-db', 3, 10), s('lateral-raise', 3, 12), s('pushdown', 3, 12), v('vacuum-standing', 3, 20)]),
    2: day('Pull', 'training', [s('deadlift', 3, 5), s('pullup', 3, 8), s('row', 3, 8), s('lat-pulldown', 3, 10), s('curl', 3, 12), v('vacuum-standing', 3, 20)]),
    3: day('Legs', 'training', [s('squat', 4, 6), s('rdl', 3, 8), s('leg-press', 3, 10), s('leg-curl', 3, 12), s('calf-raise', 4, 12), v('vacuum-standing', 3, 20)]),
    4: day('Active rest', 'active', [c('incline-walk', 30), v('vacuum-kneeling', 4, 25)]),
    5: day('Upper', 'training', [s('bench', 3, 6), s('row', 3, 8), s('ohp', 3, 10), s('pullup', 3, 8), s('curl', 2, 12), s('pushdown', 2, 12), v('vacuum-standing', 3, 20)]),
    6: day('Lower + cardio', 'training', [s('squat', 3, 8), s('rdl', 3, 10), s('leg-curl', 3, 12), c('bike', 20), v('vacuum-lying', 3, 30)]),
    0: day('Rest', 'rest', [v('vacuum-lying', 3, 30)]),
  };
}

export function defaultState(ts = now()) {
  const exercises = {};
  for (const [id, name, kind, group] of DEFAULT_EXERCISES) {
    exercises[id] = { id, name, kind, group, updatedAt: ts };
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: { unit: 'lb', distanceUnit: 'mi', weightStep: 5, weekStart: 1, updatedAt: ts },
    exercises,
    plan: defaultPlan(ts),
    sessions: {},
  };
}

export function defaultTarget(kind) {
  if (kind === 'cardio') return { minutes: 20, distance: 0 };
  if (kind === 'vacuum') return { sets: 3, holdSec: 20 };
  return { sets: 3, reps: 10, weight: 0 };
}

// ---------------------------------------------------------------------------
// Validation / migration (used on load and import)
// ---------------------------------------------------------------------------

/**
 * Coerce arbitrary (possibly old, partial or hand-edited) data into a valid
 * state object. Never throws for "shape" problems; it repairs what it can.
 */
export function normalizeState(input) {
  const base = defaultState(0);
  if (!input || typeof input !== 'object') return defaultState(0);
  const out = {
    schemaVersion: SCHEMA_VERSION,
    settings: { ...base.settings, ...(isObj(input.settings) ? input.settings : {}) },
    exercises: {},
    plan: {},
    sessions: {},
  };
  out.settings.unit = out.settings.unit === 'kg' ? 'kg' : 'lb';
  out.settings.distanceUnit = out.settings.distanceUnit === 'km' ? 'km' : 'mi';
  out.settings.weightStep = clampNum(out.settings.weightStep, 0.25, 100) || 5;
  out.settings.weekStart = Number(out.settings.weekStart) === 0 ? 0 : 1;
  out.settings.updatedAt = Number(out.settings.updatedAt) || 0;

  const exercises = isObj(input.exercises) ? input.exercises : base.exercises;
  for (const [id, ex] of Object.entries(exercises)) {
    if (!isObj(ex)) continue;
    out.exercises[id] = {
      id,
      name: String(ex.name || 'Exercise').slice(0, 80),
      kind: KINDS[ex.kind] ? ex.kind : 'strength',
      group: String(ex.group || '').slice(0, 40),
      updatedAt: Number(ex.updatedAt) || 0,
      ...(ex.deleted ? { deleted: true } : {}),
    };
  }

  const plan = isObj(input.plan) ? input.plan : base.plan;
  for (let wd = 0; wd < 7; wd++) {
    const d = isObj(plan[wd]) ? plan[wd] : { name: '', dayType: 'rest', items: [] };
    out.plan[wd] = {
      name: String(d.name || '').slice(0, 60),
      dayType: DAY_TYPES[d.dayType] ? d.dayType : 'training',
      items: (Array.isArray(d.items) ? d.items : []).filter((it) => isObj(it) && it.exerciseId).map((it) => normalizeTarget({ ...it, id: it.id || uid() })),
      updatedAt: Number(d.updatedAt) || 0,
    };
  }

  const sessions = isObj(input.sessions) ? input.sessions : {};
  for (const [date, s] of Object.entries(sessions)) {
    if (!isISODate(date) || !isObj(s)) continue;
    if (s.deleted) {
      out.sessions[date] = { date, deleted: true, updatedAt: Number(s.updatedAt) || 0 };
      continue;
    }
    out.sessions[date] = {
      date,
      name: String(s.name || '').slice(0, 60),
      dayType: DAY_TYPES[s.dayType] ? s.dayType : 'training',
      notes: String(s.notes || '').slice(0, 5000),
      entries: (Array.isArray(s.entries) ? s.entries : []).filter((e) => isObj(e) && e.exerciseId).map(normalizeEntry),
      updatedAt: Number(s.updatedAt) || 0,
    };
  }
  return out;
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function normalizeTarget(t) {
  const out = { id: t.id || uid(), exerciseId: String(t.exerciseId) };
  for (const k of ['sets', 'reps', 'weight', 'minutes', 'distance', 'holdSec']) {
    if (t[k] !== undefined) out[k] = clampNum(t[k], 0, 100000);
  }
  return out;
}

function normalizeEntry(e) {
  const kind = KINDS[e.kind] ? e.kind : 'strength';
  const out = {
    id: e.id || uid(),
    exerciseId: String(e.exerciseId),
    kind,
    target: normalizeTarget({ ...(isObj(e.target) ? e.target : defaultTarget(kind)), exerciseId: e.exerciseId }),
    notes: String(e.notes || '').slice(0, 1000),
  };
  delete out.target.id;
  delete out.target.exerciseId;
  if (kind === 'cardio') {
    const c = isObj(e.cardio) ? e.cardio : {};
    out.cardio = {
      minutes: clampNum(c.minutes),
      distance: clampNum(c.distance),
      calories: clampNum(c.calories),
      avgHr: clampNum(c.avgHr, 0, 260),
      done: !!c.done,
    };
  } else {
    out.sets = (Array.isArray(e.sets) ? e.sets : []).filter(isObj).map((s) =>
      kind === 'vacuum'
        ? { id: s.id || uid(), holdSec: clampNum(s.holdSec), done: !!s.done }
        : { id: s.id || uid(), reps: clampNum(s.reps), weight: clampNum(s.weight), done: !!s.done },
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Merging (multi-device sync)
// ---------------------------------------------------------------------------

/**
 * Merge two states record-by-record. For each exercise, plan day, session and
 * the settings object, the version with the newest `updatedAt` wins. Deletions
 * are kept as tombstones so they propagate between devices.
 * The function is commutative, associative and idempotent, which makes sync
 * safe to repeat in any order.
 */
export function mergeStates(a, b) {
  a = normalizeState(a);
  b = normalizeState(b);
  const pick = (x, y) => {
    if (!x) return y;
    if (!y) return x;
    if (x.updatedAt !== y.updatedAt) return x.updatedAt > y.updatedAt ? x : y;
    // Same timestamp: deterministic tie-break so both sides converge.
    return JSON.stringify(x) >= JSON.stringify(y) ? x : y;
  };
  const mergeMap = (x, y) => {
    const out = {};
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) out[k] = clone(pick(x[k], y[k]));
    return out;
  };
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: clone(pick(a.settings, b.settings)),
    exercises: mergeMap(a.exercises, b.exercises),
    plan: mergeMap(a.plan, b.plan),
    sessions: mergeMap(a.sessions, b.sessions),
  };
}

export function statesEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Exercises
// ---------------------------------------------------------------------------

export function activeExercises(state) {
  return Object.values(state.exercises)
    .filter((e) => !e.deleted)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function exerciseName(state, id) {
  return state.exercises[id]?.name || 'Unknown exercise';
}

export function exerciseKind(state, id) {
  return state.exercises[id]?.kind || 'strength';
}

export function addExercise(state, { name, kind = 'strength', group = '' }) {
  const id = uid();
  state.exercises[id] = { id, name: name.trim().slice(0, 80) || 'New exercise', kind: KINDS[kind] ? kind : 'strength', group, updatedAt: now() };
  return id;
}

// ---------------------------------------------------------------------------
// Sessions (one per calendar day)
// ---------------------------------------------------------------------------

export function getSession(state, date) {
  const s = state.sessions[date];
  return s && !s.deleted ? s : null;
}

/** Build a new entry for an exercise, pre-filled from targets and last performance. */
export function makeEntry(state, exerciseId, target, beforeDate) {
  const kind = exerciseKind(state, exerciseId);
  const t = { ...defaultTarget(kind), ...pickTarget(kind, target || {}) };
  const entry = { id: uid(), exerciseId, kind, target: t, notes: '' };
  const prev = beforeDate ? previousEntry(state, exerciseId, beforeDate) : null;
  if (kind === 'cardio') {
    entry.cardio = { minutes: t.minutes, distance: t.distance, calories: 0, avgHr: 0, done: false };
  } else if (kind === 'vacuum') {
    entry.sets = Array.from({ length: t.sets }, () => ({ id: uid(), holdSec: t.holdSec, done: false }));
  } else {
    // Pre-fill each set with what you lifted last time (progressive overload
    // starts from your real numbers), falling back to the planned weight.
    const prevSets = prev?.entry.sets?.filter((s) => s.done) || [];
    entry.sets = Array.from({ length: t.sets }, (_, i) => {
      const p = prevSets[i] || prevSets[prevSets.length - 1];
      const weight = t.weight || p?.weight || 0;
      return { id: uid(), reps: t.reps, weight, done: false };
    });
    // Show the real working weight as this day's target.
    if (!t.weight && prevSets.length) t.weight = Math.max(...prevSets.map((s) => s.weight || 0));
  }
  return entry;
}

function pickTarget(kind, t) {
  const keys = kind === 'cardio' ? ['minutes', 'distance'] : kind === 'vacuum' ? ['sets', 'holdSec'] : ['sets', 'reps', 'weight'];
  const out = {};
  for (const k of keys) if (t[k] !== undefined) out[k] = clampNum(t[k]);
  return out;
}

/**
 * The session for a date, or an unsaved draft built from the weekly plan.
 * Drafts are not stored until the user changes something, so editing the
 * plan keeps updating every day you haven't started yet.
 */
export function sessionOrDraft(state, date) {
  const existing = getSession(state, date);
  if (existing) return { session: existing, draft: false };
  const day = state.plan[weekdayOf(date)];
  const session = {
    date,
    name: day?.name || '',
    dayType: day?.dayType || 'training',
    notes: '',
    entries: (day?.items || []).filter((it) => state.exercises[it.exerciseId] && !state.exercises[it.exerciseId].deleted).map((it) => makeEntry(state, it.exerciseId, it, date)),
    updatedAt: 0,
  };
  return { session, draft: true };
}

/** Return the stored session for a date, creating it from the plan if needed. */
export function ensureSession(state, date) {
  const existing = getSession(state, date);
  if (existing) return existing;
  const { session } = sessionOrDraft(state, date);
  session.updatedAt = now();
  state.sessions[date] = session;
  return session;
}

export function touchSession(state, date) {
  const s = getSession(state, date);
  if (s) s.updatedAt = now();
}

/** Throw away a day's log; it falls back to the plan again. */
export function resetSession(state, date) {
  state.sessions[date] = { date, deleted: true, updatedAt: now() };
}

export function findEntry(session, entryId) {
  return session?.entries.find((e) => e.id === entryId) || null;
}

/** Change an entry's target set count, adding/removing *unfinished* sets to match. */
export function setTargetSets(entry, n) {
  n = Math.round(clampNum(n, 0, 50));
  entry.target.sets = n;
  while (entry.sets.length < n) addSet(entry);
  // Only trim sets that haven't been done; never delete logged work.
  for (let i = entry.sets.length - 1; i >= 0 && entry.sets.length > n; i--) {
    if (!entry.sets[i].done) entry.sets.splice(i, 1);
  }
}

export function addSet(entry) {
  const last = entry.sets[entry.sets.length - 1];
  if (entry.kind === 'vacuum') {
    entry.sets.push({ id: uid(), holdSec: last?.holdSec ?? entry.target.holdSec ?? 20, done: false });
  } else {
    entry.sets.push({ id: uid(), reps: last?.reps ?? entry.target.reps ?? 10, weight: last?.weight ?? entry.target.weight ?? 0, done: false });
  }
}

export function removeLastSet(entry) {
  if (entry.sets.length) entry.sets.pop();
}

/** "+" on the completed counter: mark the next unfinished set done. */
export function completeNextSet(entry) {
  if (entry.kind === 'cardio') {
    entry.cardio.done = true;
    return;
  }
  const next = entry.sets.find((s) => !s.done);
  if (next) next.done = true;
  else {
    addSet(entry);
    entry.sets[entry.sets.length - 1].done = true;
  }
}

/** "−" on the completed counter: un-mark the most recently finished set. */
export function undoLastSet(entry) {
  if (entry.kind === 'cardio') {
    entry.cardio.done = false;
    return;
  }
  for (let i = entry.sets.length - 1; i >= 0; i--) {
    if (entry.sets[i].done) {
      entry.sets[i].done = false;
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Metrics & history
// ---------------------------------------------------------------------------

/** Epley estimated one-rep max. */
export function e1rm(weight, reps) {
  if (!weight || !reps) return 0;
  if (reps === 1) return weight;
  return round(weight * (1 + reps / 30), 1);
}

/**
 * Summary numbers for an entry. With `onlyDone` (the default) only completed
 * sets count, which is what "load" means for history and comparisons.
 */
export function entryMetrics(entry, onlyDone = true) {
  if (!entry) return null;
  if (entry.kind === 'cardio') {
    const c = entry.cardio || {};
    const counted = !onlyDone || c.done;
    const minutes = counted ? c.minutes || 0 : 0;
    const distance = counted ? c.distance || 0 : 0;
    return {
      kind: 'cardio',
      minutes,
      distance,
      calories: counted ? c.calories || 0 : 0,
      pace: distance > 0 ? round(minutes / distance, 2) : 0,
      done: !!c.done,
      load: minutes,
    };
  }
  const sets = (entry.sets || []).filter((s) => !onlyDone || s.done);
  if (entry.kind === 'vacuum') {
    const totalHold = sets.reduce((a, s) => a + (s.holdSec || 0), 0);
    return {
      kind: 'vacuum',
      sets: sets.length,
      totalHold,
      longestHold: sets.reduce((m, s) => Math.max(m, s.holdSec || 0), 0),
      load: totalHold,
    };
  }
  let volume = 0;
  let reps = 0;
  let top = null;
  let best1rm = 0;
  for (const s of sets) {
    volume += (s.weight || 0) * (s.reps || 0);
    reps += s.reps || 0;
    if (!top || s.weight > top.weight || (s.weight === top.weight && s.reps > top.reps)) top = s;
    best1rm = Math.max(best1rm, e1rm(s.weight, s.reps));
  }
  return {
    kind: 'strength',
    sets: sets.length,
    reps,
    volume: round(volume, 1),
    topWeight: top?.weight || 0,
    topReps: top?.reps || 0,
    e1rm: best1rm,
    load: round(volume, 1),
  };
}

/** True if an entry has any completed work. */
export function entryHasWork(entry) {
  if (entry.kind === 'cardio') return !!entry.cardio?.done;
  return (entry.sets || []).some((s) => s.done);
}

/** Sorted (ascending) list of stored session dates. */
export function sessionDates(state) {
  return Object.keys(state.sessions)
    .filter((d) => !state.sessions[d].deleted)
    .sort();
}

/** Most recent completed performance of an exercise strictly before a date. */
export function previousEntry(state, exerciseId, beforeDate) {
  const dates = sessionDates(state);
  for (let i = dates.length - 1; i >= 0; i--) {
    const d = dates[i];
    if (d >= beforeDate) continue;
    const s = state.sessions[d];
    // If the exercise appears twice in one day, use the one with most load.
    let best = null;
    for (const e of s.entries) {
      if (e.exerciseId !== exerciseId || !entryHasWork(e)) continue;
      if (!best || entryMetrics(e).load > entryMetrics(best).load) best = e;
    }
    if (best) return { date: d, entry: best };
  }
  return null;
}

/** Every completed performance of an exercise in [from, to], oldest first. */
export function exerciseHistory(state, exerciseId, from = '0000-01-01', to = '9999-12-31') {
  const out = [];
  for (const d of sessionDates(state)) {
    if (d < from || d > to) continue;
    for (const e of state.sessions[d].entries) {
      if (e.exerciseId === exerciseId && entryHasWork(e)) out.push({ date: d, entry: e, metrics: entryMetrics(e) });
    }
  }
  return out;
}

/** Exercises that have any logged work, most recently used first. */
export function loggedExerciseIds(state) {
  const last = {};
  for (const d of sessionDates(state)) {
    for (const e of state.sessions[d].entries) if (entryHasWork(e)) last[e.exerciseId] = d;
  }
  return Object.keys(last).sort((a, b) => (last[b] < last[a] ? -1 : last[b] > last[a] ? 1 : 0));
}

/** Status of a day for the calendar strip: 'done' | 'partial' | 'planned' | 'rest' | 'empty'. */
export function dayStatus(state, date) {
  const s = getSession(state, date);
  const dayType = s?.dayType || state.plan[weekdayOf(date)]?.dayType || 'training';
  if (s && s.entries.length) {
    const total = s.entries.length;
    const finished = s.entries.filter((e) => (e.kind === 'cardio' ? e.cardio.done : e.sets.length > 0 && e.sets.every((x) => x.done))).length;
    const any = s.entries.some(entryHasWork);
    if (finished === total) return 'done';
    if (any) return 'partial';
  }
  if (dayType === 'rest') return 'rest';
  const planned = s ? s.entries.length : state.plan[weekdayOf(date)]?.items.length;
  return planned ? 'planned' : 'empty';
}

/** Totals over a date range (inclusive). */
export function rangeSummary(state, from, to) {
  const sum = { workouts: 0, sets: 0, reps: 0, volume: 0, cardioMin: 0, distance: 0, vacuumSec: 0, vacuumSets: 0 };
  for (const d of sessionDates(state)) {
    if (d < from || d > to) continue;
    let worked = false;
    for (const e of state.sessions[d].entries) {
      if (!entryHasWork(e)) continue;
      worked = true;
      const m = entryMetrics(e);
      if (m.kind === 'strength') {
        sum.sets += m.sets;
        sum.reps += m.reps;
        sum.volume += m.volume;
      } else if (m.kind === 'cardio') {
        sum.cardioMin += m.minutes;
        sum.distance += m.distance;
      } else {
        sum.vacuumSec += m.totalHold;
        sum.vacuumSets += m.sets;
      }
    }
    if (worked) sum.workouts++;
  }
  sum.volume = round(sum.volume, 1);
  sum.distance = round(sum.distance, 2);
  return sum;
}

/** Per-week totals for charts, covering every week in [from, to]. */
export function weeklySummaries(state, from, to, weekStart = 1) {
  const out = [];
  for (let w = startOfWeek(from, weekStart); w <= to; w = addDays(w, 7)) {
    out.push({ week: w, ...rangeSummary(state, w, addDays(w, 6)) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Plan helpers
// ---------------------------------------------------------------------------

/** Copy a session's exercises and targets into the weekly plan for that weekday. */
export function saveSessionAsPlan(state, date) {
  const s = getSession(state, date) || sessionOrDraft(state, date).session;
  state.plan[weekdayOf(date)] = {
    name: s.name,
    dayType: s.dayType,
    items: s.entries.map((e) => ({ id: uid(), exerciseId: e.exerciseId, ...clone(e.target) })),
    updatedAt: now(),
  };
}

export function copyPlanDay(state, fromWd, toWd) {
  const src = state.plan[fromWd];
  state.plan[toWd] = {
    name: src.name,
    dayType: src.dayType,
    items: src.items.map((it) => ({ ...clone(it), id: uid() })),
    updatedAt: now(),
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One row per logged set / cardio session, for spreadsheets. */
export function toCSV(state) {
  const rows = [['date', 'day', 'exercise', 'type', 'set', 'weight', 'reps', 'hold_sec', 'minutes', 'distance', 'calories', 'avg_hr', 'done', `unit=${state.settings.unit}`]];
  for (const d of sessionDates(state)) {
    const s = state.sessions[d];
    for (const e of s.entries) {
      const name = exerciseName(state, e.exerciseId);
      if (e.kind === 'cardio') {
        const c = e.cardio;
        rows.push([d, s.name, name, 'cardio', 1, '', '', '', c.minutes, c.distance, c.calories, c.avgHr, c.done ? 1 : 0]);
      } else {
        e.sets.forEach((x, i) => {
          rows.push([d, s.name, name, e.kind, i + 1, e.kind === 'strength' ? x.weight : '', e.kind === 'strength' ? x.reps : '', e.kind === 'vacuum' ? x.holdSec : '', '', '', '', '', x.done ? 1 : 0]);
        });
      }
    }
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}
