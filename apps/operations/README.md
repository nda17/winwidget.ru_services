# Operations service

Operations owns the WinWidget operational control plane after the direct Core
cutover. It does not read Core at runtime and does not implement dual-read,
legacy routes, or historical job migration.

## Responsibilities

- Notes and the aggregated admin event log.
- Admin alerts federated from Billing and Widgets plus Operations-owned alerts.
- Messaging overview, failures, retry, and close federation.
- Telegram operational settings and database backup administration.
- Durable daily/manual backup jobs executed only by the maintenance worker.
- DEV-only database restore control and execution.
- Reporting schedule-policy reservation and confirmation.
- Operations Outbox, delivery receipts, heartbeats, and role-aware health.

All PostgreSQL-dependent publications are written to `OutboxEvent` in the same
transaction as their state change. Workers consume RabbitMQ through
`basic.consume`; durable jobs are claimed with PostgreSQL CAS leases.

## Process roles

The same image is started once for every role:

| `OPERATIONS_PROCESS_ROLE` | Default port | Responsibility                                                   |
| ------------------------- | -----------: | ---------------------------------------------------------------- |
| `api`                     |         5200 | Public/admin/internal HTTP contracts and restore enqueue         |
| `worker`                  |         5201 | Audit consumers, scheduler, and read-only database backup jobs   |
| `outbox-publisher`        |         5202 | Transactional Outbox publication with confirms/mandatory returns |
| `restore-worker`          |         5203 | Privileged database restore execution only                       |

Only `api` registers business controllers. Every role exposes `/health/live`
and `/health/ready`; API additionally owns `/api/v1/health/deployment` and the
ADMIN-only `/api/v1/health/admin`.

## HTTP contracts

Public routes keep the existing Gateway paths under `/api/v1`:

- `GET /admin-alerts`
- `GET /messaging/admin/overview`
- `GET /messaging/admin/failures`
- `POST /messaging/admin/failures/:id/retry`
- `POST /messaging/admin/failures/:id/close`
- `GET|PATCH /telegram-bot/admin/settings`
- `POST /telegram-bot/admin/database-backups/:target/send`
- `GET /telegram-bot/admin/database-backups/overview`
- `GET /telegram-bot/admin/database-backups/jobs`
- `GET /telegram-bot/admin/database-backups/:target/jobs/active`
- `GET /telegram-bot/admin/database-backups/:target/jobs/:jobId`
- `/dev-tools/database-restores/*` for DEV users only

Unprefixed internal routes:

- `GET /internal/v1/identity/users/:userId/admin-events/overview`
- `PUT /internal/v1/operations/reporting/schedule-policy`
- `POST /internal/v1/operations/reporting/schedule-policy/confirm`

Federation always sends `x-winwidget-service: operations` and a dedicated
`*_OPERATIONS_TOKEN`. Billing uses
`/internal/v1/operations/billing/*`; Widgets uses
`/api/v1/internal/v1/operations/widgets/*`. Service URLs must be exact private
HTTP origins without embedded paths or credentials.

## RabbitMQ contracts

Operations publishes to `winwidget.events`:

- `operations.scheduled-job.requested.v1`
- `operations.database-restore.requested.v1`
- `operations.notification-routing.changed.v1`

The new job queue families are:

- `winwidget.operations.scheduled-jobs.v1`, `.retry-v1`, `.dead-letter`
- `winwidget.operations.database-restore.v1`, `.retry-v1`, `.dead-letter`

The notification-routing payload is exactly
`{ schemaVersion: 1, eventId, operationalAlertsThreadId, changedAt }`, with
aggregate type `telegram-bot-settings` and aggregate ID `singleton`.

## Configuration and database

Copy `.env.example` to the per-service `.env.production` on the VPS and fill it
with deployment secrets. `.env.production` is ignored by Git. Keep only the
variables needed by Operations; do not reuse Core tokens.

Operations uses one global `OperationsPrismaModule` and one Prisma client pool
per process. Apply migrations before starting the new revision:

```bash
pnpm prisma:generate
pnpm prisma:migrate:deploy
```

The runtime image pins PostgreSQL 18 `pg_dump`, `pg_restore`, and `psql`; its
Docker build fails if the dump/restore major drifts. Backup URLs must use
read-only backup roles and are provided only to the regular worker. Database
restore has no admin URL contract: only `restore-worker` receives each exact
`*_POSTGRES_ADMIN_USER`, `*_POSTGRES_PORT`, and
`DATABASE_RESTORE_*_ADMIN_PASSWORD_FILE`. The host is fixed to `127.0.0.1`
and every database name is hardcoded by target. Password files are existing
Docker secrets mounted read-only below `/run/secrets`; neither API nor the
regular worker receives them.

The API writes uploaded dumps and `restore-worker` consumes them, so only those
two containers mount the same private persistent
`DATABASE_RESTORE_STORAGE_DIR` read-write (owned by runtime UID 1001). Restore
enqueue is disabled unless `DATABASE_RESTORE_ENABLED=true` on API. The isolated
worker uses `RABBITMQ_CONNECTION_NAME=winwidget-operations-restore-worker` and
consumes only the `winwidget.operations.database-restore.v1` queue family.

Telegram production traffic keeps the established encrypted proxy contract:
`TELEGRAM_API_BASE_URL=https://tg.winwidget.ru/telegram-api`. Only
`operations-worker`, which sends backups, receives the bot token and proxy host
mapping. `operations-api` receives only the non-secret
`TELEGRAM_INFO_BOT_CONFIGURED=true` status flag and the public bot username.

## One-time direct-cutover bootstrap

Before Core is stopped, export only the current Telegram settings singleton and
the current Reporting schedule-policy anchor into the strict schema accepted by
`parseControlPlaneSnapshot`. No history or queued jobs are imported. After the
Operations ownership row is `ACTIVE`, run the compiled CLI with an immutable
file and its independently calculated SHA-256:

```json
{
	"schemaVersion": 1,
	"sourceRevision": "<40 lowercase git hex>",
	"createdAt": "<ISO-8601>",
	"telegramBotSettings": {
		"dailySummaryChatId": "<current value>",
		"databaseBackupThreadId": null,
		"paymentsThreadId": null,
		"operationalAlertsThreadId": null,
		"databaseBackupEnabled": false,
		"databaseBackupTime": "01:45",
		"databaseBackupLastSentPeriodStart": null,
		"databaseBackupLastSentAt": null
	},
	"reportingSchedulePolicy": {
		"reservationTime": "01:50",
		"reservationGeneration": "0",
		"confirmedChangeId": null,
		"pendingChangeId": null,
		"pendingTime": null,
		"pendingGeneration": null
	}
}
```

Use current Core values in every field; the example is a shape contract, not a
source of production defaults. The importer rejects extra fields, partial
pending reservations, inconsistent Telegram settings, schedule collisions,
and any non-pristine target.

```bash
pnpm control-plane:bootstrap -- --file /absolute/path/control-plane.json --sha256 <hex>
```

The command is atomic, requires a pristine target, and is idempotent only for
the same source revision and hash. Runtime code never reads Core afterward.

## Verification

```bash
pnpm prisma:generate
OPERATIONS_DATABASE_URL=postgresql://operations:operations@127.0.0.1:5432/operations pnpm prisma:validate
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```
