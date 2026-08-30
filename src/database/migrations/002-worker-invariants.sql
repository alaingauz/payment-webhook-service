-- 002-worker-invariants.sql
-- Second defense: unique partial index on event_id in order_status_history
-- Guarantees a webhook event cannot produce two history entries.
-- Does not affect reconciliation entries (event_id IS NULL).

CREATE UNIQUE INDEX uq_order_status_history_event_id
    ON order_status_history (event_id)
    WHERE event_id IS NOT NULL;
