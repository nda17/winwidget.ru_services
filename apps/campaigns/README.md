# Campaigns service

Campaigns owns admin-created bulk campaigns, immutable audience snapshots,
per-recipient delivery state, retry state, and the PostgreSQL `campaigns`
schema. It publishes email/Telegram delivery requests through its
transactional Outbox; Notification Delivery performs the external sends.

## Process roles

`CAMPAIGNS_PROCESS_ROLE` accepts `all`, `api`, `worker`, or `publisher`.
`all` is convenient for a single process; production can split the same image
into independently restartable roles. Containers listen on
`CAMPAIGNS_HEALTH_PORT` (`4500` by default), and all expose:

- `GET /health/live`
- `GET /health/ready`

The public ADMIN contract is `/api/v1/admin/campaigns/**`. Operations reads
`GET /internal/v1/campaigns/messaging/overview` with
`x-winwidget-service: operations` and `CAMPAIGNS_OPERATIONS_TOKEN` over
loopback only.

## Dependencies

- Identity: bearer introspection and eligible-contact snapshots through
  `IDENTITY_INTERNAL_BASE_URL` / `IDENTITY_CAMPAIGNS_TOKEN`.
- Billing: active-subscriber audience snapshots through
  `BILLING_INTERNAL_BASE_URL` / `BILLING_CAMPAIGNS_TOKEN`.
- RabbitMQ: worker consumers and confirmed Outbox publication. Independent
  retry and dead-letter queues are retained per consumer.

Campaigns does not own SMTP or Telegram credentials. Rate variables throttle
delivery-request publication, not direct provider calls.

## Configuration and deployment

Keep the tracked `.env.example` beside an untracked `.env.production` in the
Campaigns directory on the VPS. Replace all `change_me` values and scope each
credential to this service.

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
docker build --build-arg APP_REVISION="$(git rev-parse HEAD)" -t winwidget-campaigns .
```

Integration tests require a disposable local PostgreSQL database and RabbitMQ
vhost plus `CAMPAIGNS_INTEGRATION_ALLOW_MUTATION=true`; never point them at
production.
