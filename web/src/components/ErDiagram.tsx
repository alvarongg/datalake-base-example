// Diagrama entidad-relación interactivo con React Flow:
// - las tablas se arrastran y sueltan para ordenarlas como uno quiera (se recuerda en el navegador);
// - las relaciones se anclan a la fila de cada columna y eligen el lado más corto, así no se cortan;
// - al seleccionar una tabla se resaltan sus relaciones y las tablas conectadas;
// - "Ordenar automáticamente" recalcula la posición con dagre.
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow, useNodesState, useReactFlow, ReactFlowProvider,
  type Edge, type Node, type NodeProps,
} from '@xyflow/react';
import dagre from '@dagrejs/dagre';
import { Button } from '@heroui/react';
import { KeyRound, Link2, RotateCcw, Sparkles, Waypoints } from 'lucide-react';
import type { Column, ErModel } from '@/lib/model';
import { cn } from '@/lib/utils';

const ROW = 22, HEAD = 36, WIDTH = 264;
const heightOf = (cols: number) => HEAD + cols * ROW + 8;

type TableData = { title: string; cols: Column[]; agg?: boolean; dim?: boolean; highlighted?: boolean; faded?: boolean; activeCols?: string[] };

const KIND_STYLE: Record<string, string> = { pk: 'text-gold font-semibold', fk: 'text-pandas', part: 'text-[#f0abfc] font-semibold' };
const KIND_TAG: Record<string, string> = { pk: 'PK', fk: 'FK', part: 'PARTICIÓN' };

const TableNode = memo(function TableNode({ data, selected }: NodeProps & { data: TableData }) {
  return (
    <div className={cn('rounded-xl border-2 bg-surface shadow-md transition-opacity', data.agg ? 'border-dashed border-[#a78bfa]/70' : 'border-border',
      (selected || data.highlighted) && 'border-accent shadow-accent/30', data.faded && 'opacity-25')} style={{ width: WIDTH }}>
      <div className={cn('flex items-center gap-2 rounded-t-[10px] px-3', data.agg ? 'bg-[#a78bfa]/20' : data.dim ? 'bg-pandas/15' : 'bg-surface-tertiary')} style={{ height: HEAD }}>
        <span className="truncate text-[13px] font-semibold">{data.title}</span>
        {data.agg && <span className="ml-auto text-[10px] uppercase text-[#c4b5fd]">agregado</span>}
      </div>
      {/* Conectores a nivel tabla (para el linaje de agregados). */}
      <Handle type="target" position={Position.Top} id="table-t" className="!opacity-0" />
      <Handle type="source" position={Position.Bottom} id="table-s" className="!opacity-0" />
      <div className="py-1">
        {data.cols.map((c) => (
          <div key={c.n} className={cn('relative flex items-center gap-2 px-3 font-mono text-[12px]', data.activeCols?.includes(c.n) && 'bg-accent/20')} style={{ height: ROW }}>
            {c.k === 'pk' ? <KeyRound className="size-3 text-gold" /> : c.k === 'fk' ? <Link2 className="size-3 text-pandas" /> : <span className="w-3" />}
            <span className={cn('truncate', KIND_STYLE[c.k])}>{c.n}</span>
            {c.k && <span className="ml-auto text-[9px] text-muted">{KIND_TAG[c.k]}</span>}
            {/* Un conector por lado y por columna: la relación sale exactamente de su fila. */}
            <Handle type="source" position={Position.Left} id={`${c.n}-sl`} className="!left-0 !opacity-0" />
            <Handle type="source" position={Position.Right} id={`${c.n}-sr`} className="!right-0 !opacity-0" />
            <Handle type="target" position={Position.Left} id={`${c.n}-tl`} className="!left-0 !opacity-0" />
            <Handle type="target" position={Position.Right} id={`${c.n}-tr`} className="!right-0 !opacity-0" />
          </div>
        ))}
      </div>
    </div>
  );
});

const nodeTypes = { table: TableNode };

