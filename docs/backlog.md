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

### P0 — завершить авторизованную и адаптивную browser-проверку frontend

Пользователь отменил новую продуктовую главную 06.09.2026:
`winwidget.ru/` снова показывает прежний полный лендинг виджетов,
меню — «Главная» и активная «CRM» → `https://crm.winwidget.ru`.
`/products/widgets` и `/products/crm` удаляются без совместимых маршрутов
по явному решению пользователя. Сохранённые `ecosystem`/`crmProduct` в
Platform JSON не удаляются; их редакторы больше не показываются.
Рабочий WinCRM остаётся на `crm.winwidget.ru`; кабинет Widgets, общая
админка, auth и оплата сохраняют текущие маршруты. Четыре приложения
монорепозитория и независимые подписки не объединять в новый runtime.

В production-браузере осталось проверить:

- прежний редактор главной и SEO в «Контенте», включая
  сохранность `ecosystem`/`crmProduct` при сохранении контента виджетов;
  чтение публичное, структурированные изменения — ADMIN/DEV, raw head/body
  по-прежнему только DEV. Изменения попадают в transactional audit Outbox;
- сохранённые `enabled:false` записи sitemap не должны включаться редактором
  при сохранении других полей контента;
- переключение рабочих приложений без обязательного экрана выбора,
  прежние auth/return URL и независимое backend-решение о доступе;
- desktop/mobile 320/390/768/1440, клавиатуру, контраст, формы редакторов,
  все прежние Widgets demo и отсутствие запросов к закрытому CRM API
  на главной и странице «Скоро» на домене CRM;

CMS не управляет release gate, ценами, URL интеграций или Trial.
Открытие продаж и активация Trial допускаются только после остальных
backend/business gates MVP.

Проверки CI, локального браузера и публичных HTTP-ответов не заменяют
авторизованную production-проверку ADMIN/DEV. Не подменять её созданием JWT
или обходом Identity. Текущий Platform JSON-контракт не требует новой БД,
миграции, пятого frontend-приложения или общего backend.

### P0 — завершить бизнес-сценарии MVP и подготовить отдельный rollout WinCRM

Локальная foundation WinCRM и четыре независимых `crm-*` приложения не должны
попасть в production обычным рестартом существующего контура. До merge/deploy
ветки CRM обязательно:

- пройти сквозные UI/API сценарии контактов/компаний, сделок, задач,
  входящих обращений и агрегированной аналитики; отдельно проверить
  серверные роли/OWN/TEAM scope, CAS/replay и визуальную адаптивность;
- завершить браузерные native Widgets release gates:
  подключение/ошибки/retry, OWN/TEAM и межпространственные ограничения,
  принятие безымянной заявки; затем повторить steady-state smoke
  на целевой production-топологии с provisioned scoped credentials;
- доказать сквозные браузерные сценарии приглашений, CRM-ролей/команд и
  конкурентного применения лимита сотрудников: минимум 2 вместе с владельцем,
  Trial по умолчанию 2 места вместе с владельцем,
  pending и отключённые сотрудники место не занимают;
- доказать paid CRM checkout/продление/дополнительные места в браузере и
  согласованном внешнем платёжном контуре; отдельно проверить в UI
  просмотр/экспорт после `TRIAL 5 дней -> GRACE 3 дня -> READ_ONLY`; изменения и новые заявки
  запрещены в READ_ONLY, автоудаления нет. Перед продажами подтвердить суммы:
  временные значения разрешены для разработки и настраиваются в `/admin/crm`,
  условия начатого периода сохраняются как snapshot Billing;
- доказать реальные автосписания WinCRM по согласованной модели Widgets: первоначальная
  оплата с явным согласием на привязку способа оплаты и автопродление,
  recurring charge, идемпотентные provider webhook и отключение автопродления.
  Подписки и оплаченные периоды CRM/Widgets независимы; отключение или ошибка
  одной подписки не изменяют другую. Не подменять MVP ручным продлением.
  Провайдер и платёжные данные остаются в Billing, критичные изменения
  платежа/подписки — синхронными, побочные эффекты — через transactional Outbox.
  Реальные первоначальные/повторные списания требуют участия пользователя;
