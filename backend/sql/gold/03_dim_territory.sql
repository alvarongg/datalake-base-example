-- GOLD · dim_territory
-- Dimensión de territorio de venta.
-- Plantilla: {gold_db}, {silver_db} y {location} los reemplaza la Lambda 'gold'.
CREATE TABLE "{gold_db}"."dim_territory"
WITH (format = 'PARQUET', write_compression = 'SNAPPY', external_location = '{location}') AS
SELECT sales_territory_key AS territory_key, region, country, continent
FROM "{silver_db}"."territories"
