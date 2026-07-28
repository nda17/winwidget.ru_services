ALTER TABLE "scheduled_job_runs"
	DROP CONSTRAINT "scheduled_job_runs_lease_check";

ALTER TABLE "scheduled_job_runs"
	ADD CONSTRAINT "scheduled_job_runs_lease_check" CHECK (
		(
			"status" = 'PROCESSING'
			AND (
				(
					"lease_owner" IS NOT NULL
					AND "lease_token" IS NOT NULL
					AND "lease_expires_at" IS NOT NULL
				)
				OR (
					"lease_owner" IS NULL
					AND "lease_token" IS NULL
					AND "lease_expires_at" IS NULL
					AND "checkpoint" IS NOT NULL
					AND jsonb_typeof("checkpoint") = 'object'
					AND NULLIF("checkpoint" ->> 'deliveryEventId', '') IS NOT NULL
				)
			)
		)
		OR (
			"status" <> 'PROCESSING'
			AND "lease_owner" IS NULL
			AND "lease_token" IS NULL
			AND "lease_expires_at" IS NULL
		)
	);
