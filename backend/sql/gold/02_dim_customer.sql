-- GOLD · dim_customer
-- Dimensión de cliente con edad y rangos (edad calculada al 2017-06-30, fin del dataset).
-- Plantilla: {gold_db}, {silver_db} y {location} los reemplaza la Lambda 'gold'.
CREATE TABLE "{gold_db}"."dim_customer"
WITH (format = 'PARQUET', write_compression = 'SNAPPY', external_location = '{location}') AS
SELECT
    customer_key,
    full_name,
    gender,
    marital_status,
    birth_date,
    DATE_DIFF('year', birth_date, DATE '2017-06-30') AS age,
    CASE
        WHEN DATE_DIFF('year', birth_date, DATE '2017-06-30') < 30 THEN '<30'
        WHEN DATE_DIFF('year', birth_date, DATE '2017-06-30') < 45 THEN '30-44'
        WHEN DATE_DIFF('year', birth_date, DATE '2017-06-30') < 60 THEN '45-59'
        ELSE '60+'
    END AS age_band,
    annual_income,
    CASE
        WHEN annual_income < 40000  THEN 'Bajo'
        WHEN annual_income < 80000  THEN 'Medio'
        WHEN annual_income < 120000 THEN 'Alto'
        ELSE 'Muy alto'
    END AS income_band,
    total_children,
    education_level,
    occupation,
    home_owner
FROM "{silver_db}"."customers"