- доказать сквозной UI-сценарий изменения оплаченного количества мест с немедленным
  пересчётом оставшегося
  оплаченное время по snapshot цен текущего периода: уменьшение количества
  продлевает срок, увеличение сокращает его. Денежный баланс и возврат на
  карту для этого сценария не вводятся. Расчёт выполняется на сервере,
  округление не должно создавать дополнительную оплаченную стоимость;
  конкурирующие изменения мест/периода и admission защищаются версиями и
  актуальными межсервисными contracts. Покупка во время Trial начинает
  платный период после окончания Trial, не сокращая его пять дней;
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
  отдельный `/api/v1/crm/intake/ingest` с политикой `crm-source` только для
  canonical POST `/:sourceId` и preflight OPTIONS; остальные Intake routes
  требуют пользовательский JWT. Ключ источника не является Identity JWT.
  Добавить `/api/v1/workspace-invitations` -> Identity и
  `/api/v1/billing-settings/crm` -> Billing с `required`,
  origin `https://crm.winwidget.ru` и
  обновить route-manifest только вместе с полной двусторонней синхронизацией
  production env;
- создать для каждого `crm-*` собственные runtime/migration/backup роли и БД,
  подключить отдельный `deploy/docker-compose.crm.yml` к проверенному
  CRM-only release controller, выполнить migration jobs и health/smoke,
  определить service-owned backup/restore и независимый
  rollback; нельзя объединять CRM-схемы или давать сервисам доступ к чужим
  таблицам;
- проверить возможность размещения четырёх CRM-сервисов на текущем backend
  VPS: пользователь разрешил этот вариант 06.09.2026 при достаточном запасе
  ресурсов. До размещения подтвердить стабильность workers, измерить
  CPU/RAM/disk/connection budget и зарезервировать ресурсы для четырёх
  независимых БД, API, publishers/workers, migrations и backup/restore.
  Не объединять базы или runtime ради экономии. Если безопасного запаса нет,
  оставить CRM закрытой и использовать отдельный VPS;
  frontend `crm.winwidget.ru` размещается в собственном контейнере на текущем
  общем frontend VPS. К существующим Identity/Billing/Widgets
  и RabbitMQ обращаться по private topology с отдельными scoped credentials;
  на одном VPS сохранять изоляцию сервисов и loopback/private endpoints.
  При размещении на разных VPS использовать защищённую межсерверную сеть.
  Для удалённых HTTP-вызовов — HTTPS private ingress, без
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
- до включения native connector добавить точный event route
  `widgets.wincrm.lead-transfer.requested.v1` в service-owned RabbitMQ topic
  write allowlist Widgets и независимую binding/очередь Intake. Текущий
  production ACL этот event не разрешает; одного feature flag недостаточно.
  Не расширять доступ до общего wildcard. Доказать confirm/mandatory return
  и доставку под реальными least-privilege credentials перед включением;
- включать native API только после обновления всех Widgets publishers,
  миграций, broker ACL и готовности durable binding/consumer Intake. Старый
  publisher не знает новый event и может поместить его в QUARANTINED.
  Отключение feature flag не разрешает откат publisher, пока остаются
  неопубликованные native events: сохранить совместимый publisher до
  доказанного завершения очереди и не удалять durable сообщения при rollback;
  - проверить лимиты входящего API за Gateway/private ingress: сейчас Intake
    не доверяет произвольному `X-Forwarded-For`, поэтому peer-IP bucket может
    быть общим для всех запросов proxy. До роста входящего потока зафиксировать
    trusted-proxy boundary с очисткой входящих заголовков и доверенными CIDR,
    проверить подмену IP и подобрать общий/поисточниковый throughput; не
    включать слепое доверие forwarded headers ради обхода лимита.

Отдельный CRM backend VPS не является обязательным условием: допустим
проверенный deployment на текущий backend VPS при выполнении gates выше.
Read-only замер 06.09.2026 22:20:27 МСК показал 4.964 GiB
`MemAvailable` из 7.751 GiB, 15.143 GiB свободного диска (81% занято)
и 31 healthy контейнер без restarts/OOM. Четыре секундных интервала
`vmstat` показали CPU busy 1–54% (без первой строки со средним с момента
старта): короткий снимок не доказывает p95, CPU PSI или запас под нагрузкой.
Порог 6 GiB относится к отдельному restore rehearsal (два временных
контейнера по 2 GiB плюс резерв 2 GiB), а не автоматически запрещает CRM runtime.
Его невыполнение не разрешает ослаблять restore gate.

