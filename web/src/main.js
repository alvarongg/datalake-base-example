import './style.css';
import { loadConfig, currentIdToken, currentEmail, login, logout } from './auth.js';
import * as api from './api.js';
import { LAYERS, OPTIMIZATIONS, BENCHMARKS } from './content.js';
import { PIPELINES } from './pipelines.js';
import { createAppDiagram, createMedallionDiagram, updateDiagram, layerStates } from './diagram.js';
import { ORIGINAL, OPTIMIZED } from './model.js';
import { renderER } from './er.js';
import { createDag } from './dag.js';
import { createDashboard } from './dashboard.js';
import { h, awsIcon, table, fmtBytes, fmtNum } from './util.js';

const $app = document.getElementById('app');

/* ------------------------------------------------------------------ login */
function renderLogin(message = '') {
  const email = h('input', { type: 'email', placeholder: 'Email', required: true, autocomplete: 'username' });
  const pass = h('input', { type: 'password', placeholder: 'Contraseña', required: true, autocomplete: 'current-password' });
  const err = h('p', { class: 'error' }, message);
  const form = h('form', { class: 'card login', onsubmit: async (e) => {
    e.preventDefault();
    err.textContent = '';
    try { await login(email.value.trim(), pass.value); renderApp(); }
    catch (ex) { err.textContent = ex.message || 'No se pudo iniciar sesión.'; }
  } },
    h('h1', {}, 'Data Lake Medallion'),
    h('p', { class: 'muted' }, 'Adventure Works · Landing → Bronze → Silver → Gold → Athena'),
    email, pass, err, h('button', { type: 'submit' }, 'Entrar'));
  $app.replaceChildren(h('main', { class: 'center' }, form));
}

/* -------------------------------------------- estado compartido del lake
 * Una sola fuente de verdad (GET /state). Mientras haya algo ejecutándose se
 * consulta cada 2,5 s; cuando todo termina el sondeo se detiene. */
function createLake() {
  const listeners = [];
  let timer = null;
  const lake = {
    state: null,
    subscribe(fn) { listeners.push(fn); if (lake.state) fn(lake.state); },
    async refresh() {
      clearTimeout(timer);
      try {
        lake.state = await api.getState();
        listeners.forEach((fn) => fn(lake.state));
      } catch (e) { console.warn('No se pudo leer el estado', e); }
      if (lake.state?.running) timer = setTimeout(lake.refresh, 2500);
    },
    stop() { clearTimeout(timer); },
  };
  return lake;
}

/* ------------------------------------------------------- vista: Resumen */
function buildOverview(medallion) {
  return h('div', { class: 'stack' },
    h('section', { class: 'card' },
      h('h2', {}, 'Cómo se conecta todo'),
      h('p', { class: 'muted' }, 'El usuario descarga la web desde CloudFront, inicia sesión en Cognito y llama a la API con el token JWT. Los CSV viajan directo a S3.'),
      h('div', { class: 'diagram-wrap' }, createAppDiagram())),
    h('section', { class: 'card' },
      h('h2', {}, 'El modelo medallion'),
      h('p', { class: 'muted' }, 'Cada capa mejora la calidad del dato. Si algo sale mal, siempre se puede volver a la capa anterior y reprocesar. El diagrama se ilumina mientras corren los pipelines.'),
      h('div', { class: 'diagram-wrap' }, medallion),
      h('div', { class: 'layers' }, LAYERS.map((l, i) =>
        h('div', { class: `layer layer-${l.id}` },
          h('span', { class: 'badge' }, `${i + 1}`), h('h3', {}, l.title), h('small', {}, l.tag), h('p', {}, l.text))))));
}

/* ------------------------------------------------------ vista: Pipelines */
/** 'running' | 'failed' | 'succeeded' | undefined para cada ficha de pipeline. */
function pipelineState(id, state) {
  const stage = (list, k) => list.map((d) => (d.run?.runStatus === 'SUCCEEDED' ? 'succeeded' : d.run?.stages?.[k]?.status));
  const pick = (sts, done) => (sts.includes('failed') || sts.includes('blocked') ? 'failed' : sts.includes('running') ? 'running' : done ? 'succeeded' : undefined);
  const ds = state.datasets;
  if (id === 'bronze') return pick(stage(ds, 'bronze'), ds.every((d) => ['bronze', 'stale', 'ok'].includes(d.status)));
  if (id === 'deps') return pick(stage(ds, 'dependencies'), ds.every((d) => ['bronze', 'ok', 'stale'].includes(d.status)));
  if (id === 'silver-pandas' || id === 'silver-glue') {
    const eng = id === 'silver-glue' ? 'glue' : 'pandas';
    const list = ds.filter((d) => d.engine === eng);
    return pick(stage(list, 'silver'), list.every((d) => d.status === 'ok'));
  }
  return layerStates(state).gold;
}

