# Сервис Operations

Сервис Operations владеет операционной плоскостью управления WinWidget,
использует собственную БД и только актуальные service-owned HTTP/event
контракты. Готовность определяется доступностью собственной БД, RabbitMQ и
включённых для роли workers без внешних import/bootstrap-маркеров.

## Ответственность

- Агрегированный журнал событий администратора.
- Объединённые admin alerts из Billing и Widgets, а также собственные alerts
  Operations.
- Объединение обзора сообщений, ошибок, retry и close.
- Операционные настройки Telegram и администрирование резервных копий баз
  данных.
- Надёжные ежедневные и ручные задания резервного копирования, которые
  выполняет только maintenance worker.
- Управление и выполнение восстановления баз данных только для DEV.
- Резервирование и подтверждение политики расписания Reporting.
- Operations Outbox, квитанции доставки, heartbeat и health с учётом ролей.

Все зависящие от PostgreSQL публикации записываются в `OutboxEvent` в одной
транзакции с изменением состояния. Workers получают сообщения RabbitMQ через
`basic.consume`; надёжные задания захватываются с помощью CAS lease PostgreSQL.

## Роли процессов

Для каждой роли один раз запускается один и тот же образ:

| `OPERATIONS_PROCESS_ROLE` | Порт по умолчанию | Ответственность                                                |
| ------------------------- | ----------------: | -------------------------------------------------------------- |
| `api`                     |              5200 | Публичные/admin/внутренние HTTP-контракты и постановка restore |
| `worker`                  |              5201 | Consumers, scheduler, backup и Ed25519 provenance sidecar      |
| `outbox-publisher`        |              5202 | Публикация transactional Outbox с confirms/mandatory returns   |
| `restore-worker`          |              5203 | Только привилегированное выполнение восстановления баз данных  |

Бизнес-контроллеры регистрирует только `api`. Каждая роль предоставляет
`/health/live` и `/health/ready`; API дополнительно владеет
`/api/v1/health/deployment` и доступным только ADMIN
`/api/v1/health/admin`.

## HTTP-контракты

Публичные маршруты сохраняют существующие пути Gateway под `/api/v1`:

- `GET /admin-alerts`
- `GET /messaging/admin/overview`
- `GET /messaging/admin/failures`
- `POST /messaging/admin/failures/:id/retry`
- `POST /messaging/admin/failures/:id/close`
- `GET|PATCH /telegram-bot/admin/settings`
- `POST /telegram-bot/admin/database-backups/:target/send`
- `GET /telegram-bot/admin/database-backups/overview`
- `GET /telegram-bot/admin/database-backups/jobs`
- `GET /telegram-bot/admin/database-backups/:target/jobs/active`
- `GET /telegram-bot/admin/database-backups/:target/jobs/:jobId`
- `GET /dev-tools/database-restores/settings` и
  `GET /dev-tools/database-restores/jobs/:jobId` — ADMIN и DEV (read-only)
- все permit/upload/cancel/recovery mutation под
  `/dev-tools/database-restores/*` — только DEV

Внутренние маршруты без публичного префикса:

- `GET /internal/v1/identity/users/:userId/admin-events/overview`
- `PUT /internal/v1/operations/reporting/schedule-policy`
- `POST /internal/v1/operations/reporting/schedule-policy/confirm`

Федерация всегда передаёт `x-winwidget-service: operations` и отдельный
`*_OPERATIONS_TOKEN`. Billing использует
`/internal/v1/operations/billing/*`, а Widgets —
`/api/v1/internal/v1/operations/widgets/*`. URL сервисов должны быть точными
закрытыми HTTP origins без встроенных путей или учётных данных.

## Удаление административного Backlog

Миграция `20260910110000_remove_admin_backlog` удаляет только
`operations.notes` и копии задач в `operations.admin_event_logs`, отмеченные
разделом `BACKLOG`, типом `backlog_task` или одним из трёх действий
`BACKLOG_TASK_CREATE/UPDATE/DELETE`. Общий журнал, RabbitMQ receipts/Outbox,
данные CRM и технический `docs/backlog.md` не удаляются. Notes API больше
не регистрируется. Миграция не расширяет права runtime и не меняет защитные
функции восстановления.

