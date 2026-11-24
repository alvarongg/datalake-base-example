// Utilidades de DOM compartidas por las vistas.
import { ICONS, ICON_LABELS } from './icons.js';

/** Crea elementos del DOM. Usamos textContent (nunca innerHTML) para que ningún
 *  dato que venga de la API pueda inyectar HTML/JS (protección XSS). */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of children.flat()) el.append(c instanceof Node ? c : document.createTextNode(c ?? ''));
  return el;
}

export const fmtBytes = (n) => (n == null ? '' : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.ceil(n / 1e3)} KB`);
export const fmtNum = (n) => (n == null || n === '' ? '—' : Number(n).toLocaleString('es'));

export const awsIcon = (name, size = 36) =>
  h('img', { src: ICONS[name], width: size, height: size, alt: ICON_LABELS[name], title: ICON_LABELS[name] });

export const table = (head, rows) =>
  h('table', {}, h('thead', {}, h('tr', {}, head.map((t) => h('th', {}, t)))),
    h('tbody', {}, rows.map((r) => h('tr', {}, r.map((v) => h('td', {}, v ?? ''))))));
