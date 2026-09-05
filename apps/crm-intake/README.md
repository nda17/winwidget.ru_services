# WinCRM Intake

Автономный Inbox WinCRM. Реализованы ручные обращения, поиск, серверная
пагинация, отклонение с проверкой версии, история и настройка API-источников
с безопасной ротацией/отзывом credentials, синхронный приём API/webhook и
атомарный импорт подтверждённых CSV-строк.

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
(`MANUAL|API|CSV`), `sourceId`, `status`, `createdBySubject`, `teamId`, `version`,
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

### Атомарный CSV-импорт

`POST /api/v1/crm/intake/imports/csv` требует пользовательский Bearer и
`Idempotency-Key`, равный UUIDv4 `commandId`. JSON содержит ровно
`{schemaVersion:1,workspaceId,commandId,label,teamId,rows}`. `label` — название
импорта до 200 символов без путей/контрольных символов (не `.`/`..`), `teamId`
— явный null либо UUID из свежего `context.teamIds`. Каждый из 1–250 элементов
`rows` содержит ровно `title,name,phone,email,message` с лимитами ручного
обращения; nullable-поля присутствуют явно. Неизвестные поля и actor/team
override внутри строки отвергаются. Raw CSV, его encoding/delimiter и файл
не принимаются и не сохраняются: frontend сначала показывает preview.

Только точный POST CSV route допускает JSON до 1 MiB **в UTF-8 байтах**;
остальные JSON routes сохраняют 32 KiB. HTTP 413 не отражает тело запроса.
Backend повторно проверяет `intake:write`, `ACTIVE|GRACE` и роль
OWNER/CRM_ADMIN/TEAM_LEAD/MANAGER на каждой попытке, включая replay.
READ_ONLY/ANALYST не могут импортировать. Hash связывает actor, workspace,
label, team и исходные значения/порядок строк до нормализации; retry должен
сохранить тот же UUID и полностью неизменный DTO.

HTTP 200: `{schemaVersion:1,import:{id,workspaceId,createdBySubject,teamId,
label,rowCount,createdAt}}`; `id = commandId`, дата canonical ISO UTC.
Это метаданные без импортированных контактных полей. `GET /imports/:id` с
`workspaceId` возвращает тот же DTO после свежего `intake:read` и
ALL/TEAM/OWN scope, в том числе в READ_ONLY. Невидимый импорт — 404
`crm_intake_import_not_found`; чужой/изменённый commandId — 409
`crm_intake_command_conflict`; 503 `crm_intake_retry_required` или
`crm_intake_import_unavailable` требует повтора неизменной команды.

В одной короткой SERIALIZABLE-транзакции сохраняются пакет, `createMany`
заявок `NEW/origin:CSV/sourceId:null`, независимые UUID audit `CREATED`,
связи строк и global Intake command receipt (`entityKind:import`). Никакого
автослияния, контактов/сделок или автоматического Acceptance. CSV как быстрая
ограниченная локальная операция не публикует RabbitMQ-события; последующее
явное принятие использует обычный durable workflow.

Миграция `20260906130000_add_csv_imports` добавляет только собственные
`csv_imports`/`csv_import_rows`; runtime получает **SELECT/INSERT**, без
UPDATE/DELETE/TRUNCATE/DDL. Composite workspace FKs и deferred integrity
проверяют полный rowCount, origin/actor/team, создание audit и bound receipt.
Все deferred constraints принудительно проверяются внутри transaction callback
до успешного ответа. Retention этих immutable proofs согласуется отдельно.

`pnpm test:integration:csv` использует те же явные `CRM_INTAKE_TEST_*` и
`CRM_INTAKE_INTEGRATION_ALLOW_MUTATION=true`, что Inbox suite; миграции/grants
применяются отдельно. PG18 gate проверяет 250 строк, 6 конкурентных replay,
точный binding, scopes/READ_ONLY, namespace collision, rollback после реальных
записей каждой стадии, deferred failure после receipt, FK и append-only ACL.
Unit HTTP gate отдельно доказывает совместимость 32 KiB и CSV 1 MiB.

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

