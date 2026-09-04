# WinCRM Sales

Автономная граница воронок и сделок WinCRM. Текущий срез содержит runtime,
собственную схему PostgreSQL, read-only каталог версионированных шаблонов и
идемпотентную установку точной версии шаблона в новую workspace-воронку.
Операции со сделками в этот этап не входят.

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
- `POST /internal/v1/crm-access/pipelines/install-template` — защищённая
  pairwise-token команда установки для `crm-access`;
- `GET /internal/v1/crm-access/pipelines/workspaces/:workspaceId/installation`
  — защищённое чтение результата для reconciliation.

Каталог не читает и не пишет БД. `schemaVersion` описывает форму ответа,
`catalogRevision` — текущую ревизию списка, а `template.version` — неизменяемую
версию конкретного шаблона. Выбранная definition и её закреплённый SHA-256
клонируются в workspace по точной паре `(templateKey, templateVersion)`.
Воронка, этапы, installation и command receipt фиксируются одной serializable
PostgreSQL-транзакцией; повтор той же команды возвращает тот же результат, а
другая пара для уже инициализированного workspace отклоняется. Старые версии
шаблонов не перезаписываются.

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
