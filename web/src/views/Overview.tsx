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

/* Arquitectura completa: acceso, los DOS orquestadores (event-driven y programado), el lake y la plataforma. */
const zone = (id: string, x: number, y: number, w: number, h: number, title: string, tint?: string): Node =>
  ({ id, type: 'zone', position: { x, y }, data: { title, w, h, tint }, selectable: false, draggable: false, zIndex: -1 });

function useArchitecture() {
  return useMemo(() => {
    const nodes: Node[] = [
      zone('z-sec', 0, -190, 2240, 150, 'Plataforma: infraestructura como código, seguridad y monitoreo'),
      zone('z-front', 0, 0, 800, 470, 'Acceso de los ingenieros'),
      zone('z-evt', 840, 0, 870, 270, 'Arquitectura event-driven (modo "event")', 'color-mix(in oklch, var(--accent) 7%, transparent)'),
      zone('z-sch', 840, 300, 870, 170, 'Arquitectura programada (modo "scheduled")', 'color-mix(in oklch, var(--warning) 6%, transparent)'),
      zone('z-lake', 1750, 0, 490, 470, 'Data lake'),
      // plataforma
      svc('cdk', 20, -140, { icon: 'cdk', title: 'AWS CDK (Python)', subtitle: 'Crea TODO esto desde código (deplo.sh)' }),
      svc('iam', 470, -140, { icon: 'iam', title: 'IAM', subtitle: 'Un rol por función, permisos mínimos' }),
      svc('kms', 920, -140, { icon: 'kms', title: 'KMS', subtitle: 'En producción: clave propia (CMK)', dashed: true, badge: 'no desplegado: SSE-S3/SSE-SQS sin costo' }),
      svc('ssm', 1370, -140, { icon: 'ssm', title: 'SSM Parameter Store', subtitle: 'Guarda el modo: event | scheduled' }),
      svc('cw', 1820, -140, { icon: 'cloudwatch', title: 'CloudWatch', subtitle: 'Logs, métricas y costos' }),
      // acceso
      svc('user', 20, 200, { title: 'Ingeniero', subtitle: 'Navegador web', tone: 'neutral' }),
      svc('cf', 290, 60, { icon: 'cloudfront', title: 'CloudFront + S3', subtitle: 'Sirve la web (HTTPS)' }),
      svc('cognito', 290, 350, { icon: 'cognito', title: 'Cognito', subtitle: 'Login SRP · emite el JWT' }),
      svc('apigw', 290, 200, { icon: 'apiGateway', title: 'API Gateway', subtitle: 'Valida el JWT' }),
      svc('api', 560, 200, { icon: 'lambda', title: 'Lambdas de API', subtitle: 'Estado, costos, logs, modo' }),
      // event-driven
      svc('landing', 870, 60, { icon: 's3', title: 'S3 landing', subtitle: 'PUT de un CSV = evento', tone: 'landing' }),
      svc('q', 1170, 60, { icon: 'sqs', title: 'SQS events', subtitle: 'Cola de eventos del pipeline' }),
      svc('disp', 1460, 60, { icon: 'lambda', title: 'Lambda despachador', subtitle: '¿se cumplen las condiciones?' }),
      svc('retry', 1170, 180, { icon: 'sqs', title: 'SQS retry-dlq', subtitle: 'Espera 20 s y vuelve a probar' }),
      svc('dlq', 1460, 180, { icon: 'sqs', title: 'SQS dead-letter', subtitle: 'Errores y 15 intentos agotados', tone: 'neutral' }),
      svc('ebglue', 870, 180, { icon: 'eventbridge', title: 'EventBridge', subtitle: 'Avisa cuando termina Glue' }),
      // programado
      svc('ebsch', 870, 360, { icon: 'eventbridge', title: 'EventBridge (regla)', subtitle: 'Cada 30 minutos' }),
      svc('sfn', 1170, 360, { icon: 'stepFunctions', title: 'Step Functions', subtitle: 'Plan → datasets → Gold' }),
      svc('lambdas', 1460, 360, { icon: 'lambda', title: 'Lambdas por capa', subtitle: 'El MISMO código que event-driven' }),
      // lake
      svc('layers', 1790, 60, { icon: 's3', title: 'S3 bronze · silver · gold', subtitle: 'Un bucket por capa', tone: 'gold' }),
      svc('gluejob', 1790, 200, { icon: 'glue', title: 'Glue Spark + Catalog', subtitle: 'Silver de hechos · tablas' }),
      svc('athena', 1790, 350, { icon: 'athena', title: 'Athena', subtitle: 'Gold (CTAS) y consultas', tone: 'athena' }),
    ];
    const dash = { style: { strokeDasharray: '5 4' } };
    const edges: Edge[] = [
      edge('a1', 'user', 'cf', 'descarga la web', { sourceHandle: 's-Top', targetHandle: 't-Left' }),
      edge('a2', 'user', 'cognito', 'login', { sourceHandle: 's-Bottom', targetHandle: 't-Left' }),
      edge('a3', 'user', 'apigw', 'API + JWT', { sourceHandle: 's-Right', targetHandle: 't-Left' }),
      edge('a4', 'apigw', 'api', undefined, { sourceHandle: 's-Right', targetHandle: 't-Left' }),
      edge('a5', 'api', 'landing', 'URL prefirmada', { sourceHandle: 's-Top', targetHandle: 't-Left' }),
      edge('e1', 'landing', 'q', 'S3 PUT event', { sourceHandle: 's-Right', targetHandle: 't-Left', animated: true }),
      edge('e2', 'q', 'disp', 'dispara', { sourceHandle: 's-Right', targetHandle: 't-Left', animated: true }),
      edge('e3', 'disp', 'retry', 'faltan dependencias', { sourceHandle: 's-Bottom', targetHandle: 't-Right', ...dash }),
      edge('e4', 'retry', 'disp', '20 s', { sourceHandle: 's-Top', targetHandle: 't-Bottom', ...dash }),
      edge('e5', 'disp', 'dlq', 'error', { sourceHandle: 's-Bottom', targetHandle: 't-Top', ...dash }),
      edge('e6', 'ebglue', 'q', 'fin de Glue', { sourceHandle: 's-Right', targetHandle: 't-Bottom' }),
      edge('e7', 'disp', 'layers', 'ejecuta el paso', { sourceHandle: 's-Right', targetHandle: 't-Left' }),
      edge('s1', 'ebsch', 'sfn', 'cron', { sourceHandle: 's-Right', targetHandle: 't-Left' }),
      edge('s2', 'sfn', 'lambdas', undefined, { sourceHandle: 's-Right', targetHandle: 't-Left' }),
      edge('s3', 'lambdas', 'layers', undefined, { sourceHandle: 's-Right', targetHandle: 't-Bottom' }),
      edge('l1', 'layers', 'gluejob', undefined, { sourceHandle: 's-Bottom', targetHandle: 't-Top' }),
      edge('l2', 'gluejob', 'athena', undefined, { sourceHandle: 's-Bottom', targetHandle: 't-Top' }),
      edge('p1', 'cdk', 'iam', 'despliega', { sourceHandle: 's-Right', targetHandle: 't-Left', ...dash }),
      edge('p2', 'ssm', 'disp', 'modo', { sourceHandle: 's-Bottom', targetHandle: 't-Top', ...dash }),
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
        <CardHeader><CardTitle>2 · Arquitectura completa</CardTitle>
          <CardDescription>Arriba la plataforma (CDK, IAM, KMS, SSM, CloudWatch). Al centro los DOS orquestadores que se pueden alternar en Operar: event-driven (cada archivo dispara su pipeline por SQS) y programado (EventBridge cada 30 min dispara Step Functions). Ambos ejecutan el mismo código sobre el mismo lake.</CardDescription></CardHeader>
        <CardContent><Diagram nodes={arch.nodes} edges={arch.edges} height={640} /></CardContent>
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
