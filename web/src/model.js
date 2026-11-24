// Definición de los dos modelos de datos que dibuja er.js.
// k: 'pk' clave primaria · 'fk' clave foránea · 'part' columna de partición.

const c = (n, k = '') => ({ n, k });

/* ------------------------------------------------------------------
 * MODELO ORIGINAL: las 8 tablas tal como vienen en los CSV de Kaggle.
 * Es un esquema normalizado tipo "copo de nieve" (snowflake): para saber la
 * categoría de una venta hay que encadenar Sales → Products → Subcategories → Categories.
 * ------------------------------------------------------------------ */
export const ORIGINAL = {
  width: 970, height: 510,
  entities: [
    { id: 'cat', title: 'Product_Categories', x: 20, y: 10, cols: [c('ProductCategoryKey', 'pk'), c('CategoryName')] },
    { id: 'sub', title: 'Product_Subcategories', x: 20, y: 110, cols: [c('ProductSubcategoryKey', 'pk'), c('SubcategoryName'), c('ProductCategoryKey', 'fk')] },
    { id: 'prod', title: 'Products', x: 20, y: 250, cols: [
      c('ProductKey', 'pk'), c('ProductSubcategoryKey', 'fk'), c('ProductSKU'), c('ProductName'), c('ModelName'),
      c('ProductDescription'), c('ProductColor'), c('ProductSize'), c('ProductStyle'), c('ProductCost'), c('ProductPrice')] },
    { id: 'sales', title: 'Sales_2015 / 2016 / 2017', x: 360, y: 60, cols: [
      c('OrderNumber', 'pk'), c('OrderLineItem', 'pk'), c('OrderDate', 'fk'), c('StockDate'), c('ProductKey', 'fk'),
      c('CustomerKey', 'fk'), c('TerritoryKey', 'fk'), c('OrderQuantity')] },
    { id: 'ret', title: 'Returns', x: 360, y: 330, cols: [c('ReturnDate', 'fk'), c('TerritoryKey', 'fk'), c('ProductKey', 'fk'), c('ReturnQuantity')] },
    { id: 'cust', title: 'Customers', x: 700, y: 10, cols: [
      c('CustomerKey', 'pk'), c('Prefix'), c('FirstName'), c('LastName'), c('BirthDate'), c('MaritalStatus'), c('Gender'),
      c('EmailAddress'), c('AnnualIncome'), c('TotalChildren'), c('EducationLevel'), c('Occupation'), c('HomeOwner')] },
    { id: 'terr', title: 'Territories', x: 700, y: 320, cols: [c('SalesTerritoryKey', 'pk'), c('Region'), c('Country'), c('Continent')] },
    { id: 'cal', title: 'Calendar', x: 700, y: 440, cols: [c('Date', 'pk')] },
  ],
  relations: [
    { from: 'sub', fromCol: 'ProductCategoryKey', to: 'cat', toCol: 'ProductCategoryKey' },
    { from: 'prod', fromCol: 'ProductSubcategoryKey', to: 'sub', toCol: 'ProductSubcategoryKey' },
    { from: 'sales', fromCol: 'ProductKey', to: 'prod', toCol: 'ProductKey' },
    { from: 'sales', fromCol: 'CustomerKey', to: 'cust', toCol: 'CustomerKey' },
    { from: 'sales', fromCol: 'TerritoryKey', to: 'terr', toCol: 'SalesTerritoryKey' },
    { from: 'sales', fromCol: 'OrderDate', to: 'cal', toCol: 'Date' },
    { from: 'ret', fromCol: 'ProductKey', to: 'prod', toCol: 'ProductKey' },
    { from: 'ret', fromCol: 'TerritoryKey', to: 'terr', toCol: 'SalesTerritoryKey' },
    { from: 'ret', fromCol: 'ReturnDate', to: 'cal', toCol: 'Date' },
  ],
};

