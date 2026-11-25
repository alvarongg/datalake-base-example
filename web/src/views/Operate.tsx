// Pestaña 4 · Operar: elegir la arquitectura (event-driven o programada), subir archivos y
// ver, en vivo, qué etapa de qué tabla se está ejecutando, las colas y el almacenamiento.
import { createContext, memo, useCallback, useContext, useMemo, useRef, useState, type DragEvent } from 'react';
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import { useQuery } from '@tanstack/react-query';
import dagre from '@dagrejs/dagre';
import { Button, Spinner } from '@heroui/react';
import { AlertOctagon, ArchiveRestore, CalendarClock, Code2, FileUp, FileX, Hourglass, Play, PlayCircle, Redo2, RotateCcw, Trash2, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AwsIcon, EngineNote, PageHeader, StatusChip } from '@/components/common';
import { CodeButton, useCode } from '@/components/CodeViewer';
import { api, type DatasetState, type FeedEvent, type GoldState, type LakeState, type PipelineMode } from '@/lib/api';
import { useLake, useRefreshLake } from '@/lib/hooks';
import { goldSqlFile, silverCodeFor } from '@/lib/pipelines';
import { SOURCES } from '@/lib/sources';
import { cn, fmtBytes, fmtNum, fmtTime } from '@/lib/utils';

type Actions = {
  busy: boolean;
  mode: PipelineMode;
  runDataset: (name: string, mode: 'single' | 'with_dependencies') => void;
  restore: (dataset: string) => void;
  runGold: (models: string[]) => void;
  openCode: (title: string, files: string[], highlight?: string) => void;
};
const ActionsCtx = createContext<Actions>(null!);

const STAGES = [['bronze', 'Bronze'], ['dependencies', 'Dependencias'], ['silver', 'Silver']] as const;

/** Estado de cada una de las 3 etapas, mezclando la última ejecución con el estado persistido. */
function stageStates(d: DatasetState): string[] {
  const run = d.run;
  if (run && (run.runStatus === 'RUNNING' || run.runStatus === 'FAILED')) return STAGES.map(([k]) => run.stages[k]?.status ?? 'pending');
  const inBronze = ['bronze', 'stale', 'ok'].includes(d.status);
  const ok = d.status === 'ok';
  return [inBronze ? 'succeeded' : 'pending', ok ? 'succeeded' : 'pending', ok ? 'succeeded' : d.status === 'stale' ? 'stale' : 'pending'];
}

function headline(d: DatasetState): [string, string] {
  const run = d.run;
  if (run?.runStatus === 'RUNNING') {
    if (run.queued) return ['queued', 'En cola'];
    const waiting = STAGES.find(([k]) => run.stages[k]?.status === 'waiting');
    if (waiting) {
      const st = run.stages[waiting[0]];
      return ['waiting', `Esperando · intento ${st.attempt}/${st.maxAttempts}`];
    }
    const active = STAGES.find(([k]) => run.stages[k]?.status === 'running');
    return ['running', active ? `Procesando · ${active[1]}` : 'Procesando'];
  }
  if (run?.runStatus === 'FAILED') {
    const bad = STAGES.find(([k]) => run.stages[k]?.status === 'failed');
    return ['failed', `Falló en ${bad ? bad[1] : 'el pipeline'}`];
  }
  return [d.status, ''];
}

function nodeMessage(d: DatasetState): { text: string; tone: 'danger' | 'warning' | 'muted' } {
  const run = d.run;
  const stages = run ? STAGES.map(([k]) => run.stages[k]) : [];
  const failed = run?.runStatus === 'FAILED' ? stages.find((s) => s?.status === 'failed') : undefined;
  if (failed) {
    const bad = (failed.detail ?? []).filter((x) => x.status !== 'ok');
    return { text: bad.length ? bad.map((x) => `✖ ${x.dependency}: ${x.reason}`).join('\n') : failed.error ?? '', tone: 'danger' };
  }
  const waiting = run?.runStatus === 'RUNNING' ? stages.find((s) => s?.status === 'waiting') : undefined;
  if (waiting) {
    const lines = (waiting.detail ?? []).map((x) => `⏳ ${x.dependency}: ${x.reason}`);
    return { text: [waiting.reason, ...lines].filter(Boolean).join('\n'), tone: 'warning' };
  }
  if (d.status === 'no_file') return { text: `Falta: ${d.files.filter((f) => !f.uploaded).map((f) => f.name.replace('AdventureWorks_', '')).join(', ')}`, tone: 'muted' };
  if (d.status === 'stale') return { text: 'Archivo nuevo o una dependencia cambió: reprocesar.', tone: 'muted' };
  const bits = [d.rows.bronze != null && `Bronze ${fmtNum(d.rows.bronze)}`, d.rows.silver != null && `Silver ${fmtNum(d.rows.silver)} filas`];
  return { text: bits.filter(Boolean).join(' · '), tone: 'muted' };
}

