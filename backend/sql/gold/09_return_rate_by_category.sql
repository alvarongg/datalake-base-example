-- GOLD · return_rate_by_category
-- Agregado: tasa de devolución (unidades devueltas / vendidas) por categoría.
-- Plantilla: {gold_db}, {silver_db} y {location} los reemplaza la Lambda 'gold'.
CREATE TABLE "{gold_db}"."return_rate_by_category"
WITH (format = 'PARQUET', write_compression = 'SNAPPY', external_location = '{location}') AS
WITH sold AS (
    SELECT p.category_name, SUM(f.order_quantity) AS units_sold
    FROM "{gold_db}"."fact_sales" f
    JOIN "{gold_db}"."dim_product" p ON p.product_key = f.product_key
    GROUP BY p.category_name
),
returned AS (
    SELECT p.category_name, SUM(r.return_quantity) AS units_returned
    FROM "{gold_db}"."fact_returns" r
    JOIN "{gold_db}"."dim_product" p ON p.product_key = r.product_key
    GROUP BY p.category_name
)
SELECT
    s.category_name,
    s.units_sold,
    COALESCE(r.units_returned, 0) AS units_returned,
    ROUND(100.0 * COALESCE(r.units_returned, 0) / NULLIF(s.units_sold, 0), 2) AS return_rate_pct
FROM sold s
LEFT JOIN returned r ON r.category_name = s.category_name
