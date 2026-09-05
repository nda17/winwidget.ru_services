BEGIN;
-- CreateTable
CREATE TABLE "billing"."crm_commerce_accounts" (
    "workspace_id" UUID NOT NULL,
    "owner_subject" VARCHAR(256) NOT NULL,
    "version" BIGINT NOT NULL DEFAULT 1,
    "capacity_command_id" UUID,
    "capacity_fence" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_commerce_accounts_pkey" PRIMARY KEY ("workspace_id")
);

-- CreateTable
CREATE TABLE "billing"."crm_commerce_commands" (
    "command_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "actor_subject" VARCHAR(256) NOT NULL,
    "command_type" VARCHAR(64) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "expected_version" BIGINT NOT NULL,
    "capacity_fence" JSONB,
    "status" VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    "order_id" UUID,
    "period_id" UUID,
    "result_version" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_commerce_commands_pkey" PRIMARY KEY ("command_id")
);

-- CreateTable
CREATE TABLE "billing"."crm_orders" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "owner_subject" VARCHAR(256) NOT NULL,
    "command_id" UUID NOT NULL,
    "capacity_command_id" UUID NOT NULL,
    "capacity_fence" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "kind" VARCHAR(32) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    "cycle" VARCHAR(16) NOT NULL,
    "total_seats" INTEGER NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'RUB',
    "policy_version" INTEGER NOT NULL,
    "price_snapshot" JSONB NOT NULL,
    "auto_renew" BOOLEAN NOT NULL DEFAULT false,
    "consent_version" VARCHAR(128),
    "consent_text" TEXT,
    "consented_at" TIMESTAMP(3),
    "customer_email" VARCHAR(320),
    "customer_phone" VARCHAR(32),
    "provider_payment_id" VARCHAR(128),
    "provider_idempotency_key" CHAR(64) NOT NULL,
    "provider_status" VARCHAR(32),
    "confirmation_url" TEXT,
    "checkout_expires_at" TIMESTAMP(3) NOT NULL,
    "succeeded_at" TIMESTAMP(3),
    "cancellation_reason" VARCHAR(128),
    "recurring_cycle_key" VARCHAR(256),
    "recurring_attempt" INTEGER NOT NULL DEFAULT 0,
    "expected_renewal_version" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."crm_paid_periods" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "cycle" VARCHAR(16) NOT NULL,
    "total_seats" INTEGER NOT NULL,
    "original_seats" INTEGER NOT NULL,
    "price_snapshot" JSONB NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "original_expires_at" TIMESTAMP(3) NOT NULL,
    "grace_until" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_paid_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."crm_auto_renewals" (
    "workspace_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "owner_subject" VARCHAR(256) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
    "cycle" VARCHAR(16) NOT NULL,
    "total_seats" INTEGER NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "price_snapshot" JSONB NOT NULL,
    "payment_method_ciphertext" TEXT NOT NULL,
    "payment_method_title" VARCHAR(256),
    "payment_method_last4" VARCHAR(4),
    "consent_version" VARCHAR(128) NOT NULL,
    "consent_text" TEXT NOT NULL,
    "consented_at" TIMESTAMP(3) NOT NULL,
    "next_charge_at" TIMESTAMP(3) NOT NULL,
    "retry_started_at" TIMESTAMP(3),
    "retry_attempt" INTEGER NOT NULL DEFAULT 0,
    "next_retry_at" TIMESTAMP(3),
    "dispatch_pending" BOOLEAN NOT NULL DEFAULT false,
    "disabled_at" TIMESTAMP(3),
    "last_error_code" VARCHAR(128),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_auto_renewals_pkey" PRIMARY KEY ("workspace_id")
);