function buildPipelines(lake) {
  let selected = PIPELINES[0].id;
  const list = h('nav', { class: 'plist', 'aria-label': 'Pipelines' });
  const detail = h('div', { class: 'pdetail' });

  const flow = (items) => h('div', { class: 'flowrow' }, items.flatMap(([icon, title, sub], i) => [
    i > 0 ? h('span', { class: 'flowarrow', 'aria-hidden': 'true' }, '→') : null,
    h('div', { class: 'flowitem' }, awsIcon(icon, 44), h('strong', {}, title), h('small', {}, sub)),
  ]).filter(Boolean));

  function render() {
    const state = lake.state;
    list.replaceChildren(...PIPELINES.map((p) => {
      const st = state ? pipelineState(p.id, state) : undefined;
      return h('button', { class: `pitem ${p.id === selected ? 'active' : ''}`, onclick: () => { selected = p.id; render(); } },
        h('span', { class: `dot ${st ?? 'idle'}`, title: st ?? 'sin ejecutar' }),
        h('span', {}, h('strong', {}, p.title), h('br'), h('small', {}, p.engine)));
    }));

    const p = PIPELINES.find((x) => x.id === selected);
    const st = state ? pipelineState(p.id, state) : undefined;
    const summary = state ? p.summary(state) : null;
    detail.replaceChildren(
      h('div', { class: 'phead' }, h('h2', {}, p.title), h('span', { class: `chip ${p.id.includes('glue') ? 'glue' : 'pandas'}` }, p.engine),
        h('span', { class: `status ${st ?? 'idle'}` }, { running: 'en ejecución', failed: 'falló', succeeded: 'al día' }[st] ?? 'sin ejecutar')),
      h('p', {}, p.goal),
      flow(p.flow),
      h('div', { class: 'cols' },
        h('div', {}, h('h3', {}, 'Qué hace, paso a paso'), h('ol', {}, p.steps.map((s) => h('li', {}, s)))),
        h('div', {},
          h('h3', {}, 'Reglas y garantías'), h('ul', {}, p.rules.map((s) => h('li', {}, s))),
          h('h3', {}, '¿Por qué este diseño?'), h('p', {}, p.why),
          h('h3', {}, 'Dónde está el código'), h('code', {}, p.code))),
      h('h3', {}, 'Código clave'), h('pre', {}, p.snippet),
      h('h3', {}, 'Estado actual'),
      summary && summary.rows.length ? h('div', { class: 'results' }, table(summary.head, summary.rows.map((r) => r.map((v) => (typeof v === 'number' ? fmtNum(v) : v)))))
        : h('p', { class: 'muted' }, 'Aún no hay datos: procesa los archivos en la pestaña Operar.'));
  }
  lake.subscribe(render);
  render();
  return h('div', { class: 'pipelines' }, list, detail);
}

