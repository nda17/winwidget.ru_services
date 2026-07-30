# Winwidget — backend

Backend коммерческого сервиса Winwidget: HTTP API, авторизация, пользователи,
подписки, платежи, административные функции, хранение заявок, интеграции и
runtime-скрипты виджетов.

Приложение построено на NestJS 10 и Express, использует PostgreSQL через
Prisma ORM и обслуживает frontend, публичные страницы виджетов и скрипты,
устанавливаемые на сайты клиентов.

## Технологический стек

### Основные технологии

- `Node.js 20`;
- `NestJS 10`;
- `Express 4`;
- `TypeScript 5`;
- `Prisma ORM 5`;
- `PostgreSQL`;
- `RxJS`.

### Авторизация и валидация

- RS256 access JWT через JWKS и rotating opaque refresh token;
- Passport;
- OAuth: Google, GitHub, Yandex и VK;
- авторизация через Telegram;
- `bcryptjs`;
- `class-validator` и `class-transformer`;
- Google reCAPTCHA v3;
- SMS-коды через SMS Aero.

### Интеграции и инфраструктура

- RabbitMQ и transactional Outbox для at-least-once доставки асинхронных
  побочных эффектов;
- ЮKassa;
- SMTP и Nodemailer;
- React Email;
- Telegram Bot API;
- S3-совместимое файловое хранилище через AWS SDK;
- generic webhook;
- Bitrix24;
- amoCRM и Kommo;
- Яндекс Метрика;
- VK Pixel;
- Roistat;
- `xlsx` для экспорта заявок;
- `undici` для контролируемых исходящих запросов.

### Качество кода и сборка

- Jest и Supertest;
- ESLint;
- Prettier;
- Husky и lint-staged;
- esbuild;
- Docker и Docker Compose;
- pnpm 9.

---

# Архитектура проекта

Backend использует стандартную предметно-модульную архитектуру NestJS.

## Структура

```text
winwidget.ru_server/
├── src/
│   ├── app.module.ts          # корневой NestJS module
│   ├── main.ts                # bootstrap, CORS, filters и static files
│   ├── prisma.service.ts      # подключение к PostgreSQL по MODE
│   ├── auth/                  # JWT, OAuth, Telegram auth и guards
│   ├── user/                  # профиль, identities и admin-управление
│   ├── subscription/          # тарифные ограничения и подписки
│   ├── payment/               # ЮKassa и обработка платежей
│   ├── widget/                # Колесо фортуны и общие leads
│   ├── quiz/                  # Квиз
│   ├── callback/              # Заказ обратного звонка
│   ├── countdown-timer/       # Таймер
│   ├── stop-offer/            # Stop Offer
│   ├── online-consultant/     # Онлайн-консультант
│   ├── calculator/            # Калькулятор
│   ├── email/ и sms/          # уведомления и коды подтверждения
│   ├── telegram-bot/          # три Telegram-бота и webhooks
│   ├── messaging/             # RabbitMQ topology, monolith consumers и Outbox contracts
│   ├── scheduled-jobs/        # durable-запуски, уникальность и CAS-lease
│   ├── maintenance/           # длительные регламентные задачи и backup
│   ├── file/                  # local/S3 uploads
│   ├── safe-outbound-http/    # защита исходящих webhook/CRM-запросов
│   └── ...                    # контент, статистика и admin-модули
├── apps/
│   ├── api-gateway/           # отдельный внешний API ingress без бизнес-логики
│   ├── campaigns/             # автономный NestJS-сервис кампаний
│   │   ├── src/               # API, snapshot worker, Outbox publisher и health
│   │   ├── prisma/            # собственные schema, migrations и Prisma Client
│   │   └── Dockerfile         # image только с artifact сервиса
│   └── notification-delivery/ # автономный NestJS-сервис доставки
│       ├── src/               # собственный bootstrap, modules и adapters
│       ├── prisma/            # собственные schema, migrations и Prisma Client
│       ├── emails/            # только принадлежащие сервису шаблоны
│       └── Dockerfile         # image только с artifact сервиса
├── prisma/                    # schema и migrations монолита
├── widgets-src/               # читаемые исходники runtime-виджетов
├── public/widgets/            # generated runtime-файлы, не коммитятся
├── emails/                    # React Email templates
├── scripts/                   # сборка виджетов и production deploy
├── Dockerfile
└── docker-entrypoint.sh
```

Каталоги внутри `apps/` называются по capability без избыточного суффикса
`-service`: `apps/campaigns` и `apps/notification-delivery`. В архитектурном
реестре и package metadata компонент может называться `campaigns-service` или
`notification-delivery-service`, а Compose-процесс — `campaigns-service` или
`notification-delivery-worker`; это разные уровни именования, а не разные
приложения.

## Правила модульной архитектуры

- Каждый предметный модуль объединяет controller, service, DTO и Nest module.
- Controllers отвечают за HTTP, guards, validation и формат ответа.
- Services содержат бизнес-логику и работают с Prisma.
- Общий repository/use-case слой сейчас не используется.
- Конфигурация загружается глобальным `ConfigModule`.
- Технические helpers находятся в `config`, `filters`, `interceptors`,
  `utils`, `widget-domain` и `safe-outbound-http`.
- Новую предметную область следует оформлять отдельным NestJS module.

## Основные модули

| Область             | Модули                                                                                           | Ответственность                                     |
| ------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| Авторизация         | `auth`, `user`                                                                                   | JWT, OAuth, Telegram auth, профиль и identities     |
| Подписки            | `subscription`, `tariff-prices`                                                                  | тарифы, лимиты, история и expiry                    |
| Платежи             | `payment`, `affiliate`                                                                           | ЮKassa, активация подписок и referrals              |
| Виджеты             | `widget`, `quiz`, `callback`, `countdown-timer`, `stop-offer`, `online-consultant`, `calculator` | CRUD, config, leads и preview                       |
| Контент             | `home-page-content`, `legal-pages`, `site-settings`                                              | главная, документы и настройки сайта                |
| Администрирование   | `statistics`, `admin-alerts`, `admin-event-log`, `notes`, `health`, `dev-tools`                  | dashboard, мониторинг и служебные действия          |
| Уведомления         | `email`, `sms`, `telegram-bot`                                                                   | email, SMS и Telegram                               |
| Messaging           | `messaging`, `outbox-publisher`, `integration-worker`, `notification-delivery`                   | RabbitMQ, Outbox, retry, DLQ и доставка уведомлений |
| Кампании            | `apps/campaigns`                                                                                 | кампании, снимки аудитории и статусы доставок       |
| Регламентные задачи | `scheduled-jobs`, `maintenance`                                                                  | durable scheduler, lease и backup                   |
| Файлы               | `file`                                                                                           | local uploads и S3                                  |
| Интеграции          | `safe-outbound-http`                                                                             | безопасные webhook и CRM-запросы                    |

Единого `AdminModule` нет: административные endpoints находятся внутри
соответствующих предметных модулей.

---

# HTTP API

## Базовые правила

- Основной API prefix: `/api/v1`.
- Публичные loader- и preview-страницы исключены из API prefix.
- Статические runtime-файлы отдаются из `public` по `/widgets/*`.
- Development uploads сохраняются локально и доступны по `/uploads/*`.
- Для публичных widget API разрешён cross-origin доступ.
- Ошибки нормализуются глобальными HTTP и reCAPTCHA filters.

## Виджеты и заявки

Сейчас backend поддерживает семь типов виджетов:

| Виджет             | Управление                   | Public config/lead                 | Preview                        |
| ------------------ | ---------------------------- | ---------------------------------- | ------------------------------ |
| Колесо фортуны     | `/api/v1/widgets`            | `/api/v1/widget/:key/*`            | `/page-wheel/:key`             |
| Квиз               | `/api/v1/quizzes`            | `/api/v1/quiz/:key/*`              | `/page-quiz/:key`              |
| Обратный звонок    | `/api/v1/callbacks`          | `/api/v1/callback/:key/*`          | `/page-callback/:key`          |
| Таймер             | `/api/v1/countdown-timers`   | `/api/v1/countdown-timer/:key/*`   | `/page-timer/:key`             |
| Stop Offer         | `/api/v1/stop-offers`        | `/api/v1/stop-offer/:key/*`        | `/page-stop-offer/:key`        |
| Онлайн-консультант | `/api/v1/online-consultants` | `/api/v1/online-consultant/:key/*` | `/page-online-consultant/:key` |
| Калькулятор        | `/api/v1/calculators`        | `/api/v1/calculator/:key/*`        | `/page-calculator/:key`        |

Для каждого типа разделены:

- authenticated controller для CRUD и заявок владельца;
- public API controller для получения config и отправки lead;
- public controller для standalone preview page.

Общие возможности:

- публичный ключ установки;
- проверка домена установки;
- включение и выключение виджета;
- серверная пагинация заявок;
- экспорт CSV/XLSX;
- фильтрация дублей;
- тарифные ограничения на количество виджетов и заявок;
- уведомления и CRM/webhook-интеграции;
- общая обработка direct preview-запросов.

## Авторизация

Поддерживаются:

- регистрация и вход по email/password;
- подтверждение email кодом;
- регистрация и вход по телефону;
- восстановление пароля;
- Google OAuth;
- GitHub OAuth;
- Yandex OAuth;
- VK OAuth;
- Telegram Auth Bot;
- привязка email, телефона и Telegram к существующему профилю.

JWT flow:

- access token подписывается `RS256`, содержит строгие `iss`, `aud`, `sub`,
  `sid`, `roles`, `token_use`, `jti`, `iat`, `nbf`, `exp` и используется как
  Bearer token;
- публичные ключи доступны по
  `/api/v1/auth/.well-known/jwks.json`, private key получает только Auth/API;
- refresh token хранится в `HttpOnly` cookie `refreshToken`;
- opaque refresh token ротируется через `POST /api/v1/auth/refresh`;
- bcrypt hash от SHA-256 digest полного refresh token хранится в `UserSession`
  PostgreSQL;
- access token действует 15 минут;
- refresh token действует 7 дней;
- cookie domain настраивается через `AUTH_COOKIE_DOMAIN`.

reCAPTCHA v3 применяется к чувствительным auth-сценариям. Frontend передаёт
token в заголовке `recaptcha`.

Используемые actions:

- `login`;
- `register`;
- `restore-password`.

## Безопасность интеграций

`SafeOutboundHttpService` проверяет пользовательские webhook и CRM URL:

- разрешённые протоколы и порты;
- private, loopback и служебные IP-диапазоны;
- DNS resolution и rebinding;
- количество redirects;
- таймауты и максимальный размер ответа;
- официальные домены amoCRM, Kommo и Bitrix24.

---

# База данных

Prisma использует PostgreSQL. Подключение выбирается через `MODE`:

```text
MODE=development -> DATABASE_URL_DEVELOPMENT
MODE=production  -> DATABASE_URL_PRODUCTION
```

