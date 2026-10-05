import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../public/js/model.js';

const MON = '2026-10-05'; // a Monday

function withSession(state, date, entries, extra = {}) {
  state.sessions[date] = { date, name: 'Test', dayType: 'training', notes: '', entries, updatedAt: 1, ...extra };
  return state.sessions[date];
}

function strength(exerciseId, sets, target = { sets: sets.length, reps: 8, weight: 0 }) {
  return { id: M.uid(), exerciseId, kind: 'strength', target, notes: '', sets: sets.map(([weight, reps, done = true]) => ({ id: M.uid(), weight, reps, done })) };
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
    assert.equal(M.weekdayOf(MON), 1);
    assert.equal(M.startOfWeek('2026-10-11', 1), MON); // Sunday -> previous Monday
    assert.equal(M.startOfWeek('2026-10-11', 0), '2026-10-11');
    assert.equal(M.startOfWeek('2026-10-07', 0), '2026-10-04');
  });

  test('isISODate', () => {
    assert.ok(M.isISODate('2026-01-31'));
    assert.ok(!M.isISODate('2026-1-31'));
    assert.ok(!M.isISODate('hello'));
    assert.ok(!M.isISODate(undefined));
  });
});

describe('default state and plan drafts', () => {
  test('default plan covers all 7 days with valid exercises', () => {
    const s = M.defaultState();
    for (let wd = 0; wd < 7; wd++) {
      assert.ok(s.plan[wd], `day ${wd}`);
      for (const it of s.plan[wd].items) assert.ok(s.exercises[it.exerciseId], it.exerciseId);
    }
    assert.equal(s.plan[4].dayType, 'active');
    assert.equal(s.plan[0].dayType, 'rest');
  });

  test('a day with no session is a draft built from the plan', () => {
    const s = M.defaultState();
    const { session, draft } = M.sessionOrDraft(s, MON);
    assert.equal(draft, true);
    assert.equal(session.name, 'Push');
    assert.equal(session.entries[0].exerciseId, 'bench');
    assert.equal(session.entries[0].sets.length, 4);
    assert.equal(s.sessions[MON], undefined, 'draft is not stored');
  });

  test('ensureSession stores the session', () => {
    const s = M.defaultState();
    const sess = M.ensureSession(s, MON);
    assert.equal(s.sessions[MON], sess);
    assert.ok(sess.updatedAt > 0);
    assert.equal(M.ensureSession(s, MON), sess);
  });

  test('new sets are pre-filled from the last performance', () => {
    const s = M.defaultState();
    withSession(s, '2026-09-28', [strength('bench', [[185, 8], [185, 8], [190, 6]])]);
    const { session } = M.sessionOrDraft(s, MON);
    const bench = session.entries.find((e) => e.exerciseId === 'bench');
    assert.deepEqual(bench.sets.map((x) => x.weight), [185, 185, 190, 190]);
    assert.ok(bench.sets.every((x) => !x.done && x.reps === 8));
  });

  test('an explicit planned weight wins over the last performance', () => {
    const s = M.defaultState();
    s.plan[1].items[0].weight = 200;
    withSession(s, '2026-09-28', [strength('bench', [[185, 8]])]);
    const bench = M.sessionOrDraft(s, MON).session.entries[0];
    assert.ok(bench.sets.every((x) => x.weight === 200));
  });

  test('resetSession turns a day back into a plan draft', () => {
    const s = M.defaultState();
    M.ensureSession(s, MON).entries = [];
    M.resetSession(s, MON);
    assert.equal(M.getSession(s, MON), null);
    assert.equal(M.sessionOrDraft(s, MON).session.entries.length, 6);
  });

  test('deleted exercises are left out of new drafts', () => {
    const s = M.defaultState();
    s.exercises.bench.deleted = true;
    const ids = M.sessionOrDraft(s, MON).session.entries.map((e) => e.exerciseId);
    assert.ok(!ids.includes('bench'));
  });
});

