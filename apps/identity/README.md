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

## Резервный вход по коду

`IDENTITY_LOGIN_OTP_ENABLED=false` по умолчанию. Включать после миграции
`20260910010000_add_login_otp`, проверки Identity/Gateway trusted-proxy boundary
и настроенных SMTP/SMS Aero credentials. Новые маршруты находятся внутри
существующего optional-auth префикса Gateway `/api/v1/auth`; отдельная CRM
подписка для входа не нужна. Старые пароль, регистрация, Telegram и OAuth
сохраняют свои контракты и CAPTCHA-защиту.

- `GET /api/v1/auth/login-otp/capabilities` возвращает `available`, список
  `channels` (`EMAIL`/`SMS`), `codeLength:6`, `expiresInSeconds:300` и
  `resendAfterSeconds:60`; отсутствие feature flag, transport config или OTP
  таблиц не разрешает fallback. Это доступность способа входа, не результат
  проверки существования конкретного контакта или live SLA провайдера.
- `POST /api/v1/auth/login-otp/request` принимает только `channel` и
  `destination`; `202` содержит `challengeId`, `browserToken`, `expiresAt` и
  `resendAvailableAt`. Один и тот же ответ и пятисекундный response floor
  используются для подтверждённого, отсутствующего, неподтверждённого или
  отключённого контакта, а также неизвестного/неуспешного результата отправки.
  UI не должен обещать факт доставки или существование аккаунта.
- `POST /api/v1/auth/login-otp/verify` принимает только `challengeId`,
  `browserToken` и шестизначный `code`; успех возвращает обычный user/access
  token и общий HttpOnly refresh cookie. Все ответы OTP имеют `no-store`.

Только ACTIVE user с существующим verified AuthIdentity получает код. В БД
хранятся purpose `LOGIN_FALLBACK`, хеши destination/browser token и bcrypt12
от `browserToken:code`; CSPRNG browser token 256-bit остаётся только в памяти
клиента. Challenge живёт пять минут, имеет пять попыток и атомарно расходуется
вместе с созданием сессии и локальной подписью JWT. Блокировки user/identity/challenge
и повторная проверка contact ID/value/verifiedAt/status защищают конкуренцию
и отвязку контакта. Доставка HTTP-ответа браузеру не может быть атомарной с БД;
не повторять verify автоматически при неизвестном результате.

Общие между replicas PostgreSQL-лимиты: IP 10 запросов за 10 минут; один
запрос контакту за 60 секунд; SMS 5/контакт/сутки, email 20; глобально SMS
100/час и 300/сутки, email 500/час и 2000/сутки. Проверки ограничены 50/IP
и 2000 глобально за 10 минут. IP берётся из Express `request.ip`, не из raw
forwarded header. Admission идёт IP → contact cooldown → contact day → channel
hour → channel day: отказ не расходует последующие глобальные бюджеты, уже
списанные локальные квоты сохраняются. При ошибке БД — fail closed.

Ошибки: `401 login_otp_invalid`, `429 login_otp_rate_limited`,
`503 login_otp_unavailable`. Клиентский признак недоступности CAPTCHA никогда
не является разрешением сервера: это самостоятельный защищённый способ входа.
Для старого входа отказ/low score остаётся `400`, а transport/HTTP/JSON outage
siteverify получает прежний `503` и message с кодом `recaptcha_unavailable`.

OTP отправляется одной синхронной ограниченной попыткой без автоматического
retry/RabbitMQ. SMTP использует отдельный abortable socket и обычную проверку
TLS; SMS — только HTTPS POST JSON с кодом/номером в body, без redirects.
Неудачная отправка не отменяет challenge другого браузера. Просроченные OTP
и rate buckets очищаются существующим service-owned housekeeping батчами
до 1000. Код, browser token, PII и provider credentials не выводятся в логи.

