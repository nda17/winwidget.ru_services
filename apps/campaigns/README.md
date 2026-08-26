# Сервис Campaigns

Campaigns владеет создаваемыми администраторами массовыми кампаниями,
неизменяемыми снимками аудиторий, состоянием доставки каждому получателю,
состоянием повторных попыток и схемой PostgreSQL `campaigns`. Запросы на
доставку email/Telegram публикуются через transactional Outbox; внешнюю
отправку выполняет Notification Delivery.

## Роли процессов

`CAMPAIGNS_PROCESS_ROLE` принимает `all`, `api`, `worker` или `publisher`.
`all` удобен для одного процесса; в production один образ можно разделить на
независимо перезапускаемые роли. Контейнеры слушают
`CAMPAIGNS_HEALTH_PORT` (по умолчанию `4500`) и предоставляют:

- `GET /health/live`
- `GET /health/ready`

Публичный ADMIN-контракт: `/api/v1/admin/campaigns/**`. Operations читает
`GET /internal/v1/campaigns/messaging/overview` только через loopback, передавая
`x-winwidget-service: operations` и `CAMPAIGNS_OPERATIONS_TOKEN`.

## Зависимости

- Identity: introspection Bearer-токена и снимки подходящих контактов через
  `IDENTITY_INTERNAL_BASE_URL` / `IDENTITY_CAMPAIGNS_TOKEN`.
- Billing: снимки аудитории активных подписчиков через
  `BILLING_INTERNAL_BASE_URL` / `BILLING_CAMPAIGNS_TOKEN`.
- RabbitMQ: consumers worker и подтверждаемая публикация Outbox. Для каждого
  consumer сохраняются независимые очереди retry и dead-letter.

Campaigns не владеет учётными данными SMTP или Telegram. Переменные частоты
ограничивают публикацию запросов доставки, а не прямые вызовы провайдера.

## Настройка и развёртывание

В каталоге Campaigns на VPS храните отслеживаемый `.env.example` рядом с
неотслеживаемым `.env.production`. Замените все значения `change_me` и
ограничьте область действия каждых учётных данных этим сервисом.

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

Интеграционные тесты требуют одноразовой локальной базы PostgreSQL, RabbitMQ
vhost и `CAMPAIGNS_INTEGRATION_ALLOW_MUTATION=true`; никогда не направляйте их
на production.