Каждый Nest application context владеет ровно одним глобальным Prisma
module/client и одним connection pool. `api`, `outbox-publisher`,
`integration-worker` и `maintenance-worker` используют
`PrismaModule`/`PrismaService`. Автономный
`apps/notification-delivery` и `apps/campaigns` используют по одному
собственному глобальному Prisma module и сгенерированному service client; их
зависимости, сборка и Docker context не связаны с runtime artifact монолита.
Feature-модули не регистрируют Prisma service повторно в собственных
`providers` или `exports`. Root-модуль отключает свой client после завершения
lifecycle-хуков процесса; API обрабатывает `SIGTERM` через Nest shutdown hooks.

В production Maintenance получает отдельный
`MAINTENANCE_DATABASE_URL_PRODUCTION`, а `pg_dump` — обязательный
`DATABASE_BACKUP_URL` отдельной read-only роли на прямом PostgreSQL endpoint
без transaction pooler. Основной `DATABASE_URL_PRODUCTION` этому контейнеру не
передаётся. Одноразовый `migrate` получает только
`DATABASE_MIGRATION_URL_PRODUCTION`; runtime-роль API не используется для DDL.

`notification-delivery-worker` владеет отдельным PostgreSQL-контейнером,
database `winwidget_notification_delivery`, схемой `notification_delivery` и
собственным external data volume. Сейчас контейнер работает на том же backend
VPS, но его database, роли, migrations и backup-контур принадлежат только
Notification Delivery. Сервис использует отдельный Prisma Client и три разные
роли:

- migration-role из `NOTIFICATION_DELIVERY_MIGRATION_URL_PRODUCTION` владеет
  схемой и выполняет DDL только внутри неё, но не имеет database `CREATE`;
- runtime-role из `NOTIFICATION_DELIVERY_DATABASE_URL` имеет только `CONNECT`,
  `USAGE`, DML на service-таблицах и доступ к их sequences. Она не должна иметь
  `CREATE` на database/schema и не может изменять или удалять схему;
- backup-role из `NOTIFICATION_DELIVERY_BACKUP_URL` имеет только `CONNECT`,
  schema `USAGE` и `SELECT` на всех service-таблицах/sequences.

Первая migration автоматически отзывает у runtime/grantee доступ к служебной
`notification_delivery._prisma_migrations`, сохраняя default CRUD grants только
для рабочих таблиц сервиса. Сама schema создаётся bootstrap-процедурой до
релиза: service migration не выполняет `CREATE SCHEMA` и проходит с
`database CREATE=false`.

Миграции сервиса нельзя запускать из runtime URL:

```bash
NOTIFICATION_DELIVERY_DATABASE_URL="$NOTIFICATION_DELIVERY_MIGRATION_URL_PRODUCTION" \
  pnpm --dir apps/notification-delivery run prisma:migrate:deploy
```

Campaigns владеет отдельной database `winwidget_campaigns`, schema
`campaigns`, PostgreSQL-контейнером на loopback
`127.0.0.1:55433` и external volume
`winwidget-campaigns-postgres-data`. Для него также обязательны три разные
least-privilege роли:

- migration-role из `CAMPAIGNS_MIGRATION_DATABASE_URL` применяет DDL только
  через one-shot `campaigns-migrate`;
- runtime-role из `CAMPAIGNS_DATABASE_URL` доступна только
  `campaigns-service` и не получает DDL-права;
- backup-role из `CAMPAIGNS_BACKUP_URL` получает только чтение для
  `maintenance-worker`.

Schema `campaigns` создаётся bootstrap-процедурой с владельцем
migration-role до запуска Prisma. Initial migration не выполняет
`CREATE SCHEMA`, поэтому migration-role работает с
`database CREATE=false` и не может создавать произвольные schemas.

Миграции Campaigns нельзя запускать из runtime URL:

```bash
CAMPAIGNS_DATABASE_URL="$CAMPAIGNS_MIGRATION_DATABASE_URL" \
  pnpm --dir apps/campaigns run prisma:migrate:deploy
```

Production compose отслеживается вместе с backend-кодом в
`deploy/docker-compose.prod.yml`. В нём подготовлены отдельные
`campaigns-service`, `campaigns-migrate` и `campaigns-postgres`, но их
production-включение выполняется только согласованным Campaigns cutover.
Наличие service/image/Compose-конфигурации не означает, что перенос данных,
переключение Gateway, restore drill и production smoke уже выполнены.
Notification Delivery и Maintenance собираются в отдельные immutable images,
имеют loopback health endpoints на `4401` и `4300` и могут выкатываться
независимо после первого baseline deploy. Контейнеры миграций запускаются
только на время деплоя. Основная БД монолита пока остаётся управляемой
облачной PostgreSQL. PostgreSQL Notification Delivery запускается только
явным one-time database cutover через profile
`notification-delivery-database`: обычные app deploy/rollback не создают, не
останавливают и не пересоздают его, а также не удаляют external volume.
Image Notification Delivery собирается только из
`apps/notification-delivery`: в нём есть только собственные `dist`, Prisma
schema/client и production dependencies — без `dist`, Prisma client, виджетов
или production dependencies монолита.
Image Campaigns аналогично собирается только из `apps/campaigns`, использует
собственный Prisma Client и публикует API/health только на
`127.0.0.1:4500`.
RabbitMQ хранит данные в persistent volume, а его AMQP и management-порты
привязаны только к `127.0.0.1` backend VPS. PostgreSQL Notification Delivery
аналогично публикует `5432` только на `127.0.0.1:55432`; наружу VPS этот порт
не открывается. PostgreSQL Campaigns использует тот же принцип на
`127.0.0.1:55433`. Для каждой service database используется отдельная
bridge-сеть; service и migration-контейнеры работают в host network и
подключаются к PostgreSQL через loopback.

## RabbitMQ и transactional outbox

Локальный `.env` для запуска publisher/worker с RabbitMQ на localhost:

```env
RABBITMQ_USER=winwidget
RABBITMQ_PASSWORD=winwidget
RABBITMQ_VHOST=winwidget
RABBITMQ_URL=amqp://winwidget:winwidget@127.0.0.1:5672/winwidget
RABBITMQ_ASSERT_TOPOLOGY=true
RABBITMQ_MANAGEMENT_URL=http://127.0.0.1:15672
RABBITMQ_MONITOR_USER=winwidget
RABBITMQ_MONITOR_PASSWORD=winwidget
OUTBOX_BATCH_SIZE=50
OUTBOX_POLL_INTERVAL_MS=500
OUTBOX_RETENTION_DAYS=7
RABBITMQ_WORKER_PREFETCH=10
MAINTENANCE_WORKER_PREFETCH=1
SCHEDULED_JOB_POLL_INTERVAL_MS=30000
SCHEDULED_JOB_LEASE_MS=120000
SCHEDULED_JOB_LEASE_RENEW_INTERVAL_MS=30000
MESSAGING_ALERTS_ENABLED=false
MESSAGING_ACTIVITY_STALE_MS=300000
MESSAGING_QUEUE_BACKLOG_ALERT_THRESHOLD=100
INTEGRATION_RECEIPT_RETENTION_DAYS=90
INTEGRATION_FAILURE_DETAIL_RETENTION_DAYS=30
INTEGRATION_WORKER_KINDS=webhook,bitrix24,amo-crm,daily-summary-telegram,telegram-destination-unavailable,notification-delivery-outcome,campaign-admin-audit,auto-renewal
NOTIFICATION_DELIVERY_DATABASE_URL=postgresql://notification_delivery_runtime:<password>@127.0.0.1:55432/winwidget_notification_delivery?schema=notification_delivery&sslmode=disable
NOTIFICATION_DELIVERY_MIGRATION_URL_PRODUCTION=postgresql://notification_delivery_migration:<password>@127.0.0.1:55432/winwidget_notification_delivery?schema=notification_delivery&sslmode=disable
NOTIFICATION_DELIVERY_BACKUP_URL=postgresql://notification_delivery_backup:<password>@127.0.0.1:55432/winwidget_notification_delivery?schema=notification_delivery&sslmode=disable
NOTIFICATION_DELIVERY_INTERNAL_TOKEN=<random-token-at-least-32-chars>
NOTIFICATION_DELIVERY_LISTEN_HOST=127.0.0.1
NOTIFICATION_DELIVERY_HEALTH_PORT=4401
NOTIFICATION_DELIVERY_PREFETCH=5
NOTIFICATION_DELIVERY_KINDS=email,telegram,payment-email,payment-telegram,limit-email,limit-telegram,campaign-email,campaign-telegram,daily-summary-delivery-telegram,subscription-expiry-email,subscription-expiry-telegram
NOTIFICATION_DELIVERY_RECEIPT_RETENTION_DAYS=90
NOTIFICATION_DELIVERY_FAILURE_DETAIL_RETENTION_DAYS=30
CAMPAIGNS_DATABASE_URL=postgresql://winwidget_campaigns_runtime:<password>@127.0.0.1:55433/winwidget_campaigns?schema=campaigns&sslmode=disable
CAMPAIGNS_MIGRATION_DATABASE_URL=postgresql://winwidget_campaigns_migration:<password>@127.0.0.1:55433/winwidget_campaigns?schema=campaigns&sslmode=disable
CAMPAIGNS_BACKUP_URL=postgresql://winwidget_campaigns_backup:<password>@127.0.0.1:55433/winwidget_campaigns?schema=campaigns&sslmode=disable
CAMPAIGNS_PROCESS_ROLE=all
CAMPAIGNS_LISTEN_HOST=127.0.0.1
CAMPAIGNS_HEALTH_PORT=4500
CAMPAIGNS_CORE_INTERNAL_BASE_URL=http://127.0.0.1:4200
CAMPAIGNS_INTERNAL_TOKEN=<random-token-at-least-32-chars>
CAMPAIGNS_INTERNAL_TIMEOUT_MS=10000
CAMPAIGNS_PREFETCH=10
CAMPAIGNS_EMAIL_RATE_PER_SECOND=10
CAMPAIGNS_TELEGRAM_RATE_PER_SECOND=5
CAMPAIGNS_OUTBOX_BATCH_SIZE=50
CAMPAIGNS_OUTBOX_POLL_INTERVAL_MS=1000
CAMPAIGNS_OUTBOX_RETENTION_DAYS=7
MAINTENANCE_WORKER_KINDS=database-backup
```

В production пароль должен отличаться от локального. Удобно использовать
hex-пароль: он не требует percent-encoding внутри URL.

```bash
openssl rand -hex 32
```

В production используются отдельные service accounts, локальный loopback-порт
и verified external volume. Полный preflight и permissions runbook находится в
`../deploy/backend/README.md`. Минимальный набор в
`/opt/winwidget/deploy/backend/.env.production`:

`NOTIFICATION_DELIVERY_IMAGE`/`NOTIFICATION_DELIVERY_REVISION` и
`CAMPAIGNS_IMAGE`/`CAMPAIGNS_REVISION` в этом файле не хранятся.
Соответствующие deploy-скрипты экспортируют immutable image tag и полный
commit SHA, поэтому OCI revision всегда относится к проверяемому релизу.
Отдельный Campaigns deploy разрешён только после завершённого согласованного
cutover и durable lifecycle marker.

