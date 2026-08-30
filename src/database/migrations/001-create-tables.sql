-- 001-create-tables.sql
-- Initial schema: webhook inbox, orders, history, reconciliation

-- ============================================================
-- webhook_events — durable inbox / work queue
-- ============================================================
CREATE TABLE webhook_events (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id          VARCHAR(255)  NOT NULL UNIQUE,
    order_id          VARCHAR(255)  NOT NULL,
    event_type        VARCHAR(50)   NOT NULL,
    sequence          INTEGER       NOT NULL CHECK (sequence >= 0),
    occurred_at       TIMESTAMPTZ   NOT NULL,
    payload           JSONB         NOT NULL,
    payload_hash      VARCHAR(64)   NOT NULL,
    received_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
    processing_status VARCHAR(20)   NOT NULL DEFAULT 'PENDING'
                      CHECK (processing_status IN (
                          'PENDING', 'RETRY_SCHEDULED', 'APPLIED', 'IGNORED', 'DLQ'
                      )),
    outcome_reason    VARCHAR(50),
    attempt_count     INTEGER       NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at   TIMESTAMPTZ,
    last_error        TEXT,
    processed_at      TIMESTAMPTZ,
    delivery_count    INTEGER       NOT NULL DEFAULT 1 CHECK (delivery_count >= 1),
    replay_count      INTEGER       NOT NULL DEFAULT 0 CHECK (replay_count >= 0),
    correlation_id    VARCHAR(255)  NOT NULL
);

-- Worker polling: pending/retry events ready to process
CREATE INDEX idx_we_pollable ON webhook_events (id)
    WHERE processing_status IN ('PENDING', 'RETRY_SCHEDULED');

-- Lookup by order
CREATE INDEX idx_we_order ON webhook_events (order_id);

-- DLQ listing
CREATE INDEX idx_we_dlq ON webhook_events (id)
    WHERE processing_status = 'DLQ';

-- ============================================================
-- webhook_deliveries — HTTP delivery log (valid HMAC only)
-- ============================================================
CREATE TABLE webhook_deliveries (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id        VARCHAR(255)  NOT NULL,
    received_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
    latency_ms      NUMERIC(10,2) NOT NULL CHECK (latency_ms >= 0),
    result          VARCHAR(20)   NOT NULL
                    CHECK (result IN ('CREATED', 'DUPLICATE', 'IGNORED', 'REJECTED')),
    correlation_id  VARCHAR(255)  NOT NULL
);

CREATE INDEX idx_wd_event ON webhook_deliveries (event_id);

-- ============================================================
-- orders — payment order state
-- ============================================================
CREATE TABLE orders (
    id             VARCHAR(255) PRIMARY KEY,
    status         VARCHAR(20)  NOT NULL DEFAULT 'pending'
                   CHECK (status IN (
                       'pending', 'authorized', 'captured', 'refunded', 'failed'
                   )),
    last_sequence  INTEGER      NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
    amount         NUMERIC(12,2),
    currency       VARCHAR(3),
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ============================================================
-- order_status_history — audit trail (applied + ignored)
-- ============================================================
CREATE TABLE order_status_history (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id        VARCHAR(255)  NOT NULL REFERENCES orders(id),
    event_id        VARCHAR(255),
    sequence        INTEGER       NOT NULL,
    previous_status VARCHAR(20),
    new_status      VARCHAR(20),
    outcome         VARCHAR(20)   NOT NULL
                    CHECK (outcome IN ('APPLIED', 'IGNORED', 'RECONCILED')),
    outcome_reason  VARCHAR(50),
    source          VARCHAR(20)   NOT NULL DEFAULT 'WEBHOOK'
                    CHECK (source IN ('WEBHOOK', 'RECONCILIATION')),
    changed_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX idx_osh_order ON order_status_history (order_id, sequence);

-- ============================================================
-- reconciliation_runs — reconciliation execution log
-- ============================================================
CREATE TABLE reconciliation_runs (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ,
    orders_checked  INTEGER     NOT NULL DEFAULT 0,
    divergences     INTEGER     NOT NULL DEFAULT 0,
    repaired        INTEGER     NOT NULL DEFAULT 0,
    status          VARCHAR(20) NOT NULL DEFAULT 'RUNNING'
                    CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED'))
);

-- ============================================================
-- reconciliation_details — per-order reconciliation results
-- ============================================================
CREATE TABLE reconciliation_details (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_id              BIGINT       NOT NULL REFERENCES reconciliation_runs(id),
    order_id            VARCHAR(255) NOT NULL,
    local_status        VARCHAR(20),
    local_sequence      INTEGER,
    provider_status     VARCHAR(20),
    provider_sequence   INTEGER,
    action              VARCHAR(30)  NOT NULL
                        CHECK (action IN ('REPAIRED', 'ALREADY_OK', 'STALE_PROVIDER_SNAPSHOT')),
    repaired_at         TIMESTAMPTZ
);

CREATE INDEX idx_rd_run ON reconciliation_details (run_id);
