# Workout Logbook – notes for Claude

A single-user workout logbook: vanilla JS frontend in `public/`, zero-dependency
Node server in `server.js`, tests in `test/`. See README.md for features.

This file holds notes, conventions and ideas for future updates, not only rules.

## Commands

- `npm test` – unit + server tests (run before every push)
- `npm run test:e2e` – Playwright browser tests (phone + desktop viewports)
- `npm run check-videos` – verifies every YouTube link (needs internet; runs in CI
  when `program.js` changes, and weekly)

## Git and pull requests

- Commit messages and PR descriptions contain no AI attribution: no
  "Generated with Claude Code", no `Co-Authored-By: Claude` trailer, and no
  links to Claude sessions. The same goes for comments posted on PRs.

## Code comments

- Every time you create a new function, add a one-sentence comment directly
  above it describing what it does.
- When you edit a file, add the same one-sentence comment above any existing
  function that doesn't already have one.
- Use the language's normal comment style (e.g. `///` in Swift, `//` or JSDoc
  `/** */` in JS/TS, a docstring in Python).

## Storage: current setup and when to change it

The app is for one person. The server keeps the logbook in
`DATA_DIR/logbook.json` on the Render disk (with daily backups) and holds a copy
in memory. **That is fine for a single user; keep building on it.**

