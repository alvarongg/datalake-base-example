// Pestaña 1 · Resumen: arquitectura de la app y flujo medallion con iconos oficiales de AWS.
import { useMemo } from 'react';
import { Background, Controls, MarkerType, ReactFlow, type Edge, type Node } from '@xyflow/react';
import { ArrowRight } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EngineNote, PageHeader } from '@/components/common';
import { flowNodeTypes, type ServiceNodeData } from '@/components/flow';
import { CodeButton } from '@/components/CodeViewer';
import { LAYERS } from '@/lib/content';
import { layerStates, useLake } from '@/lib/hooks';

// Clases completas (Tailwind no detecta clases armadas con plantillas).
const LAYER_BG = { landing: 'bg-landing', bronze: 'bg-bronze', silver: 'bg-silver', gold: 'bg-gold' } as const;
const arrow = { type: MarkerType.ArrowClosed, width: 18, height: 18 };
const edge = (id: string, source: string, target: string, label?: string, extra: Partial<Edge> = {}): Edge => ({
  id, source, target, label, type: 'smoothstep', markerEnd: arrow, labelBgPadding: [6, 3], labelBgBorderRadius: 6,
  labelStyle: { fill: 'var(--muted)', fontSize: 11 }, labelBgStyle: { fill: 'var(--surface)' }, ...extra,
});
const svc = (id: string, x: number, y: number, data: ServiceNodeData): Node => ({ id, type: 'service', position: { x, y }, data });

/* Arquitectura completa: del navegador a Athena. */
function useArchitecture() {
  return useMemo(() => {
    const nodes: Node[] = [
      { id: 'g-front', type: 'zone', position: { x: 220, y: 0 }, data: { title: 'Front-end y acceso', w: 540, h: 400 }, selectable: false, draggable: false, zIndex: -1 },
      { id: 'g-lake', type: 'zone', position: { x: 800, y: 0 }, data: { title: 'Pipelines y data lake', w: 820, h: 400 }, selectable: false, draggable: false, zIndex: -1 },
      svc('user', 0, 170, { title: 'Ingeniero', subtitle: 'Navegador web', tone: 'neutral' }),
      svc('cf', 250, 60, { icon: 'cloudfront', title: 'CloudFront + S3', subtitle: 'Sirve la web (HTTPS)' }),
      svc('cognito', 250, 290, { icon: 'cognito', title: 'Cognito', subtitle: 'Login SRP · emite el JWT' }),
      svc('apigw', 510, 170, { icon: 'apiGateway', title: 'API Gateway', subtitle: 'Valida el JWT' }),
      svc('lambda', 830, 170, { icon: 'lambda', title: 'Lambdas de API', subtitle: 'Estado, costos, logs' }),
      svc('landing', 1110, 60, { icon: 's3', title: 'S3 landing', subtitle: 'CSV por URL prefirmada', tone: 'landing' }),
      svc('sfn', 1110, 170, { icon: 'stepFunctions', title: 'Step Functions', subtitle: 'Un pipeline por archivo' }),
      svc('athena', 1110, 290, { icon: 'athena', title: 'Athena', subtitle: 'Consultas SQL', tone: 'athena' }),
      svc('glue', 1370, 170, { icon: 'glue', title: 'Glue Catalog + Spark', subtitle: 'Tablas y job Silver' }),
    ];
    const edges: Edge[] = [
      edge('e1', 'user', 'cf', 'descarga la web', { sourceHandle: 's-Top', targetHandle: 't-Left' }),
      edge('e2', 'user', 'cognito', 'login', { sourceHandle: 's-Bottom', targetHandle: 't-Left' }),
      edge('e3', 'user', 'apigw', 'API + JWT', { sourceHandle: 's-Right', targetHandle: 't-Left' }),
      edge('e4', 'cognito', 'apigw', 'valida JWT', { sourceHandle: 's-Right', targetHandle: 't-Bottom', animated: true }),
      edge('e5', 'apigw', 'lambda', undefined, { sourceHandle: 's-Right', targetHandle: 't-Left' }),
      edge('e6', 'lambda', 'landing', 'URL prefirmada', { sourceHandle: 's-Top', targetHandle: 't-Left' }),
      edge('e7', 'lambda', 'sfn', 'inicia', { sourceHandle: 's-Right', targetHandle: 't-Left' }),
      edge('e8', 'lambda', 'athena', 'SELECT', { sourceHandle: 's-Bottom', targetHandle: 't-Left' }),
      edge('e9', 'sfn', 'glue', undefined, { sourceHandle: 's-Right', targetHandle: 't-Left' }),
    ];
    return { nodes, edges };
  }, []);
}

