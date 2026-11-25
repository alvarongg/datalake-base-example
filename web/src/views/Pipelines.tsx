// Pestaña 3 · Pipelines: una ficha por etapa, con su flujo de servicios, pasos
// (cada paso abre el código exacto) y el estado actual de cada tabla.
import { useState } from 'react';
import { Background, MarkerType, ReactFlow, type Edge, type Node } from '@xyflow/react';
import { ChevronRight, Code2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/ui/table';
import { EngineNote, PageHeader, StatusChip } from '@/components/common';
import { CodeButton, useCode } from '@/components/CodeViewer';
import { flowNodeTypes } from '@/components/flow';
import { PIPELINES, type PipelineDef } from '@/lib/pipelines';
import { useLake } from '@/lib/hooks';
import type { LakeState } from '@/lib/api';
import { cn, fmtNum } from '@/lib/utils';

/** Estado agregado de cada ficha según /state. */
function pipelineState(p: PipelineDef, s?: LakeState): string | undefined {
  if (!s) return undefined;
  if (p.layer === 'orch') return s.mode === p.id ? (s.running ? 'running' : 'ok') : undefined;
  const ds = p.id === 'silver-glue' ? s.datasets.filter((d) => d.engine === 'glue') : p.id === 'silver-pandas' ? s.datasets.filter((d) => d.engine === 'pandas') : s.datasets;
  if (p.id === 'gold') {
    const st = s.gold.map((g) => g.run?.status);
    if (st.includes('failed') || st.includes('blocked')) return 'failed';
    if (st.includes('running')) return 'running';
    return s.gold.every((g) => g.status === 'ok') ? 'ok' : undefined;
  }
  const key = p.id === 'bronze' ? 'bronze' : p.id === 'deps' ? 'dependencies' : 'silver';
  const st = ds.map((d) => (d.run?.runStatus === 'SUCCEEDED' ? 'succeeded' : d.run?.stages?.[key]?.status));
  if (st.includes('failed')) return 'failed';
  if (st.includes('running')) return 'running';
  const done = p.id === 'bronze' ? ds.every((d) => ['bronze', 'stale', 'ok'].includes(d.status)) : ds.every((d) => d.status === 'ok');
  return done ? 'ok' : undefined;
}

function FlowStrip({ p }: { p: PipelineDef }) {
  const nodes: Node[] = p.flow.map(([icon, title, sub], i) => ({ id: `n${i}`, type: 'service', position: { x: i * 300, y: 0 }, data: { icon, title, subtitle: sub }, draggable: false }));
  const edges: Edge[] = p.flow.slice(1).map((_, i) => ({ id: `e${i}`, source: `n${i}`, target: `n${i + 1}`, sourceHandle: 's-Right', targetHandle: 't-Left', animated: true, markerEnd: { type: MarkerType.ArrowClosed } }));
  return (
    <div className="h-[110px] rounded-xl border border-border bg-background/40">
      <ReactFlow key={p.id} nodes={nodes} edges={edges} nodeTypes={flowNodeTypes} fitView fitViewOptions={{ padding: 0.1, maxZoom: 1 }} proOptions={{ hideAttribution: true }}
        panOnDrag={false} zoomOnScroll={false} zoomOnPinch={false} zoomOnDoubleClick={false} nodesConnectable={false} elementsSelectable={false}>
        <Background gap={20} size={1} color="var(--border)" />
      </ReactFlow>
    </div>
  );
}

const COMPARE: [string, string, string][] = [
  ['Qué lo dispara', 'Cada PUT en S3 (y cada paso al terminar)', 'Un horario (EventBridge cada 30 min) o un clic'],
  ['Latencia', 'Segundos desde que llega el archivo', 'Hasta 30 min (lo que falte para la próxima corrida)'],
  ['Orden de dependencias', 'Implícito: cada paso espera a sus padres (reintento cada 20 s)', 'Explícito: el plan ordena el lote antes de empezar'],
  ['Si algo no está listo', 'El evento espera en la DLQ de reintento (máx. 15 × 20 s)', 'El paso falla; la próxima corrida lo vuelve a intentar'],
  ['Errores', 'Mensaje a la DLQ final con el motivo; redrive desde la web', 'La ejecución queda FAILED con el paso y la causa en el diagrama'],
  ['Dónde se ve el estado', 'Repartido: feed de decisiones, colas, progreso por tabla', 'Centralizado: una ejecución de Step Functions por lote'],
  ['Concurrencia', 'Varias tablas en paralelo; locks por tabla con escrituras condicionales de S3', 'Un dataset a la vez dentro del lote (Map con concurrencia 1)'],
  ['Costo fijo', 'Long polling de SQS: centavos al mes aunque no lleguen archivos', 'Una ejecución cada 30 min: casi nada si no hay trabajo'],
  ['Cuándo conviene', 'Datos que llegan sueltos y se necesitan rápido', 'Cargas por lotes, cierres diarios, auditoría estricta'],
];

function Comparison() {
  const { data } = useLake();
  const strip = (id: 'event' | 'scheduled') => PIPELINES.find((x) => x.id === id)!;
  return (
    <Card>
      <CardHeader><CardTitle>Event-driven vs programado: dos arquitecturas, el mismo código</CardTitle>
        <CardDescription>Las capas (Bronze, Silver, Gold) son las mismas funciones. Lo único que cambia es QUIÉN decide cuándo corre cada una. Alterna el modo en Operar y compara.</CardDescription></CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-4 2xl:grid-cols-2">
          {(['event', 'scheduled'] as const).map((id) => (
            <div key={id} className={cn('space-y-2 rounded-xl border p-3', data?.mode === id ? 'border-accent' : 'border-border')}>
              <p className="flex items-center gap-2 text-sm font-semibold">{strip(id).title}{data?.mode === id && <StatusChip status="succeeded" label="Modo activo" />}</p>
              <FlowStrip p={strip(id)} />
            </div>
          ))}
        </div>
        <DataTable head={['', 'Event-driven (SQS + Lambda)', 'Programado (EventBridge + Step Functions)']}
          rows={COMPARE.map(([a, b, c]) => [<b key="a">{a}</b>, b, c])} />
      </CardContent>
    </Card>
  );
}

export default function Pipelines() {
  const [selected, setSelected] = useState(PIPELINES[0].id);
  const { data } = useLake();
  const { open } = useCode();
  const p = PIPELINES.find((x) => x.id === selected)!;
  const summary = data ? p.summary(data) : null;

  return (
    <div className="space-y-6">
      <PageHeader title="Pipelines"
        subtitle="Cada archivo dispara su propio pipeline: Bronze → compuerta de dependencias → Silver (Lambda o Glue) → Gold. Quién decide cuándo corre cada paso depende de la arquitectura: el despachador event-driven (SQS) o Step Functions programado. Haz clic en cualquier paso para ver el código que lo implementa.">
        <CodeButton label="Ver orquestación (Step Functions)" request={{ title: 'Orquestación con Step Functions (CDK)', files: ['infra/stacks/pipeline.py'], highlight: 'per_dataset = ' }} />
      </PageHeader>

      <Comparison />

      <div className="grid gap-6 xl:grid-cols-[320px_1fr]">
        <nav className="space-y-2" aria-label="Pipelines">
          {PIPELINES.map((x, i) => {
            const st = pipelineState(x, data);
            return (
              <button key={x.id} onClick={() => setSelected(x.id)}
                className={cn('flex w-full items-center gap-3 rounded-xl border bg-surface px-4 py-3 text-left transition-colors hover:bg-surface-secondary',
                  x.id === selected ? 'border-accent ring-1 ring-accent' : 'border-border')}>
                <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-surface-tertiary text-xs font-semibold">{i + 1}</span>
                <span className="min-w-0 flex-1"><span className="block truncate font-medium">{x.title}</span><span className="block truncate text-xs text-muted">{x.engine}</span></span>
                {st && <StatusChip status={st} />}
              </button>
            );
          })}
          <div className="pt-2"><EngineNote engine="lambda" /></div>
        </nav>

        <Card>
          <CardHeader className="flex-row flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1"><CardTitle className="text-xl">{p.title}</CardTitle><CardDescription>{p.engine}</CardDescription></div>
            {pipelineState(p, data) && <StatusChip status={pipelineState(p, data)!} />}
            <CodeButton label="Ver todo el código" request={{ title: p.title, files: p.files }} />
          </CardHeader>
          <CardContent className="space-y-5">
            <p className="max-w-5xl text-[15px]">{p.goal}</p>
            <FlowStrip p={p} />
            {p.engineKind === 'glue' && <EngineNote engine="glue" />}
            {p.engineKind === 'lambda' && <EngineNote engine="lambda" compact />}
            {p.layer === 'orch' && data && <p className="text-sm"><span className="text-muted">Modo activo ahora: </span><b>{data.mode === 'event' ? 'event-driven' : 'programado'}</b> (se cambia en Operar).</p>}

            <div className="grid gap-6 2xl:grid-cols-[3fr_2fr]">
              <div>
                <h4 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">Qué hace, paso a paso</h4>
                <ol className="space-y-2">
                  {p.steps.map((s, i) => (
                    <li key={i}>
                      <button disabled={!s.code} onClick={() => s.code && open({ title: `${p.title} · paso ${i + 1}`, description: s.text, files: [s.code.file, ...p.files.filter((f) => f !== s.code!.file)], highlight: s.code.highlight })}
                        className="group flex w-full items-start gap-3 rounded-lg border border-border bg-surface-secondary/40 px-3 py-2.5 text-left hover:border-accent hover:bg-surface-secondary">
                        <span className="grid size-6 shrink-0 place-items-center rounded-md bg-accent/20 text-xs font-semibold text-accent">{i + 1}</span>
                        <span className="flex-1 text-sm">{s.text}{s.code && <span className="mt-1 block font-mono text-[11px] text-muted">{s.code.file}</span>}</span>
                        {s.code && <span className="flex shrink-0 items-center gap-1 text-xs text-muted group-hover:text-accent"><Code2 className="size-4" /> código <ChevronRight className="size-3" /></span>}
                      </button>
                    </li>
                  ))}
                </ol>
              </div>
              <div className="space-y-4">
                <div><h4 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">Reglas y garantías</h4>
                  <ul className="list-disc space-y-1 pl-5 text-sm">{p.rules.map((r) => <li key={r}>{r}</li>)}</ul></div>
                <div><h4 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">¿Por qué este diseño?</h4><p className="text-sm text-muted">{p.why}</p></div>
                <div><h4 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">Archivos</h4>
                  <div className="flex flex-wrap gap-1.5">{p.files.map((f) => (
                    <button key={f} onClick={() => open({ title: f, files: [f] })} className="rounded-md border border-border px-2 py-1 font-mono text-[11px] text-muted hover:border-accent hover:text-foreground">{f}</button>
                  ))}</div></div>
              </div>
            </div>

            <div>
              <h4 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">Estado actual</h4>
              {summary && summary.rows.length
                ? <DataTable head={summary.head} rows={summary.rows.map((r) => r.map((v) => (typeof v === 'number' ? fmtNum(v) : v)))} />
                : <p className="text-sm text-muted">Aún no hay datos: procesa los archivos en la pestaña Operar.</p>}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