## Bounded owner export

GET `/api/v1/crm/intake/exports/{entity}?workspaceId={uuid-v4}&format=json|csv`,
where entity is `inbox`. A current user Bearer session is required.
Only OWNER with both `intake:read` and `intake:export` may export,
including GRACE and READ_ONLY. This is an additive route: ordinary CRUD semantics,
Widgets and existing source endpoints are unchanged.

Each request reads only this service's business tables in one REPEATABLE READ,
READ ONLY snapshot, ordered by immutable UUID with keyset pages of 500. Archived
records are included; task export also includes completed/cancelled tasks of
archived deals. Sales uses its own stored contact-name snapshot, never a foreign
Customer database/HTTP lookup. This is a business-data export, **not a database
backup**: receipts, credentials, token hashes, integration proofs, team membership
and audit history are not part of the file.

Hard bounds are 10,000 records, 16 MiB of total encoded UTF-8 output, and 5 seconds
of materialization. No truncated/partial file is returned. SQL statement timeout
is 4 seconds; transaction max wait is 500 ms and transaction timeout 4.5 seconds.
A process permits at most four simultaneous materializations and one per exact
actor/workspace pair. This is a local memory guard (429), not a distributed quota
or a substitute for ingress connection limits. Request disconnect aborts checks;
in-flight SQL remains bounded by its timeout.

Fresh Access authorization runs before the snapshot and again after complete
encoding. Exact subject, workspace, data scope and sorted team IDs must remain
equal; current OWNER/read/export permissions are required both times. A state
transition ACTIVE -> READ_ONLY still permits export. Data is not sent before the
second check and successful insertion of a technical PREPARED audit event.

JSON envelope is exactly
`{schemaVersion:1,workspaceId,entity,snapshotAt,rowCount,items}`.
Dates are canonical UTC ISO strings, nulls stay explicit, integer amounts remain
minor currency units. Its business fields preserve values without CSV formula
rewriting. This does not promise full application-state restore.

CSV is UTF-8 BOM, comma-delimited, RFC 4180 double-quoted headers and every cell,
CRLF record terminators including the last record. Null is an empty quoted cell;
integers are decimal strings. Quotes are doubled and multiline content is retained.
String cells beginning with TAB/CR/LF, or whitespace/control followed by
`=`, `+`, `-`, `@`, receive an ASCII apostrophe prefix. Thus a phone
`+7...` is exported as `'+7...`. CSV is spreadsheet-safe, **not lossless
re-import**. Column order is fixed:

- inbox: `id, workspaceId, title, name, phone, email, message, origin, sourceId, status, createdBySubject, teamId, version, contactId, dealId, rejectionReason, receivedAt, updatedAt, acceptedAt, rejectedAt`.

