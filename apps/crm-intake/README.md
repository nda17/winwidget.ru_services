# WinCRM Intake

Автономный Inbox WinCRM. Реализованы ручные обращения, поиск, серверная
пагинация, отклонение с проверкой версии, история и настройка API-источников
с безопасной ротацией/отзывом credentials, синхронный приём API/webhook.

Нативная доставка Widgets пока не включена: ей нужен отдельный согласованный
контракт доставки и явного подключения. Явный приём в работу запускает durable
workflow создания контакта, сделки и первой задачи; `ACCEPTED` появляется
только после подтверждённых результатов Customers и Sales.

## Граница владения

- сервис владеет только PostgreSQL-схемой `crm_intake` и собственной БД;
- Prisma Client генерируется в namespace `@prisma/crm-intake-client`;
- прямой доступ к таблицам `crm-access`, `crm-customers`, `crm-sales` и других
  приложений запрещён;
- общих runtime-модулей и общей БД у CRM-сервисов нет.

## HTTP

- `GET /health/live` — liveness и текущая ревизия;
- `GET /health/ready` — подключение к БД и проверка `service_identity`;
- `GET /health/revision` — безопасный идентификатор ревизии.

Readiness дополнительно проверяет все runtime-колонки Inbox, источников,
квитанций команд и журнала. Старая схема не считается ready.

Бизнес-маршруты публикуются только под `/api/v1`. В production
listener обязан оставаться loopback; публичный трафик должен идти через
API Gateway. CORS принимает только точные `http/https` origins.

### API Inbox и источников

Prefix `/api/v1/crm/intake`. Следующие endpoints требуют Bearer-сессию;
source token не заменяет пользовательскую авторизацию этих маршрутов.

| Метод | Путь                        | Назначение                                                                                                            |
| ----- | --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| GET   | `/inbox`                    | `workspaceId`, `page` (1), `pageSize` (25, максимум 100), `search` (до 200), `status` (`NEW`, `ACCEPTED`, `REJECTED`) |
| GET   | `/inbox/:id`                | Карточка по `workspaceId`                                                                                             |
| POST  | `/inbox`                    | Создать ручное обращение                                                                                              |
| POST  | `/inbox/:id/reject`         | Отклонить новое обращение                                                                                             |
| GET   | `/inbox/:id/activities`     | История: `workspaceId`, `page`, `pageSize`                                                                            |
| GET   | `/sources`                  | Метаданные: `workspaceId`, `page`, `pageSize`                                                                         |
| POST  | `/sources`                  | Создать именованный API-источник                                                                                      |
| POST  | `/sources/:id/rotate-token` | Сменить секрет активного источника                                                                                    |
| POST  | `/sources/:id/revoke`       | Отозвать источник                                                                                                     |

Команды содержат `schemaVersion:1`, `workspaceId`, UUIDv4 `commandId` и
совпадающий `Idempotency-Key`. Повтор неизвестного результата использует
неизменные поля и тот же ключ. Отклонение, ротация и отзыв требуют
положительный `expectedVersion`. Неизвестные поля тела/query отвергаются;
JSON ограничен 32 KiB. Произвольные destination URLs не принимаются.

Ручное создание: `title` и `name` (1–200), nullable `phone` (E.164),
`email` (до 254, хранится в нижнем регистре), `message` (до 5000),
`teamId` (UUID доступной команды). Отклонение: `reason` (1–2000).
Actor, outcome, contact/deal IDs и source не принимаются в ручном DTO.

Карточка/команда возвращает `{schemaVersion:1,entry:{...}}`: `id`,
`workspaceId`, `title`, `name`, `phone`, `email`, `message`, `origin`
(`MANUAL|API`), `sourceId`, `status`, `createdBySubject`, `teamId`, `version`,
`contactId`, `dealId`, `rejectionReason`, `receivedAt`, `updatedAt`,
`acceptedAt`, `rejectedAt`. Nullable-поля всегда `null`, даты — canonical
ISO UTC. Список: `{schemaVersion:1,items:[...],page,pageSize,total}`.
История: `id`, `workspaceId`, `entityId`, `entityKind`, `commandId`,
`actorSubject`, `action`, `entityVersion`, `createdAt`. Значения контактов,
сообщений и credentials в audit не дублируются.

