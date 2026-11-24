# Data Lake Medallion · Adventure Works

Ejemplo mínimo y didáctico de un data lake con el **modelo medallion** (Bronze → Silver → Gold) en AWS, pensado para enseñar a ingenieros qué pasos requiere una extracción, transformación y carga.

Un usuario entra a una web (CloudFront + Cognito), sube los CSV del dataset [Adventure Works](https://www.kaggle.com/datasets/ukveteran/adventure-works), ejecuta el pipeline y consulta el resultado en Athena.

## Arquitectura

```
Navegador ─► CloudFront ─► S3 (web estática)
    │  login (SRP)
    ├──────────► Cognito
    │  JWT
    └──────────► API Gateway (HTTP) ─► Lambda API ─► URL prefirmada ─┐
                                                 ├► Step Functions  │
                                                 ├► Athena (SELECT) │
                                                 └► Lambda Reset    ▼
                                                              S3 landing (CSV)
                                                                    │
  Step Functions: ┌─────────────────────────────────────────────────┘
   1. BRONZE  Lambda (pandas + awswrangler)   CSV → Parquet crudo + auditoría
   2. SILVER  en paralelo:
        · Lambda (pandas)                     dimensiones: limpieza y tipos
        · AWS Glue Job (Spark)                hechos: ventas y devoluciones
   3. GOLD    Lambda (awswrangler + Athena)   SQL CTAS: dimensiones, hechos, agregados
                                                                    │
                                   Glue Data Catalog ─► Athena (datalake_bronze / _silver / _gold)
```

## Los tres motores y cuándo usar cada uno

| Capa / tabla | Motor | Por qué |
|---|---|---|
| Bronze (todo) | Lambda + **awswrangler** | Copia sin interpretar; awswrangler escribe Parquet y registra la tabla en Glue en una línea. |
| Silver, dimensiones | Lambda + **pandas** | Tablas pequeñas: la opción más simple y barata. Lógica pura en `backend/common/transforms.py`, con tests. |
| Silver, hechos (`sales`, `returns`) | **AWS Glue (Spark)** | Tablas que crecen sin límite: Spark escala horizontalmente. Ver `backend/glue/silver_facts.py`. |
| Gold | **Athena CTAS** vía awswrangler | La lógica de negocio es SQL (`backend/sql/gold/*.sql`), legible por analistas. |

## Qué hace cada capa

- **Landing**: el CSV tal cual se subió. Nunca se modifica; permite reprocesar.
- **Bronze**: texto sin interpretar + `_source_file` y `_ingested_at` (lineage). Nombres de columna en `snake_case`. El CSV de clientes está en latin-1, no UTF-8: se declara por dataset en `backend/common/datasets.py`.
- **Silver**: tipos reales (fechas, números), textos normalizados, `"$90,000 "` → `90000.0`, `"0"` → `NULL`, duplicados eliminados, claves validadas. Si una clave obligatoria viene nula, el pipeline falla (no se publican datos dudosos).
- **Gold**: `dim_product`, `dim_customer`, `dim_territory`, `dim_date`, `fact_sales`, `fact_returns` y agregados (`sales_monthly_by_category`, `sales_by_territory`, `return_rate_by_category`, `sales_by_customer_segment`).

## La web

Cinco pestañas:

- **Resumen**: diagramas con los [iconos oficiales de AWS](https://aws.amazon.com/architecture/icons/) (`web/src/assets/aws/`): cómo se conecta la app y el flujo medallion, que se ilumina mientras corren los pipelines.
- **Operar**: carga de CSV y **mapa gráfico de pipelines**: un nodo por tabla con sus dependencias como flechas y el estado en vivo de cada etapa (Bronze → Dependencias → Silver). Cada nodo tiene "Solo este" y "Con dependencias". Debajo, los modelos Gold con su propio grafo. Incluye el reinicio.
- **Pipelines**: una ficha por etapa (Bronze, Dependencias, Silver pandas, Silver Glue, Gold) con servicios, pasos, reglas, código clave y estado actual.
- **Dashboard**: ocho paneles, cada uno una consulta Athena sobre Gold con su propio gráfico (barras, líneas, dona, KPI, tabla; el tipo se puede cambiar) y una consulta libre con gráfico.
- **Modelo de datos**: diagrama entidad-relación original (8 tablas de Kaggle, copo de nieve) y el optimizado (estrella + agregados), con la lista de optimizaciones y un comparador que ejecuta la misma consulta en Athena sobre tres modelos y muestra datos leídos y tiempo.

## Un pipeline por archivo, con dependencias

Cada extracción dispara su propio pipeline (Step Functions `datalake-demo-datasets`): `Bronze → CheckDependencies → Silver (pandas o Glue) → RecordSilver`. Las dependencias reflejan las claves foráneas (`backend/common/datasets.py`):

```
product_categories → product_subcategories → products ─┐
customers, territories, calendar ──────────────────────┼→ sales
                                    products, territories, calendar → returns
```

- **Procesar un archivo solo** (`./deplo.sh run products`): Bronze corre, pero la compuerta falla si una tabla padre no está al día. Mensaje real: `products no se puede procesar: product_subcategories nunca se procesó`.
- **Procesar con dependencias** (`./deplo.sh run products with_dependencies`): el sistema exige que estén TODOS los CSV necesarios (si no, responde con la lista de faltantes) y los procesa en orden.
- **"Al día"** significa que Silver se construyó con el archivo actual y con la última versión de cada dependencia. Si se reprocesa una tabla padre (o se sube un archivo distinto), las hijas pasan a **desactualizada** y hay que reprocesarlas. El estado vive en `control/` (bucket de resultados) y la lógica pura está en `backend/common/control.py`.
- **Gold** (`datalake-demo-gold`) lee del propio SQL de qué tablas depende cada modelo y falla antes de tocar nada si alguna no está al día. Se construye todo o solo un modelo.

Medición real (ingresos por categoría 2016, mismo resultado en los tres): modelo normalizado 56 KB leídos, estrella 42 KB, tabla agregada 0,9 KB.

## Despliegue

Todo el paso a paso está en [`deplo.sh`](deplo.sh) (comentado como tutorial). Requiere AWS CLI, Node 20+ y Python 3.12.

```bash
./deplo.sh              # tests + cdk bootstrap/deploy + build web + publicar + usuario demo
./deplo.sh seed         # sube sample-data/*.csv a landing (opcional: también se hace desde la web)
./deplo.sh run          # procesa todos los archivos en orden de dependencias y espera
./deplo.sh run products # solo un archivo: falla si una dependencia no está al día
./deplo.sh run products with_dependencies   # ese archivo y todo lo que necesita
./deplo.sh gold         # construye los modelos Gold (exige Silver al día)
./deplo.sh reset        # vacía bronze/silver/gold y tablas (conserva los CSV)
./deplo.sh reset-all    # vacía también landing
./deplo.sh destroy      # elimina toda la infraestructura
```

Perfil por defecto `udemy_alvaro`, región `us-east-1` (`AWS_PROFILE`, `AWS_REGION` para cambiarlos). Al terminar imprime la URL de la web y las credenciales del usuario demo.

## Poblar desde cero

El botón **Reiniciar** de la web (o `./deplo.sh reset`) invoca la Lambda `reset`, que borra los objetos de bronze/silver/gold/resultados de Athena y elimina las tablas del Glue Catalog. Luego se vuelve a ejecutar el pipeline. Todas las etapas son idempotentes: re-ejecutarlas no duplica datos.

## Estructura

```
deplo.sh            despliegue completo
infra/              CDK (Python): stacks web, auth, datalake, pipeline, api
backend/common/     contrato de datasets, configuración, transformaciones puras, validador SQL
backend/lambdas/    api · bronze · silver_dimensions · gold · reset
backend/glue/       job Spark de Silver (hechos)
backend/sql/gold/   modelos Gold en SQL (se ejecutan en orden numérico)
web/                SPA (Vite + JS) con login Cognito
sample-data/        CSV de Adventure Works
tests/              pytest: transformaciones, SQL guard, modelos Gold, infraestructura
```

## Tests

```bash
.venv/bin/python -m pytest -q    # 70 tests, sin credenciales AWS
```

Cubren las funciones de limpieza con los CSV reales, el validador de SQL, el orden de dependencias de los modelos Gold y propiedades de seguridad de la infraestructura (buckets privados, sin auto-registro en Cognito, todas las rutas con JWT). Los jobs de Glue y las Lambdas se validan de punta a punta con `./deplo.sh run`.

## Buenas prácticas aplicadas

- **Mínimo privilegio**: un rol por función; la API solo lee las capas y nunca escribe en ellas; solo `reset` puede borrar.
- **Defensa en profundidad en las consultas**: validador `SELECT`-only + IAM sin escritura + límite de 10 GB por consulta en el workgroup.
- **Subida directa a S3** con URL prefirmada (lista blanca de nombres, expira en 5 minutos, CORS solo para el origen de la web).
- **Buckets privados**, cifrados, solo TLS; CloudFront con OAC y cabeceras de seguridad.
- **Idempotencia**: `overwrite` en Bronze/Silver, purga previa en el job de Glue, `DROP` + CTAS en Gold.
- **Sin nombres de recursos en el código**: todo llega por variables de entorno desde CDK.
- **Control de costos**: Glue con 2 workers y timeout de 15 min, API con throttling, logs a 1 semana.

## Notas

- La demo usa `RemovalPolicy.DESTROY`: `destroy` borra los datos. En producción usar `RETAIN`, versionado y KMS.
- La capa de Lambda `AWSSDKPandas-Python312` (versión 32, x86_64) es la gestionada por AWS; ver [versiones por región](https://aws-sdk-pandas.readthedocs.io/en/stable/layers.html).
- Gold usa precio y costo de lista del producto (el dataset no trae precio por línea de venta).
