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

- **503 ante fallo de PostgreSQL en la API**: Si la transacción de ingesta falla,
  se ejecuta ROLLBACK, se libera el cliente en `finally`, y se responde 503 para
  que el proveedor reintente.

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

- **Alternativas descartadas**:
  - Esperar eventos faltantes: aumenta complejidad y latencia, requiere timeouts
    y manejo de eventos que nunca llegan.
  - Usar `occurred_at` como orden principal: los relojes del proveedor no son
    confiables y podrían generar conflictos con timestamps idénticos.

## 4. Reintentos

Pendiente de implementar en una fase posterior.

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

- **Reintentos**: Pendiente para Fase 4.

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

### Latencia almacenada

- **Medición después del upsert**: `latency_ms` se calcula en el repositorio
  después del upsert de `webhook_events` e inmediatamente antes de insertar
  `webhook_deliveries`. La métrica almacenada representa el tiempo de ingesta
  hasta el registro de la entrega, incluyendo espera del pool, BEGIN y upsert
  (con posible contención por event_id).

- **Medición externa como fuente autoritativa**: La medición HTTP del script de
  verificación sigue siendo la fuente autoritativa para la latencia HTTP completa
  de ida y vuelta.
