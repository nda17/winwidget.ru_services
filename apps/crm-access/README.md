# WinCRM Access

Автономный оркестратор доступа к WinCRM. Сервис не владеет пользователями,
workspace или подписками: актуальную сессию и memberships он синхронно
получает из Identity, а entitlement — из Billing. Локальная PostgreSQL хранит
состояние входа workspace в CRM, CRM-роли, команды, очередь допуска сотрудников
и durable ограничения квоты для финансовых операций.

## Ошибка запуска

При отклонении bootstrap сервис закрывает уже созданный Nest context и
завершается с кодом `1`; ожидание cleanup ограничено пятью секундами.
AMQP reconnect, Prisma pool или оставшийся таймер не удерживают сломанный
процесс бесконечно. Ошибка bootstrap/cleanup не выводит текст соединения.
Обычный SIGTERM использует прежние shutdown hooks; это не замена durable
retry и восстановления бизнес-операций после аварии.

После сборки из корня репозитория:

```bash
node .github/scripts/test-crm-bootstrap-failure.mjs crm-access
```

Проверка запускает настоящий дочерний процесс с собранным entrypoint и
управляемыми Nest fault fixtures, включая зависший cleanup и обычную
остановку. Она не заменяет проверку точного Docker-образа, поздней готовности
RabbitMQ, restart policy и восстановления очередей перед rollout.

## Границы

- публичный API: `GET /api/v1/crm/access/bootstrap` и
  `POST /api/v1/crm/access/trial`,
  `POST /api/v1/crm/access/onboarding/template`, team API и owner-only
  billing BFF `/api/v1/crm/access/billing`;
- health: `GET /health/live`, `GET /health/ready`;
- Identity остаётся единственным владельцем пользователя, сессии и membership;
- Billing остаётся единственным владельцем entitlement, Trial, цен, оплаченных
  периодов и платежей; Access не рассчитывает цены или длительность периода;
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
loopback HTTP. CRM backend допускается на текущем backend VPS только после
измерения ресурсного запаса; при его недостатке потребуется отдельный VPS.
Первичный rollout выполнен 07.09.2026: четыре изолированные CRM-БД и
12 API/worker/publisher процессов работают на текущем backend VPS. Через
production-браузер проверены явный запуск Trial, onboarding, ручная заявка,
контакт, сделка, задачи и нативная доставка новой заявки колеса фортуны.
Четыре независимых frontend-приложения размещены на существующем frontend VPS,
WinCRM — на `crm.winwidget.ru`. Платные CRM-gates пока выключены; внешние
платёжные и оставшиеся browser/role/load проверки перечислены в `docs/backlog.md`.
Межсерверные обращения идут через защищённый
private ingress на стороне владельца сервиса; его listener остаётся локальным,
а service token проверяется независимо от TLS и сетевого allowlist. Нельзя
открывать внутренние API на публичном Gateway. HTTP redirects запрещены, чтобы
не передать service token другому origin. TLS verification не отключается.

Billing возвращает сохранённые `policyVersion`, `seatLimit` и `graceUntil`:
новый Trial длится 5 дней, следующие 3 дня `GRACE` допускают работу и завершение
onboarding, затем `READ_ONLY` запрещает CRM бизнес-команды. Локальный `SUSPENDED`
блокирует рабочее пространство CRM. Owner-only финансовый BFF проверяет
Identity независимо от business-write и не открывает доступ к данным CRM.
Старые периоды с `policyVersion=null` сохраняют свои условия.

Любая
сетевая ошибка, HTTP error (включая `404`) или невалидный ответ Identity/Billing
закрывает доступ с `503`; отсутствие entitlement признаётся только по успешному
ответу Billing со статусом `NOT_ACTIVATED`.

## Область отделов для доменных записей

Авторизация использует прежний DTO `teamIds`: для `OWNER` и `CRM_ADMIN`
это актуальные активные отделы только выбранного пространства, полученные
из собственной БД Access. Для `MANAGER`, `TEAM_LEAD`, `ANALYST` сохраняются
только активные назначения сотрудника. Владелец может назначать запись отделу
без фиктивного OWNER member; произвольные или чужие UUID не разрешаются.
Отделы перечитываются при каждой авторизации; архивированные не возвращаются.
Существующий межсервисный предел — 1000 отделов: превышение закрывает доступ
с `503`, а не обрезает список и не расширяет права.

## Финансовый BFF и ограничение мест

`CRM_ACCESS_BILLING_ENABLED=false` по умолчанию закрывает финансовые маршруты.
При включении каждая операция проверяет действующую сессию и канонического
Identity OWNER; CRM_ADMIN не получает право оплаты по своей CRM-роли.
Владелец может открыть оплату в `NOT_ACTIVATED`, `GRACE` и `READ_ONLY`.
GET не начинает Trial, не создаёт заказ и не разрешает бизнес-записи.
Ответы имеют `Cache-Control: no-store`; перед возвратом пользовательских
данных повторно проверяется текущий владелец.

