# Сервис Notification Delivery

Notification Delivery — единственный транспортный worker для email и
информационных сообщений Telegram в WinWidget. Он владеет квитанциями
доставки, состоянием retry/ошибок, результатами доставки, transactional Outbox
и схемой PostgreSQL `notification_delivery`. Доменные сервисы публикуют
запросы, но не получают учётные данные SMTP или Info-бота.

## Выполнение

Сейчас сервис запускает consumers worker, Outbox publisher, очистку по сроку
хранения и закрытый управляющий API в одном процессе. По умолчанию он слушает
только `127.0.0.1:4401` и предоставляет:

- `GET /health/live`
- `GET /health/ready`
- `GET /internal/notification-delivery/overview`
- `GET /internal/notification-delivery/failures[/:id]`
- `POST /internal/notification-delivery/failures/:id/retry`
- `POST /internal/notification-delivery/failures/:id/close`

Управляющие endpoints принимают только loopback-вызовы с
`x-winwidget-service: operations` и
`NOTIFICATION_DELIVERY_OPERATIONS_TOKEN`.

## Сообщения и провайдеры

У каждого вида доставки есть независимые очередь RabbitMQ, маршрут retry и
DLQ. До внешнего вызова consumers захватывают квитанцию по
`eventId + consumer`, выполняют ack только после надёжно сохранённого успеха и
публикуют результаты через локальный Outbox.

`NOTIFICATION_DELIVERY_KINDS` может ограничить набор consumers, принадлежащих
процессу. `.env.example` сохраняет прежний default набор; доставка приглашений
WinCRM включается отдельно, как описано ниже. Конфигурация
SMTP общая для видов email; `TELEGRAM_INFO_BOT_TOKEN` принадлежит только этому
сервису. Production-трафик Telegram должен использовать
`TELEGRAM_API_BASE_URL=https://tg.winwidget.ru/telegram-api`.

Исторически общая переменная `RECAPTCHA_CLIENT_URL` передаёт Notification
Delivery только публичный базовый URL сайта для ссылок в email. Сервис не
выполняет через неё reCAPTCHA-проверки; имя сохранено, чтобы production deploy
использовал уже существующий env-контракт без отдельной миграции.

## Приглашения WinCRM — отдельный opt-in

Kind `wincrm-invitation-email` не входит в default consumers. Для включения
сначала применить additive migration `20260907000000_add_wincrm_invitation_email`,
подготовить service-owned RabbitMQ topology/ACLs и Identity, затем явно добавить
kind в `NOTIFICATION_DELIVERY_KINDS`. Имена:

- event type / main routing: `notification.wincrm.invitation.email.requested.v1`;
- main queue: `winwidget.notification.wincrm.invitation.email`;
- retry routing: `wincrm-invitation-email`, manual: `manual.wincrm-invitation-email`,
  DLQ routing: `wincrm-invitation-email.dead-letter`; существующие retry delays,
  publisher confirms, lease/CAS и отдельный Operations retry действуют и здесь.

Identity публикует через собственный transactional Outbox ровно следующий
контракт (UUID/ISO ниже обозначают значения, не literal-строки):

```text
{ schemaVersion: 1, eventId: UUID,
  eventType: "notification.wincrm.invitation.email.requested.v1", occurredAt: ISO,
  reference: { type: "wincrm-invitation", id: invitationUUID, workspaceId: UUID },
  destination: { email: normalizedEmail },
  content: { invitationId: invitationUUID, expiresAt: ISO } }
```

AMQP `messageId` равен `eventId`; timestamps — canonical UTC ISO с
миллисекундами, expiry строго позже occurredAt. Нельзя передавать HTML, URL,
JWT, роль или секреты. Ссылка письма формируется только как
`https://crm.winwidget.ru/invitations/:UUID`, тема — «Приглашение в WinCRM».
UUID ссылки не предоставляет доступ: Identity и CRM Access проверяют
подтверждённый email, acceptance и admission отдельно. SMTP получает стабильный
`Message-ID`, но провайдер не обязан дедуплицировать его.

Для opt-in обязательны `IDENTITY_INTERNAL_BASE_URL` (точный HTTPS origin или
loopback HTTP origin) и отдельный `IDENTITY_NOTIFICATION_DELIVERY_TOKEN`.
Не использовать Operations token. После durable receipt claim, перед SMTP,
worker делает scoped POST
`/internal/v1/notification-delivery/wincrm-invitations/:id/delivery-context` с
headers `x-winwidget-service: notification-delivery` и
`x-winwidget-internal-token`, body `{schemaVersion:1,eventId,workspaceId}`.
Identity feature `WINCRM_INVITATION_EMAIL_ENABLED` по умолчанию `false`;
источник включается только после подготовки receiving topology/ACLs.

Ответ должен содержать только
`{schemaVersion:1,invitationId,workspaceId,eventId,deliver,email,expiresAt}`
с точными bindings исходного события. При `deliver:true` нормализованный адрес
совпадает с destination; при известном cancelled/accepted/expired/inactive
состоянии возвращается `deliver:false,email:null`. HTTP errors (включая 404
unknown binding), redirects, timeout, malformed/oversized response и mismatch
не разрешают SMTP: применяются обычные retry/DLQ. Timeout 5 секунд, response
не более 4096 байт; тело и credentials не попадают в ошибки/логи.

