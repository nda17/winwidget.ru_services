CREATE TYPE "OutboxEventStatus" AS ENUM (
	'PENDING',
	'PUBLISHING',
	'PUBLISHED',
	'FAILED'
);

CREATE TABLE "outbox_events" (
	"id" UUID NOT NULL,
	"event_type" TEXT NOT NULL,
	"routing_key" TEXT NOT NULL,
	"payload" JSONB NOT NULL,
	"status" "OutboxEventStatus" NOT NULL DEFAULT 'PENDING',
	"attempts" INTEGER NOT NULL DEFAULT 0,
	"available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"locked_at" TIMESTAMP(3),
	"locked_by" TEXT,
	"published_at" TIMESTAMP(3),
	"last_error" TEXT,
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,

	CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "outbox_events_dispatch_idx"
	ON "outbox_events"("status", "available_at", "created_at");

CREATE INDEX "outbox_events_locked_at_idx"
	ON "outbox_events"("locked_at");

CREATE INDEX "outbox_events_published_at_idx"
	ON "outbox_events"("published_at");
