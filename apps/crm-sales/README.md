# WinCRM Sales

Автономная граница воронок, сделок, следующего действия и истории WinCRM.
Сервис хранит собственную PostgreSQL-схему, read-only каталог шаблонов,
идемпотентную установку точной версии шаблона и рабочий цикл сделки.

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
- `POST /deals/:id/archive` — мягкое архивирование с отменой открытой задачи.

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
`archivedAt`, `nextTask` и canonical даты. Каждая неархивированная открытая
сделка имеет ровно одну активную задачу. Закрытие/архивирование убирает её;
архивирование сохраняет исторический `status`. Значение `outcome` перехода
или завершения задачи обязательно и ограничено 4000 символами.

Workspace/composite FK, partial unique index и deferred constraint triggers
защищают связи этапа, сделки и задачи и не позволяют commit открытой сделки
без следующего действия. Business mutation, timeline и actor/request-bound
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
commit без next action и append-only ACL. Требуются loopback тестовая БД
`winwidget_crm_sales_test` (либо её суффикс),
`CRM_SALES_INTEGRATION_ALLOW_MUTATION=true`, `CRM_SALES_TEST_DATABASE_URL`,
`CRM_SALES_TEST_RUNTIME_ROLE` и отдельный sentinel чужой схемы.

## Локальные проверки

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
