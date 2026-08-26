# Reporting service

Reporting owns aggregate analytics, Daily Summary settings/runs, its PostgreSQL
schema, projections, transactional Outbox, retry/DLQ state, and delivery
outcomes. It has no HTTP or snapshot dependency on the retired Core runtime.

## Runtime boundaries

- Identity authorization is fail-closed through
  `POST /internal/v1/auth/introspect` on `IDENTITY_INTERNAL_BASE_URL`.
- Daily Summary schedule changes reserve and confirm the backup-policy fence in
  Operations:
  - `PUT /internal/v1/operations/reporting/schedule-policy`
  - `POST /internal/v1/operations/reporting/schedule-policy/confirm`
- Operations notification routing is consumed from
  `operations.notification-routing.changed.v1` on `winwidget.events`.
  Reporting stores the latest `changedAt` watermark so a delayed retry cannot
  overwrite newer routing.
- Live Identity, Billing, and Widgets changes arrive through independent
  RabbitMQ queues. Reporting publishes Daily Summary delivery requests and
  admin audit events through its transactional Outbox.

Legacy Core snapshot backfill and shadow-evidence roles are intentionally
removed. Historical snapshot replay and compatibility aliases are not part of
the steady-state service.

## Process roles

`REPORTING_PROCESS_ROLE` accepts only:

- `all`
- `api`
- `worker`
- `publisher`
- `scheduler`

The single-VPS production deployment currently uses `all`. Set
`REPORTING_SCHEDULER_ENABLED=true` only for the process that owns scheduled
Daily Summary runs.

## RabbitMQ hard cutover

The durable queue `winwidget.reporting.settings` keeps its name, but its only
source binding is now `operations.notification-routing.changed.v1`. Remove the
retired Core binding during cutover. Recreate
`winwidget.reporting.settings.retry.1`, `.retry.2`, and `.retry.3` because their
immutable dead-letter routing key changes to the Operations event. Historical
messages on those retired routes are intentionally not replayed.

## Configuration

Copy `.env.example` to an ignored `.env.production` on the target VPS and set
real secrets there. Never commit `.env.production`.

Required service credentials:

- `REPORTING_DATABASE_URL` — Reporting PostgreSQL role/database/schema.
- `REPORTING_INTERNAL_TOKEN` — dedicated outbound credential for Reporting →
  Operations schedule-policy calls; at least 32 non-placeholder characters.
- `REPORTING_OPERATIONS_TOKEN` — dedicated inbound credential for Operations →
  Reporting monitoring calls; at least 32 non-placeholder characters.
- `IDENTITY_REPORTING_TOKEN` — dedicated Reporting credential for Identity
  introspection; at least 32 non-placeholder characters.
- `RABBITMQ_URL` — restricted Reporting RabbitMQ user for worker/publisher
  roles.

`OPERATIONS_INTERNAL_BASE_URL` defaults to `http://127.0.0.1:5200` and
`IDENTITY_INTERNAL_BASE_URL` defaults to `http://127.0.0.1:4900`. Both clients
reject non-loopback origins.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm run prisma:generate
pnpm run prisma:validate
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run build
```

Integration tests require isolated local PostgreSQL and RabbitMQ credentials:

```bash
REPORTING_TEST_DATABASE_URL=postgresql://... \
REPORTING_TEST_MIGRATION_DATABASE_URL=postgresql://... \
REPORTING_TEST_RABBITMQ_URL=amqp://... \
REPORTING_TEST_RABBITMQ_ADMIN_URL=amqp://... \
REPORTING_INTEGRATION_ALLOW_MUTATION=true \
pnpm run test:integration
```

The integration database and RabbitMQ vhost must be disposable and local.

## HTTP

- `GET /health/live`
- `GET /health/ready`
- `GET /metrics`
- `/api/v1/admin/reporting/**` — authenticated admin API via direct Identity
  introspection.
- `GET /internal/v1/reporting/messaging/overview` — loopback-only Operations
  monitoring endpoint authenticated with `REPORTING_OPERATIONS_TOKEN` and
  `x-winwidget-service: operations`.
