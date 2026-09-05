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

### Отдельные платные периоды WinCRM

WinCRM не использует строки Widgets `payments`, `subscriptions` и
`auto_renewals`. Billing владеет отдельными `crm_commerce_accounts`,
`crm_commerce_commands`, `crm_orders`, `crm_paid_periods`,
`crm_auto_renewals`, `crm_auto_renewal_consents`, `crm_provider_operations`,
`crm_provider_deliveries` и `crm_payment_receipts`.

Trial запускается только явной командой: 5 дней, по умолчанию 2 места с
владельцем. Оплата во время Trial создаёт один `SCHEDULED` период после
его окончания. Уже начатый Trial и его provisioning provenance не
переписываются. Начало PAID определяется свежим чтением по серверному времени,
а scheduler отдельно фиксирует идемпотентное уведомление о начале периода.
После оплаченного периода — 3 дня GRACE, затем READ_ONLY; данные не удаляются.

Первоначальный checkout допускается без действующего PAID/SCHEDULED периода
и без незавершённого PENDING/UNKNOWN заказа. Произвольная цепочка будущих
периодов не поддерживается. Цены заказа и периода — immutable snapshots,
не текущая административная политика. MONTHLY/YEARLY прибавляется календарно
с ограничением дня концом месяца. Изменение числа мест активного PAID периода
не создаёт денежный баланс или возврат: оставшееся время пересчитывается как
`floor(remainingMs * oldPeriodPrice / newPeriodPrice)` целочисленно через
BigInt, сохраняя cycle и snapshot цен. CAS Billing и durable capacity fences
в CRM Access защищают изменение количества мест и admission сотрудников.

Все пользовательские финансовые действия проходят через CRM Access BFF с
актуальной проверкой Identity OWNER, независимо от CRM business-write.
Закрытый Billing prefix — `/internal/v1/crm-access/billing/commerce`;
вызовы POST с existing парой `BILLING_CRM_ACCESS_TOKEN`,
`x-winwidget-service: crm-access` и `x-winwidget-internal-token`:

| Суффикс                                     | Назначение                                                       |
| ------------------------------------------- | ---------------------------------------------------------------- |
| `summary`, `quote`, `orders/get`, `history` | Состояние, серверная цена, заказ и серверная пагинация           |
| `checkout`, `seats`                         | Заказ либо пересчёт времени с capacity fence                     |
| `renewal/disable`, `renewal/confirm-price`  | Отказ от автопродления и явное подтверждение новой цены          |
| `orders/verify`                             | Явная постановка GET-проверки только известного provider ID      |
| `operations/get`, `operations/close`        | Durable proof либо CANCELLED tombstone перед освобождением fence |

Точные version-1 DTO находятся в `src/domain/wincrm-commerce.contract.ts`.
Каждая команда имеет UUID `commandId`, совпадающий с `Idempotency-Key`,
actor/request binding и ожидаемую версию. Отсутствие receipt не считается
откатом. SCHEDULED checkout удерживает fence до начала PAID. Возврат из
ЮKassa сам по себе не подтверждает оплату; результат фиксирует Billing после
проверенного ответа провайдера, синхронно с периодом и Outbox.

`BILLING_WINCRM_PAYMENTS_ENABLED=false` по умолчанию запрещает новые продажи
и CREATE dispatch. При включении worker требует отдельные
`BILLING_CRM_ACCESS_COMMERCE_BASE_URL`,
`BILLING_CRM_ACCESS_COMMERCE_TOKEN` для свежей reverse-авторизации capacity
перед списанием; HTTPS origin или loopback HTTP, без redirects/TLS bypass.
`BILLING_WINCRM_FRONTEND_ORIGIN` по умолчанию `https://crm.winwidget.ru`;
return path фиксирован `/billing/return`, provider confirmation URL проходит
закрытую проверку разрешённых HTTPS-страниц ЮKassa/ЮMoney.