Публичные маршруты относительно `/api/v1/crm/access/billing`:

| Метод и суффикс                                   | Назначение                                                                       |
| ------------------------------------------------- | -------------------------------------------------------------------------------- |
| `GET /?workspaceId=…`                             | Billing summary, `actorSubject`, фактические места и capabilities                |
| `POST /quote`                                     | Серверная цена CHECKOUT, SEAT_CHANGE или RENEWAL                                 |
| `POST /checkout`                                  | Создать заказ, ответ `202`, не подтверждение оплаты                              |
| `POST /seats`                                     | Пересчитать срок текущего оплаченного периода в Billing                          |
| `POST /renewal/disable`, `/renewal/confirm-price` | Отказ от автопродления или явное согласие на новую цену                          |
| `GET /orders/:id`, `/history`, `/operations/:id`  | Заказ, серверная пагинация истории, состояние команды                            |
| `POST /orders/verify`                             | Ответ `202`; проверить только уже известный провайдеру платёж, без нового CREATE |
| `POST /operations/:id/recover`                    | Закрыть неопределённость по durable proof или tombstone                          |

Точные DTO — `src/billing/billing.contract.ts`, публичная валидация —
`billing.validation.ts`. Финансовые команды используют UUID v4 `commandId`,
совпадающий `Idempotency-Key`, ожидаемые версии Billing/policy/period/order
по типу команды. Actor, цена и capacity fence не принимаются от браузера.
Recovery принимает только `schemaVersion:1` и `workspaceId`; UUID берётся из
пути. После неопределённого ответа нельзя подменять исходную команду новой.

Access до вызова Billing фиксирует actor/workspace/request-bound операцию и
fence под тем же workspace lock, что admission. UUID остаётся в общем
namespace `crm_team_command_receipts`. Допустимое число мест — минимум
свежего `Billing seatLimit`, последнего подтверждённого локального лимита и
pending target. Уменьшение ниже `1 + enabled CRM members` отклоняется под этим
же lock: параллельное принятие приглашения не обходит уменьшение квоты.
Billing синхронно меняет собственный период; общей БД или распределённой
транзакции нет.

Сетевой сбой, `404` и истечение времени не освобождают fence.
`POST recover` для ещё не начатого UUID создаёт `NOT_STARTED` tombstone,
запрещающий поздний запуск; для известной операции получает Billing proof
либо вызывает закрытие с `CANCELLED` tombstone. Уже отправленный неизвестный
платёж остаётся `PENDING`, а не объявляется отменённым. Оплаченный во время
Trial `SCHEDULED` период удерживает fence до начала PAID. Техническое
сохранение доказанного результата не требует CRM business-write; выдача
этого результата человеку всё равно требует свежего owner-доступа.

Access → Billing использует `BILLING_INTERNAL_BASE_URL`, существующий
`BILLING_CRM_ACCESS_TOKEN` и закрытый prefix
`/internal/v1/crm-access/billing/commerce`. Обратный вызов Billing —
`POST /internal/v1/crm-access/billing/authorize-operation`, отдельная пара
`BILLING_CRM_ACCESS_COMMERCE_TOKEN`, `x-winwidget-service: billing` и
`x-winwidget-internal-token`. Проверяется точная связь workspace, actor,
command, request hash, fence revision и target seats, включая актуальную
последнюю COMMITTED операцию для renewal. Подмена токена даёт
`SERVICE_AUTHORIZATION_FAILED`, отозванная бизнес-авторизация —
`OPERATION_AUTHORIZATION_REVOKED`; временная неопределённость не объявляется
отзывом. Endpoint не публикуется на Gateway и требует реальный loopback peer
за private HTTPS ingress, без доверия forwarded headers.

В worker включён независимый технический reconciliation каждые 5 секунд:
до 25 due операций по индексированному PostgreSQL `next_check_at`, группами
по 5. Он только перечитывает Billing proof и сохраняет результат по CAS,
не создаёт/закрывает платежи. Следующая проверка записывается и после ошибки,
чтобы один недоступный workspace не блокировал остальные. Admission и BFF
также синхронизируют pending fence; освобождение создаёт собственный
transactional Outbox wake для ожидающих сотрудников.

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

Отдельный `GET options?workspaceId=…&page=1&pageSize=20&selectedId=…`
возвращает только `{id,name}` доступных для входящих обращений отделов.
Матрица: OWNER/CRM_ADMIN — все собственные активные отделы;
TEAM_LEAD/MANAGER — только текущие `teamIds` серверной авторизации;
ANALYST, отключённый сотрудник и чужой workspace — отказ. Чтение доступно
при READ_ONLY, но не разрешает изменения. Административные списки и команды
сохраняют прежние права, новая ручка их не заменяет.