describe('set controls', () => {
  test('completeNextSet / undoLastSet act like +/- counters', () => {
    const e = strength('bench', [[100, 5, false], [100, 5, false]]);
    M.completeNextSet(e);
    assert.deepEqual(e.sets.map((x) => x.done), [true, false]);
    M.completeNextSet(e);
    M.completeNextSet(e); // beyond target adds an extra completed set
    assert.equal(e.sets.length, 3);
    assert.ok(e.sets.every((x) => x.done));
    M.undoLastSet(e);
    assert.deepEqual(e.sets.map((x) => x.done), [true, true, false]);
  });

  test('cardio counter toggles done', () => {
    const s = M.defaultState();
    const e = M.makeEntry(s, 'treadmill', { minutes: 30 });
    assert.equal(e.cardio.minutes, 30);
    M.completeNextSet(e);
    assert.equal(e.cardio.done, true);
    M.undoLastSet(e);
    assert.equal(e.cardio.done, false);
  });

  test('setTargetSets never deletes completed work', () => {
    const e = strength('bench', [[100, 5, true], [100, 5, true], [100, 5, false], [100, 5, false]]);
    M.setTargetSets(e, 1);
    assert.equal(e.sets.length, 2);
    assert.ok(e.sets.every((x) => x.done));
    M.setTargetSets(e, 5);
    assert.equal(e.sets.length, 5);
    assert.equal(e.target.sets, 5);
  });

  test('addSet copies the previous set', () => {
    const e = strength('bench', [[135, 12]]);
    M.addSet(e);
    assert.equal(e.sets[1].weight, 135);
    assert.equal(e.sets[1].reps, 12);
    assert.equal(e.sets[1].done, false);
  });

  test('vacuum entries hold seconds', () => {
    const s = M.defaultState();
    const e = M.makeEntry(s, 'vacuum-standing', { sets: 2, holdSec: 30 });
    assert.equal(e.kind, 'vacuum');
    assert.deepEqual(e.sets.map((x) => x.holdSec), [30, 30]);
    M.addSet(e);
    assert.equal(e.sets[2].holdSec, 30);
  });
});

