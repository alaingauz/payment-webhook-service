# Decisiones

## 1. Exactamente una vez

- **UNIQUE(event_id) + upsert atómico**: La restricción UNIQUE en `event_id`
  garantiza que PostgreSQL rechace inserciones duplicadas a nivel de base de
  datos. Usamos `INSERT ... ON CONFLICT (event_id) DO UPDATE SET delivery_count
  = delivery_count + 1 RETURNING ...` para detectar duplicados sin SELECT previo
  y sin locks en memoria.

- **FOR UPDATE SKIP LOCKED**: El worker reclama un evento pendiente usando
  `SELECT ... FOR UPDATE SKIP LOCKED`, lo que permite que múltiples workers
  compitan por eventos sin bloquearse mutuamente. Un evento solo puede ser
  reclamado por un worker a la vez.

- **Una transacción para orden, historial y evento**: Dentro de la misma
  transacción se crea/bloquea la orden, se actualiza su estado, se inserta el
  historial y se marca el evento como APPLIED o IGNORED. Si cualquier paso
  falla, todo se revierte y el evento queda PENDING para reintentar.

- **Índice único parcial en order_status_history(event_id)**: El índice
  `uq_order_status_history_event_id` (WHERE event_id IS NOT NULL) actúa como
  segunda defensa: incluso si un bug o condición de carrera permitiera procesar
  el mismo evento dos veces, PostgreSQL rechazaría la segunda inserción de
  historial. No afecta entradas de reconciliación (event_id NULL).

- **Múltiples workers producen el mismo resultado**: Gracias a SKIP LOCKED, un
  evento solo es procesado por un worker. Si un worker muere, PostgreSQL libera
  el lock y otro worker puede tomar el evento. El resultado final es idéntico
  independientemente de cuántos workers participen.

- **La API confirma solamente después del COMMIT**: El endpoint responde HTTP 202
  únicamente después de que la transacción PostgreSQL haya hecho COMMIT. Si el
  proceso muere entre el COMMIT y la respuesta HTTP, el evento ya está persistido
  y el proveedor reenviará, resultando en un duplicado idempotente.

- **El evento queda en PostgreSQL como durable inbox antes del 202**: Esto
  garantiza que ningún evento se pierde. El patrón durable inbox asegura que el
  evento sobrevive a caídas del proceso.

- **La garantía es exactamente una vez sobre el efecto de negocio**: La
  idempotencia se logra a nivel de efecto de negocio (cada `event_id` se procesa
  una sola vez), no "exactly-once delivery" a nivel de red. Las re-entregas del
  proveedor se registran como DUPLICATE en `webhook_deliveries` sin modificar el
  evento original.

## 2. Caída a mitad del procesamiento

- **Antes de COMMIT, SIGKILL provoca rollback de PostgreSQL**: Si el worker
  muere (SIGKILL) antes de ejecutar COMMIT, PostgreSQL detecta la conexión rota
  y ejecuta un rollback automático. Los locks de fila se liberan, la orden no
  cambia, el historial no se inserta y el evento permanece PENDING.

- **Los locks se liberan**: Al hacer rollback automático, PostgreSQL libera tanto
  el lock `FOR UPDATE SKIP LOCKED` del evento como el lock `FOR UPDATE` de la
  orden. Otro worker puede reclamar el evento inmediatamente.

- **El evento continúa PENDING**: Como el `processing_status` solo se actualiza
  a APPLIED/IGNORED dentro de la misma transacción, un rollback garantiza que el
  evento queda PENDING y disponible para reintentar.

- **Después de COMMIT**: Una vez ejecutado el COMMIT, orden, historial y estado
  del evento quedan persistidos de forma atómica. No existe ventana donde se
  haya respondido 202 sin tener el evento en el durable inbox.

- **No existe ventana sin durable inbox**: La API responde 202 solo después del
  COMMIT de la ingesta. El worker procesa desde el inbox. En ambos caminos, el
  efecto de negocio solo se materializa tras un COMMIT exitoso.

- **503 ante fallo de PostgreSQL en la API**: Si la sentencia CTE de ingesta
  falla, PostgreSQL revierte toda la sentencia automáticamente (transacción
  implícita) y `pool.query` rechaza la promesa. Se responde 503 para que el
  proveedor reintente.