Ответ: `schemaVersion:1`, `workspaceId`, `subject`, `page`, `pageSize`,
`total`, `items:[{id,name}]`, `selected:{id,name}|null`.
Необязательный `selectedId` — UUID v4, проверяемый тем же фильтром доступа:
имя выбранного отдела доступно и на другой странице; для чужого, архивного
или недоступного ID возвращается `null`, без раскрытия существования.
Страница, количество и выбранное имя читаются в одном Repeatable Read
snapshot CRM Access. Заголовок — `Cache-Control: no-store`.
Lookup ничего не записывает и не публикует RabbitMQ events. Команды Intake
по-прежнему получают UUID и независимо перепроверяют доступ на сервере.

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
пока **все изменения команды** запрещены в `READ_ONLY`. Исключение для безопасного
отзыва не включено без отдельного решения владельца продукта.

Приглашение создаёт Access intent с ролью/командами и TTL до 7 дней.
Worker идемпотентно создаёт Identity invitation. Принятие ссылки требует
активной сессии с точным подтверждённым EMAIL: Identity атомарно создаёт
обычный MEMBER и событие `identity.wincrm.invitation-accepted.v1`, затем
Access сохраняет admission. Обычный Identity MEMBER сам по себе не выдаёт
права WinCRM или Widgets. JWT и email не попадают в admission events.

Допуск проверяет свежие Identity/Billing/CRM-права и атомарно использует
квоту workspace: `1 + enabled CRM members <= effectiveAdmissionCeiling` с
учётом свежего Billing и локальных финансовых fences. Минимум 2
включает владельца; новый Trial по умолчанию получает 2 места вместе с владельцем.
Лимит берётся из опубликованной Billing policy (настраивается от 2); начатые
Trial сохраняют исходный snapshot, в том числе ранее выданные 5 мест. Pending и disabled
не занимают места. Очередь FIFO по durable sequence; `enable` лишь создаёт
WAITING admission и не обходит ранее принятые приглашения. Revoke выигрывает
у позднего acceptance event. Изменение платной квоты выполняется через BFF и
Billing; подтверждённое освобождение capacity fence пробуждает очередь.

Подтверждённые email и резервное имя берутся только для текущей страницы через
закрытый Identity member-directory, без телефонов, provider IDs или глобального
справочника. Заполненное ФИО своего workspace имеет приоритет над Identity
displayName. Несовпадение membership/subject или недоступность Identity
закрывают страницу с `503`; имена не выдумываются. Shape прежнего `members`
и командных ответов не меняется.

### ФИО сотрудника

`GET /api/v1/crm/access/team/profiles?workspaceId=…&subject=…` читает один
workspace-local профиль. Без `subject` — профиль текущего актора.
`POST` того же пути принимает `schemaVersion:1`, `commandId`, `workspaceId`,
`subject`, `expectedVersion` и `profile:{firstName,lastName,middleName?}`.
`Idempotency-Key` совпадает с `commandId`. Версия `0` создаёт отсутствующий
профиль, последующие изменения требуют текущую версию. Конкурирующее
изменение возвращает `409`; точный повтор возвращает прежний результат.
Ответ: `schemaVersion:1`, `workspaceId`, `subject` актора, `targetSubject`,
`profile:null|{id,firstName,lastName,middleName,version,updatedAt}`.
Чтение/запись возвращают `Cache-Control:no-store`.

Матрица: все действующие CRM-роли читают/изменяют собственное ФИО;
READ_ONLY разрешает только чтение. OWNER изменяет ФИО всех действующих
участников. CRM_ADMIN читает команду, изменяет своё ФИО и профили
TEAM_LEAD/MANAGER/ANALYST, но не владельца/других CRM_ADMIN.
TEAM_LEAD/MANAGER/ANALYST не получают административный справочник и
не изменяют чужое ФИО. Свежий Identity/CRM-допуск проверяется для актора
и чужой цели; локальный disabled/role повторно проверяется в транзакции.
Профиль владельца не требует фиктивной строки CRM-member и не занимает
дополнительное место. Лимит каждого поля 100 символов, отчество необязательно;
имя/фамилия передаются раздельно, а не угадываются из произвольной строки.

`POST team/invitations` дополнительно принимает необязательный `profile`
того же формата. Старый запрос без поля сохраняет прежний hash/семантику.
ФИО хранится только в Access intent и становится профилем в транзакции
успешного admission; pending/revoked не создают профиль. Повтор admission
и повторное включение сотрудника не переписывают заполненное ФИО.
Identity account и membership не изменяются этим функционалом.
Профиль и минимальный audit (только версии, без копий ФИО) фиксируются
синхронно вместе с command receipt; новый RabbitMQ event для быстрого
редактирования имени не нужен. Приглашения сохраняют прежние Outbox/events.

