// The starting exercise library and training plan.
// Everything here can be changed in the app (Plan tab and Settings);
// this only decides what a brand-new logbook starts with.

// [id, name, kind, group]
export const EXERCISES = [
  // Cardio
  ['incline-walk', 'Incline Treadmill Walk', 'cardio', 'Cardio'],
  ['bike', 'Stationary Bike', 'cardio', 'Cardio'],
  ['treadmill', 'Treadmill', 'cardio', 'Cardio'],

  // Stomach vacuum
  ['vacuum', 'Stomach Vacuum', 'vacuum', 'Core'],

  // Core
  ['hanging-leg-raise', 'Hanging Leg Raise', 'strength', 'Core'],
  ['russian-twist', 'Russian Twist', 'strength', 'Core'],
  ['decline-crunch', 'Decline Bench Crunch', 'strength', 'Core'],
  ['machine-crunch', 'Machine Crunch', 'strength', 'Core'],
  ['cable-crunch', 'Cable Crunch', 'strength', 'Core'],
  ['flutter-kick', 'Lying Flutter Kicks', 'strength', 'Core'],
  ['plank', 'Plank', 'timed', 'Core'],
  ['sit-up', 'Full Sit-up', 'strength', 'Core'],
  ['lying-leg-raise', 'Lying Leg Raise', 'strength', 'Core'],
  ['oblique-crunch', 'Oblique Crunch', 'strength', 'Core'],
  ['bicycle-kick', 'Bicycle Kicks', 'strength', 'Core'],

  // Chest
  ['push-up', 'Push-up', 'strength', 'Chest'],
  ['incline-machine-press', 'Incline Machine Press (Hammer Strength)', 'strength', 'Chest'],
  ['incline-db-press', 'Incline Dumbbell Press', 'strength', 'Chest'],
  ['incline-db-fly', 'Incline Dumbbell Fly', 'strength', 'Chest'],
  ['flat-press', 'Flat / Decline Chest Press', 'strength', 'Chest'],
  ['cable-crossover', 'Cable Crossover / Pec Deck', 'strength', 'Chest'],
  ['dips', 'Dips', 'strength', 'Chest'],

  // Triceps
  ['triceps-pushdown', 'Triceps Pushdown (bar or rope)', 'strength', 'Triceps'],
  ['skull-crusher', 'Skull Crusher (EZ / DB)', 'strength', 'Triceps'],
  ['close-grip-bench', 'Close-Grip EZ Bar Bench Press', 'strength', 'Triceps'],

  // Back
  ['pull-up', 'Pull-up', 'strength', 'Back'],
  ['pull-up-wide', 'Wide-Grip Pull-up', 'strength', 'Back'],
  ['lat-pulldown-wide', 'Lat Pulldown (wide grip)', 'strength', 'Back'],
  ['lat-pulldown-close', 'Lat Pulldown (underhand close grip)', 'strength', 'Back'],
  ['row', 'Barbell / T-Bar Row', 'strength', 'Back'],
  ['single-arm-row', 'Single-Arm Dumbbell Row', 'strength', 'Back'],
  ['seated-row', 'Seated Cable Row', 'strength', 'Back'],
  ['back-machine', 'Lat / Mid-Back Machine', 'strength', 'Back'],
  ['straight-arm-pulldown', 'Straight-Arm Pulldown', 'strength', 'Back'],
  ['rack-pull', 'Rack Pull / Deadlift', 'strength', 'Back'],
  ['hyperextension', 'Hyperextension', 'strength', 'Back'],

  // Biceps & forearms
  ['alt-curl', 'Alternating DB / EZ Bar Curl', 'strength', 'Biceps'],
  ['hammer-curl', 'Hammer / Preacher Curl', 'strength', 'Biceps'],
  ['ez-curl', 'Barbell / EZ Bar Curl', 'strength', 'Biceps'],
  ['db-curl', '2-Arm Dumbbell Curl', 'strength', 'Biceps'],
  ['wrist-curl', 'Wrist Curl', 'strength', 'Forearms'],

  // Shoulders & traps
  ['reverse-pec-deck', 'Reverse Pec Deck (rear delts)', 'strength', 'Shoulders'],
  ['lateral-raise', 'Dumbbell Lateral Raise', 'strength', 'Shoulders'],
  ['shoulder-press', 'Shoulder Press (DB / machine)', 'strength', 'Shoulders'],
  ['front-raise', 'Front Raise (DB / EZ / cable)', 'strength', 'Shoulders'],
  ['cable-lateral', 'Single-Arm Cable Lateral Raise', 'strength', 'Shoulders'],
  ['face-pull', 'Rope Face Pull', 'strength', 'Shoulders'],
  ['upright-row', 'Wide-Grip EZ Upright Row', 'strength', 'Shoulders'],
  ['shrug', 'Shrug (barbell / DB)', 'strength', 'Traps'],

  // Legs
  ['leg-curl', 'Leg Curl (seated / lying)', 'strength', 'Legs'],
  ['leg-extension', 'Leg Extension', 'strength', 'Legs'],
  ['squat', 'Squat (barbell / hack / smith)', 'strength', 'Legs'],
  ['leg-press', 'Leg Press', 'strength', 'Legs'],
  ['sldl', 'Straight-Leg DB Deadlift', 'strength', 'Legs'],
  ['lunge', 'Walking Lunge (weighted)', 'strength', 'Legs'],
  ['adductor', 'Adductor Machine', 'strength', 'Legs'],
  ['standing-calf', 'Standing Calf Raise', 'strength', 'Legs'],
  ['seated-calf', 'Seated Calf Raise', 'strength', 'Legs'],
];