const PILL: Record<string, string> = {
  succeeded: 'border-success/60 bg-success/15 text-success', running: 'border-accent bg-accent/20 text-accent pulse-ring',
  waiting: 'border-warning bg-warning/20 text-warning', failed: 'border-danger/70 bg-danger/15 text-danger',
  stale: 'border-warning/70 bg-warning/15 text-warning', pending: 'border-border text-muted',
};

const DatasetNode = memo(function DatasetNode({ data }: NodeProps & { data: { d: DatasetState } }) {
  const { d } = data;
  const a = useContext(ActionsCtx);
  const [cls, label] = headline(d);
  const msg = nodeMessage(d);
  const running = cls === 'running' || cls === 'queued';
  return (
    <div className={cn('w-[270px] rounded-xl border-2 bg-surface p-3 shadow-md',
      running ? 'border-accent bg-accent/5' : cls === 'waiting' ? 'border-warning bg-warning/5' : cls === 'failed' ? 'border-danger bg-danger/5'
        : d.status === 'ok' ? 'border-success/70' : d.status === 'stale' ? 'border-warning/80' : 'border-border',
      d.status === 'no_file' && !d.run && 'border-dashed opacity-80')}>
      <Handle type="target" position={Position.Left} className="!opacity-0" />
      <Handle type="source" position={Position.Right} className="!opacity-0" />
      <div className="flex items-center gap-2">
        <AwsIcon name={d.engine === 'glue' ? 'glue' : 'lambda'} size={26} />
        <p className="min-w-0 flex-1 break-all font-semibold leading-tight">{d.name}</p>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className={cn('rounded-full border px-2 py-0.5 text-[10px]', d.engine === 'glue' ? 'border-glue/60 text-glue' : 'border-pandas/60 text-pandas')}>
          {d.engine === 'glue' ? 'Glue · Spark' : 'Lambda · pandas'}</span>
        {running ? <span className="flex items-center gap-1.5 text-xs font-medium text-accent"><Spinner size="sm" color="current" />{label}</span>
          : cls === 'waiting' ? <span className="flex items-center gap-1.5 text-xs font-medium text-warning"><Hourglass className="size-3.5" />{label}</span>
            : cls === 'failed' ? <span className="text-xs font-medium text-danger">✖ {label}</span> : <StatusChip status={d.status} />}
      </div>
      <div className="mt-2 grid grid-cols-3 gap-1">
        {stageStates(d).map((st, i) => <span key={i} className={cn('rounded-md border px-1 py-0.5 text-center text-[10px]', PILL[st] ?? PILL.pending)}>{STAGES[i][1]}</span>)}
      </div>
      <p className="mt-2 text-[11px] text-muted">{d.dependsOn.length ? `Necesita: ${d.dependsOn.join(', ')}` : 'Sin dependencias'}</p>
      {msg.text && <p className={cn('mt-1 line-clamp-4 whitespace-pre-line text-[11px]', msg.tone === 'danger' ? 'text-danger' : msg.tone === 'warning' ? 'text-warning' : 'text-muted')}>{msg.text}</p>}
      <div className="nodrag mt-2 flex flex-wrap gap-1">
        {a.mode === 'event' ? (
          <Button size="sm" variant="secondary" isDisabled={a.busy} onPress={() => a.restore(d.name)}><ArchiveRestore className="size-3.5" />Reponer desde archive</Button>
        ) : (
          <>
            <Button size="sm" isDisabled={a.busy} onPress={() => a.runDataset(d.name, 'single')}><Play className="size-3.5" />Solo este</Button>
            {d.dependsOn.length > 0 && <Button size="sm" variant="secondary" isDisabled={a.busy} onPress={() => a.runDataset(d.name, 'with_dependencies')}><PlayCircle className="size-3.5" />Con dependencias</Button>}
          </>
        )}
        <Button size="sm" variant="ghost" isIconOnly aria-label="Ver código" onPress={() => a.openCode(`Pipeline de ${d.name}`,
          [a.mode === 'event' ? 'backend/lambdas/dispatcher/handler.py' : 'infra/stacks/pipeline.py', 'backend/lambdas/bronze/handler.py', ...silverCodeFor(d.engine)],
          a.mode === 'event' ? 'def on_silver' : 'per_dataset = ')}><Code2 className="size-4" /></Button>
      </div>
    </div>
  );
});

