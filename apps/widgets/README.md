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

## Нативный коннектор WinCRM — Widgets producer

`WIDGETS_WINCRM_CONNECTOR_ENABLED=false` по умолчанию: старые submit endpoints,
квоты, внешние интеграции `lead.integration.requested.v2` и AI-консультант не
меняются. При выключенном флаге новый hook не читает таблицы и не вызывает
Billing, внутренние CRM endpoints отвечают `404`, новые credentials не нужны.
Поддерживаются только `WHEEL`, `QUIZ`, `CALLBACK`, `TIMER`, `STOP_OFFER`,
`CALCULATOR`. Campaigns и чат AI-консультанта в этот контракт не входят.

При включении API/all требует отдельные `WIDGETS_CRM_INTAKE_TOKEN`,
`BILLING_WINCRM_WIDGETS_TOKEN` и явный `BILLING_INTERNAL_BASE_URL`: HTTPS origin
без path/credentials либо локальный loopback HTTP. Между VPS нужен защищённый
ingress на owning host с forwarding к loopback API; прямой remote socket,
`X-Forwarded-For` и общие токены доступа не принимаются. Internal запросы несут
`x-winwidget-service: crm-intake` и `x-winwidget-internal-token`; ответ `no-store`.
Проверка Billing использует только его scoped read-only eligibility contract,
не запускает Trial и не меняет подписку или usage. EASY/HARD должны иметь
действующий оплаченный/административно активированный период; Widgets TRIAL
не подходит. Отрицательная проверка запрещает включение, но не отключение.

Три внутренних POST без публичных `/api/v1` alias:

- `/internal/v1/crm-intake/widget-connectors/candidates`: exact body
  `{schemaVersion:1,ownerSubject,page,pageSize}`; server pagination до 100 строк
  с type/id/name/isActive/publishedVersion/createdAt, текущим активным connector
  либо null и свежим Billing eligibility. Только собственные шесть таблиц,
  никаких публичных ключей, конфигураций и credentials.
- `/internal/v1/crm-intake/widget-connectors/:connectorId/configure`: exact body
  `{schemaVersion:1,commandId,workspaceId,sourceId,ownerSubject,widgetType,widgetId,controlVersion,generation,enabled}`,
  UUID `Idempotency-Key` равен commandId. Immutable binding, monotonic
  controlVersion и отдельная generation при новом включении. Одинаковая команда
  возвращает исходный receipt, а не текущее состояние; другой payload/actor —
  `409`. Устаревшая версия не применяется. Предварительное отключение создаёт
  tombstone и не позволяет позднему enable возродить старую generation.
  Один widget имеет не более одного активного connector. DISABLE не требует
  существующего widget или живой подписки. ENABLE проверяет Billing до own
  transaction, затем owner/widget и validity внутри неё.
- `/internal/v1/crm-intake/widget-transfers/:transferId/context`: exact body
  `{schemaVersion:1,eventId,connectorId,generation,workspaceId,sourceId}`.
  Ответ `{schemaVersion:1,transferId,eventId,connectorId,generation,workspaceId,sourceId,deliver,reason,checkedAt,validUntil,payload}`.
  Неизвестная/чужая привязка — `404`, непроверяемое состояние — `503`, известное
  прекращение доставки — `deliver:false,payload:null`. Полная owner/widget
  привязка проверяется в runtime и composite FK. Positive proof повторно
  проверяет локальное состояние после HTTP, текущую подписку и исходный срок.

`wincrm_connectors`, `wincrm_connector_commands`, `wincrm_transfer_intents`
принадлежат только Widgets. Команды и intents append-only. Configure locks:
command → widget; submit: существующий quota owner lock → widget; обратного
захвата quota lock нет. Новые locks имеют SQL `lock_timeout=1500ms`,
`statement_timeout=5000ms`; configure дополнительно Serializable retry.
В lead transaction атомарно сохраняются исходная заявка/usage, immutable intent
и Outbox. Исходный `originalSubscriptionId` — Billing CUID из projection.id,
не UUID и не выдуманный локальный ID. Capture не делает HTTP. Ошибка БД откатывает
всю транзакцию, неподдерживаемый payload создаёт видимый `SKIPPED` intent.

