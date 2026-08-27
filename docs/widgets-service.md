# Widgets Service

## Назначение

Widgets — единственный владелец семи типов виджетов WinWidget:

- Wheel;
- Quiz;
- Callback;
- Countdown Timer;
- Stop Offer;
- Online Consultant;
- Calculator.

Сервис владеет конфигурациями, revisions, public runtime, заявками, telemetry,
локальным usage ledger, owner/entitlement projections, CRM/webhook
интеграциями, Outbox, receipts, retry/DLQ и operational health.

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
- `/online-consultants`;
- `/calculators`;
- `/widget-settings`;
- `/widget-runtime`;
- `/widgets/admin`.

Публичные config/lead/telemetry-префиксы:

- `/widget`;
- `/quiz`;
- `/callback`;
- `/countdown-timer`;
- `/stop-offer`;
- `/online-consultant`;
- `/calculator`;
- `/widget-events`.

Статические assets сохраняют URL `https://api.winwidget.ru/widgets/*.js` и
направляются Nginx прямо в Widgets. Preview остаётся во frontend на
`/page-{type}/:key`. Legacy aliases и Core fallback отсутствуют.

## Авторизация

| Поверхность                    | Gateway        | Widgets                              |
| ------------------------------ | -------------- | ------------------------------------ |
| Public config/lead/telemetry   | optional       | domain, key, origin и quota checks   |
| Пользовательский CRUD/settings | required       | Identity introspection и owner check |
| Admin read-only                | required       | `ADMIN`/`DEV` по endpoint contract   |
| Admin mutation/manual retry    | required       | backend role check и audit event     |
| Internal health/control        | не публикуется | scoped service credential            |

Frontend-ограничение никогда не заменяет backend authorization.

## Квоты

Billing публикует `billing.subscription.changed.v1` через transactional Outbox.
Widgets хранит versioned entitlement projection. Identity публикует
`identity.user.changed.v1` для owner lifecycle projection.

Создание виджета или заявки выполняется одной Widgets transaction:

1. захватить entitlement и usage row;
2. fail closed проверить projection, period и limit;
3. записать aggregate/lead;
4. изменить единственный canonical usage counter и ledger;
5. создать зависимые Outbox events;
6. commit.

Синхронная проверка чужой БД, dual-write и второй canonical counter запрещены.

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
- отсутствие Core routes, writers, queues и provider adapters.

Для schema-compatible релиза допустим только независимый rollback Widgets
image; fallback owner adapters не добавляются.
