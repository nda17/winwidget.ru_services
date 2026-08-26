# Billing service

Billing owns payments, subscriptions, tariff prices, affiliate state, billing
settings, renewal scheduling, and its PostgreSQL `billing` schema. Critical
payment/subscription state changes stay synchronous in PostgreSQL; dependent
events are created through the transactional Outbox.

## Process roles

| `BILLING_PROCESS_ROLE` | Default port | Responsibility                                  |
| ---------------------- | -----------: | ----------------------------------------------- |
| `api`                  |         4800 | Public Billing API and private HTTP contracts   |
| `scheduler`            |         4801 | Expiry, cleanup, and auto-renewal schedules     |
| `worker`               |         4802 | Idempotent RabbitMQ consumers and provider work |
| `outbox-publisher`     |         4803 | Confirmed/mandatory Outbox publication          |

Every role exposes `GET /health/live` and `GET /health/ready`. Only `api`
registers business controllers.

## HTTP and service boundaries

Public routes live under `/api/v1` and include `/payments`, `/subscriptions`,
`/tariff-prices`, `/affiliate`, and `/billing-settings`. YooKassa webhooks are
handled at `POST /api/v1/payments/webhook`.

Private routes are unprefixed by the public Gateway:

- Identity calls `/internal/v1/identity/billing/**` with
  `BILLING_IDENTITY_TOKEN`.
- Campaigns calls `/internal/v1/billing/campaigns/active-subscriber-ids` with
  `BILLING_CAMPAIGNS_TOKEN`.
- Operations calls `/internal/v1/operations/billing/admin-alerts` and
  `/internal/v1/operations/billing/messaging/**` with
  `BILLING_OPERATIONS_TOKEN`; caller and socket must both be local.
- Billing calls Identity introspection with `IDENTITY_BILLING_TOKEN` and the
  Widgets private API with `WIDGETS_INTERNAL_TOKEN`.

The API never performs asynchronous payment state transitions through
RabbitMQ. Provider credentials and `PAYMENT_METHOD_ENCRYPTION_KEY` must be
available only to roles that use them.

## Configuration and deployment

Copy `.env.example` to `.env.production` inside the Billing directory on the
VPS. `.env.production` is ignored by Git. Use distinct restricted database,
RabbitMQ, and internal credentials; never reuse an Identity or Operations
token in another direction.

Apply migrations before starting the new revision, then start one container
per role from the same immutable image:

```bash
pnpm install --frozen-lockfile
pnpm run prisma:generate
pnpm run prisma:validate
pnpm run prisma:migrate:deploy
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run build
docker build --build-arg APP_REVISION="$(git rev-parse HEAD)" -t winwidget-billing .
```

For `worker` and `outbox-publisher`, set
`RABBITMQ_CONNECTION_NAME=winwidget-billing-<role>`. The worker normally owns
topology assertion; the publisher can run with restricted publish-only ACLs.
