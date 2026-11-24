// Diagrama SVG del flujo medallion. Se dibuja con el DOM (sin innerHTML) y se
// "ilumina" según el estado real del pipeline (ver updateDiagram).

const NS = 'http://www.w3.org/2000/svg';

function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) el.append(c instanceof Node ? c : document.createTextNode(c));
  return el;
}

// id: clave para iluminar · tool: tecnología · note: qué pasa en esa capa
const NODES = [
  { id: 'user',    title: 'Usuario',  tool: 'Web + Cognito',          note: ['Sube los CSV', 'con URL prefirmada'] },
  { id: 'landing', title: 'Landing',  tool: 'S3',                     note: ['CSV originales', 'sin tocar'] },
  { id: 'bronze',  title: 'Bronze',   tool: 'Lambda · awswrangler',   note: ['Todo como texto', '+ auditoría', 'Parquet'] },
  { id: 'silver',  title: 'Silver',   tool: 'pandas · Glue Spark',    note: ['Tipos, limpieza,', 'deduplicación', 'Parquet'] },
  { id: 'gold',    title: 'Gold',     tool: 'Athena CTAS (SQL)',      note: ['Dimensiones,', 'hechos y', 'agregados'] },
  { id: 'athena',  title: 'Athena',   tool: 'Glue Catalog',           note: ['Consultas SQL', 'sobre cualquier', 'capa'] },
];

const W = 136, H = 74, GAP = 32, X0 = 6, Y = 40;

export function createDiagram() {
  const root = svg('svg', {
    viewBox: '0 0 1000 250', role: 'img', class: 'diagram',
    'aria-label': 'Flujo: Usuario, Landing, Bronze, Silver, Gold y Athena',
  });
  root.append(
    svg('defs', {}, svg('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto' },
      svg('path', { d: 'M0,0 L10,5 L0,10 z', class: 'arrow-head' }))),
  );

  NODES.forEach((n, i) => {
    const x = X0 + i * (W + GAP);
    // Flecha hacia el siguiente nodo (animada solo si el usuario no pidió menos movimiento).
    if (i < NODES.length - 1) {
      root.append(svg('line', {
        x1: x + W + 2, y1: Y + H / 2, x2: x + W + GAP - 3, y2: Y + H / 2,
        class: 'flow', 'marker-end': 'url(#arrow)',
      }));
    }
    const g = svg('g', { class: `node node-${n.id}`, 'data-node': n.id });
    g.append(
      svg('rect', { x, y: Y, width: W, height: H, rx: 10 }),
      svg('text', { x: x + W / 2, y: Y + 30, class: 'node-title', 'text-anchor': 'middle' }, n.title),
      svg('text', { x: x + W / 2, y: Y + 52, class: 'node-tool', 'text-anchor': 'middle' }, n.tool),
    );
    n.note.forEach((line, j) =>
      g.append(svg('text', { x: x + W / 2, y: Y + H + 24 + j * 16, class: 'node-note', 'text-anchor': 'middle' }, line)));
    root.append(g);
  });

  // Etiqueta de los dos motores de Silver, para que se vea el escenario mixto.
  const sx = X0 + 3 * (W + GAP);
  root.append(
    svg('text', { x: sx + W / 2, y: Y - 22, class: 'node-note', 'text-anchor': 'middle' }, 'en paralelo:'),
    svg('text', { x: sx + W / 2, y: Y - 8, class: 'node-note', 'text-anchor': 'middle' }, 'dimensiones | hechos'),
  );
  return root;
}

// Estado de Step Functions -> nodo del diagrama.
const STEP_TO_NODE = { Bronze: 'bronze', SilverDimensions: 'silver', SilverFacts: 'silver', Gold: 'gold' };
const RANK = { FAILED: 3, RUNNING: 2, SUCCEEDED: 1 };

export function updateDiagram(diagram, steps = {}, executionStatus) {
  const state = {};
  for (const [step, st] of Object.entries(steps)) {
    const node = STEP_TO_NODE[step];
    if (!node) continue;
    // Silver tiene dos ramas: gana el estado "más urgente" (fallo > en curso > ok).
    // Si una rama terminó y la otra no ha empezado, se muestra en curso.
    const prev = state[node];
    state[node] = !prev || RANK[st] > RANK[prev] ? st : prev;
  }
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
