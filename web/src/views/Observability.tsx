// Pestaña 7 · Observabilidad: logs de CloudWatch de cada componente del pipeline,
// errores destacados y últimas ejecuciones de Step Functions y Glue.
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Spinner } from '@heroui/react';
import { AlertCircle, AlertTriangle, ChevronDown, ChevronRight, Pause, Play, RefreshCw, Search } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AwsIcon, Empty, PageHeader, StatusChip, type AwsService } from '@/components/common';
import { CodeButton } from '@/components/CodeViewer';
import { api, type LogEvent } from '@/lib/api';
import { cn, fmtTime } from '@/lib/utils';

const WINDOWS = [[15, '15 min'], [60, '1 hora'], [360, '6 horas'], [1440, '24 horas']] as const;
const STAGE_ORDER = ['api', 'plan', 'bronze', 'dependencies', 'silver', 'orchestration', 'gold', 'reset'];
const STAGE_LABEL: Record<string, string> = {
  api: 'API', plan: 'Orquestación', bronze: 'Bronze', dependencies: 'Dependencias', silver: 'Silver', orchestration: 'Orquestación', gold: 'Gold', reset: 'Mantenimiento',
};
const KIND_ICON: Record<string, AwsService> = { lambda: 'lambda', sfn: 'stepFunctions', glue: 'glue' };
// Código que corresponde a cada componente (para saltar del log al código).
const SOURCE_CODE: Record<string, string[]> = {
  api: ['backend/lambdas/api/handler.py'], plan: ['backend/lambdas/plan/handler.py'], bronze: ['backend/lambdas/bronze/handler.py'],
  dependencies: ['backend/lambdas/dependencies/handler.py', 'backend/common/control.py'], silver_pandas: ['backend/lambdas/silver_dimensions/handler.py'],
  finalize: ['backend/lambdas/finalize/handler.py'], gold: ['backend/lambdas/gold/handler.py'], reset: ['backend/lambdas/reset/handler.py'],
  glue: ['backend/glue/silver_facts.py'], sfn_datasets: ['infra/stacks/pipeline.py'], sfn_gold: ['infra/stacks/pipeline.py'],
};

const LEVEL_STYLE: Record<string, string> = {
  ERROR: 'border-l-danger bg-danger/10', WARN: 'border-l-warning bg-warning/5', INFO: 'border-l-transparent',
};

function LogLine({ e }: { e: LogEvent }) {
  const [open, setOpen] = useState(false);
  const pretty = useMemo(() => {
    const t = e.message.trim();
    if (!t.startsWith('{')) return null;
    try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return null; }
  }, [e.message]);
  const long = e.message.length > 220 || e.message.includes('\n') || pretty;
  return (
    <div className={cn('border-b border-separator border-l-4 px-3 py-1.5 font-mono text-[12px]', LEVEL_STYLE[e.level], e.platform && 'opacity-60')}>
      <button className="flex w-full items-start gap-3 text-left" onClick={() => long && setOpen((o) => !o)}>
        <span className="shrink-0 text-muted">{fmtTime(e.ts)}</span>
        <span className={cn('w-12 shrink-0 font-semibold', e.level === 'ERROR' ? 'text-danger' : e.level === 'WARN' ? 'text-warning' : 'text-muted')}>{e.level}</span>
        <span className={cn('min-w-0 flex-1', !open && 'truncate')}>{open ? null : e.message}</span>
        {long && (open ? <ChevronDown className="size-4 shrink-0 text-muted" /> : <ChevronRight className="size-4 shrink-0 text-muted" />)}
      </button>
      {open && <pre className="mt-1 whitespace-pre-wrap break-words pl-[150px]">{pretty ?? e.message}</pre>}
    </div>
  );
}

