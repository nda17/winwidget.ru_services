# Сервис Platform

Platform владеет редактируемыми настройками сайта, юридическими страницами,
контентом и исходным кодом главной страницы, связанными событиями аудита
администратора и схемой PostgreSQL `platform`. В штатном режиме сервис не
зависит от базы данных Core.

## Роли процессов

| `PLATFORM_PROCESS_ROLE` | Порт по умолчанию | Ответственность                                    |
| ----------------------- | ----------------: | -------------------------------------------------- |
| `api`                   |              5000 | Публичный/admin API контента и закрытый мониторинг |
| `outbox-publisher`      |              5001 | Публикация Outbox с confirms и mandatory           |

Каждая роль предоставляет `GET /health/live` и `GET /health/ready`;
бизнес-контроллеры регистрирует только `api`.

Публичные маршруты Gateway:

- `/api/v1/site-settings`
- `/api/v1/legal-pages/**`
- `/api/v1/home-page-content` и `/api/v1/home-page-content/raw-code`

Platform авторизует пользователей через introspection Identity с
`IDENTITY_PLATFORM_TOKEN`. Operations читает
`GET /internal/v1/platform/messaging/overview` через loopback с
`x-winwidget-service: operations` и `PLATFORM_OPERATIONS_TOKEN`.

Все изменения контента и действия администратора, требующие публикации,
записываются в Platform Outbox в той же транзакции PostgreSQL. К RabbitMQ
подключается только роль `outbox-publisher`.

## Настройка и развёртывание

Скопируйте `.env.example` в игнорируемый `.env.production` в каталоге сервиса
на VPS. Замените каждый шаблон значением с ограниченной областью действия. Не
добавляйте выведенные из эксплуатации URL или токены Core в штатный runtime.

```bash
pnpm install --frozen-lockfile
pnpm run prisma:generate
pnpm run prisma:validate
pnpm run prisma:migrate:deploy
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run build
docker build --build-arg APP_REVISION="$(git rev-parse HEAD)" -t winwidget-platform .
```

Запустите `api` и `outbox-publisher` из одной ревизии и проверьте readiness
обеих ролей до включения маршрутов Platform в Gateway.
