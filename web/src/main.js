import './style.css';
import { loadConfig, currentIdToken, currentEmail, login, logout } from './auth.js';
import * as api from './api.js';
import { LAYERS, STEPS, EXAMPLE_QUERIES } from './content.js';
import { createDiagram, updateDiagram } from './diagram.js';

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

/* ------------------------------------------------------------------ login */
function renderLogin(message = '') {
  const email = h('input', { type: 'email', placeholder: 'Email', required: true, autocomplete: 'username' });
  const pass = h('input', { type: 'password', placeholder: 'Contraseña', required: true, autocomplete: 'current-password' });
  const err = h('p', { class: 'error' }, message);
  const form = h('form', { class: 'card login', onsubmit: async (e) => {
    e.preventDefault();
    err.textContent = '';
    try {
      await login(email.value.trim(), pass.value);
      renderApp();
    } catch (ex) {
      err.textContent = ex.message || 'No se pudo iniciar sesión.';
    }
  } },
    h('h1', {}, 'Data Lake Medallion'),
    h('p', { class: 'muted' }, 'Adventure Works · Landing → Bronze → Silver → Gold → Athena'),
    email, pass, err, h('button', { type: 'submit' }, 'Entrar'));
  $app.replaceChildren(h('main', { class: 'center' }, form));
}

/* -------------------------------------------------------------------- app */
let pollTimer = null;

async function renderApp() {
  clearInterval(pollTimer);

  // --- Intro: diagrama y las 4 capas ----------------------------------------
  const diagram = createDiagram();
  const intro = h('section', { class: 'card' },
    h('h2', {}, 'El modelo medallion en 4 pasos'),
    h('p', { class: 'muted' }, 'Cada capa mejora la calidad del dato. Si algo sale mal, siempre se puede volver a la capa anterior y reprocesar.'),
    h('div', { class: 'diagram-wrap' }, diagram),
    h('div', { class: 'layers' }, LAYERS.map((l, i) =>
      h('div', { class: `layer layer-${l.id}` },
        h('span', { class: 'badge' }, `${i + 1}`), h('h3', {}, l.title), h('small', {}, l.tag), h('p', {}, l.text)))));

  // --- Paso 1: cargar ------------------------------------------------------
  const filesBox = h('div', { class: 'files' });
  const uploadMsg = h('p', { class: 'muted' });
  const picker = h('input', { type: 'file', multiple: true, accept: '.csv', class: 'hidden', onchange: () => uploadFiles([...picker.files]) });
  const dropzone = h('div', { class: 'dropzone', onclick: () => picker.click() },
    'Arrastra aquí los CSV de Adventure Works o haz clic para elegirlos (puedes seleccionar los 10 a la vez)');
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('over'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'));
  dropzone.addEventListener('drop', (e) => { e.preventDefault(); dropzone.classList.remove('over'); uploadFiles([...e.dataTransfer.files]); });

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
  const runHint = h('small', { class: 'muted' });
  const runBtn = h('button', { disabled: true, onclick: async () => {
    runBtn.disabled = true;
    pipeMsg.textContent = '';
    try { await api.startPipeline(); watchPipeline(); }
    catch (e) { pipeMsg.textContent = `✖ ${e.message}`; runBtn.disabled = false; }
  } }, '▶ Ejecutar pipeline');

  function renderSteps(status) {
    updateDiagram(diagram, status.steps, status.status);
    const icon = { RUNNING: '⏳', SUCCEEDED: '✔', FAILED: '✖' };
    stepsBox.replaceChildren(...STEPS.map((s) => {
      const st = status.steps?.[s.name];
      return h('div', { class: `step ${st ? st.toLowerCase() : 'idle'} ${s.indent ? 'indent' : ''}` },
        h('span', { class: 'icon' }, icon[st] ?? '·'), h('div', {}, h('strong', {}, s.label), h('br'), h('small', {}, s.hint)));
    }));
    if (status.status === 'SUCCEEDED') pipeMsg.textContent = '✔ Pipeline completado. Ya puedes consultar las tablas en el paso 3.';
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
      resultBox.replaceChildren(
        h('table', {}, h('thead', {}, h('tr', {}, r.columns.map((c) => h('th', {}, c)))),
          h('tbody', {}, r.rows.map((row) => h('tr', {}, row.map((v) => h('td', {}, v ?? '')))))),
        h('small', { class: 'muted' }, `${r.rows.length} fila(s)${r.truncated ? ' (mostrando las primeras 100)' : ''}`));
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
      stepsBox.replaceChildren(); pipeMsg.textContent = ''; updateDiagram(diagram);
      resultBox.replaceChildren();
      await refreshFiles();
    } catch (e) { resetMsg.textContent = `✖ ${e.message}`; }
  }

  $app.replaceChildren(
    h('header', {}, h('h1', {}, 'Data Lake Medallion · Adventure Works'),
      h('div', {}, h('small', {}, currentEmail()), h('button', { class: 'ghost', onclick: () => { logout(); renderLogin(); } }, 'Salir'))),
    h('main', {},
      intro,
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
        resetMsg)));

  try { await refreshFiles(); await watchPipelineIfRunning(); }
  catch (e) { uploadMsg.textContent = `✖ ${e.message}`; }

  async function watchPipelineIfRunning() {
    const s = await api.pipelineStatus();
    if (s.status === 'RUNNING') watchPipeline();
    else if (s.status !== 'NONE') renderSteps(s);
  }
}

/* ------------------------------------------------------------------ inicio */
(async () => {
  const config = await loadConfig();
  api.setApiUrl(config.apiUrl);
  (await currentIdToken()) ? renderApp() : renderLogin();
})();