/* ------------------------------------------------------------------
 * MODELO OPTIMIZADO (capa Gold): esquema en estrella.
 * Una tabla de hechos al centro y dimensiones desnormalizadas alrededor:
 * cualquier consulta necesita como máximo 1 join por dimensión.
 * ------------------------------------------------------------------ */
export const OPTIMIZED = {
  width: 970, height: 720,
  entities: [
    { id: 'dprod', title: 'dim_product', x: 20, y: 10, cols: [
      c('product_key', 'pk'), c('product_sku'), c('product_name'), c('model_name'), c('product_color'), c('product_size'),
      c('product_style'), c('product_cost'), c('product_price'), c('unit_margin'), c('subcategory_name'), c('category_name')] },
    { id: 'ddate', title: 'dim_date', x: 20, y: 300, cols: [
      c('date_key', 'pk'), c('year'), c('quarter'), c('month'), c('month_name'), c('year_month'), c('day'), c('day_of_week'), c('is_weekend')] },
    { id: 'fsales', title: 'fact_sales', x: 360, y: 30, cols: [
      c('order_number', 'pk'), c('order_line_item', 'pk'), c('order_date', 'fk'), c('stock_date'), c('product_key', 'fk'),
      c('customer_key', 'fk'), c('territory_key', 'fk'), c('order_quantity'), c('unit_price'), c('unit_cost'),
      c('revenue'), c('cost'), c('profit'), c('order_year', 'part')] },
    { id: 'fret', title: 'fact_returns', x: 360, y: 380, cols: [
      c('return_date', 'fk'), c('territory_key', 'fk'), c('product_key', 'fk'), c('return_quantity'), c('returned_revenue')] },
    { id: 'dcust', title: 'dim_customer', x: 700, y: 10, cols: [
      c('customer_key', 'pk'), c('full_name'), c('gender'), c('marital_status'), c('birth_date'), c('age'), c('age_band'),
      c('annual_income'), c('income_band'), c('total_children'), c('education_level'), c('occupation'), c('home_owner')] },
    { id: 'dterr', title: 'dim_territory', x: 700, y: 320, cols: [c('territory_key', 'pk'), c('region'), c('country'), c('continent')] },
    // Agregados precalculados para dashboards (sin relaciones: se derivan de los anteriores).
    { id: 'a1', agg: true, title: 'sales_monthly_by_category', x: 15, y: 560, w: 225, cols: [
      c('year_month'), c('category_name'), c('orders'), c('units'), c('revenue'), c('profit'), c('margin_pct')] },
    { id: 'a2', agg: true, title: 'sales_by_territory', x: 255, y: 560, w: 225, cols: [
      c('continent'), c('country'), c('region'), c('year'), c('units'), c('revenue'), c('profit')] },
    { id: 'a3', agg: true, title: 'return_rate_by_category', x: 495, y: 560, w: 225, cols: [
      c('category_name'), c('units_sold'), c('units_returned'), c('return_rate_pct')] },
    { id: 'a4', agg: true, title: 'sales_by_customer_segment', x: 735, y: 560, w: 225, cols: [
      c('age_band'), c('income_band'), c('customers'), c('units'), c('revenue'), c('revenue_per_customer')] },
  ],
  relations: [
    { from: 'fsales', fromCol: 'product_key', to: 'dprod', toCol: 'product_key' },
    { from: 'fsales', fromCol: 'order_date', to: 'ddate', toCol: 'date_key' },
    { from: 'fsales', fromCol: 'customer_key', to: 'dcust', toCol: 'customer_key' },
    { from: 'fsales', fromCol: 'territory_key', to: 'dterr', toCol: 'territory_key' },
    { from: 'fret', fromCol: 'product_key', to: 'dprod', toCol: 'product_key' },
    { from: 'fret', fromCol: 'return_date', to: 'ddate', toCol: 'date_key' },
    { from: 'fret', fromCol: 'territory_key', to: 'dterr', toCol: 'territory_key' },
  ],
  notes: [{ x: 15, y: 545, text: 'Tablas agregadas (derivadas de los hechos y dimensiones, para dashboards)' }],
};
