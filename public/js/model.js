// Core data model and pure logic for the logbook.
// Shared by the browser app, the Node server (for merging) and the tests,
// so nothing in here may touch the DOM, storage or the network.

import { COMPOUND, EXERCISES, PLAN } from './program.js';

export const SCHEMA_VERSION = 2;

export const KINDS = {
  strength: 'Strength',
  cardio: 'Cardio',
  vacuum: 'Stomach vacuum',
  timed: 'Timed hold',
};

/** Kinds logged as sets of held seconds rather than weight × reps. */
export const isHold = (kind) => kind === 'vacuum' || kind === 'timed';

export const DAY_TYPES = {
  training: 'Training',
  active: 'Active rest',
  rest: 'Rest',
};

/** Set types. Warm-ups are logged but don't count toward load or PRs. */
export const SET_TYPES = {
  work: { short: '', label: 'Working set' },
  warmup: { short: 'W', label: 'Warm-up set' },
  drop: { short: 'D', label: 'Drop set' },
  failure: { short: 'F', label: 'To failure / partials' },
};
const SET_TYPE_ORDER = ['work', 'warmup', 'drop', 'failure'];

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const MAX_PLAN_DAYS = 14;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** A short random id for new records. */
export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** The current time in milliseconds (record timestamps). */
export function now() {
  return Date.now();
}

/** Pads a number to two digits (e.g. 7 → "07"). */
const pad = (n) => String(n).padStart(2, '0');

/** Local calendar date as YYYY-MM-DD. */
export function toISODate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Today's local date as YYYY-MM-DD. */
export function todayISO() {
  return toISODate(new Date());
}

/** Parse YYYY-MM-DD as a local date at noon (noon avoids DST edge cases). */
export function parseISODate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}

/** True for a real calendar date written as YYYY-MM-DD. */
export function isISODate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(parseISODate(s).getTime());
}

/** The YYYY-MM-DD date n days after (or before, for negative n) a date. */
export function addDays(iso, n) {
  const d = parseISODate(iso);
  d.setDate(d.getDate() + n);
  return toISODate(d);
}

/** Day of the week of a date (0 = Sunday … 6 = Saturday). */
export function weekdayOf(iso) {
  return parseISODate(iso).getDay();
}

/** The first day of the week containing a date (weeks start on `weekStart`, 0 = Sunday, 1 = Monday). */
export function startOfWeek(iso, weekStart = 1) {
  const diff = (weekdayOf(iso) - weekStart + 7) % 7;
  return addDays(iso, -diff);
}

/** Whole days from date a to date b (negative when b is earlier). */
export function daysBetween(a, b) {
  return Math.round((parseISODate(b) - parseISODate(a)) / 86400000);
}

/** Turns a value into a number within [min, max] (min when it isn't a number). */
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

/** A deep copy of plain JSON data. */
const clone = (o) => JSON.parse(JSON.stringify(o));
/** True for a plain object (not null or an array). */
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** A set's type, where no type means a working set. */
const setType = (s) => s.type || 'work';

// ---------------------------------------------------------------------------
// Default state
// ---------------------------------------------------------------------------

/** A blank plan day (a rest day with nothing planned). */
function emptyPlanDay(ts) {
  return { name: '', dayType: 'rest', note: '', items: [], updatedAt: ts };
}

/** The program's version of plan day i. Ids are fixed so every device agrees. */
function programDay(i, ts) {
  const d = PLAN.days[i];
  if (!d) return emptyPlanDay(ts);
  return { name: d.name, dayType: d.dayType, note: d.note || '', items: d.items.map((it, j) => ({ id: `p${i}-${j}`, ...clone(it) })), updatedAt: ts };
}

/** Every plan day as the program defines it. */
function defaultPlan(ts) {
  const plan = {};
  for (let i = 0; i < MAX_PLAN_DAYS; i++) plan[i] = programDay(i, ts);
  return plan;
}

/** Cardio settings an exercise can log. */
export const CARDIO_FIELDS = ['rounds', 'speed', 'incline', 'level'];
// Custom cardio exercises (no `fields`) log these by default.
const DEFAULT_CARDIO_FIELDS = ['speed', 'incline', 'level'];

/** An exercise record built from a program.js EXERCISES row. */
function programExercise(id, name, kind, group, extra = {}, ts = 0) {
  return {
    id,
    name,
    kind,
    group,
    ...(extra.fields ? { fields: [...extra.fields] } : {}),
    ...(extra.target ? { target: normalizeTarget(extra.target) } : {}),
    ...(extra.cue ? { cue: extra.cue } : {}),
    updatedAt: ts,
  };
}
const PROGRAM_EXERCISES = Object.fromEntries(EXERCISES.map((e) => [e[0], e]));

/**
 * True for a plan day, exercise or settings record the user hasn't edited,
 * so it follows program.js. That's `updatedAt` 0, or a record stamped by
 * "Erase all data" (`reset` equals `updatedAt`; any later edit changes
 * `updatedAt` and makes it the user's own).
 */
function followsProgram(x) {
  const t = Number(x?.updatedAt) || 0;
  return !t || Number(x.reset) === t;
}

/** Program record stamped `t`; with a time it carries the erase marker. */
function stamp(rec, t) {
  rec.updatedAt = t;
  if (t) rec.reset = t;
  else delete rec.reset;
  return rec;
}

/**
 * Rest between sets by lift type: compound lifts (bench, squat, deadlift)
 * 90–120 s and never more than 180 s; isolation lifts (curls, leg
 * extensions, lateral raises) 60–75 s and never more than 120 s.
 */
export const REST_CLASSES = {
  compound: { label: 'Compound', range: '90–120 s', def: 90, max: 180, setting: 'restCompound' },
  isolation: { label: 'Isolation', range: '60–75 s', def: 60, max: 120, setting: 'restIsolation' },
};

/** Whether a strength exercise rests like a compound or an isolation lift (null for holds and cardio). */
export function restClass(state, exerciseId) {
  const kind = state.exercises[exerciseId]?.kind || 'strength';
  if (kind !== 'strength') return null;
  return COMPOUND.has(exerciseId) ? 'compound' : 'isolation';
}

/** The longest rest allowed after a set of this exercise, in seconds. */
export function restMax(state, exerciseId) {
  return REST_CLASSES[restClass(state, exerciseId)]?.max ?? 1800;
}

/** The rest to take after a set of this exercise when it has no rest of its own. */
export function defaultRest(state, exerciseId) {
  const cls = restClass(state, exerciseId);
  return cls ? state.settings[REST_CLASSES[cls].setting] || REST_CLASSES[cls].def : state.settings.restSec;
}

/** Seconds to rest after a set of this entry: its own rest or the default for its lift type, capped at the type's maximum. */
export function restFor(state, entry) {
  return Math.min(restMax(state, entry.exerciseId), entry.target?.restSec || defaultRest(state, entry.exerciseId));
}

/** True when the next unfinished set is the partials-to-failure set, which follows the last one with no rest. */
export function nextIsFailureSet(entry) {
  return (entry.sets || []).find((x) => !x.done)?.type === 'failure';
}

/** Settings for a new logbook: US units and the program's rotation. */
export function defaultSettings(ts) {
  return {
    unit: 'lb',
    distanceUnit: 'mi',
    weightStep: 5,
    weekStart: 1,
    planMode: PLAN.mode,
    cycleLength: PLAN.length,
    cycleStart: PLAN.start || todayISO(),
    restSec: 60, // planks and other timed holds
    restCompound: 90,
    restIsolation: 60,
    autoRest: true,
    restSound: true,
    updatedAt: ts,
  };
}