- **Antes de programar retry**: Si el worker muere después del claim pero antes
  de ejecutar `ROLLBACK TO SAVEPOINT` o el UPDATE de `RETRY_SCHEDULED`, PostgreSQL
  detecta la conexión rota y hace rollback automático. El evento permanece en su
  estado previo (PENDING o RETRY_SCHEDULED) y otro worker lo reclamará.

- **Después de programar retry**: Si el worker muere después del COMMIT que marcó
  el evento como `RETRY_SCHEDULED`, el evento queda correctamente programado con
  `next_attempt_at`. Otro worker lo reclamará cuando venza la fecha.

- **Durante replay**: El replay usa `SELECT ... FOR UPDATE` con transacción.
  Si el proceso muere antes del COMMIT, PostgreSQL revierte y el evento permanece
  en DLQ. El administrador puede reintentar el replay.

- **Caída durante reconciliación y rollback atómico**: La reconciliación
  completa se ejecuta dentro de una sola transacción PostgreSQL. Si el proceso
  muere o cualquier operación falla, PostgreSQL hace rollback automático. No
  quedan órdenes parcialmente reconciliadas: o se reparan todas o ninguna.
  El `pg_advisory_xact_lock` se libera automáticamente con el rollback.

## 3. Desorden

- **sequence es autoritativa**: El campo `sequence` del evento determina el orden
  lógico. No se usa `occurred_at` como criterio principal porque los relojes del
  proveedor podrían no ser monotónicos.

- **Mayor sequence proyecta directamente el estado**: Si el evento tiene un
  `sequence` mayor que `order.last_sequence`, se aplica el estado destino
  directamente, sin exigir que la transición sea adyacente. Ejemplo: un salto
  directo de `pending` a `refunded` es válido si `sequence` es mayor.

- **Menor o igual se ignora con STALE_SEQUENCE**: Si el evento tiene un
  `sequence` menor o igual al `last_sequence` actual de la orden, se marca como
  IGNORED con `outcome_reason = 'STALE_SEQUENCE'`. No se modifica la orden.

- **No se exige transición adyacente**: Los saltos de estado son válidos. El
  sistema tolera que lleguen eventos desordenados o que se pierdan algunos
  intermedios. El último estado con el mayor sequence prevalece.

- **Protección contra snapshot atrasado del proveedor**: Si el `sequence` del
  proveedor es menor que el `last_sequence` local, la orden no se modifica.
  Se registra como `STALE_PROVIDER_SNAPSHOT` en `reconciliation_details`. Esto
  protege contra un snapshot del proveedor que no refleja eventos recientes ya
  procesados localmente. El proveedor nunca hace retroceder una orden.

- **Alternativas descartadas**:
  - Esperar eventos faltantes: aumenta complejidad y latencia, requiere timeouts
    y manejo de eventos que nunca llegan.
  - Usar `occurred_at` como orden principal: los relojes del proveedor no son
    confiables y podrían generar conflictos con timestamps idénticos.

## 4. Reintentos

- **SAVEPOINT protege solamente el bloque de negocio**: Después de reclamar el
  evento con `SELECT ... FOR UPDATE SKIP LOCKED` en la transacción exterior, se
  crea `SAVEPOINT business_processing`. Si la lógica de negocio (crear orden,
  actualizar estado, insertar historial, marcar evento) lanza una excepción, se
  ejecuta `ROLLBACK TO SAVEPOINT` y `RELEASE SAVEPOINT`, deshaciendo cualquier
  efecto parcial sin perder el lock del evento.

- **Casos deterministas no hacen rollback al SAVEPOINT**: Resultados como
  `APPLIED`, `STALE_SEQUENCE` y `UNKNOWN_EVENT_TYPE` son deterministas y se
  resuelven directamente con `RELEASE SAVEPOINT` seguido de `COMMIT`. Solo las
  excepciones reales activan `ROLLBACK TO SAVEPOINT`.

- **Fórmula `attemptCount - 1`**: El backoff exponencial usa
  `cap = min(MAX_DELAY, BASE_DELAY * 2^(attemptCount - 1))`. Esto produce:
  - attemptCount=1 → cap=BASE_DELAY
  - attemptCount=2 → cap=BASE_DELAY×2
  - attemptCount=3 → cap=BASE_DELAY×4
  No se usa `2^attemptCount` para evitar duplicar incorrectamente el primer
  retraso.

