-- Forward-only removal of the frozen Platform-owned source from Core.
--
-- A pristine database may replay the complete migration tree only with the
-- explicit non-production replay GUC.
-- Production requires exact cleanup-controller evidence, the completed
-- ownership marker identity and the pending Prisma ledger row for this file.

BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '5min';

SELECT pg_advisory_xact_lock(
    hashtext('winwidget.platform.core-source-cleanup.v1')
);

LOCK TABLE
    public.site_settings,
    public.legal_pages,
    public.home_page_content,
    public.platform_core_state,
    public.billing_source_aggregate_versions,
    public.outbox_events
IN ACCESS EXCLUSIVE MODE;

DO $platform_source_cleanup_guard$
DECLARE
    source_inventory TEXT;
    pristine_bootstrap BOOLEAN;
    production_approved BOOLEAN;
    operations_terminal_approved BOOLEAN;
    evidence_setting TEXT;
    evidence_value TEXT;
    expected_ownership_revision TEXT;
    expected_cleanup_revision TEXT;
    expected_migration_sha256 TEXT;
BEGIN
    SELECT
        (
            SELECT count(*)
            FROM pg_catalog.pg_class relation
            JOIN pg_catalog.pg_namespace namespace
              ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'public'
              AND relation.relkind = 'r'
              AND relation.relname IN (
                  'site_settings',
                  'legal_pages',
                  'home_page_content',
                  'platform_core_state'
              )
        )::TEXT || '|' ||
        (
            SELECT count(*)
            FROM pg_catalog.pg_trigger trigger
            JOIN pg_catalog.pg_class relation
              ON relation.oid = trigger.tgrelid
            JOIN pg_catalog.pg_namespace namespace
              ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'public'
              AND NOT trigger.tgisinternal
              AND relation.relname IN (
                  'site_settings',
                  'legal_pages',
                  'home_page_content',
                  'platform_core_state'
              )
        )::TEXT || '|' ||
        (
            SELECT count(*)
            FROM pg_catalog.pg_proc routine
            JOIN pg_catalog.pg_namespace namespace
              ON namespace.oid = routine.pronamespace
            WHERE namespace.nspname = 'public'
              AND routine.proname IN (
                  'platform_core_state_transition_guard',
                  'platform_core_source_writes_enabled',
                  'platform_assert_core_write_enabled',
                  'billing_offer_projection_trigger'
              )
        )::TEXT || '|' ||
        (
            SELECT count(*)
            FROM pg_catalog.pg_type type_entry
            JOIN pg_catalog.pg_namespace namespace
              ON namespace.oid = type_entry.typnamespace
            WHERE namespace.nspname = 'public'
              AND type_entry.typname = 'PlatformCoreOwnership'
        )::TEXT || '|' ||
        (
            SELECT count(*)
            FROM public.billing_source_aggregate_versions
            WHERE aggregate_type = 'billing.offer'
              AND aggregate_id = 'offer'
        )::TEXT || '|' ||
        (
            to_regclass('public.billing_source_aggregate_versions') IS NOT NULL
            AND to_regclass('public.billing_source_sequence') IS NOT NULL
            AND to_regprocedure(
                'public.billing_record_source_event(text,text,text,text,jsonb,boolean)'
            ) IS NOT NULL
            AND to_regprocedure(
                'public.billing_iso_timestamp(timestamp without time zone)'
            ) IS NOT NULL
        )::TEXT
    INTO source_inventory;

    IF source_inventory IS DISTINCT FROM '4|5|4|1|1|true' THEN
        RAISE EXCEPTION
            'Legacy Platform Core source inventory is not exact: %',
            source_inventory
            USING ERRCODE = '55000';
    END IF;

    SELECT
        current_setting(
            'winwidget.platform_pristine_replay',
            true
        ) = 'approved-nonproduction-replay'
        AND (
            SELECT count(*) = 1
            FROM public.platform_core_state
        )
        AND EXISTS (
            SELECT 1
            FROM public.platform_core_state state
            WHERE state.id = 'singleton'
              AND state.ownership = 'CORE'::public."PlatformCoreOwnership"
              AND state.source_writes_enabled
              AND state.legacy_routes_enabled
              AND state.generation = 0
              AND state.prepared_revision IS NULL
              AND state.source_revision IS NULL
              AND state.ownership_revision IS NULL
              AND state.source_fingerprint IS NULL
              AND state.source_snapshot_sha256 IS NULL
              AND state.source_high_watermark IS NULL
              AND state.billing_offer_contract_version IS NULL
              AND state.billing_offer_sequence_scope IS NULL
              AND state.billing_offer_aggregate_version IS NULL
              AND state.billing_offer_source_sequence IS NULL
              AND state.billing_offer_fence_fingerprint IS NULL
              AND state.fenced_at IS NULL
              AND state.exported_at IS NULL
              AND state.activated_at IS NULL
        )
        AND EXISTS (
            SELECT 1
            FROM public.billing_source_aggregate_versions cursor
            WHERE cursor.aggregate_type = 'billing.offer'
              AND cursor.aggregate_id = 'offer'
              AND cursor.version = 1
              AND cursor.source_sequence > 0
        )
        AND NOT EXISTS (
            SELECT 1
            FROM public.outbox_events
            WHERE event_type IN (
                'admin.audit.platform.v1',
                'billing.offer.changed.v2'
            )
        )
    INTO pristine_bootstrap;

    expected_ownership_revision := current_setting(
        'winwidget.platform_ownership_revision',
        true
    );
    expected_cleanup_revision := current_setting(
        'winwidget.platform_cleanup_revision',
        true
    );
    expected_migration_sha256 := current_setting(
        'winwidget.platform_cleanup_migration_sha256',
        true
    );

    operations_terminal_approved := COALESCE(
        current_setting(
            'winwidget.operations_platform_source_cleanup',
            true
        ) = 'production-destructive-approved'
        AND current_setting(
            'winwidget.operations_platform_source_writers_stopped',
            true
        ) = 'true'
        AND current_user = 'gen_user'
        AND session_user = 'gen_user'
        AND current_database() = current_setting(
            'winwidget.operations_platform_core_database_name',
            true
        )
        AND current_database() = 'default_db'
        AND (pg_control_system()).system_identifier::TEXT =
            current_setting(
                'winwidget.operations_platform_core_database_system_identifier',
                true
            )
        AND current_setting(
            'winwidget.operations_platform_ownership_revision',
            true
        ) ~ '^[0-9a-f]{40}$'
        AND current_setting(
            'winwidget.operations_platform_ownership_revision',
            true
        ) <> repeat('0', 40)
        AND current_setting(
            'winwidget.operations_platform_cleanup_revision',
            true
        ) ~ '^[0-9a-f]{40}$'
        AND current_setting(
            'winwidget.operations_platform_cleanup_revision',
            true
        ) <> repeat('0', 40)
        AND current_setting(
            'winwidget.operations_platform_ownership_revision',
            true
        ) <> current_setting(
            'winwidget.operations_platform_cleanup_revision',
            true
        )
        AND current_setting(
            'winwidget.operations_platform_generation',
            true
        ) ~ '^[1-9][0-9]{0,17}$'
        AND current_setting(
            'winwidget.operations_platform_source_high_watermark',
            true
        ) ~ '^[1-9][0-9]*$'
        AND current_setting(
            'winwidget.operations_platform_billing_offer_contract_version',
            true
        ) = '2'
        AND current_setting(
            'winwidget.operations_platform_billing_offer_sequence_scope',
            true
        ) = 'billing.offer:offer'
        AND current_setting(
            'winwidget.operations_platform_billing_offer_aggregate_version',
            true
        ) ~ '^[1-9][0-9]*$'
        AND current_setting(
            'winwidget.operations_platform_billing_offer_source_sequence',
            true
        ) ~ '^[1-9][0-9]*$'
        AND current_setting(
            'winwidget.operations_platform_migration_sha256',
            true
        ) ~ '^[0-9a-f]{64}$'
        AND current_setting(
            'winwidget.operations_platform_production_env_sha256',
            true
        ) ~ '^[0-9a-f]{64}$'
        AND current_setting(
            'winwidget.operations_platform_compose_sha256',
            true
        ) ~ '^[0-9a-f]{64}$'
        AND current_setting(
            'winwidget.operations_platform_snapshot_sha256',
            true
        ) ~ '^[0-9a-f]{64}$'
        AND current_setting(
            'winwidget.operations_platform_source_fingerprint',
            true
        ) ~ '^[0-9a-f]{64}$'
        AND current_setting(
            'winwidget.operations_platform_billing_offer_fence_fingerprint',
            true
        ) ~ '^[0-9a-f]{64}$'
        AND current_setting(
            'winwidget.operations_platform_migration_sha256',
            true
        ) <> repeat('0', 64)
        AND current_setting(
            'winwidget.operations_platform_production_env_sha256',
            true
        ) <> repeat('0', 64)
        AND current_setting(
            'winwidget.operations_platform_compose_sha256',
            true
        ) <> repeat('0', 64)
        AND current_setting(
            'winwidget.operations_platform_snapshot_sha256',
            true
        ) <> repeat('0', 64)
        AND current_setting(
            'winwidget.operations_platform_source_fingerprint',
            true
        ) <> repeat('0', 64)
        AND current_setting(
            'winwidget.operations_platform_billing_offer_fence_fingerprint',
            true
        ) <> repeat('0', 64),
        false
    );

    production_approved := COALESCE(
        current_setting(
            'winwidget.platform_core_source_cleanup',
            true
        ) = 'production-destructive-approved'
        AND current_database() = current_setting(
            'winwidget.platform_core_database_name',
            true
        )
        AND current_database() = 'default_db'
        AND (pg_control_system()).system_identifier::TEXT =
            current_setting(
                'winwidget.platform_core_database_system_identifier',
                true
            )
        AND expected_ownership_revision ~ '^[0-9a-f]{40}$'
        AND expected_ownership_revision <> repeat('0', 40)
        AND expected_cleanup_revision ~ '^[0-9a-f]{40}$'
        AND expected_cleanup_revision <> repeat('0', 40)
        AND expected_cleanup_revision <> expected_ownership_revision
        AND current_setting(
            'winwidget.platform_generation',
            true
        ) ~ '^[1-9][0-9]{0,17}$'
        AND current_setting(
            'winwidget.platform_source_high_watermark',
            true
        ) ~ '^[1-9][0-9]*$'
        AND current_setting(
            'winwidget.platform_billing_offer_contract_version',
            true
        ) = '2'
        AND current_setting(
            'winwidget.platform_billing_offer_sequence_scope',
            true
        ) = 'billing.offer:offer'
        AND current_setting(
            'winwidget.platform_billing_offer_aggregate_version',
            true
        ) ~ '^[1-9][0-9]*$'
        AND current_setting(
            'winwidget.platform_billing_offer_source_sequence',
            true
        ) ~ '^[1-9][0-9]*$',
        false
    );

    FOREACH evidence_setting IN ARRAY ARRAY[
        'winwidget.platform_production_env_sha256',
        'winwidget.platform_compose_sha256',
        'winwidget.platform_first_complete_proof_sha256',
        'winwidget.platform_prisma_manifest_sha256',
        'winwidget.platform_prisma_pre_ledger_sha256',
        'winwidget.platform_snapshot_sha256',
        'winwidget.platform_source_fingerprint',
        'winwidget.platform_billing_offer_fence_fingerprint',
        'winwidget.platform_core_pre_backup_sha256',
        'winwidget.platform_pre_backup_sha256',
        'winwidget.platform_pre_restore_evidence_sha256',
        'winwidget.platform_soak_evidence_sha256',
        'winwidget.platform_route_evidence_sha256',
        'winwidget.platform_queue_evidence_sha256',
        'winwidget.platform_outbox_evidence_sha256',
        'winwidget.platform_frontend_evidence_sha256',
        'winwidget.platform_frontend_phase_evidence_chain_sha256',
        'winwidget.platform_topology_scan_evidence_sha256',
        'winwidget.platform_pre_offsite_receipt_sha256',
        'winwidget.platform_cleanup_migration_sha256'
    ] LOOP
        evidence_value := current_setting(evidence_setting, true);
        production_approved := production_approved AND COALESCE(
            evidence_value ~ '^[0-9a-f]{64}$'
            AND evidence_value <> repeat('0', 64),
            false
        );
    END LOOP;

    SELECT
        production_approved
        AND (
            SELECT count(*) = 1
            FROM public._prisma_migrations
            WHERE migration_name =
                '20260825000000_remove_legacy_platform_core_source'
              AND checksum = expected_migration_sha256
              AND finished_at IS NULL
              AND rolled_back_at IS NULL
        )
        AND (
            SELECT count(*) = 1
            FROM public.platform_core_state
        )
        AND EXISTS (
            SELECT 1
            FROM public.platform_core_state state
            WHERE state.id = 'singleton'
              AND state.ownership =
                  'PLATFORM'::public."PlatformCoreOwnership"
              AND NOT state.source_writes_enabled
              AND NOT state.legacy_routes_enabled
              AND state.generation::TEXT = current_setting(
                  'winwidget.platform_generation',
                  true
              )
              AND state.prepared_revision = expected_ownership_revision
              AND state.source_revision = expected_ownership_revision
              AND state.ownership_revision = expected_ownership_revision
              AND state.source_snapshot_sha256 = current_setting(
                  'winwidget.platform_snapshot_sha256',
                  true
              )
              AND state.source_fingerprint = current_setting(
                  'winwidget.platform_source_fingerprint',
                  true
              )
              AND state.source_high_watermark::TEXT = current_setting(
                  'winwidget.platform_source_high_watermark',
                  true
              )
              AND state.billing_offer_contract_version::TEXT =
                  current_setting(
                      'winwidget.platform_billing_offer_contract_version',
                      true
                  )
              AND state.billing_offer_sequence_scope = current_setting(
                  'winwidget.platform_billing_offer_sequence_scope',
                  true
              )
              AND state.billing_offer_aggregate_version::TEXT =
                  current_setting(
                      'winwidget.platform_billing_offer_aggregate_version',
                      true
                  )
              AND state.billing_offer_source_sequence::TEXT =
                  current_setting(
                      'winwidget.platform_billing_offer_source_sequence',
                      true
                  )
              AND state.billing_offer_fence_fingerprint =
                  current_setting(
                      'winwidget.platform_billing_offer_fence_fingerprint',
                      true
                  )
              AND state.fenced_at IS NOT NULL
              AND state.exported_at IS NOT NULL
              AND state.activated_at IS NOT NULL
              AND state.fenced_at <= state.exported_at
              AND state.exported_at <= state.activated_at
        )
        AND EXISTS (
            SELECT 1
            FROM public.billing_source_aggregate_versions cursor
            WHERE cursor.aggregate_type = 'billing.offer'
              AND cursor.aggregate_id = 'offer'
              AND cursor.version::TEXT = current_setting(
                  'winwidget.platform_billing_offer_aggregate_version',
                  true
              )
              AND cursor.source_sequence::TEXT = current_setting(
                  'winwidget.platform_billing_offer_source_sequence',
                  true
              )
        )
        AND NOT EXISTS (
            SELECT 1
            FROM public.outbox_events
            WHERE event_type IN (
                'admin.audit.platform.v1',
                'billing.offer.changed.v2'
            )
              AND status <> 'PUBLISHED'::public."OutboxEventStatus"
        )
    INTO production_approved;

    SELECT
        operations_terminal_approved
        AND (
            SELECT count(*) = 1
            FROM public._prisma_migrations
            WHERE migration_name =
                '20260825000000_remove_legacy_platform_core_source'
              AND checksum = current_setting(
                  'winwidget.operations_platform_migration_sha256',
                  true
              )
              AND finished_at IS NULL
              AND rolled_back_at IS NULL
        )
        AND (
            SELECT count(*) = 1
            FROM public.platform_core_state
        )
        AND EXISTS (
            SELECT 1
            FROM public.platform_core_state state
            WHERE state.id = 'singleton'
              AND state.ownership =
                  'PLATFORM'::public."PlatformCoreOwnership"
              AND NOT state.source_writes_enabled
              AND NOT state.legacy_routes_enabled
              AND state.generation::TEXT = current_setting(
                  'winwidget.operations_platform_generation',
                  true
              )
              AND state.prepared_revision = current_setting(
                  'winwidget.operations_platform_ownership_revision',
                  true
              )
              AND state.source_revision = current_setting(
                  'winwidget.operations_platform_ownership_revision',
                  true
              )
              AND state.ownership_revision = current_setting(
                  'winwidget.operations_platform_ownership_revision',
                  true
              )
              AND state.source_snapshot_sha256 = current_setting(
                  'winwidget.operations_platform_snapshot_sha256',
                  true
              )
              AND state.source_fingerprint = current_setting(
                  'winwidget.operations_platform_source_fingerprint',
                  true
              )
              AND state.source_high_watermark::TEXT = current_setting(
                  'winwidget.operations_platform_source_high_watermark',
                  true
              )
              AND state.billing_offer_contract_version::TEXT =
                  current_setting(
                      'winwidget.operations_platform_billing_offer_contract_version',
                      true
                  )
              AND state.billing_offer_sequence_scope = current_setting(
                  'winwidget.operations_platform_billing_offer_sequence_scope',
                  true
              )
              AND state.billing_offer_aggregate_version::TEXT =
                  current_setting(
                      'winwidget.operations_platform_billing_offer_aggregate_version',
                      true
                  )
              AND state.billing_offer_source_sequence::TEXT =
                  current_setting(
                      'winwidget.operations_platform_billing_offer_source_sequence',
                      true
                  )
              AND state.billing_offer_fence_fingerprint = current_setting(
                  'winwidget.operations_platform_billing_offer_fence_fingerprint',
                  true
              )
              AND state.fenced_at IS NOT NULL
              AND state.exported_at IS NOT NULL
              AND state.activated_at IS NOT NULL
              AND state.fenced_at <= state.exported_at
              AND state.exported_at <= state.activated_at
        )
        AND EXISTS (
            SELECT 1
            FROM public.billing_source_aggregate_versions cursor
            WHERE cursor.aggregate_type = 'billing.offer'
              AND cursor.aggregate_id = 'offer'
              AND cursor.version::TEXT = current_setting(
                  'winwidget.operations_platform_billing_offer_aggregate_version',
                  true
              )
              AND cursor.source_sequence::TEXT = current_setting(
                  'winwidget.operations_platform_billing_offer_source_sequence',
                  true
              )
        )
        AND NOT EXISTS (
            SELECT 1
            FROM public.outbox_events
            WHERE event_type IN (
                'admin.audit.platform.v1',
                'billing.offer.changed.v2'
            )
              AND status <> 'PUBLISHED'::public."OutboxEventStatus"
        )
        AND NOT EXISTS (
            SELECT 1
            FROM pg_catalog.pg_stat_activity activity
            WHERE activity.pid <> pg_backend_pid()
              AND activity.datname = current_database()
              AND activity.usename IN (
                  'gen_user',
                  'winwidget_api_runtime'
              )
        )
    INTO operations_terminal_approved;

    IF COALESCE(production_approved, false)
        AND COALESCE(operations_terminal_approved, false)
    THEN
        RAISE EXCEPTION
            'Platform Core source cleanup has ambiguous production approvals'
            USING ERRCODE = '55000';
    END IF;

    IF NOT (
        COALESCE(pristine_bootstrap, false)
        OR COALESCE(production_approved, false)
        OR COALESCE(operations_terminal_approved, false)
    ) THEN
        RAISE EXCEPTION
            'Platform Core source cleanup requires an exact evidenced or Operations terminal production approval, or an exact pristine non-production database'
            USING ERRCODE = '55000';
    END IF;
