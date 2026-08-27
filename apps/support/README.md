# Сервис Support

Support владеет чатом с оператором, webhook бота Telegram Support, настройками
маршрутизации, состоянием retry/ошибок доставки и схемой PostgreSQL `support`.
Сервис читает и записывает только собственную БД и актуальные HTTP/event
контракты.

## Роли процессов

| `SUPPORT_PROCESS_ROLE` | Порт по умолчанию | Ответственность                                       |
| ---------------------- | ----------------: | ----------------------------------------------------- |
| `api`                  |              5100 | Приём webhook, admin-настройки и публичный/admin HTTP |
| `worker`               |              5101 | Идемпотентная обработка webhook и доставка в Telegram |
| `outbox-publisher`     |              5102 | Публикация Outbox с confirms и mandatory              |

Каждая роль предоставляет `GET /health/live` и `GET /health/ready`. API
владеет следующими маршрутами:

- `POST /api/v1/telegram-bot/support-webhook`
- `/api/v1/support/admin/webhook/**`
- `/api/v1/support/admin/routing-settings`
- `/api/v1/support/admin/messaging/failures/**`

Readiness проверяет подключение к БД и минимальный маркер `service_identity`
(`serviceName`, `databaseId`, временные метки). Worker и Outbox publisher
запускаются по своей process role без отдельной фазы активации; readiness
обязательно проверяет их фактическую готовность.

Operations читает `GET /internal/v1/support/messaging/overview` через loopback
с `x-winwidget-service: operations` и `SUPPORT_OPERATIONS_TOKEN`. Support
авторизует пользователей admin через Identity с `IDENTITY_SUPPORT_TOKEN`.

## Telegram и RabbitMQ

Production-вызовы Telegram используют существующий публичный TLS reverse proxy:

```dotenv
TELEGRAM_API_BASE_URL=https://tg.winwidget.ru/telegram-api
TELEGRAM_API_PROXY_IP=185.184.122.62
```

API принимает webhook только после проверки секретного заголовка Telegram и
надёжного сохранения исходного update вместе с его событием Outbox. Worker
захватывает lease PostgreSQL до внешних вызовов и выполняет ack RabbitMQ только
после надёжно сохранённого завершения. Ручные retry/close остаются
транзакционными.

Для `api` и `worker` readiness также проверяет обязательные Telegram settings.
Для `api` требуются token, username, webhook secret/public URL и pinned proxy;
для `worker` — token и pinned proxy.

Контейнер `outbox-publisher` не должен получать учётные данные Telegram,
webhook, proxy или Identity; Compose должен передавать их только `api`/`worker`
по необходимости. Для ролей RabbitMQ имя соединения должно быть строго
`winwidget-support-<role>`.

## Настройка и развёртывание

Храните отслеживаемый `.env.example` и игнорируемый `.env.production` рядом с
сервисом на VPS. Замените все шаблоны отдельными секретами с ограниченной
областью действия. До запуска runtime-контейнеров примените миграцию Support
отдельной ролью миграций.

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

После развёртывания проверьте readiness всех ролей и состояние webhook. Для
контрольного сообщения чата с оператором используйте явно заданную тестовую
цель; не отправляйте незапрошенные production-сообщения.
