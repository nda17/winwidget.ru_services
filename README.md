# WinWidget Services

Backend WinWidget состоит только из независимых сервисов. Общий NestJS API,
общая Core PostgreSQL, Core workers/publishers и Gateway fallback удалены.
Обратной совместимости с монолитом нет.

Это monorepo исходного кода сервисов. Каждый каталог в `apps/` имеет
собственные зависимости, lockfile, Dockerfile, `.env.example`, README и
Prisma schema/migrations, если сервис использует PostgreSQL.

## Сервисы

| Каталог                      | Ответственность                                                                 | Процессы и порты                                           |
| ---------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `apps/api-gateway`           | Публичная точка входа `/api/v1/*`, JWT/JWKS, CORS и proxy                       | Gateway `4100`                                             |
| `apps/identity`              | Пользователи, auth, OAuth, Telegram auth, профиль и S3-аватары                  | API `4900`, worker `4901`, outbox `4902`                   |
| `apps/billing`               | Тарифы, подписки, платежи и партнёрская программа                               | API `4800`, scheduler `4801`, worker `4802`, outbox `4803` |
| `apps/widgets`               | Все виджеты, заявки, настройки, интеграции и runtime assets                     | API/worker/outbox `4700`                                   |
| `apps/campaigns`             | Кампании, аудитории, email/Telegram-рассылки                                    | API/worker/outbox `4500`                                   |
| `apps/reporting`             | Аналитические проекции, статистика и Daily Summary                              | API/worker/scheduler/outbox `4600`                         |
| `apps/platform`              | Контент главной, юридические страницы и настройки сайта                         | API `5000`, outbox `5001`                                  |
| `apps/support`               | Чат с оператором и Telegram support transport                                   | API `5100`, worker `5101`, outbox `5102`                   |
| `apps/notification-delivery` | Фактическая доставка email и Telegram-сообщений                                 | worker `4401`                                              |
| `apps/operations`            | Notes, Admin Event Log, очереди/DLQ, Telegram settings, backup/restore и alerts | API `5200`, worker `5201`, outbox `5202`, restore `5203`   |

Gateway использует exact-prefix manifest. Общего `/api/v1` catch-all нет:
каждый публичный маршрут имеет конкретного владельца. Внутренние endpoints
доступны только по loopback и защищены отдельными service-to-service токенами.

## Структура

```text
winwidget.ru_services/
├── apps/                                  # десять автономных приложений
├── deploy/docker-compose.prod.yml         # apps-only production manifest
├── scripts/generate-jwt-keyset.mjs        # локальная генерация Identity keyset
└── .github/
    ├── scripts/                           # Compose/static validators
    └── workflows/ci.yml                   # apps-only CI matrix
```

Production lifecycle, Nginx/Telegram relay, SSH transport и runbooks находятся
в отдельном репозитории `winwidget.ru_infra`.

## Env-контракт

У каждого сервиса есть собственные файлы:

```text
apps/<service>/.env.example     # tracked, без секретов
apps/<service>/.env.production  # ignored, root:root 0600 на VPS
```

Canonical production env синхронизируется побайтово с защищённой локальной
копией. Infra controller атомарно материализует из него service-owned
`.env.production`; контейнеры получают только явный минимальный набор через
Compose `environment`. S3-ключи аватаров получает только Identity, S3-ключи
widget media — только Widgets. Runtime, migration и backup PostgreSQL roles
разделены.

## Локальные проверки

Требуются Node.js 20 и pnpm 9. Команды запускаются внутри приложения:

```bash
pnpm --dir apps/operations install --frozen-lockfile
pnpm --dir apps/operations run prisma:generate
pnpm --dir apps/operations run lint
pnpm --dir apps/operations run typecheck
pnpm --dir apps/operations run test
pnpm --dir apps/operations run build
```

Для другого сервиса замените `operations` на его каталог. API Gateway не
использует Prisma. Общая проверка:

```bash
pnpm install --frozen-lockfile
pnpm run format:check
pnpm run lint
bash .github/scripts/static-check-services-lifecycle.sh
```

CI выполняет матрицу `install → prisma:generate → lint → typecheck → test →
build` для всех десяти приложений.

## Данные и RabbitMQ

Каждый stateful service владеет собственной PostgreSQL database, schema,
migrations, ролями и external Docker volume. Межсервисных SQL joins и доступа
к чужим схемам нет.

Зависимое от PostgreSQL событие создаётся через transactional Outbox в той же
транзакции. Publisher использует confirms и mandatory return. Consumers
работают через `basic.consume`, подтверждают сообщение после успеха и
идемпотентны по `eventId + consumer`. Retry/DLQ принадлежат конкретному
consumer.

Operations scheduler создаёт durable jobs с уникальным ключом периода и CAS
lease. `pg_dump` выполняет только Operations worker, restore — отдельный
Operations restore worker с изолированным RabbitMQ user.

## Production

Release выполняется только из exact `origin/prod` commit по immutable
40-символьному SHA и под единым deploy lock. Обязательны byte-identical env
hash, OCI revision labels, migrations всех service databases, точные RabbitMQ
permissions/topology, direct readiness, Gateway/public smoke и revision
каждого контейнера.

Одноразовый terminal cutover импортирует Notes, Admin Event Log и
Telegram/Reporting control plane в Operations до запуска publishers. Только
после green service/Gateway gates удаляются заранее проверенные пустые legacy
RabbitMQ queues/users, Core containers, Core database/volume и restore staging.
Rollback или автоматического восстановления монолита нет.

Production workflow и подробный runbook находятся в
`winwidget.ru_infra`. Секреты, private keys и database password files в Git
не попадают. Контракт каждого приложения описан в `apps/<service>/README.md`.
