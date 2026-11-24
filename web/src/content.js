// Textos didácticos y consultas de ejemplo. Se mantienen separados de la lógica
// para que un ingeniero pueda editar la explicación sin tocar código.

export const LAYERS = [
  {
    id: 'landing',
    title: 'Landing',
    tag: 'CSV originales',
    text: 'Zona de aterrizaje. Aquí queda el archivo EXACTAMENTE como lo subió el usuario. Nunca se modifica: es la fuente de verdad para reprocesar.',
  },
  {
    id: 'bronze',
    title: 'Bronze',
    tag: 'Crudo + auditoría',
    text: 'Se lee cada CSV como texto (sin interpretar) y se guarda en Parquet con dos columnas extra: _source_file y _ingested_at. Se registra en el catálogo de Glue para poder consultarlo. Herramienta: Lambda + awswrangler.',
  },
  {
    id: 'silver',
    title: 'Silver',
    tag: 'Limpio y tipado',
    text: 'Se convierten tipos (fechas, números), se estandarizan textos, se eliminan duplicados y se validan claves. Tablas chicas: Lambda + pandas. Tablas grandes (ventas, devoluciones): job de Spark en AWS Glue.',
  },
  {
    id: 'gold',
    title: 'Gold',
    tag: 'Listo para negocio',
    text: 'Modelo dimensional (dimensiones y hechos) y agregados ya calculados, definidos en SQL. Se materializan con CTAS de Athena. Es lo que consumen analistas y dashboards.',
  },
];

// Pasos de Step Functions -> explicación mostrada durante la ejecución.
export const STEPS = [
  { name: 'Bronze', label: 'Bronze · Lambda (pandas + awswrangler)', hint: 'Copia cruda a Parquet con auditoría.' },
  { name: 'SilverDimensions', label: 'Silver · dimensiones · Lambda (pandas)', hint: 'Limpia clientes, productos, calendario, territorios y categorías.', indent: true },
  { name: 'SilverFacts', label: 'Silver · hechos · AWS Glue (Spark)', hint: 'Tipa y deduplica ventas y devoluciones (tarda 1-2 min por el arranque de Spark).', indent: true },
  { name: 'Gold', label: 'Gold · Athena CTAS (awswrangler + SQL)', hint: 'Crea dimensiones, hechos y agregados de negocio.' },
];

export const EXAMPLE_QUERIES = [
  {
    title: 'Ingresos y margen por categoría',
    sql: `SELECT category_name,
       ROUND(SUM(revenue), 0) AS revenue,
       ROUND(SUM(profit), 0)  AS profit
FROM datalake_gold.sales_monthly_by_category
GROUP BY category_name
ORDER BY revenue DESC`,
  },
  {
    title: 'Ventas por país y año',
    sql: `SELECT country, year, units, revenue
FROM datalake_gold.sales_by_territory
ORDER BY revenue DESC
LIMIT 20`,
  },
  {
    title: 'Tasa de devolución por categoría',
    sql: `SELECT * FROM datalake_gold.return_rate_by_category
ORDER BY return_rate_pct DESC`,
  },
  {
    title: 'Top 10 productos por utilidad',
    sql: `SELECT p.product_name, p.category_name, ROUND(SUM(f.profit), 0) AS profit
FROM datalake_gold.fact_sales f
JOIN datalake_gold.dim_product p ON p.product_key = f.product_key
GROUP BY p.product_name, p.category_name
ORDER BY profit DESC
LIMIT 10`,
  },
  {
    title: 'Bronze (texto) vs Silver (fecha tipada)',
    sql: `SELECT b.order_date AS bronze_texto,
       s.order_date AS silver_fecha
FROM datalake_bronze.sales b
JOIN datalake_silver.sales s
  ON s.order_number = b.order_number
 AND CAST(s.order_line_item AS varchar) = b.order_line_item
LIMIT 5`,
  },
  {
    title: 'Bronze: auditoría de origen',
    sql: `SELECT _source_file, COUNT(*) AS rows
FROM datalake_bronze.sales
GROUP BY _source_file
ORDER BY _source_file`,
  },
];

