// Pestaña 4 · Operar: subir archivos y ejecutar pipelines sobre un mapa React Flow
// que muestra, en vivo, qué etapa de qué tabla se está ejecutando.
import { createContext, memo, useCallback, useContext, useMemo, useRef, useState, type DragEvent } from 'react';
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import dagre from '@dagrejs/dagre';
import { Button, Spinner } from '@heroui/react';
import { Code2, FileUp, Play, PlayCircle, RotateCcw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AwsIcon, EngineNote, PageHeader, StatusChip } from '@/components/common';
import { useCode } from '@/components/CodeViewer';
import { api, type DatasetState, type GoldState } from '@/lib/api';
import { useLake, useRefreshLake } from '@/lib/hooks';
import { goldSqlFile, silverCodeFor } from '@/lib/pipelines';
import { SOURCES } from '@/lib/sources';
import { cn, fmtBytes, fmtNum } from '@/lib/utils';

type Actions = {
  busy: boolean;
  runDataset: (name: string, mode: 'single' | 'with_dependencies') => void;
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
    const active = STAGES.find(([k]) => run.stages[k]?.status === 'running');
    return ['running', active ? `Procesando · ${active[1]}` : 'Procesando'];
  }
  if (run?.runStatus === 'FAILED') {
    const bad = STAGES.find(([k]) => run.stages[k]?.status === 'failed');
    return ['failed', `Falló en ${bad ? bad[1] : 'el pipeline'}`];
  }
  return [d.status, ''];
}

function failureMessage(d: DatasetState): string | null {
  if (d.run?.runStatus !== 'FAILED') return null;
  const failed = STAGES.map(([k]) => d.run!.stages[k]).find((s) => s?.status === 'failed');
  const bad = (failed?.detail ?? []).filter((x) => x.status !== 'ok');
  return bad.length ? bad.map((x) => `✖ ${x.dependency}: ${x.reason}`).join('\n') : failed?.error ?? null;
}

const PILL: Record<string, string> = {
  succeeded: 'border-success/60 bg-success/15 text-success', running: 'border-accent bg-accent/20 text-accent pulse-ring',
  failed: 'border-danger/70 bg-danger/15 text-danger', stale: 'border-warning/70 bg-warning/15 text-warning', pending: 'border-border text-muted',
};

const DatasetNode = memo(function DatasetNode({ data }: NodeProps & { data: { d: DatasetState } }) {
  const { d } = data;
  const a = useContext(ActionsCtx);
  const [cls, label] = headline(d);
  const msg = failureMessage(d);
  const running = cls === 'running' || cls === 'queued';
  return (
    <div className={cn('w-[270px] rounded-xl border-2 bg-surface p-3 shadow-md',
      running ? 'border-accent bg-accent/5' : cls === 'failed' ? 'border-danger bg-danger/5' : d.status === 'ok' ? 'border-success/70' : d.status === 'stale' ? 'border-warning/80' : 'border-border',
      d.status === 'no_file' && 'border-dashed opacity-80')}>
      <Handle type="target" position={Position.Left} className="!opacity-0" />
      <Handle type="source" position={Position.Right} className="!opacity-0" />
      <div className="flex items-center gap-2">
        <AwsIcon name={d.engine === 'glue' ? 'glue' : 'lambda'} size={26} />
        <p className="min-w-0 flex-1 break-all font-semibold leading-tight">{d.name}</p>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <span className={cn('rounded-full border px-2 py-0.5 text-[10px]', d.engine === 'glue' ? 'border-glue/60 text-glue' : 'border-pandas/60 text-pandas')}>
          {d.engine === 'glue' ? 'Glue · Spark' : 'Lambda · pandas'}</span>
        {running ? <span className="flex items-center gap-1.5 text-xs font-medium text-accent"><Spinner size="sm" color="current" />{label}</span>
          : cls === 'failed' ? <span className="text-xs font-medium text-danger">✖ {label}</span> : <StatusChip status={d.status} />}
      </div>
      <div className="mt-2 grid grid-cols-3 gap-1">
        {stageStates(d).map((st, i) => <span key={i} className={cn('rounded-md border px-1 py-0.5 text-center text-[10px]', PILL[st] ?? PILL.pending)}>{STAGES[i][1]}</span>)}
      </div>
      <p className="mt-2 text-[11px] text-muted">{d.dependsOn.length ? `Necesita: ${d.dependsOn.join(', ')}` : 'Sin dependencias'}</p>
      {msg ? <p className="mt-1 whitespace-pre-line text-[11px] text-danger">{msg}</p> : (
        <p className="mt-1 text-[11px] text-muted">
          {d.status === 'no_file' ? `Falta: ${d.files.filter((f) => !f.uploaded).map((f) => f.name.replace('AdventureWorks_', '')).join(', ')}`
            : d.status === 'stale' ? 'Archivo nuevo o una dependencia cambió: reprocesar.'
              : [d.rows.bronze != null && `Bronze ${fmtNum(d.rows.bronze)}`, d.rows.silver != null && `Silver ${fmtNum(d.rows.silver)} filas`].filter(Boolean).join(' · ')}
        </p>
      )}
      <div className="nodrag mt-2 flex flex-wrap gap-1">
        <Button size="sm" isDisabled={a.busy} onPress={() => a.runDataset(d.name, 'single')}><Play className="size-3.5" />Solo este</Button>
        {d.dependsOn.length > 0 && <Button size="sm" variant="secondary" isDisabled={a.busy} onPress={() => a.runDataset(d.name, 'with_dependencies')}><PlayCircle className="size-3.5" />Con dependencias</Button>}
        <Button size="sm" variant="ghost" isIconOnly aria-label="Ver código" onPress={() => a.openCode(`Pipeline de ${d.name}`, ['backend/lambdas/bronze/handler.py', 'backend/lambdas/dependencies/handler.py', ...silverCodeFor(d.engine)],
          'def lambda_handler')}><Code2 className="size-4" /></Button>
      </div>
    </div>
  );
});

