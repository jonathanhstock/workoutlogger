# Workout Logbook

A simple, robust web app for logging every set, rep and weight, plus cardio and
stomach vacuum sessions. Works on desktop and phone browsers, can be installed
to your home screen, and keeps working offline.

## Features

- **Daily log.** Each day starts from your weekly plan. Every exercise has a
  **− / +** counter (+ marks the next set done, − undoes it). Each set has its
  own weight and reps steppers and a ✓ button.
- **Intensity tracker** on every exercise. It compares last session's load with
  today's planned and logged load (weight × reps, cardio minutes, or vacuum
  hold time), plus estimated 1RM, top set, pace or longest hold.
- **Weekly targets you can change.** Use “Edit target” to change sets, reps or
  weight for that day only, and see how it compares with last time. Use the
  **Plan** tab, or “Use this day as my plan”, to change it for every week.
- **7 editable days.** Name each weekday and mark it Training, Active rest or
  Rest. You can also copy one day to another.
- **Cardio:** minutes, distance, calories and average heart rate.
- **Stomach vacuums:** sets of holds, with a built-in hold timer.
- **Progress:** totals and charts over 1 week, 4 weeks, 3 months, 6 months,
  1 year or all time. There are per-exercise charts (est. 1RM, top weight,
  volume, reps, pace, hold time), personal records and full history.
- **Your data is safe.** It is saved instantly on the device, synced to the
  server across devices, and the server keeps a daily backup for 30 days. You
  can also export JSON or CSV and restore a backup.

## Run it

Requires Node.js 18 or newer. There are no runtime dependencies.

```bash
npm start                # http://localhost:3000
```

Options (environment variables):

| Variable       | Default    | Purpose                                             |
| -------------- | ---------- | --------------------------------------------------- |
| `PORT`         | `3000`     | Port to listen on                                   |
| `DATA_DIR`     | `./data`   | Where `logbook.json` and `backups/` are stored      |
| `APP_PASSWORD` | _(none)_   | If set, syncing requires this password (enter it in Settings) |

### Use it from your phone and computer

Sync works whenever every device opens the **same server**. Some options:

1. **Home network:** run `npm start` on a computer that stays on, then open
   `http://<that-computer's-IP>:3000` on your phone (same Wi-Fi).
2. **Hosted (anywhere):** deploy the included `Dockerfile` to any host that
   gives you a **persistent disk** (Fly.io, Railway, Render with a disk, or a
   small VPS). Mount the disk at `/data` and set `APP_PASSWORD`.

   ```bash
   docker build -t logbook .
   docker run -p 3000:3000 -v logbook-data:/data -e APP_PASSWORD=change-me logbook
   ```

Then, on your phone, choose **Share → Add to Home Screen** (iOS Safari) or
**⋮ → Install app** (Android Chrome).

If the app is opened without the server (for example as static files), it
still works fully, but data stays in that browser only. Use Settings →
Download backup.

## How sync works

Every device keeps a full copy of the data. Changes are pushed to the server
about a second after you make them, and are pulled again when you return to
the app. The server **merges** what it receives record by record (each day's
session, each plan day, each exercise and the settings): the most recent edit
wins, and deletions carry over. A phone that was offline therefore never wipes
out newer data from your computer.

## Development

```bash
npm install          # only needed for the browser tests (Playwright)
npm test             # unit + server tests
npm run test:e2e     # end-to-end tests in headless Chromium
npm run dev          # restart the server when files change
```

Project layout:

```
server.js            HTTP server, JSON storage, backups, merge-on-write
public/index.html    App shell
public/css/app.css   Styles (light and dark)
public/js/model.js   Data model and all logic (shared with the server and tests)
public/js/store.js   Local storage and background sync
public/js/charts.js  Small SVG chart helpers
public/js/app.js     UI: Log, Plan, Progress, Settings
public/sw.js         Offline support
test/                Unit, server and end-to-end tests
```
