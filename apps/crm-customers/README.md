# WinCRM Customers

Автономная граница данных клиентов WinCRM. На этапе platform foundation сервис
содержит только runtime-каркас и собственный маркер базы данных. Контакты,
компании, дедупликация и API появятся после фиксации доменных контрактов.

## Граница владения

- сервис владеет только PostgreSQL-схемой `crm_customers` и собственной БД;
- Prisma Client генерируется в namespace `@prisma/crm-customers-client`;
- прямой доступ к таблицам `crm-access`, `crm-intake`, `crm-sales` и других
  приложений запрещён;
- общих runtime-модулей и общей БД у CRM-сервисов нет.

## HTTP

- `GET /health/live` — liveness и текущая ревизия;
- `GET /health/ready` — подключение к БД и проверка `service_identity`;
- `GET /health/revision` — безопасный идентификатор ревизии.

Бизнес-маршруты в будущем публикуются только под `/api/v1`. В production
listener обязан оставаться loopback; публичный трафик должен идти через
API Gateway. CORS принимает только точные `http/https` origins.

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

Значение `CRM_CUSTOMERS_DATABASE_URL` с placeholder будет отклонено fail-closed.
