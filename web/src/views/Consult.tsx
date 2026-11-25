// Pestaña 5 · Consultar: tablero de comando. Cada panel es una consulta Athena
// sobre Gold con su propio gráfico D3; más una consulta libre con gráfico.
import { useState } from 'react';
import { useQueries, useMutation } from '@tanstack/react-query';
import { Button, Spinner } from '@heroui/react';
import { Play, RefreshCw } from 'lucide-react';
import { Card, CardAction, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/ui/table';
import { AwsIcon, Empty, Kpi, PageHeader } from '@/components/common';
import { CodeButton } from '@/components/CodeViewer';
import { BarChart, DonutChart, LineChart, toChartData } from '@/charts/charts';
import { DASHBOARD_PANELS, EXAMPLE_QUERIES, type ChartType } from '@/lib/content';
import { api, type QueryResult } from '@/lib/api';
import { useLake } from '@/lib/hooks';
import { compact, fmtBytes, fmtNum } from '@/lib/utils';

const TYPES: [ChartType, string][] = [['bar', 'Barras'], ['hbar', 'Barras horizontales'], ['line', 'Líneas'], ['donut', 'Dona'], ['table', 'Tabla']];
const KPI_LABELS: Record<string, [string, string]> = { revenue: ['Ingresos', '$'], profit: ['Utilidad', '$'], units: ['Unidades vendidas', ''], orders: ['Pedidos', ''] };

function Visual({ type, r }: { type: ChartType; r: QueryResult }) {
  if (type === 'kpi') {
    const row = r.rows[0] ?? [];
    return <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{r.columns.map((c, i) => {
      const [label, prefix] = KPI_LABELS[c] ?? [c, ''];
      return <Kpi key={c} label={label} value={`${prefix}${compact(Number(row[i]))}`} hint={fmtNum(row[i])} />;
    })}</div>;
  }
  const data = toChartData(r.columns, r.rows);
  if (type === 'table' || !data) return <div className="max-h-80 overflow-auto"><DataTable head={r.columns} rows={r.rows} /></div>;
  if (type === 'line') return <LineChart data={data} />;
  if (type === 'donut') return <DonutChart data={data} />;
  return <BarChart data={data} horizontal={type === 'hbar'} />;
}

const stats = (r: QueryResult) => `${r.rows.length} fila(s) · ${fmtBytes(r.stats?.dataScannedBytes)} leídos · ${r.stats?.engineMillis ?? '?'} ms`;

function TypeSelect({ value, onChange }: { value: ChartType; onChange: (t: ChartType) => void }) {
  return (
    <select aria-label="Tipo de gráfico" value={value} onChange={(e) => onChange(e.target.value as ChartType)}
      className="rounded-md border border-border bg-field px-2 py-1 text-xs text-field-foreground">
      {TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}

export default function Consult() {
  const { data: lake } = useLake();
  const goldBuilt = !!lake?.gold.some((g) => g.status !== 'not_built');
  const goldSig = lake?.gold.map((g) => g.status).join() ?? '';
  const [types, setTypes] = useState<Record<string, ChartType>>(() => Object.fromEntries(DASHBOARD_PANELS.map((p) => [p.id, p.type])));

  // Las 8 consultas corren en paralelo y se cachean; si Gold cambia, se vuelven a ejecutar.
  const panels = useQueries({
    queries: DASHBOARD_PANELS.map((p) => ({ queryKey: ['panel', p.id, goldSig], queryFn: () => api.query(p.sql), enabled: goldBuilt, staleTime: 5 * 60_000 })),
  });

  const [sql, setSql] = useState(EXAMPLE_QUERIES[0].sql);
  const [freeType, setFreeType] = useState<ChartType>('bar');
  const free = useMutation({ mutationFn: api.query });

  return (
    <div className="space-y-6">
      <PageHeader title="Consultar · tablero de comando"
        subtitle="Cada panel es una consulta SQL que Athena ejecuta sobre la capa Gold, dibujada con D3. Cambia el tipo de gráfico de cada panel o escribe tu propia consulta abajo.">
        <Button variant="secondary" isDisabled={!goldBuilt} onPress={() => panels.forEach((p) => p.refetch())}><RefreshCw className="size-4" /> Actualizar</Button>
        <CodeButton label="Ver API de consultas" request={{ title: 'Consultas de solo lectura en Athena', files: ['backend/lambdas/api/handler.py', 'backend/common/sql_guard.py'], highlight: 'def run_query' }} />
      </PageHeader>

      {!goldBuilt && <Empty>Aún no se construyó Gold. Procesa los archivos y construye Gold en la pestaña Operar.</Empty>}

      {goldBuilt && (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 2xl:grid-cols-3">
          {DASHBOARD_PANELS.map((p, i) => {
            const q = panels[i];
            const type = types[p.id];
            return (
              <Card key={p.id} className={p.wide ? 'lg:col-span-2 2xl:col-span-3' : p.id === 'trend' ? 'lg:col-span-2' : ''}>
                <CardHeader className="flex-row items-center">
                  <CardTitle>{p.title}</CardTitle>
                  <CardAction>{p.type !== 'kpi' && <TypeSelect value={type} onChange={(t) => setTypes((s) => ({ ...s, [p.id]: t }))} />}</CardAction>
                </CardHeader>
                <CardContent className={p.type === 'kpi' ? '' : 'min-h-48'}>
                  {q.isPending ? <div className="grid h-48 place-items-center"><Spinner /></div>
                    : q.isError ? <p className="text-sm text-danger">{(q.error as Error).message}</p>
                      : <Visual type={type} r={q.data!} />}
                </CardContent>
                <CardFooter>
                  {q.data && <span>{stats(q.data)}</span>}
                </CardFooter>
                <details className="px-5 pb-4"><summary className="cursor-pointer text-xs text-muted">Ver SQL</summary>
                  <pre className="mt-2 overflow-x-auto rounded-lg bg-surface-secondary p-3 font-mono text-xs">{p.sql}</pre></details>
              </Card>
            );
          })}
        </div>
      )}

      <Card>
        <CardHeader className="flex-row items-center gap-3">
          <AwsIcon name="athena" size={28} />
          <div className="flex-1"><CardTitle>Consulta libre</CardTitle>
            <p className="text-sm text-muted">Solo lectura. Bases: datalake_bronze, datalake_silver y datalake_gold. Compara la misma tabla en cada capa. La primera columna es la etiqueta y las numéricas son las series.</p></div>
        </CardHeader>
        <CardContent className="grid gap-5 2xl:grid-cols-2">
          <div className="space-y-3">
            <select className="w-full rounded-md border border-border bg-field px-3 py-2 text-sm text-field-foreground" onChange={(e) => setSql(EXAMPLE_QUERIES[Number(e.target.value)].sql)}>
              {EXAMPLE_QUERIES.map((q, i) => <option key={q.title} value={i}>{q.title}</option>)}
            </select>
            <textarea value={sql} onChange={(e) => setSql(e.target.value)} rows={12} spellCheck={false}
              className="w-full rounded-lg border border-border bg-field p-3 font-mono text-[13px] text-field-foreground outline-none focus:border-accent" />
            <div className="flex items-center gap-2">
              <Button onPress={() => free.mutate(sql)} isPending={free.isPending}><Play className="size-4" /> Ejecutar</Button>
              <TypeSelect value={freeType} onChange={setFreeType} />
              {free.data && <span className="text-xs text-muted">{stats(free.data)}{free.data.truncated ? ' (primeras 100)' : ''}</span>}
            </div>
          </div>
          <div className="min-h-64">
            {free.isError ? <p className="text-sm text-danger">{(free.error as Error).message}</p>
              : free.data ? <Visual type={freeType} r={free.data} /> : <Empty>El resultado y su gráfico aparecen aquí.</Empty>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
