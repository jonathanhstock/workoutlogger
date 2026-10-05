# Workout Logbook – notes for Claude

A single-user workout logbook: vanilla JS frontend in `public/`, zero-dependency
Node server in `server.js`, tests in `test/`. See README.md for features.

This file holds notes, conventions and ideas for future updates, not only rules.

## Commands

- `npm test` – unit + server tests (run before every push)
- `npm run test:e2e` – Playwright browser tests (phone + desktop viewports)
- `npm run check-videos` – verifies every YouTube link (needs internet; runs in CI)

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
- The browser's offline copy in localStorage stays as it is; it's a client
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
  by `npm run check-videos` (the `videos` CI job); add new links there and make
  sure that job passes.
- Supersets: `target.supersetNext` links an exercise to the next one. No rest
  timer between linked exercises; rest after the last one in the group.
  Stomach vacuums and cardio never use the rest timer.
- `public/js/model.js` holds all data logic and is shared by the browser, the
  server and the tests. Keep it free of DOM, storage and network code.
- Never make a page element wider than the screen (iPhone zooms out and gets stuck).
  The e2e suite checks this at 320 px and 390 px.
- Pinch and double-tap zoom are disabled on phones on purpose (app-like feel):
  viewport `maximum-scale=1, user-scalable=no`, `touch-action: manipulation`,
  and iOS gesture events cancelled in `app.js`. Keep inputs at 16px+ so iOS
  doesn't auto-zoom on focus.

## Feature ideas for future updates

Not built yet. Roughly in order of usefulness for this app.

1. **Weekly check-in summary**: workouts done vs. planned, total volume, PRs
   hit, cardio minutes, vacuums done, and the 7-day weight trend, all from data
   the app already has.
2. **Personal-record alerts**: a "New PR!" badge the moment a set beats the
   best e1RM, heaviest set or longest hold (PRs are already computed in
   Progress).
3. **Body measurements and progress photos**: waist, chest, arms next to scale
   weight; side-by-side photos by date. Photos need object storage (see the
   storage section), not the Render disk.
4. **Planned deload weeks**: mark a rotation as lighter (e.g. 60% weight) so
   the plan pre-fills reduced loads automatically.
5. **Streaks and consistency calendar**: month view of done / rest / missed
   days and the daily vacuum streak.
6. **Plate calculator**: tap a barbell weight to see plates per side.
7. **Meal tracking**:
   - Start with saved foods and meals, calories / protein / carbs / fat,
     daily targets as progress rings, and "repeat yesterday's meal".
   - Then food search (USDA FoodData Central, free) and barcode scanning with
     the phone camera (Open Food Facts, free).
   - Tie it to goals: protein target from body weight, weekly average calories
     next to the weight trend.
   - For one person this fits in the current logbook file; Postgres is only
     needed for the multi-user case above.
8. **Fitbit / Google health data**: pull steps, resting heart rate, sleep,
   weight (Aria scale) and logged activities through Google's Fitbit Web API.
   This is a cloud API, so it works from a web app:
   - register an app with Google;
   - OAuth sign-in once, redirecting back to the Render URL;
   - the server stores the refresh token as a secret or in the logbook file;
   - a daily sync fills scale weight and cardio automatically.
   Google has been moving Fitbit's developer APIs over to its own platform,
   so check which API is current before building.
9. **Apple Health sync**: needs a native iOS app; a web app can't read
   HealthKit.