const GoldNode = memo(function GoldNode({ data }: NodeProps & { data: { g: GoldState } }) {
  const { g } = data;
  const a = useContext(ActionsCtx);
  const run = g.run;
  const running = run?.status === 'running' || (run?.status === 'pending' && run.active);
  const waiting = run?.status === 'waiting' && run.active;
  const failed = run?.status === 'failed' || run?.status === 'blocked';
  const sql = goldSqlFile(g.name, Object.keys(SOURCES));
  return (
    <div className={cn('w-[250px] rounded-xl border-2 bg-surface p-3 shadow-md',
      running ? 'border-accent bg-accent/5' : waiting ? 'border-warning bg-warning/5' : failed ? 'border-danger bg-danger/5'
        : g.status === 'ok' ? 'border-gold/80' : g.status === 'stale' ? 'border-warning/80' : 'border-dashed border-border')}>
      <Handle type="target" position={Position.Left} className="!opacity-0" />
      <Handle type="source" position={Position.Right} className="!opacity-0" />
      <div className="flex items-center gap-2"><AwsIcon name="athena" size={24} /><p className="min-w-0 flex-1 break-all font-semibold leading-tight">{g.name}</p></div>
      <div className="mt-2">
        {running ? <span className="flex items-center gap-1.5 text-xs font-medium text-accent"><Spinner size="sm" color="current" />{run?.status === 'running' ? 'Construyendo (CTAS)' : 'En cola'}</span>
          : waiting ? <span className="flex items-center gap-1.5 text-xs font-medium text-warning"><Hourglass className="size-3.5" />Esperando · intento {run?.attempt}/{run?.maxAttempts}</span>
            : failed ? <span className="text-xs font-medium text-danger">✖ {run?.status === 'blocked' ? 'Bloqueado por dependencias' : 'Falló'}</span>
              : <StatusChip status={g.status} />}
      </div>
      <p className="mt-2 text-[11px] text-muted">Lee {[g.silverDeps.length && `Silver: ${g.silverDeps.join(', ')}`, g.goldDeps.length && `Gold: ${g.goldDeps.join(', ')}`].filter(Boolean).join(' · ')}</p>
      {(failed || waiting) && <p className={cn('mt-1 line-clamp-3 whitespace-pre-line text-[11px]', failed ? 'text-danger' : 'text-warning')}>
        {run?.detail?.length ? run.detail.map((x) => `${failed ? '✖' : '⏳'} ${x.dependency}: ${x.reason}`).join('\n') : run?.error}</p>}
      <div className="nodrag mt-2 flex gap-1">
        {a.mode === 'scheduled' && <Button size="sm" variant="secondary" isDisabled={a.busy} onPress={() => a.runGold([g.name])}><Play className="size-3.5" />Construir</Button>}
        {a.mode === 'event' && <span className="self-center text-[11px] text-muted">Se construye solo cuando sus tablas están al día</span>}
        {sql && <Button size="sm" variant="ghost" isIconOnly aria-label="Ver SQL" onPress={() => a.openCode(`Modelo Gold · ${g.name}`, [sql, 'backend/lambdas/gold/handler.py'])}><Code2 className="size-4" /></Button>}
      </div>
    </div>
  );
});

const nodeTypes = { dataset: DatasetNode, gold: GoldNode };

function layout(ids: string[], edges: [string, string][], w: number, h: number) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 22, ranksep: 80, ranker: 'longest-path' });
  g.setDefaultEdgeLabel(() => ({}));
  ids.forEach((id) => g.setNode(id, { width: w, height: h }));
  edges.forEach(([a, b]) => g.setEdge(a, b));
  dagre.layout(g);
  return Object.fromEntries(ids.map((id) => [id, { x: g.node(id).x - w / 2, y: g.node(id).y - h / 2 }]));
}