-- CreateTable
CREATE TABLE "billing"."crm_auto_renewal_consents" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "actor_subject" VARCHAR(256) NOT NULL,
    "event_type" VARCHAR(32) NOT NULL,
    "command_id" UUID NOT NULL,
    "renewal_version" INTEGER NOT NULL,
    "evidence" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_auto_renewal_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."crm_provider_operations" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "idempotency_key" CHAR(64) NOT NULL,
    "provider_payment_id" VARCHAR(128),
    "first_dispatch_at" TIMESTAMP(3),
    "dispatch_attempt" INTEGER NOT NULL DEFAULT 0,
    "retry_attempt" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_token" UUID,
    "lease_until" TIMESTAMP(3),
    "pending_event_id" UUID NOT NULL,
    "outbox_id" TEXT NOT NULL,
    "request_snapshot" JSONB NOT NULL,
    "last_error_code" VARCHAR(128),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_provider_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."crm_provider_deliveries" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "consumer" VARCHAR(64) NOT NULL,
    "operation_id" UUID,
    "payload_hash" CHAR(64) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'PROCESSING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "lease_token" UUID,
    "lease_until" TIMESTAMP(3),
    "last_error_code" VARCHAR(128),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_provider_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."crm_payment_receipts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "provider_receipt_id" VARCHAR(128) NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "type" VARCHAR(32),
    "fiscal_document_number" VARCHAR(128),
    "fiscal_storage_number" VARCHAR(128),
    "fiscal_attribute" VARCHAR(128),
    "registered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_payment_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "crm_commerce_commands_workspace_id_created_at_idx" ON "billing"."crm_commerce_commands"("workspace_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "crm_orders_command_id_key" ON "billing"."crm_orders"("command_id");