Перед применением нужен service-owned safety backup Operations и остановка
старого API writer. Миграцию выполняет только migration role, затем запускается
новая ревизия; Gateway route `/api/v1/notes` удаляется согласованным rollout.
`DROP ... RESTRICT` блокирует удаление при неожиданной зависимости, timeout
откатывает всю транзакцию. Возврат к Notes-capable runtime без отдельно
согласованного восстановления не поддерживается. Исторические резервные копии
подчиняются прежнему retention; эта миграция их не удаляет.

## Контракты RabbitMQ

Operations публикует в `winwidget.events`:

- `operations.scheduled-job.requested.v1`
- `operations.database-restore.requested.v1`
- `operations.database-restore.recovery-action.requested.v1`
- `operations.notification-routing.changed.v1`

Новые семейства очередей заданий:

- `winwidget.operations.scheduled-jobs.v1`, `.retry-v1`, `.dead-letter`
- `winwidget.operations.database-restore.v1`, `.retry-v1`, `.dead-letter`

Payload маршрутизации уведомлений имеет точный вид
`{ schemaVersion: 1, eventId, operationalAlertsThreadId, changedAt }`, тип
агрегата `telegram-bot-settings` и ID агрегата `singleton`.

## Настройка и база данных

Скопируйте `.env.example` в отдельный `.env.production` сервиса на VPS и
заполните секретами развёртывания. `.env.production` игнорируется Git. Оставьте
только переменные и отдельные scoped credentials, необходимые Operations.

Operations использует один глобальный `OperationsPrismaModule` и один пул
Prisma Client на процесс. Примените миграции до запуска новой ревизии:

```bash
pnpm prisma:generate
pnpm prisma:migrate:deploy
```

Runtime-образ фиксирует PostgreSQL 18 `pg_dump`, `pg_restore` и `psql`; его
Docker-сборка завершается ошибкой при расхождении major-версии dump/restore.
URL резервного копирования должны использовать read-only роли backup и
передаются только обычному worker. Для восстановления базы данных нет
административного URL-контракта: только `restore-worker` получает точные
`*_POSTGRES_ADMIN_USER`, `*_POSTGRES_PORT` и
`DATABASE_RESTORE_*_ADMIN_PASSWORD_FILE`. Host зафиксирован как `127.0.0.1`, а
имя каждой базы жёстко задано для соответствующего target. Файлы паролей — уже
существующие Docker secrets, смонтированные read-only ниже `/run/secrets`; ни
API, ни обычный worker их не получают.

Активный restore registry содержит семь целей: Notification Delivery,
Campaigns, Reporting, Widgets, Identity, Platform и Support. Billing исключён
до отдельного платёжного review, но продолжает получать плановые backup.
Operations исключён, потому что его self-restore удалил бы job, lease и
recovery evidence из той же схемы. Restore-worker не получает admin secrets
этих двух БД.

Для каждой из семи restore-целей `maintenance-worker` после `pg_dump`,
`pg_restore --list` и вычисления SHA-256 создаёт detached JSON sidecar
`<dump>.provenance.json` и отправляет его вторым Telegram-документом. Sidecar
содержит envelope версии 1, SHA-256 его canonical JSON и detached Ed25519
signature с domain `winwidget.operations.database-backup-provenance.v1`.
Evidence точно связывает
backup job ID, target, database/schema, исходное имя и размер файла, SHA-256,
время создания job и artifact, services/image revision, migration manifest и
версии `pg_dump`/`pg_restore`. Для Billing и Operations sidecar не создаётся:
они остаются backup-only targets и не могут быть источником этого restore
workflow.

Private PKCS8 PEM key и его active key ID получает только
`operations-worker` через read-only Docker secret. При старте worker проверяет,
что производный public key совпадает с key ID в tracked multi-key keyring
`restore-manifests/database-backup-provenance-public-keys.json`. API и
`restore-worker` имеют только этот public keyring внутри immutable image; они
не получают private key, backup URL или signing environment.

Docker Compose запускает только bootstrap entrypoint `operations-worker` с
UID 0 и минимальными capabilities `CHOWN`, `SETGID`, `SETUID`. Entrypoint
проверяет source secret как root-owned regular non-symlink `0600`, копирует его
в отдельный `tmpfs` через проверенный temporary-файл, атомарно устанавливает
runtime-копию `1001:1001`/`0400` и делает `exec gosu operations:nodejs`.
Приложение и health-check работают без root и не сохраняют capabilities;
остальные Operations roles никогда не получают root bootstrap или private key.

