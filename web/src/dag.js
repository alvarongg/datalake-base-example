// Mapa gráfico de pipelines: un nodo por tabla, con sus dependencias como flechas
// y el estado en vivo de cada etapa (Bronze → Dependencias → Silver).
import { h, awsIcon, fmtNum } from './util.js';

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

const STAGES = [['bronze', 'Bronze'], ['dependencies', 'Dependencias'], ['silver', 'Silver']];
const STATUS_LABEL = {
  no_file: 'Sin archivo', pending: 'Sin procesar', bronze: 'Solo en Bronze', stale: 'Desactualizada', ok: 'Al día ✔',
};
const GOLD_LABEL = { not_built: 'Sin construir', stale: 'Desactualizado', ok: 'Al día ✔' };
const STAGE_LABEL = { bronze: 'Bronze', dependencies: 'Dependencias', silver: 'Silver' };

// (columna, fila) de cada tabla. Las padre a la izquierda, las hijas a la derecha.
const SILVER_POS = {
  calendar: [0, 0], customers: [0, 1], territories: [0, 2],
  product_categories: [0, 3], product_subcategories: [1, 3], products: [2, 3],
  sales: [3, 1], returns: [3, 2],
};
const SILVER = { w: 210, h: 176, gapX: 50, gapY: 14 };
const GOLD = { w: 230, h: 118, gapX: 60, gapY: 12 };

function layoutGold(models) {
  const cols = { 0: [], 1: [], 2: [] };
  for (const m of models) cols[m.name.startsWith('dim_') ? 0 : m.name.startsWith('fact_') ? 1 : 2].push(m.name);
  const pos = {};
  for (const [c, names] of Object.entries(cols)) names.forEach((n, r) => { pos[n] = [Number(c), r]; });
  return pos;
}

const place = (box, [col, row]) => ({ x: col * (box.w + box.gapX), y: row * (box.h + box.gapY) });

/** Estado visual de las 3 etapas de un dataset. */
function stageStates(d) {
  const run = d.run;
  if (run && (run.runStatus === 'RUNNING' || run.runStatus === 'FAILED')) {
    return STAGES.map(([k]) => run.stages[k]?.status ?? 'pending');
  }
  const inBronze = ['bronze', 'stale', 'ok'].includes(d.status);
  const done = d.status === 'ok';
  return [inBronze ? 'succeeded' : 'pending', done ? 'succeeded' : 'pending',
    done ? 'succeeded' : d.status === 'stale' ? 'stale' : 'pending'];
}

function datasetHeadline(d) {
  const run = d.run;
  if (run?.runStatus === 'RUNNING') {
    if (run.queued) return ['queued', 'En cola…'];
    const active = STAGES.find(([k]) => run.stages[k]?.status === 'running');
    return ['running', active ? `Procesando · ${STAGE_LABEL[active[0]]}` : 'Procesando…'];
  }
  if (run?.runStatus === 'FAILED') {
    const bad = STAGES.find(([k]) => run.stages[k]?.status === 'failed');
    return ['failed', `Falló en ${bad ? STAGE_LABEL[bad[0]] : 'el pipeline'} ✖`];
  }
  return [`s-${d.status}`, STATUS_LABEL[d.status]];
}

function datasetMessage(d) {
  const run = d.run;
  const failed = run?.runStatus === 'FAILED' ? STAGES.map(([k]) => run.stages[k]).find((s) => s?.status === 'failed') : null;
  if (failed) {
    const bad = (failed.detail ?? []).filter((x) => x.status !== 'ok');
    return bad.length ? bad.map((x) => `✖ ${x.dependency}: ${x.reason}`).join('\n') : failed.error ?? '';
  }
  if (d.status === 'no_file') return `Falta subir: ${d.files.filter((f) => !f.uploaded).map((f) => f.name).join(', ')}`;
  if (d.status === 'stale') return 'Hay un archivo nuevo o una tabla de la que depende cambió. Hay que reprocesar.';
  const rows = [d.rows.bronze != null ? `Bronze ${fmtNum(d.rows.bronze)} filas` : null, d.rows.silver != null ? `Silver ${fmtNum(d.rows.silver)}` : null].filter(Boolean);
  return rows.join(' · ');
}