Перед включением полей на frontend применить миграцию профилей, выдать
runtime только SELECT/INSERT/UPDATE новой таблицы и выпустить API/worker
CRM Access одной совместимой ревизии. Старый worker игнорирует новые имена;
не включать новые приглашения при mixed Access revisions. Миграция не
изменяет старые имена, membership и назначения задач.

## Worker, publisher и PostgreSQL

`CRM_ACCESS_PROCESS_ROLE=api|worker|outbox-publisher` задаёт соответственно
порты `5300|5301|5302`. Все роли используют один service-owned image/schema;
worker/publisher не регистрируют бизнес-контроллеры. API не подключается к
RabbitMQ. Для фоновых ролей обязательны `RABBITMQ_URL` и точное
`RABBITMQ_CONNECTION_NAME=winwidget-crm-access-<role>`.

`CRM_ACCESS_RABBITMQ_ASSERT_TOPOLOGY=false` отключает declarations/bindings
worker, в том числе при reconnect. Он получает только read на три основные
очереди, без configure/write или доступа к DLQ; отсутствие очереди блокирует
готовность, а не создаёт её с расширенными правами. Publisher не объявляет
топологию при любом значении флага. Значения кроме `true|false` отклоняются
до подключения к брокеру. Для совместимости отсутствие флага означает `true`
(как прежние локальные запуски); отдельный CRM Compose требует ровно `false`.
До запуска controller должен создать exchanges, шесть durable queues и
точные bindings, приведённые ниже. Флаг не заменяет broker ACL.

Три независимых consumer очереди: `winwidget.crm-access.team.provision`,
`.acceptance`, `.admission`; routing keys соответственно
`crm.access.invitation-provision.v1`, `identity.wincrm.invitation-accepted.v1`,
`crm.access.admission-wake.v1` в `winwidget.events`. У каждой собственные
`.dead-letter` и manual route `crm-access.team.<consumer>` в
`winwidget.manual-retry`. Повторы 30s/300s/1800s планируются через
`CrmTeamOutbox.availableAt` в одной транзакции с receipt; до этого срока
publisher не захватывает запись. Доставка сразу в основную consumer queue
требует confirm/mandatory, без промежуточных TTL → DLX очередей.

Новый worker не создаёт `.retry.1|2|3`; старые очереди автоматически не
удаляются. Publisher переводит только неопубликованные legacy `winwidget.retry`
записи в direct manual route под своим CAS-lease, сохраняя message ID,
payload, headers и срок не раньше `max(createdAt + retryDelay, availableAt)`.
PUBLISHED не сбрасывается: старый confirm TTL queue не доказывает последующий
DLX republish. Перед совместным rollout исключить mixed revisions,
сверить старые queues/receipts/Outbox и обеспечить проверенный drain/recovery.
Свежая установка CRM не требует создания legacy retry queues.

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
`SELECT,INSERT,UPDATE` на `crm_workspace_access`, `crm_workspace_members`, `crm_employee_profiles`,
`crm_teams`, `crm_invitation_intents`, `crm_admissions`;
`SELECT,INSERT,UPDATE` на `crm_billing_capacity`, `crm_billing_operations`;
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

Отдельный opt-in профиль `local-wincrm-stack.mjs --backend-only
--verify-team-http --smoke-and-stop` запускается из корня services с
`WINCRM_LOCAL_STACK_ALLOW_MUTATION=true`. Нужны собственные четыре scoped
RabbitMQ principals в одном loopback test-vhost на `127.0.0.1:5673`:
`CRM_ACCESS_TEAM_HTTP_TEST_{PROVISIONER,WORKER,PUBLISHER,IDENTITY_PUBLISHER}_RABBITMQ_URL`.
Профиль создаёт три отдельных тестовых аккаунта и реальный Trial через HTTP,
без прямого seed memberships/admissions. Приглашения проходят Access Outbox,
Rabbit push consumer и внутренний Identity HTTP; принятие — публичный Identity
HTTP, Identity Outbox и Access acceptance/admission consumers. Проверяются
два места вместе с владельцем, отсутствие расхода места у pending/disabled,
FIFO при конкурентном принятии двух приглашений на последнее место,
повтор HTTP/Rabbit события и очередь повторного включения. Для наблюдаемого
пересечения consumers тест кратко удерживает настоящий workspace advisory
lock только в своей БД; production-методы и contracts не подменяются.
Identity email delivery выключена; токены остаются в памяти, credentials —
только в private fixture. Профиль нельзя смешивать с direct-seed/Widgets,
Billing или domain fault profiles. Он доказывает built dist HTTP/PG/Rabbit,
но не release images, отправку email, браузерные сценарии или production.
Собственные подключения закрываются тестом; wrapper локальной проверки
удаляет только свои БД/роли и Rabbit container/vhost, сохраняя общий PG.