API монтирует с read-write-доступом только закрытый staging-каталог
`DATABASE_RESTORE_STAGING_DIR`. `restore-worker` монтирует staging для exact
claim/delete и отдельно worker-only `DATABASE_RESTORE_SEALED_DIR`; API и
остальные контейнеры sealed-каталог не видят. Оба host-каталога принадлежат
runtime UID 1001, имеют mode `0700`, не являются symlink и после canonical
`realpath` обязаны быть разными, не вложенными друг в друга и иметь разные
filesystem device+inode identity (bind aliases одного host-каталога запрещены).
Worker открывает
staging через `O_NOFOLLOW|O_NONBLOCK`, проверяет regular-file и exact size,
копирует из открытого file descriptor в новый `0600` temporary sealed-файл,
одновременно пересчитывает approved SHA-256, выполняет file `fsync`, atomic
rename и parent-directory `fsync`. Все TOC/ledger проверки и `pg_restore`
используют только sealed path, поэтому замена staging pathname после claim не
меняет исполняемые байты. Provenance trust gate реализован и не превращает
custom archive в sandbox: bootstrap-admin остаётся явно доверенной границей,
поэтому включение всё ещё требует exact-SHA production rehearsal и принятого
recovery runbook. `DATABASE_RESTORE_ENABLED` остаётся master kill switch и
передаётся одновременно API и restore-worker:
при `false` API отклоняет новые upload, а worker не claim-ит уже поставленные
`QUEUED` normal restore events и отправляет их через retry queue с bounded
TTL/backoff без лимита попыток. Signed terminal
reconciliation и recovery actions остаются доступны, чтобы безопасно закрыть
уже начатый инцидент. Сам флаг не разрешает постановку без остальных gates:
первый DEV создаёт десятиминутный one-shot permit через
`POST /dev-tools/database-restores/permits`, а второй DEV подтверждает его через
`POST /dev-tools/database-restores/permits/:permitId/approve`. Permit заранее
привязан к target, SHA-256 и размеру source dump, исходному backup job ID,
canonical provenance envelope SHA-256 и key ID, точному 40-символьному
services SHA, SHA-256 утверждённого migration manifest и серверному job ID.
При создании permit API проверяет Ed25519 sidecar и server-trusted manifest; при
upload повторно проверяет сохранённый sidecar, точное имя, размер и SHA-256
файла. Upload обязан передать server job ID как `requestId`; permit атомарно
переходит из `APPROVED` в `CONSUMED` в одной транзакции с job и Outbox и больше
не может использоваться.
Истёкшие permits закрываются автоматически, consumed permit закрывается в
terminal-транзакции job.
Во всей системе одновременно может существовать только один глобальный
`PENDING_APPROVAL`, `APPROVED` или `CONSUMED` permit; API settings поэтому
возвращает не список, а один approved permit либо `null`.

`GET /dev-tools/database-restores/settings` возвращает exact
`currentServicesSha` и server-trusted `migrationManifestSha` для каждой цели.
При отсутствии точного 40-символьного `APP_REVISION` settings завершается
fail-closed. Клиент передаёт `expectedServicesSha` при создании permit для
явной operator binding, но не передаёт `migrationManifestSha`: Operations
вычисляет его из зафиксированного в image manifest соответствующей цели.

Outbox publication не считается подтверждённой при постановке. Job API
возвращает фактические `publicationStatus` (`PENDING`, `PROCESSING` или
`PUBLISHED`) и `publicationConfirmed=true` только для `PUBLISHED`. Event payload
версии 3 повторяет source backup job ID, provenance envelope SHA-256/key ID,
expected services SHA и migration manifest SHA. Worker отклоняет сообщение до
доступа к source dump, если его текущий `APP_REVISION` не совпадает, provenance
binding расходится или target manifest устарел; после exact claim он заново
проверяет Ed25519 signature и все сохранённые artifact/job bindings до seal.
До safety backup и mutation worker read-only извлекает из custom
dump `_prisma_migrations` и требует точного набора успешных migration names и
Prisma SHA-256 checksums из trusted manifest. После restore тот же exact
контракт проверяется SQL-запросом к восстановленной ledger; неоднозначный,
неполный или слишком большой ledger всегда останавливает restore fail-closed.

