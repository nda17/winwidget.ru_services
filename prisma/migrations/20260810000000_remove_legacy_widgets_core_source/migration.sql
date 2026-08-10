-- Forward-only cleanup of the legacy Widgets source in the Core database.
--
-- A populated production database must provide the reviewed evidence settings
-- below. A completely empty bootstrap database is allowed so a clean migration
-- replay can reach the current steady schema without production credentials.

BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '5min';
SELECT pg_advisory_xact_lock(hashtext('winwidget.widgets.core-source-cleanup.v1'));

-- Acquire the irreversible boundary before evaluating any source-state guard.
-- This closes the race between the last drain/ACL check and DROP while still
-- allowing the whole migration to roll back atomically on every failed guard.
LOCK TABLE
    public.outbox_events,
    public.widget_runtime_daily_step_metrics,
    public.widget_runtime_daily_metrics,
    public.widget_runtime_presence,
    public.widget_config_revisions,
    public.calculator_leads,
    public.online_consultant_leads,
    public.stop_offer_leads,
    public.countdown_timer_leads,
    public.callback_leads,
    public.quiz_leads,
    public.leads,
    public.calculators,
    public.online_consultants,
    public.stop_offers,
    public.countdown_timers,
    public.callbacks,
    public.quizzes,
    public.widgets
IN ACCESS EXCLUSIVE MODE;

DO $widgets_source_cleanup_guard$
DECLARE
    target_tables CONSTANT TEXT[] := ARRAY[
        'widgets',
        'quizzes',
        'callbacks',
        'countdown_timers',
        'stop_offers',
        'online_consultants',
        'calculators',
        'leads',
        'quiz_leads',
        'callback_leads',
        'countdown_timer_leads',
        'stop_offer_leads',
        'online_consultant_leads',
        'calculator_leads',
        'widget_config_revisions',
        'widget_runtime_presence',
        'widget_runtime_daily_metrics',
        'widget_runtime_daily_step_metrics'
    ];
    present_count INTEGER;
    pristine_bootstrap BOOLEAN;
    production_approved BOOLEAN;
    relation_name TEXT;
    role_name TEXT;
