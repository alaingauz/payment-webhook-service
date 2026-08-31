# Payment Webhook Service

Servicio que recibe webhooks de pago, los persiste en un **durable inbox** en
PostgreSQL y los procesa de forma asíncrona con workers escalables, garantizando
**exactamente una vez** sobre el efecto de negocio.

## Stack

- **NestJS** (TypeScript) — API y workers en el mismo artefacto, diferenciados
  por la variable `MODE`.
- **PostgreSQL 16** — almacenamiento, durable inbox, cola de reintentos y DLQ.
- **Docker Compose** — orquestación local de todos los servicios.

## Arquitectura

```
Proveedor ──HMAC──▸ API (NestJS)
                      │
                      ▼
              PostgreSQL (durable inbox)
                      │
            ┌─────────┼─────────┐
            ▼         ▼         ▼
         Worker 1  Worker 2  Worker 3
            │         │         │
            ▼         ▼         ▼
        APPLIED / IGNORED / RETRY → DLQ
```

- La **API** valida HMAC-SHA256, persiste el evento en un CTE atómico y
  responde 202 solo después del COMMIT.
- Los **workers** reclaman eventos con `SELECT … FOR UPDATE SKIP LOCKED`,
  procesan la lógica de negocio dentro de una transacción y actualizan el
  estado a APPLIED, IGNORED o RETRY_SCHEDULED.
- Se escalan horizontalmente con `--scale worker=N`.

### ¿Por qué no Kafka, RabbitMQ ni gRPC?

Para el volumen del reto, PostgreSQL actúa como durable inbox y cola mediante
polling con `SKIP LOCKED`. Añadir un broker de mensajes aumentaría la
complejidad operativa sin beneficio medible. A 100× volumen se consideraría
particionamiento, retención, métricas preagregadas y eventualmente un broker
si el volumen lo justifica. No se afirma que Kafka/RabbitMQ sean necesarios
para el volumen actual.

## Flujo: desde HMAC hasta APPLIED/IGNORED

1. El proveedor envía un POST con header `X-Signature` (HMAC-SHA256).
2. Un Guard valida la firma sobre el raw body antes de cualquier lógica.
3. Se ejecuta un CTE atómico: upsert del evento + inserción de delivery.
4. Si el evento es duplicado, se registra como DUPLICATE sin reprocesar.
5. Si `occurred_at` es antiguo (> 5 min), se marca IGNORED/STALE_TIMESTAMP.
6. Se responde 202 con `correlation_id`.
7. Un worker reclama el evento PENDING con `FOR UPDATE SKIP LOCKED`.
8. Dentro de una transacción con SAVEPOINT:
   - Crea o bloquea la orden.
   - Si `sequence > last_sequence`: aplica el estado → APPLIED.
   - Si `sequence ≤ last_sequence`: ignora → IGNORED/STALE_SEQUENCE.
   - Si falla: ROLLBACK TO SAVEPOINT → programa retry con backoff exponencial.
9. Tras agotar reintentos (`MAX_ATTEMPTS=5`), el evento pasa a DLQ.

## Requisitos locales

- Docker y Docker Compose v2
- Node.js 22 o superior (para scripts de verificación y tests; coincide con
  la imagen Docker utilizada)
- npm

## Inicio rápido

```bash
git clone https://github.com/alaingauz/payment-webhook-service.git
cd payment-webhook-service
npm ci
docker compose up --build -d --scale worker=3
```

> **Nota:** el servicio `migration` termina con `Exited (0)`. Esto es
> esperado — ejecuta las migraciones SQL y finaliza exitosamente.

Verificar que los servicios están corriendo:

```bash
docker compose ps
curl http://localhost:3000/health
```

## Variables de entorno principales

| Variable | Descripción | Default Compose |
|---|---|---|
| `MODE` | `api` o `worker` | por servicio |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | Conexión PostgreSQL | `postgres` / `5432` / `postgres` / `postgres` / `webhooks` |
| `DB_POOL_MAX` | Tamaño del pool de conexiones | `40` (API), `2` (worker) |
| `WEBHOOK_SECRET` | Secreto HMAC-SHA256 (obligatorio) | `dev-webhook-secret-change-me` |
| `PROVIDER_BASE_URL` | URL del simulador de proveedor | `http://provider:4000` |
| `WORKER_POLL_INTERVAL_MS` | Intervalo de polling del worker | `100` |
| `WORKER_MAX_ATTEMPTS` | Reintentos antes de DLQ | `5` |
| `WORKER_RETRY_BASE_MS` / `WORKER_RETRY_MAX_MS` | Backoff exponencial | `500` / `30000` |

> El secreto incluido en `docker-compose.yml` es exclusivamente para
> desarrollo. No usar en producción.

## Endpoints

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/health` | Health check |
| `POST` | `/webhooks/payments` | Recepción de webhooks (requiere `X-Signature`) |
| `GET` | `/orders/:id` | Consultar estado de una orden |
| `GET` | `/metrics` | Métricas de observabilidad |
| `GET` | `/admin/dlq` | Listar eventos en DLQ |
| `POST` | `/admin/dlq/:id/replay` | Re-encolar evento de DLQ |
| `POST` | `/admin/reconcile` | Ejecutar reconciliación contra el proveedor |

### Ejemplos

```bash
# Health check
curl http://localhost:3000/health

