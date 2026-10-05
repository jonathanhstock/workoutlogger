import * as M from './model.js';
import { createStore } from './store.js';
import { lineChart, barChart, hideTip } from './charts.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const $view = document.getElementById('view');
const $sheet = document.getElementById('sheet');
const $sheetPanel = $sheet.querySelector('.sheet-panel');

const TABS = ['log', 'plan', 'progress', 'settings'];
const ui = {
  tab: TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'log',
  date: M.todayISO(),
  editing: new Set(), // entry ids with the target editor open
  progress: { range: '3m', exerciseId: null, picked: false, metric: null, chart: 'volume' },
  sheet: null,
};

// Unsaved drafts (days built from the plan) are cached so the entry ids
// in the DOM stay valid until the first edit stores them.
const drafts = new Map();
const charts = [];
let timer = null; // running vacuum hold timer
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

function fmtPace(minPerUnit) {
  if (!minPerUnit) return '–';
  const m = Math.floor(minPerUnit);
  const s = Math.round((minPerUnit - m) * 60);
  return `${m}:${String(s).padStart(2, '0')}/${dunit()}`;
}

function fmtDate(iso, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
  return M.parseISODate(iso).toLocaleDateString(undefined, opts);
}

function targetText(entryOrItem, kind) {
  const t = entryOrItem.target || entryOrItem;
  if (kind === 'cardio') return `${fmt(t.minutes)} min${t.distance ? ` · ${fmt(t.distance)} ${dunit()}` : ''}`;
  if (kind === 'vacuum') return `${fmt(t.sets)} × ${fmtSec(t.holdSec)} hold`;
  return `${fmt(t.sets)} × ${fmt(t.reps)}${t.weight ? ` @ ${fmt(t.weight)} ${unit()}` : ''}`;
}

function loadText(kind, v) {
  if (kind === 'cardio') return `${fmt(v)} min`;
  if (kind === 'vacuum') return fmtSec(v);
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
  const done = entry.sets.filter((s) => s.done);
  if (entry.kind === 'vacuum') return done.map((s) => fmtSec(s.holdSec)).join(', ');
  return done.map((s) => `${fmt(s.weight)}×${fmt(s.reps)}`).join(', ');
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
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true" width="20" height="20"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z" fill="currentColor"/></svg>',
};

// ---------------------------------------------------------------------------
// Steppers: one generic control for every number in the app
// ---------------------------------------------------------------------------

const STEP = {
  weight: () => S().settings.weightStep,
  reps: () => 1,
  sets: () => 1,
  holdSec: () => 5,
  minutes: () => 1,
  distance: () => 0.1,
  calories: () => 10,
  avgHr: () => 1,
};
const INTEGER = new Set(['reps', 'sets', 'holdSec', 'calories', 'avgHr']);
const MAX = { sets: 50, reps: 1000, holdSec: 3600, avgHr: 260 };

function cleanValue(key, v) {
  v = Math.max(0, Math.min(MAX[key] ?? 100000, Number(v) || 0));
  return INTEGER.has(key) ? Math.round(v) : M.round(v, 2);
}

function stepper({ scope, key, value, label = '', entry = '', set = '', wd = '', item = '', sm = false }) {
  const a = `data-scope="${scope}" data-key="${key}" data-entry="${esc(entry)}" data-set="${esc(set)}" data-wd="${wd}" data-item="${esc(item)}"`;
  const name = esc(label || key);
  return `<div class="stepper-wrap">${label ? `<span class="label">${esc(label)}</span>` : ''}
    <div class="stepper${sm ? ' sm' : ''}">
      <button type="button" data-action="step" data-delta="-1" ${a} aria-label="Decrease ${name}">−</button>
      <input type="text" inputmode="decimal" autocomplete="off" data-field="value" ${a} value="${esc(fmtInput(value))}" aria-label="${name}">
      <button type="button" data-action="step" data-delta="1" ${a} aria-label="Increase ${name}">+</button>
    </div></div>`;
}

