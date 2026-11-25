// Textos didácticos y consultas de ejemplo. Se mantienen separados de la lógica
// para que un ingeniero pueda editar la explicación sin tocar código.

export const LAYERS: { id: 'landing' | 'bronze' | 'silver' | 'gold'; title: string; tag: string; text: string }[] = [
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

export const EXAMPLE_QUERIES: { title: string; sql: string }[] = [
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
 * Modelo de datos: por qué el modelo Gold es más rápido que el original.
 * -------------------------------------------------------------------- */
export const OPTIMIZATIONS: [string, string, string][] = [
  ['De copo de nieve a estrella', 'Para obtener la categoría de una venta el modelo original encadena 3 joins (Products → Subcategories → Categories). dim_product viene desnormalizada: 1 join.', 'Menos joins'],
  ['Medidas precalculadas', 'fact_sales guarda revenue, cost y profit ya multiplicados. Las consultas suman una columna en vez de calcular cantidad × precio en cada ejecución.', 'Menos cómputo'],
  ['Particionado por año', 'fact_sales está particionada por order_year. Con WHERE order_year = 2016 Athena solo lee esa carpeta (partition pruning).', 'Menos bytes leídos'],
  ['Parquet columnar + Snappy', 'Los CSV obligan a leer todas las columnas como texto. Parquet lee solo las columnas que usa la consulta y comprime.', 'Menos bytes leídos'],
  ['Tipos correctos', 'Claves enteras, fechas DATE y decimales en vez de texto: joins y filtros más baratos y sin CAST.', 'Menos cómputo'],
  ['Atributos derivados', 'age_band, income_band, year_month, category_name ya existen como columnas; no hace falta aplicar funciones en cada consulta.', 'Consultas más simples'],
  ['Agregados para dashboards', 'sales_monthly_by_category y otras tablas precalculan los totales típicos: una consulta de BI lee unas pocas filas.', 'Respuesta casi instantánea'],
];

// Mismo resultado (ingresos por categoría en 2016) con tres modelos distintos.
export const BENCHMARKS: { id: string; label: string; joins: number; sql: string }[] = [
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

/* ----------------------------------------------------------------------
 * Dashboard: un panel por consulta, cada uno con su gráfico.
 * type: kpi | bar | hbar | line | donut | table   ·   wide: ocupa dos columnas
 * Todas leen la capa Gold (el modelo pensado para consumo).
 * -------------------------------------------------------------------- */
export type ChartType = 'kpi' | 'bar' | 'hbar' | 'line' | 'donut' | 'table';
export const DASHBOARD_PANELS: { id: string; title: string; type: ChartType; wide?: boolean; sql: string }[] = [
  {
    id: 'kpi', title: 'Resumen del negocio', type: 'kpi', wide: true,
    sql: `SELECT ROUND(SUM(revenue), 0) AS revenue,
       ROUND(SUM(profit), 0)  AS profit,
       SUM(order_quantity)    AS units,
       COUNT(DISTINCT order_number) AS orders
FROM datalake_gold.fact_sales`,
  },
  {
    id: 'trend', title: 'Ingresos y utilidad por mes', type: 'line', wide: true,
    sql: `SELECT year_month,
       ROUND(SUM(revenue), 0) AS revenue,
       ROUND(SUM(profit), 0)  AS profit
FROM datalake_gold.sales_monthly_by_category
GROUP BY year_month
ORDER BY year_month`,
  },
  {
    id: 'category', title: 'Ingresos por categoría', type: 'donut',
    sql: `SELECT category_name, ROUND(SUM(revenue), 0) AS revenue
FROM datalake_gold.sales_monthly_by_category
GROUP BY category_name
ORDER BY revenue DESC`,
  },
  {
    id: 'country', title: 'Ingresos por país', type: 'bar',
    sql: `SELECT country, ROUND(SUM(revenue), 0) AS revenue
FROM datalake_gold.sales_by_territory
GROUP BY country
ORDER BY revenue DESC`,
  },
  {
    id: 'products', title: 'Top 10 productos por utilidad', type: 'hbar',
    sql: `SELECT p.product_name, ROUND(SUM(f.profit), 0) AS profit
FROM datalake_gold.fact_sales f
JOIN datalake_gold.dim_product p ON p.product_key = f.product_key
GROUP BY p.product_name
ORDER BY profit DESC
LIMIT 10`,
  },
  {
    id: 'returns', title: 'Tasa de devolución por categoría (%)', type: 'bar',
    sql: `SELECT category_name, return_rate_pct
FROM datalake_gold.return_rate_by_category
ORDER BY return_rate_pct DESC`,
  },
  {
    id: 'age', title: 'Ingresos por rango de edad', type: 'bar',
    sql: `SELECT age_band, ROUND(SUM(revenue), 0) AS revenue
FROM datalake_gold.sales_by_customer_segment
GROUP BY age_band
ORDER BY age_band`,
  },
  {
    id: 'income', title: 'Ingresos por nivel de ingreso del cliente', type: 'donut',
    sql: `SELECT income_band, ROUND(SUM(revenue), 0) AS revenue
FROM datalake_gold.sales_by_customer_segment
GROUP BY income_band
ORDER BY revenue DESC`,
  },
];
