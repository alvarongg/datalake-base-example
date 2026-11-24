// Diagramas SVG con los iconos oficiales de AWS. Se dibujan con el DOM (sin
// innerHTML). El diagrama medallion se "ilumina" según el estado real del
// pipeline (ver updateDiagram).
import { ICONS } from './icons.js';

const NS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}, text) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}

const defs = () => el('defs', {}, undefined);
function arrowDefs() {
  const d = defs();
  const m = el('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto' });
  m.append(el('path', { d: 'M0,0 L10,5 L0,10 z', class: 'arrow-head' }));
  d.append(m);
  return d;
}

/** Icono oficial centrado en (cx, cy). */
function icon(name, cx, cy, size, title) {
  const img = el('image', { href: ICONS[name], x: cx - size / 2, y: cy - size / 2, width: size, height: size });
  img.append(el('title', {}, title));
  return img;
}

function line(x1, y1, x2, y2, { dashed = false, arrow = true } = {}) {
  return el('line', { x1, y1, x2, y2, class: `flow${dashed ? ' dashed' : ''}`, ...(arrow ? { 'marker-end': 'url(#arrow)' } : {}) });
}

const text = (x, y, s, cls = 'node-note', anchor = 'middle') => el('text', { x, y, class: cls, 'text-anchor': anchor }, s);

/* ------------------------------------------------------------------ App
 * Cómo se conecta el usuario con el sistema (hosting, login, API, datos). */
export function createAppDiagram() {
  const svg = el('svg', { viewBox: '0 0 1000 330', role: 'img', class: 'diagram',
    'aria-label': 'Arquitectura de la aplicación: usuario, CloudFront, Cognito, API Gateway, Lambda, S3, Step Functions y Athena' });
  svg.append(arrowDefs());

  // Usuario (no existe icono de servicio: se dibuja una figura simple).
  const user = el('g', { class: 'node node-user' });
  user.append(el('circle', { cx: 80, cy: 138, r: 14 }), el('path', { d: 'M52,190 a28,28 0 0 1 56,0 z' }));
  svg.append(user, text(80, 218, 'Usuario', 'node-title'), text(80, 234, 'Navegador', 'node-tool'));

  const nodes = [
    { icon: 'cloudfront', x: 300, y: 55, t: 'CloudFront + S3', s: 'Sirve la web (HTTPS)' },
    { icon: 'cognito', x: 300, y: 265, t: 'Cognito', s: 'Login SRP · emite el JWT' },
    { icon: 'apiGateway', x: 520, y: 160, t: 'API Gateway', s: 'Valida el JWT en cada ruta' },
    { icon: 'lambda', x: 710, y: 160, t: 'Lambda API', s: 'Reglas y permisos mínimos' },
    { icon: 's3', x: 900, y: 45, t: 'S3 landing', s: 'CSV por URL prefirmada' },
    { icon: 'stepFunctions', x: 900, y: 160, t: 'Step Functions', s: 'Inicia el pipeline' },
    { icon: 'athena', x: 900, y: 275, t: 'Athena', s: 'Consultas SELECT' },
  ];
  for (const n of nodes) {
    svg.append(icon(n.icon, n.x, n.y, 52, n.t), text(n.x, n.y + 42, n.t, 'node-title small'), text(n.x, n.y + 57, n.s, 'node-tool'));
  }

  svg.append(
    line(108, 150, 270, 70), text(170, 96, 'descarga la web', 'node-tool'),
    line(108, 175, 270, 255), text(160, 235, 'login', 'node-tool'),
    line(110, 162, 490, 162), text(300, 154, 'API + JWT', 'node-tool'),
    line(548, 160, 682, 160),
    line(520, 238, 520, 192, { dashed: true }), text(556, 222, 'valida JWT', 'node-tool'),
    line(738, 150, 872, 66), line(738, 160, 872, 160), line(738, 170, 872, 262),
  );
  return svg;
}

/* -------------------------------------------------------------- Medallion
 * Flujo de datos por capas, con el servicio que mueve el dato entre ellas. */
