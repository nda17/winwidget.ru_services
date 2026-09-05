# Технический backlog WinWidget

Канонический backlog хранится в `docs/backlog.md` вместе с
backend-сервисами этого репозитория.

Документ содержит только незавершённые задачи, актуальные ограничения и
отложенные риски apps-only production-системы. Backend не содержит Core
runtime, его маршруты, очереди, пользователей или fallback.

## Принятые решения

- Backend расположен в `winwidget.ru_services` и состоит только из автономных
  приложений: Gateway, Billing, Campaigns, Identity, Notification Delivery,
  Operations, Platform, Reporting, Support, Widgets, CRM Access, CRM Intake,
  CRM Customers и CRM Sales.
- Каждый доменный сервис владеет своей PostgreSQL 18 database, migrations и
  runtime/migration/backup roles. Если сервис публикует событие, зависящее от
  локальной транзакции, он также владеет transactional Outbox. Запись в чужую
  БД и общий Prisma Client запрещены.
- Критичные изменения бизнес-состояния выполняются синхронно в PostgreSQL.
  RabbitMQ используется для асинхронных побочных эффектов.
- RabbitMQ работает по модели at-least-once. Consumer идемпотентен по паре
  `eventId + consumer`, подтверждает сообщение только после commit и имеет
  собственные retry/DLQ.
- Зависимое от записи в PostgreSQL событие создаётся через transactional Outbox
  в той же транзакции. Publisher использует confirm и `mandatory return`.
- `maintenance-worker` выполняет `pg_dump`; `database-restore-worker` выполняет
  привилегированное восстановление. API и обычные consumers не получают admin
  DB credentials.
- Operations владеет operator-facing read model, аудитом, backup policy/jobs и
  restore-control. Доменные receipts/failures/outbox остаются у владельцев.
- Identity единолично владеет пользователями, сессиями, OAuth/JWT/JWKS и
  introspection. Gateway не является источником бизнес-авторизации.
- Публичный API доступен под `/api/v1`; статические runtime-файлы Widgets
  остаются на стабильных `/widgets/*` URL.
- Production env каждого приложения хранится отдельно и не попадает в Git.
  Секреты не выводятся в логи и не передаются через RabbitMQ.
- На текущем этапе production-сервисы и их БД размещены на одном backend VPS. Это единый
  failure domain, а не отказоустойчивая конфигурация.

## P0 — доказать production-платежи и фискализацию

Read-only аудит production API и личного кабинета ЮKassa от 27.08.2026
подтверждает активный не тестовый магазин, оплату банковской картой и наличие
успешных платежей. «Чеки от ЮKassa» подключены: сервис автоматически отправляет
чеки покупателю и в налоговую, а услуги ОФД включены. В кабинете также
подтверждены URL `https://api.winwidget.ru/api/v1/payments/webhook` и события
`payment.succeeded`, `payment.canceled`. Повторная read-only сверка существующего
успешного платежа вернула `succeeded`, после чего Billing подтвердил
синхронизацию подписки.

Эти доказательства не подтверждают работу текущей ревизии при новом
первоначальном и рекуррентном списании. До появления клиентов требуется
оставшаяся внешняя проверка production-контура:

- с менеджером или поддержкой ЮKassa подтвердить договорное включение
  автоплатежей и привязки карт: Basic Auth и личный кабинет не показывают
  однозначный machine-readable признак этой возможности;
- с участием пользователя выполнить минимальные первоначальный и рекуррентный
  платежи и сопоставить provider operation, идемпотентный webhook, подписку,
  квоты и пользовательский результат;
- проверить отказ от автопродления и отсутствие следующего списания;
- на новых тестовых операциях подтвердить доставку чека покупателю, теги 1125,
  1187 и 1008, OFD links, обработку `receipt.canceled`, ошибок регистрации и
  корректирующего чека;
- с бухгалтером подтвердить VAT, subject и payment mode, а с юристом —
  опубликованные оферту и политику обработки данных.

Не объявлять платёжный контур production-ready до получения этих внешних
доказательств. Codex не выполняет реальный платёж без участия пользователя.

## WinCRM

### P0 — завершить бизнес-сценарии MVP и подготовить отдельный rollout WinCRM