Каждый `SUCCEEDED`, `FAILED`, `RECOVERY_REQUIRED` или `CANCELLED` переход в той
же PostgreSQL-транзакции закрывает permit и создаёт один terminal receipt.
Receipt содержит только hashes и operational identifiers, включая immutable
permit ID, requested/approved actor IDs и server timestamps dual approval, а
также source size, backup job ID, provenance envelope SHA-256/key ID. Receipt
подписывается HMAC SHA-256 отдельным ключом
`DATABASE_RESTORE_RECEIPT_HMAC_KEY_BASE64` с key ID из
`DATABASE_RESTORE_RECEIPT_HMAC_KEY_ID`; ключ не записывается в БД и не должен
попадать в логи. Ключ должен декодироваться минимум в 32 случайных байта.
UPDATE и DELETE receipt запрещены PostgreSQL trigger, поэтому без настроенного
ключа terminal transition завершается fail-closed.

Для `RECOVERY_REQUIRED` первый DEV выбирает ровно одно действие
`VERIFY_AS_IS`, `ROLL_BACK_SAFETY` или `ROLL_FORWARD_SOURCE` через
`POST /dev-tools/database-restores/jobs/:jobId/recovery-actions`, второй DEV
подтверждает его через endpoint `.../:actionId/approve`. Action привязан к hash
immutable initial receipt, exact services SHA и trusted migration manifest;
подтверждение в одной транзакции создаёт Outbox event. `VERIFY_AS_IS` проверяет
текущую базу без замены schema, `ROLL_BACK_SAFETY` восстанавливает exact safety
artifact, а `ROLL_FORWARD_SOURCE` — исходный exact source artifact. Оба
destructive варианта до mutation повторно проверяют SHA-256, TOC и migration
ledger. Все три действия выполняются только в `restore-worker` под CAS lease и
writer fence. После успеха immutable initial receipt не изменяется: создаётся
отдельный подписанный recovery receipt, а job получает `recoveryResolvedAt`.
Запрос и подтверждение recovery action доступны и при выключенном master kill
switch, чтобы аварийный workflow не зависел от разрешения новых restore jobs.

Изолированный worker использует
`RABBITMQ_CONNECTION_NAME=winwidget-operations-restore-worker` и получает
сообщения только из семейства очередей
`winwidget.operations.database-restore.v1`. Transient ошибка или занятый CAS
не создают hot-loop в main queue: исходный JSON `Buffer` публикуется с
publisher confirm и `mandatory` return-check в `winwidget.retry` по exact
routing key `operations.database-restore.requested.v1.retry.v1`, получает
30-секундный TTL и через DLX возвращается в main route. Исходное сообщение
подтверждается только после обеих проверок публикации; transport failure
оставляет его requeueable. Retry не имеет attempt cap, malformed event уходит в
DLQ без retry.

Одновременно разрешён ровно один глобальный `PROCESSING` restore, recovery
action или terminal reconciliation. Claim содержит event ID, lease token и
durable phase checkpoints
`PREPARING`, `FENCING`, `FENCED`, `SAFETY_READY`, `MUTATING`, `VERIFYING`,
`VERIFIED`, `UNFENCING` и `UNFENCED` (неприменимые phase пропускаются только по
явному state-machine contract). Потеря lease останавливает дочерний
PostgreSQL-процесс. Expired sweep сначала CAS-резервирует старый job/action,
затем физически повторно закрывает writer fence и только после подтверждения
фиксирует `RECOVERY_REQUIRED`/`BLOCKED`. Повторная
доставка не запускает destructive execution заново: просроченный claim до
mutation становится `FAILED`, а после mutation — `RECOVERY_REQUIRED` с
сохранёнными source/safety artifacts. Перед миграцией state machine таблица
restore jobs блокируется, а наличие legacy `QUEUED`, `PROCESSING` или `FAILED`
останавливает migration fail-closed. При неоднозначном результате terminal
commit redelivery сначала CAS-захватывает глобальный singleton как
`RECONCILIATION`, повторно проверяет signed terminal receipt и отсутствие
более нового неразрешённого `RECOVERY_REQUIRED` для target, затем сверяет exact
ledger/ACL и идемпотентно открывает роли. Старый terminal event никогда не
открывает target во время нового restore/recovery либо поверх более нового
incident. Source dump удаляется только после
подтверждённого terminal CAS; safety artifact успешного или разрешённого
recovery хранится ограниченное время (по умолчанию 168 часов, допустимо
24–720 через `DATABASE_RESTORE_ARTIFACT_RETENTION_HOURS`) и затем удаляется
отдельным cleanup sweep. Ошибка cleanup не повторяет restore, а legacy failure
без доказанной pre-mutation phase не попадает в cleanup. Каждый unlink
закрепляется `fsync` родительского каталога. Отдельный bounded sweep удаляет
только artifacts старше 24 часов с безопасным UUID filename после успешной
проверки Operations DB. Durable source/safety удаляются только по terminal/CAS
evidence существующего job; отсутствие job не доказывает rollback, потому что
enqueue transaction ещё может быть заблокирована или завершать неоднозначный
commit, поэтому no-DB `.dump` сохраняется fail-closed для ручной сверки.
Worker-only stale temporary sealed-файл удаляется у отсутствующего либо уже не
`PROCESSING` job. При недоступности DB любые orphan bytes сохраняются.

