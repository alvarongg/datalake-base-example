// Pestaña Dashboard: cada panel ejecuta UNA consulta en Athena y la dibuja con
// su propio gráfico (se puede cambiar el tipo). Simula un tablero de comando
// alimentado por la capa Gold. Debajo, una consulta libre con gráfico.
import * as api from './api.js';
import { h, table, fmtBytes, fmtNum } from './util.js';
import { renderChart, CHART_TYPES, compact } from './chart.js';
import { DASHBOARD_PANELS, EXAMPLE_QUERIES } from './content.js';

const KPI_LABELS = {
  revenue: ['Ingresos', '$'], profit: ['Utilidad', '$'], units: ['Unidades vendidas', ''], orders: ['Pedidos', ''],
};

function kpiCards(columns, rows) {
  const row = rows[0] ?? [];
  return h('div', { class: 'kpis' }, columns.map((c, i) => {
    const [label, prefix] = KPI_LABELS[c] ?? [c, ''];
    const n = Number(row[i]);
    return h('div', { class: 'kpi' }, h('small', {}, label),
      h('strong', { title: fmtNum(n) }, Number.isFinite(n) ? `${prefix}${compact(n)}` : (row[i] ?? '—')));
  }));
}

/** Contenido de un panel según el tipo elegido; si no se puede graficar cae a tabla. */
function content(type, data) {
  if (!data) return h('p', { class: 'muted' }, '');
  if (type === 'kpi') return kpiCards(data.columns, data.rows);
  if (type === 'table') return h('div', { class: 'results' }, table(data.columns, data.rows));
  const chart = renderChart(type, data.columns, data.rows);
  return chart ?? h('div', {}, h('p', { class: 'muted' }, 'Estos datos no se pueden graficar con este tipo; se muestran como tabla.'),
    h('div', { class: 'results' }, table(data.columns, data.rows)));
}

const statsLine = (r) => `${r.rows.length} fila(s) · ${fmtBytes(r.stats?.dataScannedBytes) || '0 KB'} leídos · ${r.stats?.engineMillis ?? '?'} ms`;

function typeSelect(current, onChange) {
  return h('select', { class: 'typesel', 'aria-label': 'Tipo de gráfico', onchange: (e) => onChange(e.target.value) },
    CHART_TYPES.map(([v, label]) => h('option', { value: v, ...(v === current ? { selected: true } : {}) }, label)));
}

function buildPanel(def) {
  let type = def.type, data = null;
  const body = h('div', { class: 'pbody' });
  const foot = h('small', { class: 'muted' });
  const draw = () => body.replaceChildren(content(type, data));

  const head = h('div', { class: 'phead2' }, h('h3', {}, def.title),
    def.type === 'kpi' ? null : typeSelect(type, (t) => { type = t; draw(); }));
  const el = h('section', { class: `card panel-card${def.wide ? ' wide' : ''}` }, head, body,
    h('details', {}, h('summary', {}, 'Ver SQL'), h('pre', {}, def.sql)), foot);

  async function load() {
    body.replaceChildren(h('p', { class: 'muted' }, 'Consultando Athena…'));
    foot.textContent = '';
    try {
      data = await api.runQuery(def.sql);
      draw();
      foot.textContent = statsLine(data);
    } catch (e) {
      data = null;
      body.replaceChildren(h('p', { class: 'error' }, e.message));
    }
  }
  return { el, load };
}

export function createDashboard() {
  let loaded = false, stale = false, signature = null, loadedSignature = null;
  const banner = h('p', { class: 'banner', hidden: true });
  const panels = DASHBOARD_PANELS.map(buildPanel);
  const grid = h('div', { class: 'dash-grid' }, panels.map((p) => p.el));
  const refresh = h('button', { onclick: () => loadAll() }, '↻ Actualizar dashboard');

  async function loadAll() {
    refresh.disabled = true;
    banner.hidden = true;
    loadedSignature = signature;
    stale = false;
    await Promise.allSettled(panels.map((p) => p.load()));  // las consultas corren en paralelo
    loaded = true;
    refresh.disabled = false;
  }

  // --- consulta libre con gráfico ------------------------------------------
  const sqlBox = h('textarea', { rows: 6, spellcheck: false });
  sqlBox.value = EXAMPLE_QUERIES[0].sql;
  const select = h('select', { onchange: () => { sqlBox.value = EXAMPLE_QUERIES[select.value].sql; } },
    EXAMPLE_QUERIES.map((q, i) => h('option', { value: i }, q.title)));
  const out = h('div', { class: 'results' });
  const outFoot = h('small', { class: 'muted' });
  let freeType = 'bar', freeData = null;
  const drawFree = () => out.replaceChildren(content(freeType, freeData));
  const freeTypeSel = typeSelect(freeType, (t) => { freeType = t; drawFree(); });
  const runBtn = h('button', { onclick: async () => {
    runBtn.disabled = true;
    out.replaceChildren(h('p', { class: 'muted' }, 'Consultando Athena…'));
    outFoot.textContent = '';
    try {
      freeData = await api.runQuery(sqlBox.value);
      drawFree();
      outFoot.textContent = statsLine(freeData) + (freeData.truncated ? ' (mostrando las primeras 100)' : '');
    } catch (e) { freeData = null; out.replaceChildren(h('p', { class: 'error' }, e.message)); }
    runBtn.disabled = false;
  } }, 'Ejecutar consulta');

  const el = h('div', { class: 'stack' },
    h('section', { class: 'card' },
      h('div', { class: 'dag-title' }, h('div', {}, h('h2', {}, 'Tablero de comando'),
        h('p', { class: 'muted' }, 'Cada panel es una consulta SQL sobre la capa Gold, con su propio gráfico. Cambia el tipo de gráfico con el selector de cada panel.')), refresh),
      banner),
    grid,
    h('section', { class: 'card' },
      h('h2', {}, 'Consulta libre'),
      h('p', { class: 'muted' }, 'Solo lectura. Bases: datalake_bronze, datalake_silver y datalake_gold. La primera columna es la etiqueta y las numéricas son las series del gráfico.'),
      h('div', { class: 'row' }, select, freeTypeSel), sqlBox, runBtn, out, outFoot));

  return {
    el,
    /** La pestaña se muestra: carga la primera vez o si Gold cambió desde la última carga. */
    onShow() {
      if (signature === 'empty') return;
      if (!loaded || stale) loadAll();
    },
    /** Se llama con cada /state: detecta si Gold cambió para avisar que hay datos nuevos. */
    setGoldState(gold) {
      const anyBuilt = gold.some((g) => g.status !== 'not_built');
      signature = anyBuilt ? gold.map((g) => `${g.name}:${g.status}`).join('|') : 'empty';
      if (!anyBuilt) {
        banner.hidden = false;
        banner.textContent = 'Aún no se construyó Gold. Procesa los archivos y construye Gold en la pestaña Operar.';
        loaded = false;
      } else if (loaded && signature !== loadedSignature) {
        stale = true;
        banner.hidden = false;
        banner.textContent = 'Gold cambió desde la última carga. Actualiza el dashboard para ver los datos nuevos.';
      } else if (!loaded) {
        banner.hidden = true;  // Gold ya existe: onShow cargará los paneles
      }
    },
  };
}
