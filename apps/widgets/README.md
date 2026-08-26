# Widgets service

Widgets owns widget definitions, draft/published versions, leads, telemetry,
delivery failures, Identity/Billing projections, button images, and the
PostgreSQL `widgets` schema. Widget browser assets are also built and packaged
inside this service from `widgets-src/`.

## Process roles

`WIDGETS_PROCESS_ROLE` accepts `all`, `api`, `worker`, or `publisher`:

- `api` serves HTTP and compiled assets on port `4700`.
- `worker` consumes Identity, entitlement, webhook, Bitrix24, and amoCRM
  queues with independent retry/DLQ state.
- `publisher` publishes the transactional Outbox with confirms and mandatory
  returns.
- `all` runs all responsibilities in one process.

Every role exposes `GET /health/live` and `GET /health/ready`. Containers use
the same internal port because each has its own network namespace; only the API
should be exposed to Gateway/Nginx.

## HTTP and internal contracts

Public and authenticated routes under `/api/v1` include:

- widget collections (`/widgets`, `/quizzes`, `/callbacks`,
  `/countdown-timers`, `/stop-offers`, `/online-consultants`, `/calculators`)
- `/widget-settings/**`, `/widgets/admin/**`, and delivery-failure controls
- public widget configuration/lead endpoints and `/widget-events/**`

Compiled assets are served at `/widgets/**`. Identity calls
`/internal/v1/identity/widgets/admin-owner-overview` with
`WIDGETS_IDENTITY_TOKEN`. Operations calls
`/api/v1/internal/v1/operations/widgets/**` with
`WIDGETS_OPERATIONS_TOKEN` for alerts, messaging overview, and failure
controls. Widgets calls Identity with `IDENTITY_WIDGETS_TOKEN`.

The older generic internal surface still uses `WIDGETS_INTERNAL_TOKEN`; do not
reuse that credential for Identity or Operations.

## Assets and storage

```bash
pnpm run build:widgets
pnpm run build:widgets:check
```

These commands compile `widgets-src/` into `public/widgets/`; generated output
is ignored by Git and copied into the image. In production, button images use
the configured S3 bucket. `WIDGETS_UPLOADS_DIR` is a local-development fallback
only.

## Configuration and deployment

Copy `.env.example` to the ignored `.env.production` beside this service on
the VPS. Replace all placeholders and pass only the variables required by each
role. The entitlement staleness bound is mandatory and must remain within the
validated range.

```bash
pnpm install --frozen-lockfile
pnpm run prisma:generate
pnpm run prisma:validate
pnpm run prisma:migrate:deploy
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run build
pnpm run test:integration
```

The Widgets Dockerfile requires the repository root as build context:

```bash
docker build -f apps/widgets/Dockerfile \
  --build-arg APP_REVISION="$(git rev-parse HEAD)" \
  -t winwidget-widgets .
```