Локальная foundation WinCRM и четыре независимых `crm-*` приложения не должны
попасть в production обычным рестартом существующего контура. До merge/deploy
ветки CRM обязательно:

- завершить реальные UI/API сценарии контактов/компаний, сделок, задач,
  входящих обращений и агрегированной аналитики; отдельно проверить
  серверные роли/OWN/TEAM scope, CAS/replay и визуальную адаптивность;
- реализовать приём через CSV, API/webhook и opt-in managed Widgets connector
  для всех типов виджетов; доказать workflow приёма обращения в сделку,
  transactional Outbox, publisher confirm/mandatory return, независимые
  push consumers, идемпотентные receipts, retry/DLQ и crash recovery;
- завершить приглашения, CRM-роли/команды и конкурентное применение лимита
  сотрудников: минимум 2 вместе с владельцем, Trial по умолчанию 5,
  pending и отключённые сотрудники место не занимают;
- завершить paid CRM checkout/продление/дополнительные места и просмотр/экспорт
  после `TRIAL 5 дней -> GRACE 3 дня -> READ_ONLY`; изменения и новые заявки
  запрещены в READ_ONLY, автоудаления нет. Перед продажами подтвердить суммы:
  временные значения разрешены для разработки и настраиваются в `/admin/crm`,
  условия начатого периода сохраняются как snapshot Billing;
- синхронно добавить отдельные production tokens Identity/Billing для
  `crm-access`, не ослабляя обязательную проверку токенов в runtime;
- синхронно задать одну и ту же сильную пару
  `CRM_SALES_CRM_ACCESS_TOKEN` в `crm-access` и `crm-sales`; несовпадение или
  односторонняя ротация блокирует rollout и onboarding;
- синхронно задать независимые пары `CRM_ACCESS_CRM_CUSTOMERS_TOKEN`,
  `CRM_ACCESS_CRM_SALES_TOKEN`, `CRM_ACCESS_CRM_INTAKE_TOKEN` у вызывающего
  сервиса и CRM Access; публичный `/crm/access/permissions` не заменяет
  свежую независимую backend-авторизацию каждой доменной команды;
- держать публичные CRM routes закрытыми до согласованного применения Billing
  provenance migration/runtime и `crm-access` migration/runtime: новый exact
  Billing-контракт несовместим со старым parser, а новые Billing `NOT NULL`
  поля нельзя оставлять со старым Trial write-path;
- добавить точные Gateway route prefixes `/api/v1/crm/access` -> `crm-access`,
  `/api/v1/crm/templates` и `/api/v1/crm/sales` -> `crm-sales`,
  `/api/v1/crm/customers` -> `crm-customers`, `/api/v1/crm/intake` -> `crm-intake`,
  origin `https://crm.winwidget.ru` и
  обновить route-manifest только вместе с полной двусторонней синхронизацией
  production env;
- создать для каждого `crm-*` собственные runtime/migration/backup роли и БД,
  Compose services, migration jobs, health/smoke, backup/restore и независимый
  rollback; нельзя объединять CRM-схемы или давать сервисам доступ к чужим
  таблицам;
- подготовить отдельный CRM backend VPS для четырёх сервисов и отдельный
  frontend VPS для `crm.winwidget.ru`; к существующим Identity/Billing/Widgets
  и RabbitMQ обращаться по защищённой межсерверной сети с отдельными scoped
  credentials. Для удалённых HTTP-вызовов — HTTPS private ingress, без
  redirects и отключения TLS verification. Не раскрывать internal routes в
  публичном Gateway; не подменять удалённые адреса localhost;
- проверить PostgreSQL 18 migrations, Identity backfill существующих
  пользователей, вход через основной сайт, явную идемпотентную активацию Trial
  и fail-closed доступ при недоступности Identity/Billing;
- исключить окно между Identity backfill и переключением нового runtime:
  остановить создание пользователей старой ревизией через drain/write-fence
  либо выполнить доказанную идемпотентную reconciliation после её остановки;
  rollout блокируется, пока любой пользователь, созданный в этом окне, может
  остаться без личного workspace и OWNER membership;
- до публикации каталога закрепить immutable fingerprint каждой пары
  `templateKey@version`; после публикации не переписывать v1, а выпускать новую
  версию с точной установкой выбранной пары;
