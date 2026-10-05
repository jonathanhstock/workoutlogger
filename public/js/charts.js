// Tiny dependency-free SVG charts sized to their container.
// Single series only: one accent color, thin marks, recessive grid,
// and a crosshair/tooltip on hover or touch.

const NS = 'http://www.w3.org/2000/svg';
const H = 200;
const PAD = { top: 12, right: 12, bottom: 26, left: 44 };

function el(tag, attrs = {}, parent) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}

function niceStep(range, count) {
  const raw = range / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const norm = raw / mag;
  return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
}

function niceDomain(min, max, count = 4, fromZero = false) {
  if (fromZero) min = Math.min(0, min);
  if (min === max) {
    const p = Math.abs(max) * 0.1 || 1;
    min -= fromZero ? 0 : p;
    max += p;
    if (fromZero) min = Math.min(0, min);
  }
  const step = niceStep(max - min, count);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { lo, hi, ticks };
}

const tooltip = () => document.getElementById('tooltip');

function showTip(svg, x, y, html) {
  const t = tooltip();
  const r = svg.getBoundingClientRect();
  t.innerHTML = html;
  t.hidden = false;
  const left = Math.min(window.innerWidth - 70, Math.max(70, r.left + x));
  t.style.left = `${left}px`;
  t.style.top = `${r.top + y}px`;
}

function hideTip() {
  const t = tooltip();
  if (t) t.hidden = true;
}

function frame(container, fmtY, domain) {
  container.innerHTML = '';
  const W = Math.max(240, container.clientWidth);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img' }, container);
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const y = (v) => PAD.top + ih - ((v - domain.lo) / (domain.hi - domain.lo || 1)) * ih;
  const grid = el('g', { class: 'grid' }, svg);
  const axis = el('g', { class: 'axis' }, svg);
  for (const t of domain.ticks) {
    el('line', { x1: PAD.left, x2: W - PAD.right, y1: y(t), y2: y(t) }, grid);
    const txt = el('text', { x: PAD.left - 8, y: y(t) + 4, 'text-anchor': 'end' }, axis);
    txt.textContent = fmtY(t, true);
  }
  return { svg, W, iw, ih, y, axis };
}

function xLabels(axis, items, xOf, fmtX, W) {
  // Pick at most ~5 evenly spaced labels that won't collide.
  const maxLabels = Math.max(2, Math.floor(W / 90));
  const every = Math.max(1, Math.ceil(items.length / maxLabels));
  items.forEach((it, i) => {
    if (i % every !== 0 && i !== items.length - 1) return;
    if (i !== items.length - 1 && items.length - 1 - i < every / 2 && i !== 0) return;
    const t = el('text', { x: xOf(it, i), y: H - 6, 'text-anchor': 'middle' }, axis);
    t.textContent = fmtX(it);
  });
}

function bindHover(svg, items, pos, html, cross) {
  const move = (ev) => {
    const r = svg.getBoundingClientRect();
    const scale = svg.viewBox.baseVal.width / r.width;
    const px = (ev.clientX - r.left) * scale;
    let best = 0;
    let bestD = Infinity;
    items.forEach((it, i) => {
      const d = Math.abs(pos(it, i).x - px);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    const p = pos(items[best], best);
    if (cross) {
      cross.setAttribute('x1', p.x);
      cross.setAttribute('x2', p.x);
      cross.style.display = '';
    }
    showTip(svg, p.x / scale, p.y / scale, html(items[best]));
  };
  const leave = () => {
    if (cross) cross.style.display = 'none';
    hideTip();
  };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerdown', move);
  svg.addEventListener('pointerleave', leave);
  svg.addEventListener('pointercancel', leave);
}

function empty(container, msg) {
  container.innerHTML = `<div class="chart-empty">${msg}</div>`;
}

/**
 * Line chart over time. points: [{ x: 'YYYY-MM-DD', y: number, tip?: string }]
 */
export function lineChart(container, points, { fmtY = String, fmtX = String, emptyMsg = 'No data in this range yet' } = {}) {
  if (!points.length) return empty(container, emptyMsg);
  const ys = points.map((p) => p.y);
  const domain = niceDomain(Math.min(...ys), Math.max(...ys), 4, false);
  const { svg, W, iw, y, axis } = frame(container, fmtY, domain);
  const t = (iso) => new Date(iso + 'T12:00:00').getTime();
  const t0 = t(points[0].x);
  const t1 = t(points[points.length - 1].x);
  const x = (p) => (t1 === t0 ? PAD.left + iw / 2 : PAD.left + ((t(p.x) - t0) / (t1 - t0)) * iw);
  const base = y(domain.lo);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p).toFixed(1)},${y(p.y).toFixed(1)}`).join('');
  if (points.length > 1) {
    el('path', { class: 'area', d: `${d}L${x(points[points.length - 1]).toFixed(1)},${base}L${x(points[0]).toFixed(1)},${base}Z` }, svg);
    el('path', { class: 'line', d }, svg);
  }
  const cross = el('line', { class: 'cross', y1: PAD.top, y2: base, style: 'display:none' }, svg);
  // Show markers when sparse enough to read; always mark the last point.
  points.forEach((p, i) => {
    if (points.length <= 40 || i === points.length - 1) el('circle', { class: 'pt', cx: x(p), cy: y(p.y), r: 4 }, svg);
  });
  xLabels(axis, points, (p) => x(p), fmtX, W);
  bindHover(svg, points, (p) => ({ x: x(p), y: y(p.y) }), (p) => p.tip || `${fmtX(p)} · ${fmtY(p.y)}`, cross);
}

/**
 * Bar chart. bars: [{ label: string, y: number, tip?: string }]
 */
export function barChart(container, bars, { fmtY = String, fmtX = (b) => b.label, emptyMsg = 'No data in this range yet' } = {}) {
  if (!bars.length || bars.every((b) => !b.y)) return empty(container, emptyMsg);
  const domain = niceDomain(0, Math.max(...bars.map((b) => b.y)), 4, true);
  const { svg, W, iw, y, axis } = frame(container, fmtY, domain);
  const slot = iw / bars.length;
  const gap = Math.min(8, slot * 0.25);
  const bw = Math.max(2, slot - gap);
  const cx = (b, i) => PAD.left + slot * i + slot / 2;
  const base = y(0);
  bars.forEach((b, i) => {
    if (!b.y) return;
    const top = y(b.y);
    const h = Math.max(1, base - top);
    const r = Math.min(4, bw / 2, h);
    const x0 = cx(b, i) - bw / 2;
    // Rounded data end, square at the baseline.
    el('path', { class: 'barr', d: `M${x0},${base}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x0 + bw - r}Q${x0 + bw},${top} ${x0 + bw},${top + r}V${base}Z` }, svg);
  });
  xLabels(axis, bars, cx, fmtX, W);
  bindHover(svg, bars, (b, i) => ({ x: cx(b, i), y: y(b.y) }), (b) => b.tip || `${fmtX(b)} · ${fmtY(b.y)}`, null);
}

export { hideTip };