# Enviar webhook con firma HMAC válida (macOS/zsh)
BODY=$(node -e '
  const body = JSON.stringify({
    event_id: "evt-readme-1",
    order_id: "ord-readme-1",
    event_type: "payment.authorized",
    sequence: 1,
    occurred_at: new Date().toISOString(),
    data: { amount: "100.00", currency: "MXN" }
  });
  process.stdout.write(body);
')
SIG=$(node -e "
  const crypto = require('crypto');
  const sig = crypto.createHmac('sha256', 'dev-webhook-secret-change-me')
    .update(process.argv[1]).digest('hex');
  process.stdout.write('sha256=' + sig);
" "$BODY")
curl -X POST http://localhost:3000/webhooks/payments \
  -H "Content-Type: application/json" \
  -H "X-Signature: $SIG" \
  --data-binary "$BODY"

# Consultar orden
curl http://localhost:3000/orders/ord-readme-1

# Métricas
curl http://localhost:3000/metrics

# DLQ
curl http://localhost:3000/admin/dlq?limit=10

# Reconciliación
curl -X POST http://localhost:3000/admin/reconcile
```

## Ejecución de tests y verificaciones

```bash
# Tests unitarios
npm test

# Tests E2E automatizados (usan un pool PG simulado; no requieren PostgreSQL real)
npm run test:e2e

# Tests del simulador
npm run test:simulator
```

### Verificaciones contra Docker (requieren los servicios levantados)

Primero, levantar solo postgres, provider, migration y api **sin workers**:

```bash
docker compose up --build -d postgres provider migration api
npm run verify:ingestion
```

Después, iniciar tres workers y ejecutar el resto de verificaciones:

```bash
docker compose up -d --no-deps --scale worker=3 worker
npm run verify:worker
npm run verify:retries-dlq
npm run verify:reconciliation
npm run verify:observability
```

### Ráfaga sucia

```bash
npm run simulate -- \
  --events=5000 \
  --duplicate-rate=0.2 \
  --shuffle \
  --seed=42
```

### Ráfaga normal

```bash
npm run simulate
```

### Muerte súbita (SIGKILL)

Mata con SIGKILL **todas** las réplicas activas del servicio worker y las
reinicia conservando el mismo número de réplicas:

```bash
npm run simulate -- --kill-at=2500
```

## Resultados reales obtenidos

| Prueba | p95 (ms) | Divergencias | Pérdidas |
|---|---|---|---|
| Ráfaga 1 (5000 eventos) | 69.98 | 0 | 0 |
| Ráfaga 2 (5000 eventos) | 30.48 | 0 | 0 |
| Ráfaga 3 (5000 eventos) | 30.38 | 0 | 0 |
| Observabilidad posterior | 63.16 | 0 | 0 |
| SIGKILL (`--kill-at=2500`) | 89.34 | 0 | **0** |

Tres ráfagas de 5000 eventos sin divergencias. La prueba SIGKILL eliminó las
tres réplicas del worker simultáneamente y obtuvo: eventos pendientes 0,
DLQ 0, eventos perdidos 0, divergencias 0, p95 89.34 ms — resultado PASS.

## Detener y limpiar

```bash
# Detener sin borrar datos (el volumen persiste)
docker compose down

# Detener y borrar el volumen de PostgreSQL
docker compose down -v
```

## Limitaciones conocidas

- Los endpoints administrativos (`/admin/*`) no tienen autenticación. En
  producción requerirían RBAC.
- PostgreSQL funciona como durable inbox y cola mediante polling. A volúmenes
  muy altos, el polling con `SKIP LOCKED` sería el primer cuello de botella.
- Las métricas (`/metrics`) consultan datos históricos completos con
  `percentile_cont`. A escala, se necesitarían métricas preagregadas o
  retención.
- El secreto HMAC en `docker-compose.yml` es exclusivamente de desarrollo.
- El simulador ejecuta comandos Docker (`docker compose kill`) para la prueba
  SIGKILL y debe ejecutarse desde el host, no desde dentro de un contenedor.

## Estructura del repositorio

```
├── src/
│   ├── webhooks/          # Recepción, validación HMAC, ingesta
│   ├── worker/            # Worker loop, procesamiento, reintentos
│   ├── orders/            # Consulta de órdenes
│   ├── admin/             # DLQ y reconciliación
│   ├── metrics/           # Endpoint de métricas
│   ├── health/            # Health check
│   ├── database/          # Migraciones y módulo de BD
│   ├── config/            # Configuración tipada
│   ├── logging/           # Logger estructurado JSON
│   └── provider/          # Cliente HTTP del proveedor
├── scripts/               # Scripts de verificación (verify:*)
├── provider-simulator/    # Simulador, generador, tests de caos
├── test/                  # Tests E2E
├── docker-compose.yml
├── Dockerfile
├── DECISIONS.md
└── package.json
```