export default function Observability() {
  const [minutes, setMinutes] = useState(60);
  const [source, setSource] = useState('bronze');
  const [level, setLevel] = useState<'all' | 'warn' | 'error'>('all');
  const [search, setSearch] = useState('');
  const [needle, setNeedle] = useState('');
  const [live, setLive] = useState(true);
  const [hidePlatform, setHidePlatform] = useState(true);

  const summary = useQuery({ queryKey: ['logsSummary', minutes], queryFn: () => api.logsSummary(minutes), refetchInterval: live ? 20_000 : false });
  const logs = useQuery({ queryKey: ['logs', source, minutes, level, needle], queryFn: () => api.logs({ source, minutes, level, q: needle }), refetchInterval: live ? 10_000 : false });
  const runs = useQuery({ queryKey: ['runs'], queryFn: api.runs, refetchInterval: live ? 15_000 : false });

  const sources = useMemo(() => Object.entries(summary.data?.sources ?? {})
    .sort(([, a], [, b]) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage)), [summary.data]);
  const totalErrors = sources.reduce((a, [, s]) => a + s.ERROR, 0);
  const failedRuns = runs.data?.runs.filter((r) => ['FAILED', 'TIMED_OUT', 'ABORTED', 'ERROR'].includes(r.status)) ?? [];
  const events = (logs.data?.events ?? []).filter((e) => !(hidePlatform && e.platform));

  return (
    <div className="space-y-6">
      <PageHeader title="Observabilidad"
        subtitle="Todos los logs de CloudWatch de cada parte del pipeline (Lambdas, Step Functions y el job de Glue), con los errores resaltados, más las últimas ejecuciones y su causa de fallo.">
        <div className="flex rounded-lg bg-surface-secondary p-1">
          {WINDOWS.map(([v, l]) => <button key={v} onClick={() => setMinutes(v)} className={cn('rounded-md px-3 py-1.5 text-sm', minutes === v ? 'bg-surface font-medium shadow-sm' : 'text-muted')}>{l}</button>)}
        </div>
        <Button variant={live ? 'primary' : 'secondary'} onPress={() => setLive((v) => !v)}>{live ? <Pause className="size-4" /> : <Play className="size-4" />}{live ? 'En vivo' : 'Pausado'}</Button>
        <CodeButton label="Ver código" request={{ title: 'Observabilidad', files: ['backend/lambdas/observability/handler.py', 'infra/stacks/api.py'], highlight: 'def get_logs' }} />
      </PageHeader>

      <div className="grid gap-6 2xl:grid-cols-[360px_1fr]">
        <Card className="h-fit">
          <CardHeader><CardTitle>Componentes</CardTitle>
            <CardDescription>{totalErrors ? <span className="text-danger">{totalErrors} error(es) en la ventana</span> : 'Sin errores en la ventana'}</CardDescription></CardHeader>
          <CardContent className="space-y-1.5">
            {summary.isPending && <Spinner />}
            {sources.map(([id, s]) => (
              <button key={id} onClick={() => setSource(id)}
                className={cn('flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm transition-colors',
                  id === source ? 'border-accent bg-accent/10' : 'border-transparent hover:bg-surface-secondary')}>
                <AwsIcon name={KIND_ICON[s.kind] ?? 'lambda'} size={24} />
                <span className="min-w-0 flex-1"><span className="block truncate">{s.label}</span><span className="text-[11px] text-muted">{STAGE_LABEL[s.stage] ?? s.stage}</span></span>
                {s.ERROR > 0 && <span className="rounded-full bg-danger px-2 text-xs font-semibold text-danger-foreground">{s.ERROR}</span>}
                {s.WARN > 0 && <span className="rounded-full bg-warning/80 px-2 text-xs font-semibold text-warning-foreground">{s.WARN}</span>}
                {!s.ERROR && !s.WARN && <span className="text-[11px] text-muted">{s.INFO} líneas</span>}
              </button>
            ))}
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader className="flex-row flex-wrap items-center gap-3">
            <div className="flex-1"><CardTitle>{logs.data?.label ?? 'Logs'}</CardTitle>
              <CardDescription className="font-mono text-xs">{logs.data?.groups.join(' · ')}</CardDescription></div>
            {SOURCE_CODE[source] && <CodeButton label="Código de este componente" request={{ title: logs.data?.label ?? source, files: SOURCE_CODE[source] }} />}
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              {(['all', 'warn', 'error'] as const).map((l) => (
                <button key={l} onClick={() => setLevel(l)} className={cn('rounded-md border px-3 py-1 text-xs', level === l ? 'border-accent bg-accent/15' : 'border-border text-muted')}>
                  {l === 'all' ? 'Todo' : l === 'warn' ? 'Warnings y errores' : 'Solo errores'}
                </button>
              ))}
              <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); setNeedle(search); }}>
                <div className="flex items-center gap-1 rounded-md border border-border bg-field px-2"><Search className="size-3.5 text-muted" />
                  <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar texto…" className="w-56 bg-transparent py-1 text-xs outline-none" /></div>
              </form>
              <label className="flex items-center gap-1.5 text-xs text-muted"><input type="checkbox" checked={hidePlatform} onChange={(e) => setHidePlatform(e.target.checked)} />Ocultar START/END/REPORT</label>
              {logs.data && (
                <span className="ml-auto flex gap-3 text-xs">
                  <span className="text-danger">{logs.data.counts.ERROR} errores</span><span className="text-warning">{logs.data.counts.WARN} warnings</span>
                  <span className="text-muted">{logs.data.counts.INFO} info</span>
                  {logs.isFetching && <RefreshCw className="size-3.5 animate-spin text-muted" />}
                </span>
              )}
            </div>
            <div className="h-[clamp(420px,56vh,720px)] overflow-auto rounded-lg border border-border bg-background/60">
              {logs.isPending ? <div className="grid h-full place-items-center"><Spinner /></div>
                : logs.isError ? <p className="p-4 text-sm text-danger">{(logs.error as Error).message}</p>
                  : events.length ? events.map((e, i) => <LogLine key={`${e.ts}-${i}`} e={e} />)
                    : <div className="p-6"><Empty>Sin eventos en esta ventana. Ejecuta un pipeline en Operar y vuelve aquí.</Empty></div>}
            </div>
            {logs.data?.truncated && <p className="text-xs text-muted">Se muestran los 400 eventos más recientes.</p>}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex-row items-center gap-3">
          <AwsIcon name="stepFunctions" size={28} />
          <div className="flex-1"><CardTitle>Últimas ejecuciones</CardTitle>
            <CardDescription>{failedRuns.length ? <span className="flex items-center gap-1 text-danger"><AlertCircle className="size-4" />{failedRuns.length} con error</span> : 'Step Functions (datasets y Gold) y ejecuciones del job de Glue.'}</CardDescription></div>
        </CardHeader>
        <CardContent>
          {runs.isPending ? <Spinner /> : (
            <div className="max-h-[460px] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-surface text-xs uppercase text-muted"><tr>
                  <th className="px-3 py-2 text-left">Inicio</th><th className="px-3 py-2 text-left">Tipo</th><th className="px-3 py-2 text-left">Procesó</th>
                  <th className="px-3 py-2 text-left">Estado</th><th className="px-3 py-2 text-left">Duración</th><th className="px-3 py-2 text-left">Causa del error</th></tr></thead>
                <tbody>
                  {runs.data?.runs.map((r) => {
                    const dur = r.stoppedAt ? Math.round((+new Date(r.stoppedAt) - +new Date(r.startedAt)) / 1000) : null;
                    return (
                      <tr key={r.arn} className="border-t border-separator align-top">
                        <td className="whitespace-nowrap px-3 py-2 text-muted">{fmtTime(r.startedAt)}</td>
                        <td className="px-3 py-2"><span className="flex items-center gap-2"><AwsIcon name={r.kind === 'glue' ? 'glue' : 'stepFunctions'} size={18} />{r.kind === 'glue' ? 'Glue job' : r.kind === 'gold' ? 'Pipeline Gold' : 'Pipeline datasets'}</span></td>
                        <td className="max-w-80 px-3 py-2 font-mono text-xs">{r.input.join(' → ') || 'todos'}</td>
                        <td className="px-3 py-2"><StatusChip status={r.status} /></td>
                        <td className="px-3 py-2 tabular-nums text-muted">{dur != null ? `${dur} s` : '…'}</td>
                        <td className="max-w-[640px] px-3 py-2 text-xs">{r.error ? <span className="flex gap-1.5 text-danger"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" /><span className="line-clamp-3 break-words">{r.error}</span></span> : <span className="text-muted">—</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
