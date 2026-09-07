# WinCRM Sales

Автономная граница воронок, сделок, следующего действия и истории WinCRM.
Сервис хранит собственную PostgreSQL-схему, read-only каталог шаблонов,
идемпотентную установку точной версии шаблона и рабочий цикл сделки.

## Ошибка запуска

При отклонении bootstrap сервис закрывает уже созданный Nest context и
завершается с кодом `1`; ожидание cleanup ограничено пятью секундами.
AMQP reconnect, Prisma pool или оставшийся таймер не удерживают сломанный
процесс бесконечно. Ошибка bootstrap/cleanup не выводит текст соединения.
Обычный SIGTERM использует прежние shutdown hooks; это не замена durable
retry и восстановления бизнес-операций после аварии.

После сборки из корня репозитория:

```bash
node .github/scripts/test-crm-bootstrap-failure.mjs crm-sales
```

Проверка запускает настоящий дочерний процесс с собранным entrypoint и
управляемыми Nest fault fixtures, включая зависший cleanup и обычную
остановку. Она не заменяет проверку точного Docker-образа, поздней готовности
RabbitMQ, restart policy и восстановления очередей перед rollout.

## Граница владения

- сервис владеет только PostgreSQL-схемой `crm_sales` и собственной БД;
- Prisma Client генерируется в namespace `@prisma/crm-sales-client`;
- прямой доступ к таблицам `crm-access`, `crm-intake`, `crm-customers` и других
  приложений запрещён;
- общих runtime-модулей и общей БД у CRM-сервисов нет.

## HTTP

- `GET /health/live` — liveness и текущая ревизия;
- `GET /health/ready` — подключение к БД и проверка `service_identity`;
- `GET /health/revision` — безопасный идентификатор ревизии;
- `GET /api/v1/crm/templates` — неизменяемый каталог десяти шаблонов v1.
- `POST /internal/v1/crm-access/pipelines/install-template` — защищённая
  pairwise-token команда установки для `crm-access`;
- `GET /internal/v1/crm-access/pipelines/workspaces/:workspaceId/installation`
  — защищённое чтение результата для reconciliation.

Каталог не читает и не пишет БД. `schemaVersion` описывает форму ответа,
`catalogRevision` — текущую ревизию списка, а `template.version` — неизменяемую
версию конкретного шаблона. Выбранная definition и её закреплённый SHA-256
клонируются в workspace по точной паре `(templateKey, templateVersion)`.
Воронка, этапы, installation и command receipt фиксируются одной serializable
PostgreSQL-транзакцией; повтор той же команды возвращает тот же результат, а
другая пара для уже инициализированного workspace отклоняется. Старые версии
шаблонов не перезаписываются.

В production listener обязан оставаться loopback; публичный трафик должен идти
через API Gateway. CORS принимает только точные `http/https` origins.

### Сделки и следующее действие

Публичные endpoints `/api/v1/crm/sales` требуют `Authorization: Bearer` и
`workspaceId` (query для GET, body для POST). Каждый запрос, включая replay,
синхронно перепроверяет доступ через
`POST /internal/v1/crm-access/authorize`. Отдельные env
`CRM_ACCESS_INTERNAL_BASE_URL` и `CRM_ACCESS_CRM_SALES_TOKEN` задают точный
origin и pairwise-token направления Sales → Access. URL допускает HTTPS либо
loopback HTTP; redirects и кеш запрещены. Ошибка authorizer закрывает доступ.
Read-only позволяет чтение; `ANALYST` получает только агрегаты без контактов.

- `GET /pipelines` — установленные воронки и этапы workspace;
- `GET /deals`, `GET /tasks` — серверная пагинация `page` (от 1),
  `pageSize` (1–100), bounded `search`; сделки поддерживают `pipelineId`,
  `stageId`, `status`;
