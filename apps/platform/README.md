# Platform service

Platform owns editable site settings, legal pages, home-page content, raw
home-page code, the related admin-audit events, and the PostgreSQL `platform`
schema. It has no steady-state Core database dependency.

## Process roles

| `PLATFORM_PROCESS_ROLE` | Default port | Responsibility                                  |
| ----------------------- | -----------: | ----------------------------------------------- |
| `api`                   |         5000 | Public/admin content API and private monitoring |
| `outbox-publisher`      |         5001 | Confirmed/mandatory Outbox publication          |

Every role exposes `GET /health/live` and `GET /health/ready`; only `api`
registers business controllers.

Public Gateway routes are:

- `/api/v1/site-settings`
- `/api/v1/legal-pages/**`
- `/api/v1/home-page-content` and `/api/v1/home-page-content/raw-code`

Platform authorizes users through Identity introspection with
`IDENTITY_PLATFORM_TOKEN`. Operations reads
`GET /internal/v1/platform/messaging/overview` over loopback with
`x-winwidget-service: operations` and `PLATFORM_OPERATIONS_TOKEN`.

All content changes and admin actions that require publication are written to
the Platform Outbox in the same PostgreSQL transaction. Only the
`outbox-publisher` role connects to RabbitMQ.

## Configuration and deployment

Copy `.env.example` to an ignored `.env.production` in this service directory
on the VPS. Replace every placeholder with a scoped value. Do not add retired
Core URLs or tokens to the steady runtime.

```bash
pnpm install --frozen-lockfile
pnpm run prisma:generate
pnpm run prisma:validate
pnpm run prisma:migrate:deploy
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run build
docker build --build-arg APP_REVISION="$(git rev-parse HEAD)" -t winwidget-platform .
```

Start `api` and `outbox-publisher` from the same revision and verify both
readiness endpoints before enabling the Platform Gateway routes.