При раздельных ролях native connector нужны 12 application processes:
Access — API/worker/publisher; Intake — API, три workers и три publishers;
Customers и Sales — по API. Вместе с четырьмя PostgreSQL это 16 новых
контейнеров, без временных migration/release jobs. Перед применением отдельного
Compose обязательны CRM-only controller, проверка фактических OCI revisions,
provisioning scoped credentials/DB roles и measured memory/CPU caps.
Shape validator не подтверждает capacity и не разрешает rollout. Routine
backend controller проверяет контейнеры своего project `winwidget`, но
RabbitMQ users — глобально: перед первым provisioning выпустить controller
с точным `CRM_RABBITMQ_CONTRACT=disabled|native-v1` и согласованно включить
`native-v1` под общим deploy lock после создания восьми principals/ACL/bindings.
На VPS этот переход ещё не проверен. Не ослаблять inventory до wildcard
и не возвращать `disabled` при rollback runtime, пока существуют CRM users
или события. До старта Access worker provisioner создаёт
три основные team queues, три DLQ и точные event/manual-retry bindings;
runtime с `CRM_ACCESS_RABBITMQ_ASSERT_TOPOLOGY=false` получает только read
на основные очереди, без configure/write. Подтвердить этот контракт на
целевом брокере, включая reconnect и fail-closed при отсутствующей очереди.
Для отдельного project `winwidget-crm` при первом
rollout проверить сохранение контейнеров/images в целевой среде при routine
cleanup, включая неиспользуемые CRM candidate/rollback tags, и общий deploy lock:
cleanup сравнивает глобальные running IDs и image bindings, поэтому параллельный
CRM rollout недопустим. Само наличие контейнеров другого project не является
ошибкой текущего project-scoped inventory.
Для локальной проверки заложить явные
Prisma pool limits: API 5, worker 4, publisher 1 — 40 runtime connections
(Access 10, Intake 20, Customers 5, Sales 5). Дополнительно резервировать
по три подключения на БД для migration/backup/read-only probe и отдельные
superuser slots. Старый и новый runtime при rollout могут удвоить pools:
проектные `max_connections` 32/48/16/16 требуют проверки либо исключения overlap.
Это предлагаемый бюджет, а не действующая production-конфигурация: реальные
CRM URLs ещё нужно сформировать и проверить. Отдельный Compose validator
требует `connection_limit` 5/4/1 и `pool_timeout=10`; применение бюджетов
остаётся заблокированным до нагрузочной проверки.

На production-shaped стенде проверить 12 процессов и четыре раздельные БД,
release images, worker prefetch/reconciliation и максимум одновременных
экспортов. Предварительная граница: дополнительный пик CRM вместе с ростом
RabbitMQ/Identity/Billing/Widgets не более 3 GiB при сохранении минимум 2 GiB
`MemAvailable`; общий CPU p95 не выше 70% и без ухудшения существующих SLO.
Не назначать произвольные жёсткие caps только по idle RSS. Подтвердить
connection ceilings без pool timeouts, восстановление очередей после burst,
WAL/место под новые и rollback images, migration и штатное резервное копирование.
Без этого capacity PASS не доказан; при нехватке ресурсов согласовать
увеличение VPS или другую топологию, не объединяя сервисы/БД.
Очистка диска не устраняет нехватку RAM.
Решение по frontend
уточнено пользователем 05.09.2026: все четыре приложения, включая WinCRM,
размещаются в отдельных контейнерах на одном текущем frontend VPS; отдельный
CRM frontend VPS больше не является условием выпуска. Работа над MVP
продолжается локально с commit/push и CI. После MVP разрешены frontend backlog
и выпуск на существующей инфраструктуре, но CRM-зависимые действия не
включаются до совместимого backend rollout. Перенос frontend на разные VPS
выполняется только при подтверждённой потребности масштабирования.

### P0 — совместимый rollout native Widgets Inbox

Сначала выпустить readers/экспорт/acceptance, понимающие WIDGET и nullable
имя, затем включать producer/consumer. Расширение значений текущих DTO не
совместимо со старым строгим reader. После первой WIDGET-записи отключение
feature flag само по себе не разрешает откат reader. Старые MANUAL/API/CSV
payloads и обязательность имени для них должны сохраниться.

Перед включением завершить браузерные сценарии всех шести типов виджетов:
доступ к WIDGET snapshots в OWN/TEAM scope и запрет чтения между workspace,
в том числе после отключения источника/окончания подписки; создание контакта
с подтверждённым именем для безымянной WIDGET-заявки и отсутствие переименования
выбранного существующего контакта. Повторить service-owned smoke на целевой
production-топологии с её точными образами и scoped credentials.

### P0 — безопасный rollout отложенных retry новых CRM workflows

