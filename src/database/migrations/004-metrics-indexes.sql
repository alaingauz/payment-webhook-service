-- 004-metrics-indexes.sql
-- Partial indexes to accelerate metrics aggregation queries

-- Fast count of duplicate deliveries for webhook_duplicate_events_total
CREATE INDEX IF NOT EXISTS idx_wd_result_duplicate
    ON webhook_deliveries (id)
    WHERE result = 'DUPLICATE';

-- Fast count of stale-sequence events for webhook_out_of_order_events_total
CREATE INDEX IF NOT EXISTS idx_we_outcome_stale_sequence
    ON webhook_events (id)
    WHERE outcome_reason = 'STALE_SEQUENCE';