- доказать согласованную обратную совместимость Widgets: отсутствие CRM не
  влияет на заявки и прежние интеграции, managed connector включается явно
  только на оплаченных `EASY`/`HARD`; окончание подписки прекращает новые
  передачи, сохраняя полученные данные. Историю автоматически не переносить.
- проверить лимиты входящего API за Gateway/private ingress: сейчас Intake
  не доверяет произвольному `X-Forwarded-For`, поэтому peer-IP bucket может
  быть общим для всех запросов proxy. До роста входящего потока зафиксировать
  trusted-proxy boundary с очисткой входящих заголовков и доверенными CIDR,
  проверить подмену IP и подобрать общий/поисточниковый throughput; не
  включать слепое доверие forwarded headers ради обхода лимита.

Новые CRM VPS ещё не созданы; их деплой явно отложен пользователем 05.09.2026.
Работа продолжается локально с commit/push и CI. После MVP разрешены frontend
backlog и выпуск остальных приложений на существующей инфраструктуре, но
CRM-зависимые действия не включаются до совместимого backend rollout.

### P1 — восстановление неизвестного результата команды после новой авторизации

Стабильный UUID и immutable payload не должны теряться при повторной проверке
доступа или размонтировании frontend-формы. Memory-only coordinator сохраняет
такую команду в текущем документе, но не переживает полный reload или redirect
на login. Session DTO не содержит подтверждённого идентификатора auth-сессии;
нельзя переносить команду в другую сессию по одному совпадению `userId`.

До обещания сквозного восстановления после повторного входа добавить
service-owned read-only recovery contract по безопасному идентификатору
команды с новой Identity/CRM авторизацией, actor/workspace binding и
ограниченным ответом без source tokens. Определить способ сохранения только
нечувствительного command reference и срок его жизни. Не сохранять JWT, PII
или ключи источников в browser storage ради retry; последующий 401/403/409
не считать доказательством отката предыдущей неоднозначной попытки.

## RabbitMQ и фоновые задачи

### P1 — production-наблюдение и recovery

- Наблюдать lag Outbox, ready/unacknowledged, retry, DLQ, heartbeat и broker
  alarms отдельно по каждому владельцу очереди.
- Откалибровать alert thresholds и SLA; пустая DLQ без consumer нормальна,
  первое сообщение в ней должно поднимать alert.
- Проверить восстановление после перезапуска RabbitMQ, publishers, workers и
  schedulers без потери и дублей.
- Провести контролируемые тесты недоступности SMTP, Telegram и CRM providers.
- Проверить catch-up плановых сводок и backups после истечения CAS lease.
- До роста числа replicas измерить `max_connections`, reserved connections и
  фактический `pg_stat_activity`, затем распределить connection budget с
  резервом 20–30% для migrations и административных операций.
- Quorum queues вводить только вместе с кластером минимум из трёх RabbitMQ
  узлов или managed broker; тип существующей очереди in-place не менять.

### P2 — persistent circuit breaker для сломанных destinations

При общей ошибке credentials новые события могут создавать повторяющиеся
failures. Перед реализацией согласовать продуктовую семантику паузы.

- Хранить durable incident с ключом
  `source + entityId + integration + targetFingerprint`.
- Явно определить судьбу новых событий: deferred, DLQ или согласованный
  fallback; молча отбрасывать их нельзя.
- Закрывать incident только после подтверждённой смены credentials либо
  аудируемого DEV-действия.
- Показывать владельцу безопасную причину без секретов и PII.

### P2 — crash-boundary внешних уведомлений

SMTP и Telegram остаются at-least-once: авария после принятия сообщения
провайдером, но до фиксации результата может дать редкий дубль. Telegram Bot
API не предоставляет idempotency key, а email provider не обязан
дедуплицировать стабильный `Message-ID`.

Если продукту потребуется более строгая гарантия, выбрать provider с
idempotency/receipt API или явно принять семантику редкого дубля. Нельзя
помечать delivery успешной до внешнего вызова: это заменит дубли потерями.

## Telegram

### P1 — независимый мониторинг публичного TLS relay

`185.184.122.62:8443` — публичный fixed-upstream TLS relay и единая точка
исходящего доступа backend к Telegram.

- Добавить внешний synthetic TLS smoke с SNI `api.telegram.org`, проверкой
  сертификата, listener, firewall и upstream errors.
