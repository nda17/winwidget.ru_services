# WinCRM Customers

Автономный сервис контактов и компаний WinCRM. Реализованы серверная
пагинация/поиск, создание и редактирование с проверкой версии, мягкий архив,
история изменений и просмотр кандидатов в дубли по телефону/email.
Автоматическое слияние не выполняется.

## Граница владения

- сервис владеет только PostgreSQL-схемой `crm_customers` и собственной БД;
- Prisma Client генерируется в namespace `@prisma/crm-customers-client`;
- прямой доступ к таблицам `crm-access`, `crm-intake`, `crm-sales` и других
  приложений запрещён;
- общих runtime-модулей и общей БД у CRM-сервисов нет.

## HTTP

- `GET /health/live` — liveness и текущая ревизия;
- `GET /health/ready` — подключение к БД и проверка `service_identity`;
- `GET /health/revision` — безопасный идентификатор ревизии.

Readiness дополнительно проверяет все runtime-колонки контактов, компаний,
квитанций команд и журнала изменений. Старая схема не считается ready.

Бизнес-маршруты публикуются только под `/api/v1`. В production
listener обязан оставаться loopback; публичный трафик должен идти через
API Gateway. CORS принимает только точные `http/https` origins.

Каждый запрос заново подтверждает Bearer-сессию и CRM-права через
`POST /internal/v1/crm-access/authorize`. Межсервисная идентичность —
`x-winwidget-service: crm-customers` и отдельный
`CRM_ACCESS_CRM_CUSTOMERS_TOKEN`; адрес задаётся обязательным
`CRM_ACCESS_INTERNAL_BASE_URL` (точный HTTPS origin для другого VPS или
loopback HTTP локально). Redirect запрещён, timeout ограничен, JSON-ответ
не превышает 64 KiB; отсутствие/ошибка контракта возвращает `503` без
раскрытия внутреннего URL или токена. Кэш прав не используется.

### API контактов и компаний

Общий prefix `/api/v1/crm/customers`:

| Метод | Путь                                                    | Назначение                                                                           |
| ----- | ------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| GET   | `/contacts`, `/companies`                               | `workspaceId`, `page` (1), `pageSize` (25, максимум 100), `search` (до 200 символов) |
| GET   | `/contacts/:id`, `/companies/:id`                       | Карточка по `workspaceId`                                                            |
| POST  | `/contacts`, `/companies`                               | Создание                                                                             |
| PUT   | `/contacts/:id`, `/companies/:id`                       | Полная замена редактируемых полей с `expectedVersion`                                |
| POST  | `/contacts/:id/archive`, `/companies/:id/archive`       | Мягкий архив с `expectedVersion`                                                     |
| GET   | `/contacts/:id/activities`, `/companies/:id/activities` | Пагинация истории по `workspaceId`, `page`, `pageSize`                               |
| GET   | `/contacts/duplicates`                                  | Кандидаты по точному `phone` и/или `email`, с пагинацией                             |

Команды содержат `schemaVersion: 1`, `workspaceId`, UUIDv4 `commandId`;
`Idempotency-Key` обязан совпадать с `commandId`. При неопределённом результате
повторяется неизменная команда с тем же ключом. Архив не содержит полей
карточки. PUT требует актуальный `expectedVersion`; пропущенные nullable-поля
очищаются. Неизвестные поля тела и query отклоняются.

Поля контакта: `name` (1–200), `phone` (E.164 `+` и 7–15 цифр либо null),
`email` (до 254, хранится в нижнем регистре), `companyId` (UUID либо null),
`notes` (до 5000), `teamId` (доступная по auth context команда либо null).
Поля компании: `name`, `notes`, `teamId`, `inn` (10/12 цифр либо null),
`website` (http/https URL без credentials до 2048 либо null).