Для настоящей интерактивной браузерной проверки отдельно запускается
`WINCRM_LOCAL_STACK_ALLOW_MUTATION=true node apps/crm-access/test/integration/local-wincrm-stack.mjs --browser-team`
из корня services. Этот режим несовместим со всеми остальными flags и не
изменяет `--verify-team-http`. Нужны тот же PG18 и четыре scoped
`CRM_ACCESS_TEAM_HTTP_TEST_*_RABBITMQ_URL` (передаются приватным wrapper через
env, не печатаются). Помимо API, Gateway и четырёх Next-приложений запускаются
настоящие built `main.js`: Access worker/publisher на 5301/5302 и Identity
publisher на 4902. Публикация — штатный Outbox lifecycle, доставка — Rabbit
push consumers; ручного `publishOne`, прямого seed CRM admissions или JWT нет.

Три новые обычные USER-персоны `browserOwner`, `browserInviteeA`,
`browserInviteeB` получают только собственные Identity workspaces. Пароли
случайные, email подтверждены только в изолированном fixture. Данные входа
сохраняются исключительно в `browser-fixture.json` с mode0600 под private0700
каталогом; не выводить файл, пароли или сессии в лог. Trial активируется кнопкой
в браузере, приглашения и пять CRM-ролей проверяются реальными UI-командами.
При Trial2 роли проверяются последовательно, без увеличения квоты. Сохраняется
обычный лимит входа 10/IP/600 секунд: не сбрасывать его ради проверки.
Стартовый preflight выполняет только анонимные GET и не расходует login slots
(`startupLoginRequests=0`); старый административный smoke в этом режиме не идёт.
Только этот локальный профиль задаёт `connection_limit=3` для owner clients
(до 27 соединений девяти runtime-процессов и два read-only observer clients);
это ограничение fixture, не измеренный production capacity budget.

Нужны свободные loopback-порты 3000/3001/3002/3003/3100/4100/4800/4900/4902/
5300/5301/5302/5310/5320/5330, PG55440 и Rabbit5673. Standalone frontend mirror
использует development-режим; production release gate не изменяется. Emails,
SMS, Telegram и реальные платежи выключены. Проверка здесь не запускает Docker
сама и не подтверждает браузерный результат лишь по readiness.

При работающем `--browser-team` доступен отдельный HTTP companion:

```bash
WINCRM_LOCAL_STACK_ALLOW_MUTATION=true node apps/crm-access/test/integration/local-team-runtime.mjs /exact/private/browser-fixture.json
```

Он использует другие свежие fixture-персоны `owner`, `manager`, `teamLead`,
не изменяя аккаунты браузерного сценария. Три входа проходят обычный Identity
HTTP и расходуют реальные login slots. Все изменения — публичные команды
через Gateway; workers/publishers уже работают отдельными `main.js`, без
композиции классов, `publishOne`, JWT signing или seed бизнес-таблиц.
Проверяются конкурентное принятие на последнее место, настоящий PostgreSQL
lock у двух push handlers, FIFO, отключение/повторное включение, пять ролей,
OWN/TEAM/ALL контактов и компаний, запрет чужого workspace в трёх доменных
сервисах, ограничения аналитика и CAS/replay смены роли. PostgreSQL observer
только читает результат и кратко удерживает тестовый advisory lock.
Private `team-runtime-started.json` запрещает повторный запуск на частично
изменённой персоне; после ошибки нужен новый изолированный стенд, не удаление
marker. `team-runtime-result.json` не подтверждает браузер, email, Docker
images или WIDGET snapshots; cleanup остаётся обязанностью wrapper.

SIGINT/SIGTERM/SIGHUP закрывают собственный browser ingress, ждут durable
Outbox/receipt drain, затем graceful exit своих background-процессов. Только
после выхода consumers проверяются пустые очереди без consumers (pre-stop
`messageCount` не доказывает отсутствие unacked). Force-kill отсутствует;
timeout/ошибка создаёт private `browser-team-shutdown.json` с
`preserveResources=true` и требует отдельного review. DB/роли, контейнеры,
images/cache и Colima очищаются отдельно по правилам workspace, не вслепую.

`pnpm run test:integration:billing` использует те же opt-in переменные и
изоляцию после применения миграции `20260906120000_crm_billing_capacity`.
Проверяет конкурентные admission/уменьшение мест, durable fence, replay,
неопределённость Billing, scheduled release, tombstone, rollback и ACL.
Unit/HTTP, typecheck, lint и build выполняются отдельно: `pnpm test`,
`pnpm typecheck`, `pnpm lint`, `pnpm build`.

