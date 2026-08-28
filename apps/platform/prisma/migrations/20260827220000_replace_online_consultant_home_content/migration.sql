BEGIN;

DO $replace_online_consultant_home_content$
DECLARE
    current_content JSONB;
    next_content JSONB;
    section_content JSONB;
    nested_content JSONB;
    transformed_items JSONB;
    remaining_items JSONB;
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

    IF next_content ? 'seo' THEN
        section_content := next_content -> 'seo';
        IF pg_catalog.jsonb_typeof(section_content) <> 'object' THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Platform home page SEO content must be an object';
        END IF;
        section_content := section_content || pg_catalog.jsonb_build_object(
            'title', 'Winwidget — AI-консультант и виджеты для сайта',
            'description', 'AI-консультант Winwidget отвечает клиентам 24/7 по вашей текстовой инструкции. Колесо фортуны, квиз, заказ звонка и другие виджеты помогают расти конверсии.',
            'keywords', pg_catalog.jsonb_build_array(
                'ai консультант для сайта',
                'ai чат для сайта',
                'виртуальный консультант',
                'виджет колесо фортуны',
                'виджет для сайта',
                'увеличение конверсии',
                'winwidget'
            ),
            'ogTitle', 'Winwidget — AI-консультант для вашего сайта',
            'ogDescription', 'Добавьте текстовую инструкцию о компании, товарах и ценах — AI-оператор будет отвечать клиентам круглосуточно.'
        );
        next_content := pg_catalog.jsonb_set(next_content, '{seo}', section_content, false);
    END IF;

    IF next_content ? 'technicalSeo' THEN
        section_content := next_content -> 'technicalSeo';
        IF pg_catalog.jsonb_typeof(section_content) <> 'object' THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Platform technical SEO content must be an object';
        END IF;
        IF section_content ? 'robotsDisallow' THEN
            nested_content := section_content -> 'robotsDisallow';
            IF pg_catalog.jsonb_typeof(nested_content) <> 'array' THEN
                RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Platform robotsDisallow content must be an array';
            END IF;
            IF NOT nested_content @> '["/ai-consultants/"]'::JSONB THEN
                nested_content := nested_content || '["/ai-consultants/"]'::JSONB;
            END IF;
            IF NOT nested_content @> '["/page-ai-consultant/"]'::JSONB THEN
                nested_content := nested_content || '["/page-ai-consultant/"]'::JSONB;
            END IF;
            section_content := pg_catalog.jsonb_set(
                section_content,
                '{robotsDisallow}',
                nested_content,
                false
            );
            next_content := pg_catalog.jsonb_set(
                next_content,
                '{technicalSeo}',
                section_content,
                false
            );
        END IF;
    END IF;

    IF next_content ? 'demoWidgets' THEN
        section_content := next_content -> 'demoWidgets';
        IF pg_catalog.jsonb_typeof(section_content) <> 'object' THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Platform demo widget content must be an object';
        END IF;
        IF section_content ? 'bubbleTexts' THEN
            nested_content := section_content -> 'bubbleTexts';
            IF pg_catalog.jsonb_typeof(nested_content) <> 'object' THEN
                RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Platform demo widget bubble texts must be an object';
            END IF;
            nested_content := (nested_content - 'onlineConsultant') ||
                pg_catalog.jsonb_build_object(
                    'aiConsultant',
                    'Задайте вопрос AI-оператору'
                );
            section_content := pg_catalog.jsonb_set(
                section_content,
                '{bubbleTexts}',
                nested_content,
                false
            );
            next_content := pg_catalog.jsonb_set(
                next_content,
                '{demoWidgets}',
                section_content,
                false
            );
        END IF;
    END IF;

    IF next_content ? 'hero' THEN
        section_content := next_content -> 'hero';
        IF pg_catalog.jsonb_typeof(section_content) <> 'object' THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Platform hero content must be an object';
        END IF;
        section_content := section_content || pg_catalog.jsonb_build_object(
            'titleBeforeAccent', E'AI-консультант отвечает\nвашим клиентам',
            'accentText', '24/7',
            'titleAfterAccent', 'по вашим инструкциям',
            'subtitle', 'Добавьте текст о товарах, ценах и условиях — AI-оператор будет отвечать на вопросы прямо на сайте.'
        );
        next_content := pg_catalog.jsonb_set(next_content, '{hero}', section_content, false);
    END IF;

    IF next_content ? 'tools' THEN
        section_content := next_content -> 'tools';
        IF pg_catalog.jsonb_typeof(section_content) <> 'object' THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Platform tools content must be an object';
        END IF;
        section_content := section_content || pg_catalog.jsonb_build_object(
            'title',
            'AI-консультант и виджеты для вашего сайта'
        );
        IF section_content ? 'items' THEN
            nested_content := section_content -> 'items';
            IF pg_catalog.jsonb_typeof(nested_content) <> 'array' THEN
                RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Platform tools items must be an array';
            END IF;
            SELECT COALESCE(
                pg_catalog.jsonb_agg(
                    CASE
                        WHEN item.value ->> 'previewType' IN (
                            'onlineConsultant',
                            'aiConsultant'
                        )
                        THEN item.value || pg_catalog.jsonb_build_object(
                            'title', 'AI-консультант',
                            'description', E'Отвечает на вопросы 24/7 по вашей текстовой инструкции.\nЕсли в промпте нет нужной информации, честно сообщает об этом.',
                            'previewType', 'aiConsultant'
                        )
                        ELSE item.value
                    END
                    ORDER BY item.ordinality
                ),
                '[]'::JSONB
            )
            INTO transformed_items
            FROM pg_catalog.jsonb_array_elements(nested_content)
                WITH ORDINALITY AS item(value, ordinality);
            section_content := pg_catalog.jsonb_set(
                section_content,
                '{items}',
                transformed_items,
                false
            );
        END IF;
        next_content := pg_catalog.jsonb_set(next_content, '{tools}', section_content, false);
    END IF;

    IF next_content ? 'caseStudies' THEN
        section_content := next_content -> 'caseStudies';
        IF pg_catalog.jsonb_typeof(section_content) <> 'object' THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Platform case studies content must be an object';
        END IF;
        section_content := section_content || pg_catalog.jsonb_build_object(
            'title', 'Как AI-консультант и виджеты помогают бизнесу',
            'subtitle', 'Три понятных сценария без выдуманных цифр и обещаний.',
            'items', pg_catalog.jsonb_build_array(
                pg_catalog.jsonb_build_object(
                    'title', 'Интернет-магазин',
                    'text', 'Владелец добавляет в промпт цены, условия оплаты и доставки. AI-оператор отвечает на типовые вопросы прямо на сайте.',
                    'result', 'Покупатель быстро получает информацию из инструкции компании, а важные условия можно перепроверить.'
                ),
                pg_catalog.jsonb_build_object(
                    'title', 'Сайт услуг',
                    'text', 'AI-консультант объясняет разницу между услугами, а квиз помогает собрать параметры задачи.',
                    'result', 'Посетителю проще разобраться в предложении и перейти к нужному сценарию.'
                ),
                pg_catalog.jsonb_build_object(
                    'title', 'Неполная инструкция',
                    'text', 'Посетитель спрашивает о товаре, которого нет в текстовом промпте. AI-оператор не обходит сайт и сообщает, что подтверждённых данных недостаточно.',
                    'result', 'Клиент честно видит, что данных недостаточно, а владелец понимает, чем дополнить инструкцию.'
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
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Platform steps content must be an object';
        END IF;
        section_content := section_content || pg_catalog.jsonb_build_object(
            'title', 'Запустите AI-консультанта за три шага',
            'resultText', E'AI-оператор\nготов\nотвечать!',
            'items', pg_catalog.jsonb_build_array(
                pg_catalog.jsonb_build_object(
                    'text',
                    'Укажите имя, приветствие и текстовый промпт'
                ),
                pg_catalog.jsonb_build_object(
                    'text',
                    'Настройте цвет, сторону экрана и тайм-аут'
                ),
                pg_catalog.jsonb_build_object(
                    'text',
                    'Проверьте ответы, опубликуйте и вставьте одну строчку кода'
                )
            )
        );
        next_content := pg_catalog.jsonb_set(next_content, '{steps}', section_content, false);
    END IF;

    IF next_content ? 'seoText' THEN
        section_content := next_content -> 'seoText';
        IF pg_catalog.jsonb_typeof(section_content) <> 'object' THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Platform SEO text content must be an object';
        END IF;
        section_content := section_content || pg_catalog.jsonb_build_object(
            'title', 'AI-консультант и виджеты для роста конверсии',
            'text', 'Winwidget объединяет AI-консультанта и интерактивные виджеты для сайта. AI-оператор отвечает на вопросы о товарах, ценах и условиях по текстовой инструкции владельца виджета. Он не загружает файлы, не обходит сайт и не использует отдельную базу знаний: если данных в промпте нет, он честно сообщает об этом. Колесо фортуны, квиз, заказ звонка, таймер, стоп-оффер и калькулятор дополняют чат и помогают вовлекать посетителей без сложной разработки.'
        );
        next_content := pg_catalog.jsonb_set(next_content, '{seoText}', section_content, false);
    END IF;

    IF next_content ? 'faq' THEN
        section_content := next_content -> 'faq';
        IF pg_catalog.jsonb_typeof(section_content) <> 'object' THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Platform FAQ content must be an object';
        END IF;
        IF section_content ? 'items' THEN
            nested_content := section_content -> 'items';
            IF pg_catalog.jsonb_typeof(nested_content) <> 'array' THEN
                RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Platform FAQ items must be an array';
            END IF;
            SELECT COALESCE(
                pg_catalog.jsonb_agg(item.value ORDER BY item.ordinality)
                    FILTER (WHERE item.ordinality > 6),
                '[]'::JSONB
            )
            INTO remaining_items
            FROM pg_catalog.jsonb_array_elements(nested_content)
                WITH ORDINALITY AS item(value, ordinality);
            transformed_items := pg_catalog.jsonb_build_array(
                pg_catalog.jsonb_build_object(
                    'question', 'Что такое AI-консультант?',
                    'answerHtml', 'Это чат на сайте, в котором AI-оператор отвечает на вопросы посетителей. Имя оператора, приветствие, текстовую инструкцию и внешний вид задаёт владелец виджета. В интерфейсе всегда видно, что это AI, а не реальный сотрудник.'
                ),
                pg_catalog.jsonb_build_object(
                    'question', 'Откуда AI-консультант берёт ответы?',
                    'answerHtml', 'Из текстового промпта, который вы задаёте в настройках. Туда можно добавить сведения о компании, товарах, ценах, доставке и других условиях. Загрузки PDF и Word, обхода сайта и отдельной базы знаний в текущей версии нет.'
                ),
                pg_catalog.jsonb_build_object(
                    'question', 'Что будет, если в промпте нет нужной информации?',
                    'answerHtml', 'Сервис требует подтверждать ответ фрагментом вашей инструкции. Если подтверждения нет, AI-оператор сообщает, что данных недостаточно. Перед публикацией проверьте важные цены и условия в тестовом чате.'
                ),
                pg_catalog.jsonb_build_object(
                    'question', 'Можно ли спрашивать AI-оператора на посторонние темы?',
                    'answerHtml', 'Спросить можно, но AI-консультант ограничивает разговор темой сайта и бизнеса. На просьбы, не относящиеся к указанной информации, он вежливо предлагает задать вопрос по теме.'
                ),
                pg_catalog.jsonb_build_object(
                    'question', 'Можно ли настроить имя и внешний вид AI-оператора?',
                    'answerHtml', 'Да. По умолчанию оператора зовут Alex, но имя и приветствие можно изменить. Также настраиваются основной цвет, оформление, положение слева или справа и время бездействия. Рядом с именем всегда остаётся метка «AI-оператор».'
                ),
                pg_catalog.jsonb_build_object(
                    'question', 'Как установить AI-консультанта на сайт?',
                    'answerHtml', 'Создайте виджет в личном кабинете, заполните промпт, проверьте ответы в тестовом чате и опубликуйте настройки. Затем скопируйте сгенерированный код и вставьте его перед закрывающим тегом &lt;/body&gt; — AI-консультант появится автоматически.'
                )
            ) || remaining_items;
            section_content := pg_catalog.jsonb_set(
                section_content,
                '{items}',
                transformed_items,
                false
            );
            next_content := pg_catalog.jsonb_set(next_content, '{faq}', section_content, false);
        END IF;
    END IF;

    UPDATE "platform"."home_page_content"
    SET "content" = next_content
    WHERE "id" = 'singleton'
        AND "content" IS DISTINCT FROM next_content;

    GET DIAGNOSTICS updated_rows = ROW_COUNT;

    IF updated_rows > 1 THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'Platform AI consultant content migration changed more than the singleton row';
    END IF;

    IF updated_rows = 1 THEN
        PERFORM "platform"."refresh_current_semantic_fingerprint"(
            "platform"."current_semantic_fingerprint"()
        );
    END IF;
END
$replace_online_consultant_home_content$;

COMMIT;
