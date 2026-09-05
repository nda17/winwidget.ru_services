# WinCRM Access

Автономный оркестратор доступа к WinCRM. Сервис не владеет пользователями,
workspace или подписками: актуальную сессию и memberships он синхронно
получает из Identity, а entitlement — из Billing. Локальная PostgreSQL хранит
состояние входа workspace в CRM, CRM-роли, команды и очередь допуска сотрудников.

## Границы

- публичный API: `GET /api/v1/crm/access/bootstrap` и
  `POST /api/v1/crm/access/trial`,
  `POST /api/v1/crm/access/onboarding/template`;
- health: `GET /health/live`, `GET /health/ready`;
- Identity остаётся единственным владельцем пользователя, сессии и membership;
- Billing остаётся единственным владельцем статуса entitlement и длительности
  trial;
- приглашения и межсервисный допуск используют собственный transactional
  Outbox и push consumers; обычные команды команды остаются синхронными.

`POST /trial` требует UUID v4 в `commandId`, совпадающий заголовок
`Idempotency-Key`, workspace с ролью `OWNER` и Bearer access token. Сначала
идемпотентно фиксируется Billing entitlement, затем локальный onboarding. Если
локальная запись временно не удалась, `bootstrap` или повтор команды безопасно
восстанавливает её из неизменяемого Billing-owned provenance
(`entitlementId`, исходная команда, её тип и субъект). Эти служебные поля
проверяются fail-closed, но не включаются в публичный CRM-ответ.

`POST /onboarding/template` доступен только `OWNER` рабочего пространства с
entitlement в `ACTIVE` или `GRACE`. Команда фиксирует точную пару
`templateKey@templateVersion`, синхронно просит `crm-sales` создать независимую
воронку, повторно проверяет Billing и только затем переводит локальный lifecycle
из `ONBOARDING` в `ACTIVE`. Полная команда защищена совпадающим
`Idempotency-Key`; неопределённый сетевой результат безопасно повторяется с тем
же `commandId`. Если `crm-sales` уже зафиксировал установку, а локальное
завершение не состоялось, `bootstrap` выполняет reconciliation без повторного
создания воронки. Сервис не читает БД `crm-sales` напрямую.

Скопируйте `.env.example`, задайте отдельные сильные service tokens и URL базы,
затем выполните:

```bash
pnpm install --frozen-lockfile
pnpm prisma:generate
pnpm prisma:migrate:deploy
pnpm build
pnpm start
```

В production все internal URLs задаются явно: удалённые Identity и Billing
доступны через точные HTTPS origins, локальный `crm-sales` может использовать
loopback HTTP. CRM backend размещается на отдельном VPS от платформы, а CRM
frontend — на ещё одном VPS. Межсерверные обращения идут через защищённый
private ingress на стороне владельца сервиса; его listener остаётся локальным,
а service token проверяется независимо от TLS и сетевого allowlist. Нельзя
открывать внутренние API на публичном Gateway. HTTP redirects запрещены, чтобы
не передать service token другому origin. TLS verification не отключается.

Billing возвращает сохранённые `policyVersion`, `seatLimit` и `graceUntil`:
новый Trial длится 5 дней, следующие 3 дня `GRACE` допускают работу и завершение
onboarding, затем `READ_ONLY` запрещает команды. Локальный `SUSPENDED` всегда
блокирует доступ. Старые периоды с `policyVersion=null` сохраняют свои условия.

Любая
сетевая ошибка, HTTP error (включая `404`) или невалидный ответ Identity/Billing
закрывает доступ с `503`; отсутствие entitlement признаётся только по успешному
ответу Billing со статусом `NOT_ACTIVATED`.

## Владелец нативного источника Widgets

`POST /internal/v1/crm-access/authorize-widget-source` принимает только
`crm-intake` с существующей отдельной парой `CRM_ACCESS_CRM_INTAKE_TOKEN` и
точными `schemaVersion:1`, `workspaceId`, `subject`. Пользовательский JWT и
`ownerSubject` в теле не заменяют межсервисную авторизацию. Контракт не
публикуется через Gateway; удалённый caller использует защищённый private
HTTPS ingress, а приложение проверяет реальный loopback peer.

Identity заново определяет активного актора и единственного канонического
владельца в одном own read-only snapshot. Access независимо проверяет свой
CRM-member, onboarding и актуальный Billing. Допускаются только writable
OWNER/CRM_ADMIN с `intake:manage-sources`, включая CRM Trial/GRACE; READ_ONLY,
отзыв доступа и неоднозначный владелец запрещают подключение. Ответ — обычный
Intake authorization DTO плюс `ownerSubject`, `Cache-Control: no-store`.
Оплаченный EASY/HARD проверяет Widgets через свой Billing-контракт отдельно.
Существующие auth/source/workflow endpoints и их точные DTO не меняются.

## Команда и допуск сотрудников

Публичный `/api/v1/crm/access/team` содержит серверные списки `members`,
`teams`, `invitations`, `deliveries` (`page>=1`, `pageSize<=100`). Просмотр
структуры разрешён только `OWNER`/`CRM_ADMIN`, включая `READ_ONLY`.
`access:read-team` не раскрывает данные менеджерам или аналитикам.

Команды: `POST teams`, `teams/:id/rename`, `teams/:id/archive`,
`invitations`, `invitations/:id/revoke`,
`members/:id/change-role`, `members/:id/set-teams`, `members/:id/disable`,
`members/:id/enable`, `deliveries/:id/retry`. Все требуют `schemaVersion:1`,
UUID v4 `commandId`, точный `Idempotency-Key`, `workspaceId`; команды
существующих объектов также `expectedVersion`. Actor/workspace/payload-bound
receipt и минимальный team audit фиксируются в той же Serializable транзакции.
Повтор команды заново проверяет актуальные права. `409` требует перечитать
объект и согласовать новый draft; сетевую неопределённость повторяют с прежним
UUID и неизменным payload. Конкурентные `P2034`/`P2002` повторяются ограниченно.

