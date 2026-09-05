# API Gateway

Публичная HTTP-точка входа WinWidget. Gateway не владеет состоянием PostgreSQL
или RabbitMQ: он проверяет access JWT по Identity JWKS и проксирует каждый
явно заданный префикс `/api/v1` в соответствующий доменный сервис.

## Контракт выполнения

- Слушает `GATEWAY_LISTEN_HOST:GATEWAY_PORT` (по умолчанию
  `127.0.0.1:4100`).
- Обязательная переменная `GATEWAY_ROUTES_JSON` содержит точные объекты
  маршрутов с полями `id`, `pathPrefix`, `upstreamUrl`, `authPolicy` и
  `timeoutMs`.
- Побеждает самый длинный совпавший префикс. `API_UPSTREAM_URL` отклоняется;
  универсального резервного маршрута нет.
- Проверка Bearer-токена работает по принципу fail-closed, если JWKS нельзя
  инициализировать или обновить в пределах настроенного окна устаревания.
- `/api/v1/internal/**` никогда не публикуется через публичный Gateway.

Для входящего API WinCRM существует отдельная политика `crm-source`,
разрешённая **только** для префикса `/api/v1/crm/intake/ingest`. Она пропускает
только `POST` и preflight `OPTIONS` на точный путь `/:sourceId` с canonical
lowercase UUIDv4, без query, encoded path, завершающего slash и дочерних путей.
`POST` требует единственный Bearer с canonical 32-byte base64url source key;
Gateway проверяет только форму, а `crm-intake` независимо проверяет hash ключа,
отзыв, источник, workspace, текущие права и лимиты. Пользовательский JWT здесь
не заменяет source key. Остальной `/api/v1/crm/intake` остаётся `required`;
`required` и `optional` по-прежнему проверяют каждый переданный Bearer как JWT.

Политика не включается автоматически и не изменяет production routes.
Добавлять отдельный маршрут следует только вместе с совместимым Intake
upstream и его release gates; отсутствие маршрута не даёт обхода JWT через
общий CRM prefix. Internal credentials и пользовательские claims-заголовки
очищаются по прежним правилам. Peer-IP rate limit Intake за private proxy
требует отдельной согласованной trusted-proxy настройки.

Плоскость управления Operations владеет следующими дополнительными публичными
префиксами, которые должны вести на `http://127.0.0.1:5200`:

- `/api/v1/admin-alerts`
- `/api/v1/messaging/admin`
- `/api/v1/telegram-bot/admin`
- `/api/v1/dev-tools/database-restores`

Gateway напрямую обслуживает проверки `GET /health/live`,
`GET /health/ready` и `GET /health` (алиас readiness).

## Настройка и развёртывание

Скопируйте `.env.example` в `.env.production` в каталоге Gateway на VPS.
Production-файл хранится рядом с сервисом, игнорируется Git и передаётся только
контейнеру Gateway. Замените пример массива маршрутов полной production-таблицей
маршрутизации; catch-all `/api/v1` запрещён.

Сборка и проверка из этого каталога:

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run build
docker build --build-arg APP_REVISION="$(git rev-parse HEAD)" -t winwidget-api-gateway .
```

После развёртывания проверьте обе health-точки и хотя бы один маршрут для
каждого upstream. Ответ 200 от health Gateway сам по себе не доказывает
готовность какого-либо upstream.
