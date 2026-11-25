// Pestaña 6 · Costos: estimación casi en tiempo real del gasto de cada servicio.
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Spinner } from '@heroui/react';
import { AlertTriangle, Info, RefreshCw } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/ui/table';
import { AwsIcon, Kpi, PageHeader, type AwsService } from '@/components/common';
import { CodeButton } from '@/components/CodeViewer';
import { DonutChart, StackedArea } from '@/charts/charts';
import { api, type CostService } from '@/lib/api';
import { fmtNum, fmtTime, usd } from '@/lib/utils';

const RANGES = [['24h', 'Últimas 24 h'], ['7d', 'Últimos 7 días'], ['30d', 'Últimos 30 días']] as const;
const ICON: Record<string, AwsService | undefined> = {
  lambda: 'lambda', glue: 'glue', athena: 'athena', stepfunctions: 'stepFunctions', s3: 's3', apigateway: 'apiGateway', cloudfront: 'cloudfront', cognito: 'cognito', sqs: 'sqs', eventbridge: 'eventbridge', logs: 'cloudwatch',
};
const DETAIL_COLS: Record<string, [string, string][]> = {
  lambda: [['label', 'Función'], ['invocations', 'Invocaciones'], ['durationSeconds', 'Segundos'], ['memoryMb', 'Memoria (MB)'], ['cost', 'Costo']],
  glue: [['label', 'Dataset'], ['state', 'Estado'], ['seconds', 'Segundos'], ['dpuSeconds', 'DPU-s'], ['cost', 'Costo']],
  stepfunctions: [['label', 'Flujo'], ['executions', 'Ejecuciones'], ['transitions', 'Transiciones'], ['cost', 'Costo']],
  s3: [['label', 'Bucket'], ['objects', 'Objetos'], ['megabytes', 'MB'], ['monthlyCost', 'Costo/mes']],
};

function ServiceCard({ s, share }: { s: CostService; share: number }) {
  const cols = DETAIL_COLS[s.id];
  return (
    <Card>
      <CardHeader className="flex-row items-center gap-3">
        {ICON[s.id] && <AwsIcon name={ICON[s.id]!} size={32} />}
        <div className="flex-1"><CardTitle>{s.label}</CardTitle><CardDescription>{(share * 100).toFixed(1)}% del total</CardDescription></div>
        <p className="text-xl font-semibold tabular-nums">{usd(s.cost)}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {s.error && <p className="flex items-center gap-2 text-sm text-warning"><AlertTriangle className="size-4" /> No se pudo leer: {s.error}</p>}
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          {s.usage.map((u) => <span key={u.label}><span className="text-muted">{u.label}: </span><b className="tabular-nums">{u.unit === 'USD' ? usd(u.value) : `${fmtNum(u.value)} ${u.unit}`}</b></span>)}
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-surface-tertiary"><div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(1, share * 100)}%` }} /></div>
        {s.note && <p className="flex gap-2 text-xs text-muted"><Info className="mt-0.5 size-3.5 shrink-0" />{s.note}</p>}
        {cols && s.details.length > 0 && (
          <details><summary className="cursor-pointer text-xs text-muted">Detalle ({s.details.length})</summary>
            <div className="mt-2 max-h-64 overflow-auto">
              <DataTable head={cols.map(([, l]) => l)} rows={s.details.map((d) => cols.map(([k]) => (k === 'cost' || k === 'monthlyCost' ? usd(Number(d[k])) : typeof d[k] === 'number' ? fmtNum(d[k]) : d[k])))} />
            </div></details>
        )}
      </CardContent>
    </Card>
  );
}