- `GET /deals/:id`, `GET /deals/:id/timeline` — карточка и история;
- `GET /analytics` — число и сумма сделок по статусам без клиентской PII;
- `POST /deals` — ручная сделка с доступным контактом и первым действием;
- `POST /deals/:id/transition` — результат действия, новый этап и следующее
  действие для открытого этапа;
- `POST /tasks/:id/complete` — результат текущего действия и обязательное
  следующее; `expectedVersion` относится к задаче;
- `POST /deals/:id/archive` — мягкое архивирование с отменой активных задач сделки.

Изменяющие DTO включают `schemaVersion: 1`, UUIDv4 `commandId`, совпадающий
с `Idempotency-Key`, и `workspaceId`; изменение существующей сделки требует
`expectedVersion`. Создание принимает `title`, `currency: RUB`, целый
`amountMinor` (копейки, 0–2147483647), `pipelineId`, `stageId`, `contactId`,
опциональный `teamId` и `nextTask: {title, dueAt}` с canonical ISO-датой.
Назначение ответственного пока только текущему пользователю; `teamId`
должен входить в проверенный список его команд. Contact availability
проверяется через user-scoped Customers HTTP endpoint с исходным Bearer;
origin задаётся `CRM_CUSTOMERS_INTERNAL_BASE_URL`. Прямых чтений чужой БД нет.

Команды возвращают `{schemaVersion:1,deal}`; списки —
`{schemaVersion:1,page,pageSize,total,items}`. Сделка включает `version`,
`contactId`, snapshot `contactName`, `assignedToSubject`, nullable `teamId`,
`archivedAt`, `nextTask` и canonical даты. Открытая сделка может иметь несколько
активных задач либо ни одной. `nextTask` указывает на одну активную задачу той
же сделки/workspace и равен null, если активных задач нет. Чтение использует
существующий composite FK, не загружает весь набор параллельных задач.
Закрытие/архивирование завершает/отменяет все активные задачи именно сделки;
самостоятельные задачи не затрагиваются. Архивирование сохраняет исторический
`status`. Значение `outcome` перехода
или завершения задачи обязательно и ограничено 4000 символами.

Workspace/composite FK и deferred constraint triggers защищают связи этапа,
сделки и задачи: активный набор требует корректного next-action pointer;
пустой набор допускает null; закрытая сделка не сохраняет активные задачи.
Business mutation, timeline и actor/request-bound
receipt выполняются одной SERIALIZABLE-транзакцией. Replay возвращает
первоначальный результат только после новой проверки прав и row scope.
`OWN` ограничивает записи ответственным; `TEAM` — собственными записями и
проверенными командами; `ALL` всё равно ограничен workspace. Ошибки 409
`crm_sales_version_conflict` и `crm_sales_command_conflict` требуют обновления
данных/проверки команды; 404 `crm_sales_record_not_found` не раскрывает чужую
запись. Для этого синхронного workflow RabbitMQ не нужен. Новые событийные
побочные эффекты добавляются только с transactional Outbox и активными
контрактами consumers.

Перед возвратом результата callback принудительно выполняет `SET CONSTRAINTS`
для трёх named deferred constraints. Проверка PostgreSQL 18 с Prisma 5.22
показала: отклонение только на COMMIT откатывает БД, но Promise interactive
transaction может успешно завершиться. Явная проверка до COMMIT гарантирует
видимую API-ошибку вместо подтверждения несохранённого результата. SQL-гарантии
остаются deferred на время построения атомарного следующего действия.