// Item helpers. `x` takes optional extras: setsMax, repsMax, scheme,
// warm (warm-up sets), warmReps, drop, fail, rest (sec), note, opt.
const s = (exerciseId, sets, reps, x = {}) => ({
  exerciseId,
  sets: x.scheme ? x.scheme.length : sets,
  reps: x.scheme ? x.scheme[0] : reps,
  weight: 0,
  ...(x.setsMax ? { setsMax: x.setsMax } : {}),
  ...(x.repsMax ? { repsMax: x.repsMax } : {}),
  ...(x.scheme ? { repScheme: x.scheme } : {}),
  ...(x.warm ? { warmupSets: x.warm, warmupReps: x.warmReps || 15 } : {}),
  ...(x.drop ? { dropSets: x.drop } : {}),
  ...(x.fail ? { failureSets: x.fail } : {}),
  ...(x.rest ? { restSec: x.rest } : {}),
  ...(x.note ? { note: x.note } : {}),
  ...(x.opt ? { optional: true } : {}),
});
const cardio = (exerciseId, minutes, note, x = {}) => ({ exerciseId, minutes, distance: 0, note, ...x });
const hold = (exerciseId, sets, holdSec, x = {}) => ({
  exerciseId,
  sets,
  holdSec,
  ...(x.setsMax ? { setsMax: x.setsMax } : {}),
  ...(x.rest ? { restSec: x.rest } : {}),
  ...(x.note ? { note: x.note } : {}),
  ...(x.opt ? { optional: true } : {}),
});

const warmupBike = cardio('bike', 5, 'Warm-up: 5–10 min on the bike or treadmill');
const fastedCardio = cardio('incline-walk', 30, 'Fasted · 3 mph · incline 12 · 30–45 min');
const vacuums = hold('vacuum', 5, 10, { setsMax: 8, rest: 20, note: 'Daily: 5–8 holds of 10 seconds' });
const coreCircuit = [
  s('hanging-leg-raise', 3, 15, { setsMax: 4, repsMax: 20, rest: 30, note: 'Core circuit: pick 3–4 exercises, swap any you like' }),
  s('russian-twist', 3, 15, { setsMax: 4, repsMax: 20, rest: 30 }),
  s('cable-crunch', 3, 15, { setsMax: 4, repsMax: 20, rest: 30 }),
  hold('plank', 3, 45, { setsMax: 4, rest: 30, note: '45 seconds to 1 minute' }),
];

/**
 * 3 days on, 1 day off → an 8-day rotation (index 0 = Day 1).
 * Fasted cardio lands 5 times per 8 days (~4–5×/week) and the core circuit
 * 3 times (~2–3×/week); vacuums every day.
 */
