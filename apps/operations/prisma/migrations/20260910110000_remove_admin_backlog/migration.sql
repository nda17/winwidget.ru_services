-- The owner explicitly removed the administration Backlog and its data.
-- Rollout requires a service-owned safety backup and a drained old Notes writer.
-- Run only as the Operations migration role, never through the runtime API.
-- Do not CASCADE, touch CRM customer notes, or remove unrelated audit evidence.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

LOCK TABLE "operations"."notes" IN ACCESS EXCLUSIVE MODE;

DELETE FROM "operations"."admin_event_logs"
WHERE "section" = 'BACKLOG'
   OR "entity_type" = 'backlog_task'
   OR "action" IN (
       'BACKLOG_TASK_CREATE',
       'BACKLOG_TASK_UPDATE',
       'BACKLOG_TASK_DELETE'
   );

DROP TABLE "operations"."notes" RESTRICT;
COMMIT;