Runtime получает только SELECT/INSERT/UPDATE на `deals`/`tasks`, SELECT/INSERT на
`deal_timeline`/`command_receipts`; DELETE/TRUNCATE не выдаются. Сделки архивируются,
задачи завершаются либо отменяются без физического удаления. Миграции, FK и
согласованная техническая очистка остаются у отдельной migration-role.
Доступ к чужой схеме и `_prisma_migrations` не выдаётся. Readiness проверяет
наличие новых таблиц и колонок. `pnpm test:workflow` запускает PostgreSQL 18
сценарий после migrations: create → complete task → WON → reopen → archive,
конкурентные CAS/replay, cross-workspace/OWN/ANALYST проверки, невозможность
commit с некорректным next action и append-only ACL. Требуются loopback тестовая БД
`winwidget_crm_sales_test` (либо её суффикс),
`CRM_SALES_INTEGRATION_ALLOW_MUTATION=true`, `CRM_SALES_TEST_DATABASE_URL`,
`CRM_SALES_TEST_RUNTIME_ROLE` и отдельный sentinel чужой схемы.

`GET /deals` дополнительно принимает `withoutNextAction=true|false`.
Отсутствие параметра и `false` сохраняют прежнюю выборку. `true` выбирает
только открытые неархивные сделки без связанных задач в `OPEN`/`IN_PROGRESS`;
проверяется вся связь `tasks`, а не только `nextTaskId`. Фильтр пересекается
с прежними workspace/OWN/TEAM, поиском, воронкой, этапом и статусом до подсчёта
и серверной пагинации. Поэтому `status=WON|LOST` вместе с включённым фильтром
возвращает пустой результат, не игнорирует выбранный статус. Другие значения,
массивы и пустая строка отклоняются. Новых миграций, команд и runtime grants нет;
frontend с новым параметром выпускается после совместимого Sales reader.

### Подготовка модели «Моего дня»

Миграции `20260907120000_add_task_in_progress` и
`20260907120100_expand_workday_tasks` добавляют `IN_PROGRESS`, nullable `dealId`
и снимают ограничение ровно одной активной задачи. Enum расширяется отдельным
коммитом PostgreSQL до использования нового значения в CHECK. Исторические
строки, назначения, Intake proofs и JSON прежних receipts не переписываются;
новых runtime-прав и межсервисных зависимостей нет.

`OPEN`/`IN_PROGRESS` имеют `completedAt: null`; `COMPLETED`/`CANCELLED` требуют
дату завершения. Проверка next action рассматривает прежнего и нового родителя
при изменении связи, включая standalone. Независимая задача не может стать
`nextTask` сделки без настоящей composite FK-связи.

Прежний `POST /tasks/:id/complete` остаётся командой «завершить выбранное
действие и создать следующее» с прежним форматом receipt. Он принимает активное
выбранное действие, не завершает параллельные задачи и не принимает standalone.
Переход между OPEN-этапами заменяет только выбранное действие; переход в WON/LOST
или архивирование закрывает весь активный набор данной сделки. `GET /tasks`
сохраняет старый deal-bound список OPEN; новый workday API ниже обслуживает
самостоятельные задачи и новые фильтры без подмены прежнего контракта.

До включения новых writers необходимо выпустить совместимые frontend
readers (`IN_PROGRESS`, отсутствие next action, независимый ответственный задачи), миграции и Sales runtime;
старые открытые страницы должны обновиться. Нельзя откатывать к старому Sales
runtime после появления новых состояний: старый код считает активным только
OPEN. Напоминания/назначения/повторы ещё не публикуют события из этого изменения.

### Workday API и команды задач

Prefix: `/api/v1/crm/sales/workday/tasks`. Все endpoints проверяют исходный
пользовательский Bearer через Access; `workspaceId` обязателен.

- `GET /` — `page`, `pageSize` (1–100), `search`, `scope: MINE|TEAM|ALL`
  (по умолчанию MINE), optional `teamId`, `assigneeSubject`, `status`.
  `period: TODAY|TOMORROW|WEEK|DAY|RANGE|ALL|OVERDUE` (TODAY по умолчанию),
  явный IANA `timeZone` (по умолчанию Europe/Moscow). DAY требует `from`, RANGE
  требует `from`/`to` формата YYYY-MM-DD; обе даты включены. Неделя — пн–вс.
  Границы вычисляет сервер, включая 23/25-часовые и пропущенные календарные дни.
  Ответ содержит `workspaceId`, `subject`, `page`, `pageSize`, `total`, `items`,
  `counts` по четырём статусам, отдельный `overdueCount`, `asOf`, `timeZone`,
  `range: {from,until}|null` (until исключён). Counts соблюдают scope/search/период,
  но не отдельный status; overdueCount соблюдает scope/search по всем датам.
  Фильтрация предшествует пагинации; все запросы одной REPEATABLE READ snapshot.