```env
COMPOSE_PROJECT_NAME=winwidget
RABBITMQ_DATA_VOLUME=<verified-existing-volume>
RABBITMQ_VHOST=winwidget
RABBITMQ_ADMIN_USER=winwidget-admin
RABBITMQ_ADMIN_PASSWORD=<полученный-hex-пароль>
RABBITMQ_MONITOR_USER=winwidget-monitor
RABBITMQ_MONITOR_PASSWORD=<отдельный-hex-пароль>
RABBITMQ_PUBLISHER_URL=amqp://winwidget-publisher:<url-encoded-password>@127.0.0.1:5672/winwidget
RABBITMQ_INTEGRATION_WORKER_URL=amqp://winwidget-integration:<url-encoded-password>@127.0.0.1:5672/winwidget
RABBITMQ_CAMPAIGNS_URL=amqp://winwidget-campaigns:<url-encoded-password>@127.0.0.1:5672/winwidget
RABBITMQ_NOTIFICATION_DELIVERY_URL=amqp://winwidget-notification-delivery:<url-encoded-password>@127.0.0.1:5672/winwidget
RABBITMQ_MAINTENANCE_WORKER_URL=amqp://winwidget-maintenance:<url-encoded-password>@127.0.0.1:5672/winwidget
RABBITMQ_MANAGEMENT_URL=http://127.0.0.1:15672
OUTBOX_BATCH_SIZE=50
OUTBOX_POLL_INTERVAL_MS=1000
OUTBOX_RETENTION_DAYS=7
RABBITMQ_WORKER_PREFETCH=10
MAINTENANCE_WORKER_PREFETCH=1
SCHEDULED_JOB_POLL_INTERVAL_MS=30000
SCHEDULED_JOB_LEASE_MS=120000
SCHEDULED_JOB_LEASE_RENEW_INTERVAL_MS=30000
MESSAGING_ALERTS_ENABLED=true
MESSAGING_ACTIVITY_STALE_MS=300000
MESSAGING_QUEUE_BACKLOG_ALERT_THRESHOLD=100
INTEGRATION_RECEIPT_RETENTION_DAYS=90
INTEGRATION_FAILURE_DETAIL_RETENTION_DAYS=30
INTEGRATION_WORKER_KINDS=webhook,bitrix24,amo-crm,daily-summary-telegram,telegram-destination-unavailable,notification-delivery-outcome,campaign-admin-audit,auto-renewal
NOTIFICATION_DELIVERY_POSTGRES_IMAGE=postgres:18-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296
NOTIFICATION_DELIVERY_POSTGRES_PORT=55432
NOTIFICATION_DELIVERY_POSTGRES_DATA_VOLUME=winwidget-notification-delivery-postgres-data
NOTIFICATION_DELIVERY_POSTGRES_ADMIN_USER=winwidget_notification_delivery_admin
NOTIFICATION_DELIVERY_POSTGRES_ADMIN_PASSWORD_FILE=/opt/winwidget/deploy/backend/.notification-delivery-postgres-admin-password
NOTIFICATION_DELIVERY_MIGRATION_URL_PRODUCTION=postgresql://winwidget_notification_delivery_migration:<password>@127.0.0.1:55432/winwidget_notification_delivery?schema=notification_delivery&sslmode=disable
NOTIFICATION_DELIVERY_DATABASE_URL=postgresql://winwidget_notification_delivery_runtime:<password>@127.0.0.1:55432/winwidget_notification_delivery?schema=notification_delivery&sslmode=disable
NOTIFICATION_DELIVERY_BACKUP_URL=postgresql://winwidget_notification_delivery_backup:<password>@127.0.0.1:55432/winwidget_notification_delivery?schema=notification_delivery&sslmode=disable
NOTIFICATION_DELIVERY_INTERNAL_TOKEN=<random-token-at-least-32-chars>
NOTIFICATION_DELIVERY_KINDS=email,telegram,payment-email,payment-telegram,limit-email,limit-telegram,campaign-email,campaign-telegram,daily-summary-delivery-telegram,subscription-expiry-email,subscription-expiry-telegram
NOTIFICATION_DELIVERY_RECEIPT_RETENTION_DAYS=90
NOTIFICATION_DELIVERY_FAILURE_DETAIL_RETENTION_DAYS=30
CAMPAIGNS_POSTGRES_IMAGE=postgres:18-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296
CAMPAIGNS_POSTGRES_PORT=55433
CAMPAIGNS_POSTGRES_DATA_VOLUME=winwidget-campaigns-postgres-data
CAMPAIGNS_POSTGRES_ADMIN_USER=winwidget_campaigns_admin
CAMPAIGNS_POSTGRES_ADMIN_PASSWORD_FILE=/opt/winwidget/deploy/backend/.campaigns-postgres-admin-password
CAMPAIGNS_MIGRATION_DATABASE_URL=postgresql://winwidget_campaigns_migration:<password>@127.0.0.1:55433/winwidget_campaigns?schema=campaigns&sslmode=disable
CAMPAIGNS_DATABASE_URL=postgresql://winwidget_campaigns_runtime:<password>@127.0.0.1:55433/winwidget_campaigns?schema=campaigns&sslmode=disable
CAMPAIGNS_BACKUP_URL=postgresql://winwidget_campaigns_backup:<password>@127.0.0.1:55433/winwidget_campaigns?schema=campaigns&sslmode=disable
CAMPAIGNS_PROCESS_ROLE=all
CAMPAIGNS_LISTEN_HOST=127.0.0.1
CAMPAIGNS_HEALTH_PORT=4500
CAMPAIGNS_CORE_INTERNAL_BASE_URL=http://127.0.0.1:4200
CAMPAIGNS_INTERNAL_TOKEN=<random-token-at-least-32-chars>
CAMPAIGNS_INTERNAL_TIMEOUT_MS=10000
CAMPAIGNS_PREFETCH=10
CAMPAIGNS_EMAIL_RATE_PER_SECOND=10
CAMPAIGNS_TELEGRAM_RATE_PER_SECOND=5
CAMPAIGNS_OUTBOX_BATCH_SIZE=50
CAMPAIGNS_OUTBOX_POLL_INTERVAL_MS=1000
CAMPAIGNS_OUTBOX_RETENTION_DAYS=7
MAINTENANCE_WORKER_KINDS=database-backup
```

Все три Notification Delivery URL должны указывать на одинаковые protocol,
host, port, database и SSL-параметры; различаются только login/password.
После cutover они обязаны использовать
`127.0.0.1:55432/winwidget_notification_delivery` и ровно
`sslmode=disable`, потому что соединение не выходит за пределы VPS. До cutover
скрипт принимает текущие три URL облачной source database и атомарно заменяет
их target-значениями.

Три Campaigns URL подчиняются той же границе и после согласованного cutover
обязаны указывать на
`127.0.0.1:55433/winwidget_campaigns?schema=campaigns&sslmode=disable`,
различаясь только логином и паролем. До cutover routine
`scripts/deploy-campaigns-production.sh` заблокирован lifecycle marker и не
создаёт service database автоматически.

Production source проверена как PostgreSQL 18 с locale identity
`UTF8/libc/C.UTF-8`. Поэтому target использует PostgreSQL 18 Bookworm по
immutable multi-arch digest и создаётся с той же locale; несовпадение major,
encoding, provider, `LC_COLLATE` или `LC_CTYPE` fail-closed останавливает
cutover.

Production deploy завершается до изменения runtime, если service credentials,
verified volume или полный точный список consumers не заданы. Additive
Notification Delivery migration и privilege smoke выполняются до quiesce.
Provider cutover запрещает одновременно переносить pending core migration,
затем останавливает producers, дренирует legacy payment/limit, mailing и daily
summary очереди, проверяет отсутствие `PROCESSING` subscription reminders и
только после этого переключает физическую доставку на новый сервис.

Назначение настроек:

- `RABBITMQ_MANAGEMENT_URL` — внутренний HTTP endpoint RabbitMQ Management API
  для health-check и административного мониторинга; бизнес-события через него
  не публикуются;
- `OUTBOX_BATCH_SIZE` — максимум событий, захватываемых publisher за цикл;
- `OUTBOX_POLL_INTERVAL_MS` — интервал чтения outbox;
- `OUTBOX_RETENTION_DAYS` — срок хранения успешно опубликованных событий;
  очистка выполняется ограниченными пакетами;
- `RABBITMQ_WORKER_PREFETCH` — максимум неподтверждённых сообщений на каждый
  main/DLQ consumer, а не общий лимит процесса;
- `MAINTENANCE_WORKER_PREFETCH` — число backup-задач, одновременно получаемых
  maintenance worker; production-значение `1` не допускает параллельные
  `pg_dump` в одном процессе;
- `SCHEDULED_JOB_POLL_INTERVAL_MS` — интервал проверки расписания durable-задач;
- `SCHEDULED_JOB_LEASE_MS` — срок CAS-lease длительной задачи;
- `SCHEDULED_JOB_LEASE_RENEW_INTERVAL_MS` — интервал продления lease, который
  должен быть меньше `SCHEDULED_JOB_LEASE_MS`;
- `MESSAGING_ALERTS_ENABLED` — Telegram-алерты о недоступных messaging-процессах,
  необработанных ошибках, Rabbit alarm, очередях без consumers/backlog и
  событиях Outbox, ожидающих больше 15 минут;
- `MESSAGING_ACTIVITY_STALE_MS` — окно контроля последнего успешного
  poll/publish/consume;
- `MESSAGING_QUEUE_BACKLOG_ALERT_THRESHOLD` — порог сообщений в одной queue;
- `INTEGRATION_RECEIPT_RETENTION_DAYS` — срок хранения отметок об успешной доставке, минимум 30 дней;
- `INTEGRATION_FAILURE_DETAIL_RETENTION_DAYS` — срок хранения payload и текстов
  ошибки только у уже resolved DLQ; classification и audit metadata остаются;
- `INTEGRATION_WORKER_KINDS` — consumers, запускаемые integration worker;
- `MAINTENANCE_WORKER_KINDS` — consumers длительных регламентных задач,
  запускаемые maintenance worker;
- `CAMPAIGNS_EMAIL_RATE_PER_SECOND` и
  `CAMPAIGNS_TELEGRAM_RATE_PER_SECOND` — независимые service-owned лимиты
  публикации запросов на физическую доставку;
- `CAMPAIGNS_PREFETCH` — число сообщений, одновременно захватываемых каждым
  Campaigns consumer;
- `CAMPAIGNS_OUTBOX_*` — batch, polling и retention собственного
  transactional Outbox Campaigns.

Административный health и operational alert дополнительно контролируют
`scheduled_job_runs`: окончательные `FAILED`, задания `QUEUED` с задержкой
больше 15 минут и `PROCESSING` с просроченным lease.

Worker получает сообщения из RabbitMQ по push-модели через `basic.consume`:
broker доставляет сообщение сам, а worker подтверждает обработку через `ack`.
Pull-чтение (`basic.get`) для рабочих очередей не используется. Отдельный
polling применяется только publisher-процессом при чтении PostgreSQL Outbox.