- **Full jitter evita sincronización de varios workers**: El delay real es un
  valor aleatorio uniforme entre 0 y cap (`delay = random() * cap`). Esto evita
  que múltiples workers que fallaron simultáneamente reintenten al mismo tiempo,
  distribuyendo la carga.

- **Parámetros elegidos**: `WORKER_MAX_ATTEMPTS=5`, `WORKER_RETRY_BASE_MS=500`,
  `WORKER_RETRY_MAX_MS=30000`. Con 5 intentos y base 500ms, los caps son
  500ms, 1s, 2s, 4s. El max de 30s previene esperas excesivas. Estos valores
  son configurables por variables de entorno y se validan al arrancar.

- **Al agotarse intentos se usa PostgreSQL como DLQ**: Cuando
  `attemptCount >= WORKER_MAX_ATTEMPTS`, el evento se marca como `DLQ` con
  `outcome_reason = 'MAX_ATTEMPTS_EXHAUSTED'`. No se usa una cola externa;
  PostgreSQL actúa como DLQ con índice parcial para consultas eficientes.

- **Replay solo vuelve a PENDING; no procesa inline**: El endpoint
  `POST /admin/dlq/:id/replay` resetea el evento a `PENDING` con
  `attempt_count=0` e incrementa `replay_count`. No ejecuta la lógica de
  negocio dentro del endpoint; el worker lo tomará posteriormente.

- **Dos replays concurrentes se serializan con FOR UPDATE**: El replay usa
  `SELECT ... FOR UPDATE` dentro de una transacción. Si dos requests llegan
  simultáneamente, uno obtiene el lock y hace el replay; el otro espera,
  observa que ya no está en DLQ y responde `NOT_IN_DLQ` sin modificar nada.
  `replay_count` solo aumenta una vez.

## 5. Uso de IA

- **Junie** fue usado para implementación y generación inicial de pruebas.
- **Codex** fue usado para diseño, revisión técnica y detección de riesgos.
- El candidato revisó los cambios y ejecutó las verificaciones.

## 6. Escala

- **SKIP LOCKED permite múltiples workers**: Cada worker ejecuta
  `SELECT ... FOR UPDATE SKIP LOCKED`, lo que permite que varios workers
  procesen eventos en paralelo sin bloquearse entre sí. Se escala con
  `docker compose up -d --scale worker=3`.

- **Un event_id caliente se serializa por el contador de entregas**: Si el mismo
  evento llega múltiples veces, el upsert en `webhook_events` serializa las
  entregas por el lock de fila. Solo la primera entrega queda PENDING; las
  siguientes incrementan `delivery_count` y se responden como DUPLICATE.

- **Eventos de la misma orden se serializan mediante el lock de orders**: Al
  usar `SELECT ... FROM orders WHERE id = $1 FOR UPDATE`, dos workers que
  procesen eventos de la misma orden se serializan. Solo uno avanza a la vez,
  garantizando consistencia del estado.

- **Primer límite probable: PostgreSQL/pool y escrituras de auditoría**: Con
  múltiples workers, el cuello de botella será el pool de conexiones y la
  velocidad de escritura en `order_status_history` y `webhook_events`. Para
  escalar más allá, se podría particionar por `order_id` o usar réplicas de
  lectura.

- **Índice parcial por `next_attempt_at`**: El índice
  `idx_webhook_events_retry_due` sobre `(next_attempt_at, id)` con condición
  `WHERE processing_status = 'RETRY_SCHEDULED'` permite al worker localizar
  reintentos vencidos eficientemente sin escanear toda la tabla.

- **Hot spots de DLQ y auditoría**: Eventos en DLQ se acumulan en la tabla
  `webhook_events`. El índice `idx_we_dlq` permite consultas paginadas
  eficientes. Si el volumen de DLQ crece significativamente, se podría
  particionar o archivar eventos antiguos.

- **Primer componente que se rompería a 100× volumen**: A 100× volumen, el
  cuello de botella sería el polling del worker (`SELECT ... FOR UPDATE SKIP
  LOCKED`) compitiendo con muchos workers por los mismos eventos. Se resolvería
  con particionamiento por `order_id` hash, colas dedicadas por rango de ID,
  o migración a un broker de mensajes externo (Kafka/RabbitMQ). El segundo
  límite serían las escrituras de auditoría en `order_status_history`.

