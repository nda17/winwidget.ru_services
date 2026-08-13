-- Forward-only cleanup of the legacy Billing source in the Core database.
--
-- A populated production database must provide the reviewed evidence settings
-- below. A pristine bootstrap database is allowed so a clean migration replay
-- can reach the current steady schema without production credentials.

BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '5min';
SELECT pg_advisory_xact_lock(hashtext('winwidget.billing.core-source-cleanup.v1'));

-- Acquire the irreversible boundary before evaluating any source-state guard.
-- This closes the race between the last drain/ACL check and DROP while still
-- allowing the whole migration to roll back atomically on every failed guard.
LOCK TABLE
    public.billing_core_state,
    public.billing_source_aggregate_versions,
    public.billing_settings_compositions,
    public.outbox_events,
    public.integration_delivery_failures,
    public.integration_delivery_receipts,
    public.site_settings,
    public.payment_receipts,
    public.auto_renewal_consent_events,
    public.auto_renewals,
    public.subscription_expiry_reminders,
    public.subscription_history,
    public.affiliate_referrals,
    public.payments,
    public.subscriptions,
    public.tariff_prices
IN ACCESS EXCLUSIVE MODE;

DO $billing_source_cleanup_guard$
DECLARE
    target_tables CONSTANT TEXT[] := ARRAY[
        'payments',
        'payment_receipts',
        'subscriptions',
        'subscription_history',
        'subscription_expiry_reminders',
        'auto_renewals',
        'auto_renewal_consent_events',
        'tariff_prices',
        'affiliate_referrals'
    ];
    legacy_settings_columns CONSTANT TEXT[] := ARRAY[
        'payment_enabled',
        'auto_renewal_signup_enabled',
        'auto_renewal_charges_enabled',
        'auto_renewal_charges_enabled_at',
        'affiliate_program_enabled',
        'affiliate_cashback_percent'
    ];
    expected_target_triggers CONSTANT TEXT[] := ARRAY[
        'affiliate_referrals:billing_affiliate_referrals_legacy_write_fence',
        'auto_renewal_consent_events:billing_auto_renewal_events_legacy_write_fence',
        'auto_renewals:billing_auto_renewals_legacy_write_fence',
        'payment_receipts:billing_payment_receipts_legacy_write_fence',
        'payments:billing_payments_legacy_write_fence',
        'payments:reporting_payment_projection',
        'subscription_expiry_reminders:billing_subscription_reminders_legacy_write_fence',
        'subscription_history:billing_subscription_history_legacy_write_fence',
        'subscriptions:billing_subscriptions_legacy_write_fence',
        'subscriptions:reporting_subscription_projection',
        'tariff_prices:billing_tariff_prices_legacy_write_fence'
    ];
    expected_retained_triggers CONSTANT TEXT[] := ARRAY[
        'User:billing_identity_user_projection',
        'auth_identities:billing_identity_auth_projection',
        'billing_core_state:billing_core_state_transition_guard',
        'legal_pages:billing_offer_projection',
        'telegram_bot_settings:billing_notification_routing_projection',
        'telegram_notification_channels:billing_identity_telegram_projection'
    ];
    legacy_outbox_event_types CONSTANT TEXT[] := ARRAY[
        'billing.settings.source.changed.v1',
        'billing.payment.changed.v1',
        'billing.subscription.changed.v1',
        'notification.subscription-expiry.email.requested.v1',
        'notification.subscription-expiry.telegram.requested.v1',
        'payment.auto-renewal.charge.requested.v1',
        'payment.notification.telegram.requested.v1',
        'payment.succeeded.v1'
    ];
    present_count INTEGER;
    actual_triggers TEXT[];
    pristine_bootstrap BOOLEAN;
    production_approved BOOLEAN;
    relation_name TEXT;
    role_name TEXT;
    expected_ownership_revision TEXT;
    expected_cleanup_revision TEXT;
