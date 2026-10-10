import * as M from './model.js';
import { VIDEOS, WORKOUT_VIDEOS, youtubeId } from './program.js';
import { createStore } from './store.js';
import { lineChart, barChart, hideTip } from './charts.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const $view = document.getElementById('view');
const $sheet = document.getElementById('sheet');
const $sheetPanel = $sheet.querySelector('.sheet-panel');
const $rest = document.getElementById('rest');

const TABS = ['log', 'plan', 'exercises', 'progress', 'settings'];
const ui = {
  tab: TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'log',
  date: M.todayISO(),
  editing: new Set(), // entry ids with the target editor open
  planMore: new Set(), // plan item ids with advanced options open
  lib: { q: '', group: 'All' },
  // `month` is the consistency calendar's 'YYYY-MM'; null follows the current month.
  progress: { range: '3m', exerciseId: null, picked: false, metric: null, chart: 'volume', month: null },
  sheet: null,
};

// Unsaved drafts (days built from the plan) are cached so the entry ids
// in the DOM stay valid until the first edit stores them.
const drafts = new Map();
const charts = [];
let holdTimer = null; // running vacuum / plank hold timer
let pendingRender = false;

const store = await createStore({
  // Redraws after a change, waiting while the user types if the change came from a sync.
  onChange({ remote }) {
    // Drafts are dropped in render(), so ids in the DOM stay valid until the
    // page is redrawn (a sync can arrive while you're typing).
    if (remote && isTyping()) pendingRender = true;
    else render();
  },
  onSyncStatus: renderSync,
});

// Returns the current logbook state.
const S = () => store.state;
// Returns the chosen weight unit (lb or kg).
const unit = () => S().settings.unit;
// Returns the chosen distance unit (mi or km).
const dunit = () => S().settings.distanceUnit;

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

// Escapes text so it is safe to put inside HTML.
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const nf1 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
// Formats a number with up to two decimals for display.
const fmt = (n) => nf.format(Number(n) || 0);
const nfCompact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
// Formats a number, shortening big ones (e.g. 12.5K).
const fmtCompact = (n) => (Math.abs(n) >= 10000 ? nfCompact.format(n) : fmt(n));

