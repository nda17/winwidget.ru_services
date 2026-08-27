# Сервис Identity

Identity владеет пользователями, идентификаторами аутентификации, сессиями,
проверочными challenge, OAuth, аватарами профиля, привязками Telegram и схемой
PostgreSQL `identity`. Объекты аватаров остаются в настроенном S3-хранилище;
сервис не заменяет их файлами, привязанными к хосту.

## Роли процессов

| `IDENTITY_PROCESS_ROLE` | Порт по умолчанию | Ответственность                                        |
| ----------------------- | ----------------: | ------------------------------------------------------ |
| `api`                   |              4900 | HTTP-контракты Auth/users/OAuth/Telegram и JWKS        |
| `worker`                |              4901 | Идемпотентные consumers жизненного цикла и направлений |
| `outbox-publisher`      |              4902 | Публикация Outbox с confirms и mandatory               |

`IDENTITY_PORT` может переопределять порты worker/publisher, но API всегда
работает на `4900`. Каждая роль предоставляет `/health/live`, `/health/ready`,
и `/health/revision`; бизнес-контроллеры регистрируются только для `api`.

## HTTP- и внутренние контракты

Публичные маршруты находятся под `/api/v1`: `/auth/**`, `/users/**`,
`/telegram-auth/**` и webhook Telegram. JWKS доступен по
`GET /api/v1/auth/.well-known/jwks.json`.

Закрытые loopback-контракты не публикуются через Gateway:

- `POST /internal/v1/auth/introspect`
- `/internal/v1/widgets/owners/**`
- `/internal/v1/operations/audit-snapshots` и
  `GET /internal/v1/operations/admin-health`
- `POST /internal/v1/campaigns/eligible-contacts`
- `POST /internal/v1/billing/lifecycle/complete`
- `/internal/v1/identity/messaging/**`

Campaigns, Reporting, Widgets, Billing, Platform, Support и Operations имеют
раздельные `IDENTITY_<CALLER>_TOKEN`; сервис отклоняет отсутствующие, шаблонные,
повторно используемые или короткие учётные данные. Сам Identity вызывает
Billing, Widgets и Operations через отдельные токены с областью Identity.

## Внешние провайдеры

- Access JWT используют закрытый ключ RSA и публичный JWKS, переданные в
  base64.
- Учётные данные и callback OAuth настраиваются отдельно для Google, GitHub,
  Yandex и VK.
- Проверка email/SMS использует SMTP и SMS Aero.
- Webhook Telegram использует учётные данные ботов Auth и Info. В production
  `TELEGRAM_API_BASE_URL` должен быть равен
  `https://tg.winwidget.ru/telegram-api`; прямой доступ к Telegram разрешён
  только вне production.
- Хранилище аватаров требует отдельного пространства имён
  `IDENTITY_AVATAR_S3_*`.

## Настройка и развёртывание

Оставьте `.env.example` под контролем Git и создайте рядом на VPS игнорируемый
`.env.production`. Замените каждое `change_me`, используйте отдельные роли базы
данных для runtime и миграций и передавайте каждому контейнеру только нужные
его роли секреты. Никогда не выводите в логи развёртывания закрытые ключи,
токены ботов, секреты провайдеров или строки подключения.

```bash
pnpm install --frozen-lockfile
pnpm run prisma:generate
pnpm run prisma:validate
pnpm run prisma:migrate:deploy
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run build
docker build --build-arg APP_REVISION="$(git rev-parse HEAD)" -t winwidget-identity .
```

Запустите API, worker и Outbox publisher из одного неизменяемого образа. До
переключения маршрутов Gateway проверьте readiness каждой роли и публичный JWKS.
Миграции сохраняют постоянный `service_identity` текущей базы; отдельной фазы
активации нет, поэтому включённые worker, housekeeping и Outbox publisher
запускаются сразу после успешного применения миграций.