const GoldNode = memo(function GoldNode({ data }: NodeProps & { data: { g: GoldState } }) {
  const { g } = data;
  const a = useContext(ActionsCtx);
  const run = g.run;
  const running = run?.status === 'running' || (run?.status === 'pending' && run.active);
  const failed = run?.status === 'failed' || run?.status === 'blocked';
  const sql = goldSqlFile(g.name, Object.keys(SOURCES));
  return (
    <div className={cn('w-[250px] rounded-xl border-2 bg-surface p-3 shadow-md',
      running ? 'border-accent bg-accent/5' : failed ? 'border-danger bg-danger/5' : g.status === 'ok' ? 'border-gold/80' : g.status === 'stale' ? 'border-warning/80' : 'border-dashed border-border')}>
      <Handle type="target" position={Position.Left} className="!opacity-0" />
      <Handle type="source" position={Position.Right} className="!opacity-0" />
      <div className="flex items-center gap-2"><AwsIcon name="athena" size={24} /><p className="min-w-0 flex-1 break-all font-semibold leading-tight">{g.name}</p></div>
      <div className="mt-2">
        {running ? <span className="flex items-center gap-1.5 text-xs font-medium text-accent"><Spinner size="sm" color="current" />{run?.status === 'running' ? 'Construyendo (CTAS)' : 'En cola'}</span>
          : failed ? <span className="text-xs font-medium text-danger">✖ {run?.status === 'blocked' ? 'Bloqueado por dependencias' : 'Falló'}</span>
            : <StatusChip status={g.status} />}
      </div>
      <p className="mt-2 text-[11px] text-muted">Lee {[g.silverDeps.length && `Silver: ${g.silverDeps.join(', ')}`, g.goldDeps.length && `Gold: ${g.goldDeps.join(', ')}`].filter(Boolean).join(' · ')}</p>
      {failed && <p className="mt-1 whitespace-pre-line text-[11px] text-danger">{run?.detail?.length ? run.detail.map((x) => `✖ ${x.dependency}: ${x.reason}`).join('\n') : run?.error}</p>}
      <div className="nodrag mt-2 flex gap-1">
        <Button size="sm" variant="secondary" isDisabled={a.busy} onPress={() => a.runGold([g.name])}><Play className="size-3.5" />Construir</Button>
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
  const dsPos = useMemo(() => layout(datasets.map((d) => d.name), datasets.flatMap((d) => d.dependsOn.map((p) => [p, d.name] as [string, string])), 270, 232),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dsKey]);
  const goldKey = gold.map((g) => g.name).join();
  const goldPos = useMemo(() => layout(gold.map((g) => g.name), gold.flatMap((g) => g.goldDeps.map((p) => [p, g.name] as [string, string])), 250, 200),
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

function Uploader({ datasets, onUploaded }: { datasets: DatasetState[]; onUploaded: () => void }) {
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
    if (csv.length) toast.success(`${csv.length} archivo(s) en el bucket landing`);
    onUploaded();
  }
  const onDrop = (e: DragEvent) => { e.preventDefault(); setOver(false); upload([...e.dataTransfer.files]); };
  const files = datasets.flatMap((d) => d.files.map((f) => ({ ...f, dataset: d.name })));

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><AwsIcon name="s3" size={24} /> Paso 1 · Cargar archivos a landing</CardTitle>
        <CardDescription>Los archivos viajan directo del navegador a S3 con una URL prefirmada: ni la API ni Lambda los ven pasar. Sube uno o los 10.</CardDescription>
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
              <span className={f.uploaded ? 'text-success' : 'text-muted'}>{f.uploaded ? '✔' : '○'}</span>
              <span className="flex-1 truncate font-mono">{f.name}</span>
              <span className="text-muted">{f.uploaded ? fmtBytes(f.size) : 'falta'}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export default function Operate() {
  const { data } = useLake();
  const refresh = useRefreshLake();
  const { open } = useCode();
  const [starting, setStarting] = useState(false);
  const busy = starting || !!data?.running;

  const start = useCallback(async (fn: () => Promise<{ datasets?: string[]; models?: string[] }>) => {
    setStarting(true);
    try {
      const r = await fn();
      toast.success(r.datasets ? `Pipeline iniciado: ${r.datasets.join(' → ')}` : `Construyendo Gold: ${r.models?.length} modelo(s)`);
      await refresh();
    } catch (e) {
      const body = (e as { body?: { missingFiles?: string[] } }).body;
      toast.error((e as Error).message, body?.missingFiles ? { description: 'Sube esos archivos en el Paso 1 y vuelve a intentar.' } : undefined);
    } finally { setStarting(false); }
  }, [refresh]);

  const actions = useMemo<Actions>(() => ({
    busy,
    runDataset: (name, mode) => start(() => api.startDatasets(name, mode)),
    runGold: (models) => start(() => api.startGold(models)),
    openCode: (title, files, highlight) => open({ title, files, highlight }),
  }), [busy, start, open]);

  const graphs = useGraphs(data?.datasets ?? [], data?.gold ?? []);

  async function reset(includeLanding: boolean) {
    const what = includeLanding ? 'TODO el lake, incluidos los CSV subidos' : 'Bronze, Silver y Gold (los CSV se conservan)';
    if (!confirm(`Se borrará ${what}. No se puede deshacer. ¿Continuar?`)) return;
    try { await api.reset(includeLanding); toast.success('Lake vacío: puedes volver a procesar desde cero'); refresh(); }
    catch (e) { toast.error((e as Error).message); }
  }

  if (!data) return <div className="grid h-64 place-items-center"><Spinner /></div>;
  return (
    <ActionsCtx.Provider value={actions}>
      <div className="space-y-6">
        <PageHeader title="Operar el data lake"
          subtitle="Cada archivo dispara su propio pipeline. Prueba procesar products con “Solo este” sin haber procesado product_subcategories: fallará en la compuerta de dependencias. Después usa “Con dependencias” y mira cómo se ejecutan en orden.">
          <Button isDisabled={busy} onPress={() => actions.runDataset('all', 'with_dependencies')}><PlayCircle className="size-4" /> Procesar todo en orden</Button>
          <Button variant="secondary" isDisabled={busy} onPress={() => actions.runGold([])}><Play className="size-4" /> Construir todo Gold</Button>
        </PageHeader>

        <div className="grid gap-6 2xl:grid-cols-[380px_1fr]">
          <Uploader datasets={data.datasets} onUploaded={refresh} />
          <Card>
            <CardHeader className="flex-row items-center gap-3">
              <div className="flex-1"><CardTitle className="flex items-center gap-2"><AwsIcon name="stepFunctions" size={24} /> Paso 2 · Silver: un pipeline por archivo</CardTitle>
                <CardDescription>Las flechas van de la tabla padre a la hija (verde = la padre está al día). Cada nodo muestra en vivo sus etapas: Bronze → Dependencias → Silver.</CardDescription></div>
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
              <CardDescription>Cada modelo declara en su SQL qué tablas lee. Solo se construye si todas están al día; si no, el pipeline falla antes de tocar nada.</CardDescription></CardHeader>
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
                <CardDescription>Deja el lake vacío para demostrar el proceso desde cero. No se puede deshacer.</CardDescription></CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                <Button variant="danger-soft" isDisabled={busy} onPress={() => reset(false)}><RotateCcw className="size-4" /> Vaciar Bronze/Silver/Gold</Button>
                <Button variant="danger" isDisabled={busy} onPress={() => reset(true)}><Trash2 className="size-4" /> Vaciar TODO</Button>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </ActionsCtx.Provider>
  );
}