BEGIN
    SELECT count(*)
    INTO present_count
    FROM unnest(target_tables) AS target(relation_name)
    WHERE to_regclass(format('public.%I', target.relation_name)) IS NOT NULL;

    IF present_count <> cardinality(target_tables) THEN
        RAISE EXCEPTION
            'Billing Core source cleanup requires all 9 legacy tables; found %',
            present_count
            USING ERRCODE = '55000';
    END IF;

    SELECT count(*)
    INTO present_count
    FROM pg_catalog.pg_attribute attribute
    JOIN pg_catalog.pg_class relation
      ON relation.oid = attribute.attrelid
    JOIN pg_catalog.pg_namespace namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname = 'site_settings'
      AND attribute.attname = ANY(legacy_settings_columns)
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped;

    IF present_count <> cardinality(legacy_settings_columns) THEN
        RAISE EXCEPTION
            'Billing Core source cleanup requires all 6 legacy settings columns; found %',
            present_count
            USING ERRCODE = '55000';
    END IF;

    SELECT
        NOT EXISTS (SELECT 1 FROM public."User")
        AND NOT EXISTS (SELECT 1 FROM public.auth_identities)
        AND NOT EXISTS (SELECT 1 FROM public.outbox_events)
        AND NOT EXISTS (SELECT 1 FROM public.integration_delivery_receipts)
        AND NOT EXISTS (SELECT 1 FROM public.integration_delivery_failures)
        AND NOT EXISTS (SELECT 1 FROM public.billing_read_projection_versions)
        AND NOT EXISTS (SELECT 1 FROM public.billing_subscription_read_projections)
        AND NOT EXISTS (SELECT 1 FROM public.billing_payment_read_projections)
        AND NOT EXISTS (SELECT 1 FROM public.billing_affiliate_read_projections)
        AND NOT EXISTS (SELECT 1 FROM public.billing_settings_read_projection)
        AND NOT EXISTS (SELECT 1 FROM public.billing_settings_compositions)
        AND (SELECT count(*) = 1 FROM public.billing_core_state)
        AND EXISTS (
            SELECT 1
            FROM public.billing_core_state
            WHERE id = 'singleton'
              AND ownership = 'CORE'::public."BillingCoreOwnership"
              AND source_producers_enabled
              AND legacy_routes_enabled
              AND scheduler_enabled
              AND legacy_consumer_enabled
              AND projection_consumer_enabled
              AND generation = 0
              AND prepared_revision IS NULL
              AND ownership_revision IS NULL
              AND activated_at IS NULL
        )
    INTO pristine_bootstrap;

    -- The canonical four tariff rows are migration seed data, not production
    -- state. Every other legacy relation must be empty on the bootstrap path.
    IF pristine_bootstrap THEN
        FOREACH relation_name IN ARRAY target_tables LOOP
            IF relation_name = 'tariff_prices' THEN
                SELECT count(*) = 4
                    AND count(*) FILTER (
                        WHERE (id, plan::TEXT, billing_period::TEXT, amount) IN (
                            ('easy_monthly', 'EASY', 'MONTHLY', 990),
                            ('easy_yearly', 'EASY', 'YEARLY', 4680),
                            ('hard_monthly', 'HARD', 'MONTHLY', 1690),
                            ('hard_yearly', 'HARD', 'YEARLY', 9480)
                        )
                    ) = 4
                INTO pristine_bootstrap
                FROM public.tariff_prices;
            ELSE
                EXECUTE format(
                    'SELECT NOT EXISTS (SELECT 1 FROM public.%I)',
                    relation_name
                ) INTO pristine_bootstrap;
            END IF;
            EXIT WHEN NOT pristine_bootstrap;
        END LOOP;
    END IF;

    expected_ownership_revision := current_setting(
        'winwidget.billing_ownership_revision',
        true
    );
    expected_cleanup_revision := current_setting(
        'winwidget.billing_cleanup_revision',
        true
    );
    production_approved := COALESCE(
        current_setting('winwidget.billing_core_source_cleanup', true)
            = 'production-destructive-approved'
        AND current_setting('winwidget.billing_ownership_phase', true)
            = 'complete'
        AND current_setting('winwidget.billing_ownership_generation', true)
            = '2'
        AND expected_ownership_revision ~ '^[0-9a-f]{40}$'
        AND expected_ownership_revision <> repeat('0', 40)
        AND expected_cleanup_revision ~ '^[0-9a-f]{40}$'
        AND expected_cleanup_revision <> repeat('0', 40)
        AND expected_cleanup_revision <> expected_ownership_revision
        AND current_setting('winwidget.billing_source_snapshot_sha256', true)
            ~ '^[0-9a-f]{64}$'
        AND current_setting('winwidget.billing_source_snapshot_sha256', true)
            <> repeat('0', 64)
        AND current_setting('winwidget.billing_core_backup_sha256', true)
            ~ '^[0-9a-f]{64}$'
        AND current_setting('winwidget.billing_core_backup_sha256', true)
            <> repeat('0', 64)
        AND current_setting('winwidget.billing_backup_sha256', true)
            ~ '^[0-9a-f]{64}$'
        AND current_setting('winwidget.billing_backup_sha256', true)
            <> repeat('0', 64)
        AND current_setting('winwidget.billing_restore_evidence_sha256', true)
            ~ '^[0-9a-f]{64}$'
        AND current_setting('winwidget.billing_restore_evidence_sha256', true)
            <> repeat('0', 64)
        AND current_setting('winwidget.billing_offsite_receipt_sha256', true)
            ~ '^[0-9a-f]{64}$'
        AND current_setting('winwidget.billing_offsite_receipt_sha256', true)
            <> repeat('0', 64)
        AND current_setting('winwidget.billing_queue_drain_evidence_sha256', true)
            ~ '^[0-9a-f]{64}$'
        AND current_setting('winwidget.billing_queue_drain_evidence_sha256', true)
            <> repeat('0', 64)
        AND current_setting('winwidget.billing_stopped_writers_evidence_sha256', true)
            ~ '^[0-9a-f]{64}$'
        AND current_setting('winwidget.billing_stopped_writers_evidence_sha256', true)
            <> repeat('0', 64)
        AND current_setting('winwidget.billing_retention_decision', true)
            = 'approved'
        AND length(btrim(COALESCE(
            current_setting('winwidget.billing_retention_reference', true),
            ''
        ))) BETWEEN 8 AND 240,
        false
    );

    IF production_approved AND current_database() <> 'default_db' THEN
        RAISE EXCEPTION 'Production Billing source cleanup targets only default_db'
            USING ERRCODE = '55000';
    END IF;

    IF NOT (pristine_bootstrap OR production_approved) THEN
        RAISE EXCEPTION
            'Billing Core source cleanup requires reviewed production evidence'
            USING ERRCODE = '55000';
    END IF;

    IF production_approved AND NOT (
        SELECT count(*) = 1
            AND bool_and(
                id = 'singleton'
                AND ownership = 'BILLING'::public."BillingCoreOwnership"
                AND NOT source_producers_enabled
                AND NOT legacy_routes_enabled
                AND NOT scheduler_enabled
                AND NOT legacy_consumer_enabled
                AND projection_consumer_enabled
                AND generation = 2
                AND prepared_revision = expected_ownership_revision
                AND billing_core_state.ownership_revision = expected_ownership_revision
                AND activated_at IS NOT NULL
            )
        FROM public.billing_core_state
    ) THEN
        RAISE EXCEPTION
            'Billing Core state is not the exact COMPLETE generation-2 ownership state'
            USING ERRCODE = '55000';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_constraint dependency
        JOIN pg_catalog.pg_class referenced_relation
          ON referenced_relation.oid = dependency.confrelid
        JOIN pg_catalog.pg_namespace referenced_namespace
          ON referenced_namespace.oid = referenced_relation.relnamespace
        JOIN pg_catalog.pg_class dependent_relation
          ON dependent_relation.oid = dependency.conrelid
        JOIN pg_catalog.pg_namespace dependent_namespace
          ON dependent_namespace.oid = dependent_relation.relnamespace
        WHERE dependency.contype = 'f'
          AND referenced_namespace.nspname = 'public'
          AND referenced_relation.relname = ANY(target_tables)
          AND NOT (
              dependent_namespace.nspname = 'public'
              AND dependent_relation.relname = ANY(target_tables)
          )
    ) THEN
        RAISE EXCEPTION 'A non-Billing table still references the legacy Billing source'
            USING ERRCODE = '55000';
    END IF;

    SELECT COALESCE(
        array_agg(
            relation.relname || ':' || trigger.tgname
            ORDER BY relation.relname, trigger.tgname
        ),
        ARRAY[]::TEXT[]
    )
    INTO actual_triggers
    FROM pg_catalog.pg_trigger trigger
    JOIN pg_catalog.pg_class relation
      ON relation.oid = trigger.tgrelid
    JOIN pg_catalog.pg_namespace namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname = ANY(target_tables)
      AND NOT trigger.tgisinternal;

    IF actual_triggers <> expected_target_triggers THEN
        RAISE EXCEPTION
            'Legacy Billing source trigger manifest drifted: %',
            actual_triggers
            USING ERRCODE = '55000';
    END IF;

    SELECT COALESCE(
        array_agg(trigger.tgname ORDER BY trigger.tgname),
        ARRAY[]::TEXT[]
    )
    INTO actual_triggers
    FROM pg_catalog.pg_trigger trigger
    JOIN pg_catalog.pg_class relation
      ON relation.oid = trigger.tgrelid
    JOIN pg_catalog.pg_namespace namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname = 'site_settings'
      AND NOT trigger.tgisinternal
      AND trigger.tgname LIKE 'billing_%';

    IF actual_triggers <> ARRAY[
        'billing_settings_projection',
        'billing_site_settings_fields_update_fence',
        'billing_site_settings_insert_delete_fence'
    ]::TEXT[] THEN
        RAISE EXCEPTION
            'Legacy Billing settings trigger manifest drifted: %',
            actual_triggers
            USING ERRCODE = '55000';
    END IF;

    SELECT COALESCE(
        array_agg(
            relation.relname || ':' || trigger.tgname
            ORDER BY relation.relname, trigger.tgname
        ),
        ARRAY[]::TEXT[]
    )
    INTO actual_triggers
    FROM pg_catalog.pg_trigger trigger
    JOIN pg_catalog.pg_class relation
      ON relation.oid = trigger.tgrelid
    JOIN pg_catalog.pg_namespace namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname = ANY(ARRAY[
          'User',
          'auth_identities',
          'billing_core_state',
          'legal_pages',
          'telegram_bot_settings',
          'telegram_notification_channels'
      ]::TEXT[])
      AND trigger.tgname = ANY(ARRAY[
          'billing_identity_user_projection',
          'billing_identity_auth_projection',
          'billing_core_state_transition_guard',
          'billing_offer_projection',
          'billing_notification_routing_projection',
          'billing_identity_telegram_projection'
      ]::TEXT[])
      AND NOT trigger.tgisinternal;

    IF actual_triggers <> expected_retained_triggers THEN
        RAISE EXCEPTION
            'Required retained Billing producer trigger manifest drifted: %',
            actual_triggers
            USING ERRCODE = '55000';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM unnest(ARRAY[
            'public.billing_assert_legacy_table_write_enabled()',
            'public.billing_assert_legacy_settings_write_enabled()',
            'public.billing_settings_projection_trigger()',
            'public.reporting_payment_projection_trigger()',
            'public.reporting_subscription_projection_trigger()'
        ]::TEXT[]) AS expected(signature)
        WHERE to_regprocedure(expected.signature) IS NULL
    ) THEN
        RAISE EXCEPTION 'A required legacy Billing cleanup function is missing'
            USING ERRCODE = '55000';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM unnest(ARRAY[
            'public.billing_core_state_transition_guard()',
            'public.billing_core_source_producers_enabled()',
            'public.billing_core_ownership_active()',
            'public.billing_iso_timestamp(timestamp without time zone)',
            'public.billing_record_source_event(text,text,text,text,jsonb,boolean)',
            'public.billing_emit_identity_projection(text,boolean)',
            'public.billing_identity_user_projection_trigger()',
            'public.billing_identity_auth_projection_trigger()',
            'public.billing_identity_telegram_projection_trigger()',
            'public.billing_notification_routing_projection_trigger()',
            'public.billing_offer_projection_trigger()'
        ]::TEXT[]) AS retained(signature)
        WHERE to_regprocedure(retained.signature) IS NULL
    ) THEN
        RAISE EXCEPTION 'A required retained Billing Core producer function is missing'
            USING ERRCODE = '55000';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_policy policy
        JOIN pg_catalog.pg_class relation
          ON relation.oid = policy.polrelid
        JOIN pg_catalog.pg_namespace namespace
          ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND (
              relation.relname = ANY(target_tables)
              OR relation.relname = 'site_settings'
          )
    ) THEN
        RAISE EXCEPTION 'A row-level security policy remains on the legacy Billing source'
            USING ERRCODE = '55000';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_publication_rel publication_relation
        JOIN pg_catalog.pg_class relation
          ON relation.oid = publication_relation.prrelid
        JOIN pg_catalog.pg_namespace namespace
          ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND (
              relation.relname = ANY(target_tables)
              OR relation.relname = 'site_settings'
          )
    ) OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_publication
        WHERE puballtables
    ) OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_publication_namespace publication_namespace
        JOIN pg_catalog.pg_namespace namespace
          ON namespace.oid = publication_namespace.pnnspid
        WHERE namespace.nspname = 'public'
    ) THEN
        RAISE EXCEPTION 'A publication still contains the legacy Billing source'
            USING ERRCODE = '55000';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_depend dependency
        JOIN pg_catalog.pg_class sequence_relation
          ON sequence_relation.oid = dependency.objid
         AND sequence_relation.relkind = 'S'
        JOIN pg_catalog.pg_class target_relation
          ON target_relation.oid = dependency.refobjid
        JOIN pg_catalog.pg_namespace target_namespace
          ON target_namespace.oid = target_relation.relnamespace
        WHERE dependency.classid = 'pg_class'::regclass
          AND dependency.refclassid = 'pg_class'::regclass
          AND dependency.deptype IN ('a', 'i')
          AND target_namespace.nspname = 'public'
          AND target_relation.relname = ANY(target_tables)
    ) THEN
        RAISE EXCEPTION 'A sequence is still owned by the legacy Billing source'
            USING ERRCODE = '55000';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_depend dependency
        JOIN pg_catalog.pg_class target_relation
          ON target_relation.oid = dependency.refobjid
        JOIN pg_catalog.pg_namespace target_namespace
          ON target_namespace.oid = target_relation.relnamespace
        WHERE dependency.refclassid = 'pg_class'::regclass
          AND target_namespace.nspname = 'public'
          AND target_relation.relname = ANY(target_tables)
          AND dependency.classid NOT IN (
              'pg_constraint'::regclass,
              'pg_trigger'::regclass,
              'pg_attrdef'::regclass,
              'pg_class'::regclass,
              'pg_type'::regclass
          )
    ) THEN
        RAISE EXCEPTION
            'An unexpected catalog object depends on the legacy Billing source'
            USING ERRCODE = '55000';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_depend dependency
        JOIN pg_catalog.pg_attribute attribute
          ON attribute.attrelid = dependency.refobjid
         AND attribute.attnum = dependency.refobjsubid
        WHERE dependency.refclassid = 'pg_class'::regclass
          AND dependency.refobjid = 'public.site_settings'::regclass
          AND attribute.attname = ANY(legacy_settings_columns)
          AND dependency.classid NOT IN (
              'pg_attrdef'::regclass,
              'pg_trigger'::regclass
          )
          AND NOT (
              dependency.classid = 'pg_constraint'::regclass
              AND EXISTS (
                  SELECT 1
                  FROM pg_catalog.pg_constraint constraint_definition
                  WHERE constraint_definition.oid = dependency.objid
                    AND constraint_definition.conrelid =
                        'public.site_settings'::regclass
                    AND constraint_definition.contype = 'n'
                    AND constraint_definition.conkey =
                        ARRAY[attribute.attnum]::SMALLINT[]
              )
          )
    ) THEN
        RAISE EXCEPTION
            'An unexpected catalog object depends on a legacy Billing settings column'
            USING ERRCODE = '55000';
    END IF;

    IF production_approved THEN
        IF to_regrole('gen_user') IS NULL
           OR to_regrole('winwidget_backup') IS NULL
           OR to_regrole('winwidget_api_runtime') IS NULL
           OR to_regrole('winwidget_maintenance') IS NULL THEN
            RAISE EXCEPTION 'Core cleanup database roles are incomplete'
                USING ERRCODE = '55000';
        END IF;

        IF NOT EXISTS (
            SELECT 1
            FROM pg_catalog.pg_class relation
            JOIN pg_catalog.pg_namespace namespace
              ON namespace.oid = relation.relnamespace
            JOIN pg_catalog.pg_roles owner_role
              ON owner_role.oid = relation.relowner
            WHERE namespace.nspname = 'public'
              AND relation.relname = 'site_settings'
              AND relation.relkind = 'r'
              AND owner_role.rolname = 'gen_user'
        ) THEN
            RAISE EXCEPTION
                'Core site_settings does not have the exact migration owner'
                USING ERRCODE = '55000';
        END IF;

        -- Restore/finalize grants runtime roles broad access to the current
        -- public schema. Converge the exact obsolete ACL inside this same
        -- transaction so a failed cleanup restores the SHA A privileges,
        -- while a committed cleanup cannot leave a legacy grant behind.
        FOREACH relation_name IN ARRAY target_tables LOOP
            EXECUTE format(
                'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC, winwidget_api_runtime, winwidget_maintenance',
                relation_name
            );
        END LOOP;
        REVOKE ALL PRIVILEGES ON FUNCTION
            public.billing_assert_legacy_table_write_enabled(),
            public.billing_assert_legacy_settings_write_enabled(),
            public.billing_settings_projection_trigger(),
            public.reporting_payment_projection_trigger(),
            public.reporting_subscription_projection_trigger()
        FROM PUBLIC, winwidget_api_runtime, winwidget_maintenance, winwidget_backup;

        FOREACH relation_name IN ARRAY target_tables LOOP
            IF NOT EXISTS (
                SELECT 1
                FROM pg_catalog.pg_class relation
                JOIN pg_catalog.pg_namespace namespace
                  ON namespace.oid = relation.relnamespace
                JOIN pg_catalog.pg_roles owner_role
                  ON owner_role.oid = relation.relowner
                WHERE namespace.nspname = 'public'
                  AND relation.relname = relation_name
                  AND relation.relkind = 'r'
                  AND owner_role.rolname = 'gen_user'
            ) THEN
                RAISE EXCEPTION
                    'Legacy Billing relation % does not have the exact migration owner',
                    relation_name
                    USING ERRCODE = '55000';
            END IF;
            IF NOT has_table_privilege(
                    'winwidget_backup',
                    format('public.%I', relation_name),
                    'SELECT'
                )
               OR has_table_privilege(
                    'winwidget_backup',
                    format('public.%I', relation_name),
                    'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
                ) THEN
                RAISE EXCEPTION
                    'Core backup role does not have the exact read-only ACL on %',
                    relation_name
                    USING ERRCODE = '55000';
            END IF;
            FOREACH role_name IN ARRAY ARRAY[
                'winwidget_api_runtime',
                'winwidget_maintenance'
            ] LOOP
                IF has_table_privilege(
                    role_name,
                    format('public.%I', relation_name),
                    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
                ) THEN
                    RAISE EXCEPTION
                        'Core role % retains a legacy Billing privilege on %',
                        role_name,
                        relation_name
                        USING ERRCODE = '55000';
                END IF;
            END LOOP;
        END LOOP;

        IF EXISTS (
            SELECT 1
            FROM pg_catalog.pg_class relation
            JOIN pg_catalog.pg_namespace namespace
              ON namespace.oid = relation.relnamespace
            CROSS JOIN LATERAL aclexplode(
                COALESCE(relation.relacl, acldefault('r', relation.relowner))
            ) privilege
            WHERE namespace.nspname = 'public'
              AND relation.relname = ANY(target_tables)
              AND privilege.grantee = 0
              AND privilege.privilege_type = ANY(ARRAY[
                  'SELECT',
                  'INSERT',
                  'UPDATE',
                  'DELETE',
                  'TRUNCATE',
                  'REFERENCES',
                  'TRIGGER'
              ])
        ) THEN
            RAISE EXCEPTION 'PUBLIC retains a legacy Billing table privilege'
                USING ERRCODE = '55000';
        END IF;

        IF EXISTS (
            SELECT 1
            FROM pg_catalog.pg_class relation
            JOIN pg_catalog.pg_namespace namespace
              ON namespace.oid = relation.relnamespace
            CROSS JOIN LATERAL aclexplode(
                COALESCE(relation.relacl, acldefault('r', relation.relowner))
            ) privilege
            WHERE namespace.nspname = 'public'
              AND relation.relname = ANY(target_tables)
              AND (
                  privilege.grantee NOT IN (
                      relation.relowner,
                      to_regrole('winwidget_backup')::OID
                  )
                  OR (
                      privilege.grantee = to_regrole('winwidget_backup')::OID
                      AND (
                          privilege.privilege_type <> 'SELECT'
                          OR privilege.is_grantable
                      )
                  )
              )
        ) THEN
            RAISE EXCEPTION 'Unexpected grantee remains on the legacy Billing source'
                USING ERRCODE = '55000';
        END IF;

        IF EXISTS (
            SELECT 1
            FROM pg_catalog.pg_attribute attribute
            JOIN pg_catalog.pg_class relation
              ON relation.oid = attribute.attrelid
            JOIN pg_catalog.pg_namespace namespace
              ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'public'
              AND relation.relname = ANY(target_tables)
              AND attribute.attnum > 0
              AND NOT attribute.attisdropped
              AND attribute.attacl IS NOT NULL
        ) THEN
            RAISE EXCEPTION 'Column-level ACL remains on the legacy Billing source'
                USING ERRCODE = '55000';
        END IF;

        IF EXISTS (
            SELECT 1
            FROM pg_catalog.pg_attribute attribute
            WHERE attribute.attrelid = 'public.site_settings'::regclass
              AND attribute.attname = ANY(legacy_settings_columns)
              AND attribute.attnum > 0
              AND NOT attribute.attisdropped
              AND attribute.attacl IS NOT NULL
        ) THEN
            RAISE EXCEPTION
                'Column-level ACL remains on legacy Billing settings'
                USING ERRCODE = '55000';
        END IF;

        IF EXISTS (
            SELECT 1
            FROM pg_catalog.pg_proc function
            JOIN pg_catalog.pg_namespace namespace
              ON namespace.oid = function.pronamespace
            JOIN pg_catalog.pg_roles owner_role
              ON owner_role.oid = function.proowner
            CROSS JOIN LATERAL aclexplode(
                COALESCE(function.proacl, acldefault('f', function.proowner))
            ) privilege
            WHERE namespace.nspname = 'public'
              AND function.proname = ANY(ARRAY[
                  'billing_assert_legacy_table_write_enabled',
                  'billing_assert_legacy_settings_write_enabled',
                  'billing_settings_projection_trigger',
                  'reporting_payment_projection_trigger',
                  'reporting_subscription_projection_trigger'
              ]::TEXT[])
              AND (
                  owner_role.rolname <> 'gen_user'
                  OR privilege.grantee <> function.proowner
                  OR privilege.privilege_type <> 'EXECUTE'
              )
        ) THEN
            RAISE EXCEPTION
                'Unexpected ACL remains on a legacy Billing function'
                USING ERRCODE = '55000';
        END IF;

        IF has_function_privilege(
                'winwidget_api_runtime',
                'public.billing_assert_legacy_table_write_enabled()',
                'EXECUTE'
            )
           OR has_function_privilege(
                'winwidget_api_runtime',
                'public.billing_assert_legacy_settings_write_enabled()',
                'EXECUTE'
            )
           OR has_function_privilege(
                'winwidget_api_runtime',
                'public.billing_settings_projection_trigger()',
                'EXECUTE'
            )
           OR has_function_privilege(
                'winwidget_api_runtime',
                'public.reporting_payment_projection_trigger()',
                'EXECUTE'
            )
           OR has_function_privilege(
                'winwidget_api_runtime',
                'public.reporting_subscription_projection_trigger()',
                'EXECUTE'
            ) THEN
            RAISE EXCEPTION
                'Core runtime retains EXECUTE on a legacy Billing function'
                USING ERRCODE = '55000';
        END IF;

        IF EXISTS (
            SELECT 1
            FROM public.billing_settings_compositions
            WHERE status IN (
                'PENDING'::public."BillingSettingsCompositionStatus",
                'BILLING_APPLIED'::public."BillingSettingsCompositionStatus"
            )
        ) THEN
            RAISE EXCEPTION 'Billing settings compositions are not drained'
                USING ERRCODE = '55000';
        END IF;

        IF EXISTS (
            SELECT 1
            FROM public.outbox_events
            WHERE event_type = ANY(legacy_outbox_event_types)
              AND status <> 'PUBLISHED'::public."OutboxEventStatus"
        ) THEN
            RAISE EXCEPTION 'Legacy Billing Outbox state is not drained'
                USING ERRCODE = '55000';
        END IF;

        IF EXISTS (
            SELECT 1
            FROM public.integration_delivery_failures
            WHERE integration IN (
                'auto-renewal',
                'notification-delivery-outcome'
            )
              AND resolved_at IS NULL
        ) OR EXISTS (
            SELECT 1
            FROM public.integration_delivery_receipts
            WHERE integration IN (
                'auto-renewal',
                'notification-delivery-outcome'
            )
              AND status IN (
                  'PROCESSING'::public."IntegrationDeliveryReceiptStatus",
                  'RETRY_SCHEDULED'::public."IntegrationDeliveryReceiptStatus"
              )
        ) THEN
            RAISE EXCEPTION
                'Legacy Billing Core delivery state is not drained'
                USING ERRCODE = '55000';
        END IF;
    END IF;
