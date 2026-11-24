-- GOLD · sales_by_territory
-- Agregado: ventas por territorio y año.
-- Plantilla: {gold_db}, {silver_db} y {location} los reemplaza la Lambda 'gold'.
CREATE TABLE "{gold_db}"."sales_by_territory"
WITH (format = 'PARQUET', write_compression = 'SNAPPY', external_location = '{location}') AS
SELECT
    t.continent,
    t.country,
    t.region,
    d.year,
    SUM(f.order_quantity)    AS units,
    ROUND(SUM(f.revenue), 2) AS revenue,
    ROUND(SUM(f.profit), 2)  AS profit
FROM "{gold_db}"."fact_sales"    f
JOIN "{gold_db}"."dim_territory" t ON t.territory_key = f.territory_key
JOIN "{gold_db}"."dim_date"      d ON d.date_key      = f.order_date
GROUP BY t.continent, t.country, t.region, d.year
