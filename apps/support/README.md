# Support service

Support owns the operator chat, Telegram Support-bot webhook, routing settings,
delivery retry/failure state, and the PostgreSQL `support` schema. It is
independent from Core and has no dual-read or legacy write path.

## Process roles

| `SUPPORT_PROCESS_ROLE` | Default port | Responsibility                                           |
| ---------------------- | -----------: | -------------------------------------------------------- |
| `api`                  |         5100 | Webhook admission, admin settings, and public/admin HTTP |
| `worker`               |         5101 | Idempotent webhook processing and Telegram delivery      |
| `outbox-publisher`     |         5102 | Confirmed/mandatory Outbox publication                   |

Every role exposes `GET /health/live` and `GET /health/ready`. The API owns:

- `POST /api/v1/telegram-bot/support-webhook`
- `/api/v1/support/admin/webhook/**`
- `/api/v1/support/admin/routing-settings`
- `/api/v1/support/admin/messaging/failures/**`

Operations reads `GET /internal/v1/support/messaging/overview` over loopback
with `x-winwidget-service: operations` and `SUPPORT_OPERATIONS_TOKEN`. Support
authorizes admin users through Identity with `IDENTITY_SUPPORT_TOKEN`.

## Telegram and RabbitMQ

Production Telegram calls use the existing public TLS reverse proxy:

```dotenv
TELEGRAM_API_BASE_URL=https://tg.winwidget.ru/telegram-api
TELEGRAM_API_PROXY_IP=185.184.122.62
```

The API admits a webhook only after checking Telegram's secret header and
durably storing the raw update plus its Outbox event. The worker claims
PostgreSQL leases before external calls and acks RabbitMQ only after durable
completion. Manual retry/close remains transactional.

The `outbox-publisher` container must not receive Telegram, webhook, proxy, or
Identity credentials; Compose should pass those only to `api`/`worker` as
required. For RabbitMQ roles, the connection name must be exactly
`winwidget-support-<role>`.

## Configuration and deployment

Keep `.env.example` tracked and `.env.production` ignored beside this service
on the VPS. Replace all placeholders with distinct scoped secrets. Apply the
Support migration with a separate migration role before starting runtime
containers.

```bash
pnpm install --frozen-lockfile
pnpm run prisma:generate
pnpm run prisma:validate
pnpm run prisma:migrate:deploy
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run build
docker build --build-arg APP_REVISION="$(git rev-parse HEAD)" -t winwidget-support .
```

After deployment verify all role readiness and webhook status. A controlled
operator-chat message should use an explicit test target; do not send an
unsolicited production message.
