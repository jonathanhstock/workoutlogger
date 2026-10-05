// End-to-end tests in a real browser (Chromium via Playwright).
// Run: npm run test:e2e   (set SCREENSHOTS=dir to save screenshots)

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../server.js';
import { defaultState } from '../public/js/model.js';

const TODAY = '2026-10-05'; // rotation Day 1: Chest & Triceps
const LAST_ROTATION = '2026-09-27'; // the previous Day 1
const SHOTS = process.env.SCREENSHOTS;
const FLAT = 'Flat / Decline Chest Press';

const PHONE = { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const DESKTOP = { viewport: { width: 1280, height: 900 } };

let server;
let base;
let browser;
let clockMinutes = 0;

async function openApp(device = PHONE, hash = '#log') {
  const context = await browser.newContext(device);
  const page = await context.newPage();
  // Each "device" opens a few minutes after the previous one so edits are
  // ordered in time like they would be in real life.
  clockMinutes += 5;
  await page.clock.install({ time: new Date(new Date(`${TODAY}T09:00:00`).getTime() + clockMinutes * 60000) });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('dialog', (d) => d.accept());
  // No internet in tests: stand in for YouTube thumbnails and the player.
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  await page.route('https://i.ytimg.com/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
  await page.route('https://www.youtube-nocookie.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<p>player</p>' }));
  await page.goto(`${base}/${hash}`);
  await page.waitForSelector('#sync[data-status="synced"]');
  return { context, page, errors };
}

const card = (page, name) => page.locator('article.entry', { has: page.locator('h3', { hasText: name }) }).first();

async function serverState() {
  return (await fetch(`${base}/api/state`)).json();
}