/* -------------------------------------------------- vista: Modelo de datos */
function buildModel() {
  const result = h('div', { class: 'results' });
  const btn = h('button', { onclick: async () => {
    btn.disabled = true;
    const rows = [];
    const head = ['Modelo', 'Joins', 'Datos leídos', 'Tiempo motor (ms)'];
    for (const b of BENCHMARKS) {
      result.replaceChildren(h('p', { class: 'muted' }, `Ejecutando: ${b.label}…`), rows.length ? table(head, rows) : '');
      try {
        const r = await api.runQuery(b.sql);
        rows.push([b.label, b.joins, fmtBytes(r.stats?.dataScannedBytes) || '0 KB', r.stats?.engineMillis ?? '']);
      } catch (e) { rows.push([b.label, b.joins, 'error', e.message]); }
    }
    result.replaceChildren(table(head, rows),
      h('p', { class: 'muted' }, 'Con solo 56 mil filas los tiempos varían de una ejecución a otra: lo que escala con el volumen son los datos leídos y la cantidad de joins. Requiere haber construido Gold.'));
    btn.disabled = false;
  } }, '⚡ Comparar velocidad en Athena');

  return h('div', { class: 'stack' },
    h('section', { class: 'card' },
      h('h2', {}, 'Modelo original (los CSV de Kaggle)'),
      h('p', { class: 'muted' }, 'Ocho tablas normalizadas, esquema copo de nieve. Las ventas vienen en tres archivos (2015, 2016, 2017) con la misma estructura. Todo es texto y para llegar a la categoría de un producto hay que encadenar tres tablas. Las flechas son las dependencias que validan los pipelines.'),
      h('div', { class: 'diagram-wrap' }, renderER(ORIGINAL, 'Diagrama entidad-relación original')),
      h('p', { class: 'legend' }, 'N = lado muchos (clave foránea) · 1 = lado uno (clave primaria)')),
    h('section', { class: 'card' },
      h('h2', {}, 'Modelo optimizado para consultas (capa Gold)'),
      h('p', { class: 'muted' }, 'Esquema en estrella: dos tablas de hechos y cuatro dimensiones desnormalizadas. Debajo, los agregados precalculados para dashboards.'),
      h('div', { class: 'diagram-wrap' }, renderER(OPTIMIZED, 'Diagrama entidad-relación optimizado (estrella)'))),
    h('section', { class: 'card' },
      h('h2', {}, 'Qué cambió y por qué es más rápido'),
      table(['Optimización', 'Detalle', 'Efecto'], OPTIMIZATIONS)),
    h('section', { class: 'card' },
      h('h2', {}, 'Compruébalo: la misma pregunta con tres modelos'),
      h('p', { class: 'muted' }, 'Ingresos por categoría en 2016. Cada consulta devuelve el mismo resultado; cambia cuánto trabaja Athena para obtenerlo.'),
      BENCHMARKS.map((b) => h('details', {}, h('summary', {}, `${b.label} · ${b.joins} join(s)`), h('pre', {}, b.sql))),
      btn, result));
}

