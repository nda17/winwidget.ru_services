-- Keep the published snapshot, draft copy, and initial revision consistent
-- while the previous application version may still be running.
BEGIN;

ALTER TABLE "widgets"
    ADD COLUMN "draft_config" JSONB,
    ADD COLUMN "draft_install_domain" TEXT,
    ADD COLUMN "draft_revision" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "published_version" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "published_from_draft_revision" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "published_at" TIMESTAMP(3);

ALTER TABLE "quizzes"
    ADD COLUMN "draft_config" JSONB,
    ADD COLUMN "draft_install_domain" TEXT,
    ADD COLUMN "draft_revision" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "published_version" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "published_from_draft_revision" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "published_at" TIMESTAMP(3);

ALTER TABLE "callbacks"
    ADD COLUMN "draft_config" JSONB,
    ADD COLUMN "draft_install_domain" TEXT,
    ADD COLUMN "draft_revision" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "published_version" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "published_from_draft_revision" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "published_at" TIMESTAMP(3);

ALTER TABLE "countdown_timers"
    ADD COLUMN "draft_config" JSONB,
    ADD COLUMN "draft_install_domain" TEXT,
    ADD COLUMN "draft_revision" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "published_version" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "published_from_draft_revision" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "published_at" TIMESTAMP(3);

ALTER TABLE "stop_offers"
    ADD COLUMN "draft_config" JSONB,
    ADD COLUMN "draft_install_domain" TEXT,
    ADD COLUMN "draft_revision" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "published_version" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "published_from_draft_revision" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "published_at" TIMESTAMP(3);

ALTER TABLE "online_consultants"
    ADD COLUMN "draft_config" JSONB,
    ADD COLUMN "draft_install_domain" TEXT,
    ADD COLUMN "draft_revision" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "published_version" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "published_from_draft_revision" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "published_at" TIMESTAMP(3);

ALTER TABLE "calculators"
    ADD COLUMN "draft_config" JSONB,
    ADD COLUMN "draft_install_domain" TEXT,
    ADD COLUMN "draft_revision" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "published_version" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "published_from_draft_revision" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "published_at" TIMESTAMP(3);

CREATE TABLE "widget_config_revisions" (
    "id" TEXT NOT NULL,
    "widget_type" TEXT NOT NULL,
    "widget_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "config" JSONB NOT NULL,
    "install_domain" TEXT NOT NULL,
    "source_version" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "widget_config_revisions_pkey" PRIMARY KEY ("id")
);

UPDATE "widgets"
SET
    "draft_config" = "config",
    "draft_install_domain" = "install_domain",
    "draft_revision" = 1,
    "published_version" = 1,
    "published_from_draft_revision" = 1,
    "published_at" = "updated_at";

UPDATE "quizzes"
SET
    "draft_config" = "config",
    "draft_install_domain" = "install_domain",
    "draft_revision" = 1,
    "published_version" = 1,
    "published_from_draft_revision" = 1,
    "published_at" = "updated_at";

UPDATE "callbacks"
SET
    "draft_config" = "config",
    "draft_install_domain" = "install_domain",
    "draft_revision" = 1,
    "published_version" = 1,
    "published_from_draft_revision" = 1,
    "published_at" = "updated_at";

UPDATE "countdown_timers"
SET
    "draft_config" = "config",
    "draft_install_domain" = "install_domain",
    "draft_revision" = 1,
    "published_version" = 1,
    "published_from_draft_revision" = 1,
    "published_at" = "updated_at";

UPDATE "stop_offers"
SET
    "draft_config" = "config",
    "draft_install_domain" = "install_domain",
    "draft_revision" = 1,
    "published_version" = 1,
    "published_from_draft_revision" = 1,
    "published_at" = "updated_at";

UPDATE "online_consultants"
SET
    "draft_config" = "config",
    "draft_install_domain" = "install_domain",
    "draft_revision" = 1,
    "published_version" = 1,
    "published_from_draft_revision" = 1,
    "published_at" = "updated_at";

UPDATE "calculators"
SET
    "draft_config" = "config",
    "draft_install_domain" = "install_domain",
    "draft_revision" = 1,
    "published_version" = 1,
    "published_from_draft_revision" = 1,
    "published_at" = "updated_at";

INSERT INTO "widget_config_revisions" (
    "id",
    "widget_type",
    "widget_id",
    "version",
    "config",
    "install_domain",
    "created_at"
)
SELECT
    'revision:WHEEL:' || "id" || ':1',
    'WHEEL',
    "id",
    1,
    "config",
    "install_domain",
    "updated_at"
FROM "widgets";

INSERT INTO "widget_config_revisions" (
    "id",
    "widget_type",
    "widget_id",
    "version",
    "config",
    "install_domain",
    "created_at"
)
SELECT
    'revision:QUIZ:' || "id" || ':1',
    'QUIZ',
    "id",
    1,
    "config",
    "install_domain",
    "updated_at"
FROM "quizzes";

INSERT INTO "widget_config_revisions" (
    "id",
    "widget_type",
    "widget_id",
    "version",
    "config",
    "install_domain",
    "created_at"
)
SELECT
    'revision:CALLBACK:' || "id" || ':1',
    'CALLBACK',
    "id",
    1,
    "config",
    "install_domain",
    "updated_at"
FROM "callbacks";

INSERT INTO "widget_config_revisions" (
    "id",
    "widget_type",
    "widget_id",
    "version",
    "config",
    "install_domain",
    "created_at"
)
SELECT
    'revision:TIMER:' || "id" || ':1',
    'TIMER',
    "id",
    1,
    "config",
    "install_domain",
    "updated_at"
FROM "countdown_timers";

INSERT INTO "widget_config_revisions" (
    "id",
    "widget_type",
    "widget_id",
    "version",
    "config",
    "install_domain",
    "created_at"
)
SELECT
    'revision:STOP_OFFER:' || "id" || ':1',
    'STOP_OFFER',
    "id",
    1,
    "config",
    "install_domain",
    "updated_at"
FROM "stop_offers";

INSERT INTO "widget_config_revisions" (
    "id",
    "widget_type",
    "widget_id",
    "version",
    "config",
    "install_domain",
    "created_at"
)
SELECT
    'revision:ONLINE_CONSULTANT:' || "id" || ':1',
    'ONLINE_CONSULTANT',
    "id",
    1,
    "config",
    "install_domain",
    "updated_at"
FROM "online_consultants";

INSERT INTO "widget_config_revisions" (
    "id",
    "widget_type",
    "widget_id",
    "version",
    "config",
    "install_domain",
    "created_at"
)
SELECT
    'revision:CALCULATOR:' || "id" || ':1',
    'CALCULATOR',
    "id",
    1,
    "config",
    "install_domain",
    "updated_at"
FROM "calculators";

CREATE UNIQUE INDEX "widget_config_revisions_widget_type_widget_id_version_key"
    ON "widget_config_revisions"("widget_type", "widget_id", "version");

CREATE INDEX "widget_config_revisions_widget_type_widget_id_created_at_idx"
    ON "widget_config_revisions"("widget_type", "widget_id", "created_at");

COMMIT;