BEGIN
    SELECT count(*)
    INTO present_count
    FROM unnest(target_tables) AS target(relation_name)
    WHERE to_regclass(format('public.%I', target.relation_name)) IS NOT NULL;

    IF present_count <> cardinality(target_tables) THEN
        RAISE EXCEPTION
            'Widgets Core source cleanup requires all 18 legacy tables; found %',
            present_count
            USING ERRCODE = '55000';
    END IF;

    SELECT
        NOT EXISTS (SELECT 1 FROM public."User")
        AND NOT EXISTS (SELECT 1 FROM public.auth_identities)
        AND NOT EXISTS (SELECT 1 FROM public.payments)
        AND NOT EXISTS (SELECT 1 FROM public.subscriptions)
        AND NOT EXISTS (SELECT 1 FROM public.outbox_events)
        AND NOT EXISTS (SELECT 1 FROM public.integration_delivery_receipts)
        AND NOT EXISTS (SELECT 1 FROM public.integration_delivery_failures)
        AND NOT EXISTS (SELECT 1 FROM public.integration_credential_snapshots)
    INTO pristine_bootstrap;

    -- Prove every source table is actually empty before accepting the
    -- dependency-free bootstrap path.
    IF pristine_bootstrap THEN
        FOREACH relation_name IN ARRAY target_tables LOOP
            EXECUTE format(
                'SELECT NOT EXISTS (SELECT 1 FROM public.%I)',
                relation_name
            ) INTO pristine_bootstrap;
            EXIT WHEN NOT pristine_bootstrap;
        END LOOP;
    END IF;

    production_approved := COALESCE(
        current_setting('winwidget.widgets_source_cleanup', true)
            = 'production-destructive-approved'
        AND current_setting('winwidget.widgets_ownership_state', true) = 'active'
        AND current_setting('winwidget.widgets_ownership_generation', true)
            ~ '^[1-9][0-9]*$'
        AND current_setting('winwidget.widgets_source_snapshot_sha256', true)
            ~ '^[0-9a-f]{64}$'
        AND current_setting('winwidget.widgets_source_snapshot_sha256', true)
            <> repeat('0', 64)
        AND current_setting('winwidget.widgets_core_backup_sha256', true)
            ~ '^[0-9a-f]{64}$'
        AND current_setting('winwidget.widgets_core_backup_sha256', true)
            <> repeat('0', 64)
        AND current_setting('winwidget.widgets_backup_sha256', true)
            ~ '^[0-9a-f]{64}$'
        AND current_setting('winwidget.widgets_backup_sha256', true)
            <> repeat('0', 64)
        AND current_setting('winwidget.widgets_restore_evidence_sha256', true)
            ~ '^[0-9a-f]{64}$'
        AND current_setting('winwidget.widgets_restore_evidence_sha256', true)
            <> repeat('0', 64),
        false
    );

    IF production_approved AND current_database() <> 'default_db' THEN
        RAISE EXCEPTION 'Production Widgets source cleanup targets only default_db'
            USING ERRCODE = '55000';
    END IF;

    IF NOT (pristine_bootstrap OR production_approved) THEN
        RAISE EXCEPTION
            'Widgets Core source cleanup requires reviewed production evidence'
            USING ERRCODE = '55000';
    END IF;

    IF to_regprocedure('public.widgets_cutover_reject_legacy_write()') IS NOT NULL
       OR EXISTS (
            SELECT 1
            FROM pg_catalog.pg_trigger trigger
            WHERE trigger.tgname = 'widgets_cutover_write_fence'
              AND NOT trigger.tgisinternal
       ) THEN
        RAISE EXCEPTION 'Widgets Core source cleanup found an active write fence'
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
        RAISE EXCEPTION 'A non-Widgets table still references the legacy Widgets source'
            USING ERRCODE = '55000';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_trigger trigger
        JOIN pg_catalog.pg_class relation
          ON relation.oid = trigger.tgrelid
        JOIN pg_catalog.pg_namespace namespace
          ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname = ANY(target_tables)
          AND NOT trigger.tgisinternal
          AND trigger.tgname <> ALL(ARRAY[
              'reporting_widget_projection',
              'reporting_quiz_projection',
              'reporting_callback_projection',
              'reporting_countdown_timer_projection',
              'reporting_stop_offer_projection',
              'reporting_online_consultant_projection',
              'reporting_calculator_projection',
              'reporting_wheel_lead_projection',
              'reporting_quiz_lead_projection',
              'reporting_callback_lead_projection',
              'reporting_countdown_timer_lead_projection',
              'reporting_stop_offer_lead_projection',
              'reporting_online_consultant_lead_projection',
              'reporting_calculator_lead_projection'
          ])
    ) THEN
        RAISE EXCEPTION 'An unexpected trigger depends on the legacy Widgets source'
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
        RAISE EXCEPTION 'A row-level security policy remains on the legacy Widgets source'
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
          AND relation.relname = ANY(target_tables)
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
        RAISE EXCEPTION 'A publication still contains the legacy Widgets source'
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
        RAISE EXCEPTION 'A sequence is still owned by the legacy Widgets source'
            USING ERRCODE = '55000';
    END IF;

    IF production_approved THEN
        IF to_regrole('gen_user') IS NULL
           OR to_regrole('winwidget_backup') IS NULL THEN
            RAISE EXCEPTION 'Core cleanup database roles are incomplete'
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
                    'Legacy Widgets relation % does not have the exact migration owner',
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
                IF to_regrole(role_name) IS NULL
                   OR has_table_privilege(
                        role_name,
                        format('public.%I', relation_name),
                        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
                   ) THEN
                    RAISE EXCEPTION
                        'Core role % retains a legacy Widgets privilege on %',
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
            RAISE EXCEPTION 'PUBLIC retains a legacy Widgets table privilege'
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
            RAISE EXCEPTION 'Unexpected grantee remains on the legacy Widgets source'
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
            RAISE EXCEPTION 'Column-level ACL remains on the legacy Widgets source'
                USING ERRCODE = '55000';
        END IF;

        IF to_regprocedure('public.reporting_widget_projection_trigger()')
                IS NOT NULL
           OR to_regprocedure('public.reporting_lead_projection_trigger()')
                IS NOT NULL
           OR EXISTS (
                SELECT 1
                FROM pg_catalog.pg_trigger trigger
                JOIN pg_catalog.pg_class relation
                  ON relation.oid = trigger.tgrelid
                JOIN pg_catalog.pg_namespace namespace
                  ON namespace.oid = relation.relnamespace
                WHERE namespace.nspname = 'public'
                  AND relation.relname = ANY(target_tables)
                  AND NOT trigger.tgisinternal
           ) THEN
            RAISE EXCEPTION
                'Legacy Widgets Reporting producers remain before source cleanup'
                USING ERRCODE = '55000';
        END IF;

        IF EXISTS (
            SELECT 1
            FROM public.outbox_events
            WHERE (
                event_type IN (
                    'widgets.widget.changed.v1',
                    'widgets.lead.changed.v1',
                    'lead.integration.requested.v2',
                    'lead.limit.reached.email.v2',
                    'lead.limit.reached.telegram.v2'
                )
                OR (
                    event_type = 'admin.audit.event.v1'
                    AND routing_key = 'admin.audit.widgets.v1'
                )
              )
              AND status <> 'PUBLISHED'::public."OutboxEventStatus"
        ) THEN
            RAISE EXCEPTION 'Legacy Widgets Outbox state is not drained'
                USING ERRCODE = '55000';
        END IF;
    END IF;
