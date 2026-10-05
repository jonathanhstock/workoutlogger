import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../public/js/model.js';

const D1 = '2026-10-05'; // set as rotation Day 1 in these tests (a Monday)

function fresh() {
  const s = M.defaultState();
  s.settings.cycleStart = D1;
  return s;
}

function withSession(state, date, entries, extra = {}) {
  state.sessions[date] = { date, name: 'Test', dayType: 'training', note: '', notes: '', entries, updatedAt: 1, ...extra };
  return state.sessions[date];
}

/** sets: [weight, reps, done = true, type?] */
function strength(exerciseId, sets, target = { sets: sets.length, reps: 8, weight: 0 }, extra = {}) {
  return {
    id: M.uid(),
    exerciseId,
    kind: 'strength',
    target,
    notes: '',
    rpe: 0,
    sets: sets.map(([weight, reps, done = true, type]) => ({ id: M.uid(), weight, reps, done, ...(type ? { type } : {}) })),
    ...extra,
  };
}

describe('dates', () => {
  test('addDays crosses month and year boundaries', () => {
    assert.equal(M.addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(M.addDays('2026-03-01', -1), '2026-02-28');
    assert.equal(M.addDays('2028-02-28', 1), '2028-02-29');
  });

  test('addDays is stable across DST changes', () => {
    let d = '2026-03-01';
    for (let i = 0; i < 60; i++) d = M.addDays(d, 1);
    assert.equal(d, '2026-04-30');
    assert.equal(M.addDays('2026-11-01', 1), '2026-11-02');
  });

  test('weekday and startOfWeek', () => {
    assert.equal(M.weekdayOf(D1), 1);
    assert.equal(M.startOfWeek('2026-10-11', 1), D1);
    assert.equal(M.startOfWeek('2026-10-11', 0), '2026-10-11');
  });

  test('isISODate', () => {
    assert.ok(M.isISODate('2026-01-31'));
    assert.ok(!M.isISODate('2026-1-31'));
    assert.ok(!M.isISODate(undefined));
  });
});

describe('the starting program', () => {
  test('is a 3-on / 1-off rotation of 8 days, all in lb', () => {
    const s = fresh();
    assert.equal(s.settings.planMode, 'cycle');
    assert.equal(s.settings.cycleLength, 8);
    assert.equal(s.settings.unit, 'lb');
    const names = M.planOrder(s).map((i) => s.plan[i].name);
    assert.deepEqual(names, ['Chest & Triceps', 'Back & Biceps', 'Shoulders, Rear Delts & Traps', 'Rest', 'Legs', 'Chest & Shoulders', 'Arms & Lats', 'Rest']);
    assert.equal(s.plan[3].dayType, 'active');
  });

  test('the rotation starts with Day 1 on Oct 5, 2026', () => {
    const s = M.defaultState();
    assert.equal(M.planIndex(s, '2026-10-05'), 0);
    assert.equal(M.planIndex(s, '2026-10-09'), 4); // Legs, after the first rest day
  });

  test('every plan item references a real exercise', () => {
    const s = fresh();
    for (const i of M.planOrder(s)) for (const it of s.plan[i].items) assert.ok(s.exercises[it.exerciseId], it.exerciseId);
  });

  test('vacuums every day, fasted cardio ~4-5x and core ~2-3x per week', () => {
    const s = fresh();
    const days = M.planOrder(s).map((i) => s.plan[i].items.map((it) => it.exerciseId));
    assert.ok(days.every((d) => d.includes('vacuum')));
    const perWeek = (id) => (days.filter((d) => d.includes(id)).length / 8) * 7;
    assert.ok(perWeek('incline-walk') >= 4 && perWeek('incline-walk') <= 5, `cardio ${perWeek('incline-walk')}`);
    assert.ok(perWeek('plank') >= 2 && perWeek('plank') <= 3, `core ${perWeek('plank')}`);
    const vac = s.plan[0].items.find((it) => it.exerciseId === 'vacuum');
    assert.deepEqual([vac.sets, vac.setsMax, vac.holdSec], [5, 8, 10]);
  });

  test('ranges, pyramids, warm-ups, drop sets and optional items are kept', () => {
    const s = fresh();
    const d1 = s.plan[0].items;
    const incline = d1.find((it) => it.exerciseId === 'incline-machine-press');
    assert.deepEqual([incline.sets, incline.setsMax, incline.reps, incline.repsMax, incline.dropSets], [3, 4, 8, 10, 1]);
    assert.deepEqual(d1.find((it) => it.exerciseId === 'skull-crusher').repScheme, [15, 12, 10, 10]);
    assert.equal(d1.find((it) => it.exerciseId === 'triceps-pushdown').warmupSets, 1);
    assert.equal(d1.find((it) => it.exerciseId === 'incline-db-fly').optional, true);
    assert.equal(s.exercises.plank.kind, 'timed');
  });
});

describe('rotation plan', () => {
  test('planIndex walks the 8-day cycle in both directions', () => {
    const s = fresh();
    assert.equal(M.planIndex(s, D1), 0);
    assert.equal(M.planIndex(s, M.addDays(D1, 3)), 3);
    assert.equal(M.planIndex(s, M.addDays(D1, 8)), 0);
    assert.equal(M.planIndex(s, M.addDays(D1, -1)), 7);
    assert.equal(M.planLabel(s, 2), 'Day 3');
  });

  test('anchorCycle makes a date a given day (e.g. after a missed day)', () => {
    const s = fresh();
    const tue = M.addDays(D1, 1);
    M.anchorCycle(s, tue, 0); // skipped Monday: Tuesday is Day 1
    assert.equal(M.planIndex(s, tue), 0);
    assert.equal(M.sessionOrDraft(s, tue).session.name, 'Chest & Triceps');
  });

  test('weekly mode uses weekdays', () => {
    const s = fresh();
    s.settings.planMode = 'weekly';
    assert.equal(M.planIndex(s, D1), 1);
    assert.equal(M.planLabel(s, 1), 'Monday');
    assert.equal(M.planOrder(s)[0], 1);
  });

  test('old weekly logbooks stay weekly after loading', () => {
    const n = M.normalizeState({ settings: { unit: 'lb' }, exercises: {}, plan: {}, sessions: {} });
    assert.equal(n.settings.planMode, 'weekly');
  });
});

describe('drafts and entries', () => {
  test('a day with no session is a draft built from the plan', () => {
    const s = fresh();
    const { session, draft } = M.sessionOrDraft(s, D1);
    assert.equal(draft, true);
    assert.equal(session.name, 'Chest & Triceps');
    assert.match(session.note, /rotator cuff/);
    assert.equal(s.sessions[D1], undefined, 'draft is not stored');
  });

  test('warm-up, working, drop and failure sets are generated in order', () => {
    const s = fresh();
    const row = M.makeEntry(s, 'row', { sets: 3, reps: 8, repsMax: 10, warmupSets: 1, warmupReps: 12, dropSets: 1 });
    assert.deepEqual(row.sets.map((x) => [x.type || 'work', x.reps]), [['warmup', 12], ['work', 8], ['work', 8], ['work', 8], ['drop', 10]]);
    const curl = M.makeEntry(s, 'leg-curl', { repScheme: [15, 15, 12, 12], failureSets: 1 });
    assert.deepEqual(curl.sets.map((x) => [x.type || 'work', x.reps]), [['work', 15], ['work', 15], ['work', 12], ['work', 12], ['failure', 12]]);
  });

  test('sets are pre-filled from the last performance, by set type', () => {
    const s = fresh();
    withSession(s, '2026-09-28', [strength('row', [[95, 12, true, 'warmup'], [185, 8], [185, 8], [190, 7], [135, 10, true, 'drop']])]);
    const e = M.makeEntry(s, 'row', { sets: 3, reps: 8, warmupSets: 1, dropSets: 1 }, D1);
    assert.deepEqual(e.sets.map((x) => x.weight), [95, 185, 185, 190, 135]);
    assert.equal(e.target.weight, 190, 'target shows the real working weight');
  });

  test('within a rep range, reps start from last time', () => {
    const s = fresh();
    withSession(s, '2026-09-28', [strength('flat-press', [[185, 12], [185, 11], [185, 9]])]);
    const e = M.makeEntry(s, 'flat-press', { sets: 4, reps: 10, repsMax: 12 }, D1);
    assert.deepEqual(e.sets.map((x) => x.reps), [12, 11, 10, 10]);
  });

  test('drop sets default to ~70% of the working weight', () => {
    const s = fresh();
    const e = M.makeEntry(s, 'row', { sets: 2, reps: 8, weight: 200, dropSets: 1 });
    assert.equal(e.sets[2].weight, 140);
  });

  test('ensureSession / resetSession', () => {
    const s = fresh();
    const sess = M.ensureSession(s, D1);
    assert.equal(s.sessions[D1], sess);
    M.resetSession(s, D1);
    assert.equal(M.getSession(s, D1), null);
    assert.ok(M.sessionOrDraft(s, D1).session.entries.length > 5);
  });

  test('deleted exercises are left out of new drafts', () => {
    const s = fresh();
    s.exercises['push-up'].deleted = true;
    assert.ok(!M.sessionOrDraft(s, D1).session.entries.some((e) => e.exerciseId === 'push-up'));
  });
});

describe('set controls', () => {
  test('completeNextSet / undoLastSet act like +/- counters and record times', () => {
    const e = strength('dips', [[0, 15, false], [0, 15, false]]);
    const set = M.completeNextSet(e);
    assert.equal(set.done, true);
    assert.ok(set.at > 0);
    M.completeNextSet(e);
    M.completeNextSet(e); // beyond target adds an extra completed set
    assert.equal(e.sets.length, 3);
    M.undoLastSet(e);
    assert.deepEqual(e.sets.map((x) => x.done), [true, true, false]);
    assert.equal(e.sets[2].at, undefined);
  });

  test('setTargetSets changes working sets only and keeps finishers last', () => {
    const e = strength('row', [[95, 12, true, 'warmup'], [185, 8, true], [185, 8, false], [130, 10, false, 'drop']], { sets: 2, reps: 8 });
    M.setTargetSets(e, 4);
    assert.deepEqual(e.sets.map((x) => x.type || 'work'), ['warmup', 'work', 'work', 'work', 'work', 'drop']);
    M.setTargetSets(e, 1);
    assert.deepEqual(e.sets.map((x) => x.type || 'work'), ['warmup', 'work', 'drop'], 'completed work is never removed');
  });

  test('setTypedCount adds and removes warm-up / drop sets', () => {
    const e = strength('row', [[200, 8, false]], { sets: 1, reps: 8, weight: 200 });
    M.setTypedCount(e, 'warmup', 1);
    M.setTypedCount(e, 'drop', 2);
    assert.deepEqual(e.sets.map((x) => [x.type || 'work', x.weight]), [['warmup', 100], ['work', 200], ['drop', 140], ['drop', 140]]);
    M.setTypedCount(e, 'drop', 0);
    assert.equal(e.sets.filter((x) => x.type === 'drop').length, 0);
  });

  test('cycleSetType rotates through the types', () => {
    const set = { weight: 1, reps: 1 };
    const seen = [];
    for (let i = 0; i < 4; i++) {
      M.cycleSetType(set);
      seen.push(set.type || 'work');
    }
    assert.deepEqual(seen, ['warmup', 'drop', 'failure', 'work']);
  });

  test('restTaken measures time between completed sets', () => {
    const e = strength('dips', [[0, 15, false], [0, 15, false], [0, 15, false]]);
    M.markSet(e.sets[0], true, 1000);
    M.markSet(e.sets[1], true, 91000);
    const r = M.restTaken(e);
    assert.equal(r[e.sets[1].id], 90);
    assert.equal(r[e.sets[0].id], undefined);
  });

  test('hold entries (vacuum, plank)', () => {
    const s = fresh();
    const v = M.makeEntry(s, 'vacuum', { sets: 5, holdSec: 10 });
    assert.equal(v.sets.length, 5);
    const p = M.makeEntry(s, 'plank', { sets: 3, holdSec: 45 });
    assert.equal(p.kind, 'timed');
    assert.ok(M.isHold(p.kind));
    M.addSet(p);
    assert.equal(p.sets[3].holdSec, 45);
  });
});

describe('metrics', () => {
  test('e1rm (Epley)', () => {
    assert.equal(M.e1rm(100, 1), 100);
    assert.equal(M.e1rm(100, 10), 133.3);
    assert.equal(M.e1rm(0, 10), 0);
  });

  test('warm-ups are excluded from load; drop sets count', () => {
    const e = strength('row', [[95, 12, true, 'warmup'], [100, 10], [70, 10, true, 'drop'], [120, 5, false]]);
    const m = M.entryMetrics(e);
    assert.equal(m.volume, 1700);
    assert.equal(m.sets, 2);
    assert.equal(m.topWeight, 100);
    assert.equal(M.entryMetrics(e, false).volume, 2300);
  });

  test('cardio and hold metrics', () => {
    const c = { kind: 'cardio', cardio: { minutes: 30, distance: 3, done: true } };
    assert.equal(M.entryMetrics(c).pace, 10);
    const v = { kind: 'vacuum', sets: [{ holdSec: 10, done: true }, { holdSec: 12, done: true }, { holdSec: 10, done: false }] };
    assert.deepEqual([M.entryMetrics(v).totalHold, M.entryMetrics(v).longestHold], [22, 12]);
  });

  test('previousEntry finds the latest completed session before a date', () => {
    const s = fresh();
    withSession(s, '2026-09-21', [strength('flat-press', [[175, 8]])]);
    withSession(s, '2026-09-28', [strength('flat-press', [[180, 8]])]);
    withSession(s, '2026-09-30', [strength('flat-press', [[999, 8, false]])]);
    const p = M.previousEntry(s, 'flat-press', D1);
    assert.equal(p.date, '2026-09-28');
    assert.equal(M.previousEntry(s, 'flat-press', '2026-09-21'), null);
  });

  test('overloadHint suggests more weight after topping the rep range', () => {
    const s = fresh();
    const target = { sets: 3, reps: 8, repsMax: 10, weight: 0 };
    withSession(s, '2026-09-28', [strength('flat-press', [[180, 10], [180, 10], [180, 10]], target)]);
    const prev = M.previousEntry(s, 'flat-press', D1);
    const today = M.makeEntry(s, 'flat-press', target, D1);
    assert.deepEqual(M.overloadHint(s, today, prev), { reps: 10, from: 180, to: 185 });
    // Not when a set fell short, or when it was an all-out effort.
    s.sessions['2026-09-28'].entries[0].sets[2].reps = 9;
    assert.equal(M.overloadHint(s, today, M.previousEntry(s, 'flat-press', D1)), null);
    s.sessions['2026-09-28'].entries[0].sets[2].reps = 10;
    s.sessions['2026-09-28'].entries[0].rpe = 10;
    assert.equal(M.overloadHint(s, today, M.previousEntry(s, 'flat-press', D1)), null);
  });

  test('exerciseHistory filters by range', () => {
    const s = fresh();
    withSession(s, '2026-08-01', [strength('squat', [[200, 5]])]);
    withSession(s, '2026-09-01', [strength('squat', [[210, 5]])]);
    withSession(s, '2026-10-01', [strength('squat', [[220, 5]])]);
    assert.deepEqual(M.exerciseHistory(s, 'squat', '2026-08-15', '2026-09-30').map((x) => x.metrics.topWeight), [210]);
  });

  test('rangeSummary and weeklySummaries', () => {
    const s = fresh();
    withSession(s, '2026-09-29', [strength('flat-press', [[100, 10], [100, 10]]), { id: 'c', exerciseId: 'incline-walk', kind: 'cardio', target: {}, cardio: { minutes: 30, distance: 1.5, done: true } }]);
    withSession(s, D1, [{ id: 'v', exerciseId: 'vacuum', kind: 'vacuum', target: {}, sets: [{ holdSec: 10, done: true }] }]);
    const sum = M.rangeSummary(s, '2026-09-28', '2026-10-11');
    assert.deepEqual([sum.workouts, sum.volume, sum.cardioMin, sum.vacuumSec], [2, 2000, 30, 10]);
    const weeks = M.weeklySummaries(s, '2026-09-28', '2026-10-11', 1);
    assert.deepEqual(weeks.map((w) => w.workouts), [1, 1]);
  });

  test('dayStatus ignores optional exercises you skipped', () => {
    const s = fresh();
    assert.equal(M.dayStatus(s, D1), 'planned');
    withSession(s, D1, [strength('dips', [[0, 15], [0, 15, false]]), strength('incline-db-fly', [[30, 10, false]], { sets: 1, reps: 10, optional: true })]);
    assert.equal(M.dayStatus(s, D1), 'partial');
    s.sessions[D1].entries[0].sets[1].done = true;
    assert.equal(M.dayStatus(s, D1), 'done');
  });
});

describe('body weight', () => {
  test('weigh-ins, previous, averages and clearing', () => {
    const s = fresh();
    M.setBodyWeight(s, '2026-10-01', 182.4);
    M.setBodyWeight(s, '2026-10-03', 181.8);
    M.setBodyWeight(s, D1, 181.2);
    assert.equal(M.bodyWeightOn(s, D1), 181.2);
    assert.deepEqual(M.previousBodyWeight(s, D1), { date: '2026-10-03', weight: 181.8 });
    assert.equal(M.bodyWeightAverage(s, D1, 7), 181.8);
    M.setBodyWeight(s, D1, 0);
    assert.equal(M.bodyWeightOn(s, D1), 0);
    assert.equal(M.bodyWeights(s).length, 2);
  });

  test('body weights merge per day', () => {
    const a = fresh();
    const b = structuredClone(a);
    a.body['2026-10-01'] = { weight: 180, updatedAt: 5 };
    b.body['2026-10-01'] = { weight: 181, updatedAt: 9 };
    b.body['2026-10-02'] = { weight: 182, updatedAt: 1 };
    const m = M.mergeStates(a, b);
    assert.equal(m.body['2026-10-01'].weight, 181);
    assert.equal(m.body['2026-10-02'].weight, 182);
  });
});

describe('merge (sync)', () => {
  test('newest record wins per session, other records are unioned', () => {
    const base = fresh();
    const a = structuredClone(base);
    const b = structuredClone(base);
    withSession(a, '2026-10-01', [strength('row', [[100, 5]])], { updatedAt: 10 });
    withSession(b, '2026-10-01', [strength('row', [[105, 5]])], { updatedAt: 20 });
    withSession(b, '2026-10-02', [strength('squat', [[200, 5]])], { updatedAt: 5 });
    a.settings = { ...a.settings, restSec: 120, updatedAt: Date.now() + 1000 };
    const m = M.mergeStates(a, b);
    assert.equal(m.sessions['2026-10-01'].entries[0].sets[0].weight, 105);
    assert.ok(m.sessions['2026-10-02']);
    assert.equal(m.settings.restSec, 120);
  });

  test('merge is commutative and idempotent', () => {
    const a = fresh();
    const b = structuredClone(a);
    withSession(a, '2026-10-01', [strength('row', [[100, 5]])], { updatedAt: 7 });
    withSession(b, '2026-10-01', [strength('row', [[110, 5]])], { updatedAt: 7 });
    b.plan[1] = { ...b.plan[1], name: 'Back day', updatedAt: Date.now() + 1000 };
    const ab = M.mergeStates(a, b);
    assert.ok(M.statesEqual(ab, M.mergeStates(b, a)));
    assert.ok(M.statesEqual(M.mergeStates(ab, ab), ab));
    assert.equal(ab.plan[1].name, 'Back day');
  });

  test('a brand-new device never overwrites real data', () => {
    const server = M.normalizeState(null);
    server.settings = { ...server.settings, restSec: 75, updatedAt: 500 };
    server.plan[1] = { ...server.plan[1], name: 'My back day', updatedAt: 500 };
    const m = M.mergeStates(M.normalizeState(null), server);
    assert.equal(m.settings.restSec, 75);
    assert.equal(m.plan[1].name, 'My back day');
  });

  test('deletions propagate as tombstones', () => {
    const a = fresh();
    withSession(a, D1, [strength('row', [[100, 5]])], { updatedAt: 5 });
    const b = structuredClone(a);
    b.sessions[D1] = { date: D1, deleted: true, updatedAt: 6 };
    assert.equal(M.getSession(M.mergeStates(a, b), D1), null);
  });
});

describe('normalizeState', () => {
  test('repairs garbage input', () => {
    const s = M.normalizeState({
      settings: { unit: 'stones', weekStart: 5, cycleLength: 99, restSec: -4 },
      exercises: {},
      plan: {},
      sessions: { nope: {}, '2026-10-01': { entries: [{ exerciseId: 'row', rpe: 14, sets: [{ weight: '100', reps: -3, done: 1, type: 'bogus' }] }, 'junk'] } },
      body: { '2026-10-01': { weight: '181.24' }, bad: { weight: 1 } },
    });
    assert.equal(s.settings.unit, 'lb');
    assert.equal(s.settings.cycleLength, M.MAX_PLAN_DAYS);
    assert.equal(s.settings.restSec, 0);
    assert.equal(s.sessions.nope, undefined);
    const e = s.sessions['2026-10-01'].entries[0];
    assert.equal(e.rpe, 10);
    assert.deepEqual([e.sets[0].weight, e.sets[0].reps, e.sets[0].done, e.sets[0].type], [100, 0, true, undefined]);
    assert.equal(s.body['2026-10-01'].weight, 181.24);
    assert.equal(s.body.bad, undefined);
    assert.equal(Object.keys(s.plan).length, M.MAX_PLAN_DAYS);
  });

  test('round-trips a valid state unchanged', () => {
    const s = fresh();
    withSession(s, D1, [strength('row', [[95, 12, true, 'warmup'], [100, 5]], { sets: 1, reps: 5, repsMax: 8, dropSets: 0, note: 'x', optional: true }, { rpe: 8.5 })], { updatedAt: 5 });
    M.setBodyWeight(s, D1, 181.2);
    const n = M.normalizeState(JSON.parse(JSON.stringify(s)));
    assert.ok(M.statesEqual(M.normalizeState(n), n));
    assert.equal(n.sessions[D1].entries[0].sets[0].type, 'warmup');
    assert.equal(n.sessions[D1].entries[0].rpe, 8.5);
    assert.equal(n.sessions[D1].entries[0].target.optional, true);
  });
});

describe('plan helpers and export', () => {
  test('saveSessionAsPlan copies targets into the plan day for that date', () => {
    const s = fresh();
    const sess = M.ensureSession(s, D1);
    sess.name = 'Heavy chest';
    sess.entries = [M.makeEntry(s, 'flat-press', { sets: 5, reps: 5, weight: 225, note: 'pause reps' })];
    M.saveSessionAsPlan(s, D1);
    assert.equal(s.plan[0].name, 'Heavy chest');
    assert.deepEqual([s.plan[0].items[0].sets, s.plan[0].items[0].weight, s.plan[0].items[0].note], [5, 225, 'pause reps']);
  });

  test('copyPlanDay gives new item ids', () => {
    const s = fresh();
    M.copyPlanDay(s, 0, 7);
    assert.equal(s.plan[7].name, 'Chest & Triceps');
    assert.notEqual(s.plan[7].items[0].id, s.plan[0].items[0].id);
  });

  test('toCSV includes set types, RPE and weigh-ins', () => {
    const s = fresh();
    s.exercises.row.name = 'Row, "heavy"';
    withSession(s, D1, [strength('row', [[95, 12, true, 'warmup'], [185, 8]], undefined, { rpe: 8 })]);
    M.setBodyWeight(s, D1, 181.2);
    const lines = M.toCSV(s).trim().split('\n');
    assert.equal(lines.length, 4);
    assert.ok(lines[1].includes('"Row, ""heavy"""'));
    assert.ok(lines[1].includes(',warmup,'));
    assert.ok(lines[3].includes('bodyweight'));
  });
});