/* ----------------------------------------------------------------------
 * Pipelines: una ficha por cada paso del Step Functions.
 * `stepName` coincide con el nombre del estado en la máquina de estados.
 * `summary(output)` extrae de la salida de la última ejecución lo que se muestra.
 * -------------------------------------------------------------------- */
const findBranch = (out, key) => (out?.silver ?? []).find((b) => b?.[key])?.[key];

export const PIPELINES = [
  {
    id: 'bronze', stepName: 'Bronze', title: 'Bronze · ingesta cruda', engine: 'Lambda + awswrangler',
    flow: [['s3', 'S3 landing', '10 CSV'], ['lambda', 'Lambda', 'pandas + awswrangler'], ['s3', 'S3 bronze', 'Parquet'], ['glue', 'Glue Catalog', 'datalake_bronze']],
    goal: 'Guardar el dato exactamente como llegó, sin interpretarlo, en un formato eficiente y consultable. Si algo falla más adelante, siempre se puede reprocesar desde aquí.',
    steps: [
      'Verifica que estén los 10 CSV en landing; si falta alguno falla con la lista de faltantes.',
      'Lee cada CSV como texto (dtype=str) con su encoding: clientes viene en latin-1.',
      'Pasa los nombres de columna a snake_case (ProductSKU → product_sku).',
      'Agrega _source_file y _ingested_at para saber de dónde y cuándo salió cada fila.',
      'Une los tres CSV de ventas (2015-2017) en una sola tabla.',
      'Escribe Parquet con Snappy en el bucket bronze y registra la tabla en Glue (modo overwrite).',
    ],
    rules: ['Los valores no se tocan: fechas y números siguen siendo texto.', 'Idempotente: ejecutar dos veces deja el mismo resultado.'],
    why: 'awswrangler escribe Parquet y crea la tabla en el catálogo con una sola llamada. Para copiar archivos pequeños no se justifica un clúster.',
    code: 'backend/lambdas/bronze/handler.py',
    snippet: `raw = wr.s3.read_csv(uri, dtype=str, keep_default_na=False, encoding=ds.encoding)
bronze_df = to_bronze(raw, source_file=filename, ingested_at=ingested_at)

wr.s3.to_parquet(df=bronze_df, path=settings.table_uri("bronze", ds.name),
                 dataset=True, mode="overwrite",
                 database=settings.bronze_db, table=ds.name)`,
    summary: (out) => ({
      head: ['Tabla Bronze', 'Filas'],
      rows: (out?.bronze?.tables ?? []).map((t) => [t.table, t.rows]),
    }),
  },
  {
    id: 'silver-pandas', stepName: 'SilverDimensions', title: 'Silver · dimensiones', engine: 'Lambda + pandas',
    flow: [['s3', 'S3 bronze', 'Parquet crudo'], ['lambda', 'Lambda', 'pandas'], ['s3', 'S3 silver', 'Parquet tipado'], ['glue', 'Glue Catalog', 'datalake_silver']],
    goal: 'Limpiar y tipar las tablas pequeñas (clientes, productos, categorías, territorios, calendario). Caben en memoria, así que pandas es lo más simple y barato.',
    steps: [
      'Lee la tabla Bronze y descarta las columnas de auditoría.',
      'Convierte tipos: fechas M/D/YYYY → date, claves → entero, precios → decimal.',
      'Normaliza texto: nombres en Title Case, emails en minúsculas, vacíos → NULL.',
      '"$90,000 " → 90000.0 y "0" en talla/estilo de producto → NULL.',
      'Calendario: deriva año, trimestre, mes, nombre de mes, día de la semana, fin de semana.',
      'Elimina duplicados por clave y exige que la clave primaria no sea nula.',
    ],
    rules: ['Clave nula = el pipeline falla (no se publican datos dudosos).', 'Cada tabla informa filas de entrada, de salida y duplicados quitados.'],
    why: 'La lógica son funciones puras DataFrame → DataFrame en common/transforms.py, con tests locales sin credenciales.',
    code: 'backend/lambdas/silver_dimensions/handler.py · backend/common/transforms.py',
    snippet: `"annual_income": _to_float(df["annual_income"].str.replace(r"[$,\\s]", "", regex=True)),
"product_size":  _blank_to_na(df["product_size"]).mask(lambda s: s == "0"),
...
_require_not_null(out, ["customer_key"], "customers")
out, dups = _dedupe(out, ["customer_key"])`,
    summary: (out) => ({
      head: ['Tabla Silver', 'Filas entrada', 'Filas salida', 'Duplicados'],
      rows: (findBranch(out, 'silver_dimensions')?.tables ?? []).map((t) => [t.table, t.rows_in, t.rows_out, t.duplicates_removed]),
    }),
  },
  {
    id: 'silver-glue', stepName: 'SilverFacts', title: 'Silver · hechos', engine: 'AWS Glue (Spark)',
    flow: [['s3', 'S3 bronze', 'ventas, devoluciones'], ['glue', 'Glue Job', 'Spark 3 · 2 workers'], ['s3', 'S3 silver', 'particionado por año'], ['glue', 'Glue Catalog', 'datalake_silver']],
    goal: 'Procesar las tablas que crecen sin límite (ventas y devoluciones). Spark reparte el trabajo en varios nodos: el mismo script sirve para 56 mil o para miles de millones de filas.',
    steps: [
      'Lee las tablas Bronze a través del Glue Data Catalog.',
      'Convierte fechas con to_date y claves/cantidades a entero.',
      'Descarta líneas con cantidad no positiva (no son ventas).',
      'Deduplica por clave natural (order_number + order_line_item).',
      'Valida que no queden nulos en columnas obligatorias; si los hay, el job falla.',
      'Purga la carpeta destino y escribe Parquet particionado por order_year, actualizando el catálogo.',
    ],
    rules: ['Idempotente: purga antes de escribir, el sink de Glue solo agrega archivos.', 'Timeout de 15 min y 2 workers G.1X para acotar el costo.'],
    why: 'Es el escenario "grande": arranca en 1-2 minutos por el inicio de Spark, a cambio escala horizontalmente sin cambiar código.',
    code: 'backend/glue/silver_facts.py',
    snippet: `out = (raw.select(F.trim("order_number"), to_date("order_date"), ...)
          .filter(F.col("order_quantity") > 0)
          .dropDuplicates(["order_number", "order_line_item"])
          .withColumn("order_year", F.year("order_date")))
assert_no_nulls(out, ["order_number", "order_date", "product_key"], "sales")
write_silver(out, "sales", partition_keys=["order_year"])`,
    summary: (out) => {
      const r = findBranch(out, 'silver_facts');
      return { head: ['Job de Glue', 'Estado', 'Segundos', 'Run ID'], rows: r ? [['datalake-demo-silver-facts', r.state, r.seconds, r.job_run_id]] : [] };
    },
  },
  {
    id: 'gold', stepName: 'Gold', title: 'Gold · modelo de negocio', engine: 'Athena CTAS (SQL) vía awswrangler',
    flow: [['s3', 'S3 silver', 'tablas limpias'], ['athena', 'Athena', 'CTAS · 10 modelos SQL'], ['s3', 'S3 gold', 'modelo estrella'], ['glue', 'Glue Catalog', 'datalake_gold']],
    goal: 'Construir el modelo que consumen analistas y dashboards: dimensiones, hechos y agregados ya calculados. La lógica está escrita en SQL, no en Python.',
    steps: [
      'Recorre backend/sql/gold/NN_nombre.sql en orden numérico (los agregados dependen de los hechos).',
      'Borra la tabla anterior y su carpeta en S3 (un CTAS exige carpeta vacía).',
      'Renderiza la plantilla con los nombres reales de bases y buckets.',
      'Ejecuta CREATE TABLE AS SELECT en Athena y espera a que termine; si falla, falla el pipeline.',
      'fact_sales sale particionada por año y con ingreso, costo y utilidad precalculados.',
    ],
    rules: ['Re-ejecutable: DROP + CTAS.', 'El workgroup corta consultas de más de 10 GB (control de costo).'],
    why: 'El SQL lo puede leer y modificar un analista, Athena escala solo y no hay servidores. Es ELT: transformar donde ya está el dato.',
    code: 'backend/lambdas/gold/handler.py · backend/sql/gold/*.sql',
    snippet: `wr.catalog.delete_table_if_exists(database=settings.gold_db, table=table)
wr.s3.delete_objects(location)
sql = sql_path.read_text().format(gold_db=..., silver_db=..., location=location)
wr.athena.start_query_execution(sql=sql, database=settings.gold_db,
                                workgroup=settings.athena_workgroup, wait=True)`,
    summary: (out) => ({ head: ['Tabla Gold creada'], rows: (out?.gold?.tables ?? []).map((t) => [t]) }),
  },
];