END
$billing_source_cleanup_guard$;

DROP TRIGGER "billing_payments_legacy_write_fence" ON public.payments;
DROP TRIGGER "reporting_payment_projection" ON public.payments;
DROP TRIGGER "billing_payment_receipts_legacy_write_fence" ON public.payment_receipts;
DROP TRIGGER "billing_subscriptions_legacy_write_fence" ON public.subscriptions;
DROP TRIGGER "reporting_subscription_projection" ON public.subscriptions;
DROP TRIGGER "billing_subscription_history_legacy_write_fence" ON public.subscription_history;
DROP TRIGGER "billing_subscription_reminders_legacy_write_fence" ON public.subscription_expiry_reminders;
DROP TRIGGER "billing_auto_renewals_legacy_write_fence" ON public.auto_renewals;
DROP TRIGGER "billing_auto_renewal_events_legacy_write_fence" ON public.auto_renewal_consent_events;
DROP TRIGGER "billing_tariff_prices_legacy_write_fence" ON public.tariff_prices;
DROP TRIGGER "billing_affiliate_referrals_legacy_write_fence" ON public.affiliate_referrals;
DROP TRIGGER "billing_settings_projection" ON public.site_settings;
DROP TRIGGER "billing_site_settings_fields_update_fence" ON public.site_settings;
DROP TRIGGER "billing_site_settings_insert_delete_fence" ON public.site_settings;