### Локальная репетиция двенадцати процессов на Docker-образах

Из корня services на пустом локальном Docker context `colima`:

```bash
WINCRM_IMAGE_REHEARSAL_ALLOW_MUTATION=true node apps/crm-access/test/integration/local-crm-image-topology.mjs --run
```

Образы собираются из `git archive HEAD:apps/<service>`: ignored env и
неотслеживаемые исходники не попадают в image. Создаются четыре независимые
PostgreSQL 18 с отдельными паролями, migration/runtime ролями и namespace
guard. Миграции выполняются CLI из соответствующего образа, не с хоста.
Все 12 runtime-процессов используют точные image IDs, production-mode,
loopback HTTP и пулы 5/4/1 (API/worker/publisher), всего 40 подключений.
Pairwise credentials не передаются сервисам, которым они не принадлежат.

Отдельный тестовый RabbitMQ имеет восемь независимых runtime principals:
publishers не получают consumer/DDL права, все workers — publish/DDL права.
Топология Access и Intake создаётся отдельным provisioner до старта ролей;
Access worker имеет read только на три основные очереди, не на DLQ/exchanges.
Брокер намеренно выключен при запуске процессов: восемь background roles
должны завершиться с ошибкой и автоматически перезапуститься. После запуска
брокера проверяются health всех ролей, image/revision, 12 пустых очередей,
шесть push consumers, четыре database IDs и текущие pool connections.
Повторное выключение брокера в работающей системе должно вернуть readiness
503 у восьми фоновых ролей и сохранить 200 у четырёх API. После восстановления
брокера все роли и шесть push consumers должны восстановиться без перезапуска
application processes. Обычный SIGTERM проверяется отдельно: exit 0 всех ролей,
нет queued/unacked сообщений. Итоговый `result.json` публикуется атомарно только
после graceful shutdown и удаления собственных containers/volumes.
Профиль не создаёт аккаунтов,
бизнес-команд или внешних отправок, не изменяет production env и не обращается
к VPS. Успех удаляет только собственные containers/volumes; ошибка сохраняет
их вместе с private ownership metadata для разбора. После окончания действует
общая обязательная очистка локальных images/cache и остановка Colima.

Локальная репетиция 06.09.2026, run `992e301405`, на точных образах
`8ac43fbd1b989bf96f623b98bf90ab7eff52f3ef` прошла для всех 12 ролей и четырёх
PostgreSQL. Access worker с `CRM_ACCESS_RABBITMQ_ASSERT_TOPOLOGY=false`
и без configure/write восстановил три push consumers. При позднем старте
RabbitMQ все восемь фоновых процессов завершились с ошибкой и перезапустились;
четыре API не перезапускались. При повторном outage readiness фоновых ролей
стала 503, затем все роли восстановились без новых process restarts.
После graceful shutdown шесть consumer queues и шесть DLQ пусты,
собственные контейнеры/volumes удалены. Это не проверка доставки приглашений,
отложенных бизнес-повторов, браузера или целевой production capacity.

Это доказательство холодного старта, **не capacity PASS** и не сквозная
передача реальных заявок. Защитные лимиты стенда (384 MiB/process,
256 MiB/PostgreSQL, 512 MiB/RabbitMQ) не являются production-рекомендацией.
Idle statistics не заменяют burst/экспорт, рост соседних сервисов, CPU p95,
WAL/disk/connection измерения и проверки native/acceptance workflows.

### Команда и database-delayed retry на настоящих образах

```bash
WINCRM_LOCAL_STACK_ALLOW_MUTATION=true node apps/crm-access/test/integration/local-wincrm-stack.mjs --backend-only --verify-team-images --smoke-and-stop
```

Это отдельный профиль: флаги активации, прямого CRM seed, Widgets и прочих
проверок с ним несовместимы. Нужен тот же локальный `wincrm-mvp-postgres18`
на loopback `55440`, других контейнеров быть не должно. Семь API images
(Identity, Billing, четыре CRM, Gateway), Access worker/publisher и Identity
publisher запускаются из точного HEAD. Шесть логических БД имеют отдельные
migration/runtime роли, но разделяют один тестовый PostgreSQL; это не
production-shaped capacity proof. RabbitMQ topology создаёт provisioner;
три независимых runtime principals не имеют configure permission.