GET/команда возвращает `{schemaVersion:1, contact:{...}}` или
`{schemaVersion:1, company:{...}}`. Карточка всегда содержит `id`,
`workspaceId`, перечисленные поля (nullable представлены `null`),
`createdBySubject`, `version`, `archivedAt`, `createdAt`, `updatedAt`.
Даты — canonical ISO UTC. Список возвращает
`{schemaVersion:1, items:[...], page, pageSize, total}`.
История содержит `id`, `workspaceId`, `entityId`, `entityKind`, `commandId`,
`actorSubject`, `action` (`CREATED|UPDATED|ARCHIVED`), `entityVersion`,
`changedFields` и `createdAt`; значения PII в журнал не дублируются.

`401` означает неактивную сессию; `403` — недоступное действие; `404` одинаков
для отсутствующей, архивной или невидимой карточки. `409` с
`crm_customer_version_conflict` требует перечитать карточку;
`crm_customer_command_conflict` означает повторное использование ключа для
другого запроса. Компания с активными контактами не архивируется (`409
crm_company_has_contacts`): сначала контакты необходимо отвязать или
архивировать. История архивной записи доступна в прежнем scope.

### Права и транзакции

`customers:read` требуется для чтения. `customers:write` и `ACTIVE|GRACE`
требуются для всех изменений; `READ_ONLY` блокируется на backend.
Каждая SQL-выборка учитывает workspace и `dataScope`: `ALL`, `OWN`
(`createdBySubject = subject`), `TEAM` (собственные записи плюс `teamIds`).
Владелец записи устанавливается из подтверждённого subject и не принимается
из DTO. `companyId` проверяется в том же scope; составной FK дополнительно
запрещает привязку между workspace.

Создание/изменение, append-only activity и receipt фиксируются в одной
SERIALIZABLE-транзакции. Ключ команды связан хэшем с workspace, actor,
операцией, entity, ожидаемой версией и нормализованными полями; повторная
выдача receipt дополнительно проверяет актуальную видимость записи.
Workspace-local transaction lock согласует архив компании с привязкой
контакта. CAS защищает от потерянных изменений. RabbitMQ для быстрого CRUD
не используется; при добавлении внешних событий потребуется Outbox.

Runtime PostgreSQL-роли выдаются только `USAGE` схемы, `SELECT` для
`service_identity`, `SELECT/INSERT/UPDATE` для `contacts` и `companies`,
`SELECT/INSERT` для `customer_commands` и `customer_activities`.
`DELETE`, доступ к `_prisma_migrations`, создание schema/table и доступ к
чужим схемам запрещены. Migration/backup роли остаются отдельными.

## Локальные проверки

### Внутренние операции принятия Inbox

Prefix `/internal/v1/crm-customers/intake-operations`, только POST. Endpoint
`execute`/`close` доступен только `crm-intake`, `read` — `crm-intake|crm-sales`,
`verify` — только `crm-sales`. Guard проверяет transport loopback и отдельные
пары `CRM_CUSTOMERS_CRM_INTAKE_TOKEN`, `CRM_CUSTOMERS_CRM_SALES_TOKEN` через
`x-winwidget-service`/`x-winwidget-internal-token`. Для другого VPS используется
приватный HTTPS ingress, который проксирует на loopback; в public Gateway эти
маршруты не публикуются. Пользовательский JWT не сохраняется и не требуется.

Точное binding тело: `{schemaVersion:1,workspaceId,workflowId,operationId,
actorSubject,payloadHash}`. IDs — UUIDv4; hash — SHA-256 JSON с рекурсивно
отсортированными ключами и сохранённым порядком массивов. `execute` добавляет
`commandId`, `payload`; `close` — `commandId`, `recoverySubject`; обе команды
требуют совпадение `Idempotency-Key`. Payload: `{mode:CREATE,name,phone,email,
teamId}` (nullable поля), либо только `{mode:EXISTING,contactId}`. Неизвестные
поля и неканонический actor отвергаются.

Ответ: binding плюс `state:ABSENT|COMMITTED|CANCELLED`, `result:null|{contactId,
contactName,contactVersion}`, `committedAt:null|ISO`. Имя — минимальный snapshot
доказательства, не свежая карточка; phone/email/notes не выдаются. `read`
возвращает только доказательство точно совпавшей операции и может работать
после expiry; произвольный поиск контакта через этот endpoint невозможен.
Перед новым Sales write `verify` заново проверяет delegated actor через Access
`authorize-workflow` (`purpose:INTAKE_ACCEPT`), текущую доступность контакта и
отсутствие архива. `execute` тоже всегда требует fresh writable authority;
`close` дополнительно требует текущего OWNER/CRM_ADMIN recovery actor.

