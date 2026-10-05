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
  progress: { range: '3m', exerciseId: null, picked: false, metric: null, chart: 'volume' },
  sheet: null,
};

// Unsaved drafts (days built from the plan) are cached so the entry ids
// in the DOM stay valid until the first edit stores them.
const drafts = new Map();
const charts = [];
let holdTimer = null; // running vacuum / plank hold timer
let pendingRender = false;

const store = createStore({
  onChange({ remote }) {
    drafts.clear();
    if (remote && isTyping()) pendingRender = true;
    else render();
  },
  onSyncStatus: renderSync,
});

const S = () => store.state;
const unit = () => S().settings.unit;
const dunit = () => S().settings.distanceUnit;

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const nf1 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const fmt = (n) => nf.format(Number(n) || 0);
const fmtCompact = (n) => (Math.abs(n) >= 10000 ? new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n) : fmt(n));

function fmtSec(sec) {
  sec = Math.round(sec || 0);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function fmtClock(sec) {
  sec = Math.max(0, Math.round(sec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function fmtPace(minPerUnit) {
  if (!minPerUnit) return '–';
  const m = Math.floor(minPerUnit);
  const s = Math.round((minPerUnit - m) * 60);
  return `${m}:${String(s).padStart(2, '0')}/${dunit()}`;
}

function fmtDate(iso, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
  return M.parseISODate(iso).toLocaleDateString(undefined, opts);
}

const speedUnit = () => (dunit() === 'km' ? 'km/h' : 'mph');
const CARDIO_LABEL = {
  get speed() {
    return `Speed (${speedUnit()})`;
  },
  incline: 'Incline',
  level: 'Level',
};

const range = (lo, hi) => (hi && hi > lo ? `${fmt(lo)}–${fmt(hi)}` : fmt(lo));

/** Cardio settings as text, e.g. "incline 12 · 3 mph" or "level 8". */
function cardioSettingsText(c) {
  return [c.incline ? `incline ${fmt(c.incline)}` : '', c.speed ? `${fmt(c.speed)} ${speedUnit()}` : '', c.level ? `level ${fmt(c.level)}` : ''].filter(Boolean).join(' · ');
}

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

function loadText(kind, v) {
  if (kind === 'cardio') return `${fmt(v)} min`;
  if (M.isHold(kind)) return fmtSec(v);
  return `${fmtCompact(v)} ${unit()}`;
}

function deltaHTML(cur, prev, suffix = '') {
  if (!prev) return '';
  const pct = ((cur - prev) / prev) * 100;
  if (Math.abs(pct) < 0.5) return `<span class="delta flat">= same${suffix}</span>`;
  const cls = pct > 0 ? 'up' : 'down';
  return `<span class="delta ${cls}">${pct > 0 ? '▲' : '▼'} ${Math.abs(pct).toFixed(1)}%${suffix}</span>`;
}

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
};

// ---------------------------------------------------------------------------
// Steppers: one generic control for every number in the app
// ---------------------------------------------------------------------------

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
  calories: () => 10,
  avgHr: () => 1,
};
const INTEGER = new Set(['reps', 'repsMax', 'sets', 'setsMax', 'warmupSets', 'dropSets', 'failureSets', 'restSec', 'holdSec', 'calories', 'avgHr', 'cycleLength', 'level']);
const MAX = { sets: 50, setsMax: 50, reps: 1000, repsMax: 1000, warmupSets: 10, dropSets: 10, failureSets: 10, restSec: 1800, holdSec: 3600, avgHr: 260, speed: 30, incline: 40, level: 30 };

function cleanValue(key, v) {
  v = Math.max(0, Math.min(MAX[key] ?? 100000, Number(v) || 0));
  return INTEGER.has(key) ? Math.round(v) : M.round(v, 2);
}

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

function fmtInput(v) {
  return String(M.round(Number(v) || 0, 2));
}

const SETTING_RULES = {
  weightStep: { step: 0.5, min: 0.25, max: 100 },
  restSec: { step: 15, min: 0, max: 900 },
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
      const v = cleanValue(key, fn(e.target[key] || 0, step));
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

function dayData(date) {
  const stored = M.getSession(S(), date);
  if (stored) return { session: stored, draft: false };
  if (!drafts.has(date)) drafts.set(date, M.sessionOrDraft(S(), date).session);
  return { session: drafts.get(date), draft: true };
}

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

function editEntry(entryId, fn) {
  editSession((sess, s) => {
    const e = M.findEntry(sess, entryId);
    if (e) fn(e, sess, s);
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function isTyping() {
  const a = document.activeElement;
  return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && ($view.contains(a) || $sheet.contains(a));
}

function focusKey(n) {
  if (!n || !$view.contains(n) || !n.dataset) return null;
  const d = n.dataset;
  if (!d.field) return null;
  return ['field', 'scope', 'key', 'entry', 'set', 'wd', 'item', 'ex'].map((k) => d[k] ?? '').join('|');
}

function render() {
  pendingRender = false;
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

function saveRest() {
  try {
    if (rest) localStorage.setItem(REST_KEY, JSON.stringify(rest));
    else localStorage.removeItem(REST_KEY);
  } catch {
    /* ignore */
  }
}

function unlockAudio() {
  // Browsers only allow sound after a user gesture, so prepare it on taps.
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
  } catch {
    audio = null;
  }
}

function beep() {
  if (!audio || !S().settings.restSound) return;
  try {
    const t0 = audio.currentTime;
    for (let i = 0; i < 3; i++) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.frequency.value = 880;
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

function startRest(sec, label) {
  if (!sec) return;
  rest = { endsAt: Date.now() + sec * 1000, total: sec, label, done: false };
  saveRest();
  buildRestBar();
}

function stopRest() {
  rest = null;
  saveRest();
  buildRestBar();
}

function buildRestBar() {
  clearInterval(restTick);
  if (!rest) {
    $rest.hidden = true;
    $rest.innerHTML = '';
    document.body.classList.remove('has-rest');
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
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
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
    toast(`Superset: straight to ${M.exerciseName(S(), next.exerciseId)}`);
    requestAnimationFrame(() => document.querySelector(`[data-entry-id="${next.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    return;
  }
  // Cardio and stomach vacuums don't use rest periods.
  if (!st.autoRest || entry.kind === 'cardio' || entry.kind === 'vacuum') return;
  const sec = entry.target.restSec || st.restSec;
  const name = M.exerciseName(S(), entry.exerciseId);
  const left = entry.sets.filter((s) => !s.done).length;
  startRest(sec, left ? `${name} · ${left} set${left === 1 ? '' : 's'} left` : `${name} done · next exercise`);
}

// ---------------------------------------------------------------------------
// Log view
// ---------------------------------------------------------------------------

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
      <div class="small muted">${diffHTML ? `${diffHTML} vs ${fmtDate(prev.date, { month: 'short', day: 'numeric' })} · ` : ''}7-day avg <b class="num">${nf1.format(avg)}</b></div></div></div>
    <div class="bw-input">${stepper({ scope: 'body', key: 'weight', value: w || '', label: '', placeholder: 'e.g. 182.4' })}<span class="muted small">${unit()}</span></div>
  </section>`;
}

function logView() {
  const state = S();
  const { session, draft } = dayData(ui.date);
  const today = M.todayISO();
  const ws = M.startOfWeek(ui.date, state.settings.weekStart);
  const idx = M.planIndex(state, ui.date);
  const cycle = M.isCycle(state);

  const week = Array.from({ length: 7 }, (_, i) => {
    const d = M.addDays(ws, i);
    const st = M.dayStatus(state, d);
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

  ${bodyWeightCard()}

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

function rpeRow(e, prev) {
  if (e.kind === 'vacuum') return ''; // no effort rating for vacuums
  if (e.kind === 'cardio' && !e.cardio.done && !e.rpe) return '';
  const chips = [5, 6, 7, 8, 9, 10].map((v) => `<button type="button" data-action="rpe" data-entry="${e.id}" data-value="${v}" aria-pressed="${e.rpe === v}">${v}</button>`).join('');
  return `<div class="rpe-row"><span class="label" title="Rate of perceived exertion: 10 = maximum effort, nothing left">RPE</span>
    <div class="rpe" role="group" aria-label="Effort (RPE)">${chips}</div>
    ${prev?.entry.rpe ? `<span class="muted small">last ${fmt(prev.entry.rpe)}</span>` : ''}</div>`;
}

function targetEditor(e, prev) {
  const t = e.target;
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
    <p class="hint">Changes apply to this day only and fill the sets you haven't done yet. To change it for every rotation, use “Save as my plan” or the Plan tab. Rest 0 = your default (${fmt(S().settings.restSec)}s).</p></div>`;
}

function intensityHTML(e, prev) {
  const done = M.entryMetrics(e, true);
  const planned = M.entryMetrics(e, false);
  const pm = prev ? M.entryMetrics(prev.entry) : null;
  const max = Math.max(pm?.load || 0, planned.load, done.load, 1);
  const w = (v) => `${Math.min(100, (v / max) * 100).toFixed(1)}%`;
  const bodyweight = e.kind === 'strength' && !planned.topWeight && !pm?.topWeight;
  const what = e.kind === 'cardio' ? 'Duration' : M.isHold(e.kind) ? 'Total hold time' : bodyweight ? 'Total reps' : 'Load (weight × reps)';
  // Bodyweight moves (push-ups, dips…) compare reps instead of weight × reps.
  const L = (m) => (bodyweight ? m?.reps || 0 : m?.load || 0);
  const lt = (v) => (bodyweight ? `${fmt(v)} reps` : loadText(e.kind, v));
  const maxL = Math.max(L(pm), L(planned), L(done), 1);
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

function setsBody(e, prev) {
  const prevDone = prev?.entry.sets?.filter((s) => s.done) || [];
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

function cardioBody(e) {
  const c = e.cardio;
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
    <button type="button" class="btn block ${c.done ? '' : 'primary'}" data-action="cardio-done" data-entry="${e.id}" aria-pressed="${c.done}">${c.done ? `${ICON.check} Completed – tap to undo` : 'Mark cardio complete'}</button>`;
}

// ---------------------------------------------------------------------------
// Plan view
// ---------------------------------------------------------------------------

function planItemHTML(state, wd, it, i, n) {
  const ex = state.exercises[it.exerciseId];
  if (!ex || ex.deleted) return '';
  const kind = ex.kind;
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
  ],
  vacuum: HOLD_METRICS,
  timed: HOLD_METRICS,
};

function metricFormatter(kind, key) {
  if (M.isHold(kind) && key !== 'sets') return (v) => fmtSec(v);
  if (key === 'pace') return (v) => fmtPace(v);
  if (['e1rm', 'topWeight', 'volume'].includes(key)) return (v, axis) => (axis ? fmtCompact(v) : `${fmt(v)} ${unit()}`);
  if (key === 'distance') return (v, axis) => (axis ? fmt(v) : `${fmt(v)} ${dunit()}`);
  if (key === 'minutes') return (v, axis) => (axis ? fmt(v) : `${fmt(v)} min`);
  if (key === 'speed') return (v, axis) => (axis ? fmt(v) : `${fmt(v)} ${speedUnit()}`);
  if (key === 'incline') return (v, axis) => (axis ? fmt(v) : `incline ${fmt(v)}`);
  if (key === 'level') return (v, axis) => (axis ? fmt(v) : `level ${fmt(v)}`);
  return (v) => fmt(v);
}

function bodyWeightSection(from, to) {
  const state = S();
  const list = M.bodyWeights(state, from, to);
  const latest = M.bodyWeights(state).pop();
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

    const options = (ids, label) => (ids.length ? `<optgroup label="${label}">${ids.map((id) => `<option value="${esc(id)}" ${id === ex.id ? 'selected' : ''}>${esc(state.exercises[id].name)}</option>`).join('')}</optgroup>` : '');
    const unlogged = all.map((e) => e.id).filter((id) => !logged.includes(id));
    exSection = `
      <select data-field="progress-exercise" aria-label="Exercise">${options(logged, 'Logged')}${options(unlogged, 'Not logged yet')}</select>
      <div class="seg" role="group" aria-label="Metric">${metrics.map(([k, label]) => `<button type="button" data-action="progress-metric" data-metric="${k}" aria-pressed="${k === mKey}">${label}</button>`).join('')}</div>
      <div class="chart" id="chart-exercise"></div>
      <div class="prs">${prs.map(([k, v, d]) => `<div class="stat"><div class="k">${k}</div><div class="v">${esc(v)}</div>${d ? `<div class="muted small">${fmtDate(d, { month: 'short', day: 'numeric', year: '2-digit' })}</div>` : ''}</div>`).join('')}</div>
      ${rows ? `<div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th>${ex.kind === 'strength' ? 'Sets (weight×reps)' : M.isHold(ex.kind) ? 'Holds' : 'Session'}</th><th class="r">RPE</th><th class="r">${esc(metrics.find((m) => m[0] === mKey)[1])}</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}`;
  }

  // Session history
  const history = M.sessionDates(state)
    .filter((d) => d >= from && d <= to)
    .reverse()
    .map((d) => {
      const s = state.sessions[d];
      const worked = s.entries.filter(M.entryHasWork);
      if (!worked.length && !s.notes) return '';
      const r = M.rangeSummary(state, d, d);
      const bits = [r.sets ? `${r.sets} sets · ${fmtCompact(r.volume)} ${unit()}` : '', r.cardioMin ? `${fmt(r.cardioMin)} min cardio` : '', r.vacuumSec ? `${fmtSec(r.vacuumSec)} vacuum` : ''].filter(Boolean).join(' · ');
      return `<button type="button" class="history-item" data-action="open-date" data-date="${d}">
        <div class="d"><span>${fmtDate(d, { month: 'short' })}</span><b>${M.parseISODate(d).getDate()}</b></div>
        <div class="body"><div class="t">${esc(s.name || M.DAY_TYPES[s.dayType])} <span class="muted small">${fmtDate(d, { weekday: 'short' })}</span></div>
        <div class="s">${bits || 'Notes only'} — ${esc(worked.map((e) => M.exerciseName(state, e.exerciseId)).join(', '))}</div></div>
        <span class="muted">${ICON.right}</span></button>`;
    })
    .filter(Boolean)
    .slice(0, 150)
    .join('');

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

function settingsView() {
  const state = S();
  const st = state.settings;
  const seg = (action, value, opts) => `<div class="seg" role="group">${opts.map(([v, l]) => `<button type="button" data-action="${action}" data-value="${v}" aria-pressed="${String(value) === String(v)}">${l}</button>`).join('')}</div>`;
  const exRows = M.activeExercises(state)
    .map(
      (ex) => `<div class="ex-row">
      <input data-field="ex-name" data-ex="${esc(ex.id)}" value="${esc(ex.name)}" aria-label="Exercise name" maxlength="80">
      <select data-field="ex-kind" data-ex="${esc(ex.id)}" aria-label="Type">${Object.entries(M.KINDS).map(([k, v]) => `<option value="${k}" ${ex.kind === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <button type="button" class="icon-btn" data-action="ex-delete" data-ex="${esc(ex.id)}" aria-label="Delete ${esc(ex.name)}">${ICON.trash}</button>
    </div>`,
    )
    .join('');
  return `
  <h2>Settings</h2>
  <section class="card">
    <h3>Rest timer</h3>
    <div class="settings-row"><span>Start automatically after each set</span>${seg('set-autorest', st.autoRest, [[true, 'On'], [false, 'Off']])}</div>
    <div class="settings-row"><span>Default rest (seconds)</span>${stepper({ scope: 'setting', key: 'restSec', value: st.restSec })}</div>
    <div class="settings-row"><span>Sound when rest is over</span>${seg('set-restsound', st.restSound, [[true, 'On'], [false, 'Off']])}</div>
    <p class="hint">Exercises can have their own rest time (Plan tab → More options). Phones may silence sounds while the screen is locked; the timer still keeps time.</p>
  </section>

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

  <section class="card stack">
    <div class="spread"><h3>Exercise library</h3><button type="button" class="btn sm" data-action="open-add" data-mode="library">+ New</button></div>
    <p class="hint">Renaming keeps all history. Deleting hides the exercise from pickers but keeps past logs.</p>
    <div>${exRows}</div>
  </section>

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

function videoTile([title, url]) {
  const id = youtubeId(url);
  if (!id) return '';
  return `<button type="button" class="video-tile" data-action="video" data-url="${esc(url)}" data-title="${esc(title)}" aria-label="Play video: ${esc(title)}">
    <span class="video-thumb"><img src="https://i.ytimg.com/vi/${id}/mqdefault.jpg" alt="" loading="lazy" referrerpolicy="no-referrer"><span class="play">${ICON.play}</span></span>
    <span class="t">${esc(title)}</span></button>`;
}

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

function sheetTitle(ctx) {
  if (ctx.mode === 'library') return 'New exercise';
  if (ctx.mode === 'swap' || ctx.mode === 'plan-swap') return 'Swap for…';
  if (ctx.mode === 'plan') return `Add to ${M.planLabel(S(), ctx.wd)}`;
  return `Add to ${fmtDate(ui.date)}`;
}

function openSheet(ctx) {
  ui.sheet = { q: '', kind: 'all', ...ctx };
  $sheetPanel.innerHTML = `
    <div class="spread"><h2 id="sheet-title">${esc(sheetTitle(ctx))}</h2>
      <button type="button" class="icon-btn" data-action="close-sheet" aria-label="Close">${ICON.close}</button></div>
    <input type="search" id="sheet-q" placeholder="${ctx.mode === 'library' ? 'Exercise name' : 'Search or type a new name'}" autocomplete="off" aria-label="Search exercises">
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

function closeSheet() {
  ui.sheet = null;
  $sheet.hidden = true;
  $sheetPanel.innerHTML = '';
}

function renderSheetList() {
  const sh = ui.sheet;
  if (!sh || sh.mode === 'video') return;
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
  } else if (!q && sh.mode === 'library') {
    create = '<p class="hint" style="margin:8px 0">Type a name above to create a new exercise.</p>';
  }
  const items =
    sh.mode === 'library'
      ? ''
      : list.map((e) => `<button type="button" class="pick" data-action="pick-exercise" data-ex="${esc(e.id)}"><span>${esc(e.name)}<br><span class="g">${esc(e.group)}</span></span><span class="badge ${e.kind}">${M.KINDS[e.kind]}</span></button>`).join('');
  document.getElementById('sheet-list').innerHTML = items ? items + create : create || (sh.mode === 'library' ? '' : '<p class="hint">No exercises yet.</p>');
}

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

function goDate(date) {
  if (!M.isISODate(date)) return;
  ui.date = date;
  ui.editing.clear();
  render();
}

function stopHoldTimer(save) {
  if (!holdTimer) return;
  clearInterval(holdTimer.interval);
  const t = holdTimer;
  holdTimer = null;
  if (!save) return;
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

const vibrate = (ms) => navigator.vibrate && navigator.vibrate(ms);

const ACTIONS = {
  tab(el) {
    ui.tab = el.dataset.tab;
    history.replaceState(null, '', `#${ui.tab}`);
    render();
    window.scrollTo(0, 0);
  },
  'shift-day': (el) => goDate(M.addDays(ui.date, Number(el.dataset.delta))),
  'go-date': (el) => goDate(el.dataset.date),
  'open-date'(el) {
    ui.tab = 'log';
    history.replaceState(null, '', '#log');
    goDate(el.dataset.date);
    window.scrollTo(0, 0);
  },
  'day-type': (el) => editSession((s) => (s.dayType = el.dataset.type)),
  step(el) {
    const delta = Number(el.dataset.delta);
    changeValue(el.dataset, (v, step) => {
      // Snap to the step grid so 187 + 5 → 190 rather than 192.
      const next = delta > 0 ? Math.floor(M.round(v / step, 6)) * step + step : Math.ceil(M.round(v / step, 6)) * step - step;
      return M.round(next, 2);
    });
    vibrate(5);
  },
  'complete-set'(el) {
    let entry;
    editEntry(el.dataset.entry, (e) => {
      M.completeNextSet(e);
      entry = e;
    });
    vibrate(10);
    if (entry) restAfter(entry);
  },
  'undo-set': (el) => editEntry(el.dataset.entry, (e) => M.undoLastSet(e)),
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
  'set-type'(el) {
    editEntry(el.dataset.entry, (e) => {
      const x = e.sets.find((s) => s.id === el.dataset.set);
      if (x) M.cycleSetType(x);
    });
  },
  'add-set'(el) {
    editEntry(el.dataset.entry, (e) => {
      M.addSet(e);
      if (!M.isHold(e.kind)) delete e.target.repScheme;
      e.target.sets = M.isHold(e.kind) ? e.sets.length : M.workingSets(e).length;
    });
  },
  'remove-set'(el) {
    editEntry(el.dataset.entry, (e) => {
      M.removeLastSet(e);
      if (!M.isHold(e.kind)) delete e.target.repScheme;
      e.target.sets = M.isHold(e.kind) ? e.sets.length : M.workingSets(e).length;
    });
  },
  'cardio-done': (el) => editEntry(el.dataset.entry, (e) => (e.cardio.done = !e.cardio.done)),
  rpe(el) {
    const v = Number(el.dataset.value);
    editEntry(el.dataset.entry, (e) => (e.rpe = e.rpe === v ? 0 : v));
  },
  'toggle-target'(el) {
    const id = el.dataset.entry;
    if (ui.editing.has(id)) ui.editing.delete(id);
    else ui.editing.add(id);
    render();
  },
  'move-entry'(el) {
    editSession((sess) => {
      const i = sess.entries.findIndex((e) => e.id === el.dataset.entry);
      const j = i + Number(el.dataset.dir);
      if (i < 0 || j < 0 || j >= sess.entries.length) return;
      [sess.entries[i], sess.entries[j]] = [sess.entries[j], sess.entries[i]];
    });
  },
  'remove-entry'(el) {
    const date = ui.date;
    let removed;
    let index;
    editSession((sess) => {
      index = sess.entries.findIndex((e) => e.id === el.dataset.entry);
      if (index >= 0) [removed] = sess.entries.splice(index, 1);
    });
    if (removed) {
      toast(`Removed ${M.exerciseName(S(), removed.exerciseId)}`, {
        label: 'Undo',
        run: () => editSession((sess) => sess.entries.splice(Math.min(index, sess.entries.length), 0, removed), date),
      });
    }
  },
  'swap-entry'(el) {
    const { session } = dayData(ui.date);
    const e = M.findEntry(session, el.dataset.entry);
    // Store the day first so the entry id stays valid while picking.
    editSession(() => {});
    openSheet({ mode: 'swap', entry: el.dataset.entry, group: S().exercises[e?.exerciseId]?.group, kind: e?.kind === 'cardio' ? 'cardio' : 'all' });
  },
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
    holdTimer = { entryId: entry, setId: set, date: ui.date, start: Date.now() };
    holdTimer.interval = setInterval(() => {
      const n = document.querySelector('[data-timer]');
      if (n) n.textContent = `${Math.floor((Date.now() - holdTimer.start) / 1000)}s`;
    }, 250);
    render();
  },
  'rest-add'(el) {
    if (!rest) return;
    const left = Math.max(0, rest.endsAt - Date.now());
    rest.endsAt = Date.now() + Math.max(0, left + Number(el.dataset.delta) * 1000);
    rest.total = Math.max(rest.total + Number(el.dataset.delta), 1);
    rest.done = false;
    saveRest();
    updateRestBar();
  },
  'rest-skip': stopRest,
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
  'open-add': (el) => openSheet({ mode: el.dataset.mode, wd: el.dataset.wd !== undefined ? Number(el.dataset.wd) : undefined }),
  'close-sheet': closeSheet,
  'sheet-kind'(el) {
    ui.sheet.kind = el.dataset.kind;
    renderSheetList();
  },
  'pick-exercise': (el) => addExerciseToContext(el.dataset.ex),
  'create-exercise'(el) {
    const name = ui.sheet.q.trim();
    if (!name) return;
    let id;
    store.update((s) => {
      id = M.addExercise(s, { name, kind: el.dataset.kind, group: el.dataset.kind === 'strength' ? '' : M.KINDS[el.dataset.kind] });
    });
    if (ui.sheet.mode === 'library') {
      closeSheet();
      toast(`Created ${name}`);
    } else addExerciseToContext(id);
  },
  'save-plan'() {
    const label = M.planLabel(S(), M.planIndex(S(), ui.date));
    if (!confirm(`Replace your ${label} plan with this day's exercises and targets? Future ${label}s you haven't started will use it.`)) return;
    store.update((s) => M.saveSessionAsPlan(s, ui.date));
    toast(`${label} plan updated`);
  },
  'reset-day'() {
    if (!confirm('Clear everything logged for this day and start over from the plan?')) return;
    stopHoldTimer(false);
    store.update((s) => M.resetSession(s, ui.date));
    toast('Day reset to plan');
  },
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
  'plan-type'(el) {
    store.update((s) => {
      s.plan[el.dataset.wd].dayType = el.dataset.type;
      s.plan[el.dataset.wd].updatedAt = Date.now();
    });
  },
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
  'plan-remove'(el) {
    store.update((s) => {
      const day = s.plan[el.dataset.wd];
      day.items = day.items.filter((it) => it.id !== el.dataset.item);
      day.updatedAt = Date.now();
    });
  },
  'plan-more'(el) {
    const id = el.dataset.item;
    if (ui.planMore.has(id)) ui.planMore.delete(id);
    else ui.planMore.add(id);
    render();
  },
  'superset-entry'(el) {
    editEntry(el.dataset.entry, (e) => {
      if (e.target.supersetNext) delete e.target.supersetNext;
      else e.target.supersetNext = true;
    });
  },
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
  'plan-swap'(el) {
    const it = S().plan[el.dataset.wd]?.items.find((i) => i.id === el.dataset.item);
    openSheet({ mode: 'plan-swap', wd: Number(el.dataset.wd), item: el.dataset.item, group: S().exercises[it?.exerciseId]?.group });
  },
  'progress-range'(el) {
    ui.progress.range = el.dataset.range;
    render();
  },
  'progress-metric'(el) {
    ui.progress.metric = el.dataset.metric;
    render();
  },
  'progress-chart'(el) {
    ui.progress.chart = el.dataset.chart;
    render();
  },
  'set-unit': (el) => updateSettings({ unit: el.dataset.value }),
  'set-dunit': (el) => updateSettings({ distanceUnit: el.dataset.value }),
  'set-weekstart': (el) => updateSettings({ weekStart: Number(el.dataset.value) }),
  'set-autorest': (el) => updateSettings({ autoRest: el.dataset.value === 'true' }),
  'set-restsound': (el) => updateSettings({ restSound: el.dataset.value === 'true' }),
  'sync-now': () => syncNow(),
  video: (el) => openVideo(el.dataset.url, el.dataset.title),
  'lib-group'(el) {
    ui.lib.group = el.dataset.group;
    render();
  },
  'lib-add'(el) {
    const exId = el.dataset.ex;
    const today = M.todayISO();
    editSession((sess, s) => {
      const prev = M.previousEntry(s, exId, today);
      sess.entries.push(M.makeEntry(s, exId, prev?.entry.target, today));
    }, today);
    toast(`Added ${M.exerciseName(S(), exId)} to today`);
  },
  'go-home'() {
    closeSheet();
    ui.tab = 'log';
    history.replaceState(null, '', '#log');
    goDate(M.todayISO());
    window.scrollTo(0, 0);
  },
  'export-json'() {
    download(`logbook-backup-${M.todayISO()}.json`, JSON.stringify(S(), null, 2), 'application/json');
  },
  'export-csv'() {
    download(`logbook-sets-${M.todayISO()}.csv`, M.toCSV(S()), 'text/csv');
  },
  'ex-delete'(el) {
    const id = el.dataset.ex;
    const name = M.exerciseName(S(), id);
    if (!confirm(`Delete “${name}”? It will be removed from your plan. Past logs are kept.`)) return;
    store.update((s) => {
      s.exercises[id] = { ...s.exercises[id], deleted: true, updatedAt: Date.now() };
      for (const day of Object.values(s.plan)) {
        const before = day.items.length;
        day.items = day.items.filter((it) => it.exerciseId !== id);
        if (day.items.length !== before) day.updatedAt = Date.now();
      }
    });
  },
  'reset-all'() {
    if (!confirm('Erase ALL workouts, weigh-ins, plans and custom exercises everywhere (this device, the server and your other devices)?')) return;
    if (!confirm('Really erase everything? This cannot be undone. Download a backup first if unsure.')) return;
    stopHoldTimer(false);
    stopRest();
    // Tombstone everything so the erase also reaches your other devices.
    store.update((s) => {
      const fresh = M.defaultState();
      const t = Date.now();
      for (const d of Object.keys(s.sessions)) fresh.sessions[d] = { date: d, deleted: true, updatedAt: t };
      for (const d of Object.keys(s.body)) fresh.body[d] = { weight: 0, updatedAt: t };
      for (const [id, ex] of Object.entries(s.exercises)) if (!fresh.exercises[id]) fresh.exercises[id] = { ...ex, deleted: true, updatedAt: t };
      Object.assign(s, fresh);
    });
    toast('All data erased');
  },
};

function updateSettings(patch) {
  store.update((s) => {
    Object.assign(s.settings, patch, { updatedAt: Date.now() });
  });
}

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

function editPlanItem(el, fn) {
  store.update((s) => {
    const day = s.plan[el.dataset.wd];
    const it = day?.items.find((i) => i.id === el.dataset.item);
    if (!it) return;
    fn(it);
    day.updatedAt = Date.now();
  });
}

const FIELDS = {
  value(el) {
    const raw = String(el.value).trim();
    const v = parseFloat(raw.replace(',', '.'));
    if (el.dataset.scope === 'body') {
      if (raw === '' || v === 0) return store.update((s) => M.setBodyWeight(s, ui.date, 0));
      if (Number.isNaN(v)) return render();
      return store.update((s) => M.setBodyWeight(s, ui.date, M.round(v, 1)));
    }
    if (Number.isNaN(v) && raw !== '') return render();
    changeValue(el.dataset, () => (Number.isNaN(v) ? 0 : v));
  },
  date: (el) => goDate(el.value),
  'session-name': (el) => editSession((s) => (s.name = el.value.trim())),
  'session-notes': (el) => editSession((s) => (s.notes = el.value)),
  'entry-notes': (el) => editEntry(el.dataset.entry, (e) => (e.notes = el.value)),
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
  'cycle-today'(el) {
    store.update((s) => M.anchorCycle(s, M.todayISO(), Number(el.value)));
    toast(`Today is now ${M.planLabel(S(), Number(el.value))}`);
  },
  'plan-name'(el) {
    store.update((s) => {
      s.plan[el.dataset.wd].name = el.value.trim();
      s.plan[el.dataset.wd].updatedAt = Date.now();
    });
  },
  'plan-daynote'(el) {
    store.update((s) => {
      s.plan[el.dataset.wd].note = el.value.trim().slice(0, 500);
      s.plan[el.dataset.wd].updatedAt = Date.now();
    });
  },
  'plan-note': (el) =>
    editPlanItem(el, (it) => {
      const v = el.value.trim().slice(0, 300);
      if (v) it.note = v;
      else delete it.note;
    }),
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
  'plan-copy'(el) {
    const from = Number(el.value);
    const to = Number(el.dataset.wd);
    if (el.value === '') return;
    const label = (i) => M.planLabel(S(), i);
    if (S().plan[to].items.length && !confirm(`Replace ${label(to)} with a copy of ${label(from)}?`)) {
      el.value = '';
      return;
    }
    store.update((s) => M.copyPlanDay(s, from, to));
    toast(`Copied ${label(from)} to ${label(to)}`);
  },
  'progress-exercise'(el) {
    ui.progress.exerciseId = el.value;
    ui.progress.picked = true;
    ui.progress.metric = null;
    render();
  },
  'ex-name'(el) {
    const name = el.value.trim();
    if (!name) return render();
    store.update((s) => {
      s.exercises[el.dataset.ex].name = name.slice(0, 80);
      s.exercises[el.dataset.ex].updatedAt = Date.now();
    });
  },
  'ex-kind'(el) {
    const id = el.dataset.ex;
    const used = M.sessionDates(S()).some((d) => S().sessions[d].entries.some((e) => e.exerciseId === id));
    if (used && !confirm('This exercise already has logged sessions. Changing its type only affects new entries. Continue?')) return render();
    store.update((s) => {
      s.exercises[id].kind = el.value;
      s.exercises[id].updatedAt = Date.now();
      // Plan targets need the fields for the new type.
      for (const day of Object.values(s.plan)) {
        let changed = false;
        for (const it of day.items) {
          if (it.exerciseId === id) {
            Object.assign(it, { ...M.defaultTarget(el.value), ...it });
            changed = true;
          }
        }
        if (changed) day.updatedAt = Date.now();
      }
    });
  },
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

document.addEventListener('click', (ev) => {
  unlockAudio();
  const el = ev.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = ACTIONS[el.dataset.action];
  if (fn) fn(el, ev);
});

document.addEventListener('change', (ev) => {
  const el = ev.target.closest('[data-field]');
  if (!el) return;
  const fn = FIELDS[el.dataset.field];
  if (!fn) return;
  // Defer so focus has moved to wherever the user tapped next.
  setTimeout(() => fn(el), 0);
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

function showPull(dist, state) {
  $ptr.classList.toggle('is-ready', state === 'ready');
  $ptr.classList.toggle('is-syncing', state === 'syncing');
  $ptr.querySelector('.ptr-text').textContent = state === 'syncing' ? 'Syncing…' : state === 'ready' ? 'Release to sync' : 'Pull to sync';
  $ptr.querySelector('.ptr-icon').style.transform = state === 'syncing' ? '' : `rotate(${dist * 3}deg)`;
  $ptr.style.opacity = String(Math.min(1, dist / 40));
  $ptr.style.transform = `translate(-50%, ${Math.min(dist, 90) - 80}px)`;
}

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
  }
});
window.addEventListener('online', () => store.sync());

// Roll "today" forward if the app was left open overnight.
let lastToday = M.todayISO();
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
store.init();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Exposed for debugging in the console.
window.logbook = { store, ui, M };
