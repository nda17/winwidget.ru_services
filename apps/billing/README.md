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

### Read-only допуск Widgets → WinCRM

`POST /internal/v1/billing/widgets/wincrm-eligibility` — узкое чтение
текущей записи `billing.subscriptions`, без `ensureTrial`, нормализации,
платежей, usage, внешних HTTP-вызовов или PostgreSQL-записей. Сам connector
этим endpoint не включается. Body exact: `{schemaVersion:1,ownerSubject}`;
subject — строка 1–256 символов без пробелов/control characters, не UUID.

По умолчанию `BILLING_WINCRM_WIDGETS_ELIGIBILITY_ENABLED=false`: API возвращает
404, новые credentials не обязательны. При явном `true` обязательны две
независимые пары `BILLING_WINCRM_WIDGETS_TOKEN` (caller `widgets`) и
`BILLING_WINCRM_CRM_INTAKE_TOKEN` (caller `crm-intake`). Токены не совпадают
между собой или с существующими service credentials. Заголовки —
`x-winwidget-service`, `x-winwidget-internal-token`; неподходящая пара даёт 403. Контроллер существует только в API process. Guard проверяет реальный
loopback peer socket, не forwarded headers. Удалённые callers должны идти
через защищённый private HTTPS ingress с локальным upstream; не публиковать
маршрут в Gateway, не ослаблять guard и не использовать redirect/TLS bypass.
Существующие роли запускаются без новых настроек, пока feature выключен.

Exact response: `schemaVersion:1`, `ownerSubject`, `eligible`, `reason`,
`subscriptionId`, `version`, `plan`, `startsAt`, `expiresAt`, `checkedAt`,
`validUntil`. Subscription ID — opaque string 1–255 (Prisma default CUID),
не UUID; `version` — десятичная строка неотрицательного PostgreSQL bigint.
При отсутствии записи ID/version/plan/период null и reason `NO_SUBSCRIPTION`.
Даты — canonical ISO с миллисекундами; `checkedAt` вычисляется после чтения.
Ответ `Cache-Control: no-store`; application cache отсутствует.

Разрешён только `ACTIVE` EASY/HARD с конечным согласованным периодом
`startsAt <= checkedAt < expiresAt`; действующая admin activation тоже
допустима. Известные EXPIRED/CANCELLED дают `INACTIVE` (nullable expiry
legacy-периода допустим); активный TRIAL — `TRIAL`, будущий оплаченный период
— `NOT_STARTED`, достигнутый expiry — `EXPIRED`. Неизвестный enum, неверная
scope/ID/version/date или ACTIVE paid без конечного положительного периода
дают безопасный 503 `billing_wincrm_eligibility_unavailable`, без деталей БД.

Для `eligible=true`, `validUntil=min(checkedAt+5s,expiresAt)`; для отказа
`validUntil=checkedAt`. Consumer обязан заново получить снимок для каждой
попытки и проверить `now < validUntil` и исходный transfer deadline перед
своим commit. Пять секунд ограничивают свежесть HTTP-ответа, а не дают
распределённую атомарность с последующим revoke. Этот ответ не проверяет
владение виджетом, CRM-права/квоту, состояние connector или историю transfer:
их независимо подтверждают владельцы соответствующих доменов. Новые БД,
migrations, grants, Outbox и RabbitMQ-события для этого чтения не требуются.

### Коммерческие настройки WinCRM

`GET /api/v1/billing-settings/crm` с действующей Identity-сессией возвращает
текущую общую ценовую политику из тех же настроек, что и админка. Ответ
`Cache-Control: no-store`, без данных администратора и без записи в Billing.
Это не персональное предложение об оплате: endpoint не проверяет активный
состав сотрудников, не фиксирует цену заказа, не создаёт платёж или Trial и
не включает автопродление. Отдельный Gateway prefix требует `required`.

`GET /api/v1/billing-settings/admin/crm` доступен `ADMIN` и `DEV`.
`PUT` по тому же адресу доступен только `DEV` после Identity introspection.
Команда содержит `schemaVersion: 1`, UUIDv4 `commandId`, совпадающий с
`Idempotency-Key`, `expectedVersion` и полный набор четырёх цен и двух
лимитов. Цены передаются целыми копейками RUB в диапазоне 1–100000000:
`monthlyPriceMinor`, `yearlyPriceMinor`, `additionalSeatMonthlyPriceMinor`,
`additionalSeatYearlyPriceMinor`. `includedSeats` включает владельца;
`includedSeats` и отдельный `trialSeatLimit` допускают 2–10000 мест.

