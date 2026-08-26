# Notification Delivery service

Notification Delivery is the sole transport worker for WinWidget email and
informational Telegram messages. It owns delivery receipts, retry/failure
state, delivery outcomes, its transactional Outbox, and the PostgreSQL
`notification_delivery` schema. Domain services publish requests; they do not
receive SMTP or Info-bot credentials.

## Runtime

The service currently runs worker consumers, its Outbox publisher, retention,
and the private control API in one process. It listens only on
`127.0.0.1:4401` by default and exposes:

- `GET /health/live`
- `GET /health/ready`
- `GET /internal/notification-delivery/overview`
- `GET /internal/notification-delivery/failures[/:id]`
- `POST /internal/notification-delivery/failures/:id/retry`
- `POST /internal/notification-delivery/failures/:id/close`

Control endpoints accept only a loopback caller with
`x-winwidget-service: operations` and
`NOTIFICATION_DELIVERY_OPERATIONS_TOKEN`.

## Messaging and providers

Each delivery kind has an independent RabbitMQ queue, retry route, and DLQ.
Consumers claim `eventId + consumer` receipts before external calls, ack only
after durable success, and publish outcomes through the local Outbox.

`NOTIFICATION_DELIVERY_KINDS` can narrow the consumers owned by a process. The
full supported set is recorded in `.env.example`. SMTP configuration is shared
by email kinds; `TELEGRAM_INFO_BOT_TOKEN` belongs only here. Production
Telegram traffic must use
`TELEGRAM_API_BASE_URL=https://tg.winwidget.ru/telegram-api`.

## Configuration and deployment

Copy `.env.example` to the ignored `.env.production` beside this service on
the VPS. Replace `change_me`, restrict the PostgreSQL and RabbitMQ accounts to
Notification Delivery, and never pass transport credentials to domain-service
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
pnpm run test:integration
docker build --build-arg APP_REVISION="$(git rev-parse HEAD)" -t winwidget-notification-delivery .
```

Integration tests require disposable local PostgreSQL, RabbitMQ, and SMTP
fixtures. Readiness proves the database, RabbitMQ connection, consumers, and
Outbox publisher, not external provider delivery.