Successful replies have a fixed attachment filename `wincrm-{entity}.{format}`,
`Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and an exact origin
`Content-Length`. Metadata headers are `X-WinCRM-Export-Entity`, `-Rows`,
`-Snapshot-At`, `-Schema`, `-Bytes`, `-Actor-SHA256` plus
`X-WinCRM-Workspace-Id`. Actor SHA-256 is lowercase hexadecimal over the exact
UTF-8 subject: it is pseudonymous, not anonymous. `-Bytes` is the logical UTF-8
body length; proxies may compress/remove/change Content-Length and browsers
decode automatically. Consumers must bound their decoded stream, not equate
wire length with logical bytes. Metadata, Content-Disposition, Content-Length
and X-Content-Type-Options are CORS-exposed without changing allowed origins.

Errors are 400 invalid entity/query, 401 invalid session, 403 denied or changed
authority, 413 row/byte limit, 429 process memory guard, and 503 dependency,
deadline or audit failure. No row, request value or credential is included in
error details or logs.

Migration `20260906140000_add_export_audit` adds only this service's
`crm_intake.export_audit`: UUID, workspace, actor subject, entity, format,
row/byte counts, snapshot timestamp and preparation timestamp. Grant runtime
**SELECT, INSERT only**, including SELECT for readiness; no UPDATE, DELETE,
TRUNCATE, DDL or sequence grant. PREPARED records prove materialization and
authorization, not successful browser download. Audit insertion is permitted
technical bookkeeping in READ_ONLY, not a business mutation. Retention requires
a separate maintenance policy; runtime must not silently prune audit.

Opt-in PostgreSQL 18 gate: build first, apply own migrations externally, grant
restricted runtime privileges, then run `pnpm test:integration:export` with the
existing `CRM_INTAKE_TEST_DATABASE_URL`,
`_TEST_MIGRATION_DATABASE_URL`, `_TEST_RUNTIME_ROLE` and
`_INTEGRATION_ALLOW_MUTATION=true` variables. It accepts loopback test-named
databases only, never loads .env, and cleans only its random test workspaces
using the separate migration role. It proves a stable snapshot across concurrent
updates, fresh revoke, OWN/TEAM isolation, archives, output limits, SQL timeout,
audit failure and append-only/foreign-schema ACL. These PG tests stub the Access
response to control revocation; end-to-end HTTP authorization remains a separate
local-stack/rollout gate.

## Managed Widgets control plane (opt-in)

`CRM_INTAKE_WIDGETS_ENABLED=false` by default. This additive phase only manages
the desired Widgets connection and its durable acknowledgement. It does **not**
consume `widgets.wincrm.lead-transfer.requested.v1`, create Inbox entries from
Widgets, change nullable lead fields, or import history. Existing manual/CSV/API
sources, source secrets, ingestion, acceptance and exports retain their contracts.
With the flag off, the managed controller, its SQL readiness checks, Widgets HTTP
client and new credentials are absent from existing API paths. The four CRM apps
remain independent; no new CRM service or shared database is introduced.

### Public HTTP and permissions

Base `/api/v1/crm/intake/widget-sources`, with current Identity Bearer session:

- `GET /?workspaceId&page&pageSize` and `GET /:id?workspaceId`: OWNER/CRM_ADMIN
  with `intake:read`, including READ_ONLY. Server pagination uses the existing
  Intake bounds (page size at most 100).
- `GET /candidates?workspaceId&page&pageSize`: writable OWNER/CRM_ADMIN with
  `intake:manage-sources`; returns actual owned widgets even when Widgets billing
  is ineligible, with a separate explicit eligibility result.
- `POST /`: `{schemaVersion:1,workspaceId,commandId,name,widgetType,widgetId,teamId}`.
  Name is at most 200 characters. `teamId` is a required nullable UUID and, when
  present, must be in the actor's fresh authorized team IDs.
- `POST /:id/configure`:
  `{schemaVersion:1,workspaceId,commandId,expectedVersion,enabled}`.
- `POST /:id/retry`: `{schemaVersion:1,workspaceId,commandId,expectedVersion}`;
  only the current BLOCKED/ERROR command can be retried.

All POSTs require writable OWNER/CRM_ADMIN and exact `Idempotency-Key=commandId`.
They return **202**, `Cache-Control: no-store`, exactly
`{schemaVersion:1,source,command:{id:commandId,state:'QUEUED'}}`. This is a durable
queued acknowledgement, not proof that Widgets has applied it. The stored reply
is historical: an exact public replay returns the original response; read the
source again to observe convergence. A command UUID shares the existing global
Intake namespace with manual/API/CSV commands, protected by the same actor,
workspace, raw request hash and nonblocking UUID advisory lock. Cross-purpose or
changed-body reuse is 409. The old sources DTO and endpoint are not reused.

Source fields are exactly `id,workspaceId,kind:'WIDGET',name,widgetType,widgetId,
teamId,createdBySubject,version,enabled,generation,controlVersion,
appliedControlVersion,appliedGeneration,syncState,lastErrorCode,createdAt,
updatedAt,syncedAt`. Applied fields/timestamp and error are nullable; sync state
is PENDING/SYNCED/BLOCKED/ERROR. Dates are canonical ISO UTC. Name, routing team,
widget binding and original actor are immutable in this phase. Version equals
the monotonically increasing desired control version. A false-to-true transition
increments generation; local disable sets `enabled=false` in the public command
transaction immediately. Observed acknowledgement updates never change the
desired version and cannot overwrite a newer command.

Candidates envelope is `{schemaVersion:1,workspaceId,page,pageSize,total,
eligibility,items}`. Eligibility fields are `eligible,reason,plan,startsAt,
expiresAt,checkedAt,validUntil`. Each item is `widgetType,widgetId,name,isActive,
publishedVersion,createdAt,connection,sourceId`; connection is NONE,
THIS_WORKSPACE or OTHER_WORKSPACE. `sourceId` is only exposed for this workspace;
other workspace IDs, connector IDs, billing IDs and canonical owner are omitted.
Widget types are WHEEL, QUIZ, CALLBACK, TIMER, STOP_OFFER and CALCULATOR.

Errors do not echo input or dependency bodies: 400 malformed DTO/key, 401 session,
403 role/subscription/delegation restrictions, 404 unknown source, 409 command
collision/CAS/already-connected/retry-state, 503 unavailable dependency/transaction.
Asynchronous errors are the closed codes DELEGATION_REVOKED, OWNER_CHANGED,
SUBSCRIPTION_REQUIRED, WIDGET_UNAVAILABLE, ALREADY_CONNECTED, CONTROL_CONFLICT,
DEPENDENCY_UNAVAILABLE or INVALID_RESPONSE; never arbitrary provider text.

### Fresh authority and cross-VPS boundary

Intake obtains canonical ownership only from fresh scoped Access
`POST /internal/v1/crm-access/authorize-widget-source`, body
`{schemaVersion:1,workspaceId,subject}`. Response extends the existing exact
authorization context with `ownerSubject`. Access obtains that owner from active
Identity workspace/membership records; public input never chooses the owner.
The worker reauthorizes the **original creator** before every enabling HTTP call,
checks current owner equality and routing-team membership, and rechecks the local
desired command/lease before sending. Demotion, disable, expiry or changed owner
halts enabling; retry never substitutes the administrator requesting the retry.
An already-authorized durable disabling command may converge technically after
CRM expiry without obtaining permission to create business data.

Scoped Widgets HTTP uses `WIDGETS_INTERNAL_BASE_URL`, distinct
`WIDGETS_CRM_INTAKE_TOKEN` and `x-winwidget-service: crm-intake`; no saved JWT.
Only exact HTTPS origins or local loopback HTTP are valid. Redirects are rejected,
JSON reads are bounded (candidates 256 KiB/configure 16 KiB), with 250–5000 ms total
timeout (`CRM_INTAKE_WIDGETS_HTTP_TIMEOUT_MS`, default 3000). A separate VPS uses a
private HTTPS ingress forwarding to the owning app's actual loopback socket;
direct private-address HTTP and arbitrary forwarded-header trust are not allowed.
Public Gateway must not publish these internal endpoints.

Widgets configure uses its frozen monotonic controlVersion/generation contract.
An exact downstream command UUID/body is reused after response loss; historical
acknowledgement is validated against that exact binding, not mistaken for current
remote state. A later local desired command wins over any late success or error.
No compensating deletion, owner substitution or silent reconnection occurs.

### Own transactions, processes and queues

Migration `20260907020000_add_managed_widget_control` adds only
`crm_intake.managed_widget_sources`, `widget_control_jobs`,
`widget_control_receipts` and `widget_control_outbox`, and additively extends the
existing command/activity kind allowlists. Runtime needs SELECT/INSERT/UPDATE on
all four (no DELETE/TRUNCATE until a separate retention contract), and
the existing SELECT/INSERT-only `intake_commands`/`intake_activities` grants.
There are no sequence or foreign-schema privileges. Immutable binding/terminal
proof triggers and deferred composite FKs are checked explicitly with SET
CONSTRAINTS IMMEDIATE before returning from each command/consumer transaction.
SQL lock/statement/transaction timeouts bound contention; network calls are outside
database transactions.

Source, immutable job, global command receipt, audit and Outbox commit atomically.
The consumer claims `(eventId, consumer='crm-intake.widget-control.v1')` and job
with a 30-second CAS lease before external calls, renewing every 10 seconds.
Success/failed receipt and acknowledgement/retry Outbox update atomically before
ack. Manual retry creates a new event ID and Outbox in the retry transaction but
keeps the exact downstream command ID/body. Obsolete events cannot take over a
new command. Retain commands, receipts and bindings until an explicit replay
horizon/maintenance policy is agreed; do not auto-prune proof or active jobs.

Independent `CRM_INTAKE_PROCESS_ROLE` values are `widget-control-worker` (5313)
and `widget-control-publisher` (5314), requiring the feature flag. API remains
5310, acceptance worker/publisher remain 5311/5312. Each background process uses
its own scoped principal via its own `CRM_INTAKE_RABBITMQ_URL`; API-only needs no
broker. `all` is for local checks. Consumer drain and publisher completion occur
before Prisma disconnect. No new broker is required, only separate topology/ACL:

- Main direct exchange `winwidget.crm-intake.widget-control.events`, routing key
  `crm.intake.widget-control.requested.v1`, queue
  `winwidget.crm-intake.widget-control.v1`.
- Retry direct exchange `winwidget.crm-intake.widget-control.retry`, routing keys
  `widget-control.retry.1`, `.2`, `.3`; queues main queue plus `.retry.1`/`.2`/`.3`,
  TTL 5/30/120 seconds, dead-lettering back to the main exchange/key.
- Dead-letter direct exchange `winwidget.crm-intake.widget-control.dead-letter`,
  main routing key, queue main queue plus `.dead-letter`.

Publisher write allowlist is only these three exchanges; worker read is only its
main queue. Retry dead-letter routing requires the corresponding broker-side
permissions. Runtime `CRM_INTAKE_RABBITMQ_ASSERT_TOPOLOGY=false`; a separate
provisioner owns configure/bind/TTL permissions. No acceptance or general Widgets
queue wildcard. Main/retry/DLQ envelopes contain only schemaVersion/eventId/
workspaceId/sourceId/commandId/controlVersion/generation, never JWT, canonical
owner, widget contact payload or source secret. Publisher sends Buffer JSON with
confirm **and** mandatory-return verification, and retries transient transport
failures indefinitely with a bounded backoff; consumer uses basic.consume, not
broker polling. Exhausted processing retries become visible ERROR with durable
DLQ; public retry remains an explicit authorized command.

### Verification gates

`pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build` cover default-off module
isolation, strict scoped clients, actual ephemeral loopback controller HTTP,
authority/revoke/CAS/replay, independent messaging and shutdown ordering.
`pnpm test:integration:widget-control` uses the same guarded isolated PG18 env as
the other Intake integration scripts. Apply migrations externally with the
migration role, grant the four own tables, then run with restricted runtime.
The script does not load .env or migrate; it cleans only its random workspace
through the separate migration role. It checks six concurrent identical creates,
shared namespace, late acknowledgement versus disable, original-actor recovery,
response loss, lease recovery, reached-after-insert rollback and DB/ACL invariants.
Access/Widgets responses are controlled stubs in this PG test, not claimed as a
cross-service HTTP proof.

Optional `CRM_INTAKE_WIDGET_CONTROL_TEST_RABBITMQ_URL` must reference an isolated,
empty, authenticated loopback test/CI vhost. It adds real push/confirm/mandatory,
duplicate receipt and drain checks; the script refuses nonempty/consumed queues,
does not purge, and closes only its connections. The owner of the fixture removes
its broker resources. Full Identity → Access → Intake → Widgets HTTP authority,
restricted broker ACL, and coordinated future lead transfer remain separate
local-stack/release gates. Existing production flag stays off; no VPS deployment
is part of this phase.