Для team, widget-control и acceptance закрепить проверку целевой
production-топологии и recovery.
Если в целевой среде работала старая ревизия с classic TTL -> DLX, сначала
остановить её publishers/workers, сохранить legacy queues и их доступные
targets для drain и сверить ready/unacked с nonterminal job/receipt/Outbox.
Mixed old/new workers/publishers запрещены; purge не является recovery.

Legacy Outbox PENDING и expired PUBLISHING поддержаны новым publisher,
но PUBLISHED автоматически не сбрасывается: прежний confirm в retry queue
не доказывает последующий DLX republish. Уже потерянное сообщение требует
отдельного проверенного service-owned recovery по durable evidence, без
нового бизнес-эффекта или ручной публикации через Management API.
До первого rollout закрепить эту процедуру. Проверки новых CRM workflows
не являются доказательством надёжности всех RabbitMQ consumers платформы.

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

### P2 — масштабирование авторизации свыше 1000 отделов

Текущие межсервисные DTO ограничивают `teamIds` 1000 элементами. Для OWNER
и CRM_ADMIN Access возвращает активные отделы своего workspace; при
превышении лимита авторизация fail-closed (`503`), без обрезания списка.
До поддержки пространств с большим числом отделов нужен отдельный bounded
контракт проверки назначения отдела и пагинируемого выбора. Не расширять
scope wildcard, не читать чужие БД и не менять OWN/TEAM ограничения.
Для MVP с небольшими командами изменение этого контракта отложено.

## RabbitMQ и фоновые задачи

### P1 — retention доказательств и отменённых операций WinCRM

Immutable operation slots/tombstones, command receipts и workflow Outbox
предотвращают повторное создание контактов и сделок после запоздалой доставки.
Удаление по произвольному TTL нарушает эту гарантию. До согласования replay
horizon сохранять эти записи и наблюдать рост таблиц отдельно по сервисам.

Перед автоматической очисткой определить срок повторов public API, ручных
retry, broker/DLQ и offline workers; закрыть возможность исполнения сообщений
старше горизонта, сохранить достаточное доказательство отмены/завершения и
проверить позднюю redelivery после очистки. Очистка должна быть service-owned,
пакетной и не требовать доступа к чужой БД. Не применять общий TTL к активным,
неподтверждённым или частично выполненным workflow.

Для native Widgets connector отдельно определить срок хранения контактного
snapshot в transfer intent: бессрочная дедупликация не должна требовать
бессрочного хранения дополнительной копии персональных данных. До включения
автоматического удаления разделить неизменяемое доказательство передачи и
очищаемое содержимое; согласовать срок жизни payload, обработку удаления
исходной заявки и проверить late retry после очистки без воскрешения данных.
Не удалять proof вместе с payload и не обходить append-only ограничения
расширением прав обычного runtime.

Для service-owned `export_audit` отдельно согласовать срок хранения записей
PREPARED (actor, workspace, сущность, формат, объём и время, без содержимого
файла). Они подтверждают подготовку, но не фактическое скачивание клиентом.
До реализации ограниченной очистки отдельной maintenance-ролью обычный
runtime сохраняет только SELECT/INSERT; UPDATE/DELETE/TRUNCATE не разрешать.
До масштабирования экспорта закрепить лимиты соединений и медленных скачиваний
на Gateway/private ingress: process-local лимит подготовки файлов не ограничивает
уже отправляемые ответы и не является общей квотой нескольких replicas.

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

### P1 — проверить холодный старт остальных сервисов

Production-инцидент 06.09.2026 показал, что `process.exitCode = 1` после
ошибки bootstrap не завершает процесс, если AMQP reconnect, пул БД или таймеры
удерживают event loop. Consumer при этом может работать, хотя HTTP listener
не открыт и Docker считает контейнер unhealthy. Одного порядка запуска
Compose недостаточно при автоматическом старте контейнеров после reboot VPS.

Проверить аналогичные entrypoints Identity, Platform, Reporting,
Widgets и Gateway: наличие того же catch в коде — риск,
но не доказательство текущего отказа этих healthy сервисов. Перед их
выборочным выпуском воспроизвести зависшие handles, проверить successful
startup/обычный graceful shutdown и отсутствие преждевременной обработки.
Для каждого исправления доказать ограниченное по времени закрытие частично
созданного context, гарантированный nonzero exit и автоматический restart
после поздней готовности RabbitMQ на exact image.
Не менять миграции, платёжную семантику, queue ACL или удалять сообщения.
Этот startup fix не заменяет отдельную гарантию восстановления активной
бизнес-операции после crash и не закрывает Operations busy-lease ACK риск.

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