`pnpm test:integration:login-otp` требует отдельную PostgreSQL 18 test DB и
разные migration/runtime роли, `IDENTITY_INTEGRATION_ALLOW_MUTATION=true`,
`IDENTITY_TEST_DATABASE_URL` и `IDENTITY_TEST_MIGRATION_DATABASE_URL`. Fixture
использует только synthetic delivery; runtime имеет USAGE identity, SELECT
users/auth_identities/telegram_notification_channels, UPDATE(id) users и auth_identities для
row lock, SELECT/INSERT user_sessions и CRUD двух OTP-таблиц. Driver проверяет
конкурирующий consume, лимит попыток, rollback, изменение контакта, durable
квоты и SQL constraints; создание/удаление самой test DB остаётся у runner.

### Совместимость отдельного Identity-релиза

OTP не зависит от CRM runtime, workspace backfill, новых межсервисных токенов
или миграций другого сервиса. Изменение схемы строго additive: две новые
таблицы и индексы, без изменения прежних пользователей, сессий и challenge.
Старый Identity runtime продолжает работать с этой схемой. Новый readiness
проверяет наличие обеих таблиц даже при выключенном флаге; миграция и ACL
должны предшествовать переключению всех трёх Identity процессов.

Canonical `.env.example` и `apps/identity/.env.example` содержат один и тот же
выключенный флаг. Compose передаёт его явно только `identity-api`; одной
строки в canonical env без Compose-проводки недостаточно. Самостоятельные
правки generated service env запрещены. Production-процедура и immutable
infra pin принадлежат `winwidget.ru_infra/docs/runbook.md`. Выпуск использует
только `identity-with-operations-manifest`: три процесса Identity и четыре
Operations, без Billing, Support, Widgets, CRM и Gateway. До reviewed scoped
workflow, совпадающих local/server env hashes и exact green CI деплой не
разрешён; прежние jobs исправления federation/семи workers повторно не запускать.

Кандидат должен наследовать worker recovery
`e9501c954dec661e29d92d6b13e8dbf4eef97b56`: его двенадцать bootstrap/test
файлов и восемь security lockfiles сохраняются без изменений. При смешанном
live baseline отдельно закрепляются прежняя ревизия Operations API и ревизия
трёх её фоновых процессов; их четыре встроенных manifest должны совпадать
побайтово. От worker baseline Operations меняет только restore JSON с одной
новой миграцией Identity; Billing/Support не меняются. Фактические live image
IDs/revisions проверяются перед выпуском, а не выводятся из Git-ветки `prod`.

Перед включением проверить под реальными runtime/backup ролями права новых
таблиц и service-owned backup/restore manifest. Не расширять права на чужие
схемы или DDL обычному runtime. Manifest встроен также в Operations backup
image: одной его регенерации в Git недостаточно. Оба новых image собираются и
проверяются до остановки процессов. После повторных quiet-проверок Operations
останавливаются все четыре её процесса через SIGTERM, без SIGKILL; timeout
останавливает выпуск. Quiet sampling не является атомарным writer fence:
дополнительно нужны физический stop, ноль Operations runtime PG sessions и
SHARE-барьер с нулём PROCESSING backup jobs и active restore. Только затем
применяется Identity migration и запускаются согласованные Identity/Operations
images. Это короткая пауза admin control plane, не остановка Widgets/Billing.

При успешном или неизвестном результате DDL запрещено автоматически возвращать
старый Operations manifest: сохранить fence и recovery evidence до доказанного
совпадения ledger/manifest. После additive migration допустим rollback
на прежний совместимый Identity image с сохранением нового Operations manifest,
новых таблиц и данных:
сначала отключить OTP и дождаться завершения активных запросов, не удалять
challenge/сессии и не выполнять reverse DROP. Старый frontend/обычный вход
должны оставаться работоспособными. Проверка реальной доставки кода требует
участия пользователя; synthetic transport и `capabilities.available` её не
доказывают.