/** Let the debounced sync fire, then poll the server until `check` passes. */
async function serverHas(page, check) {
  await page.clock.runFor(1500);
  let s;
  for (let i = 0; i < 50; i++) {
    s = await serverState();
    try {
      if (check(s)) return s;
    } catch {
      /* not there yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`server never reached expected state: ${JSON.stringify(s.sessions?.[TODAY]).slice(0, 400)}`);
}

const todayEntry = (s, id) => s.sessions[TODAY].entries.find((e) => e.exerciseId === id);

async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

async function noHorizontalScroll(page) {
  const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  assert.ok(sw <= cw, `page scrolls horizontally: ${sw} > ${cw}`);
}

describe('workout logbook in the browser', () => {
  before(async () => {
    if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-e2e-'));
    // Seed the previous Day 1 so the intensity tracker has history.
    const seed = defaultState(1);
    seed.settings.cycleStart = TODAY;
    seed.sessions[LAST_ROTATION] = {
      date: LAST_ROTATION,
      name: 'Chest & Triceps',
      dayType: 'training',
      note: '',
      notes: '',
      updatedAt: 1,
      entries: [
        {
          id: 'e1',
          exerciseId: 'flat-press',
          kind: 'strength',
          notes: '',
          rpe: 8,
          target: { sets: 4, reps: 10, repsMax: 12, weight: 0 },
          sets: [1, 2, 3, 4].map((i) => ({ id: `s${i}`, weight: 185, reps: 10, done: true })),
        },
      ],
    };
    fs.writeFileSync(path.join(dir, 'logbook.json'), JSON.stringify(seed));
    server = createServer({ dataDir: dir });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch();
  });

  after(async () => {
    await browser?.close();
    server?.close();
  });

  test('logs sets with +/- controls and starts the rest timer', async () => {
    const { context, page, errors } = await openApp();
    assert.equal(await page.locator('.dayname').inputValue(), 'Chest & Triceps');
    assert.equal(await page.locator('select[data-field="plan-day"]').inputValue(), '0');
    await page.locator('.day-note', { hasText: 'rotator cuffs' }).waitFor();

    const flat = () => card(page, FLAT);
    // Pre-filled from the previous rotation's 185 lb, with the intensity tracker comparing.
    assert.equal(await flat().locator('.set-row input').first().inputValue(), '185');
    await flat().locator('.intensity').getByText('Last · Sep 27').waitFor();
    await flat().locator('.target-line', { hasText: '4 × 10–12 @ 185 lb' }).waitFor();
    await shot(page, '01-log-phone');

    // "+" completes the next set and starts the rest timer.
    await flat().getByRole('button', { name: /Complete next set/ }).click();
    await flat().locator('.count', { hasText: '1/4' }).waitFor();
    await page.locator('#rest .rest-sub', { hasText: `${FLAT} · 3 sets left` }).waitFor();
    await page.locator('#rest [data-rest-time]', { hasText: '1:30' }).waitFor();
    await page.clock.runFor(30000);
    await page.locator('#rest [data-rest-time]', { hasText: '1:00' }).waitFor();
    await page.getByRole('button', { name: '15 seconds more' }).click();
    await page.locator('#rest [data-rest-time]', { hasText: '1:15' }).waitFor();
    await page.clock.runFor(76000);
    await page.locator('#rest.is-done', { hasText: 'Next set!' }).waitFor();
    await page.getByRole('button', { name: 'Skip' }).click();
    assert.equal(await page.locator('#rest').isHidden(), true);

    // "−" undoes; steppers and typing edit a set.
    await flat().getByRole('button', { name: /Complete next set/ }).click();
    await flat().getByRole('button', { name: /Undo last completed set/ }).click();
    await flat().locator('.count', { hasText: '1/4' }).waitFor();
    await flat().locator('.set-row').nth(1).getByRole('button', { name: 'Increase weight' }).click();
    assert.equal(await flat().locator('.set-row').nth(1).locator('input').first().inputValue(), '190');
    const reps = flat().locator('.set-row').nth(1).locator('input').nth(1);
    await reps.fill('9');
    await reps.press('Enter');
    await page.waitForTimeout(50);
    await page.clock.runFor(95000);
    await flat().locator('.set-row').nth(1).getByRole('button', { name: 'Set 2 done' }).click();
    await flat().locator('.count', { hasText: '2/4' }).waitFor();
    // Rest actually taken between sets 1 and 2 is shown.
    await flat().locator('.set-row').nth(1).locator('.prev-hint', { hasText: /rested \d+:\d\d/ }).waitFor();

    // RPE for the exercise.
    await flat().locator('.rpe-row').getByText('last 8').waitFor();
    await flat().locator('.rpe button', { hasText: '9' }).click();

    const sets = (s) => todayEntry(s, 'flat-press').sets.slice(0, 2).map((x) => [x.weight, x.reps, x.done]);
    await serverHas(page, (s) => JSON.stringify(sets(s)) === JSON.stringify([[185, 10, true], [190, 9, true]]) && todayEntry(s, 'flat-press').rpe === 9);

    await noHorizontalScroll(page);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('targets can be changed for this rotation only', async () => {
    const { context, page, errors } = await openApp();
    const flat = () => card(page, FLAT);
    await flat().getByRole('button', { name: 'Edit target' }).click();
    await flat().locator('.target-edit').getByRole('button', { name: 'Increase Sets' }).click();
    await flat().locator('.count', { hasText: '2/5' }).waitFor();
    await flat().locator('.target-edit').getByText('Last time (Sun, Sep 27)').waitFor();
    await flat().locator('.target-edit .delta.up', { hasText: '+1 sets' }).waitFor();
    // Add a drop set from the editor.
    await flat().locator('.target-edit').getByRole('button', { name: 'Increase Drop sets' }).click();
    await flat().locator('.count', { hasText: '2/6' }).waitFor();
    await flat().locator('.set-row.t-drop').waitFor();
    await shot(page, '02-target-edit');
    await flat().locator('.target-edit').getByRole('button', { name: 'Decrease Drop sets' }).click();
    await flat().locator('.target-edit').getByRole('button', { name: 'Decrease Sets' }).click();
    await flat().locator('.count', { hasText: '2/4' }).waitFor();

    const s = await serverHas(page, (st) => todayEntry(st, 'flat-press').target.sets === 4 && !todayEntry(st, 'flat-press').sets.some((x) => x.type));
    assert.equal(s.plan[0].items.find((it) => it.exerciseId === 'flat-press').sets, 4, 'plan untouched');
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('warm-up sets, set types and swapping exercises', async () => {
    const { context, page, errors } = await openApp();
    const push = () => card(page, 'Triceps Pushdown');
    await push().locator('.set-row.t-warmup .idx', { hasText: 'W' }).waitFor();
    await push().locator('.set-legend').waitFor();
    // Optional exercises are marked in yellow.
    const fly = card(page, 'Incline Dumbbell Fly');
    assert.match(await fly.getAttribute('class'), /is-optional/);
    await fly.locator('.badge.opt', { hasText: 'Optional' }).waitFor();
    assert.equal(await card(page, 'Dips').locator('.badge.opt').count(), 0);
    // Tapping a set number cycles its type: warm-up, then drop set.
    await push().locator('.set-row').nth(3).locator('.idx').click();
    await push().locator('.set-row.t-warmup').nth(1).waitFor();
    await push().locator('.set-row').nth(3).locator('.idx').click();
    await push().locator('.set-row.t-drop').waitFor();

    // Swap the incline machine for the pec deck.
    await card(page, 'Incline Machine Press').getByRole('button', { name: /Swap Incline Machine Press/ }).click();
    await page.locator('#sheet-title', { hasText: 'Swap for' }).waitFor();
    await page.locator('#sheet-q').fill('pec deck');
    await page.locator('.pick', { hasText: 'Cable Crossover / Pec Deck' }).click();
    assert.equal(await card(page, 'Incline Machine Press').count(), 0);
    assert.equal(await page.locator('article.entry h3', { hasText: 'Cable Crossover / Pec Deck' }).count(), 2);

    const s = await serverHas(page, (st) => !todayEntry(st, 'incline-machine-press') && todayEntry(st, 'triceps-pushdown').sets.some((x) => x.type === 'drop'));
    assert.equal(todayEntry(s, 'triceps-pushdown').sets[0].type, 'warmup');
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('cardio, vacuum timer, body weight and adding exercises', async () => {
    const { context, page, errors } = await openApp();

    const walk = () => card(page, 'Incline Treadmill Walk');
    await walk().locator('.cue', { hasText: 'Incline 12 · 3.0 mph' }).waitFor();
    assert.equal(await walk().getByRole('textbox', { name: 'Incline', exact: true }).inputValue(), '12');
    assert.equal(await walk().getByRole('textbox', { name: 'Speed (mph)', exact: true }).inputValue(), '3');
    await walk().getByRole('button', { name: 'Increase Minutes' }).click();
    await walk().getByRole('button', { name: 'Mark cardio complete' }).click();
    await walk().locator('.count', { hasText: '1/1' }).waitFor();

    // Vacuum hold timer.
    const vac = () => card(page, 'Stomach Vacuum');
    await vac().locator('.target-line', { hasText: '5–8 × 10s hold' }).waitFor();
    await vac().getByRole('button', { name: 'Start hold timer' }).first().click();
    await page.clock.runFor(11000);
    await vac().locator('[data-timer]').filter({ hasText: /1[01]s/ }).waitFor();
    await vac().getByRole('button', { name: 'Stop timer and log hold' }).click();
    const first = vac().locator('.set-row').first();
    assert.equal(await first.locator('input').inputValue(), '11');
    assert.equal(await first.locator('.check').getAttribute('aria-pressed'), 'true');
    // Vacuums have no rest timer and no RPE.
    await vac().getByRole('button', { name: /Complete next set/ }).click();
    await vac().locator('.count', { hasText: '2/5' }).waitFor();
    assert.equal(await page.locator('#rest').isHidden(), true);
    assert.equal(await vac().locator('.rpe-row').count(), 0);

    // Scale weight: first weigh-in, then the stepper.
    await page.getByRole('button', { name: 'Log weight' }).click();
    const bw = page.locator('.bw input');
    await bw.fill('182.4');
    await bw.press('Enter');
    await page.locator('.bw').getByText('7-day avg').waitFor();
    await page.locator('.bw').getByRole('button', { name: 'Increase weight' }).click();
    assert.equal(await page.locator('.bw input').inputValue(), '182.6');

    // Create a brand-new exercise.
    await page.getByRole('button', { name: /Add exercise, cardio or vacuum/ }).click();
    await page.locator('#sheet-q').fill('Landmine Press');
    await page.getByRole('button', { name: 'Strength', exact: true }).last().click();
    await card(page, 'Landmine Press').waitFor();
    await shot(page, '03-cardio-vacuum');

    const s = await serverHas(page, (st) => st.body[TODAY]?.weight === 182.6 && todayEntry(st, 'incline-walk').cardio.done && todayEntry(st, 'incline-walk').cardio.minutes === 31);
    assert.equal(todayEntry(s, 'vacuum').sets[0].holdSec, 11);
    assert.equal(todayEntry(s, 'vacuum').sets.filter((x) => x.done).length, 2);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('supersets skip rest between the pair; cardio can be swapped', async () => {
    const { context, page, errors } = await openApp();
    const press = () => card(page, 'Incline Dumbbell Press');
    const fly = () => card(page, 'Incline Dumbbell Fly');
    await press().locator('.badge.ss').waitFor();
    await page.locator('.ss-link', { hasText: 'no rest between' }).first().waitFor();
    // First exercise of the superset: no rest, straight to the next.
    await press().getByRole('button', { name: /Complete next set/ }).click();
    await page.locator('#toast', { hasText: 'Superset: straight to Incline Dumbbell Fly' }).waitFor();
    assert.equal(await page.locator('#rest').isHidden(), true);
    // Second exercise: now rest before the next round.
    await fly().getByRole('button', { name: /Complete next set/ }).click();
    await page.locator('#rest .rest-sub', { hasText: 'Incline Dumbbell Fly' }).waitFor();
    await page.getByRole('button', { name: 'Skip' }).click();

    // Swap the incline walk for the Stairmaster: it logs a level instead.
    await card(page, 'Incline Treadmill Walk').getByRole('button', { name: /Swap Incline Treadmill Walk/ }).click();
    await page.locator('#sheet-kinds [aria-pressed="true"]', { hasText: 'Cardio' }).waitFor();
    await page.locator('.pick', { hasText: 'Stairmaster' }).click();
    const stairs = card(page, 'Stairmaster');
    await stairs.locator('.cue', { hasText: 'don’t hold on' }).waitFor();
    assert.equal(await stairs.getByRole('textbox', { name: 'Level', exact: true }).inputValue(), '8');
    assert.equal(await stairs.getByRole('textbox', { name: 'Speed (mph)', exact: true }).count(), 0);
    await stairs.getByRole('button', { name: 'Increase Level' }).click();
    // HIIT options are in the cardio swap list and log intervals.
    await stairs.getByRole('button', { name: /Swap Stairmaster/ }).click();
    await page.locator('.pick', { hasText: 'HIIT Elliptical' }).click();
    const hiit = card(page, 'HIIT Elliptical');
    await hiit.locator('.cue', { hasText: 'Level 12–15' }).waitFor();
    assert.equal(await hiit.getByRole('textbox', { name: 'Intervals', exact: true }).inputValue(), '6');
    await hiit.getByRole('button', { name: 'Increase Intervals' }).click();
    await serverHas(page, (s) => todayEntry(s, 'hiit-elliptical')?.cardio.rounds === 7);

    // Interval timer: no warm-up/cool-down, 2 rounds of 45 s hard / 90 s easy.
    await hiit.getByRole('button', { name: '⏱ Interval timer' }).click();
    const setup = page.locator('.hiit-setup');
    for (let i = 0; i < 4; i++) await setup.getByRole('button', { name: 'Decrease Warm-up (min)' }).click();
    for (let i = 0; i < 4; i++) await setup.getByRole('button', { name: 'Decrease Cool-down (min)' }).click();
    for (let i = 0; i < 5; i++) await setup.getByRole('button', { name: 'Decrease Rounds' }).click();
    assert.equal(await setup.getByRole('textbox', { name: 'Rounds' }).inputValue(), '2');
    await setup.getByRole('button', { name: 'Start' }).click();
    const bar = page.locator('#hiit');
    await bar.locator('[data-hiit-label]', { hasText: 'Hard 1/2' }).waitFor();
    assert.equal(await bar.getAttribute('data-kind'), 'hard');
    await bar.locator('[data-hiit-time]', { hasText: '0:45' }).waitFor();
    await page.clock.runFor(46000);
    await bar.locator('[data-hiit-label]', { hasText: 'Easy 1/2' }).waitFor();
    // Pause holds the time; skip jumps to the next interval.
    await bar.getByRole('button', { name: 'Pause' }).click();
    const frozen = await bar.locator('[data-hiit-time]').textContent();
    await page.clock.runFor(20000);
    assert.equal(await bar.locator('[data-hiit-time]').textContent(), frozen);
    await bar.getByRole('button', { name: 'Resume' }).click();
    await bar.getByRole('button', { name: 'Skip to next interval' }).click();
    await bar.locator('[data-hiit-label]', { hasText: 'Hard 2/2' }).waitFor();
    await page.clock.runFor(136000);
    await page.locator('#toast', { hasText: 'HIIT logged: 2 intervals' }).waitFor();
    assert.equal(await bar.isHidden(), true);
    await serverHas(page, (s) => todayEntry(s, 'hiit-elliptical')?.cardio.rounds === 2 && todayEntry(s, 'hiit-elliptical').cardio.done);
    await hiit.getByRole('button', { name: /Swap HIIT Elliptical/ }).click();
    await page.locator('.pick', { hasText: 'Stairmaster' }).click();
    await card(page, 'Stairmaster').getByRole('button', { name: 'Increase Level' }).click();
    // Metric is available in Settings; US units are the default.
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'lb', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'mi · mph' }).getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: 'km · km/h' }).click();
    await page.getByRole('button', { name: 'Log', exact: true }).click();
    await card(page, 'Seated Bike').getByText('Distance (km)').first().waitFor();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'mi · mph' }).click();
    await serverHas(page, (s) => todayEntry(s, 'stairmaster')?.cardio.level === 9 && todayEntry(s, 'incline-db-press').sets.some((x) => x.done));
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('exercises tab lists exercises with playable form videos', async () => {
    const { context, page, errors } = await openApp();
    // Form video link right on the Log card.
    await card(page, 'Skull Crusher').getByRole('button', { name: '▶ Form video' }).click();
    assert.match(await page.locator('.sheet-panel iframe').getAttribute('src'), /youtube-nocookie\.com\/embed\/Hdx3L8vjeeA/);
    await page.locator('.sheet-panel').getByRole('button', { name: 'Close', exact: true }).click();

    await page.getByRole('button', { name: 'Exercises', exact: true }).click();
    await page.getByText('Full workouts').waitFor();
    assert.equal(await page.locator('.video-tile', { hasText: 'Glute workout with bands' }).count(), 1);
    await page.locator('[data-field="lib-q"]').fill('hang clean');
    await page.locator('.lib-ex h3', { hasText: 'Hang Clean' }).waitFor();
    assert.equal(await page.locator('.lib-ex').count(), 1);
    await page.getByRole('button', { name: 'Play video: Hang cleans' }).click();
    assert.match(await page.locator('.sheet-panel iframe').getAttribute('src'), /embed\/eVWbmwSg5CE/);
    assert.equal(await page.getByRole('link', { name: 'Open in YouTube' }).getAttribute('href'), 'https://youtu.be/eVWbmwSg5CE');
    await page.locator('.sheet-panel').getByRole('button', { name: 'Close', exact: true }).click();
    // Filter by group and add one to today's log.
    await page.locator('[data-field="lib-q"]').fill('');
    await page.getByRole('button', { name: 'Glutes', exact: true }).click();
    await page.locator('.lib-ex', { hasText: 'Frog Pump' }).getByRole('button', { name: '+ Add to today' }).click();
    await page.getByRole('button', { name: 'Log', exact: true }).click();
    await card(page, 'Frog Pump').waitFor();
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('removing an exercise can be undone', async () => {
    const { context, page, errors } = await openApp();
    await card(page, 'Dips').getByRole('button', { name: 'Remove Dips' }).click();
    assert.equal(await card(page, 'Dips').count(), 0);
    await page.locator('#toast-action').click();
    await card(page, 'Dips').waitFor();
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('editing the plan changes future days', async () => {
    const { context, page, errors } = await openApp(PHONE, '#plan');
    const day4 = page.locator('article.planday', { has: page.locator('.wdname', { hasText: 'Day 4' }) });
    const name = page.getByRole('textbox', { name: 'Day 4 name' });
    await name.fill('Recovery');
    await name.press('Enter');
    await day4.getByRole('button', { name: '+ Add exercise' }).click();
    await page.locator('#sheet-q').fill('flutter');
    await page.locator('.pick', { hasText: 'Lying Flutter Kicks' }).click();
    await day4.getByText('Lying Flutter Kicks').waitFor();

    // Advanced options: give an item a rest time and a note.
    const item = day4.locator('.planitem', { hasText: 'Lying Flutter Kicks' });
    await item.getByRole('button', { name: /More options/ }).click();
    await item.getByRole('button', { name: 'Increase Rest (0=default)' }).click();
    const note = item.locator('input[data-field="plan-note"]');
    await note.fill('Slow and controlled');
    await note.press('Enter');
    await item.getByText('rest 15s').waitFor();
    await shot(page, '04-plan');

    // Day 4 this week (Thursday Oct 8) follows the new plan.
    await page.getByRole('button', { name: 'Log', exact: true }).click();
    await page.locator('.weekstrip button').nth(3).click();
    assert.equal(await page.locator('.dayname').inputValue(), 'Recovery');
    await card(page, 'Lying Flutter Kicks').locator('.cue', { hasText: 'Slow and controlled' }).waitFor();
    await noHorizontalScroll(page);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('progress view shows charts, body weight and history', async () => {
    const { context, page, errors } = await openApp(PHONE, '#progress');
    await page.locator('#chart-activity svg').waitFor();
    await page.locator('#chart-body svg').waitFor();
    await page.locator('select[data-field="progress-exercise"]').selectOption('flat-press');
    await page.locator('#chart-exercise svg').waitFor();
    await page.getByRole('button', { name: 'Top weight' }).click();
    await page.locator('.prs').getByText('Heaviest set').waitFor();
    await page.locator('.table td', { hasText: '9' }).first().waitFor(); // RPE column
    await page.locator('.history-item').first().waitFor();
    for (const r of ['1W', '4W', '6M', '1Y', 'All']) await page.getByRole('button', { name: r, exact: true }).click();
    await shot(page, '05-progress');
    await noHorizontalScroll(page);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('data syncs between devices and settings apply', async () => {
    const desktop = await openApp(DESKTOP);
    await card(desktop.page, FLAT).locator('.count', { hasText: '2/4' }).waitFor();
    await shot(desktop.page, '06-log-desktop');

    await desktop.page.getByRole('button', { name: 'Settings' }).click();
    await desktop.page.getByRole('button', { name: 'Increase restSec' }).click();
    await serverHas(desktop.page, (s) => s.settings.restSec === 105);
    await shot(desktop.page, '07-settings');

    const phone = await openApp(PHONE);
    await card(phone.page, FLAT).getByRole('button', { name: /Complete next set/ }).click();
    await phone.page.locator('#rest [data-rest-time]', { hasText: '1:45' }).waitFor();
    await serverHas(phone.page, (s) => todayEntry(s, 'flat-press').sets.filter((x) => x.done).length === 3);
    await noHorizontalScroll(desktop.page);
    assert.deepEqual([...desktop.errors, ...phone.errors], []);
    await desktop.context.close();
    await phone.context.close();
  });

  test('works offline from local storage', async () => {
    const { context, page } = await openApp();
    await context.setOffline(true);
    await card(page, FLAT).getByRole('button', { name: /Complete next set/ }).click();
    await page.clock.runFor(1500);
    await page.waitForSelector('#sync[data-status="offline"]');
    await page.reload();
    await card(page, FLAT).locator('.count', { hasText: '4/4' }).waitFor();
    await context.setOffline(false);
    await page.evaluate(() => window.logbook.store.sync());
    await serverHas(page, (s) => todayEntry(s, 'flat-press').sets.filter((x) => x.done).length === 4);
    await context.close();
  });

  test('pull down to sync, and the logo goes to today', async () => {
    const { context, page, errors } = await openApp();
    // A short pull does nothing; a long one syncs.
    const drag = (dy) =>
      page.evaluate((dy) => {
        const t = (y) => new Touch({ identifier: 1, target: document.body, clientX: 180, clientY: y });
        const fire = (type, y) => document.dispatchEvent(new TouchEvent(type, { touches: type === 'touchend' ? [] : [t(y)], changedTouches: [t(y)], bubbles: true }));
        fire('touchstart', 120);
        for (let y = 120; y <= 120 + dy; y += 20) fire('touchmove', y);
        fire('touchend', 120 + dy);
      }, dy);
    let puts = 0;
    page.on('request', (r) => r.method() === 'PUT' && r.url().endsWith('/api/state') && puts++);
    await drag(60);
    await page.waitForTimeout(200);
    assert.equal(puts, 0);
    await drag(220);
    await page.locator('#toast', { hasText: 'Synced' }).waitFor();
    assert.equal(puts, 1);

    // Tapping "Logbook" returns to today's log from anywhere.
    await page.getByRole('button', { name: 'Next day' }).click();
    await page.getByRole('button', { name: 'Plan', exact: true }).click();
    await page.getByRole('button', { name: /Logbook: go to today/ }).click();
    await page.locator('.today-pill').waitFor();
    assert.equal(await page.locator('.tabbar [aria-current="page"]').textContent().then((t) => t.trim()), 'Log');
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('nothing is wider than a small phone screen (no zoom-out)', async () => {
    const meta = await (await fetch(`${base}/`)).text();
    assert.match(meta, /minimum-scale=1, maximum-scale=1, user-scalable=no/);
    for (const width of [320, 390]) {
      const { context, page, errors } = await openApp({ ...PHONE, viewport: { width, height: 800 } });
      // Day 3 has the longest name in the rotation picker.
      await page.locator('.weekstrip button').nth(2).click();
      await page.locator('.dayname[value^="Shoulders"]').waitFor();
      for (const tab of ['Log', 'Plan', 'Exercises', 'Progress', 'Settings']) {
        await page.getByRole('button', { name: tab, exact: true }).click();
        await page.waitForTimeout(100);
        const wide = await page.evaluate(() => {
          const vw = document.documentElement.clientWidth;
          // Ignore content inside horizontally scrolling segmented controls.
          return [...document.querySelectorAll('body *')]
            .filter((el) => !el.closest('.seg') && el.getClientRects().length)
            .filter((el) => el.getBoundingClientRect().right > vw + 0.5)
            .map((el) => `${el.tagName}.${el.className}`)
            .slice(0, 5);
        });
        assert.deepEqual(wide, [], `${tab} at ${width}px overflows: ${wide.join(', ')}`);
        await noHorizontalScroll(page);
      }
      assert.deepEqual(errors, []);
      await context.close();
    }
  });

  test('the rotation can be re-anchored after a missed day', async () => {
    const { context, page, errors } = await openApp();
    // Tomorrow would be Day 2; say we skipped and tomorrow is Day 1 again.
    await page.getByRole('button', { name: 'Next day' }).click();
    assert.equal(await page.locator('.dayname').inputValue(), 'Back & Biceps');
    await page.locator('select[data-field="plan-day"]').selectOption('0');
    await page.locator('.dayname[value="Chest & Triceps"]').waitFor();
    // The day after that is now Day 2, and today's logged session is untouched.
    await page.getByRole('button', { name: 'Next day' }).click();
    assert.equal(await page.locator('.dayname').inputValue(), 'Back & Biceps');
    const s = await serverHas(page, (st) => st.settings.cycleStart === '2026-10-06');
    assert.equal(s.sessions[TODAY].name, 'Chest & Triceps');
    assert.deepEqual(errors, []);
    await context.close();
  });
});