Обычные HTTP login/Trial/template/invitation/acceptance проходят общий
сценарий `local-team-runtime.mjs`: Trial 2 с владельцем, pending без места,
конкурентное занятие последнего места, FIFO, disable/re-enable, все пять
CRM-ролей, OWN/TEAM/ALL и запрет доступа в другое workspace. Отдельное
свежее workspace проходит outage Identity/Billing последовательно для
`provision`, `acceptance`, `admission`. Наблюдаются receipt и retry Outbox,
проверяются неизменные payload/token/messageId и реальная 30-секундная
задержка после остановки/запуска Access worker/publisher и RabbitMQ.
Повтор committed events под scoped publisher credentials не должен
создавать новых приглашений/admission/membership или изменять receipts.
До и после replay проверяется стабильное завершение обоих service-owned
Outbox, всех team receipts и шести RabbitMQ queues. Пустой broker без
проверки PostgreSQL недостаточен: admission создаёт следующий FIFO wake
в транзакции, а publisher может отправить его позже.
Скрипт не создаёт host-экземпляры business workers и не меняет таблицы
CRM для имитации бизнес-команд. Email/внешние провайдеры отключены.

`team-images-result.json` появляется только после успешного сценария,
пустых шести очередей, graceful shutdown и удаления собственных image
контейнеров. Общий тестовый PostgreSQL и images/cache требуют отдельной
обязательной очистки. Браузер, реальные оплаты, целевая topology и capacity
остаются самостоятельными release gates; наличие профиля не означает PASS.

Локальный прогон 06.09.2026 `5b6798d104` на точной ревизии
`709967cb82be429961f8f84c6006464d64abae9a` завершился успешно:
обычные HTTP-команды приглашений, конкурентный последний seat, FIFO,
disable/re-enable, все пять ролей и межпространственный запрет;
три отдельные реальные 30-секундные retry для provision/acceptance/admission
с сохранением deadline/payload/messageId после остановки и запуска
dependency, Access worker/publisher и RabbitMQ. Повтор каждого завершённого
события дважды не изменил invitation/membership/admission/receipt snapshots.
Зафиксированы graceful exit и удаление собственных контейнеров. Семь API
images и три background processes использовали шесть логических БД на одном
локальном PostgreSQL 18, а не четыре production PostgreSQL instances.
После прогона отдельно удалены шесть синтетических БД, 12 ролей,
тестовый PostgreSQL/volume, все локальные images/cache; Colima остановлена.
Этот PASS не закрывает браузер, email, внешние платежи, Intake widget-control,
целевые production credentials/topology или нагрузочную capacity-проверку.

### Native Widgets → Inbox на настоящих API/worker/publisher images

Отдельный неинтерактивный профиль из корня services:

```bash
WINCRM_LOCAL_STACK_ALLOW_MUTATION=true node apps/crm-access/test/integration/local-wincrm-stack.mjs --backend-only --activate-owner --with-widgets --verify-native-images --smoke-and-stop
```

Нужен только предварительно проверенный локальный `wincrm-mvp-postgres18`
на loopback `55440` в `colima`; другие контейнеры запрещены. Профиль строит
восемь образов из точного Git HEAD: Identity, Billing, Widgets, четыре CRM
API и Gateway. Изменённые runtime inputs запрещены; ignored env не попадают
в build context. Семь **логических** тестовых БД имеют собственные
migration/runtime роли; миграции запускаются из образов. Этот профиль
использует один общий тестовый PostgreSQL с trust authentication и поэтому
не заменяет отдельную проверку четырёх production-shaped PostgreSQL.

Бизнес-команды выполняются только HTTP-запросами к настоящим образам в
production-mode. Отдельно запускаются четыре Intake widget-control/transfer
worker/publisher и Widgets publisher, затем два acceptance worker/publisher;
RabbitMQ имеет семь независимых
scoped principals, confirm/mandatory и собственные durable очереди.
Prisma на хосте используется для synthetic fixtures и наблюдения, не для
подмены worker/processor/publisher. Тестовая EASY подписка не является оплатой.

Перед передачей заявок все шесть команд подключения проходят отдельный
outage Widgets API. Подтверждённые исходные события обрабатывает настоящий
Intake worker; publisher остановлен, чтобы наблюдать шесть новых retry
Outbox с неизменным event/command binding и реальной задержкой пять секунд.
Остановка и запуск worker/publisher/RabbitMQ не должны менять payload,
eventId или availableAt. После восстановления зависимости проверяются
publication не раньше deadline и синхронизация источников.
Повтор уже применённых событий под реальными scoped publisher credentials
не изменяет полные snapshots jobs, receipts, Outbox, источников,
Widgets connectors и command receipts. Наличие этого сценария не означает
PASS до атомарного итогового результата всего прогона.

Для проверки scope создаётся явная синтетическая membership владельца и
одного сотрудника (2/2 места, квота проверяется через Access API). Это не
доказательство приглашения/admission. Три источника подключает OWNER, три —
CRM_ADMIN; все относятся к одному отделу. Изменения CRM-роли и отделов
выполняются versioned HTTP-командами. После естественного окончания подписки
Widgets и остановки Widgets API проверяются OWN/TEAM, немедленный отзыв доступа
к чужим записям отдела, запрет PII для ANALYST и чтения между workspace.
Все JWT остаются только в памяти проверочного процесса.