-- CreateIndex
CREATE UNIQUE INDEX "crm_orders_provider_payment_id_key" ON "billing"."crm_orders"("provider_payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "crm_orders_provider_idempotency_key_key" ON "billing"."crm_orders"("provider_idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "crm_orders_recurring_cycle_key_key" ON "billing"."crm_orders"("recurring_cycle_key");

-- CreateIndex
CREATE INDEX "crm_orders_workspace_id_created_at_idx" ON "billing"."crm_orders"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "crm_orders_status_checkout_expires_at_idx" ON "billing"."crm_orders"("status", "checkout_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "crm_orders_id_workspace_id_key" ON "billing"."crm_orders"("id", "workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "crm_paid_periods_order_id_key" ON "billing"."crm_paid_periods"("order_id");

-- CreateIndex
CREATE INDEX "crm_paid_periods_workspace_id_starts_at_idx" ON "billing"."crm_paid_periods"("workspace_id", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "crm_paid_periods_order_id_workspace_id_key" ON "billing"."crm_paid_periods"("order_id", "workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "crm_auto_renewals_id_key" ON "billing"."crm_auto_renewals"("id");

-- CreateIndex
CREATE INDEX "crm_auto_renewals_status_next_charge_at_idx" ON "billing"."crm_auto_renewals"("status", "next_charge_at");

-- CreateIndex
CREATE INDEX "crm_auto_renewals_status_next_retry_at_idx" ON "billing"."crm_auto_renewals"("status", "next_retry_at");

-- CreateIndex
CREATE INDEX "crm_auto_renewal_consents_workspace_id_created_at_idx" ON "billing"."crm_auto_renewal_consents"("workspace_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "crm_provider_operations_idempotency_key_key" ON "billing"."crm_provider_operations"("idempotency_key");

-- CreateIndex
CREATE INDEX "crm_provider_operations_status_available_at_idx" ON "billing"."crm_provider_operations"("status", "available_at");

-- CreateIndex
CREATE INDEX "crm_provider_deliveries_status_lease_until_idx" ON "billing"."crm_provider_deliveries"("status", "lease_until");

-- CreateIndex
CREATE UNIQUE INDEX "crm_provider_deliveries_event_id_consumer_key" ON "billing"."crm_provider_deliveries"("event_id", "consumer");

-- CreateIndex
CREATE UNIQUE INDEX "crm_payment_receipts_provider_receipt_id_key" ON "billing"."crm_payment_receipts"("provider_receipt_id");

-- CreateIndex
CREATE INDEX "crm_payment_receipts_workspace_id_created_at_idx" ON "billing"."crm_payment_receipts"("workspace_id", "created_at");

-- AddForeignKey
ALTER TABLE "billing"."crm_orders" ADD CONSTRAINT "crm_orders_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "billing"."crm_commerce_accounts"("workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."crm_paid_periods" ADD CONSTRAINT "crm_paid_periods_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "billing"."crm_commerce_accounts"("workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."crm_paid_periods" ADD CONSTRAINT "crm_paid_periods_order_id_workspace_id_fkey" FOREIGN KEY ("order_id", "workspace_id") REFERENCES "billing"."crm_orders"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."crm_auto_renewals" ADD CONSTRAINT "crm_auto_renewals_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "billing"."crm_commerce_accounts"("workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."crm_auto_renewal_consents" ADD CONSTRAINT "crm_auto_renewal_consents_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "billing"."crm_commerce_accounts"("workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."crm_provider_operations" ADD CONSTRAINT "crm_provider_operations_order_id_workspace_id_fkey" FOREIGN KEY ("order_id", "workspace_id") REFERENCES "billing"."crm_orders"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."crm_provider_deliveries" ADD CONSTRAINT "crm_provider_deliveries_operation_id_fkey" FOREIGN KEY ("operation_id") REFERENCES "billing"."crm_provider_operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."crm_payment_receipts" ADD CONSTRAINT "crm_payment_receipts_order_id_workspace_id_fkey" FOREIGN KEY ("order_id", "workspace_id") REFERENCES "billing"."crm_orders"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE billing.crm_commerce_accounts
  ADD CONSTRAINT crm_commerce_accounts_version_check CHECK (version > 0),
  ADD CONSTRAINT crm_commerce_accounts_owner_check CHECK (length(owner_subject) BETWEEN 1 AND 256 AND owner_subject !~ '[[:space:][:cntrl:]]');
CREATE UNIQUE INDEX crm_commerce_commands_command_id_workspace_id_actor_subject_key ON billing.crm_commerce_commands(command_id, workspace_id, actor_subject);
CREATE UNIQUE INDEX crm_paid_periods_id_workspace_id_key ON billing.crm_paid_periods(id, workspace_id);
ALTER TABLE billing.crm_commerce_accounts ADD CONSTRAINT crm_commerce_accounts_capacity_owner_fkey FOREIGN KEY (capacity_command_id, workspace_id, owner_subject) REFERENCES billing.crm_commerce_commands(command_id, workspace_id, actor_subject) ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE billing.crm_orders ADD CONSTRAINT crm_orders_capacity_command_id_workspace_id_owner_subject_fkey FOREIGN KEY (capacity_command_id, workspace_id, owner_subject) REFERENCES billing.crm_commerce_commands(command_id, workspace_id, actor_subject) ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE billing.crm_commerce_commands ADD CONSTRAINT crm_commerce_commands_order_id_workspace_id_fkey FOREIGN KEY (order_id, workspace_id) REFERENCES billing.crm_orders(id, workspace_id) ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE billing.crm_commerce_commands ADD CONSTRAINT crm_commerce_commands_period_id_workspace_id_fkey FOREIGN KEY (period_id, workspace_id) REFERENCES billing.crm_paid_periods(id, workspace_id) ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE billing.crm_commerce_commands
  ADD CONSTRAINT crm_commerce_commands_state_check CHECK (status IN ('PENDING', 'COMMITTED', 'CANCELLED')),
  ADD CONSTRAINT crm_commerce_commands_type_check CHECK (command_type IN ('WINCRM_CHECKOUT', 'WINCRM_SEAT_CHANGE', 'WINCRM_DISABLE_RENEWAL', 'WINCRM_CONFIRM_RENEWAL', 'WINCRM_VERIFY_ORDER')),
  ADD CONSTRAINT crm_commerce_commands_hash_check CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT crm_commerce_commands_version_check CHECK (expected_version >= 0 AND (result_version IS NULL OR result_version > 0)),
  ADD CONSTRAINT crm_commerce_commands_actor_check CHECK (length(actor_subject) BETWEEN 1 AND 256 AND actor_subject !~ '[[:space:][:cntrl:]]');
ALTER TABLE billing.crm_commerce_commands ADD CONSTRAINT crm_commerce_commands_capacity_check CHECK (
  (command_type IN ('WINCRM_CHECKOUT','WINCRM_SEAT_CHANGE')) = (capacity_fence IS NOT NULL) AND
  (capacity_fence IS NULL OR (
    jsonb_typeof(capacity_fence) = 'object' AND capacity_fence ?& ARRAY['operationId','requestHash','fenceRevision','targetSeats'] AND
    capacity_fence->>'operationId' = command_id::text AND capacity_fence->>'requestHash' = request_hash AND
    jsonb_typeof(capacity_fence->'fenceRevision') = 'number' AND capacity_fence->>'fenceRevision' ~ '^[1-9][0-9]*$' AND (capacity_fence->>'fenceRevision')::numeric BETWEEN 1 AND 2147483646 AND
    jsonb_typeof(capacity_fence->'targetSeats') = 'number' AND capacity_fence->>'targetSeats' ~ '^[1-9][0-9]*$' AND (capacity_fence->>'targetSeats')::numeric BETWEEN 2 AND 10000
  )) IS TRUE);
ALTER TABLE billing.crm_orders
  ADD CONSTRAINT crm_orders_state_check CHECK (status IN ('PENDING', 'SUCCEEDED', 'CANCELLED', 'UNKNOWN')),
  ADD CONSTRAINT crm_orders_kind_check CHECK (kind IN ('ONE_TIME', 'RECURRING')),
  ADD CONSTRAINT crm_orders_cycle_check CHECK (cycle IN ('MONTHLY', 'YEARLY')),
  ADD CONSTRAINT crm_orders_money_check CHECK (amount_minor BETWEEN 1 AND 1000000000000 AND currency = 'RUB'),
  ADD CONSTRAINT crm_orders_version_check CHECK (version BETWEEN 1 AND 2147483646 AND policy_version > 0),
  ADD CONSTRAINT crm_orders_seats_check CHECK (total_seats BETWEEN 2 AND 10000 AND total_seats >= (price_snapshot->>'includedSeats')::integer),
  ADD CONSTRAINT crm_orders_snapshot_check CHECK (jsonb_typeof(price_snapshot) = 'object' AND price_snapshot ?& ARRAY['policyVersion','monthlyPriceMinor','yearlyPriceMinor','additionalSeatMonthlyPriceMinor','additionalSeatYearlyPriceMinor','includedSeats','graceDays']),
  ADD CONSTRAINT crm_orders_key_check CHECK (provider_idempotency_key ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT crm_orders_consent_check CHECK (NOT auto_renew OR (consent_version IS NOT NULL AND consent_text IS NOT NULL AND consented_at IS NOT NULL)),
  ADD CONSTRAINT crm_orders_success_check CHECK ((status = 'SUCCEEDED') = (succeeded_at IS NOT NULL)),
  ADD CONSTRAINT crm_orders_attempt_check CHECK (recurring_attempt BETWEEN 0 AND 2);
ALTER TABLE billing.crm_paid_periods
  ADD CONSTRAINT crm_paid_periods_version_check CHECK (version BETWEEN 1 AND 2147483646),
  ADD CONSTRAINT crm_paid_periods_cycle_check CHECK (cycle IN ('MONTHLY', 'YEARLY')),
  ADD CONSTRAINT crm_paid_periods_seats_check CHECK (total_seats BETWEEN 2 AND 10000 AND original_seats BETWEEN 2 AND 10000 AND total_seats >= (price_snapshot->>'includedSeats')::integer),
  ADD CONSTRAINT crm_paid_periods_time_check CHECK (starts_at < expires_at AND starts_at < original_expires_at AND grace_until >= expires_at);
ALTER TABLE billing.crm_auto_renewals
  ADD CONSTRAINT crm_auto_renewals_version_check CHECK (version BETWEEN 1 AND 2147483646),
  ADD CONSTRAINT crm_auto_renewals_state_check CHECK (status IN ('ACTIVE', 'USER_DISABLED', 'TECHNICAL_PAUSE', 'PRICE_CONFIRMATION_REQUIRED', 'REVOKED')),
  ADD CONSTRAINT crm_auto_renewals_cycle_check CHECK (cycle IN ('MONTHLY', 'YEARLY')),
  ADD CONSTRAINT crm_auto_renewals_money_check CHECK (amount_minor BETWEEN 1 AND 1000000000000),
  ADD CONSTRAINT crm_auto_renewals_seats_check CHECK (total_seats BETWEEN 2 AND 10000),
  ADD CONSTRAINT crm_auto_renewals_method_check CHECK (payment_method_ciphertext LIKE 'v1:%' AND (payment_method_last4 IS NULL OR payment_method_last4 ~ '^[0-9]{4}$')),
  ADD CONSTRAINT crm_auto_renewals_attempt_check CHECK (retry_attempt BETWEEN 0 AND 2);
ALTER TABLE billing.crm_auto_renewal_consents
  ADD CONSTRAINT crm_auto_renewal_consents_version_check CHECK (renewal_version BETWEEN 1 AND 2147483646),
  ADD CONSTRAINT crm_auto_renewal_consents_event_check CHECK (event_type IN ('ENABLED', 'DISABLED', 'PRICE_CONFIRMED', 'SEATS_CHANGED', 'PAUSED', 'REVOKED'));
ALTER TABLE billing.crm_provider_operations
  ADD CONSTRAINT crm_provider_operations_state_check CHECK (status IN ('PENDING', 'PROCESSING', 'SUCCEEDED', 'UNKNOWN', 'FAILED')),
  ADD CONSTRAINT crm_provider_operations_kind_check CHECK (kind IN ('CREATE', 'VERIFY', 'SYNC_RECEIPT')),
  ADD CONSTRAINT crm_provider_operations_version_check CHECK (version BETWEEN 1 AND 2147483646 AND dispatch_attempt >= 0 AND retry_attempt >= 0),
  ADD CONSTRAINT crm_provider_operations_lease_check CHECK ((lease_token IS NULL) = (lease_until IS NULL) AND (status = 'PROCESSING') = (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  ADD CONSTRAINT crm_provider_operations_key_check CHECK (idempotency_key ~ '^[a-f0-9]{64}$');
ALTER TABLE billing.crm_provider_deliveries
  ADD CONSTRAINT crm_provider_deliveries_state_check CHECK (status IN ('PROCESSING', 'DELIVERED', 'RETRY_SCHEDULED', 'DEAD_LETTERED')),
  ADD CONSTRAINT crm_provider_deliveries_version_check CHECK (version BETWEEN 1 AND 2147483646),
  ADD CONSTRAINT crm_provider_deliveries_hash_check CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT crm_provider_deliveries_lease_check CHECK ((lease_token IS NULL) = (lease_until IS NULL) AND (status = 'PROCESSING') = (lease_token IS NOT NULL AND lease_until IS NOT NULL));

ALTER TABLE billing.crm_paid_periods ADD COLUMN activation_notified_at TIMESTAMP(3);
CREATE INDEX crm_paid_periods_activation_notified_at_starts_at_idx ON billing.crm_paid_periods(activation_notified_at, starts_at);

CREATE FUNCTION billing.protect_wincrm_commerce_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE snapshot jsonb; price_key text; amount numeric; purchase billing.crm_orders%ROWTYPE;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') OR (TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'crm_auto_renewal_consents') THEN
    RAISE EXCEPTION 'WinCRM commerce evidence cannot be removed or rewritten';
  END IF;
  IF TG_TABLE_NAME IN ('crm_orders', 'crm_paid_periods', 'crm_auto_renewals') THEN
    snapshot := NEW.price_snapshot;
    IF jsonb_typeof(snapshot) IS DISTINCT FROM 'object' OR
      NOT snapshot ?& ARRAY['policyVersion','monthlyPriceMinor','yearlyPriceMinor','additionalSeatMonthlyPriceMinor','additionalSeatYearlyPriceMinor','includedSeats','graceDays'] OR
      (SELECT count(*) FROM jsonb_object_keys(snapshot)) <> 7 THEN
      RAISE EXCEPTION 'WinCRM price snapshot is invalid';
    END IF;
    FOREACH price_key IN ARRAY ARRAY['policyVersion','monthlyPriceMinor','yearlyPriceMinor','additionalSeatMonthlyPriceMinor','additionalSeatYearlyPriceMinor','includedSeats','graceDays'] LOOP
      IF jsonb_typeof(snapshot->price_key) IS DISTINCT FROM 'number' OR (snapshot->>price_key) !~ '^(0|[1-9][0-9]*)$' THEN
        RAISE EXCEPTION 'WinCRM price snapshot requires bounded integers';
      END IF;
    END LOOP;
    IF NOT ((snapshot->>'policyVersion')::numeric BETWEEN 1 AND 2147483646 AND
      (snapshot->>'monthlyPriceMinor')::numeric BETWEEN 1 AND 100000000 AND
      (snapshot->>'yearlyPriceMinor')::numeric BETWEEN 1 AND 100000000 AND
      (snapshot->>'additionalSeatMonthlyPriceMinor')::numeric BETWEEN 0 AND 100000000 AND
      (snapshot->>'additionalSeatYearlyPriceMinor')::numeric BETWEEN 0 AND 100000000 AND
      (snapshot->>'includedSeats')::numeric BETWEEN 2 AND 10000 AND
      (snapshot->>'graceDays')::numeric = 3 AND NEW.total_seats >= (snapshot->>'includedSeats')::numeric) THEN
      RAISE EXCEPTION 'WinCRM price snapshot range is invalid';
    END IF;
    IF TG_TABLE_NAME IN ('crm_orders', 'crm_auto_renewals') THEN
      amount := CASE WHEN NEW.cycle = 'MONTHLY' THEN (snapshot->>'monthlyPriceMinor')::numeric ELSE (snapshot->>'yearlyPriceMinor')::numeric END +
        (NEW.total_seats - (snapshot->>'includedSeats')::numeric) *
        CASE WHEN NEW.cycle = 'MONTHLY' THEN (snapshot->>'additionalSeatMonthlyPriceMinor')::numeric ELSE (snapshot->>'additionalSeatYearlyPriceMinor')::numeric END;
      IF NEW.amount_minor IS DISTINCT FROM amount THEN RAISE EXCEPTION 'WinCRM amount does not match purchase snapshot'; END IF;
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'crm_orders' THEN
    IF NEW.policy_version <> (NEW.price_snapshot->>'policyVersion')::integer THEN RAISE EXCEPTION 'WinCRM order policy binding mismatch'; END IF;
  END IF;
  IF TG_TABLE_NAME IN ('crm_paid_periods', 'crm_provider_operations') THEN
    SELECT * INTO STRICT purchase FROM billing.crm_orders WHERE id = NEW.order_id AND workspace_id = NEW.workspace_id;
    IF TG_TABLE_NAME = 'crm_paid_periods' THEN
      IF purchase.status <> 'SUCCEEDED' OR NEW.cycle <> purchase.cycle OR NEW.original_seats <> purchase.total_seats OR NEW.price_snapshot IS DISTINCT FROM purchase.price_snapshot THEN RAISE EXCEPTION 'WinCRM period purchase binding mismatch'; END IF;
    END IF;
    IF TG_TABLE_NAME = 'crm_provider_operations' THEN
    IF (
      NEW.request_snapshot->>'orderId' IS DISTINCT FROM purchase.id::text OR
      NEW.request_snapshot->>'workspaceId' IS DISTINCT FROM purchase.workspace_id::text OR
      NEW.request_snapshot->>'kind' IS DISTINCT FROM NEW.kind OR
      NEW.request_snapshot->>'amountMinor' IS DISTINCT FROM purchase.amount_minor::text OR
      NEW.request_snapshot->>'currency' IS DISTINCT FROM purchase.currency OR
      NEW.request_snapshot->>'providerKey' IS DISTINCT FROM purchase.provider_idempotency_key::text OR
      NOT NEW.request_snapshot ?& ARRAY['returnUrl','paymentMethodCiphertext'] OR
      (NEW.kind = 'CREATE' AND purchase.kind = 'ONE_TIME' AND (jsonb_typeof(NEW.request_snapshot->'returnUrl') IS DISTINCT FROM 'string' OR NEW.request_snapshot->'paymentMethodCiphertext' IS DISTINCT FROM 'null'::jsonb)) OR
      (NEW.kind = 'CREATE' AND purchase.kind = 'RECURRING' AND (NEW.request_snapshot->'returnUrl' IS DISTINCT FROM 'null'::jsonb OR jsonb_typeof(NEW.request_snapshot->'paymentMethodCiphertext') IS DISTINCT FROM 'string' OR NEW.request_snapshot->>'paymentMethodCiphertext' NOT LIKE 'v1:%'))
    ) THEN RAISE EXCEPTION 'WinCRM provider request binding mismatch'; END IF;
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'crm_orders' THEN
    IF OLD.provider_payment_id IS NOT NULL AND NEW.provider_payment_id IS DISTINCT FROM OLD.provider_payment_id THEN RAISE EXCEPTION 'WinCRM verified provider binding is immutable'; END IF;
    IF OLD.status = 'SUCCEEDED' AND NEW.status <> 'SUCCEEDED' THEN RAISE EXCEPTION 'WinCRM paid order is terminal'; END IF;
  END IF;
  IF TG_TABLE_NAME = 'crm_orders' AND
    (to_jsonb(NEW) - ARRAY['version','status','provider_payment_id','provider_status','confirmation_url','succeeded_at','cancellation_reason','updated_at']) IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['version','status','provider_payment_id','provider_status','confirmation_url','succeeded_at','cancellation_reason','updated_at']) THEN
    RAISE EXCEPTION 'WinCRM order purchase snapshot is immutable';
  END IF;
  IF TG_TABLE_NAME = 'crm_provider_operations' AND
    (to_jsonb(NEW) - ARRAY['status','version','provider_payment_id','first_dispatch_at','dispatch_attempt','retry_attempt','available_at','lease_token','lease_until','pending_event_id','outbox_id','last_error_code','updated_at']) IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['status','version','provider_payment_id','first_dispatch_at','dispatch_attempt','retry_attempt','available_at','lease_token','lease_until','pending_event_id','outbox_id','last_error_code','updated_at']) THEN
    RAISE EXCEPTION 'WinCRM provider request snapshot is immutable';
  END IF;
  IF TG_TABLE_NAME = 'crm_provider_operations' THEN
    IF OLD.first_dispatch_at IS NOT NULL AND NEW.first_dispatch_at IS DISTINCT FROM OLD.first_dispatch_at THEN RAISE EXCEPTION 'WinCRM first dispatch evidence is immutable'; END IF;
    IF OLD.provider_payment_id IS NOT NULL AND NEW.provider_payment_id IS DISTINCT FROM OLD.provider_payment_id THEN RAISE EXCEPTION 'WinCRM provider evidence binding is immutable'; END IF;
  END IF;
  IF TG_TABLE_NAME = 'crm_commerce_commands' AND
    (to_jsonb(NEW) - ARRAY['status','period_id','result_version','updated_at']) IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['status','period_id','result_version','updated_at']) THEN
    RAISE EXCEPTION 'WinCRM command binding is immutable';
  END IF;
  IF TG_TABLE_NAME = 'crm_commerce_commands' THEN
    IF OLD.status <> 'PENDING' AND NEW.status IS DISTINCT FROM OLD.status THEN RAISE EXCEPTION 'WinCRM terminal command cannot reopen'; END IF;
  END IF;
  IF TG_TABLE_NAME = 'crm_paid_periods' AND
    (to_jsonb(NEW) - ARRAY['version','total_seats','expires_at','grace_until','activation_notified_at','updated_at']) IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['version','total_seats','expires_at','grace_until','activation_notified_at','updated_at']) THEN
    RAISE EXCEPTION 'WinCRM paid period purchase snapshot is immutable';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION billing.protect_wincrm_commerce_evidence() FROM PUBLIC;
CREATE TRIGGER crm_orders_evidence_protection BEFORE INSERT OR UPDATE OR DELETE ON billing.crm_orders
  FOR EACH ROW EXECUTE FUNCTION billing.protect_wincrm_commerce_evidence();
CREATE TRIGGER crm_orders_no_truncate BEFORE TRUNCATE ON billing.crm_orders
  FOR EACH STATEMENT EXECUTE FUNCTION billing.protect_wincrm_commerce_evidence();
CREATE TRIGGER crm_paid_periods_evidence_protection BEFORE INSERT OR UPDATE OR DELETE ON billing.crm_paid_periods
  FOR EACH ROW EXECUTE FUNCTION billing.protect_wincrm_commerce_evidence();
CREATE TRIGGER crm_paid_periods_no_truncate BEFORE TRUNCATE ON billing.crm_paid_periods
  FOR EACH STATEMENT EXECUTE FUNCTION billing.protect_wincrm_commerce_evidence();
CREATE TRIGGER crm_auto_renewal_consents_append_only BEFORE UPDATE OR DELETE ON billing.crm_auto_renewal_consents
  FOR EACH ROW EXECUTE FUNCTION billing.protect_wincrm_commerce_evidence();
CREATE TRIGGER crm_auto_renewal_consents_no_truncate BEFORE TRUNCATE ON billing.crm_auto_renewal_consents
  FOR EACH STATEMENT EXECUTE FUNCTION billing.protect_wincrm_commerce_evidence();
CREATE TRIGGER crm_provider_operations_evidence_protection BEFORE INSERT OR UPDATE OR DELETE ON billing.crm_provider_operations
  FOR EACH ROW EXECUTE FUNCTION billing.protect_wincrm_commerce_evidence();
CREATE TRIGGER crm_provider_operations_no_truncate BEFORE TRUNCATE ON billing.crm_provider_operations
  FOR EACH STATEMENT EXECUTE FUNCTION billing.protect_wincrm_commerce_evidence();
CREATE TRIGGER crm_commerce_commands_evidence_protection BEFORE UPDATE OR DELETE ON billing.crm_commerce_commands
  FOR EACH ROW EXECUTE FUNCTION billing.protect_wincrm_commerce_evidence();
CREATE TRIGGER crm_commerce_commands_no_truncate BEFORE TRUNCATE ON billing.crm_commerce_commands
  FOR EACH STATEMENT EXECUTE FUNCTION billing.protect_wincrm_commerce_evidence();
CREATE TRIGGER crm_auto_renewals_snapshot_validation BEFORE INSERT OR UPDATE ON billing.crm_auto_renewals
  FOR EACH ROW EXECUTE FUNCTION billing.protect_wincrm_commerce_evidence();

COMMIT;