Migration создаёт временные значения: 990 ₽/месяц, 9900 ₽/год,
290 ₽/месяц и 2900 ₽/год за дополнительное место, два включённых места,
два места в Trial по умолчанию, включая владельца. Оба лимита остаются
настраиваемыми через админку в диапазоне 2–10000. Trial остаётся пятидневным, затем действуют три дня
`GRACE`, после которых доступ становится `READ_ONLY`. Изменение цен пока
не создаёт checkout или списание и не затрагивает тарифы Widgets.

Migration `20260908090000_set_default_crm_trial_seats_two` добавляет policy v2
с двумя местами Trial только поверх неизменённой исходной seed v1. Историческая
v1 с пятью местами не переписывается. Если администратор уже публиковал
политику, migration сохраняет его настройки без изменений; лимит можно
изменить обычной DEV-командой. Начатые периоды сохраняют прежние snapshots,
включая выданные ранее пять мест.

Каждое сохранение добавляет immutable-версию `crm_commercial_policies`,
receipt команды и событие Журнала в одной SERIALIZABLE-транзакции.
Receipt привязан к payload и actor; повтор возвращает первоначальный
результат. `expectedVersion` защищает от потери параллельных изменений;
409 требует повторного чтения и явной проверки формы. БД запрещает
UPDATE/DELETE/TRUNCATE версий. Аудит использует существующий
`SITE_SETTINGS_UPDATE`, `entity.type=crm_commercial_policy` и безопасные
снимки before/after через Billing Outbox.

Новые Trial сохраняют `policyVersion`, `seatLimit` и `graceUntil` при
активации. Новые цены и лимиты не переписывают начатый Trial. Существующие
entitlements получают nullable поля без изменения дат/лимитов и сохраняют
прежнее истечение `EXPIRED`. Internal entitlement DTO добавляет обязательные
nullable `policyVersion` и `graceUntil`; Billing и `crm-access` обновляются
согласованно. Readiness проверяет новые колонки и наличие policy seed.

`pnpm run test:integration:crm-policy` выполняет реальные PostgreSQL 18
проверки immutable-версий, runtime-роли, CAS, конкурентного replay, атомарного
отката при ошибке аудита и сохранения Trial snapshot. Проверяется актуальная
seed v2 с двумя местами и сохранность исторической v1 с пятью. Перед запуском нужны
`pnpm run prisma:generate`, `pnpm run build` и чистая БД со всеми migrations.
Скрипт требует `BILLING_CRM_POLICY_TEST_ALLOW_MUTATION=true`, отдельные
`BILLING_CRM_POLICY_TEST_DATABASE_URL` и
`BILLING_CRM_POLICY_TEST_RUNTIME_ROLE`; допускает только loopback БД с именем
`winwidget_billing_crm_policy_test` или её суффиксом `_testname`. Runtime роль
не должна владеть схемой. Проверка оставляет данные в выделенной тестовой
БД; её контейнер и volume удаляются общим локальным rehearsal cleanup.

Для этого изолированного теста migration-role владеет только схемой
`billing`. Runtime-role: `LOGIN NOINHERIT NOSUPERUSER NOCREATEDB
NOCREATEROLE NOREPLICATION NOBYPASSRLS`, без CREATE на БД. Grant allowlist:
`USAGE` на `billing`; `SELECT` на `service_identity`;
`SELECT, INSERT` на `crm_commercial_policies` и `command_receipts`;
`SELECT, INSERT, UPDATE` на `source_sequences`;
`SELECT, INSERT, UPDATE, DELETE` на `crm_entitlements` и `outbox_events`.
`source_sequences` — таблица, дополнительные PostgreSQL sequences этому
сценарию не нужны. Sentinel `foreign_service_guard.sentinel` принадлежит
другой роли; runtime не получает USAGE/SELECT. Скрипт проверяет отказ
доступа к sentinel. Production ACL этим тестом не изменяются.

### Окружение и миграции

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