- `GET /:id`, `GET /:id/timeline` — текущая scoped задача и серверная пагинация
  собственного журнала. Исторический журнал legacy задач не выдумывается.
- `POST /` — `{schemaVersion:1,commandId,workspaceId,title,dueAt,dealId?,teamId?,
assignee:{subject,membershipId}}`. UI должен по умолчанию выбрать свежий
  binding создателя; явное назначение допустимо только в пределах Access authority.
- `POST /:id/edit` — базовая команда + `expectedVersion`, `title`, `dueAt`.
- `POST /:id/status` — базовая команда + `expectedVersion`, `status`:
  OPEN/IN_PROGRESS/COMPLETED/CANCELLED. Не меняет срок/назначение и не создаёт
  следующую задачу автоматически; CANCELLED не считается завершённой работой.
- `POST /:id/assignee` — базовая команда + `expectedVersion`, `assignee`.
  Все POST требуют `Idempotency-Key === commandId`, возвращают `{schemaVersion:1,task}`.

Workday task содержит nullable `dealId`, nullable `assignedToMembershipId`
(неизвестен для legacy задач), эффективный `teamId`, версию, название, срок,
статус, subject ответственного и даты. Старый task DTO не расширяется.
Самостоятельная задача существует без fake Deal. Связанная задача наследует
актуальную видимость/отдел сделки; получатель должен иметь доступ к ней,
назначение не открывает прежнюю историю. Для standalone действует OWN/TEAM/ALL;
TEAM_LEAD может делегировать не личную безотдельную, а задачу своего отдела.
ANALYST не получает операционные задачи, READ_ONLY разрешает только чтение.
Закрытая/архивная сделка не допускает новые изменения её задач.

Миграция `20260907140000_add_workday_commands` добавляет nullable поля без
переназначения данных и собственные append-only `task_command_receipts` /
`task_timeline` (runtime SELECT/INSERT). Команда, audit и receipt атомарны;
SERIALIZABLE retry заново проверяет actor authority, запись защищена CAS.
Перед новым назначением — uncached `authorize-assignee` с exact binding и
повторной actor authority; отказ/timeout не подменяется локальным разрешением.
Межсервисная проверка не является распределённой блокировкой Identity.
Replay требует актуальной видимости записи и возвращает неизменённый результат;
старые `command_receipts` не переписываются. Рабочая запись не удаляется.
При завершении выбранной задачи pointer переключается на существующую активную
задачу либо null. Все изменения связанной задачи инкрементируют версию сделки,
чтобы старые команды не перезаписали конкурентный workflow.

Release order: совместимые Identity/Access endpoints → migration/runtime grants
Sales → совместимые readers/новый Sales runtime → Workday UI. Health readiness
проверяет новые колонки и обе таблицы. Сам UI/доска, напоминания, повторяющиеся
задачи и асинхронные уведомления требуют отдельного rollout; этот API пока
не публикует события RabbitMQ. Перед их включением команда обязана атомарно
создавать Outbox вместе с изменением задачи, а consumer — обеспечивать retry/receipt.

## Локальные проверки

### Приём обращения: service-owned operation slots

