UPDATE billing.payments
SET provider_snapshot = provider_snapshot #- '{payment_method,id}'
WHERE provider_snapshot IS NOT NULL
  AND jsonb_typeof(provider_snapshot -> 'payment_method') = 'object'
  AND (provider_snapshot -> 'payment_method') ? 'id';
