# Workout Logbook

A simple, robust web app for logging every set, rep and weight, plus cardio,
stomach vacuums, rest times, RPE and your daily scale weight. Works on desktop
and phone browsers, can be installed to your home screen, and keeps working
offline.

## Features

- **Your program built in.** It ships with an 8-day rotation (3 days on,
  1 day off): Chest & Triceps, Back & Biceps, Shoulders, Rest, Legs,
  Chest & Shoulders, Arms & Lats, Rest. It also includes:
  - fasted incline walks about 4–5×/week
  - a core circuit about 2–3×/week
  - stomach vacuums every day

  Everything is editable in the **Plan** tab.
- **Rotation that follows real life.** If you miss a day, choose which day today
  is and the rotation shifts from there. You can also switch to a weekly plan.
- **Daily log.** Every exercise has a **− / +** counter: + marks the next set done
  and starts the rest timer, − undoes it. Each set has weight and reps
  steppers and a ✓ button.
- **Real program details:**
  - rep ranges (3–4 × 8–10)
  - pyramids (15/12/10/10)
  - warm-up sets, which are logged but not counted in your load
  - drop sets and partials to failure
  - optional exercises
  - per-exercise notes and rest times
  - **⇄ swap** for "machine X or similar"
- **Intensity tracker.** Compares last session's load with today's planned and
  logged load. Shows estimated 1RM and top set. When you hit the top of your
  rep range on every set, it suggests the next weight.
- **Edit targets for one day.** Use "Edit target" to change sets, reps, weight,
  warm-ups, drop sets or rest for that day only. You see how it compares with
  last time.
- **Rest timer between sets.** It starts automatically: 1:30 for compound
  lifts (bench, squat, deadlift; 90–120 s, never over 3:00) and 1:00 for
  everything else (curls, extensions, raises, planks; isolation lifts never
  over 2:00), all adjustable in Settings. There's no rest before a partials-to-failure set.
  You can add or remove 15 s or skip. It beeps and vibrates when rest is over. The app also
  records how long you actually rested.
- **RPE per exercise** (5–10) is shown next to last time's RPE.
- **Timer alerts.** When rest ends, at each HIIT interval switch, and when a
  hold reaches its target, the app beeps and vibrates (on iPhone, a haptic
  tick on iOS 18+). Turn on **Settings → Timer alerts** to also get a
  notification with your phone's sound and vibration when the app is closed
  or the screen is locked. On iPhone this works in the Home Screen app
  (iOS 16.4+), not in a Safari tab.