// Formats seconds as a short duration like "45s", "2m 30s" or "1h 5m".
function fmtSec(sec) {
  sec = Math.round(sec || 0);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// Formats seconds as a clock like "1:05".
function fmtClock(sec) {
  sec = Math.max(0, Math.round(sec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

// Formats minutes per mile/km as a pace like "12:30/mi".
function fmtPace(minPerUnit) {
  if (!minPerUnit) return '–';
  const m = Math.floor(minPerUnit);
  const s = Math.round((minPerUnit - m) * 60);
  return `${m}:${String(s).padStart(2, '0')}/${dunit()}`;
}

// toLocaleDateString builds a new formatter on every call, which adds up
// across charts and history lists; reuse one per set of options.
const dateFormats = new Map();
// Formats a YYYY-MM-DD date for display with the given Intl options.
function fmtDate(iso, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
  const key = JSON.stringify(opts);
  let f = dateFormats.get(key);
  if (!f) dateFormats.set(key, (f = new Intl.DateTimeFormat(undefined, opts)));
  return f.format(M.parseISODate(iso));
}

// Returns the speed unit label for the chosen distance unit.
const speedUnit = () => (dunit() === 'km' ? 'km/h' : 'mph');
const CARDIO_LABEL = {
  get speed() {
    return `Speed (${speedUnit()})`;
  },
  incline: 'Incline',
  level: 'Level',
  rounds: 'Intervals',
};

// Formats a number or a "low–high" range.
const range = (lo, hi) => (hi && hi > lo ? `${fmt(lo)}–${fmt(hi)}` : fmt(lo));

/** Cardio settings as text, e.g. "incline 12 · 3 mph" or "level 8". */
function cardioSettingsText(c) {
  return [c.incline ? `incline ${fmt(c.incline)}` : '', c.speed ? `${fmt(c.speed)} ${speedUnit()}` : '', c.level ? `level ${fmt(c.level)}` : '', c.rounds ? `${fmt(c.rounds)} intervals` : ''].filter(Boolean).join(' · ');
}

// Describes an exercise target as text, e.g. "3 × 8–10 @ 135 lb".
function targetText(t, kind) {
  if (kind === 'cardio') {
    const bits = [`${fmt(t.minutes)} min`, cardioSettingsText(t), t.distance ? `${fmt(t.distance)} ${dunit()}` : ''];
    return bits.filter(Boolean).join(' · ');
  }
  if (M.isHold(kind)) return `${range(t.sets, t.setsMax)} × ${fmtSec(t.holdSec)} hold`;
  const reps = t.repScheme ? t.repScheme.join('/') : range(t.reps, t.repsMax);
  const sets = t.repScheme ? '' : `${range(t.sets, t.setsMax)} × `;
  let s = `${sets}${reps}${t.weight ? ` @ ${fmt(t.weight)} ${unit()}` : ''}`;
  if (t.warmupSets) s = `${t.warmupSets} warm-up + ${s}`;
  if (t.dropSets) s += ` + ${t.dropSets} drop`;
  if (t.failureSets) s += ` + ${t.failureSets} to failure`;
  return s;
}

// Formats an intensity load value for an exercise kind (minutes, hold time or weight).
function loadText(kind, v) {
  if (kind === 'cardio') return `${fmt(v)} min`;
  if (M.isHold(kind)) return fmtSec(v);
  return `${fmtCompact(v)} ${unit()}`;
}

// Shows the percent change from a previous value as an up/down badge.
function deltaHTML(cur, prev, suffix = '') {
  if (!prev) return '';
  const pct = ((cur - prev) / prev) * 100;
  if (Math.abs(pct) < 0.5) return `<span class="delta flat">= same${suffix}</span>`;
  const cls = pct > 0 ? 'up' : 'down';
  return `<span class="delta ${cls}">${pct > 0 ? '▲' : '▼'} ${Math.abs(pct).toFixed(1)}%${suffix}</span>`;
}

// Summarizes the sets done in an entry as text, e.g. "135×10, 155×8".
function setSummary(entry) {
  if (entry.kind === 'cardio') {
    const c = entry.cardio;
    return `${fmt(c.minutes)} min${c.distance ? `, ${fmt(c.distance)} ${dunit()}` : ''}`;
  }
  const done = entry.sets.filter((s) => s.done && s.type !== 'warmup');
  if (M.isHold(entry.kind)) return done.map((s) => fmtSec(s.holdSec)).join(', ');
  return done.map((s) => `${fmt(s.weight)}×${fmt(s.reps)}${s.type ? M.SET_TYPES[s.type].short.toLowerCase() : ''}`).join(', ');
}

const ICON = {
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z" fill="currentColor"/></svg>',
  left: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4-4.6-4.6z" fill="currentColor"/></svg>',
  right: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.6 16.6 10 18l6-6-6-6-1.4 1.4 4.6 4.6z" fill="currentColor"/></svg>',
  up: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.4 15.4 12 10.8l4.6 4.6L18 14l-6-6-6 6z" fill="currentColor"/></svg>',
  down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.4 8.6 12 13.2l4.6-4.6L18 10l-6 6-6-6z" fill="currentColor"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z" fill="currentColor"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6z" fill="currentColor"/></svg>',
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>',
  stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6h12v12H6z" fill="currentColor"/></svg>',
  swap: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h11l-3-3 1.4-1.4L22 8l-5.6 5.4L15 12l3-3H7zm10 10H6l3 3-1.4 1.4L2 16l5.6-5.4L9 12l-3 3h11z" fill="currentColor"/></svg>',
  link: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.9 12a3.1 3.1 0 0 1 3.1-3.1h4V7H7a5 5 0 0 0 0 10h4v-1.9H7A3.1 3.1 0 0 1 3.9 12zM8 13h8v-2H8zm9-6h-4v1.9h4a3.1 3.1 0 0 1 0 6.2h-4V17h4a5 5 0 0 0 0-10z" fill="currentColor"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true" width="20" height="20"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z" fill="currentColor"/></svg>',
  scale: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm7 3a6 6 0 0 0-5.7 4h3.2l2.3-2.3 1.4 1.4-.9.9h5.4A6 6 0 0 0 12 6z" fill="currentColor"/></svg>',
  flame: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.48 12.35c-1.57-4.08-7.16-4.3-5.81-10.23.1-.44-.37-.78-.75-.55C9.29 3.71 6.68 8 8.87 13.62c.18.46-.36.89-.75.59-1.81-1.37-2-3.34-1.84-4.75.06-.52-.62-.77-.91-.34C4.69 10.16 4 11.84 4 14.37c.38 5.6 5.11 7.32 6.81 7.54 2.43.31 5.06-.14 6.95-1.87 2.08-1.93 2.84-5.01 1.72-7.69zm-9.28 5.03c1.44-.35 2.18-1.39 2.38-2.31.33-1.43-.96-2.83-.09-5.09.33 1.87 3.27 3.04 3.27 5.08.08 2.53-2.66 4.7-5.56 2.32z" fill="currentColor"/></svg>',
};

// ---------------------------------------------------------------------------
// Steppers: one generic control for every number in the app
// ---------------------------------------------------------------------------

// Functions returning how much one −/+ tap changes each kind of value.
const STEP = {
  weight: () => S().settings.weightStep,
  reps: () => 1,
  repsMax: () => 1,
  sets: () => 1,
  setsMax: () => 1,
  warmupSets: () => 1,
  dropSets: () => 1,
  failureSets: () => 1,
  restSec: () => 15,
  holdSec: () => 5,
  minutes: () => 1,
  distance: () => 0.1,
  speed: () => 0.1,
  incline: () => 0.5,
  level: () => 1,
  rounds: () => 1,
  calories: () => 10,
  avgHr: () => 1,
};
const INTEGER = new Set(['reps', 'repsMax', 'sets', 'setsMax', 'warmupSets', 'dropSets', 'failureSets', 'restSec', 'restCompound', 'restIsolation', 'holdSec', 'calories', 'avgHr', 'cycleLength', 'level', 'rounds']);
const MAX = { sets: 50, setsMax: 50, reps: 1000, repsMax: 1000, warmupSets: 10, dropSets: 10, failureSets: 10, restSec: 1800, holdSec: 3600, avgHr: 260, speed: 30, incline: 40, level: 30, rounds: 50 };

// Clamps and rounds a typed or stepped value to what the field allows.
function cleanValue(key, v) {
  v = Math.max(0, Math.min(MAX[key] ?? 100000, Number(v) || 0));
  return INTEGER.has(key) ? Math.round(v) : M.round(v, 2);
}

// Builds a −/+ stepper with a number box for any value in the app.
function stepper({ scope, key, value, label = '', entry = '', set = '', wd = '', item = '', sm = false, placeholder = '' }) {
  const a = `data-scope="${scope}" data-key="${key}" data-entry="${esc(entry)}" data-set="${esc(set)}" data-wd="${wd}" data-item="${esc(item)}"`;
  const name = esc(label || key);
  return `<div class="stepper-wrap">${label ? `<span class="label">${esc(label)}</span>` : ''}
    <div class="stepper${sm ? ' sm' : ''}">
      <button type="button" data-action="step" data-delta="-1" ${a} aria-label="Decrease ${name}">−</button>
      <input type="text" inputmode="decimal" autocomplete="off" data-field="value" ${a} value="${value === '' ? '' : esc(fmtInput(value))}" placeholder="${esc(placeholder)}" aria-label="${name}">
      <button type="button" data-action="step" data-delta="1" ${a} aria-label="Increase ${name}">+</button>
    </div></div>`;
}

// Formats a number for an input box (no thousands separators).
function fmtInput(v) {
  return String(M.round(Number(v) || 0, 2));
}

const SETTING_RULES = {
  weightStep: { step: 0.5, min: 0.25, max: 100 },
  restSec: { step: 15, min: 0, max: 900 },
  restCompound: { step: 15, min: 15, max: M.REST_CLASSES.compound.max },
  restIsolation: { step: 15, min: 15, max: M.REST_CLASSES.isolation.max },
  cycleLength: { step: 1, min: 2, max: M.MAX_PLAN_DAYS },
};

/** Apply a numeric change described by a stepper's data attributes. */
function changeValue(d, fn) {
  const { scope, key } = d;
  const step = STEP[key]?.() ?? 1;
  if (scope === 'plan') {
    store.update((s) => {
      const day = s.plan[d.wd];
      const it = day?.items.find((i) => i.id === d.item);
      if (!it) return;
      it[key] = cleanValue(key, fn(it[key] || 0, step));
      // Rest never goes past the maximum for the lift type.
      if (key === 'restSec') it[key] = Math.min(it[key], M.restMax(s, it.exerciseId));
      // Editing sets or reps by hand replaces a pyramid scheme.
      if ((key === 'sets' || key === 'reps') && it.repScheme) delete it.repScheme;
      day.updatedAt = Date.now();
    });
    return;
  }
  if (scope === 'setting') {
    const r = SETTING_RULES[key];
    store.update((s) => {
      const v = Math.min(r.max, Math.max(r.min, Number(fn(s.settings[key] || 0, r.step)) || 0));
      s.settings[key] = INTEGER.has(key) ? Math.round(v) : M.round(v, 2);
      s.settings.updatedAt = Date.now();
    });
    return;
  }
  if (scope === 'hiit') {
    // Interval timer setup lives only in the setup sheet until you press Start.
    const r = { warmMin: [0, 30, 1], workSec: [5, 600, 5], easySec: [5, 600, 5], rounds: [1, 50, 1], coolMin: [0, 30, 1] }[key];
    ui.hiitSetup.cfg[key] = Math.min(r[1], Math.max(r[0], Math.round(Number(fn(ui.hiitSetup.cfg[key] || 0, r[2])) || 0)));
    renderHiitSetup();
    return;
  }
  if (scope === 'body') {
    store.update((s) => {
      const cur = M.bodyWeightOn(s, ui.date) || M.previousBodyWeight(s, ui.date)?.weight || 0;
      M.setBodyWeight(s, ui.date, Math.max(0, M.round(fn(cur, 0.2), 1)));
    });
    return;
  }
  editEntry(d.entry, (e) => {
    if (scope === 'set') {
      const x = e.sets.find((s) => s.id === d.set);
      if (x) x[key] = cleanValue(key, fn(x[key] || 0, step));
    } else if (scope === 'cardio') {
      e.cardio[key] = cleanValue(key, fn(e.cardio[key] || 0, step));
    } else if (scope === 'target') {
      let v = cleanValue(key, fn(e.target[key] || 0, step));
      if (key === 'restSec') v = Math.min(v, M.restMax(S(), e.exerciseId));
      if (key === 'sets' && e.kind !== 'cardio') {
        delete e.target.repScheme;
        M.setTargetSets(e, v);
      } else if (key === 'warmupSets') M.setTypedCount(e, 'warmup', v);
      else if (key === 'dropSets') M.setTypedCount(e, 'drop', v);
      else if (key === 'failureSets') M.setTypedCount(e, 'failure', v);
      else {
        e.target[key] = v;
        if (key === 'reps') delete e.target.repScheme;
        // New targets flow into the working sets you haven't done yet.
        if (e.sets && key !== 'restSec') for (const s of e.sets) if (!s.done && !s.type && key in s) s[key] = v;
        if (e.cardio && !e.cardio.done && key in e.cardio) e.cardio[key] = v;
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Session editing
// ---------------------------------------------------------------------------

// Returns the session for a date, or a cached draft built from the plan.
function dayData(date) {
  const stored = M.getSession(S(), date);
  if (stored) return { session: stored, draft: false };
  if (!drafts.has(date)) drafts.set(date, M.sessionOrDraft(S(), date).session);
  return { session: drafts.get(date), draft: true };
}

// Changes the session for a date (storing the draft first if needed) and saves.
function editSession(fn, date = ui.date) {
  store.update((s) => {
    let sess = M.getSession(s, date);
    if (!sess) {
      sess = drafts.get(date) || M.sessionOrDraft(s, date).session;
      s.sessions[date] = sess;
    }
    fn(sess, s);
    sess.updatedAt = Date.now();
  });
}

// Changes one entry of the current day’s session and saves.
function editEntry(entryId, fn) {
  editSession((sess, s) => {
    const e = M.findEntry(sess, entryId);
    if (e) fn(e, sess, s);
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// Tells whether the user is typing in a text field in the page or sheet.
function isTyping() {
  const a = document.activeElement;
  return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && ($view.contains(a) || $sheet.contains(a));
}

// Builds a key that identifies a field across re-renders, to keep focus on it.
function focusKey(n) {
  if (!n || !$view.contains(n) || !n.dataset) return null;
  const d = n.dataset;
  if (!d.field) return null;
  return ['field', 'scope', 'key', 'entry', 'set', 'wd', 'item', 'ex'].map((k) => d[k] ?? '').join('|');
}

// Redraws the current tab, keeping focus and caret in the same field.
function render() {
  pendingRender = false;
  drafts.clear();
  hideTip();
  // Keep focus (and caret) in the same logical field across re-renders.
  const active = document.activeElement;
  const key = focusKey(active);
  const sel = key && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;

  document.querySelectorAll('.tabbar [data-tab]').forEach((b) => b.toggleAttribute('aria-current', false));
  const cur = document.querySelector(`.tabbar [data-tab="${ui.tab}"]`);
  if (cur) cur.setAttribute('aria-current', 'page');

  charts.length = 0;
  $view.innerHTML = VIEWS[ui.tab]();
  drawCharts();

  if (key) {
    const match = [...$view.querySelectorAll('[data-field]')].find((n) => focusKey(n) === key);
    if (match) {
      match.focus({ preventScroll: true });
      if (sel) {
        try {
          match.setSelectionRange(...sel);
        } catch {
          /* not a text input */
        }
      }
    }
  }
  if (ui.sheet) renderSheetList();
}

// Draws the charts queued by the last render.
function drawCharts() {
  for (const c of charts) {
    const node = document.getElementById(c.id);
    if (node) c.draw(node);
  }
}

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(drawCharts, 150);
});

// Updates the sync badge (and the Settings sync note) for a new sync status.
function renderSync(status, detail) {
  const btn = document.getElementById('sync');
  const label = { local: 'This device', synced: 'Synced', syncing: 'Syncing…', offline: 'Offline', auth: 'Locked', error: 'Error' }[status] || status;
  btn.dataset.status = status;
  btn.title = detail || label;
  document.getElementById('sync-label').textContent = label;
  if (ui.tab === 'settings' && !isTyping()) {
    const n = document.getElementById('sync-detail');
    if (n) n.textContent = syncDetail();
  }
}

// Explains the current sync status in a sentence for Settings.
function syncDetail() {
  return {
    local: 'No server detected. Your data is saved in this browser only. Download backups regularly, or run the server to sync devices.',
    synced: 'Your logbook is saved on the server and in this browser.',
    syncing: 'Syncing…',
    offline: 'Saved in this browser. Changes will sync when the server is reachable.',
    auth: 'The server needs your password before it will sync. Enter it below.',
    error: 'Could not save in this browser. Download a backup.',
  }[store.status];
}

let toastTimer;
// Shows a short message at the bottom of the screen, optionally with an action button.
function toast(msg, action) {
  const t = document.getElementById('toast');
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button" id="toast-action">${esc(action.label)}</button>` : ''}`;
  t.classList.add('show');
  if (action) {
    document.getElementById('toast-action').onclick = () => {
      t.classList.remove('show');
      action.run();
    };
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), action ? 6000 : 2500);
}

// ---------------------------------------------------------------------------
// Rest timer (between sets)
// ---------------------------------------------------------------------------

const REST_KEY = 'workout-logbook:rest';
let rest = null; // { endsAt, total, label, done }
let restTick = null;
let audio = null;

try {
  const saved = JSON.parse(localStorage.getItem(REST_KEY) || 'null');
  if (saved && saved.endsAt > Date.now() - 10000) rest = saved;
} catch {
  /* ignore */
}

// Saves the running rest timer so it survives a reload.
function saveRest() {
  try {
    if (rest) localStorage.setItem(REST_KEY, JSON.stringify(rest));
    else localStorage.removeItem(REST_KEY);
  } catch {
    /* ignore */
  }
}

// Prepares audio on a tap, since browsers only allow sound after a user gesture.
function unlockAudio() {
  // Browsers only allow sound after a user gesture, so prepare it on taps.
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
  } catch {
    audio = null;
  }
}

// Plays a few short beeps if sounds are on.
function beep(freq = 880, count = 3) {
  if (!audio || !S().settings.restSound) return;
  try {
    const t0 = audio.currentTime;
    for (let i = 0; i < count; i++) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + i * 0.25);
      gain.gain.exponentialRampToValueAtTime(0.3, t0 + i * 0.25 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.25 + 0.18);
      osc.connect(gain).connect(audio.destination);
      osc.start(t0 + i * 0.25);
      osc.stop(t0 + i * 0.25 + 0.2);
    }
  } catch {
    /* ignore */
  }
}

// Starts the rest timer for the given number of seconds.
function startRest(sec, label, max = 1800) {
  if (!sec) return;
  rest = { endsAt: Date.now() + sec * 1000, total: sec, label, done: false, max };
  saveRest();
  buildRestBar();
}

// Stops and hides the rest timer.
function stopRest() {
  rest = null;
  saveRest();
  buildRestBar();
}

// Builds (or hides) the rest timer bar and starts its ticking.
function buildRestBar() {
  clearInterval(restTick);
  if (!rest) {
    $rest.hidden = true;
    $rest.innerHTML = '';
    if (!hiit) document.body.classList.remove('has-rest');
    return;
  }
  $rest.hidden = false;
  document.body.classList.add('has-rest');
  $rest.innerHTML = `
    <div class="rest-fill" data-rest-fill></div>
    <div class="rest-main">
      <div class="rest-text"><span class="label" data-rest-label>Rest</span><span class="rest-time" data-rest-time>0:00</span><span class="rest-sub">${esc(rest.label || '')}</span></div>
      <div class="rest-btns">
        <button type="button" class="btn sm" data-action="rest-add" data-delta="-15" aria-label="15 seconds less">−15</button>
        <button type="button" class="btn sm" data-action="rest-add" data-delta="15" aria-label="15 seconds more">+15</button>
        <button type="button" class="btn sm primary" data-action="rest-skip">Skip</button>
      </div>
    </div>`;
  updateRestBar();
  restTick = setInterval(updateRestBar, 250);
}

// Updates the rest timer countdown, and beeps and buzzes when rest is over.
function updateRestBar() {
  if (!rest) return;
  const left = (rest.endsAt - Date.now()) / 1000;
  const time = $rest.querySelector('[data-rest-time]');
  const label = $rest.querySelector('[data-rest-label]');
  const fill = $rest.querySelector('[data-rest-fill]');
  if (left > 0) {
    time.textContent = fmtClock(Math.ceil(left));
    fill.style.width = `${Math.max(0, Math.min(100, (1 - left / rest.total) * 100))}%`;
    $rest.classList.remove('is-done');
    return;
  }
  if (!rest.done) {
    rest.done = true;
    saveRest();
    beep();
    vibrate([200, 100, 200]);
  }
  $rest.classList.add('is-done');
  label.textContent = 'Rest over';
  time.textContent = 'Next set!';
  fill.style.width = '100%';
  if (left < -10) stopRest();
}

/**
 * After finishing a set: in a superset, go straight to the next exercise
 * (no rest); otherwise start the rest timer, if enabled.
 */
function restAfter(entry, date = ui.date) {
  const st = S().settings;
  const session = M.getSession(S(), date);
  const next = M.supersetNext(session, entry.id);
  if (next) {
    stopRest();
    // Just say where to go next; the page stays put so you scroll at your own pace.
    toast(`Superset: straight to ${M.exerciseName(S(), next.exerciseId)}`);
    return;
  }
  // Stomach vacuum holds run back to back: no rest, and a rest still
  // counting from the exercise before stops.
  if (entry.kind === 'vacuum') {
    stopRest();
    return;
  }
  // Cardio doesn't use rest periods.
  if (entry.kind === 'cardio') return;
  // The partials-to-failure set follows the set before it back to back.
  if (M.nextIsFailureSet(entry)) {
    stopRest();
    toast('No rest: straight into your partials to failure');
    return;
  }
  if (!st.autoRest) return;
  const name = M.exerciseName(S(), entry.exerciseId);
  const left = entry.sets.filter((s) => !s.done).length;
  startRest(M.restFor(S(), entry), left ? `${name} · ${left} set${left === 1 ? '' : 's'} left` : `${name} done · next exercise`, M.restMax(S(), entry.exerciseId));
}

// ---------------------------------------------------------------------------
// Log view
// ---------------------------------------------------------------------------

// Builds the scale weight card for the shown day.
function bodyWeightCard() {
  const state = S();
  const w = M.bodyWeightOn(state, ui.date);
  const prev = M.previousBodyWeight(state, ui.date);
  const avg = M.bodyWeightAverage(state, ui.date, 7);
  if (!w && ui.bwOpen !== ui.date) {
    return `<section class="card bw">
      <div class="bw-head"><span class="bw-icon">${ICON.scale}</span><div><div class="label">Scale weight</div>
      <div class="small muted">${prev ? `Last: ${fmt(prev.weight)} ${unit()} on ${fmtDate(prev.date, { month: 'short', day: 'numeric' })}` : 'Weigh in to track your trend'}</div></div></div>
      <button type="button" class="btn sm primary" data-action="bw-log">Log weight</button></section>`;
  }
  const diff = prev && w ? M.round(w - prev.weight, 1) : null;
  const diffHTML = diff === null ? '' : diff === 0 ? '<span class="delta flat">no change</span>' : `<span class="delta ${diff < 0 ? 'down-good' : 'up-neutral'}">${diff > 0 ? '+' : ''}${nf1.format(diff)} ${unit()}</span>`;
  return `<section class="card bw">
    <div class="bw-head"><span class="bw-icon">${ICON.scale}</span><div><div class="label">Scale weight</div>
      <div class="small muted">${diffHTML ? `${diffHTML} vs ${fmtDate(prev.date, { month: 'short', day: 'numeric' })} · ` : ''}7-day avg <b class="num">${nf1.format(avg)}</b>${state.body[ui.date]?.source === 'fitbit' ? ' · from Fitbit' : ''}</div></div></div>
    <div class="bw-input">${stepper({ scope: 'body', key: 'weight', value: w || '', label: '', placeholder: 'e.g. 182.4' })}<span class="muted small">${unit()}</span></div>
  </section>`;
}

/** Steps, resting heart rate, sleep and activities imported from Fitbit. */
function healthCard() {
  const h = S().health?.[ui.date];
  if (!h || !(h.steps || h.restingHr || h.sleepMin || h.activities?.length)) return '';
  // Converts kilometers to the chosen distance unit.
  const km = (v) => (dunit() === 'km' ? v : v * 0.621371);
  // Builds one stat tile.
  const stat = (k, v) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  const stats = [
    h.steps ? stat('Steps', fmt(h.steps)) : '',
    h.restingHr ? stat('Resting HR', `${h.restingHr} <small>bpm</small>`) : '',
    // Always shown, so a night Fitbit didn't record reads as "–" rather than missing.
    stat('Sleep', h.sleepMin ? `${Math.floor(h.sleepMin / 60)}h ${h.sleepMin % 60}m` : '–'),
  ].join('');
  const acts = (h.activities || [])
    .map((a) => {
      const bits = [a.start, a.minutes ? `${fmt(Math.round(a.minutes))} min` : '', a.calories ? `${fmt(a.calories)} cal` : '', a.avgHr ? `avg ${a.avgHr} bpm` : '', a.distanceKm ? `${nf1.format(km(a.distanceKm))} ${dunit()}` : ''].filter(Boolean);
      // Keep "1.7 mi" and "52 min" together when the line wraps.
      return `<li><b>${esc(a.name)}</b> <span class="muted small">${esc(bits.map((b) => b.replace(/ /g, '\u00a0')).join(' · '))}</span></li>`;
    })
    .join('');
  return `<section class="card health" aria-label="Fitbit data">
    <span class="label">Fitbit</span>
    ${stats ? `<div class="stats">${stats}</div>` : ''}
    ${acts ? `<ul class="health-acts">${acts}</ul>` : ''}
  </section>`;
}

// Returns "1 workout" or "3 workouts": a count with the right word.
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// Returns the data-state attribute for a streak: done today, still due today, or neither.
const streakState = (x) => (x.doneToday ? 'data-state="done"' : x.pendingToday ? 'data-state="pending"' : '');
// Returns the data-met attribute for a weekly goal that has been reached.
const goalMet = (g) => (g.planned > 0 && g.done >= g.planned ? 'data-met' : '');

// Builds the streak and weekly-goal row under the week strip.
function habitRow(days, ctx) {
  const { workout: w, vacuum: v } = M.currentStreaks(S(), ctx);
  const t = M.consistencyTotals(days);
  // Builds a done/planned cell for a weekly goal, or nothing when the week has neither.
  const goal = (key, label, g) => (g.planned || g.done ? `<span class="habit" data-habit="${key}" ${goalMet(g)}><b class="num">${g.done}<span class="of">/${g.planned}</span></b><small>${label}</small></span>` : '');
  // Describes a weekly goal for screen readers (visible words first), or nothing when the cell is left out.
  const goalText = (label, g) => (g.planned || g.done ? ` ${g.done} of ${g.planned} ${label} this week.` : '');
  const wNote = w.doneToday ? ', done today' : w.pendingToday ? (w.count ? ', log a workout today to keep it going' : ', log a workout today to start a streak') : '';
  const vNote = v.doneToday ? ', done today' : v.pendingToday ? ', not done yet today' : '';
  // Starts with the visible text ("2 streak", "3 vacuum days", "1/4 cardio") so voice control can tap it by what it shows.
  const label = `${w.count} streak, ${plural(w.count, 'workout', 'workouts')} in a row${wNote}. ${v.count} vacuum days in a row${vNote}.${goalText('cardio', t.cardio)}${goalText('core', t.core)} Opens the consistency calendar.`;
  return `<button type="button" class="habits" data-action="open-consistency" aria-label="${esc(label)}">
    <span class="habit" data-habit="streak" ${streakState(w)}><b class="num">${ICON.flame}${w.count}</b><small>streak</small></span>
    <span class="habit" data-habit="vacuum" ${streakState(v)}><b class="num">${v.count}</b><small>vacuum days</small></span>
    ${goal('cardio', 'cardio', t.cardio)}
    ${goal('core', 'core', t.core)}
  </button>`;
}

// Builds the Log tab for the shown day.
function logView() {
  const state = S();
  const { session, draft } = dayData(ui.date);
  const today = M.todayISO();
  const ws = M.startOfWeek(ui.date, state.settings.weekStart);
  const idx = M.planIndex(state, ui.date);
  const cycle = M.isCycle(state);
  const ctx = { today, start: M.consistencyStart(state) };
  const cdays = M.consistencyDays(state, ws, M.addDays(ws, 6), ctx);
  // The streak and goal row only describes the current week.
  const thisWeek = ws === M.startOfWeek(today, state.settings.weekStart);

  const week = Array.from({ length: 7 }, (_, i) => {
    const d = M.addDays(ws, i);
    const base = M.dayStatus(state, d);
    // Tracked days follow the consistency tracker, so the dot never contradicts the streak or the calendar
    // (vacuums alone don't make a workout day partial, and skipped vacuums don't stop it being done).
    const c = cdays[i].status;
    const st = c === 'pending' ? 'planned' : c === 'done' || c === 'partial' || c === 'missed' || c === 'rest' ? c : base;
    const label = cycle ? `D${M.planIndex(state, d) + 1}` : M.WEEKDAY_SHORT[M.weekdayOf(d)][0];
    return `<button type="button" data-action="go-date" data-date="${d}" data-status="${st}" class="${d === today ? 'is-today' : ''}" ${d === ui.date ? 'aria-current="date"' : ''} aria-label="${fmtDate(d, { weekday: 'long', month: 'long', day: 'numeric' })}, ${st}">
      <span class="wd">${cycle ? M.WEEKDAY_SHORT[M.weekdayOf(d)][0] : label}</span><span class="dn">${M.parseISODate(d).getDate()}</span>${cycle ? `<span class="cd">${label}</span>` : ''}<i class="st"></i></button>`;
  }).join('');

  // Day progress (optional exercises count once started)
  let totalUnits = 0;
  let doneUnits = 0;
  for (const e of session.entries.filter(M.entryCounts)) {
    if (e.kind === 'cardio') {
      totalUnits++;
      if (e.cardio.done) doneUnits++;
    } else {
      totalUnits += e.sets.length;
      doneUnits += e.sets.filter((s) => s.done).length;
    }
  }
  const sum = session.entries.reduce(
    (a, e) => {
      const m = M.entryMetrics(e);
      if (m.kind === 'strength') a.vol += m.volume;
      else if (m.kind === 'cardio') a.min += m.minutes;
      else if (m.kind === 'vacuum') a.hold += m.totalHold;
      return a;
    },
    { vol: 0, min: 0, hold: 0 },
  );
  const sumBits = [sum.vol ? `${fmt(sum.vol)} ${unit()}` : '', sum.min ? `${fmt(sum.min)} min cardio` : '', sum.hold ? `${fmtSec(sum.hold)} vacuum` : ''].filter(Boolean).join(' · ');
  const pct = totalUnits ? Math.round((doneUnits / totalUnits) * 100) : 0;

  const entries = session.entries
    .map((e, i) => {
      const linked = e.target.supersetNext && session.entries[i + 1];
      return entryCard(e, i, session) + (linked ? '<div class="ss-link" aria-hidden="true"><span>Superset · no rest between</span></div>' : '');
    })
    .join('');
  const isRest = session.dayType !== 'training';
  const emptyState = !session.entries.length
    ? `<div class="card empty"><h3>${session.dayType === 'rest' ? 'Rest day' : session.dayType === 'active' ? 'Active rest day' : 'Nothing planned'}</h3>
       <p class="hint">${isRest ? 'Recovery counts. If you did anything today, add it below.' : 'Add exercises below, or set up this day in the Plan tab.'}</p></div>`
    : '';

  const planPicker = cycle
    ? `<label class="planpick"><span class="muted small">Rotation</span>
        <select data-field="plan-day" aria-label="Which rotation day is this">
          ${M.planOrder(state).map((i) => `<option value="${i}" ${i === idx ? 'selected' : ''}>${M.planLabel(state, i)}${M.planDay(state, i).name ? ` · ${esc(M.planDay(state, i).name)}` : ''}</option>`).join('')}
        </select></label>`
    : '';

  return `
  <section class="daynav">
    <button type="button" class="icon-btn" data-action="shift-day" data-delta="-1" aria-label="Previous day">${ICON.left}</button>
    <div class="daytitle">
      <div class="dow">${fmtDate(ui.date, { weekday: 'long' })}${ui.date === today ? '<span class="today-pill">Today</span>' : ''}</div>
      <div class="date">${fmtDate(ui.date, { month: 'long', day: 'numeric', year: 'numeric' })}${ui.date !== today ? ` · <button type="button" class="link-btn" data-action="go-date" data-date="${today}">Back to today</button>` : ''}</div>
      <input type="date" data-field="date" value="${ui.date}" aria-label="Pick a date">
    </div>
    <button type="button" class="icon-btn" data-action="shift-day" data-delta="1" aria-label="Next day">${ICON.right}</button>
  </section>
  <nav class="weekstrip" aria-label="This week">${week}</nav>
  ${thisWeek ? habitRow(cdays, ctx) : ''}

  ${bodyWeightCard()}
  ${healthCard()}

  <section class="card dayhead">
    <div class="dayhead-top">
      <input class="dayname" data-field="session-name" value="${esc(session.name)}" placeholder="Name this day (e.g. Chest & Triceps)" aria-label="Day name" maxlength="60">
      ${planPicker}
    </div>
    <div class="seg" role="group" aria-label="Day type">
      ${Object.entries(M.DAY_TYPES).map(([k, v]) => `<button type="button" data-action="day-type" data-type="${k}" aria-pressed="${session.dayType === k}">${v}</button>`).join('')}
    </div>
    ${session.note ? `<p class="day-note">${esc(session.note)}</p>` : ''}
    ${totalUnits ? `<div class="dayprogress"><div class="spread small"><span><b class="num">${doneUnits}</b> of <span class="num">${totalUnits}</span> sets done</span><span class="muted">${sumBits || 'Nothing logged yet'}</span></div>
      <div class="meter" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div></div>` : ''}
  </section>

  ${emptyState}
  ${entries}
  <button type="button" class="add-btn" data-action="open-add" data-mode="session">${ICON.plus} Add exercise, cardio or vacuum</button>

  <section class="card stack">
    <label class="label" for="day-notes">Notes</label>
    <textarea id="day-notes" data-field="session-notes" placeholder="How did it feel? Sleep, energy, anything worth remembering…">${esc(session.notes)}</textarea>
  </section>

  <div class="row wrap" style="justify-content:center">
    <button type="button" class="btn sm" data-action="save-plan">Save as my ${esc(M.planLabel(state, idx))} plan</button>
    ${draft ? '' : '<button type="button" class="btn sm danger" data-action="reset-day">Reset day to plan</button>'}
  </div>
  ${draft && session.entries.length ? '<p class="draft-note">This day follows your plan. Change anything here to adjust just this day.</p>' : ''}`;
}

// Builds the −/+ done counter for an entry.
function counterHTML(e) {
  let done;
  let total;
  if (e.kind === 'cardio') {
    done = e.cardio.done ? 1 : 0;
    total = 1;
  } else {
    done = e.sets.filter((s) => s.done).length;
    total = e.sets.length;
  }
  const name = esc(M.exerciseName(S(), e.exerciseId));
  return `<div class="counter" role="group" aria-label="Completed ${e.kind === 'cardio' ? 'session' : 'sets'}">
    <button type="button" data-action="undo-set" data-entry="${e.id}" aria-label="Undo last completed set of ${name}">−</button>
    <div class="count" aria-live="polite">${done}/${total}<small>${e.kind === 'cardio' ? 'done' : 'sets'}</small></div>
    <button type="button" class="plus" data-action="complete-set" data-entry="${e.id}" aria-label="Complete next set of ${name}">+</button>
  </div>`;
}

// Builds the card for one exercise entry on the Log.
function entryCard(e, index, session) {
  const count = session.entries.length;
  const ssNext = M.supersetNext(session, e.id);
  const ssPrev = M.supersetPrev(session, e.id);
  const state = S();
  const ex = state.exercises[e.exerciseId];
  const name = ex?.name || 'Unknown exercise';
  const prev = M.previousEntry(state, e.exerciseId, ui.date);
  const editing = ui.editing.has(e.id);
  const allDone = M.entryComplete(e);
  const body = e.kind === 'cardio' ? cardioBody(e) : setsBody(e, prev);

  const cue = [ex?.cue, e.target.note].filter(Boolean).join(' · ');
  const ssLine = ssNext ? `Superset with ${esc(M.exerciseName(state, ssNext.exerciseId))}: go straight to it, then rest` : ssPrev ? `Superset with ${esc(M.exerciseName(state, ssPrev.exerciseId))}: rest after this one` : '';
  return `<article class="card entry${allDone ? ' is-done' : ''}${e.target.optional ? ' is-optional' : ''}${ssNext || ssPrev ? ' is-superset' : ''}" data-entry-id="${e.id}">
    <div class="entry-head">
      <div class="entry-title">
        <h3>${esc(name)} <span class="badge ${e.kind}">${M.KINDS[e.kind]}</span>${ssNext || ssPrev ? '<span class="badge ss">Superset</span>' : ''}${e.target.optional ? '<span class="badge opt" title="Optional – skip it if you like">Optional</span>' : ''}</h3>
        <div class="target-line"><span>Target <b>${targetText(e.target, e.kind)}</b></span>
          <button type="button" class="link-btn" data-action="toggle-target" data-entry="${e.id}" aria-expanded="${editing}">${editing ? 'Done' : 'Edit target'}</button></div>
        ${cue ? `<div class="cue">${esc(cue)}</div>` : ''}
        ${VIDEOS[e.exerciseId] ? `<button type="button" class="video-link" data-action="video" data-url="${esc(VIDEOS[e.exerciseId][0][1])}" data-title="${esc(name)}">▶ Form video</button>` : ''}
        ${ssLine ? `<div class="ss-line">${ssLine}</div>` : ''}
      </div>
      ${counterHTML(e)}
    </div>
    ${editing ? targetEditor(e, prev) : ''}
    ${intensityHTML(e, prev)}
    ${body}
    ${rpeRow(e, prev)}
    <div class="entry-foot">
      ${e.kind !== 'cardio' ? `<button type="button" class="btn sm" data-action="remove-set" data-entry="${e.id}" ${e.sets.length ? '' : 'disabled'}>− Set</button>
      <button type="button" class="btn sm" data-action="add-set" data-entry="${e.id}">+ Set</button>` : ''}
      <span class="grow"></span>
      <button type="button" class="icon-btn" data-action="swap-entry" data-entry="${e.id}" aria-label="Swap ${esc(name)} for another exercise" title="Swap exercise">${ICON.swap}</button>
      <button type="button" class="icon-btn" data-action="superset-entry" data-entry="${e.id}" aria-pressed="${!!e.target.supersetNext}" aria-label="Superset ${esc(name)} with the next exercise" title="Superset with next exercise" ${index === count - 1 ? 'disabled' : ''}>${ICON.link}</button>
      <button type="button" class="icon-btn" data-action="move-entry" data-entry="${e.id}" data-dir="-1" aria-label="Move up" ${index === 0 ? 'disabled' : ''}>${ICON.up}</button>
      <button type="button" class="icon-btn" data-action="move-entry" data-entry="${e.id}" data-dir="1" aria-label="Move down" ${index === count - 1 ? 'disabled' : ''}>${ICON.down}</button>
      <button type="button" class="icon-btn" data-action="remove-entry" data-entry="${e.id}" aria-label="Remove ${esc(name)}">${ICON.trash}</button>
    </div>
    <input class="entry-notes" data-field="entry-notes" data-entry="${e.id}" value="${esc(e.notes)}" placeholder="Note (machine setting, how it felt…)" aria-label="Note for ${esc(name)}" maxlength="1000">
  </article>`;
}

// Builds the RPE picker for an entry, with last time’s RPE.
function rpeRow(e, prev) {
  if (e.kind === 'vacuum') return ''; // no effort rating for vacuums
  if (e.kind === 'cardio' && !e.cardio.done && !e.rpe) return '';
  const chips = [5, 6, 7, 8, 9, 10].map((v) => `<button type="button" data-action="rpe" data-entry="${e.id}" data-value="${v}" aria-pressed="${e.rpe === v}">${v}</button>`).join('');
  return `<div class="rpe-row"><span class="label" title="Rate of perceived exertion: 10 = maximum effort, nothing left">RPE</span>
    <div class="rpe" role="group" aria-label="Effort (RPE)">${chips}</div>
    ${prev?.entry.rpe ? `<span class="muted small">last ${fmt(prev.entry.rpe)}</span>` : ''}</div>`;
}

// Builds the editor for changing an entry’s target for this day only.
function targetEditor(e, prev) {
  const t = e.target;
  // Builds a stepper for one target field.
  const st = (key, label) => stepper({ scope: 'target', key, value: t[key] || 0, label, entry: e.id });
  let fields;
  if (e.kind === 'cardio') {
    const extra = M.cardioFields(S(), e.exerciseId).map((f) => st(f, CARDIO_LABEL[f])).join('');
    fields = `<div class="grid3">${st('minutes', 'Minutes')}${extra}${st('distance', `Distance (${dunit()})`)}</div>`;
  } else if (M.isHold(e.kind)) {
    fields =
      e.kind === 'vacuum'
        ? `<div class="grid2">${st('sets', 'Sets')}${st('holdSec', 'Hold (sec)')}</div>`
        : `<div class="grid3">${st('sets', 'Sets')}${st('holdSec', 'Hold (sec)')}${st('restSec', 'Rest (sec)')}</div>`;
  } else {
    fields = `<div class="grid3">${st('sets', 'Sets')}${st('reps', 'Reps')}${st('weight', unit())}</div>
      <div class="grid3">${st('warmupSets', 'Warm-ups')}${st('dropSets', 'Drop sets')}${st('restSec', 'Rest (sec)')}</div>`;
  }
  let cmp = '<span class="muted">No previous session to compare with yet.</span>';
  if (prev) {
    const pt = prev.entry.target;
    const diffs = [];
    const keys = e.kind === 'cardio' ? [['minutes', 'min'], ['distance', dunit()]] : M.isHold(e.kind) ? [['sets', 'sets'], ['holdSec', 's hold']] : [['sets', 'sets'], ['reps', 'reps'], ['weight', unit()]];
    for (const [k, label] of keys) {
      const d = M.round((t[k] || 0) - (pt[k] || 0), 2);
      if (d) diffs.push(`<span class="delta ${d > 0 ? 'up' : 'down'}">${d > 0 ? '+' : ''}${fmt(d)} ${label}</span>`);
    }
    cmp = `Last time (${fmtDate(prev.date)}): <b>${targetText(pt, e.kind)}</b> → ${diffs.length ? diffs.join(', ') : '<span class="delta flat">same target</span>'}`;
  }
  return `<div class="target-edit">${fields}<div class="compare">${cmp}</div>
    <p class="hint">Changes apply to this day only and fill the sets you haven't done yet. To change it for every rotation, use “Save as my plan” or the Plan tab. Rest 0 = the default for ${M.restClass(S(), e.exerciseId) ? `${M.restClass(S(), e.exerciseId)} lifts` : 'this exercise'} (${fmtSec(M.defaultRest(S(), e.exerciseId))}, max ${fmtSec(M.restMax(S(), e.exerciseId))}).</p></div>`;
}

// Builds the intensity tracker comparing last time’s load with today’s.
function intensityHTML(e, prev) {
  const done = M.entryMetrics(e, true);
  const planned = M.entryMetrics(e, false);
  const pm = prev ? M.entryMetrics(prev.entry) : null;
  const max = Math.max(pm?.load || 0, planned.load, done.load, 1);
  // Returns a bar width as a percent of the planned/last maximum.
  const w = (v) => `${Math.min(100, (v / max) * 100).toFixed(1)}%`;
  const bodyweight = e.kind === 'strength' && !planned.topWeight && !pm?.topWeight;
  const what = e.kind === 'cardio' ? 'Duration' : M.isHold(e.kind) ? 'Total hold time' : bodyweight ? 'Total reps' : 'Load (weight × reps)';
  // Bodyweight moves (push-ups, dips…) compare reps instead of weight × reps.
  const L = (m) => (bodyweight ? m?.reps || 0 : m?.load || 0);
  // Formats a load value, or reps for bodyweight exercises.
  const lt = (v) => (bodyweight ? `${fmt(v)} reps` : loadText(e.kind, v));
  const maxL = Math.max(L(pm), L(planned), L(done), 1);
  // Returns a bar width as a percent of the largest load.
  const wl = (v) => `${Math.min(100, (v / maxL) * 100).toFixed(1)}%`;

  let foot = '';
  if (e.kind === 'strength' && !bodyweight) {
    const top = planned.topWeight ? `${fmt(planned.topWeight)}×${fmt(planned.topReps)}` : '–';
    foot = `<span>Est. 1RM ${pm?.e1rm ? `${fmt(pm.e1rm)} → ` : ''}<b class="num">${fmt(planned.e1rm)}</b> ${deltaHTML(planned.e1rm, pm?.e1rm)}</span>
      <span>Top set ${pm ? `${fmt(pm.topWeight)}×${fmt(pm.topReps)} → ` : ''}<b class="num">${top}</b></span>`;
  } else if (e.kind === 'cardio') {
    const settings = M.cardioFields(S(), e.exerciseId)
      .map((f) => `<span>${CARDIO_LABEL[f]} ${pm?.[f] ? `${fmt(pm[f])} → ` : ''}<b class="num">${fmt(planned[f])}</b> ${deltaHTML(planned[f], pm?.[f])}</span>`)
      .join('');
    foot = `${settings}<span>Distance ${pm ? `${fmt(pm.distance)} → ` : ''}<b class="num">${fmt(planned.distance)} ${dunit()}</b></span>
      ${planned.pace ? `<span>Pace ${pm?.pace ? `${fmtPace(pm.pace)} → ` : ''}<b class="num">${fmtPace(planned.pace)}</b></span>` : ''}`;
  } else if (M.isHold(e.kind)) {
    foot = `<span>Longest hold ${pm ? `${fmtSec(pm.longestHold)} → ` : ''}<b class="num">${fmtSec(planned.longestHold)}</b> ${deltaHTML(planned.longestHold, pm?.longestHold)}</span>`;
  }
  const hint = M.overloadHint(S(), e, prev);
  const hintHTML = hint ? `<div class="overload">You hit ${hint.reps} reps on every set last time. Try <b>${fmt(hint.to)} ${unit()}</b> (from ${fmt(hint.from)}).</div>` : '';
  const showW = bodyweight ? wl : w;

  return `<div class="intensity" aria-label="Intensity tracker">
    <div class="int-head"><span class="label">${what}</span>${pm ? `<span>vs last: ${deltaHTML(L(planned), L(pm)) || '<span class="delta flat">new</span>'}</span>` : '<span class="muted">First time – this sets your baseline</span>'}</div>
    ${pm ? `<div class="int-row"><span class="lbl">Last · ${fmtDate(prev.date, { month: 'short', day: 'numeric' })}</span><div class="bar"><i class="prev" style="width:${showW(L(pm))}"></i></div><span class="val">${lt(L(pm))}</span></div>` : ''}
    <div class="int-row"><span class="lbl">Today</span><div class="bar" title="Logged ${lt(L(done))} of ${lt(L(planned))} planned"><i class="plan" style="width:${showW(L(planned))}"></i><i class="done" style="width:${showW(L(done))}"></i></div><span class="val">${lt(L(planned))}</span></div>
    <div class="int-foot"><span class="muted">Logged so far: <b class="num">${lt(L(done))}</b></span>${foot}</div>
    ${hintHTML}
  </div>`;
}

// Builds the list of sets for a strength or hold entry.
function setsBody(e, prev) {
  const prevDone = prev?.entry.sets?.filter((s) => s.done) || [];
  // Returns last time’s finished sets of one set type.
  const prevByType = (type) => prevDone.filter((s) => (s.type || 'work') === type);
  const hold = M.isHold(e.kind);
  if (!e.sets.length) return '<p class="hint">No sets. Tap “+ Set” to add one.</p>';
  const rested = M.restTaken(e);
  const head = hold
    ? '<div class="set-head hold"><span>#</span><span>Hold (sec)</span><span>Timer</span><span>Done</span></div>'
    : `<div class="set-head"><span>#</span><span>Weight (${unit()})</span><span>Reps</span><span>Done</span></div>`;
  const counters = {};
  let workNo = 0;
  const rows = e.sets
    .map((s, i) => {
      const type = s.type || 'work';
      counters[type] = (counters[type] || 0) + 1;
      const p = prevByType(type)[counters[type] - 1];
      const bits = [];
      if (p) bits.push(`Last: ${hold ? fmtSec(p.holdSec) : `${fmt(p.weight)} × ${fmt(p.reps)}`}`);
      if (rested[s.id] && e.kind !== 'vacuum') bits.push(`rested ${fmtClock(rested[s.id])}`);
      const hint = bits.length ? `<div class="prev-hint">${bits.join(' · ')}</div>` : '';
      const check = `<button type="button" class="check" data-action="toggle-set" data-entry="${e.id}" data-set="${s.id}" aria-pressed="${s.done}" aria-label="Set ${i + 1} done">${ICON.check}</button>`;
      if (hold) {
        const running = holdTimer && holdTimer.setId === s.id;
        return `<div class="set-row hold${s.done ? ' is-done' : ''}"><span class="idx">${i + 1}</span>
          ${stepper({ scope: 'set', key: 'holdSec', value: s.holdSec, entry: e.id, set: s.id, label: '' })}
          <button type="button" class="timer-btn${running ? ' running' : ''}" data-action="hold-timer" data-entry="${e.id}" data-set="${s.id}" aria-label="${running ? 'Stop timer and log hold' : 'Start hold timer'}">${running ? `${ICON.stop}<span data-timer>${Math.floor((Date.now() - holdTimer.start) / 1000)}s</span>` : `${ICON.play}Start`}</button>
          ${check}${hint}</div>`;
      }
      if (type === 'work') workNo++;
      const tag = type === 'work' ? String(workNo) : M.SET_TYPES[type].short;
      return `<div class="set-row t-${type}${s.done ? ' is-done' : ''}">
        <button type="button" class="idx" data-action="set-type" data-entry="${e.id}" data-set="${s.id}" title="${M.SET_TYPES[type].label} (tap to change type)" aria-label="Set ${i + 1}: ${M.SET_TYPES[type].label}. Tap to change type">${tag}</button>
        ${stepper({ scope: 'set', key: 'weight', value: s.weight, entry: e.id, set: s.id })}
        ${stepper({ scope: 'set', key: 'reps', value: s.reps, entry: e.id, set: s.id })}
        ${check}${hint}</div>`;
    })
    .join('');
  const legend = !hold && e.sets.some((s) => s.type) ? '<p class="hint set-legend">W = warm-up (not counted in load) · D = drop set · F = to failure / partials. Tap a set number to change its type.</p>' : '';
  return `<div class="sets">${head}${rows}</div>${legend}`;
}

// Builds the inputs for a cardio entry (minutes, distance, speed and so on).
function cardioBody(e) {
  const c = e.cardio;
  // Builds one labeled number field for a cardio entry.
  const field = (key, label) => `<label class="field"><span>${label}</span><input type="text" inputmode="numeric" data-field="value" data-scope="cardio" data-key="${key}" data-entry="${e.id}" data-set="" data-wd="" data-item="" value="${c[key] ? fmtInput(c[key]) : ''}" placeholder="–"></label>`;
  const settings = M.cardioFields(S(), e.exerciseId)
    .map((f) => stepper({ scope: 'cardio', key: f, value: c[f] || 0, label: CARDIO_LABEL[f], entry: e.id }))
    .join('');
  const est = !c.distance && c.speed ? M.round((c.speed * c.minutes) / 60, 2) : 0;
  return `<div class="cardio-grid">
      ${stepper({ scope: 'cardio', key: 'minutes', value: c.minutes, label: 'Minutes', entry: e.id })}
      ${settings}
      ${stepper({ scope: 'cardio', key: 'distance', value: c.distance || '', label: est ? `Distance (≈${fmt(est)} ${dunit()})` : `Distance (${dunit()})`, placeholder: est ? fmt(est) : '0', entry: e.id })}
      ${field('calories', 'Calories')}
      ${field('avgHr', 'Avg heart rate')}
    </div>
    ${M.cardioFields(S(), e.exerciseId).includes('rounds') ? `<button type="button" class="btn block" data-action="hiit-setup" data-entry="${e.id}">${hiit && hiit.entryId === e.id ? '⏱ Interval timer running' : '⏱ Interval timer'}</button>` : ''}
    <button type="button" class="btn block ${c.done ? '' : 'primary'}" data-action="cardio-done" data-entry="${e.id}" aria-pressed="${c.done}">${c.done ? `${ICON.check} Completed – tap to undo` : 'Mark cardio complete'}</button>`;
}

// ---------------------------------------------------------------------------
// HIIT interval timer
// ---------------------------------------------------------------------------

const HIIT_KEY = 'workout-logbook:hiit';
const $hiit = document.getElementById('hiit');
let hiit = null; // { entryId, date, name, cfg, phases, startedAt, pausedAt, pausedMs, lastIndex, lastBeep }
let hiitTick = null;
let wakeLock = null;

try {
  const saved = JSON.parse(localStorage.getItem(HIIT_KEY) || 'null');
  // Restored even if it finished while the app was closed: the first tick
  // then logs it (finishHiit) instead of losing the session.
  if (saved && saved.phases) hiit = saved;
} catch {
  /* ignore */
}

// Saves the running interval timer so it survives a reload.
function saveHiit() {
  try {
    if (hiit) localStorage.setItem(HIIT_KEY, JSON.stringify(hiit));
    else localStorage.removeItem(HIIT_KEY);
  } catch {
    /* ignore */
  }
}

// Returns how long the interval timer has run, not counting pauses (ms).
function hiitElapsed() {
  return (hiit.pausedAt || Date.now()) - hiit.startedAt - hiit.pausedMs;
}

// Opens the interval timer setup sheet for a HIIT entry.
function openHiitSetup(entryId) {
  if (hiit) return toast('An interval timer is already running');
  const { session } = dayData(ui.date);
  const e = M.findEntry(session, entryId);
  if (!e) return;
  // Store the day first so the entry id stays valid.
  editSession(() => {});
  ui.hiitSetup = { entryId, date: ui.date, cfg: M.hiitConfig(e), name: M.exerciseName(S(), e.exerciseId) };
  ui.sheet = { mode: 'hiit' };
  $sheet.hidden = false;
  renderHiitSetup();
}

// Draws the interval timer setup sheet.
function renderHiitSetup() {
  const { cfg, name } = ui.hiitSetup;
  // Builds a stepper for one interval setting.
  const st = (key, label) => stepper({ scope: 'hiit', key, value: cfg[key], label });
  const total = M.hiitTotalSec(M.hiitPhases(cfg));
  $sheetPanel.innerHTML = `
    <div class="spread"><h2 id="sheet-title">${esc(name)} intervals</h2>
      <button type="button" class="icon-btn" data-action="close-sheet" aria-label="Close">${ICON.close}</button></div>
    <div class="hiit-setup stack">
      <div class="grid3">${st('workSec', 'Hard (sec)')}${st('easySec', 'Easy (sec)')}${st('rounds', 'Rounds')}</div>
      <div class="grid2">${st('warmMin', 'Warm-up (min)')}${st('coolMin', 'Cool-down (min)')}</div>
      <p class="hint">Total about <b>${Math.round(total / 60)} min</b>. You'll hear a beep and feel a buzz at each switch, with a 3-2-1 countdown. The timer keeps time if you lock your phone.</p>
      <button type="button" class="btn primary block" data-action="hiit-start">Start</button>
    </div>`;
}

// Keeps the screen awake (or lets it sleep again) where the browser allows it.
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    /* not supported or not allowed */
  }
}

// Starts the interval timer with the settings from the setup sheet.
function startHiit() {
  const { entryId, date, cfg, name } = ui.hiitSetup;
  // Remember these settings on the entry for next time.
  editSession((sess) => {
    const e = M.findEntry(sess, entryId);
    if (e) Object.assign(e.target, cfg);
  }, date);
  closeSheet();
  stopRest();
  hiit = { entryId, date, name, cfg, phases: M.hiitPhases(cfg), startedAt: Date.now(), pausedAt: 0, pausedMs: 0, lastIndex: -1, lastBeep: -1 };
  saveHiit();
  keepAwake(true);
  buildHiitBar();
  render();
}

// Builds (or hides) the interval timer bar and starts its ticking.
function buildHiitBar() {
  clearInterval(hiitTick);
  if (!hiit) {
    $hiit.hidden = true;
    $hiit.innerHTML = '';
    if (!rest) document.body.classList.remove('has-rest');
    return;
  }
  $hiit.hidden = false;
  document.body.classList.add('has-rest');
  $hiit.innerHTML = `
    <div class="rest-fill" data-hiit-fill></div>
    <div class="rest-main">
      <div class="rest-text"><span class="label" data-hiit-label>HIIT</span><span class="rest-time" data-hiit-time>0:00</span><span class="rest-sub" data-hiit-sub>${esc(hiit.name)}</span></div>
      <div class="rest-btns">
        <button type="button" class="btn sm" data-action="hiit-pause" data-hiit-pause>Pause</button>
        <button type="button" class="btn sm" data-action="hiit-skip" aria-label="Skip to next interval">Skip</button>
        <button type="button" class="btn sm primary" data-action="hiit-end">End</button>
      </div>
    </div>`;
  updateHiitBar();
  hiitTick = setInterval(updateHiitBar, 250);
}

// Beeps and buzzes for the start of a hard or easy interval.
function hiitCue(kind) {
  vibrate(kind === 'hard' ? [300, 100, 300] : 300);
  beep(kind === 'hard' ? 1320 : 660, kind === 'hard' ? 3 : 2);
}

// Updates the interval timer bar, with cues at each switch and a 3-2-1 countdown.
function updateHiitBar() {
  if (!hiit) return;
  const pos = M.hiitPosition(hiit.phases, hiitElapsed());
  if (pos.done) return finishHiit(true);
  const p = hiit.phases[pos.index];
  if (pos.index !== hiit.lastIndex) {
    if (hiit.lastIndex !== -1 || pos.index === 0) hiitCue(p.kind);
    hiit.lastIndex = pos.index;
    hiit.lastBeep = -1;
    saveHiit();
  }
  const left = Math.ceil(pos.remaining);
  // 3-2-1 countdown before each switch.
  if (left <= 3 && left >= 1 && hiit.lastBeep !== left && !hiit.pausedAt) {
    hiit.lastBeep = left;
    beep(880, 1);
  }
  const next = hiit.phases[pos.index + 1];
  $hiit.dataset.kind = p.kind;
  $hiit.classList.toggle('is-paused', !!hiit.pausedAt);
  $hiit.querySelector('[data-hiit-label]').textContent = hiit.pausedAt ? `${p.label} · paused` : p.label;
  $hiit.querySelector('[data-hiit-time]').textContent = fmtClock(left);
  $hiit.querySelector('[data-hiit-sub]').textContent = `${hiit.name}${next ? ` · next: ${next.label}` : ' · last interval'}`;
  $hiit.querySelector('[data-hiit-fill]').style.width = `${Math.min(100, (1 - pos.remaining / p.sec) * 100)}%`;
  $hiit.querySelector('[data-hiit-pause]').textContent = hiit.pausedAt ? 'Resume' : 'Pause';
}

/** Log rounds and minutes on the entry and close the timer. */
function finishHiit(completed) {
  if (!hiit) return;
  const t = hiit;
  const pos = M.hiitPosition(t.phases, (t.pausedAt || Date.now()) - t.startedAt - t.pausedMs);
  const rounds = completed ? t.cfg.rounds : pos.rounds;
  const minutes = Math.max(1, Math.round(Math.min(hiitElapsedOf(t), M.hiitTotalSec(t.phases) * 1000) / 60000));
  hiit = null;
  saveHiit();
  clearInterval(hiitTick);
  keepAwake(false);
  buildHiitBar();
  editSession((sess) => {
    const e = M.findEntry(sess, t.entryId);
    if (!e) return;
    e.cardio.rounds = rounds;
    e.cardio.minutes = minutes;
    if (rounds > 0) e.cardio.done = true;
  }, t.date);
  if (completed) {
    beep(990, 4);
    vibrate([200, 100, 200, 100, 400]);
  }
  toast(rounds ? `HIIT logged: ${rounds} interval${rounds === 1 ? '' : 's'}, ${minutes} min` : 'Interval timer stopped');
}

// Returns how long a given interval timer has run, not counting pauses (ms).
function hiitElapsedOf(t) {
  return (t.pausedAt || Date.now()) - t.startedAt - t.pausedMs;
}

// ---------------------------------------------------------------------------
// Plan view
// ---------------------------------------------------------------------------

// Builds the editor row for one exercise in a plan day.
function planItemHTML(state, wd, it, i, n) {
  const ex = state.exercises[it.exerciseId];
  if (!ex || ex.deleted) return '';
  const kind = ex.kind;
  // Builds a stepper for one plan target field.
  const st = (key, label) => stepper({ scope: 'plan', key, value: it[key] ?? M.defaultTarget(kind)[key] ?? 0, label, wd, item: it.id, sm: true });
  let grid;
  let more = '';
  const open = ui.planMore.has(it.id);
  if (kind === 'cardio') {
    const extra = M.cardioFields(state, it.exerciseId).map((f) => stepper({ scope: 'plan', key: f, value: it[f] ?? M.exerciseTarget(state, it.exerciseId)[f] ?? 0, label: CARDIO_LABEL[f], wd, item: it.id, sm: true })).join('');
    grid = `<div class="grid3">${st('minutes', 'Minutes')}${extra}</div>`;
  } else if (M.isHold(kind)) {
    grid = `<div class="grid3">${st('sets', 'Sets')}${st('setsMax', 'Up to')}${st('holdSec', 'Hold sec')}</div>`;
    if (open && kind !== 'vacuum') more = `<div class="grid3">${st('restSec', 'Rest (0=default)')}</div>`;
  } else {
    grid = it.repScheme
      ? `<div class="grid2"><label class="field"><span>Reps per set</span><input data-field="plan-scheme" data-wd="${wd}" data-item="${esc(it.id)}" value="${esc(it.repScheme.join(' '))}" inputmode="numeric" aria-label="Reps per set"></label>${st('weight', `${unit()} (0 = last)`)}</div>`
      : `<div class="grid3">${st('sets', 'Sets')}${st('reps', 'Reps')}${st('weight', `${unit()} (0 = last)`)}</div>`;
    if (open) {
      more = `<div class="grid3">${st('setsMax', 'Sets up to')}${st('repsMax', 'Reps up to')}${st('restSec', 'Rest (0=default)')}</div>
        <div class="grid3">${st('warmupSets', 'Warm-ups')}${st('dropSets', 'Drop sets')}${st('failureSets', 'To failure')}</div>
        <label class="field"><span>Pyramid (reps per set, e.g. 15 12 10 10). Leave empty for straight sets.</span><input data-field="plan-scheme" data-wd="${wd}" data-item="${esc(it.id)}" value="${esc((it.repScheme || []).join(' '))}" inputmode="numeric" aria-label="Pyramid reps"></label>`;
    }
  }
  if (open) {
    more += `<label class="field"><span>Note / cue</span><input data-field="plan-note" data-wd="${wd}" data-item="${esc(it.id)}" value="${esc(it.note || '')}" maxlength="300" placeholder="e.g. superset with flyes, 2-sec squeeze"></label>
      <button type="button" class="btn sm" data-action="plan-optional" data-wd="${wd}" data-item="${esc(it.id)}" aria-pressed="${!!it.optional}">${it.optional ? '✓ Optional' : 'Mark as optional'}</button>`;
  }
  return `<div class="planitem${it.optional ? ' is-optional' : ''}${it.supersetNext ? ' ss-start' : ''}">
    <div class="planitem-top"><span class="name">${esc(ex.name)}</span>${it.optional ? '<span class="badge opt" title="Optional – skip it if you like">Optional</span>' : ''}
      <button type="button" class="icon-btn" data-action="plan-swap" data-wd="${wd}" data-item="${it.id}" aria-label="Swap ${esc(ex.name)}" title="Swap exercise">${ICON.swap}</button>
      <button type="button" class="icon-btn" data-action="plan-superset" data-wd="${wd}" data-item="${it.id}" aria-pressed="${!!it.supersetNext}" aria-label="Superset ${esc(ex.name)} with the next exercise" title="Superset with next exercise" ${i === n - 1 ? 'disabled' : ''}>${ICON.link}</button>
      <button type="button" class="icon-btn" data-action="plan-move" data-wd="${wd}" data-item="${it.id}" data-dir="-1" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>${ICON.up}</button>
      <button type="button" class="icon-btn" data-action="plan-move" data-wd="${wd}" data-item="${it.id}" data-dir="1" aria-label="Move down" ${i === n - 1 ? 'disabled' : ''}>${ICON.down}</button>
      <button type="button" class="icon-btn" data-action="plan-remove" data-wd="${wd}" data-item="${it.id}" aria-label="Remove ${esc(ex.name)}">${ICON.trash}</button></div>
    <div class="small muted">${targetText(it, kind)}${it.restSec && kind !== 'vacuum' ? ` · rest ${fmtSec(it.restSec)}` : ''}${it.note && !open ? ` · ${esc(it.note)}` : ''}</div>
    ${grid}${more}
    <button type="button" class="link-btn" data-action="plan-more" data-item="${it.id}" aria-expanded="${open}">${open ? 'Fewer options' : 'More options (ranges, warm-ups, drop sets, rest, notes)'}</button>
  </div>`;
}

// Builds the Plan tab.
function planView() {
  const state = S();
  const cycle = M.isCycle(state);
  const todayIdx = M.planIndex(state, M.todayISO());
  const order = M.planOrder(state);
  const days = order
    .map((wd) => {
      const day = M.planDay(state, wd);
      const items = day.items
        .map((it, i) => planItemHTML(state, wd, it, i, day.items.length) + (it.supersetNext && day.items[i + 1] ? '<div class="ss-link plan" aria-hidden="true"><span>Superset · no rest between</span></div>' : ''))
        .join('');
      return `<article class="card planday${wd === todayIdx ? ' is-today' : ''}">
        <div class="planday-head">
          <div class="spread"><span class="wdname">${M.planLabel(state, wd)}${wd === todayIdx ? ' · today' : ''}</span>
            <span class="muted small">${day.items.length} item${day.items.length === 1 ? '' : 's'}</span></div>
          <input class="dayname" data-field="plan-name" data-wd="${wd}" value="${esc(day.name)}" placeholder="Name (e.g. Legs, Rest)" aria-label="${M.planLabel(state, wd)} name" maxlength="60">
          <div class="seg" role="group" aria-label="Day type">${Object.entries(M.DAY_TYPES).map(([k, v]) => `<button type="button" data-action="plan-type" data-wd="${wd}" data-type="${k}" aria-pressed="${day.dayType === k}">${v}</button>`).join('')}</div>
          <input class="plan-note" data-field="plan-daynote" data-wd="${wd}" value="${esc(day.note || '')}" placeholder="Day note (e.g. warm up rotator cuffs first)" aria-label="${M.planLabel(state, wd)} note" maxlength="500">
        </div>
        ${items || '<p class="hint">No exercises. Rest up, or add some.</p>'}
        <div class="planday-foot">
          <button type="button" class="btn sm" data-action="open-add" data-mode="plan" data-wd="${wd}">+ Add exercise</button>
          <select data-field="plan-copy" data-wd="${wd}" aria-label="Copy another day into ${M.planLabel(state, wd)}">
            <option value="">Copy from…</option>
            ${order.filter((o) => o !== wd).map((o) => `<option value="${o}">${M.planLabel(state, o)}${M.planDay(state, o).name ? ` (${esc(M.planDay(state, o).name)})` : ''}</option>`).join('')}
          </select>
        </div>
      </article>`;
    })
    .join('');

  const cycleControls = cycle
    ? `<div class="settings-row"><span>Days in rotation</span>${stepper({ scope: 'setting', key: 'cycleLength', value: state.settings.cycleLength })}</div>
       <div class="settings-row"><span>Today is</span><select data-field="cycle-today" style="width:auto" aria-label="Which rotation day is today">${order.map((i) => `<option value="${i}" ${i === todayIdx ? 'selected' : ''}>${M.planLabel(state, i)}${M.planDay(state, i).name ? ` · ${esc(M.planDay(state, i).name)}` : ''}</option>`).join('')}</select></div>
       <p class="hint">Missed a day? Set which day today is (here or in the Log) and the rotation shifts from there. Days you've already logged stay as they are.</p>`
    : '<p class="hint">Each weekday has its own plan.</p>';

  return `<div class="stack"><h2>Plan</h2>
    <p class="hint">Each day in the Log starts from this plan until you change it. To do more or less just once, edit that day in the Log instead. A weight of 0 pre-fills from what you lifted last time.</p></div>
    <section class="card">
      <div class="settings-row"><span>Plan type</span><div class="seg" role="group">
        <button type="button" data-action="plan-mode" data-value="cycle" aria-pressed="${cycle}">Rotation</button>
        <button type="button" data-action="plan-mode" data-value="weekly" aria-pressed="${!cycle}">Weekly</button></div></div>
      ${cycleControls}
    </section>
    ${days}`;
}

// ---------------------------------------------------------------------------
// Progress view
// ---------------------------------------------------------------------------

const RANGES = { '1w': ['1W', 7], '4w': ['4W', 28], '3m': ['3M', 91], '6m': ['6M', 182], '1y': ['1Y', 365], all: ['All', null] };

// Returns the [from, to] dates of the chosen Progress range.
function rangeBounds() {
  const today = M.todayISO();
  const days = RANGES[ui.progress.range][1];
  if (days) return [M.addDays(today, -(days - 1)), today];
  const dates = [...M.sessionDates(S()), ...M.bodyWeights(S()).map((b) => b.date)].sort();
  return [dates[0] && dates[0] < today ? dates[0] : M.addDays(today, -27), dates.length && dates[dates.length - 1] > today ? dates[dates.length - 1] : today];
}

const HOLD_METRICS = [
  ['totalHold', 'Total hold', (m) => m.totalHold],
  ['longestHold', 'Longest hold', (m) => m.longestHold],
  ['sets', 'Sets', (m) => m.sets],
];
const EX_METRICS = {
  strength: [
    ['e1rm', 'Est. 1RM', (m) => m.e1rm],
    ['topWeight', 'Top weight', (m) => m.topWeight],
    ['volume', 'Volume', (m) => m.volume],
    ['reps', 'Total reps', (m) => m.reps],
  ],
  cardio: [
    ['minutes', 'Minutes', (m) => m.minutes],
    ['distance', 'Distance', (m) => m.distance],
    ['pace', 'Pace', (m) => m.pace],
    ['speed', 'Speed', (m) => m.speed],
    ['incline', 'Incline', (m) => m.incline],
    ['level', 'Level', (m) => m.level],
    ['rounds', 'Intervals', (m) => m.rounds],
  ],
  vacuum: HOLD_METRICS,
  timed: HOLD_METRICS,
};

// Returns a formatter for an exercise progress metric.
function metricFormatter(kind, key) {
  if (M.isHold(kind) && key !== 'sets') return (v) => fmtSec(v);
  if (key === 'pace') return (v) => fmtPace(v);
  if (['e1rm', 'topWeight', 'volume'].includes(key)) return (v, axis) => (axis ? fmtCompact(v) : `${fmt(v)} ${unit()}`);
  if (key === 'distance') return (v, axis) => (axis ? fmt(v) : `${fmt(v)} ${dunit()}`);
  if (key === 'minutes') return (v, axis) => (axis ? fmt(v) : `${fmt(v)} min`);
  if (key === 'speed') return (v, axis) => (axis ? fmt(v) : `${fmt(v)} ${speedUnit()}`);
  if (key === 'incline') return (v, axis) => (axis ? fmt(v) : `incline ${fmt(v)}`);
  if (key === 'rounds') return (v, axis) => (axis ? fmt(v) : `${fmt(v)} intervals`);
  if (key === 'level') return (v, axis) => (axis ? fmt(v) : `level ${fmt(v)}`);
  return (v) => fmt(v);
}

// Builds the body weight chart and stats for a date range.
function bodyWeightSection(from, to) {
  const state = S();
  const list = M.bodyWeights(state, from, to);
  const latest = M.bodyWeights(state).pop();
  // Formats a body weight, without the unit on chart axes.
  const fmtW = (v, axis) => (axis ? nf1.format(v) : `${nf1.format(v)} ${unit()}`);
  charts.push({
    id: 'chart-body',
    draw: (node) => lineChart(node, list.map((b) => ({ x: b.date, y: b.weight, tip: `${fmtDate(b.date)} · ${esc(fmtW(b.weight))} · 7-day avg ${nf1.format(M.bodyWeightAverage(state, b.date))}` })), { fmtY: fmtW, fmtX: (p) => fmtDate(p.x, { month: 'short', day: 'numeric' }), emptyMsg: 'No weigh-ins in this range. Log your scale weight on the Log tab.' }),
  });
  const change = list.length > 1 ? M.round(list[list.length - 1].weight - list[0].weight, 1) : null;
  return `<section class="card stack"><h3>Body weight</h3>
    <div class="prs">
      <div class="stat"><div class="k">Latest</div><div class="v">${latest ? `${nf1.format(latest.weight)}` : '–'}</div>${latest ? `<div class="muted small">${fmtDate(latest.date, { month: 'short', day: 'numeric' })}</div>` : ''}</div>
      <div class="stat"><div class="k">7-day avg</div><div class="v">${latest ? nf1.format(M.bodyWeightAverage(state, latest.date)) : '–'}</div></div>
      <div class="stat"><div class="k">Change (range)</div><div class="v">${change === null ? '–' : `${change > 0 ? '+' : ''}${nf1.format(change)}`}</div>${change !== null ? `<div class="muted small">${unit()}</div>` : ''}</div>
    </div>
    <div class="chart" id="chart-body"></div></section>`;
}

const CAL_STATUS = { done: 'done', partial: 'partly done', missed: 'missed', pending: 'not done yet', rest: 'rest day', future: 'coming up', before: 'before tracking started' };
const GOALS = [
  ['workouts', 'Workouts'],
  ['cardio', 'Cardio'],
  ['core', 'Core'],
  ['vacuum', 'Vacuums'],
];

// Describes a calendar day for screen readers.
function calDayLabel(day, today) {
  const head = `${fmtDate(day.date, { weekday: 'long', month: 'long', day: 'numeric' })}${day.date === today ? ' (today)' : ''}: ${CAL_STATUS[day.status]}`;
  if (day.status === 'before' || day.status === 'future') return head;
  const vac = { done: 'vacuums done', partial: `vacuums ${day.vacuumHolds} of ${day.vacuumTarget}`, missed: 'vacuums missed', pending: 'vacuums not done yet' }[day.vacuum];
  const bits = [day.cardio ? `cardio ${fmt(day.cardioMin)} min` : '', day.core ? 'core' : '', vac || ''].filter(Boolean);
  return bits.length ? `${head}, ${bits.join(', ')}` : head;
}

// Builds the Consistency card on the Progress tab: streaks, this week's goals and a month calendar.
function consistencyCard() {
  const state = S();
  const today = M.todayISO();
  const ctx = { today, start: M.consistencyStart(state) };
  const cur = today.slice(0, 7);
  const min = (ctx.start && ctx.start < today ? ctx.start : today).slice(0, 7);
  const asked = ui.progress.month || cur;
  const ym = asked > cur ? cur : asked < min ? min : asked;
  // Keep the shown month, so Previous / Next step from what's on screen.
  ui.progress.month = ym === cur ? null : ym;
  const { workout: w, vacuum: v } = M.currentStreaks(state, ctx);
  const best = M.bestStreaks(state, ctx);
  const weekStart = state.settings.weekStart;
  const ws = M.startOfWeek(today, weekStart);
  const wk = M.consistencyDays(state, ws, M.addDays(ws, 6), ctx);
  const tot = M.consistencyTotals(wk);
  const grid = M.monthGrid(state, ym, ctx);

  // Adds the best streak to a tile's sub-line, or "your best yet" when this is it.
  const bestNote = (x, b) => (x.count === b && x.count >= 3 ? ' · your best yet' : b > 0 ? ` · best ${b}` : '');
  const wSub = (w.pendingToday ? (w.count ? 'Log a workout today to keep it going' : 'Log a workout today to start one') : w.doneToday ? 'Done today' : "Rest days don't break it") + bestNote(w, best.workout);
  const vSub = (v.doneToday ? 'Done today' : v.pendingToday ? 'Not done yet today' : 'No vacuums planned today') + bestNote(v, best.vacuum);

  const goals = GOALS.map(([key, label]) => {
    const g = tot[key];
    // Workouts on unscheduled days are shown apart, so "n/n" only means every planned day was done.
    const extra = g.extra || 0;
    if (!g.planned && !g.done && !extra) return '';
    const pips = wk.map((d) => `<i class="pip" data-pip="${M.habitPip(d, key, today)}"></i>`).join('');
    const k = extra && g.planned ? `${label} <small class="muted">+${extra}<span class="xw"> extra</span></small>` : label;
    return `<div class="goal" data-goal="${key}" ${goalMet(g)}><span class="k">${k}</span><span class="pips" aria-hidden="true">${pips}</span><b class="num">${g.planned ? `${g.done}/${g.planned}` : g.done + extra}</b></div>`;
  }).join('');

  const head = Array.from({ length: 7 }, (_, i) => `<span class="wd" aria-hidden="true">${M.WEEKDAY_SHORT[(weekStart + i) % 7][0]}</span>`).join('');
  const cells = grid.weeks
    .flat()
    .map((day) => {
      if (!day.inMonth) return '<span class="cal-day out" aria-hidden="true"></span>';
      const vac = day.vacuum === 'done' || day.vacuum === 'partial' ? day.vacuum : '';
      return `<button type="button" class="cal-day" data-action="open-date" data-date="${day.date}" data-status="${day.status}" data-vac="${vac}" ${day.date === today ? 'aria-current="date"' : ''} aria-label="${esc(calDayLabel(day, today))}"><span class="dn">${M.parseISODate(day.date).getDate()}</span><i class="vac"></i></button>`;
    })
    .join('');

  const mt = grid.totals;
  // Formats a done/planned pair for the month summary, or nothing when both are 0.
  const pair = (label, g) => (g.planned || g.done ? ` · ${label} ${g.done}/${g.planned}` : '');
  const summary = !ctx.start
    ? 'Log your first workout to start tracking. Days before your first log never count as missed.'
    : `${fmtDate(`${ym}-01`, { month: 'long' })}${ym === cur ? ' so far' : ''}: ${mt.workouts.done} of ${mt.workouts.planned} workouts${mt.workouts.extra ? ` · ${mt.workouts.extra} extra` : ''}${mt.missed ? ` · ${mt.missed} missed` : ''}${pair('cardio', mt.cardio)}${pair('core', mt.core)} · vacuums ${mt.vacuum.done}/${mt.vacuum.planned}`;
  const rules = `A workout counts once you finish a working set (warm-ups don't count), ${M.CARDIO_SESSION_MIN}+ minutes of cardio in one go or an interval session, so the warm-up bike alone doesn't. Partly done still keeps your streak. Rest days never break it, unless ${M.STREAK_GAP_DAYS} days in a row pass with nothing planned or done; a past workout day with nothing logged does, and today only counts as missed once it's over. To excuse a day (sick, travelling), open it on the Log and set it to Rest; vacuums are still due. Workouts on Rest days show as extra. Cardio counts at ${M.CARDIO_SESSION_MIN}+ minutes in one entry or a finished interval session, core with ${M.CORE_SESSION_MIN}+ different core exercises, and vacuums once you've done the day's planned holds. Weekly goals come from your plan. Days before your first log are never counted.`;

  return `<section class="card stack consistency" id="consistency" aria-labelledby="consistency-h">
    <h3 id="consistency-h">Consistency</h3>
    <div class="streaks">
      <div class="stat" data-streak="workout" ${streakState(w)}><div class="k">Workout streak</div><div class="v">${w.count}<small> in a row</small></div><div class="sub">${esc(wSub)}</div></div>
      <div class="stat" data-streak="vacuum" ${streakState(v)}><div class="k">Vacuum streak</div><div class="v">${v.count}<small> ${v.count === 1 ? 'day' : 'days'}</small></div><div class="sub">${esc(vSub)}</div></div>
    </div>
    <div class="goals stack">
      <div class="spread"><span class="label">This week</span><span class="muted small">${fmtDate(ws, { month: 'short', day: 'numeric' })} – ${fmtDate(M.addDays(ws, 6), { month: 'short', day: 'numeric' })}</span></div>
      ${goals}
    </div>
    <div class="cal-nav">
      <button type="button" class="icon-btn" data-action="cal-month" data-delta="-1" aria-label="Previous month" ${ym <= min ? 'disabled' : ''}>${ICON.left}</button>
      <h4 id="cal-title">${fmtDate(`${ym}-01`, { month: 'long', year: 'numeric' })}</h4>
      <button type="button" class="icon-btn" data-action="cal-month" data-delta="1" aria-label="Next month" ${ym >= cur ? 'disabled' : ''}>${ICON.right}</button>
    </div>
    <div class="cal" role="group" aria-labelledby="cal-title">${head}${cells}</div>
    <ul class="cal-legend">
      <li><i class="cal-sw" data-status="done"></i>Done</li>
      <li><i class="cal-sw" data-status="partial"></i>Partly</li>
      <li><i class="cal-sw" data-status="missed"></i>Missed</li>
      <li><i class="cal-sw" data-status="rest"></i>Rest</li>
      <li><i class="cal-sw vac-sw"></i>Vacuums done</li>
    </ul>
    <p class="hint">${esc(summary)}</p>
    <details class="rules"><summary>How it counts</summary><p>${esc(rules)}</p></details>
  </section>`;
}

// Builds the Progress tab.
function progressView() {
  const state = S();
  const [from, to] = rangeBounds();
  const sum = M.rangeSummary(state, from, to);
  const p = ui.progress;

  // Activity chart: daily buckets for short ranges, weekly otherwise.
  const span = M.daysBetween(from, to) + 1;
  const daily = span <= 31;
  const buckets = [];
  if (daily) {
    for (let d = from; d <= to; d = M.addDays(d, 1)) buckets.push({ start: d, ...M.rangeSummary(state, d, d) });
  } else {
    for (const w of M.weeklySummaries(state, from, to, state.settings.weekStart)) buckets.push({ start: w.week, ...w });
  }
  const CHARTS = {
    volume: ['Volume', (b) => b.volume, (v, axis) => (axis ? fmtCompact(v) : `${fmt(v)} ${unit()}`)],
    sets: ['Sets', (b) => b.sets, (v) => fmt(v)],
    cardio: ['Cardio', (b) => b.cardioMin, (v, axis) => (axis ? fmt(v) : `${fmt(v)} min`)],
    vacuum: ['Vacuum', (b) => b.vacuumSec, (v) => fmtSec(v)],
  };
  const [, getY, fmtY] = CHARTS[p.chart];
  const bars = buckets.map((b) => ({
    label: b.start,
    y: getY(b),
    tip: `${daily ? fmtDate(b.start) : `Week of ${fmtDate(b.start, { month: 'short', day: 'numeric' })}`} · ${esc(fmtY(getY(b)))}`,
  }));
  charts.push({ id: 'chart-activity', draw: (node) => barChart(node, bars, { fmtY, fmtX: (b) => fmtDate(b.label, { month: 'short', day: 'numeric' }), emptyMsg: 'Nothing logged in this range yet' }) });

  // Exercise progress
  const logged = M.loggedExerciseIds(state).filter((id) => state.exercises[id] && !state.exercises[id].deleted);
  const all = M.activeExercises(state);
  // Default to the most recently trained exercise until you pick one.
  if (!p.picked || !state.exercises[p.exerciseId] || state.exercises[p.exerciseId].deleted) p.exerciseId = logged[0] || all[0]?.id || null;
  const ex = p.exerciseId ? state.exercises[p.exerciseId] : null;
  let exSection = '<p class="hint">Add exercises to see progress.</p>';
  if (ex) {
    const metrics = EX_METRICS[ex.kind];
    const allHist = M.exerciseHistory(state, ex.id);
    if (!metrics.find((m) => m[0] === p.metric)) {
      // Bodyweight exercises default to reps instead of an empty 1RM chart.
      const bodyweight = ex.kind === 'strength' && allHist.length && allHist.every((h) => !h.metrics.topWeight);
      p.metric = bodyweight ? 'reps' : metrics[0][0];
    }
    const [mKey, , mGet] = metrics.find((m) => m[0] === p.metric);
    const fmtM = metricFormatter(ex.kind, mKey);
    const hist = M.exerciseHistory(state, ex.id, from, to);
    const points = hist.map((h) => ({ x: h.date, y: mGet(h.metrics), tip: `${fmtDate(h.date)} · ${esc(fmtM(mGet(h.metrics)))}${h.entry.rpe ? ` · RPE ${fmt(h.entry.rpe)}` : ''}` })).filter((pt) => pt.y > 0 || mKey !== 'pace');
    charts.push({ id: 'chart-exercise', draw: (node) => lineChart(node, points, { fmtY: fmtM, fmtX: (pt) => fmtDate(pt.x, { month: 'short', day: 'numeric' }), emptyMsg: `No ${esc(ex.name)} logged in this range` }) });

    // Finds the logged session with the best value of a metric.
    const best = (fn, cmp = (a, b) => a > b) => allHist.reduce((b, h) => (fn(h.metrics) && (!b || cmp(fn(h.metrics), fn(b.metrics))) ? h : b), null);
    let prs;
    if (ex.kind === 'strength') {
      const b1 = best((m) => m.e1rm);
      const bw = best((m) => m.topWeight);
      const bv = best((m) => m.volume);
      const br = best((m) => m.reps);
      prs = b1
        ? [
            ['Best est. 1RM', `${fmt(b1.metrics.e1rm)} ${unit()}`, b1.date],
            ['Heaviest set', `${fmt(bw.metrics.topWeight)}×${fmt(bw.metrics.topReps)}`, bw.date],
            ['Best volume', `${fmtCompact(bv.metrics.volume)} ${unit()}`, bv.date],
          ]
        : [
            ['Most reps', br ? fmt(br.metrics.reps) : '–', br?.date],
            ['Sessions', String(allHist.length), null],
            ['Last', allHist.length ? setSummary(allHist[allHist.length - 1].entry) : '–', allHist[allHist.length - 1]?.date],
          ];
    } else if (ex.kind === 'cardio') {
      const bm = best((m) => m.minutes);
      const bd = best((m) => m.distance);
      const bp = best((m) => m.pace, (a, b) => a < b);
      prs = [
        ['Longest', bm ? `${fmt(bm.metrics.minutes)} min` : '–', bm?.date],
        ['Farthest', bd ? `${fmt(bd.metrics.distance)} ${dunit()}` : '–', bd?.date],
        ['Best pace', bp ? fmtPace(bp.metrics.pace) : '–', bp?.date],
      ];
    } else {
      const bl = best((m) => m.longestHold);
      const bt = best((m) => m.totalHold);
      prs = [
        ['Longest hold', bl ? fmtSec(bl.metrics.longestHold) : '–', bl?.date],
        ['Most total hold', bt ? fmtSec(bt.metrics.totalHold) : '–', bt?.date],
        ['Sessions', String(allHist.length), null],
      ];
    }
    const rows = hist
      .slice()
      .reverse()
      .map((h) => `<tr><td><button type="button" class="link-btn" data-action="open-date" data-date="${h.date}">${fmtDate(h.date)}</button></td><td>${esc(setSummary(h.entry))}</td><td class="r">${h.entry.rpe ? fmt(h.entry.rpe) : '–'}</td><td class="r">${esc(fmtM(mGet(h.metrics)))}</td></tr>`)
      .join('');

    // Builds an option group of exercises for the Progress picker.
    const options = (ids, label) => (ids.length ? `<optgroup label="${label}">${ids.map((id) => `<option value="${esc(id)}" ${id === ex.id ? 'selected' : ''}>${esc(state.exercises[id].name)}</option>`).join('')}</optgroup>` : '');
    const unlogged = all.map((e) => e.id).filter((id) => !logged.includes(id));
    exSection = `
      <select data-field="progress-exercise" aria-label="Exercise">${options(logged, 'Logged')}${options(unlogged, 'Not logged yet')}</select>
      <div class="seg" role="group" aria-label="Metric">${metrics.map(([k, label]) => `<button type="button" data-action="progress-metric" data-metric="${k}" aria-pressed="${k === mKey}">${label}</button>`).join('')}</div>
      <div class="chart" id="chart-exercise"></div>
      <div class="prs">${prs.map(([k, v, d]) => `<div class="stat"><div class="k">${k}</div><div class="v">${esc(v)}</div>${d ? `<div class="muted small">${fmtDate(d, { month: 'short', day: 'numeric', year: '2-digit' })}</div>` : ''}</div>`).join('')}</div>
      ${rows ? `<div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th>${ex.kind === 'strength' ? 'Sets (weight×reps)' : M.isHold(ex.kind) ? 'Holds' : 'Session'}</th><th class="r">RPE</th><th class="r">${esc(metrics.find((m) => m[0] === mKey)[1])}</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}`;
  }

  // Session history (newest first, at most 150 rows)
  const rows = [];
  const dates = M.sessionDates(state).filter((d) => d >= from && d <= to);
  for (let i = dates.length - 1; i >= 0 && rows.length < 150; i--) {
    const d = dates[i];
    const s = state.sessions[d];
    const worked = s.entries.filter(M.entryHasWork);
    if (!worked.length && !s.notes) continue;
    const r = M.rangeSummary(state, d, d);
    const bits = [r.sets ? `${r.sets} sets · ${fmtCompact(r.volume)} ${unit()}` : '', r.cardioMin ? `${fmt(r.cardioMin)} min cardio` : '', r.vacuumSec ? `${fmtSec(r.vacuumSec)} vacuum` : ''].filter(Boolean).join(' · ');
    rows.push(`<button type="button" class="history-item" data-action="open-date" data-date="${d}">
      <div class="d"><span>${fmtDate(d, { month: 'short' })}</span><b>${M.parseISODate(d).getDate()}</b></div>
      <div class="body"><div class="t">${esc(s.name || M.DAY_TYPES[s.dayType])} <span class="muted small">${fmtDate(d, { weekday: 'short' })}</span></div>
      <div class="s">${bits || 'Notes only'} — ${esc(worked.map((e) => M.exerciseName(state, e.exerciseId)).join(', '))}</div></div>
      <span class="muted">${ICON.right}</span></button>`);
  }
  const history = rows.join('');

  return `
  <div class="spread"><h2>Progress</h2><span class="muted small">${fmtDate(from, { month: 'short', day: 'numeric', year: 'numeric' })} – ${fmtDate(to, { month: 'short', day: 'numeric', year: 'numeric' })}</span></div>
  <div class="seg" role="group" aria-label="Time range">${Object.entries(RANGES).map(([k, [label]]) => `<button type="button" data-action="progress-range" data-range="${k}" aria-pressed="${k === p.range}">${label}</button>`).join('')}</div>
  <div class="stats">
    <div class="stat"><div class="k">Workouts</div><div class="v">${fmt(sum.workouts)}</div></div>
    <div class="stat"><div class="k">Sets</div><div class="v">${fmt(sum.sets)}</div></div>
    <div class="stat"><div class="k">Volume (${unit()})</div><div class="v">${fmtCompact(sum.volume)}</div></div>
    <div class="stat"><div class="k">Cardio</div><div class="v">${fmt(Math.round(sum.cardioMin))}<span class="small muted"> min</span></div>${sum.distance ? `<div class="muted small">${fmt(sum.distance)} ${dunit()}</div>` : ''}</div>
    <div class="stat"><div class="k">Vacuum</div><div class="v">${fmtSec(sum.vacuumSec)}</div><div class="muted small">${fmt(sum.vacuumSets)} holds</div></div>
  </div>

  ${consistencyCard()}

  ${bodyWeightSection(from, to)}

  <section class="card stack">
    <div class="spread"><h3>${daily ? 'Daily' : 'Weekly'} ${CHARTS[p.chart][0].toLowerCase()}</h3></div>
    <div class="seg" role="group" aria-label="Chart metric">${Object.entries(CHARTS).map(([k, [label]]) => `<button type="button" data-action="progress-chart" data-chart="${k}" aria-pressed="${k === p.chart}">${label}</button>`).join('')}</div>
    <div class="chart" id="chart-activity"></div>
  </section>

  <section class="card stack"><h3>Exercise progress</h3>${exSection}</section>

  <section class="card"><h3 style="margin-bottom:4px">History</h3>${history || '<p class="hint">No workouts logged in this range.</p>'}</section>`;
}

// ---------------------------------------------------------------------------
// Settings view
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Fitbit / Google Health
// ---------------------------------------------------------------------------

let google = null; // server status, see api/google/status
let googleChecked = 0;

// Describes how long ago a time was, e.g. "5 min ago".
function agoText(t) {
  const min = Math.round((Date.now() - t) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;
  return fmtDate(M.toISODate(new Date(t)), { month: 'short', day: 'numeric' });
}

// Says what the last Fitbit import found, so "no data" is easy to tell from "not working".
function foundText(f) {
  if (!f) return '';
  // Formats a count with the right singular or plural word.
  const n = (v, one, many) => `${v} ${v === 1 ? one : many}`;
  const range = f.from && f.to ? ` (${fmtDate(f.from, { month: 'short', day: 'numeric' })} – ${fmtDate(f.to, { month: 'short', day: 'numeric' })})` : '';
  const bits = [n(f.steps || 0, 'day of steps', 'days of steps'), n(f.sleep || 0, 'sleep', 'sleeps'), n(f.restingHr || 0, 'resting HR', 'resting HRs'), n(f.weight || 0, 'weigh-in', 'weigh-ins'), n(f.exercise || 0, 'workout', 'workouts')];
  return `<p class="hint">Last import found${range}: ${esc(bits.join(' · '))}.</p>`;
}

// Builds the Fitbit card in Settings for the current connection state.
function googleCard() {
  const g = google;
  let body;
  if (!g) {
    body = `<p class="hint">${store.status === 'local' ? 'Needs the server (the Render app) to connect.' : 'Checking…'}</p>`;
  } else if (g.auth) {
    body = '<p class="hint">Enter your server password above first.</p>';
  } else if (!g.configured) {
    body = `<p class="hint">Bring in steps, resting heart rate, sleep, weigh-ins and workouts from your Fitbit. To turn it on, add <b>GOOGLE_CLIENT_ID</b> and <b>GOOGLE_CLIENT_SECRET</b> to the server's environment (Render → Environment), and register this redirect URI in Google Cloud:</p>
      <code class="copy">${esc(g.redirectUri)}</code>`;
  } else if (!g.connected || g.needsReconnect) {
    body = `<p class="hint">${g.needsReconnect ? '<b>Google sign-in expired.</b> Connect again to keep importing.' : 'Sign in with the Google account your Fitbit uses. The app imports steps, resting heart rate, sleep, weigh-ins (unless you typed one in yourself) and workouts, read-only.'}</p>
      <button type="button" class="btn primary" data-action="google-connect" style="align-self:flex-start">Connect Fitbit</button>`;
  } else {
    body = `<p class="hint">Connected${g.lastSync ? ` · last import ${agoText(g.lastSync)}` : ''}. New data comes in when you open the app.</p>
      ${foundText(g.lastFound)}
      ${g.missing?.length ? `<p class="hint warn">Google didn't allow access to your ${esc(g.missing.join(' or '))}. Tap <b>Connect again</b> and tick every box on Google's screen.</p>` : ''}
      ${g.lastError ? `<p class="hint warn">${esc(g.lastError)}</p>` : ''}
      <div class="row wrap">
        ${g.missing?.length ? '<button type="button" class="btn sm primary" data-action="google-connect">Connect again</button>' : ''}
        <button type="button" class="btn sm" data-action="google-sync">Import now</button>
        <button type="button" class="btn sm danger" data-action="google-disconnect">Disconnect</button>
      </div>`;
  }
  return `<section class="card stack" id="google-card"><h3>Fitbit</h3>${body}</section>`;
}

// Redraws just the Fitbit card in Settings.
function renderGoogleCard() {
  const node = document.getElementById('google-card');
  if (node && !isTyping()) node.outerHTML = googleCard();
}

// Asks the server for the Fitbit connection status and updates the card.
async function refreshGoogle() {
  if (store.status === 'local') return null;
  try {
    google = await store.request('api/google/status');
  } catch (err) {
    google = err.status === 401 ? { auth: true } : err.data?.configured !== undefined ? err.data : null;
  }
  googleChecked = Date.now();
  renderGoogleCard();
  return google;
}

/** Import from Fitbit (the server skips it if it ran in the last few minutes). */
async function googleImport(force = false) {
  try {
    const res = await store.request('api/google/sync', { method: 'POST', body: { force, today: M.todayISO() } });
    google = res;
    renderGoogleCard();
    // After a forced import (e.g. right after connecting) the server may have
    // new data from an import that already ran, so always pull it.
    if (res.changed || force) await store.sync();
    return res;
  } catch (err) {
    if (err.data?.configured !== undefined) google = err.data;
    renderGoogleCard();
    throw err;
  }
}

// Checks the Fitbit connection and imports new data, at most every 10 minutes.
async function autoGoogle() {
  if (Date.now() - googleChecked < 10 * 60 * 1000) return;
  const g = await refreshGoogle();
  if (g?.configured && g.connected && !g.needsReconnect) googleImport().catch(() => {});
}

// ---------------------------------------------------------------------------
// Timer alerts: notifications when rest or an interval ends with the app closed
// ---------------------------------------------------------------------------

const ALERTS_KEY = 'workout-logbook:alerts';
let alertsSent = false;

// Tells whether this browser can receive push notifications at all.
function alertsSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

// Tells whether this is an iPhone/iPad browser tab rather than the Home Screen app.
function iosTab() {
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return ios && !(navigator.standalone || matchMedia('(display-mode: standalone)').matches);
}

// Tells whether timer alerts are turned on for this device.
function alertsOn() {
  try {
    return localStorage.getItem(ALERTS_KEY) === '1' && alertsSupported() && Notification.permission === 'granted';
  } catch {
    return false;
  }
}

// Turns the server's base64url public key into the bytes the browser wants.
function keyBytes(b64) {
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// Asks for notification permission, subscribes this device and tells the server.
async function enableAlerts() {
  if (!alertsSupported()) return toast(iosTab() ? 'Add the app to your Home Screen first' : 'This browser can’t show notifications');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return toast('Notifications are blocked. Allow them in your phone’s settings for this app.');
  try {
    const reg = await navigator.serviceWorker.ready;
    const { publicKey } = await store.request('api/push/key');
    const key = keyBytes(publicKey);
    let sub = await reg.pushManager.getSubscription();
    // A subscription made with an older server key won't work; replace it.
    const old = sub?.options?.applicationServerKey;
    if (sub && old && !new Uint8Array(old).every((b, i) => b === key[i])) {
      await sub.unsubscribe();
      sub = null;
    }
    sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await store.request('api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
    localStorage.setItem(ALERTS_KEY, '1');
    toast('Timer alerts on');
  } catch (err) {
    toast(`Couldn’t turn on alerts: ${err.message}`);
  }
  renderAlertsCard();
}

// Unsubscribes this device from timer alerts.
async function disableAlerts() {
  try {
    localStorage.removeItem(ALERTS_KEY);
    const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
    if (sub) {
      await store.request('api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
      await sub.unsubscribe();
    }
    toast('Timer alerts off');
  } catch (err) {
    toast(err.message);
  }
  renderAlertsCard();
}

/** The notifications to send for the running timers: rest end and each interval switch. */
function pendingAlerts(now = Date.now()) {
  const items = [];
  if (rest && !rest.done && rest.endsAt > now) {
    items.push({ at: rest.endsAt, title: 'Rest over', body: rest.label ? `${rest.label} · next set!` : 'Next set!', tag: 'rest' });
  }
  if (hiit && !hiit.pausedAt) {
    const pos = M.hiitPosition(hiit.phases, hiitElapsed());
    if (!pos.done) {
      let at = now + pos.remaining * 1000;
      for (let i = pos.index + 1; i < hiit.phases.length; i++) {
        const p = hiit.phases[i];
        items.push({ at, title: p.kind === 'hard' ? `Go hard! ${p.label}` : p.label, body: `${hiit.name} · ${fmtClock(p.sec)}`, tag: 'hiit' });
        at += p.sec * 1000;
      }
      items.push({ at, title: 'HIIT done', body: `${hiit.name} · open the app to log it`, tag: 'hiit' });
    }
  }
  return items;
}

/** Tells the server which alerts to push while the app is hidden, or cancels them. */
function sendTimerAlerts(hidden) {
  if (!alertsOn()) return;
  const items = hidden ? pendingAlerts() : [];
  if (!items.length && !alertsSent) return;
  alertsSent = items.length > 0;
  store.request('api/push/schedule', { method: 'POST', body: { items }, keepalive: true }).catch(() => {});
}

// Builds the Timer alerts card in Settings.
function alertsCard() {
  let body;
  if (!alertsSupported() || iosTab()) {
    body = iosTab()
      ? '<p class="hint">To get an alert when rest or an interval ends with the app closed or your phone locked, add this app to your Home Screen (Share → Add to Home Screen), open it from there, and turn alerts on here. iPhone only allows notifications for Home Screen apps.</p>'
      : '<p class="hint">This browser can’t show notifications.</p>';
  } else if (store.status === 'local') {
    body = '<p class="hint">Needs the server (the Render app) to send alerts.</p>';
  } else if (alertsOn()) {
    body = `<p class="hint">On for this device. When the app is closed or your phone is locked, you get a notification (with your phone’s sound and vibration) when rest ends and at each interval switch.</p>
      <div class="row wrap"><button type="button" class="btn sm" data-action="alerts-test">Send a test</button><button type="button" class="btn sm danger" data-action="alerts-off">Turn off</button></div>`;
  } else {
    body = `<p class="hint">Get a notification when rest or an interval ends, even with the app closed or your phone locked.${typeof Notification !== 'undefined' && Notification.permission === 'denied' ? ' <b>Notifications are blocked</b> for this app; allow them in your phone’s settings first.' : ''}</p>
      <button type="button" class="btn primary" data-action="alerts-on" style="align-self:flex-start">Turn on timer alerts</button>`;
  }
  return `<section class="card stack" id="alerts-card"><h3>Timer alerts</h3>${body}</section>`;
}

// Redraws just the Timer alerts card in Settings.
function renderAlertsCard() {
  const node = document.getElementById('alerts-card');
  if (node) node.outerHTML = alertsCard();
}

// Builds the Settings tab.
function settingsView() {
  const state = S();
  const st = state.settings;
  // Builds a segmented on/off style control for a setting.
  const seg = (action, value, opts) => `<div class="seg" role="group">${opts.map(([v, l]) => `<button type="button" data-action="${action}" data-value="${v}" aria-pressed="${String(value) === String(v)}">${l}</button>`).join('')}</div>`;
  return `
  <h2>Settings</h2>
  <section class="card">
    <h3>Rest timer</h3>
    <div class="settings-row"><span>Start automatically after each set</span>${seg('set-autorest', st.autoRest, [[true, 'On'], [false, 'Off']])}</div>
    <div class="settings-row"><span>Compound lifts (bench, squat, deadlift, rows, presses) · 90–120 s, max 180 s</span>${stepper({ scope: 'setting', key: 'restCompound', value: st.restCompound })}</div>
    <div class="settings-row"><span>Isolation lifts (curls, leg extensions, lateral raises) · 60–75 s, max 120 s</span>${stepper({ scope: 'setting', key: 'restIsolation', value: st.restIsolation })}</div>
    <div class="settings-row"><span>Planks and other holds (seconds)</span>${stepper({ scope: 'setting', key: 'restSec', value: st.restSec })}</div>
    <div class="settings-row"><span>Sound when rest is over</span>${seg('set-restsound', st.restSound, [[true, 'On'], [false, 'Off']])}</div>
    <p class="hint">Exercises can have their own rest time (Plan tab → More options). Phones may silence sounds while the screen is locked; the timer still keeps time.</p>
  </section>

  ${alertsCard()}

  <section class="card">
    <h3>Units</h3>
    <div class="settings-row"><span>Weight unit</span>${seg('set-unit', st.unit, [['lb', 'lb'], ['kg', 'kg']])}</div>
    <div class="settings-row"><span>Distance &amp; speed</span>${seg('set-dunit', st.distanceUnit, [['mi', 'mi · mph'], ['km', 'km · km/h']])}</div>
    <div class="settings-row"><span>Weight +/− step</span>${stepper({ scope: 'setting', key: 'weightStep', value: st.weightStep })}</div>
    <div class="settings-row"><span>Week starts on</span>${seg('set-weekstart', st.weekStart, [[1, 'Monday'], [0, 'Sunday']])}</div>
    <p class="hint">US units (lb, mi, mph) are the default. Switching units relabels numbers; it doesn't convert past entries.</p>
  </section>

  <section class="card stack">
    <h3>Sync &amp; backup</h3>
    <p class="hint" id="sync-detail">${syncDetail()}</p>
    <form class="row" data-form="password" autocomplete="off">
      <input type="password" name="pw" placeholder="${store.hasPassword() ? 'Password saved – enter to change' : 'Server password'}" aria-label="Server password" autocomplete="current-password">
      <button type="submit" class="btn">Save</button>
    </form>
    <div class="row wrap">
      <button type="button" class="btn sm" data-action="sync-now">Sync now</button>
      <button type="button" class="btn sm" data-action="export-json">Download backup (JSON)</button>
      <button type="button" class="btn sm" data-action="export-csv">Export sets (CSV)</button>
      <label class="btn sm">Restore backup…<input type="file" accept="application/json,.json" data-field="import" hidden></label>
    </div>
  </section>

  ${googleCard()}

  <section class="card stack">
    <h3>Tips</h3>
    <p class="hint">On your phone, open this page in Safari or Chrome and choose <b>Add to Home Screen</b> to use it like an app (it works offline too).</p>
    <p class="hint">“+” on an exercise marks the next set done and starts your rest timer; “−” undoes the last set. Tap a set number to mark it as a warm-up, drop set or set to failure. ⇄ swaps an exercise for a similar one.</p>
    <button type="button" class="btn sm danger" data-action="reset-all" style="align-self:flex-start">Erase all data…</button>
  </section>`;
}

// ---------------------------------------------------------------------------
// Exercises tab: every exercise with its form videos
// ---------------------------------------------------------------------------

// Builds a tappable thumbnail for one form video.
function videoTile([title, url]) {
  const id = youtubeId(url);
  if (!id) return '';
  return `<button type="button" class="video-tile" data-action="video" data-url="${esc(url)}" data-title="${esc(title)}" aria-label="Play video: ${esc(title)}">
    <span class="video-thumb"><img src="https://i.ytimg.com/vi/${id}/mqdefault.jpg" alt="" loading="lazy" referrerpolicy="no-referrer"><span class="play">${ICON.play}</span></span>
    <span class="t">${esc(title)}</span></button>`;
}

// Builds the Exercises tab with every exercise and its form videos.
function exercisesView() {
  const state = S();
  const { q, group } = ui.lib;
  const all = M.activeExercises(state);
  const groups = ['All', ...new Set(all.map((e) => e.group || 'Other').sort())];
  const needle = q.trim().toLowerCase();
  const list = all.filter((e) => (group === 'All' || (e.group || 'Other') === group) && (!needle || e.name.toLowerCase().includes(needle) || (e.group || '').toLowerCase().includes(needle)));
  const withVideos = all.filter((e) => VIDEOS[e.id]).length;
  const items = list
    .map((e) => {
      const vids = VIDEOS[e.id] || [];
      return `<article class="card lib-ex">
        <div class="lib-ex-head"><h3>${esc(e.name)}</h3><span class="badge ${e.kind}">${M.KINDS[e.kind]}</span>${e.group ? `<span class="muted small">${esc(e.group)}</span>` : ''}</div>
        ${e.cue ? `<div class="cue">${esc(e.cue)}</div>` : ''}
        ${vids.length ? `<div class="videos">${vids.map(videoTile).join('')}</div>` : '<p class="hint">No video yet.</p>'}
        <div><button type="button" class="btn sm" data-action="lib-add" data-ex="${esc(e.id)}">+ Add to today</button></div>
      </article>`;
    })
    .join('');
  const workouts = !needle && group === 'All' ? `<section class="card stack"><h3>Full workouts</h3><div class="videos">${WORKOUT_VIDEOS.map(videoTile).join('')}</div></section>` : '';
  return `<div class="stack"><h2>Exercises</h2><p class="hint">${all.length} exercises, ${withVideos} with form videos. Tap a video to play it.</p></div>
    <div class="lib-search"><input type="search" data-field="lib-q" value="${esc(q)}" placeholder="Search exercises" aria-label="Search exercises" autocomplete="off"></div>
    <div class="seg" role="group" aria-label="Muscle group">${groups.map((g) => `<button type="button" data-action="lib-group" data-group="${esc(g)}" aria-pressed="${g === group}">${esc(g)}</button>`).join('')}</div>
    ${workouts}
    ${items || '<p class="hint">No exercises match.</p>'}`;
}

// Opens a form video in the in-app player sheet.
function openVideo(url, title) {
  const id = youtubeId(url);
  if (!id) return;
  ui.sheet = { mode: 'video' };
  $sheetPanel.innerHTML = `
    <div class="spread"><h2 id="sheet-title">${esc(title)}</h2>
      <button type="button" class="icon-btn" data-action="close-sheet" aria-label="Close">${ICON.close}</button></div>
    <iframe class="video-frame" src="https://www.youtube-nocookie.com/embed/${id}?playsinline=1&rel=0&modestbranding=1" title="${esc(title)}" allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>
    <a class="btn sm" href="https://youtu.be/${id}" target="_blank" rel="noopener">Open in YouTube</a>`;
  $sheet.hidden = false;
}

const VIEWS = { log: logView, plan: planView, exercises: exercisesView, progress: progressView, settings: settingsView };

// ---------------------------------------------------------------------------
// Exercise picker sheet (add / swap / create)
// ---------------------------------------------------------------------------

// Returns the title for the exercise picker sheet.
function sheetTitle(ctx) {
  if (ctx.mode === 'swap' || ctx.mode === 'plan-swap') return 'Swap for…';
  if (ctx.mode === 'plan') return `Add to ${M.planLabel(S(), ctx.wd)}`;
  return `Add to ${fmtDate(ui.date)}`;
}

// Opens the exercise picker sheet for adding or swapping an exercise.
function openSheet(ctx) {
  ui.sheet = { q: '', kind: 'all', ...ctx };
  $sheetPanel.innerHTML = `
    <div class="spread"><h2 id="sheet-title">${esc(sheetTitle(ctx))}</h2>
      <button type="button" class="icon-btn" data-action="close-sheet" aria-label="Close">${ICON.close}</button></div>
    <input type="search" id="sheet-q" placeholder="Search or type a new name" autocomplete="off" aria-label="Search exercises">
    <div class="seg" role="group" aria-label="Filter by type" id="sheet-kinds"></div>
    <div class="sheet-list" id="sheet-list"></div>`;
  $sheet.hidden = false;
  renderSheetList();
  const q = document.getElementById('sheet-q');
  q.addEventListener('input', () => {
    ui.sheet.q = q.value;
    renderSheetList();
  });
  setTimeout(() => q.focus(), 50);
}

// Closes the bottom sheet.
function closeSheet() {
  ui.sheet = null;
  $sheet.hidden = true;
  $sheetPanel.innerHTML = '';
}

// Redraws the exercise picker list for the current search and filter.
function renderSheetList() {
  const sh = ui.sheet;
  if (!sh || sh.mode === 'video' || sh.mode === 'hiit') return;
  const kinds = document.getElementById('sheet-kinds');
  kinds.innerHTML = [['all', 'All'], ...Object.entries(M.KINDS)].map(([k, v]) => `<button type="button" data-action="sheet-kind" data-kind="${k}" aria-pressed="${sh.kind === k}">${v}</button>`).join('');
  const q = sh.q.trim().toLowerCase();
  const list = M.activeExercises(S()).filter((e) => (sh.kind === 'all' || e.kind === sh.kind) && (!q || e.name.toLowerCase().includes(q) || e.group.toLowerCase().includes(q)));
  // For swaps, show the same muscle group first.
  if (sh.group) list.sort((a, b) => (b.group === sh.group) - (a.group === sh.group));
  const exact = M.activeExercises(S()).some((e) => e.name.toLowerCase() === q);
  const createKind = sh.kind === 'all' ? null : sh.kind;
  let create = '';
  if (q && !exact) {
    create = `<div class="card stack" style="margin:8px 0"><div>Create <b>“${esc(sh.q.trim())}”</b> as:</div><div class="row wrap">${Object.entries(M.KINDS)
      .filter(([k]) => !createKind || k === createKind)
      .map(([k, v]) => `<button type="button" class="btn sm${k === (createKind || 'strength') ? ' primary' : ''}" data-action="create-exercise" data-kind="${k}">${v}</button>`)
      .join('')}</div></div>`;
  }
  const items = list.map((e) => `<button type="button" class="pick" data-action="pick-exercise" data-ex="${esc(e.id)}"><span>${esc(e.name)}<br><span class="g">${esc(e.group)}</span></span><span class="badge ${e.kind}">${M.KINDS[e.kind]}</span></button>`).join('');
  document.getElementById('sheet-list').innerHTML = items + create || '<p class="hint">No exercises yet.</p>';
}

// Adds or swaps the picked exercise into the day or plan the sheet was opened for.
function addExerciseToContext(exId) {
  const sh = ui.sheet;
  const state = S();
  const name = M.exerciseName(state, exId);
  const kind = M.exerciseKind(state, exId);
  if (sh.mode === 'plan') {
    store.update((s) => {
      const day = s.plan[sh.wd];
      day.items.push({ id: M.uid(), exerciseId: exId, ...M.defaultTarget(kind) });
      day.updatedAt = Date.now();
    });
    toast(`Added ${name} to ${M.planLabel(state, sh.wd)}`);
  } else if (sh.mode === 'plan-swap') {
    store.update((s) => {
      const day = s.plan[sh.wd];
      const i = day.items.findIndex((it) => it.id === sh.item);
      if (i < 0) return;
      const old = day.items[i];
      const keep = { ...(old.note ? { note: old.note } : {}), ...(old.optional ? { optional: true } : {}), ...(old.supersetNext ? { supersetNext: true } : {}) };
      if (kind === 'cardio') {
        // New cardio machine: its own default settings, same duration.
        day.items[i] = { id: old.id, exerciseId: exId, ...M.defaultTarget(kind), ...M.exerciseTarget(s, exId), ...(old.minutes ? { minutes: old.minutes } : {}), ...keep };
      } else if (M.exerciseKind(s, old.exerciseId) === kind) day.items[i] = { ...old, exerciseId: exId };
      else day.items[i] = { id: old.id, exerciseId: exId, ...M.defaultTarget(kind), ...keep };
      day.updatedAt = Date.now();
    });
    toast(`Swapped to ${name}`);
  } else if (sh.mode === 'swap') {
    editSession((sess, s) => {
      const i = sess.entries.findIndex((e) => e.id === sh.entry);
      if (i < 0) return;
      const old = sess.entries[i];
      if (old.kind === kind && kind !== 'cardio') {
        // Keep the sets and targets, just change the exercise.
        old.exerciseId = exId;
      } else if (kind === 'cardio' && old.kind === 'cardio') {
        // Use the new machine's own settings (or last time's), keep the duration.
        const last = M.previousEntry(s, exId, ui.date)?.entry.target || {};
        const fresh = M.makeEntry(s, exId, { ...last, minutes: old.target.minutes, ...(old.target.note ? { note: old.target.note } : {}), ...(old.target.supersetNext ? { supersetNext: true } : {}) }, ui.date);
        fresh.id = old.id;
        sess.entries[i] = fresh;
      } else {
        const fresh = M.makeEntry(s, exId, M.previousEntry(s, exId, ui.date)?.entry.target, ui.date);
        fresh.id = old.id;
        sess.entries[i] = fresh;
      }
    });
    toast(`Swapped to ${name}`);
    dropStaleHoldTimer();
  } else if (sh.mode === 'session') {
    let newId;
    editSession((sess, s) => {
      // Use the most recent target for this exercise if you've done it before.
      const prev = M.previousEntry(s, exId, ui.date);
      const e = M.makeEntry(s, exId, prev?.entry.target, ui.date);
      newId = e.id;
      sess.entries.push(e);
    });
    closeSheet();
    toast(`Added ${name}`);
    requestAnimationFrame(() => document.querySelector(`[data-entry-id="${newId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    return;
  }
  closeSheet();
}

// ---------------------------------------------------------------------------
// Actions (clicks)
// ---------------------------------------------------------------------------

// Shows the Log for a given date.
function goDate(date) {
  if (!M.isISODate(date)) return;
  ui.date = date;
  ui.editing.clear();
  render();
}

// Stops the hold timer without logging if the set it was timing no longer exists.
function dropStaleHoldTimer() {
  if (!holdTimer) return;
  const sess = M.getSession(S(), holdTimer.date);
  if (M.findEntry(sess || { entries: [] }, holdTimer.entryId)?.sets?.some((x) => x.id === holdTimer.setId)) return;
  stopHoldTimer(false);
  render();
}

// Stops the vacuum / plank hold timer, logging the hold if asked.
function stopHoldTimer(save) {
  if (!holdTimer) return;
  clearInterval(holdTimer.interval);
  const t = holdTimer;
  holdTimer = null;
  if (!save) return;
  // The set was removed (or the day reset) while timing: nothing to log.
  const sess = M.getSession(S(), t.date);
  if (!M.findEntry(sess || { entries: [] }, t.entryId)?.sets?.some((x) => x.id === t.setId)) return;
  const sec = Math.max(1, Math.round((Date.now() - t.start) / 1000));
  let entry;
  editSession(
    (sess) => {
      const e = M.findEntry(sess, t.entryId);
      const x = e?.sets.find((s) => s.id === t.setId);
      if (x) {
        x.holdSec = sec;
        M.markSet(x, true);
        entry = e;
      }
    },
    t.date,
  );
  toast(`Logged a ${fmtSec(sec)} hold`);
  if (entry) restAfter(entry, t.date);
}

let hapticLabel = null;

/**
 * Vibrates the phone with a pattern of on/off milliseconds. Android uses the
 * Vibration API; iPhone Safari has none, so each pulse taps a hidden iOS
 * switch control, which makes the phone give a haptic tick (iOS 18+).
 */
function vibrate(pattern) {
  if (navigator.vibrate) {
    navigator.vibrate(pattern);
    return;
  }
  if (!/iP(hone|ad|od)/.test(navigator.userAgent) && !(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return;
  try {
    if (!hapticLabel) {
      hapticLabel = document.createElement('label');
      hapticLabel.setAttribute('aria-hidden', 'true');
      hapticLabel.style.cssText = 'position:fixed;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;left:-10px;top:0';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.setAttribute('switch', '');
      input.tabIndex = -1;
      hapticLabel.append(input);
      document.body.append(hapticLabel);
    }
    const steps = Array.isArray(pattern) ? pattern : [pattern];
    let at = 0;
    for (let i = 0; i < steps.length; i += 2) {
      setTimeout(() => hapticLabel.click(), at);
      at += (steps[i] || 0) + (steps[i + 1] || 0);
    }
  } catch {
    /* no haptics */
  }
}

const ACTIONS = {
  // Switches to another tab.
  tab(el) {
    ui.tab = el.dataset.tab;
    history.replaceState(null, '', `#${ui.tab}`);
    render();
    if (ui.tab === 'settings') refreshGoogle();
    window.scrollTo(0, 0);
  },
  // Moves the Log one day back or forward.
  'shift-day': (el) => goDate(M.addDays(ui.date, Number(el.dataset.delta))),
  // Shows the Log for the tapped date.
  'go-date': (el) => goDate(el.dataset.date),
  // Opens the consistency card on the Progress tab.
  'open-consistency'() {
    ui.tab = 'progress';
    history.replaceState(null, '', '#progress');
    ui.progress.month = null;
    render();
    document.getElementById('consistency')?.scrollIntoView({ block: 'start' });
  },
  // Shows the previous or next month in the consistency calendar.
  'cal-month'(el) {
    const delta = el.dataset.delta;
    const cur = M.todayISO().slice(0, 7);
    const next = M.shiftMonth(ui.progress.month || cur, Number(delta));
    // The view keeps it from going before the first logged month.
    ui.progress.month = next >= cur ? null : next;
    render();
    // Keep focus on the same arrow, or on the other one once this end is reached.
    const same = $view.querySelector(`[data-action="cal-month"][data-delta="${delta}"]`);
    (same && !same.disabled ? same : $view.querySelector('[data-action="cal-month"]:not(:disabled)'))?.focus({ preventScroll: true });
  },
  // Opens a past day (from the Progress history or calendar) on the Log.
  'open-date'(el) {
    ui.tab = 'log';
    history.replaceState(null, '', '#log');
    goDate(el.dataset.date);
    window.scrollTo(0, 0);
  },
  // Sets the day type (training, active rest or rest).
  'day-type': (el) => editSession((s) => (s.dayType = el.dataset.type)),
  // Handles a − or + tap on any stepper.
  step(el) {
    const delta = Number(el.dataset.delta);
    changeValue(el.dataset, (v, step) => {
      // Snap to the step grid so 187 + 5 → 190 rather than 192.
      const next = delta > 0 ? Math.floor(M.round(v / step, 6)) * step + step : Math.ceil(M.round(v / step, 6)) * step - step;
      return M.round(next, 2);
    });
    vibrate(5);
  },
  // Marks the next set done ("+") and starts rest or moves to the superset partner.
  'complete-set'(el) {
    let entry;
    editEntry(el.dataset.entry, (e) => {
      M.completeNextSet(e);
      entry = e;
    });
    vibrate(10);
    if (entry) restAfter(entry);
  },
  // Undoes the last finished set ("−").
  'undo-set': (el) => editEntry(el.dataset.entry, (e) => M.undoLastSet(e)),
  // Ticks or unticks one set.
  'toggle-set'(el) {
    let entry;
    let nowDone = false;
    editEntry(el.dataset.entry, (e) => {
      const x = e.sets.find((s) => s.id === el.dataset.set);
      if (!x) return;
      M.markSet(x, !x.done);
      nowDone = x.done;
      entry = e;
    });
    vibrate(10);
    if (entry && nowDone) restAfter(entry);
  },
  // Cycles a set through work, warm-up, drop and failure.
  'set-type'(el) {
    editEntry(el.dataset.entry, (e) => {
      const x = e.sets.find((s) => s.id === el.dataset.set);
      if (x) M.cycleSetType(x);
    });
  },
  // Adds a set to an entry.
  'add-set'(el) {
    editEntry(el.dataset.entry, (e) => {
      M.addSet(e);
      if (!M.isHold(e.kind)) delete e.target.repScheme;
      e.target.sets = M.isHold(e.kind) ? e.sets.length : M.workingSets(e).length;
    });
    dropStaleHoldTimer();
  },
  // Removes a set from an entry.
  'remove-set'(el) {
    editEntry(el.dataset.entry, (e) => {
      M.removeLastSet(e);
      if (!M.isHold(e.kind)) delete e.target.repScheme;
      e.target.sets = M.isHold(e.kind) ? e.sets.length : M.workingSets(e).length;
    });
  },
  // Marks a cardio entry done or not done.
  'cardio-done': (el) => editEntry(el.dataset.entry, (e) => (e.cardio.done = !e.cardio.done)),
  // Sets or clears the RPE for an entry.
  rpe(el) {
    const v = Number(el.dataset.value);
    editEntry(el.dataset.entry, (e) => (e.rpe = e.rpe === v ? 0 : v));
  },
  // Opens or closes the target editor for an entry.
  'toggle-target'(el) {
    const id = el.dataset.entry;
    if (ui.editing.has(id)) ui.editing.delete(id);
    else ui.editing.add(id);
    render();
  },
  // Moves an entry up or down in the day.
  'move-entry'(el) {
    editSession((sess) => {
      const i = sess.entries.findIndex((e) => e.id === el.dataset.entry);
      const j = i + Number(el.dataset.dir);
      if (i < 0 || j < 0 || j >= sess.entries.length) return;
      [sess.entries[i], sess.entries[j]] = [sess.entries[j], sess.entries[i]];
    });
  },
  // Removes an entry from the day, with an undo option.
  'remove-entry'(el) {
    const date = ui.date;
    let removed;
    let index;
    editSession((sess) => {
      index = sess.entries.findIndex((e) => e.id === el.dataset.entry);
      if (index >= 0) [removed] = sess.entries.splice(index, 1);
    });
    dropStaleHoldTimer();
    if (removed) {
      toast(`Removed ${M.exerciseName(S(), removed.exerciseId)}`, {
        label: 'Undo',
        run: () => editSession((sess) => sess.entries.splice(Math.min(index, sess.entries.length), 0, removed), date),
      });
    }
  },
  // Opens the picker to swap an entry for a similar exercise.
  'swap-entry'(el) {
    const { session } = dayData(ui.date);
    const e = M.findEntry(session, el.dataset.entry);
    // Store the day first so the entry id stays valid while picking.
    editSession(() => {});
    openSheet({ mode: 'swap', entry: el.dataset.entry, group: S().exercises[e?.exerciseId]?.group, kind: e?.kind === 'cardio' ? 'cardio' : 'all' });
  },
  // Starts or stops the vacuum / plank hold timer.
  'hold-timer'(el) {
    const { entry, set } = el.dataset;
    if (holdTimer && holdTimer.setId === set) {
      stopHoldTimer(true);
      return;
    }
    stopHoldTimer(true);
    stopRest();
    // Store the day first so the ids we're timing are permanent.
    editSession(() => {});
    const target = M.findEntry(dayData(ui.date).session, entry)?.target?.holdSec || 0;
    holdTimer = { entryId: entry, setId: set, date: ui.date, start: Date.now(), target, alerted: false };
    holdTimer.interval = setInterval(() => {
      const sec = Math.floor((Date.now() - holdTimer.start) / 1000);
      const n = document.querySelector('[data-timer]');
      if (n) n.textContent = `${sec}s`;
      // Beep and buzz once when the target hold time is reached.
      if (holdTimer.target && !holdTimer.alerted && sec >= holdTimer.target) {
        holdTimer.alerted = true;
        beep(990, 2);
        vibrate([200, 100, 200]);
      }
    }, 250);
    render();
  },
  // Adds or removes 15 seconds of rest.
  'rest-add'(el) {
    if (!rest) return;
    // +15 never takes the whole rest past the maximum for the lift type.
    const elapsed = rest.total - Math.max(0, rest.endsAt - Date.now()) / 1000;
    const total = Math.max(1, Math.min(rest.max || 1800, rest.total + Number(el.dataset.delta)));
    if (total === rest.total) return toast(`Rest is capped at ${fmtSec(rest.max)} for this lift`);
    rest.endsAt = Date.now() + Math.max(0, total - elapsed) * 1000;
    rest.total = total;
    rest.done = false;
    saveRest();
    updateRestBar();
  },
  // Skips the rest of the rest period.
  'rest-skip': stopRest,
  // Opens the interval timer setup for a HIIT entry.
  'hiit-setup'(el) {
    if (hiit && hiit.entryId === el.dataset.entry) return toast('Use the timer bar to pause, skip or end');
    openHiitSetup(el.dataset.entry);
  },
  // Starts the interval timer.
  'hiit-start': () => startHiit(),
  // Pauses or resumes the interval timer.
  'hiit-pause'() {
    if (!hiit) return;
    if (hiit.pausedAt) {
      hiit.pausedMs += Date.now() - hiit.pausedAt;
      hiit.pausedAt = 0;
    } else hiit.pausedAt = Date.now();
    saveHiit();
    updateHiitBar();
  },
  // Skips to the next interval.
  'hiit-skip'() {
    if (!hiit) return;
    const pos = M.hiitPosition(hiit.phases, hiitElapsed());
    // Jump to the start of the next phase.
    hiit.startedAt -= Math.ceil(pos.remaining * 1000);
    saveHiit();
    updateHiitBar();
  },
  // Ends the interval timer early and logs what was done.
  'hiit-end'() {
    if (hiit && confirm('End the interval timer and log the rounds you finished?')) finishHiit(false);
  },
  // Logs today’s scale weight, starting from the last one.
  'bw-log'() {
    const prev = M.previousBodyWeight(S(), ui.date);
    if (prev) {
      // Start from the last weigh-in; the +/− buttons adjust it.
      store.update((s) => M.setBodyWeight(s, ui.date, prev.weight));
      return;
    }
    // First weigh-in: nothing to pre-fill, so open the field for typing.
    ui.bwOpen = ui.date;
    render();
    document.querySelector('.bw input')?.focus();
  },
  // Opens the picker to add an exercise to the day or a plan day.
  'open-add': (el) => openSheet({ mode: el.dataset.mode, wd: el.dataset.wd !== undefined ? Number(el.dataset.wd) : undefined }),
  // Closes the exercise picker sheet.
  'close-sheet': closeSheet,
  // Filters the exercise picker by type.
  'sheet-kind'(el) {
    ui.sheet.kind = el.dataset.kind;
    renderSheetList();
  },
  // Adds or swaps in the tapped exercise.
  'pick-exercise': (el) => addExerciseToContext(el.dataset.ex),
  // Creates a new exercise with the typed name and adds it.
  'create-exercise'(el) {
    const name = ui.sheet.q.trim();
    if (!name) return;
    let id;
    store.update((s) => {
      id = M.addExercise(s, { name, kind: el.dataset.kind, group: el.dataset.kind === 'strength' ? '' : M.KINDS[el.dataset.kind] });
    });
    addExerciseToContext(id);
  },
  // Makes this day’s exercises and targets the plan for its plan day.
  'save-plan'() {
    const label = M.planLabel(S(), M.planIndex(S(), ui.date));
    if (!confirm(`Replace your ${label} plan with this day's exercises and targets? Future ${label}s you haven't started will use it.`)) return;
    store.update((s) => M.saveSessionAsPlan(s, ui.date));
    toast(`${label} plan updated`);
  },
  // Clears everything logged for the day and starts over from the plan.
  'reset-day'() {
    if (!confirm('Clear everything logged for this day and start over from the plan?')) return;
    stopHoldTimer(false);
    store.update((s) => M.resetSession(s, ui.date));
    toast('Day reset to plan');
  },
  // Switches between the rotation and a weekly plan.
  'plan-mode'(el) {
    const mode = el.dataset.value;
    if (mode === S().settings.planMode) return;
    const msg =
      mode === 'weekly'
        ? 'Switch to a weekly plan? Your days stay, but Day 1 becomes Sunday, Day 2 Monday, and so on. You can switch back any time.'
        : 'Switch to a rotation? Your weekly days become Day 1 (Sunday), Day 2 (Monday)… You can switch back any time.';
    if (!confirm(msg)) return;
    store.update((s) => {
      s.settings.planMode = mode;
      if (mode === 'cycle') s.settings.cycleLength = Math.max(s.settings.cycleLength, 7);
      s.settings.updatedAt = Date.now();
    });
  },
  // Sets the day type of a plan day.
  'plan-type'(el) {
    store.update((s) => {
      s.plan[el.dataset.wd].dayType = el.dataset.type;
      s.plan[el.dataset.wd].updatedAt = Date.now();
    });
  },
  // Moves an exercise up or down in a plan day.
  'plan-move'(el) {
    store.update((s) => {
      const day = s.plan[el.dataset.wd];
      const i = day.items.findIndex((it) => it.id === el.dataset.item);
      const j = i + Number(el.dataset.dir);
      if (i < 0 || j < 0 || j >= day.items.length) return;
      [day.items[i], day.items[j]] = [day.items[j], day.items[i]];
      day.updatedAt = Date.now();
    });
  },
  // Removes an exercise from a plan day.
  'plan-remove'(el) {
    store.update((s) => {
      const day = s.plan[el.dataset.wd];
      day.items = day.items.filter((it) => it.id !== el.dataset.item);
      day.updatedAt = Date.now();
    });
  },
  // Shows or hides the extra options for a plan exercise.
  'plan-more'(el) {
    const id = el.dataset.item;
    if (ui.planMore.has(id)) ui.planMore.delete(id);
    else ui.planMore.add(id);
    render();
  },
  // Links or unlinks an entry with the next one as a superset.
  'superset-entry'(el) {
    editEntry(el.dataset.entry, (e) => {
      if (e.target.supersetNext) delete e.target.supersetNext;
      else e.target.supersetNext = true;
    });
  },
  // Links or unlinks a plan exercise with the next one as a superset.
  'plan-superset'(el) {
    store.update((s) => {
      const day = s.plan[el.dataset.wd];
      const it = day.items.find((i) => i.id === el.dataset.item);
      if (!it) return;
      if (it.supersetNext) delete it.supersetNext;
      else it.supersetNext = true;
      day.updatedAt = Date.now();
    });
  },
  // Marks a plan exercise optional or required.
  'plan-optional'(el) {
    store.update((s) => {
      const day = s.plan[el.dataset.wd];
      const it = day.items.find((i) => i.id === el.dataset.item);
      if (!it) return;
      if (it.optional) delete it.optional;
      else it.optional = true;
      day.updatedAt = Date.now();
    });
  },
  // Opens the picker to swap an exercise in a plan day.
  'plan-swap'(el) {
    const it = S().plan[el.dataset.wd]?.items.find((i) => i.id === el.dataset.item);
    openSheet({ mode: 'plan-swap', wd: Number(el.dataset.wd), item: el.dataset.item, group: S().exercises[it?.exerciseId]?.group });
  },
  // Changes the Progress time range.
  'progress-range'(el) {
    ui.progress.range = el.dataset.range;
    render();
  },
  // Changes the metric shown on the exercise progress chart.
  'progress-metric'(el) {
    ui.progress.metric = el.dataset.metric;
    render();
  },
  // Changes the metric shown on the activity chart.
  'progress-chart'(el) {
    ui.progress.chart = el.dataset.chart;
    render();
  },
  // Switches between lb and kg.
  'set-unit': (el) => updateSettings({ unit: el.dataset.value }),
  // Switches between miles and kilometers.
  'set-dunit': (el) => updateSettings({ distanceUnit: el.dataset.value }),
  // Sets which day the week starts on.
  'set-weekstart': (el) => updateSettings({ weekStart: Number(el.dataset.value) }),
  // Turns the automatic rest timer on or off.
  'set-autorest': (el) => updateSettings({ autoRest: el.dataset.value === 'true' }),
  // Turns the rest-over sound on or off.
  'set-restsound': (el) => updateSettings({ restSound: el.dataset.value === 'true' }),
  // Syncs now.
  'sync-now': () => syncNow(),
  // Plays a form video.
  video: (el) => openVideo(el.dataset.url, el.dataset.title),
  // Filters the Exercises tab by muscle group.
  'lib-group'(el) {
    ui.lib.group = el.dataset.group;
    render();
  },
  // Adds an exercise from the Exercises tab to today.
  'lib-add'(el) {
    const exId = el.dataset.ex;
    const today = M.todayISO();
    editSession((sess, s) => {
      const prev = M.previousEntry(s, exId, today);
      sess.entries.push(M.makeEntry(s, exId, prev?.entry.target, today));
    }, today);
    toast(`Added ${M.exerciseName(S(), exId)} to today`);
  },
  // Goes back to today’s Log (the Logbook logo).
  'go-home'() {
    closeSheet();
    ui.tab = 'log';
    history.replaceState(null, '', '#log');
    goDate(M.todayISO());
    window.scrollTo(0, 0);
  },
  // Downloads a full backup as JSON.
  'export-json'() {
    download(`logbook-backup-${M.todayISO()}.json`, JSON.stringify(S(), null, 2), 'application/json');
  },
  // Downloads every logged set as a CSV file.
  'export-csv'() {
    download(`logbook-sets-${M.todayISO()}.csv`, M.toCSV(S()), 'text/csv');
  },
  // Starts the Google sign-in to connect Fitbit.
  async 'google-connect'() {
    try {
      const { url } = await store.request('api/google/connect', { method: 'POST' });
      location.href = url;
    } catch (err) {
      toast(err.message);
    }
  },
  // Imports from Fitbit now and says what came in.
  async 'google-sync'(el) {
    el.disabled = true;
    try {
      const res = await googleImport(true);
      toast(res.changed ? `Imported ${res.changed} update${res.changed === 1 ? '' : 's'} from Fitbit` : 'Fitbit: nothing new');
    } catch (err) {
      toast(err.message);
    } finally {
      el.disabled = false;
    }
  },
  // Disconnects Fitbit after asking.
  async 'google-disconnect'() {
    if (!confirm('Disconnect Fitbit? Data already imported stays in your logbook.')) return;
    try {
      google = await store.request('api/google/disconnect', { method: 'POST' });
      renderGoogleCard();
      toast('Fitbit disconnected');
    } catch (err) {
      toast(err.message);
    }
  },
  // Turns on notifications for timers on this device.
  'alerts-on': () => enableAlerts(),
  // Turns off notifications for timers on this device.
  'alerts-off': () => disableAlerts(),
  // Sends a test notification to every device with alerts on.
  async 'alerts-test'() {
    try {
      await store.request('api/push/test', { method: 'POST', body: {} });
      toast('Test sent. Lock your phone to see it if nothing shows.');
    } catch (err) {
      toast(err.message);
    }
  },
  // Erases all data on every device after asking twice.
  'reset-all'() {
    if (!confirm('Erase ALL workouts, weigh-ins, plans and custom exercises everywhere (this device, the server and your other devices)?')) return;
    if (!confirm('Really erase everything? This cannot be undone. Download a backup first if unsure.')) return;
    stopHoldTimer(false);
    stopRest();
    if (hiit) {
      hiit = null;
      saveHiit();
      keepAwake(false);
      buildHiitBar();
    }
    store.update((s) => M.eraseAll(s));
    toast('All data erased');
  },
};

// Changes settings and saves.
function updateSettings(patch) {
  store.update((s) => {
    Object.assign(s.settings, patch, { updatedAt: Date.now() });
  });
}

// Downloads text as a file.
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// Field changes (inputs)
// ---------------------------------------------------------------------------

// Changes one exercise in a plan day and saves.
function editPlanItem(el, fn) {
  store.update((s) => {
    const day = s.plan[el.dataset.wd];
    const it = day?.items.find((i) => i.id === el.dataset.item);
    if (!it) return;
    fn(it);
    day.updatedAt = Date.now();
  });
}

/**
 * Reads a typed number: "1,250" (thousands) is 1250, while "82,5" (a decimal
 * comma) is 82.5. Returns NaN for text that isn't a number.
 */
function parseNumber(raw) {
  const t = String(raw).trim().replace(/\s/g, '');
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return parseFloat(t.replace(/,/g, ''));
  return parseFloat(t.replace(',', '.'));
}

const FIELDS = {
  // Saves a number typed into a stepper box.
  value(el) {
    const raw = String(el.value).trim();
    const v = parseNumber(raw);
    if (el.dataset.scope === 'body') {
      if (raw === '' || v === 0) return store.update((s) => M.setBodyWeight(s, ui.date, 0));
      if (Number.isNaN(v)) return render();
      return store.update((s) => M.setBodyWeight(s, ui.date, M.round(v, 1)));
    }
    if (Number.isNaN(v) && raw !== '') return render();
    changeValue(el.dataset, () => (Number.isNaN(v) ? 0 : v));
  },
  // Shows the Log for the picked date.
  date: (el) => goDate(el.value),
  // Renames the day.
  'session-name': (el) => editSession((s) => (s.name = el.value.trim())),
  // Saves the day’s notes.
  'session-notes': (el) => editSession((s) => (s.notes = el.value)),
  // Saves an entry’s notes.
  'entry-notes': (el) => editEntry(el.dataset.entry, (e) => (e.notes = el.value)),
  // Sets which plan day the shown date is, shifting the rotation from there.
  'plan-day'(el) {
    // Re-anchor the rotation so this date is the chosen plan day.
    const idx = Number(el.value);
    const date = ui.date;
    const stored = M.getSession(S(), date);
    const hasWork = stored?.entries.some(M.entryHasWork);
    store.update((s) => {
      M.anchorCycle(s, date, idx);
      if (stored && !hasWork) M.resetSession(s, date);
    });
    toast(hasWork ? `Rotation updated. Today's logged sets were kept.` : `Today is now ${M.planLabel(S(), idx)}`);
  },
  // Sets which rotation day today is.
  'cycle-today'(el) {
    store.update((s) => M.anchorCycle(s, M.todayISO(), Number(el.value)));
    toast(`Today is now ${M.planLabel(S(), Number(el.value))}`);
  },
  // Renames a plan day.
  'plan-name'(el) {
    store.update((s) => {
      s.plan[el.dataset.wd].name = el.value.trim();
      s.plan[el.dataset.wd].updatedAt = Date.now();
    });
  },
  // Saves a plan day’s note.
  'plan-daynote'(el) {
    store.update((s) => {
      s.plan[el.dataset.wd].note = el.value.trim().slice(0, 500);
      s.plan[el.dataset.wd].updatedAt = Date.now();
    });
  },
  // Saves a plan exercise’s note.
  'plan-note': (el) =>
    editPlanItem(el, (it) => {
      const v = el.value.trim().slice(0, 300);
      if (v) it.note = v;
      else delete it.note;
    }),
  // Saves a plan exercise’s pyramid rep scheme (e.g. 15/12/10).
  'plan-scheme': (el) =>
    editPlanItem(el, (it) => {
      const scheme = el.value
        .split(/[^\d]+/)
        .map(Number)
        .filter((n) => n > 0)
        .slice(0, 20);
      if (scheme.length) {
        it.repScheme = scheme;
        it.sets = scheme.length;
        it.reps = scheme[0];
      } else delete it.repScheme;
    }),
  // Copies one plan day onto another.
  'plan-copy'(el) {
    const from = Number(el.value);
    const to = Number(el.dataset.wd);
    if (el.value === '') return;
    // Returns the name of a plan day.
    const label = (i) => M.planLabel(S(), i);
    if (S().plan[to].items.length && !confirm(`Replace ${label(to)} with a copy of ${label(from)}?`)) {
      el.value = '';
      return;
    }
    store.update((s) => M.copyPlanDay(s, from, to));
    toast(`Copied ${label(from)} to ${label(to)}`);
  },
  // Shows the progress chart for the picked exercise.
  'progress-exercise'(el) {
    ui.progress.exerciseId = el.value;
    ui.progress.picked = true;
    ui.progress.metric = null;
    render();
  },
  // Restores a JSON backup, merging or replacing.
  import(el) {
    const file = el.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let data;
      try {
        data = JSON.parse(reader.result);
        if (!data || typeof data !== 'object' || !data.sessions) throw new Error('Not a logbook backup');
      } catch (err) {
        toast(`Could not read that file: ${err.message}`);
        return;
      }
      const replace = confirm('Restore this backup?\n\nOK = replace everything with the backup\nCancel = merge it with your current data');
      if (replace) store.replace(data);
      else store.update((s) => Object.assign(s, M.mergeStates(s, data)));
      toast('Backup restored');
    };
    reader.readAsText(file);
    el.value = '';
  },
};

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

// A typed value is committed on `change`, deferred so focus has moved to
// wherever the user tapped next. On phones the tap's click can arrive
// before that, so a click first commits whatever is still pending.
let pendingField = null;

// Commits a typed value that is still waiting to be saved.
function flushField() {
  const el = pendingField;
  pendingField = null;
  if (el) FIELDS[el.dataset.field]?.(el);
}

document.addEventListener('click', (ev) => {
  unlockAudio();
  const el = ev.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = ACTIONS[el.dataset.action];
  if (!fn) return;
  const a = document.activeElement;
  if (a && a !== el && a.dataset?.field && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) a.blur();
  flushField();
  fn(el, ev);
});

document.addEventListener('change', (ev) => {
  const el = ev.target.closest('[data-field]');
  if (!el || !FIELDS[el.dataset.field]) return;
  if (pendingField && pendingField !== el) flushField();
  pendingField = el;
  setTimeout(flushField, 0);
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && ui.sheet) closeSheet();
  // Enter in a single-line field commits it.
  if (ev.key === 'Enter' && ev.target.matches?.('input[data-field]')) ev.target.blur();
  if (ev.key === 'Enter' && ev.target.id === 'sheet-q') {
    // Prefer an existing match; otherwise create with the highlighted type.
    const first = document.querySelector('#sheet-list .pick') || document.querySelector('#sheet-list .btn.primary');
    if (first) first.click();
  }
});

// Exercises tab search filters as you type.
document.addEventListener('input', (ev) => {
  if (ev.target.matches?.('[data-field="lib-q"]')) {
    ui.lib.q = ev.target.value;
    render();
  }
});

// Mark video thumbnails that fail to load (removed or private videos).
document.addEventListener(
  'error',
  (ev) => {
    if (ev.target.matches?.('.video-thumb img')) ev.target.parentElement.classList.add('is-broken');
  },
  true,
);

document.addEventListener('focusin', (ev) => {
  // Select the whole number so typing replaces it.
  if (ev.target.matches?.('.stepper input')) setTimeout(() => ev.target.select?.(), 0);
});

document.addEventListener('focusout', () => {
  if (pendingRender) setTimeout(() => !isTyping() && pendingRender && render(), 0);
});

document.addEventListener('submit', (ev) => {
  const form = ev.target.closest('[data-form="password"]');
  if (!form) return;
  ev.preventDefault();
  const pw = form.elements.pw.value;
  store.setPassword(pw).then(() => {
    toast(store.status === 'synced' ? 'Connected and synced' : store.status === 'auth' ? 'Wrong password' : 'Saved');
    render();
  });
});

window.addEventListener('hashchange', () => {
  const t = location.hash.slice(1);
  if (TABS.includes(t) && t !== ui.tab) {
    ui.tab = t;
    render();
  }
});

// Behave like a native app on phones: no pinch zoom. iOS Safari ignores
// user-scalable=no in browser tabs, so also cancel its pinch gestures and
// multi-finger moves. Desktop browser zoom (Ctrl/Cmd +/−) is unaffected.
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (ev) => ev.preventDefault(), { passive: false });
}
document.addEventListener(
  'touchmove',
  (ev) => {
    if (ev.touches.length > 1 || (ev.scale && ev.scale !== 1)) ev.preventDefault();
  },
  { passive: false },
);

// ---------------------------------------------------------------------------
// Manual sync (Synced button and pull-to-sync)
// ---------------------------------------------------------------------------

let manualSync = null;
// Syncs when the user asks, then says how it went.
function syncNow() {
  if (manualSync) return manualSync;
  manualSync = store.syncNow().then(() => {
    manualSync = null;
    const msg = { synced: 'Synced', offline: "Couldn't reach the server. Saved on this device.", auth: 'Enter your password in Settings to sync', local: 'No server: data is saved on this device only' }[store.status];
    if (msg) toast(msg);
  });
  return manualSync;
}

// Pull down from the top of the page to sync, like a native app.
const $ptr = document.getElementById('ptr');
const PULL_TRIGGER = 70; // px of (damped) pull needed to sync
let pull = null;

// Moves and labels the pull-to-sync indicator.
function showPull(dist, state) {
  $ptr.classList.toggle('is-ready', state === 'ready');
  $ptr.classList.toggle('is-syncing', state === 'syncing');
  $ptr.querySelector('.ptr-text').textContent = state === 'syncing' ? 'Syncing…' : state === 'ready' ? 'Release to sync' : 'Pull to sync';
  $ptr.querySelector('.ptr-icon').style.transform = state === 'syncing' ? '' : `rotate(${dist * 3}deg)`;
  $ptr.style.opacity = String(Math.min(1, dist / 40));
  $ptr.style.transform = `translate(-50%, ${Math.min(dist, 90) - 80}px)`;
}

// Slides the pull-to-sync indicator back out of view.
function hidePull() {
  $ptr.classList.add('is-animating');
  showPull(0, '');
  setTimeout(() => $ptr.classList.remove('is-animating'), 220);
}

document.addEventListener(
  'touchstart',
  (ev) => {
    if (ev.touches.length !== 1 || window.scrollY > 0 || ui.sheet || manualSync) return;
    pull = { y0: ev.touches[0].clientY, dist: 0 };
    $ptr.classList.remove('is-animating');
  },
  { passive: true },
);
document.addEventListener(
  'touchmove',
  (ev) => {
    if (!pull) return;
    if (ev.touches.length !== 1 || window.scrollY > 0) {
      pull = null;
      hidePull();
      return;
    }
    // Damped so it feels like a rubber band.
    pull.dist = Math.max(0, (ev.touches[0].clientY - pull.y0) * 0.5);
    showPull(pull.dist, pull.dist >= PULL_TRIGGER ? 'ready' : '');
  },
  { passive: true },
);
document.addEventListener('touchend', () => {
  if (!pull) return;
  const go = pull.dist >= PULL_TRIGGER;
  pull = null;
  if (!go) return hidePull();
  $ptr.classList.add('is-animating');
  showPull(PULL_TRIGGER, 'syncing');
  vibrate(10);
  syncNow().finally(hidePull);
});
document.addEventListener('touchcancel', () => {
  if (pull) {
    pull = null;
    hidePull();
  }
});

// Pull changes from other devices when coming back to the app.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    checkToday();
    updateRestBar();
    store.sync();
    autoGoogle();
  }
  // Timer alerts only while the app is out of sight (locked or switched away).
  sendTimerAlerts(document.visibilityState === 'hidden');
});
addEventListener('pagehide', () => sendTimerAlerts(true));
window.addEventListener('online', () => store.sync());