export function createDag({ onRunDataset, onRunGold }) {
  const silverCards = new Map();
  const goldCards = new Map();
  const silverEdges = [];
  const goldEdges = [];
  let built = false;

  const silverCanvas = h('div', { class: 'dag-canvas' });
  const goldCanvas = h('div', { class: 'dag-canvas' });
  const runAllBtn = h('button', { onclick: () => onRunDataset('all', 'with_dependencies') }, '▶ Procesar todos los archivos, en orden');
  const goldAllBtn = h('button', { onclick: () => onRunGold([]) }, '▶ Construir todo Gold');

  function buildSilverCard(d) {
    const stagesEl = h('div', { class: 'dstages' }, STAGES.map(([k, label]) => h('span', { class: 'pill pending', 'data-stage': k }, label)));
    const headline = h('div', { class: 'dstatus' });
    const msg = h('div', { class: 'dmsg' });
    const solo = h('button', { class: 'mini', title: 'Procesa solo este archivo. Falla si una tabla de la que depende no está al día.',
      onclick: () => onRunDataset(d.name, 'single') }, '▶ Solo este');
    const deps = d.dependsOn.length
      ? h('button', { class: 'mini ghost', title: 'Procesa en orden todo lo que este dataset necesita. Exige que estén todos los archivos.',
        onclick: () => onRunDataset(d.name, 'with_dependencies') }, '▶ Con dependencias')
      : null;
    const el = h('div', { class: 'dnode' },
      h('div', { class: 'dhead' }, awsIcon(d.engine === 'glue' ? 'glue' : 'lambda', 22), h('strong', {}, d.name),
        h('span', { class: `dchip ${d.engine}` }, d.engine === 'glue' ? 'Glue' : 'pandas')),
      headline, stagesEl,
      h('div', { class: 'ddeps' }, d.dependsOn.length ? `Necesita: ${d.dependsOn.join(', ')}` : 'Sin dependencias'),
      msg, h('div', { class: 'dactions' }, solo, deps));
    return { el, headline, stagesEl, msg, buttons: [solo, deps].filter(Boolean) };
  }

  function buildGoldCard(g) {
    const headline = h('div', { class: 'dstatus' });
    const msg = h('div', { class: 'dmsg' });
    const btn = h('button', { class: 'mini', onclick: () => onRunGold([g.name]) }, '▶ Construir');
    const reads = [g.silverDeps.length ? `Silver: ${g.silverDeps.join(', ')}` : null, g.goldDeps.length ? `Gold: ${g.goldDeps.join(', ')}` : null]
      .filter(Boolean).join(' · ');
    const el = h('div', { class: 'dnode gold' },
      h('div', { class: 'dhead' }, awsIcon('athena', 22), h('strong', {}, g.name)),
      headline, h('div', { class: 'ddeps' }, `Lee de ${reads}`), msg, h('div', { class: 'dactions' }, btn));
    return { el, headline, msg, buttons: [btn] };
  }

  function drawEdges(canvas, box, positions, edges, nodesByName) {
    const w = Math.max(...Object.values(positions).map(([c]) => c)) * (box.w + box.gapX) + box.w;
    const hgt = Math.max(...Object.values(positions).map(([, r]) => r)) * (box.h + box.gapY) + box.h;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${hgt}px`;
    const svg = svgEl('svg', { class: 'dag-edges', width: w, height: hgt, viewBox: `0 0 ${w} ${hgt}`, 'aria-hidden': 'true' });
    const defs = svgEl('defs');
    const marker = svgEl('marker', { id: `dagarrow-${canvas.dataset.kind}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto' });
    marker.append(svgEl('path', { d: 'M0,0 L10,5 L0,10 z', class: 'dag-arrow' }));
    defs.append(marker);
    svg.append(defs);
    for (const [child, parents] of nodesByName) {
      for (const parent of parents) {
        if (!positions[parent] || !positions[child]) continue;
        const a = place(box, positions[parent]), b = place(box, positions[child]);
        const x1 = a.x + box.w, y1 = a.y + box.h / 2, x2 = b.x, y2 = b.y + box.h / 2;
        const mid = (x1 + x2) / 2;
        const path = svgEl('path', { d: `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`, class: 'dag-edge',
          'marker-end': `url(#dagarrow-${canvas.dataset.kind})` });
        svg.append(path);
        edges.push({ parent, path });
      }
    }
    canvas.prepend(svg);
  }

  function build(state) {
    silverCanvas.dataset.kind = 'silver';
    goldCanvas.dataset.kind = 'gold';
    for (const d of state.datasets) {
      const card = buildSilverCard(d);
      const p = place(SILVER, SILVER_POS[d.name] ?? [0, 0]);
      Object.assign(card.el.style, { left: `${p.x}px`, top: `${p.y}px`, width: `${SILVER.w}px`, height: `${SILVER.h}px` });
      silverCanvas.append(card.el);
      silverCards.set(d.name, card);
    }
    drawEdges(silverCanvas, SILVER, SILVER_POS, silverEdges, state.datasets.map((d) => [d.name, d.dependsOn]));

    const gpos = layoutGold(state.gold);
    for (const g of state.gold) {
      const card = buildGoldCard(g);
      const p = place(GOLD, gpos[g.name]);
      Object.assign(card.el.style, { left: `${p.x}px`, top: `${p.y}px`, width: `${GOLD.w}px`, height: `${GOLD.h}px` });
      goldCanvas.append(card.el);
      goldCards.set(g.name, card);
    }
    drawEdges(goldCanvas, GOLD, gpos, goldEdges, state.gold.map((g) => [g.name, g.goldDeps]));
    built = true;
  }

  function update(state) {
    if (!built) build(state);
    const busy = state.running;
    const byName = Object.fromEntries(state.datasets.map((d) => [d.name, d]));

    for (const d of state.datasets) {
      const c = silverCards.get(d.name);
      const [cls, label] = datasetHeadline(d);
      c.el.className = `dnode ${cls}`;
      c.headline.textContent = label;
      stageStates(d).forEach((st, i) => { c.stagesEl.children[i].className = `pill ${st}`; });
      c.msg.textContent = datasetMessage(d);
      c.buttons.forEach((b) => { b.disabled = busy; });
    }
    for (const e of silverEdges) e.path.setAttribute('class', `dag-edge ${byName[e.parent]?.status === 'ok' ? 'ok' : 'pending'}`);

    const goldByName = Object.fromEntries(state.gold.map((g) => [g.name, g]));
    for (const g of state.gold) {
      const c = goldCards.get(g.name);
      const run = g.run;
      let cls = `s-${g.status}`, label = GOLD_LABEL[g.status];
      if (run?.status === 'running' || (run?.status === 'pending' && run.active)) { cls = 'running'; label = run.status === 'running' ? 'Construyendo…' : 'En cola…'; }
      else if (run?.status === 'failed') { cls = 'failed'; label = 'Falló ✖'; }
      else if (run?.status === 'blocked') { cls = 'failed'; label = 'Bloqueado por dependencias ✖'; }
      c.el.className = `dnode gold ${cls}`;
      c.headline.textContent = label;
      c.msg.textContent = run?.status === 'blocked' || run?.status === 'failed'
        ? (run.detail?.length ? run.detail.map((x) => `✖ ${x.dependency}: ${x.reason}`).join('\n') : run.error ?? '') : '';
      c.buttons.forEach((b) => { b.disabled = busy; });
    }
    for (const e of goldEdges) e.path.setAttribute('class', `dag-edge ${goldByName[e.parent]?.status === 'ok' ? 'ok' : 'pending'}`);
    runAllBtn.disabled = busy;
    goldAllBtn.disabled = busy;
  }

  const el = h('div', { class: 'dag' },
    h('div', { class: 'dag-section' },
      h('div', { class: 'dag-title' }, h('h3', {}, 'Silver · un pipeline por archivo'), runAllBtn),
      h('p', { class: 'muted' }, 'Cada tabla tiene su pipeline: Bronze → Dependencias → Silver. Las flechas van de la tabla padre a la hija. "Solo este" falla si un padre no está al día; "Con dependencias" los procesa en orden.'),
      h('div', { class: 'dag-scroll' }, silverCanvas)),
    h('div', { class: 'dag-section' },
      h('div', { class: 'dag-title' }, h('h3', {}, 'Gold · modelos SQL'), goldAllBtn),
      h('p', { class: 'muted' }, 'Cada modelo declara en su SQL qué tablas lee. Solo se construye si todas están al día.'),
      h('div', { class: 'dag-scroll' }, goldCanvas)));

  return { el, update };
}
