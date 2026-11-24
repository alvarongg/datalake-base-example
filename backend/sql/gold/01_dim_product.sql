-- GOLD · dim_product
-- Dimensión de producto: producto + subcategoría + categoría + margen unitario.
-- Plantilla: {gold_db}, {silver_db} y {location} los reemplaza la Lambda 'gold'.
CREATE TABLE "{gold_db}"."dim_product"
WITH (format = 'PARQUET', write_compression = 'SNAPPY', external_location = '{location}') AS
SELECT
    p.product_key,
    p.product_sku,
    p.product_name,
    p.model_name,
    p.product_color,
    p.product_size,
    p.product_style,
    p.product_cost,
    p.product_price,
    ROUND(p.product_price - p.product_cost, 4) AS unit_margin,
    s.subcategory_name,
    c.category_name
FROM "{silver_db}"."products" p
LEFT JOIN "{silver_db}"."product_subcategories" s ON s.product_subcategory_key = p.product_subcategory_key
LEFT JOIN "{silver_db}"."product_categories"    c ON c.product_category_key    = s.product_category_key
