# Контракт миграции NestJS 11 / Express 5

Дата подготовки: 30.08.2026.

Миграция выполняется отдельным major-релизом после завершения совместимого
dependency-hotfix. Она не объединяется в одном rollout с recovery, legal или
иными security-изменениями.

## Scope

Отдельная ветка: `dev_3.0.0/refactor/nestjs-11-express-5`.

В scope входят восемь неплатёжных приложений:

- campaigns;
- identity;
- notification-delivery;
- operations;
- platform;
- reporting;
- support;
- widgets.

API Gateway не использует NestJS и остаётся без изменений. Billing исключён
по решению владельца продукта до отдельного payment review. Независимые
service-owned runtime и lockfiles позволяют временно эксплуатировать Billing
на NestJS 10 без скрытой общей зависимости.

## Целевые версии

- `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express`,
  `@nestjs/testing`: `11.1.18`;
- `@nestjs/config`: `4.0.4`;
- Identity `@nestjs/jwt`: `11.0.2`;
- `express`: `5.2.1`;
- `@types/express`: `5.0.6`;
- Widgets `@types/multer`: `2.2.0`;
- проверенный Multer override остаётся `2.2.0`;
- временные overrides Express 4/body-parser удаляются;
- override `file-type` запрещён: NestJS 11 должен сам разрешить совместимый
  `file-type@21.3.4` или более новый безопасный patch в том же major.

## Проверяемые breaking contracts

Express 5 меняет синтаксис route patterns, query parser, значение `req.body`,
обработку rejected promises, static dotfiles и MIME types. NestJS 11 меняет
framework/runtime prerequisites и adapter behavior. До rollout проверяются:

- Reporting и Widgets заменяют `MiddlewareConsumer.forRoutes('*')` на
  `forRoutes('{*splat}')`; вариант со скобками обязан покрывать также root;
- Identity разделяет cookie options установки и удаления: `clearCookie` не
  получает `maxAge` или `expires`, но сохраняет exact `path`, `sameSite`,
  `secure` и `httpOnly` boundary;
- Express 5 `simple` query parser остаётся включённым; повторный, массивный или
  объектный scalar query отклоняется `400` в Identity, Operations и Widgets,
  а не выбирает первый элемент, не меняет формат и не доходит до `.trim()`;
- Platform задаёт явный конечный JSON transport limit, достаточный для
  существующего прикладного лимита до 1 MiB с JSON escaping; Support задаёт
  `512 KiB` raw-body limit из единой константы Telegram webhook;

- все публичные, внутренние и webhook routes, global prefix и exclusions;
- query arrays/objects, validation pipe и exception filters;
- cookies, CORS, trusted proxy и получение клиентского IP;
- Identity auth/OAuth/JWKS, avatar multipart upload и redirect/cookie flags;
- Operations restore multipart size/type limits без destructive execution;
- Widgets PNG upload и `/widgets/*` static MIME/cache/CORS;
- Support raw-body Telegram webhook;
- Platform sanitizer против `javascript:` и malformed URI attributes;
- server-side email rendering Identity и Notification Delivery;
- отсутствие `@Sse`, `FileTypeValidator` и прямого `qs.stringify` повторно
  подтверждается статическим поиском.

Целевой production graph обязан содержать Express `5.2.1`, body-parser
`2.3.0`, path-to-regexp `8.4.2`, file-type `21.3.4` и Multer `2.2.0`. Express
4, body-parser 1, file-type 20 и Multer 1 в восьми runtime graph запрещены.
Blind override `file-type` не используется.

Reflection-only controller tests не доказывают совместимость Express adapter.
Для каждого приложения нужен реальный HTTP boundary test с global prefix,
route params, отсутствующим body, rejected async handler и завершением процесса
в deadline без `SIGKILL`. Дополнительно проверяются:

- Campaigns и Notification Delivery: DTO query arrays/objects возвращают
  `400`;
- Identity: JWKS/OAuth routes, repeated query и exact Set-Cookie при set/clear;
- Operations: restore multipart, `:target`/`:jobId`, scalar admin queries и
  PostgreSQL 18 rehearsal;
- Platform: запросы больше 100 KiB до выбранной границы и sanitizer;
- Reporting: correlation middleware на API, internal и root routes;
- Support: exact raw `Buffer`, malformed body и границы `512 KiB`/`+1`;
- Widgets: `{*splat}` middleware, scalar query, route arrays, JavaScript/PNG
  MIME, cache/CORS и отказ в выдаче dotfiles.

Официальные migration guides:

- <https://docs.nestjs.com/v11/migration-guide>;
- <https://expressjs.com/en/guide/migrating-5.html>.

## Обязательные gates

Для каждого приложения:

1. frozen install собственного lockfile;
2. `pnpm audit --prod --audit-level low` без findings;
3. Prisma generate/validate, если применимо;
4. lint, typecheck, unit tests и production build;
5. собственные PostgreSQL 18/RabbitMQ integration tests;
6. production Docker image с проверкой Node major, OCI exact revision и
   отсутствия уязвимых версий в runtime graph.

Общие gates:

- lifecycle/static Compose validators;
- Gateway route manifest и cross-service contracts;
- upload/webhook/static-asset regression matrix;
- exact-SHA CI и отдельный immutable production rollout;
- direct/public health, auth, widget asset и changed-scenario smoke;
- rollback только на schema-compatible previous images; эта миграция не должна
  содержать DB migration.

## Acceptance

Миграция закрыта только когда audit всех восьми приложений показывает ноль
`low/moderate/high/critical`, production images соответствуют тому же SHA и
публичные/direct smoke подтверждают healthy revision. Dependency debt Billing
остаётся отдельной платёжной задачей и не маскируется общей отметкой о
завершении.