/** A brand-new logbook with the program's exercises and plan and no workouts. */
export function defaultState(ts = now()) {
  const exercises = {};
  for (const [id, name, kind, group, extra] of EXERCISES) exercises[id] = programExercise(id, name, kind, group, extra, ts);
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: defaultSettings(ts),
    exercises,
    plan: defaultPlan(ts),
    sessions: {},
    body: {},
    health: {},
  };
}

/** The default target for a new exercise of a kind (sets × reps, minutes or holds). */
export function defaultTarget(kind) {
  if (kind === 'cardio') return { minutes: 20, distance: 0 };
  if (kind === 'vacuum') return { sets: 5, holdSec: 10 };
  if (kind === 'timed') return { sets: 3, holdSec: 45 };
  return { sets: 3, reps: 10, weight: 0 };
}

// ---------------------------------------------------------------------------
// Validation / migration (used on load, import and by the server)
// ---------------------------------------------------------------------------

const TARGET_NUMS = { sets: 50, setsMax: 50, reps: 1000, repsMax: 1000, weight: 100000, warmupSets: 10, warmupReps: 1000, dropSets: 10, failureSets: 10, restSec: 1800, minutes: 100000, distance: 100000, holdSec: 3600, speed: 30, incline: 40, level: 30, rounds: 50, warmMin: 60, workSec: 600, easySec: 600, coolMin: 60 };

/** Clean a plan item / entry target. Unknown keys are dropped. */
export function normalizeTarget(t) {
  const out = {};
  if (!isObj(t)) return out;
  for (const [k, max] of Object.entries(TARGET_NUMS)) {
    if (t[k] !== undefined && t[k] !== null && t[k] !== '') out[k] = clampNum(t[k], 0, max);
  }
  if (Array.isArray(t.repScheme)) {
    const scheme = t.repScheme.map((r) => Math.round(clampNum(r, 0, 1000))).filter((r) => r > 0).slice(0, 20);
    if (scheme.length) out.repScheme = scheme;
  }
  if (t.note) out.note = String(t.note).slice(0, 300);
  if (t.optional) out.optional = true;
  if (t.supersetNext) out.supersetNext = true;
  return out;
}

/**
 * Coerce arbitrary (possibly old, partial or hand-edited) data into a valid
 * state object. Never throws for "shape" problems; it repairs what it can.
 */
export function normalizeState(input) {
  if (!isObj(input)) return defaultState(0);
  const inSettings = isObj(input.settings) ? input.settings : {};
  const st = { ...defaultSettings(0), ...inSettings };
  // Logbooks from before rotations existed were weekly.
  if (isObj(input.settings) && !inSettings.planMode) st.planMode = 'weekly';
  // Logbooks from before rest by lift type kept the old 90 s default for
  // everything; holds now rest 1:00 like isolation lifts.
  if (isObj(input.settings) && !('restCompound' in inSettings) && Number(inSettings.restSec) === 90) st.restSec = 60;
  const out = {
    schemaVersion: SCHEMA_VERSION,
    settings: {
      // US units (lb, mi, mph) unless metric was chosen in Settings.
      unit: st.unit === 'kg' ? 'kg' : 'lb',
      distanceUnit: st.distanceUnit === 'km' ? 'km' : 'mi',
      weightStep: clampNum(st.weightStep, 0.25, 100) || 5,
      weekStart: Number(st.weekStart) === 0 ? 0 : 1,
      planMode: st.planMode === 'weekly' ? 'weekly' : 'cycle',
      cycleLength: Math.round(clampNum(st.cycleLength, 2, MAX_PLAN_DAYS)),
      // Settings nobody has edited yet (updatedAt 0) always follow the
      // program's start date, so every device and the server agree on it.
      cycleStart: followsProgram(st) && PLAN.start ? PLAN.start : isISODate(st.cycleStart) ? st.cycleStart : todayISO(),
      restSec: Math.round(clampNum(st.restSec, 0, 1800)),
      restCompound: Math.round(clampNum(st.restCompound, 15, REST_CLASSES.compound.max)) || REST_CLASSES.compound.def,
      restIsolation: Math.round(clampNum(st.restIsolation, 15, REST_CLASSES.isolation.max)) || REST_CLASSES.isolation.def,
      autoRest: st.autoRest !== false,
      restSound: st.restSound !== false,
      updatedAt: Number(st.updatedAt) || 0,
      ...(followsProgram(st) && Number(st.updatedAt) ? { reset: Number(st.updatedAt) } : {}),
    },
    exercises: {},
    plan: {},
    sessions: {},
    body: {},
    health: {},
  };

  const needDefaults = !isObj(input.exercises) || !isObj(input.plan);
  const base = needDefaults ? defaultState(0) : null;
  const exercises = isObj(input.exercises) ? input.exercises : base.exercises;
  for (const [id, ex] of Object.entries(exercises)) {
    if (!isObj(ex)) continue;
    // Exercises nobody has edited follow the current program definition.
    if (followsProgram(ex) && !ex.deleted && PROGRAM_EXERCISES[id]) {
      out.exercises[id] = stamp(programExercise(...PROGRAM_EXERCISES[id]), Number(ex.updatedAt) || 0);
      continue;
    }
    const fields = Array.isArray(ex.fields) ? CARDIO_FIELDS.filter((f) => ex.fields.includes(f)) : null;
    out.exercises[id] = {
      id,
      name: String(ex.name || 'Exercise').slice(0, 80),
      kind: KINDS[ex.kind] ? ex.kind : 'strength',
      group: String(ex.group || '').slice(0, 40),
      ...(fields ? { fields } : {}),
      ...(isObj(ex.target) ? { target: normalizeTarget(ex.target) } : {}),
      ...(ex.cue ? { cue: String(ex.cue).slice(0, 200) } : {}),
      updatedAt: Number(ex.updatedAt) || 0,
      ...(ex.deleted ? { deleted: true } : {}),
    };
  }
  // New exercises added to the program show up in existing logbooks.
  for (const e of EXERCISES) if (!out.exercises[e[0]]) out.exercises[e[0]] = programExercise(...e);

  const plan = isObj(input.plan) ? input.plan : base.plan;
  for (let i = 0; i < MAX_PLAN_DAYS; i++) {
    const d = plan[i];
    // Plan days nobody has edited follow the current program.
    if (!isObj(d) || followsProgram(d)) {
      out.plan[i] = stamp(programDay(i, 0), Number(d?.updatedAt) || 0);
      continue;
    }
    out.plan[i] = {
      name: String(d.name || '').slice(0, 60),
      dayType: DAY_TYPES[d.dayType] ? d.dayType : 'training',
      note: String(d.note || '').slice(0, 500),
      items: (Array.isArray(d.items) ? d.items : []).filter((it) => isObj(it) && it.exerciseId).map((it) => ({ id: cleanId(it.id), exerciseId: String(it.exerciseId), ...normalizeTarget(it) })),
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
      note: String(s.note || '').slice(0, 500),
      notes: String(s.notes || '').slice(0, 5000),
      entries: (Array.isArray(s.entries) ? s.entries : []).filter((e) => isObj(e) && e.exerciseId).map(normalizeEntry),
      updatedAt: Number(s.updatedAt) || 0,
    };
  }

  const body = isObj(input.body) ? input.body : {};
  for (const [date, b] of Object.entries(body)) {
    if (!isISODate(date) || !isObj(b)) continue;
    out.body[date] = { weight: round(clampNum(b.weight, 0, 2000), 2), ...(b.source === 'fitbit' ? { source: 'fitbit' } : {}), updatedAt: Number(b.updatedAt) || 0 };
  }

  const health = isObj(input.health) ? input.health : {};
  for (const [date, h] of Object.entries(health)) {
    if (isISODate(date) && isObj(h)) out.health[date] = normalizeHealth(h);
  }
  return out;
}

