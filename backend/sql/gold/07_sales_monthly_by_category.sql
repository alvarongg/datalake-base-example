-- GOLD · sales_monthly_by_category
-- Agregado: ventas por mes y categoría (alimenta gráficos de tendencia).
-- Plantilla: {gold_db}, {silver_db} y {location} los reemplaza la Lambda 'gold'.
CREATE TABLE "{gold_db}"."sales_monthly_by_category"
WITH (format = 'PARQUET', write_compression = 'SNAPPY', external_location = '{location}') AS
SELECT
    d.year_month,
    p.category_name,
    COUNT(DISTINCT f.order_number) AS orders,
    SUM(f.order_quantity)          AS units,
    ROUND(SUM(f.revenue), 2)       AS revenue,
    ROUND(SUM(f.profit), 2)        AS profit,
    ROUND(100.0 * SUM(f.profit) / NULLIF(SUM(f.revenue), 0), 2) AS margin_pct
FROM "{gold_db}"."fact_sales" f
JOIN "{gold_db}"."dim_date"    d ON d.date_key    = f.order_date
JOIN "{gold_db}"."dim_product" p ON p.product_key = f.product_key
GROUP BY d.year_month, p.category_name
