# WinCRM Sales

Автономная граница воронок и сделок WinCRM. На этапе platform foundation
сервис содержит runtime-каркас, собственный маркер базы данных и read-only
каталог версионированных шаблонов процесса. Сделки, workspace pipelines и
применение шаблона в этот этап не входят.

## Граница владения

- сервис владеет только PostgreSQL-схемой `crm_sales` и собственной БД;
- Prisma Client генерируется в namespace `@prisma/crm-sales-client`;
- прямой доступ к таблицам `crm-access`, `crm-intake`, `crm-customers` и других
  приложений запрещён;
- общих runtime-модулей и общей БД у CRM-сервисов нет.

## HTTP

- `GET /health/live` — liveness и текущая ревизия;
- `GET /health/ready` — подключение к БД и проверка `service_identity`;
- `GET /health/revision` — безопасный идентификатор ревизии;
- `GET /api/v1/crm/templates` — неизменяемый каталог десяти шаблонов v1.

Каталог не читает и не пишет БД. `schemaVersion` описывает форму ответа,
`catalogRevision` — текущую ревизию списка, а `template.version` — неизменяемую
версию конкретного шаблона. В будущем выбранная definition клонируется в
workspace по точной паре `(templateKey, templateVersion)` отдельной командой с
собственной авторизацией и идемпотентностью. Старые версии не перезаписываются.

В production listener обязан оставаться loopback; публичный трафик должен идти
через API Gateway. CORS принимает только точные `http/https` origins.

## Локальные проверки

```bash
cp .env.example .env
pnpm install --frozen-lockfile
pnpm prisma:generate
pnpm prisma:validate
pnpm lint
pnpm test
pnpm typecheck
pnpm build
```

Значение `CRM_SALES_DATABASE_URL` с placeholder будет отклонено fail-closed.