describe('metrics', () => {
  test('e1rm (Epley)', () => {
    assert.equal(M.e1rm(100, 1), 100);
    assert.equal(M.e1rm(100, 10), 133.3);
    assert.equal(M.e1rm(0, 10), 0);
  });

  test('strength metrics only count completed sets by default', () => {
    const e = strength('bench', [[100, 10], [110, 8], [120, 5, false]]);
    const done = M.entryMetrics(e);
    assert.equal(done.volume, 1880);
    assert.equal(done.sets, 2);
    assert.equal(done.topWeight, 110);
    const planned = M.entryMetrics(e, false);
    assert.equal(planned.volume, 2480);
    assert.equal(planned.topWeight, 120);
  });

  test('cardio metrics and pace', () => {
    const e = { kind: 'cardio', cardio: { minutes: 30, distance: 3, done: true } };
    const m = M.entryMetrics(e);
    assert.equal(m.pace, 10);
    assert.equal(m.load, 30);
    e.cardio.done = false;
    assert.equal(M.entryMetrics(e).minutes, 0);
    assert.equal(M.entryMetrics(e, false).minutes, 30);
  });

  test('vacuum metrics', () => {
    const e = { kind: 'vacuum', sets: [{ holdSec: 20, done: true }, { holdSec: 35, done: true }, { holdSec: 40, done: false }] };
    const m = M.entryMetrics(e);
    assert.equal(m.totalHold, 55);
    assert.equal(m.longestHold, 35);
  });

  test('previousEntry finds the latest completed session before a date', () => {
    const s = M.defaultState();
    withSession(s, '2026-09-21', [strength('bench', [[175, 8]])]);
    withSession(s, '2026-09-28', [strength('bench', [[180, 8]])]);
    withSession(s, '2026-09-30', [strength('bench', [[999, 8, false]])]); // nothing done
    withSession(s, MON, [strength('bench', [[185, 8]])]);
    const p = M.previousEntry(s, 'bench', MON);
    assert.equal(p.date, '2026-09-28');
    assert.equal(p.entry.sets[0].weight, 180);
    assert.equal(M.previousEntry(s, 'bench', '2026-09-21'), null);
  });

  test('exerciseHistory filters by range', () => {
    const s = M.defaultState();
    withSession(s, '2026-08-01', [strength('squat', [[200, 5]])]);
    withSession(s, '2026-09-01', [strength('squat', [[210, 5]])]);
    withSession(s, '2026-10-01', [strength('squat', [[220, 5]])]);
    assert.equal(M.exerciseHistory(s, 'squat').length, 3);
    const h = M.exerciseHistory(s, 'squat', '2026-08-15', '2026-09-30');
    assert.deepEqual(h.map((x) => x.metrics.topWeight), [210]);
  });

  test('rangeSummary and weeklySummaries', () => {
    const s = M.defaultState();
    withSession(s, '2026-09-29', [strength('bench', [[100, 10], [100, 10]]), { id: 'c', exerciseId: 'bike', kind: 'cardio', target: {}, cardio: { minutes: 20, distance: 5, done: true } }]);
    withSession(s, MON, [{ id: 'v', exerciseId: 'vacuum-standing', kind: 'vacuum', target: {}, sets: [{ holdSec: 30, done: true }] }]);
    withSession(s, '2026-10-06', [strength('bench', [[100, 10, false]])]); // not done
    const sum = M.rangeSummary(s, '2026-09-28', '2026-10-11');
    assert.equal(sum.workouts, 2);
    assert.equal(sum.volume, 2000);
    assert.equal(sum.cardioMin, 20);
    assert.equal(sum.vacuumSec, 30);
    const weeks = M.weeklySummaries(s, '2026-09-28', '2026-10-11', 1);
    assert.deepEqual(weeks.map((w) => [w.week, w.workouts]), [['2026-09-28', 1], [MON, 1]]);
  });

  test('dayStatus', () => {
    const s = M.defaultState();
    assert.equal(M.dayStatus(s, MON), 'planned');
    assert.equal(M.dayStatus(s, '2026-10-11'), 'rest'); // Sunday is rest in the default plan
    withSession(s, MON, [strength('bench', [[100, 10], [100, 10, false]])]);
    assert.equal(M.dayStatus(s, MON), 'partial');
    s.sessions[MON].entries[0].sets[1].done = true;
    assert.equal(M.dayStatus(s, MON), 'done');
  });
});

describe('merge (sync)', () => {
  test('newest record wins per session, other records are unioned', () => {
    const base = M.defaultState(1);
    const a = structuredClone(base);
    const b = structuredClone(base);
    withSession(a, '2026-10-01', [strength('bench', [[100, 5]])], { updatedAt: 10 });
    withSession(b, '2026-10-01', [strength('bench', [[105, 5]])], { updatedAt: 20 });
    withSession(b, '2026-10-02', [strength('squat', [[200, 5]])], { updatedAt: 5 });
    a.settings = { ...a.settings, unit: 'kg', updatedAt: 30 };
    const m = M.mergeStates(a, b);
    assert.equal(m.sessions['2026-10-01'].entries[0].sets[0].weight, 105);
    assert.ok(m.sessions['2026-10-02']);
    assert.equal(m.settings.unit, 'kg');
  });

  test('merge is commutative and idempotent', () => {
    const a = M.defaultState(1);
    const b = M.defaultState(1);
    withSession(a, '2026-10-01', [strength('bench', [[100, 5]])], { updatedAt: 7 });
    withSession(b, '2026-10-01', [strength('bench', [[110, 5]])], { updatedAt: 7 }); // same timestamp
    b.plan[1] = { ...b.plan[1], name: 'Chest day', updatedAt: 9 };
    const ab = M.mergeStates(a, b);
    const ba = M.mergeStates(b, a);
    assert.ok(M.statesEqual(ab, ba));
    assert.ok(M.statesEqual(M.mergeStates(ab, ab), ab));
    assert.equal(ab.plan[1].name, 'Chest day');
  });

  test('a brand-new device never overwrites real data', () => {
    const server = M.defaultState(1);
    server.settings = { ...server.settings, unit: 'kg', updatedAt: 500 };
    server.plan[1] = { ...server.plan[1], name: 'My push', updatedAt: 500 };
    const freshDevice = M.normalizeState(null); // what a new browser starts with
    const m = M.mergeStates(freshDevice, server);
    assert.equal(m.settings.unit, 'kg');
    assert.equal(m.plan[1].name, 'My push');
  });

  test('deletions propagate as tombstones', () => {
    const a = M.defaultState(1);
    withSession(a, MON, [strength('bench', [[100, 5]])], { updatedAt: 5 });
    const b = structuredClone(a);
    b.sessions[MON] = { date: MON, deleted: true, updatedAt: 6 };
    const m = M.mergeStates(a, b);
    assert.equal(M.getSession(m, MON), null);
  });
});

