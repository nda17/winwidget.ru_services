# Сервис Operations

Сервис Operations владеет операционной плоскостью управления WinWidget,
использует собственную БД и только актуальные service-owned HTTP/event
контракты. Готовность определяется доступностью собственной БД, RabbitMQ и
включённых для роли workers без внешних import/bootstrap-маркеров.

## Ответственность

- Notes и агрегированный журнал событий администратора.
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
| `worker`                  |              5201 | Consumers аудита, scheduler и read-only backup баз данных      |
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
- `/dev-tools/database-restores/*` — только для пользователей DEV

Внутренние маршруты без публичного префикса:

- `GET /internal/v1/identity/users/:userId/admin-events/overview`
- `PUT /internal/v1/operations/reporting/schedule-policy`
- `POST /internal/v1/operations/reporting/schedule-policy/confirm`

Федерация всегда передаёт `x-winwidget-service: operations` и отдельный
`*_OPERATIONS_TOKEN`. Billing использует
`/internal/v1/operations/billing/*`, а Widgets —
`/api/v1/internal/v1/operations/widgets/*`. URL сервисов должны быть точными
закрытыми HTTP origins без встроенных путей или учётных данных.

## Контракты RabbitMQ

Operations публикует в `winwidget.events`:

- `operations.scheduled-job.requested.v1`
- `operations.database-restore.requested.v1`
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

API записывает загруженные dump, а `restore-worker` их читает, поэтому только
эти два контейнера монтируют один закрытый постоянный
`DATABASE_RESTORE_STORAGE_DIR` с read-write-доступом (владелец — runtime UID
1001). Production-постановка restore выключена и не должна включаться до
exact-SHA rehearsal и approved recovery procedure. Изолированный worker
использует
`RABBITMQ_CONNECTION_NAME=winwidget-operations-restore-worker` и получает
сообщения только из семейства очередей
`winwidget.operations.database-restore.v1`.

Одновременно разрешён ровно один `PROCESSING` restore. Claim содержит event ID,
lease token и durable phase checkpoints `PREPARING`, `SAFETY_READY`, `MUTATING`
и `VERIFIED`. Потеря lease останавливает дочерний PostgreSQL-процесс. Повторная
доставка не запускает destructive execution заново: просроченный claim до
mutation становится `FAILED`, а после mutation — `RECOVERY_REQUIRED` с
сохранёнными source/safety artifacts. Перед миграцией state machine таблица
restore jobs блокируется, а наличие legacy `QUEUED`, `PROCESSING` или `FAILED`
останавливает migration fail-closed. Source dump удаляется только после
подтверждённого terminal CAS; ошибка cleanup не повторяет restore, а legacy
failure без доказанной pre-mutation phase не попадает в cleanup.

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
и global/schema default ACL. Изолированный bootstrap-admin каждой service-owned
PostgreSQL обязан быть `LOGIN + SUPERUSER`; migration/runtime/backup роли не
могут быть superuser, наследовать роли или входить в membership. После restore
worker в одной транзакции переключается на migration owner, отзывает известные
grants, восстанавливает точную runtime/backup матрицу, повторяет catalog-проверку
и только затем выполняет `COMMIT` и фиксирует `VERIFIED`. Для Platform разрешены
ровно восемь обычных таблиц, нет sequences и blanket runtime default grants;
runtime получает только явный table/column/function allowlist.

Production restore остаётся выключенным до полного exact-SHA rehearsal
dump/restore, one-shot permit и signed receipt, утверждённого
`RECOVERY_REQUIRED` workflow с dual approval, а также retention и alerts для
restore artifacts/job/fence.

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
