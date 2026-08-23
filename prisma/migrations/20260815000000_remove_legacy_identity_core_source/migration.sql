-- Forward-only cleanup of the legacy Identity source in the Core database.
--
-- Production execution requires cleanup-workflow session evidence for stable
-- Identity ownership, the soak interval, drained queues/consumers, stopped
-- Core writers, exact backups and an independently restored Identity dump.
-- A pristine bootstrap database is allowed so a full migration replay can
-- reach the current steady schema without production-only evidence.

BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '5min';
SELECT pg_advisory_xact_lock(
    hashtext('winwidget.identity.core-source-cleanup.v1')
);

-- Close every legacy Identity writer before checking the irreversible guard.
-- The existing source fence already serializes writers on its singleton row;
-- ACCESS EXCLUSIVE locks make the subsequent verification and DROP one atomic
-- boundary.
LOCK TABLE
    public."identity_core_source_state",
    public."User",
    public.auth_identities,
    public.telegram_notification_channels,
    public.user_sessions,
    public.verification_challenges,
    public.site_settings,
    public.outbox_events,
    public.reporting_producer_state,
    public.billing_core_state
IN ACCESS EXCLUSIVE MODE;

DO $identity_source_cleanup_guard$
DECLARE
    target_tables CONSTANT TEXT[] := ARRAY[
        'User',
        'auth_identities',
        'telegram_notification_channels',
        'user_sessions',
        'verification_challenges',
        'identity_core_source_state'
    ];
    auth_settings_columns CONSTANT TEXT[] := ARRAY[
        'recaptcha_enabled',
        'google_auth_enabled',
        'yandex_auth_enabled',
        'github_auth_enabled',
        'vk_auth_enabled',
        'telegram_auth_enabled'
    ];
    expected_triggers CONSTANT TEXT[] := ARRAY[
        'User:reporting_user_projection',
        'User:billing_identity_user_projection',
        'User:identity_core_source_write_fence',
        'auth_identities:reporting_auth_identity_projection',
        'auth_identities:billing_identity_auth_projection',
        'auth_identities:identity_core_source_write_fence',
        'telegram_notification_channels:billing_identity_telegram_projection',
        'telegram_notification_channels:identity_core_source_write_fence',
        'user_sessions:identity_core_source_write_fence',
        'verification_challenges:identity_core_source_write_fence',
        'site_settings:identity_core_auth_settings_write_fence'
    ];
    expected_functions CONSTANT TEXT[] := ARRAY[
        'public.reporting_emit_user_projection(text,boolean)',
        'public.reporting_user_projection_trigger()',
        'public.reporting_auth_identity_projection_trigger()',
        'public.billing_emit_identity_projection(text,boolean)',
        'public.billing_identity_user_projection_trigger()',
        'public.billing_identity_auth_projection_trigger()',
        'public.billing_identity_telegram_projection_trigger()',
        'public.identity_core_source_is_open()',
        'public.lock_identity_core_source_open()',
        'public.reject_fenced_identity_core_source_write()',
        'public.reject_fenced_identity_auth_settings_write()',
        'public.fence_identity_core_source(text)',
        'public.unfence_identity_core_source(text)'
    ];
    actual_triggers TEXT[];
    sorted_expected_triggers TEXT[];
    actual_functions TEXT[];
    sorted_expected_functions TEXT[];
    present_count INTEGER;
    pristine_bootstrap BOOLEAN;
    production_approved BOOLEAN;
    relation_name TEXT;
    column_name TEXT;
    signature TEXT;
    evidence_setting TEXT;
    evidence_value TEXT;
    expected_ownership_revision TEXT;
    expected_cleanup_revision TEXT;
    expected_cleanup_migration_sha256 TEXT;