function useGraphs(datasets: DatasetState[], gold: GoldState[]) {
  const dsKey = datasets.map((d) => d.name).join();
  const dsPos = useMemo(() => layout(datasets.map((d) => d.name), datasets.flatMap((d) => d.dependsOn.map((p) => [p, d.name] as [string, string])), 270, 250),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dsKey]);
  const goldKey = gold.map((g) => g.name).join();
  const goldPos = useMemo(() => layout(gold.map((g) => g.name), gold.flatMap((g) => g.goldDeps.map((p) => [p, g.name] as [string, string])), 250, 210),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [goldKey]);
  const byName = Object.fromEntries(datasets.map((d) => [d.name, d]));
  const goldByName = Object.fromEntries(gold.map((g) => [g.name, g]));

  const edgeStyle = (ok: boolean, active: boolean): Partial<Edge> => ({
    type: 'smoothstep', animated: active,
    markerEnd: { type: MarkerType.ArrowClosed, color: ok ? 'var(--success)' : 'var(--muted)' },
    style: { stroke: active ? 'var(--accent)' : ok ? 'var(--success)' : 'var(--muted)', strokeWidth: active ? 2.5 : 1.6, strokeDasharray: ok ? undefined : '5 5' },
  });

  const dsNodes: Node[] = datasets.map((d) => ({ id: d.name, type: 'dataset', position: dsPos[d.name], data: { d } }));
  const dsEdges: Edge[] = datasets.flatMap((d) => d.dependsOn.map((p) => ({
    id: `${p}->${d.name}`, source: p, target: d.name, ...edgeStyle(byName[p]?.status === 'ok', d.run?.runStatus === 'RUNNING' && !d.run.queued),
  })));
  const goldNodes: Node[] = gold.map((g) => ({ id: g.name, type: 'gold', position: goldPos[g.name], data: { g } }));
  const goldEdges: Edge[] = gold.flatMap((g) => g.goldDeps.map((p) => ({
    id: `${p}->${g.name}`, source: p, target: g.name, ...edgeStyle(goldByName[p]?.status === 'ok', g.run?.status === 'running'),
  })));
  return { dsNodes, dsEdges, goldNodes, goldEdges };
}

/* ---------------------------------------------------------------- modo */

