// The starting exercise library and training plan.
// Everything here can be changed in the app (Plan tab and Settings);
// this only decides what a brand-new logbook starts with.

// [id, name, kind, group]
export const EXERCISES = [
  // Cardio
  // Cardio: `fields` picks which settings you log (speed in mph, incline %,
  // intensity level); `target` is the default; `cue` is shown on the card.
  ['incline-walk', 'Incline Treadmill Walk', 'cardio', 'Cardio', { fields: ['speed', 'incline'], target: { minutes: 30, speed: 3, incline: 12 }, cue: 'Incline 12 · 3.0 mph · 30–45 min' }],
  ['incline-walk-full', 'Full Incline Walk', 'cardio', 'Cardio', { fields: ['speed', 'incline'], target: { minutes: 30, speed: 2.8, incline: 15 }, cue: 'Incline 15 · 2.7–3.0 mph · don’t hold on' }],
  ['incline-walk-fast', 'Incline Walk (3.5 mph)', 'cardio', 'Cardio', { fields: ['speed', 'incline'], target: { minutes: 30, speed: 3.5, incline: 10 }, cue: 'Incline 9–12 · 3.5 mph · hold on if needed' }],
  ['bike', 'Seated Bike', 'cardio', 'Cardio', { fields: ['level'], target: { minutes: 30, level: 8 }, cue: 'Intensity 6–10' }],
  ['elliptical', 'Elliptical', 'cardio', 'Cardio', { fields: ['level'], target: { minutes: 30, level: 8 }, cue: 'High intensity: resistance 7–10, hands moving' }],
  ['stairmaster', 'Stairmaster', 'cardio', 'Cardio', { fields: ['level'], target: { minutes: 30, level: 8 }, cue: 'Decent speed (7–10), don’t hold on' }],
  ['outdoor-walk', 'Outdoor Walk', 'cardio', 'Cardio', { fields: [], target: { minutes: 30 }, cue: 'Medium-fast pace' }],
  // HIIT: 3–5 min warm-up jog, then 4–8 rounds of 45–60 s high intensity +
  // 90–120 s walk/light jog, then a 4–5 min cool-down walk (~25 min total).
  ['hiit-treadmill', 'HIIT Treadmill', 'cardio', 'Cardio', { fields: ['rounds', 'speed', 'incline'], target: { minutes: 25, rounds: 6, incline: 7, warmMin: 4, workSec: 45, easySec: 90, coolMin: 4 }, cue: 'Incline 7–8 · warm up 3–5 min light jog · 45–60 s hard run / 90–120 s walk or light jog × 4–8 · cool down 4–5 min slow walk' }],
  ['hiit-elliptical', 'HIIT Elliptical', 'cardio', 'Cardio', { fields: ['rounds', 'level'], target: { minutes: 25, rounds: 6, level: 12, warmMin: 4, workSec: 45, easySec: 90, coolMin: 4 }, cue: 'Level 12–15 · warm up 3–5 min easy · 45–60 s all-out / 90–120 s easy × 4–8 · cool down 4–5 min easy' }],
  ['treadmill', 'Treadmill', 'cardio', 'Cardio', { fields: ['speed', 'incline'], target: { minutes: 30, speed: 3, incline: 1 } }],

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
  ['incline-barbell-bench', 'Incline Barbell Bench Press', 'strength', 'Chest'],
  ['flat-barbell-bench', 'Flat Barbell Bench Press', 'strength', 'Chest'],
  ['inner-chest-press', 'Inner Chest Dumbbell Press', 'strength', 'Chest'],

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
  ['supinated-db-row', 'Supinated Dumbbell Row', 'strength', 'Back'],

  // Biceps & forearms
  ['alt-curl', 'Alternating DB / EZ Bar Curl', 'strength', 'Biceps'],
  ['hammer-curl', 'Hammer / Preacher Curl', 'strength', 'Biceps'],
  ['ez-curl', 'Barbell / EZ Bar Curl', 'strength', 'Biceps'],
  ['db-curl', '2-Arm Dumbbell Curl', 'strength', 'Biceps'],
  ['wrist-curl', 'Wrist Curl', 'strength', 'Forearms'],
  ['concentration-curl', 'Concentration Curl', 'strength', 'Biceps'],
  ['reverse-curl', 'Reverse Curl', 'strength', 'Forearms'],

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
  ['lying-leg-curl', 'Lying Leg Curl', 'strength', 'Legs'],
  ['abductor', 'Abductor Machine', 'strength', 'Glutes'],
  ['pull-through', 'Cable Pull-Through', 'strength', 'Glutes'],
  ['frog-pump', 'Frog Pump', 'strength', 'Glutes'],
  ['banded-side-walk', 'Banded Side Walk', 'strength', 'Glutes'],

  // Olympic lifts
  ['hang-clean', 'Hang Clean', 'strength', 'Full body'],
  ['barbell-snatch', 'Barbell Snatch', 'strength', 'Full body'],
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
  ...(x.ss ? { supersetNext: true } : {}),
});
const cardio = (exerciseId, minutes, note, x = {}) => ({ exerciseId, minutes, distance: 0, ...(note ? { note } : {}), ...x });
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
// Default cardio; swap it for any other cardio option on the day.
const fastedCardio = cardio('incline-walk', 30, 'Fasted', { speed: 3, incline: 12 });
const vacuums = hold('vacuum', 5, 10, { setsMax: 8, note: 'Daily: 5–8 holds of 10 seconds' });
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
// Form videos per exercise: [title, YouTube URL]. Every link is checked by
// `npm run check-videos` (in CI) so a removed or private video is caught.
// Replaced because YouTube refused to embed them (HTTP 403 from oEmbed):
//   reverse pec deck https://youtu.be/qdYLu49hg1c, pull-through https://youtu.be/FIFAYRU29xk
export const VIDEOS = {
  'incline-barbell-bench': [['Incline barbell bench press', 'https://youtu.be/SrqOu55lrYU']],
  'flat-barbell-bench': [['Flat barbell bench press', 'https://youtu.be/ysUTNll8JQ8']],
  'incline-db-press': [['Incline dumbbell bench press', 'https://youtu.be/hChjZQhX1Ls']],
  'incline-db-fly': [['Incline dumbbell fly', 'https://youtu.be/bDaIL_zKbGs']],
  'flat-press': [['Flat dumbbell bench press', 'https://youtu.be/Y_7aHqXeCfQ']],
  'incline-machine-press': [['Incline Hammer Strength press machine', 'https://youtu.be/ig0NyNlSce4']],
  'inner-chest-press': [['Inner chest dumbbell presses', 'https://youtu.be/WCAIi9xvNR8']],
  'cable-crossover': [['Cable crossovers', 'https://youtu.be/1SoJVttMI1w']],
  'skull-crusher': [['Skull crushers', 'https://youtu.be/Hdx3L8vjeeA']],
  dips: [['Triceps dips', 'https://youtu.be/35PXVWP1XVs']],
  'triceps-pushdown': [['Triceps push downs', 'https://youtu.be/REWv05om0ho']],
  'close-grip-bench': [['Close grip barbell bench press', 'https://youtu.be/cXbSJHtjrQQ']],
  row: [
    ['Barbell rows', 'https://youtu.be/kBWAon7ItDw'],
    ['T-bar row', 'https://youtu.be/OrrKhAcb62o'],
  ],
  'single-arm-row': [['Single arm dumbbell rows', 'https://youtu.be/EEFHHOCfHgw']],
  'rack-pull': [
    ['Rack pulls', 'https://youtu.be/aAjN8zS7Idg'],
    ['Deadlifts', 'https://youtu.be/ytGaGIn3SjE'],
  ],
  'supinated-db-row': [['Supinated dumbbell rows', 'https://youtu.be/H75im9fAUMc']],
  'seated-row': [['Seated cable rows', 'https://youtu.be/A77hAjcpN1s']],
  hyperextension: [['Hyper extensions', 'https://youtu.be/vx0jZBEmZcE']],
  'lat-pulldown-wide': [['Wide grip lat pulldowns', 'https://youtu.be/CAwf7n6Luuc']],
  'lat-pulldown-close': [['Underhand close grip lat pulldown', 'https://youtu.be/D-aYXhHBDI8']],
  'ez-curl': [['EZ bar and straight bar curls', 'https://youtu.be/prAKEcaMbRo']],
  'alt-curl': [
    ['EZ bar and straight bar curls', 'https://youtu.be/prAKEcaMbRo'],
    ['Dumbbell curl', 'https://youtu.be/y01MQBNG-as'],
  ],
  'hammer-curl': [['Hammer curls', 'https://youtu.be/7jqi2qWAUJk']],
  'db-curl': [['Dumbbell curl', 'https://youtu.be/y01MQBNG-as']],
  'concentration-curl': [['Concentration curl', 'https://youtu.be/EOfAgBvyTMM']],
  'reverse-curl': [['Reverse curls', 'https://youtu.be/nRgxYX2Ve9w']],
  'shoulder-press': [['Dumbbell shoulder press', 'https://youtu.be/qEwKCR5JCog']],
  'lateral-raise': [['Dumbbell lateral raises', 'https://youtu.be/zpUTA5i16kA']],
  'front-raise': [['Dumbbell front raises', 'https://youtu.be/ALNyDCkW9y8']],
  'reverse-pec-deck': [['Reverse pec deck (rear delts)', 'https://youtu.be/dC7jhEk-29A']],
  'face-pull': [['Face pulls (rear delts)', 'https://youtu.be/V8dZ3pyiCBo']],
  'upright-row': [['Upright rows', 'https://youtu.be/jaAV-rD45I0']],
  shrug: [['Dumbbell shrugs', 'https://youtu.be/xDt6qbKgLkY']],
  squat: [
    ['Barbell squats', 'https://youtu.be/1oed-UmAxFs'],
    ['Hack squat', 'https://youtu.be/bhfyY8F8F24'],
  ],
  'leg-press': [['Leg press', 'https://youtu.be/CHPHn-OnTqE']],
  'leg-extension': [['Leg extensions', 'https://youtu.be/ljO4jkwv8wQ']],
  'leg-curl': [['Seated leg curls', 'https://youtu.be/eGoFk_TJT1A']],
  'lying-leg-curl': [['Lying leg curls', 'https://youtu.be/6y_GEg3YFC0']],
  sldl: [['Straight leg deadlifts', 'https://youtu.be/1uDiW5--rAE']],
  lunge: [['Lunges', 'https://youtu.be/T3W55FZJ1hQ']],
  'seated-calf': [['Seated calf raises', 'https://youtu.be/xz7sqxaJ-Ck']],
  'standing-calf': [['Standing calf raises', 'https://youtu.be/YMmgqO8Jo-k']],
  'pull-through': [['Cable pull-through', 'https://youtu.be/DbSF7ipBh5Y']],
  'frog-pump': [['Frog pumps', 'https://youtu.be/MQ62r2V7Lw8']],
  'banded-side-walk': [['Banded side walk', 'https://youtu.be/CPvijTQz6a0']],
  adductor: [['Adduction and abduction machine', 'https://youtu.be/MwXtApoiVEc']],
  abductor: [['Adduction and abduction machine', 'https://youtu.be/MwXtApoiVEc']],
  'hang-clean': [['Hang cleans', 'https://youtu.be/eVWbmwSg5CE']],
  'barbell-snatch': [['Barbell snatch', 'https://youtu.be/UBc5N_-xdqo']],
};