- Доставлять alert каналом, не зависящим от Telegram.
- Не писать в метрики и логи Bot API token, URL с token, payload или backup.
- Проверять relay с внешней точки и из каждого использующего его runtime.
- При повторных отказах оценить второй relay и failover с теми же TLS и
  fixed-upstream ограничениями.

## Backup и восстановление

### P1 — ограничения backup-контура

Telegram-документы service-owned БД приняты как временные off-VPS logical
backups. Это не даёт PITR и ограничено размером файлов.

- Алертить, если любой активный backup не завершён, lease истекает повторно
  или dump приближается к 20 МБ: стандартный
  [Telegram Bot API](https://core.telegram.org/bots/api#getfile) позволяет
  отправить до 50 МБ, но автоматический возврат через `getFile` ограничен
  20 МБ. Текущий application upload limit 49 МиБ не является доказательством
  recoverability; backup больше 20 МБ нельзя считать автоматически
  восстанавливаемым через принятый relay.
- До недоступного для автоматического возврата размера перенести backups в
  зашифрованное versioned object storage с минимальными credentials, retention
  и детерминированным ключом артефакта.
- При росте проекта определить RPO/RTO и перейти на WAL/PITR либо managed
  PostgreSQL.
- Учесть at-least-once последствия восстановления delivery receipts/outbox:
  возможны дубли или потеря поздних outcomes.

### P1 — доказать защищённое production-восстановление

Operations принимает и аудитирует DEV-only restore request, а изолированный
`database-restore-worker` выполняет manifest/SHA/TOC/migration/ACL проверки,
safety dump и restore. `maintenance-worker` уже выпускает detached Ed25519
provenance sidecar, а API и restore-worker проверяют его по встроенному
multi-key public keyring и exact artifact/job bindings. В active registry
входят семь service-owned targets:
`campaigns`, `identity`, `notification-delivery`, `platform`, `reporting`,
`support` и `widgets`. Billing остаётся только backup target до отдельного
платёжного review. Operations остаётся только backup target, пока job/lease и
recovery evidence не вынесены из восстанавливаемой схемы.

Осталось:

- на exact production SHA создать свежую подписанную пару dump/sidecar и
  провести контролируемый restore rehearsal для каждой из семи целей с
  проверкой artifact provenance, writer fence, migration/ACL evidence и
  terminal outcome; до завершения rehearsal сохранять
  `DATABASE_RESTORE_ENABLED=false`;
- отдельно отрепетировать `RECOVERY_REQUIRED` действия `VERIFY_AS_IS`,
  `ROLL_BACK_SAFETY` и `ROLL_FORWARD_SOURCE`, включая dual approval,
  terminal/recovery receipts и restart/redelivery;
- провести первую rehearsal ротации Ed25519 keyring по documented
  verify-before-sign procedure и доказать, что старые sidecar остаются
  проверяемыми в течение retention пригодных backup и незакрытых
  restore/recovery evidence;
- если потребуется вернуть Operations self-restore, вынести control ledger,
  lease, incidents и recovery evidence в отдельную невосстанавливаемую границу;
- решить, остаётся ли in-place restore приемлемым, либо перейти к восстановлению
  в новую изолированную PostgreSQL с проверкой до switch;
- подтвердить на production rehearsal заданный retention restore artifacts и
  alerts на зависшие job/fence.

### P2 — выделенная recovery session boundary перед расширением control plane

Текущий restore-контракт сознательно доверяет единственному bootstrap-admin и
single-replica `operations-restore-worker`: admin secret не получают API и
остальные containers, а глобальный CAS запрещает overlapping mutation.
PostgreSQL `CONNECTION LIMIT` не является барьером для superuser и не
используется как гарантия fence.

До запуска нескольких restore-worker replicas, удалённого recovery или выдачи
admin secret другому процессу добавить отдельный recovery proxy/session
boundary с единоличным lease-aware допуском, отзывом сессий и аудитируемым
fail-closed shutdown. До этого не расширять текущую trusted boundary и не
утверждать защиту при компрометации restore-worker/admin secret.

### P2 — keyring для ротации подписей recovery receipt

Первичный rollout использует один active HMAC key и запрещает его замену, пока
есть `PROCESSING`, `RECOVERY_REQUIRED` или незавершённые recovery-actions. До
первой ротации добавить current/previous keyring и проверку подписи по key ID,
зафиксировать approve/rehearsal procedure и удалять прежний ключ только после
доказанного отсутствия незавершённых receipt, подписанных этим ключом.

### P2 — durable upload intent для безопасной очистки no-DB restore dump

Upload сохраняет UUID staging dump до транзакции permit/job/Outbox. Отсутствие
job даже спустя 24 часа не доказывает rollback: исходный PostgreSQL backend
может всё ещё ждать lock или завершать неоднозначный commit. Поэтому текущий
cleanup fail-closed не удаляет no-DB `.dump` автоматически. До автоматической
очистки таких файлов добавить отдельный durable upload-intent, зафиксированный
до появления sweepable artifact и атомарно переводимый вместе с job/Outbox;
sweep может удалять dump только по terminal/abandoned intent после повторной DB
проверки. Покрыть blocked transaction дольше retention, ambiguous commit,
restart и bounded batch без starvation.

## Платежи и юридические требования

### P1 — Billing default ACL PostgreSQL

Billing исключён из общего ACL-hardening до отдельной проверки платёжного
контура. Перед закрытием payment review нужно проаудировать `pg_default_acl` и
`pg_proc.proacl`, зафиксировать точный routine allowlist новой immutable
migration и доказать fail-closed поведение на чистой PostgreSQL 18, после
migrations и после restore. Не переносить в Billing изменения других сервисов
без отдельного платёжного решения.

### P2 — безопасная ротация ключа платёжных методов

- Добавить key ID в versioned ciphertext и keyring current/previous keys.
- Выполнять пакетное перешифрование с CAS/checkpoint без RabbitMQ-секретов.
- Удалять прежний ключ только после доказанного отсутствия старых записей.
- Логировать только запуск, итог и количества, без ключей/provider IDs.

### P2 — уведомления о неуспешном автосписании

После фиксации отказа создать versioned Outbox event и доставлять email через
Notification Delivery: безопасная причина, сумма, номер попытки, дата retry и
путь отключения автопродления. Разделить шаблоны retry/final pause и доказать
идемпотентность при повторном webhook.

### P2 — неизменяемые версии юридических документов

Добавить immutable revision с slug, version, hash, author и publication time.
До реализации определить retention и восстановление версии. Exact checkout
consent snapshot в Billing остаётся отдельным обязательным доказательством.

### P2 — retention платёжных данных и согласий

- Согласовать сроки отдельно для платёжных, фискальных данных и согласий.
- Определить судьбу IP, User-Agent, masked method и OFD links.
- Реализовать идемпотентную пакетную очистку с агрегированным audit.
- Учесть legal hold и восстановимость отчётности.

## Identity и доступ

### P1 — общий auth rate limiter до нескольких replicas

До второй Identity/Gateway replica вынести process-local counters в общий
storage с атомарными counters и TTL. Сохранить buckets по endpoint, trusted IP
и login identity, определить fail-open/fail-closed и проверить рестарт,
конкуренцию и балансировку между replicas.

### P1 — штатная и аварийная ротация Identity signing keys

Текущий keyset нельзя менять ad hoc. Нужен reviewed action, который атомарно
добавляет новый public JWK, переключает active private key, выдерживает overlap
не меньше `access TTL + clock tolerance + JWKS cache TTL`, очищает verifier
caches и проверяет отказ старой подписи после окна. Секреты не должны покидать
Identity trust domain.

## Widgets и продуктовые данные

### P1 — Turnstile pool и общий AI-chat limiter до роста

Текущий AI-консультант работает на одной API replica и ограничивает запросы
process-local по global/owner/widget/IP/session, включая один inflight на
сессию, dedup request ID и circuit breaker провайдера.

До публикации девятого уникального клиентского домена автоматизировать pool
Turnstile widgets и hostname sync: один Free widget резервирует из десяти
слотов один для `winwidget.ru` и один для crash-safe смены hostname, поэтому
текущий fail-closed предел — восемь клиентских доменов. Выбор pool widget должен
быть детерминированным, храниться в Widgets, не раскрывать secret key и
атомарно завершать pre-sync до DB publish.

До запуска второй Widgets API replica также вынести signed-session replay
state, hostname-sync coordination, rate counters, request-ID dedup и circuit
breaker в общее атомарное хранилище с TTL/CAS. Сохранить те же scope-лимиты, не
записывать тексты вопросов, ответов или prompt, хешировать сетевые
идентификаторы и проверить конкуренцию, restart и истечение lease между
replicas.

### P1 — внешний legal/DPA gate AI-консультанта

До коммерческого масштабирования юрист должен подтвердить договорный и
регуляторный контур после обновления публичной политики и согласия:

- проверить и принять актуальный Cloudflare DPA, перечень subprocessors,
  страны обработки, сроки хранения и порядок удаления;
- подтвердить роли владельца клиентского сайта, WinWidget и Cloudflare и
  оформить поручение обработки персональных данных в клиентском договоре/DPA;
- подтвердить 1095-дневный срок хранения минимального immutable consent
  receipt, основания удаления и legal hold без хранения текста переписки;
- подтвердить выполнение локализации в РФ и необходимость/содержание
  уведомления Роскомнадзора о трансграничной передаче до её начала;
- обязать каждого владельца сайта раскрыть Cloudflare Workers AI и Turnstile в
  собственной политике/согласии и указать эту ссылку в `privacyUrl`.

Технический контракт запрещает использовать политику WinWidget в клиентской
настройке, выключает AI fail-closed без допустимой ссылки, требует отдельное
явное согласие до загрузки Turnstile, хранит version/hash/acceptedAt и
псевдонимизированный receipt без переписки и отключает AI Gateway logging. Это
не заменяет внешнее юридическое заключение и договорные документы.

## Инженерная эксплуатация

### P2 — разделить frontend админки, лендинга и рабочего приложения WinWidget

Выполнять отдельным этапом после локального MVP WinCRM. Сейчас основной
Next.js frontend объединяет лендинг, рабочее приложение WinWidget и операторскую админку;
общий RootLayout загружает настройки и контент главной страницы. Это связывает
их сборки, зависимости и выпуск изменений. Перед стартом повторно проверить
связность приложений и актуальность разделения.

Согласованные названия четырёх приложений: «Лендинг WinWidget», «Рабочее
приложение WinWidget», «Общая админка WinWidget и WinCRM», «Рабочее приложение
WinCRM». Рабочее приложение WinWidget включает создание/настройку виджетов,
редакторы и предпросмотр, заявки, интеграции и подписку. Встраиваемый JS-runtime
остаётся отдельной частью сервиса Widgets; публичные страницы виджетов сохраняются.

- Сначала выделить общую админку WinWidget/WinCRM в самостоятельное
  frontend-приложение с собственной сборкой и контейнером; затем разделить
  лендинг и рабочее приложение WinWidget. WinCRM остаётся существующим четвёртым отдельным
  frontend-приложением.
- Не считать запуск нескольких контейнеров одного полного Next.js-приложения
  завершённым разделением. У каждого приложения нужны самостоятельные build,
  image, CI/deploy, health/smoke и rollback. Новые VPS для каждого frontend
  не обязательны; размещение и итоговые домены согласовать перед переносом.
- Сохранить обратную совместимость текущих URL, bookmarks, auth/returnUrl,
  OAuth callbacks, cookies, logout и публичных страниц виджетов. Маршрутизацию
  и при необходимости redirects зафиксировать явно и проверить до cutover.
- Сохранить единый Identity и service-owned API: отдельный frontend админки
  не требует нового admin backend или общей БД. Backend RBAC, DEV-only
  mutations и Журнал событий остаются обязательными.
- Редактирование контента лендинга остаётся в общей админке во вкладке
  «Контент»; маркетинговые scripts/HTML/providers не должны загружаться в
  операторском приложении.
- Общие стабильные UI tokens/components допускается вынести в версионированный
  package; не создавать runtime-импорты между frontend-приложениями.
- Проверить browser-сценарии и адаптивность отдельно для каждого приложения,
  включая вход, переходы между продуктами, редактирование контента и
  недоступность соседнего frontend.

### P1 — убрать временное ограничение Platform sanitizer audit

С 02.09.2026 `npm audit` для `sanitize-html@2.17.5` публикует conditional
moderate finding `GHSA-g8qq-57p8-ggw5`; upstream также опубликовал
`GHSA-jxwj-j7wr-gfrw`, который пока не индексируется текущим audit-ответом.
Полностью исправленная `2.17.7` требует Node.js `>=22.12.0`, тогда как
production Platform закреплён на Node.js `20.20.2`. Текущий Platform contract
не разрешает SVG/SMIL и `textarea`/`xmp` tags или wildcard attributes,
применяет scheme policy только к `href`, а regression tests удаляют оба
опубликованных exploit payload.

Временный production audit constraint разрешает только прямой exact path
`. > sanitize-html@2.17.5` для этих двух advisory IDs; остальные versions,
paths и findings по-прежнему запрещены. Fail-closed проверка запрещает symlinks
в `apps/platform/src`, фиксирует SHA-256 manifest всех production TypeScript
sources Platform, а через AST — единственный default import, package subpaths,
dynamic module literals, все ссылки и два прямых call sites. Отдельно
проверяются SHA-256 точной literal-конфигурации и обоих regression tests, затем
обязательно запускаются и успешно выполняются все три GHSA test cases. Boundary
выполняется безусловно, пока закреплена `2.17.5`, даже если registry временно
вернул ноль findings; сам audit также требует ожидаемый exit status, пустой
muted-list и точное совпадение severity metadata/advisories.

- В отдельной ветке перевести build/runtime/CI Platform на поддерживаемый
  Node.js 22 LTS с immutable image digest либо дождаться совместимого
  backport-релиза `sanitize-html`.
- Обновить `sanitize-html` минимум до `2.17.7`, выполнить frozen install,
  audit от low, unit/integration и production image gates, затем удалить exact
  audit constraint. Regression test сохранить.
- Не совмещать этот runtime-переход с Billing review или restore rehearsal.

### P2 — dependency review Billing после проверки платёжного контура

API Gateway и восемь неплатёжных приложений переведены на NestJS 11 / Express 5. Все, кроме описанного выше exact Platform constraint, имеют нулевой
production audit от low до critical. Billing намеренно не включён в общий
major-переход и остаётся на NestJS 10 / Express 4 до отдельной проверки
платёжного контура владельцем продукта.

- Не переносить общие overrides или major-версии в Billing без отдельного
  payment review.
- При закрытии review повторить frozen install, audit от low, unit/integration,
  PostgreSQL 18 и production Docker gates только для точного Billing SHA.

### P2 — повысить сигнал CI и распараллелить verify

- Перехватывать ожидаемые ERROR/WARN отрицательных tests через logger spy.
- Добавить стабильный required aggregator поверх matrix jobs и сохранить
  cross-service contract/integration gate.
- В integration jobs использовать отдельные migration/runtime PostgreSQL-роли
  без DDL и cross-schema доступа у runtime; RabbitMQ permissions и topic
  permissions должны совпадать с production least-privilege contract, а не
  разрешать весь `winwidget.*` namespace.

### P2 — условное выделение Backup service

Текущие `maintenance-worker` и `database-restore-worker` достаточно изолированы
для одного VPS. Выделять `backup-service` только при измеримой причине:
отдельный VPS/SLA/команда либо необходимость независимого release. Тогда
закрепить durable jobs, собственную schema/Outbox и versioned command contract,
не передавая admin credentials через API или RabbitMQ.

### P2 — подготовка к размещению сервисов на разных VPS

До первого переноса сервиса:

- CI один раз собирает image для commit SHA, публикует его в private registry
  и deploy использует immutable digest;
- pin SSH host key каждого VPS из доверенного канала и включить
  `StrictHostKeyChecking=yes`;
- перенести internal HTTP с loopback на private network с firewall allowlist,
  mTLS/service identity и отдельной ротацией credentials;
- заменить локальный AMQP на `amqps://` по private network с least-privilege
  credentials;
- переносить сервис вместе с его БД/volume либо managed PostgreSQL endpoint,
  не создавая второго writer;
- rollback переключает только сервис на предыдущий совместимый digest и не
  перезапускает остальные приложения.

## Операции, которые остаются синхронными

- изменение статуса платежа, подписки и квот;
- регистрация, login, verification challenges и привязка контактов;
- быстрые административные CRUD-операции;
- сверка provider-status платежа до окончательного решения;
- очистка опубликованного Outbox retention service пакетно по индексу.
