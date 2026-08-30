# Технический backlog WinWidget

Канонический backlog хранится в `docs/backlog.md` вместе с
backend-сервисами этого репозитория.

Документ содержит только незавершённые задачи, актуальные ограничения и
отложенные риски apps-only production-системы. Backend не содержит Core
runtime, его маршруты, очереди, пользователей или fallback.

## Принятые решения

- Backend расположен в `winwidget.ru_services` и состоит только из автономных
  приложений: Gateway, Billing, Campaigns, Identity, Notification Delivery,
  Operations, Platform, Reporting, Support и Widgets.
- Каждый доменный сервис владеет своей PostgreSQL 18 database, migrations,
  runtime/migration/backup roles и transactional Outbox. Запись в чужую БД и
  общий Prisma Client запрещены.
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
- На текущем этапе сервисы и их БД размещены на одном backend VPS. Это единый
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
  или dump приближается к лимиту Telegram.
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
safety dump и restore. В active registry входят семь service-owned targets:
`campaigns`, `identity`, `notification-delivery`, `platform`, `reporting`,
`support` и `widgets`. Billing остаётся только backup target до отдельного
платёжного review. Operations остаётся только backup target, пока job/lease и
recovery evidence не вынесены из восстанавливаемой схемы.

Осталось:

- до включения production restore закрыть trust gate custom archive одним из
  двух способов: предпочтительно подписывать в `maintenance-worker`
  исчерпывающую service-owned backup evidence отдельным Ed25519 private key и
  проверять её встроенным public key в API/restore-worker, либо выполнять
  `pg_restore` через dedicated least-privileged restore principal;
  bootstrap-admin connection с `--role` не считать sandbox, private signing
  key не передавать API/restore-worker, а binding обязан включать target,
  database/schema, artifact SHA-256, manifest/services SHA, backup job/time и
  tool/image revision;
- выполнить exact-SHA Linux/Docker/PostgreSQL 18 rehearsal всех targets,
  включая несовместимый dump, нехватку места, cancel race, restart checkpoint,
  ACL drift и изоляцию чужих БД;
- проверить one-shot permit, signed receipt и обязательное закрытие API после
  success, timeout и отмены workflow;
- отрепетировать реализованные `RECOVERY_REQUIRED` recovery-actions с
  проверкой terminal/lock/fence evidence и dual approval;
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

### P2 — lease-guarded compensation writer fence

Pre-authorization compensation сейчас повторно применяет physical writer fence
после ошибки, но потерявший lease процесс может сделать это уже поверх новой
generation. Это не открывает writer roles и остаётся fail-closed, однако может
перезаписать operation marker, закрыть активные sessions нового recovery и
создать production availability incident. До включения destructive restore
добавить DB guard exact current lease перед re-fence, отказ при более новом
target marker и two-worker fault test: старый process теряет lease, новый
записывает generation, поздний compensation не меняет marker и sessions.

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

### P2 — усилить DB-инварианты control ledger восстановления

Application CAS и signed receipts сейчас fail-closed проверяют допустимые
переходы, но PostgreSQL constraints ещё не выражают полную матрицу
`status ↔ phase ↔ release authorization ↔ terminal receipt`. До разрешения
production restore добавить exact CHECK/immutable triggers для terminal job и
recovery-action, сделать `recovery_resolved_at` монотонным и запретить cleanup
для строк без подтверждённой terminal shape. Отдельный CI gate должен поднять
чистую Operations PostgreSQL 18, применить все Prisma migrations и выполнить
negative SQL matrix для cross-binding, unknown target, mutable terminal state и
release-authorization/receipt constraints; service-target restore rehearsal не
считать заменой этому control-ledger gate.

### P2 — lease-bound compensation для writer fence

До release authorization compensation намеренно fail-closed повторно закрывает
writer roles. Старый worker после потери lease теоретически может возобновить
такой `apply`, перезаписать target generation marker уже новой operation и
создать availability-инцидент, хотя открыть writers без авторизации он не
может. Перед каждым compensation добавить финальный exact-lease CAS guard,
прочитать текущий target marker под advisory lock и запретить overwrite/terminate,
если marker принадлежит другой operation; сохранить HIGH alert с физическим
состоянием вместо ложного утверждения о закрытом fence. Покрыть двух-worker
fault matrix: старый process остановлен до apply, новая generation fenced,
старый process продолжен и не меняет marker, роли или сессии новой generation.

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

### P2 — устранить оставшиеся moderate/low зависимости сервисов

Production audit всей service matrix от 30.08.2026 не содержит high/critical.
В девяти доменных приложениях остаётся от четырёх до пяти moderate и одна low
уязвимость; API Gateway findings не имеет. Общие findings включают
`file-type@20.4.1` через `@nestjs/common` и
`@nestjs/core@10.4.22`, а также `qs@6.14.2` и `body-parser@1.20.4`;
Identity, Notification Delivery и Platform требуют отдельного разбора
дополнительного moderate finding. Текущие upload endpoints ограничивают тип и
размер файлов, SSE endpoints не используются, но зависимости должны быть
обновлены планово.

- Не применять слепой major override `file-type` и не совмещать плановый
  переход NestJS 10 → 11 / Express 4 → 5 с другими security hotfix.
- Проверить совместимые patch/minor upgrades `qs` и `body-parser`, подготовить
  отдельный NestJS 11 migration contract и повторить audit/integration/Docker
  gates.

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