Ошибки: `401` неактивная сессия, `403` нет доступа, `404` отсутствующий или
невидимый tenant/OWN/TEAM объект. `409 crm_intake_version_conflict` требует
перечитать запись; `crm_intake_command_conflict` — ключ использован другим
запросом; `crm_intake_entry_not_new` — обращение уже обработано. `503` не
подменяется отсутствием подписки или успешной командой.

### Credentials источников

Создание: `name` (1–200), `token` (canonical base64url ровно 32 случайных
байтов), nullable `teamId`. Frontend генерирует байты через
`crypto.getRandomValues`, сохраняет в памяти до подтверждения команды и
показывает один раз; потеря требует явной ротации. Ротация передаёт новый
`token` и `expectedVersion`; отзыв — только `expectedVersion` с общими
полями команды.

Backend хранит только SHA-256 token. Plaintext не попадает в source row,
response, receipt, activity или validation error. Command hash зависит от
хэша секрета. Ответ `{schemaVersion:1,source:{...}}` содержит только `id`,
`workspaceId`, `name`, `kind:API`, `tokenVersion`, `createdBySubject`,
`teamId`, `version`, `revokedAt`, `createdAt`, `updatedAt`. GET не раскрывает
секрет/hash. Повтор команды не генерирует другой секрет. Ротация на тот же
token запрещена; revoked-источник нельзя восстановить ротацией.

GET источников требует `OWNER|CRM_ADMIN` и `intake:read`; безопасные
метаданные остаются доступны в READ_ONLY. Изменения требуют той же роли,
`intake:manage-sources` и `ACTIVE|GRACE`. Созданный API-источник принимает
запросы только с действующим source token и текущими правами его создателя.

### Внешний API/webhook

`POST /api/v1/crm/intake/ingest/:sourceId` принимает `Authorization: Bearer
<source-token>` и UUIDv4 `Idempotency-Key`. Это единственный Intake endpoint
без пользовательской JWT-сессии; Gateway должен публиковать отдельный
точный POST route, не ослабляя авторизацию `/inbox` и `/sources`.

Тело: `{schemaVersion:1,title,name,phone?,email?,message?}` с теми же лимитами,
что у ручного обращения. `workspaceId`, actor, team, commandId и URLs в теле
запрещены. Ответ HTTP 200: `{schemaVersion:1,entryId,receivedAt}` — без
контактных данных. Запись сразу сохраняется `NEW`, `origin:API`; автоматического
создания контакта/сделки и RabbitMQ-публикации здесь нет.

Source token проверяется constant-time сравнением SHA-256 до чтения квитанции.
Каждый запрос, включая replay, вызывает sessionless
`POST /internal/v1/crm-access/authorize-source` с `schemaVersion`, сохранёнными
`workspaceId` и `createdBySubject`. Access разрешает этот контракт только
`crm-intake`, заново проверяет active user/workspace/membership через scoped
Identity `/internal/v1/crm-access/source-context`, затем Billing, lifecycle,
текущую CRM-роль и `intake:manage-sources`. Требуются `OWNER|CRM_ADMIN`,
`ACTIVE|GRACE`; отключение/понижение роли/READ_ONLY останавливают доставку.
Восстановленная текущая роль разрешает неотозванный источник снова.

В собственной SERIALIZABLE-транзакции Intake блокирует source row и повторно
сверяет tokenHash/tokenVersion/version, отзыв, workspace, actor и team.
Ротация/отзыв взаимодействуют с той же блокировкой. Квитанция уникальна по
`sourceId + externalCommandId`; изменённые поля под тем же ключом дают 409,
другой source имеет независимое пространство ключей. Запись, квитанция и
append-only audit атомарны. Внутренний auditCommandId связывает событие с
receipt без записи секрета или контактных полей. Отозванный/старый токен не
получает даже прежний успешный ответ; новый действующий токен может безопасно
повторить неизменный запрос.