- **Fitbit import (optional).** Steps, resting heart rate, sleep, weigh-ins
  and workouts from your Fitbit show up on each day's log. See
  [Connect Fitbit](#connect-fitbit-optional).
- **Daily scale weight** with the change since your last weigh-in, a 7-day
  average and a trend chart.
- **Cardio** (minutes, distance, calories, heart rate) and **timed holds**
  (vacuums, planks) with a built-in timer.
- **Progress** over 1 week, 4 weeks, 3 months, 6 months, 1 year or all time.
  Includes charts, personal records and full history.
- **Consistency tracker.** A row under the week strip shows your workout
  streak, vacuum streak and this week's cardio and core against your plan.
  Progress has the full card: best streaks, this week's goals day by day, and
  a month calendar of done / partly done / missed / rest days with a vacuum
  dot (tap a day to open it). Rest days never break a streak; warm-ups and the
  warm-up bike don't count as a workout.
- **Your data is safe.** It's saved instantly on the device and synced across
  devices. The server keeps 30 days of daily backups. You can export JSON or
  CSV and restore a backup.

## Host it online (Render)

The repo includes a `render.yaml`, so Render can set everything up from GitHub:

1. Create an account at [render.com](https://render.com) and connect your GitHub.
2. Click **New → Blueprint** and pick this repository.
3. When asked for `APP_PASSWORD`, enter a password. You'll type it once on
   each device.
4. Click **Apply**. After a minute or two you get a URL like
   `https://workout-logbook-xxxx.onrender.com`.
5. Open that URL on your phone and computer, go to **Settings**, and enter
   your password.
6. On your phone, choose **Share → Add to Home Screen** (iPhone Safari) or
   **⋮ → Install app** (Android Chrome).

Notes:

- The blueprint uses Render's **Starter** instance with a 1 GB disk. Free
  instances don't keep files, so your logbook would be lost on restart.
  Check Render's pricing page for current costs.
- Every push to the branch Render watches redeploys the app automatically.
  Your data on the disk is kept.
- Any host with a persistent disk works too, using the included `Dockerfile`:

  ```bash
  docker build -t logbook .
  docker run -p 3000:3000 -v logbook-data:/data -e APP_PASSWORD=change-me logbook
  ```

## Connect Fitbit (optional)

The app can import your Fitbit data every time you open it: **steps, resting
heart rate, sleep, weigh-ins and workouts** (read-only). Weigh-ins you type in
yourself always win over Fitbit's.

Google replaced the old Fitbit Web API with the **Google Health API** on
September 30, 2026, so this uses Google sign-in. One-time setup:

1. In [Google Cloud Console](https://console.cloud.google.com/), open the
   project your OAuth client belongs to.
2. **APIs & Services → Library**: search for **Google Health API** and
   enable it.
3. **Google Auth Platform** (OAuth consent screen): user type **External**,
   add your own Google account under **Test users**, and add these scopes:
   - `.../auth/googlehealth.activity_and_fitness.readonly`
   - `.../auth/googlehealth.health_metrics_and_measurements.readonly`
   - `.../auth/googlehealth.sleep.readonly`
4. **Clients** → your Web client → **Authorized redirect URIs**: add
   `https://<your-app>.onrender.com/api/google/callback`. Settings in the app
   shows the exact address to paste.
5. On Render → your service → **Environment**, add `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET` (from the client's details or its downloaded JSON).
   Never commit that JSON file to the repository.
6. Open the app → **Settings → Fitbit → Connect Fitbit**, and sign in with the
   Google account your Fitbit uses.

While the Google app is in **Testing**, Google lets a sign-in last only
**7 days**. When it runs out, Settings says so and you tap **Connect** again.
Publishing the app ("In production") removes that limit. However, Google
treats health data as a restricted scope and may require a verification
review first.

The server keeps the sign-in token in `DATA_DIR/google.json`. It is never
sent to the browser or included in backups.

## Run it locally

Requires Node.js 18 or newer. There are no runtime dependencies.

```bash
npm start                # http://localhost:3000
```

| Variable       | Default    | Purpose                                                   |
| -------------- | ---------- | --------------------------------------------------------- |
| `PORT`         | `3000`     | Port to listen on                                         |
| `DATA_DIR`     | `./data`   | Where `logbook.json` and `backups/` are stored            |
| `APP_PASSWORD` | _(none)_   | Password required to read or sync data (enter it in Settings) |
| `TRUST_PROXY`  | _(off)_    | Set to `1` behind a reverse proxy (automatic on Render)   |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | _(none)_ | Turn on the Fitbit import (see above) |
| `PUBLIC_URL`   | _(auto)_   | Public address for the Google sign-in redirect (Render's is detected) |

After 10 wrong passwords, the server locks out that address for 15 minutes.

## How sync works

Every device keeps a full copy of the data. Changes are pushed to the server
about a second after you make them, and are pulled again when you return to
the app. The server **merges** what it receives record by record: each day's
session, each plan day, each exercise, each weigh-in, and the settings. The
most recent edit wins, and deletions carry over. A phone that was offline
therefore never wipes out newer data from your computer.

## Development

```bash
npm install          # only needed for the browser tests (Playwright)
npm test             # unit + server tests
npm run test:e2e     # end-to-end tests in headless Chromium
npm run dev          # restart the server when files change
```

```
server.js            HTTP server, JSON storage, backups, merge-on-write, password lockout
public/index.html    App shell
public/css/app.css   Styles (light and dark)
public/js/program.js Starting exercise library and training plan
public/js/model.js   Data model and all logic (shared with the server and tests)
public/js/store.js   Local storage and background sync
public/js/charts.js  Small SVG chart helpers
public/js/app.js     UI: Log, Plan, Progress, Settings, rest timer
public/sw.js         Offline support
google-health.js     Fitbit / Google Health import (server side)
web-push.js          Timer notifications (Web Push, server side)
render.yaml          One-click Render deployment
test/                Unit, server and end-to-end tests
```