export const PLAN = {
  mode: 'cycle',
  length: 8,
  // Day 1 of the rotation. Every later date follows from this
  // (change it in the app with Plan → "Today is").
  start: '2026-10-05',
  days: [
    {
      name: 'Chest & Triceps',
      dayType: 'training',
      note: 'Stretch and warm up your rotator cuffs (arm circles) before pressing.',
      items: [
        fastedCardio,
        warmupBike,
        s('push-up', 3, 20, { note: 'Warm-up: as many as you can, up to 20' }),
        s('pull-up', 1, 10, { note: 'Warm-up set' }),
        s('incline-machine-press', 3, 8, { setsMax: 4, repsMax: 10, drop: 1, note: 'Or any similar incline machine' }),
        s('incline-db-press', 3, 8, { setsMax: 4, repsMax: 10, note: 'Optional superset with incline DB flyes' }),
        s('incline-db-fly', 3, 10, { setsMax: 4, repsMax: 12, opt: true, note: 'Superset with incline DB press' }),
        s('flat-press', 4, 10, { repsMax: 12, note: 'Decline Hammer Strength, flat machine or flat DB bench' }),
        s('cable-crossover', 3, 12, { setsMax: 5, repsMax: 15, note: 'Middle-chest level' }),
        s('dips', 3, 15, { repsMax: 20, note: 'Regular, assisted forward-lean wide grip, or machine' }),
        s('triceps-pushdown', 3, 12, { repsMax: 15, warm: 1, warmReps: 15, note: 'Straight bar or rope' }),
        s('skull-crusher', 4, 15, { scheme: [15, 12, 10, 10], note: 'EZ/DB, or single-arm DB extensions. Superset with close-grip EZ bench' }),
        s('close-grip-bench', 4, 15, { scheme: [15, 12, 10, 10], opt: true }),
        vacuums,
      ],
    },
    {
      name: 'Back & Biceps',
      dayType: 'training',
      note: 'Rack pulls / deadlifts are optional (do them first or last). If you skip them, do straight-arm pulldowns.',
      items: [
        warmupBike,
        s('pull-up-wide', 3, 10, { setsMax: 4, note: 'Warm-up: all sets to failure (assisted if needed)' }),
        s('lat-pulldown-wide', 3, 10, { repsMax: 12 }),
        s('lat-pulldown-close', 2, 10, { repsMax: 12 }),
        s('row', 3, 8, { setsMax: 4, repsMax: 10, warm: 1, warmReps: 12, drop: 1, note: 'Or T-bar, standing 2-arm DB rows, supinated DB rows on incline' }),
        s('single-arm-row', 4, 8, { repsMax: 10, drop: 1, note: 'Or a similar lat movement' }),
        s('seated-row', 3, 12, { setsMax: 4, repsMax: 15, drop: 1, note: 'Any attachment, or similar mid-back machine' }),
        s('rack-pull', 3, 6, { setsMax: 4, repsMax: 8, warm: 1, warmReps: 8, rest: 150, opt: true, note: '120+ sec rest between sets' }),
        s('straight-arm-pulldown', 3, 12, { setsMax: 4, repsMax: 15, rest: 60, opt: true, note: 'Do these if you skipped rack pulls' }),
        s('hyperextension', 3, 12, { opt: true, note: 'All the way down, 2-second hold at the top with lats open' }),
        s('alt-curl', 4, 8, { repsMax: 10, drop: 1, note: 'Reps per side' }),
        s('hammer-curl', 4, 10, { note: 'Hammer or preacher. Add the other one too if you have energy' }),
        vacuums,
      ],
    },
    {
      name: 'Shoulders, Rear Delts & Traps',
      dayType: 'training',
      items: [
        fastedCardio,
        warmupBike,
        s('pull-up', 2, 10, { setsMax: 3, note: 'Warm-up (assisted if needed)' }),
        s('reverse-pec-deck', 3, 15, { scheme: [15, 15, 12] }),
        s('lateral-raise', 3, 10, { setsMax: 4, repsMax: 12, rest: 45, opt: true, note: '35–50 sec rest' }),
        s('shoulder-press', 3, 8, { setsMax: 4, repsMax: 10, warm: 1, warmReps: 12, drop: 1 }),
        s('front-raise', 3, 10, { setsMax: 4, note: 'Alternating DB (hammer grip), EZ bar or cables' }),
        s('cable-lateral', 3, 10, { setsMax: 4, note: 'Per arm, behind the back or in front' }),
        s('face-pull', 3, 15, { scheme: [15, 12, 12], opt: true, note: '1-second squeeze. Or incline DB rear-delt flyes' }),
        s('upright-row', 3, 12, { repsMax: 15, opt: true, note: 'Superset with EZ bar front raises (optional)' }),
        s('shrug', 3, 10, { warm: 1, warmReps: 12, note: '1–2 second hold at the top' }),
        vacuums,
        ...coreCircuit,
      ],
    },
    {
      name: 'Rest',
      dayType: 'active',
      note: 'Rest from lifting. Fasted incline walk plus the core circuit, done back to back.',
      items: [fastedCardio, ...coreCircuit, vacuums],
    },
    {
      name: 'Legs',
      dayType: 'training',
      items: [
        warmupBike,
        s('leg-curl', 4, 15, { scheme: [15, 15, 12, 12], fail: 1, note: '+1 set of partials to failure' }),
        s('leg-extension', 4, 15, { scheme: [15, 15, 12, 12], fail: 1, note: '+1 set of partials to failure' }),
        s('squat', 3, 8, { setsMax: 4, repsMax: 10, warm: 1, warmReps: 15, note: 'Barbell, hack, DB front or smith. Optional drop set to failure' }),
        s('leg-press', 3, 20, { setsMax: 4, note: 'Regular stance: 10 slow and controlled, 10 above-average speed' }),
        s('sldl', 4, 15, { scheme: [15, 12, 12, 10], opt: true, note: 'Or swap for a glute movement' }),
        s('lunge', 3, 10, { setsMax: 4, note: 'Laps back and forth, 8–10 steps per side' }),
        s('adductor', 3, 15, { scheme: [15, 12, 12], opt: true, note: 'Superset with bodyweight squats (optional)' }),
        s('standing-calf', 3, 15, { repsMax: 20, note: 'Standing or on the leg press' }),
        s('seated-calf', 3, 15, { repsMax: 20, opt: true }),
        vacuums,
      ],
    },
    {
      name: 'Chest & Shoulders',
      dayType: 'training',
      items: [
        fastedCardio,
        s('pull-up', 1, 10, { note: 'Warm-up' }),
        s('push-up', 3, 20, { note: 'Warm-up: up to 20 per set' }),
        s('lateral-raise', 3, 12, { setsMax: 4, repsMax: 15 }),
        s('cable-crossover', 3, 12, { setsMax: 4, rest: 45, note: '35–50 sec rest' }),
        s('incline-db-press', 3, 8, { setsMax: 4, repsMax: 10, note: 'Or incline smith machine press' }),
        s('shoulder-press', 3, 8, { repsMax: 10, note: 'Seated DB, smith machine or similar machine' }),
        s('incline-machine-press', 3, 8, { repsMax: 10, note: 'Or similar incline machine' }),
        s('front-raise', 3, 10, { setsMax: 4, opt: true }),
        s('flat-press', 3, 12, { scheme: [12, 10, 8], note: 'Flat DB bench press or similar flat chest machine' }),
        s('reverse-pec-deck', 3, 12, { repsMax: 15, note: 'Any rear-delt exercise' }),
        s('shrug', 3, 10, { repsMax: 12, opt: true, note: 'Any trap exercise' }),
        vacuums,
      ],
    },
    {
      name: 'Arms & Lats',
      dayType: 'training',
      note: 'You can start with arms or lats.',
      items: [
        warmupBike,
        s('pull-up-wide', 3, 10, { note: 'Until failure' }),
        s('lat-pulldown-wide', 3, 15, { scheme: [15, 15, 15] }),
        s('lat-pulldown-close', 3, 15, { scheme: [15, 15, 15] }),
        s('single-arm-row', 3, 8, { setsMax: 4, repsMax: 12, note: 'Focus on the lower lats' }),
        s('straight-arm-pulldown', 3, 12, { setsMax: 4, rest: 45, note: 'Straight bar, 35–60 sec rest' }),
        s('back-machine', 3, 10, { setsMax: 4, repsMax: 12 }),
        s('ez-curl', 4, 15, { scheme: [15, 12, 12, 10] }),
        s('db-curl', 3, 10, { scheme: [10, 10, 10], note: 'Heavy, good form' }),
        s('triceps-pushdown', 4, 15, { scheme: [15, 12, 12, 10], note: 'Rope extensions' }),
        s('skull-crusher', 3, 12, { scheme: [12, 12, 12], note: 'Or single-arm extensions behind the head on a flat bench' }),
        s('hammer-curl', 3, 12, { scheme: [12, 12, 12], note: 'One arm at a time, or another biceps exercise' }),
        s('dips', 3, 15, { scheme: [15, 15, 15], note: 'Assisted if needed' }),
        s('wrist-curl', 3, 10, { scheme: [10, 10, 10], opt: true, note: 'Seated, forearm on your leg, palms up' }),
        vacuums,
      ],
    },
    {
      name: 'Rest',
      dayType: 'active',
      note: 'Rest from lifting. Fasted incline walk plus the core circuit, done back to back.',
      items: [fastedCardio, ...coreCircuit, vacuums],
    },
  ],
};
