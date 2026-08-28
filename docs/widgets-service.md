# Widgets Service

## Назначение

Это канонический контракт сервиса Widgets.

Widgets — единственный владелец семи типов виджетов WinWidget:

- Wheel;
- Quiz;
- Callback;
- Countdown Timer;
- Stop Offer;
- AI Consultant;
- Calculator.

Сервис владеет конфигурациями, revisions, public runtime, заявками остальных
виджетов, AI-ответами без хранения переписки, telemetry, локальным usage
ledger, owner/entitlement projections, CRM/webhook интеграциями, Outbox,
receipts, retry/DLQ и operational health.

Identity владеет пользователями, Billing — подписками/квотами, Reporting —
read models, Notification Delivery — физической email/Telegram-доставкой,
Operations — глобальным audit/operational read model.

## Данные и границы

- database: `winwidget_widgets`;
- schema: `widgets`;
- один writer — Widgets;
- runtime role не имеет DDL и доступа к `_prisma_migrations`;
- migration, backup и restore roles разделены;
- межсервисные `userId`, `subscriptionId` и actor IDs хранятся как scalar
  values без cross-database foreign key;
- каждый process использует один глобальный PrismaModule/PrismaClient.

Ни один другой сервис не читает Widgets tables напрямую. Обмен выполняется
через versioned HTTP/events.

## HTTP

Внешний API остаётся под `/api/v1` и проходит через Gateway.

Защищённые management-префиксы:

- `/widgets`;
- `/quizzes`;
- `/callbacks`;
- `/countdown-timers`;
- `/stop-offers`;
- `/ai-consultants`;
- `/calculators`;
- `/widget-settings`;
- `/widget-runtime`;
- `/widgets/admin`.

Публичные config/messages/lead/telemetry-префиксы:

- `/widget`;
- `/quiz`;
- `/callback`;
- `/countdown-timer`;
- `/stop-offer`;
- `/ai-consultant`;
- `/calculator`;
- `/widget-events`.

Статические assets сохраняют URL `https://api.winwidget.ru/widgets/*.js` и
направляются Nginx прямо в Widgets. Preview остаётся во frontend на
`/page-{type}/:key`. Legacy aliases и Core fallback отсутствуют.

## Авторизация

| Поверхность                           | Gateway        | Widgets                              |
| ------------------------------------- | -------------- | ------------------------------------ |
| Public config/messages/lead/telemetry | optional       | domain, key, origin и quota checks   |
| Пользовательский CRUD/settings        | required       | Identity introspection и owner check |
| Admin read-only                       | required       | `ADMIN`/`DEV` по endpoint contract   |
| Admin mutation/manual retry           | required       | backend role check и audit event     |
| Internal health/control               | не публикуется | scoped service credential            |

Frontend-ограничение никогда не заменяет backend authorization.

## Квоты

Billing публикует `billing.subscription.changed.v1` через transactional Outbox.
Widgets хранит versioned entitlement projection. Identity публикует
`identity.user.changed.v1` для owner lifecycle projection.

Создание виджета или заявки виджета, который собирает контакты, выполняется
одной Widgets transaction:

1. захватить entitlement и usage row;
2. fail closed проверить projection, period и limit;
3. записать aggregate/lead;
4. изменить единственный canonical usage counter и ledger;
5. создать зависимые Outbox events;
6. commit.

Синхронная проверка чужой БД, dual-write и второй canonical counter запрещены.
AI Consultant не создаёт заявку и не изменяет lead counter. Его сообщения
обрабатываются синхронно через Workers AI и не сохраняются в PostgreSQL.

## AI Consultant

- slug и asset: `ai-consultant`, `ai-consultant.js`;
- публичная конфигурация: `GET /api/v1/ai-consultant/:key/config`;
- bootstrap защищённой сессии: `POST /api/v1/ai-consultant/:key/session`;
- публичное сообщение: `POST /api/v1/ai-consultant/:key/messages`;
- проверка сохранённого draft: `POST /api/v1/ai-consultants/:id/test-message`;
- текстовый `instructionsPrompt` хранится только в конфигурации владельца и
  никогда не возвращается публичным config endpoint;
- клиентская история ограничена, считается недоверенными данными и не является
  источником фактов или инструкций;
- для `ANSWER` модель возвращает внутренний точный `evidence` длиной не менее
  8 символов из `BUSINESS_CONTEXT`, но этот фрагмент никогда не отдаётся
  клиенту; дословное раскрытие prompt блокируется;
- ответ допускает только краткий пересказ: рискованные числа, цены, даты, URL и
  контакты должны встречаться в evidence, а отдельный bounded verifier-call
  подтверждает каждое утверждение; любой сбой проверки fail-closed заменяет
  ответ на `NO_INFORMATION`;
