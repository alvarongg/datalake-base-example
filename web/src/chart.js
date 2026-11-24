// Gráficos SVG sin dependencias para el dashboard.
// Convención: la PRIMERA columna del resultado de Athena es la etiqueta y las
// columnas numéricas restantes son las series.

const NS = 'http://www.w3.org/2000/svg';
const PALETTE = ['#6366f1', '#22d3ee', '#eab308', '#f97316', '#22c55e', '#e879f9', '#f43f5e', '#94a3b8'];
const W = 520, H = 280;

export const CHART_TYPES = [
  ['bar', 'Barras'], ['hbar', 'Barras horizontales'], ['line', 'Líneas'], ['donut', 'Dona'], ['table', 'Tabla'],
];

function el(tag, attrs = {}, text) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}

/** 1234567 -> "1.2M". Se usa en ejes y etiquetas. */
export function compact(n) {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
const short = (s, n = 16) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

/** Separa etiquetas y series numéricas. Devuelve null si no hay nada que graficar. */
export function toSeries(columns, rows) {
  const numeric = [];
  for (let c = 1; c < columns.length; c++) {
    if (rows.length && rows.every((r) => r[c] != null && r[c] !== '' && Number.isFinite(Number(r[c])))) numeric.push(c);
  }
  if (!rows.length || !numeric.length) return null;
  return {
    labels: rows.map((r) => String(r[0] ?? '')),
    series: numeric.map((c) => ({ name: columns[c], values: rows.map((r) => Number(r[c])) })),
  };
}

/** Escala "bonita": máximo redondeado y 4 divisiones. */
function niceMax(max) {
  if (max <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  const f = max / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

function legend(svg, series) {
  if (series.length < 2) return;
  series.forEach((s, i) => {
    svg.append(el('rect', { x: 60 + i * 130, y: 6, width: 10, height: 10, rx: 2, fill: PALETTE[i % PALETTE.length] }),
      el('text', { x: 75 + i * 130, y: 15, class: 'ch-label' }, short(s.name, 14)));
  });
}

function axisY(svg, max, left, top, bottom, right) {
  for (let i = 0; i <= 4; i++) {
    const y = bottom - ((bottom - top) * i) / 4;
    svg.append(el('line', { x1: left, x2: right, y1: y, y2: y, class: 'ch-grid' }),
      el('text', { x: left - 6, y: y + 4, class: 'ch-label', 'text-anchor': 'end' }, compact((max * i) / 4)));
  }
}

function bars(data, horizontal) {
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img' });
  const { labels, series } = data;
  const max = niceMax(Math.max(...series.flatMap((s) => s.values), 0));
  legend(svg, series);

  if (horizontal) {
    const left = 130, right = W - 20, top = 24, bottom = H - 24;
    const band = (bottom - top) / labels.length;
    for (let i = 0; i <= 4; i++) {
      const x = left + ((right - left) * i) / 4;
      svg.append(el('line', { x1: x, x2: x, y1: top, y2: bottom, class: 'ch-grid' }),
        el('text', { x, y: H - 8, class: 'ch-label', 'text-anchor': 'middle' }, compact((max * i) / 4)));
    }
    labels.forEach((l, i) => {
      svg.append(el('text', { x: left - 6, y: top + band * i + band / 2 + 4, class: 'ch-label', 'text-anchor': 'end' }, short(l, 22)));
      series.forEach((s, k) => {
        const bh = Math.min(22, (band * 0.7) / series.length);
        const w = ((right - left) * s.values[i]) / max;
        const r = el('rect', { x: left, y: top + band * i + (band - bh * series.length) / 2 + k * bh, width: Math.max(w, 1), height: bh - 2, rx: 3, fill: PALETTE[k % PALETTE.length] });
        r.append(el('title', {}, `${l} · ${s.name}: ${s.values[i].toLocaleString('es')}`));
        svg.append(r);
      });
    });
    return svg;
  }

  const left = 52, right = W - 12, top = 28, bottom = H - (labels.length > 6 ? 62 : 36);
  axisY(svg, max, left, top, bottom, right);
  const band = (right - left) / labels.length;
  labels.forEach((l, i) => {
    const bw = Math.min(46, (band * 0.75) / series.length);
    series.forEach((s, k) => {
      const h = ((bottom - top) * s.values[i]) / max;
      const x = left + band * i + (band - bw * series.length) / 2 + k * bw;
      const r = el('rect', { x, y: bottom - h, width: bw - 2, height: Math.max(h, 1), rx: 3, fill: PALETTE[k % PALETTE.length] });
      r.append(el('title', {}, `${l} · ${s.name}: ${s.values[i].toLocaleString('es')}`));
      svg.append(r);
    });
    const tx = left + band * i + band / 2;
    const rotate = labels.length > 6;
    svg.append(el('text', { x: tx, y: bottom + 16, class: 'ch-label', 'text-anchor': rotate ? 'end' : 'middle',
      ...(rotate ? { transform: `rotate(-35 ${tx} ${bottom + 16})` } : {}) }, short(l, rotate ? 14 : 12)));
  });
  return svg;
}

function lines(data) {
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img' });
  const { labels, series } = data;
  const max = niceMax(Math.max(...series.flatMap((s) => s.values), 0));
  const left = 52, right = W - 14, top = 28, bottom = H - 36;
  legend(svg, series);
  axisY(svg, max, left, top, bottom, right);
  const x = (i) => left + (labels.length === 1 ? (right - left) / 2 : ((right - left) * i) / (labels.length - 1));
  const y = (v) => bottom - ((bottom - top) * v) / max;
  const every = Math.ceil(labels.length / 8); // evita amontonar etiquetas
  labels.forEach((l, i) => {
    if (i % every === 0) svg.append(el('text', { x: x(i), y: bottom + 16, class: 'ch-label', 'text-anchor': 'middle' }, short(l, 8)));
  });
  series.forEach((s, k) => {
    const color = PALETTE[k % PALETTE.length];
    svg.append(el('path', { d: s.values.map((v, i) => `${i ? 'L' : 'M'}${x(i)},${y(v)}`).join(' '), fill: 'none', stroke: color, 'stroke-width': 2.5, 'stroke-linejoin': 'round' }));
    s.values.forEach((v, i) => {
      const c = el('circle', { cx: x(i), cy: y(v), r: labels.length > 20 ? 2 : 3.5, fill: color });
      c.append(el('title', {}, `${labels[i]} · ${s.name}: ${v.toLocaleString('es')}`));
      svg.append(c);
    });
  });
  return svg;
}

function donut(data) {
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img' });
  const values = data.series[0].values.map((v) => Math.max(v, 0));
  const total = values.reduce((a, b) => a + b, 0) || 1;
  const cx = 150, cy = H / 2, R = 100, r = 60;
  let angle = -Math.PI / 2;
  values.forEach((v, i) => {
    const a2 = angle + (v / total) * Math.PI * 2;
    const large = a2 - angle > Math.PI ? 1 : 0;
    const p = (rad, ang) => `${cx + rad * Math.cos(ang)},${cy + rad * Math.sin(ang)}`;
    // Un único segmento al 100% no se puede dibujar como arco: se parte en dos mitades.
    const end = v / total > 0.9999 ? angle + Math.PI * 2 - 0.0001 : a2;
    const path = el('path', { d: `M${p(R, angle)} A${R},${R} 0 ${large} 1 ${p(R, end)} L${p(r, end)} A${r},${r} 0 ${large} 0 ${p(r, angle)} z`, fill: PALETTE[i % PALETTE.length] });
    path.append(el('title', {}, `${data.labels[i]}: ${v.toLocaleString('es')} (${((v / total) * 100).toFixed(1)}%)`));
    svg.append(path);
    angle = a2;
  });
  svg.append(el('text', { x: cx, y: cy - 2, class: 'ch-center', 'text-anchor': 'middle' }, compact(total)),
    el('text', { x: cx, y: cy + 16, class: 'ch-label', 'text-anchor': 'middle' }, data.series[0].name));
  data.labels.slice(0, 10).forEach((l, i) => {
    svg.append(el('rect', { x: 290, y: 38 + i * 22, width: 11, height: 11, rx: 2, fill: PALETTE[i % PALETTE.length] }),
      el('text', { x: 308, y: 48 + i * 22, class: 'ch-label' }, `${short(l, 20)} · ${((values[i] / total) * 100).toFixed(1)}%`));
  });
  return svg;
}

/** Devuelve un SVG, o null si los datos no son graficables (el llamador cae a tabla). */
export function renderChart(type, columns, rows) {
  const data = toSeries(columns, rows);
  if (!data) return null;
  if (type === 'bar') return bars(data, false);
  if (type === 'hbar') return bars(data, true);
  if (type === 'line') return lines(data);
  if (type === 'donut') return donut(data);
  return null;
}
