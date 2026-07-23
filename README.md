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

- JWT access/refresh flow;
- Passport;
- OAuth: Google, GitHub, Yandex и VK;
- авторизация через Telegram;
- `bcryptjs`;
- `class-validator` и `class-transformer`;
- Google reCAPTCHA v3;
- SMS-коды через SMS Aero.

### Интеграции и инфраструктура

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
│   ├── file/                  # local/S3 uploads
│   ├── safe-outbound-http/    # защита исходящих webhook/CRM-запросов
│   └── ...                    # контент, статистика и admin-модули
├── prisma/
│   ├── schema.prisma
│   └── migrations/
├── widgets-src/               # читаемые исходники runtime-виджетов
├── public/widgets/            # generated runtime-файлы, не коммитятся
├── emails/                    # React Email templates
├── scripts/                   # сборка виджетов и production deploy
├── Dockerfile
└── docker-entrypoint.sh
```

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

| Область           | Модули                                                                                           | Ответственность                                 |
| ----------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| Авторизация       | `auth`, `user`                                                                                   | JWT, OAuth, Telegram auth, профиль и identities |
| Подписки          | `subscription`, `tariff-prices`                                                                  | тарифы, лимиты, история и expiry                |
| Платежи           | `payment`, `affiliate`                                                                           | ЮKassa, активация подписок и referrals          |
| Виджеты           | `widget`, `quiz`, `callback`, `countdown-timer`, `stop-offer`, `online-consultant`, `calculator` | CRUD, config, leads и preview                   |
| Контент           | `home-page-content`, `legal-pages`, `site-settings`                                              | главная, документы и настройки сайта            |
| Администрирование | `statistics`, `admin-alerts`, `admin-event-log`, `notes`, `mailing`, `health`, `dev-tools`       | dashboard, мониторинг и служебные действия      |
| Уведомления       | `email`, `sms`, `telegram-bot`                                                                   | email, SMS и Telegram                           |
| Файлы             | `file`                                                                                           | local uploads и S3                              |
| Интеграции        | `safe-outbound-http`                                                                             | безопасные webhook и CRM-запросы                |

Единого `AdminModule` нет: административные endpoints находятся внутри
соответствующих предметных модулей.

---

# HTTP API

## Базовые правила

- Основной API prefix: `/api`.
- OAuth endpoints и публичные preview-страницы исключены из prefix.
- Статические runtime-файлы отдаются из `public` по `/widgets/*`.
- Development uploads сохраняются локально и доступны по `/uploads/*`.
- Для публичных widget API разрешён cross-origin доступ.
- Ошибки нормализуются глобальными HTTP и reCAPTCHA filters.

## Виджеты и заявки

Сейчас backend поддерживает семь типов виджетов:

| Виджет             | Управление                | Public config/lead              | Preview                        |
| ------------------ | ------------------------- | ------------------------------- | ------------------------------ |
| Колесо фортуны     | `/api/widgets`            | `/api/widget/:key/*`            | `/page-wheel/:key`             |
| Квиз               | `/api/quizzes`            | `/api/quiz/:key/*`              | `/page-quiz/:key`              |
| Обратный звонок    | `/api/callbacks`          | `/api/callback/:key/*`          | `/page-callback/:key`          |
| Таймер             | `/api/countdown-timers`   | `/api/countdown-timer/:key/*`   | `/page-timer/:key`             |
| Stop Offer         | `/api/stop-offers`        | `/api/stop-offer/:key/*`        | `/page-stop-offer/:key`        |
| Онлайн-консультант | `/api/online-consultants` | `/api/online-consultant/:key/*` | `/page-online-consultant/:key` |
| Калькулятор        | `/api/calculators`        | `/api/calculator/:key/*`        | `/page-calculator/:key`        |

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

- access token используется как Bearer token;
- refresh token хранится в `HttpOnly` cookie `refreshToken`;
- refresh token ротируется при обновлении;
- hash refresh token хранится в PostgreSQL;
- access token действует 1 час;
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

Production compose отслеживается вместе с backend-кодом в
`deploy/docker-compose.prod.yml`. Он запускает четыре постоянных
backend-контейнера: `api`, `rabbitmq`, `outbox-publisher` и
`integration-worker`. Контейнер `migrate` запускается только на время деплоя.
RabbitMQ хранит данные в persistent volume, а его AMQP и management-порты
привязаны только к `127.0.0.1` backend VPS.

## RabbitMQ и transactional outbox

Локальный `.env` для запуска publisher/worker с RabbitMQ на localhost:

```env
RABBITMQ_USER=winwidget
RABBITMQ_PASSWORD=winwidget
RABBITMQ_VHOST=winwidget
RABBITMQ_URL=amqp://winwidget:winwidget@127.0.0.1:5672/winwidget
OUTBOX_BATCH_SIZE=50
OUTBOX_POLL_INTERVAL_MS=500
OUTBOX_RETENTION_DAYS=7
RABBITMQ_WORKER_PREFETCH=10
MESSAGING_ALERTS_ENABLED=false
INTEGRATION_RECEIPT_RETENTION_DAYS=90
INTEGRATION_WORKER_KINDS=email,webhook,telegram,bitrix24,amo-crm
```

В production пароль должен отличаться от локального. Удобно использовать
hex-пароль: он не требует percent-encoding внутри URL.

```bash
openssl rand -hex 32
```

Добавьте полученное значение в
`/opt/winwidget/deploy/backend/.env.production`:

```env
RABBITMQ_USER=winwidget
RABBITMQ_PASSWORD=<полученный-hex-пароль>
RABBITMQ_VHOST=winwidget
RABBITMQ_URL=amqp://winwidget:<тот-же-hex-пароль>@127.0.0.1:5672/winwidget
OUTBOX_BATCH_SIZE=50
OUTBOX_POLL_INTERVAL_MS=1000
OUTBOX_RETENTION_DAYS=7
RABBITMQ_WORKER_PREFETCH=10
MESSAGING_ALERTS_ENABLED=true
INTEGRATION_RECEIPT_RETENTION_DAYS=90
INTEGRATION_WORKER_KINDS=email,webhook,telegram,bitrix24,amo-crm
```

`RABBITMQ_PASSWORD` и пароль внутри `RABBITMQ_URL` должны совпадать.
Production deploy останавливается до запуска миграции и контейнеров, если
`RABBITMQ_PASSWORD` или `RABBITMQ_URL` пусты.

Назначение настроек:

- `OUTBOX_BATCH_SIZE` — максимум событий, захватываемых publisher за цикл;
- `OUTBOX_POLL_INTERVAL_MS` — интервал чтения outbox;
- `OUTBOX_RETENTION_DAYS` — срок хранения успешно опубликованных событий;
- `RABBITMQ_WORKER_PREFETCH` — максимум неподтверждённых сообщений worker;
- `MESSAGING_ALERTS_ENABLED` — Telegram-алерты о недоступных messaging-процессах и необработанных ошибках;
- `INTEGRATION_RECEIPT_RETENTION_DAYS` — срок хранения отметок об успешной доставке, минимум 30 дней;
- `INTEGRATION_WORKER_KINDS` — consumers, запускаемые worker-контейнером.

RabbitMQ Management UI слушает только `127.0.0.1:15672`. Не открывайте этот
порт публично. Для временного доступа используйте SSH tunnel:

```bash
ssh -L 15672:127.0.0.1:15672 <user>@<backend-vps>
```

После этого интерфейс доступен локально по `http://127.0.0.1:15672`.

### Гарантии доставки и защита от дублей

Система использует доставку `at-least-once`: событие не теряется при временной
недоступности RabbitMQ или внешнего сервиса, но при аварии в момент внешнего
запроса теоретически возможна повторная доставка.

- worker хранит успешные `eventId` в `integration_delivery_receipts` и не
  обрабатывает уже завершённое событие повторно;
- webhook получает стабильный `eventId` в JSON и заголовке
  `X-WinWidget-Event-Id`, чтобы принимающая сторона могла реализовать свою
  идемпотентность;
- email получает стабильный `Message-ID`;
- Telegram, Битрикс24 и amoCRM не предоставляют общей транзакции с нашей БД,
  поэтому абсолютная exactly-once гарантия для них технически невозможна;
- старые receipts удаляются worker по
  `INTEGRATION_RECEIPT_RETENTION_DAYS`.

### Production runbook

Единственный compose, используемый CI/CD:
`winwidget.ru_server/deploy/docker-compose.prod.yml`. Копия в
`deploy/backend/docker-compose.prod.yml` оставлена только для старых ручных
команд и должна содержать те же параметры.

Перед первым production-деплоем:

1. Убедиться, что у облачной PostgreSQL есть актуальный backup/snapshot.
2. Заполнить RabbitMQ-переменные в
   `/opt/winwidget/deploy/backend/.env.production`.
3. Проверить, что management-порт `15672` и AMQP-порт `5672` доступны только
   через localhost.
4. Запустить штатный CI/CD. Контейнер `migrate` применит миграции до запуска
   новой версии API и worker.
5. Открыть `/admin/system` и `/admin/messaging`: RabbitMQ, publisher и worker
   должны иметь статус `Работает`, а Outbox/DLQ — не накапливаться.

Диагностика:

```bash
docker compose --env-file /opt/winwidget/deploy/backend/.env.production \
  -f /opt/winwidget/winwidget.ru_server/deploy/docker-compose.prod.yml ps

docker compose --env-file /opt/winwidget/deploy/backend/.env.production \
  -f /opt/winwidget/winwidget.ru_server/deploy/docker-compose.prod.yml \
  logs --tail=200 outbox-publisher integration-worker rabbitmq
```

Аварийные сценарии:

- RabbitMQ недоступен: заявки продолжают сохраняться вместе с Outbox; после
  восстановления publisher отправит накопившиеся события.
- Worker недоступен: сообщения остаются в durable-очередях RabbitMQ.
- Внешняя интеграция недоступна: выполняются повторы через 30 секунд, 5 и
  30 минут, затем событие сохраняется как DLQ-ошибка.
- PostgreSQL недоступна: API не подтверждает сохранение заявки, publisher и
  worker возобновляют работу после восстановления соединения/перезапуска.
- Ошибка в DLQ: устранить причину и нажать `Повторить` в
  `/admin/messaging`; действие попадёт в журнал событий.

CI запускает `test:messaging-integration`, который проверяет реальные цепочки
`Outbox → RabbitMQ` и `RabbitMQ → DLQ → PostgreSQL`.

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

React Email templates находятся в `emails`:

- подтверждение email;
- восстановление пароля;
- уведомление о новой заявке;
- достижение лимита заявок;
- напоминание об окончании подписки;
- административная рассылка.

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

Фоновые задачи выполняются внутри backend-процесса:

- очистка verification challenges;
- очистка зависших платежей;
- проверка подписок и expiry reminders;
- Telegram daily summary;
- резервная копия PostgreSQL в Telegram;
- проверка Telegram webhooks.

Для нескольких API replicas потребуется вынести расписание в отдельный worker
или использовать distributed lock.

Административный health endpoint:

```text
GET /api/health/admin
```

Он проверяет backend, PostgreSQL, S3, SMTP, SMS Aero, reCAPTCHA, ЮKassa и три
Telegram-бота. Итог каждого сервиса находится в массиве `checks` со статусом
`ok`, `warning`, `down` или `disabled`.

---

# Установка и запуск

## Требования

- Node.js 20;
- pnpm 9;
- PostgreSQL;
- заполненный `.env`.

## Установка зависимостей

```bash
corepack enable
corepack prepare pnpm@9.15.9 --activate
pnpm install --frozen-lockfile
```

## Настройка окружения

```bash
cp .env.example .env
```

Заполните development-переменные и не коммитьте реальные секреты.

## Development

```bash
pnpm prisma-generate
pnpm dev
```

По `.env.example` backend доступен на:

```text
http://localhost:4200
```

## Production build

```bash
pnpm build
pnpm start:prod
```

Результат NestJS-сборки находится в `dist`, runtime-виджеты — в
`public/widgets`.

---

# Переменные окружения

## Приложение и база данных

```text
MODE
PORT
API_LISTEN_HOST
PRODUCTION_HOST
DEVELOPMENT_HOST
AUTH_COOKIE_DOMAIN
DATABASE_URL_DEVELOPMENT
DATABASE_URL_PRODUCTION
JWT_SECRET
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

---

# Команды

| Команда                     | Назначение                             |
| --------------------------- | -------------------------------------- |
| `pnpm dev`                  | Development server с watch mode        |
| `pnpm build`                | NestJS + runtime-виджеты               |
| `pnpm build:app`            | Только NestJS                          |
| `pnpm build:widgets`        | Сборка и проверка runtime-виджетов     |
| `pnpm start:prod`           | Запуск собранного backend              |
| `pnpm exec tsc --noEmit`    | TypeScript check                       |
| `pnpm lint`                 | ESLint с автоматическими исправлениями |
| `pnpm format`               | Форматирование исходников              |
| `pnpm test`                 | Unit tests                             |
| `pnpm test:watch`           | Unit tests в watch mode                |
| `pnpm test:cov`             | Unit tests с coverage                  |
| `pnpm email`                | React Email preview                    |
| `pnpm prisma-generate`      | Генерация Prisma Client                |
| `pnpm dev-prisma-migration` | Применение development migrations      |

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

Production image использует multi-stage build:

1. Node.js 20 Alpine и pnpm 9.15.9.
2. Установка зависимостей через frozen lockfile.
3. `prisma generate`.
4. Сборка NestJS и runtime-виджетов.
5. Удаление development dependencies.
6. Запуск от непривилегированного пользователя `nestjs`.

Container слушает порт `4200`. `docker-entrypoint.sh` выбирает database URL по
`MODE` и экспортирует его как `DATABASE_URL` для runtime.

## CI/CD

Workflow `.github/workflows/deploy-production.yml` запускается вручную или при
push в ветку `prod`.

Verify выполняет:

```text
pnpm install --frozen-lockfile
pnpm exec prisma generate
pnpm exec tsc --noEmit
pnpm build
```

После успешного verify deploy по SSH:

1. обновляет ветку `prod` через `git pull --ff-only`;
2. собирает backend image;
3. запускает migration container;
4. пересоздаёт API container;
5. проверяет `http://127.0.0.1:4200/api/site-settings`;
6. при ошибке выводит последние логи API.

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

Связанные файлы:

- [`.env.example`](.env.example);
- [`Dockerfile`](Dockerfile);
- [`docker-entrypoint.sh`](docker-entrypoint.sh);
- [`.github/workflows/deploy-production.yml`](.github/workflows/deploy-production.yml);
- [`scripts/deploy-production.sh`](scripts/deploy-production.sh);
- `../deploy/backend` — production compose и nginx в общем checkout;
- `../DOCUMENTATION` — общая документация проекта с аналитическими артефактами.
