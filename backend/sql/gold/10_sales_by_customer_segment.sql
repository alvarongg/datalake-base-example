-- GOLD · sales_by_customer_segment
-- Agregado: ventas por rango de edad e ingreso del cliente.
-- Plantilla: {gold_db}, {silver_db} y {location} los reemplaza la Lambda 'gold'.
CREATE TABLE "{gold_db}"."sales_by_customer_segment"
WITH (format = 'PARQUET', write_compression = 'SNAPPY', external_location = '{location}') AS
SELECT
    c.age_band,
    c.income_band,
    COUNT(DISTINCT c.customer_key) AS customers,
    SUM(f.order_quantity)          AS units,
    ROUND(SUM(f.revenue), 2)       AS revenue,
    ROUND(SUM(f.revenue) / COUNT(DISTINCT c.customer_key), 2) AS revenue_per_customer
FROM "{gold_db}"."fact_sales"   f
JOIN "{gold_db}"."dim_customer" c ON c.customer_key = f.customer_key
GROUP BY c.age_band, c.income_band
