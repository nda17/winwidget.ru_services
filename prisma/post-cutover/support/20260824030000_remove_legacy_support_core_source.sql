BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

SELECT set_config(
    'winwidget.support_cleanup_confirmation',
    :'cleanup_confirmation',
    true
);
SELECT set_config(
    'winwidget.support_cleanup_revision',
    :'cleanup_revision',
    true
);
SELECT set_config(
    'winwidget.support_target_database_id',
    :'target_database_id',
    true
);
SELECT set_config(
    'winwidget.support_source_database_system_id',
    :'source_database_system_id',
    true
);
SELECT set_config(
    'winwidget.support_source_fingerprint',
    :'source_fingerprint',
    true
);
SELECT set_config(
    'winwidget.support_source_snapshot_sha256',
    :'source_snapshot_sha256',
    true
);
SELECT set_config(
    'winwidget.support_source_mapping_count',
    :'source_mapping_count',
    true
);
SELECT set_config(
    'winwidget.support_source_high_watermark',
    :'source_high_watermark',
    true
);

SELECT pg_advisory_xact_lock(
    hashtextextended('winwidget.support-core-source-cleanup.v1', 0)
);

DO $cleanup_guard$
DECLARE
    marker "support_core_state"%ROWTYPE;
    source_count BIGINT;
    cleanup_revision TEXT :=
        current_setting('winwidget.support_cleanup_revision', true);
    target_database_id TEXT :=
        current_setting('winwidget.support_target_database_id', true);
    source_database_system_id TEXT :=
        current_setting('winwidget.support_source_database_system_id', true);
    source_fingerprint TEXT :=
        current_setting('winwidget.support_source_fingerprint', true);
    source_snapshot_sha256 TEXT :=
        current_setting('winwidget.support_source_snapshot_sha256', true);
    source_mapping_count TEXT :=
        current_setting('winwidget.support_source_mapping_count', true);
    source_high_watermark TEXT :=
        current_setting('winwidget.support_source_high_watermark', true);
BEGIN
    IF current_setting(
        'winwidget.support_cleanup_confirmation',
        true
    ) IS DISTINCT FROM 'DROP LEGACY SUPPORT CORE SOURCE' THEN
        RAISE EXCEPTION 'exact Support cleanup confirmation is required';
    END IF;
    IF cleanup_revision IS NULL
        OR cleanup_revision !~ '^[0-9a-f]{40}$'
        OR target_database_id IS NULL
        OR target_database_id !~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        OR source_database_system_id IS NULL
        OR source_database_system_id !~ '^[1-9][0-9]{0,31}$'
        OR source_fingerprint IS NULL
        OR source_fingerprint !~ '^[0-9a-f]{64}$'
        OR source_snapshot_sha256 IS NULL
        OR source_snapshot_sha256 !~ '^[0-9a-f]{64}$'
        OR source_mapping_count IS NULL
        OR source_mapping_count !~ '^(0|[1-9][0-9]*)$'
        OR source_high_watermark IS NULL
        OR source_high_watermark !~ '^[1-9][0-9]*$' THEN
        RAISE EXCEPTION 'Support cleanup immutable inputs are invalid';
    END IF;
    IF to_regclass('public.telegram_support_messages') IS NULL
        OR NOT EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public'
                AND table_name = 'telegram_bot_settings'
                AND column_name = 'support_thread_id'
        ) THEN
        RAISE EXCEPTION 'legacy Support Core source is already absent or incomplete';
    END IF;

    SELECT *
    INTO STRICT marker
    FROM "support_core_state"
    WHERE "id" = 'singleton'
    FOR UPDATE;

    IF marker."ownership" <> 'SUPPORT'
        OR marker."admission_enabled"
        OR marker."reconciler_enabled"
        OR marker."active_task_count" <> 0
        OR marker."generation" < 1
        OR marker."prepared_revision" IS DISTINCT FROM cleanup_revision
        OR marker."source_revision" IS DISTINCT FROM cleanup_revision
        OR marker."ownership_revision" IS DISTINCT FROM cleanup_revision
        OR marker."source_database_system_id" IS DISTINCT FROM
            source_database_system_id
        OR marker."source_fingerprint" IS DISTINCT FROM source_fingerprint
        OR marker."source_snapshot_sha256" IS DISTINCT FROM
            source_snapshot_sha256
        OR marker."source_mapping_count" IS DISTINCT FROM
            source_mapping_count::BIGINT
        OR marker."source_high_watermark" IS DISTINCT FROM
            source_high_watermark::BIGINT
        OR marker."fenced_at" IS NULL
        OR marker."exported_at" IS NULL
        OR marker."activated_at" IS NULL
        OR marker."exported_at" < marker."fenced_at"
        OR marker."activated_at" < marker."exported_at" THEN
        RAISE EXCEPTION 'Support Core ownership marker does not match target attestation';
    END IF;

    SELECT count(*) INTO source_count FROM "telegram_support_messages";
    IF source_count <> marker."source_mapping_count" THEN
        RAISE EXCEPTION 'legacy Support mapping count drifted after ownership switch';
    END IF;
END
$cleanup_guard$;

CREATE TABLE "support_core_cleanup_state" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cleanup_revision" TEXT NOT NULL,
    "target_database_id" UUID NOT NULL,
    "source_database_system_id" TEXT NOT NULL,
    "source_fingerprint" TEXT NOT NULL,
    "source_snapshot_sha256" TEXT NOT NULL,
    "source_mapping_count" BIGINT NOT NULL,
    "source_high_watermark" BIGINT NOT NULL,
    "cleaned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "support_core_cleanup_state_singleton_check"
        CHECK ("id" = 'singleton'),
    CONSTRAINT "support_core_cleanup_state_revision_check"
        CHECK ("cleanup_revision" ~ '^[0-9a-f]{40}$'),
    CONSTRAINT "support_core_cleanup_state_hash_check"
        CHECK (
            "source_fingerprint" ~ '^[0-9a-f]{64}$'
            AND "source_snapshot_sha256" ~ '^[0-9a-f]{64}$'
        ),
    CONSTRAINT "support_core_cleanup_state_count_check"
        CHECK (
            "source_mapping_count" >= 0
            AND "source_high_watermark" >= 1
        )
);

INSERT INTO "support_core_cleanup_state" (
    "id",
    "cleanup_revision",
    "target_database_id",
    "source_database_system_id",
    "source_fingerprint",
    "source_snapshot_sha256",
    "source_mapping_count",
    "source_high_watermark"
)
VALUES (
    'singleton',
    current_setting('winwidget.support_cleanup_revision'),
    current_setting('winwidget.support_target_database_id')::UUID,
    current_setting('winwidget.support_source_database_system_id'),
    current_setting('winwidget.support_source_fingerprint'),
    current_setting('winwidget.support_source_snapshot_sha256'),
    current_setting('winwidget.support_source_mapping_count')::BIGINT,
    current_setting('winwidget.support_source_high_watermark')::BIGINT
);

DROP TABLE "telegram_support_messages";
ALTER TABLE "telegram_bot_settings" DROP COLUMN "support_thread_id";

COMMIT;
