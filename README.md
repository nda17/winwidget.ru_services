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
│   ├── messaging/             # RabbitMQ topology, consumers и Outbox contracts
│   ├── scheduled-jobs/        # durable-запуски, уникальность и CAS-lease
│   ├── maintenance/           # длительные регламентные задачи и backup
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

| Область             | Модули                                                                                           | Ответственность                                 |
| ------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| Авторизация         | `auth`, `user`                                                                                   | JWT, OAuth, Telegram auth, профиль и identities |
| Подписки            | `subscription`, `tariff-prices`                                                                  | тарифы, лимиты, история и expiry                |
| Платежи             | `payment`, `affiliate`                                                                           | ЮKassa, активация подписок и referrals          |
| Виджеты             | `widget`, `quiz`, `callback`, `countdown-timer`, `stop-offer`, `online-consultant`, `calculator` | CRUD, config, leads и preview                   |
| Контент             | `home-page-content`, `legal-pages`, `site-settings`                                              | главная, документы и настройки сайта            |
| Администрирование   | `statistics`, `admin-alerts`, `admin-event-log`, `notes`, `mailing`, `health`, `dev-tools`       | dashboard, мониторинг и служебные действия      |
| Уведомления         | `email`, `sms`, `telegram-bot`                                                                   | email, SMS и Telegram                           |
| Messaging           | `messaging`, `outbox-publisher`, `integration-worker`                                            | RabbitMQ, Outbox, retry и DLQ                   |
| Регламентные задачи | `scheduled-jobs`, `maintenance`                                                                  | durable scheduler, lease и backup               |
| Файлы               | `file`                                                                                           | local uploads и S3                              |
| Интеграции          | `safe-outbound-http`                                                                             | безопасные webhook и CRM-запросы                |

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

Каждый Nest application context (`api`, `outbox-publisher`,
`integration-worker`, `maintenance-worker`) импортирует глобальный
`PrismaModule` и владеет ровно одним `PrismaClient`/connection pool.
Feature-модули только внедряют `PrismaService` и не регистрируют его в
собственных `providers` или `exports`. Root-модуль отключает свой Prisma client
после завершения lifecycle-хуков процесса; API обрабатывает `SIGTERM` через
Nest shutdown hooks.

Для `pg_dump` maintenance worker сначала использует необязательный
`DATABASE_BACKUP_URL`. Указывайте в нём прямой PostgreSQL endpoint, если
основной Prisma URL ведёт через PgBouncer/pooler. Если переменная пустая,
используется URL, выбранный через `MODE`; deploy не требует
`DATABASE_BACKUP_URL`.