`POST /internal/v1/crm-sales/intake-operations/{execute,read,close}` доступен
только Intake через loopback/private HTTPS ingress и отдельную пару
`CRM_SALES_CRM_INTAKE_TOKEN`. Все endpoints принимают точный binding
`schemaVersion:1, workspaceId, workflowId, operationId, actorSubject, payloadHash`.
UUID должны быть canonical lowercase UUIDv4; hash — lowercase SHA-256 от JSON
payload с рекурсивной сортировкой ключей объектов и сохранением порядка массивов.
`execute`/`close` дополнительно требуют UUID `commandId` и совпадающий
`Idempotency-Key`. JWT, source tokens и неподтверждённые `contactId`/имя
в команды не входят.

`execute` принимает `payload: {title, currency:RUB, amountMinor, pipelineId,
stageId, teamId:null|UUID, nextTask:{title,dueAt},
contactOperation:{operationId,payloadHash}}`. Sales перепроверяет инициатора
через Access `authorize-workflow`, а текущую доступность и отсутствие архива
контакта — через Customers `intake-operations/verify` с отдельной парой
`CRM_CUSTOMERS_CRM_SALES_TOKEN`. Proof связан с точными workspace, workflow,
actor, operation и payload hash; включает только ID, name snapshot и version
контакта. Проверки HTTP выполняются до короткой PostgreSQL-транзакции.

Одна транзакция создаёт сделку, первую задачу, timeline, immutable COMMITTED
slot и actor/request-bound receipt. Срок задачи не подменяется при задержке:
canonical ISO в прошлом создаёт честно просроченную задачу. Идентификаторы
созданных сущностей защищены составными FK только внутри Sales. Уникальность
workspace/workflow и operation ID запрещает второй бизнес-эффект с новым
command ID. Перед успешным ответом проверяются named deferred constraints.

`read` возвращает только точный доказанный результат, включая после expiry,
чтобы Intake мог завершить bookkeeping без новых записей. `close` требует
`recoverySubject`, заново проверяет writable OWNER/CRM_ADMIN и атомарно либо
возвращает уже COMMITTED результат, либо создаёт CANCELLED tombstone.
Поздний execute заново проверяет slot под тем же business-operation lock и
не создаёт сделку после tombstone. Подмена первоначального actor, удаление
созданной сделки/контакта и автоматическое повторное принятие запрещены.

Ответ: `{...binding,state:ABSENT|COMMITTED|CANCELLED,result:null|{
contactId,dealId,firstTaskId},committedAt:null|ISO}`. Internal proof не является
публичным endpoint и не заменяет fresh user authorization при просмотре CRM.
Runtime получает только SELECT/INSERT на `intake_operation_slots` и
`intake_operation_commands`; UPDATE/DELETE/TRUNCATE дополнительно запрещены
SQL triggers. `pnpm test:intake-operations` проверяет параллельный replay,
отзыв прав, гонку close/execute, FK, атомарный rollback и append-only ACL
на отдельной PostgreSQL 18. Этот сценарий также включён в `test:workflow`.

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

Значение `CRM_SALES_DATABASE_URL` с placeholder будет отклонено fail-closed.

## Bounded owner export

### Workday tasks, additive schema 2

`GET /api/v1/crm/sales/exports/v2/tasks?workspaceId={uuid-v4}&format=json|csv`
exports **all tasks currently visible in Workday**, independently of the
selected UI day/period, status, assignee and list/board view. The UI action
must say «Экспорт всех задач», not imply export of the selected day. Unknown
query fields (including `period`, `scope` and `status`) are rejected.
Only the same current `OWNER` + `sales:read` + `sales:export` can use this
route, including `GRACE`/`READ_ONLY`; other CRM/global roles gain no permission.

The JSON envelope is exactly
`{schemaVersion:2,workspaceId,entity:"tasks",snapshotAt,rowCount,items}`.
Items and CSV columns, in order:
`id, workspaceId, dealId, version, title, dueAt, status, assignedToSubject,
assignedToMembershipId, teamId, completedAt, createdAt, updatedAt`.
`dealId`, `assignedToMembershipId`, `teamId` and `completedAt` are explicitly
nullable; unknown historical membership remains null. Status is one of
`OPEN`, `IN_PROGRESS`, `COMPLETED`, `CANCELLED` without conversion. Dates
remain canonical UTC ISO strings. No timeline, previous assignments,
command receipts, parent snapshots or employee-directory data are exported.

