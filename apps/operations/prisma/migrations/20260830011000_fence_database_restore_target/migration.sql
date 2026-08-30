CREATE UNIQUE INDEX "database_restore_jobs_target_fence"
ON "operations"."database_restore_jobs"("target")
WHERE "status" IN ('QUEUED', 'PROCESSING', 'RECOVERY_REQUIRED');
