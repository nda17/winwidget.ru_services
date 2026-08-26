# Сервис Reporting

Reporting владеет агрегированной аналитикой, настройками и запусками Daily
Summary, своей схемой PostgreSQL, проекциями, transactional Outbox,
состоянием retry/DLQ и результатами доставки. У сервиса нет HTTP- или
snapshot-зависимости от выведенного из эксплуатации runtime Core.

## Границы runtime

- Авторизация через Identity работает по принципу fail-closed через
  `POST /internal/v1/auth/introspect` на `IDENTITY_INTERNAL_BASE_URL`.
- Изменения расписания Daily Summary резервируют и подтверждают ограждение
  политики резервного копирования в Operations:
  - `PUT /internal/v1/operations/reporting/schedule-policy`
  - `POST /internal/v1/operations/reporting/schedule-policy/confirm`
- Маршрутизация уведомлений Operations получается из события
  `operations.notification-routing.changed.v1` в `winwidget.events`.
  Reporting хранит последний watermark `changedAt`, чтобы отложенный retry не
  мог перезаписать более новую маршрутизацию.
- Актуальные изменения Identity, Billing и Widgets поступают через независимые
  очереди RabbitMQ. Reporting публикует запросы доставки Daily Summary и
  события аудита администратора через transactional Outbox.

Устаревший backfill snapshot Core и роли shadow-evidence намеренно удалены.
Повторное воспроизведение исторических snapshot и алиасы совместимости не
входят в штатный сервис.

## Роли процессов

`REPORTING_PROCESS_ROLE` принимает только:

- `all`
- `api`
- `worker`
- `publisher`
- `scheduler`

Production-развёртывание на одном VPS сейчас использует `all`. Устанавливайте
`REPORTING_SCHEDULER_ENABLED=true` только для процесса, который владеет
запусками Daily Summary по расписанию.

## Прямой cutover RabbitMQ

Надёжная очередь `winwidget.reporting.settings` сохраняет имя, но её
единственным source binding теперь является
`operations.notification-routing.changed.v1`. Во время cutover удалите
выведенный из эксплуатации binding Core. Пересоздайте
`winwidget.reporting.settings.retry.1`, `.retry.2` и `.retry.3`, поскольку их
неизменяемый dead-letter routing key меняется на событие Operations.
Исторические сообщения из выведенных маршрутов намеренно не воспроизводятся.

## Настройка

Скопируйте `.env.example` в игнорируемый `.env.production` на целевом VPS и
задайте там реальные секреты. Никогда не добавляйте `.env.production` в commit.

Обязательные учётные данные сервиса:

- `REPORTING_DATABASE_URL` — роль/база/схема PostgreSQL сервиса Reporting.
- `REPORTING_INTERNAL_TOKEN` — отдельные исходящие учётные данные для вызовов
  политики расписания Reporting → Operations; не менее 32 нешаблонных
  символов.
- `REPORTING_OPERATIONS_TOKEN` — отдельные входящие учётные данные для вызовов
  мониторинга Operations → Reporting; не менее 32 нешаблонных символов.
- `IDENTITY_REPORTING_TOKEN` — отдельные учётные данные Reporting для
  introspection Identity; не менее 32 нешаблонных символов.
- `RABBITMQ_URL` — ограниченный пользователь RabbitMQ сервиса Reporting для
  ролей worker/publisher.

`OPERATIONS_INTERNAL_BASE_URL` по умолчанию равен `http://127.0.0.1:5200`, а
`IDENTITY_INTERNAL_BASE_URL` — `http://127.0.0.1:4900`. Оба клиента отклоняют
origins не на loopback.

## Команды

```bash
pnpm install --frozen-lockfile
pnpm run prisma:generate
pnpm run prisma:validate
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run build
```

Интеграционные тесты требуют изолированные локальные учётные данные PostgreSQL
и RabbitMQ:

```bash
REPORTING_TEST_DATABASE_URL=postgresql://... \
REPORTING_TEST_MIGRATION_DATABASE_URL=postgresql://... \
REPORTING_TEST_RABBITMQ_URL=amqp://... \
REPORTING_TEST_RABBITMQ_ADMIN_URL=amqp://... \
REPORTING_INTEGRATION_ALLOW_MUTATION=true \
pnpm run test:integration
```

Интеграционная база данных и RabbitMQ vhost должны быть одноразовыми и
локальными.

## HTTP

- `GET /health/live`
- `GET /health/ready`
- `GET /metrics`
- `/api/v1/admin/reporting/**` — аутентифицированный admin API через прямой
  introspection Identity.
- `GET /internal/v1/reporting/messaging/overview` — доступный только через
  loopback endpoint мониторинга Operations с аутентификацией через
  `REPORTING_OPERATIONS_TOKEN` и `x-winwidget-service: operations`.