Selection reuses the exact service-owned `workdayScope`: standalone tasks
use their own current assignee/team; linked tasks require their **current,
non-archived parent deal** in the same workspace and its current OWN/TEAM/ALL
scope. A task's former team or assignee never bypasses parent visibility.
The exported effective `teamId` is the current parent deal's team for linked
tasks (including an actual null), or the standalone task's team. This is a
single database snapshot, not assignment history or a filtered current UI page.
The old schema-1 export below still includes tasks from archived deals and
still excludes standalone tasks; its route, projection and semantics do not change.

Schema 2 retains the same bounded REPEATABLE READ/READ ONLY snapshot, pages,
row/byte/time limits, disconnect checks, fresh authority check and PREPARED
audit described below. Both versions share one concurrency guard; changing
the route cannot bypass the actor/workspace or process preparation limits.
The existing append-only audit records `entity:"tasks"` and counts, never
file content or historical assignments. Existing receipts/audits are not rewritten;
no new database, migration, Prisma pool, Outbox or broker operation is required.

Headers remain unchanged except `X-WinCRM-Export-Schema: 2` and attachment
filename `wincrm-tasks-v2.json` / `wincrm-tasks-v2.csv`; entity remains `tasks`.
Actor/workspace binding, CORS exposure, UTF-8 byte accounting, CSV formula
escaping, null encoding and error semantics remain the same. Deploy a compatible
schema-2 reader before exposing this UI action; do not send nullable rows through
the old strict reader or present the legacy export as all Workday tasks.

### Legacy schema 1

GET `/api/v1/crm/sales/exports/{entity}?workspaceId={uuid-v4}&format=json|csv`,
where entity is `deals` or `tasks`. A current user Bearer session is required.
Only OWNER with both `sales:read` and `sales:export` may export,
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

- deals: `id, workspaceId, version, title, currency, amountMinor, pipelineId, stageId, status, contactId, contactName, assignedToSubject, teamId, nextTaskId, archivedAt, createdAt, updatedAt, pipelineName, templateKey, templateVersion, stageKey, stageName, stagePosition`.
- tasks: `id, workspaceId, dealId, version, title, dueAt, status, assignedToSubject, completedAt, createdAt, updatedAt`.

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
`crm_sales.export_audit`: UUID, workspace, actor subject, entity, format,
row/byte counts, snapshot timestamp and preparation timestamp. Grant runtime
**SELECT, INSERT only**, including SELECT for readiness; no UPDATE, DELETE,
TRUNCATE, DDL or sequence grant. PREPARED records prove materialization and
authorization, not successful browser download. Audit insertion is permitted
technical bookkeeping in READ_ONLY, not a business mutation. Retention requires
a separate maintenance policy; runtime must not silently prune audit.

Opt-in PostgreSQL 18 gate: build first, apply own migrations externally, grant
restricted runtime privileges, then run `pnpm test:integration:export` with the
existing `CRM_SALES_TEST_DATABASE_URL`,
`_TEST_MIGRATION_DATABASE_URL`, `_TEST_RUNTIME_ROLE` and
`_INTEGRATION_ALLOW_MUTATION=true` variables. It accepts loopback test-named
databases only, never loads .env, and cleans only its random test workspaces
using the separate migration role. It proves a stable snapshot across concurrent
updates, fresh revoke, OWN/TEAM isolation, archives, output limits, SQL timeout,
audit failure and append-only/foreign-schema ACL. These PG tests stub the Access
response to control revocation; end-to-end HTTP authorization remains a separate
local-stack/rollout gate.