- **Coste del snapshot completo**: La reconciliación descarga el snapshot
  completo del proveedor (`GET /provider/orders` sin `updated_since`). Para el
  volumen del reto esto es aceptable. A mayor escala se podría usar
  `updated_since` con paginación, pero eso introduce riesgo de perder órdenes
  si el filtro del proveedor es inexacto.

- **Locks y advisory lock**: Cada orden se bloquea con `SELECT ... FOR UPDATE`
  para evitar conflictos con workers que procesen eventos de la misma orden.
  `pg_advisory_xact_lock(900000001)` serializa reconciliaciones concurrentes
  entre múltiples instancias de la API, garantizando que dos ejecuciones
  simultáneas producen el mismo estado final sin duplicar reparaciones.

- **PostgreSQL sigue siendo suficiente**: Para el volumen del reto, PostgreSQL
  maneja reconciliación, advisory locks y locks de fila sin problemas. No se
  necesita un sistema de colas externo ni un coordinador distribuido.

## Decisiones de reconciliación

- **Snapshot completo como fuente de verdad**: Se usa el snapshot completo del
  proveedor para evitar depender de filtros incrementales que podrían omitir
  órdenes. El proveedor es la fuente autoritativa del estado final.

- **No se mantiene transacción abierta durante HTTP**: El snapshot se descarga
  antes de abrir la transacción PostgreSQL. Esto evita mantener locks de base
  de datos durante una llamada HTTP potencialmente lenta, reduciendo contención.

- **provider_sequence menor nunca retrocede la orden**: Si el proveedor reporta
  un sequence menor que el local, se asume que el snapshot está desactualizado
  y no se modifica la orden. Se registra como STALE_PROVIDER_SNAPSHOT.

- **Segunda ejecución no cambia datos de negocio**: Una reconciliación repetida
  con el mismo snapshot encuentra todas las órdenes como ALREADY_OK (excepto
  las STALE). No ejecuta UPDATE ni inserta historial. Sí crea su propio
  `reconciliation_run` y `reconciliation_details` para auditoría.

- **Normalización monetaria sin Number**: Las comparaciones de amount usan
  normalización string a 2 decimales (`"100" → "100.00"`) para evitar
  imprecisiones de punto flotante. No se usa `Number` ni `parseFloat` para
  dinero.

- **BIGINT como string**: Los identificadores BIGINT (run_id) se devuelven
  como strings para evitar pérdida de precisión en JSON.

## Decisiones adicionales de recepción

### Firma HMAC y seguridad

- **HMAC-SHA256 sobre raw body**: La firma se calcula sobre los bytes exactos del
  body HTTP, no sobre `JSON.stringify(req.body)`, para evitar discrepancias por
  serialización.

- **Validación antes del DTO**: Un Guard de NestJS valida la firma antes de que
  el pipeline de validación procese el payload. Si la firma es inválida o ausente,
  se responde 401 sin ejecutar ninguna consulta SQL.

- **timingSafeEqual con validación previa**: Antes de llamar
  `crypto.timingSafeEqual`, validamos formato y longitud del hex para evitar
  excepciones por buffers de longitud diferente.

- **Dos formatos aceptados**: Se acepta tanto hex plano (64 caracteres) como el
  formato `sha256=<hex>` para mayor compatibilidad con proveedores.

- **WEBHOOK_SECRET obligatorio**: Se usa `ConfigService.getOrThrow('WEBHOOK_SECRET')`
  para que la aplicación falle al arrancar si el secreto no está configurado.
  No se usa un valor por defecto silencioso.

### Antigüedad y timestamps

- **Regla unidireccional**: Un evento se marca como antiguo solo cuando
  `occurred_at < received_at - 5 minutos`. Timestamps futuros no se marcan como
  antiguos, evitando rechazos incorrectos por diferencia de relojes.

- **Eventos antiguos se persisten como IGNORED**: Se insertan en la base de datos
  con `processing_status = 'IGNORED'` y `outcome_reason = 'STALE_TIMESTAMP'` para
  mantener trazabilidad, pero no se procesan.

### Correlación y observabilidad

