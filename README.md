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

## Pruebas y verificación

### 2. Instalar y validar el código

```bash
npm ci
npm run lint
npm run build
npm test
npm run test:e2e
npm run test:simulator
docker compose config
```

Resultados de referencia:

| Prueba | Resultado |
|---|---|
| Unit tests | 189 passed |
| E2E tests | 44 passed |
| Simulator tests | 42 passed |
| Lint | 0 errores |
| Build | exitoso |
| Compose config | válido |

Los tests E2E automatizados utilizan un pool de PostgreSQL simulado. Las
verificaciones siguientes utilizan PostgreSQL real mediante Docker.

### 3. Levantar el entorno con tres workers

Asegurar que no exista una ejecución anterior:

```bash
docker compose down -v --remove-orphans
```

Construir y levantar todos los servicios:

```bash
docker compose up --build -d --scale worker=3
```

Esperar hasta que Docker marque la API como saludable:

```bash
API_ID=$(docker compose ps -q api)

until [ "$(docker inspect --format '{{.State.Health.Status}}' "$API_ID")" = "healthy" ]; do
  echo "Esperando que Docker marque la API como healthy..."
  sleep 1
done

sleep 3
```

Revisar los contenedores:

```bash
docker compose ps -a
```

Estado esperado:

| Servicio | Estado |
|---|---|
| PostgreSQL | healthy |
| Provider | healthy |
| API | healthy |
| Tres workers | running |
| Migration | Exited (0) |

> El servicio `migration` termina después de aplicar las migraciones.
> `Exited (0)` representa una ejecución exitosa.

### 4. Ejecutar las verificaciones con workers activos

```bash
npm run verify:worker
npm run verify:retries-dlq
npm run verify:reconciliation
npm run verify:observability
```

Resultados de referencia:

| Verificación | Resultado |
|---|---|
| verify:worker | 36 passed, 0 failed |
| verify:retries-dlq | 29 passed, 0 failed |
| verify:reconciliation | 42 passed, 0 failed |
| verify:observability | 14 passed, 0 failed |

### 5. Verificar la ingesta sin workers

La prueba de ingesta debe ejecutarse con los workers detenidos porque verifica
que la API persiste los eventos sin procesarlos todavía.

```bash
docker compose stop worker
npm run verify:ingestion
```

Resultado esperado:

```
Results: 22 passed, 0 failed
```

Después de la verificación, volver a levantar las tres réplicas:

```bash
docker compose up -d --no-deps --scale worker=3 worker
```

Confirmar que las tres estén activas:

```bash
docker compose ps worker
```

### 6. Prueba de ráfaga sucia

```bash
npm run simulate -- \
  --events=5000 \
  --duplicate-rate=0.2 \
  --shuffle \
  --seed=42
```

Criterios de aprobación:

| Métrica | Esperado |
|---|---|
| Pending events | 0 |
| DLQ events | 0 |
| Lost events | 0 |
| Divergences | 0 |
| Unexpected errors | 0 |
| p95 HTTP latency | menor a 100 ms |

El reporte debe finalizar con:

```
SUCCESS: all orders converged to expected state
```

Esta prueba puede ejecutarse tres veces consecutivas para verificar
consistencia:

```bash
for run in 1 2 3; do
  echo "========== RÁFAGA 5000 · EJECUCIÓN $run =========="

  npm run simulate -- \
    --events=5000 \
    --duplicate-rate=0.2 \
    --shuffle \
    --seed=42 || break
done
```

### 7. Prueba de muerte súbita

Confirmar primero que existan tres workers activos:

```bash
docker compose ps worker
```

Ejecutar la ráfaga con muerte súbita en la entrega 2500:

```bash
npm run simulate -- \
  --events=5000 \
  --duplicate-rate=0.2 \
  --shuffle \
  --seed=42 \
  --kill-at=2500 \
  --restart-delay-ms=1000
```

Durante la ejecución, el simulador:

1. Detecta la cantidad de workers activos.
2. Continúa enviando la ráfaga.
3. Mata todas las réplicas con SIGKILL en la entrega 2500.
4. Continúa enviando eventos mientras los workers están detenidos.
5. Reinicia la misma cantidad de réplicas.
6. Espera hasta que todos los eventos alcancen un estado terminal.
7. Compara las órdenes contra `expected-states.json`.

El reporte debe confirmar:

| Métrica | Esperado |
|---|---|
| Workers killed | 3 |
| Kill confirmed | YES |
| Workers restarted | 3 |
| Restart confirmed | YES |
| Burst continued | YES |
| Pending events | 0 |
| DLQ events | 0 |
| Lost events | 0 |
| Divergences | 0 |
| Unexpected errors | 0 |

Y finalizar con:

```
PASS: sudden death test — convergence after SIGKILL
SUCCESS: all orders converged to expected state
```

### 8. Restaurar archivos y limpiar Docker

Las simulaciones actualizan los snapshots del proveedor. Restaurarlos antes de
revisar Git:

```bash
git restore \
  provider-simulator/data/provider-orders.json \
  provider-simulator/data/expected-states.json
```

Detener el entorno y eliminar el volumen temporal:

```bash
docker compose down -v
```

Verificar que el clon permanezca limpio:

```bash
git status --short
```

Si no existe salida, no quedaron archivos modificados.

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
