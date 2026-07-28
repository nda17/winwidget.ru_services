ALTER TABLE "widget_runtime_presence"
    ADD COLUMN "published_version" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "widget_runtime_daily_metrics"
    ADD COLUMN "published_version" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "completions" INTEGER NOT NULL DEFAULT 0;

DROP INDEX "widget_runtime_daily_metrics_widget_type_widget_id_date_key";
DROP INDEX "widget_runtime_daily_metrics_widget_type_widget_id_date_idx";

CREATE UNIQUE INDEX "widget_runtime_metric_unique"
    ON "widget_runtime_daily_metrics"("widget_type", "widget_id", "published_version", "date");

CREATE INDEX "widget_runtime_metric_lookup_idx"
    ON "widget_runtime_daily_metrics"("widget_type", "widget_id", "published_version", "date");

ALTER TABLE "widget_runtime_presence"
    ALTER COLUMN "published_version" DROP DEFAULT;

ALTER TABLE "widget_runtime_daily_metrics"
    ALTER COLUMN "published_version" DROP DEFAULT;

CREATE TABLE "widget_runtime_daily_step_metrics" (
    "id" TEXT NOT NULL,
    "widget_type" TEXT NOT NULL,
    "widget_id" TEXT NOT NULL,
    "published_version" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "step_key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "widget_runtime_daily_step_metrics_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "widget_runtime_step_metric_unique"
    ON "widget_runtime_daily_step_metrics"("widget_type", "widget_id", "published_version", "date", "step_key");

CREATE INDEX "widget_runtime_step_metric_lookup_idx"
    ON "widget_runtime_daily_step_metrics"("widget_type", "widget_id", "published_version", "date");