Целевое владение messaging-процессами после Campaigns cutover:

| Процесс                        | Ответственность                                                                                                                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outbox-publisher`             | Публикация transactional Outbox монолита и создание принадлежащей монолиту RabbitMQ topology                                                                                                  |
| `campaigns-service`            | Снимки аудитории, состояние кампаний и доставок, service-owned Outbox/rate limits, snapshot/outcome consumers и их receipts/retry/DLQ                                                         |
| `notification-delivery-worker` | Физическая email/Telegram-доставка лидов, платежей, лимитов, кампаний, daily summary и subscription expiry; собственные receipts, failures, retry/DLQ Outbox, delivery outcomes и control API |
| `integration-worker`           | CRM/webhook, daily summary, монолитный `notification-delivery-outcome`, недоступность пользовательского Telegram-канала, campaign admin audit и auto-renewal; без campaign lifecycle/outcomes |
| `maintenance-worker`           | Durable scheduler/lease и независимые backup-задачи для core, Notification Delivery и Campaigns                                                                                               |

Один kind не должен одновременно находиться у `integration-worker` и
`notification-delivery-worker`. Первичный Outbox остаётся в транзакции
производящего домена, а сервис доставки владеет только состоянием выполнения
своих уведомлений.

Успешная оплата обрабатывается следующим образом:

1. Статус платежа, подписка и событие `payment.succeeded.v1` записываются одной
   транзакцией PostgreSQL.
2. Outbox publisher публикует событие в RabbitMQ.
3. RabbitMQ направляет одно событие в две независимые очереди:
   `winwidget.payment-notification.email` и
   `winwidget.payment-notification.telegram`.
4. Каждый consumer имеет собственные receipt, retry и DLQ. Сбой Telegram не
   блокирует email и наоборот.

Publisher подтверждает публикацию только после broker confirm и проверки
`mandatory return`. Если маршрута для события нет или RabbitMQ временно
недоступен, Outbox остаётся в `PENDING` и повторяется с ограниченным backoff без
необратимого лимита транспортных попыток.

Переход scheduled job в окончательный `FAILED` и намерение доставки в его DLQ
фиксируются одной PostgreSQL-транзакцией. Outbox publisher отправляет это
намерение через `winwidget.events` по `<kind>.dead-letter`; соответствующая
durable DLQ привязана и к events exchange, и к обычному dead-letter exchange
consumer’а. Поэтому сбой RabbitMQ после terminal commit не оставляет ошибку
только в PostgreSQL. Для malformed/poison-сообщения без валидного `messageId`
используется детерминированный UUIDv8 от AMQP envelope и содержимого: redelivery
не создаёт новую failure-запись.

Бизнес-критичные изменения платежа и подписки остаются синхронными в
PostgreSQL. Через RabbitMQ выполняются только побочные уведомления.

### Campaigns Service

`apps/campaigns` владеет campaign lifecycle, immutable-снимками аудитории,
доставками, control actions, idempotency, rate limits, transactional Outbox,
consumer receipts и heartbeat. В целевой single-VPS схеме сервис запускается
с `CAMPAIGNS_PROCESS_ROLE=all`; роли `api`, `worker` и `publisher` позволяют
разделить процессы позднее без изменения доменного контракта.

После согласованного cutover внешний контракт проходит через Gateway по
префиксу `/api/v1/admin/campaigns`:

- `POST /` — создать кампанию; ADMIN, обязательный UUID
  `Idempotency-Key`;
- `GET /` и `GET /:id` — список и детали; ADMIN;
- `POST /:id/cancel` — отменить кампанию; ADMIN;
- `GET /:id/deliveries?page=&limit=&status=` — серверная пагинация доставок;
  ADMIN;
- `POST /:id/deliveries/:deliveryId/retry` — retry одной доставки; DEV,
  обязательный UUID `Idempotency-Key`.

Detail DTO возвращает `snapshots` как массив по каналам:
`{id, sourceSnapshotId, channel, status, recipientCount, sha256, asOf,
completedAt}`. Campaigns получает авторизацию и NDJSON export аудитории только
через fail-closed internal API монолита с отдельным
`CAMPAIGNS_INTERNAL_TOKEN`; destination, count и SHA-256 проверяются в
каноническом отсортированном виде.

Физическая email/Telegram-доставка остаётся у Notification Delivery через
`notification.campaign.*.requested.v2`. Результаты возвращаются в отдельную
Campaigns outcome queue, а `admin.audit.event.v1` обрабатывает
`integration-worker`. Campaigns публикует зависимые события только из
собственного transactional Outbox с publisher confirm и `mandatory return`.

Production cutover ещё не выполнен: до переключения обязательны backup и
restore drill, проверка ролей, миграций, очередей, health/revision, rollback и
smoke. Отдельным блокирующим pre-source-drop gate остаётся P1-аудит ошибочно
отключённых Telegram-каналов по legacy delivery/failure данным. Старые URL,
dual-write и compatibility aliases не сохраняются; источник удаляется только
после подтверждённого forward-only этапа. Полный порядок находится в
`../DOCUMENTATION/DEPLOYMENT.md`, чек-лист — в
`../DOCUMENTATION/DEPLOY_CHECKLIST.md`, незавершённые production gates — в
`../DOCUMENTATION/BACKLOG.md`.

### Уведомление о лимите заявок

Когда последняя доступная заявка фиксируется в PostgreSQL, событие
`lead.limit.reached.email.v2` создаётся отдельно для каждого email-получателя, а
`lead.limit.reached.telegram.v2` — для Telegram destination. Все события
создаются в той же транзакции и поступают в независимые email и Telegram queues.
Прежняя fire-and-forget отправка из API-процесса удалена.

### Ежедневная Telegram-сводка

Scheduler работает в `maintenance-worker`, а не в API. Для отчётного периода
он одной транзакцией PostgreSQL создаёт durable-запуск с уникальным ключом и
Outbox-событие. Событие фиксирует границы периода и поступает в отдельную
очередь `winwidget.report.daily-summary.telegram`; отправку, retry и DLQ
обрабатывает `integration-worker`. Поэтому повтор после сбоя не выбирает уже
другой день, несколько replicas scheduler не создают два запуска, а startup API
не ждёт формирования или отправки сводки.

Доставка остаётся `at-least-once`: Telegram Bot API не поддерживает
идемпотентный ключ. Если процесс завершится после успешного `sendMessage`, но до
фиксации `SUCCEEDED` в PostgreSQL, retry может повторно отправить сводку. Lease,
receipt и checkpoint предотвращают параллельную обработку и повторное
формирование после сохранённого checkpoint, но не могут атомарно объединить
Telegram и PostgreSQL.

### Backup PostgreSQL

Для основной БД (`core`), Notification Delivery
(`notification-delivery`) и Campaigns (`campaigns`) создаются независимые
durable-задания: `DATABASE_BACKUP`,
`NOTIFICATION_DELIVERY_DATABASE_BACKUP` и
`CAMPAIGNS_DATABASE_BACKUP`. Плановый backup основной БД запускается в
настроенное время, Notification Delivery — через 15 минут, Campaigns — через
30 минут, чтобы три `pg_dump` не конкурировали за CPU, disk I/O и Telegram
upload. Результаты отправляются отдельными документами в настроенную
Telegram-тему вне VPS.

Плановый и ручной backup сначала создают durable-задание в основной PostgreSQL
и Outbox-событие. API только ставит ручной запуск в очередь и не выполняет
`pg_dump` внутри HTTP-запроса. Отдельный `maintenance-worker` получает ID
задания из `winwidget.maintenance.database-backup`, атомарно захватывает его
через CAS и продлевает lease во время длительной работы. RabbitMQ не содержит
файл backup или секреты подключения. В production временный dump создаётся в
отдельном `tmpfs` maintenance-контейнера с лимитом 64 МБ и удаляется в
`finally`; максимальный размер каждого отправляемого файла ограничен 49 МБ.

В production обязательны три независимых read-only подключения на прямые
PostgreSQL endpoints:

- `DATABASE_BACKUP_URL` — основная БД;
- `NOTIFICATION_DELIVERY_BACKUP_URL` — отдельный PostgreSQL-контейнер
  Notification Delivery;
- `CAMPAIGNS_BACKUP_URL` — отдельный PostgreSQL-контейнер Campaigns.

`pg_dump` не должен идти через transaction pooler. Пароль удаляется из
аргументов процесса и передаётся `pg_dump` только через `PGPASSWORD`;
Prisma-only параметры подключения удаляются.

Контракт ручного запуска возвращает принятое в очередь задание, а не готовый
файл. Для каждого target используется
`POST /api/v1/telegram-bot/admin/database-backups/:target/send`, где `target` —
`core`, `notification-delivery` или `campaigns`; запрос требует заголовок
`Idempotency-Key` с UUID. Ключ сохраняется в детерминированном `scheduleKey`
вместе с ID администратора и target, а также в отдельной таблице соответствий
`adminId + jobType + idempotencyKey → jobId`. Поэтому повтор HTTP-запроса
возвращает тот же job даже после его завершения и не создаёт второй Outbox или
audit event. Если у этого администратора уже есть активный ручной backup того
же target, новый ключ атомарно связывается с текущим job; новый job появляется
только после завершения активного. FK с `ON DELETE RESTRICT` защищает
соответствие от случайного удаления job. Проверка и создание защищены коротким
transaction-scoped advisory lock только на команду данного администратора и
target; этот lock завершается до `pg_dump`.

Интерфейс ручного запуска и polling трёх targets расположен на странице
`/admin/databases`. Для каждого target есть отдельная кнопка и независимый
статус. Админка восстанавливает polling после reload через
`GET /api/v1/telegram-bot/admin/database-backups/:target/jobs/active` и
локальный marker. Endpoint и получение конкретного ручного job проверяют
`input.requestedByAdminId`, поэтому один администратор не получает состояние
чужого запуска.

Восстановление остаётся отдельной операцией только для роли `DEV`:
`POST /api/v1/dev-tools/database-backup/restore`. Строка повторного подтверждения
получается через `GET /api/v1/dev-tools/database-backup/restore-settings` и больше
не входит в настройки Telegram-бота. Поэтому DEV-блок страницы «Базы данных»
не зависит от загрузки Telegram settings; ограничение файла 49 МБ, проверка
формата `.dump` и audit event восстановления сохранены. До destructive
`pg_restore --clean` сервер читает TOC: требует схему `public` и fail-closed
отклоняет dump со схемой `notification_delivery`.
Проверка TOC не подтверждает происхождение произвольного архива со схемой
`public`: перед запуском DEV обязан проверить, что выбран актуальный core dump
WinWidget из доверенного backup-контура.

Для Telegram-документа действует тот же `at-least-once` предел: авария после
успешной загрузки файла, но до фиксации результата job может привести к
повторной отправке. Одновременно один job выполняет только владелец актуального
lease; состояние и окончательные ошибки остаются наблюдаемыми в PostgreSQL.

При штатной остановке `maintenance-worker` сначала отменяет RabbitMQ consumers,
прерывает активный `pg_dump` и в пределах ограниченного shutdown-окна возвращает
принадлежащий ему job из `PROCESSING` в `QUEUED` по `jobId + leaseToken`.
Возврат job и новый Outbox-event фиксируются одной PostgreSQL-транзакцией, а
увеличенная при claim попытка компенсируется. Production compose оставляет
контейнеру 30 секунд на завершение; lease recovery остаётся аварийным fallback
при `SIGKILL`, недоступной PostgreSQL или превышении shutdown-окна.

Maintenance публикует собственные loopback endpoints:

```text
GET http://127.0.0.1:4300/health/live
GET http://127.0.0.1:4300/health/ready
```

Readiness становится успешным только после регистрации consumers и проверяет
текущие RabbitMQ connection, shared Prisma connection и shutdown-state. Ответ
содержит точную OCI revision; перед drain readiness переключается в
неуспешное состояние.

Для всех scheduler не вводится общий PostgreSQL-lock. Уникальный ключ периода
защищает расписание от дублей, длительный backup использует возобновляемый
lease, а короткие идемпотентные очистки остаются без распределённой блокировки.
Транзакция и advisory lock не удерживаются во время `pg_dump` или сетевой
отправки.

На текущем бюджетном single-VPS этапе два Telegram-документа приняты как
off-VPS защита: потеря VPS вместе с Docker volumes не уничтожает единственную
копию dump. Эта схема не даёт PITR, имеет жёсткий лимит 49 МБ на файл и требует
регулярного restore drill. При росте данных или требований к RPO/RTO backups
нужно перенести в зашифрованное versioned object storage и отдельно внедрить
WAL/PITR либо managed PostgreSQL. Восстановление базы не выполняется worker
автоматически: это отдельная защищённая операция по runbook.

Напоминания об окончании подписки пока остаются в существующем scheduler:
у них уже есть PostgreSQL-дедупликация. Остальные отчёты и административные
задачи в RabbitMQ автоматически не переносятся.

RabbitMQ Management UI слушает только `127.0.0.1:15672`. Не открывайте этот
порт публично. Для временного доступа используйте SSH tunnel:

```bash
ssh -L 15672:127.0.0.1:15672 <user>@<backend-vps>
```

После этого интерфейс доступен локально по `http://127.0.0.1:15672`.