Production compose отслеживается вместе с backend-кодом в
`deploy/docker-compose.prod.yml`. Он запускает пять постоянных
backend-контейнеров: `api`, `rabbitmq`, `outbox-publisher`,
`integration-worker`, `maintenance-worker`. Контейнер `migrate` запускается
только на время деплоя. PostgreSQL является внешней управляемой базой и в эти
пять контейнеров не входит.
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
MAINTENANCE_WORKER_PREFETCH=1
SCHEDULED_JOB_POLL_INTERVAL_MS=30000
SCHEDULED_JOB_LEASE_MS=120000
SCHEDULED_JOB_LEASE_RENEW_INTERVAL_MS=30000
MESSAGING_ALERTS_ENABLED=false
INTEGRATION_RECEIPT_RETENTION_DAYS=90
INTEGRATION_WORKER_KINDS=email,webhook,telegram,bitrix24,amo-crm,payment-email,payment-telegram,mailing-email,mailing-telegram,limit-email,limit-telegram,daily-summary-telegram
MAINTENANCE_WORKER_KINDS=database-backup
MAILING_EMAIL_RATE_PER_SECOND=5
MAILING_TELEGRAM_RATE_PER_SECOND=10
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
MAINTENANCE_WORKER_PREFETCH=1
SCHEDULED_JOB_POLL_INTERVAL_MS=30000
SCHEDULED_JOB_LEASE_MS=120000
SCHEDULED_JOB_LEASE_RENEW_INTERVAL_MS=30000
MESSAGING_ALERTS_ENABLED=true
INTEGRATION_RECEIPT_RETENTION_DAYS=90
INTEGRATION_WORKER_KINDS=email,webhook,telegram,bitrix24,amo-crm,payment-email,payment-telegram,mailing-email,mailing-telegram,limit-email,limit-telegram,daily-summary-telegram
MAINTENANCE_WORKER_KINDS=database-backup
MAILING_EMAIL_RATE_PER_SECOND=5
MAILING_TELEGRAM_RATE_PER_SECOND=10
```

`RABBITMQ_PASSWORD` и пароль внутри `RABBITMQ_URL` должны совпадать.
Production deploy останавливается до запуска миграции и контейнеров, если
`RABBITMQ_PASSWORD` или `RABBITMQ_URL` пусты. Перед первым деплоем этой версии
обновите реальный `.env.production`: deploy также проверяет новые настройки
maintenance worker и наличие `daily-summary-telegram`/`database-backup` в
списках consumers. Это предотвращает успешный релиз без обработчика новой
очереди.

Назначение настроек:

- `OUTBOX_BATCH_SIZE` — максимум событий, захватываемых publisher за цикл;
- `OUTBOX_POLL_INTERVAL_MS` — интервал чтения outbox;
- `OUTBOX_RETENTION_DAYS` — срок хранения успешно опубликованных событий;
  очистка выполняется ограниченными пакетами;
- `RABBITMQ_WORKER_PREFETCH` — максимум неподтверждённых сообщений worker;
- `MAINTENANCE_WORKER_PREFETCH` — число backup-задач, одновременно получаемых
  maintenance worker; production-значение `1` не допускает параллельные
  `pg_dump` в одном процессе;
- `SCHEDULED_JOB_POLL_INTERVAL_MS` — интервал проверки расписания durable-задач;
- `SCHEDULED_JOB_LEASE_MS` — срок CAS-lease длительной задачи;
- `SCHEDULED_JOB_LEASE_RENEW_INTERVAL_MS` — интервал продления lease, который
  должен быть меньше `SCHEDULED_JOB_LEASE_MS`;
- `MESSAGING_ALERTS_ENABLED` — Telegram-алерты о недоступных messaging-процессах,
  необработанных ошибках и событиях Outbox, ожидающих больше 15 минут;
- `INTEGRATION_RECEIPT_RETENTION_DAYS` — срок хранения отметок об успешной доставке, минимум 30 дней;
- `INTEGRATION_WORKER_KINDS` — consumers, запускаемые integration worker;
- `MAINTENANCE_WORKER_KINDS` — consumers длительных регламентных задач,
  запускаемые maintenance worker;
- `MAILING_EMAIL_RATE_PER_SECOND` — максимальная скорость массовой email-рассылки в одном worker-процессе;
- `MAILING_TELEGRAM_RATE_PER_SECOND` — максимальная скорость массовой Telegram-рассылки в одном worker-процессе.

Административный health и operational alert дополнительно контролируют
`scheduled_job_runs`: окончательные `FAILED`, задания `QUEUED` с задержкой
больше 15 минут и `PROCESSING` с просроченным lease.

Worker получает сообщения из RabbitMQ по push-модели через `basic.consume`:
broker доставляет сообщение сам, а worker подтверждает обработку через `ack`.
Pull-чтение (`basic.get`) для рабочих очередей не используется. Отдельный
polling применяется только publisher-процессом при чтении PostgreSQL Outbox.

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

Независимые retry-очереди используют суффикс `retry-v2`. Старые пустые
`*.retry.1..3`, если они остались после обновления существующего RabbitMQ,
больше не получают сообщения; удаляйте их вручную только после проверки, что
в них нет отложенных сообщений.

Бизнес-критичные изменения платежа и подписки остаются синхронными в
PostgreSQL. Через RabbitMQ выполняются только побочные уведомления.

### Массовые рассылки

Администратор создаёт кампанию, после чего API сразу возвращает её идентификатор
и снимок количества получателей. Кампания, получатели и Outbox-события
создаются одной транзакцией PostgreSQL. Email и Telegram обрабатываются
независимыми очередями `winwidget.mailing.email` и
`winwidget.mailing.telegram`.

- для каждого получателя хранится отдельный статус;
- worker ограничивает скорость отправки через
  `MAILING_*_RATE_PER_SECOND`;
- после перезапуска необработанные сообщения остаются в RabbitMQ;
- окончательная ошибка попадает в DLQ и отражается в кампании;
- ручной retry восстанавливает только выбранную доставку;
- отмена помечает ещё не начатые доставки как отменённые; сообщение, которое
  уже отправляется, может успеть уйти.

### Уведомление о лимите заявок

Когда последняя доступная заявка фиксируется в PostgreSQL, событие
`lead.limit.reached.v1` создаётся в той же транзакции. Оно разветвляется в
независимые email и Telegram queues. Прежняя fire-and-forget отправка из
API-процесса удалена.

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

Плановый и ручной backup сначала создают durable-задание в PostgreSQL и
Outbox-событие. API только ставит ручной запуск в очередь и не выполняет
`pg_dump` внутри HTTP-запроса. Отдельный `maintenance-worker` получает ID
задания из `winwidget.maintenance.database-backup`, атомарно захватывает его
через CAS и продлевает lease во время длительной работы. RabbitMQ не содержит
файл backup или секреты подключения. В production временный dump создаётся в
отдельном `tmpfs` maintenance-контейнера с лимитом 64 МБ и удаляется в
`finally`; максимальный размер отправляемого файла ограничен 49 МБ.
Если провайдер выдаёт отдельный direct endpoint, задайте его в
`DATABASE_BACKUP_URL`: `pg_dump` не должен идти через transaction pooler.
Переменная необязательна и при отсутствии использует обычный URL текущего
`MODE`. Пароль удаляется из аргументов процесса и передаётся `pg_dump` только
через `PGPASSWORD`; Prisma-only параметры подключения удаляются.

Контракт ручного запуска изменён намеренно: endpoint возвращает принятое в
очередь задание, а не готовый файл. Совместимость со старым синхронным ответом
не сохраняется. `POST /api/telegram-bot/admin/database-backup/send` требует
заголовок `Idempotency-Key` с UUID. Ключ сохраняется в детерминированном
`scheduleKey` вместе с ID администратора и в отдельной таблице соответствий
`adminId + jobType + idempotencyKey → jobId`. Поэтому повтор HTTP-запроса
возвращает тот же job даже после его завершения и не создаёт второй Outbox или
audit event. Если у этого администратора уже есть активный ручной backup, новый
ключ атомарно связывается с текущим job; новый job появляется только после
завершения активного. FK с `ON DELETE RESTRICT` защищает соответствие от
случайного удаления job. Проверка и создание защищены коротким
transaction-scoped advisory lock только на команду данного администратора;
этот lock завершается до `pg_dump`.

Интерфейс ручного запуска и polling расположен на странице
`/admin/databases`. Админка восстанавливает polling после reload через
`GET /api/telegram-bot/admin/database-backup/jobs/active` и локальный marker.
Endpoint и получение конкретного ручного job проверяют
`input.requestedByAdminId`, поэтому один администратор не получает состояние
чужого запуска.

Восстановление остаётся отдельной операцией только для роли `DEV`:
`POST /api/dev-tools/database-backup/restore`. Строка повторного подтверждения
получается через `GET /api/dev-tools/database-backup/restore-settings` и больше
не входит в настройки Telegram-бота. Поэтому DEV-блок страницы «Базы данных»
не зависит от загрузки Telegram settings; ограничение файла 49 МБ, проверка
формата `.dump` и audit event восстановления сохранены.

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

Для всех scheduler не вводится общий PostgreSQL-lock. Уникальный ключ периода
защищает расписание от дублей, длительный backup использует возобновляемый
lease, а короткие идемпотентные очистки остаются без распределённой блокировки.
Транзакция и advisory lock не удерживаются во время `pg_dump` или сетевой
отправки.

Telegram-копия backup является дополнительным операционным каналом. Основной
защитой production-данных должны оставаться проверяемые backup и point-in-time
recovery управляемой PostgreSQL с шифрованием и retention. Восстановление базы
не выполняется worker автоматически: это отдельная защищённая операция по
runbook.

Напоминания об окончании подписки пока остаются в существующем scheduler:
у них уже есть PostgreSQL-дедупликация. Остальные отчёты и административные
задачи в RabbitMQ автоматически не переносятся.

RabbitMQ Management UI слушает только `127.0.0.1:15672`. Не открывайте этот
порт публично. Для временного доступа используйте SSH tunnel:

```bash
ssh -L 15672:127.0.0.1:15672 <user>@<backend-vps>
```

После этого интерфейс доступен локально по `http://127.0.0.1:15672`.

