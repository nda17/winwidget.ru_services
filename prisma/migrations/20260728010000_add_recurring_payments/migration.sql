-- Extend the local payment state machine without deleting legacy payment rows.
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'EXPIRED';

CREATE TYPE "PaymentKind" AS ENUM ('ONE_TIME', 'RECURRING');
CREATE TYPE "AutoRenewalStatus" AS ENUM (
    'ACTIVE',
    'USER_DISABLED',
    'ADMIN_PAUSED',
    'TECHNICAL_PAUSE',
    'REVOKED'
);
CREATE TYPE "AutoRenewalConsentEventType" AS ENUM (
    'CONSENT_GRANTED',
    'USER_DISABLED',
    'ADMIN_PAUSED',
    'ADMIN_RESUMED',
    'ADMIN_REVOKED',
    'TECHNICAL_PAUSED',
    'TECHNICAL_RESUMED',
    'PAYMENT_METHOD_UPDATED',
    'PRICE_CHANGE_REQUIRED',
    'PRICE_CHANGE_CONFIRMED',
    'RETRY_SCHEDULED',
    'RETRY_EXHAUSTED',
    'RETRY_CANCELLED'
);

ALTER TABLE "payments"
    ALTER COLUMN "yookassa_id" DROP NOT NULL,
    ADD COLUMN "provider_idempotency_key" TEXT,
    ADD COLUMN "recurring_cycle_key" TEXT,
    ADD COLUMN "recurring_attempt" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "kind" "PaymentKind" NOT NULL DEFAULT 'ONE_TIME',
    ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'RUB',
    ADD COLUMN "provider_status" TEXT,
    ADD COLUMN "auto_renew" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "consent_version" TEXT,
    ADD COLUMN "consent_text" TEXT,
    ADD COLUMN "consented_at" TIMESTAMP(3),
    ADD COLUMN "consent_ip" TEXT,
    ADD COLUMN "consent_user_agent" TEXT,
    ADD COLUMN "offer_snapshot" TEXT,
    ADD COLUMN "offer_sha256" TEXT,
    ADD COLUMN "offer_updated_at" TIMESTAMP(3),
    ADD COLUMN "customer_email" TEXT,
    ADD COLUMN "customer_phone" TEXT,
    ADD COLUMN "payment_method_ciphertext" TEXT,
    ADD COLUMN "provider_created_at" TIMESTAMP(3),
    ADD COLUMN "checkout_expires_at" TIMESTAMP(3),
    ADD COLUMN "provider_expires_at" TIMESTAMP(3),
    ADD COLUMN "last_provider_checked_at" TIMESTAMP(3),
    ADD COLUMN "succeeded_at" TIMESTAMP(3),
    ADD COLUMN "cancelled_at" TIMESTAMP(3),
    ADD COLUMN "cancellation_reason" TEXT,
    ADD COLUMN "receipt_sync_eligible" BOOLEAN NOT NULL DEFAULT false;

UPDATE "payments"
SET
    "checkout_expires_at" = "created_at" + INTERVAL '1 hour',
    "provider_created_at" = "created_at",
    "provider_status" = CASE
        WHEN "status" = 'SUCCEEDED' THEN 'succeeded'
        WHEN "status" = 'CANCELLED' THEN 'canceled'
        ELSE 'pending'
    END,
    "succeeded_at" = CASE
        WHEN "status" = 'SUCCEEDED' THEN "updated_at"
        ELSE NULL
    END,
    "cancelled_at" = CASE
        WHEN "status" = 'CANCELLED' THEN "updated_at"
        ELSE NULL
    END;

ALTER TABLE "payments"
    ALTER COLUMN "checkout_expires_at" SET NOT NULL,
    ALTER COLUMN "receipt_sync_eligible" SET DEFAULT true;

ALTER TABLE "site_settings"
    ADD COLUMN "auto_renewal_signup_enabled" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "auto_renewal_charges_enabled" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "auto_renewal_charges_enabled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX "payments_provider_idempotency_key_key"
    ON "payments"("provider_idempotency_key");
CREATE UNIQUE INDEX "payments_recurring_cycle_key_key"
    ON "payments"("recurring_cycle_key");
DROP INDEX "payments_user_id_idx";
CREATE INDEX "payments_user_id_created_at_idx"
    ON "payments"("user_id", "created_at");
CREATE INDEX "payments_status_checkout_expires_at_idx"
    ON "payments"("status", "checkout_expires_at");
CREATE INDEX "payments_kind_status_created_at_idx"
    ON "payments"("kind", "status", "created_at");
ALTER TABLE "payments"
    ADD CONSTRAINT "payments_recurring_attempt_check"
    CHECK ("recurring_attempt" BETWEEN 0 AND 2);