### P1 — durable redelivery после аварии Operations backup worker

При остановке worker после захвата `PROCESSING` повторная доставка до
окончания lease может получить `claim = null` и быть подтверждена без
повторного durable trigger. Это риск по результатам анализа кода, а не
подтверждённый production-инцидент.

До закрытия crash-recovery гарантий различать terminal/no-op и занятый lease;
для второго случая обеспечить durable delayed retry через Outbox либо
service-owned CAS recovery. Не перехватывать действующий lease и не очищать
очередь. Обязательны тесты crash-after-claim, redelivery-before-expiry,
повторного запуска и восстановления без параллельных внешних действий.
Исправление не входит в узкий rollout OTP и удаления пользовательского Backlog.

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

Перед production-включением платной WinCRM отдельно включить новые
`crm_commerce_*`, `crm_orders`, `crm_paid_periods`, `crm_auto_renewal*`,
`crm_provider_*`, `crm_payment_receipts` в service-owned backup/restore review.
Billing пока не входит в семь разрешённых restore targets Operations:
простое добавление `billing.protect_wincrm_commerce_evidence()` в общий
allowlist не заменяет отдельный target, writer fence и rehearsal. Требуются
точные ACL: без DELETE/TRUNCATE для девяти commerce-таблиц, append-only
consent/command evidence, запрет runtime EXECUTE новой защитной routine,
восстановление lease/Outbox без повторного создания списания. Не применять
общий STANDARD ACL с DELETE к платёжным доказательствам. Для четырёх новых
CRM-сервисов service-owned backup/restore и отдельные runtime/migration роли
проверить на выбранном backend VPS до открытия рабочего продукта.

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

### P1 — подтвердить реальную доставку и вход по резервному коду

С участием пользователя проверить в production получение кода на его
подтверждённые email/телефон и завершение входа при недоступности Google
CAPTCHA. Успешный `GET /api/v1/auth/login-otp/capabilities`, наличие настроек
SMTP/SMS и одинаковый ответ запроса кода не доказывают фактическую доставку.
Без участия пользователя не отправлять тестовые SMS/письма и не создавать
сессии обходом Identity.

Проверить в браузере неверный и истёкший код, повторную отправку после
таймера, восстановление после ошибки и сохранность обычного входа.
Не ослаблять browser binding, независимые PostgreSQL-лимиты
IP/контакта/канала, trusted-proxy boundary или CAPTCHA обычного входа и
регистрации. Frontend не должен показывать фиктивную успешную доставку
при неготовом backend. Локальные synthetic transport/PG/DOM проверки не
заменяют эту внешнюю проверку.

### P1 — общий auth rate limiter до нескольких replicas

Для прежних password/register/OAuth endpoints до второй Identity/Gateway
replica вынести process-local counters в общий
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

### P1 — применить удаление пользовательской вкладки «Беклог» в production

Миграцию Operations `20260910110000_remove_admin_backlog` пока не выполнять:
06.09.2026 пользователь уточнил, что дополнительные копии ему не нужны.
Не создавать ещё один dump и не скачивать production safety dump на Mac;
существующие backups и штатное резервное копирование не удалять и не отключать.
Возобновление destructive phase B требует отдельно согласованной проверки
восстановления; отказ от дополнительной копии не заменяет эту проверку.
Автопроверка безопасности отклонила скачивание из-за чувствительных данных:
общее разрешение на реализацию/deploy не заменяет согласие на этот перенос.
Не обходить отказ другим транспортом или промежуточным хранилищем. После
согласия использовать только проверенные SHA/размер dump и receipts,
каталог 0700 и файлы 0600, без вывода содержимого и загрузки третьим лицам.
Не повторять phase A/capture и не заменять сохранённые immutable receipts.
До успешного восстановления настоящего dump destructive phase B запрещена.
Удалить Gateway route
`operations-notes` с полной двусторонней синхронизацией production env и
совместимым exact infra contract (42 routes, 7 у Operations).