Административные API общего мониторинга Outbox/RabbitMQ и ручного retry
доступны только роли `DEV`. Обычные администраторы управляют массовыми
кампаниями на странице «Рассылки», но не имеют доступа к общему DLQ.

### Гарантии доставки и защита от дублей

Система использует доставку `at-least-once`: событие не теряется при временной
недоступности RabbitMQ или внешнего сервиса, но при аварии в момент внешнего
запроса теоретически возможна повторная доставка.

- worker хранит успешную пару `eventId + consumer` в
  `integration_delivery_receipts` и не обрабатывает уже завершённую доставку
  повторно;
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
  `INTEGRATION_RECEIPT_RETENTION_DAYS` ограниченными пакетами.

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
5. Открыть `/admin/system` и `/admin/messaging`: RabbitMQ, publisher,
   integration worker и maintenance worker должны иметь статус `Работает`, а
   Outbox/DLQ — не накапливаться.

Диагностика:

```bash
docker compose --env-file /opt/winwidget/deploy/backend/.env.production \
  -f /opt/winwidget/winwidget.ru_server/deploy/docker-compose.prod.yml ps

docker compose --env-file /opt/winwidget/deploy/backend/.env.production \
  -f /opt/winwidget/winwidget.ru_server/deploy/docker-compose.prod.yml \
  logs --tail=200 outbox-publisher integration-worker maintenance-worker rabbitmq
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
retry, `RabbitMQ → DLQ → PostgreSQL` и наличие очередей ежедневной сводки и
backup.

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
DATABASE_BACKUP_URL
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
pnpm exec prisma migrate deploy
pnpm exec tsc --noEmit
pnpm exec jest --runInBand
docker compose ... config --quiet
pnpm build
docker compose ... build api
pg_dump --version && pg_restore --version
pnpm run test:messaging-integration
```

После успешного verify deploy по SSH:

1. обновляет ветку `prod` через `git pull --ff-only`, требует чистый checkout и
   точное совпадение с проверенным `${{ github.sha }}`;
2. собирает backend image с тегом и OCI revision полного SHA commit;
3. запускает migration container;
4. запускает RabbitMQ и пересоздаёт API, Outbox publisher, integration worker и
   maintenance worker;
5. ждёт свежие heartbeat трёх worker-процессов и consumers основных/DLQ
   очередей ежедневной сводки и backup;
6. сверяет revision через локальный
   `http://127.0.0.1:4200/api/health/deployment` и публичный
   `https://api.winwidget.ru/api/health/deployment`;
7. проверяет OCI-label и отсутствие рестартов у API, Outbox publisher,
   integration worker и maintenance worker;
8. при ошибке выводит последние логи API и процесс, занимающий порт `4200`.

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