function fmtInput(v) {
  return String(M.round(Number(v) || 0, 2));
}

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
      day.updatedAt = Date.now();
    });
    return;
  }
  if (scope === 'setting') {
    store.update((s) => {
      s.settings[key] = Math.max(0.25, cleanValue(key, fn(s.settings[key] || 0, key === 'weightStep' ? 0.5 : 1)));
      s.settings.updatedAt = Date.now();
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
        M.setTargetSets(e, v);
      } else {
        e.target[key] = v;
        // New targets flow into the sets you haven't done yet.
        if (e.sets) for (const s of e.sets) if (!s.done && key in s) s[key] = v;
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
  const s = store.status;
  return {
    local: 'No server detected. Your data is saved in this browser only. Export backups regularly, or run the server to sync devices.',
    synced: 'Your logbook is saved on the server and in this browser.',
    syncing: 'Syncing…',
    offline: 'Saved in this browser. Changes will sync when the server is reachable.',
    auth: 'The server needs a password before it will sync.',
    error: 'Could not save in this browser. Export a backup.',
  }[s];
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
// Log view
// ---------------------------------------------------------------------------

function logView() {
  const state = S();
  const { session, draft } = dayData(ui.date);
  const today = M.todayISO();
  const ws = M.startOfWeek(ui.date, state.settings.weekStart);

  const week = Array.from({ length: 7 }, (_, i) => {
    const d = M.addDays(ws, i);
    const st = M.dayStatus(state, d);
    return `<button type="button" data-action="go-date" data-date="${d}" data-status="${st}" class="${d === today ? 'is-today' : ''}" ${d === ui.date ? 'aria-current="date"' : ''} aria-label="${fmtDate(d, { weekday: 'long', month: 'long', day: 'numeric' })}, ${st}">
      <span class="wd">${M.WEEKDAY_SHORT[M.weekdayOf(d)][0]}</span><span class="dn">${M.parseISODate(d).getDate()}</span><i class="st"></i></button>`;
  }).join('');

  // Day progress
  let totalUnits = 0;
  let doneUnits = 0;
  for (const e of session.entries) {
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
      else a.hold += m.totalHold;
      return a;
    },
    { vol: 0, min: 0, hold: 0 },
  );
  const sumBits = [sum.vol ? `${fmt(sum.vol)} ${unit()} volume` : '', sum.min ? `${fmt(sum.min)} min cardio` : '', sum.hold ? `${fmtSec(sum.hold)} vacuum` : ''].filter(Boolean).join(' · ');
  const pct = totalUnits ? Math.round((doneUnits / totalUnits) * 100) : 0;

  const entries = session.entries.map((e, i) => entryCard(e, i, session.entries.length)).join('');
  const isRest = session.dayType !== 'training';
  const emptyState = !session.entries.length
    ? `<div class="card empty"><h3>${session.dayType === 'rest' ? 'Rest day' : session.dayType === 'active' ? 'Active rest day' : 'Nothing planned'}</h3>
       <p class="hint">${isRest ? 'Recovery counts. If you did anything today, add it below.' : 'Add exercises below, or set up this weekday in the Plan tab.'}</p></div>`
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

  <section class="card dayhead">
    <input class="dayname" data-field="session-name" value="${esc(session.name)}" placeholder="Name this day (e.g. Push)" aria-label="Day name" maxlength="60">
    <div class="seg" role="group" aria-label="Day type">
      ${Object.entries(M.DAY_TYPES).map(([k, v]) => `<button type="button" data-action="day-type" data-type="${k}" aria-pressed="${session.dayType === k}">${v}</button>`).join('')}
    </div>
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
    <button type="button" class="btn sm" data-action="save-plan">Use this day as my ${fmtDate(ui.date, { weekday: 'long' })} plan</button>
    ${draft ? '' : '<button type="button" class="btn sm danger" data-action="reset-day">Reset day to plan</button>'}
  </div>
  ${draft && session.entries.length ? '<p class="draft-note">This day follows your weekly plan. Change anything here to adjust just this day.</p>' : ''}`;
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

function entryCard(e, index, count) {
  const state = S();
  const ex = state.exercises[e.exerciseId];
  const name = ex?.name || 'Unknown exercise';
  const prev = M.previousEntry(state, e.exerciseId, ui.date);
  const editing = ui.editing.has(e.id);
  const allDone = e.kind === 'cardio' ? e.cardio.done : e.sets.length > 0 && e.sets.every((s) => s.done);

  let body = '';
  if (e.kind === 'cardio') body = cardioBody(e);
  else body = setsBody(e, prev);

  return `<article class="card entry${allDone ? ' is-done' : ''}" data-entry-id="${e.id}">
    <div class="entry-head">
      <div class="entry-title">
        <h3>${esc(name)} <span class="badge ${e.kind}">${M.KINDS[e.kind]}</span></h3>
        <div class="target-line"><span>Target <b>${targetText(e, e.kind)}</b></span>
          <button type="button" class="link-btn" data-action="toggle-target" data-entry="${e.id}" aria-expanded="${editing}">${editing ? 'Done' : 'Edit target'}</button></div>
      </div>
      ${counterHTML(e)}
    </div>
    ${editing ? targetEditor(e, prev) : ''}
    ${intensityHTML(e, prev)}
    ${body}
    <div class="entry-foot">
      ${e.kind !== 'cardio' ? `<button type="button" class="btn sm" data-action="remove-set" data-entry="${e.id}" ${e.sets.length ? '' : 'disabled'}>− Set</button>
      <button type="button" class="btn sm" data-action="add-set" data-entry="${e.id}">+ Set</button>` : ''}
      <span class="grow"></span>
      <button type="button" class="icon-btn" data-action="move-entry" data-entry="${e.id}" data-dir="-1" aria-label="Move up" ${index === 0 ? 'disabled' : ''}>${ICON.up}</button>
      <button type="button" class="icon-btn" data-action="move-entry" data-entry="${e.id}" data-dir="1" aria-label="Move down" ${index === count - 1 ? 'disabled' : ''}>${ICON.down}</button>
      <button type="button" class="icon-btn" data-action="remove-entry" data-entry="${e.id}" aria-label="Remove ${esc(name)}">${ICON.trash}</button>
    </div>
    <input class="entry-notes" data-field="entry-notes" data-entry="${e.id}" value="${esc(e.notes)}" placeholder="Note (form cue, machine setting…)" aria-label="Note for ${esc(name)}" maxlength="1000">
  </article>`;
}

function targetEditor(e, prev) {
  const t = e.target;
  let fields;
  if (e.kind === 'cardio') {
    fields = `<div class="grid2">${stepper({ scope: 'target', key: 'minutes', value: t.minutes, label: 'Minutes', entry: e.id })}${stepper({ scope: 'target', key: 'distance', value: t.distance, label: `Distance (${dunit()})`, entry: e.id })}</div>`;
  } else if (e.kind === 'vacuum') {
    fields = `<div class="grid2">${stepper({ scope: 'target', key: 'sets', value: t.sets, label: 'Sets', entry: e.id })}${stepper({ scope: 'target', key: 'holdSec', value: t.holdSec, label: 'Hold (sec)', entry: e.id })}</div>`;
  } else {
    fields = `<div class="grid3">${stepper({ scope: 'target', key: 'sets', value: t.sets, label: 'Sets', entry: e.id })}${stepper({ scope: 'target', key: 'reps', value: t.reps, label: 'Reps', entry: e.id })}${stepper({ scope: 'target', key: 'weight', value: t.weight, label: unit(), entry: e.id })}</div>`;
  }
  let cmp = '<span class="muted">No previous session to compare with yet.</span>';
  if (prev) {
    const pt = prev.entry.target;
    const diffs = [];
    const keys = e.kind === 'cardio' ? [['minutes', 'min'], ['distance', dunit()]] : e.kind === 'vacuum' ? [['sets', 'sets'], ['holdSec', 's hold']] : [['sets', 'sets'], ['reps', 'reps'], ['weight', unit()]];
    for (const [k, label] of keys) {
      const d = M.round((t[k] || 0) - (pt[k] || 0), 2);
      if (d) diffs.push(`<span class="delta ${d > 0 ? 'up' : 'down'}">${d > 0 ? '+' : ''}${fmt(d)} ${label}</span>`);
    }
    cmp = `Last time (${fmtDate(prev.date)}): <b>${targetText(pt, e.kind)}</b> → ${diffs.length ? diffs.join(', ') : '<span class="delta flat">same target</span>'}`;
  }
  return `<div class="target-edit">${fields}<div class="compare">${cmp}</div>
    <p class="hint">Changes apply to this day only and fill the sets you haven't done yet. To change it every week, use “Use this day as my plan” or the Plan tab.</p></div>`;
}

function intensityHTML(e, prev) {
  const done = M.entryMetrics(e, true);
  const planned = M.entryMetrics(e, false);
  const pm = prev ? M.entryMetrics(prev.entry) : null;
  const max = Math.max(pm?.load || 0, planned.load, done.load, 1);
  const w = (v) => `${Math.min(100, (v / max) * 100).toFixed(1)}%`;
  const what = e.kind === 'cardio' ? 'Duration' : e.kind === 'vacuum' ? 'Total hold time' : 'Load (weight × reps)';

  let foot = '';
  if (e.kind === 'strength') {
    const top = planned.topWeight ? `${fmt(planned.topWeight)}×${fmt(planned.topReps)}` : '–';
    foot = `<span>Est. 1RM ${pm?.e1rm ? `${fmt(pm.e1rm)} → ` : ''}<b class="num">${fmt(planned.e1rm)}</b> ${deltaHTML(planned.e1rm, pm?.e1rm)}</span>
      <span>Top set ${pm ? `${fmt(pm.topWeight)}×${fmt(pm.topReps)} → ` : ''}<b class="num">${top}</b></span>`;
  } else if (e.kind === 'cardio') {
    foot = `<span>Distance ${pm ? `${fmt(pm.distance)} → ` : ''}<b class="num">${fmt(planned.distance)} ${dunit()}</b></span>
      ${planned.pace ? `<span>Pace ${pm?.pace ? `${fmtPace(pm.pace)} → ` : ''}<b class="num">${fmtPace(planned.pace)}</b></span>` : ''}`;
  } else {
    foot = `<span>Longest hold ${pm ? `${fmtSec(pm.longestHold)} → ` : ''}<b class="num">${fmtSec(planned.longestHold)}</b> ${deltaHTML(planned.longestHold, pm?.longestHold)}</span>`;
  }

  return `<div class="intensity" aria-label="Intensity tracker">
    <div class="int-head"><span class="label">${what}</span>${pm ? `<span>vs last: ${deltaHTML(planned.load, pm.load) || '<span class="delta flat">new</span>'}</span>` : '<span class="muted">First time – this sets your baseline</span>'}</div>
    ${pm ? `<div class="int-row"><span class="lbl">Last · ${fmtDate(prev.date, { month: 'short', day: 'numeric' })}</span><div class="bar"><i class="prev" style="width:${w(pm.load)}"></i></div><span class="val">${loadText(e.kind, pm.load)}</span></div>` : ''}
    <div class="int-row"><span class="lbl">Today</span><div class="bar" title="Logged ${loadText(e.kind, done.load)} of ${loadText(e.kind, planned.load)} planned"><i class="plan" style="width:${w(planned.load)}"></i><i class="done" style="width:${w(done.load)}"></i></div><span class="val">${loadText(e.kind, planned.load)}</span></div>
    <div class="int-foot"><span class="muted">Logged so far: <b class="num">${loadText(e.kind, done.load)}</b></span>${foot}</div>
  </div>`;
}

function setsBody(e, prev) {
  const prevSets = prev?.entry.sets?.filter((s) => s.done) || [];
  const vac = e.kind === 'vacuum';
  if (!e.sets.length) return '<p class="hint">No sets. Tap “+ Set” to add one.</p>';
  const head = vac
    ? '<div class="set-head vac"><span>#</span><span>Hold (sec)</span><span>Timer</span><span>Done</span></div>'
    : `<div class="set-head"><span>#</span><span>Weight (${unit()})</span><span>Reps</span><span>Done</span></div>`;
  const rows = e.sets
    .map((s, i) => {
      const p = prevSets[i];
      const hint = p ? `<div class="prev-hint">Last: ${vac ? fmtSec(p.holdSec) : `${fmt(p.weight)} × ${fmt(p.reps)}`}</div>` : '';
      const check = `<button type="button" class="check" data-action="toggle-set" data-entry="${e.id}" data-set="${s.id}" aria-pressed="${s.done}" aria-label="Set ${i + 1} done">${ICON.check}</button>`;
      if (vac) {
        const running = timer && timer.setId === s.id;
        return `<div class="set-row vac${s.done ? ' is-done' : ''}"><span class="idx">${i + 1}</span>
          ${stepper({ scope: 'set', key: 'holdSec', value: s.holdSec, entry: e.id, set: s.id, label: '' })}
          <button type="button" class="timer-btn${running ? ' running' : ''}" data-action="timer" data-entry="${e.id}" data-set="${s.id}" aria-label="${running ? 'Stop timer and log hold' : 'Start hold timer'}">${running ? `${ICON.stop}<span data-timer>${Math.floor((Date.now() - timer.start) / 1000)}s</span>` : `${ICON.play}Start`}</button>
          ${check}${hint}</div>`;
      }
      return `<div class="set-row${s.done ? ' is-done' : ''}"><span class="idx">${i + 1}</span>
        ${stepper({ scope: 'set', key: 'weight', value: s.weight, entry: e.id, set: s.id })}
        ${stepper({ scope: 'set', key: 'reps', value: s.reps, entry: e.id, set: s.id })}
        ${check}${hint}</div>`;
    })
    .join('');
  return `<div class="sets">${head}${rows}</div>`;
}

function cardioBody(e) {
  const c = e.cardio;
  const field = (key, label) => `<label class="field"><span>${label}</span><input type="text" inputmode="numeric" data-field="value" data-scope="cardio" data-key="${key}" data-entry="${e.id}" data-set="" data-wd="" data-item="" value="${c[key] ? fmtInput(c[key]) : ''}" placeholder="–"></label>`;
  return `<div class="cardio-grid">
      ${stepper({ scope: 'cardio', key: 'minutes', value: c.minutes, label: 'Minutes', entry: e.id })}
      ${stepper({ scope: 'cardio', key: 'distance', value: c.distance, label: `Distance (${dunit()})`, entry: e.id })}
      ${field('calories', 'Calories')}
      ${field('avgHr', 'Avg heart rate')}
    </div>
    <button type="button" class="btn block ${c.done ? '' : 'primary'}" data-action="cardio-done" data-entry="${e.id}" aria-pressed="${c.done}">${c.done ? `${ICON.check} Completed – tap to undo` : 'Mark cardio complete'}</button>`;
}

// ---------------------------------------------------------------------------
// Plan view
// ---------------------------------------------------------------------------

function planView() {
  const state = S();
  const ws = state.settings.weekStart;
  const todayWd = M.weekdayOf(M.todayISO());
  const order = Array.from({ length: 7 }, (_, i) => (ws + i) % 7);
  const days = order
    .map((wd) => {
      const day = state.plan[wd];
      const items = day.items
        .map((it, i) => {
          const ex = state.exercises[it.exerciseId];
          if (!ex || ex.deleted) return '';
          const kind = ex.kind;
          const st = (key, label) => stepper({ scope: 'plan', key, value: it[key] ?? M.defaultTarget(kind)[key] ?? 0, label, wd, item: it.id, sm: true });
          const grid =
            kind === 'cardio'
              ? `<div class="grid2">${st('minutes', 'Minutes')}${st('distance', dunit())}</div>`
              : kind === 'vacuum'
                ? `<div class="grid2">${st('sets', 'Sets')}${st('holdSec', 'Hold sec')}</div>`
                : `<div class="grid3">${st('sets', 'Sets')}${st('reps', 'Reps')}${st('weight', `${unit()} (0 = last)`)}</div>`;
          return `<div class="planitem">
            <div class="planitem-top"><span class="name">${esc(ex.name)}</span><span class="badge ${kind}">${M.KINDS[kind]}</span>
              <button type="button" class="icon-btn" data-action="plan-move" data-wd="${wd}" data-item="${it.id}" data-dir="-1" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>${ICON.up}</button>
              <button type="button" class="icon-btn" data-action="plan-move" data-wd="${wd}" data-item="${it.id}" data-dir="1" aria-label="Move down" ${i === day.items.length - 1 ? 'disabled' : ''}>${ICON.down}</button>
              <button type="button" class="icon-btn" data-action="plan-remove" data-wd="${wd}" data-item="${it.id}" aria-label="Remove ${esc(ex.name)}">${ICON.trash}</button></div>
            ${grid}</div>`;
        })
        .join('');
      return `<article class="card planday${wd === todayWd ? ' is-today' : ''}">
        <div class="planday-head">
          <div class="spread"><span class="wdname">${M.WEEKDAY_NAMES[wd]}${wd === todayWd ? ' · today' : ''}</span>
            <span class="muted small">${day.items.length} item${day.items.length === 1 ? '' : 's'}</span></div>
          <input class="dayname" data-field="plan-name" data-wd="${wd}" value="${esc(day.name)}" placeholder="Name (e.g. Push, Legs, Rest)" aria-label="${M.WEEKDAY_NAMES[wd]} name" maxlength="60">
          <div class="seg" role="group" aria-label="Day type">${Object.entries(M.DAY_TYPES).map(([k, v]) => `<button type="button" data-action="plan-type" data-wd="${wd}" data-type="${k}" aria-pressed="${day.dayType === k}">${v}</button>`).join('')}</div>
        </div>
        ${items || '<p class="hint">No exercises. Rest up, or add some.</p>'}
        <div class="planday-foot">
          <button type="button" class="btn sm" data-action="open-add" data-mode="plan" data-wd="${wd}">+ Add exercise</button>
          <select data-field="plan-copy" data-wd="${wd}" aria-label="Copy another day into ${M.WEEKDAY_NAMES[wd]}">
            <option value="">Copy from…</option>
            ${order.filter((o) => o !== wd).map((o) => `<option value="${o}">${M.WEEKDAY_NAMES[o]}${state.plan[o].name ? ` (${esc(state.plan[o].name)})` : ''}</option>`).join('')}
          </select>
        </div>
      </article>`;
    })
    .join('');
  return `<div class="stack"><h2>Weekly plan</h2>
    <p class="hint">Your default week. Each day in the Log starts from this plan until you change it. To do more or less for just one week, edit that day in the Log instead. A weight of 0 pre-fills from what you lifted last time.</p></div>
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
  const dates = M.sessionDates(S());
  return [dates[0] && dates[0] < today ? dates[0] : M.addDays(today, -27), dates.length && dates[dates.length - 1] > today ? dates[dates.length - 1] : today];
}

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
  ],
  vacuum: [
    ['totalHold', 'Total hold', (m) => m.totalHold],
    ['longestHold', 'Longest hold', (m) => m.longestHold],
    ['sets', 'Sets', (m) => m.sets],
  ],
};

function metricFormatter(kind, key) {
  if (kind === 'vacuum' && key !== 'sets') return (v) => fmtSec(v);
  if (key === 'pace') return (v) => fmtPace(v);
  if (['e1rm', 'topWeight', 'volume'].includes(key)) return (v, axis) => (axis ? fmtCompact(v) : `${fmt(v)} ${unit()}`);
  if (key === 'distance') return (v, axis) => (axis ? fmt(v) : `${fmt(v)} ${dunit()}`);
  if (key === 'minutes') return (v, axis) => (axis ? fmt(v) : `${fmt(v)} min`);
  return (v) => fmt(v);
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
  const logged = M.loggedExerciseIds(state);
  const all = M.activeExercises(state);
  // Default to the most recently trained exercise until you pick one.
  if (!p.picked || !state.exercises[p.exerciseId] || state.exercises[p.exerciseId].deleted) p.exerciseId = logged[0] || all[0]?.id || null;
  const ex = p.exerciseId ? state.exercises[p.exerciseId] : null;
  let exSection = '<p class="hint">Add exercises to see progress.</p>';
  if (ex) {
    const metrics = EX_METRICS[ex.kind];
    if (!metrics.find((m) => m[0] === p.metric)) p.metric = metrics[0][0];
    const [mKey, , mGet] = metrics.find((m) => m[0] === p.metric);
    const fmtM = metricFormatter(ex.kind, mKey);
    const hist = M.exerciseHistory(state, ex.id, from, to);
    const points = hist.map((h) => ({ x: h.date, y: mGet(h.metrics), tip: `${fmtDate(h.date)} · ${esc(fmtM(mGet(h.metrics)))}` })).filter((pt) => pt.y > 0 || mKey !== 'pace');
    charts.push({ id: 'chart-exercise', draw: (node) => lineChart(node, points, { fmtY: fmtM, fmtX: (pt) => fmtDate(pt.x, { month: 'short', day: 'numeric' }), emptyMsg: `No ${esc(ex.name)} logged in this range` }) });

    const allHist = M.exerciseHistory(state, ex.id);
    const best = (fn, cmp = (a, b) => a > b) => allHist.reduce((b, h) => (fn(h.metrics) && (!b || cmp(fn(h.metrics), fn(b.metrics))) ? h : b), null);
    let prs;
    if (ex.kind === 'strength') {
      const b1 = best((m) => m.e1rm);
      const bw = best((m) => m.topWeight);
      const bv = best((m) => m.volume);
      prs = [
        ['Best est. 1RM', b1 ? `${fmt(b1.metrics.e1rm)} ${unit()}` : '–', b1?.date],
        ['Heaviest set', bw ? `${fmt(bw.metrics.topWeight)}×${fmt(bw.metrics.topReps)}` : '–', bw?.date],
        ['Best volume', bv ? `${fmtCompact(bv.metrics.volume)} ${unit()}` : '–', bv?.date],
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
      .map((h) => `<tr><td><button type="button" class="link-btn" data-action="open-date" data-date="${h.date}">${fmtDate(h.date)}</button></td><td>${esc(setSummary(h.entry))}</td><td class="r">${esc(fmtM(mGet(h.metrics)))}</td></tr>`)
      .join('');

    const options = (ids, label) => (ids.length ? `<optgroup label="${label}">${ids.map((id) => `<option value="${esc(id)}" ${id === ex.id ? 'selected' : ''}>${esc(state.exercises[id].name)}</option>`).join('')}</optgroup>` : '');
    const unlogged = all.map((e) => e.id).filter((id) => !logged.includes(id));
    exSection = `
      <select data-field="progress-exercise" aria-label="Exercise">${options(logged.filter((id) => state.exercises[id] && !state.exercises[id].deleted), 'Logged')}${options(unlogged, 'Not logged yet')}</select>
      <div class="seg" role="group" aria-label="Metric">${metrics.map(([k, label]) => `<button type="button" data-action="progress-metric" data-metric="${k}" aria-pressed="${k === mKey}">${label}</button>`).join('')}</div>
      <div class="chart" id="chart-exercise"></div>
      <div class="prs">${prs.map(([k, v, d]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div>${d ? `<div class="muted small">${fmtDate(d, { month: 'short', day: 'numeric', year: '2-digit' })}</div>` : ''}</div>`).join('')}</div>
      ${rows ? `<div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th>${ex.kind === 'strength' ? 'Sets (weight×reps)' : ex.kind === 'vacuum' ? 'Holds' : 'Session'}</th><th class="r">${esc(metrics.find((m) => m[0] === mKey)[1])}</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}`;
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
    <div class="settings-row"><span>Weight unit</span>${seg('set-unit', st.unit, [['lb', 'lb'], ['kg', 'kg']])}</div>
    <div class="settings-row"><span>Distance unit</span>${seg('set-dunit', st.distanceUnit, [['mi', 'mi'], ['km', 'km']])}</div>
    <div class="settings-row"><span>Weight +/− step</span>${stepper({ scope: 'setting', key: 'weightStep', value: st.weightStep })}</div>
    <div class="settings-row"><span>Week starts on</span>${seg('set-weekstart', st.weekStart, [[1, 'Monday'], [0, 'Sunday']])}</div>
    <p class="hint">Changing units relabels numbers; it doesn't convert past entries.</p>
  </section>

  <section class="card stack">
    <h3>Sync &amp; backup</h3>
    <p class="hint" id="sync-detail">${syncDetail()}</p>
    <form class="row" data-form="password" autocomplete="off">
      <input type="password" name="pw" placeholder="${store.hasPassword() ? 'Password saved – enter to change' : 'Server password (if set)'}" aria-label="Server password" autocomplete="current-password">
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
    <p class="hint">“+” on an exercise marks the next set done, “−” undoes the last one. “Edit target” changes sets, reps and weight for that day only.</p>
    <button type="button" class="btn sm danger" data-action="reset-all" style="align-self:flex-start">Erase all data…</button>
  </section>`;
}

const VIEWS = { log: logView, plan: planView, progress: progressView, settings: settingsView };

// ---------------------------------------------------------------------------
// Add-exercise sheet
// ---------------------------------------------------------------------------

function openSheet(ctx) {
  ui.sheet = { q: '', kind: 'all', ...ctx };
  $sheetPanel.innerHTML = `
    <div class="spread"><h2 id="sheet-title">${ctx.mode === 'library' ? 'New exercise' : 'Add to ' + (ctx.mode === 'plan' ? M.WEEKDAY_NAMES[ctx.wd] : fmtDate(ui.date))}</h2>
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
  if (!sh) return;
  const kinds = document.getElementById('sheet-kinds');
  kinds.innerHTML = [['all', 'All'], ...Object.entries(M.KINDS)].map(([k, v]) => `<button type="button" data-action="sheet-kind" data-kind="${k}" aria-pressed="${sh.kind === k}">${v}</button>`).join('');
  const q = sh.q.trim().toLowerCase();
  const list = M.activeExercises(S()).filter((e) => (sh.kind === 'all' || e.kind === sh.kind) && (!q || e.name.toLowerCase().includes(q) || e.group.toLowerCase().includes(q)));
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
  const name = M.exerciseName(S(), exId);
  if (sh.mode === 'plan') {
    store.update((s) => {
      const day = s.plan[sh.wd];
      day.items.push({ id: M.uid(), exerciseId: exId, ...M.defaultTarget(M.exerciseKind(s, exId)) });
      day.updatedAt = Date.now();
    });
    toast(`Added ${name} to ${M.WEEKDAY_NAMES[sh.wd]}`);
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

function stopTimer(save) {
  if (!timer) return;
  clearInterval(timer.interval);
  const t = timer;
  timer = null;
  if (!save) return;
  const sec = Math.max(1, Math.round((Date.now() - t.start) / 1000));
  editSession(
    (sess) => {
      const e = M.findEntry(sess, t.entryId);
      const x = e?.sets.find((s) => s.id === t.setId);
      if (x) {
        x.holdSec = sec;
        x.done = true;
      }
    },
    t.date,
  );
  toast(`Logged a ${fmtSec(sec)} hold`);
}

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
    if (navigator.vibrate) navigator.vibrate(5);
  },
  'complete-set'(el) {
    editEntry(el.dataset.entry, (e) => M.completeNextSet(e));
    if (navigator.vibrate) navigator.vibrate(10);
  },
  'undo-set': (el) => editEntry(el.dataset.entry, (e) => M.undoLastSet(e)),
  'toggle-set'(el) {
    editEntry(el.dataset.entry, (e) => {
      const x = e.sets.find((s) => s.id === el.dataset.set);
      if (x) x.done = !x.done;
    });
    if (navigator.vibrate) navigator.vibrate(10);
  },
  'add-set'(el) {
    editEntry(el.dataset.entry, (e) => {
      M.addSet(e);
      e.target.sets = Math.max(e.target.sets || 0, e.sets.length);
    });
  },
  'remove-set'(el) {
    editEntry(el.dataset.entry, (e) => {
      M.removeLastSet(e);
      e.target.sets = e.sets.length;
    });
  },
  'cardio-done': (el) => editEntry(el.dataset.entry, (e) => (e.cardio.done = !e.cardio.done)),
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
  timer(el) {
    const { entry, set } = el.dataset;
    if (timer && timer.setId === set) {
      stopTimer(true);
      return;
    }
    stopTimer(true);
    // Store the day first so the ids we're timing are permanent.
    editSession(() => {});
    timer = { entryId: entry, setId: set, date: ui.date, start: Date.now() };
    timer.interval = setInterval(() => {
      const n = document.querySelector('[data-timer]');
      if (n) n.textContent = `${Math.floor((Date.now() - timer.start) / 1000)}s`;
    }, 250);
    render();
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
    const wdName = M.WEEKDAY_NAMES[M.weekdayOf(ui.date)];
    if (!confirm(`Replace your ${wdName} plan with this day's exercises and targets? Future ${wdName}s you haven't started will use it.`)) return;
    store.update((s) => M.saveSessionAsPlan(s, ui.date));
    toast(`${wdName} plan updated`);
  },
  'reset-day'() {
    if (!confirm('Clear everything logged for this day and start over from the plan?')) return;
    stopTimer(false);
    store.update((s) => M.resetSession(s, ui.date));
    toast('Day reset to plan');
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
  'sync-now'() {
    store.sync();
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
    if (!confirm(`Delete “${name}”? It will be removed from your weekly plan. Past logs are kept.`)) return;
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
    if (!confirm('Erase ALL workouts, plans and custom exercises everywhere (this device, the server and your other devices)? Download a backup first if unsure.')) return;
    if (!confirm('Really erase everything? This cannot be undone.')) return;
    stopTimer(false);
    // Tombstone everything so the erase also reaches your other devices.
    store.update((s) => {
      const fresh = M.defaultState();
      const t = Date.now();
      for (const d of Object.keys(s.sessions)) fresh.sessions[d] = { date: d, deleted: true, updatedAt: t };
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

const FIELDS = {
  value(el) {
    const v = parseFloat(String(el.value).replace(',', '.'));
    if (Number.isNaN(v) && el.value.trim() !== '') return render();
    changeValue(el.dataset, () => (Number.isNaN(v) ? 0 : v));
  },
  date: (el) => goDate(el.value),
  'session-name': (el) => editSession((s) => (s.name = el.value.trim())),
  'session-notes': (el) => editSession((s) => (s.notes = el.value)),
  'entry-notes': (el) => editEntry(el.dataset.entry, (e) => (e.notes = el.value)),
  'plan-name'(el) {
    store.update((s) => {
      s.plan[el.dataset.wd].name = el.value.trim();
      s.plan[el.dataset.wd].updatedAt = Date.now();
    });
  },
  'plan-copy'(el) {
    const from = Number(el.value);
    const to = Number(el.dataset.wd);
    if (el.value === '') return;
    if (S().plan[to].items.length && !confirm(`Replace ${M.WEEKDAY_NAMES[to]} with a copy of ${M.WEEKDAY_NAMES[from]}?`)) {
      el.value = '';
      return;
    }
    store.update((s) => M.copyPlanDay(s, from, to));
    toast(`Copied ${M.WEEKDAY_NAMES[from]} to ${M.WEEKDAY_NAMES[to]}`);
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
        for (const it of day.items) if (it.exerciseId === id) Object.assign(it, { ...M.defaultTarget(el.value), ...it });
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

// Pull changes from other devices when coming back to the app.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    checkToday();
    store.sync();
  }
});

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
window.addEventListener('online', () => store.sync());

render();
store.init();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Exposed for debugging in the console.
window.logbook = { store, ui, M };