/** A day of Fitbit / Google Health data (imported by the server). */
function normalizeHealth(h) {
  const out = {};
  // Clamps a value to a whole number in [0, max].
  const int = (v, max) => Math.round(clampNum(v, 0, max));
  if (h.steps) out.steps = int(h.steps, 1000000);
  if (h.restingHr) out.restingHr = int(h.restingHr, 260);
  if (h.sleepMin) out.sleepMin = int(h.sleepMin, 1440);
  if (Array.isArray(h.activities) && h.activities.length) {
    out.activities = h.activities
      .filter(isObj)
      .slice(0, 20)
      .map((a) => ({
        name: String(a.name || 'Activity').slice(0, 60),
        start: /^\d\d:\d\d$/.test(a.start) ? a.start : '',
        minutes: round(clampNum(a.minutes, 0, 1440), 1),
        calories: int(a.calories, 100000),
        avgHr: int(a.avgHr, 260),
        distanceKm: round(clampNum(a.distanceKm, 0, 10000), 2),
        steps: int(a.steps, 1000000),
      }));
  }
  out.updatedAt = Number(h.updatedAt) || 0;
  return out;
}

/** Record ids go into HTML attributes, so keep them to safe characters. */
function cleanId(v) {
  return String(v ?? '').replace(/[^\w-]/g, '').slice(0, 40) || uid();
}

