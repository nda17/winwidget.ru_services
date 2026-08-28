BEGIN;

DO $restore_selected_home_content$
DECLARE
    current_content JSONB;
    next_content JSONB;
    section_content JSONB;
    updated_rows INTEGER;
BEGIN
    SELECT "content"
    INTO current_content
    FROM "platform"."home_page_content"
    WHERE "id" = 'singleton'
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    IF pg_catalog.jsonb_typeof(current_content) <> 'object' THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'Platform home page content must be a JSON object';
    END IF;

    next_content := current_content;

    IF next_content ? 'hero' THEN
        section_content := next_content -> 'hero';
        IF pg_catalog.jsonb_typeof(section_content) <> 'object' THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                MESSAGE = 'Platform hero content must be an object';
        END IF;
        section_content := section_content || pg_catalog.jsonb_build_object(
            'titleBeforeAccent', E'Увеличение конверсии\nсайта до',
            'accentText', '30%',
            'titleAfterAccent', 'с помощью умных виджетов',
            'subtitle', 'Простая интеграция, заметный результат.'
        );
        next_content := pg_catalog.jsonb_set(
            next_content,
            '{hero}',
            section_content,
            false
        );
    END IF;

    IF next_content ? 'caseStudies' THEN
        section_content := next_content -> 'caseStudies';
        IF pg_catalog.jsonb_typeof(section_content) <> 'object' THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                MESSAGE = 'Platform case studies content must be an object';
        END IF;
        IF section_content ? 'items'
            AND pg_catalog.jsonb_typeof(section_content -> 'items') <> 'array' THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                MESSAGE = 'Platform case studies items must be an array';
        END IF;
        IF section_content -> 'items' -> 0 IS NOT NULL
            AND pg_catalog.jsonb_typeof(section_content -> 'items' -> 0) <> 'object' THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                MESSAGE = 'Platform case studies item 1 must be an object';
        END IF;
        IF section_content -> 'items' -> 1 IS NOT NULL
            AND pg_catalog.jsonb_typeof(section_content -> 'items' -> 1) <> 'object' THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                MESSAGE = 'Platform case studies item 2 must be an object';
        END IF;
        IF section_content -> 'items' -> 2 IS NOT NULL
            AND pg_catalog.jsonb_typeof(section_content -> 'items' -> 2) <> 'object' THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                MESSAGE = 'Platform case studies item 3 must be an object';
        END IF;
        section_content := section_content || pg_catalog.jsonb_build_object(
            'title', 'Как это работает на практике',
            'subtitle', 'Несколько понятных сценариев, где виджеты закрывают реальные задачи бизнеса.',
            'items', pg_catalog.jsonb_build_array(
                COALESCE(section_content -> 'items' -> 0, '{}'::JSONB)
                    || pg_catalog.jsonb_build_object(
                    'title', 'Интернет-магазин',
                    'text', 'Посетитель собирается уйти без покупки. Стоп-оффер показывает персональную скидку и забирает контакт.',
                    'result', 'Часть потерянного трафика возвращается в воронку продаж.'
                ),
                COALESCE(section_content -> 'items' -> 1, '{}'::JSONB)
                    || pg_catalog.jsonb_build_object(
                    'title', 'Сайт услуг',
                    'text', 'Квиз задаёт 3-5 вопросов, помогает выбрать услугу и передаёт менеджеру уже тёплую заявку.',
                    'result', 'Менеджер видит контекст обращения, а не просто номер телефона.'
                ),
                COALESCE(section_content -> 'items' -> 2, '{}'::JSONB)
                    || pg_catalog.jsonb_build_object(
                    'title', 'Лендинг акции',
                    'text', 'Обратный отсчёт и колесо фортуны усиливают срочность и дают понятный повод оставить контакт.',
                    'result', 'Посетителю проще сделать первый шаг прямо сейчас.'
                )
            )
        );
        next_content := pg_catalog.jsonb_set(
            next_content,
            '{caseStudies}',
            section_content,
            false
        );
    END IF;

    IF next_content ? 'steps' THEN
        section_content := next_content -> 'steps';
        IF pg_catalog.jsonb_typeof(section_content) <> 'object' THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                MESSAGE = 'Platform steps content must be an object';
        END IF;
        IF section_content ? 'items'
            AND pg_catalog.jsonb_typeof(section_content -> 'items') <> 'array' THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                MESSAGE = 'Platform steps items must be an array';
        END IF;
        IF section_content -> 'items' -> 0 IS NOT NULL
            AND pg_catalog.jsonb_typeof(section_content -> 'items' -> 0) <> 'object' THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                MESSAGE = 'Platform steps item 1 must be an object';
        END IF;
        IF section_content -> 'items' -> 1 IS NOT NULL
            AND pg_catalog.jsonb_typeof(section_content -> 'items' -> 1) <> 'object' THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                MESSAGE = 'Platform steps item 2 must be an object';
        END IF;
        IF section_content -> 'items' -> 2 IS NOT NULL
            AND pg_catalog.jsonb_typeof(section_content -> 'items' -> 2) <> 'object' THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                MESSAGE = 'Platform steps item 3 must be an object';
        END IF;
        section_content := section_content || pg_catalog.jsonb_build_object(
            'title', 'Установка проще, чем сварить кофе',
            'resultText', E'Ловите\nгорячие\nлиды!',
            'items', pg_catalog.jsonb_build_array(
                COALESCE(section_content -> 'items' -> 0, '{}'::JSONB)
                    || pg_catalog.jsonb_build_object(
                    'text', 'Настройте дизайн и логику виджета'
                ),
                COALESCE(section_content -> 'items' -> 1, '{}'::JSONB)
                    || pg_catalog.jsonb_build_object(
                    'text', 'Скопируйте одну строчку кода'
                ),
                COALESCE(section_content -> 'items' -> 2, '{}'::JSONB)
                    || pg_catalog.jsonb_build_object(
                    'text', 'Вставьте в код своего сайта'
                )
            )
        );
        next_content := pg_catalog.jsonb_set(
            next_content,
            '{steps}',
            section_content,
            false
        );
    END IF;

    UPDATE "platform"."home_page_content"
    SET "content" = next_content
    WHERE "id" = 'singleton'
        AND "content" IS DISTINCT FROM next_content;

    GET DIAGNOSTICS updated_rows = ROW_COUNT;

    IF updated_rows > 1 THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'Platform selected home content restore changed more than the singleton row';
    END IF;

    IF updated_rows = 1 THEN
        PERFORM "platform"."refresh_current_semantic_fingerprint"(
            "platform"."current_semantic_fingerprint"()
        );
    END IF;
END
$restore_selected_home_content$;

COMMIT;
