CREATE TYPE "SupportCoreOwnership" AS ENUM ('CORE', 'SUPPORT');

CREATE TABLE "support_core_state" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "ownership" "SupportCoreOwnership" NOT NULL DEFAULT 'CORE',
    "admission_enabled" BOOLEAN NOT NULL DEFAULT true,
    "reconciler_enabled" BOOLEAN NOT NULL DEFAULT true,
    "active_task_count" INTEGER NOT NULL DEFAULT 0,
    "generation" BIGINT NOT NULL DEFAULT 0,
    "prepared_revision" TEXT,
    "source_revision" TEXT,
    "ownership_revision" TEXT,
    "source_database_system_id" TEXT,
    "source_fingerprint" TEXT,
    "source_snapshot_sha256" TEXT,
    "source_mapping_count" BIGINT,
    "source_high_watermark" BIGINT,
    "fenced_at" TIMESTAMP(3),
    "exported_at" TIMESTAMP(3),
    "activated_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "support_core_state_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "support_core_state_singleton_check" CHECK ("id" = 'singleton'),
    CONSTRAINT "support_core_state_counts_check" CHECK (
        "active_task_count" >= 0
        AND "generation" >= 0
        AND ("source_mapping_count" IS NULL OR "source_mapping_count" >= 0)
        AND ("source_high_watermark" IS NULL OR "source_high_watermark" >= 0)
    ),
    CONSTRAINT "support_core_state_hash_check" CHECK (
        ("source_fingerprint" IS NULL OR "source_fingerprint" ~ '^[0-9a-f]{64}$')
        AND ("source_snapshot_sha256" IS NULL OR "source_snapshot_sha256" ~ '^[0-9a-f]{64}$')
    ),
    CONSTRAINT "support_core_state_phase_check" CHECK (
        (
            "ownership" = 'CORE'
            AND "admission_enabled" = true
            AND "reconciler_enabled" = true
            AND "generation" = 0
            AND "ownership_revision" IS NULL
            AND "activated_at" IS NULL
        )
        OR (
            "ownership" = 'CORE'
            AND "admission_enabled" = false
            AND "reconciler_enabled" = false
            AND "generation" >= 1
            AND "prepared_revision" IS NOT NULL
            AND "prepared_revision" ~ '^[0-9a-f]{40}$'
            AND (
                "source_revision" IS NULL
                OR "source_revision" = "prepared_revision"
            )
            AND "ownership_revision" IS NULL
            AND "fenced_at" IS NOT NULL
            AND "activated_at" IS NULL
        )
        OR (
            "ownership" = 'SUPPORT'
            AND "admission_enabled" = false
            AND "reconciler_enabled" = false
            AND "active_task_count" = 0
            AND "generation" >= 1
            AND "prepared_revision" IS NOT NULL
            AND "prepared_revision" ~ '^[0-9a-f]{40}$'
            AND "source_revision" IS NOT NULL
            AND "source_revision" = "prepared_revision"
            AND "ownership_revision" IS NOT NULL
            AND "ownership_revision" = "source_revision"
            AND "source_database_system_id" IS NOT NULL
            AND "source_database_system_id" ~ '^[1-9][0-9]{0,31}$'
            AND "source_fingerprint" IS NOT NULL
            AND "source_fingerprint" ~ '^[0-9a-f]{64}$'
            AND "source_snapshot_sha256" IS NOT NULL
            AND "source_snapshot_sha256" ~ '^[0-9a-f]{64}$'
            AND "source_mapping_count" IS NOT NULL
            AND "source_mapping_count" >= 0
            AND "source_high_watermark" IS NOT NULL
            AND "source_high_watermark" >= 1
            AND "fenced_at" IS NOT NULL
            AND "exported_at" IS NOT NULL
            AND "exported_at" >= "fenced_at"
            AND "activated_at" IS NOT NULL
            AND "activated_at" >= "exported_at"
        )
    )
);

INSERT INTO "support_core_state" ("id", "updated_at")
VALUES ('singleton', CURRENT_TIMESTAMP);
