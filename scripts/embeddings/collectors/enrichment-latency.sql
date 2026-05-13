-- End-to-end async enrichment latency.
-- Run after a Scenario 2 k6 run to compute the distribution of
-- (embedding-persisted-at) − (feedback-record-created-at).
--
-- Restrict to the run window with the :start and :end psql variables, e.g.
--   psql "$DATABASE_URL" \
--     -v start="'2026-05-13 10:00:00+00'" \
--     -v end="'2026-05-13 11:00:00+00'" \
--     -v tenant="'formbricks-hub-test-tenant'" \
--     -f collectors/enrichment-latency.sql

\set ON_ERROR_STOP on

WITH joined AS (
  SELECT
    fr.id,
    fr.tenant_id,
    fr.created_at AT TIME ZONE 'UTC'        AS fr_created_at,
    e.created_at                            AS emb_created_at,
    e.model,
    EXTRACT(EPOCH FROM (e.created_at - (fr.created_at AT TIME ZONE 'UTC'))) AS latency_s
  FROM feedback_records fr
  JOIN embeddings e ON e.feedback_record_id = fr.id
  WHERE fr.tenant_id = :tenant
    AND fr.created_at >= :start::timestamptz
    AND fr.created_at <  :end::timestamptz
)
SELECT
  COUNT(*)                                                       AS rows,
  ROUND(MIN(latency_s)::numeric, 3)                              AS min_s,
  ROUND(percentile_cont(0.50) WITHIN GROUP (ORDER BY latency_s)::numeric, 3) AS p50_s,
  ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_s)::numeric, 3) AS p95_s,
  ROUND(percentile_cont(0.99) WITHIN GROUP (ORDER BY latency_s)::numeric, 3) AS p99_s,
  ROUND(MAX(latency_s)::numeric, 3)                              AS max_s,
  ROUND(AVG(latency_s)::numeric, 3)                              AS avg_s
FROM joined;

-- Also surface any feedback records in the window that DO NOT yet have an
-- embedding — these are unfinished work the worker still needs to drain.
SELECT
  COUNT(*) AS unfinished_rows,
  MIN(fr.created_at) AS oldest_unfinished
FROM feedback_records fr
LEFT JOIN embeddings e ON e.feedback_record_id = fr.id
WHERE fr.tenant_id = :tenant
  AND fr.created_at >= :start::timestamptz
  AND fr.created_at <  :end::timestamptz
  AND fr.field_type = 'text'
  AND fr.value_text IS NOT NULL
  AND fr.value_text <> ''
  AND e.feedback_record_id IS NULL;