Restore принимает только custom archive, читаемый закреплённым PostgreSQL 18
`pg_restore`, в активном TOC которого есть ровно одна запись `SCHEMA` и она
точно соответствует выбранной service-owned schema и её migration owner.
Упоминания schema в `TABLE`, `COMMENT`, ACL или других записях не считаются;
multi-schema, структурно неоднозначные и превышающие безопасный TOC-лимит
архивы отклоняются до safety copy и любых destructive-команд.
Safety copy после закрытия pipeline синхронизируется через `fsync` для файла и
родительского каталога, затем повторно читается pinned `pg_restore --list` и
проходит тот же exact schema/owner TOC invariant. Только после этого фиксируются
`SAFETY_READY` и `MUTATING`.

До safety copy worker fail-closed сверяет из PostgreSQL catalog точные роли,
membership, database/schema/object owners, table/column/sequence/routine grants
и global/schema default ACL. Ровно один bootstrap-admin выбранной
service-owned PostgreSQL обязан быть `LOGIN + SUPERUSER`; другой LOGIN
SUPERUSER и membership к/от admin, migration, runtime или backup запрещены.
Bootstrap-admin — явно доверенная граница restore control plane: его password
file получает только exact single-replica `restore-worker`, а глобальный CAS
запрещает overlap. `CONNECTION LIMIT` не считается security barrier для
superuser. Writer fence не защищает от компрометации restore-worker или admin
secret и не должен так описываться. Migration/runtime/backup роли не могут быть
superuser, наследовать роли или входить в membership. После restore
worker в одной транзакции переключается на migration owner, отзывает известные
grants, восстанавливает точную runtime/backup матрицу, повторяет catalog-проверку
и только затем выполняет `COMMIT` и фиксирует `VERIFIED`. Для Platform разрешены
ровно восемь обычных таблиц, нет sequences и blanket runtime default grants;
runtime получает только явный table/column/function allowlist.

`operations-restore-worker` помечен `com.winwidget.singleton=true` и имеет
Compose `deploy.replicas=1`; ручной `docker compose --scale` для него запрещён.
Production deploy обязан проверить, что запущен ровно один контейнер с этим
singleton label, прежде чем передавать bootstrap-admin secrets.