/** Posiciones con dagre: tablas hijas a la izquierda, padres a la derecha. */
function autoLayout(model: ErModel, lineage: [string, string][]): Record<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 140, marginx: 20, marginy: 80 });
  g.setDefaultEdgeLabel(() => ({}));
  model.entities.forEach((e) => g.setNode(e.id, { width: WIDTH, height: heightOf(e.cols.length) }));
  model.relations.forEach((r) => g.setEdge(r.from, r.to));
  lineage.forEach(([from, to]) => g.setEdge(from, to));
  dagre.layout(g);
  return Object.fromEntries(model.entities.map((e) => {
    const n = g.node(e.id);
    return [e.id, { x: n.x - WIDTH / 2, y: n.y - heightOf(e.cols.length) / 2 }];
  }));
}

function Inner({ model, storageKey, lineage = [], height, initial: initialMode = 'auto' }: { model: ErModel; storageKey: string; lineage?: [string, string][]; height: number | string; initial?: 'auto' | 'model' }) {
  const { fitView } = useReactFlow();
  const [showLineage, setShowLineage] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const initial = useMemo<Node<TableData>[]>(() => {
    let saved: Record<string, { x: number; y: number }> | null = null;
    try { saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null'); } catch { saved = null; }
    // 'model': posiciones diseñadas a mano en model.ts (escaladas al tamaño real de las cajas).
    const designed = Object.fromEntries(model.entities.map((e) => [e.id, { x: e.x * 1.45, y: e.y * 1.6 }]));
    const pos = saved && model.entities.every((e) => saved![e.id]) ? saved : initialMode === 'model' ? designed : autoLayout(model, []);
    return model.entities.map((e) => ({
      id: e.id, type: 'table', position: pos[e.id],
      data: { title: e.title, cols: e.cols, agg: e.agg, dim: e.title.startsWith('dim_') },
    }));
  }, [model, storageKey, initialMode]);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<TableData>>(initial);

  // Guarda la disposición cada vez que el usuario suelta una tabla.
  useEffect(() => {
    const t = setTimeout(() => localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(nodes.map((n) => [n.id, n.position])))), 300);
    return () => clearTimeout(t);
  }, [nodes, storageKey]);

  const byId = useMemo(() => Object.fromEntries(nodes.map((n) => [n.id, n])), [nodes]);

  // Relaciones: cada una elige el lado (izquierda/derecha) según dónde quedaron las tablas.
  const edges = useMemo<Edge[]>(() => {
    const rel = model.relations.map((r, i): Edge => {
      const a = byId[r.from], b = byId[r.to];
      const aCenter = (a?.position.x ?? 0) + WIDTH / 2, bCenter = (b?.position.x ?? 0) + WIDTH / 2;
      const sameColumn = Math.abs(aCenter - bCenter) < WIDTH * 0.6;
      const goesRight = aCenter < bCenter;
      const sourceSide = sameColumn ? 'l' : goesRight ? 'r' : 'l';
      const targetSide = sameColumn ? 'l' : goesRight ? 'l' : 'r';
      const active = selected != null && (r.from === selected || r.to === selected);
      return ({
        id: `r${i}`, source: r.from, target: r.to, sourceHandle: `${r.fromCol}-s${sourceSide}`, targetHandle: `${r.toCol}-t${targetSide}`,
        type: 'smoothstep', pathOptions: { offset: sameColumn ? 36 : 20, borderRadius: 10 },
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: active ? 'var(--accent)' : 'var(--muted)' },
        label: active ? `${r.fromCol} → ${r.toCol}` : undefined,
        labelStyle: { fill: 'var(--foreground)', fontSize: 11 }, labelBgStyle: { fill: 'var(--overlay)' }, labelBgPadding: [6, 3], labelBgBorderRadius: 6,
        animated: active,
        style: { stroke: active ? 'var(--accent)' : 'var(--muted)', strokeWidth: active ? 2.5 : 1.5, opacity: selected && !active ? 0.15 : 1 },
        zIndex: active ? 10 : 0,
      }) as Edge;
    });
    const lin = showLineage ? lineage.map(([from, to], i): Edge => {
      const active = selected != null && (from === selected || to === selected);
      return {
        id: `l${i}`, source: from, target: to, sourceHandle: 'table-s', targetHandle: 'table-t', type: 'smoothstep',
        markerEnd: { type: MarkerType.ArrowClosed, color: '#a78bfa' },
        style: { stroke: '#a78bfa', strokeDasharray: '5 5', strokeWidth: active ? 2.2 : 1.2, opacity: selected && !active ? 0.1 : 0.75 },
      };
    }) : [];
    return [...rel, ...lin];
  }, [model.relations, lineage, showLineage, byId, selected]);

  // Resalta las tablas conectadas a la seleccionada y las columnas involucradas.
  const decorated = useMemo(() => {
    if (!selected) return nodes.map((n) => ({ ...n, data: { ...n.data, highlighted: false, faded: false, activeCols: [] } }));
    const related = new Set([selected]);
    const cols: Record<string, string[]> = {};
    model.relations.forEach((r) => {
      if (r.from === selected || r.to === selected) {
        related.add(r.from); related.add(r.to);
        (cols[r.from] ??= []).push(r.fromCol); (cols[r.to] ??= []).push(r.toCol);
      }
    });
    if (showLineage) lineage.forEach(([f, t]) => { if (f === selected || t === selected) { related.add(f); related.add(t); } });
    return nodes.map((n) => ({ ...n, data: { ...n.data, highlighted: related.has(n.id) && n.id !== selected, faded: !related.has(n.id), activeCols: cols[n.id] ?? [] } }));
  }, [nodes, selected, model.relations, lineage, showLineage]);

  const relayout = useCallback(() => {
    const pos = autoLayout(model, []);
    setNodes((ns) => ns.map((n) => ({ ...n, position: pos[n.id] })));
    setTimeout(() => fitView({ padding: 0.1, duration: 400 }), 50);
  }, [model, setNodes, fitView]);

  const resetDesigned = useCallback(() => {
    setNodes((ns) => ns.map((n) => ({ ...n, position: initial.find((i) => i.id === n.id)!.position })));
    setTimeout(() => fitView({ padding: 0.06, duration: 400 }), 50);
  }, [initial, setNodes, fitView]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" onPress={relayout}><Sparkles className="size-4" /> Ordenar automáticamente</Button>
        <Button size="sm" variant="ghost" onPress={() => { localStorage.removeItem(storageKey); resetDesigned(); }}><RotateCcw className="size-4" /> Restablecer</Button>
        {lineage.length > 0 && (
          <Button size="sm" variant={showLineage ? 'primary' : 'ghost'} onPress={() => setShowLineage((v) => !v)}><Waypoints className="size-4" /> Linaje de agregados</Button>
        )}
        <span className="ml-auto text-xs text-muted">Arrastra las tablas para ordenarlas · clic en una tabla para ver sus relaciones · la disposición se guarda en tu navegador</span>
      </div>
    <div style={{ height }} className="rounded-xl border border-border bg-background/40">
      <ReactFlow nodes={decorated} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange}
        onNodeClick={(_, n) => setSelected((s) => (s === n.id ? null : n.id))} onPaneClick={() => setSelected(null)}
        fitView fitViewOptions={{ padding: 0.06, maxZoom: 1.1 }} minZoom={0.2} maxZoom={2} nodesConnectable={false} proOptions={{ hideAttribution: true }}>
        <Background gap={22} size={1} color="var(--border)" />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap pannable zoomable nodeColor={(n) => ((n.data as TableData).agg ? '#a78bfa' : 'var(--surface-tertiary)')} maskColor="color-mix(in oklch, var(--background) 70%, transparent)" />
      </ReactFlow>
    </div>
    </div>
  );
}

export function ErDiagram(props: { model: ErModel; storageKey: string; lineage?: [string, string][]; height: number | string; initial?: 'auto' | 'model' }) {
  return <ReactFlowProvider><Inner {...props} /></ReactFlowProvider>;
}