/* -------------------------------------------------------- vista: Operar */
function buildOperate(lake) {
  const msg = h('p', { class: 'muted pipemsg' });
  const say = (text, kind = '') => { msg.textContent = text; msg.className = `pipemsg ${kind || 'muted'}`; };

  // --- Paso 1: cargar ------------------------------------------------------
  const filesBox = h('div', { class: 'files' });
  const uploadMsg = h('p', { class: 'muted' });
  const picker = h('input', { type: 'file', multiple: true, accept: '.csv', class: 'hidden', onchange: () => uploadFiles([...picker.files]) });
  const dropzone = h('div', { class: 'dropzone', onclick: () => picker.click() },
    'Arrastra aquí los CSV de Adventure Works o haz clic para elegirlos. Puedes subir uno solo o los 10: cada archivo se procesa por separado.');
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('over'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'));
  dropzone.addEventListener('drop', (e) => { e.preventDefault(); dropzone.classList.remove('over'); uploadFiles([...e.dataTransfer.files]); });

  function renderFiles(state) {
    const label = { no_file: 'sin archivo', pending: 'cargado, sin procesar', bronze: 'en Bronze', stale: 'desactualizada', ok: 'al día' };
    filesBox.replaceChildren(h('table', {},
      h('thead', {}, h('tr', {}, ['Dataset', 'Archivo(s)', 'Depende de', 'Estado'].map((t) => h('th', {}, t)))),
      h('tbody', {}, state.datasets.map((d) => h('tr', {},
        h('td', {}, h('strong', {}, d.name), h('br'), h('small', { class: 'muted' }, d.description)),
        h('td', {}, d.files.map((f) => h('div', { class: f.uploaded ? 'ok' : 'pending' }, f.uploaded ? `✔ ${f.name} (${fmtBytes(f.size)})` : `⏳ ${f.name}`))),
        h('td', {}, d.dependsOn.length ? d.dependsOn.join(', ') : '—'),
        h('td', {}, h('span', { class: `chip st-${d.status}` }, label[d.status])))))));
  }

  async function uploadFiles(files) {
    for (const f of files) {
      uploadMsg.textContent = `Subiendo ${f.name}…`;
      try { await api.uploadFile(f); } catch (e) { uploadMsg.textContent = `✖ ${f.name}: ${e.message}`; return; }
    }
    uploadMsg.textContent = files.length ? `✔ ${files.length} archivo(s) en el bucket landing.` : '';
    picker.value = '';
    await lake.refresh();
  }

  // --- Paso 2: mapa de pipelines ------------------------------------------
  async function start(fn, okText) {
    say('Iniciando…');
    try {
      const r = await fn();
      say(okText(r), 'ok');
      await lake.refresh();
    } catch (e) { say(`✖ ${e.message}`, 'error'); }
  }
  const dag = createDag({
    onRunDataset: (dataset, mode) => start(() => api.startDatasets(dataset, mode),
      (r) => `Pipeline iniciado: ${r.datasets.join(' → ')}`),
    onRunGold: (models) => start(() => api.startGold(models),
      (r) => `Construyendo Gold: ${r.models.join(', ')}`),
  });

  // --- Reinicio -----------------------------------------------------------
  const resetMsg = h('p', { class: 'muted' });
  async function doReset(includeLanding) {
    const what = includeLanding ? 'TODO el lake, incluidos los CSV subidos' : 'Bronze, Silver y Gold (los CSV se conservan)';
    if (!confirm(`Se borrará ${what}. ¿Continuar?`)) return;
    resetMsg.textContent = 'Borrando…';
    try {
      await api.resetLake(includeLanding);
      resetMsg.textContent = '✔ Lake vacío. Puedes volver a procesar desde cero.';
      say('');
      await lake.refresh();
    } catch (e) { resetMsg.textContent = `✖ ${e.message}`; }
  }

  lake.subscribe((state) => { renderFiles(state); dag.update(state); });

  return h('div', { class: 'stack' },
    h('section', { class: 'card' }, h('h2', {}, 'Paso 1 · Cargar datos (Landing)'),
      h('p', { class: 'muted' }, 'Los archivos viajan directo del navegador a S3 mediante una URL prefirmada: ni la API ni Lambda los ven pasar.'),
      dropzone, picker, uploadMsg, filesBox),
    h('section', { class: 'card' }, h('h2', {}, 'Paso 2 · Procesar: un pipeline por archivo'),
      h('p', { class: 'muted' }, 'Cada extracción dispara su propio pipeline. Prueba procesar "products" con "Solo este" sin haber procesado antes "product_subcategories": fallará en la compuerta de dependencias. Luego usa "Con dependencias" y verás cómo se ejecutan en orden.'),
      msg, dag.el),
    h('section', { class: 'card danger' }, h('h2', {}, 'Reiniciar'),
      h('p', { class: 'muted' }, 'Deja el lake vacío para demostrar el proceso desde cero.'),
      h('div', { class: 'row' },
        h('button', { class: 'warn', onclick: () => doReset(false) }, 'Vaciar Bronze/Silver/Gold'),
        h('button', { class: 'danger-btn', onclick: () => doReset(true) }, 'Vaciar TODO (incluye CSV)')),
      resetMsg));
}

/* -------------------------------------------------------------------- app */
let activeLake = null;

async function renderApp() {
  activeLake?.stop();
  const lake = createLake();
  activeLake = lake;
  const medallion = createMedallionDiagram();
  const dashboard = createDashboard();

  lake.subscribe((state) => { updateDiagram(medallion, state); dashboard.setGoldState(state.gold); });

  const TABS = [
    ['resumen', 'Resumen', buildOverview(medallion)],
    ['operar', 'Operar', buildOperate(lake)],
    ['pipelines', 'Pipelines', buildPipelines(lake)],
    ['dashboard', 'Dashboard', dashboard.el],
    ['modelo', 'Modelo de datos', buildModel()],
  ];
  const panels = {};
  const nav = h('nav', { class: 'tabs', role: 'tablist' });
  const show = (id) => {
    for (const [tid] of TABS) {
      panels[tid].hidden = tid !== id;
      nav.querySelector(`[data-tab="${tid}"]`).setAttribute('aria-selected', String(tid === id));
    }
    if (location.hash !== `#${id}`) history.replaceState(null, '', `#${id}`);
    if (id === 'dashboard') dashboard.onShow();
  };
  for (const [id, label, el] of TABS) {
    panels[id] = h('div', { class: 'panel', role: 'tabpanel' }, el);
    nav.append(h('button', { class: 'tab', role: 'tab', 'data-tab': id, onclick: () => show(id) }, label));
  }

  $app.replaceChildren(
    h('header', {}, h('h1', {}, 'Data Lake Medallion · Adventure Works'),
      h('div', {}, h('small', {}, currentEmail()), h('button', { class: 'ghost', onclick: () => { logout(); lake.stop(); renderLogin(); } }, 'Salir'))),
    nav,
    h('main', {}, ...Object.values(panels)));

  const initial = location.hash.slice(1);
  await lake.refresh();
  show(TABS.some(([id]) => id === initial) ? initial : 'resumen');
}

/* ------------------------------------------------------------------ inicio */
(async () => {
  const config = await loadConfig();
  api.setApiUrl(config.apiUrl);
  (await currentIdToken()) ? renderApp() : renderLogin();
})();
