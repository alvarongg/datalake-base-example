// Pestaña "Buckets S3": cómo se ordenan las rutas dentro de cada bucket, qué contienen y,
// sobre todo, cómo los CSV viajan de landing/adventureworks/ a landing/archive/ cuando Bronze
// los procesa. También permite disparar un evento SIN archivo para ver el fallo.
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import { Button, Spinner } from '@heroui/react';
import { ArchiveRestore, ArrowRight, CheckCircle2, ChevronDown, ChevronRight, Circle, FileText, FileX, Folder, FolderOpen, Hourglass, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AwsIcon, PageHeader, StatusChip } from '@/components/common';
import { CodeButton } from '@/components/CodeViewer';
import { api, type DatasetState, type FeedEvent, type S3Object } from '@/lib/api';
import { useLake, useRefreshLake } from '@/lib/hooks';
import { cn, fmtBytes, fmtNum } from '@/lib/utils';

const PENDING_RE = /^adventureworks\/([^/]+\.csv)$/;
const ARCHIVE_RE = /^archive\/adventureworks\/(.+)__procesado_(\d{8}T\d{6}Z)\.(\w+)$/;

/** '20261125T130142Z' -> Date */
const parseTs = (ts: string) => new Date(`${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(9, 11)}:${ts.slice(11, 13)}:${ts.slice(13, 15)}Z`);

function ago(date: Date | string): string {
  const s = Math.max(0, Math.round((Date.now() - +new Date(date)) / 1000));
  if (s < 60) return `hace ${s} s`;
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  return `hace ${Math.round(s / 86400)} d`;
}

interface Archived { key: string; original: string; ts: string; date: Date; size: number }

function splitLanding(objects: S3Object[]) {
  const pending = new Map<string, S3Object>();
  const archived: Archived[] = [];
  for (const o of objects) {
    const p = o.key.match(PENDING_RE);
    if (p) { pending.set(p[1], o); continue; }
    const a = o.key.match(ARCHIVE_RE);
    if (a) archived.push({ key: o.key, original: `${a[1]}.${a[3]}`, ts: a[2], date: parseTs(a[2]), size: o.size });
  }
  archived.sort((x, y) => (x.ts < y.ts ? 1 : -1));
  return { pending, archived };
}

/** Nombre archivado con la marca de tiempo resaltada. */
function ArchivedName({ a }: { a: Archived }) {
  const stem = a.original.replace(/\.csv$/, '');
  return <span className="break-all font-mono text-[12px]">{stem}__procesado_<b className="rounded bg-gold/25 px-1 text-gold">{a.ts}</b>.csv</span>;
}

/* ------------------------------------------------- landing → archive en vivo */

