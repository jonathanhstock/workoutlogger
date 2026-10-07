import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../public/js/model.js';
import { VIDEOS, WORKOUT_VIDEOS, EXERCISES, youtubeId } from '../public/js/program.js';

const D1 = '2026-10-05'; // set as rotation Day 1 in these tests (a Monday)

// A default logbook whose rotation starts (Day 1) on D1.
function fresh() {
  const s = M.defaultState();
  s.settings.cycleStart = D1;
  return s;
}

// Stores a training session with the given entries on a date and returns it.
function withSession(state, date, entries, extra = {}) {
  state.sessions[date] = { date, name: 'Test', dayType: 'training', note: '', notes: '', entries, updatedAt: 1, ...extra };
  return state.sessions[date];
}

/** Builds a strength entry from sets given as [weight, reps, done = true, type?]. */
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

  test('Sunday Oct 4, 2026 is Day 3 (Day 1 was Oct 2)', () => {
    const s = M.defaultState();
    assert.equal(M.planIndex(s, '2026-10-02'), 0);
    assert.equal(M.planIndex(s, '2026-10-04'), 2); // Shoulders, Rear Delts & Traps
    assert.equal(M.planIndex(s, '2026-10-06'), 4); // Legs, after the first rest day
  });

  test('an untouched rotation start follows the program; an edited one is kept', () => {
    // A server first started with older code saved its own start date.
    const old = { ...M.normalizeState(null), settings: { ...M.defaultSettings(0), cycleStart: '2026-10-05' } };
    assert.equal(M.normalizeState(old).settings.cycleStart, '2026-10-02');
    const edited = { ...old, settings: { ...old.settings, updatedAt: 123 } };
    assert.equal(M.normalizeState(edited).settings.cycleStart, '2026-10-05');
  });

  test('every plan item references a real exercise', () => {
    const s = fresh();
    for (const i of M.planOrder(s)) for (const it of s.plan[i].items) assert.ok(s.exercises[it.exerciseId], it.exerciseId);
  });

  test('vacuums every day, fasted cardio ~4-5x and core ~2-3x per week', () => {
    const s = fresh();
    const days = M.planOrder(s).map((i) => s.plan[i].items.map((it) => it.exerciseId));
    assert.ok(days.every((d) => d.includes('vacuum')));
    // How many times a week an exercise is planned, on average over the rotation.
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

describe('cardio options and supersets', () => {
  test('cardio defaults: incline walk 12 / 3 mph; machines use a level', () => {
    const s = fresh();
    const walk = M.makeEntry(s, 'incline-walk', { minutes: 30 });
    assert.deepEqual([walk.cardio.incline, walk.cardio.speed], [12, 3]);
    assert.deepEqual(M.cardioFields(s, 'incline-walk'), ['speed', 'incline']);
    const stairs = M.makeEntry(s, 'stairmaster');
    assert.equal(stairs.cardio.level, 8);
    assert.deepEqual(M.cardioFields(s, 'stairmaster'), ['level']);
    assert.deepEqual(M.cardioFields(s, 'outdoor-walk'), []);
    const fasted = s.plan[0].items.find((it) => it.exerciseId === 'incline-walk');
    assert.deepEqual([fasted.incline, fasted.speed], [12, 3]);
  });

  test('HIIT treadmill and elliptical log intervals', () => {
    const s = fresh();
    const tread = M.makeEntry(s, 'hiit-treadmill');
    assert.deepEqual([tread.cardio.rounds, tread.cardio.incline, tread.cardio.minutes], [6, 7, 25]);
    assert.deepEqual(M.cardioFields(s, 'hiit-treadmill'), ['rounds', 'speed', 'incline']);
    const ell = M.makeEntry(s, 'hiit-elliptical');
    assert.deepEqual([ell.cardio.rounds, ell.cardio.level], [6, 12]);
    ell.cardio.done = true;
    assert.equal(M.entryMetrics(ell).rounds, 6);
    // Custom cardio doesn't get an intervals field unless asked for.
    const id = M.addExercise(s, { name: 'Rower', kind: 'cardio' });
    assert.deepEqual(M.cardioFields(s, id), ['speed', 'incline', 'level']);
  });

  test('distance is estimated from speed when not entered', () => {
    const e = { kind: 'cardio', cardio: { minutes: 40, speed: 3, distance: 0, done: true } };
    assert.equal(M.entryMetrics(e).distance, 2);
    e.cardio.distance = 2.2;
    assert.equal(M.entryMetrics(e).distance, 2.2);
  });

  test('superset links point to the next exercise', () => {
    const s = fresh();
    const sess = M.sessionOrDraft(s, D1).session;
    const press = sess.entries.find((e) => e.exerciseId === 'incline-db-press');
    const fly = sess.entries.find((e) => e.exerciseId === 'incline-db-fly');
    assert.equal(M.supersetNext(sess, press.id), fly);
    assert.equal(M.supersetPrev(sess, fly.id), press);
    assert.equal(M.supersetNext(sess, fly.id), null);
  });

  test('US units by default; metric is kept when chosen', () => {
    assert.deepEqual([M.defaultState().settings.unit, M.defaultState().settings.distanceUnit], ['lb', 'mi']);
    const n = M.normalizeState({ settings: { unit: 'kg', distanceUnit: 'km', updatedAt: 5 }, exercises: {}, plan: {} });
    assert.deepEqual([n.settings.unit, n.settings.distanceUnit], ['kg', 'km']);
  });

  test('saved logbooks pick up program changes for anything not edited', () => {
    const s = fresh();
    // Simulate an older saved logbook: untouched day/exercise, one edited day.
    s.plan[0] = { ...s.plan[0], items: [{ id: 'old', exerciseId: 'incline-walk', minutes: 30 }], updatedAt: 0 };
    s.plan[1] = { ...s.plan[1], name: 'My back day', updatedAt: 99 };
    s.exercises['incline-walk'] = { id: 'incline-walk', name: 'Old name', kind: 'cardio', group: 'Cardio', updatedAt: 0 };
    s.exercises.squat = { ...s.exercises.squat, name: 'Hack squat', updatedAt: 99 };
    delete s.exercises.stairmaster;
    const n = M.normalizeState(JSON.parse(JSON.stringify(s)));
    assert.equal(n.plan[0].items.find((it) => it.exerciseId === 'incline-walk').incline, 12);
    assert.equal(n.plan[1].name, 'My back day');
    assert.equal(n.exercises['incline-walk'].name, 'Incline Treadmill Walk');
    assert.equal(n.exercises.squat.name, 'Hack squat');
    assert.ok(n.exercises.stairmaster);
  });
});

describe('exercise videos', () => {
  test('every video belongs to a real exercise and has a valid YouTube id', () => {
    const ids = new Set(EXERCISES.map((e) => e[0]));
    for (const [exercise, list] of Object.entries(VIDEOS)) {
      assert.ok(ids.has(exercise), `unknown exercise ${exercise}`);
      for (const [title, url] of list) assert.match(youtubeId(url) || '', /^[\w-]{11}$/, `${exercise}: ${title}`);
    }
    for (const [title, url] of WORKOUT_VIDEOS) assert.ok(youtubeId(url), title);
  });

  test('youtubeId handles youtu.be and watch links', () => {
    assert.equal(youtubeId('https://youtu.be/1uDiW5--rAE'), '1uDiW5--rAE');
    assert.equal(youtubeId('https://www.youtube.com/watch?v=HG3cwzZ1lyo'), 'HG3cwzZ1lyo');
    assert.equal(youtubeId('https://example.com'), null);
  });

  test('new exercises from the video list are in the library', () => {
    const s = fresh();
    for (const id of ['hang-clean', 'barbell-snatch', 'incline-barbell-bench', 'flat-barbell-bench', 'inner-chest-press', 'supinated-db-row', 'concentration-curl', 'reverse-curl', 'lying-leg-curl', 'pull-through', 'frog-pump', 'banded-side-walk', 'abductor']) {
      assert.ok(s.exercises[id], id);
    }
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

describe('HIIT interval timer', () => {
  const cfg = { warmMin: 1, workSec: 45, easySec: 90, rounds: 2, coolMin: 1 };

  test('phases: warm-up, hard/easy per round, cool-down', () => {
    const phases = M.hiitPhases(cfg);
    assert.deepEqual(phases.map((p) => p.label), ['Warm-up', 'Hard 1/2', 'Easy 1/2', 'Hard 2/2', 'Easy 2/2', 'Cool-down']);
    assert.equal(M.hiitTotalSec(phases), 60 + 2 * 135 + 60);
    assert.deepEqual(M.hiitPhases({ ...cfg, warmMin: 0, coolMin: 0 }).map((p) => p.kind), ['hard', 'easy', 'hard', 'easy']);
  });

  test('position tracks the current phase and completed rounds', () => {
    const phases = M.hiitPhases(cfg);
    assert.deepEqual(M.hiitPosition(phases, 30000), { index: 0, remaining: 30, rounds: 0, done: false });
    const hard = M.hiitPosition(phases, 70000);
    assert.equal(phases[hard.index].label, 'Hard 1/2');
    assert.equal(hard.rounds, 0);
    const easy = M.hiitPosition(phases, 110000);
    assert.equal(phases[easy.index].label, 'Easy 1/2');
    assert.equal(easy.rounds, 1);
    assert.equal(M.hiitPosition(phases, 391000).done, true);
    assert.equal(M.hiitPosition(phases, 391000).rounds, 2);
  });

  test('config comes from the entry target with defaults', () => {
    const s = M.defaultState();
    const e = M.makeEntry(s, 'hiit-treadmill');
    assert.deepEqual(M.hiitConfig(e), { warmMin: 4, workSec: 45, easySec: 90, rounds: 6, coolMin: 4 });
    // Rounds set on the card today win over the plan.
    e.cardio.rounds = 8;
    assert.equal(M.hiitConfig(e).rounds, 8);
  });
});

describe('bug fixes and speed-ups', () => {
  test('statesEqual ignores key order', () => {
    assert.ok(M.statesEqual({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 }));
    assert.ok(!M.statesEqual({ a: 1 }, { a: 1, b: undefined }));
    assert.ok(!M.statesEqual([1, 2], { 0: 1, 1: 2 }));
    // A merge with itself never looks like a change.
    const s = fresh();
    withSession(s, D1, [strength('row', [[95, 12, true, 'warmup'], [185, 8]])]);
    assert.ok(M.statesEqual(M.mergeStates(s, s), M.normalizeState(s)));
  });

  test('erase all data still follows program updates and wins over other devices', () => {
    const s = fresh();
    s.plan[0] = { ...s.plan[0], name: 'My push day', updatedAt: 500 };
    withSession(s, D1, [strength('row', [[100, 10]])]);
    M.setBodyWeight(s, D1, 180);
    M.eraseAll(s, 1000);
    const n = M.normalizeState(JSON.parse(JSON.stringify(s)));
    assert.equal(n.sessions[D1].deleted, true);
    assert.equal(M.bodyWeightOn(n, D1), 0);
    // The plan day is the program's again, stamped so it beats older edits...
    assert.notEqual(n.plan[0].name, 'My push day');
    assert.equal(n.plan[0].updatedAt, 1000);
    const other = fresh();
    other.plan[0] = { ...other.plan[0], name: 'My push day', updatedAt: 500 };
    assert.notEqual(M.mergeStates(n, other).plan[0].name, 'My push day');
    // ...yet still counts as unedited, so program.js changes reach it.
    n.plan[0].items = [];
    assert.ok(M.normalizeState(n).plan[0].items.length > 0);
    // Editing it afterwards makes it the user's own.
    n.plan[0].name = 'Mine now';
    n.plan[0].updatedAt = 2000;
    assert.equal(M.normalizeState(n).plan[0].name, 'Mine now');
  });

  test('record ids are kept to safe characters', () => {
    const s = fresh();
    withSession(s, D1, [{ ...strength('row', [[100, 10]]), id: '"><img src=x onerror=alert(1)>' }]);
    const id = M.normalizeState(s).sessions[D1].entries[0].id;
    assert.match(id, /^[\w-]+$/);
  });

  test('CSV export defuses formulas and has a unit column', () => {
    const s = fresh();
    s.exercises.row.name = '=HYPERLINK("x")';
    withSession(s, D1, [strength('row', [[185, 8]])]);
    const lines = M.toCSV(s).trim().split('\n');
    assert.ok(lines[0].endsWith(',unit'));
    assert.ok(lines[1].includes(`"'=HYPERLINK(""x"")"`));
    assert.equal(lines[0].split(',').length, lines[1].replace(/"[^"]*"/g, 'q').split(',').length);
    assert.ok(lines[1].endsWith(',lb'));
  });

  test('range totals and weigh-ins are the same for short and long ranges', () => {
    const s = fresh();
    for (let i = 0; i < 60; i++) {
      const d = M.addDays(D1, -i);
      withSession(s, d, [strength('row', [[100 + i, 10]])]);
      if (i % 2) M.setBodyWeight(s, d, 200 - i);
    }
    s.sessions[M.addDays(D1, -3)] = { date: M.addDays(D1, -3), deleted: true, updatedAt: 5 };
    const week = M.rangeSummary(s, M.addDays(D1, -6), D1);
    assert.equal(week.workouts, 6);
    const all = M.rangeSummary(s, '2000-01-01', '2100-01-01');
    assert.equal(all.workouts, 59);
    assert.equal(M.weeklySummaries(s, M.addDays(D1, -59), D1).reduce((a, w) => a + w.workouts, 0), 59);
    assert.deepEqual(M.previousBodyWeight(s, D1), { date: M.addDays(D1, -1), weight: 199 });
    assert.equal(M.bodyWeightAverage(s, D1, 7), M.round((199 + 197 + 195) / 3, 1));
    assert.equal(M.bodyWeights(s, M.addDays(D1, -6), D1).length, 3);
  });
});

describe('Fitbit import', () => {
  test('adds health days, clears what Google no longer has, and stays quiet when unchanged', () => {
    const s = fresh();
    const acts = [{ name: 'Walk', start: '07:00', minutes: 30, calories: 150, avgHr: 100, distanceKm: 2.5, steps: 3000 }];
    assert.equal(M.applyHealthImport(s, { days: { [D1]: { steps: 8000, restingHr: 58, sleepMin: 420, activities: acts }, '2026-10-06': { steps: 0, activities: [] } } }, 100), 1);
    assert.equal(s.health[D1].steps, 8000);
    assert.equal(s.health['2026-10-06'], undefined, 'no empty records');
    assert.equal(M.applyHealthImport(s, { days: { [D1]: { steps: 8000, restingHr: 58, sleepMin: 420, activities: acts } } }, 200), 0);
    assert.equal(s.health[D1].updatedAt, 100);
    // A partial import (sleep failed) keeps the fields it didn't fetch.
    M.applyHealthImport(s, { days: { [D1]: { steps: 9000, activities: [] } } }, 300);
    assert.deepEqual([s.health[D1].steps, s.health[D1].sleepMin, s.health[D1].activities], [9000, 420, undefined]);
    // Survives normalize and merges like any other record.
    const n = M.normalizeState(JSON.parse(JSON.stringify(s)));
    assert.equal(n.health[D1].steps, 9000);
    assert.equal(M.mergeStates(n, M.defaultState(0)).health[D1].steps, 9000);
  });

  test('weigh-ins use your unit and never replace one you typed', () => {
    const s = fresh();
    M.setBodyWeight(s, D1, 175);
    M.applyHealthImport(s, { weights: { [D1]: 80000, '2026-10-04': 80000 } });
    assert.equal(M.bodyWeightOn(s, D1), 175);
    assert.deepEqual([s.body['2026-10-04'].weight, s.body['2026-10-04'].source], [176.4, 'fitbit']);
    s.settings.unit = 'kg';
    M.applyHealthImport(s, { weights: { '2026-10-04': 80000 } });
    assert.equal(s.body['2026-10-04'].weight, 80);
    // Typing over a Fitbit weigh-in makes it yours.
    M.setBodyWeight(s, '2026-10-04', 79.5);
    M.applyHealthImport(s, { weights: { '2026-10-04': 81000 } });
    assert.equal(M.bodyWeightOn(s, '2026-10-04'), 79.5);
  });
});

describe('consistency', () => {
  // The date n days after D1 (rotation Day 1).
  const P = (n) => M.addDays(D1, n);
  // The consistency context for a logbook seen on a given day.
  const ctxFor = (s, today) => ({ today, start: M.consistencyStart(s) });
  // A cardio entry of some minutes, finished or not.
  const cardioE = (exerciseId, minutes, done = true, target = { minutes: 30 }) => ({ id: M.uid(), exerciseId, kind: 'cardio', target, notes: '', rpe: 0, cardio: { minutes, done } });
  // A stomach vacuum entry with `done` of `total` holds finished.
  const holds = (done, total = 5) => ({ id: M.uid(), exerciseId: 'vacuum', kind: 'vacuum', target: { sets: total, holdSec: 10 }, notes: '', rpe: 0, sets: Array.from({ length: total }, (_, i) => ({ id: M.uid(), holdSec: 10, done: i < done })) });
  // Removes the stomach vacuums from every plan day.
  const noVacuums = (s) => {
    for (const k of Object.keys(s.plan)) s.plan[k] = { ...s.plan[k], items: s.plan[k].items.filter((it) => it.exerciseId !== 'vacuum') };
  };
  // A plank entry (3 × 45 s) with `done` holds finished.
  const plank = (done = 1) => ({ id: M.uid(), exerciseId: 'plank', kind: 'timed', target: { sets: 3, holdSec: 45 }, notes: '', rpe: 0, sets: Array.from({ length: 3 }, (_, i) => ({ id: M.uid(), holdSec: 45, done: i < done })) });

  test('the program plans cardio 5, core 3 and vacuums 8 times per rotation', () => {
    const days = M.consistencyDays(fresh(), D1, P(7), { today: P(-1), start: null });
    assert.equal(days.length, 8);
    assert.ok(days.every((d) => d.scheduled));
    assert.deepEqual(days.map((d) => d.dayType), ['training', 'training', 'training', 'active', 'training', 'training', 'training', 'active']);
    // Indexes of the rotation days where a fact is true.
    const where = (key) => days.flatMap((d, i) => (d[key] ? [i] : []));
    assert.deepEqual(where('cardioPlanned'), [0, 2, 3, 5, 7]);
    assert.deepEqual(where('corePlanned'), [2, 3, 7]);
    assert.ok(days.every((d) => d.vacuumPlanned && d.vacuumTarget === 5));
    assert.deepEqual(M.consistencyDays(fresh(), P(1), D1, { today: D1, start: null }), []);
  });

  test('weekly goals come from the plan', () => {
    // Planned workouts, cardio, core and vacuum days in the week starting `from`.
    const planned = (s, from) => {
      const t = M.consistencyTotals(M.consistencyDays(s, from, M.addDays(from, 6), { today: D1, start: null }));
      return [t.workouts.planned, t.cardio.planned, t.core.planned, t.vacuum.planned];
    };
    assert.deepEqual(planned(M.defaultState(), D1), [7, 4, 2, 7]);
    assert.deepEqual(planned(fresh(), P(7)), [7, 5, 3, 7]);
  });

  test('warm-ups and short cardio are not a workout or a cardio session', () => {
    const s = fresh();
    // Today's (D1's) consistency facts.
    const day = () => M.dayConsistency(s, D1, ctxFor(s, D1));
    withSession(s, D1, [cardioE('bike', 5, true, { minutes: 5 })]);
    assert.deepEqual([day().cardio, day().status], [false, 'pending']);
    withSession(s, D1, [cardioE('incline-walk', 19)]);
    assert.equal(day().cardio, false);
    withSession(s, D1, [cardioE('incline-walk', 20)]);
    assert.deepEqual([day().cardio, day().cardioMin, day().status], [true, 20, 'done']);
    withSession(s, D1, [cardioE('incline-walk', 30, false)]);
    assert.equal(day().cardio, false);
    withSession(s, D1, [cardioE('bike', 10, true, { minutes: 5 }), cardioE('incline-walk', 15)]);
    assert.equal(day().cardio, false, 'minutes are not added up across entries');
    withSession(s, D1, [strength('row', [[50, 12, true, 'warmup'], [100, 8, false]])]);
    assert.equal(day().status, 'pending');
  });

  test('a finished interval session counts as cardio and as a workout, even under 20 minutes', () => {
    const s = fresh();
    // A HIIT treadmill entry as the interval timer logs it: rounds and the timer's real minutes.
    const hiit = (rounds, minutes, done = true, target = { minutes: 30, rounds: 6 }) => ({ ...cardioE('hiit-treadmill', minutes, done, target), cardio: { minutes, rounds, done } });
    for (let i = 0; i <= 2; i++) withSession(s, P(i), [strength('row', [[100, 8]])]);
    // Day 4 (active rest): the incline walk swapped for HIIT, 4 rounds in 17 minutes.
    withSession(s, P(3), [hiit(4, 17), holds(5)], { dayType: 'active' });
    withSession(s, P(4), [strength('row', [[100, 8]])]);
    const ctx = ctxFor(s, P(5));
    // The consistency facts for Day 4.
    const day4 = () => M.dayConsistency(s, P(3), ctx);
    assert.deepEqual([day4().status, day4().cardio, day4().cardioMin, day4().cardioPlanned], ['done', true, 17, true]);
    assert.equal(M.currentStreaks(s, ctx).workout.count, 5);
    assert.equal(M.bestStreaks(s, ctx).workout, 5);
    // A short interval plan is planned cardio too.
    withSession(s, P(3), [hiit(5, 19, true, { minutes: 15, rounds: 5 })], { dayType: 'active' });
    assert.deepEqual([day4().cardio, day4().cardioPlanned], [true, true]);
    // Unfinished, or a short entry without rounds (the warm-up bike), still doesn't count.
    withSession(s, P(3), [hiit(4, 17, false)], { dayType: 'active' });
    assert.deepEqual([day4().status, day4().cardio], ['missed', false]);
    withSession(s, P(3), [cardioE('bike', 10, true, { minutes: 5 })], { dayType: 'active' });
    assert.deepEqual([day4().status, day4().cardio, day4().cardioPlanned], ['missed', false, false]);
    assert.equal(M.currentStreaks(s, ctx).workout.count, 1);
  });

  test('a core session needs three different core exercises', () => {
    const s = fresh();
    // Today's (D1's) consistency facts.
    const day = () => M.dayConsistency(s, D1, ctxFor(s, D1));
    // A finished hanging leg raise entry.
    const legRaise = () => strength('hanging-leg-raise', [[0, 15]]);
    withSession(s, D1, [plank(), legRaise(), holds(5)]);
    assert.deepEqual([day().coreCount, day().core], [2, false]);
    withSession(s, D1, [plank(), legRaise(), strength('russian-twist', [[0, 15]])]);
    assert.deepEqual([day().coreCount, day().core], [3, true]);
    withSession(s, D1, [plank(), legRaise(), legRaise()]);
    assert.deepEqual([day().coreCount, day().core], [2, false]);
    s.exercises['push-up'].group = ' core ';
    withSession(s, D1, [plank(), legRaise(), strength('push-up', [[0, 15]])]);
    assert.equal(day().core, true);

    const f = fresh();
    assert.deepEqual([M.isCoreExercise(f, 'plank'), M.isCoreExercise(f, 'vacuum'), M.isCoreExercise(f, 'push-up')], [true, false, false]);
    f.exercises.plank.deleted = true;
    assert.equal(M.isCoreExercise(f, 'plank'), true);
  });

  test("vacuums count once the day's target holds are done", () => {
    const s = fresh();
    withSession(s, P(-1), [holds(4)]);
    withSession(s, D1, [holds(5)]);
    const ctx = ctxFor(s, P(1));
    // The vacuum status of a date.
    const vac = (d, c = ctx) => M.dayConsistency(s, d, c).vacuum;
    assert.equal(vac(P(-1)), 'partial');
    assert.equal(vac(D1), 'done');
    withSession(s, D1, [holds(5, 6)]);
    assert.equal(vac(D1), 'partial');
    const extra = holds(5);
    extra.sets.push({ id: M.uid(), holdSec: 10, done: false });
    withSession(s, D1, [extra]);
    assert.equal(vac(D1), 'done');
    assert.equal(vac(P(1)), 'pending');
    assert.equal(vac(P(1), { ...ctx, today: P(2) }), 'missed');
  });

  test('day statuses: before, missed, rest, pending, future', () => {
    const s = fresh();
    withSession(s, P(-3), [strength('row', [[100, 8]])]);
    s.sessions[P(-1)] = { date: P(-1), deleted: true, updatedAt: 3 };
    withSession(s, P(-5), []);
    const ctx = ctxFor(s, D1);
    assert.equal(ctx.start, P(-3));
    // The workout status of a date.
    const status = (d) => M.dayConsistency(s, d, ctx).status;
    assert.equal(status(P(-4)), 'before');
    assert.equal(status(P(-2)), 'missed');
    assert.equal(status(P(-1)), 'missed', 'a reset day falls back to the plan');
    withSession(s, P(-2), [], { dayType: 'rest' });
    assert.equal(status(P(-2)), 'rest');
    assert.equal(status(D1), 'pending');
    assert.equal(status(P(1)), 'future');
    const active = M.dayConsistency(s, P(3), { today: P(4), start: P(-3) });
    assert.deepEqual([active.status, active.dayType], ['missed', 'active']);
  });

  test('vacuums are tracked apart from the workout', () => {
    const s = fresh();
    withSession(s, P(-1), [strength('row', [[100, 8], [100, 8]]), holds(0)]);
    let d = M.dayConsistency(s, P(-1), ctxFor(s, D1));
    assert.deepEqual([d.status, d.vacuum], ['done', 'missed']);
    const t = fresh();
    withSession(t, D1, [strength('flat-press', [[100, 10, false]]), holds(5)]);
    d = M.dayConsistency(t, D1, ctxFor(t, P(1)));
    assert.deepEqual([d.status, d.vacuum], ['missed', 'done']);
    withSession(t, D1, [holds(5)]);
    d = M.dayConsistency(t, D1, ctxFor(t, P(1)));
    assert.deepEqual([d.status, d.scheduled, d.vacuum], ['rest', false, 'done']);

    // A Rest day excuses the workout but not its vacuums: first as the Log's Rest button stores it, then as a Rest plan day.
    const r = fresh();
    withSession(r, P(-3), [strength('row', [[100, 8]])]);
    withSession(r, P(-2), [holds(0)], { dayType: 'rest' });
    d = M.dayConsistency(r, P(-2), ctxFor(r, D1));
    assert.deepEqual([d.status, d.scheduled, d.vacuumPlanned, d.vacuum], ['rest', false, true, 'missed']);
    const i = M.planIndex(r, P(-1));
    r.plan[i] = { ...r.plan[i], dayType: 'rest', updatedAt: 9 };
    d = M.dayConsistency(r, P(-1), ctxFor(r, D1));
    assert.deepEqual([d.status, d.scheduled, d.vacuumPlanned, d.vacuum], ['rest', false, true, 'missed']);
    withSession(r, P(-1), [holds(5)], { dayType: 'rest' });
    withSession(r, P(-2), [holds(5)], { dayType: 'rest' });
    withSession(r, P(-3), [strength('row', [[100, 8]]), holds(5)]);
    assert.equal(M.currentStreaks(r, ctxFor(r, D1)).vacuum.count, 3);
    withSession(r, P(-2), [holds(0)], { dayType: 'rest' });
    assert.equal(M.currentStreaks(r, ctxFor(r, D1)).vacuum.count, 1, 'skipped vacuums on a Rest day break the streak');
  });

  test('workouts on unscheduled days are extra and never fill the planned count', () => {
    const s = fresh();
    withSession(s, P(-4), [strength('row', [[100, 8]])]);
    // P(-3) is a planned day with nothing logged.
    withSession(s, P(-2), [strength('row', [[100, 8]])], { dayType: 'rest' });
    withSession(s, P(-1), [strength('row', [[100, 8]])]);
    const t = M.consistencyTotals(M.consistencyDays(s, P(-4), P(-1), ctxFor(s, D1)));
    assert.deepEqual([t.workouts, t.missed], [{ done: 2, planned: 3, extra: 1 }, 1]);
    assert.equal(t.workouts.done + t.missed, t.workouts.planned);
  });

  test("skipped optional exercises don't block done; started ones must be finished", () => {
    const s = fresh();
    withSession(s, P(-1), [strength('dips', [[0, 15], [0, 15, false]]), strength('incline-db-fly', [[30, 10, false]], { sets: 1, reps: 10, optional: true })]);
    // The workout status of P(-1).
    const status = () => M.dayConsistency(s, P(-1), ctxFor(s, D1)).status;
    assert.equal(status(), 'partial');
    s.sessions[P(-1)].entries[0].sets[1].done = true;
    assert.equal(status(), 'done');
    s.sessions[P(-1)].entries.push(strength('rack-pull', [[200, 5], [200, 5, false]], { sets: 2, reps: 5, optional: true }));
    assert.equal(status(), 'partial');
  });

  test('extra work on a rest day counts but is not scheduled', () => {
    const s = fresh();
    withSession(s, P(-1), [strength('row', [[100, 8]])], { dayType: 'rest' });
    const d = M.dayConsistency(s, P(-1), ctxFor(s, D1));
    assert.deepEqual([d.status, d.scheduled], ['done', false]);
  });

  test('workout streak skips rest days and today, and breaks on a miss', () => {
    const s = fresh();
    for (let i = -6; i <= -1; i++) withSession(s, P(i), [strength('row', [[100, 8]])]);
    withSession(s, P(-3), [], { dayType: 'rest' });
    assert.deepEqual(M.currentStreaks(s, ctxFor(s, D1)).workout, { count: 5, since: P(-6), pendingToday: true, doneToday: false });
    withSession(s, D1, [strength('row', [[100, 8]])]);
    let w = M.currentStreaks(s, ctxFor(s, D1)).workout;
    assert.deepEqual([w.count, w.doneToday, w.pendingToday], [6, true, false]);
    s.sessions[P(-2)] = { date: P(-2), deleted: true, updatedAt: 9 };
    w = M.currentStreaks(s, ctxFor(s, D1)).workout;
    assert.equal(w.count, 2);
    assert.equal(M.bestStreaks(s, ctxFor(s, D1)).workout, 3);
  });

  test('vacuum streak counts calendar days and today never breaks it', () => {
    const s = fresh();
    for (let i = -4; i <= -1; i++) withSession(s, P(i), [holds(5)]);
    let v = M.currentStreaks(s, ctxFor(s, D1)).vacuum;
    assert.deepEqual([v.count, v.pendingToday, v.doneToday], [4, true, false]);
    withSession(s, D1, [holds(3)]);
    v = M.currentStreaks(s, ctxFor(s, D1)).vacuum;
    assert.deepEqual([v.count, v.pendingToday], [4, true]);
    withSession(s, D1, [holds(5)]);
    v = M.currentStreaks(s, ctxFor(s, D1)).vacuum;
    assert.deepEqual([v.count, v.doneToday], [5, true]);
    withSession(s, P(-2), [holds(4)]);
    const st = M.currentStreaks(s, ctxFor(s, D1));
    assert.equal(st.vacuum.count, 2);
    assert.deepEqual(M.bestStreaks(s, ctxFor(s, D1)), { workout: 0, vacuum: 2 });
    assert.equal(st.workout.count, 0, 'vacuum-only days are rest days, not workouts');
  });

  test('two weeks in a row with nothing planned or done end a streak', () => {
    assert.equal(M.STREAK_GAP_DAYS, 14);
    const s = fresh();
    // A finished row session.
    const lift = () => [strength('row', [[100, 8]])];
    withSession(s, P(-20), lift());
    for (let i = -19; i <= -6; i++) withSession(s, P(i), [], { dayType: 'rest' });
    for (let i = -5; i <= -1; i++) withSession(s, P(i), lift());
    assert.equal(M.currentStreaks(s, ctxFor(s, D1)).workout.count, 5, '14 rest days in a row end it');
    assert.equal(M.bestStreaks(s, ctxFor(s, D1)).workout, 5);
    withSession(s, P(-19), lift());
    assert.equal(M.currentStreaks(s, ctxFor(s, D1)).workout.count, 7, '13 rest days in a row do not');
    assert.equal(M.bestStreaks(s, ctxFor(s, D1)).workout, 7);

    // Vacuums: days with none planned or done are neutral, up to the same limit.
    const v = fresh();
    noVacuums(v);
    withSession(v, P(-20), [holds(5)]);
    for (let i = -5; i <= -1; i++) withSession(v, P(i), [holds(5)]);
    assert.equal(M.currentStreaks(v, ctxFor(v, D1)).vacuum.count, 5);
    assert.equal(M.bestStreaks(v, ctxFor(v, D1)).vacuum, 5);
    withSession(v, P(-19), [holds(5)]);
    assert.equal(M.currentStreaks(v, ctxFor(v, D1)).vacuum.count, 7);
    assert.equal(M.bestStreaks(v, ctxFor(v, D1)).vacuum, 7);
  });

  test('current streaks stop walking after a rotation of neutral days', () => {
    const N = 1096; // three years
    // Three years of sessions built by `entries(i)` (null = nothing logged), with every session lookup counted.
    const logbook = (s, entries) => {
      const raw = {};
      for (let i = 1; i < N; i++) {
        const list = entries(i);
        if (list) raw[P(-i)] = { date: P(-i), name: 'X', dayType: 'training', note: '', notes: '', updatedAt: 1, entries: list };
      }
      const start = M.consistencyStart({ sessions: raw });
      const counter = { gets: 0 };
      s.sessions = new Proxy(raw, {
        // Counts every date looked up.
        get(target, key, recv) {
          counter.gets++;
          return Reflect.get(target, key, recv);
        },
      });
      return { ctx: { today: D1, start }, counter };
    };

    // Vacuums not in the plan and never logged, and a missed workout 2 days ago.
    const a = fresh();
    noVacuums(a);
    const A = logbook(a, (i) => (i === 2 ? null : [strength('row', [[100, 8]])]));
    const ca = M.currentStreaks(a, A.ctx);
    assert.deepEqual([ca.workout.count, ca.vacuum.count], [1, 0]);
    assert.ok(A.counter.gets <= M.STREAK_GAP_DAYS + 1, `looked up ${A.counter.gets} dates`);

    // A vacuum-only plan where every day is Rest, and vacuums missed 10 days ago.
    const b = fresh();
    for (const k of Object.keys(b.plan)) b.plan[k] = { name: '', dayType: 'rest', note: '', updatedAt: 5, items: [{ id: `v${k}`, exerciseId: 'vacuum', sets: 5, holdSec: 10 }] };
    const B = logbook(b, (i) => (i === 10 ? null : [holds(5)]));
    const cb = M.currentStreaks(b, B.ctx);
    assert.deepEqual([cb.workout.count, cb.vacuum.count], [0, 9]);
    assert.ok(B.counter.gets <= M.STREAK_GAP_DAYS + 1, `looked up ${B.counter.gets} dates`);
  });

  test('an empty logbook is tracked from today', () => {
    const s = fresh();
    const ctx = ctxFor(s, D1);
    assert.equal(ctx.start, null);
    const { workout, vacuum } = M.currentStreaks(s, ctx);
    assert.deepEqual([workout.count, workout.pendingToday, vacuum.count, vacuum.pendingToday], [0, true, 0, true]);
    assert.equal(M.dayConsistency(s, P(-1), ctx).status, 'before');
    assert.equal(M.dayConsistency(s, D1, ctx).status, 'pending');
    assert.deepEqual(M.bestStreaks(s, ctx), { workout: 0, vacuum: 0 });
  });

  test('the best streak survives a break', () => {
    const s = fresh();
    for (let i = -15; i <= -6; i++) withSession(s, P(i), [strength('row', [[100, 8]])]);
    for (let i = -3; i <= -1; i++) withSession(s, P(i), [strength('row', [[100, 8]])]);
    const ctx = ctxFor(s, D1);
    assert.equal(M.currentStreaks(s, ctx).workout.count, 3);
    assert.equal(M.bestStreaks(s, ctx).workout, 10);
  });

  test('weekly plan mode follows weekdays', () => {
    const s = fresh();
    s.settings.planMode = 'weekly';
    for (let i = 0; i < 7; i++) s.plan[i] = { name: '', dayType: 'rest', note: '', items: [], updatedAt: 5 };
    for (const i of [1, 3, 5]) {
      s.plan[i] = { name: 'Lift', dayType: 'training', note: '', updatedAt: 5, items: [{ id: `a${i}`, exerciseId: 'row', sets: 3, reps: 8 }, { id: `b${i}`, exerciseId: 'incline-walk', minutes: 30 }, { id: `v${i}`, exerciseId: 'vacuum', sets: 5, holdSec: 10 }] };
    }
    const t = M.consistencyTotals(M.consistencyDays(s, D1, P(6), { today: D1, start: null }));
    assert.deepEqual([t.workouts.planned, t.cardio.planned, t.core.planned, t.vacuum.planned], [3, 3, 0, 3]);
    const sunday = M.dayConsistency(s, P(6), { today: P(7), start: D1 });
    assert.deepEqual([sunday.status, sunday.vacuum], ['rest', 'none']);
  });

  test('plan edits re-colour unlogged days only', () => {
    const s = fresh();
    withSession(s, P(-8), [strength('row', [[100, 8]])]);
    const ctx = ctxFor(s, D1);
    assert.equal(M.dayConsistency(s, P(-7), ctx).status, 'missed');
    s.plan[1] = { ...s.plan[1], dayType: 'rest', updatedAt: 9 };
    assert.equal(M.dayConsistency(s, P(-7), ctx).status, 'rest');
    s.plan[0] = { ...s.plan[0], dayType: 'rest', updatedAt: 9 };
    const logged = M.dayConsistency(s, P(-8), ctx);
    assert.deepEqual([logged.status, logged.dayType], ['done', 'training']);
  });

  test('habitPip marks each habit per day', () => {
    const s = fresh();
    withSession(s, P(-3), [plank(3), strength('russian-twist', [[0, 15]])], { dayType: 'active' });
    withSession(s, P(-2), [strength('row', [[100, 8]])]);
    const ctx = ctxFor(s, D1);
    // Workout, cardio, core and vacuum pips for a date.
    const pips = (d) => ['workouts', 'cardio', 'core', 'vacuum'].map((h) => M.habitPip(M.dayConsistency(s, d, ctx), h, D1));
    assert.deepEqual(pips(P(-4)), ['none', 'none', 'none', 'none']);
    assert.deepEqual(pips(P(-3)), ['done', 'none', 'partial', 'none']);
    assert.deepEqual(pips(P(-2)), ['done', 'none', 'none', 'none']);
    assert.deepEqual(pips(P(-1)), ['missed', 'missed', 'missed', 'missed']);
    assert.deepEqual(pips(D1), ['planned', 'planned', 'none', 'planned']);
    assert.deepEqual(pips(P(2)), ['planned', 'planned', 'planned', 'planned']);
  });

  test('monthGrid covers whole weeks from the week start', () => {
    const s = fresh();
    const ctx = { today: D1, start: null };
    // Number of weeks and the first and last cell of a month's grid.
    const shape = (ym, weekStart) => {
      s.settings.weekStart = weekStart;
      const g = M.monthGrid(s, ym, ctx);
      assert.ok(g.weeks.every((w) => w.length === 7));
      return [g.weeks.length, g.weeks[0][0].date, g.weeks.at(-1)[6].date];
    };
    assert.deepEqual(shape('2026-10', 1), [5, '2026-09-28', '2026-11-01']);
    assert.deepEqual(shape('2026-10', 0), [5, '2026-09-27', '2026-10-31']);
    assert.equal(shape('2026-11', 1)[0], 6);
    assert.deepEqual(shape('2027-02', 1), [4, '2027-02-01', '2027-02-28']);
    assert.equal(shape('2027-02', 0)[0], 5);
    s.settings.weekStart = 1;
    const first = M.monthGrid(s, '2026-10', ctx).weeks[0];
    assert.deepEqual(first.map((c) => c.inMonth), [false, false, false, true, true, true, true]);
    assert.deepEqual(first[0], { date: '2026-09-28', inMonth: false });

    const t = fresh();
    for (const d of ['2026-09-30', '2026-10-01', '2026-10-02']) withSession(t, d, [strength('row', [[100, 8]])]);
    // Sep 30 is outside the month and Oct 6+ is after today, so neither counts.
    assert.deepEqual(M.monthGrid(t, '2026-10', ctxFor(t, D1)).totals, { workouts: { done: 2, planned: 5, extra: 0 }, cardio: { done: 0, planned: 2 }, core: { done: 0, planned: 1 }, vacuum: { done: 0, planned: 3 }, missed: 2 });
  });

  test('shiftMonth wraps years', () => {
    assert.equal(M.shiftMonth('2026-01', -1), '2025-12');
    assert.equal(M.shiftMonth('2026-12', 1), '2027-01');
    assert.equal(M.shiftMonth('2026-10', -13), '2025-09');
  });

  test('consistency helpers never scan the whole history', () => {
    const N = 1461; // four years of daily sessions
    const raw = {};
    for (let i = 0; i < N; i++) {
      const d = P(-i);
      const lifts = Array.from({ length: 10 }, (_, k) => strength(k % 2 ? 'row' : 'flat-press', [[100, 8], [100, 8], [100, 8]]));
      raw[d] = { date: d, name: 'X', dayType: 'training', note: '', notes: '', updatedAt: 1, entries: [...lifts, cardioE('incline-walk', 30), holds(5)] };
    }
    const s = fresh();
    let scans = 0;
    s.sessions = new Proxy(raw, {
      // Counts every enumeration of the sessions map.
      ownKeys(target) {
        scans++;
        return Reflect.ownKeys(target);
      },
    });
    const t0 = performance.now();
    const start = M.consistencyStart(s);
    assert.equal(scans, 1);
    assert.equal(start, P(-(N - 1)));
    const ctx = { today: D1, start };
    const cur = M.currentStreaks(s, ctx);
    assert.deepEqual([cur.workout.count, cur.vacuum.count], [N, N]);
    assert.deepEqual(M.bestStreaks(s, ctx), { workout: N, vacuum: N });
    const grid = M.monthGrid(s, '2026-10', ctx);
    const ws = M.startOfWeek(D1, 1);
    assert.equal(M.consistencyDays(s, ws, M.addDays(ws, 6), ctx).length, 7);
    const ms = performance.now() - t0;
    assert.equal(scans, 1, 'only consistencyStart enumerates the sessions');

    // The month grid only depends on the days it shows.
    const small = fresh();
    for (let d = '2026-09-28'; d <= '2026-11-01'; d = M.addDays(d, 1)) if (raw[d]) small.sessions[d] = raw[d];
    assert.deepEqual(M.monthGrid(small, '2026-10', ctx), grid);
    assert.ok(ms < 500, `took ${ms.toFixed(0)} ms`);
  });
});

describe('rest times by lift type', () => {
  test('compound lifts rest 90–120 s (max 180), isolation 60–75 s (max 120)', () => {
    const s = fresh();
    assert.equal(M.restClass(s, 'flat-barbell-bench'), 'compound');
    assert.equal(M.restClass(s, 'squat'), 'compound');
    assert.equal(M.restClass(s, 'rack-pull'), 'compound');
    assert.equal(M.restClass(s, 'alt-curl'), 'isolation');
    assert.equal(M.restClass(s, 'leg-extension'), 'isolation');
    assert.equal(M.restClass(s, 'lateral-raise'), 'isolation');
    assert.equal(M.restClass(s, 'plank'), null);
    assert.equal(M.restClass(s, 'incline-walk'), null);
    assert.equal(M.restFor(s, { exerciseId: 'squat', target: {} }), 120);
    assert.equal(M.restFor(s, { exerciseId: 'alt-curl', target: {} }), 75);
    assert.equal(M.restFor(s, { exerciseId: 'plank', target: {} }), 90);
    // An exercise's own rest wins, but never past its type's maximum.
    assert.equal(M.restFor(s, { exerciseId: 'rack-pull', target: { restSec: 150 } }), 150);
    assert.equal(M.restFor(s, { exerciseId: 'rack-pull', target: { restSec: 300 } }), 180);
    assert.equal(M.restFor(s, { exerciseId: 'alt-curl', target: { restSec: 200 } }), 120);
    assert.equal(M.restMax(s, 'squat'), 180);
    assert.equal(M.restMax(s, 'alt-curl'), 120);
    // The defaults come from Settings, clamped to the maximum on load.
    s.settings.restCompound = 90;
    assert.equal(M.restFor(s, { exerciseId: 'squat', target: {} }), 90);
    const n = M.normalizeState({ ...s, settings: { ...s.settings, restCompound: 400, restIsolation: 500 } });
    assert.deepEqual([n.settings.restCompound, n.settings.restIsolation], [180, 120]);
    assert.deepEqual([M.defaultState(0).settings.restCompound, M.defaultState(0).settings.restIsolation], [120, 75]);
  });

  test('the program no longer gives lateral raises a 45 s rest', () => {
    const s = fresh();
    const it = Object.values(s.plan).flatMap((d) => d.items).find((x) => x.exerciseId === 'lateral-raise');
    assert.equal(it.restSec, undefined);
  });

  test('the set before the partials-to-failure set has no rest', () => {
    const s = fresh();
    const legs = Object.keys(s.plan).find((k) => s.plan[k].items.some((x) => x.exerciseId === 'leg-curl'));
    const date = M.addDays(D1, Number(legs));
    const e = M.sessionOrDraft(s, date).session.entries.find((x) => x.exerciseId === 'leg-curl');
    const work = e.sets.filter((x) => !x.type);
    assert.equal(e.sets[e.sets.length - 1].type, 'failure');
    for (const x of work.slice(0, -1)) M.markSet(x, true);
    assert.equal(M.nextIsFailureSet(e), false);
    M.markSet(work[work.length - 1], true);
    assert.equal(M.nextIsFailureSet(e), true);
    M.markSet(e.sets[e.sets.length - 1], true);
    assert.equal(M.nextIsFailureSet(e), false);
  });
});
