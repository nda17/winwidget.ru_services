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
- `POST /callback/:key/verification/start` для опционального callback OTP;
  финальный `/callback/:key/lead` требует challenge и шестизначный код при
  опубликованном режиме `SMS` или `EMAIL`
- `GET /ai-consultant/:key/config`, `POST /ai-consultant/:key/consents`,
  `POST /ai-consultant/:key/session` и `POST /ai-consultant/:key/messages`
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
недоверенные данные, сообщения и ответы не сохраняются в БД или прикладных
логах; результат `requestId` dedupe остаётся в памяти процесса не более 5 минут.
Заявки не создаются; файлов, RAG и отдельной базы знаний нет. В runtime оператор
всегда явно обозначен как AI. Для публикации обязательна HTTP(S)-ссылка на политику
владельца сайта, которая раскрывает обработку через Cloudflare Workers AI и
Turnstile. Политика на домене WinWidget запрещена в клиентской настройке и не
подставляется виджетам по умолчанию. Публичный config возвращает точный текст,
версию и hash явного согласия. Consent contract
`ai-consultant-consent-v2` раскрывает обработку вопроса и до 12 последних
сообщений через Workers AI, передачу Turnstile технических сигналов
безопасности и самостоятельную роль Cloudflare при улучшении обнаружения
ботов. Runtime сначала фиксирует отдельный consent
receipt и только после этого загружает Turnstile и создаёт одноразовую
bootstrap-сессию. Неподтверждённый receipt удаляется через 15 минут;
подтверждённый минимальный receipt без переписки, raw IP и raw session ID
хранится 1095 дней. Runtime показывает провайдера, ссылку и предупреждение не
вводить специальные категории, биометрические и избыточные персональные
данные. Запросы к AI Gateway
всегда передают `cf-aig-collect-log: false` и
`cf-aig-collect-log-payload: false`, поэтому для запроса пропускается вся log
entry AI Gateway, включая payload и metadata. Это не означает отсутствия
обработки запроса Workers AI или технических сигналов Turnstile.
Аутентифицированный `POST /ai-consultants/:id/test-message` fail-closed требует
`aiCloudflareDisclosureAcknowledged: true` до чтения draft, quota-check и
вызова провайдера; acknowledgment не добавляет хранение переписки.

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

Callback OTP принадлежит Widgets и отправляется синхронно через SMTP или
SMS Aero. Задайте отдельный `WIDGETS_CALLBACK_OTP_SECRET` длиной не менее 32
байт, существующие `SMTP_*` и `SMSAERO_*` credentials. Код действует 5 минут,
допускает не более 5 попыток и никогда не сохраняется открытым. Email нужен
только для подтверждения: финальная заявка хранит телефон и metadata канала,
но не email. Отсутствие или сбой одного из провайдеров закрывает только
соответствующий OTP-вызов; readiness остальных виджетов остаётся доступным.

Опубликованный `verificationMode` фиксирует канал. Start принимает ровно
`{"phone":"+79991234567"}` для `SMS` либо
`{"email":"visitor@example.com"}` для `EMAIL` и возвращает
`challengeId`, `expiresAt`, `resendAvailableAt`, `destinationHint`. При `429`
клиент использует доступный через CORS заголовок `Retry-After`. Финальная
заявка передаёт прежние callback-поля плюс `challengeId` и шестизначный `code`;
для `EMAIL` она также повторяет email только для серверной привязки challenge.
При `OFF` challenge и code не принимаются.

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