Обзор состояния Outbox/RabbitMQ (`GET /api/v1/messaging/admin/overview`) доступен
ролям `ADMIN` и `DEV`. Просмотр общего DLQ и ручной retry доступны только роли
`DEV`. Обычные администраторы также управляют массовыми кампаниями на странице
«Рассылки», но не имеют доступа к подробному списку ошибок доставки и их
повторному запуску.

### Гарантии доставки и защита от дублей

Система использует доставку `at-least-once`: событие не теряется при временной
недоступности RabbitMQ или внешнего сервиса, но при аварии в момент внешнего
запроса теоретически возможна повторная доставка.

- оставшийся monolith integration worker хранит пару `eventId + consumer` в
  `integration_delivery_receipts`, а Notification Delivery — в
  `notification_delivery.delivery_receipts`; оба не обрабатывают уже
  завершённую доставку повторно;
- перед внешним вызовом worker атомарно захватывает receipt в состоянии
  `PROCESSING`; параллельный consumer не выполняет тот же вызов, а зависший
  claim можно восстановить по lease;
- webhook получает стабильный `eventId` в JSON и заголовке
  `X-WinWidget-Event-Id`, чтобы принимающая сторона могла реализовать свою
  идемпотентность;
- email получает стабильный `Message-ID`;
- Telegram, Битрикс24 и amoCRM не предоставляют общей транзакции с нашей БД,
  поэтому абсолютная exactly-once гарантия для них технически невозможна;
- старые receipts удаляются worker по
  `INTEGRATION_RECEIPT_RETENTION_DAYS` или
  `NOTIFICATION_DELIVERY_RECEIPT_RETENTION_DAYS` ограниченными пакетами.

### Production runbook

Единственный compose, используемый CI/CD:
`winwidget.ru_server/deploy/docker-compose.prod.yml`. Root-файл
`deploy/backend/docker-compose.prod.yml` содержит только Compose `include` на
канонический файл и не дублирует services.

Перед первым production-деплоем:

1. Убедиться, что у облачной PostgreSQL есть актуальный backup/snapshot.
2. Заполнить RabbitMQ-переменные в
   `/opt/winwidget/deploy/backend/.env.production`.
3. Проверить, что management-порт `15672` и AMQP-порт `5672` доступны только
   через localhost.
4. Запустить штатный CI/CD. До остановки старых процессов deploy создаст или
   обновит RabbitMQ service users на verified external volume и применит
   least-privilege permissions. Затем контейнер `migrate` применит миграции до
   запуска новой версии API и worker.
5. Открыть `/admin/system` и `/admin/messaging`: RabbitMQ, publisher,
   integration worker, Notification Delivery и maintenance worker должны иметь
   статус `Работает`, а объединённые Outbox/DLQ — не накапливаться.

Диагностика:

```bash
docker compose --env-file /opt/winwidget/deploy/backend/.env.production \
  -f /opt/winwidget/winwidget.ru_server/deploy/docker-compose.prod.yml ps

docker compose --env-file /opt/winwidget/deploy/backend/.env.production \
  -f /opt/winwidget/winwidget.ru_server/deploy/docker-compose.prod.yml \
  logs --tail=200 outbox-publisher integration-worker \
  notification-delivery-worker maintenance-worker rabbitmq
```

Аварийные сценарии:

- RabbitMQ недоступен: заявки продолжают сохраняться вместе с Outbox; после
  восстановления publisher отправит накопившиеся события.
- Worker недоступен: сообщения остаются в соответствующих durable-очередях
  RabbitMQ; при штатном `SIGTERM` активный backup сразу возвращается через
  transactional Outbox, а после принудительной остановки восстанавливается по
  истечении lease.
- Внешняя интеграция недоступна: выполняются повторы через 30 секунд, 5 и
  30 минут, затем событие сохраняется как DLQ-ошибка.
- PostgreSQL недоступна: API не подтверждает сохранение заявки, publisher и
  worker возобновляют работу после восстановления соединения/перезапуска.
- Ошибка в DLQ: устранить причину и нажать `Повторить` в
  `/admin/messaging`; действие попадёт в журнал событий, а команда retry —
  в PostgreSQL Outbox в той же транзакции с изменением состояния ошибки.

CI запускает `test:messaging-integration`, который после применения миграций
проверяет transaction-scoped advisory lock ручного backup на реальной
PostgreSQL, цепочки `Outbox → RabbitMQ`, `mandatory return`, маршрут ручного
retry, `RabbitMQ → DLQ → PostgreSQL`, наличие очередей ежедневной сводки и
backup, а также restart RabbitMQ с проверкой durable-сообщения и reconnect
publisher/consumers.

Отдельный app-local
`pnpm --dir apps/notification-delivery run test:integration` запускается с
реальными PostgreSQL, RabbitMQ и уже собранным production image Notification
Delivery без переопределения его `CMD`. CI создаёт schema-owner migration-role и
ограниченную runtime-role, применяет миграцию только первой ролью, а затем
проверяет runtime CRUD/sequence-права и запрет `CREATE/ALTER/DROP SCHEMA`.
Service подключается к RabbitMQ отдельным пользователем без configure-прав:
положительные и отрицательные tests доказывают доступ только к собственным
очередям и разрешённым exchanges. Smoke использует локальный TLS fake SMTP на
`127.0.0.1:465` и покрывает success, полный transient retry
`PENDING → PUBLISHED → DELIVERED`, terminal DLQ collection, duplicate, lease
recovery, internal auth, полный manual retry и close. Реальные SMTP и Telegram
endpoints в CI не вызываются; provider sandbox E2E остаётся отдельной
pre-production проверкой.

При неизвестном `MODE` или отсутствующей выбранной переменной backend
завершает запуск с ошибкой.

## Основные группы моделей

- Пользователи и авторизация: `User`, `AuthIdentity`,
  `VerificationChallenge`.
- Виджеты и заявки: `Widget`, `Quiz`, `Callback`, `CountdownTimer`,
  `StopOffer`, `OnlineConsultant`, `Calculator` и соответствующие lead models.
- Подписки и платежи: `Subscription`, `SubscriptionHistory`, `Payment`,
  `TariffPrice`, `AffiliateReferral`.
- Telegram: `TelegramNotificationChannel`, `TelegramSupportMessage`,
  `TelegramBotSettings`.
- Фоновые задачи: `ScheduledJobRun`.
- Администрирование и контент: `AdminEventLog`, `SiteSettings`, `LegalPage`,
  `HomePageContent`, `Note`.

Миграции хранятся в `prisma/migrations` и должны коммититься вместе с
изменением `schema.prisma`.

## Работа с Prisma

Сгенерировать Prisma Client:

```bash
pnpm prisma-generate
```

Проверить schema:

```bash
pnpm exec prisma validate
```

Создать migration нужно локально на development-базе:

```bash
DATABASE_URL='postgresql://user:password@localhost:5432/winwidget' \
pnpm exec prisma migrate dev --name <migration_name>
```

Применить уже закоммиченные development migrations:

```bash
pnpm dev-prisma-migration
```

Для production не используйте `prisma db push`. Production migrations
выпускаются через согласованный CI/CD flow и отдельный migration container.

`prisma migrate dev` требует shadow database. Локальный PostgreSQL user должен
иметь право `CREATE DATABASE`.

---

# Runtime-скрипты виджетов

Источник истины — читаемые файлы в `widgets-src`.

Собираются:

- `wheel.js`;
- `quiz.js`;
- `callback.js`;
- `timer.js`;
- `stop-offer.js`;
- `online-consultant.js`;
- `calculator.js`;
- `helpers/winwidget-phone.js`.

Также копируются изображения кнопок и
`helpers/libphonenumber-min.js`.

Правила разработки:

- редактируйте файлы в `widgets-src`;
- не редактируйте вручную `public/widgets`;
- после изменений запускайте полную сборку виджетов;
- не коммитьте generated runtime-файлы.

Сборка:

```bash
pnpm build:widgets
```

esbuild минифицирует JavaScript с target `es2018`, после чего
`build:widgets:check` проверяет наличие файлов и JS-синтаксис через
`node --check`.

Проверка без повторной сборки:

```bash
pnpm build:widgets:check
```

Полная backend-сборка автоматически включает runtime-виджеты:

```bash
pnpm build
```

---

# Подписки и платежи

## Подписки

- `TRIAL`: 7 дней, 1 виджет и до 10 заявок;
- `EASY`: 1 виджет и до 100 заявок;
- `HARD`: до 10 виджетов и безлимитные заявки;
- месячный и годовой billing;
- upgrade и renewal;
- история изменений;
- административная активация, продление и отмена;
- напоминания об окончании через email и Telegram.