Outbox event/routing key — `widgets.wincrm.lead-transfer.requested.v1`,
exchange `EVENTS`, messageId=eventId. Exact identifier-only payload:
`{schemaVersion:1,eventType,eventId,occurredAt,transferId,connectorId,generation,workspaceId,sourceId,originalSubscriptionId,originalSubscriptionVersion,originalPeriodStartsAt,originalDeadline}`.
Последние четыре поля nullable при skipped capture; version — decimal bigint
string, включая `0`. JSON передаёт прежний publisher с Buffer/confirm/mandatory,
не новый consumer или прямой publish. DTO и bounded typed snapshot определены
в `src/wincrm/widgets-wincrm.contract.ts` и `widgets-wincrm-snapshot.ts`.

Snapshot сохраняет nullable реальное имя, raw контакт/телефон, точный E164 если
он уже дан, email, безопасный page URL, бонус/quiz answers с опубликованными
подписями/callback slot/calculator Decimal и typed answers. Нет IP, OTP,
reset tokens, HTML, URL userinfo/query/fragment и целой конфигурации. Unicode
проверяется без повреждения emoji; ограничение snapshot 256 KiB UTF-8. Данные
не обрезаются молча: `PAYLOAD_TOO_LARGE`, `PAYLOAD_SHAPE_UNSUPPORTED`,
`TEXT_UNSUPPORTED`, `SOURCE_PERIOD_INELIGIBLE`, `SOURCE_PERIOD_INVALID` или
`BEFORE_ACTIVATION` видны через context. История не импортируется. Исходный
deadline никогда не продлевается новой оплатой; validity ≤ 5 секунд — только
transport freshness bound, не обещание распределённой атомарности отзыва.

Runtime grants нового среза: schema USAGE; `SELECT,INSERT,UPDATE` на
`wincrm_connectors`; `SELECT,INSERT` на commands и intents; без
DELETE/TRUNCATE, без UPDATE evidence. Существующие service-owned lead/quota/
projection/Outbox grants сохраняются; новых sequences нет. Readiness при
включённом флаге проверяет новые таблицы. PostgreSQL proof запускается после
migrate/generate/build: `pnpm run test:integration:wincrm`, только с явным
`WIDGETS_INTEGRATION_ALLOW_MUTATION=true` и `WIDGETS_TEST_DATABASE_URL` на
свежую локальную `winwidget_widgets_test_*_test` или `winwidget_widgets_ci`.
Immutable проверочные строки оставляются до удаления выделенной тестовой БД
её владельцем; runtime не выдаётся право обходить evidence triggers.

Воспроизводимая локальная проверка использует уже запущенный Colima container
`wincrm-mvp-postgres18` с label `winwidget.test=crm-mvp`, PostgreSQL 18 на
`127.0.0.1:55440` и bootstrap `crm_bootstrap_ci`:

```bash
WIDGETS_LOCAL_WINCRM_PG_ALLOW_MUTATION=true node apps/widgets/test/integration/local-wincrm-postgres.mjs
```

Запуск из корня services проверяет активный context/Unix socket/daemon/label и
точный loopback port; создаёт новую `winwidget_widgets_test_<randomhex>_test`
и две ограниченные роли. Миграции запускаются их владельцем, runtime получает
только перечисленные grants. Сценарий доказывает отсутствие cross-schema доступа,
проверяет sentinel, реальные ограничения/rollback и owner-level evidence triggers.
Существующие fixtures, env, CRM БД и другие контейнеры не читаются и не меняются.
Сгенерированные credentials не печатаются и не сохраняются в файлы. Временная
копия Prisma без env удаляется, имена собственной БД/ролей выводятся для
последующей общей cleanup; контейнер остаётся запущенным для соседних проверок.
В тестовом ACL `UPDATE(id)` на шесть widget-таблиц требуется PostgreSQL для
`SELECT ... FOR SHARE`; это не выдаёт UPDATE остальных полей и не расширяет
права на evidence или чужую схему. Production grants runner не меняет.

До включения остаются обязательные rollout gates: работающий отдельный Intake
consumer с eventId+consumer receipt, independent retry/DLQ/manual retry,
свежая CRM write authority и source-generation fence, собственный PII retention/
purge policy для новых snapshots (старый Widgets retention их не очищает),
private ingress, реальные PostgreSQL/RabbitMQ проверки. Widgets не утверждает
`DELIVERED` и не предоставляет отдельный ack endpoint: результат доставки
принадлежит Intake. Этот producer сам по себе не включает интеграцию у клиента.

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