END
$platform_source_cleanup_guard$;

DROP TRIGGER "billing_offer_projection" ON public.legal_pages;
DROP TRIGGER "platform_core_state_transition_guard"
ON public.platform_core_state;
DROP TRIGGER "platform_site_settings_write_fence"
ON public.site_settings;
DROP TRIGGER "platform_legal_pages_write_fence"
ON public.legal_pages;
DROP TRIGGER "platform_home_page_content_write_fence"
ON public.home_page_content;

DROP FUNCTION public.billing_offer_projection_trigger();
DROP FUNCTION public.platform_core_state_transition_guard();
DROP FUNCTION public.platform_core_source_writes_enabled();
DROP FUNCTION public.platform_assert_core_write_enabled();

DO $platform_offer_cursor_cleanup$
DECLARE
    deleted_cursor_rows INTEGER;
BEGIN
    DELETE FROM public.billing_source_aggregate_versions
    WHERE aggregate_type = 'billing.offer'
      AND aggregate_id = 'offer';

    GET DIAGNOSTICS deleted_cursor_rows = ROW_COUNT;
    IF deleted_cursor_rows <> 1 THEN
        RAISE EXCEPTION
            'Platform cleanup expected exactly one Billing offer cursor'
            USING ERRCODE = '55000';
    END IF;