COMMITTED/CANCELLED slot и command receipt неизменяемы. Контакт, slot, receipt
и audit атомарны; close конкурирует с execute под одним operation-lock, поздняя
команда не может пройти CANCELLED tombstone. Компенсационного удаления нет.
SQL lock/statement timeout ограничивает конкуренцию; неизвестный результат
повторяется с тем же ключом. Новые `intake_operation_slots` и
`intake_operation_commands` имеют только SELECT/INSERT для runtime, входят в
readiness и отдельную service-owned backup/restore схему.

`node test/integration/intake-operations-postgres18.integration.mjs` использует
ту же явную isolated PG18 test-конфигурацию, что CRUD suite, но миграции должны
быть применены заранее; скрипт не читает `.env`. Проверяет parallel replay,
close/late-write race, точные proof bindings, expiry/archive, rollback и ACL.

### Сборка и CRUD

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

Значение `CRM_CUSTOMERS_DATABASE_URL` с placeholder будет отклонено fail-closed.

PostgreSQL 18 integration: после `prisma:generate` и `build` запустить
`pnpm test:integration:postgres18` с
`CRM_CUSTOMERS_INTEGRATION_ALLOW_MUTATION=true`,
`CRM_CUSTOMERS_TEST_DATABASE_URL`,
`CRM_CUSTOMERS_TEST_MIGRATION_DATABASE_URL`,
`CRM_CUSTOMERS_TEST_RUNTIME_ROLE`. Обе роли должны указывать на одну локальную
изолированную БД с суффиксом `_test`/`_ci` и `schema=crm_customers`.
Runtime grants подготавливаются отдельно по матрице выше. Проверка применяет
миграции и проверяет CRUD, идемпотентность, конкурентный CAS, FK, tenant/team
scope, rollback при ошибке receipt и append-only grants. После проверки
удаляются только данные созданных ею случайных workspace.

## Bounded owner export

GET `/api/v1/crm/customers/exports/{entity}?workspaceId={uuid-v4}&format=json|csv`,
where entity is `contacts` or `companies`. A current user Bearer session is required.
Only OWNER with both `customers:read` and `customers:export` may export,
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

- contacts: `id, workspaceId, name, notes, createdBySubject, teamId, version, archivedAt, createdAt, updatedAt, phone, email, companyId`.
- companies: `id, workspaceId, name, notes, createdBySubject, teamId, version, archivedAt, createdAt, updatedAt, inn, website`.

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
`crm_customers.export_audit`: UUID, workspace, actor subject, entity, format,
row/byte counts, snapshot timestamp and preparation timestamp. Grant runtime
**SELECT, INSERT only**, including SELECT for readiness; no UPDATE, DELETE,
TRUNCATE, DDL or sequence grant. PREPARED records prove materialization and
authorization, not successful browser download. Audit insertion is permitted
technical bookkeeping in READ_ONLY, not a business mutation. Retention requires
a separate maintenance policy; runtime must not silently prune audit.

Opt-in PostgreSQL 18 gate: build first, apply own migrations externally, grant
restricted runtime privileges, then run `pnpm test:integration:export` with the
existing `CRM_CUSTOMERS_TEST_DATABASE_URL`,
`_TEST_MIGRATION_DATABASE_URL`, `_TEST_RUNTIME_ROLE` and
`_INTEGRATION_ALLOW_MUTATION=true` variables. It accepts loopback test-named
databases only, never loads .env, and cleans only its random test workspaces
using the separate migration role. It proves a stable snapshot across concurrent
updates, fresh revoke, OWN/TEAM isolation, archives, output limits, SQL timeout,
audit failure and append-only/foreign-schema ACL. These PG tests stub the Access
response to control revocation; end-to-end HTTP authorization remains a separate
local-stack/rollout gate.