CREATE TABLE "auto_renewals" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" "AutoRenewalStatus" NOT NULL DEFAULT 'ACTIVE',
    "plan" "Plan" NOT NULL,
    "billing_period" "BillingPeriod" NOT NULL,
    "amount" TEXT NOT NULL,
    "pending_amount" TEXT,
    "price_change_detected_at" TIMESTAMP(3),
    "currency" TEXT NOT NULL DEFAULT 'RUB',
    "payment_method_ciphertext" TEXT,
    "payment_method_type" TEXT,
    "payment_method_title" TEXT,
    "payment_method_last4" TEXT,
    "payment_method_saved_at" TIMESTAMP(3),
    "consent_version" TEXT NOT NULL,
    "consent_text" TEXT NOT NULL,
    "consented_at" TIMESTAMP(3) NOT NULL,
    "offer_snapshot" TEXT,
    "offer_sha256" TEXT,
    "offer_updated_at" TIMESTAMP(3),
    "next_charge_at" TIMESTAMP(3) NOT NULL,
    "retry_started_at" TIMESTAMP(3),
    "retry_attempt" INTEGER NOT NULL DEFAULT 0,
    "next_retry_at" TIMESTAMP(3),
    "dispatch_pending" BOOLEAN NOT NULL DEFAULT false,
    "disabled_at" TIMESTAMP(3),
    "disable_reason" TEXT,
    "last_charge_attempt_at" TIMESTAMP(3),
    "last_charge_error_code" TEXT,
    "state_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auto_renewals_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "auto_renewal_consent_events" (
    "id" TEXT NOT NULL,
    "auto_renewal_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" "AutoRenewalConsentEventType" NOT NULL,
    "actor_user_id" TEXT,
    "actor_role" TEXT,
    "source" TEXT NOT NULL,
    "reason" TEXT,
    "consent_version" TEXT NOT NULL,
    "consent_text" TEXT NOT NULL,
    "offer_snapshot" TEXT,
    "offer_sha256" TEXT,
    "offer_updated_at" TIMESTAMP(3),
    "plan" "Plan" NOT NULL,
    "billing_period" "BillingPeriod" NOT NULL,
    "amount" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'RUB',
    "ip" TEXT,
    "user_agent" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auto_renewal_consent_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "payment_receipts" (
    "id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "provider_receipt_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "type" TEXT,
    "fiscal_document_number" TEXT,
    "fiscal_storage_number" TEXT,
    "fiscal_attribute" TEXT,
    "registered_at" TIMESTAMP(3),
    "public_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_receipts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "auto_renewals_user_id_key"
    ON "auto_renewals"("user_id");
CREATE INDEX "auto_renewals_status_next_charge_at_idx"
    ON "auto_renewals"("status", "next_charge_at");
CREATE INDEX "auto_renewals_status_next_retry_at_idx"
    ON "auto_renewals"("status", "next_retry_at");
ALTER TABLE "auto_renewals"
    ADD CONSTRAINT "auto_renewals_retry_attempt_check"
    CHECK ("retry_attempt" BETWEEN 0 AND 2);
CREATE INDEX "auto_renewal_consent_events_auto_renewal_id_created_at_idx"
    ON "auto_renewal_consent_events"("auto_renewal_id", "created_at");
CREATE INDEX "auto_renewal_consent_events_user_id_created_at_idx"
    ON "auto_renewal_consent_events"("user_id", "created_at");
CREATE UNIQUE INDEX "payment_receipts_provider_receipt_id_key"
    ON "payment_receipts"("provider_receipt_id");
CREATE INDEX "payment_receipts_payment_id_registered_at_idx"
    ON "payment_receipts"("payment_id", "registered_at");

ALTER TABLE "auto_renewals"
    ADD CONSTRAINT "auto_renewals_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "auto_renewal_consent_events"
    ADD CONSTRAINT "auto_renewal_consent_events_auto_renewal_id_fkey"
    FOREIGN KEY ("auto_renewal_id") REFERENCES "auto_renewals"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "auto_renewal_consent_events"
    ADD CONSTRAINT "auto_renewal_consent_events_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payment_receipts"
    ADD CONSTRAINT "payment_receipts_payment_id_fkey"
    FOREIGN KEY ("payment_id") REFERENCES "payments"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Change only untouched legacy homepage copy. Custom admin values are preserved.
UPDATE "home_page_content"
SET
    "content" = jsonb_set(
        "content",
        '{hero,benefits}',
        (
            SELECT jsonb_agg(
                CASE
                    WHEN benefit->>'text' = 'Без привязки карты'
                    THEN jsonb_set(benefit, '{text}', to_jsonb('Оплата через ЮKassa'::text))
                    ELSE benefit
                END
                ORDER BY position
            )
            FROM jsonb_array_elements("content"#>'{hero,benefits}')
                WITH ORDINALITY AS benefits(benefit, position)
        ),
        false
    ),
    "updated_at" = CURRENT_TIMESTAMP
WHERE jsonb_typeof("content"#>'{hero,benefits}') = 'array'
  AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements("content"#>'{hero,benefits}') AS benefit
      WHERE benefit->>'text' = 'Без привязки карты'
  );

UPDATE "home_page_content"
SET
    "content" = jsonb_set(
        "content",
        '{cta,benefits}',
        (
            SELECT jsonb_agg(
                CASE
                    WHEN benefit->>'text' = E'Без привязки\nбанковской карты'
                    THEN jsonb_set(
                        benefit,
                        '{text}',
                        to_jsonb(E'Безопасная оплата\nчерез ЮKassa'::text)
                    )
                    ELSE benefit
                END
                ORDER BY position
            )
            FROM jsonb_array_elements("content"#>'{cta,benefits}')
                WITH ORDINALITY AS benefits(benefit, position)
        ),
        false
    ),
    "updated_at" = CURRENT_TIMESTAMP
WHERE jsonb_typeof("content"#>'{cta,benefits}') = 'array'
  AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements("content"#>'{cta,benefits}') AS benefit
      WHERE benefit->>'text' = E'Без привязки\nбанковской карты'
  );

-- Append the recurring-payment terms without replacing the existing
-- administrator-managed offer. The marker prevents duplicate inserts if the
-- migration is replayed while preparing an environment.
INSERT INTO "legal_pages" ("slug", "content", "updated_at")
VALUES (
    'oferta',
    $winwidget_offer$
<section data-winwidget-section="auto-renewal-v1">
  <h2>Автоматическое продление подписки</h2>
  <p>Пользователь может выбрать разовую оплату либо подключить автоматическое продление подписки. Автоматическое продление подключается только после отдельного согласия Пользователя на странице оплаты.</p>
  <p>При подключении автоматического продления Пользователь поручает Исполнителю сохранить в ЮKassa выбранный способ оплаты и инициировать последующие безакцептные списания (без дополнительного подтверждения каждой операции) в размере и с периодичностью, указанными на странице оплаты: ежемесячно либо ежегодно. Первоначальный платёж подтверждается Пользователем в ЮKassa. Последующие платежи выполняются с использованием сохранённого способа оплаты при наступлении даты очередного продления.</p>
  <p>Пользователь вправе в любое время отключить автоматическое продление в личном кабинете либо направить отказ в электронной форме в службу поддержки по адресу <a href="mailto:info@winwidget.ru">info@winwidget.ru</a>, указав адрес электронной почты или номер телефона, привязанный к учётной записи. После получения и идентификации такого отказа Исполнитель прекращает использовать сохранённый способ оплаты для будущих списаний. Отключение не отменяет платёж, выполненный до получения отказа, и не прекращает текущий оплаченный период. Само по себе отключение не означает автоматического возврата денежных средств, однако настоящее положение не ограничивает права гражданина-потребителя на отказ от договора и возврат денежных средств в случаях и порядке, предусмотренных законодательством Российской Федерации, включая статью 32 Закона Российской Федерации от 07.02.1992 № 2300-1 «О защите прав потребителей».</p>
  <p>Если первая попытка очередного списания отклонена из-за недостатка денежных средств либо временной недоступности банка, Исполнитель вправе выполнить не более двух повторных попыток: ориентировочно через 24 часа и через 72 часа с момента первого отказа. Запрос на каждую повторную попытку может быть отправлен в течение не более одного часа после соответствующего расчётного момента; если в это окно он не отправлен, такая попытка автоматически не выполняется. Размер каждого повторного списания не превышает сумму, подтверждённую Пользователем для соответствующего периода продления. До отправки запроса на повторную попытку Пользователь может отключить автоматическое продление в личном кабинете или через службу поддержки.</p>
  <p>Новый период подписки начинается и доступ продлевается только после успешного завершения первоначальной либо одной из разрешённых повторных попыток списания; до этого новый период не считается оплаченным. При иных причинах отказа повторные списания автоматически не выполняются. Если ни одна из разрешённых повторных попыток не завершилась успешно, подписка на новый период не продлевается, а автоматическое продление приостанавливается. Исполнитель также вправе временно приостановить автоматическое продление при технической ошибке, отсутствии сохранённого способа оплаты, неподтверждённом контакте или несоответствии состояния подписки.</p>
  <p>При изменении стоимости тарифа новая цена не списывается автоматически. Автоматическое продление приостанавливается до отдельного подтверждения Пользователем прежней и новой стоимости в личном кабинете. Если Пользователь не подтвердит новую стоимость, подписка действует до окончания уже оплаченного периода и далее автоматически не продлевается.</p>
  <p>При каждом успешном расчёте Исполнитель обеспечивает направление электронного кассового чека на адрес электронной почты или абонентский номер, предоставленный Пользователем до совершения расчёта. Сведения о платежах и доступные ссылки на кассовые чеки размещаются в личном кабинете. Ссылка на чек на сайте оператора фискальных данных в личном кабинете является дополнительным способом доступа к уже сформированному чеку и не заменяет его направление Пользователю в установленном законом порядке. Факт согласия, выбранный тариф, периодичность, сумма, дата и технические данные подтверждения фиксируются Исполнителем.</p>
</section>
    $winwidget_offer$,
    CURRENT_TIMESTAMP
)
ON CONFLICT ("slug") DO UPDATE
SET
    "content" = CASE
        WHEN POSITION(
            'data-winwidget-section="auto-renewal-v1"'
            IN "legal_pages"."content"
        ) > 0
        THEN "legal_pages"."content"
        ELSE CONCAT(
            "legal_pages"."content",
            E'\n',
            EXCLUDED."content"
        )
    END,
    "updated_at" = CASE
        WHEN POSITION(
            'data-winwidget-section="auto-renewal-v1"'
            IN "legal_pages"."content"
        ) > 0
        THEN "legal_pages"."updated_at"
        ELSE CURRENT_TIMESTAMP
    END;

-- Document the personal-data processing that is specific to payments and
-- auto-renewal without replacing the administrator-managed policy.
INSERT INTO "legal_pages" ("slug", "content", "updated_at")
VALUES (
    'personal-policy',
    $winwidget_personal_policy$
<section data-winwidget-section="recurring-personal-data-v1">
  <h2>Данные при оплате и автоматическом продлении</h2>
  <p>Для заключения и исполнения договора, приёма оплаты, подключения и управления автоматическим продлением, подтверждения согласия, предотвращения ошибочных и дублирующих списаний, формирования и доставки кассовых чеков, рассмотрения обращений и защиты прав сторон Оператор обрабатывает идентификатор Пользователя, выбранный тариф и период, сумму и статус платежа, идентификаторы платежа и кассового чека, предоставленные адрес электронной почты или номер телефона, дату и редакцию согласия, IP-адрес и сведения User-Agent, а также полученные от ЮKassa тип, наименование и маскированные сведения о сохранённом способе оплаты, включая последние четыре цифры номера карты при их наличии.</p>
  <p>Оператор не запрашивает и не хранит полный номер банковской карты, код CVC/CVV и срок её действия. Идентификатор сохранённого способа оплаты предоставляет ЮKassa; у Оператора он хранится в зашифрованном виде и используется только для разрешённых Пользователем повторных списаний. После идентифицированного отказа Пользователя от автоматического продления этот идентификатор удаляется из активного автопродления и связанных незавершённых платёжных попыток и не используется для будущих списаний.</p>
  <p>Для проведения платежей и сохранения способа оплаты данные передаются ООО НКО «ЮМани» (сервис ЮKassa), а для фискализации, направления и предоставления кассового чека — подключённой онлайн-кассе и оператору фискальных данных в объёме, необходимом для исполнения соответствующих обязанностей. Самостоятельные правила обработки данных указанными лицами размещаются на их официальных ресурсах.</p>
  <p>Данные хранятся до достижения указанных целей, окончания срока действия договора и обязательных сроков хранения платёжных, бухгалтерских и фискальных документов, а также срока, необходимого для предъявления или защиты законных требований. После прекращения правовых оснований данные удаляются либо обезличиваются в установленном порядке.</p>
</section>
    $winwidget_personal_policy$,
    CURRENT_TIMESTAMP
)
ON CONFLICT ("slug") DO UPDATE
SET
    "content" = CASE
        WHEN POSITION(
            'data-winwidget-section="recurring-personal-data-v1"'
            IN "legal_pages"."content"
        ) > 0
        THEN "legal_pages"."content"
        ELSE CONCAT(
            "legal_pages"."content",
            E'\n',
            EXCLUDED."content"
        )
    END,
    "updated_at" = CASE
        WHEN POSITION(
            'data-winwidget-section="recurring-personal-data-v1"'
            IN "legal_pages"."content"
        ) > 0
        THEN "legal_pages"."updated_at"
        ELSE CURRENT_TIMESTAMP
    END;