Лимиты: JSON 32 KiB; pre-auth peer-IP 1200/min с bounded map на 10000 peers
(при заполнении fail-closed); после валидного token durable PostgreSQL
source 120/min и peer-IP 600/min, общие для всех реплик. Минутное окно берётся
из часов БД, cleanup удаляет максимум 500 устаревших счётчиков за запрос.
Ограничения распространяются и на replay. `429` требует отложить повтор того
же ключа, `503` — повторить позже без смены ключа. Ошибки не содержат PII.

Важное runtime-ограничение перед production: IP берётся из transport socket,
не из неподтверждённого `X-Forwarded-For`. За Gateway все его запросы делят
peer-IP budget; source budget остаётся независимым. До rollout нужно
согласовать доверенную proxy boundary и ingress edge limits, затем проверить
реальные клиентские IP и общий бюджет на ожидаемой нагрузке. Слепое `trust
proxy` не включено. Нынешний этап не публикует этот маршрут на VPS.

### Авторизация и транзакции

Каждый пользовательский запрос заново вызывает `POST /internal/v1/crm-access/authorize` с
пользовательским Bearer и `x-winwidget-service: crm-intake` плюс
`x-winwidget-internal-token`. Обязательны `CRM_ACCESS_INTERNAL_BASE_URL`
(точный HTTPS origin для другого VPS, loopback HTTP локально),
`CRM_ACCESS_CRM_INTAKE_TOKEN` (не-placeholder от 32 символов). Timeout
задаёт `CRM_ACCESS_INTERNAL_TIMEOUT_MS`; redirect запрещён, response до
64 KiB, кэша прав нет. Ошибки не раскрывают токены/внутренние URL.

Чтение Inbox требует `intake:read`, ручные команды — `intake:write` и
`ACTIVE|GRACE`. SQL фильтрует workspace плюс `dataScope`: `ALL`, собственный
`createdBySubject` для `OWN`, собственные записи или `teamIds` для `TEAM`.
Actor выводится только из авторизации. Запись, audit и receipt фиксируются
одной SERIALIZABLE-транзакцией; ключ связан с workspace, actor, операцией и
полями. CAS защищает от потерянных изменений; replay проверяет актуальную
видимость. SQL CHECK требует обе ссылки contact/deal и timestamp для
ACCEPTED, а составной source FK исключает связи между workspace.

Runtime grants: `service_identity` SELECT; `inbox_entries` и `intake_sources`
SELECT/INSERT/UPDATE без DELETE; `intake_commands` и `intake_activities`
SELECT/INSERT без UPDATE/DELETE. Runtime не получает CREATE, migration
tables или чужие схемы. Migration/backup роли самостоятельны.
`inbound_receipts` также имеет только SELECT/INSERT; техническая таблица
`ingestion_rate_buckets` — SELECT/INSERT/UPDATE/DELETE для счётчиков и TTL.

## Локальные проверки

### Принятие Inbox

Все маршруты ниже требуют fresh пользовательскую авторизацию и текущую
видимость Inbox, как остальные endpoints. `GET /inbox/:id/acceptance` принимает
workspaceId и возвращает `{schemaVersion:1,acceptance:null|summary}`.
`POST /inbox/:id/accept` требует intake:write, ACTIVE/GRACE, общие поля команды,
`expectedVersion` записи Inbox, `contact:{mode:CREATE_FROM_ENTRY}` или
`{mode:EXISTING,contactId}`, `deal:{title,currency:RUB,amountMinor,pipelineId,
stageId,nextTask:{title,dueAt}}`. Сумма в копейках, 0..2147483647; dueAt —
canonical ISO UTC, допускается прошедшая дата без её скрытой подмены. Actor и
team берутся из авторизации и сохранённого Inbox, не из формы. Результат —
HTTP 202 `{schemaVersion:1,acceptance:summary}`, не готовая сделка.

Summary: `id,workspaceId,entryId,actorSubject,status,version,mode,contactId,
dealId,firstTaskId,lastErrorCode,retryAt,completedAt,createdAt,updatedAt`.
Nullable ссылки/ошибка/даты представлены null; payload и именные proofs сюда
не входят. Status: QUEUED, RUNNING, RETRY_WAIT, BLOCKED, FAILED, RECOVERING,
CANCELLED, COMPLETED. Mode: EXECUTE/RECOVER. lastErrorCode:
WORKFLOW_ACCESS_BLOCKED, WORKFLOW_REFERENCE_CONFLICT,
WORKFLOW_DEPENDENCY_UNAVAILABLE. Клиент перечитывает scoped GET; receipt
повторной команды сохраняет первоначальный ответ, не заменяет актуальный GET.