/* ----------------------------------------------------------------------
 * Modelo de datos: por qué el modelo Gold es más rápido que el original.
 * -------------------------------------------------------------------- */
export const OPTIMIZATIONS = [
  ['De copo de nieve a estrella', 'Para obtener la categoría de una venta el modelo original encadena 3 joins (Products → Subcategories → Categories). dim_product viene desnormalizada: 1 join.', 'Menos joins'],
  ['Medidas precalculadas', 'fact_sales guarda revenue, cost y profit ya multiplicados. Las consultas suman una columna en vez de calcular cantidad × precio en cada ejecución.', 'Menos cómputo'],
  ['Particionado por año', 'fact_sales está particionada por order_year. Con WHERE order_year = 2016 Athena solo lee esa carpeta (partition pruning).', 'Menos bytes leídos'],
  ['Parquet columnar + Snappy', 'Los CSV obligan a leer todas las columnas como texto. Parquet lee solo las columnas que usa la consulta y comprime.', 'Menos bytes leídos'],
  ['Tipos correctos', 'Claves enteras, fechas DATE y decimales en vez de texto: joins y filtros más baratos y sin CAST.', 'Menos cómputo'],
  ['Atributos derivados', 'age_band, income_band, year_month, category_name ya existen como columnas; no hace falta aplicar funciones en cada consulta.', 'Consultas más simples'],
  ['Agregados para dashboards', 'sales_monthly_by_category y otras tablas precalculan los totales típicos: una consulta de BI lee unas pocas filas.', 'Respuesta casi instantánea'],
];

