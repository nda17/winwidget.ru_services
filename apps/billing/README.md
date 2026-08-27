# Сервис Billing

Billing владеет платежами, подписками, ценами тарифов, партнёрским состоянием,
настройками биллинга, планированием продлений и схемой PostgreSQL `billing`.
Критичные изменения состояния платежей и подписок выполняются синхронно в
PostgreSQL; зависимые события создаются через transactional Outbox.

## Роли процессов

| `BILLING_PROCESS_ROLE` | Порт по умолчанию | Ответственность                                         |
| ---------------------- | ----------------: | ------------------------------------------------------- |
| `api`                  |              4800 | Публичный Billing API и закрытые HTTP-контракты         |
| `scheduler`            |              4801 | Расписания истечения, очистки и автопродления           |
| `worker`               |              4802 | Идемпотентные RabbitMQ consumers и работа с провайдером |
| `outbox-publisher`     |              4803 | Публикация Outbox с confirms и mandatory                |

Каждая роль предоставляет `GET /health/live` и `GET /health/ready`.
Бизнес-контроллеры регистрирует только `api`.

## HTTP-контракты и границы сервиса

Публичные маршруты находятся под `/api/v1` и включают `/payments`,
`/subscriptions`, `/tariff-prices`, `/affiliate` и `/billing-settings`.
Webhook YooKassa обрабатывается по `POST /api/v1/payments/webhook`.

Закрытые маршруты не публикуются через публичный Gateway:

- Identity вызывает `/internal/v1/identity/billing/**` с
  `BILLING_IDENTITY_TOKEN`.
- Campaigns вызывает `/internal/v1/billing/campaigns/active-subscriber-ids` с
  `BILLING_CAMPAIGNS_TOKEN`.
- Operations вызывает `/internal/v1/operations/billing/admin-alerts` и
  `/internal/v1/operations/billing/messaging/**` с
  `BILLING_OPERATIONS_TOKEN`; и вызывающая сторона, и сокет должны быть
  локальными.
- Billing вызывает introspection Identity с `IDENTITY_BILLING_TOKEN` и
  закрытый API Widgets с `WIDGETS_INTERNAL_TOKEN`.

API никогда не выполняет асинхронные переходы состояния платежа через
RabbitMQ. Учётные данные провайдера и `PAYMENT_METHOD_ENCRYPTION_KEY` должны
быть доступны только использующим их ролям.

## Настройка и развёртывание

Скопируйте `.env.example` в `.env.production` внутри каталога Billing на VPS.
`.env.production` игнорируется Git. Используйте отдельные ограниченные учётные
данные для базы данных, RabbitMQ и внутренних вызовов; никогда не используйте
токен Identity или Operations повторно в другом направлении.

Примените миграции до запуска новой ревизии, затем запустите по одному
контейнеру каждой роли из одного неизменяемого образа:

Миграции создают постоянный `service_identity` текущей базы. После их
успешного применения включённые consumers, provider worker и scheduler
запускаются сразу; отдельной фазы активации базы нет.

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

Для `worker` и `outbox-publisher` задайте
`RABBITMQ_CONNECTION_NAME=winwidget-billing-<role>`. Обычно проверкой топологии
владеет worker; publisher может работать с ограниченными ACL только на
публикацию.
