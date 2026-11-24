// Renderizador de diagramas entidad-relación en SVG (sin librerías).
const NS = 'http://www.w3.org/2000/svg';
const HEAD = 26, ROW = 19, DEFAULT_W = 250;

function el(tag, attrs = {}, text) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}

export function renderER(model, label) {
  const svg = el('svg', { viewBox: `0 0 ${model.width} ${model.height}`, class: 'er', role: 'img', 'aria-label': label });
  const byId = Object.fromEntries(model.entities.map((e) => [e.id, { ...e, w: e.w ?? DEFAULT_W, h: HEAD + e.cols.length * ROW }]));

  // Geometría de una columna dentro de su entidad (para anclar las líneas en la fila de la FK).
  const rowY = (ent, col) => {
    const i = ent.cols.findIndex((x) => x.n === col);
    return ent.y + HEAD + i * ROW + ROW / 2;
  };

  // Relaciones primero, así quedan detrás de las cajas.
  const lines = el('g', { class: 'er-lines' });
  for (const r of model.relations) {
    const a = byId[r.from], b = byId[r.to];
    const y1 = rowY(a, r.fromCol), y2 = rowY(b, r.toCol);
    let x1, x2, c1, c2, lx1, lx2;
    if (Math.abs(a.x - b.x) < 5) {            // misma columna: la curva sale por la izquierda
      x1 = a.x; x2 = b.x; c1 = x1 - 40; c2 = x2 - 40; lx1 = x1 - 10; lx2 = x2 - 10;
    } else if (a.x > b.x) {                   // el origen está a la derecha del destino
      x1 = a.x; x2 = b.x + b.w; c1 = x1 - 45; c2 = x2 + 45; lx1 = x1 - 10; lx2 = x2 + 10;
    } else {                                  // el origen está a la izquierda del destino
      x1 = a.x + a.w; x2 = b.x; c1 = x1 + 45; c2 = x2 - 45; lx1 = x1 + 10; lx2 = x2 - 10;
    }
    lines.append(
      el('path', { d: `M${x1},${y1} C${c1},${y1} ${c2},${y2} ${x2},${y2}`, class: 'er-rel' }),
      el('text', { x: lx1, y: y1 - 4, class: 'er-card', 'text-anchor': 'middle' }, 'N'),
      el('text', { x: lx2, y: y2 - 4, class: 'er-card', 'text-anchor': 'middle' }, '1'),
    );
  }
  svg.append(lines);

  for (const n of model.notes ?? []) svg.append(el('text', { x: n.x, y: n.y, class: 'er-note' }, n.text));

  for (const e of Object.values(byId)) {
    const g = el('g', { class: `er-entity${e.agg ? ' agg' : ''}` });
    g.append(
      el('rect', { x: e.x, y: e.y, width: e.w, height: e.h, rx: 8, class: 'er-box' }),
      el('path', { d: `M${e.x},${e.y + HEAD} V${e.y + 8} a8,8 0 0 1 8,-8 H${e.x + e.w - 8} a8,8 0 0 1 8,8 V${e.y + HEAD} z`, class: 'er-head' }),
      el('text', { x: e.x + 10, y: e.y + 17, class: 'er-title' }, e.title),
    );
    e.cols.forEach((col, i) => {
      const y = e.y + HEAD + i * ROW + 14;
      g.append(el('text', { x: e.x + 10, y, class: `er-col ${col.k}` }, col.n));
      if (col.k) g.append(el('text', { x: e.x + e.w - 10, y, class: `er-tag ${col.k}`, 'text-anchor': 'end' },
        { pk: 'PK', fk: 'FK', part: 'PARTICIÓN' }[col.k]));
    });
    svg.append(g);
  }
  return svg;
}
