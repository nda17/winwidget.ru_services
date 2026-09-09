# Сервис Support

Support владеет чатом с оператором, webhook бота Telegram Support, настройками
маршрутизации, состоянием retry/ошибок доставки и схемой PostgreSQL `support`.
Сервис читает и записывает только собственную БД и актуальные HTTP/event
контракты.

## Роли процессов

| `SUPPORT_PROCESS_ROLE` | Порт по умолчанию | Ответственность                                       |
| ---------------------- | ----------------: | ----------------------------------------------------- |
| `api`                  |              5100 | Приём webhook, admin-настройки и публичный/admin HTTP |
| `worker`               |              5101 | Идемпотентная обработка webhook и доставка в Telegram |
| `outbox-publisher`     |              5102 | Публикация Outbox с confirms и mandatory              |

Каждая роль предоставляет `GET /health/live` и `GET /health/ready`. API
владеет следующими маршрутами:

- `POST /api/v1/telegram-bot/support-webhook`
- `/api/v1/support/admin/webhook/**`
- `/api/v1/support/admin/routing-settings`
- `/api/v1/support/admin/messaging/failures/**`

Readiness проверяет подключение к БД и минимальный маркер `service_identity`
(`serviceName`, `databaseId`, временные метки). Worker и Outbox publisher
запускаются по своей process role без отдельной фазы активации; readiness
обязательно проверяет их фактическую готовность.

Operations читает `GET /internal/v1/support/messaging/overview` через loopback
с `x-winwidget-service: operations` и `SUPPORT_OPERATIONS_TOKEN`. Support
авторизует пользователей admin через Identity с `IDENTITY_SUPPORT_TOKEN`.

## Telegram и RabbitMQ

Production-вызовы Telegram используют существующий публичный TLS reverse proxy:

```dotenv
TELEGRAM_API_BASE_URL=https://tg.winwidget.ru/telegram-api
TELEGRAM_API_PROXY_IP=185.184.122.62
```

API принимает webhook только после проверки секретного заголовка Telegram и
надёжного сохранения исходного update вместе с его событием Outbox. Worker
захватывает lease PostgreSQL до внешних вызовов и выполняет ack RabbitMQ только
после надёжно сохранённого завершения. Ручные retry/close остаются
транзакционными.

Для `api` и `worker` readiness также проверяет обязательные Telegram settings.
Для `api` требуются token, username, webhook secret/public URL и pinned proxy;
для `worker` — token и pinned proxy.

Контейнер `outbox-publisher` не должен получать учётные данные Telegram,
webhook, proxy или Identity; Compose должен передавать их только `api`/`worker`
по необходимости. Для ролей RabbitMQ имя соединения должно быть строго
`winwidget-support-<role>`.

## Настройка и развёртывание

Храните отслеживаемый `.env.example` и игнорируемый `.env.production` рядом с
сервисом на VPS. Замените все шаблоны отдельными секретами с ограниченной
областью действия. До запуска runtime-контейнеров примените миграцию Support
отдельной ролью миграций.

```bash
pnpm install --frozen-lockfile
pnpm run prisma:generate
pnpm run prisma:validate
pnpm run prisma:migrate:deploy
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run build
docker build --build-arg APP_REVISION="$(git rev-parse HEAD)" -t winwidget-support .
```

После развёртывания проверьте readiness всех ролей и состояние webhook. Для
контрольного сообщения чата с оператором используйте явно заданную тестовую
цель; не отправляйте незапрошенные production-сообщения.

## Веб-поддержка CRM

`SUPPORT_WEB_CHAT_ENABLED=true` включает отдельный веб-контур внутри Support.
Существующие Telegram webhook, история, `RoutingSettings` и Support bot bridge
сохраняют своё поведение. Новые `web_*` таблицы создаёт миграция
`20260909160000_add_web_support_chat`; миграция не включает внешние уведомления.
Настройки веб-доставки хранятся отдельно в `web_notification_settings`.

Клиент открывает «Поддержка» в CRM и отправляет первое сообщение, чтобы создать
обращение. История хранится на сервере; закрытие панели и перезагрузка её
сохраняют. Доступ определяется активной сессией Identity и автором обращения,
не платной CRM-подпиской. Участники той же компании не получают доступ.
Оператор ADMIN/DEV отвечает в `/admin/support`; новый ответ клиента повторно
открывает решённое обращение. Прочтение оператора индивидуальное.

