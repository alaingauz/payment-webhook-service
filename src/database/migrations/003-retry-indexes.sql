-- 003-retry-indexes.sql
-- Index and constraint for retry scheduling

-- Partial index to locate retry-due events efficiently
CREATE INDEX IF NOT EXISTS idx_webhook_events_retry_due
    ON webhook_events (next_attempt_at, id)
    WHERE processing_status = 'RETRY_SCHEDULED';

-- Constraint: RETRY_SCHEDULED events must have next_attempt_at set
ALTER TABLE webhook_events
    ADD CONSTRAINT chk_retry_scheduled_has_next_attempt
    CHECK (
        processing_status <> 'RETRY_SCHEDULED'
        OR next_attempt_at IS NOT NULL
    );
