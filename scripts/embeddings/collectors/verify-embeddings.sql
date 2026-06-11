-- Sanity-check that the embeddings produced during the load test match the
-- expected model and 768-dimension contract.
--
-- Usage:
--   psql "$DATABASE_URL" \
--     -v tenant="'formbricks-hub-test-tenant'" \
--     -v start="'2026-05-13 10:00:00+00'" \
--     -v end="'2026-05-13 11:00:00+00'" \
--     -f collectors/verify-embeddings.sql

\set ON_ERROR_STOP on

-- Per-model row counts and embedding dimensionality.
SELECT
  e.model,
  COUNT(*)                                          AS rows,
  MIN(vector_dims(e.embedding::vector))             AS min_dim,
  MAX(vector_dims(e.embedding::vector))             AS max_dim
FROM embeddings e
JOIN feedback_records fr ON fr.id = e.feedback_record_id
WHERE fr.tenant_id = :tenant
  AND fr.created_at >= :start::timestamptz
  AND fr.created_at <  :end::timestamptz
GROUP BY e.model
ORDER BY rows DESC;

-- Coverage: how many of the eligible feedback_records actually got embedded.
SELECT
  COUNT(*) FILTER (WHERE e.feedback_record_id IS NOT NULL) AS with_embedding,
  COUNT(*) FILTER (WHERE e.feedback_record_id IS NULL)     AS without_embedding,
  COUNT(*)                                                 AS total_eligible
FROM feedback_records fr
LEFT JOIN embeddings e ON e.feedback_record_id = fr.id
WHERE fr.tenant_id = :tenant
  AND fr.field_type = 'text'
  AND fr.value_text IS NOT NULL
  AND fr.value_text <> ''
  AND fr.created_at >= :start::timestamptz
  AND fr.created_at <  :end::timestamptz;
