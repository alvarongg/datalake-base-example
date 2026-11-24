-- GOLD · dim_date
-- Dimensión de fecha (calendario ya enriquecido en Silver).
-- Plantilla: {gold_db}, {silver_db} y {location} los reemplaza la Lambda 'gold'.
CREATE TABLE "{gold_db}"."dim_date"
WITH (format = 'PARQUET', write_compression = 'SNAPPY', external_location = '{location}') AS
SELECT date AS date_key, year, quarter, month, month_name, year_month, day, day_of_week, is_weekend
FROM "{silver_db}"."calendar"
