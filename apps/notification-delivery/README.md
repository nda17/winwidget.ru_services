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
процессу. Полный поддерживаемый набор указан в `.env.example`. Конфигурация
SMTP общая для видов email; `TELEGRAM_INFO_BOT_TOKEN` принадлежит только этому
сервису. Production-трафик Telegram должен использовать
`TELEGRAM_API_BASE_URL=https://tg.winwidget.ru/telegram-api`.

Исторически общая переменная `RECAPTCHA_CLIENT_URL` передаёт Notification
Delivery только публичный базовый URL сайта для ссылок в email. Сервис не
выполняет через неё reCAPTCHA-проверки; имя сохранено, чтобы production deploy
использовал уже существующий env-контракт без отдельной миграции.

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