// Full workouts (not tied to one exercise), shown at the top of the Exercises tab.
export const WORKOUT_VIDEOS = [
  ['15-min full body HIIT (no equipment)', 'https://youtu.be/1skBf6h2ksI'],
  ['HIIT workout at home (no equipment)', 'https://youtu.be/8J2pCRDTK9o'],
  ['Glute workout with bands (at home)', 'https://www.youtube.com/watch?v=HG3cwzZ1lyo'],
  ['Upper body workout with bands', 'https://youtu.be/ou0n5aO_K9Y'],
  ['Ab workouts', 'https://youtu.be/4-r3Yz7GfdM'],
];

/** The 11-character video id from a youtu.be or youtube.com link. */
export function youtubeId(url) {
  const m = String(url).match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/shorts\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

export const PLAN = {
  mode: 'cycle',
  length: 8,
  // Day 1 of the rotation. Every later date follows from this
  // (change it in the app with Plan → "Today is").
  start: '2026-10-02',
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
        s('incline-db-press', 3, 8, { setsMax: 4, repsMax: 10, ss: true }),
        s('incline-db-fly', 3, 10, { setsMax: 4, repsMax: 12, opt: true }),
        s('flat-press', 4, 10, { repsMax: 12, note: 'Decline Hammer Strength, flat machine or flat DB bench' }),
        s('cable-crossover', 3, 12, { setsMax: 5, repsMax: 15, note: 'Middle-chest level' }),
        s('dips', 3, 15, { repsMax: 20, note: 'Regular, assisted forward-lean wide grip, or machine' }),
        s('triceps-pushdown', 3, 12, { repsMax: 15, warm: 1, warmReps: 15, note: 'Straight bar or rope' }),
        s('skull-crusher', 4, 15, { scheme: [15, 12, 10, 10], ss: true, note: 'EZ/DB, or single-arm DB extensions' }),
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