Перед любой mutation worker под target-derived advisory transaction lock
записывает в admin-only PostgreSQL role setting SHA-256 exact immutable
operation ID, атомарно переводит runtime, migration и backup роли выбранной
цели в `NOLOGIN`, отдельной PostgreSQL-командой завершает
их активные sessions, а новой catalog snapshot проверяет отсутствие sessions,
prepared transactions и постороннего admin connection. ACL reconciliation в
режиме `FENCED` не возвращает `LOGIN`. Роли открываются только после повторной
exact manifest, ACL и fence verification, immutable signed release
authorization и durable `UNFENCING` checkpoint. Initial apply допускает только
ровно три `LOGIN` либо уже закрытые три `NOLOGIN` роли той же generation;
смешанное состояние отклоняется. Release и terminal reconciliation под тем же
advisory lock требуют exact operation marker, поэтому возобновившийся старый
процесс не может открыть роли поверх fence следующего job/action. До создания
signed release authorization любая ошибка после `FENCING` допускает
compensation reapply только после немедленного exact CAS renew текущего
execution lease. Reapply требует marker той же operation, никогда не
перезаписывает чужую generation и при потерянном lease вообще не выполняет
физическую команду. После создания authorization workflow, включая
restart/redelivery, может только идемпотентно
завершить разрешённый release и подписанный terminal receipt: возвращаться к
destructive mutation или compensation fence запрещено. Если pre-authorization
fence не подтверждён, job/action сохраняет маркер
`PHYSICAL_WRITER_FENCE_UNCONFIRMED`, а HIGH alert не утверждает, что роли
закрыты. Непосредственно перед mutation worker ещё раз
проверяет exact NOLOGIN roles, отсутствие writer/prepared/admin sessions,
единственность LOGIN SUPERUSER и отсутствие protected-role membership.

Для проверки свежих production backup без подключения к production-БД образ
Operations содержит внутренний CLI `pnpm rehearsal:restore-artifacts`. Он не
является альтернативным restore API и запускается только контроллером
`winwidget.ru_infra/scripts/run-isolated-restore-rehearsal.sh` в отдельном
PostgreSQL 18 с `--network none`. Runner требует ровно семь пар
dump/sidecar, UID/GID `1001:1001`, read-only mode `0400`, точный
`APP_REVISION`, встроенный public keyring и literal
`DATABASE_RESTORE_ENABLED=false`; наличие production target env приводит к
отказу. До первого restore копия каждого dump повторно проходит SHA-256,
TOC и migration-ledger проверки. Затем для каждой цели выполняются normal
executor и все три recovery executor с exact checkpoint sequence,
ACL/ledger/writer-fence verification. Временные роли, БД, пароли и рабочие
копии удаляются до выдачи `SUCCEEDED`; ошибка очистки делает весь запуск
неуспешным.

Этот isolated executor-level прогон доказывает пригодность подписанных
артефактов и destructive PostgreSQL-механики, но намеренно не доказывает
dual approval, permit → transactional Outbox → worker CAS/lease, signed
terminal/recovery receipts, restart/redelivery, retention и alerts. Эти
control-plane gates остаются отдельной production rehearsal и не позволяют
автоматически включить master kill switch.

Production restore остаётся выключенным до полного exact-SHA rehearsal свежей
подписанной пары dump/sidecar, проверки dual-approval, terminal/recovery
receipts, retention/alert evidence и отдельного операционного решения о
включении master kill switch. Реализация Ed25519 provenance не включает флаг
автоматически. Для ротации receipt key требуется сохранить
проверяемость receipts со старым key ID; до реализации keyring ключ нельзя
удалять или заменять без утверждённой процедуры. Первичное provisioning одного
случайного ключа не является rotation, но active key запрещено менять, пока
есть `PROCESSING` или неразрешённые `RECOVERY_REQUIRED`; будущая rotation
требует previous-key verification/keyring.

Ротация backup provenance выполняется только в порядке verify-before-sign:
сначала новый SPKI и key ID добавляются в tracked keyring и эта ревизия
развёртывается во всех verifier roles, затем меняются private key secret и
active key ID только у maintenance-worker. Старый public key сохраняется как
минимум до истечения retention всех пригодных backup и закрытия всех
permit/job/recovery evidence с этим key ID. Удаление public key раньше делает
соответствующие sidecar недоверенными fail-closed; private key никогда не
переносится в API/restore-worker. Forward-only migration provenance
останавливается при наличии любых legacy restore jobs, permits или terminal
receipts: unsigned evidence не переносится и не получает совместимость молча.

Production-трафик Telegram сохраняет установленный контракт зашифрованного
прокси: `TELEGRAM_API_BASE_URL=https://tg.winwidget.ru/telegram-api`. Только
`operations-worker`, отправляющий резервные копии, получает токен бота и
сопоставление proxy host. `operations-api` получает только несекретный флаг
состояния `TELEGRAM_INFO_BOT_CONFIGURED=true` и публичное имя бота.

## Проверка

```bash
pnpm prisma:generate
OPERATIONS_DATABASE_URL=postgresql://operations:operations@127.0.0.1:5432/operations pnpm prisma:validate
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```
