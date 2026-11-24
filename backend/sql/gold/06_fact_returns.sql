-- GOLD · fact_returns
-- Hecho de devoluciones con su valor estimado a precio de lista.
-- Plantilla: {gold_db}, {silver_db} y {location} los reemplaza la Lambda 'gold'.
CREATE TABLE "{gold_db}"."fact_returns"
WITH (format = 'PARQUET', write_compression = 'SNAPPY', external_location = '{location}') AS
SELECT
    r.return_date,
    r.territory_key,
    r.product_key,
    r.return_quantity,
    ROUND(r.return_quantity * p.product_price, 4) AS returned_revenue
FROM "{silver_db}"."returns" r
JOIN "{silver_db}"."products" p ON p.product_key = r.product_key
