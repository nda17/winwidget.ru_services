# WinCRM Intake

Автономный Inbox WinCRM. Реализованы ручные обращения, поиск, серверная
пагинация, отклонение с проверкой версии, история и настройка API-источников
с безопасной ротацией/отзывом credentials, синхронный приём API/webhook.

Нативная доставка Widgets пока не включена: ей нужен отдельный согласованный
контракт доставки и явного подключения. Приём в работу тоже
пока не публикуется: `ACCEPTED` зарезервирован для подтверждённого создания
контакта и сделки. Фиктивной смены статуса и RabbitMQ-интеграции нет.

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