export default function Costs() {
  const [range, setRange] = useState<'24h' | '7d' | '30d'>('24h');
  // "Tiempo real": se vuelve a calcular cada 60 s mientras la pestaña está abierta.
  const q = useQuery({ queryKey: ['costs', range], queryFn: () => api.costs(range), refetchInterval: 60_000 });
  const r = q.data;

  const chart = useMemo(() => {
    if (!r) return null;
    const keys = r.services.filter((s) => s.cost > 0).map((s) => s.id);
    return {
      times: r.series.map((p) => new Date(p.t)), keys,
      rows: r.series.map((p) => Object.fromEntries(keys.map((k) => [k, Number(p[k] ?? 0)]))),
      labels: Object.fromEntries(r.services.map((s) => [s.id, s.label])),
    };
  }, [r]);
  const paid = r?.services.filter((s) => s.cost > 0) ?? [];
  const pipelineCost = r?.services.filter((s) => ['lambda', 'glue', 'stepfunctions'].includes(s.id)).reduce((a, s) => a + s.cost, 0) ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader title="Costos del data lake"
        subtitle="Estimación casi en tiempo real: la función de costos lee el uso real de cada servicio (métricas de CloudWatch, historial de Glue, Athena y Step Functions, tamaño de S3) y lo multiplica por el precio de lista. Se recalcula cada minuto.">
        <div className="flex rounded-lg bg-surface-secondary p-1">
          {RANGES.map(([v, l]) => (
            <button key={v} onClick={() => setRange(v)} className={`rounded-md px-3 py-1.5 text-sm ${range === v ? 'bg-surface font-medium shadow-sm' : 'text-muted'}`}>{l}</button>
          ))}
        </div>
        <Button variant="secondary" onPress={() => q.refetch()} isPending={q.isFetching}><RefreshCw className="size-4" /> Recalcular</Button>
        <CodeButton label="Ver cálculo" request={{ title: 'Cálculo de costos', files: ['backend/lambdas/costs/handler.py', 'backend/common/pricing.py'], highlight: 'def collect' }} />
      </PageHeader>

      {q.isPending && <div className="grid h-64 place-items-center"><Spinner size="lg" /></div>}
      {q.isError && <p className="text-danger">{(q.error as Error).message}</p>}

      {r && chart && (
        <>
          <div className="grid grid-cols-2 gap-4 xl:grid-cols-5">
            <Kpi label={`Total ${RANGES.find(([v]) => v === range)![1].toLowerCase()}`} value={usd(r.total)} hint={`Actualizado ${fmtTime(r.generatedAt)}`} />
            <Kpi label="Ritmo mensual estimado" value={usd(r.monthlyProjection)} hint="Si el uso de la ventana se mantuviera" />
            <Kpi label="Procesamiento (pipelines)" value={usd(pipelineCost)} hint="Lambda + Glue + Step Functions" />
            <Kpi label="Consultas Athena" value={usd(r.services.find((s) => s.id === 'athena')?.cost ?? 0)} hint={`${fmtNum(r.services.find((s) => s.id === 'athena')?.usage[0]?.value ?? 0)} consultas`} />
            <Kpi label="Servicio más caro" value={paid[0]?.label.replace(/^(AWS|Amazon) /, '') ?? '—'} hint={paid[0] ? usd(paid[0].cost) : 'Sin gasto'} />
          </div>

          <div className="grid gap-6 2xl:grid-cols-[2fr_1fr]">
            <Card>
              <CardHeader><CardTitle>Costo en el tiempo por servicio</CardTitle>
                <CardDescription>Cada banda es un servicio. Los picos coinciden con las ejecuciones de pipelines (sobre todo Glue).</CardDescription></CardHeader>
              <CardContent>{chart.keys.length ? <StackedArea {...chart} format={usd} height={320} /> : <p className="text-sm text-muted">Sin gasto en la ventana elegida.</p>}</CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Distribución</CardTitle></CardHeader>
              <CardContent>{paid.length ? <DonutChart height={240} format={usd} data={{ labels: paid.map((s) => s.label), series: [{ name: 'USD', values: paid.map((s) => s.cost) }] }} /> : <p className="text-sm text-muted">Sin gasto.</p>}</CardContent>
            </Card>
          </div>

          <div className="grid gap-5 lg:grid-cols-2 2xl:grid-cols-3">
            {r.services.map((s) => <ServiceCard key={s.id} s={s} share={r.total ? s.cost / r.total : 0} />)}
          </div>

          <Card>
            <CardHeader><CardTitle>Cómo leer estos números</CardTitle></CardHeader>
            <CardContent className="grid gap-4 text-sm text-muted lg:grid-cols-3">
              <p><b className="text-foreground">Es una estimación.</b> Usa precios de lista de us-east-1 sin capa gratuita ni descuentos. La factura real llega a Cost Explorer con hasta 24 h de retraso.</p>
              <p><b className="text-foreground">Lambda vs Glue.</b> Una Lambda factura por milisegundo; un job de Glue factura por segundo de DPU con un mínimo de 1 minuto y 2 workers. Por eso Glue domina el costo aunque procese menos tablas: conviene recién a partir de ~1 millón de registros.</p>
              <p><b className="text-foreground">Athena.</b> Cobra por datos escaneados (mínimo 10 MB por consulta). Parquet, particiones y tablas agregadas en Gold bajan el costo de cada consulta del tablero.</p>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