- **X-Correlation-Id bidireccional**: Si el cliente envía un correlation ID
  válido (no vacío después de trim, máximo 128 caracteres), se usa tal cual.
  Si no, se genera un UUID v4. Se devuelve en header y body de respuesta, y se
  persiste en ambas tablas.

### Latencia almacenada y optimización del p95

- **CTE atómico en lugar de transacción explícita**: La ingesta de webhooks usa
  una única sentencia SQL con CTEs (`WITH evt AS (... INSERT ... ON CONFLICT ...),
  resolved AS (...), dlv AS (... INSERT ...) SELECT ...`). Una sentencia
  PostgreSQL individual ya es atómica, eliminando la necesidad de BEGIN/COMMIT.
  Esto reduce los round trips de red de 4 (BEGIN → UPSERT → INSERT delivery →
  COMMIT) a 1, lo cual baja significativamente el p95 bajo alta concurrencia.

- **Pools diferenciados API vs worker**: La API usa `DB_POOL_MAX=40` para
  soportar 100 requests concurrentes sin esperar conexiones. Cada worker usa
  `DB_POOL_MAX=2` porque procesa una transacción a la vez. Con 3 workers el
  total es 40 + 3×2 = 46 conexiones, dentro del límite de `max_connections=100`
  de PostgreSQL (por defecto). Esto deja 54 conexiones teóricas libres, aunque
  se debe reservar margen para migraciones, scripts de verificación y
  administración.

- **Causa raíz del p95 alto**: Con `--concurrency=100` y pool de 10 conexiones,
  90 requests esperaban una conexión libre. Además, cada request requería 4
  round trips (BEGIN, UPSERT, INSERT, COMMIT), multiplicando el tiempo bajo
  contención. La combinación de pool insuficiente + round trips excesivos
  producía p95 > 100 ms. Con `DB_POOL_MAX=40` el máximo potencial de solicitudes
  en cola se reduce de 90 a 60; el CTE hace que cada conexión se libere más
  rápido, logrando que la espera efectiva sea mínima.

- **Latencia medida en PostgreSQL**: `latency_ms` se calcula dentro del CTE
  usando `clock_timestamp() - received_at`. Se mide inmediatamente antes del
  INSERT de `webhook_deliveries`, después del UPSERT y de la espera del pool.
  No incluye la finalización del INSERT de la delivery en sí. La latencia HTTP
  externa (medida por el simulador) sigue siendo la medición completa de ida y
  vuelta.

- **Sentencia CTE como transacción implícita**: Ya no existe ROLLBACK explícito
  en la API. La sentencia CTE completa es una transacción implícita; si cualquier
  operación falla, PostgreSQL revierte toda la sentencia y `pool.query` rechaza
  la promesa. `pool.query` obtiene y libera internamente una conexión del pool.

## 7. Observabilidad: métricas y logs estructurados

### Métricas derivadas de PostgreSQL

- **Por qué PostgreSQL y no contadores en memoria**: Las métricas se calculan con
  una consulta SQL sobre `webhook_events` y `webhook_deliveries`. Esto garantiza
  que los valores sobreviven a reinicios de proceso y son consistentes entre
  múltiples instancias de API. Los contadores en memoria se perderían al reiniciar
  y divergirían entre réplicas. No se agrega Redis, Kafka ni prom-client porque
  las métricas dependen directamente de los datos persistidos.

- **`webhook_events_received_total`**: COUNT(*) de `webhook_deliveries`. Representa
  entregas con HMAC válido. Las firmas inválidas se excluyen porque no se persisten
  datos no confiables (el Guard rechaza con 401 sin ejecutar SQL).

- **`webhook_duplicate_events_total`**: COUNT(*) de `webhook_deliveries` donde
  `result = 'DUPLICATE'`. Permite monitorear la tasa de re-entregas del proveedor.

- **`webhook_out_of_order_events_total`**: COUNT(*) de `webhook_events` donde
  `outcome_reason = 'STALE_SEQUENCE'`. Indica eventos cuyo sequence era menor o
  igual al `last_sequence` de la orden cuando el worker los procesó.

- **`webhook_dlq_size`**: COUNT(*) de `webhook_events` donde
  `processing_status = 'DLQ'`. Es un gauge porque puede decrementarse con replays.

