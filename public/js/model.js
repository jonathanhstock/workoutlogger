// Core data model and pure logic for the logbook.
// Shared by the browser app, the Node server (for merging) and the tests,
// so nothing in here may touch the DOM, storage or the network.

import { EXERCISES, PLAN } from './program.js';

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
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const setType = (s) => s.type || 'work';

// ---------------------------------------------------------------------------
// Default state
// ---------------------------------------------------------------------------

function emptyPlanDay(ts) {
  return { name: '', dayType: 'rest', note: '', items: [], updatedAt: ts };
}

/** The program's version of plan day i. Ids are fixed so every device agrees. */
function programDay(i, ts) {
  const d = PLAN.days[i];
  if (!d) return emptyPlanDay(ts);
  return { name: d.name, dayType: d.dayType, note: d.note || '', items: d.items.map((it, j) => ({ id: `p${i}-${j}`, ...clone(it) })), updatedAt: ts };
}

function defaultPlan(ts) {
  const plan = {};
  for (let i = 0; i < MAX_PLAN_DAYS; i++) plan[i] = programDay(i, ts);
  return plan;
}

/** Cardio settings an exercise can log. */
export const CARDIO_FIELDS = ['rounds', 'speed', 'incline', 'level'];
// Custom cardio exercises (no `fields`) log these by default.
const DEFAULT_CARDIO_FIELDS = ['speed', 'incline', 'level'];

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

