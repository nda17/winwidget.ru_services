-- Remove cancelled future-widget cards from persisted homepage content.
-- Implemented widgets and unrelated tariff/affiliate features are preserved.
UPDATE "home_page_content"
SET
    "content" = jsonb_set(
        "content",
        '{tools,items}',
        COALESCE(
            (
                SELECT jsonb_agg(tool ORDER BY position)
                FROM jsonb_array_elements("content"#>'{tools,items}')
                    WITH ORDINALITY AS tools(tool, position)
                WHERE btrim(COALESCE(tool->>'title', '')) NOT IN (
                    'Отзывы',
                    'Социальное доказательство',
                    'Сравнение тарифов',
                    'Запись на услугу',
                    'NPS-опрос',
                    'Брошенная корзина',
                    'Реферальный виджет'
                )
            ),
            '[]'::jsonb
        ),
        false
    ),
    "updated_at" = CURRENT_TIMESTAMP
WHERE jsonb_typeof("content"#>'{tools,items}') = 'array'
  AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements("content"#>'{tools,items}') AS tool
      WHERE btrim(COALESCE(tool->>'title', '')) IN (
          'Отзывы',
          'Социальное доказательство',
          'Сравнение тарифов',
          'Запись на услугу',
          'NPS-опрос',
          'Брошенная корзина',
          'Реферальный виджет'
      )
  );
