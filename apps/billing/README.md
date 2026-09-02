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
- `crm-access` читает WinCRM entitlement и идемпотентно запускает отдельный
  пятидневный Trial через `/internal/v1/crm-access/billing/entitlements/**` с
  `BILLING_CRM_ACCESS_TOKEN`. Посещение CRM, вход и подключение источника этот
  Trial не создают; повторный запуск для workspace запрещён.
- Operations вызывает `/internal/v1/operations/billing/admin-alerts` и
  `/internal/v1/operations/billing/messaging/**` с
  `BILLING_OPERATIONS_TOKEN`; и вызывающая сторона, и сокет должны быть
  локальными. В admin alerts входят отменённые YooKassa-чеки, терминальные
  ошибки их синхронизации и отсутствующие либо pending чеки старше 30 минут;
  corrective receipt остаётся ручным контролируемым действием.
- Billing вызывает introspection Identity с `IDENTITY_BILLING_TOKEN` и
  закрытый API Widgets с `WIDGETS_INTERNAL_TOKEN`.

API никогда не выполняет асинхронные переходы состояния платежа через
RabbitMQ. Учётные данные YooKassa доступны только `worker`. Ключ
`PAYMENT_METHOD_ENCRYPTION_KEY` доступен `worker` для recurring-списаний и
`api` для закрытых admin recovery-действий, которые проверяют сохранённый способ
оплаты. Остальные роли не получают эти секреты. Admin readiness читает только
маскированное состояние конфигурации из loopback health-check `worker` и
проверяет его роль, сервис и revision. Readiness `api` и `worker` закрывается с
ошибкой при некорректном 32-байтовом base64 encryption key; readiness `worker`
дополнительно требует обе учётные данные YooKassa.

Создание платежа повторяется с тем же provider idempotency key только внутри
23-часового безопасного окна. После окна новый POST в YooKassa не выполняется:
операция остаётся в `UNKNOWN` до сверки. Отключение или отзыв автопродления
фиксируется немедленно даже при уже начатом неоднозначном списании; такое
списание сверяется отдельно и не реактивирует автопродление. `PENDING`
provider operation с `attempt > 0` считается потенциально отправленной и не
удаляется обычным checkout cleanup; `attempt = 0` можно безопасно завершить без
вызова провайдера. Поле `payment_method.id` удаляется из сохраняемого provider
snapshot, а migration очищает ранее сохранённые snapshot без вывода ID.

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