`POST /inbox/:id/acceptance/retry` принимает общие поля команды с
`expectedVersion` Acceptance (не Inbox); допускается для BLOCKED/FAILED/
RETRY_WAIT исходным actor либо OWNER/CRM_ADMIN, только writable. Тот же actor и
payload сохраняются. `POST /inbox/:id/acceptance/recover` — writable
OWNER/CRM_ADMIN для любого незавершённого workflow; атомарно создаёт новый
generation и Outbox. Сначала закрывается Sales slot, затем Customers slot.
COMMITTED сохраняется, отсутствующий slot превращается в неизменяемый
CANCELLED tombstone. Поздние execute не создают записи. Если Sales уже
COMMITTED, подтверждённые ссылки завершают Inbox; иначе workflow CANCELLED,
Inbox остаётся NEW. Ранее созданный контакт не удаляется; его ID доступен для
нового явно проверенного принятия. Смена actor в текущем workflow запрещена.

400 — валидация, 401 — сессия, 403 — права, 404 — невидимый Inbox,
409 — версия/конкурирующий workflow, 503 — повторить неизменную команду.
READ_ONLY recovery не разрешён. Отклонить Inbox с незакрытым workflow нельзя.

Worker сохраняет PROCESSING receipt до HTTP и обновляет lease/CAS. Перед
каждым новым downstream write Access `authorize-workflow` заново проверяет
сохранённого actor, membership, lifecycle, Billing, CRM-роль и scope. JWT в БД
и RabbitMQ отсутствует. Ошибка/expiry после контакта блокирует создание сделки.
Техническое завершение после expiry допустимо только по уже COMMITTED точным
proofs, без создания новых контактов/сделок/задач и без обхода fresh read scope
человека. Каждый сервис хранит только собственные таблицы. Downstream HTTP
ограничен 10s/64KiB, redirect запрещён, origin — HTTPS либо loopback HTTP.

### Процессы, RabbitMQ и ACL

`CRM_INTAKE_PROCESS_ROLE`: api (по умолчанию, port5310), worker (5311),
publisher (5312), all (5310, локальные проверки). Worker/publisher не имеют
публичных Inbox/source endpoints. API не требует RabbitMQ; publisher не
требует Access и downstream credentials. У каждого процесса один глобальный
PrismaModule/connection pool; общий runtime с другими сервисами отсутствует.
При shutdown push consumer отменяется и work/publish завершаются до закрытия
каналов и Prisma. Readiness worker требует активной push registration;
publisher — соединения/канала, все роли — актуальных собственных таблиц.

Worker env: `CRM_ACCESS_INTERNAL_BASE_URL`, `CRM_ACCESS_CRM_INTAKE_TOKEN`,
`CRM_CUSTOMERS_INTERNAL_BASE_URL`, `CRM_CUSTOMERS_CRM_INTAKE_TOKEN`,
`CRM_SALES_INTERNAL_BASE_URL`, `CRM_SALES_CRM_INTAKE_TOKEN`. Внешние origins
не имеют localhost fallback. Worker/publisher требуют
`CRM_INTAKE_RABBITMQ_URL` с отдельным principal, AMQPS вне loopback;
`CRM_INTAKE_RABBITMQ_ASSERT_TOPOLOGY=false` в production. Provisioning может
использовать true только с configure-доступом к собственному namespace.

Все exchanges direct/durable: `winwidget.crm-intake.events`,
`winwidget.crm-intake.retry`, `winwidget.crm-intake.dead-letter`.
Основной queue `winwidget.crm-intake.acceptance.v1`, binding/event type
`crm.intake.acceptance.requested.v1`. Три retry queue имеют suffix `.retry.1`,
`.retry.2`, `.retry.3`, TTL 30s/5m/30m и DLX обратно в основной exchange/key;
binding в retry exchange — `acceptance.retry.1|2|3`. DLQ имеет suffix
`.dead-letter`, binding из dead-letter exchange — основной event key.
Каждый consumer получает свою очередь; текущий consumer один:
`crm-intake-acceptance-v1`. Worker использует basic.consume/prefetch5, не polling.