Владелец определяется Identity и не хранится как редактируемый CRM-member.
`CRM_ADMIN` не управляет владельцем, другими администраторами и собственной
ролью. `TEAM_LEAD`/`MANAGER`/`ANALYST` не управляют структурой. Изменения требуют
`access:manage-team`; отзыв/отключение выделены в `access:revoke-access`, но
пока **все** изменения запрещены в `READ_ONLY`. Исключение для безопасного
отзыва не включено без отдельного решения владельца продукта.

Приглашение создаёт Access intent с ролью/командами и TTL до 7 дней.
Worker идемпотентно создаёт Identity invitation. Принятие ссылки требует
активной сессии с точным подтверждённым EMAIL: Identity атомарно создаёт
обычный MEMBER и событие `identity.wincrm.invitation-accepted.v1`, затем
Access сохраняет admission. Обычный Identity MEMBER сам по себе не выдаёт
права WinCRM или Widgets. JWT и email не попадают в admission events.

Допуск проверяет свежие Identity/Billing/CRM-права и атомарно использует
квоту workspace: `1 + enabled CRM members <= Billing seatLimit`. Минимум 2
включает владельца; новый Trial по умолчанию получает 2 места вместе с владельцем.
Лимит берётся из опубликованной Billing policy (настраивается от 2); начатые
Trial сохраняют исходный snapshot, в том числе ранее выданные 5 мест. Pending и disabled
не занимают места. Очередь FIFO по durable sequence; `enable` лишь создаёт
WAITING admission и не обходит ранее принятые приглашения. Revoke выигрывает
у позднего acceptance event. Изменение платной квоты посреди периода не
реализовано; paid renewal должен отдельно создавать wake для ожидающих.

Имена и подтверждённые email берутся только для текущей страницы через
закрытый Identity member-directory, без телефонов, provider IDs или глобального
справочника. Несовпадение membership/subject или недоступность Identity
закрывают страницу с `503`; имена не выдумываются.

## Worker, publisher и PostgreSQL

`CRM_ACCESS_PROCESS_ROLE=api|worker|outbox-publisher` задаёт соответственно
порты `5300|5301|5302`. Все роли используют один service-owned image/schema;
worker/publisher не регистрируют бизнес-контроллеры. API не подключается к
RabbitMQ. Для фоновых ролей обязательны `RABBITMQ_URL` и точное
`RABBITMQ_CONNECTION_NAME=winwidget-crm-access-<role>`.

Три независимых consumer очереди: `winwidget.crm-access.team.provision`,
`.acceptance`, `.admission`; routing keys соответственно
`crm.access.invitation-provision.v1`, `identity.wincrm.invitation-accepted.v1`,
`crm.access.admission-wake.v1` в `winwidget.events`. У каждой собственные
retry `.retry.1|2|3` (30s/300s/1800s), `.dead-letter`, manual route
`crm-access.team.<consumer>` в `winwidget.manual-retry`.

До внешнего вызова берётся receipt `(eventId,consumer)` с PROCESSING и
CAS-lease 300s (максимум четырёх последовательных HTTP фаз по 60s).
Повтор занятого claim сохраняет delayed Outbox wake на expiry до ack.
Успешные бизнес-записи идемпотентны независимо от transport receipt;
consumer ack следует только после durable finalization либо retry Outbox.
Poison payload сохраняет только hash и безопасную причину, без исходных
секретоподобных полей. Manual retry — CAS + Outbox в одной транзакции.
Publisher отправляет Buffer JSON, требует confirm и отсутствие mandatory
return; временные ошибки возвращают запись в PENDING без необратимого лимита.
Shutdown сначала отменяет consume/timer и дожидается текущих операций, затем
закрывает RabbitMQ и Prisma.

Runtime: `USAGE crm_access`; `SELECT service_identity`;
`SELECT,INSERT,UPDATE` на `crm_workspace_access`, `crm_workspace_members`,
`crm_teams`, `crm_invitation_intents`, `crm_admissions`;
`SELECT,INSERT,DELETE` на `crm_member_teams`;
только `SELECT,INSERT` на `crm_team_command_receipts`, `crm_team_audit`;
`SELECT,INSERT,UPDATE,DELETE` на `crm_team_outbox`, `crm_team_deliveries`;
`USAGE,SELECT crm_admissions_position_seq`. Runtime не получает DDL,
schema ownership, TRUNCATE, DELETE бизнес-строк или чужие схемы.
История защищена также immutable triggers. Migration role отдельная.

Миграция join-команд fail-closed при непустых legacy `team_ids`: требуется
явный mapping до запуска, не fallback к старым массивам. Внешний DTO `teamIds`
сохранён; действующие product memberships Identity не изменяются.

Opt-in PostgreSQL18 proof:
`node test/integration/team-admission-postgres18.integration.mjs` после build,
с `CRM_ACCESS_INTEGRATION_ALLOW_MUTATION=true`,
`CRM_ACCESS_TEST_DATABASE_URL`, `CRM_ACCESS_TEST_RUNTIME_ROLE`.
Только loopback изолированная БД `winwidget_crm_access_test[_...]`, отдельная
runtime role и чужая sentinel schema. Проверяются ACL, конкурентные команды,
FIFO/quota, replay, revoke, tenant joins и receipt-before-effect.