/** Cleans one logged entry (sets or cardio) into a valid shape. */
function normalizeEntry(e) {
  const kind = KINDS[e.kind] ? e.kind : 'strength';
  const out = {
    id: cleanId(e.id),
    exerciseId: String(e.exerciseId),
    kind,
    target: { ...defaultTarget(kind), ...normalizeTarget(e.target) },
    notes: String(e.notes || '').slice(0, 1000),
    rpe: round(clampNum(e.rpe, 0, 10), 1),
  };
  if (kind === 'cardio') {
    const c = isObj(e.cardio) ? e.cardio : {};
    out.cardio = {
      minutes: clampNum(c.minutes),
      distance: clampNum(c.distance),
      speed: clampNum(c.speed, 0, 30),
      incline: clampNum(c.incline, 0, 40),
      level: clampNum(c.level, 0, 30),
      rounds: Math.round(clampNum(c.rounds, 0, 50)),
      calories: clampNum(c.calories),
      avgHr: clampNum(c.avgHr, 0, 260),
      done: !!c.done,
    };
  } else {
    out.sets = (Array.isArray(e.sets) ? e.sets : []).filter(isObj).map((s) => {
      const set = isHold(kind)
        ? { id: cleanId(s.id), holdSec: clampNum(s.holdSec), done: !!s.done }
        : { id: cleanId(s.id), reps: clampNum(s.reps), weight: clampNum(s.weight), done: !!s.done };
      if (!isHold(kind) && SET_TYPES[s.type] && s.type !== 'work') set.type = s.type;
      if (s.done && Number(s.at)) set.at = Number(s.at);
      return set;
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Merging (multi-device sync)
// ---------------------------------------------------------------------------

/**
 * Merge two states record-by-record. For each exercise, plan day, session,
 * body-weight entry and the settings object, the version with the newest
 * `updatedAt` wins. Deletions are kept as tombstones so they propagate.
 * The function is commutative, associative and idempotent, which makes sync
 * safe to repeat in any order.
 */
export function mergeStates(a, b) {
  a = normalizeState(a);
  b = normalizeState(b);
  // Picks the newer of two versions of a record.
  const pick = (x, y) => {
    if (!x) return y;
    if (!y) return x;
    if (x.updatedAt !== y.updatedAt) return x.updatedAt > y.updatedAt ? x : y;
    // Same timestamp: deterministic tie-break so both sides converge.
    return JSON.stringify(x) >= JSON.stringify(y) ? x : y;
  };
  // Merges two by-id maps record by record.
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
    body: mergeMap(a.body, b.body),
    health: mergeMap(a.health, b.health),
  };
}

/** Deep equality that ignores key order (faster than comparing JSON, too). */
export function statesEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (!Object.hasOwn(b, k) || !statesEqual(a[k], b[k])) return false;
  return true;
}

/**
 * "Erase all data": tombstone every workout and weigh-in so the erase
 * reaches other devices too, and put the plan, exercises and settings back to
 * the program (still following future program updates).
 */
export function eraseAll(state, t = now()) {
  const fresh = defaultState(t);
  stamp(fresh.settings, t);
  for (const ex of Object.values(fresh.exercises)) stamp(ex, t);
  for (const day of Object.values(fresh.plan)) stamp(day, t);
  for (const d of Object.keys(state.sessions)) fresh.sessions[d] = { date: d, deleted: true, updatedAt: t };
  for (const d of Object.keys(state.body)) fresh.body[d] = { weight: 0, updatedAt: t };
  for (const d of Object.keys(state.health || {})) fresh.health[d] = { updatedAt: t };
  for (const [id, ex] of Object.entries(state.exercises)) if (!fresh.exercises[id]) fresh.exercises[id] = { ...ex, deleted: true, updatedAt: t };
  Object.assign(state, fresh);
  return state;
}

// ---------------------------------------------------------------------------
// Exercises
// ---------------------------------------------------------------------------

/** Exercises that aren't deleted, sorted by name. */
export function activeExercises(state) {
  return Object.values(state.exercises)
    .filter((e) => !e.deleted)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** An exercise's name, or a placeholder for an unknown id. */
export function exerciseName(state, id) {
  return state.exercises[id]?.name || 'Unknown exercise';
}

/** An exercise's kind (strength, cardio, vacuum or timed), strength when unknown. */
export function exerciseKind(state, id) {
  return state.exercises[id]?.kind || 'strength';
}

/** Which cardio settings (speed / incline / level) an exercise logs. */
export function cardioFields(state, id) {
  const ex = state.exercises[id];
  if (!ex || ex.kind !== 'cardio') return [];
  return ex.fields || DEFAULT_CARDIO_FIELDS;
}

/** The exercise's own default target (e.g. a cardio machine's usual level). */
export function exerciseTarget(state, id) {
  return state.exercises[id]?.target || {};
}

/** Adds a custom exercise to the library and returns its id. */
export function addExercise(state, { name, kind = 'strength', group = '' }) {
  const id = uid();
  state.exercises[id] = { id, name: name.trim().slice(0, 80) || 'New exercise', kind: KINDS[kind] ? kind : 'strength', group, updatedAt: now() };
  return id;
}

// ---------------------------------------------------------------------------
// Plan (weekly, or an N-day rotation like 3 on / 1 off)
// ---------------------------------------------------------------------------

/** True when the plan is an N-day rotation rather than a weekly plan. */
export function isCycle(state) {
  return state.settings.planMode === 'cycle';
}

/** How many plan days there are (the rotation length, or 7 for a weekly plan). */
export function planDayCount(state) {
  return isCycle(state) ? state.settings.cycleLength : 7;
}

/** Which plan day applies to a calendar date. */
export function planIndex(state, date) {
  if (!isCycle(state)) return weekdayOf(date);
  const n = state.settings.cycleLength;
  return (((daysBetween(state.settings.cycleStart, date) % n) + n) % n);
}

/** A plan day's label, e.g. "Day 3" or "Wednesday". */
export function planLabel(state, idx) {
  return isCycle(state) ? `Day ${idx + 1}` : WEEKDAY_NAMES[idx];
}

/** Plan day indexes in display order. */
export function planOrder(state) {
  if (isCycle(state)) return Array.from({ length: state.settings.cycleLength }, (_, i) => i);
  return Array.from({ length: 7 }, (_, i) => (state.settings.weekStart + i) % 7);
}

/** The plan day at an index, or a blank rest day if there is none. */
export function planDay(state, idx) {
  return state.plan[idx] || emptyPlanDay(0);
}

/** Shift the rotation so that `date` is plan day `idx`. */
export function anchorCycle(state, date, idx) {
  state.settings.cycleStart = addDays(date, -idx);
  state.settings.updatedAt = now();
}

/** Copy a session's exercises and targets into the plan day for that date. */
export function saveSessionAsPlan(state, date) {
  const s = getSession(state, date) || sessionOrDraft(state, date).session;
  state.plan[planIndex(state, date)] = {
    name: s.name,
    dayType: s.dayType,
    note: s.note || '',
    items: s.entries.map((e) => ({ id: uid(), exerciseId: e.exerciseId, ...normalizeTarget(e.target) })),
    updatedAt: now(),
  };
}

/** Copies one plan day onto another, with new item ids. */
export function copyPlanDay(state, from, to) {
  const src = planDay(state, from);
  state.plan[to] = { name: src.name, dayType: src.dayType, note: src.note, items: src.items.map((it) => ({ ...clone(it), id: uid() })), updatedAt: now() };
}

// ---------------------------------------------------------------------------
// Sessions (one per calendar day)
// ---------------------------------------------------------------------------

/** The stored session for a date, or null (a deleted one counts as none). */
export function getSession(state, date) {
  const s = state.sessions[date];
  return s && !s.deleted ? s : null;
}

/** Rounds a weight to the nearest multiple of the weight step. */
function roundToStep(v, step) {
  return step > 0 ? round(Math.round(v / step) * step, 2) : round(v, 2);
}

/** Build a new entry for an exercise, pre-filled from targets and last performance. */
export function makeEntry(state, exerciseId, target, beforeDate) {
  const kind = exerciseKind(state, exerciseId);
  const t = { ...defaultTarget(kind), ...normalizeTarget(exerciseTarget(state, exerciseId)), ...normalizeTarget(target || {}) };
  if (t.repScheme) {
    t.sets = t.repScheme.length;
    if (!target?.reps) t.reps = t.repScheme[0];
  }
  const entry = { id: uid(), exerciseId, kind, target: t, notes: '', rpe: 0 };
  const prev = beforeDate ? previousEntry(state, exerciseId, beforeDate) : null;

  if (kind === 'cardio') {
    entry.cardio = { minutes: t.minutes, distance: t.distance || 0, speed: t.speed || 0, incline: t.incline || 0, level: t.level || 0, rounds: t.rounds || 0, calories: 0, avgHr: 0, done: false };
    return entry;
  }
  if (isHold(kind)) {
    entry.sets = Array.from({ length: t.sets }, () => ({ id: uid(), holdSec: t.holdSec, done: false }));
    return entry;
  }

  // Strength: pre-fill each set with what you lifted last time (progressive
  // overload starts from your real numbers), unless the plan names a weight.
  const prevDone = prev?.entry.sets?.filter((s) => s.done) || [];
  // Last time's finished sets of one type.
  const prevOf = (type) => prevDone.filter((s) => setType(s) === type);
  const pw = prevOf('work');
  // The i-th item of a list, or its last item when the list is shorter.
  const at = (list, i) => list[i] || list[list.length - 1];
  // The weight for working set i: the planned weight, else last time's.
  const workWeight = (i) => t.weight || at(pw, i)?.weight || 0;
  const topWork = t.weight || pw.reduce((m, s) => Math.max(m, s.weight || 0), 0);
  const step = state.settings?.weightStep || 5;
  const sets = [];
  for (let i = 0; i < (t.warmupSets || 0); i++) {
    sets.push({ id: uid(), type: 'warmup', reps: t.warmupReps || 12, weight: at(prevOf('warmup'), i)?.weight ?? roundToStep(topWork * 0.5, step), done: false });
  }
  for (let i = 0; i < t.sets; i++) {
    // Within a rep range, start from the reps you actually did last time.
    const last = at(pw, i)?.reps;
    const reps = t.repScheme ? t.repScheme[Math.min(i, t.repScheme.length - 1)] : t.repsMax && last ? Math.min(t.repsMax, Math.max(t.reps, last)) : t.reps;
    sets.push({ id: uid(), reps, weight: workWeight(i), done: false });
  }
  for (let i = 0; i < (t.dropSets || 0); i++) {
    sets.push({ id: uid(), type: 'drop', reps: t.repsMax || t.reps, weight: at(prevOf('drop'), i)?.weight ?? roundToStep(topWork * 0.7, step), done: false });
  }
  for (let i = 0; i < (t.failureSets || 0); i++) {
    sets.push({ id: uid(), type: 'failure', reps: t.repScheme ? t.repScheme[t.repScheme.length - 1] : t.reps, weight: at(prevOf('failure'), i)?.weight ?? topWork, done: false });
  }
  entry.sets = sets;
  // Show the real working weight as this day's target.
  if (!t.weight && topWork) t.weight = topWork;
  return entry;
}

/**
 * The session for a date, or an unsaved draft built from the plan.
 * Drafts are not stored until the user changes something, so editing the
 * plan keeps updating every day you haven't started yet.
 */
export function sessionOrDraft(state, date) {
  const existing = getSession(state, date);
  if (existing) return { session: existing, draft: false };
  const day = planDay(state, planIndex(state, date));
  const session = {
    date,
    name: day.name || '',
    dayType: day.dayType || 'training',
    note: day.note || '',
    notes: '',
    entries: day.items.filter((it) => state.exercises[it.exerciseId] && !state.exercises[it.exerciseId].deleted).map((it) => makeEntry(state, it.exerciseId, it, date)),
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

/** Throw away a day's log; it falls back to the plan again. */
export function resetSession(state, date) {
  state.sessions[date] = { date, deleted: true, updatedAt: now() };
}

/** The entry with an id in a session, or null. */
export function findEntry(session, entryId) {
  return session?.entries.find((e) => e.id === entryId) || null;
}

/**
 * Supersets: an entry with `target.supersetNext` is paired with the entry
 * after it. Returns the next exercise in the superset, or null if this is
 * the last one (which is when you rest).
 */
export function supersetNext(session, entryId) {
  const i = session?.entries.findIndex((e) => e.id === entryId) ?? -1;
  if (i < 0 || !session.entries[i].target?.supersetNext) return null;
  return session.entries[i + 1] || null;
}

/** The entry before this one, if it's linked to this one as a superset. */
export function supersetPrev(session, entryId) {
  const i = session?.entries.findIndex((e) => e.id === entryId) ?? -1;
  return i > 0 && session.entries[i - 1].target?.supersetNext ? session.entries[i - 1] : null;
}

/** An entry's working sets (no warm-up, drop or failure sets). */
export function workingSets(entry) {
  return (entry.sets || []).filter((s) => setType(s) === 'work');
}

/** A new unfinished set copying another set's numbers (or the entry's target). */
function newSetLike(entry, like) {
  if (isHold(entry.kind)) return { id: uid(), holdSec: like?.holdSec ?? entry.target.holdSec ?? 20, done: false };
  return { id: uid(), reps: like?.reps ?? entry.target.reps ?? 10, weight: like?.weight ?? entry.target.weight ?? 0, done: false };
}

/** Add a working set (before any drop / failure sets) copying the last one. */
export function addSet(entry) {
  if (isHold(entry.kind)) {
    entry.sets.push(newSetLike(entry, entry.sets[entry.sets.length - 1]));
    return;
  }
  const work = workingSets(entry);
  const set = newSetLike(entry, work[work.length - 1]);
  const finisher = entry.sets.findIndex((s) => s.type === 'drop' || s.type === 'failure');
  if (finisher === -1) entry.sets.push(set);
  else entry.sets.splice(finisher, 0, set);
}

/** Remove the last unfinished set (or the last set if all are done). */
export function removeLastSet(entry) {
  for (let i = entry.sets.length - 1; i >= 0; i--) {
    if (!entry.sets[i].done) {
      entry.sets.splice(i, 1);
      return;
    }
  }
  entry.sets.pop();
}

/** Change the number of working sets, never deleting completed work. */
export function setTargetSets(entry, n) {
  n = Math.round(clampNum(n, 0, 50));
  entry.target.sets = n;
  while (workingSets(entry).length < n) addSet(entry);
  for (let i = entry.sets.length - 1; i >= 0 && workingSets(entry).length > n; i--) {
    if (setType(entry.sets[i]) === 'work' && !entry.sets[i].done) entry.sets.splice(i, 1);
  }
}

/** Change how many warm-up / drop / failure sets an entry has. */
export function setTypedCount(entry, type, n) {
  n = Math.round(clampNum(n, 0, 10));
  const key = { warmup: 'warmupSets', drop: 'dropSets', failure: 'failureSets' }[type];
  entry.target[key] = n;
  // How many sets of this type the entry has.
  const count = () => entry.sets.filter((s) => s.type === type).length;
  const work = workingSets(entry);
  while (count() < n) {
    const ref = work[work.length - 1];
    const set = { id: uid(), type, reps: type === 'warmup' ? entry.target.warmupReps || 12 : ref?.reps ?? entry.target.reps ?? 10, weight: ref?.weight ?? entry.target.weight ?? 0, done: false };
    if (type === 'warmup') set.weight = round((set.weight || 0) * 0.5, 2);
    if (type === 'drop') set.weight = round((set.weight || 0) * 0.7, 2);
    if (type === 'warmup') entry.sets.splice(entry.sets.filter((s) => s.type === 'warmup').length, 0, set);
    else entry.sets.push(set);
  }
  for (let i = entry.sets.length - 1; i >= 0 && count() > n; i--) {
    if (entry.sets[i].type === type && !entry.sets[i].done) entry.sets.splice(i, 1);
  }
}

/** Cycle a set through working → warm-up → drop → failure. */
export function cycleSetType(set) {
  const next = SET_TYPE_ORDER[(SET_TYPE_ORDER.indexOf(setType(set)) + 1) % SET_TYPE_ORDER.length];
  if (next === 'work') delete set.type;
  else set.type = next;
}

/** Marks a set done (recording when) or not done. */
export function markSet(set, done, at = now()) {
  set.done = done;
  if (done) set.at = at;
  else delete set.at;
}

/** "+" on the completed counter: mark the next unfinished set done. Returns the set. */
export function completeNextSet(entry) {
  if (entry.kind === 'cardio') {
    entry.cardio.done = true;
    return null;
  }
  let next = entry.sets.find((s) => !s.done);
  if (!next) {
    addSet(entry);
    next = entry.sets.find((s) => !s.done);
  }
  markSet(next, true);
  return next;
}

/** "−" on the completed counter: un-mark the most recently finished set. */
export function undoLastSet(entry) {
  if (entry.kind === 'cardio') {
    entry.cardio.done = false;
    return;
  }
  for (let i = entry.sets.length - 1; i >= 0; i--) {
    if (entry.sets[i].done) {
      markSet(entry.sets[i], false);
      return;
    }
  }
}

/** Seconds rested before each set (from completion times within the entry). */
export function restTaken(entry) {
  const out = {};
  let last = null;
  const done = (entry.sets || []).filter((s) => s.done && s.at).sort((a, b) => a.at - b.at);
  for (const s of done) {
    if (last) out[s.id] = Math.round((s.at - last) / 1000);
    last = s.at;
  }
  return out;
}

// ---------------------------------------------------------------------------
// HIIT interval timer
// ---------------------------------------------------------------------------

export const HIIT_DEFAULTS = { warmMin: 4, workSec: 45, easySec: 90, rounds: 6, coolMin: 4 };

/** Interval timer settings for an entry: today's rounds, its target, then defaults. */
export function hiitConfig(entry) {
  const t = entry?.target || {};
  // A timer setting from the target, or its default.
  const pick = (k) => (t[k] !== undefined && t[k] !== null ? t[k] : HIIT_DEFAULTS[k]);
  return { warmMin: pick('warmMin'), workSec: pick('workSec') || HIIT_DEFAULTS.workSec, easySec: pick('easySec') || HIIT_DEFAULTS.easySec, rounds: entry?.cardio?.rounds || pick('rounds') || HIIT_DEFAULTS.rounds, coolMin: pick('coolMin') };
}

/** The phases of a HIIT session: warm-up, hard/easy × rounds, cool-down. */
export function hiitPhases(cfg) {
  const phases = [];
  if (cfg.warmMin > 0) phases.push({ kind: 'warm', label: 'Warm-up', sec: Math.round(cfg.warmMin * 60) });
  for (let r = 1; r <= cfg.rounds; r++) {
    phases.push({ kind: 'hard', label: `Hard ${r}/${cfg.rounds}`, sec: cfg.workSec, round: r });
    phases.push({ kind: 'easy', label: `Easy ${r}/${cfg.rounds}`, sec: cfg.easySec, round: r });
  }
  if (cfg.coolMin > 0) phases.push({ kind: 'cool', label: 'Cool-down', sec: Math.round(cfg.coolMin * 60) });
  return phases;
}

/**
 * Where a session is after `elapsedMs`: the current phase index, seconds
 * left in it, rounds fully completed (a round counts once its hard part is
 * done) and whether the whole session is over.
 */
export function hiitPosition(phases, elapsedMs) {
  let t = Math.max(0, elapsedMs) / 1000;
  let rounds = 0;
  for (let i = 0; i < phases.length; i++) {
    const p = phases[i];
    if (t < p.sec) return { index: i, remaining: p.sec - t, rounds: p.kind === 'easy' ? Math.max(rounds, p.round) : rounds, done: false };
    t -= p.sec;
    if (p.kind === 'hard') rounds = p.round;
  }
  return { index: phases.length, remaining: 0, rounds, done: true };
}

/** Total length of a HIIT session in seconds. */
export function hiitTotalSec(phases) {
  return phases.reduce((a, p) => a + p.sec, 0);
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
 * Warm-up sets never count.
 */
export function entryMetrics(entry, onlyDone = true) {
  if (!entry) return null;
  if (entry.kind === 'cardio') {
    const c = entry.cardio || {};
    const counted = !onlyDone || c.done;
    const minutes = counted ? c.minutes || 0 : 0;
    // No distance entered? Estimate it from treadmill speed (mph × hours).
    const distance = counted ? c.distance || (c.speed ? round((c.speed * minutes) / 60, 2) : 0) : 0;
    return {
      kind: 'cardio',
      minutes,
      distance,
      speed: counted ? c.speed || 0 : 0,
      incline: counted ? c.incline || 0 : 0,
      level: counted ? c.level || 0 : 0,
      rounds: counted ? c.rounds || 0 : 0,
      calories: counted ? c.calories || 0 : 0,
      pace: distance > 0 ? round(minutes / distance, 2) : 0,
      done: !!c.done,
      load: minutes,
    };
  }
  const sets = (entry.sets || []).filter((s) => (!onlyDone || s.done) && setType(s) !== 'warmup');
  if (isHold(entry.kind)) {
    const totalHold = sets.reduce((a, s) => a + (s.holdSec || 0), 0);
    return { kind: entry.kind, sets: sets.length, totalHold, longestHold: sets.reduce((m, s) => Math.max(m, s.holdSec || 0), 0), load: totalHold };
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
  return { kind: 'strength', sets: sets.length, reps, volume: round(volume, 1), topWeight: top?.weight || 0, topReps: top?.reps || 0, e1rm: best1rm, load: round(volume, 1) };
}

/** True if an entry has any completed work. */
export function entryHasWork(entry) {
  if (entry.kind === 'cardio') return !!entry.cardio?.done;
  return (entry.sets || []).some((s) => s.done);
}

/** True when every set of an entry (or its cardio) is done. */
export function entryComplete(entry) {
  if (entry.kind === 'cardio') return !!entry.cardio?.done;
  return entry.sets.length > 0 && entry.sets.every((s) => s.done);
}

/** Optional exercises only count toward a day once you've started them. */
export function entryCounts(entry) {
  return !entry.target?.optional || entryHasWork(entry);
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
    // If the exercise appears twice in one day, use the one with most load.
    let best = null;
    for (const e of state.sessions[d].entries) {
      if (e.exerciseId !== exerciseId || !entryHasWork(e)) continue;
      if (!best || entryMetrics(e).load > entryMetrics(best).load) best = e;
    }
    if (best) return { date: d, entry: best };
  }
  return null;
}

/**
 * Progressive-overload nudge: if you hit the top of the rep range on every
 * working set last time (and it wasn't an all-out effort), suggest more weight.
 */
export function overloadHint(state, entry, prev) {
  if (entry.kind !== 'strength' || !prev || entry.target.repScheme) return null;
  const top = entry.target.repsMax || entry.target.reps;
  const pw = workingSets(prev.entry).filter((s) => s.done);
  if (!top || pw.length < (prev.entry.target.sets || 1)) return null;
  const maxW = pw.reduce((m, s) => Math.max(m, s.weight || 0), 0);
  if (!maxW || !pw.every((s) => s.reps >= top) || (prev.entry.rpe && prev.entry.rpe >= 9.5)) return null;
  const plannedTop = workingSets(entry).reduce((m, s) => Math.max(m, s.weight || 0), 0);
  if (plannedTop > maxW) return null;
  return { reps: top, from: maxW, to: round(maxW + (state.settings.weightStep || 5), 2) };
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
  const day = planDay(state, planIndex(state, date));
  const dayType = s?.dayType || day.dayType || 'training';
  if (s && s.entries.length) {
    const counted = s.entries.filter(entryCounts);
    if (counted.length && counted.every(entryComplete)) return 'done';
    if (s.entries.some(entryHasWork)) return 'partial';
  }
  if (dayType === 'rest') return 'rest';
  const planned = s ? s.entries.length : day.items.length;
  return planned ? 'planned' : 'empty';
}

/**
 * Keys of a by-date map that fall in [from, to], in no particular order.
 * Short ranges (a day, a week) look the days up directly instead of scanning
 * years of history, which keeps charts and lists fast as the logbook grows.
 */
function datesInRange(map, from, to) {
  const n = daysBetween(from, to) + 1;
  if (n > 0 && n <= 400 && n < Object.keys(map).length) {
    const out = [];
    for (let i = 0, d = from; i < n; i++, d = addDays(d, 1)) if (map[d]) out.push(d);
    return out;
  }
  return Object.keys(map).filter((d) => d >= from && d <= to);
}

/** Totals over a date range (inclusive). */
export function rangeSummary(state, from, to) {
  const sum = { workouts: 0, sets: 0, reps: 0, volume: 0, cardioMin: 0, distance: 0, vacuumSec: 0, vacuumSets: 0, holdSec: 0 };
  for (const d of datesInRange(state.sessions, from, to)) {
    const s = state.sessions[d];
    if (!s || s.deleted) continue;
    let worked = false;
    for (const e of s.entries) {
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
      } else if (m.kind === 'vacuum') {
        sum.vacuumSec += m.totalHold;
        sum.vacuumSets += m.sets;
      } else {
        sum.holdSec += m.totalHold;
        sum.sets += m.sets;
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
// Consistency (streaks, weekly goals, month calendar)
// ---------------------------------------------------------------------------
// Every helper takes ctx = { today, start }: `today` from todayISO() and
// `start` from consistencyStart(), both read once per render. Only
// consistencyStart enumerates state.sessions; everything else looks days up
// directly, so the cost follows the days shown (or the streak's length), not
// the size of the history. Days before the start are never judged.

/** Minutes one finished cardio entry needs to count as a cardio session (the 5–10 min warm-up never does). */
export const CARDIO_SESSION_MIN = 20;
/** Different core exercises (vacuums excluded) a day needs for a core session; the circuit says "pick 3–4". */
export const CORE_SESSION_MIN = 3;
/** Days in a row with nothing planned or done that end a streak: a full rotation, since no plan is longer than MAX_PLAN_DAYS. */
export const STREAK_GAP_DAYS = MAX_PLAN_DAYS;
// Vacuum holds a day needs when its vacuum entry has no target.
const VACUUM_DEFAULT_HOLDS = 5;

/**
 * @typedef {Object} DayConsistency
 * @property {string} date
 * @property {'training'|'active'|'rest'} dayType   effective (session wins over plan)
 * @property {boolean} scheduled
 * @property {'done'|'partial'|'missed'|'pending'|'rest'|'future'|'before'} status
 * @property {boolean} cardio  @property {boolean} cardioPlanned  @property {number} cardioMin
 * @property {boolean} core    @property {boolean} corePlanned    @property {number} coreCount
 * @property {'done'|'partial'|'missed'|'pending'|'none'|'future'|'before'} vacuum
 * @property {boolean} vacuumPlanned  @property {number} vacuumHolds  @property {number} vacuumTarget
 */

/** True for an exercise in the Core group that isn't a stomach vacuum (deleted exercises keep counting for old logs). */
export function isCoreExercise(state, id) {
  const ex = state.exercises[id];
  return !!ex && ex.kind !== 'vacuum' && String(ex.group || '').trim().toLowerCase() === 'core';
}

/** Earliest date with any logged work (one pass over session keys, no sort); null for an empty logbook. */
export function consistencyStart(state) {
  let start = null;
  for (const d of Object.keys(state.sessions)) {
    if (start && d >= start) continue;
    const s = state.sessions[d];
    if (s && !s.deleted && (s.entries || []).some(entryHasWork)) start = d;
  }
  return start;
}

/** The first date that is judged: the tracking start, or today when nothing (or only future days) is logged. */
function trackFrom(ctx) {
  return !ctx.start || ctx.start > ctx.today ? ctx.today : ctx.start;
}

/** True for a cardio session: CARDIO_SESSION_MIN+ minutes, or an interval (HIIT) session, which logs rounds (the warm-up bike has none). */
function isCardioSession(minutes, rounds) {
  return (minutes || 0) >= CARDIO_SESSION_MIN || (rounds || 0) > 0;
}

/** True for real training: a finished working set, or a finished cardio entry that is a cardio session (vacuums never). */
function entryWorked(e) {
  if (e.kind === 'vacuum') return false;
  if (e.kind === 'cardio') return !!e.cardio?.done && isCardioSession(e.cardio.minutes, e.cardio.rounds);
  return (e.sets || []).some((s) => s.done && setType(s) !== 'warmup');
}

/** What a list of session entries or plan items asks for: scheduled workout, cardio, core and the vacuum target. */
function plannedFacts(state, list, kindOf, dayType) {
  let nonVac = false;
  let cardio = false;
  let vac = false;
  let vacTarget = 0;
  const core = new Set();
  for (const x of list) {
    const t = x.target || x;
    const kind = kindOf(x);
    if (kind === 'vacuum') {
      vac = true;
      vacTarget = Math.max(vacTarget, t.sets ?? exerciseTarget(state, x.exerciseId).sets ?? VACUUM_DEFAULT_HOLDS);
      continue;
    }
    nonVac = true;
    // The 5-min warm-up bike is cardio too, but too short to be a cardio session.
    const et = kind === 'cardio' ? exerciseTarget(state, x.exerciseId) : null;
    if (et && isCardioSession(t.minutes ?? et.minutes ?? 20, t.rounds ?? et.rounds)) cardio = true;
    if (isCoreExercise(state, x.exerciseId)) core.add(x.exerciseId);
  }
  const on = dayType !== 'rest';
  return {
    dayType,
    scheduled: on && nonVac,
    cardioPlanned: on && cardio,
    corePlanned: on && core.size >= CORE_SESSION_MIN,
    // A Rest day doesn't excuse vacuums.
    vacuumPlanned: vac,
    vacuumTarget: Math.max(1, vacTarget || VACUUM_DEFAULT_HOLDS),
  };
}

/** plannedFacts for a plan day, memoized per plan index for the length of one call. */
function planFacts(state, idx, cache) {
  if (cache?.has(idx)) return cache.get(idx);
  const day = planDay(state, idx);
  const items = day.items.filter((it) => state.exercises[it.exerciseId] && !state.exercises[it.exerciseId].deleted && !it.optional);
  const f = plannedFacts(state, items, (it) => exerciseKind(state, it.exerciseId), day.dayType || 'training');
  cache?.set(idx, f);
  return f;
}

/** Consistency facts for one date (see DayConsistency); `cache` memoizes plan days within one call. */
function classifyDay(state, date, ctx, cache) {
  // Reads only this date's session and plan day: never sessionOrDraft,
  // makeEntry or sessionDates, which sort or scan the whole history.
  const s = getSession(state, date);
  const idx = planIndex(state, date);
  const f = s ? plannedFacts(state, s.entries.filter(entryCounts), (e) => e.kind, s.dayType || planDay(state, idx).dayType || 'training') : planFacts(state, idx, cache);
  const day = { date, ...f, status: '', cardio: false, cardioMin: 0, core: false, coreCount: 0, vacuum: '', vacuumHolds: 0 };
  let worked = false;
  let complete = true;
  let counted = 0;
  const coreIds = new Set();
  for (const e of s ? s.entries : []) {
    if (e.kind === 'vacuum') {
      day.vacuumHolds += (e.sets || []).filter((x) => x.done).length;
      continue;
    }
    const w = entryWorked(e);
    if (w) worked = true;
    // Minutes are never summed across entries: one entry must be long enough.
    if (w && e.kind === 'cardio') {
      day.cardio = true;
      day.cardioMin += e.cardio.minutes;
    }
    if (w && isCoreExercise(state, e.exerciseId)) coreIds.add(e.exerciseId);
    if (entryCounts(e)) {
      counted++;
      if (!entryComplete(e)) complete = false;
    }
  }
  day.coreCount = coreIds.size;
  day.core = coreIds.size >= CORE_SESSION_MIN;

  const from = trackFrom(ctx);
  if (date > ctx.today) day.status = 'future';
  else if (date < from) day.status = 'before';
  else if (worked) day.status = counted && complete ? 'done' : 'partial';
  else if (!day.scheduled) day.status = 'rest';
  else day.status = date === ctx.today ? 'pending' : 'missed';

  const h = day.vacuumHolds;
  if (date > ctx.today) day.vacuum = 'future';
  else if (date < from) day.vacuum = 'before';
  else if (h >= day.vacuumTarget) day.vacuum = 'done';
  else if (h > 0) day.vacuum = 'partial';
  else if (!day.vacuumPlanned) day.vacuum = 'none';
  else day.vacuum = date === ctx.today ? 'pending' : 'missed';
  return day;
}

/** Consistency facts for one date; ctx is { today, start } with start from consistencyStart. */
export function dayConsistency(state, date, ctx) {
  return classifyDay(state, date, ctx, null);
}

/** DayConsistency for every date in [from, to], oldest first, in O(days); [] when from > to. */
export function consistencyDays(state, from, to, ctx) {
  const cache = new Map();
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(classifyDay(state, d, ctx, cache));
  return out;
}

/** Done vs planned workouts (done counts scheduled days only, the rest are `extra`), cardio, core and vacuum days, plus missed days, over a list from consistencyDays. */
export function consistencyTotals(days) {
  const t = { workouts: { done: 0, planned: 0, extra: 0 }, cardio: { done: 0, planned: 0 }, core: { done: 0, planned: 0 }, vacuum: { done: 0, planned: 0 }, missed: 0 };
  for (const d of days) {
    if (d.status === 'before') continue;
    // Future days count toward the target, so a week shows its whole plan.
    t.workouts.planned += d.scheduled ? 1 : 0;
    t.cardio.planned += d.cardioPlanned ? 1 : 0;
    t.core.planned += d.corePlanned ? 1 : 0;
    t.vacuum.planned += d.vacuumPlanned ? 1 : 0;
    if (d.status === 'future') continue;
    if (d.status === 'done' || d.status === 'partial') t.workouts[d.scheduled ? 'done' : 'extra']++;
    t.cardio.done += d.cardio ? 1 : 0;
    t.core.done += d.core ? 1 : 0;
    t.vacuum.done += d.vacuum === 'done' ? 1 : 0;
    t.missed += d.status === 'missed' ? 1 : 0;
  }
  return t;
}

/** Pip state of one habit on one day for the weekly goal rows. */
export function habitPip(day, habit, today) {
  if (day.status === 'before') return 'none';
  const ahead = day.date >= today;
  if (habit === 'workouts') {
    if (day.status === 'done' || day.status === 'partial' || day.status === 'missed') return day.status;
    return day.scheduled && ahead ? 'planned' : 'none';
  }
  if (habit === 'vacuum') {
    if (day.vacuum === 'done' || day.vacuum === 'partial' || day.vacuum === 'missed') return day.vacuum;
    return day.vacuumPlanned && ahead ? 'planned' : 'none';
  }
  const cardio = habit === 'cardio';
  const past = day.status !== 'future';
  if (past && (cardio ? day.cardio : day.core)) return 'done';
  if (!cardio && past && day.coreCount > 0) return 'partial';
  if (!(cardio ? day.cardioPlanned : day.corePlanned)) return 'none';
  return ahead ? 'planned' : 'missed';
}

/** Current workout and vacuum streaks, walking back from today only as far as they reach (STREAK_GAP_DAYS neutral days in a row end one). */
export function currentStreaks(state, ctx) {
  const cache = new Map();
  const workout = { count: 0, since: null, pendingToday: false, doneToday: false };
  const vacuum = { count: 0, since: null, pendingToday: false, doneToday: false };
  let w = true;
  let v = true;
  let wGap = 0;
  let vGap = 0;
  for (let d = ctx.today; w || v; d = addDays(d, -1)) {
    const day = classifyDay(state, d, ctx, cache);
    // Bounded by the tracking start: nothing before it is judged.
    if (day.status === 'before') break;
    if (w) {
      // Workouts in a row: rest days are neutral and today is never a miss.
      if (day.status === 'done' || day.status === 'partial') {
        workout.count++;
        workout.since = d;
        wGap = 0;
        if (d === ctx.today) workout.doneToday = true;
      } else if (day.status === 'pending') workout.pendingToday = true;
      else if (day.status === 'missed' || ++wGap >= STREAK_GAP_DAYS) w = false;
    }
    if (v) {
      // Calendar days in a row: today not done yet never breaks it.
      if (day.vacuum === 'done') {
        vacuum.count++;
        vacuum.since = d;
        vGap = 0;
        if (d === ctx.today) vacuum.doneToday = true;
      } else if (d === ctx.today) vacuum.pendingToday = day.vacuumPlanned;
      else if (day.vacuum !== 'none' || ++vGap >= STREAK_GAP_DAYS) v = false;
    }
  }
  return { workout, vacuum };
}

/** Longest workout and vacuum streaks ever, in one forward pass from the tracking start (same rules as currentStreaks). */
export function bestStreaks(state, ctx) {
  const cache = new Map();
  const best = { workout: 0, vacuum: 0 };
  let wRun = 0;
  let vRun = 0;
  let wGap = 0;
  let vGap = 0;
  for (let d = trackFrom(ctx); d <= ctx.today; d = addDays(d, 1)) {
    const day = classifyDay(state, d, ctx, cache);
    if (day.status === 'done' || day.status === 'partial') {
      best.workout = Math.max(best.workout, ++wRun);
      wGap = 0;
    } else if (day.status === 'missed' || (day.status === 'rest' && ++wGap >= STREAK_GAP_DAYS)) wRun = 0;
    if (day.vacuum === 'done') {
      best.vacuum = Math.max(best.vacuum, ++vRun);
      vGap = 0;
    } else if (d !== ctx.today && (day.vacuum !== 'none' || ++vGap >= STREAK_GAP_DAYS)) vRun = 0;
  }
  return best;
}

/** A 'YYYY-MM' month shifted by n months (wraps years). */
export function shiftMonth(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const i = y * 12 + m - 1 + n;
  return `${Math.floor(i / 12)}-${pad((i % 12) + 1)}`;
}

/** Whole weeks (from settings.weekStart) covering a 'YYYY-MM' month, with per-day facts and totals for in-month days up to today. */
export function monthGrid(state, ym, ctx) {
  const first = `${ym}-01`;
  const last = addDays(`${shiftMonth(ym, 1)}-01`, -1);
  const cache = new Map();
  const weeks = [];
  const tracked = [];
  for (let d = startOfWeek(first, state.settings.weekStart); d <= last; ) {
    const week = [];
    for (let i = 0; i < 7; i++, d = addDays(d, 1)) {
      if (d < first || d > last) {
        week.push({ date: d, inMonth: false });
        continue;
      }
      const cell = { ...classifyDay(state, d, ctx, cache), inMonth: true };
      week.push(cell);
      if (d <= ctx.today) tracked.push(cell);
    }
    weeks.push(week);
  }
  return { month: ym, weeks, totals: consistencyTotals(tracked) };
}

// ---------------------------------------------------------------------------
// Body weight (daily scale weight)
// ---------------------------------------------------------------------------

/** Saves the scale weight for a date (0 clears it). */
export function setBodyWeight(state, date, weight) {
  state.body[date] = { weight: round(clampNum(weight, 0, 2000), 2), updatedAt: now() };
}

/** Weigh-ins in [from, to], oldest first. A weight of 0 means "cleared". */
export function bodyWeights(state, from = '0000-01-01', to = '9999-12-31') {
  return datesInRange(state.body, from, to)
    .filter((d) => state.body[d].weight > 0)
    .sort()
    .map((date) => ({ date, weight: state.body[date].weight }));
}

/** The weigh-in for a date, or 0 when there is none. */
export function bodyWeightOn(state, date) {
  const b = state.body[date];
  return b && b.weight > 0 ? b.weight : 0;
}

/** Last weigh-in strictly before a date. */
export function previousBodyWeight(state, date) {
  let best = null;
  for (const [d, b] of Object.entries(state.body)) if (d < date && b.weight > 0 && (!best || d > best)) best = d;
  return best ? { date: best, weight: state.body[best].weight } : null;
}

/** Average of weigh-ins in the `days` days ending on `date`. */
export function bodyWeightAverage(state, date, days = 7) {
  const list = bodyWeights(state, addDays(date, -(days - 1)), date);
  if (!list.length) return 0;
  return round(list.reduce((a, b) => a + b.weight, 0) / list.length, 1);
}

// ---------------------------------------------------------------------------
// Fitbit / Google Health import
// ---------------------------------------------------------------------------

const GRAMS = { lb: 453.59237, kg: 1000 };

/**
 * Merge imported health data into the logbook. `days` maps a date to
 * { steps, restingHr, sleepMin, activities }; `weights` maps a date to grams.
 * A day is only re-stamped when its data changed (so syncs stay quiet), and a
 * Fitbit weigh-in never replaces one you typed in yourself.
 * Returns how many records changed.
 */
export function applyHealthImport(state, { days = {}, weights = {} }, t = now()) {
  let changed = 0;
  state.health ||= {};
  for (const [date, data] of Object.entries(days)) {
    if (!isISODate(date)) continue;
    const old = state.health[date];
    const next = normalizeHealth({ ...(old && !old.deleted ? old : {}), ...data, updatedAt: t });
    const same = old ? statesEqual({ ...old, updatedAt: 0 }, { ...next, updatedAt: 0 }) : Object.keys(next).length === 1;
    if (!same) {
      state.health[date] = next;
      changed++;
    }
  }
  const per = GRAMS[state.settings.unit] || GRAMS.lb;
  for (const [date, grams] of Object.entries(weights)) {
    if (!isISODate(date) || !(grams > 0)) continue;
    const cur = state.body[date];
    if (cur && cur.weight > 0 && cur.source !== 'fitbit') continue;
    const weight = round(grams / per, 1);
    if (cur && cur.source === 'fitbit' && cur.weight === weight) continue;
    state.body[date] = { weight, source: 'fitbit', updatedAt: t };
    changed++;
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** One CSV cell, quoted when needed and safe from spreadsheet formulas. */
function csvCell(v) {
  let s = String(v ?? '');
  // Text starting with = + - @ would run as a formula in Excel / Sheets.
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One row per logged set / cardio session / weigh-in, for spreadsheets. */
export function toCSV(state) {
  const rows = [['date', 'day', 'exercise', 'type', 'set', 'set_type', 'weight', 'reps', 'hold_sec', 'minutes', 'distance', 'calories', 'avg_hr', 'rpe', 'done', 'unit']];
  const u = state.settings.unit;
  for (const d of sessionDates(state)) {
    const s = state.sessions[d];
    for (const e of s.entries) {
      const name = exerciseName(state, e.exerciseId);
      const rpe = e.rpe || '';
      if (e.kind === 'cardio') {
        const c = e.cardio;
        rows.push([d, s.name, name, 'cardio', 1, '', '', '', '', c.minutes, c.distance, c.calories, c.avgHr, rpe, c.done ? 1 : 0, state.settings.distanceUnit]);
      } else {
        e.sets.forEach((x, i) => {
          const hold = isHold(e.kind);
          rows.push([d, s.name, name, e.kind, i + 1, hold ? '' : setType(x), hold ? '' : x.weight, hold ? '' : x.reps, hold ? x.holdSec : '', '', '', '', '', rpe, x.done ? 1 : 0, hold ? '' : u]);
        });
      }
    }
  }
  for (const b of bodyWeights(state)) rows.push([b.date, '', 'Body weight', 'bodyweight', '', '', b.weight, '', '', '', '', '', '', '', 1, u]);
  return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}