/* Flujo medallion: capas + motor entre capas, iluminado según el estado real. */
function useMedallion() {
  const { data } = useLake();
  const st = layerStates(data);
  return useMemo(() => {
    const y = 120;
    const nodes: Node[] = [
      svc('l', 0, y, { icon: 's3', title: 'Landing', subtitle: 'CSV originales', tone: 'landing', state: st.landing }),
      svc('b', 320, y, { icon: 's3', title: 'Bronze', subtitle: 'Parquet crudo + auditoría', tone: 'bronze', state: st.bronze }),
      svc('s', 640, y, { icon: 's3', title: 'Silver', subtitle: 'Limpio, tipado, sin duplicados', tone: 'silver', state: st.silver }),
      svc('g', 960, y, { icon: 's3', title: 'Gold', subtitle: 'Modelo estrella + agregados', tone: 'gold', state: st.gold }),
      svc('a', 1280, y, { icon: 'athena', title: 'Athena', subtitle: 'SQL sobre cualquier capa', tone: 'athena', state: st.athena }),
      svc('e1', 160, 0, { icon: 'lambda', title: 'Lambda', subtitle: 'awswrangler' }),
      svc('e2', 480, -10, { icon: 'lambda', title: 'Lambda · pandas', subtitle: 'tablas chicas' }),
      svc('e3', 480, 250, { icon: 'glue', title: 'Glue · Spark', subtitle: 'tablas de hechos' }),
      svc('e4', 800, 0, { icon: 'athena', title: 'Athena CTAS', subtitle: 'modelos SQL' }),
      svc('sfn', 1280, 300, { icon: 'stepFunctions', title: 'Step Functions', subtitle: 'orquesta y valida dependencias' }),
    ];
    const run = (s?: string) => s === 'running';
    const edges: Edge[] = [
      edge('m1', 'l', 'b', undefined, { sourceHandle: 's-Right', targetHandle: 't-Left', animated: run(st.bronze) }),
      edge('m2', 'b', 's', undefined, { sourceHandle: 's-Right', targetHandle: 't-Left', animated: run(st.silver) }),
      edge('m3', 's', 'g', undefined, { sourceHandle: 's-Right', targetHandle: 't-Left', animated: run(st.gold) }),
      edge('m4', 'g', 'a', undefined, { sourceHandle: 's-Right', targetHandle: 't-Left' }),
      edge('x1', 'e1', 'b', undefined, { sourceHandle: 's-Bottom', targetHandle: 't-Top', style: { strokeDasharray: '4 4' } }),
      edge('x2', 'e2', 's', undefined, { sourceHandle: 's-Bottom', targetHandle: 't-Top', style: { strokeDasharray: '4 4' } }),
      edge('x3', 'e3', 's', undefined, { sourceHandle: 's-Top', targetHandle: 't-Bottom', style: { strokeDasharray: '4 4' } }),
      edge('x4', 'e4', 'g', undefined, { sourceHandle: 's-Bottom', targetHandle: 't-Top', style: { strokeDasharray: '4 4' } }),
    ];
    return { nodes, edges };
  }, [st.landing, st.bronze, st.silver, st.gold, st.athena]);
}

function Diagram({ nodes, edges, height }: { nodes: Node[]; edges: Edge[]; height: number }) {
  return (
    <div style={{ height }} className="rounded-xl border border-border bg-background/40">
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={flowNodeTypes} fitView fitViewOptions={{ padding: 0.08, maxZoom: 1.1 }}
        nodesConnectable={false} proOptions={{ hideAttribution: true }} minZoom={0.3} maxZoom={1.8} panOnScroll={false} zoomOnScroll={false}>
        <Background gap={24} size={1} color="var(--border)" />
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>
    </div>
  );
}

export default function Overview() {
  const arch = useArchitecture();
  const med = useMedallion();
  return (
    <div className="space-y-6">
      <PageHeader title="Cómo se construye un data lake medallion"
        subtitle="Recorre las pestañas en orden: primero el modelo de datos, luego cada pipeline, después operarlo, consultarlo, controlar su costo y observarlo. Los diagramas se pueden mover y hacer zoom.">
        <CodeButton label="Ver infraestructura (CDK)" request={{ title: 'Infraestructura como código (CDK Python)', files: ['infra/app.py', 'infra/stacks/datalake.py', 'infra/stacks/pipeline.py', 'infra/stacks/api.py', 'infra/stacks/web.py', 'infra/stacks/auth.py'] }} />
        <CodeButton label="Ver deplo.sh" request={{ title: 'deplo.sh · despliegue paso a paso', files: ['deplo.sh'] }} />
      </PageHeader>

      <div className="space-y-6">
        <Card>
          <CardHeader><CardTitle>1 · El flujo medallion</CardTitle>
            <CardDescription>Cada capa es un bucket S3 distinto. Entre capas, el servicio que transforma el dato. Se ilumina con el estado real de los pipelines.</CardDescription></CardHeader>
          <CardContent><Diagram nodes={med.nodes} edges={med.edges} height={480} /></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>¿Qué hace cada capa?</CardTitle></CardHeader>
          <CardContent className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-4">
            {LAYERS.map((l, i) => (
              <div key={l.id} className="flex gap-3 rounded-xl border border-border bg-surface-secondary/50 p-3">
                <span className={`grid size-8 shrink-0 place-items-center rounded-lg text-sm font-bold text-black ${LAYER_BG[l.id]}`}>{i + 1}</span>
                <div><p className="font-medium">{l.title} <span className="text-xs font-normal text-muted">· {l.tag}</span></p>
                  <p className="text-sm text-muted">{l.text}</p></div>
              </div>
            ))}
            <div className="lg:col-span-2 2xl:col-span-4"><EngineNote engine="lambda" /></div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>2 · Cómo se conecta todo</CardTitle>
          <CardDescription>El ingeniero descarga la web desde CloudFront, inicia sesión en Cognito y llama a la API con el JWT. Los CSV viajan directo del navegador a S3.</CardDescription></CardHeader>
        <CardContent><Diagram nodes={arch.nodes} edges={arch.edges} height={440} /></CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Recorrido sugerido para la clase</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2 text-sm">
          {['Modelo de datos: qué tablas hay y cómo se relacionan', 'Pipelines: qué hace cada etapa y su código', 'Operar: subir archivos y ver fallar una dependencia', 'Consultar: el tablero sobre Gold', 'Costos: cuánto costó cada paso', 'Observabilidad: logs y errores'].map((s, i, a) => (
            <span key={s} className="flex items-center gap-2"><span className="rounded-lg bg-surface-secondary px-3 py-1.5">{s}</span>{i < a.length - 1 && <ArrowRight className="size-4 text-muted" />}</span>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