END
$widgets_source_cleanup_guard$;

DROP TABLE
    public.widget_runtime_daily_step_metrics,
    public.widget_runtime_daily_metrics,
    public.widget_runtime_presence,
    public.widget_config_revisions,
    public.calculator_leads,
    public.online_consultant_leads,
    public.stop_offer_leads,
    public.countdown_timer_leads,
    public.callback_leads,
    public.quiz_leads,
    public.leads,
    public.calculators,
    public.online_consultants,
    public.stop_offers,
    public.countdown_timers,
    public.callbacks,
    public.quizzes,
    public.widgets
RESTRICT;

DROP FUNCTION IF EXISTS public.reporting_widget_projection_trigger();
DROP FUNCTION IF EXISTS public.reporting_lead_projection_trigger();

DO $widgets_source_cleanup_verify$
DECLARE
    relation_name TEXT;
BEGIN
    FOREACH relation_name IN ARRAY ARRAY[
        'widgets',
        'quizzes',
        'callbacks',
        'countdown_timers',
        'stop_offers',
        'online_consultants',
        'calculators',
        'leads',
        'quiz_leads',
        'callback_leads',
        'countdown_timer_leads',
        'stop_offer_leads',
        'online_consultant_leads',
        'calculator_leads',
        'widget_config_revisions',
        'widget_runtime_presence',
        'widget_runtime_daily_metrics',
        'widget_runtime_daily_step_metrics'
    ] LOOP
        IF to_regclass(format('public.%I', relation_name)) IS NOT NULL THEN
            RAISE EXCEPTION 'Legacy Widgets relation remains: %', relation_name;
        END IF;
    END LOOP;
    IF to_regprocedure('public.reporting_widget_projection_trigger()') IS NOT NULL
       OR to_regprocedure('public.reporting_lead_projection_trigger()') IS NOT NULL THEN
        RAISE EXCEPTION 'Legacy Widgets Reporting function remains';
    END IF;
END
$widgets_source_cleanup_verify$;

COMMIT;