Idea for later, only if the app ever needs **other users with logins, photo
storage, or much more data than one person's logbook**: move to Postgres and a
stateless backend (no data held in the server's memory between requests).
Notes for that migration:

- One row per record (session per date, plan day, exercise, weigh-in,
  settings) with an `updated_at` column. Sync is an upsert that only replaces
  a row when the incoming `updated_at` is newer (the same last-write-wins
  rule as `mergeStates` in `public/js/model.js`). Keep deletions as tombstones.
- Add a `user_id` to every row once there are logins.
- Move the password-lockout counter into the database too.
- Photos go in object storage (Cloudflare R2, S3, Cloudinary), not on the server.
- On first start, import the existing `logbook.json` so no data is lost, then
  drop the Render disk from `render.yaml`.
- The browser's offline copy (IndexedDB) stays as it is; it's a client
  cache, not server state.

## Conventions

- **US units by default** (lb, miles, mph); metric (kg, km, km/h) stays
  available in Settings. New measurements must follow the chosen unit setting
  (`settings.unit` / `settings.distanceUnit`) and default to US units.
- Program defaults live in `public/js/program.js`. Plan days and exercises the
  user hasn't edited (`updatedAt` 0) always follow the program, so changes
  there reach existing logbooks; anything the user edited is kept.
- Cardio exercises declare which settings they log (`fields`: rounds, speed,
  incline, level), a default `target`, and a `cue`. Default cardio is the
  Incline Treadmill Walk at incline 12, 3.0 mph. HIIT cardio has an interval
  timer (logic in `model.js`: `hiitPhases` / `hiitPosition`).
- Form videos live in `VIDEOS` / `WORKOUT_VIDEOS` in `program.js` and play in
  the app (YouTube privacy-enhanced embed; video data streams from YouTube, not
  Render). Every exercise has one. Every link is checked against YouTube oEmbed
  by `npm run check-videos` (the `videos` workflow, which runs when `program.js`
  changes and every Monday); add new links there and make
  sure that job passes.
- Supersets: `target.supersetNext` links an exercise to the next one. No rest
  timer between linked exercises; rest after the last one in the group.
  Stomach vacuums and cardio never use the rest timer; a vacuum set also
  stops a rest still running from the exercise before, so holds run back to
  back.
- Rest by lift type (`REST_CLASSES`, `restFor` in `model.js`; the compound
  list is `COMPOUND` in `program.js`, everything else is isolation):
  compound lifts (bench, squat, deadlift, rows, presses, pull-ups) default
  120 s (90–120 s, never more than 180 s); isolation lifts (curls, leg
  extensions, lateral raises) default 75 s (60–75 s, max 120 s). An
  exercise's own rest wins but is capped at its type's max, and so is +15
  on the timer. Planks and other holds use `settings.restSec`. No rest
  before a partials-to-failure set (`nextIsFailureSet`): it follows the
  last working set back to back.
- Speed: the server gzips/brotlis app files once and answers revalidation with
  ETag 304s; syncs are gzipped both ways and get an empty 204 when nothing is
  newer. The browser keeps one IndexedDB row per record (`store.js`), so a tap
  saves only that day. Model helpers that run during render must not scan or
  sort the whole history per item (see `datesInRange`); check with a few years
  of fake data when adding charts or lists.
- Fitbit: `google-health.js` (server only) talks to the Google Health API
  (`health.googleapis.com/v4`; it replaced the Fitbit Web API on 2026-09-30).
  OAuth tokens live in `DATA_DIR/google.json` and never go to the browser or
  the logbook. Imports land in `state.health[date]` (steps, restingHr,
  sleepMin, activities) and in `state.body` with `source: 'fitbit'`;
  `applyHealthImport` in `model.js` never overwrites a weigh-in the user
  typed. The API's description document is at
  `https://health.googleapis.com/$discovery/rest?version=v4`, which is useful
  for checking field names.
- Timer alerts: `web-push.js` sends Web Push (RFC 8291/8292, `node:crypto`
  only); VAPID keys, subscriptions and pending alerts live in
  `DATA_DIR/push.json`. The app sends its pending alerts (`pendingAlerts`)
  only when it goes to the background and cancels them when it comes back,
  so you never get a notification and an in-app beep together. iPhone has
  no Vibration API; `vibrate()` in `app.js` falls back to tapping a hidden
  iOS switch control for a haptic tick.
- `public/js/model.js` holds all data logic and is shared by the browser, the
  server and the tests. Keep it free of DOM, storage and network code.
- Consistency rules live in `model.js` (`dayConsistency`, `currentStreaks`,
  `bestStreaks`, `monthGrid`, `consistencyTotals`). A workout is a finished
  working set, or one cardio entry of `CARDIO_SESSION_MIN`+ minutes or with
  interval rounds logged (warm-ups, the warm-up bike and vacuums don't
  count). A day is scheduled when it isn't Rest and has a non-vacuum item,
  so active-rest days count. A past scheduled day with no workout is missed
  and breaks the streak; today is pending until it ends. Workouts on
  unscheduled days count as `extra`, not toward the planned number. Rest
  excuses a day but not its vacuums. Cardio = one such entry, core =
  `CORE_SESSION_MIN` different Core-group exercises, vacuums = the day's
  target holds. `STREAK_GAP_DAYS` (14) neutral days in a row end a streak.
  Days before the first logged work are never judged. Helpers take
  `{ today, start }` (start from `consistencyStart`, computed once per
  render) and must never enumerate `state.sessions` per day (a Proxy test
  checks this). Idea for later: memoize the streak up to yesterday if a
  multi-year unbroken streak ever makes the Log feel slow.
- Never make a page element wider than the screen (iPhone zooms out and gets stuck).
  The e2e suite checks this at 320 px and 390 px.
- Pinch and double-tap zoom are disabled on phones on purpose (app-like feel):
  viewport `maximum-scale=1, user-scalable=no`, `touch-action: manipulation`,
  and iOS gesture events cancelled in `app.js`. Keep inputs at 16px+ so iOS
  doesn't auto-zoom on focus.

## Feature ideas for future updates

Not built yet. Roughly in order of usefulness for this app.

1. **Weekly summary every Sunday** (planned, not built yet):
   - **What it shows**, for the week ending that Sunday (Mon–Sun, or Sun–Sat
     when `settings.weekStart` is 0), compared with the week before:
     - workouts done vs. planned, missed days and extra days, plus the
       workout and vacuum streaks (from `consistencyDays` /
       `consistencyTotals` / `currentStreaks`);
     - cardio sessions and minutes vs. the 4–5×/week goal, and core
       sessions vs. 2–3×;
     - vacuum days out of 7;
     - total volume (`rangeSummary`) and the change from last week;
     - new PRs this week (best e1RM, heaviest set, longest hold);
     - 7-day average weight vs. last week (`bodyWeightAverage`);
     - Fitbit averages when connected: steps, sleep, resting HR
       (`state.health`);
     - one line on what to focus on next week, e.g. "2 walks short of
       your cardio goal".
   - **Where it shows:**
     - a "Week in review" card at the top of the Log on Sunday (and on
       Monday, if Sunday was missed), dismissible;
     - a "Weekly summaries" list in Progress to reread past weeks.
   - **Sunday alert:** with Timer alerts on, the server pushes "Your week in
     review is ready" on Sunday evening (around 7 pm local; store the
     device's time-zone offset with the push subscription). This reuses
     `web-push.js` with a weekly server timer, not the app-hidden schedule.
   - **How to build it:**
     - a pure `weeklyReview(state, weekStart, ctx)` in `model.js`, computed
       on the fly from existing data, so nothing new is stored except a
       `dismissed` week marker in settings;
     - keep it O(days in the week) per the speed rule;
     - unit tests for each number, and an e2e test that it shows on a
       Sunday and not on a Wednesday.
2. **Personal-record alerts**: a "New PR!" badge the moment a set beats the
   best e1RM, heaviest set or longest hold (PRs are already computed in
   Progress).
3. **Body measurements and progress photos**: waist, chest, arms next to scale
   weight; side-by-side photos by date. Photos need object storage (see the
   storage section), not the Render disk.
4. **Planned deload weeks**: mark a rotation as lighter (e.g. 60% weight) so
   the plan pre-fills reduced loads automatically.
5. **Plate calculator**: tap a barbell weight to see plates per side.
6. **Meal tracking**:
   - Start with saved foods and meals, calories / protein / carbs / fat,
     daily targets as progress rings, and "repeat yesterday's meal".
   - Then food search (USDA FoodData Central, free) and barcode scanning with
     the phone camera (Open Food Facts, free).
   - Tie it to goals: protein target from body weight, weekly average calories
     next to the weight trend.
   - For one person this fits in the current logbook file; Postgres is only
     needed for the multi-user case above.
7. **Fitbit trends**: steps, resting heart rate and sleep charts in Progress,
   and Fitbit workouts suggested as cardio entries (data is already imported
   into `state.health`).
8. **Apple Health sync**: needs a native iOS app; a web app can't read
   HealthKit.
