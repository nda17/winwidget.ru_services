# Сервис Widgets

Widgets владеет определениями виджетов, черновыми и опубликованными версиями,
заявками контактных виджетов, AI-ответами без хранения переписки, телеметрией,
ошибками доставки, проекциями Identity/Billing, изображениями кнопок и схемой
PostgreSQL `widgets`. Браузерные assets виджетов также собираются из
`widgets-src/` и упаковываются внутри этого сервиса.

## Роли процессов

`WIDGETS_PROCESS_ROLE` принимает `all`, `api`, `worker` или `publisher`:

- `api` обслуживает HTTP и собранные assets на порту `4700`.
- `worker` получает сообщения из очередей Identity, entitlement, webhook,
  Bitrix24 и amoCRM с независимым состоянием retry/DLQ.
- `publisher` публикует transactional Outbox с confirms и mandatory returns.
- `all` запускает все обязанности в одном процессе.

Каждая роль предоставляет `GET /health/live` и `GET /health/ready`.
Контейнеры используют один внутренний порт, поскольку у каждого своё сетевое
пространство имён; только API должен публиковаться через Gateway/Nginx.

## HTTP- и внутренние контракты

Публичные и аутентифицированные маршруты под `/api/v1` включают:

- коллекции виджетов (`/widgets`, `/quizzes`, `/callbacks`,
  `/countdown-timers`, `/stop-offers`, `/ai-consultants`, `/calculators`)
- `/widget-settings/**`, `/widgets/admin/**` и управление ошибками доставки
- публичные endpoints конфигурации/заявок виджетов и `/widget-events/**`
- `GET /ai-consultant/:key/config`, `POST /ai-consultant/:key/session` и
  `POST /ai-consultant/:key/messages`
- `POST /ai-consultants/:id/test-message` для проверки сохранённого draft

Собранные assets обслуживаются по `/widgets/**`. Identity вызывает
`/internal/v1/identity/widgets/admin-owner-overview` с
`WIDGETS_IDENTITY_TOKEN`. Operations вызывает
`/api/v1/internal/v1/operations/widgets/**` с
`WIDGETS_OPERATIONS_TOKEN` для alerts, обзора сообщений и управления ошибками.
Widgets вызывает Identity с `IDENTITY_WIDGETS_TOKEN`.

Более старый общий внутренний интерфейс по-прежнему использует
`WIDGETS_INTERNAL_TOKEN`; не используйте эти учётные данные повторно для
Identity или Operations.

AI Consultant использует только текстовый `instructionsPrompt`. Публичный
config этот prompt не возвращает. Клиентская история передаётся как
недоверенные данные, сообщения и ответы не сохраняются, заявки не создаются;
файлов, RAG и отдельной базы знаний нет. В runtime оператор всегда явно
обозначен как AI. Для публикации обязательна HTTP(S)-ссылка на политику
обработки персональных данных; runtime показывает её рядом с предупреждением
не вводить персональные данные.

## Ресурсы и хранилище

```bash
pnpm run build:widgets
pnpm run build:widgets:check
```

Эти команды компилируют `widgets-src/` в `public/widgets/`; сгенерированный
результат игнорируется Git и копируется в образ. В production изображения
кнопок используют настроенный S3 bucket. `WIDGETS_UPLOADS_DIR` предназначен
только для резервного варианта локальной разработки.

## Настройка и развёртывание

Скопируйте `.env.example` в игнорируемый `.env.production` рядом с сервисом на
VPS. Замените все шаблоны и передавайте только переменные, необходимые каждой
роли. Граница устаревания entitlement обязательна и должна оставаться в
проверяемом диапазоне.

Для Workers AI задайте `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_AI_GATEWAY_ID`, `CLOUDFLARE_AI_MODEL`, Turnstile-пару
`CLOUDFLARE_TURNSTILE_SITE_KEY` / `CLOUDFLARE_TURNSTILE_SECRET_KEY` и отдельный
`WIDGETS_AI_SESSION_SECRET`. API token должен иметь Workers AI и Turnstile Sites
Write, хранится только в production secret env и не передаётся во frontend.

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
```

Для Dockerfile Widgets корень репозитория должен быть build context:

```bash
docker build -f apps/widgets/Dockerfile \
  --build-arg APP_REVISION="$(git rev-parse HEAD)" \
  -t winwidget-widgets .
```