// Roll "today" forward if the app was left open overnight.
let lastToday = M.todayISO();
// Moves "today" forward if the app was left open past midnight.
function checkToday() {
  const t = M.todayISO();
  if (t === lastToday) return;
  if (ui.date === lastToday) ui.date = t;
  lastToday = t;
  if (!isTyping()) render();
}
setInterval(checkToday, 60000);

render();
buildRestBar();
const firstSync = store.init();

// Back from Google sign-in (see /api/google/callback).
const googleParam = new URLSearchParams(location.search).get('google');
if (googleParam) {
  const reason = new URLSearchParams(location.search).get('reason');
  history.replaceState(null, '', location.pathname + location.hash);
  if (googleParam === 'connected') {
    toast('Fitbit connected. Importing your data…');
    firstSync.then(() => googleImport(true)).then(
      (res) => toast(res?.changed ? 'Fitbit data imported' : 'Fitbit connected'),
      (err) => toast(err.message),
    );
  } else toast(`Couldn't connect Fitbit: ${reason || 'try again'}`);
}
firstSync.then(autoGoogle);
if (hiit) {
  if (M.hiitPosition(hiit.phases, hiitElapsed()).done) {
    // It finished while the app was closed: log it once the latest copy of
    // the day has synced, so the entry it belongs to is there.
    firstSync.finally(buildHiitBar);
  } else {
    keepAwake(true);
    buildHiitBar();
  }
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Exposed for debugging in the console.
window.logbook = { store, ui, M };