- запросы на раскрытие prompt/системных инструкций блокируются до вызова
  провайдера;
- текст инструкции ограничен 16 000 байт UTF-8; перед вызовом провайдера
  действует общий conservative input budget, в который сначала укладывается
  текущий вопрос, а затем только самая новая часть истории;
- для публикации обязательна нормализованная HTTP(S)-ссылка `privacyUrl`, а
  runtime показывает у поля ввода предупреждение не указывать персональные
  данные и ссылку на политику;
- конфигурация отклоняет PEM/private keys и распространённые token/password
  строки фиксированной ошибкой без вывода содержимого;
- PDF/Word, RAG, отдельная база знаний, заявки и хранение transcript отсутствуют.

Провайдер вызывается через Cloudflare Workers AI REST API. Обязательные
переменные: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_AI_GATEWAY_ID`, `CLOUDFLARE_AI_MODEL`,
`CLOUDFLARE_TURNSTILE_SITE_KEY`, `CLOUDFLARE_TURNSTILE_SECRET_KEY` и
`WIDGETS_AI_SESSION_SECRET`; timeout задаётся отдельными AI/Turnstile
переменными. API token требует Workers AI и Turnstile Sites Write. Payload
logging в AI Gateway принудительно отключён.
Для выбранного reasoning-моделя Qwen3 оба вызова принудительно завершают
последнее сообщение строкой `/no_think`; пользовательский `/think` не может
переопределить этот режим, а короткий verifier не расходует бюджет на reasoning.
Один AI-вызов ограничен 20 секундами, два последовательных вызова ответа и
verifier — 55-секундным browser deadline, а публичный Gateway route сохраняет
60-секундный deadline.

Публичный runtime получает одноразовый Turnstile token и обменивает его на
короткоживущую подписанную сессию, привязанную к ключу виджета, IP и версии
публикации. Free Turnstile widget всегда содержит `winwidget.ru`, максимум
восемь уникальных опубликованных клиентских доменов и один свободный
transition-slot. Публикация fail-closed добавляет новый hostname, не удаляя
старый live hostname до фиксации новой версии.
Каждая AI-публикация выполняет pre-sync committed domains union candidate,
затем DB commit и только после него exact committed reconcile. Crash до commit
не ломает live-виджет, а лишний hostname после crash не проходит отдельную
exact-domain проверку backend.

На клиентском сайте со строгой CSP нужно явно разрешить
`https://challenges.cloudflare.com` в `script-src`, `frame-src` и `connect-src`,
а домен WinWidget API — в `connect-src`. Turnstile `api.js` и frame нельзя
проксировать, зеркалировать или кешировать на стороне клиента.

## RabbitMQ

| Event                             | Producer | Consumer                       |
| --------------------------------- | -------- | ------------------------------ |
| `identity.user.changed.v1`        | Identity | Widgets owner projection       |
| `billing.subscription.changed.v1` | Billing  | Widgets entitlement projection |
| `widgets.widget.changed.v1`       | Widgets  | Reporting                      |
| `widgets.lead.changed.v1`         | Widgets  | Reporting                      |
| delivery request                  | Widgets  | Notification Delivery          |
| webhook/Bitrix24/amoCRM request   | Widgets  | Widgets integration workers    |
| admin audit event                 | Widgets  | Operations                     |

Publisher использует JSON `Buffer`, publisher confirm и mandatory return.
Consumer использует `eventId + consumer`, atomic PROCESSING claim, CAS lease,
commit до ack и отдельные main/retry/DLQ. Manual retry создаётся через Widgets
Outbox в одной transaction с изменением failure state.

## Runtime assets

Исходники runtime находятся в
[`apps/widgets/widgets-src`](../apps/widgets/widgets-src), сборка — в
принадлежащем Widgets `public/widgets`. Публикация выполняется только принятыми
`build:widgets`/`build:widgets:check` scripts. Сгенерированные assets и исходники
должны соответствовать друг другу в CI.

## Steady-state проверки релиза

- typecheck/unit/integration/contract tests Widgets;
- clean migration и runtime CRUD на PostgreSQL 18 при изменении schema;
- RabbitMQ/Outbox/retry/DLQ contracts;
- smoke всех изменённых типов, quota и NONE scenarios;
- Gateway/Nginx public route и неизменный `/widgets/*` URL;
- Identity/Billing projection health;
- backup job и, при изменении restore contract, clean restore rehearsal;
- exact deployment revision;
- отсутствие Core routes, writers, queues, legacy-алиасов консультанта и
  fallback-провайдеров.