function ModeSwitch({ state, onChange, pending }: { state: LakeState; onChange: (m: PipelineMode) => void; pending: boolean }) {
  const options: { id: PipelineMode; title: string; flow: string; icon: React.ReactNode; text: string }[] = [
    { id: 'event', title: 'Event-driven', flow: 'S3 PUT → SQS → Lambda despachador', icon: <Zap className="size-5" />,
      text: 'Cada archivo dispara su pipeline apenas llega. Si una dependencia no está lista, el evento espera 20 s en la DLQ de reintento y vuelve a probar.' },
    { id: 'scheduled', title: 'Programado', flow: `EventBridge cada ${state.schedule.everyMinutes} min → Step Functions`, icon: <CalendarClock className="size-5" />,
      text: 'Los archivos esperan en landing. El flujo se despierta en horario, arma un lote con todo lo nuevo y lo procesa en orden de dependencias.' },
  ];
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {options.map((o) => {
        const active = state.mode === o.id;
        return (
          <button key={o.id} disabled={active || pending} onClick={() => onChange(o.id)}
            className={cn('flex gap-4 rounded-2xl border-2 p-4 text-left transition-colors',
              active ? 'border-accent bg-accent/10' : 'border-border bg-surface hover:border-accent/60')}>
            <span className={cn('grid size-10 shrink-0 place-items-center rounded-xl', active ? 'bg-accent text-accent-foreground' : 'bg-surface-tertiary')}>{o.icon}</span>
            <span className="min-w-0">
              <span className="flex items-center gap-2 font-semibold">{o.title}{active && <StatusChip status="succeeded" label="Modo activo" />}
                {!active && <span className="text-xs font-normal text-accent">Cambiar a este modo</span>}</span>
              <span className="mt-0.5 block font-mono text-xs text-muted">{o.flow}</span>
              <span className="mt-1 block text-sm text-muted">{o.text}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

const LEVEL: Record<FeedEvent['level'], string> = {
  ok: 'text-success', info: 'text-muted', wait: 'text-warning', error: 'text-danger',
};
const LEVEL_ICON: Record<FeedEvent['level'], string> = { ok: '✔', info: '•', wait: '⏳', error: '✖' };

function QueueGauge({ icon, title, hint, q, tone }: { icon: 'sqs'; title: string; hint: string; q: { visible: number; inFlight: number; delayed: number }; tone: string }) {
  const total = q.visible + q.inFlight + q.delayed;
  return (
    <div className={cn('rounded-xl border bg-surface-secondary/50 p-3', total ? tone : 'border-border')}>
      <div className="flex items-center gap-2"><AwsIcon name={icon} size={22} /><p className="text-sm font-medium">{title}</p>
        <span className="ml-auto text-2xl font-semibold tabular-nums">{total}</span></div>
      <p className="mt-1 text-[11px] text-muted">{hint}</p>
      <p className="mt-1 text-[11px] tabular-nums text-muted">{q.visible} en cola · {q.inFlight} procesándose · {q.delayed} esperando su demora</p>
    </div>
  );
}

function EventPanel({ state, onAction }: { state: LakeState; onAction: () => void }) {
  const feed = useQuery({ queryKey: ['feed'], queryFn: api.events, refetchInterval: state.running ? 2500 : 15_000 });
  const absent = state.datasets.flatMap((d) => d.files).filter((f) => !f.uploaded).map((f) => f.name);
  const [file, setFile] = useState('');
  const target = absent.includes(file) ? file : absent[0];

  async function act(fn: () => Promise<unknown>, ok: string) {
    try { await fn(); toast.success(ok); onAction(); feed.refetch(); }
    catch (e) { toast.error((e as Error).message); }
  }

  return (
    <div className="grid gap-6 2xl:grid-cols-[1fr_1.4fr]">
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><AwsIcon name="sqs" size={24} /> Colas en vivo</CardTitle>
          <CardDescription>Así se ve la arquitectura event-driven por dentro: cada evento pasa por SQS y la Lambda despachador decide qué hacer.</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3 2xl:grid-cols-1">
            <QueueGauge icon="sqs" title="events" hint="PUT de S3, fin de Glue y 'siguiente paso'" q={state.queues.events} tone="border-accent" />
            <QueueGauge icon="sqs" title="retry-dlq (20 s)" hint="Condición no cumplida: vuelve a probar en 20 s (máx. 15 veces)" q={state.queues.retry} tone="border-warning" />
            <QueueGauge icon="sqs" title="dead-letter (DLQ final)" hint="Errores y reintentos agotados: requiere intervención" q={state.queues.dlq} tone="border-danger" />
          </div>
          <div className="space-y-2 rounded-xl border border-border p-3">
            <p className="text-sm font-medium">Probar la arquitectura</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onPress={() => act(() => api.restore('all'), 'Archivos repuestos: cada copia es un evento de S3')}>
                <ArchiveRestore className="size-4" /> Reponer todos desde archive/</Button>
              {state.queues.dlq.visible > 0 && (
                <Button size="sm" variant="secondary" onPress={() => act(api.redriveDlq, 'Mensajes reenviados de la DLQ final a events')}><Redo2 className="size-4" /> Reprocesar DLQ final</Button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select value={target ?? ''} onChange={(e) => setFile(e.target.value)} disabled={!absent.length}
                className="max-w-72 rounded-md border border-border bg-field px-2 py-1.5 text-xs text-field-foreground">
                {absent.map((f) => <option key={f} value={f}>{f}</option>)}
                {!absent.length && <option>Todos los archivos están en landing</option>}
              </select>
              <Button size="sm" variant="danger-soft" isDisabled={!target} onPress={() => act(() => api.simulateMissing(target!), 'Evento enviado: el despachador debe fallar')}>
                <FileX className="size-4" /> Simular evento sin archivo</Button>
            </div>
            <p className="text-[11px] text-muted">“Simular” manda a la cola un evento de S3 de un archivo que NO está en landing: es la condición principal, así que no se reintenta y va directo a la DLQ final.</p>
          </div>
          <CodeButton label="Ver el despachador" request={{ title: 'Despachador event-driven', files: ['backend/lambdas/dispatcher/handler.py', 'backend/common/events.py', 'infra/stacks/datalake.py'], highlight: 'class Dispatcher' }} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Decisiones del despachador</CardTitle>
          <CardDescription>Cada línea es un evento y lo que se decidió con él. Lo más reciente arriba.</CardDescription></CardHeader>
        <CardContent>
          <div className="h-[clamp(380px,46vh,560px)] overflow-auto rounded-lg border border-border bg-background/60 font-mono text-[12px]">
            {feed.isPending ? <div className="grid h-full place-items-center"><Spinner /></div>
              : !feed.data?.events.length ? <p className="p-4 text-sm text-muted">Sin eventos todavía. Sube un CSV o repón uno desde archive/.</p>
                : feed.data.events.map((e, i) => (
                  <div key={`${e.ts}-${i}`} className={cn('flex gap-3 border-b border-separator px-3 py-1.5', e.level === 'error' && 'bg-danger/10', e.level === 'wait' && 'bg-warning/5')}>
                    <span className="shrink-0 text-muted">{fmtTime(e.ts * 1000)}</span>
                    <span className={cn('w-4 shrink-0', LEVEL[e.level])}>{LEVEL_ICON[e.level]}</span>
                    <span className="w-14 shrink-0 text-muted">{e.kind}</span>
                    <span className="w-48 shrink-0 truncate font-semibold">{e.target}</span>
                    <span className={cn('min-w-0 flex-1', LEVEL[e.level] === 'text-muted' ? '' : LEVEL[e.level])}>{e.text}</span>
                  </div>
                ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ScheduledPanel({ state, actions }: { state: LakeState; actions: Actions & { runSchedule: () => void } }) {
  const last = state.schedule.lastRun;
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center gap-3">
        <div className="flex-1"><CardTitle className="flex items-center gap-2"><AwsIcon name="eventbridge" size={24} /> Ejecución programada</CardTitle>
          <CardDescription>EventBridge dispara el flujo <b>datalake-demo-scheduled</b> cada {state.schedule.everyMinutes} minutos: planifica, procesa los datasets con archivo nuevo (y sus hijos) en orden, y reconstruye solo los modelos Gold desactualizados.</CardDescription></div>
        <div className="flex flex-wrap gap-2">
          <Button isDisabled={actions.busy} onPress={actions.runSchedule}><CalendarClock className="size-4" /> Ejecutar la programación ahora</Button>
          <Button variant="secondary" isDisabled={actions.busy} onPress={() => actions.runDataset('all', 'with_dependencies')}><PlayCircle className="size-4" /> Procesar todo en orden</Button>
          <Button variant="secondary" isDisabled={actions.busy} onPress={() => actions.runGold([])}><Play className="size-4" /> Construir todo Gold</Button>
          <CodeButton label="Ver el flujo" request={{ title: 'Flujo programado (Step Functions)', files: ['infra/stacks/pipeline.py', 'backend/lambdas/schedule_plan/handler.py'], highlight: 'def _scheduled_flow' }} />
        </div>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-6 text-sm">
        <span><span className="text-muted">Última ejecución: </span>{last ? <>{fmtTime(last.startDate)} <StatusChip status={last.status} /></> : 'todavía ninguna'}</span>
        <span className="text-muted">Mientras tanto, los archivos que subas quedan en landing esperando la próxima corrida (el despachador ignora sus eventos).</span>
      </CardContent>
    </Card>
  );
}

/* --------------------------------------------------------- almacenamiento */

function Storage() {
  const q = useQuery({ queryKey: ['storage'], queryFn: api.storage, refetchInterval: 20_000 });
  return (
    <Card>
      <CardHeader className="flex-row items-center gap-3">
        <AwsIcon name="s3" size={28} />
        <div className="flex-1"><CardTitle>Almacenamiento por ruta</CardTitle>
          <CardDescription>Cantidad de archivos y peso de cada ruta de cada bucket. Fíjate en landing: <span className="font-mono">adventureworks/</span> es lo que falta procesar y <span className="font-mono">archive/</span> lo ya procesado, con la fecha en el nombre.</CardDescription></div>
        {q.isFetching && <Spinner size="sm" />}
      </CardHeader>
      <CardContent className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-5">
        {q.data?.buckets.map((b) => {
          const max = Math.max(1, ...b.prefixes.map((p) => p.bytes));
          return (
            <div key={b.label} className="rounded-xl border border-border bg-surface-secondary/40 p-3">
              <div className="flex items-baseline gap-2"><p className="font-semibold">{b.label}</p>
                <span className="ml-auto text-xs tabular-nums text-muted">{fmtNum(b.files)} archivos · {fmtBytes(b.bytes)}</span></div>
              <ul className="mt-2 space-y-1.5">
                {b.prefixes.filter((p) => p.depth <= 2).map((p) => (
                  <li key={p.prefix} style={{ paddingLeft: (p.depth - 1) * 14 }}>
                    <div className="flex items-center gap-2 text-xs">
                      <span className={cn('min-w-0 flex-1 truncate font-mono', p.prefix.startsWith('archive/') && 'text-gold')}>{p.prefix.split('/').slice(-2, -1)[0]}/</span>
                      <span className="tabular-nums text-muted">{fmtNum(p.files)}</span>
                      <span className="w-16 text-right tabular-nums">{fmtBytes(p.bytes)}</span>
                    </div>
                    <div className="mt-0.5 h-1 rounded-full bg-surface-tertiary"><div className="h-1 rounded-full bg-accent/70" style={{ width: `${(p.bytes / max) * 100}%` }} /></div>
                  </li>
                ))}
                {!b.prefixes.length && <li className="text-xs text-muted">Vacío</li>}
              </ul>
            </div>
          );
        })}
        {q.isPending && <Spinner />}
      </CardContent>
    </Card>
  );
}

/* ---------------------------------------------------------------- carga */

function Uploader({ datasets, onUploaded, mode }: { datasets: DatasetState[]; onUploaded: () => void; mode: PipelineMode }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);

  async function upload(files: File[]) {
    const csv = files.filter((f) => f.name.endsWith('.csv'));
    for (const [i, f] of csv.entries()) {
      setProgress(`Subiendo ${f.name} (${i + 1}/${csv.length})…`);
      try { await api.upload(f); } catch (e) { toast.error(`${f.name}: ${(e as Error).message}`); setProgress(null); return; }
    }
    setProgress(null);
    if (csv.length) toast.success(`${csv.length} archivo(s) en landing`, { description: mode === 'event' ? 'Cada PUT ya disparó su evento en SQS.' : 'Esperan a la próxima ejecución programada.' });
    onUploaded();
  }
  const onDrop = (e: DragEvent) => { e.preventDefault(); setOver(false); upload([...e.dataTransfer.files]); };
  const files = datasets.flatMap((d) => d.files.map((f) => ({ ...f, dataset: d.name, loaded: d.lastBronzeAt })));

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><AwsIcon name="s3" size={24} /> Paso 1 · Cargar archivos a landing</CardTitle>
        <CardDescription>Directo del navegador a S3 con URL prefirmada. {mode === 'event' ? 'En event-driven, cada archivo dispara su pipeline al instante.' : 'En modo programado, esperan a la próxima corrida.'}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <button onClick={() => input.current?.click()} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}
          className={cn('flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed px-4 py-6 text-sm text-muted transition-colors',
            over ? 'border-accent bg-accent/10 text-foreground' : 'border-border hover:border-accent')}>
          <FileUp className="size-7" />
          {progress ?? 'Arrastra los CSV de Adventure Works o haz clic para elegirlos'}
        </button>
        <input ref={input} type="file" accept=".csv" multiple hidden onChange={(e) => { upload([...(e.target.files ?? [])]); e.target.value = ''; }} />
        <ul className="max-h-[360px] space-y-1 overflow-auto pr-1 text-xs">
          {files.map((f) => (
            <li key={f.name} className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-surface-secondary">
              <span className={f.uploaded ? 'text-accent' : f.loaded ? 'text-success' : 'text-muted'}>{f.uploaded ? '⬆' : f.loaded ? '✔' : '○'}</span>
              <span className="flex-1 truncate font-mono">{f.name}</span>
              <span className="text-muted">{f.uploaded ? `en landing · ${fmtBytes(f.size)}` : f.loaded ? 'procesado → archive/' : 'falta'}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ vista */

export default function Operate() {
  const { data } = useLake();
  const refresh = useRefreshLake();
  const { open } = useCode();
  const [starting, setStarting] = useState(false);
  const [switching, setSwitching] = useState(false);
  const mode: PipelineMode = data?.mode ?? 'event';
  const busy = starting || (mode === 'scheduled' && !!data && Object.values(data.runningMachines).some(Boolean));

  const start = useCallback(async (fn: () => Promise<{ datasets?: string[]; models?: string[]; restored?: unknown[]; executionArn?: string }>, ok: (r: never) => string) => {
    setStarting(true);
    try {
      const r = await fn();
      toast.success(ok(r as never));
      await refresh();
    } catch (e) {
      const body = (e as { body?: { missingFiles?: string[] } }).body;
      toast.error((e as Error).message, body?.missingFiles ? { description: 'Sube esos archivos en el Paso 1 y vuelve a intentar.' } : undefined);
    } finally { setStarting(false); }
  }, [refresh]);

  const actions = useMemo(() => ({
    busy, mode,
    runDataset: (name: string, m: 'single' | 'with_dependencies') => start(() => api.startDatasets(name, m), (r: { datasets: string[] }) => `Pipeline iniciado: ${r.datasets.join(' → ')}`),
    runGold: (models: string[]) => start(() => api.startGold(models), (r: { models: string[] }) => `Construyendo Gold: ${r.models.length} modelo(s)`),
    restore: (ds: string) => start(() => api.restore(ds), (r: { restored: unknown[] }) => `${r.restored.length} archivo(s) repuestos en landing: su evento de S3 dispara el pipeline`),
    runSchedule: () => start(api.runSchedule, () => 'Flujo programado iniciado'),
    openCode: (title: string, files: string[], highlight?: string) => open({ title, files, highlight }),
  }), [busy, mode, start, open]);

  const graphs = useGraphs(data?.datasets ?? [], data?.gold ?? []);

  async function changeMode(m: PipelineMode) {
    const msg = m === 'event'
      ? 'Pasar a event-driven: el despachador procesará cada archivo al llegar. Los archivos que ya estén en landing se procesan ahora.'
      : 'Pasar a programado: los archivos esperarán en landing hasta la próxima ejecución programada (o la que lances a mano).';
    if (!confirm(msg)) return;
    setSwitching(true);
    try {
      const r = await api.setMode(m);
      toast.success(`Modo ${m === 'event' ? 'event-driven' : 'programado'} activo`, r.resentEvents.length ? { description: `${r.resentEvents.length} evento(s) re-emitidos` } : undefined);
      refresh();
    } catch (e) { toast.error((e as Error).message); } finally { setSwitching(false); }
  }

  async function reset(includeLanding: boolean) {
    const what = includeLanding ? 'TODO el lake, incluidos los CSV subidos y archive/' : 'Bronze, Silver y Gold (landing y archive/ se conservan)';
    if (!confirm(`Se borrará ${what}. No se puede deshacer. ¿Continuar?`)) return;
    try { await api.reset(includeLanding); toast.success('Lake vacío: puedes volver a procesar desde cero'); refresh(); }
    catch (e) { toast.error((e as Error).message); }
  }

  if (!data) return <div className="grid h-64 place-items-center"><Spinner /></div>;
  return (
    <ActionsCtx.Provider value={actions}>
      <div className="space-y-6">
        <PageHeader title="Operar el data lake"
          subtitle="Elige la arquitectura y mira cómo se comporta con los mismos datos. En event-driven, repón products sin sus tablas padre: Silver esperará con reintentos cada 20 s. En programado, nada corre hasta que llega el horario (o lo lanzas a mano)." />

        <ModeSwitch state={data} onChange={changeMode} pending={switching} />
        {mode === 'event' ? <EventPanel state={data} onAction={refresh} /> : <ScheduledPanel state={data} actions={actions} />}

        <div className="grid gap-6 2xl:grid-cols-[380px_1fr]">
          <Uploader datasets={data.datasets} onUploaded={refresh} mode={mode} />
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><AwsIcon name={mode === 'event' ? 'sqs' : 'stepFunctions'} size={24} /> Paso 2 · Silver: un pipeline por archivo</CardTitle>
              <CardDescription>Las flechas van de la tabla padre a la hija (verde = la padre está al día). Cada nodo muestra en vivo sus etapas: Bronze → Dependencias → Silver. Ámbar = esperando en la DLQ de reintento.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="h-[clamp(560px,66vh,820px)] rounded-xl border border-border bg-background/40">
                <ReactFlow nodes={graphs.dsNodes} edges={graphs.dsEdges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.06, maxZoom: 1 }}
                  nodesConnectable={false} minZoom={0.3} proOptions={{ hideAttribution: true }} zoomOnScroll={false} panOnScroll>
                  <Background gap={22} size={1} color="var(--border)" /><Controls showInteractive={false} position="bottom-right" />
                </ReactFlow>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-6 2xl:grid-cols-[1fr_380px]">
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2"><AwsIcon name="athena" size={24} /> Paso 3 · Gold: modelos SQL</CardTitle>
              <CardDescription>Cada modelo declara en su SQL qué tablas lee. {mode === 'event' ? 'En event-driven se construye solo cuando la última de sus tablas queda al día.' : 'Solo se construye si todas están al día; si no, falla antes de tocar nada.'}</CardDescription></CardHeader>
            <CardContent>
              <div className="h-[clamp(440px,50vh,640px)] rounded-xl border border-border bg-background/40">
                <ReactFlow nodes={graphs.goldNodes} edges={graphs.goldEdges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.06, maxZoom: 1 }}
                  nodesConnectable={false} minZoom={0.3} proOptions={{ hideAttribution: true }} zoomOnScroll={false} panOnScroll>
                  <Background gap={22} size={1} color="var(--border)" /><Controls showInteractive={false} position="bottom-right" />
                </ReactFlow>
              </div>
            </CardContent>
          </Card>
          <div className="space-y-6">
            <EngineNote engine="lambda" />
            <EngineNote engine="glue" />
            <Card className="border-danger/40">
              <CardHeader><CardTitle className="flex items-center gap-2"><Trash2 className="size-4 text-danger" /> Reiniciar</CardTitle>
                <CardDescription>Deja el lake vacío para demostrar el proceso desde cero. No se puede deshacer. Requiere colas vacías.</CardDescription></CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                <Button variant="danger-soft" isDisabled={busy} onPress={() => reset(false)}><RotateCcw className="size-4" /> Vaciar Bronze/Silver/Gold</Button>
                <Button variant="danger" isDisabled={busy} onPress={() => reset(true)}><AlertOctagon className="size-4" /> Vaciar TODO</Button>
              </CardContent>
            </Card>
          </div>
        </div>

        <Storage />
      </div>
    </ActionsCtx.Provider>
  );
}