Лимиты виджетов и заявок проверяются атомарно. Количество виджетов считается
сразу по всем поддерживаемым типам.

## Платежи

- ЮKassa;
- разные credentials для development и production;
- redirect confirmation;
- receipt с email или телефоном;
- повторная серверная проверка успешного webhook;
- восстановление и отмена pending payment;
- административный список и ручная проверка;
- автоматическая активация подписки;
- начисление affiliate reward после первого успешного платежа;
- очистка зависших `PENDING` платежей.

---

# Email, SMS, Telegram и файлы

## Email templates

Auth templates монолита находятся в `emails`:

- подтверждение email;
- восстановление пароля.

Шаблоны физической доставки находятся у владельца provider-контракта в
`apps/notification-delivery/emails`: заявки, платежи, лимиты, subscription
expiry и email кампаний (`admin-broadcast.email.tsx`).

Локальный preview:

```bash
pnpm email
```

## Telegram

Backend обслуживает три бота:

- Info Bot — заявки, уведомления и административная сводка;
- Auth Bot — вход и регистрация через Telegram;
- Support Bot — связь пользователя с поддержкой.

Webhook settings и health доступны в модуле `telegram-bot`.

## Файлы

```text
MODE=development -> локальный каталог uploads
MODE=production  -> S3-совместимое хранилище
```

Для пользовательских PNG-кнопок проверяются:

- формат PNG;
- прозрачный фон;
- 8-bit color depth;
- размер не больше `320x320`;
- вес не больше `200 КБ`.

---

# Фоновые задачи и health

Короткие регламентные операции остаются в API:

- очистка verification challenges;
- очистка зависших платежей;
- проверка подписок и expiry reminders;
- проверка Telegram webhooks.

Durable-задачи выполняются отдельными процессами:

- `maintenance-worker` создаёт уникальные периодические запуски ежедневной
  Telegram-сводки и трёх backup, выполняет `pg_dump` и восстанавливает
  зависшие задания по CAS-lease;
- `outbox-publisher` читает PostgreSQL Outbox и публикует события в RabbitMQ;
- после coordinated cutover `campaigns-service` в роли `all` обслуживает HTTP
  API, импортирует снимки, публикует собственный Outbox и применяет delivery
  outcomes;
- `integration-worker` обрабатывает сводку, CRM/webhook, монолитный
  `notification-delivery-outcome`, campaign admin audit и остальные
  принадлежащие монолиту consumers через независимые очереди, retry и DLQ.

Общий distributed lock для всех scheduler не используется. Очистки
verification challenges и зависших платежей идемпотентны, а durable-задачи
защищены уникальным ключом периода и lease. Перед увеличением количества API
replicas нужно добавить durable deduplication для expiry reminders и остальных
уведомлений, которые пока запускаются из API.

Административный health endpoint:

```text
GET /api/v1/health/admin
```

Он проверяет backend, PostgreSQL, RabbitMQ, heartbeat `outbox-publisher`,
`integration-worker` и `maintenance-worker`, накопление Outbox/DLQ, состояние
durable-задач, S3, SMTP, SMS Aero, reCAPTCHA, ЮKassa и три Telegram-бота. Итог
каждой проверки находится в массиве `checks` со статусом `ok`, `warning`,
`down` или `disabled`.

Campaigns имеет отдельные loopback endpoints
`http://127.0.0.1:4500/health/live` и `/health/ready`. Их production-проверка
вместе с revision/heartbeat обязательна при согласованном cutover и не
подтверждается одним admin health монолита.

---

# Установка и запуск

## Требования

- Node.js 20;
- pnpm 9;
- PostgreSQL;
- RabbitMQ 4 с Management plugin;
- заполненный `.env`.

## Установка зависимостей

```bash
corepack enable
corepack prepare pnpm@9.15.9 --activate
pnpm install --frozen-lockfile
pnpm --dir apps/api-gateway install --frozen-lockfile
pnpm --dir apps/notification-delivery install --frozen-lockfile
```

## Настройка окружения

```bash
cp .env.example .env
```

Заполните development-переменные и не коммитьте реальные секреты.

## Development

Для запуска только HTTP API:

```bash
pnpm prisma-generate
pnpm dev
```

Для полного локального messaging-контура сначала:

1. создайте database `winwidget_notification_delivery`, схему
   `notification_delivery` и отдельные migration/runtime/backup роли;
   runtime выдайте только `CONNECT`, schema `USAGE`, DML и sequence privileges,
   backup — только `CONNECT`, `USAGE` и `SELECT`;
2. примените service migration через migration-role;
3. запустите RabbitMQ с пользователем и vhost из `.env`;
4. соберите NestJS и запустите процессы в отдельных терминалах.

```bash
NOTIFICATION_DELIVERY_DATABASE_URL="$NOTIFICATION_DELIVERY_MIGRATION_URL_PRODUCTION" \
  pnpm --dir apps/notification-delivery run prisma:migrate:deploy

pnpm build:app
pnpm --dir apps/notification-delivery install --frozen-lockfile
pnpm --dir apps/notification-delivery run build
pnpm start:prod
pnpm start:outbox-publisher
pnpm start:integration-worker
pnpm --dir apps/notification-delivery run start:local
pnpm start:maintenance-worker
```

Monolith worker-команды запускают файлы из корневого `dist`, поэтому после их
изменений нужно повторить `pnpm build:app`. Notification Delivery собирается в
свой `apps/notification-delivery/dist` и не попадает в корневую сборку. HTTP API
можно продолжать запускать через `pnpm dev`, если watch mode удобнее. Для
runtime запуска
`NOTIFICATION_DELIVERY_DATABASE_URL` необходимо вернуть на URL ограниченной
runtime-роли; migration URL сервису не передаётся.

По `.env.example` backend доступен на:

```text
http://localhost:4200
```

Gateway запускается отдельным package после API:

```bash
pnpm --dir apps/api-gateway install --frozen-lockfile
pnpm --dir apps/api-gateway run build
pnpm start:api-gateway
```

По `.env.example` он слушает `http://127.0.0.1:4100`, проксирует только
`/api/v1` в API на `4200` и получает публичные ключи через JWKS. Локальный
скрипт читает корневой `.env` и использует `GATEWAY_PORT=4100`, даже когда
NestJS API использует `PORT=4200`.

## Production build

```bash
pnpm build
pnpm --dir apps/api-gateway run build
pnpm --dir apps/notification-delivery run build
pnpm start:prod
```

Результат NestJS-сборки находится в `dist`, runtime-виджеты — в
`public/widgets`, Gateway — в `apps/api-gateway/dist`, Notification Delivery —
в `apps/notification-delivery/dist`.

---

# Переменные окружения

## Приложение и база данных

```text
MODE
PORT
API_LISTEN_HOST
PRODUCTION_HOST
AUTH_COOKIE_DOMAIN
DATABASE_URL_DEVELOPMENT
DATABASE_URL_PRODUCTION
DATABASE_MIGRATION_URL_PRODUCTION
MAINTENANCE_DATABASE_URL_PRODUCTION
DATABASE_BACKUP_URL
TRUST_PROXY
CORS_ALLOWED_ORIGINS
```

## Auth, JWT и API Gateway

```text
JWT_ACCESS_PRIVATE_KEY_BASE64
JWT_ACCESS_JWKS_BASE64
JWT_ACCESS_ACTIVE_KID
JWT_ISSUER
JWT_AUDIENCE
JWT_ACCESS_TTL_SECONDS
JWT_CLOCK_TOLERANCE_SECONDS
GATEWAY_LISTEN_HOST
GATEWAY_PORT
GATEWAY_ROUTES_JSON
JWT_JWKS_URL
JWT_MAX_TOKEN_BYTES
JWKS_FETCH_TIMEOUT_MS
JWKS_REFRESH_MIN_INTERVAL_MS
JWKS_CACHE_TTL_MS
JWKS_MAX_STALE_MS
JWKS_MAX_BYTES
GATEWAY_SHUTDOWN_GRACE_MS
```

## reCAPTCHA

```text
RECAPTCHA_SECRET_KEY
RECAPTCHA_CLIENT_URL
RECAPTCHA_ENABLED
RECAPTCHA_MIN_SCORE
```

## SMTP и SMS Aero

```text
SMTP_LOGIN
SMTP_PASSWORD
SMTP_SERVER
SMSAERO_EMAIL
SMSAERO_API_KEY
SMSAERO_SIGN
```

## OAuth

```text
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_CALLBACK_URL

GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET
GITHUB_CALLBACK_URL

YANDEX_CLIENT_ID
YANDEX_CLIENT_SECRET
YANDEX_CALLBACK_URL

VK_CLIENT_ID
VK_CLIENT_SECRET
VK_SERVICE_TOKEN
VK_CALLBACK_URL
```

## ЮKassa

```text
YOOKASSA_SHOP_ID
YOOKASSA_SECRET_KEY
YOOKASSA_PRODUCTION_SHOP_ID
YOOKASSA_PRODUCTION_SECRET_KEY
```

## Telegram

```text
TELEGRAM_WEBHOOK_HOST

TELEGRAM_INFO_BOT_TOKEN
TELEGRAM_INFO_BOT_USERNAME
TELEGRAM_INFO_BOT_WEBHOOK_SECRET

TELEGRAM_AUTH_BOT_TOKEN
TELEGRAM_AUTH_BOT_USERNAME
TELEGRAM_AUTH_BOT_WEBHOOK_SECRET

TELEGRAM_SUPPORT_BOT_TOKEN
TELEGRAM_SUPPORT_BOT_USERNAME
TELEGRAM_SUPPORT_BOT_WEBHOOK_SECRET
```

## S3

Production storage:

```text
S3_ENDPOINT
S3_REGION
S3_BUCKET
S3_ACCESS_KEY_ID
S3_SECRET_ACCESS_KEY
S3_PUBLIC_BASE_URL
S3_KEY_PREFIX
S3_FORCE_PATH_STYLE
```

## RabbitMQ и фоновые процессы