Rabbit body содержит только `{schemaVersion:1,eventId,workspaceId,workflowId,
generation,mode}`, без PII/JWT/URLs. Publisher отправляет Buffer JSON,
persistent+mandatory, требует confirm и отсутствие basic.return. Только затем
Outbox PUBLISHED. Временные transport errors имеют неограниченный durable
retry с backoff до60s. Consumer error/retry/DLQ и новая Outbox записываются
одной транзакцией до ack; пропавший worker восстанавливается lease/CAS,
stale generation не вызывает HTTP. Ручной retry — только public команда
выше, никогда не Rabbit Management publish. Poison payload не копируется в
DLQ: сохраняется безопасный synthetic envelope с hash-only deduplication.

Разделение broker ACL: publisher write только на три перечисленных exchanges,
read/configure `^$`; worker read только основной queue, write/configure `^$`.
Provisioning отдельно выдаёт configure/read/write исключительно namespace
`^winwidget\\.crm-intake\\.`; DLX permissions проверяются при provisioning.
Мониторинг DLQ и очередь retry могут иметь отдельный read principal.

Новые PG tables: `acceptances`, `acceptance_outbox`, `acceptance_receipts` —
SELECT/INSERT/UPDATE, без DELETE/DDL для runtime; append-only commands/activity
не меняют grants. Миграции/backup принадлежат Intake. Retention опубликованной
Outbox/receipts/операционных tombstones требует отдельной согласованной
политики: до неё записи не удаляются, иначе поздний replay может повторить
побочный эффект. Размер таблиц/очередей нужно мониторить перед rollout.

### Сборка и интеграционные проверки

`node test/integration/acceptance-postgres18.integration.mjs` использует ту же
явную isolated PG18 test-конфигурацию, что Inbox suite. Миграции и grants
применяются заранее, `.env` скрипт не читает. Проверяются реальный PG CAS,
двойной claim, lost Sales response, completion после expiry, partial contact,
admin recovery/tombstones/restart и transactional retry. Downstream boundary
в этом suite fault-injected; реальные Customer/Sales slots проверяются их
собственными PG suites, полный HTTP stack проверяется отдельным gate.
Для реального RabbitMQ добавить `CRM_INTAKE_ACCEPTANCE_TEST_RABBITMQ_URL`:
loopback broker, отдельный пустой test-vhost с суффиксом `_test`/`_ci`, scoped
test credentials. Проверяются push, confirm+mandatory, duplicate delivery и
drain. Скрипт не purge чужие очереди, не обращается в Management API и чистит
только собственный случайный workspace через migration-role.

```bash
cp .env.example .env
pnpm install --frozen-lockfile
pnpm prisma:generate
pnpm prisma:validate
pnpm lint
pnpm test
pnpm typecheck
pnpm build
```

Значение `CRM_INTAKE_DATABASE_URL` с placeholder будет отклонено fail-closed.

PostgreSQL 18: отдельно применить миграции с migration-role и выдать runtime
grants; затем `pnpm test:integration:postgres18` с
`CRM_INTAKE_INTEGRATION_ALLOW_MUTATION=true`,
`CRM_INTAKE_TEST_DATABASE_URL`, `CRM_INTAKE_TEST_MIGRATION_DATABASE_URL`,
`CRM_INTAKE_TEST_RUNTIME_ROLE`. Обе роли — одна изолированная loopback БД
с суффиксом `_test`/`_ci` и `schema=crm_intake`. Скрипт не читает `.env` и не
запускает миграции сам. Проверяет CRUD/concurrency/CAS/replay/scopes,
credentials lifecycle, конкурентный API replay, source-scoped ключи,
ротацию во время authorization, durable rate limits, DB constraints,
rollback и append-only grants;
удаляет только созданные им случайные workspace через migration-role.

Production rollout отсутствует: новые CRM VPS пока не созданы. Нынешний
этап локальный, существующий Widgets runtime не меняется.
