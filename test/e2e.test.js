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

const TODAY = '2026-10-05'; // Monday ("Push" in the default plan)
const LAST_WEEK = '2026-09-28';
const SHOTS = process.env.SCREENSHOTS;

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
    // Seed last week's bench session so the intensity tracker has history.
    const seed = defaultState(1);
    seed.sessions[LAST_WEEK] = {
      date: LAST_WEEK,
      name: 'Push',
      dayType: 'training',
      notes: '',
      updatedAt: 1,
      entries: [
        {
          id: 'e1',
          exerciseId: 'bench',
          kind: 'strength',
          notes: '',
          target: { sets: 3, reps: 8, weight: 0 },
          sets: [1, 2, 3].map((i) => ({ id: `s${i}`, weight: 185, reps: 8, done: true })),
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

  test('logs sets with +/- controls, steppers and typing', async () => {
    const { context, page, errors } = await openApp();
    await page.getByText('Monday', { exact: false }).first().waitFor();
    assert.equal(await page.locator('.dayname').inputValue(), 'Push');

    const bench = card(page, 'Bench Press');
    // Pre-filled from last week's 185 lb, with the intensity tracker comparing.
    assert.equal(await bench.locator('.set-row input').first().inputValue(), '185');
    await bench.locator('.intensity').getByText('Last · Sep 28').waitFor();
    await shot(page, '01-log-phone');

    // "+" completes the next set, "−" undoes it.
    await bench.getByRole('button', { name: /Complete next set/ }).click();
    await bench.locator('.count', { hasText: '1/4' }).waitFor();
    await bench.getByRole('button', { name: /Complete next set/ }).click();
    await bench.getByRole('button', { name: /Undo last completed set/ }).click();
    await bench.locator('.count', { hasText: '1/4' }).waitFor();

    // Weight stepper on set 2: 185 -> 190.
    await card(page, 'Bench Press').locator('.set-row').nth(1).getByRole('button', { name: 'Increase weight' }).click();
    assert.equal(await card(page, 'Bench Press').locator('.set-row').nth(1).locator('input').first().inputValue(), '190');

    // Type reps directly into set 2, then tick it done.
    const reps = card(page, 'Bench Press').locator('.set-row').nth(1).locator('input').nth(1);
    await reps.fill('6');
    await reps.press('Enter');
    await page.waitForTimeout(50);
    await card(page, 'Bench Press').locator('.set-row').nth(1).getByRole('button', { name: 'Set 2 done' }).click();
    await card(page, 'Bench Press').locator('.count', { hasText: '2/4' }).waitFor();

    // Wait for the debounced sync and check the server.
    const benchSets = (s) => s.sessions[TODAY].entries.find((e) => e.exerciseId === 'bench').sets.slice(0, 2).map((x) => [x.weight, x.reps, x.done]);
    await serverHas(page, (s) => JSON.stringify(benchSets(s)) === JSON.stringify([[185, 8, true], [190, 6, true]]));

    await noHorizontalScroll(page);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('targets can be changed for this week only', async () => {
    const { context, page, errors } = await openApp();
    const bench = () => card(page, 'Bench Press');
    await bench().getByRole('button', { name: 'Edit target' }).click();
    await bench().locator('.target-edit').waitFor();
    await bench().locator('.target-edit').getByRole('button', { name: 'Increase Sets' }).click();
    await bench().locator('.count', { hasText: '2/5' }).waitFor();
    await bench().locator('.target-edit').getByText('Last time (Mon, Sep 28)').waitFor();
    await bench().locator('.target-edit .delta.up', { hasText: '+2 sets' }).waitFor();
    await shot(page, '02-target-edit');
    await bench().locator('.target-edit').getByRole('button', { name: 'Decrease Sets' }).click();
    await bench().locator('.count', { hasText: '2/4' }).waitFor();

    // The weekly plan is untouched.
    const s = await serverHas(page, (st) => st.sessions[TODAY].entries.find((e) => e.exerciseId === 'bench').target.sets === 4);
    assert.equal(s.plan[1].items[0].sets, 4);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('cardio, vacuum timer and adding exercises', async () => {
    const { context, page, errors } = await openApp();

    // Add cardio from the picker.
    await page.getByRole('button', { name: /Add exercise, cardio or vacuum/ }).click();
    await page.locator('#sheet-q').fill('tread');
    await page.locator('.pick', { hasText: 'Treadmill' }).click();
    const tread = card(page, 'Treadmill');
    await tread.waitFor();
    await tread.getByRole('button', { name: 'Increase Minutes' }).click();
    await tread.getByRole('button', { name: 'Mark cardio complete' }).click();
    await card(page, 'Treadmill').locator('.count', { hasText: '1/1' }).waitFor();

    // Create a brand-new exercise.
    await page.getByRole('button', { name: /Add exercise, cardio or vacuum/ }).click();
    await page.locator('#sheet-q').fill('Hanging Leg Raise');
    await page.getByRole('button', { name: 'Strength', exact: true }).last().click();
    await card(page, 'Hanging Leg Raise').waitFor();

    // Vacuum hold timer.
    const vac = card(page, 'Stomach Vacuum (standing)');
    await vac.getByRole('button', { name: 'Start hold timer' }).first().click();
    await page.clock.runFor(12000);
    await card(page, 'Stomach Vacuum (standing)').locator('[data-timer]').filter({ hasText: /1[12]s/ }).waitFor();
    await card(page, 'Stomach Vacuum (standing)').getByRole('button', { name: 'Stop timer and log hold' }).click();
    const first = card(page, 'Stomach Vacuum (standing)').locator('.set-row').first();
    assert.equal(await first.locator('input').inputValue(), '12');
    assert.equal(await first.locator('.check').getAttribute('aria-pressed'), 'true');
    await shot(page, '03-cardio-vacuum');

    // Day type.
    await page.getByRole('button', { name: 'Active rest', exact: true }).click();
    await serverHas(page, (s) => s.sessions[TODAY].dayType === 'active' && s.sessions[TODAY].entries.some((e) => e.exerciseId === 'treadmill' && e.cardio.done && e.cardio.minutes === 21));
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('removing an exercise can be undone', async () => {
    const { context, page, errors } = await openApp();
    await card(page, 'Overhead Press').getByRole('button', { name: 'Remove Overhead Press' }).click();
    assert.equal(await card(page, 'Overhead Press').count(), 0);
    await page.locator('#toast-action').click();
    await card(page, 'Overhead Press').waitFor();
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('editing the weekly plan changes future days', async () => {
    const { context, page, errors } = await openApp(PHONE, '#plan');
    const thursday = page.locator('article.planday', { has: page.locator('.wdname', { hasText: 'Thursday' }) });
    const name = page.getByRole('textbox', { name: 'Thursday name' });
    await name.fill('Mobility');
    await name.press('Enter');
    await thursday.getByRole('button', { name: '+ Add exercise' }).click();
    await page.locator('#sheet-q').fill('Rowing');
    await page.locator('.pick', { hasText: 'Rowing Machine' }).click();
    await thursday.getByText('Rowing Machine').waitFor();
    await shot(page, '04-plan');

    // Thursday this week in the log follows the new plan.
    await page.getByRole('button', { name: 'Log' }).click();
    await page.locator('.weekstrip button').nth(3).click();
    assert.equal(await page.locator('.dayname').inputValue(), 'Mobility');
    await card(page, 'Rowing Machine').waitFor();
    await noHorizontalScroll(page);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('progress view shows charts and history', async () => {
    const { context, page, errors } = await openApp(PHONE, '#progress');
    await page.locator('#chart-activity svg').waitFor();
    await page.locator('#chart-exercise svg').waitFor();
    await page.locator('select[data-field="progress-exercise"]').selectOption('bench');
    await page.getByRole('button', { name: 'Top weight' }).click();
    await page.locator('.prs').getByText('Heaviest set').waitFor();
    await page.locator('.history-item').first().waitFor();
    for (const r of ['1W', '4W', '6M', '1Y', 'All']) await page.getByRole('button', { name: r, exact: true }).click();
    await shot(page, '05-progress');
    await noHorizontalScroll(page);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('data syncs between devices and settings apply', async () => {
    const desktop = await openApp(DESKTOP);
    // Logged on the "phone" in earlier tests; visible on desktop.
    await card(desktop.page, 'Bench Press').locator('.count', { hasText: '2/4' }).waitFor();
    await shot(desktop.page, '06-log-desktop');

    await desktop.page.getByRole('button', { name: 'Settings' }).click();
    await desktop.page.getByRole('button', { name: 'kg', exact: true }).click();
    await serverHas(desktop.page, (s) => s.settings.unit === 'kg');
    await shot(desktop.page, '07-settings');

    const phone = await openApp(PHONE);
    await card(phone.page, 'Bench Press').getByText('Weight (kg)').waitFor();
    await noHorizontalScroll(desktop.page);
    assert.deepEqual([...desktop.errors, ...phone.errors], []);
    await desktop.context.close();
    await phone.context.close();
  });

  test('works offline from local storage', async () => {
    const { context, page } = await openApp();
    await context.setOffline(true);
    await card(page, 'Bench Press').getByRole('button', { name: /Complete next set/ }).click();
    await page.clock.runFor(1500);
    await page.waitForSelector('#sync[data-status="offline"]');
    await page.reload();
    await card(page, 'Bench Press').locator('.count', { hasText: '3/4' }).waitFor();
    // Back online: the change reaches the server.
    await context.setOffline(false);
    await page.evaluate(() => window.logbook.store.sync());
    await serverHas(page, (s) => s.sessions[TODAY].entries.find((e) => e.exerciseId === 'bench').sets.filter((x) => x.done).length === 3);
    await context.close();
  });
});