function Movement({ objects, datasets, onRestore, busy }: { objects: S3Object[]; datasets: DatasetState[]; onRestore: (ds: string) => void; busy: boolean }) {
  const { pending, archived } = useMemo(() => splitLanding(objects), [objects]);
  const files = datasets.flatMap((d) => d.files.map((f) => ({ name: f.name, dataset: d }))).sort((a, b) => a.name.localeCompare(b.name));
  const latest = new Map<string, Archived>();
  const versions = new Map<string, number>();
  for (const a of archived) {
    if (!latest.has(a.original)) latest.set(a.original, a);
    versions.set(a.original, (versions.get(a.original) ?? 0) + 1);
  }

  const bronzeStatus = (d: DatasetState) => {
    const st = d.run?.runStatus === 'RUNNING' ? d.run.stages.bronze : undefined;
    if (st?.status === 'running') return { text: 'Bronze lo está leyendo…', cls: 'text-accent', icon: <Spinner size="sm" color="current" /> };
    if (st?.status === 'waiting') return { text: `Esperando el resto del dataset (intento ${st.attempt}/${st.maxAttempts})`, cls: 'text-warning', icon: <Hourglass className="size-3.5" /> };
    if (d.run?.runStatus === 'FAILED' && d.run.stages.bronze?.status === 'failed') return { text: 'Bronze falló', cls: 'text-danger', icon: <XCircle className="size-3.5" /> };
    return { text: 'Esperando al pipeline', cls: 'text-muted', icon: <Circle className="size-3.5" /> };
  };

  const card = 'rounded-xl border bg-surface p-3 shadow-sm';
  return (
    <LayoutGroup>
      <div className="grid gap-4 xl:grid-cols-[1fr_200px_1fr]">
        {/* Columna izquierda: lo que está en landing esperando */}
        <div className="rounded-2xl border border-landing/50 bg-landing/5 p-3">
          <div className="mb-3 flex items-center gap-2"><AwsIcon name="s3" size={22} />
            <p className="font-mono text-sm font-semibold">landing/adventureworks/</p>
            <span className="ml-auto text-xs text-muted">{pending.size} pendiente(s)</span></div>
          <div className="space-y-2">
            <AnimatePresence>
              {[...pending.entries()].map(([name, o]) => {
                const ds = files.find((f) => f.name === name)?.dataset;
                const st = ds ? bronzeStatus(ds) : null;
                return (
                  <motion.div key={name} layoutId={`file-${name}`} initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}
                    transition={{ type: 'spring', stiffness: 260, damping: 28 }} className={cn(card, 'border-landing/60')}>
                    <div className="flex items-center gap-2"><FileText className="size-4 text-landing" /><span className="min-w-0 flex-1 truncate font-mono text-[12px]">{name}</span>
                      <span className="text-[11px] text-muted">{fmtBytes(o.size)}</span></div>
                    <div className="mt-1 flex items-center gap-1.5 text-[11px]">
                      {st && <span className={cn('flex items-center gap-1', st.cls)}>{st.icon}{st.text}</span>}
                      <span className="ml-auto text-muted">llegó {ago(o.lastModified)}</span></div>
                  </motion.div>
                );
              })}
            </AnimatePresence>
            {!pending.size && <p className="rounded-xl border border-dashed border-border p-4 text-center text-sm text-muted">Vacío: no hay nada pendiente de procesar.</p>}
          </div>
        </div>

        {/* Columna central: la explicación del movimiento */}
        <div className="flex flex-col items-center justify-center gap-3 text-center">
          <AwsIcon name="lambda" size={40} />
          <p className="text-sm font-semibold">Bronze</p>
          <ArrowRight className="size-8 text-gold" />
          <p className="text-[12px] text-muted">Al terminar de cargar, mueve el CSV: <b className="text-foreground">copia</b> a archive/ con la fecha en el nombre (solo si el ETag no cambió) y <b className="text-foreground">borra</b> el original.</p>
          <p className="text-[11px] text-muted">archive/ no dispara eventos: la notificación de S3 solo escucha adventureworks/*.csv</p>
          <CodeButton label="Ver el código" request={{ title: 'Cómo se archiva un CSV', files: ['backend/lambdas/bronze/handler.py', 'backend/common/events.py', 'infra/stacks/datalake.py'], highlight: 'def archive_files' }} />
        </div>

        {/* Columna derecha: lo ya procesado */}
        <div className="rounded-2xl border border-gold/50 bg-gold/5 p-3">
          <div className="mb-3 flex items-center gap-2"><AwsIcon name="s3" size={22} />
            <p className="font-mono text-sm font-semibold">landing/archive/adventureworks/</p>
            <span className="ml-auto text-xs text-muted">{archived.length} versión(es)</span></div>
          <div className="space-y-2">
            {files.filter((f) => latest.has(f.name)).map(({ name, dataset }) => {
              const a = latest.get(name)!;
              const movedNow = !pending.has(name);  // si hay una versión nueva en landing, esta tarjeta no "es" el archivo actual
              return (
                <motion.div key={name} layoutId={movedNow ? `file-${name}` : undefined} transition={{ type: 'spring', stiffness: 260, damping: 28 }}
                  className={cn(card, 'border-gold/50', !movedNow && 'opacity-60')}>
                  <div className="flex items-start gap-2"><FileText className="mt-0.5 size-4 shrink-0 text-gold" /><ArchivedName a={a} /></div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
                    <span>procesado {ago(a.date)}</span><span>{fmtBytes(a.size)}</span>
                    {(versions.get(name) ?? 0) > 1 && <span className="text-gold">{versions.get(name)} versiones</span>}
                    {!movedNow && <span className="text-landing">versión anterior (hay una nueva en landing)</span>}
                    <button disabled={busy} onClick={() => onRestore(dataset.name)} className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-accent hover:bg-accent/10 disabled:opacity-40">
                      <ArchiveRestore className="size-3.5" /> Reponer en landing</button>
                  </div>
                </motion.div>
              );
            })}
            {!archived.length && <p className="rounded-xl border border-dashed border-border p-4 text-center text-sm text-muted">Todavía no se procesó ningún archivo.</p>}
          </div>
        </div>
      </div>
    </LayoutGroup>
  );
}