DROP TABLE
    public.payment_receipts,
    public.auto_renewal_consent_events,
    public.auto_renewals,
    public.subscription_expiry_reminders,
    public.subscription_history,
    public.affiliate_referrals,
    public.payments,
    public.subscriptions,
    public.tariff_prices
RESTRICT;

ALTER TABLE public.site_settings
    DROP COLUMN payment_enabled,
    DROP COLUMN auto_renewal_signup_enabled,
    DROP COLUMN auto_renewal_charges_enabled,
    DROP COLUMN auto_renewal_charges_enabled_at,
    DROP COLUMN affiliate_program_enabled,
    DROP COLUMN affiliate_cashback_percent;

DROP FUNCTION public.billing_assert_legacy_table_write_enabled();
DROP FUNCTION public.billing_assert_legacy_settings_write_enabled();
DROP FUNCTION public.billing_settings_projection_trigger();
DROP FUNCTION public.reporting_payment_projection_trigger();
DROP FUNCTION public.reporting_subscription_projection_trigger();

DROP TYPE public."PaymentKind" RESTRICT;
DROP TYPE public."AutoRenewalStatus" RESTRICT;
DROP TYPE public."AutoRenewalConsentEventType" RESTRICT;
DROP TYPE public."SubscriptionExpiryReminderStatus" RESTRICT;
DROP TYPE public."SubscriptionHistoryAction" RESTRICT;
DROP TYPE public."SubscriptionBonusAudience" RESTRICT;

