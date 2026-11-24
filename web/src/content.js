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
