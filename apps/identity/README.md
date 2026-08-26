# Identity service

Identity owns users, authentication identities, sessions, verification
challenges, OAuth, profile avatars, Telegram identity bindings, and the
PostgreSQL `identity` schema. Avatar objects remain in the configured S3
storage; this service does not replace them with host-bound files.

## Process roles

| `IDENTITY_PROCESS_ROLE` | Default port | Responsibility                                    |
| ----------------------- | -----------: | ------------------------------------------------- |
| `api`                   |         4900 | Auth/users/OAuth/Telegram HTTP contracts and JWKS |
| `worker`                |         4901 | Idempotent lifecycle/destination consumers        |
| `outbox-publisher`      |         4902 | Confirmed/mandatory Outbox publication            |

`IDENTITY_PORT` may override worker/publisher ports, but the API is fixed to
`4900`. Every role exposes `/health/live`, `/health/ready`, `/health/revision`,
and `/health/ownership`; only `api` registers business controllers.

## HTTP and internal contracts

Public routes are under `/api/v1`: `/auth/**`, `/users/**`,
`/telegram-auth/**`, and Telegram webhooks. JWKS is
`GET /api/v1/auth/.well-known/jwks.json`.

Private loopback contracts are outside the public Gateway:

- `POST /internal/v1/auth/introspect`
- `/internal/v1/widgets/owners/**`
- `/internal/v1/operations/audit-snapshots` and
  `GET /internal/v1/operations/admin-health`
- `POST /internal/v1/campaigns/eligible-contacts`
- `POST /internal/v1/billing/lifecycle/complete`
- `/internal/v1/identity/messaging/**`

Campaigns, Reporting, Widgets, Billing, Platform, Support, and Operations each
have a distinct `IDENTITY_<CALLER>_TOKEN`; the service rejects missing,
placeholder, reused, or short credentials. Identity itself calls Billing,
Widgets, and Operations through their dedicated Identity-scoped tokens.

## External providers

- Access JWTs use an RSA private key and public JWKS supplied as base64.
- OAuth credentials/callbacks are configured separately for Google, GitHub,
  Yandex, and VK.
- Email/SMS verification uses SMTP and SMS Aero.
- Telegram webhooks use the Auth and Info bot credentials. In production
  `TELEGRAM_API_BASE_URL` must be
  `https://tg.winwidget.ru/telegram-api`; direct Telegram is allowed only
  outside production.
- Avatar storage requires the dedicated `IDENTITY_AVATAR_S3_*` namespace.

## Configuration and deployment

Keep `.env.example` tracked and create an ignored `.env.production` beside it
on the VPS. Replace every `change_me`, use separate runtime/migration database
roles, and pass only role-required secrets into each container. Never print
private keys, bot tokens, provider secrets, or connection strings in deploy
logs.

```bash
pnpm install --frozen-lockfile
pnpm run prisma:generate
pnpm run prisma:validate
pnpm run prisma:migrate:deploy
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run build
docker build --build-arg APP_REVISION="$(git rev-parse HEAD)" -t winwidget-identity .
```

Start the API, worker, and Outbox publisher from the same immutable image and
verify every role's readiness plus public JWKS before switching Gateway routes.
