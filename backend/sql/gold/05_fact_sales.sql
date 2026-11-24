-- GOLD · fact_sales
-- Hecho de ventas a nivel línea: cantidad x precio/costo del producto = ingreso, costo y utilidad.
-- Plantilla: {gold_db}, {silver_db} y {location} los reemplaza la Lambda 'gold'.
CREATE TABLE "{gold_db}"."fact_sales"
WITH (format = 'PARQUET', write_compression = 'SNAPPY', external_location = '{location}') AS
SELECT
    s.order_number,
    s.order_line_item,
    s.order_date,
    s.stock_date,
    s.product_key,
    s.customer_key,
    s.territory_key,
    s.order_quantity,
    p.product_price                                                 AS unit_price,
    p.product_cost                                                  AS unit_cost,
    ROUND(s.order_quantity * p.product_price, 4)                    AS revenue,
    ROUND(s.order_quantity * p.product_cost, 4)                     AS cost,
    ROUND(s.order_quantity * (p.product_price - p.product_cost), 4) AS profit
FROM "{silver_db}"."sales" s
JOIN "{silver_db}"."products" p ON p.product_key = s.product_key