const BOX_W = 130, BOX_H = 120, BOX_Y = 120, LINE_Y = 180;
const BUCKETS = [
  { id: 'landing', title: 'Landing', note: 'CSV originales', cls: 'landing' },
  { id: 'bronze', title: 'Bronze', note: 'Parquet crudo', cls: 'bronze' },
  { id: 'silver', title: 'Silver', note: 'Parquet tipado', cls: 'silver' },
  { id: 'gold', title: 'Gold', note: 'Modelo estrella', cls: 'gold' },
  { id: 'athena', title: 'Athena', note: 'SQL sobre cualquier capa', cls: 'athena' },
];
const bx = (i) => 35 + i * 200;

export function createMedallionDiagram() {
  const svg = el('svg', { viewBox: '0 0 1000 330', role: 'img', class: 'diagram',
    'aria-label': 'Flujo medallion: Landing, Bronze, Silver, Gold y Athena con los servicios que transforman cada paso' });
  svg.append(arrowDefs());

  // Orquestador sobre todo el flujo.
  svg.append(icon('stepFunctions', 500, 30, 40, 'AWS Step Functions'), text(500, 62, 'AWS Step Functions orquesta cada paso', 'node-tool'),
    el('line', { x1: bx(1) + BOX_W / 2, y1: 78, x2: bx(4) - 70, y2: 78, class: 'flow dashed' }));

  BUCKETS.forEach((b, i) => {
    const x = bx(i);
    const g = el('g', { class: `node node-${b.cls}`, 'data-node': b.id });
    g.append(el('rect', { x, y: BOX_Y, width: BOX_W, height: BOX_H, rx: 12 }));
    g.append(icon(b.id === 'athena' ? 'athena' : 's3', x + BOX_W / 2, BOX_Y + 36, 48, b.id === 'athena' ? 'Amazon Athena' : 'Amazon S3'));
    g.append(text(x + BOX_W / 2, BOX_Y + 82, b.title, 'node-title'), text(x + BOX_W / 2, BOX_Y + 100, b.note, 'node-tool'));
    svg.append(g);
    if (i < BUCKETS.length - 1) svg.append(line(x + BOX_W + 2, LINE_Y, bx(i + 1) - 4, LINE_Y));
  });

  // Servicios que transforman el dato entre capas: [gap, icono, etiqueta, y del icono, nodo que ilumina]
  const engines = [
    [0, 'lambda', 'awswrangler', 146, 'bronze'],
    [1, 'lambda', 'pandas', 112, 'silver'],
    [1, 'glue', 'Spark', 198, 'silver'],
    [2, 'athena', 'CTAS SQL', 146, 'gold'],
    [3, 'glue', 'Data Catalog', 146, null],
  ];
  for (const [gap, name, label, y, node] of engines) {
    const cx = bx(gap) + BOX_W + 35;
    const g = el('g', { class: 'engine', ...(node ? { 'data-node': node } : {}) });
    g.append(icon(name, cx, y, 32, label), text(cx, y + 28, label, 'node-tool'));
    svg.append(g);
  }
  svg.append(
    text(bx(1) + BOX_W + 35, 292, 'dimensiones | hechos', 'node-tool'),
    text(500, 318, 'Cada capa es un bucket S3 distinto: permisos y ciclo de vida independientes', 'node-tool'),
  );
  return svg;
}

// Estado de Step Functions -> nodo del diagrama.
const STEP_TO_NODE = { Bronze: 'bronze', SilverDimensions: 'silver', SilverFacts: 'silver', Gold: 'gold' };
const RANK = { FAILED: 3, RUNNING: 2, SUCCEEDED: 1 };

export function updateDiagram(diagram, steps = {}, executionStatus) {
  const state = {};
  for (const [step, st] of Object.entries(steps)) {
    const node = STEP_TO_NODE[step];
    if (!node) continue;
    // Silver tiene dos ramas: gana el estado más urgente (fallo > en curso > ok).
    const prev = state[node];
    state[node] = !prev || RANK[st] > RANK[prev] ? st : prev;
  }
  // Una rama terminó pero la otra no: Silver sigue en curso.
  if (state.silver === 'SUCCEEDED' && (steps.SilverDimensions !== 'SUCCEEDED' || steps.SilverFacts !== 'SUCCEEDED')) {
    state.silver = 'RUNNING';
  }
  if (executionStatus === 'SUCCEEDED') state.athena = 'SUCCEEDED';
  diagram.querySelectorAll('[data-node]').forEach((g) => {
    g.classList.remove('running', 'succeeded', 'failed');
    const st = state[g.dataset.node];
    if (st) g.classList.add(st.toLowerCase());
  });
}
