# Сервис Identity

Identity владеет пользователями, идентификаторами аутентификации, сессиями,
personal workspaces и memberships, проверочными challenge, OAuth, аватарами
профиля, привязками Telegram и схемой PostgreSQL `identity`. Объекты аватаров
остаются в настроенном S3-хранилище; сервис не заменяет их файлами,
привязанными к хосту.

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

Refresh token остаётся общим HttpOnly cookie для доверенных поддоменов.
Параллельная ротация в коротком grace-окне отвечает
`409 refresh_rotation_in_progress`, не удаляет cookie и должна повторяться
клиентом как временный конфликт; просроченный replay предыдущего токена отзывает
сессию.

Закрытые loopback-контракты не публикуются через Gateway:

- `POST /internal/v1/auth/introspect`
- `POST /internal/v1/crm-access/auth-context` — только валидная bearer-сессия
  и активные memberships активных workspaces
- `/internal/v1/widgets/owners/**`
- `/internal/v1/operations/audit-snapshots` и
  `GET /internal/v1/operations/admin-health`
- `POST /internal/v1/campaigns/eligible-contacts`
- `POST /internal/v1/billing/lifecycle/complete`
- `/internal/v1/identity/messaging/**`

Campaigns, Reporting, Widgets, Billing, `crm-access`, Platform, Support и
Operations имеют раздельные `IDENTITY_<CALLER>_TOKEN`; сервис отклоняет
отсутствующие, шаблонные, повторно используемые или короткие учётные данные.
Сам Identity вызывает Billing, Widgets и Operations через отдельные токены с
областью Identity.

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

## Приглашения WinCRM

Identity владеет `workspace_invitations`, подтверждённым EMAIL и обычным
workspace MEMBER, но не CRM-ролями или лимитом мест. Ссылка содержит только
UUID приглашения, не bearer secret. `GET /api/v1/workspace-invitations/:id`
и `POST .../:id/accept` требуют текущую сессию с точным активным проверенным
EMAIL приглашения. Иной email/неизвестное приглашение дают одинаковый `404`.
POST: `schemaVersion:1`, UUID `commandId`, `expectedVersion`, точный
`Idempotency-Key`. Receipt связан с актором и payload, replay заново проверяет
email. Неактивный MEMBER не реактивируется; активный MEMBER переиспользуется,
новый MEMBER получает provenance `WINCRM` и invitation ID. OWNER не изменяется.

Acceptance, membership, receipt и identifiers-only Outbox
`identity.wincrm.invitation-accepted.v1` коммитятся вместе. CRM Access отдельно
выдаёт роль после свежей проверки Identity/Billing и квоты; до этого обычный
MEMBER не предоставляет продуктовых прав. JWT нигде не сохраняется в saga.

Scoped `crm-access` internal APIs:
`POST /internal/v1/crm-access/invitations`,
`POST .../:id/revoke`, `POST .../:id/acceptance-context`;
`POST /internal/v1/crm-access/workspaces/:workspaceId/member-directory` принимает
`{schemaVersion:1,membershipIds:UUID[0..100]}` и возвращает только
`membershipId,subject,displayName,verifiedEmail` запрошенных записей своего
workspace. Нет общих профилей, телефонов и provider IDs; missing/foreign ID
закрывает весь запрос. Для неактивного/удалённого пользователя профиль null.

Email доставки включаются отдельно `WINCRM_INVITATION_EMAIL_ENABLED=true`
**только вместе** с Notification Delivery consumer `wincrm-invitation-email`.
По умолчанию false сохраняет прежний runtime без нового обязательного токена.
При включении требуется отдельный pairwise-distinct
`IDENTITY_NOTIFICATION_DELIVERY_TOKEN`. Создание приглашения атомарно
публикует `notification.wincrm.invitation.email.requested.v1` через Outbox:
immutable notification event ID, invitation/workspace IDs, нормализованный
email и expiry; без URL, HTML или JWT. Шаблон и allowlisted CRM link строит
Notification Delivery. Outcome event не создаётся без отдельного consumer.

Перед отправкой Notification Delivery вызывает только
`POST /internal/v1/notification-delivery/wincrm-invitations/:id/delivery-context`
с `x-winwidget-service`, `x-winwidget-internal-token` и body
`{schemaVersion:1,eventId,workspaceId}`. Exact binding неизвестен — `404`;
известное revoked/accepted/expired или выключенный email — `200 deliver:false`
с `email:null`, а не успешная SMTP-доставка. Неуспешный validity read запрещает
SMTP. Даже уже отправленная ссылка повторно проверяется при acceptance.

Runtime дополнительно нужен `SELECT,INSERT,UPDATE` на
`identity.workspace_invitations`; grants существующих `workspace_members`,
`internal_command_receipts`, `outbox_events` остаются service-owned. Readiness
проверяет migration columns. Для rollout применить migration до новой API;
старые memberships и Widgets-права не меняются, compatibility adapter не нужен.