Сохранить runtime без Notes endpoints при сохранённой таблице, повторно
доказать отсутствие старых writers и активных Notes-транзакций и применить
destructive migration только после проверки копии. Проверить скачанный backup по hash и восстановлением
в изолированную БД; одного `pg_restore --list` недостаточно. Operations не
входит в собственный allowlist автоматического restore: не пытаться
восстановить её control ledger через тот же работающий control ledger.
Штатный Telegram backup с `--no-privileges` не доказывает сохранение writer
fence: после такого restore у runtime может не быть прав независимо от
состояния исходной БД. Для destructive phase B нужен отдельный проверенный
ACL-preserving safety dump из maintenance-worker boundary, только через
Operations backup role, и root-bound acquisition receipt: phase-A hash,
database UUID, точный container/image/revision, SHA/размер файла и время
получения после fence. Одного `restoredAt >= fencedAt` недостаточно.
Закрепить эти проверки в producer/consumer evidence до удаления таблицы;
не подменять их JWT mint, ручным API bypass или запуском `pg_dump` в API.
Локальный isolated PostgreSQL 18 proof требует собственного resource preflight;
он не является production rehearsal семи signed restore targets и не снимает
его отдельный gate 6 GiB.
Синхронизировать новый immutable infra pin с удалением route; прежний pin
`b602ae5` ожидает 43 маршрута и несовместим с новым контрактом 42.

Миграция удаляет только `operations.notes` и связанные audit-копии по
`BACKLOG`, `backlog_task`, `BACKLOG_TASK_*`; не использовать CASCADE и не
затрагивать заметки клиентов CRM, остальные audits, Outbox или receipts.
После rollout проверить отсутствие старого UI и Notes endpoints. Старый
Notes-capable runtime нельзя возвращать без явного плана восстановления.
Исторические backups сохраняются по действующему retention; их автоматическое
удаление не входит в разрешение очистить данные вкладки. Технический
`docs/backlog.md` не относится к удаляемым пользовательским данным.

### P1 — завершить production-проверки frontend после cutover

Закончить авторизованную production browser-проверку роли ADMIN,
редактирования контента, частичной недоступности соседнего приложения и
сохранения состояния существующего задания восстановления для ADMIN/DEV.
Локальные проверки не заменяют production-сессию. Не включать восстановление
и не создавать задания только ради визуальной проверки; release gates и
backend guards остаются обязательными.

Все четыре frontend-контейнера пока размещаются на одном существующем VPS.
Сохраняются прежние main-domain URL Widgets и админки, auth/returnUrl, OAuth,
cookies и публичные страницы виджетов. Завершить разрешённое пользователем
удаление устаревшего GitHub-репозитория `nda17/winwidget.ru_client_crm`:
текущему CLI-токену недоступен scope `delete_repo`, DELETE возвращает 403.
В действующей браузерной сессии GitHub также требует повторного подтверждения
личности владельца перед удалением; без участия пользователя его не обходить.
Перед повтором проверить точный repository ID `1351670384`, перенос истории
в монорепозиторий и сохранность recoverable Git bundle вне Git-репозиториев.
Не удалять `winwidget.ru_frontends` или действующий checkout `winwidget.ru_client`.
Не путать готовность frontend с выпуском четырёх CRM backend-сервисов:
по решению пользователя 06.09.2026 CRM-ссылка должна быть активной и вести на
`https://crm.winwidget.ru`. До выпуска backend этот домен показывает «Скоро»
без инициализации сессии; продуктовые API и платёжные действия выключены.

### P1 — завершить browser-проверку фильтров ошибок доставки Operations

В авторизованной production-сессии `/admin/messaging` проверить все пять
фильтров, частичную недоступность источника и существующие backend-права.
Отдельно проверить отображение `RESOLVED` и `CLOSED`, не трактуя исторические
строки с неизвестным результатом как успешную доставку. Не запускать retry/DLQ
или внешние отправки ради проверки. Browser-блокировку окном расширения
нельзя обходить подменой сессии или самостоятельно выпущенным JWT.

До destructive Notes phase B требуется отдельная проверка нового сочетания
API/worker revisions. Сохранённая phase-A квитанция не доказывает четыре
процесса одной старой ревизии; не переписывать её и не ослаблять admission.

### P2 — выборочный независимый frontend release после первого cutover

Первый reviewed cutover-controller выпускает четыре приложения одним
согласованным набором. Для обычных последующих обновлений добавить явный
выбор приложения и независимый rollback без пересоздания соседних контейнеров.
Сохранять exact image/revision ownership, общий Nginx lock, append-only static
assets, compatibility gates shared packages и проверки всех потребителей
изменённого package. Отдельные сборки и образы сами по себе не доказывают
независимый production deploy. Разнос на разные VPS отложен до подтверждённой
потребности масштабирования; общий VPS пока остаётся единой точкой отказа.

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
