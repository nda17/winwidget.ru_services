# WinCRM Access

Автономный оркестратор доступа к WinCRM. Сервис не владеет пользователями,
workspace или подписками: актуальную сессию и memberships он синхронно
получает из Identity, а entitlement — из Billing. Локальная PostgreSQL хранит
только состояние входа workspace в CRM.

## Границы

- публичный API: `GET /api/v1/crm/access/bootstrap` и
  `POST /api/v1/crm/access/trial`;
- health: `GET /health/live`, `GET /health/ready`;
- Identity остаётся единственным владельцем пользователя, сессии и membership;
- Billing остаётся единственным владельцем статуса entitlement и длительности
  trial;
- сервис не использует RabbitMQ и Outbox, поскольку текущий срез не публикует
  локальных доменных событий.

`POST /trial` требует UUID v4 в `commandId`, совпадающий заголовок
`Idempotency-Key`, workspace с ролью `OWNER` и Bearer access token. Сначала
идемпотентно фиксируется Billing entitlement, затем локальный onboarding. Если
локальная запись временно не удалась, повтор того же command безопасно
восстанавливает её по сохранённому Billing receipt.

Скопируйте `.env.example`, задайте отдельные сильные service tokens и URL базы,
затем выполните:

```bash
pnpm install --frozen-lockfile
pnpm prisma:generate
pnpm prisma:migrate:deploy
pnpm build
pnpm start
```

Production internal URLs обязаны быть точными loopback HTTP origins. Любая
сетевая ошибка, HTTP error (включая `404`) или невалидный ответ Identity/Billing
закрывает доступ с `503`; отсутствие entitlement признаётся только по успешному
ответу Billing со статусом `NOT_ACTIVATED`.
