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