/* --------------------------------------------------- simular evento sin archivo */

type Track = { file: string; dataset: string; sentAt: number; dlqBefore: number };

function Simulator({ pendingNames, datasets }: { pendingNames: Set<string>; datasets: DatasetState[] }) {
  const { data: lake } = useLake();
  const refresh = useRefreshLake();
  const allFiles = datasets.flatMap((d) => d.files.map((f) => ({ file: f.name, dataset: d.name })));
  const candidates = allFiles.filter((f) => !pendingNames.has(f.file));
  const [file, setFile] = useState('');
  const chosen = candidates.find((c) => c.file === file) ?? candidates[0];
  const [track, setTrack] = useState<Track | null>(null);
  const [sending, setSending] = useState(false);
  const feed = useQuery({ queryKey: ['feed'], queryFn: api.events, refetchInterval: track ? 2000 : 15_000 });

  const errorEvent: FeedEvent | undefined = track
    ? feed.data?.events.find((e) => e.level === 'error' && e.target === track.dataset && e.ts >= track.sentAt - 2)
    : undefined;
  const received = track && feed.data?.events.some((e) => e.kind === 's3' && e.target.includes(track.file.slice(0, 26)) && e.ts >= track.sentAt - 2);
  const inDlq = track && lake && (lake.queues.dlq.visible > track.dlqBefore || (!!errorEvent && lake.queues.dlq.visible > 0));
  useEffect(() => { if (errorEvent) refresh(); }, [errorEvent, refresh]);

  async function simulate() {
    if (!chosen || !lake) return;
    setSending(true);
    try {
      await api.simulateMissing(chosen.file);
      setTrack({ file: chosen.file, dataset: chosen.dataset, sentAt: Date.now() / 1000, dlqBefore: lake.queues.dlq.visible });
      toast.info(`Evento de S3 enviado para ${chosen.file}, que no está en landing`);
    } catch (e) { toast.error((e as Error).message); } finally { setSending(false); }
  }

  const eventMode = lake?.mode === 'event';
  const Step = ({ ok, active, children }: { ok?: boolean; active?: boolean; children: React.ReactNode }) => (
    <li className="flex items-start gap-2 text-sm">
      {ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" /> : active ? <Spinner size="sm" className="mt-0.5" /> : <Circle className="mt-0.5 size-4 shrink-0 text-muted" />}
      <span className={cn(!ok && !active && 'text-muted')}>{children}</span>
    </li>
  );

  return (
    <Card className="border-danger/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><FileX className="size-5 text-danger" /> Simular un evento sin archivo</CardTitle>
        <CardDescription>Manda a la cola SQS un evento de S3 idéntico al real, pero de un archivo que NO está en landing. Es la condición principal: el despachador no reintenta, marca el error y manda el mensaje a la DLQ final.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!eventMode && <p className="rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm text-warning">Disponible solo en modo event-driven (en modo programado el despachador ignora los eventos). Cámbialo en la pestaña Operar.</p>}
        <div className="flex flex-wrap items-center gap-2">
          <select value={chosen?.file ?? ''} onChange={(e) => setFile(e.target.value)} disabled={!candidates.length}
            className="min-w-72 rounded-md border border-border bg-field px-3 py-2 text-sm text-field-foreground">
            {candidates.map((c) => <option key={c.file} value={c.file}>{c.file}</option>)}
            {!candidates.length && <option>Todos los archivos están en landing</option>}
          </select>
          <Button variant="danger" isDisabled={!eventMode || !chosen} isPending={sending} onPress={simulate}><FileX className="size-4" /> Simular evento sin archivo</Button>
        </div>
        {track && (
          <div className="rounded-xl border border-border bg-surface-secondary/40 p-4">
            <p className="mb-2 text-sm font-semibold">Seguimiento: {track.file}</p>
            <ol className="space-y-2">
              <Step ok>1 · Evento publicado en <span className="font-mono">datalake-demo-events</span> (mismo formato que la notificación de S3)</Step>
              <Step ok={!!received || !!errorEvent} active={!received && !errorEvent}>2 · El despachador lo recibe → pipeline de <b>{track.dataset}</b></Step>
              <Step ok={!!errorEvent} active={!!received && !errorEvent}>3 · Precheck de Bronze: el archivo no está en landing → <b className="text-danger">ERROR</b>, sin reintentos</Step>
              <Step ok={!!inDlq} active={!!errorEvent && !inDlq}>4 · Mensaje en la DLQ final <span className="font-mono">datalake-demo-dead-letter</span> ({lake?.queues.dlq.visible ?? 0} mensaje(s))</Step>
            </ol>
            {errorEvent && <p className="mt-3 rounded-lg bg-danger/10 p-3 font-mono text-[12px] text-danger">{errorEvent.text}</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              <CodeButton label="Ver la regla" request={{ title: 'Precheck de Bronze', files: ['backend/common/events.py', 'backend/lambdas/dispatcher/handler.py'], highlight: 'def bronze_precheck' }} />
              {errorEvent && <StatusChip status="failed" label={`${track.dataset}: Bronze falló`} />}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* --------------------------------------------------------- explorador de rutas */

interface TreeNode { name: string; path: string; folders: Map<string, TreeNode>; files: S3Object[]; count: number; bytes: number; last: string }

function buildTree(objects: S3Object[]): TreeNode {
  const root: TreeNode = { name: '', path: '', folders: new Map(), files: [], count: 0, bytes: 0, last: '' };
  for (const o of objects) {
    const parts = o.key.split('/');
    let node = root;
    const bump = (n: TreeNode) => { n.count += 1; n.bytes += o.size; if (o.lastModified > n.last) n.last = o.lastModified; };
    bump(node);
    for (const part of parts.slice(0, -1)) {
      if (!node.folders.has(part)) node.folders.set(part, { name: part, path: `${node.path}${part}/`, folders: new Map(), files: [], count: 0, bytes: 0, last: '' });
      node = node.folders.get(part)!;
      bump(node);
    }
    if (parts.at(-1)) node.files.push(o);
  }
  return root;
}

const BUCKET_HINT: Record<string, string> = {
  landing: 'adventureworks/ = lo que llegó y falta procesar · archive/ = lo ya procesado, con la fecha de procesamiento en el nombre.',
  bronze: 'Una carpeta por tabla con el dato crudo en Parquet (todo texto + _source_file e _ingested_at).',
  silver: 'Una carpeta por tabla, tipada y limpia. sales está particionada por order_year=AAAA (una carpeta por año).',
  gold: 'Una carpeta por modelo (CTAS de Athena). fact_sales particionada por order_year.',
  'athena-results': 'control/ (versiones y lineage), progress/ (estado para la web), locks/ (concurrencia) y query-results/ (resultados de Athena, expiran a los 7 días).',
};

function FolderRow({ node, depth, open, toggle, max }: { node: TreeNode; depth: number; open: Set<string>; toggle: (p: string) => void; max: number }) {
  const isOpen = open.has(node.path);
  const partition = node.name.includes('=');
  const archive = node.name === 'archive';
  return (
    <>
      <button onClick={() => toggle(node.path)} className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-surface-secondary" style={{ paddingLeft: 8 + depth * 18 }}>
        {isOpen ? <ChevronDown className="size-4 text-muted" /> : <ChevronRight className="size-4 text-muted" />}
        {isOpen ? <FolderOpen className={cn('size-4', archive ? 'text-gold' : 'text-landing')} /> : <Folder className={cn('size-4', archive ? 'text-gold' : 'text-landing')} />}
        <span className={cn('font-mono text-[13px]', archive && 'text-gold')}>{node.name}/</span>
        {partition && <span className="rounded-full border border-[#f0abfc]/60 px-1.5 text-[10px] text-[#f0abfc]">partición</span>}
        {archive && <span className="rounded-full border border-gold/60 px-1.5 text-[10px] text-gold">procesados</span>}
        <span className="ml-auto flex items-center gap-3 text-xs tabular-nums text-muted">
          <span className="hidden w-32 lg:block"><span className="block h-1.5 rounded-full bg-surface-tertiary"><span className="block h-1.5 rounded-full bg-accent/70" style={{ width: `${(node.bytes / max) * 100}%` }} /></span></span>
          <span className="w-20 text-right">{fmtNum(node.count)} archivo(s)</span><span className="w-20 text-right">{fmtBytes(node.bytes)}</span>
          <span className="hidden w-24 text-right xl:block">{node.last ? ago(node.last) : ''}</span>
        </span>
      </button>
      {isOpen && <TreeChildren node={node} depth={depth + 1} open={open} toggle={toggle} max={max} />}
    </>
  );
}

function TreeChildren({ node, depth, open, toggle, max }: { node: TreeNode; depth: number; open: Set<string>; toggle: (p: string) => void; max: number }) {
  const [showAll, setShowAll] = useState(false);
  const files = [...node.files].sort((a, b) => (a.lastModified < b.lastModified ? 1 : -1));
  const visible = showAll ? files : files.slice(0, 25);
  return (
    <>
      {[...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name)).map((f) => <FolderRow key={f.path} node={f} depth={depth} open={open} toggle={toggle} max={max} />)}
      {visible.map((o) => {
        const name = o.key.split('/').at(-1)!;
        const a = o.key.match(ARCHIVE_RE);
        return (
          <div key={o.key} className="flex items-center gap-2 px-2 py-0.5 text-[12px]" style={{ paddingLeft: 8 + depth * 18 + 22 }}>
            <FileText className={cn('size-3.5 shrink-0', a ? 'text-gold' : 'text-muted')} />
            <span className="min-w-0 flex-1 truncate font-mono">{a ? <ArchivedName a={{ key: o.key, original: `${a[1]}.${a[3]}`, ts: a[2], date: parseTs(a[2]), size: o.size }} /> : name}</span>
            <span className="w-20 text-right tabular-nums text-muted">{fmtBytes(o.size)}</span>
            <span className="hidden w-24 text-right text-muted xl:block">{ago(o.lastModified)}</span>
          </div>
        );
      })}
      {files.length > 25 && !showAll && (
        <button onClick={() => setShowAll(true)} className="px-2 py-1 text-xs text-accent" style={{ paddingLeft: 8 + depth * 18 + 22 }}>Ver los {files.length - 25} restantes</button>
      )}
    </>
  );
}

function Explorer({ selected, onSelect }: { selected: string; onSelect: (b: string) => void }) {
  const summary = useQuery({ queryKey: ['storage'], queryFn: api.storage, refetchInterval: 15_000 });
  const objects = useQuery({ queryKey: ['objects', selected], queryFn: () => api.objects(selected), refetchInterval: 5000 });
  const tree = useMemo(() => buildTree(objects.data?.objects ?? []), [objects.data]);
  const [open, setOpen] = useState<Set<string>>(new Set(['adventureworks/', 'archive/', 'archive/adventureworks/']));
  const toggle = (p: string) => setOpen((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; });
  const max = Math.max(1, ...[...tree.folders.values()].map((f) => f.bytes));

  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><AwsIcon name="s3" size={26} /> Rutas y contenido de cada bucket</CardTitle>
        <CardDescription>Un bucket por capa y, dentro, una carpeta por tabla. Haz clic en las carpetas para abrirlas. Se actualiza cada 5 s.</CardDescription></CardHeader>
      <CardContent className="grid gap-5 xl:grid-cols-[300px_1fr]">
        <div className="space-y-2">
          {(summary.data?.buckets ?? []).map((b) => (
            <button key={b.label} onClick={() => onSelect(b.label)}
              className={cn('flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors', b.label === selected ? 'border-accent bg-accent/10' : 'border-border hover:bg-surface-secondary')}>
              <AwsIcon name="s3" size={26} />
              <span className="min-w-0 flex-1"><span className="block font-semibold">{b.label}</span>
                <span className="block truncate font-mono text-[10px] text-muted">{b.bucket}</span></span>
              <span className="text-right text-xs tabular-nums"><span className="block">{fmtNum(b.files)}</span><span className="block text-muted">{fmtBytes(b.bytes)}</span></span>
            </button>
          ))}
          {summary.isPending && <Spinner />}
        </div>
        <div className="min-w-0 rounded-xl border border-border bg-background/50">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
            <span className="font-mono text-sm">s3://{objects.data?.name ?? '…'}/</span>
            {objects.isFetching && <Spinner size="sm" />}
            {objects.data?.truncated && <span className="text-xs text-warning">(se muestran los primeros 1000 objetos)</span>}
          </div>
          <p className="px-4 pt-2 text-xs text-muted">{BUCKET_HINT[selected]}</p>
          <div className="max-h-[clamp(420px,58vh,720px)] overflow-auto p-2">
            {objects.isPending ? <div className="grid h-40 place-items-center"><Spinner /></div>
              : !objects.data?.objects.length ? <p className="p-6 text-center text-sm text-muted">El bucket está vacío.</p>
                : <TreeChildren node={tree} depth={0} open={open} toggle={toggle} max={max} />}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------- vista */

export default function Buckets() {
  const { data: lake } = useLake();
  const refresh = useRefreshLake();
  const [selected, setSelected] = useState('landing');
  const [restoring, setRestoring] = useState(false);
  // landing se consulta seguido: es donde se ve el movimiento hacia archive/.
  const landing = useQuery({ queryKey: ['objects', 'landing'], queryFn: () => api.objects('landing'), refetchInterval: 2500 });
  const pendingNames = useMemo(() => new Set(splitLanding(landing.data?.objects ?? []).pending.keys()), [landing.data]);

  async function restore(ds: string) {
    setRestoring(true);
    try {
      const r = await api.restore(ds);
      toast.success(`${r.restored.length} archivo(s) repuestos en landing`, { description: lake?.mode === 'event' ? 'Mira cómo vuelven a moverse a archive/ cuando Bronze los procese.' : 'En modo programado esperan a la próxima ejecución.' });
      landing.refetch(); refresh();
    } catch (e) { toast.error((e as Error).message); } finally { setRestoring(false); }
  }

  if (!lake) return <div className="grid h-64 place-items-center"><Spinner /></div>;
  return (
    <div className="space-y-6">
      <PageHeader title="Buckets S3: rutas, contenido y movimiento a archive/"
        subtitle="Cada capa vive en su propio bucket y cada tabla en su propia carpeta. En landing, adventureworks/ es la bandeja de entrada y archive/ el histórico: cuando Bronze termina de cargar un CSV, lo mueve a archive/ con la fecha de procesamiento en el nombre.">
        <Button variant="secondary" isPending={restoring} onPress={() => restore('all')}><ArchiveRestore className="size-4" /> Reponer todos desde archive/</Button>
      </PageHeader>

      <Card>
        <CardHeader className="flex-row flex-wrap items-center gap-3">
          <div className="flex-1"><CardTitle>Landing → archive/ en vivo</CardTitle>
            <CardDescription>Cada tarjeta es un CSV. Cuando Bronze lo procesa, la tarjeta “viaja” de la izquierda a la derecha. Repón un dataset desde archive/ para verlo moverse (en modo {lake.mode === 'event' ? 'event-driven tarda segundos' : 'programado espera a la próxima ejecución'}).</CardDescription></div>
          <StatusChip status={lake.mode === 'event' ? 'succeeded' : 'pending'} label={lake.mode === 'event' ? 'Modo event-driven' : 'Modo programado'} />
        </CardHeader>
        <CardContent>
          {landing.isPending ? <div className="grid h-40 place-items-center"><Spinner /></div>
            : <Movement objects={landing.data?.objects ?? []} datasets={lake.datasets} onRestore={restore} busy={restoring} />}
        </CardContent>
      </Card>

      <div className="grid gap-6 2xl:grid-cols-[1fr_1fr]">
        <Simulator pendingNames={pendingNames} datasets={lake.datasets} />
        <History objects={landing.data?.objects ?? []} />
      </div>

      <Explorer selected={selected} onSelect={setSelected} />
    </div>
  );
}

function History({ objects }: { objects: S3Object[] }) {
  const { archived } = useMemo(() => splitLanding(objects), [objects]);
  return (
    <Card>
      <CardHeader><CardTitle>Historial de movimientos a archive/</CardTitle>
        <CardDescription>Lo más reciente arriba. La marca de tiempo del nombre es el momento en que Bronze procesó el archivo.</CardDescription></CardHeader>
      <CardContent>
        <div className="max-h-[420px] overflow-auto rounded-lg border border-border">
          {!archived.length ? <p className="p-4 text-sm text-muted">Sin movimientos todavía.</p> : archived.slice(0, 60).map((a) => (
            <div key={a.key} className="flex items-center gap-3 border-b border-separator px-3 py-1.5 text-[12px]">
              <span className="w-32 shrink-0 tabular-nums text-muted">{a.date.toLocaleString('es', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
              <span className="w-56 shrink-0 truncate font-mono">{a.original}</span>
              <ArrowRight className="size-3.5 shrink-0 text-gold" />
              <span className="min-w-0 flex-1"><ArchivedName a={a} /></span>
              <span className="w-16 shrink-0 text-right text-muted">{fmtBytes(a.size)}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
