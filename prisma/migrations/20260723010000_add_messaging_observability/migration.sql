CREATE TABLE "messaging_heartbeats" (
	"id" UUID NOT NULL,
	"service" TEXT NOT NULL,
	"instance_id" TEXT NOT NULL,
	"metadata" JSONB NOT NULL DEFAULT '{}',
	"last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,

	CONSTRAINT "messaging_heartbeats_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "integration_delivery_failures" (
	"id" UUID NOT NULL,
	"event_id" UUID NOT NULL,
	"integration" TEXT NOT NULL,
	"routing_key" TEXT NOT NULL,
	"payload" JSONB NOT NULL,
	"attempts" INTEGER NOT NULL,
	"last_error" TEXT NOT NULL,
	"failed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"retrying_at" TIMESTAMP(3),
	"resolved_at" TIMESTAMP(3),
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,

	CONSTRAINT "integration_delivery_failures_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "messaging_heartbeats_service_instance_unique"
	ON "messaging_heartbeats"("service", "instance_id");

CREATE INDEX "messaging_heartbeats_service_seen_idx"
	ON "messaging_heartbeats"("service", "last_seen_at");

CREATE INDEX "messaging_heartbeats_seen_idx"
	ON "messaging_heartbeats"("last_seen_at");

CREATE UNIQUE INDEX "integration_delivery_failures_event_id_key"
	ON "integration_delivery_failures"("event_id");

CREATE INDEX "integration_delivery_failures_status_idx"
	ON "integration_delivery_failures"("resolved_at", "failed_at");

CREATE INDEX "integration_delivery_failures_integration_idx"
	ON "integration_delivery_failures"("integration", "resolved_at");