- **`webhook_ingest_latency_p95_ms`**: percentile_cont(0.95) sobre
  `webhook_deliveries.latency_ms`. Se calcula inmediatamente antes del INSERT de
  `webhook_deliveries` dentro del CTE atómico. Incluye procesamiento previo
  (validación, Guard HMAC), espera por conexión del pool, upsert del evento y
  contención. No incluye la ejecución final del INSERT de la delivery ni la
  escritura de la respuesta HTTP.

- **`webhook_processing_latency_p95_ms`**: percentile_cont(0.95) de
  `EXTRACT(EPOCH FROM (processed_at - received_at)) * 1000` sobre eventos con
  `processed_at IS NOT NULL` y `processing_status IN ('APPLIED', 'IGNORED')`.
  Mide el tiempo total desde la recepción del webhook hasta que el worker completó
  su procesamiento.

- **`webhook_processing_latency_p95_ms` incluye espera en cola y procesamiento**:
  Mide `processed_at - received_at`, que abarca el tiempo en cola (esperando a que
  un worker reclame el evento) más el tiempo de procesamiento del worker. No se
  debe afirmar que processing_latency siempre es mayor que ingest_latency, porque
  un evento ignorado durante la ingesta por STALE_TIMESTAMP puede tener
  `processed_at` igual a `received_at` (ambos se asignan en la misma sentencia CTE),
  resultando en un processing_latency de 0 ms.

- **Coste de ejecutar agregaciones sobre tablas crecientes**: Las consultas usan
  COUNT(*) con filtros parciales y percentile_cont() que requieren escaneos. Los
  índices parciales en migración 004 (`idx_wd_result_duplicate` y
  `idx_we_outcome_stale_sequence`) aceleran los conteos filtrados. A medida que
  las tablas crecen, el coste de las agregaciones aumentará.

- **A 100× volumen**: Se necesitaría una de estas estrategias:
  - Métricas preagregadas: un proceso batch que actualice contadores en una tabla
    `metrics_cache` periódicamente.
  - Retención: particionar `webhook_deliveries` y `webhook_events` por fecha y
    archivar o eliminar particiones antiguas.
  - Exporter dedicado: un proceso separado que lea las métricas con menor
    frecuencia y las publique a un sistema de series temporales (Prometheus con
    pushgateway o VictoriaMetrics).

### Logs estructurados

- **Estrategia de correlación API→worker**: El `correlation_id` se genera o recibe
  en la API y se persiste en `webhook_events.correlation_id`. El worker lee este
  campo al reclamar el evento y lo incluye en todos sus logs. Esto permite rastrear
  el ciclo completo de un evento desde la recepción hasta el procesamiento con un
  solo identificador.

- **Una línea JSON por evento de dominio**: Los eventos de dominio (webhook.ingested,
  worker.processing_started, etc.) se registran como JSON en una sola línea,
  directamente a stdout (info/warn) o stderr (error), sin pasar por el Logger de
  NestJS. Los logs de bootstrap y shutdown del framework pueden permanecer en su
  formato original. Esto permite procesamiento directo por herramientas como `jq`,
  Fluentd o CloudWatch Logs.

- **worker_id único por instancia**: El worker resuelve su identificador con la
  prioridad: variable de entorno `WORKER_ID` (si no vacía) → `HOSTNAME` (único por
  contenedor Docker) → `worker-${process.pid}` como fallback. Esto garantiza que
  `--scale worker=3` produzca tres identificadores distintos sin configuración
  manual, ya que Docker asigna un HOSTNAME único a cada contenedor.

- **Datos que deliberadamente no se registran**:
  - `rawBody`: contiene el payload completo del proveedor.
  - `payload`: datos de negocio del evento.
  - `X-Signature` y `WEBHOOK_SECRET`: credenciales criptográficas.
  - Contraseñas y URLs de PostgreSQL con credenciales.
  - Datos completos del proveedor en reconciliación.
  Los mensajes de error se sanitizan eliminando patrones de secretos y payloads
  grandes antes de emitirlos.

- **Campos protegidos**: Los campos `timestamp`, `level`, `service` y `event` no
  pueden ser sobrescritos por datos del caller para evitar inyección de logs.

- **Robustez**: Una falla al escribir un log nunca cambia el estado de negocio.
  Los valores `undefined` se omiten silenciosamente. Los errores se serializan
  de forma segura extrayendo solo `name` y `message` (sanitizado).