Согласие на автопродление не проставляется автоматически. Сохранённый способ
оплаты зашифрован `PAYMENT_METHOD_ENCRYPTION_KEY`, raw method ID не сохраняется
в JSON, Outbox или браузере. Повторный CREATE использует исходный key,
return URL и зашифрованный method snapshot. `firstDispatchAt` — durable граница
возможного внешнего списания: после неё отказ/сбой нельзя выдать за неотправленный
платёж. После 23 часов новый POST запрещён. Отключение renewal не отменяет
уже отправленную операцию и не реактивируется от позднего успеха. Отказ банка
допускает две попытки примерно через 24/72 часа с часовым окном;
изменение цены требует нового отдельного подтверждения согласия.

Провайдер обслуживается отдельным push consumer
`winwidget.billing.wincrm-provider.v1` через scoped
`BILLING_WINCRM_PROVIDER_RABBITMQ_URL`. Событие
`billing.wincrm.provider-operation.requested.v1` публикуется в
`winwidget.events`; payload содержит только schema/event/operation IDs.
DLQ: exchange `winwidget.billing.wincrm-provider.dead-letter`, queue
`winwidget.billing.wincrm-provider.v1.dead-letter`. Default
`BILLING_WINCRM_PROVIDER_ASSERT_TOPOLOGY=false`; topology создаётся отдельно.
Retry использует PostgreSQL Outbox `availableAt`, без TTL/DLX-таймеров.
Claim/lease/CAS предшествует внешнему вызову, ack — после commit;
publisher использует Buffer JSON, confirm и mandatory return.

После отключения продаж сохраняйте собственный broker URL и workers до
завершения durable обязательств: VERIFY, фискальная синхронизация и начало
уже оплаченного SCHEDULED периода продолжаются. Пустой/pending список чеков
не считается завершённой фискализацией; отменённый чек даёт отдельную ошибку
и DLQ, не отменяя оплаченный период. Существующий общий webhook сначала
проверяет DB-owned CRM binding, затем legacy Widgets; metadata webhook не
является доказательством успешной оплаты.

Независимый ручной retry —
`POST /api/v1/payments/admin/crm-provider-operations/:operationId/retry`,
только DEV после Identity introspection. Body: `schemaVersion:1`, UUID
`commandId`, `expectedVersion`; UUID совпадает с `Idempotency-Key`.
Команда атомарно создаёт actor-bound receipt, новый VERIFY/SYNC_RECEIPT,
Outbox и событие Журнала `BILLING_DELIVERY_RETRY`. Новый CREATE невозможен;
UNKNOWN без provider evidence требует отдельной контролируемой сверки.

`pnpm run test:integration:wincrm-commerce` — PostgreSQL 18 gate с отдельной
loopback БД `winwidget_billing_*_test`/`*_ci`, ограниченной runtime-ролью и
`BILLING_WINCRM_COMMERCE_TEST_ALLOW_MUTATION=true`,
`BILLING_WINCRM_COMMERCE_TEST_DATABASE_URL`,
`BILLING_WINCRM_COMMERCE_TEST_RUNTIME_ROLE`. Предварительно применяются все
migrations, генерируется клиент и собирается Billing. CI использует отдельную
чистую БД, не результаты изменяющего policy-test.
Новые 8 изменяемых CRM commerce-таблиц получают SELECT/INSERT/UPDATE;
`crm_auto_renewal_consents` — только SELECT/INSERT. DELETE/TRUNCATE и прямой
EXECUTE `protect_wincrm_commerce_evidence()` запрещены. Для синтетического
seed тесту отдельно разрешён INSERT `identity_contact_projections`;
это не расширяет production API grants. Тест проверяет транзакции, concurrency,
неизменяемость, ACL, Trial/PAID и seat conversion с синтетическими ответами
провайдера. Он не доказывает реальные платежи, RabbitMQ или договорные условия
провайдера. Production rollout и внешние платёжные проверки остаются отдельными.

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
