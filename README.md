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

SPA en **React 19 + TypeScript + Vite**, pensada para monitores 16:9 (usa todo el ancho). Librerías:

| Librería | Para qué |
|---|---|
| [React Flow](https://reactflow.dev/) (`@xyflow/react`) + dagre | Todos los diagramas: arquitectura, flujo medallion, ER arrastrables y mapa de pipelines en vivo |
| [HeroUI v3](https://heroui.com/) | Tema oscuro, botones, chips de estado, spinners |
| [shadcn/ui](https://ui.shadcn.com/) | Card, Tabs, Sheet y Table en `web/src/components/ui/` (Radix), adaptados a los tokens de color de HeroUI |
| [D3](https://d3js.org/) | Gráficos del tablero y de costos (d3 calcula escalas y formas; React dibuja el SVG) |
| TanStack Query | Llamadas a la API con caché y refresco en vivo |
| prism-react-renderer | Visor de código con resaltado |
| Motion | Microanimaciones (respeta "reducir movimiento") |

Siete pestañas, en el orden en que se enseña a construir el data lake:

1. **Resumen**: flujo medallion y arquitectura con los [iconos oficiales de AWS](https://aws.amazon.com/architecture/icons/) (`web/src/assets/aws/`). El flujo se ilumina con el estado real.
2. **Modelo de datos**: ER original (8 tablas de Kaggle, copo de nieve) y optimizado (estrella + agregados). Las tablas **se arrastran y sueltan** (la disposición se guarda en el navegador), las relaciones se anclan a la fila de cada columna y eligen el lado más corto, y al hacer clic en una tabla se resaltan sus relaciones. Incluye "Ordenar automáticamente", el linaje de los agregados y un comparador de velocidad en Athena.
3. **Pipelines**: una ficha por etapa. **Cada paso abre el código exacto** que lo implementa (el código del repo se embebe en la web al compilar). Explica por qué se usa Lambda (dataset chico) y cuándo pasar a Glue con Spark (más de ~1 millón de registros).
4. **Operar**: carga de CSV y mapa React Flow con un nodo por tabla: etapas en vivo, "Solo este" / "Con dependencias" y acceso al código. Debajo, el grafo de modelos Gold. Incluye el reinicio.
5. **Consultar**: tablero de comando (8 paneles, cada uno una consulta Athena sobre Gold con su gráfico D3) y consulta libre con gráfico.
6. **Costos**: estimación casi en tiempo real (se recalcula cada minuto) por servicio: Lambda, Glue, Athena, Step Functions, S3, API Gateway, CloudFront y CloudWatch Logs. Lee el uso real (CloudWatch, historial de Glue/Athena/Step Functions, tamaño de S3) y aplica precios de lista (`backend/common/pricing.py`). Es una estimación: la factura real llega a Cost Explorer con hasta 24 h de retraso.
7. **Observabilidad**: logs de CloudWatch de cada componente (todas las Lambdas, los dos flujos de Step Functions y el job de Glue) con errores y warnings resaltados, búsqueda, modo en vivo, y las últimas ejecuciones con la causa del fallo.

Requiere Node >= 20.19 (Vite 7). Desarrollo local: `cd web && npm ci && npm run dev` (necesita `web/public/config.json`, que genera `deplo.sh`).

## Dos arquitecturas: event-driven y programada

El mismo código de cada capa (`run_bronze`, `run_silver_pandas`, job de Glue, `build_model`) se orquesta de dos formas. El modo se cambia en la pestaña **Operar** (o `./deplo.sh mode event|scheduled`) y se guarda en SSM Parameter Store (`/datalake-demo/pipeline-mode`). Los dos modos nunca corren a la vez.

### Event-driven (modo `event`, por defecto)

```
S3 PUT (landing/adventureworks/*.csv) ─► SQS datalake-demo-events ─► Lambda despachador
          ▲                                   ▲                          │
          │                     EventBridge (fin de Glue)               │ condición no cumplida
          │                                                             ▼
          └────────────── 20 s ─────────── SQS datalake-demo-retry-dlq ◄┘
                                                │ error o 15 intentos (5 min)
                                                ▼
                                    SQS datalake-demo-dead-letter (DLQ final)
```

- **Llega un CSV:** Bronze del dataset. Si el archivo **no está** en landing, es un **error**: no se reintenta y va directo a la DLQ final. Si faltan otros CSV del dataset (por ejemplo ventas 2016), el evento espera 20 s y se vuelve a probar.
- **Termina Bronze:** el CSV se **mueve** a `archive/adventureworks/<nombre>__procesado_<YYYYMMDDTHHMMSSZ>.csv` y se publica el evento de Silver.
- **Silver:** si una tabla padre no está al día, el evento va a `retry-dlq`, que lo entrega 20 s después, hasta 15 intentos. Las tablas grandes arrancan el job de Glue y su fin llega como evento de EventBridge.
- **Fan-out:** al terminar Silver se publican las tablas hijas listas y los modelos Gold que la leen. Al terminar un modelo Gold, se publican sus modelos hijos.
- **Buenas prácticas:**
  - Idempotencia: un ETag ya consumido o una tabla al día no se reprocesan.
  - Locks con escritura condicional de S3 (`If-None-Match`), con doble verificación.
  - Feed de eventos con concurrencia optimista (`If-Match`).
  - `batchItemFailures`.
  - Visibility timeout de 6× el timeout de la función.
  - Redrive policy (3 fallos van a la DLQ final) y redrive desde la web (`StartMessageMoveTask`).
  - Colas con SSE-SQS y solo TLS.

### Programada (modo `scheduled`)

Una regla de EventBridge dispara `datalake-demo-scheduled` cada 30 min (o `./deplo.sh schedule`):

1. **`PlanProgramado`** arma el lote: archivos en landing, tablas con Bronze sin Silver al día y sus hijas, en orden de dependencias. Si ya hay otra ejecución en curso, o el modo es event-driven, termina sin hacer nada.
2. **Datasets:** el flujo hijo `datalake-demo-datasets` (`.sync:2`) procesa un dataset a la vez.
3. **Gold:** el flujo hijo `datalake-demo-gold` corre con `onlyStale` y `onlyReady`.

Buenas prácticas:
- Flujos anidados.
- Retry con backoff, por ejemplo ante `Glue.ConcurrentRunsExceededException`.
- Timeout por tarea.
- Catch hacia un estado `Fail`.
- X-Ray y logs de nivel ALL.

La pestaña **Pipelines** compara las dos arquitecturas punto por punto.

### Probarlo sin subir archivos de nuevo

En Operar:
- **Reponer desde archive/:** copia, del lado de S3, la última versión archivada a landing. Esa copia es un evento real de S3.
- **Simular evento sin archivo:** demuestra el error que va a la DLQ final.
- **Reprocesar DLQ final:** reenvía a la cola principal los mensajes de la DLQ final.

La sección **Almacenamiento por ruta** muestra la cantidad de archivos y el peso de cada ruta de cada bucket, incluido `archive/`.

### Seguridad y cifrado

Se usan SSE-S3 y SSE-SQS, que no tienen costo. **KMS** figura en el diagrama como la opción de producción (una clave propia con rotación), pero **no se despliega** para no sumar costo.

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
./deplo.sh seed         # sube sample-data/*.csv a landing (en event-driven, eso dispara todo)
./deplo.sh mode [event|scheduled]   # muestra o cambia la arquitectura
./deplo.sh schedule     # (programado) ejecuta ya el flujo programado
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
backend/lambdas/    api · plan · bronze · dependencies · silver_dimensions · finalize · gold · reset · costs · observability
backend/glue/       job Spark de Silver (hechos)
backend/sql/gold/   modelos Gold en SQL (se ejecutan en orden numérico)
web/                SPA React + TS (React Flow, HeroUI, shadcn/ui, D3) con login Cognito
sample-data/        CSV de Adventure Works
tests/              pytest: transformaciones, SQL guard, modelos Gold, infraestructura
```

## Tests

```bash
.venv/bin/python -m pytest -q    # 100 tests, sin credenciales AWS
```

Cubren las funciones de limpieza con los CSV reales, el validador de SQL, el orden de dependencias de los modelos Gold y propiedades de seguridad de la infraestructura (buckets privados, sin auto-registro en Cognito, todas las rutas con JWT). Los jobs de Glue y las Lambdas se validan de punta a punta con `./deplo.sh run`.

## Buenas prácticas aplicadas

- **Mínimo privilegio**: un rol por función; la API solo lee las capas y nunca escribe en ellas; solo `reset` puede borrar.
- **Defensa en profundidad en las consultas**: validador `SELECT`-only + IAM sin escritura + límite de 10 GB por consulta en el workgroup.
- **Subida directa a S3** con URL prefirmada (lista blanca de nombres, expira en 5 minutos, CORS solo para el origen de la web).
- **Buckets privados**, cifrados, solo TLS; CloudFront con OAC y cabeceras de seguridad.
- **Idempotencia**: `overwrite` en Bronze/Silver, purga previa en el job de Glue, `DROP` + CTAS en Gold.
- **Sin nombres de recursos en el código**: todo llega por variables de entorno desde CDK.
- **Control de costos**: Glue con 2 workers y timeout de 15 min, API con throttling, logs a 1 semana, y la pestaña Costos para ver el gasto por servicio.
- **Costos y Observabilidad de solo lectura**: cada una en su propia Lambda con permisos de lectura limitados (métricas, logs de sus grupos, historiales).

## Notas

- La demo usa `RemovalPolicy.DESTROY`: `destroy` borra los datos. En producción usar `RETAIN`, versionado y KMS.
- La capa de Lambda `AWSSDKPandas-Python312` (versión 32, x86_64) es la gestionada por AWS; ver [versiones por región](https://aws-sdk-pandas.readthedocs.io/en/stable/layers.html).
- Gold usa precio y costo de lista del producto (el dataset no trae precio por línea de venta).
