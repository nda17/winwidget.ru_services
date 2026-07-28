CREATE TABLE "widget_runtime_presence" (
    "id" TEXT NOT NULL,
    "widget_type" TEXT NOT NULL,
    "widget_id" TEXT NOT NULL,
    "install_domain" TEXT NOT NULL,
    "runtime_version" TEXT NOT NULL,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "widget_runtime_presence_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "widget_runtime_daily_metrics" (
    "id" TEXT NOT NULL,
    "widget_type" TEXT NOT NULL,
    "widget_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "opens" INTEGER NOT NULL DEFAULT 0,
    "starts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "widget_runtime_daily_metrics_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "widget_runtime_presence_widget_type_widget_id_key"
    ON "widget_runtime_presence"("widget_type", "widget_id");

CREATE INDEX "widget_runtime_presence_last_seen_at_idx"
    ON "widget_runtime_presence"("last_seen_at");

CREATE UNIQUE INDEX "widget_runtime_daily_metrics_widget_type_widget_id_date_key"
    ON "widget_runtime_daily_metrics"("widget_type", "widget_id", "date");

CREATE INDEX "widget_runtime_daily_metrics_widget_type_widget_id_date_idx"
    ON "widget_runtime_daily_metrics"("widget_type", "widget_id", "date");
