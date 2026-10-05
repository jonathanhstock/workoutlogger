# Workout Logbook – notes for Claude

A single-user workout logbook: vanilla JS frontend in `public/`, zero-dependency
Node server in `server.js`, tests in `test/`. See README.md for features.

## Commands

- `npm test` – unit + server tests (run before every push)
- `npm run test:e2e` – Playwright browser tests (phone + desktop viewports)

## Architecture rules for new work

Two habits keep scaling painless:

1. **Store everything in Postgres, not files on the server's disk.**
   Any new persistent data goes in Postgres tables, never new files on disk.
2. **Keep the backend stateless.** Hold no data in the app's memory between
   requests. Read from and write to the database on each request, so any
   number of server instances can run side by side.

Current state (known exception): the server still stores the logbook in
`DATA_DIR/logbook.json`, keeps a copy in memory, and keeps the password-lockout
counter in memory. Don't build new features on top of that. When adding
server-side storage, migrate to Postgres instead:

- One row per record (session per date, plan day, exercise, weigh-in,
  settings) with an `updated_at` column. Sync is an upsert that only replaces
  a row when the incoming `updated_at` is newer (the same last-write-wins
  rule as `mergeStates` in `public/js/model.js`). Keep deletions as tombstones.
- Move the password-lockout counter into Postgres too.
- On first start, import an existing `logbook.json` so no data is lost, then
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
- Cardio exercises declare which settings they log (`fields`: speed, incline,
  level), a default `target`, and a `cue`. Default cardio is the Incline
  Treadmill Walk at incline 12, 3.0 mph.
- Form videos live in `VIDEOS` / `WORKOUT_VIDEOS` in `program.js` and show in
  the Exercises tab. Every link is checked against YouTube oEmbed by
  `npm run check-videos` (the `videos` CI job); add new links there and make
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