END
$platform_offer_cursor_cleanup$;

DROP TABLE
    public.site_settings,
    public.legal_pages,
    public.home_page_content,
    public.platform_core_state
RESTRICT;

DROP TYPE public."PlatformCoreOwnership" RESTRICT;

DO $platform_source_cleanup_verify$
DECLARE
    post_inventory TEXT;
BEGIN
    SELECT
        (
            SELECT count(*)
            FROM pg_catalog.pg_class relation
            JOIN pg_catalog.pg_namespace namespace
              ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'public'
              AND relation.relkind = 'r'
              AND relation.relname IN (
                  'site_settings',
                  'legal_pages',
                  'home_page_content',
                  'platform_core_state'
              )
        )::TEXT || '|' ||
        (
            SELECT count(*)
            FROM pg_catalog.pg_trigger trigger
            JOIN pg_catalog.pg_class relation
              ON relation.oid = trigger.tgrelid
            JOIN pg_catalog.pg_namespace namespace
              ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'public'
              AND NOT trigger.tgisinternal
              AND relation.relname IN (
                  'site_settings',
                  'legal_pages',
                  'home_page_content',
                  'platform_core_state'
              )
        )::TEXT || '|' ||
        (
            SELECT count(*)
            FROM pg_catalog.pg_proc routine
            JOIN pg_catalog.pg_namespace namespace
              ON namespace.oid = routine.pronamespace
            WHERE namespace.nspname = 'public'
              AND routine.proname IN (
                  'platform_core_state_transition_guard',
                  'platform_core_source_writes_enabled',
                  'platform_assert_core_write_enabled',
                  'billing_offer_projection_trigger'
              )
        )::TEXT || '|' ||
        (
            SELECT count(*)
            FROM pg_catalog.pg_type type_entry
            JOIN pg_catalog.pg_namespace namespace
              ON namespace.oid = type_entry.typnamespace
            WHERE namespace.nspname = 'public'
              AND type_entry.typname = 'PlatformCoreOwnership'
        )::TEXT || '|' ||
        (
            SELECT count(*)
            FROM public.billing_source_aggregate_versions
            WHERE aggregate_type = 'billing.offer'
              AND aggregate_id = 'offer'
        )::TEXT || '|' ||
        (
            to_regclass('public.billing_core_state') IS NOT NULL
            AND to_regclass(
                'public.billing_source_aggregate_versions'
            ) IS NOT NULL
            AND to_regclass(
                'public.billing_read_projection_versions'
            ) IS NOT NULL
            AND to_regclass(
                'public.billing_subscription_read_projections'
            ) IS NOT NULL
            AND to_regclass(
                'public.billing_payment_read_projections'
            ) IS NOT NULL
            AND to_regclass(
                'public.billing_affiliate_read_projections'
            ) IS NOT NULL
            AND to_regclass(
                'public.billing_settings_read_projection'
            ) IS NOT NULL
            AND to_regclass(
                'public.billing_settings_compositions'
            ) IS NOT NULL
            AND to_regclass('public.billing_source_sequence') IS NOT NULL
            AND to_regprocedure(
                'public.billing_record_source_event(text,text,text,text,jsonb,boolean)'
            ) IS NOT NULL
            AND to_regprocedure(
                'public.billing_iso_timestamp(timestamp without time zone)'
            ) IS NOT NULL
        )::TEXT
    INTO post_inventory;

    IF post_inventory IS DISTINCT FROM '0|0|0|0|0|true' THEN
        RAISE EXCEPTION
            'Post-cleanup Platform/Billing inventory is unsafe: %',
            post_inventory
            USING ERRCODE = '55000';
    END IF;
END
$platform_source_cleanup_verify$;

COMMIT;