Просроченный envelope не требует внешнего вызова. No-send фиксируется CAS как
`CLOSED_NO_RETRY` с безопасным checkpoint
`{schemaVersion:1,outcome:"SKIPPED",reason,skippedAt}`; `reason` —
`INVITATION_EXPIRED` или `INVITATION_UNAVAILABLE`. Это постоянный dedup tombstone,
не `DELIVERED`. Предыдущая unresolved failure закрывается в той же транзакции
внутренним actor `service:notification-delivery`, без выдуманного пользователя.
Delivery outcome для этого kind не публикуется: активного consumer нет.

Eligibility не является распределённой блокировкой: отмена сразу после HTTP
проверки может пересечься с SMTP. Такое письмо всё равно не позволяет принять
отменённое приглашение. Crash после принятия SMTP, но до receipt commit,
может дать редкий дубль — сохраняется at-least-once семантика транспорта.
Тесты используют только fake SMTP; production SMTP не нужен для локальной QA.

Изолированный PG18 тест: `pnpm run test:integration:wincrm-invitation`.
Требуются `NOTIFICATION_INVITATION_TEST_ALLOW_MUTATION=true`,
`NOTIFICATION_INVITATION_TEST_DATABASE_URL` (loopback,
`winwidget_notification_invitation_test` или `_ci`, schema
`notification_delivery`) и `NOTIFICATION_INVITATION_TEST_RUNTIME_ROLE`.
Миграции применяются отдельно migration-ролью в принадлежащую ей схему;
runtime — LOGIN/NOSUPERUSER/NOINHERIT/NOCREATEDB/NOCREATEROLE/NOREPLICATION/
NOBYPASSRLS, только CONNECT, schema USAGE и SELECT/INSERT/UPDATE/DELETE на
`delivery_receipts`, `delivery_failures`, `outbox_events`, `control_actions`,
`heartbeats`. DELETE нужен service-owned retention, не управлению пользователями.
Не выдавать доступ к `_prisma_migrations`, CREATE в schema/database или к
контрольной чужой таблице `foreign_service_guard.sentinel`; тест проверяет отказ.
Он не читает env-файлы, не запускает миграции/брокер, не вызывает SMTP и удаляет
только собственные случайные fixture event IDs. Lifecycle disposable DB и
контейнера остаётся у запускающего окружения.

## Retention и readiness

Сервис применяет фиксированную политику хранения ко всем активным видам
доставки; `consumer` и дата переноса данных из прежнего backend не являются
признаками legacy-строки:

- опубликованный Outbox старше 7 дней удаляется; `PENDING`, `PUBLISHING` и
  `FAILED` не затрагиваются;
- у `DELIVERED` receipt старше 90 дней очищается только `checkpoint` и
  заполняется `details_redacted_at`. Строка с `eventId + consumer`, статусом и
  `deliveredAt` остаётся постоянным dedup tombstone; `CLOSED_NO_RETRY` также
  хранится постоянно;
- у resolved failure старше 30 дней очищаются payload, headers и provider
  details, а текстовые детали и комментарий закрывающего control action
  заменяются на `[redacted after retention]`;
- resolved failure с результатом `DELIVERED` или `CLOSED_NO_RETRY` старше
  365 дней удаляется вместе с дочерними `control_actions` в одной транзакции,
  сначала дочерние строки, затем parent;
- unresolved/retrying failure, `PROCESSING`, `RETRY_SCHEDULED` и
  `DEAD_LETTERED` receipt не очищаются автоматически; heartbeat старше 7 дней
  удаляется.

Сроки 7/90/30/365 дней являются core policy и не меняются runtime-переменными.
Существующие env-ключи для 7/90/30 принимаются только с этими точными
значениями и останавливают запуск при расхождении. Очистка идёт CAS-safe
пакетами. При наличии backlog следующий пакет запускается без ожидания
следующего часового интервала.

После старта `GET /health/live` доступен во время очистки, но
`GET /health/ready` возвращает `503`, пока первый полный retention pass не
обработает все пакеты. После первого успешного полного pass последующая ошибка
плановой очистки логируется, но сама по себе не снимает readiness уже
работающего delivery-контура.

Online retention не заменяет service-owned backup, проверку isolated restore
или будущий PITR-контур: их расписание, артефакты и контроль восстановления
ведутся отдельно от readiness Notification Delivery.

## Настройка и развёртывание

Скопируйте `.env.example` в игнорируемый `.env.production` рядом с сервисом на
VPS. Замените `change_me`, ограничьте учётные записи PostgreSQL и RabbitMQ
сервисом Notification Delivery и никогда не передавайте транспортные учётные
данные контейнерам доменных сервисов.

```bash
pnpm install --frozen-lockfile
pnpm run prisma:generate
pnpm run prisma:validate
pnpm run prisma:migrate:deploy
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run build
pnpm run test:integration
docker build --build-arg APP_REVISION="$(git rev-parse HEAD)" -t winwidget-notification-delivery .
```

Интеграционные тесты требуют одноразовых локальных окружений PostgreSQL,
RabbitMQ и SMTP. Readiness подтверждает базу данных, соединение RabbitMQ,
consumers и Outbox publisher, но не доставку внешним провайдером.