// Mismo resultado (ingresos por categoría en 2016) con tres modelos distintos.
export const BENCHMARKS = [
  {
    id: 'original', label: 'Modelo original normalizado (Silver)', joins: 3,
    sql: `SELECT c.category_name, ROUND(SUM(s.order_quantity * p.product_price), 0) AS revenue
FROM datalake_silver.sales s
JOIN datalake_silver.products p ON p.product_key = s.product_key
JOIN datalake_silver.product_subcategories sc ON sc.product_subcategory_key = p.product_subcategory_key
JOIN datalake_silver.product_categories c ON c.product_category_key = sc.product_category_key
WHERE s.order_year = 2016
GROUP BY c.category_name
ORDER BY revenue DESC`,
  },
  {
    id: 'star', label: 'Modelo estrella (Gold: hecho + dimensión)', joins: 1,
    sql: `SELECT p.category_name, ROUND(SUM(f.revenue), 0) AS revenue
FROM datalake_gold.fact_sales f
JOIN datalake_gold.dim_product p ON p.product_key = f.product_key
WHERE f.order_year = 2016
GROUP BY p.category_name
ORDER BY revenue DESC`,
  },
  {
    id: 'aggregate', label: 'Tabla agregada (Gold)', joins: 0,
    sql: `SELECT category_name, ROUND(SUM(revenue), 0) AS revenue
FROM datalake_gold.sales_monthly_by_category
WHERE year_month LIKE '2016-%'
GROUP BY category_name
ORDER BY revenue DESC`,
  },
];
