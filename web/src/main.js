import './style.css';
import { loadConfig, currentIdToken, currentEmail, login, logout } from './auth.js';
import * as api from './api.js';
import { LAYERS, STEPS, EXAMPLE_QUERIES, PIPELINES, OPTIMIZATIONS, BENCHMARKS } from './content.js';
import { createAppDiagram, createMedallionDiagram, updateDiagram } from './diagram.js';
import { ICONS, ICON_LABELS } from './icons.js';
import { ORIGINAL, OPTIMIZED } from './model.js';
import { renderER } from './er.js';

/* ---------------------------------------------------------------- helpers
 * `h` crea elementos del DOM. Usamos textContent (nunca innerHTML) para que
 * ningún dato que venga de la API pueda inyectar HTML/JS (protección XSS). */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of children.flat()) el.append(c instanceof Node ? c : document.createTextNode(c ?? ''));
  return el;
}
const $app = document.getElementById('app');
const fmtBytes = (n) => (n == null ? '' : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.ceil(n / 1e3)} KB`);
const awsIcon = (name, size = 36) => h('img', { src: ICONS[name], width: size, height: size, alt: ICON_LABELS[name], title: ICON_LABELS[name] });
const table = (head, rows) =>
  h('table', {}, h('thead', {}, h('tr', {}, head.map((t) => h('th', {}, t)))),
    h('tbody', {}, rows.map((r) => h('tr', {}, r.map((v) => h('td', {}, v ?? ''))))));

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

/* ------------------------------------------------------- vista: Resumen */
function buildOverview(medallion) {
  return h('div', { class: 'stack' },
    h('section', { class: 'card' },
      h('h2', {}, 'Cómo se conecta todo'),
      h('p', { class: 'muted' }, 'El usuario descarga la web desde CloudFront, inicia sesión en Cognito y llama a la API con el token JWT. Los CSV viajan directo a S3.'),
      h('div', { class: 'diagram-wrap' }, createAppDiagram())),
    h('section', { class: 'card' },
      h('h2', {}, 'El modelo medallion'),
      h('p', { class: 'muted' }, 'Cada capa mejora la calidad del dato. Si algo sale mal, siempre se puede volver a la capa anterior y reprocesar. El diagrama se ilumina mientras corre el pipeline.'),
      h('div', { class: 'diagram-wrap' }, medallion),
      h('div', { class: 'layers' }, LAYERS.map((l, i) =>
        h('div', { class: `layer layer-${l.id}` },
          h('span', { class: 'badge' }, `${i + 1}`), h('h3', {}, l.title), h('small', {}, l.tag), h('p', {}, l.text))))));
}

/* ------------------------------------------------------ vista: Pipelines */
function buildPipelines() {
  let selected = PIPELINES[0].id;
  let lastStatus = null;
  const list = h('nav', { class: 'plist', 'aria-label': 'Pipelines' });
  const detail = h('div', { class: 'pdetail' });

  const flow = (items) => h('div', { class: 'flowrow' }, items.flatMap(([icon, title, sub], i) => [
    i > 0 ? h('span', { class: 'flowarrow', 'aria-hidden': 'true' }, '→') : null,
    h('div', { class: 'flowitem' }, awsIcon(icon, 44), h('strong', {}, title), h('small', {}, sub)),
  ]).filter(Boolean));

  function render() {
    const stepStatus = (p) => lastStatus?.steps?.[p.stepName];
    list.replaceChildren(...PIPELINES.map((p) => {
      const st = stepStatus(p);
      return h('button', { class: `pitem ${p.id === selected ? 'active' : ''}`, onclick: () => { selected = p.id; render(); } },
        h('span', { class: `dot ${st ? st.toLowerCase() : 'idle'}`, title: st ?? 'sin ejecutar' }),
        h('span', {}, h('strong', {}, p.title), h('br'), h('small', {}, p.engine)));
    }));

    const p = PIPELINES.find((x) => x.id === selected);
    const st = stepStatus(p);
    const summary = lastStatus?.output ? p.summary(lastStatus.output) : null;
    detail.replaceChildren(
      h('div', { class: 'phead' }, h('h2', {}, p.title), h('span', { class: `chip ${p.id.includes('glue') ? 'glue' : 'pandas'}` }, p.engine),
        h('span', { class: `status ${st ? st.toLowerCase() : 'idle'}` }, st ?? 'sin ejecutar')),
      h('p', {}, p.goal),
      flow(p.flow),
      h('div', { class: 'cols' },
        h('div', {}, h('h3', {}, 'Qué hace, paso a paso'), h('ol', {}, p.steps.map((s) => h('li', {}, s)))),
        h('div', {},
          h('h3', {}, 'Reglas y garantías'), h('ul', {}, p.rules.map((s) => h('li', {}, s))),
          h('h3', {}, '¿Por qué este motor?'), h('p', {}, p.why),
          h('h3', {}, 'Dónde está el código'), h('code', {}, p.code))),
      h('h3', {}, 'Código clave'), h('pre', {}, p.snippet),
      h('h3', {}, 'Resultado de la última ejecución'),
      summary && summary.rows.length
        ? table(summary.head, summary.rows)
        : h('p', { class: 'muted' }, 'Aún no hay resultados: ejecuta el pipeline en la pestaña Operar.'));
  }
  render();
  return { el: h('div', { class: 'pipelines' }, list, detail), update: (s) => { lastStatus = s; render(); } };
}

/* -------------------------------------------------- vista: Modelo de datos */
function buildModel() {
  const result = h('div', { class: 'results' });
  const btn = h('button', { onclick: async () => {
    btn.disabled = true;
    const rows = [];
    for (const b of BENCHMARKS) {
      result.replaceChildren(h('p', { class: 'muted' }, `Ejecutando: ${b.label}…`), rows.length ? table(['Modelo', 'Joins', 'Datos leídos', 'Tiempo motor (ms)'], rows) : '');
      try {
        const r = await api.runQuery(b.sql);
        rows.push([b.label, b.joins, fmtBytes(r.stats?.dataScannedBytes) || '0 KB', r.stats?.engineMillis ?? '']);
      } catch (e) { rows.push([b.label, b.joins, 'error', e.message]); }
    }
    result.replaceChildren(
      table(['Modelo', 'Joins', 'Datos leídos', 'Tiempo motor (ms)'], rows),
      h('p', { class: 'muted' }, 'Con solo 56 mil filas los tiempos varían de una ejecución a otra: lo que escala con el volumen son los datos leídos y la cantidad de joins. Requiere haber ejecutado el pipeline.'));
    btn.disabled = false;
  } }, '⚡ Comparar velocidad en Athena');

  return h('div', { class: 'stack' },
    h('section', { class: 'card' },
      h('h2', {}, 'Modelo original (los CSV de Kaggle)'),
      h('p', { class: 'muted' }, 'Ocho tablas normalizadas, esquema copo de nieve. Las ventas vienen en tres archivos (2015, 2016, 2017) con la misma estructura. Todo es texto y para llegar a la categoría de un producto hay que encadenar tres tablas.'),
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
function buildOperate(onStatus) {
  let pollTimer = null;

  // --- Paso 1: cargar ------------------------------------------------------
  const filesBox = h('div', { class: 'files' });
  const uploadMsg = h('p', { class: 'muted' });
  const picker = h('input', { type: 'file', multiple: true, accept: '.csv', class: 'hidden', onchange: () => uploadFiles([...picker.files]) });
  const dropzone = h('div', { class: 'dropzone', onclick: () => picker.click() },
    'Arrastra aquí los CSV de Adventure Works o haz clic para elegirlos (puedes seleccionar los 10 a la vez)');
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('over'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'));
  dropzone.addEventListener('drop', (e) => { e.preventDefault(); dropzone.classList.remove('over'); uploadFiles([...e.dataTransfer.files]); });

  const runHint = h('small', { class: 'muted' });
  const runBtn = h('button', { disabled: true, onclick: async () => {
    runBtn.disabled = true;
    pipeMsg.textContent = '';
    try { await api.startPipeline(); watchPipeline(); }
    catch (e) { pipeMsg.textContent = `✖ ${e.message}`; runBtn.disabled = false; }
  } }, '▶ Ejecutar pipeline');

  async function refreshFiles() {
    const { datasets, ready } = await api.listFiles();
    filesBox.replaceChildren(h('table', {},
      h('thead', {}, h('tr', {}, ['Dataset', 'Archivo(s) esperado(s)', 'Procesa Silver con', 'Estado'].map((t) => h('th', {}, t)))),
      h('tbody', {}, datasets.map((d) => h('tr', {},
        h('td', {}, h('strong', {}, d.name), h('br'), h('small', { class: 'muted' }, d.description)),
        h('td', {}, d.files.map((f) => h('div', {}, f.name))),
        h('td', {}, h('span', { class: `chip ${d.engine}` }, d.engine === 'glue' ? 'AWS Glue (Spark)' : 'Lambda (pandas)')),
        h('td', {}, d.files.map((f) => h('div', { class: f.uploaded ? 'ok' : 'pending' }, f.uploaded ? `✔ ${fmtBytes(f.size)}` : '⏳ falta'))))))));
    runBtn.disabled = !ready;
    runHint.textContent = ready ? '' : 'Sube los 10 archivos para habilitar el pipeline.';
  }

  async function uploadFiles(files) {
    for (const f of files) {
      uploadMsg.textContent = `Subiendo ${f.name}…`;
      try { await api.uploadFile(f); } catch (e) { uploadMsg.textContent = `✖ ${f.name}: ${e.message}`; return; }
    }
    uploadMsg.textContent = files.length ? `✔ ${files.length} archivo(s) en el bucket landing.` : '';
    picker.value = '';
    await refreshFiles();
  }

  // --- Paso 2: pipeline ------------------------------------------------------
  const stepsBox = h('div', { class: 'steps' });
  const pipeMsg = h('p', { class: 'muted' });

  function renderSteps(status) {
    onStatus(status);
    const icon = { RUNNING: '⏳', SUCCEEDED: '✔', FAILED: '✖' };
    stepsBox.replaceChildren(...STEPS.map((s) => {
      const st = status.steps?.[s.name];
      return h('div', { class: `step ${st ? st.toLowerCase() : 'idle'} ${s.indent ? 'indent' : ''}` },
        h('span', { class: 'icon' }, icon[st] ?? '·'), h('div', {}, h('strong', {}, s.label), h('br'), h('small', {}, s.hint)));
    }));
    if (status.status === 'SUCCEEDED') pipeMsg.textContent = '✔ Pipeline completado. Revisa cada pipeline en la pestaña Pipelines o consulta las tablas abajo.';
    else if (status.status === 'FAILED' || status.status === 'TIMED_OUT') pipeMsg.textContent = `✖ ${status.status}: ${status.error ?? 'revisa los logs en CloudWatch'}`;
    else if (status.status === 'RUNNING') pipeMsg.textContent = 'Ejecutando…';
  }

  async function watchPipeline() {
    clearInterval(pollTimer);
    const tick = async () => {
      const s = await api.pipelineStatus().catch(() => null);
      if (!s) return;
      renderSteps(s);
      if (s.status !== 'RUNNING') { clearInterval(pollTimer); await refreshFiles(); }
    };
    await tick();
    pollTimer = setInterval(tick, 3000);
  }

  // --- Paso 3: consultar -----------------------------------------------------
  const sqlBox = h('textarea', { rows: 7, spellcheck: false });
  sqlBox.value = EXAMPLE_QUERIES[0].sql;
  const select = h('select', { onchange: () => { sqlBox.value = EXAMPLE_QUERIES[select.value].sql; } },
    EXAMPLE_QUERIES.map((q, i) => h('option', { value: i }, q.title)));
  const resultBox = h('div', { class: 'results' });
  const queryBtn = h('button', { onclick: async () => {
    queryBtn.disabled = true;
    resultBox.replaceChildren(h('p', { class: 'muted' }, 'Consultando Athena…'));
    try {
      const r = await api.runQuery(sqlBox.value);
      resultBox.replaceChildren(table(r.columns, r.rows),
        h('small', { class: 'muted' }, `${r.rows.length} fila(s)${r.truncated ? ' (mostrando las primeras 100)' : ''} · ${fmtBytes(r.stats?.dataScannedBytes) || '0 KB'} leídos · ${r.stats?.engineMillis ?? '?'} ms`));
    } catch (e) { resultBox.replaceChildren(h('p', { class: 'error' }, e.message)); }
    queryBtn.disabled = false;
  } }, 'Ejecutar consulta');

  // --- Reinicio -----------------------------------------------------------
  const resetMsg = h('p', { class: 'muted' });
  async function doReset(includeLanding) {
    const what = includeLanding ? 'TODO el lake, incluidos los CSV subidos' : 'Bronze, Silver y Gold (los CSV se conservan)';
    if (!confirm(`Se borrará ${what}. ¿Continuar?`)) return;
    resetMsg.textContent = 'Borrando…';
    try {
      await api.resetLake(includeLanding);
      resetMsg.textContent = '✔ Lake vacío. Puedes volver a ejecutar el pipeline desde cero.';
      stepsBox.replaceChildren(); pipeMsg.textContent = '';
      resultBox.replaceChildren();
      onStatus({ steps: {}, status: 'NONE' });
      await refreshFiles();
    } catch (e) { resetMsg.textContent = `✖ ${e.message}`; }
  }

  async function init() {
    try {
      await refreshFiles();
      const s = await api.pipelineStatus();
      if (s.status === 'RUNNING') watchPipeline();
      else if (s.status !== 'NONE') renderSteps(s);
    } catch (e) { uploadMsg.textContent = `✖ ${e.message}`; }
  }

  const el = h('div', { class: 'stack' },
    h('section', { class: 'card' }, h('h2', {}, 'Paso 1 · Cargar datos (Landing)'),
      h('p', { class: 'muted' }, 'Los archivos viajan directo del navegador a S3 mediante una URL prefirmada: ni la API ni Lambda los ven pasar.'),
      dropzone, picker, uploadMsg, filesBox),
    h('section', { class: 'card' }, h('h2', {}, 'Paso 2 · Procesar (Bronze → Silver → Gold)'),
      h('p', { class: 'muted' }, 'AWS Step Functions orquesta los pasos. Silver corre en paralelo: dimensiones (pandas) y hechos (Glue/Spark).'),
      runBtn, runHint, stepsBox, pipeMsg),
    h('section', { class: 'card' }, h('h2', {}, 'Paso 3 · Consultar con Athena'),
      h('p', { class: 'muted' }, 'Solo lectura. Bases disponibles: datalake_bronze, datalake_silver y datalake_gold. Prueba las mismas tablas en cada capa y compara.'),
      select, sqlBox, queryBtn, resultBox),
    h('section', { class: 'card danger' }, h('h2', {}, 'Reiniciar'),
      h('p', { class: 'muted' }, 'Deja el lake vacío para demostrar el proceso desde cero.'),
      h('div', { class: 'row' },
        h('button', { class: 'warn', onclick: () => doReset(false) }, 'Vaciar Bronze/Silver/Gold'),
        h('button', { class: 'danger-btn', onclick: () => doReset(true) }, 'Vaciar TODO (incluye CSV)')),
      resetMsg));
  return { el, init, stop: () => clearInterval(pollTimer) };
}

/* -------------------------------------------------------------------- app */
let stopPolling = () => {};

async function renderApp() {
  stopPolling();
  const medallion = createMedallionDiagram();
  const pipelines = buildPipelines();
  const operate = buildOperate((status) => {
    updateDiagram(medallion, status.steps, status.status);
    pipelines.update(status);
  });
  stopPolling = operate.stop;

  const TABS = [
    ['resumen', 'Resumen', buildOverview(medallion)],
    ['pipelines', 'Pipelines', pipelines.el],
    ['modelo', 'Modelo de datos', buildModel()],
    ['operar', 'Operar', operate.el],
  ];
  const panels = {};
  const nav = h('nav', { class: 'tabs', role: 'tablist' });
  const show = (id) => {
    for (const [tid] of TABS) {
      panels[tid].hidden = tid !== id;
      nav.querySelector(`[data-tab="${tid}"]`).setAttribute('aria-selected', String(tid === id));
    }
    if (location.hash !== `#${id}`) history.replaceState(null, '', `#${id}`);
  };
  for (const [id, label, el] of TABS) {
    panels[id] = h('div', { class: 'panel', role: 'tabpanel' }, el);
    nav.append(h('button', { class: 'tab', role: 'tab', 'data-tab': id, onclick: () => show(id) }, label));
  }

  $app.replaceChildren(
    h('header', {}, h('h1', {}, 'Data Lake Medallion · Adventure Works'),
      h('div', {}, h('small', {}, currentEmail()), h('button', { class: 'ghost', onclick: () => { logout(); stopPolling(); renderLogin(); } }, 'Salir'))),
    nav,
    h('main', {}, ...Object.values(panels)));

  const initial = location.hash.slice(1);
  show(TABS.some(([id]) => id === initial) ? initial : 'resumen');
  await operate.init();
}

/* ------------------------------------------------------------------ inicio */
(async () => {
  const config = await loadConfig();
  api.setApiUrl(config.apiUrl);
  (await currentIdToken()) ? renderApp() : renderLogin();
})();
