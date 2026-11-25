// Fichas de la pestaña "Pipelines": una por cada etapa. Cada ficha sabe qué
// archivos de código la implementan, para abrirlos desde la web.
import type { AwsService } from '@/components/common';
import type { LakeState } from './api';

export interface PipelineStep { text: string; code?: { file: string; highlight: string } }
export interface PipelineDef {
  id: string;
  title: string;
  layer: 'bronze' | 'deps' | 'silver' | 'gold' | 'orch';
  engine: string;
  engineKind: 'lambda' | 'glue' | 'athena' | 'control' | 'orchestrator';
  flow: [AwsService, string, string][];
  goal: string;
  steps: PipelineStep[];
  rules: string[];
  why: string;
  files: string[];
  summary: (s: LakeState) => { head: string[]; rows: (string | number)[][] };
}

const DS_STATUS: Record<string, string> = {
  no_file: 'Sin archivo', pending: 'Sin procesar', bronze: 'Solo Bronze', stale: 'Desactualizada', ok: 'Al día',
};

export const PIPELINES: PipelineDef[] = [
  {
    id: 'event', layer: 'orch', title: 'Orquestación event-driven', engine: 'S3 → SQS → Lambda despachador', engineKind: 'orchestrator',
    flow: [['s3', 'S3 landing', 'PUT de un CSV'], ['sqs', 'SQS events', 'cola de eventos'], ['lambda', 'Despachador', 'decide el paso'], ['sqs', 'SQS retry-dlq', 'espera 20 s']],
    goal: 'Cada archivo dispara su propio pipeline apenas llega. No hay un "director de orquesta": cada paso, al terminar, publica el siguiente evento. Si una condición no se cumple, el evento espera 20 s en la DLQ de reintento y vuelve a probar.',
    steps: [
      { text: 'S3 notifica cada PUT en landing/adventureworks/*.csv directo a la cola SQS events (archive/ no dispara nada).', code: { file: 'infra/stacks/datalake.py', highlight: 'add_event_notification' } },
      { text: 'La Lambda despachador lee la cola (lotes de 1, máx. 2 en paralelo) y reconoce el tipo de mensaje: S3, fin de Glue o "siguiente paso".', code: { file: 'backend/common/events.py', highlight: 'def parse_messages' } },
      { text: 'Bronze: si el archivo NO está en landing es un error (condición principal) y va a la DLQ final; si faltan otros CSV del dataset, espera 20 s.', code: { file: 'backend/common/events.py', highlight: 'def bronze_precheck' } },
      { text: 'Condición no cumplida: el mensaje se reenvía a retry-dlq (DeliveryDelay 20 s) con el intento + 1; a los 15 intentos va a la DLQ final.', code: { file: 'backend/lambdas/dispatcher/handler.py', highlight: 'def wait' } },
      { text: 'Silver con Glue: arranca el job y termina; el fin del job llega como evento de EventBridge a la misma cola.', code: { file: 'infra/stacks/pipeline.py', highlight: 'GlueStateChangeRule' } },
      { text: 'Al terminar Silver publica Silver de las tablas hijas listas y Gold de los modelos que la leen (fan-out).', code: { file: 'backend/lambdas/dispatcher/handler.py', highlight: 'def after_silver' } },
      { text: 'Dos eventos de la misma tabla: un lock con escritura condicional de S3 deja pasar solo a uno.', code: { file: 'backend/common/events.py', highlight: 'class S3Lock' } },
    ],
    rules: ['Idempotente: un evento repetido (ETag ya consumido, tabla al día) no reprocesa.', 'Reporte parcial de lotes: solo se reintenta el mensaje que falló.',
      'visibility timeout = 6 × timeout de la Lambda; DLQ final con redrive desde la web.', 'Colas cifradas con SSE-SQS (sin costo) y solo TLS.'],
    why: 'Latencia mínima y cada tabla avanza a su ritmo. Escala sola con la cantidad de archivos. A cambio, el estado está repartido: hacen falta idempotencia, locks y un buen feed de eventos para entender qué pasó.',
    files: ['backend/lambdas/dispatcher/handler.py', 'backend/common/events.py', 'infra/stacks/datalake.py', 'infra/stacks/pipeline.py'],
    summary: (s) => ({ head: ['Cola', 'En cola', 'Procesándose', 'Esperando demora'],
      rows: (['events', 'retry', 'dlq'] as const).map((k) => [k, s.queues[k].visible, s.queues[k].inFlight, s.queues[k].delayed]) }),
  },
  {
    id: 'scheduled', layer: 'orch', title: 'Orquestación programada', engine: 'EventBridge → Step Functions', engineKind: 'orchestrator',
    flow: [['eventbridge', 'EventBridge', 'cada 30 min'], ['stepFunctions', 'Step Functions', 'datalake-demo-scheduled'], ['lambda', 'Plan', 'qué hay nuevo'], ['stepFunctions', 'Flujos hijos', 'datasets → Gold']],
    goal: 'Un orquestador central se despierta en horario, arma un lote con todo lo nuevo y lo ejecuta en orden. El estado de cada corrida queda en un solo lugar (la ejecución de Step Functions), con su diagrama, entradas y salidas.',
    steps: [
      { text: 'Una regla de EventBridge ejecuta el flujo cada 30 minutos. Si el modo es event-driven, el flujo termina al instante.', code: { file: 'infra/stacks/pipeline.py', highlight: 'ScheduleRule' } },
      { text: 'PlanProgramado decide el lote: archivos nuevos, tablas con Bronze sin Silver al día y sus hijas, en orden de dependencias.', code: { file: 'backend/lambdas/schedule_plan/handler.py', highlight: 'def plan_datasets' } },
      { text: 'Ejecuta el flujo hijo de datasets (.sync): Map de un dataset a la vez → Bronze → compuerta de dependencias → Silver.', code: { file: 'infra/stacks/pipeline.py', highlight: 'ProcesarDatasets' } },
      { text: 'Después el flujo hijo de Gold solo con lo desactualizado (onlyStale) y salteando lo bloqueado (onlyReady).', code: { file: 'backend/lambdas/gold/handler.py', highlight: 'def plan_models' } },
      { text: 'Reintentos con backoff exponencial ante errores transitorios, timeout por tarea y Catch a un estado de fallo.', code: { file: 'infra/stacks/pipeline.py', highlight: 'add_retry' } },
    ],
    rules: ['Flujos anidados (.sync:2): cada hijo se puede probar solo.', 'X-Ray y logs de nivel ALL en las 3 máquinas.', 'Timeout por tarea y timeout total por ejecución.', 'El mismo código de cada capa que event-driven.'],
    why: 'Fácil de razonar y de auditar: una ejecución = un lote, con un diagrama que muestra dónde falló. Ideal para cargas por lotes (cierres diarios). A cambio, la latencia es la del horario y se procesa por lotes aunque llegue un solo archivo.',
    files: ['infra/stacks/pipeline.py', 'backend/lambdas/schedule_plan/handler.py', 'backend/lambdas/gold/handler.py'],
    summary: (s) => ({ head: ['Flujo', 'En ejecución'], rows: Object.entries(s.runningMachines).map(([k, v]) => [k, v ? 'sí' : 'no']) }),
  },
  {
    id: 'bronze', layer: 'bronze', title: 'Bronze · ingesta cruda', engine: 'AWS Lambda + pandas + awswrangler', engineKind: 'lambda',
    flow: [['s3', 'S3 landing', 'CSV del dataset'], ['lambda', 'Lambda Bronze', 'pandas + awswrangler'], ['s3', 'S3 bronze', 'Parquet'], ['glue', 'Glue Catalog', 'datalake_bronze']],
    goal: 'Guardar el dato exactamente como llegó, sin interpretarlo, en un formato eficiente y consultable. Se ejecuta por dataset: cada extracción dispara su propia carga y no depende de ninguna otra tabla.',
    steps: [
      { text: 'Verifica que estén todos los CSV del dataset en landing; si falta alguno falla con la lista de faltantes.', code: { file: 'backend/lambdas/bronze/handler.py', highlight: 'MissingFilesError(f' } },
      { text: 'Lee cada CSV como texto (dtype=str) con su encoding: clientes viene en latin-1.', code: { file: 'backend/lambdas/bronze/handler.py', highlight: 'wr.s3.read_csv' } },
      { text: 'Pasa los nombres de columna a snake_case y agrega _source_file y _ingested_at (lineage).', code: { file: 'backend/common/transforms.py', highlight: 'def to_bronze' } },
      { text: 'Escribe Parquet con Snappy en el bucket bronze y registra la tabla en Glue (modo overwrite).', code: { file: 'backend/lambdas/bronze/handler.py', highlight: 'wr.s3.to_parquet' } },
      { text: 'Anota en el control con qué versión del archivo se cargó (huella de los ETag de S3).', code: { file: 'backend/common/control.py', highlight: 'def record_bronze' } },
    ],
    rules: ['Los valores no se tocan: fechas y números siguen siendo texto.', 'Idempotente: ejecutar dos veces deja el mismo resultado.', 'Subir un archivo distinto cambia su versión y deja Silver desactualizado.'],
    why: 'awswrangler escribe Parquet y crea la tabla en el catálogo con una sola llamada. Copiar unos MB no justifica levantar un clúster.',
    files: ['backend/lambdas/bronze/handler.py', 'backend/common/transforms.py', 'backend/common/control.py', 'backend/common/datasets.py'],
    summary: (s) => ({ head: ['Dataset', 'Filas en Bronze', 'Última ejecución'], rows: s.datasets.map((d) => [d.name, d.rows.bronze ?? '—', d.run?.stages.bronze?.status ?? '—']) }),
  },
  {
    id: 'deps', layer: 'deps', title: 'Dependencias · la compuerta', engine: 'AWS Lambda (control de versiones)', engineKind: 'control',
    flow: [['s3', 'Control', 'versiones en S3'], ['lambda', 'Lambda', 'CheckDependencies'], ['stepFunctions', 'Step Functions', 'falla o continúa']],
    goal: 'Un pipeline real no transforma una tabla hija si sus tablas padre no están al día. Esta compuerta corre entre Bronze y Silver y hace que la ejecución FALLE con el motivo exacto cuando una dependencia está pendiente o desactualizada.',
    steps: [
      { text: 'Calcula el estado de cada dataset: al día, desactualizado, solo Bronze, sin procesar o sin archivo.', code: { file: 'backend/common/control.py', highlight: 'def dataset_status' } },
      { text: 'Las dependencias de cada tabla están declaradas en el catálogo de datasets (reflejan las claves foráneas).', code: { file: 'backend/common/datasets.py', highlight: 'depends_on=("product_subcategories",)' } },
      { text: 'Si alguna dependencia no está al día lanza DependencyError y Step Functions termina en FAILED.', code: { file: 'backend/lambdas/dependencies/handler.py', highlight: 'raise DependencyError' } },
      { text: 'Si todas cumplen, guarda con qué versión de cada una se construirá Silver (lineage).', code: { file: 'backend/lambdas/dependencies/handler.py', highlight: 'built_from = ' } },
    ],
    rules: ['Reprocesar una tabla padre deja desactualizadas a todas las hijas.', 'Procesar "con dependencias" las ordena y exige que estén TODOS sus archivos.', 'Procesar un dataset "solo" demuestra el fallo cuando falta una dependencia.'],
    why: 'Es la diferencia entre un script que transforma archivos y un pipeline de datos: la corrección no depende de que alguien recuerde el orden.',
    files: ['backend/lambdas/dependencies/handler.py', 'backend/common/control.py', 'backend/common/datasets.py', 'infra/stacks/pipeline.py'],
    summary: (s) => ({
      head: ['Dataset', 'Depende de', 'Resultado de la compuerta'],
      rows: s.datasets.filter((d) => d.dependsOn.length).map((d) => {
        const st = d.run?.stages.dependencies;
        return [d.name, d.dependsOn.join(', '), st ? (st.status === 'failed' ? `✖ ${st.error}` : st.status) : '—'];
      }),
    }),
  },
  {
    id: 'silver-pandas', layer: 'silver', title: 'Silver · tablas pequeñas', engine: 'AWS Lambda + pandas', engineKind: 'lambda',
    flow: [['s3', 'S3 bronze', 'Parquet crudo'], ['lambda', 'Lambda Silver', 'pandas'], ['s3', 'S3 silver', 'Parquet tipado'], ['glue', 'Glue Catalog', 'datalake_silver']],
    goal: 'Limpiar y tipar las tablas pequeñas (clientes, productos, categorías, territorios, calendario). Caben de sobra en la memoria de una Lambda.',
    steps: [
      { text: 'Lee la tabla Bronze y descarta las columnas de auditoría.', code: { file: 'backend/lambdas/silver_dimensions/handler.py', highlight: 'wr.s3.read_parquet' } },
      { text: 'Convierte tipos: fechas M/D/YYYY → date, claves → entero, precios → decimal.', code: { file: 'backend/common/transforms.py', highlight: 'def _to_date' } },
      { text: '"$90,000 " → 90000.0 y "0" en talla/estilo de producto → NULL.', code: { file: 'backend/common/transforms.py', highlight: '"annual_income"' } },
      { text: 'Calendario: deriva año, trimestre, mes, día de la semana y fin de semana.', code: { file: 'backend/common/transforms.py', highlight: 'def silver_calendar' } },
      { text: 'Elimina duplicados por clave y exige que la clave primaria no sea nula.', code: { file: 'backend/common/transforms.py', highlight: 'def _require_not_null' } },
      { text: 'RecordSilver anota el token de esta construcción: las tablas hijas lo usan para saber si siguen al día.', code: { file: 'backend/lambdas/finalize/handler.py', highlight: 'record_silver' } },
    ],
    rules: ['Clave nula = el pipeline falla (no se publican datos dudosos).', 'Cada tabla informa filas de entrada, de salida y duplicados quitados.'],
    why: 'La lógica son funciones puras DataFrame → DataFrame con tests locales sin credenciales. La Lambda solo hace la lectura y escritura.',
    files: ['backend/lambdas/silver_dimensions/handler.py', 'backend/common/transforms.py', 'backend/lambdas/finalize/handler.py'],
    summary: (s) => ({
      head: ['Dataset', 'Estado', 'Filas Silver', 'Duplicados quitados'],
      rows: s.datasets.filter((d) => d.engine === 'pandas').map((d) => [d.name, DS_STATUS[d.status], d.rows.silver ?? '—', d.run?.stages.silver?.duplicates ?? '—']),
    }),
  },
  {
    id: 'silver-glue', layer: 'silver', title: 'Silver · hechos grandes', engine: 'AWS Glue Job (Spark)', engineKind: 'glue',
    flow: [['s3', 'S3 bronze', 'ventas o devoluciones'], ['glue', 'Glue Job', 'Spark 3 · 2 workers'], ['s3', 'S3 silver', 'particionado por año'], ['glue', 'Glue Catalog', 'datalake_silver']],
    goal: 'Procesar las tablas que crecen sin límite (ventas y devoluciones). Cada dataset es una ejecución distinta del mismo job (parámetro --dataset). Con este volumen una Lambda alcanzaría: se usa Glue para mostrar el escenario de más de un millón de registros.',
    steps: [
      { text: 'Lee la tabla Bronze a través del Glue Data Catalog.', code: { file: 'backend/glue/silver_facts.py', highlight: 'def read_bronze' } },
      { text: 'Convierte fechas con to_date y claves/cantidades a entero.', code: { file: 'backend/glue/silver_facts.py', highlight: 'def build_sales' } },
      { text: 'Descarta líneas sin cantidad positiva y deduplica por clave natural.', code: { file: 'backend/glue/silver_facts.py', highlight: 'dropDuplicates(["order_number"' } },
      { text: 'Valida que no queden nulos en columnas obligatorias; si los hay, el job falla.', code: { file: 'backend/glue/silver_facts.py', highlight: 'def assert_no_nulls' } },
      { text: 'Purga la carpeta y escribe Parquet (ventas particionado por order_year), actualizando el catálogo.', code: { file: 'backend/glue/silver_facts.py', highlight: 'def write_silver' } },
    ],
    rules: ['Solo arranca si la compuerta de dependencias pasó.', 'Idempotente: purga antes de escribir, el sink de Glue solo agrega archivos.', 'Timeout de 15 min y 2 workers G.1X para acotar el costo.'],
    why: 'Spark divide los datos en particiones y las procesa en paralelo en varios workers. El mismo script sirve para 56 mil o para miles de millones de filas.',
    files: ['backend/glue/silver_facts.py', 'infra/stacks/pipeline.py'],
    summary: (s) => ({
      head: ['Dataset', 'Estado', 'Filas Silver', 'Última ejecución'],
      rows: s.datasets.filter((d) => d.engine === 'glue').map((d) => [d.name, DS_STATUS[d.status], d.rows.silver ?? '—', d.run?.stages.silver?.status ?? '—']),
    }),
  },
  {
    id: 'gold', layer: 'gold', title: 'Gold · modelo de negocio', engine: 'Athena CTAS (SQL) desde Lambda + awswrangler', engineKind: 'athena',
    flow: [['s3', 'S3 silver', 'tablas limpias'], ['athena', 'Athena', 'CTAS · 10 modelos SQL'], ['s3', 'S3 gold', 'modelo estrella'], ['glue', 'Glue Catalog', 'datalake_gold']],
    goal: 'Construir el modelo que consumen analistas y dashboards: dimensiones, hechos y agregados ya calculados. La lógica está escrita en SQL y cada modelo declara en su propio SQL de qué tablas depende.',
    steps: [
      { text: 'Lee del SQL de cada modelo qué tablas Silver y qué modelos Gold necesita.', code: { file: 'backend/common/gold_models.py', highlight: 'def parse_dependencies' } },
      { text: 'Valida ANTES de tocar nada: todo debe estar al día; si no, falla y lo explica.', code: { file: 'backend/lambdas/gold/handler.py', highlight: 'def plan_models' } },
      { text: 'Borra la tabla anterior y su carpeta (un CTAS exige carpeta vacía) y ejecuta CREATE TABLE AS SELECT.', code: { file: 'backend/lambdas/gold/handler.py', highlight: 'wr.athena.start_query_execution' } },
      { text: 'fact_sales queda particionada por año y con ingreso, costo y utilidad precalculados.', code: { file: 'backend/sql/gold/05_fact_sales.sql', highlight: 'partitioned_by' } },
    ],
    rules: ['Re-ejecutable: DROP + CTAS.', 'El workgroup corta consultas de más de 10 GB (control de costo).'],
    why: 'El SQL lo puede leer y modificar un analista, Athena escala solo y no hay servidores. Es ELT: transformar donde ya está el dato.',
    files: ['backend/lambdas/gold/handler.py', 'backend/common/gold_models.py', 'backend/sql/gold/01_dim_product.sql', 'backend/sql/gold/05_fact_sales.sql', 'backend/sql/gold/07_sales_monthly_by_category.sql'],
    summary: (s) => ({
      head: ['Modelo Gold', 'Lee de Silver', 'Lee de Gold', 'Estado'],
      rows: s.gold.map((g) => [g.name, g.silverDeps.join(', ') || '—', g.goldDeps.join(', ') || '—', { not_built: 'Sin construir', stale: 'Desactualizado', ok: 'Al día' }[g.status]]),
    }),
  },
];

/** Archivo de código de cada dataset en Silver (para abrir desde el mapa de Operar). */
export const silverCodeFor = (engine: 'pandas' | 'glue') =>
  engine === 'glue' ? ['backend/glue/silver_facts.py'] : ['backend/lambdas/silver_dimensions/handler.py', 'backend/common/transforms.py'];

export const goldSqlFile = (name: string, files: string[]) => files.find((f) => f.endsWith(`_${name}.sql`));
