// Pestaña 2 · Modelo de datos: ER original vs optimizado (React Flow, arrastrables) y su efecto en Athena.
import { useState } from 'react';
import { Button } from '@heroui/react';
import { Zap } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DataTable } from '@/components/ui/table';
import { PageHeader } from '@/components/common';
import { CodeButton } from '@/components/CodeViewer';
import { ErDiagram } from '@/components/ErDiagram';
import { BarChart } from '@/charts/charts';
import { BENCHMARKS, OPTIMIZATIONS } from '@/lib/content';
import { ORIGINAL, OPTIMIZED } from '@/lib/model';
import { api } from '@/lib/api';
import { fmtBytes } from '@/lib/utils';

// De qué tablas Gold sale cada agregado (se dibuja como linaje punteado).
const LINEAGE: [string, string][] = [
  ['fsales', 'a1'], ['ddate', 'a1'], ['dprod', 'a1'],
  ['fsales', 'a2'], ['dterr', 'a2'], ['ddate', 'a2'],
  ['fsales', 'a3'], ['fret', 'a3'], ['dprod', 'a3'],
  ['fsales', 'a4'], ['dcust', 'a4'],
];

const DIAGRAM_HEIGHT = 'max(620px, calc(100vh - 330px))';

type Bench = { label: string; joins: number; bytes?: number; ms?: number; error?: string };

export default function DataModel() {
  const [bench, setBench] = useState<Bench[]>([]);
  const [running, setRunning] = useState(false);

  async function runBenchmark() {
    setRunning(true);
    const out: Bench[] = [];
    for (const b of BENCHMARKS) {
      try {
        const r = await api.query(b.sql);
        out.push({ label: b.label, joins: b.joins, bytes: r.stats?.dataScannedBytes, ms: r.stats?.engineMillis });
      } catch (e) { out.push({ label: b.label, joins: b.joins, error: (e as Error).message }); }
      setBench([...out]);
    }
    setRunning(false);
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Modelo de datos"
        subtitle="Antes de construir pipelines hay que entender los datos: qué tablas llegan, cómo se relacionan y cómo conviene remodelarlas para que las consultas sean rápidas y baratas.">
        <CodeButton label="Ver SQL de Gold" request={{ title: 'Modelos Gold (SQL)', files: ['backend/sql/gold/01_dim_product.sql', 'backend/sql/gold/02_dim_customer.sql', 'backend/sql/gold/03_dim_territory.sql', 'backend/sql/gold/04_dim_date.sql', 'backend/sql/gold/05_fact_sales.sql', 'backend/sql/gold/06_fact_returns.sql', 'backend/sql/gold/07_sales_monthly_by_category.sql', 'backend/sql/gold/08_sales_by_territory.sql', 'backend/sql/gold/09_return_rate_by_category.sql', 'backend/sql/gold/10_sales_by_customer_segment.sql'] }} />
        <CodeButton label="Ver dependencias" request={{ title: 'Dependencias entre tablas', files: ['backend/common/datasets.py'], highlight: 'DATASETS: tuple' }} />
      </PageHeader>

      <Tabs defaultValue="original">
        <TabsList>
          <TabsTrigger value="original">Original · CSV de Kaggle (copo de nieve)</TabsTrigger>
          <TabsTrigger value="optimized">Optimizado · capa Gold (estrella)</TabsTrigger>
        </TabsList>
        <TabsContent value="original" className="mt-4">
          <div className="grid gap-4 2xl:grid-cols-[1fr_340px]">
            <ErDiagram model={ORIGINAL} storageKey="er-original-v2" height={DIAGRAM_HEIGHT} />
            <Card className="h-fit">
              <CardHeader><CardTitle>Cómo leerlo</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm text-muted">
                <p>Ocho tablas normalizadas. Las ventas vienen en tres archivos (2015, 2016, 2017) con la misma estructura.</p>
                <p>La flecha va de la <span className="text-pandas">clave foránea (FK)</span> a la <span className="text-gold">clave primaria (PK)</span>: muchas ventas apuntan a un producto.</p>
                <p>Para saber la categoría de una venta hay que encadenar <b className="text-foreground">Sales → Products → Subcategories → Categories</b>: tres joins.</p>
                <p>Estas mismas relaciones son las <b className="text-foreground">dependencias</b> que validan los pipelines: no se puede procesar Products si Subcategories no está al día.</p>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
        <TabsContent value="optimized" className="mt-4">
          <div className="grid gap-4 2xl:grid-cols-[1fr_340px]">
            <ErDiagram model={OPTIMIZED} storageKey="er-optimized-v4" lineage={LINEAGE} height={DIAGRAM_HEIGHT} initial="model" />
            <Card className="h-fit">
              <CardHeader><CardTitle>Por qué es más rápido</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm text-muted">
                <p>Esquema en <b className="text-foreground">estrella</b>: dos tablas de hechos al centro y dimensiones desnormalizadas. Cualquier consulta necesita como máximo un join por dimensión.</p>
                <p><span className="text-[#f0abfc]">order_year</span> es la partición de fact_sales: filtrar por año lee solo esa carpeta.</p>
                <p>Las tablas <span className="text-[#c4b5fd]">punteadas</span> son agregados precalculados para dashboards. Activa “Linaje de agregados” para ver de qué tablas salen.</p>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Qué cambió y su efecto</CardTitle></CardHeader>
          <CardContent><DataTable head={['Optimización', 'Detalle', 'Efecto']} rows={OPTIMIZATIONS.map(([a, b, c]) => [<b key="a">{a}</b>, <span key="b" className="text-muted">{b}</span>, c])} /></CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Compruébalo en Athena: la misma pregunta con tres modelos</CardTitle>
            <CardDescription>Ingresos por categoría en 2016. Las tres consultas devuelven el mismo resultado; cambia cuántos datos lee Athena (y por lo tanto el costo).</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button onPress={runBenchmark} isPending={running}><Zap className="size-4" /> Comparar en Athena</Button>
            {bench.length > 0 && (
              <>
                <DataTable head={['Modelo', 'Joins', 'Datos leídos', 'Tiempo motor']} rows={bench.map((b) => [b.label, b.joins, b.error ? <span key="e" className="text-danger">{b.error}</span> : fmtBytes(b.bytes), b.ms != null ? `${b.ms} ms` : '—'])} />
                {bench.every((b) => b.bytes != null) && (
                  <BarChart horizontal height={160} format={(n) => fmtBytes(n)}
                    data={{ labels: bench.map((b) => b.label), series: [{ name: 'Bytes leídos', values: bench.map((b) => b.bytes ?? 0) }] }} />
                )}
                <p className="text-xs text-muted">Con 56 mil filas los tiempos varían entre ejecuciones: lo que escala con el volumen son los datos leídos y los joins.</p>
              </>
            )}
            <details className="text-sm">
              <summary className="cursor-pointer text-muted">Ver las tres consultas</summary>
              {BENCHMARKS.map((b) => (
                <div key={b.id} className="mt-3"><p className="mb-1 font-medium">{b.label} · {b.joins} join(s)</p>
                  <pre className="overflow-x-auto rounded-lg bg-surface-secondary p-3 font-mono text-xs">{b.sql}</pre></div>
              ))}
            </details>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