```text
COMPOSE_PROJECT_NAME
RABBITMQ_DATA_VOLUME
RABBITMQ_ADMIN_USER
RABBITMQ_ADMIN_PASSWORD
RABBITMQ_MONITOR_USER
RABBITMQ_MONITOR_PASSWORD
RABBITMQ_VHOST
RABBITMQ_PUBLISHER_URL
RABBITMQ_INTEGRATION_WORKER_URL
RABBITMQ_CAMPAIGNS_URL
RABBITMQ_NOTIFICATION_DELIVERY_URL
RABBITMQ_MAINTENANCE_WORKER_URL
RABBITMQ_MANAGEMENT_URL
RABBITMQ_ASSERT_TOPOLOGY
OUTBOX_BATCH_SIZE
OUTBOX_POLL_INTERVAL_MS
OUTBOX_RETENTION_DAYS
RABBITMQ_WORKER_PREFETCH
MAINTENANCE_WORKER_PREFETCH
MAINTENANCE_HEALTH_PORT
SCHEDULED_JOB_POLL_INTERVAL_MS
SCHEDULED_JOB_LEASE_MS
SCHEDULED_JOB_LEASE_RENEW_INTERVAL_MS
INTEGRATION_WORKER_KINDS
MAINTENANCE_WORKER_KINDS
MESSAGING_ALERTS_ENABLED
MESSAGING_ACTIVITY_STALE_MS
MESSAGING_QUEUE_BACKLOG_ALERT_THRESHOLD
INTEGRATION_RECEIPT_RETENTION_DAYS
INTEGRATION_FAILURE_DETAIL_RETENTION_DAYS
NOTIFICATION_DELIVERY_DATABASE_URL
NOTIFICATION_DELIVERY_MIGRATION_URL_PRODUCTION
NOTIFICATION_DELIVERY_INTERNAL_URL
NOTIFICATION_DELIVERY_INTERNAL_TOKEN
NOTIFICATION_DELIVERY_LISTEN_HOST
NOTIFICATION_DELIVERY_HEALTH_PORT
NOTIFICATION_DELIVERY_PREFETCH
NOTIFICATION_DELIVERY_KINDS
NOTIFICATION_DELIVERY_RECEIPT_RETENTION_DAYS
NOTIFICATION_DELIVERY_FAILURE_DETAIL_RETENTION_DAYS
CAMPAIGNS_POSTGRES_IMAGE
CAMPAIGNS_POSTGRES_PORT
CAMPAIGNS_POSTGRES_DATA_VOLUME
CAMPAIGNS_POSTGRES_ADMIN_USER
CAMPAIGNS_POSTGRES_ADMIN_PASSWORD_FILE
CAMPAIGNS_DATABASE_URL
CAMPAIGNS_MIGRATION_DATABASE_URL
CAMPAIGNS_BACKUP_URL
CAMPAIGNS_PROCESS_ROLE
CAMPAIGNS_LISTEN_HOST
CAMPAIGNS_HEALTH_PORT
CAMPAIGNS_CORE_INTERNAL_BASE_URL
CAMPAIGNS_INTERNAL_TOKEN
CAMPAIGNS_INTERNAL_TIMEOUT_MS
CAMPAIGNS_PREFETCH
CAMPAIGNS_EMAIL_RATE_PER_SECOND
CAMPAIGNS_TELEGRAM_RATE_PER_SECOND
CAMPAIGNS_OUTBOX_BATCH_SIZE
CAMPAIGNS_OUTBOX_POLL_INTERVAL_MS
CAMPAIGNS_OUTBOX_RETENTION_DAYS
```

---

# Команды

| Команда                                                      | Назначение                             |
| ------------------------------------------------------------ | -------------------------------------- |
| `pnpm dev`                                                   | Development server с watch mode        |
| `pnpm build`                                                 | NestJS + runtime-виджеты               |
| `pnpm build:app`                                             | Только NestJS                          |
| `pnpm build:widgets`                                         | Сборка и проверка runtime-виджетов     |
| `pnpm start:prod`                                            | Запуск собранного HTTP API             |
| `pnpm start:outbox-publisher`                                | Запуск собранного Outbox publisher     |
| `pnpm start:integration-worker`                              | Запуск собранного integration worker   |
| `pnpm start:maintenance-worker`                              | Запуск собранного maintenance worker   |
| `pnpm exec tsc --noEmit`                                     | TypeScript check                       |
| `pnpm lint`                                                  | ESLint с автоматическими исправлениями |
| `pnpm format`                                                | Форматирование исходников              |
| `pnpm test`                                                  | Unit tests                             |
| `pnpm test:watch`                                            | Unit tests в watch mode                |
| `pnpm test:cov`                                              | Unit tests с coverage                  |
| `pnpm test:messaging-integration`                            | RabbitMQ/PostgreSQL integration smoke  |
| `pnpm email`                                                 | React Email preview                    |
| `pnpm prisma-generate`                                       | Генерация Prisma Client                |
| `pnpm dev-prisma-migration`                                  | Применение development migrations      |
| `pnpm jwt:keyset:generate -- ...`                            | Генерация RSA 3072 keyset              |
| `pnpm --dir apps/api-gateway test`                           | Unit/integration tests API Gateway     |
| `pnpm --dir apps/campaigns build`                            | Сборка Campaigns Service               |
| `pnpm --dir apps/campaigns lint`                             | ESLint Campaigns Service               |
| `pnpm --dir apps/campaigns run start:local`                  | Локальный запуск Campaigns Service     |
| `pnpm --dir apps/campaigns test`                             | Unit-тесты Campaigns Service           |
| `pnpm --dir apps/campaigns run test:integration`             | Изолированный DB/Rabbit/service smoke  |
| `pnpm --dir apps/notification-delivery build`                | Сборка Notification Delivery           |
| `pnpm --dir apps/notification-delivery lint`                 | ESLint Notification Delivery           |
| `pnpm --dir apps/notification-delivery run start:local`      | Локальный запуск Notification Delivery |
| `pnpm --dir apps/notification-delivery test`                 | Unit-тесты Notification Delivery       |
| `pnpm --dir apps/notification-delivery run test:integration` | Изолированный DB/Rabbit/service smoke  |

`pnpm lint` и `pnpm format` изменяют файлы.

---

# Code style

- Используйте alias `@/*` для импортов из `src`.
- Для email templates доступен alias `@email/*`.
- Следуйте существующим NestJS modules, controllers, services и DTO.
- Валидируйте входные payload через DTO и `class-validator`.
- Не размещайте бизнес-логику в controllers.
- Не отправляйте пользовательские webhook URL обычным `fetch`; используйте
  `SafeOutboundHttpService`.
- Новые административные действия логируйте в `AdminEventLog`, если это
  разумно для сценария.
- Новые списки и журналы реализуйте с серверной пагинацией.
- Не редактируйте generated Prisma Client и `public/widgets`.

Перед commit Husky и lint-staged форматируют staged-файлы и запускают ESLint
для TypeScript-кода.

---

# Проверки и тестирование

Минимальный набор проверок:

```bash
pnpm lint
pnpm exec tsc --noEmit
pnpm test
pnpm build
pnpm exec prisma validate
```

Unit tests покрывают защиту исходящих HTTP-запросов и атомарные ограничения
подписок, виджетов и заявок.

После изменений widget runtime дополнительно проверьте:

- синтаксис generated JavaScript;
- загрузку `/widgets/<type>.js`;
- получение public config;
- отправку заявки;
- direct preview page;
- установку на обычный сайт и SPA/PWA.

## Рекомендуемый формат веток

```bash
feature/oauth-vk
feature/calculator-api
fix/payment-webhook
refactor/subscription-service
```

## Commit convention

```bash
feat: add calculator endpoints
fix: validate payment webhook
refactor: split subscription cleanup
```

---

# Docker и CI/CD

## Docker

NestJS production image использует multi-stage build:

1. Node.js 20 Alpine и pnpm 9.15.9.
2. Установка зависимостей через frozen lockfile.
3. `prisma generate`.
4. Сборка NestJS и runtime-виджетов.
5. Удаление development dependencies.
6. Запуск от непривилегированного пользователя `nestjs`.

Контейнер API слушает только `127.0.0.1:4200`.
`docker-entrypoint.sh` выбирает database URL по `MODE` и экспортирует его как
`DATABASE_URL` для runtime. Отдельный минимальный image Gateway не получает
private JWT key, PostgreSQL или RabbitMQ credentials и слушает только
`127.0.0.1:4100`. Maintenance собирается отдельным target/image, получает
собственные DB/Rabbit credentials и публикует health только на
`127.0.0.1:4300`. Notification Delivery имеет отдельные `package.json`,
lockfile, Prisma schema/client, NestJS build и Dockerfile в
`apps/notification-delivery`; его production image не наследует root
Dockerfile монолита и публикует health только на `127.0.0.1:4401`.
Campaigns также имеет собственные `package.json`, lockfile, Prisma
schema/client, NestJS build и Dockerfile в `apps/campaigns`; его image не
содержит monolith artifacts и слушает только `127.0.0.1:4500`.

## CI/CD

Workflow `.github/workflows/deploy-production.yml` запускается вручную или при
push в ветку `prod`. После завершённого Campaigns lifecycle push выполняет
обычный полный deploy. Первый push Campaigns-ревизии при отсутствующем
lifecycle marker выполняет только verify и staged-only checkout: не собирает
image, не применяет migrations, не перезапускает контейнеры и не запускает
порт `4500`. Ручной запуск позволяет выбрать `all`, `maintenance`,
`notification-delivery`,
`notification-delivery-database`, `campaigns` либо
`campaigns-database`. Maintenance, Notification Delivery и routine
Campaigns используют изолированный rollout с возвратом exact previous image.
Database cutover разрешён только вручную из защищённой ветки `prod` и проходит
явными фазами соответствующего runbook. После forward boundary recovery
выполняется только вперёд на новой database.

Для Campaigns уже подготовлены routine
`scripts/deploy-campaigns-production.sh`, resumable многофазный
`scripts/cutover-campaigns-database-production.sh`, lifecycle/contract guards,
общий production deploy lock и защищённые workflow targets. Routine разрешён
только после завершённого Campaigns lifecycle marker. До production-like
rehearsal, smoke, Telegram-аудита и restore drill выполнять Campaigns
production finalize запрещено.

Первый Campaigns cutover выполняется в таком порядке:

```text
prepare → frontend → production smoke → Telegram audit (completed)
→ Campaigns backup + clean restore → finalize
```

1. Подготовить Campaigns credentials и target env по
   `../DOCUMENTATION/ENV_PRODUCTION_TEMPLATE.md`.
2. Merge backend в `prod`; автоматический workflow должен завершиться
   staged-only и создать `.campaigns-first-cutover-staged-v1` с exact SHA.
3. Заморозить backend deploy/campaign writes, проверить очереди и получить
   off-VPS backups core и Notification Delivery.
4. Вручную запустить из `prod`
   `deploy_target=campaigns-database`,
   `campaigns_database_action=prepare`. Успех означает marker
   `phase=switched`, а legacy source ещё сохранён. Backend prepare переключает
   backend/Gateway/RabbitMQ contour, но не деплоит frontend. Перед публикацией
   нового runtime marker находится в recoverable `phase=switching`: после
   прерывания legacy runtime восстанавливается, а следующий `prepare` или
   `rollback` удаляет target-only queues и exact-восстанавливает verified
   import.
5. Сразу задеплоить согласованный frontend SHA и выполнить production smoke.
   До `forward-only` при ошибке из `switching|switched` запустить action
   `rollback` и вернуть frontend на предыдущий SHA. После нового `prepare`
   заново задеплоить frontend и повторить весь smoke, Telegram-аудит, новый
   Campaigns backup и clean restore; evidence предыдущего switched-окна не
   переиспользовать, потому что новый `prepare` увеличивает durable
   `switch_generation`.