describe('normalizeState', () => {
  test('repairs garbage input', () => {
    const s = M.normalizeState({ settings: { unit: 'stones', weekStart: 5 }, sessions: { nope: {}, '2026-10-01': { entries: [{ exerciseId: 'bench', sets: [{ weight: '100', reps: -3, done: 1 }] }, 'junk'] } } });
    assert.equal(s.settings.unit, 'lb');
    assert.equal(s.settings.weekStart, 1);
    assert.equal(s.sessions.nope, undefined);
    const set = s.sessions['2026-10-01'].entries[0].sets[0];
    assert.deepEqual([set.weight, set.reps, set.done], [100, 0, true]);
    assert.equal(Object.keys(s.plan).length, 7);
  });

  test('round-trips a valid state unchanged', () => {
    const s = M.defaultState(1);
    withSession(s, MON, [strength('bench', [[100, 5]])], { updatedAt: 5 });
    const n = M.normalizeState(JSON.parse(JSON.stringify(s)));
    assert.ok(M.statesEqual(M.normalizeState(n), n));
    assert.equal(n.sessions[MON].entries[0].sets[0].weight, 100);
  });

  test('handles null / non-objects', () => {
    assert.equal(Object.keys(M.normalizeState(null).exercises).length > 0, true);
    assert.equal(Object.keys(M.normalizeState('x').plan).length, 7);
  });
});

describe('plan helpers and export', () => {
  test('saveSessionAsPlan copies targets into the weekday plan', () => {
    const s = M.defaultState();
    const sess = M.ensureSession(s, MON);
    sess.name = 'Heavy push';
    sess.entries[0].target = { sets: 5, reps: 5, weight: 225 };
    M.saveSessionAsPlan(s, MON);
    assert.equal(s.plan[1].name, 'Heavy push');
    assert.deepEqual({ sets: s.plan[1].items[0].sets, reps: s.plan[1].items[0].reps, weight: s.plan[1].items[0].weight }, { sets: 5, reps: 5, weight: 225 });
  });

  test('copyPlanDay gives new item ids', () => {
    const s = M.defaultState();
    M.copyPlanDay(s, 1, 0);
    assert.equal(s.plan[0].name, 'Push');
    assert.notEqual(s.plan[0].items[0].id, s.plan[1].items[0].id);
  });

  test('toCSV has one row per set and escapes names', () => {
    const s = M.defaultState();
    s.exercises.bench.name = 'Bench, "flat"';
    withSession(s, MON, [strength('bench', [[100, 5], [100, 5, false]])]);
    const lines = M.toCSV(s).trim().split('\n');
    assert.equal(lines.length, 3);
    assert.ok(lines[1].includes('"Bench, ""flat"""'));
  });
});
