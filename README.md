# Сервисы WinWidget

Бэкенд WinWidget состоит из десяти независимо собираемых приложений. Gateway
использует только точные service-owned routes; catch-all, Core upstream и
listener `:4200` запрещены steady-state verifier-ом.

Это монорепозиторий исходного кода сервисов. Каждый каталог в `apps/` имеет
собственные зависимости, lockfile, Dockerfile, `.env.example`, README и
схему/миграции Prisma, если сервис использует PostgreSQL.

## Сервисы

| Каталог                      | Ответственность                                                                 | Процессы и порты                                           |
| ---------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `apps/api-gateway`           | Публичная точка входа `/api/v1/*`, JWT/JWKS, CORS и проксирование               | Gateway `4100`                                             |
| `apps/identity`              | Пользователи, auth, OAuth, Telegram auth, профиль и S3-аватары                  | API `4900`, worker `4901`, outbox `4902`                   |
| `apps/billing`               | Тарифы, подписки, платежи и партнёрская программа                               | API `4800`, scheduler `4801`, worker `4802`, outbox `4803` |
| `apps/widgets`               | Все виджеты, заявки, настройки, интеграции и runtime-assets                     | API/worker/outbox `4700`                                   |
| `apps/campaigns`             | Кампании, аудитории, email/Telegram-рассылки                                    | API/worker/outbox `4500`                                   |
| `apps/reporting`             | Аналитические проекции, статистика и Daily Summary                              | API/worker/scheduler/outbox `4600`                         |
| `apps/platform`              | Контент главной, юридические страницы и настройки сайта                         | API `5000`, outbox `5001`                                  |
| `apps/support`               | Чат с оператором и Telegram support transport                                   | API `5100`, worker `5101`, outbox `5102`                   |
| `apps/notification-delivery` | Фактическая доставка email и Telegram-сообщений                                 | worker `4401`                                              |
| `apps/operations`            | Notes, Admin Event Log, очереди/DLQ, Telegram settings, backup/restore и alerts | API `5200`, worker `5201`, outbox `5202`, restore `5203`   |

Gateway использует манифест точных префиксов. Общего универсального маршрута
`/api/v1` нет:
каждый публичный маршрут имеет конкретного владельца. Внутренние endpoints
доступны только по loopback и защищены отдельными межсервисными токенами.

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

Жизненный цикл production, Nginx/Telegram relay, SSH-транспорт и инструкции
находятся в отдельном репозитории `winwidget.ru_infra`.

## Контракт переменных окружения

У каждого сервиса есть собственные файлы:

```text
apps/<service>/.env.example     # tracked, без секретов
apps/<service>/.env             # ignored, локальная разработка
apps/<service>/.env.production  # ignored, root:root 0600 на VPS
```

Канонический production env синхронизируется побайтово с защищённой локальной
копией. Infra controller атомарно материализует из него принадлежащие сервисам
`.env.production`; контейнеры получают только явный минимальный набор через
Compose `environment`. S3-ключи аватаров получает только Identity, S3-ключи
медиафайлов виджетов — только Widgets. Роли PostgreSQL для runtime, миграций и
резервного копирования разделены.

Корневой `.env.example` — только агрегированный структурный контракт для
production Compose и CI-валидаторов; он не является общим runtime env.

Локальный запуск также не читает общий корневой env: каждый сервис использует
только собственный `apps/<service>/.env`, созданный на основе его
`.env.example`.

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

Каждый сервис с состоянием владеет собственной базой и схемой PostgreSQL,
миграциями, ролями и внешним Docker volume. Межсервисных SQL joins и доступа к
чужим схемам нет.

Зависимое от PostgreSQL событие создаётся через transactional Outbox в той же
транзакции. Publisher использует confirms и mandatory return. Consumers
работают через `basic.consume`, подтверждают сообщение после успеха и
идемпотентны по `eventId + consumer`. Retry/DLQ принадлежат конкретному
consumer.

Scheduler Operations создаёт надёжные задания с уникальным ключом периода и
CAS lease. `pg_dump` выполняет только worker Operations, восстановление —
отдельный restore worker Operations с изолированным пользователем RabbitMQ.

## Развёртывание в production

Релиз выполняется только из точного commit `origin/prod` по неизменяемому
40-символьному SHA и под единым deploy lock. Обязательны побайтово идентичный
hash env, метки OCI revision, миграции баз всех сервисов, точные
permissions/topology RabbitMQ, прямые проверки readiness, smoke-проверки
Gateway/публичного API и revision каждого контейнера.

Notes, Admin Event Log и плоскость управления Telegram/Reporting принадлежат
Operations. Обычный deploy проверяет актуальные границы service-owned баз,
миграции, readiness и краткие negative invariants: отсутствуют Core runtime,
routes, queues, users и listener `:4200`. Исторические import/activate/bootstrap
состояния не участвуют в runtime или steady-state CLI.

Workflow для production и подробная инструкция находятся в
`winwidget.ru_infra`. Секреты, закрытые ключи и файлы паролей баз данных в Git
не попадают. Контракт каждого приложения описан в `apps/<service>/README.md`.

## Документация

- [Технический backlog](docs/backlog.md)
- [API Gateway и авторизация](docs/api-gateway-auth.md)
- [Контракт Widgets](docs/widgets-service.md)
- [Production runbook](https://github.com/nda17/winwidget.ru_infra/blob/master/docs/runbook.md)