BEGIN
    SELECT count(*)
    INTO present_count
    FROM unnest(target_tables) AS target(relation_name)
    WHERE to_regclass(format('public.%I', target.relation_name)) IS NOT NULL;

    IF present_count <> cardinality(target_tables) THEN
        RAISE EXCEPTION
            'Identity Core source cleanup requires all 6 legacy tables; found %',
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
      AND attribute.attname = ANY(auth_settings_columns)
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped;

    IF present_count <> cardinality(auth_settings_columns) THEN
        RAISE EXCEPTION
            'Identity Core source cleanup requires all 6 auth settings columns; found %',
            present_count
            USING ERRCODE = '55000';
    END IF;

    FOREACH signature IN ARRAY expected_functions LOOP
        IF to_regprocedure(signature) IS NULL THEN
            RAISE EXCEPTION
                'Identity Core source cleanup is missing function %',
                signature
                USING ERRCODE = '55000';
        END IF;
    END LOOP;

    SELECT array_agg(
        format(
            '%s.%s(%s)',
            namespace.nspname,
            routine.proname,
            replace(
                pg_catalog.oidvectortypes(routine.proargtypes),
                ' ',
                ''
            )
        )
        ORDER BY format(
            '%s.%s(%s)',
            namespace.nspname,
            routine.proname,
            replace(
                pg_catalog.oidvectortypes(routine.proargtypes),
                ' ',
                ''
            )
        ) COLLATE "C"
    )
    INTO actual_functions
    FROM pg_catalog.pg_proc routine
    JOIN pg_catalog.pg_namespace namespace
      ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname = 'public'
      AND (
          starts_with(routine.proname, 'billing_identity_')
          OR (
              starts_with(routine.proname, 'reporting_')
              AND position('identity' IN routine.proname) > 0
          )
          OR starts_with(routine.proname, 'identity_core_')
          OR starts_with(
              routine.proname,
              'reject_fenced_identity_'
          )
          OR starts_with(
              routine.proname,
              'lock_identity_core_source'
          )
          OR starts_with(
              routine.proname,
              'fence_identity_core_source'
          )
          OR starts_with(
              routine.proname,
              'unfence_identity_core_source'
          )
          OR starts_with(
              routine.proname,
              'reporting_emit_user_projection'
          )
          OR starts_with(
              routine.proname,
              'reporting_user_projection'
          )
          OR starts_with(
              routine.proname,
              'billing_emit_identity_projection'
          )
      );

    SELECT array_agg(value ORDER BY value COLLATE "C")
    INTO sorted_expected_functions
    FROM unnest(expected_functions) AS expected(value);

    IF actual_functions IS DISTINCT FROM sorted_expected_functions THEN
        RAISE EXCEPTION
            'Identity Core source function set is not exact'
            USING ERRCODE = '55000';
    END IF;

    SELECT array_agg(
        format('%s:%s', relation.relname, trigger.tgname)
        ORDER BY format('%s:%s', relation.relname, trigger.tgname) COLLATE "C"
    )
    INTO actual_triggers
    FROM pg_catalog.pg_trigger trigger
    JOIN pg_catalog.pg_class relation
      ON relation.oid = trigger.tgrelid
    JOIN pg_catalog.pg_namespace namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND NOT trigger.tgisinternal
      AND (
          relation.relname = ANY(target_tables)
          OR (
              relation.relname = 'site_settings'
              AND trigger.tgname LIKE 'identity_core_%'
          )
      );

    SELECT array_agg(value ORDER BY value COLLATE "C")
    INTO sorted_expected_triggers
    FROM unnest(expected_triggers) AS expected(value);

    IF actual_triggers IS DISTINCT FROM sorted_expected_triggers THEN
        RAISE EXCEPTION
            'Identity Core source trigger set is not exact'
            USING ERRCODE = '55000';
    END IF;

    SELECT
        NOT EXISTS (SELECT 1 FROM public."User")
        AND NOT EXISTS (SELECT 1 FROM public.auth_identities)
        AND NOT EXISTS (
            SELECT 1 FROM public.telegram_notification_channels
        )
        AND NOT EXISTS (SELECT 1 FROM public.user_sessions)
        AND NOT EXISTS (SELECT 1 FROM public.verification_challenges)
        AND EXISTS (
            SELECT 1
            FROM public.identity_core_source_state
            WHERE id = 'singleton'
              AND ownership = 'OPEN'
              AND generation = 0
              AND fenced_revision IS NULL
              AND fenced_at IS NULL
        )
        AND (
            SELECT count(*) = 1
            FROM public.identity_core_source_state
        )
        AND NOT EXISTS (
            SELECT 1
            FROM public.outbox_events
            WHERE event_type IN (
                'identity.user.changed.v1',
                'billing.identity.changed.v1'
            )
        )
    INTO pristine_bootstrap;

    expected_ownership_revision := current_setting(
        'winwidget.identity_ownership_revision',
        true
    );
    expected_cleanup_revision := current_setting(
        'winwidget.identity_cleanup_revision',
        true
    );
    expected_cleanup_migration_sha256 := current_setting(
        'winwidget.identity_cleanup_migration_sha256',
        true
    );
    production_approved := COALESCE(
        current_setting(
            'winwidget.identity_core_source_cleanup',
            true
        ) = 'production-destructive-approved'
        AND current_setting(
            'winwidget.identity_ownership_phase',
            true
        ) = 'complete'
        AND expected_ownership_revision ~ '^[0-9a-f]{40}$'
        AND expected_ownership_revision <> repeat('0', 40)
        AND expected_cleanup_revision ~ '^[0-9a-f]{40}$'
        AND expected_cleanup_revision <> repeat('0', 40)
        AND expected_cleanup_revision <> expected_ownership_revision,
        false
    );

    FOREACH evidence_setting IN ARRAY ARRAY[
        'winwidget.identity_cleanup_migration_sha256',
        'winwidget.identity_core_backup_sha256',
        'winwidget.identity_backup_sha256',
        'winwidget.identity_restore_evidence_sha256',
        'winwidget.identity_queue_drain_evidence_sha256',
        'winwidget.identity_stopped_writers_evidence_sha256',
        'winwidget.identity_soak_evidence_sha256'
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
        AND current_database() = 'default_db'
        AND (
            SELECT count(*) = 1
            FROM public._prisma_migrations
            WHERE migration_name =
                '20260815000000_remove_legacy_identity_core_source'
              AND checksum = expected_cleanup_migration_sha256
              AND finished_at IS NULL
              AND rolled_back_at IS NULL
        )
        AND (
            SELECT count(*) = 1
            FROM public.identity_core_source_state
        )
        AND EXISTS (
            SELECT 1
            FROM public.identity_core_source_state
            WHERE id = 'singleton'
              AND ownership = 'FENCED'
              AND generation > 0
              AND fenced_revision = expected_ownership_revision
              AND fenced_at IS NOT NULL
        )
        AND EXISTS (
            SELECT 1
            FROM public.reporting_producer_state
            WHERE id = 'singleton'
              AND enabled
              AND daily_summary_owner = 'REPORTING'
              AND daily_summary_switch_generation > 0
              AND daily_summary_switched_at IS NOT NULL
        )
        AND EXISTS (
            SELECT 1
            FROM public.billing_core_state
            WHERE id = 'singleton'
              AND ownership = 'BILLING'::public."BillingCoreOwnership"
              AND NOT source_producers_enabled
              AND NOT legacy_routes_enabled
              AND NOT scheduler_enabled
              AND NOT legacy_consumer_enabled
              AND projection_consumer_enabled
              AND generation > 0
              AND ownership_revision ~ '^[0-9a-f]{40}$'
              AND activated_at IS NOT NULL
        )
        AND NOT EXISTS (
            SELECT 1
            FROM public.outbox_events
            WHERE event_type IN (
                'identity.user.changed.v1',
                'billing.identity.changed.v1'
            )
              AND status <> 'PUBLISHED'::public."OutboxEventStatus"
        )
    INTO production_approved;

    IF NOT (pristine_bootstrap OR production_approved) THEN
        RAISE EXCEPTION
            'Identity Core source cleanup requires a fenced, drained production source or pristine bootstrap'
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
        RAISE EXCEPTION
            'A non-Identity table still references the legacy Identity source'
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
          AND relation.relname = ANY(target_tables)
    ) THEN
        RAISE EXCEPTION
            'A row-level security policy remains on the legacy Identity source'
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
        RAISE EXCEPTION
            'A publication still contains the legacy Identity source'
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
        RAISE EXCEPTION
            'A sequence is still owned by the legacy Identity source'
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
            'An unexpected catalog object depends on the legacy Identity source'
            USING ERRCODE = '55000';
    END IF;

    FOREACH column_name IN ARRAY auth_settings_columns LOOP
        IF EXISTS (
            SELECT 1
            FROM pg_catalog.pg_depend dependency
            JOIN pg_catalog.pg_attribute attribute
              ON attribute.attrelid = dependency.refobjid
             AND attribute.attnum = dependency.refobjsubid
            WHERE dependency.refclassid = 'pg_class'::regclass
              AND dependency.refobjid = 'public.site_settings'::regclass
              AND attribute.attname = column_name
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
                'An unexpected catalog object depends on legacy Identity setting %',
                column_name
                USING ERRCODE = '55000';
        END IF;
    END LOOP;

    IF production_approved THEN
        IF to_regrole('gen_user') IS NULL
           OR to_regrole('winwidget_backup') IS NULL
           OR to_regrole('winwidget_api_runtime') IS NULL
           OR to_regrole('winwidget_maintenance') IS NULL THEN
            RAISE EXCEPTION
                'Core cleanup database roles are incomplete'
                USING ERRCODE = '55000';
        END IF;

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
                    'Legacy Identity relation % does not have the exact migration owner',
                    relation_name
                    USING ERRCODE = '55000';
            END IF;
        END LOOP;

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

        FOREACH relation_name IN ARRAY target_tables LOOP
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
                    'Core backup role does not have exact read-only ACL on %',
                    relation_name
                    USING ERRCODE = '55000';
            END IF;
        END LOOP;
    END IF;
END
$identity_source_cleanup_guard$;

DROP TRIGGER "reporting_user_projection" ON public."User";
DROP TRIGGER "billing_identity_user_projection" ON public."User";
DROP TRIGGER "identity_core_source_write_fence" ON public."User";

DROP TRIGGER "reporting_auth_identity_projection"
ON public.auth_identities;
DROP TRIGGER "billing_identity_auth_projection"
ON public.auth_identities;
DROP TRIGGER "identity_core_source_write_fence"
ON public.auth_identities;

DROP TRIGGER "billing_identity_telegram_projection"
ON public.telegram_notification_channels;
DROP TRIGGER "identity_core_source_write_fence"
ON public.telegram_notification_channels;
DROP TRIGGER "identity_core_source_write_fence"
ON public.user_sessions;
DROP TRIGGER "identity_core_source_write_fence"
ON public.verification_challenges;
DROP TRIGGER "identity_core_auth_settings_write_fence"
ON public.site_settings;

DROP FUNCTION public.reporting_user_projection_trigger();
DROP FUNCTION public.reporting_auth_identity_projection_trigger();
DROP FUNCTION public.reporting_emit_user_projection(TEXT, BOOLEAN);

DROP FUNCTION public.billing_identity_user_projection_trigger();
DROP FUNCTION public.billing_identity_auth_projection_trigger();
DROP FUNCTION public.billing_identity_telegram_projection_trigger();
DROP FUNCTION public.billing_emit_identity_projection(TEXT, BOOLEAN);

DROP FUNCTION public.reject_fenced_identity_core_source_write();
DROP FUNCTION public.reject_fenced_identity_auth_settings_write();
DROP FUNCTION public.identity_core_source_is_open();
DROP FUNCTION public.lock_identity_core_source_open();
DROP FUNCTION public.fence_identity_core_source(TEXT);
DROP FUNCTION public.unfence_identity_core_source(TEXT);

DROP TABLE
    public.user_sessions,
    public.verification_challenges,
    public.telegram_notification_channels,
    public.auth_identities,
    public."User",
    public.identity_core_source_state
RESTRICT;

ALTER TABLE public.site_settings
    DROP COLUMN recaptcha_enabled,
    DROP COLUMN google_auth_enabled,
    DROP COLUMN yandex_auth_enabled,
    DROP COLUMN github_auth_enabled,
    DROP COLUMN vk_auth_enabled,
    DROP COLUMN telegram_auth_enabled;

DROP TYPE public."VerificationChallengePurpose" RESTRICT;
DROP TYPE public."VerificationChallengeType" RESTRICT;
DROP TYPE public."AuthIdentityType" RESTRICT;
DROP TYPE public."UserStatus" RESTRICT;
DROP TYPE public."Role" RESTRICT;

DO $identity_source_cleanup_verify$
DECLARE
    relation_name TEXT;
    column_name TEXT;
    signature TEXT;
    type_name TEXT;
BEGIN
    FOREACH relation_name IN ARRAY ARRAY[
        'User',
        'auth_identities',
        'telegram_notification_channels',
        'user_sessions',
        'verification_challenges',
        'identity_core_source_state'
    ] LOOP
        IF to_regclass(format('public.%I', relation_name)) IS NOT NULL THEN
            RAISE EXCEPTION
                'Legacy Identity relation remains: %',
                relation_name;
        END IF;
    END LOOP;

    FOREACH column_name IN ARRAY ARRAY[
        'recaptcha_enabled',
        'google_auth_enabled',
        'yandex_auth_enabled',
        'github_auth_enabled',
        'vk_auth_enabled',
        'telegram_auth_enabled'
    ] LOOP
        IF EXISTS (
            SELECT 1
            FROM pg_catalog.pg_attribute attribute
            WHERE attribute.attrelid = 'public.site_settings'::regclass
              AND attribute.attname = column_name
              AND attribute.attnum > 0
              AND NOT attribute.attisdropped
        ) THEN
            RAISE EXCEPTION
                'Legacy Identity settings column remains: %',
                column_name;
        END IF;
    END LOOP;

    FOREACH signature IN ARRAY ARRAY[
        'public.reporting_emit_user_projection(text,boolean)',
        'public.reporting_user_projection_trigger()',
        'public.reporting_auth_identity_projection_trigger()',
        'public.billing_emit_identity_projection(text,boolean)',
        'public.billing_identity_user_projection_trigger()',
        'public.billing_identity_auth_projection_trigger()',
        'public.billing_identity_telegram_projection_trigger()',
        'public.identity_core_source_is_open()',
        'public.lock_identity_core_source_open()',
        'public.reject_fenced_identity_core_source_write()',
        'public.reject_fenced_identity_auth_settings_write()',
        'public.fence_identity_core_source(text)',
        'public.unfence_identity_core_source(text)'
    ] LOOP
        IF to_regprocedure(signature) IS NOT NULL THEN
            RAISE EXCEPTION
                'Legacy Identity function remains: %',
                signature;
        END IF;
    END LOOP;

    FOREACH type_name IN ARRAY ARRAY[
        'Role',
        'UserStatus',
        'AuthIdentityType',
        'VerificationChallengeType',
        'VerificationChallengePurpose'
    ] LOOP
        IF to_regtype(format('public.%I', type_name)) IS NOT NULL THEN
            RAISE EXCEPTION
                'Legacy Identity enum remains: %',
                type_name;
        END IF;
    END LOOP;

    FOREACH signature IN ARRAY ARRAY[
        'public.reporting_producers_enabled()',
        'public.reporting_iso_timestamp(timestamp without time zone)',
        'public.reporting_record_projection_event(text,text,text,text,jsonb,boolean)',
        'public.reporting_settings_projection_trigger()',
        'public.billing_core_state_transition_guard()',
        'public.billing_core_source_producers_enabled()',
        'public.billing_core_ownership_active()',
        'public.billing_iso_timestamp(timestamp without time zone)',
        'public.billing_record_source_event(text,text,text,text,jsonb,boolean)',
        'public.billing_notification_routing_projection_trigger()',
        'public.billing_offer_projection_trigger()'
    ] LOOP
        IF to_regprocedure(signature) IS NULL THEN
            RAISE EXCEPTION
                'Required retained Core producer function is missing: %',
                signature;
        END IF;
    END LOOP;

    IF to_regclass('public.site_settings') IS NULL
       OR to_regclass('public.telegram_bot_settings') IS NULL
       OR to_regclass('public.admin_event_logs') IS NULL
       OR to_regclass('public.outbox_events') IS NULL THEN
        RAISE EXCEPTION
            'A required residual Core relation was removed';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_trigger trigger
        JOIN pg_catalog.pg_class relation
          ON relation.oid = trigger.tgrelid
        JOIN pg_catalog.pg_namespace namespace
          ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND NOT trigger.tgisinternal
          AND trigger.tgname LIKE 'identity_core_%'
    ) THEN
        RAISE EXCEPTION
            'A legacy Identity Core trigger remains';
    END IF;
END
$identity_source_cleanup_verify$;

COMMIT;