API находится под `/api/v1/support`: `conversations`, сообщения и `read`
внутри обращения, `unread-count`, `commands/:commandId`, `attachments`.
Операторские обращения находятся под `/api/v1/support/admin`; чтение
`notification-settings` доступно ADMIN/DEV, изменение — DEV. Все командные
изменения требуют неизменных `commandId` и `expectedActorSubject`. Повтор с
другим содержимым возвращает 409. После неизвестного результата создания,
ответа или статуса можно прочитать `commands/:commandId`; NOT_FOUND не
разрешает автоматическую повторную отправку. Загрузка и настройки повторяются
только явно с исходной командой. Доказательства команд автоматически не удаляются.

История выдаётся серверными страницами до 100 сообщений с `beforeSequence`
либо `afterSequence`, всегда в порядке sequence ASC. Статус изменяется с CAS
по `expectedVersion`. Сообщение, привязка вложений и уведомительный Outbox
фиксируются одной PostgreSQL-транзакцией. Непрочитанные учитывают сообщения
противоположной стороны; отметка `throughSequence` только возрастает.

Изображения PNG/JPEG/WebP до 5 MiB и 40 миллионов пикселей проходят полное
декодирование, удаление метаданных и проверку отсутствия анимации. Одновременно
API запускает не более двух декодеров. До трёх вложений на сообщение; каждый
upload содержит один файл. Временные загрузки ограничены 30 на автора и
живут 24 часа. S3 bucket должен быть PRIVATE с отдельным Support credential;
публичного URL и прямой выдачи signed URL нет. Support проверяет права перед
каждым скачиванием и передаёт поток с `no-store`. Доступ к S3 нужен только API,
где работает ограниченный cleanup с lease/CAS. Cleanup никогда не удаляет
прикреплённый файл; tombstones сохраняют безопасный повтор команд.
S3-объекты не входят в PostgreSQL dump: object storage recovery и retention
обеспечиваются отдельно. Версионирование bucket этот релиз не включает.

Защита частоты хранится в PostgreSQL: 240 read/PUT, 30 изменяющих запросов,
20 uploads в минуту на автора; максимум 10 новых обращений в час.

Support создаёт независимый intent для каждого служебного адреса и канала.
Сообщения группируются в фиксированном 60-секундном окне PostgreSQL;
`Outbox.availableAt` откладывает доставку до его окончания. RabbitMQ содержит
только идентификаторы, без текста переписки, файлов и получателей. ND получает
минимальный контекст через отдельный аутентифицированный внутренний endpoint:
`POST /internal/v1/notification-delivery/support-notifications/:id/delivery-context`.
Текущий подтверждённый email клиента запрашивается у Identity перед доставкой.
Изменение версии настроек отменяет перенаправление старых intent на новые
адреса. Отказы доставки не отменяют сообщения.

Результаты ND обрабатываются независимой очередью
`winwidget.support.notification-outcomes.v1`, consumer
`support-notification-outcome`, собственными retry-v1/DLQ. Ручные retry/close
доступны через существующий Support messaging API и выбирают обработчик по
consumer. Ответы, статусы, настройки и ручные действия аудитируются без текста
переписки и вложений. SMTP/Telegram имеют at-least-once семантику: редкий дубль
на границе успешной внешней отправки и аварии процесса остаётся возможным.

Перед активацией сначала выпускаются совместимые Identity/CRM Access,
Notification Delivery и Operations readers, миграции, queue ACL и Support;
затем frontend и флаг чата. Настройки внешних каналов включаются после проверки
конкретного Support bot и служебных получателей.

`pnpm test:integration:web` проверяет реальные транзакции PostgreSQL 18 с
mocked внешними транспортами. Требуются `SUPPORT_TEST_ALLOW_MUTATION=true`,
`SUPPORT_TEST_DATABASE_URL` для runtime и `SUPPORT_TEST_MIGRATION_DATABASE_URL`
для setup; `SUPPORT_TEST_SKIP_MIGRATIONS=true` — только если setup выполнен.
Разрешены лишь loopback и явно тестовые имена БД. Проверяются concurrency,
изоляция, idempotency, pagination/read/status CAS, rollback Outbox, private
attachment admission и повтор обработки результата доставки.