6. В `phase=switched` выполнить read-only Telegram audit:

   ```bash
   cd /opt/winwidget/winwidget.ru_server
   bash scripts/audit-legacy-telegram-channels-production.sh --self-test
   DEPLOY_SHA="$(git rev-parse HEAD)"
   sudo env EXPECTED_REVISION="$DEPLOY_SHA" \
     bash scripts/audit-legacy-telegram-channels-production.sh
   ```

   Точные значения двух строк `CAMPAIGNS_TELEGRAM_AUDIT_*` из вывода записать
   в root-owned mode-600 production env. Для finalize принимается только
   `CAMPAIGNS_TELEGRAM_AUDIT_DECISION=completed`; `waived` запрещён. Audit
   reference имеет формат
   `switch-generation:<N>:<absolute-path>/SHA256SUMS@sha256:<64-hex>` для
   текущего `switch_generation`.

7. Через `/admin/databases` получить реальный Campaigns Telegram backup,
   вручную восстановить его в чистую PostgreSQL 18 и зафиксировать
   `CAMPAIGNS_RESTORE_DRILL_REFERENCE` вида
   `switch-generation:<N>:<reviewable-id>@sha256:<64-hex>` для того же
   generation.
8. Явно подтвердить необратимую операцию ручным workflow input
   `campaigns_database_action=finalize` и approval защищённого GitHub
   `production` environment; отдельного технического gate/secret нет. Finalize
   удаляет legacy SQL tables/enums/FK migration-ролью, а точные legacy RabbitMQ
   queues — отдельной RabbitMQ-операцией после проверки отсутствия
   consumers/messages. Затем проверить `phase=complete` и
   `source_schema_state=dropped`.

Ручной target `all` до `phase=complete` блокируется до чтения env, build,
migrations и restart. Все backend workflow paths проверяют staged/in-progress
revision до `git fetch`, поэтому другой SHA не может незаметно изменить
checkout во время cutover. Полный checklist, smoke и recovery приведены в
`../DOCUMENTATION/DEPLOYMENT.md` и
`../DOCUMENTATION/DEPLOY_CHECKLIST.md`.

Source-роли, созданные `gen_user` через PostgreSQL 18 `CREATEROLE`, сохраняют
только автоматические административные memberships
`ADMIN=true, SET=false, INHERIT=false`. Они нужны cutover для атомарного
`LOGIN`-fencing, но не дают `gen_user` наследовать права service-ролей или
выполнять `SET ROLE`; любые дополнительные memberships отклоняются.

Verify выполняет:

```text
pnpm install --frozen-lockfile
pnpm --dir apps/notification-delivery install --frozen-lockfile
pnpm --dir apps/campaigns install --frozen-lockfile
pnpm exec prisma generate
create isolated Notification Delivery database and migration/runtime/backup roles
create isolated Campaigns database and migration/runtime/backup roles
pnpm exec prisma migrate deploy
NOTIFICATION_DELIVERY_DATABASE_URL=<migration-role-url> pnpm --dir apps/notification-delivery run prisma:migrate:deploy
CAMPAIGNS_DATABASE_URL=<migration-role-url> pnpm --dir apps/campaigns run prisma:migrate:deploy
recreate isolated Notification Delivery PostgreSQL and verify volume/system identifier/sentinel
recreate isolated Campaigns PostgreSQL and verify volume/system identifier/sentinel
pg_dump with backup role -> clean scratch pg_restore -> compare migrations/tables/rows/sequences
curl ... "$RABBITMQ_MANAGEMENT_URL/api/overview"
pnpm exec tsc --noEmit --incremental false -p tsconfig.build.json
pnpm exec jest --runInBand
pnpm --dir apps/notification-delivery run typecheck
pnpm --dir apps/notification-delivery run lint
pnpm --dir apps/notification-delivery test
pnpm --dir apps/campaigns run typecheck
pnpm --dir apps/campaigns run lint
pnpm --dir apps/campaigns test
docker compose ... config --quiet + semantic validation
pnpm build
pnpm --dir apps/notification-delivery run build
pnpm --dir apps/campaigns run build
compare monolith/app notification kinds, routing keys and queue names
pnpm --dir apps/api-gateway run typecheck
pnpm --dir apps/api-gateway test
docker compose ... build api api-gateway maintenance-worker notification-delivery-worker
pg_dump --version && pg_restore --version && maintenance entrypoint check
pnpm run test:messaging-integration
pnpm --dir apps/notification-delivery run test:integration
pnpm --dir apps/campaigns run test:integration
```

Semantic compose validation проверяет восемь постоянных app/broker-сервисов
обычного profile и отдельные profiles `notification-delivery-database` и
`campaigns-database` с PostgreSQL-контейнерами и external volumes. Также
проверяются отдельные API/Gateway/Maintenance/Notification Delivery/Campaigns
images и revisions, автономные Docker contexts выделенных сервисов без
target/image монолита, команды оставшихся worker-процессов, точные consumer
kinds, три backup-цели, а отдельная contract-boundary проверка сравнивает
producer/consumer routing keys и queue names без общей source-зависимости.
Дополнительно проверяются обе пары
`INTEGRATION_*`/`NOTIFICATION_DELIVERY_*` retention-настроек, healthchecks и
ограниченный `tmpfs` maintenance worker.

После успешного verify обычный deploy по SSH (после Campaigns
`phase=complete`):

1. до изменения checkout проверяет Campaigns staged/lifecycle marker, затем
   обновляет `prod` только до exact `${{ github.sha }}` и требует чистый
   checkout;
2. собирает отдельные API, Gateway, Maintenance, Notification Delivery и
   Campaigns images с тегом и OCI revision полного SHA commit; standalone
   images собираются только из своих app contexts, а smoke проверяет отсутствие
   monolith artifacts;
3. применяет отдельную service-owned Notification Delivery migration
   migration-ролью и проверяет DML/DDL-границу runtime-роли;
4. при первом clean cutover останавливает producers, дожидается пустых четырёх
   main/retry/DLQ-наборов и отсутствия активных старых receipts/failures;
5. до durable marker запускает только изолированные API/workers без root
   Outbox publisher и публичного Gateway, проверяет readiness, control API,
   ownership consumers и повторно доказывает, что moved queues и собственные
   receipts/failures/Outbox нового сервиса пусты;
6. атомарно создаёт marker, переключает recovery только в forward-направление
   и лишь затем включает Outbox publisher и публичный Gateway;
7. ждёт readiness Maintenance и Notification Delivery, свежие heartbeat всех
   worker-процессов, полный набор main/DLQ consumers и отсутствие Rabbit alarm;
8. сверяет revision через локальный
   `http://127.0.0.1:4200/api/v1/health/deployment` и публичный
   `https://api.winwidget.ru/api/v1/health/deployment`;
9. проверяет authenticated Notification Delivery overview, точное ownership
   consumers, OCI-label и отсутствие рестартов;
10. при ошибке выводит последние логи и процессы, занимающие порты
    `4100/4200/4300/4401`.

Первый provider cutover Notification Delivery всегда выполняется target `all`.
До создания durable provider marker скрипт восстанавливает прежние exact
containers только когда пустота moved queues и service-owned state доказана
повторно. Неоднозначное состояние останавливает recovery fail-closed без
запуска двух владельцев одних очередей. Provider marker создаётся после
readiness, authenticated control API и Rabbit ownership smoke изолированного
forward-контура, но до запуска producer и публичного Gateway. Target
`notification-delivery` разрешён только после этого baseline и не применяется
для первого provider cutover. Отдельный database cutover описан ниже.

Production flow:

```text
локальные проверки
-> commit и push
-> GitHub Actions verify
-> GitHub Actions deploy
-> migration container
-> API healthcheck
-> production smoke-test
```

### One-time database cutover Notification Delivery

Cutover выполняется отдельно от обычного rollout и только после merge нужного
SHA в защищённую ветку `prod`:

1. Запустить обычный target `all` для этого SHA и дождаться успешных verify,
   migrations, rollout и production healthchecks. Cutover откажется работать,
   если `api`, `maintenance-worker` или `notification-delivery-worker` не
   запущены в проверенной revision.
2. В GitHub Actions вручную выбрать ветку `prod` и target
   `notification-delivery-database`. Первый запуск создаст отдельный
   PostgreSQL-контейнер, database, роли и persistent external volume на текущем
   VPS, перенесёт данные, переключит URLs и worker на новую БД и сохранит
   marker в фазе `forward_only`. Marker привязывает source к нормализованному
   endpoint fingerprint, PostgreSQL system identifier и OID базы. После
   подтверждения target health и точного RabbitMQ queue ownership доступ
   service-ролей к source отзывается сразу; сама исходная схема сохраняется
   только до финального запуска.
3. Проверить readiness Notification Delivery, RabbitMQ ownership и
   функциональную доставку email/Telegram. После первой записи в новую БД
   возврат к исходной схеме запрещён; исправления выполняются только
   forward-recovery.
4. Ещё раз запустить target `all` из той же актуальной `prod`. Полный deploy
   проверит fingerprint PostgreSQL-контейнера и volume, применит service-owned
   migrations и подтвердит, что `maintenance-worker` видит обе независимые
   backup-цели. PostgreSQL-контейнер и volume при этом не пересоздаются и не
   останавливаются.
5. Открыть `/admin/databases`, по отдельности запустить ручной backup `core` и
   `notification-delivery`, дождаться `SUCCEEDED` и убедиться, что в Telegram
   пришли два непустых `.dump`-документа. Эти backups должны быть созданы после
   перехода marker в `forward_only`.
6. Повторно вручную запустить
   `notification-delivery-database` из `prod`. Скрипт проверит
   readiness, текущий target backup URL и наличие обоих успешных post-cutover
   Telegram-backups, повторно сверит frozen schema/data checksums, удалит
   точный набор service-owned объектов через `RESTRICT`, отключит dedicated
   source-роли и только затем переведёт marker в `complete`.
7. Выполнить финальный smoke и убедиться, что marker содержит одновременно
   `phase=complete` и `source_schema_state=dropped`. После первой записи в
   target и удаления source schema rollback выполняется только вперёд на новой
   БД или из проверенного off-VPS backup.

Обычные targets `all`, `maintenance` и `notification-delivery` не управляют
lifecycle PostgreSQL Notification Delivery: не создают, не останавливают, не
пересоздают контейнер и не удаляют external volume. Эти операции разрешены
только явному database cutover/runbook.

На production VPS запрещено выполнять `docker compose down`,
`docker compose down -v` и
`docker volume rm winwidget-notification-delivery-postgres-data`. Для
rollout/recovery используются только versioned deploy/cutover scripts; routine
deploy не управляет lifecycle service database.

Связанные файлы:

- [`.env.example`](.env.example);
- [`Dockerfile`](Dockerfile);
- [`docker-entrypoint.sh`](docker-entrypoint.sh);
- [`.github/workflows/deploy-production.yml`](.github/workflows/deploy-production.yml);
- [`scripts/deploy-production.sh`](scripts/deploy-production.sh);
- [`scripts/deploy-maintenance-production.sh`](scripts/deploy-maintenance-production.sh);
- `../deploy/backend` — production compose и nginx в общем checkout;
- `../DOCUMENTATION` — общая документация проекта с аналитическими артефактами.