export function defaultSettings(ts) {
  return {
    unit: 'lb',
    distanceUnit: 'mi',
    weightStep: 5,
    weekStart: 1,
    planMode: PLAN.mode,
    cycleLength: PLAN.length,
    cycleStart: PLAN.start || todayISO(),
    restSec: 90,
    autoRest: true,
    restSound: true,
    updatedAt: ts,
  };
}

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
  };
}

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
      cycleStart: !Number(st.updatedAt) && PLAN.start ? PLAN.start : isISODate(st.cycleStart) ? st.cycleStart : todayISO(),
      restSec: Math.round(clampNum(st.restSec, 0, 1800)),
      autoRest: st.autoRest !== false,
      restSound: st.restSound !== false,
      updatedAt: Number(st.updatedAt) || 0,
    },
    exercises: {},
    plan: {},
    sessions: {},
    body: {},
  };

  const needDefaults = !isObj(input.exercises) || !isObj(input.plan);
  const base = needDefaults ? defaultState(0) : null;
  const exercises = isObj(input.exercises) ? input.exercises : base.exercises;
  for (const [id, ex] of Object.entries(exercises)) {
    if (!isObj(ex)) continue;
    // Exercises nobody has edited follow the current program definition.
    if (!Number(ex.updatedAt) && !ex.deleted && PROGRAM_EXERCISES[id]) {
      out.exercises[id] = programExercise(...PROGRAM_EXERCISES[id]);
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
    if (!isObj(d) || !Number(d.updatedAt)) {
      out.plan[i] = programDay(i, 0);
      continue;
    }
    out.plan[i] = {
      name: String(d.name || '').slice(0, 60),
      dayType: DAY_TYPES[d.dayType] ? d.dayType : 'training',
      note: String(d.note || '').slice(0, 500),
      items: (Array.isArray(d.items) ? d.items : []).filter((it) => isObj(it) && it.exerciseId).map((it) => ({ id: String(it.id || uid()), exerciseId: String(it.exerciseId), ...normalizeTarget(it) })),
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
    out.body[date] = { weight: round(clampNum(b.weight, 0, 2000), 2), updatedAt: Number(b.updatedAt) || 0 };
  }
  return out;
}

function normalizeEntry(e) {
  const kind = KINDS[e.kind] ? e.kind : 'strength';
  const out = {
    id: String(e.id || uid()),
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
        ? { id: String(s.id || uid()), holdSec: clampNum(s.holdSec), done: !!s.done }
        : { id: String(s.id || uid()), reps: clampNum(s.reps), weight: clampNum(s.weight), done: !!s.done };
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
    body: mergeMap(a.body, b.body),
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

export function addExercise(state, { name, kind = 'strength', group = '' }) {
  const id = uid();
  state.exercises[id] = { id, name: name.trim().slice(0, 80) || 'New exercise', kind: KINDS[kind] ? kind : 'strength', group, updatedAt: now() };
  return id;
}

// ---------------------------------------------------------------------------
// Plan (weekly, or an N-day rotation like 3 on / 1 off)
// ---------------------------------------------------------------------------

export function isCycle(state) {
  return state.settings.planMode === 'cycle';
}

export function planDayCount(state) {
  return isCycle(state) ? state.settings.cycleLength : 7;
}

/** Which plan day applies to a calendar date. */
export function planIndex(state, date) {
  if (!isCycle(state)) return weekdayOf(date);
  const n = state.settings.cycleLength;
  return (((daysBetween(state.settings.cycleStart, date) % n) + n) % n);
}

export function planLabel(state, idx) {
  return isCycle(state) ? `Day ${idx + 1}` : WEEKDAY_NAMES[idx];
}

/** Plan day indexes in display order. */
export function planOrder(state) {
  if (isCycle(state)) return Array.from({ length: state.settings.cycleLength }, (_, i) => i);
  return Array.from({ length: 7 }, (_, i) => (state.settings.weekStart + i) % 7);
}

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

export function copyPlanDay(state, from, to) {
  const src = planDay(state, from);
  state.plan[to] = { name: src.name, dayType: src.dayType, note: src.note, items: src.items.map((it) => ({ ...clone(it), id: uid() })), updatedAt: now() };
}

// ---------------------------------------------------------------------------
// Sessions (one per calendar day)
// ---------------------------------------------------------------------------

export function getSession(state, date) {
  const s = state.sessions[date];
  return s && !s.deleted ? s : null;
}

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
  const prevOf = (type) => prevDone.filter((s) => setType(s) === type);
  const pw = prevOf('work');
  const at = (list, i) => list[i] || list[list.length - 1];
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

export function workingSets(entry) {
  return (entry.sets || []).filter((s) => setType(s) === 'work');
}

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

/** Totals over a date range (inclusive). */
export function rangeSummary(state, from, to) {
  const sum = { workouts: 0, sets: 0, reps: 0, volume: 0, cardioMin: 0, distance: 0, vacuumSec: 0, vacuumSets: 0, holdSec: 0 };
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
// Body weight (daily scale weight)
// ---------------------------------------------------------------------------

export function setBodyWeight(state, date, weight) {
  state.body[date] = { weight: round(clampNum(weight, 0, 2000), 2), updatedAt: now() };
}

/** Weigh-ins in [from, to], oldest first. A weight of 0 means "cleared". */
export function bodyWeights(state, from = '0000-01-01', to = '9999-12-31') {
  return Object.entries(state.body)
    .filter(([d, b]) => b.weight > 0 && d >= from && d <= to)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, b]) => ({ date, weight: b.weight }));
}

export function bodyWeightOn(state, date) {
  const b = state.body[date];
  return b && b.weight > 0 ? b.weight : 0;
}

/** Last weigh-in strictly before a date. */
export function previousBodyWeight(state, date) {
  const list = bodyWeights(state, '0000-01-01', addDays(date, -1));
  return list[list.length - 1] || null;
}

/** Average of weigh-ins in the `days` days ending on `date`. */
export function bodyWeightAverage(state, date, days = 7) {
  const list = bodyWeights(state, addDays(date, -(days - 1)), date);
  if (!list.length) return 0;
  return round(list.reduce((a, b) => a + b.weight, 0) / list.length, 1);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One row per logged set / cardio session / weigh-in, for spreadsheets. */
export function toCSV(state) {
  const rows = [['date', 'day', 'exercise', 'type', 'set', 'set_type', 'weight', 'reps', 'hold_sec', 'minutes', 'distance', 'calories', 'avg_hr', 'rpe', 'done', `unit=${state.settings.unit}`]];
  for (const d of sessionDates(state)) {
    const s = state.sessions[d];
    for (const e of s.entries) {
      const name = exerciseName(state, e.exerciseId);
      const rpe = e.rpe || '';
      if (e.kind === 'cardio') {
        const c = e.cardio;
        rows.push([d, s.name, name, 'cardio', 1, '', '', '', '', c.minutes, c.distance, c.calories, c.avgHr, rpe, c.done ? 1 : 0]);
      } else {
        e.sets.forEach((x, i) => {
          const hold = isHold(e.kind);
          rows.push([d, s.name, name, e.kind, i + 1, hold ? '' : setType(x), hold ? '' : x.weight, hold ? '' : x.reps, hold ? x.holdSec : '', '', '', '', '', rpe, x.done ? 1 : 0]);
        });
      }
    }
  }
  for (const b of bodyWeights(state)) rows.push([b.date, '', 'Body weight', 'bodyweight', '', '', b.weight, '', '', '', '', '', '', '', 1]);
  return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}
