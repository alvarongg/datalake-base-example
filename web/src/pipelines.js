// Fichas de la pestaña "Pipelines": una por cada etapa del pipeline de un dataset
// (más Gold). `summary(state)` extrae del estado de la API lo que se muestra.

const DS_STATUS = {
  no_file: 'Sin archivo', pending: 'Sin procesar', bronze: 'Solo Bronze', stale: 'Desactualizada', ok: 'Al día',
};
const stage = (d, name) => d.run?.stages?.[name];

export const PIPELINES = [
  {
    id: 'bronze', title: 'Bronze · ingesta cruda', engine: 'Lambda + awswrangler',
    flow: [['s3', 'S3 landing', 'CSV del dataset'], ['lambda', 'Lambda', 'pandas + awswrangler'], ['s3', 'S3 bronze', 'Parquet'], ['glue', 'Glue Catalog', 'datalake_bronze']],
    goal: 'Guardar el dato exactamente como llegó, sin interpretarlo, en un formato eficiente y consultable. Se ejecuta por dataset: cada extracción dispara su propia carga y no depende de ninguna otra tabla.',
    steps: [
      'Verifica que estén todos los CSV del dataset en landing; si falta alguno falla con la lista de faltantes.',
      'Lee cada CSV como texto (dtype=str) con su encoding: clientes viene en latin-1.',
      'Pasa los nombres de columna a snake_case (ProductSKU → product_sku).',
      'Agrega _source_file y _ingested_at para saber de dónde y cuándo salió cada fila.',
      'Escribe Parquet con Snappy en el bucket bronze y registra la tabla en Glue (modo overwrite).',
      'Anota en el control con qué versión del archivo se cargó (huella de los ETag de S3).',
    ],
    rules: ['Los valores no se tocan: fechas y números siguen siendo texto.', 'Idempotente: ejecutar dos veces deja el mismo resultado.', 'Subir un archivo distinto cambia su versión y deja Silver desactualizado.'],
    why: 'awswrangler escribe Parquet y crea la tabla en el catálogo con una sola llamada. Para copiar archivos pequeños no se justifica un clúster.',
    code: 'backend/lambdas/bronze/handler.py',
    snippet: `raw = wr.s3.read_csv(uri, dtype=str, keep_default_na=False, encoding=ds.encoding)
bronze_df = to_bronze(raw, source_file=filename, ingested_at=ingested_at)

wr.s3.to_parquet(df=bronze_df, path=settings.table_uri("bronze", ds.name),
                 dataset=True, mode="overwrite",
                 database=settings.bronze_db, table=ds.name)
store.record_bronze(ds.name, version, len(bronze_df))   # lineage: qué versión se cargó`,
    summary: (s) => ({
      head: ['Dataset', 'Filas en Bronze', 'Última ejecución'],
      rows: s.datasets.map((d) => [d.name, d.rows.bronze ?? '—', stage(d, 'bronze')?.status ?? '—']),
    }),
  },
  {
    id: 'deps', title: 'Dependencias · la compuerta', engine: 'Lambda (control de versiones)',
    flow: [['s3', 'Control', 'versiones en S3'], ['lambda', 'Lambda', 'CheckDependencies'], ['stepFunctions', 'Step Functions', 'falla o continúa']],
    goal: 'Un pipeline real no transforma una tabla hija si sus tablas padre no están al día. Esta compuerta corre entre Bronze y Silver y hace que la ejecución FALLE con el motivo exacto cuando una dependencia está pendiente o desactualizada.',
    steps: [
      'Calcula el estado de cada dataset: al día, desactualizado, solo Bronze, sin procesar o sin archivo.',
      'Mira solo las dependencias directas del dataset (ej. products necesita product_subcategories).',
      'Cada dependencia debe estar "al día": Silver construido con el archivo actual y con la última versión de SUS propias dependencias.',
      'Si alguna no cumple, lanza DependencyError y la ejecución termina en FAILED explicando cuál y por qué.',
      'Si todas cumplen, registra con qué versión de cada una se construirá Silver (lineage).',
    ],
    rules: ['Reprocesar una tabla padre deja desactualizadas a todas las hijas.', 'Procesar "con dependencias" las ordena y exige que estén TODOS sus archivos.', 'Procesar un dataset "solo" demuestra el fallo cuando falta una dependencia.'],
    why: 'Es la diferencia entre un script que transforma archivos y un pipeline de datos: la corrección no depende de que alguien recuerde el orden.',
    code: 'backend/lambdas/dependencies/handler.py · backend/common/control.py',
    snippet: `problems = check_dependencies(ds.name, state.statuses)
if problems:
    raise DependencyError(ds.name, problems)
# -> "products no se puede procesar: product_subcategories nunca se procesó (no está en Bronze)"
built_from = {d: silver_token(state.controls[d]) for d in ds.depends_on}`,
    summary: (s) => ({
      head: ['Dataset', 'Depende de', 'Resultado de la compuerta'],
      rows: s.datasets.filter((d) => d.dependsOn.length).map((d) => {
        const st = stage(d, 'dependencies');
        return [d.name, d.dependsOn.join(', '), st ? (st.status === 'failed' ? `✖ ${st.error}` : st.status) : '—'];
      }),
    }),
  },
  {
    id: 'silver-pandas', title: 'Silver · tablas pequeñas', engine: 'Lambda + pandas',
    flow: [['s3', 'S3 bronze', 'Parquet crudo'], ['lambda', 'Lambda', 'pandas'], ['s3', 'S3 silver', 'Parquet tipado'], ['glue', 'Glue Catalog', 'datalake_silver']],
    goal: 'Limpiar y tipar las tablas pequeñas (clientes, productos, categorías, territorios, calendario). Caben en memoria, así que pandas es lo más simple y barato.',
    steps: [
      'Lee la tabla Bronze y descarta las columnas de auditoría.',
      'Convierte tipos: fechas M/D/YYYY → date, claves → entero, precios → decimal.',
      'Normaliza texto: nombres en Title Case, emails en minúsculas, vacíos → NULL.',
      '"$90,000 " → 90000.0 y "0" en talla/estilo de producto → NULL.',
      'Calendario: deriva año, trimestre, mes, nombre de mes, día de la semana, fin de semana.',
      'Elimina duplicados por clave y exige que la clave primaria no sea nula.',
      'El paso RecordSilver anota el token de esta construcción: las tablas hijas lo usarán para saber si siguen al día.',
    ],
    rules: ['Clave nula = el pipeline falla (no se publican datos dudosos).', 'Cada tabla informa filas de entrada, de salida y duplicados quitados.'],
    why: 'La lógica son funciones puras DataFrame → DataFrame en common/transforms.py, con tests locales sin credenciales.',
    code: 'backend/lambdas/silver_dimensions/handler.py · backend/common/transforms.py',
    snippet: `"annual_income": _to_float(df["annual_income"].str.replace(r"[$,\\s]", "", regex=True)),
"product_size":  _blank_to_na(df["product_size"]).mask(lambda s: s == "0"),
...
_require_not_null(out, ["customer_key"], "customers")
out, dups = _dedupe(out, ["customer_key"])`,
    summary: (s) => ({
      head: ['Dataset', 'Estado', 'Filas Silver', 'Duplicados quitados'],
      rows: s.datasets.filter((d) => d.engine === 'pandas').map((d) => [d.name, DS_STATUS[d.status], d.rows.silver ?? '—', stage(d, 'silver')?.duplicates ?? '—']),
    }),
  },
  {
    id: 'silver-glue', title: 'Silver · hechos grandes', engine: 'AWS Glue (Spark)',
    flow: [['s3', 'S3 bronze', 'ventas o devoluciones'], ['glue', 'Glue Job', 'Spark 3 · 2 workers'], ['s3', 'S3 silver', 'particionado por año'], ['glue', 'Glue Catalog', 'datalake_silver']],
    goal: 'Procesar las tablas que crecen sin límite (ventas y devoluciones). Spark reparte el trabajo en varios nodos: el mismo script sirve para 56 mil o para miles de millones de filas. Cada dataset es una ejecución distinta del mismo job (parámetro --dataset).',
    steps: [
      'Lee la tabla Bronze a través del Glue Data Catalog.',
      'Convierte fechas con to_date y claves/cantidades a entero.',
      'Descarta líneas con cantidad no positiva (no son ventas).',
      'Deduplica por clave natural (order_number + order_line_item).',
      'Valida que no queden nulos en columnas obligatorias; si los hay, el job falla.',
      'Purga la carpeta destino y escribe Parquet (ventas particionado por order_year), actualizando el catálogo.',
    ],
    rules: ['Solo arranca si la compuerta de dependencias pasó: sales necesita products, customers, territories y calendar al día.', 'Idempotente: purga antes de escribir, el sink de Glue solo agrega archivos.', 'Timeout de 15 min y 2 workers G.1X para acotar el costo.'],
    why: 'Es el escenario "grande": arranca en 1-2 minutos por el inicio de Spark, a cambio escala horizontalmente sin cambiar código.',
    code: 'backend/glue/silver_facts.py',
    snippet: `out = (raw.select(F.trim("order_number"), to_date("order_date"), ...)
          .filter(F.col("order_quantity") > 0)
          .dropDuplicates(["order_number", "order_line_item"])
          .withColumn("order_year", F.year("order_date")))
assert_no_nulls(out, ["order_number", "order_date", "product_key"], "sales")
write_silver(out, "sales", partition_keys=["order_year"])`,
    summary: (s) => ({
      head: ['Dataset', 'Estado', 'Filas Silver', 'Última ejecución'],
      rows: s.datasets.filter((d) => d.engine === 'glue').map((d) => [d.name, DS_STATUS[d.status], d.rows.silver ?? '—', stage(d, 'silver')?.status ?? '—']),
    }),
  },
  {
    id: 'gold', title: 'Gold · modelo de negocio', engine: 'Athena CTAS (SQL) vía awswrangler',
    flow: [['s3', 'S3 silver', 'tablas limpias'], ['athena', 'Athena', 'CTAS · 10 modelos SQL'], ['s3', 'S3 gold', 'modelo estrella'], ['glue', 'Glue Catalog', 'datalake_gold']],
    goal: 'Construir el modelo que consumen analistas y dashboards: dimensiones, hechos y agregados ya calculados. Se pueden construir todos los modelos o solo algunos; cada modelo declara en su propio SQL de qué tablas depende.',
    steps: [
      'Lee del SQL de cada modelo qué tablas Silver y qué otros modelos Gold necesita.',
      'Valida ANTES de tocar nada: toda tabla Silver debe estar al día y todo modelo Gold padre debe estar construido; si no, falla y lo explica.',
      'Borra la tabla anterior y su carpeta en S3 (un CTAS exige carpeta vacía).',
      'Ejecuta CREATE TABLE AS SELECT en Athena y espera a que termine.',
      'Registra con qué versiones de sus insumos se construyó: si luego cambian, el modelo queda desactualizado.',
    ],
    rules: ['Re-ejecutable: DROP + CTAS.', 'El workgroup corta consultas de más de 10 GB (control de costo).', 'fact_sales sale particionada por año y con ingreso, costo y utilidad precalculados.'],
    why: 'El SQL lo puede leer y modificar un analista, Athena escala solo y no hay servidores. Es ELT: transformar donde ya está el dato.',
    code: 'backend/lambdas/gold/handler.py · backend/sql/gold/*.sql',
    snippet: `to_build, blocked = plan_models(requested, models, state.statuses, state.gold_statuses)
if blocked:
    raise DependencyError(first, blocked[first])      # falla ANTES de modificar nada
wr.catalog.delete_table_if_exists(database=settings.gold_db, table=model.name)
wr.athena.start_query_execution(sql=sql, database=settings.gold_db, wait=True)`,
    summary: (s) => ({
      head: ['Modelo Gold', 'Lee de Silver', 'Lee de Gold', 'Estado'],
      rows: s.gold.map((g) => [g.name, g.silverDeps.join(', ') || '—', g.goldDeps.join(', ') || '—',
        { not_built: 'Sin construir', stale: 'Desactualizado', ok: 'Al día' }[g.status]]),
    }),
  },
];