DO $billing_source_cleanup_verify$
DECLARE
    relation_name TEXT;
    column_name TEXT;
    signature TEXT;
    type_name TEXT;
BEGIN
    FOREACH relation_name IN ARRAY ARRAY[
        'payments',
        'payment_receipts',
        'subscriptions',
        'subscription_history',
        'subscription_expiry_reminders',
        'auto_renewals',
        'auto_renewal_consent_events',
        'tariff_prices',
        'affiliate_referrals'
    ] LOOP
        IF to_regclass(format('public.%I', relation_name)) IS NOT NULL THEN
            RAISE EXCEPTION 'Legacy Billing relation remains: %', relation_name;
        END IF;
    END LOOP;

    FOREACH column_name IN ARRAY ARRAY[
        'payment_enabled',
        'auto_renewal_signup_enabled',
        'auto_renewal_charges_enabled',
        'auto_renewal_charges_enabled_at',
        'affiliate_program_enabled',
        'affiliate_cashback_percent'
    ] LOOP
        IF EXISTS (
            SELECT 1
            FROM pg_catalog.pg_attribute attribute
            WHERE attribute.attrelid = 'public.site_settings'::regclass
              AND attribute.attname = column_name
              AND attribute.attnum > 0
              AND NOT attribute.attisdropped
        ) THEN
            RAISE EXCEPTION 'Legacy Billing settings column remains: %', column_name;
        END IF;
    END LOOP;

    FOREACH signature IN ARRAY ARRAY[
        'public.billing_assert_legacy_table_write_enabled()',
        'public.billing_assert_legacy_settings_write_enabled()',
        'public.billing_settings_projection_trigger()',
        'public.reporting_payment_projection_trigger()',
        'public.reporting_subscription_projection_trigger()'
    ] LOOP
        IF to_regprocedure(signature) IS NOT NULL THEN
            RAISE EXCEPTION 'Legacy Billing function remains: %', signature;
        END IF;
    END LOOP;

    FOREACH signature IN ARRAY ARRAY[
        'public.billing_core_state_transition_guard()',
        'public.billing_core_source_producers_enabled()',
        'public.billing_core_ownership_active()',
        'public.billing_iso_timestamp(timestamp without time zone)',
        'public.billing_record_source_event(text,text,text,text,jsonb,boolean)',
        'public.billing_emit_identity_projection(text,boolean)',
        'public.billing_identity_user_projection_trigger()',
        'public.billing_identity_auth_projection_trigger()',
        'public.billing_identity_telegram_projection_trigger()',
        'public.billing_notification_routing_projection_trigger()',
        'public.billing_offer_projection_trigger()'
    ] LOOP
        IF to_regprocedure(signature) IS NULL THEN
            RAISE EXCEPTION 'Required Billing Core producer function was removed: %', signature;
        END IF;
    END LOOP;

    FOREACH relation_name IN ARRAY ARRAY[
        'billing_core_state',
        'billing_source_aggregate_versions',
        'billing_read_projection_versions',
        'billing_subscription_read_projections',
        'billing_payment_read_projections',
        'billing_affiliate_read_projections',
        'billing_settings_read_projection',
        'billing_settings_compositions'
    ] LOOP
        IF to_regclass(format('public.%I', relation_name)) IS NULL THEN
            RAISE EXCEPTION 'Required retained Billing relation is missing: %', relation_name;
        END IF;
    END LOOP;

    IF to_regclass('public.billing_source_sequence') IS NULL THEN
        RAISE EXCEPTION 'Required retained Billing source sequence is missing';
    END IF;

    FOREACH type_name IN ARRAY ARRAY[
        'PaymentKind',
        'AutoRenewalStatus',
        'AutoRenewalConsentEventType',
        'SubscriptionExpiryReminderStatus',
        'SubscriptionHistoryAction',
        'SubscriptionBonusAudience'
    ] LOOP
        IF to_regtype(format('public.%I', type_name)) IS NOT NULL THEN
            RAISE EXCEPTION 'Legacy Billing enum remains: %', type_name;
        END IF;
    END LOOP;

    FOREACH type_name IN ARRAY ARRAY[
        'PaymentStatus',
        'Plan',
        'BillingPeriod',
        'SubscriptionStatus',
        'AffiliateReferralStatus',
        'BillingCoreOwnership',
        'BillingSettingsCompositionStatus'
    ] LOOP
        IF to_regtype(format('public.%I', type_name)) IS NULL THEN
            RAISE EXCEPTION 'Required retained Billing enum is missing: %', type_name;
        END IF;
    END LOOP;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_trigger trigger
        JOIN pg_catalog.pg_class relation
          ON relation.oid = trigger.tgrelid
        JOIN pg_catalog.pg_namespace namespace
          ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname = 'site_settings'
          AND trigger.tgname LIKE 'billing_%'
          AND NOT trigger.tgisinternal
    ) THEN
        RAISE EXCEPTION 'Legacy Billing settings trigger remains';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.billing_core_state
        WHERE id = 'singleton'
          AND projection_consumer_enabled
          AND (
              (
                  ownership = 'CORE'::public."BillingCoreOwnership"
                  AND source_producers_enabled
                  AND legacy_routes_enabled
                  AND scheduler_enabled
                  AND legacy_consumer_enabled
                  AND generation = 0
                  AND prepared_revision IS NULL
                  AND ownership_revision IS NULL
                  AND activated_at IS NULL
              )
              OR (
                  ownership = 'BILLING'::public."BillingCoreOwnership"
                  AND NOT source_producers_enabled
                  AND NOT legacy_routes_enabled
                  AND NOT scheduler_enabled
                  AND NOT legacy_consumer_enabled
                  AND generation = 2
                  AND prepared_revision = current_setting(
                      'winwidget.billing_ownership_revision',
                      true
                  )
                  AND ownership_revision = prepared_revision
                  AND activated_at IS NOT NULL
              )
          )
    ) THEN
        RAISE EXCEPTION 'Billing Core ownership state changed during cleanup';
    END IF;
END
$billing_source_cleanup_verify$;

COMMIT;
