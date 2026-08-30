# Decisiones

## 1. Exactamente una vez

- **UNIQUE(event_id) + upsert atómico**: La restricción UNIQUE en `event_id`
  garantiza que PostgreSQL rechace inserciones duplicadas a nivel de base de
  datos. Usamos `INSERT ... ON CONFLICT (event_id) DO UPDATE SET delivery_count
  = delivery_count + 1 RETURNING ...` para detectar duplicados sin SELECT previo
  y sin locks en memoria.

- **La API confirma solamente después del COMMIT**: El endpoint responde HTTP 202
  únicamente después de que la transacción PostgreSQL haya hecho COMMIT. Si el
  proceso muere entre el COMMIT y la respuesta HTTP, el evento ya está persistido
  y el proveedor reenviará, resultando en un duplicado idempotente.

- **El evento queda en PostgreSQL como durable inbox antes del 202**: Esto
  garantiza que ningún evento se pierde. El patrón durable inbox asegura que el
  evento sobrevive a caídas del proceso.

- **El worker futuro podrá recuperarlo aunque la API muera**: Al tener el evento
  en `webhook_events` con `processing_status = 'PENDING'`, un worker futuro puede
  hacer polling de eventos pendientes y procesarlos independientemente del estado
  de la API.

- **La garantía es exactamente una vez sobre el efecto de negocio**: La
  idempotencia se logra a nivel de efecto de negocio (cada `event_id` se procesa
  una sola vez), no "exactly-once delivery" a nivel de red. Las re-entregas del
  proveedor se registran como DUPLICATE en `webhook_deliveries` sin modificar el
  evento original.

## 2. Caída a mitad del procesamiento

- **503 ante fallo de PostgreSQL**: Si la transacción falla, se ejecuta ROLLBACK,
  se libera el cliente en `finally`, y se responde 503 para que el proveedor
  reintente. El evento no se pierde porque nunca se hizo durable.

- **COMMIT antes del 202**: Primero se hace COMMIT y solamente después se devuelve
  el 202. Si el proceso muere después del COMMIT pero antes de la respuesta HTTP,
  el evento ya está seguro en PostgreSQL y la siguiente entrega será un duplicado
  idempotente.

- **El worker futuro podrá recuperar eventos pendientes**: Los eventos con
  `processing_status = 'PENDING'` quedan disponibles para un worker futuro que
  los procese aunque la API haya muerto.

## 3. Desorden

Pendiente de implementar en una fase posterior.

## 4. Reintentos

Pendiente de implementar en una fase posterior.

## 5. Uso de IA

- **Junie** fue usado para implementación y generación inicial de pruebas.
- **Codex** fue usado para diseño, revisión técnica y detección de riesgos.
- El candidato revisó los cambios y ejecutó las verificaciones.

## 6. Escala

Pendiente de implementar en una fase posterior.

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
