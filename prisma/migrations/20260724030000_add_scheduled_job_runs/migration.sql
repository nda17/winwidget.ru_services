CREATE TYPE "ScheduledJobRunStatus" AS ENUM (
	'QUEUED',
	'PROCESSING',
	'SUCCEEDED',
	'FAILED',
	'CANCELLED',
	'SKIPPED'
);

CREATE TYPE "ScheduledJobRunTrigger" AS ENUM (
	'SCHEDULED',
	'MANUAL'
);

CREATE TABLE "scheduled_job_runs" (
	"id" UUID NOT NULL,
	"job_type" TEXT NOT NULL,
	"schedule_key" TEXT NOT NULL,
	"trigger" "ScheduledJobRunTrigger" NOT NULL DEFAULT 'SCHEDULED',
	"status" "ScheduledJobRunStatus" NOT NULL DEFAULT 'QUEUED',
	"scheduled_for" TIMESTAMP(3) NOT NULL,
	"period_start" TIMESTAMP(3),
	"period_end" TIMESTAMP(3),
	"input" JSONB NOT NULL DEFAULT '{}',
	"checkpoint" JSONB NOT NULL DEFAULT '{}',
	"result" JSONB,
	"attempts" INTEGER NOT NULL DEFAULT 0,
	"max_attempts" INTEGER NOT NULL DEFAULT 4,
	"available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"lease_owner" TEXT,
	"lease_token" UUID,
	"lease_expires_at" TIMESTAMP(3),
	"started_at" TIMESTAMP(3),
	"finished_at" TIMESTAMP(3),
	"last_error" TEXT,
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,

	CONSTRAINT "scheduled_job_runs_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "scheduled_job_runs_identity_check" CHECK (
		char_length(btrim("job_type")) BETWEEN 1 AND 255
		AND char_length(btrim("schedule_key")) BETWEEN 1 AND 255
		AND "job_type" = btrim("job_type")
		AND "schedule_key" = btrim("schedule_key")
	),
	CONSTRAINT "scheduled_job_runs_period_check" CHECK (
		(
			"period_start" IS NULL
			AND "period_end" IS NULL
		)
		OR (
			"period_start" IS NOT NULL
			AND "period_end" IS NOT NULL
			AND "period_end" > "period_start"
		)
	),
	CONSTRAINT "scheduled_job_runs_attempts_check" CHECK (
		"attempts" >= 0
		AND "max_attempts" > 0
	),
	CONSTRAINT "scheduled_job_runs_lease_check" CHECK (
		(
			"status" = 'PROCESSING'
			AND "lease_owner" IS NOT NULL
			AND "lease_token" IS NOT NULL
			AND "lease_expires_at" IS NOT NULL
		)
		OR (
			"status" <> 'PROCESSING'
			AND "lease_owner" IS NULL
			AND "lease_token" IS NULL
			AND "lease_expires_at" IS NULL
		)
	),
	CONSTRAINT "scheduled_job_runs_finished_check" CHECK (
		(
			"status" IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'SKIPPED')
			AND "finished_at" IS NOT NULL
		)
		OR (
			"status" IN ('QUEUED', 'PROCESSING')
			AND "finished_at" IS NULL
		)
	)
);

CREATE UNIQUE INDEX "scheduled_job_runs_type_schedule_key_unique"
	ON "scheduled_job_runs"("job_type", "schedule_key");

CREATE INDEX "scheduled_job_runs_dispatch_idx"
	ON "scheduled_job_runs"("status", "available_at", "created_at");

CREATE INDEX "scheduled_job_runs_lease_idx"
	ON "scheduled_job_runs"("status", "lease_expires_at");

CREATE INDEX "scheduled_job_runs_type_created_idx"
	ON "scheduled_job_runs"("job_type", "created_at");

CREATE TABLE "scheduled_job_idempotency_keys" (
	"admin_id" TEXT NOT NULL,
	"job_type" TEXT NOT NULL,
	"idempotency_key" UUID NOT NULL,
	"job_id" UUID NOT NULL,
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

	CONSTRAINT "scheduled_job_idempotency_keys_pkey"
		PRIMARY KEY ("admin_id", "job_type", "idempotency_key"),
	CONSTRAINT "scheduled_job_idempotency_keys_identity_check" CHECK (
		char_length(btrim("admin_id")) BETWEEN 1 AND 255
		AND char_length(btrim("job_type")) BETWEEN 1 AND 255
		AND "admin_id" = btrim("admin_id")
		AND "job_type" = btrim("job_type")
	),
	CONSTRAINT "scheduled_job_idempotency_keys_job_fkey"
		FOREIGN KEY ("job_id")
		REFERENCES "scheduled_job_runs"("id")
		ON DELETE RESTRICT
		ON UPDATE CASCADE
);

CREATE INDEX "scheduled_job_idempotency_keys_job_idx"
	ON "scheduled_job_idempotency_keys"("job_id");