Сценарии: шесть явных подключений и публичных заявок, immutable snapshots
и чтение Inbox, повтор событий без дублей, обязательный возврат unroutable
сообщения и восстановление Outbox, отключение/повторный запуск RabbitMQ,
SIGKILL точного consumer во время PROCESSING с последующим CAS/lease recovery,
реальные интервалы retry 5/30/120 секунд при недоступном Widgets API,
исчерпание retry в DLQ и versioned HTTP-retry через новый transactional
Outbox, replay и отказ устаревшей версии. Короткая синтетическая подписка
действует восемь минут: тест дожидается её естественного окончания,
не изменяя часы, первоначальный deadline или immutable snapshots.
Проверяются явное отключение источника, expiry fence ожидающей заявки
и чтение всех шести ранее принятых snapshots при остановленном Widgets API.
Шесть независимых корректных команд подключения должны завершаться
автоматически: тест не маскирует `CONTROL_CONFLICT` новой ручной командой.
Истощение кратких повторов сериализации Widgets возвращает `503`, сохраняя
исходную команду для database-delayed retry Intake; реальные конфликты
версии/привязки и persistent unique conflict остаются `409`.
Проверяются все фактические retry publications и immutable command binding.
Reporting представлен отдельной
наблюдательной очередью, а не запущенным сервисом Reporting.

После завершения native delivery её пять фоновых процессов останавливаются.
На тех же API images отдельно проверяется принятие шести безымянных WIDGET
заявок с явно подтверждёнными именами: durable acceptance Outbox → RabbitMQ →
отдельный worker → контакты/сделки/первые задачи. Недоступность Customers должна
сохранить retry в PostgreSQL с настоящим 30-секундным интервалом; перезапуск
publisher/worker и брокера не изменяет срок и не теряет задачу. Ожидание
восстановления допускает второй штатный повтор через пять минут без ускорения
часов. При ошибке до удаления контейнеров сохраняются только allowlisted
диагностические коды и метаданные процессов, без сырых логов и credentials.
Повтор HTTP
команды и broker redelivery не создают дублей. Седьмая заявка связывается с
существующим контактом без изменения его имени; передача имени в таком выборе
отклоняется. Исходные записи остаются безымянными, snapshots не перезаписываются.

Успешный private `native-images-result.json` создаётся атомарно **после**
exit 0 всех процессов и удаления собственных контейнеров/анонимных volumes.
Shared PostgreSQL, его тестовые БД/роли и images остаются для общей обязательной
локальной очистки; чужие ресурсы не удаляются. `browser-fixture.json` не
заменяет итоговый результат. Профиль не доказывает production capacity,
пользовательский браузер, OWN/TEAM UI, приглашения и внешние платежи.
Контрактные unit-тесты в CI не запускают Docker workflow и не доказывают
успех этих реальных fault-сценариев.

Проверка 06.09.2026 `00250ca2f4`: полный профиль завершился с exit 0,
runtime images и драйвер — точная ревизия
`5efcaa5037ddd3c5b4bcb83db4a62f52daef634e`. Все шесть исходных команд
подключения восстановились автоматически, без нового ручного commandId:
четыре после первого delayed retry и две после второго. Восемь retry
publications сохранили исходные payload/eventId и deadlines; replay всех
шести исходных и применённых retry событий не изменил snapshots.
Итоговый атомарный отчёт подтвердил восемь API images, семь фоновых
процессов, шесть типов native-заявок, OWN/TEAM/ALL и межпространственную
изоляцию, семь завершённых acceptance workflows без дублей после повторных
HTTP-команд и событий. Подтверждены естественное окончание Widgets-подписки,
отзыв источника, broker outage, crashed claim, mandatory return,
transfer DLQ/manual retry и delayed acceptance retry с перезапуском брокера
и процессов. Browser, invitation admission, внешние платежи и production
capacity этим прогоном не проверены: семь логических БД работают на одном
локальном PostgreSQL, а не на четырёх production instances.
После результата отдельно удалены семь синтетических БД, 14 ролей,
тестовый PostgreSQL/volume, 23 локальных образа и build cache;
проверены нулевые остатки контейнеров/images/cache/осиротевших anonymous
volumes, Colima остановлена. Production этим прогоном не изменялась.

Наличие этих контрактов не означает готовность paid production. Обязательны
отдельные интеграционные проверки реальных сервисов/PG/Rabbit, rollout
миграций и scoped ACL, private ingress и токенов, а также согласованные
провайдерские и продуктовые release gates. Тестовый provider не доказывает
реальное списание или фискализацию; актуальный остаток — в `docs/backlog.md`
корня services-репозитория.
