# API Gateway

Public HTTP entry point for WinWidget. The Gateway does not own PostgreSQL or
RabbitMQ state: it validates access JWTs against Identity JWKS and proxies each
explicit `/api/v1` prefix to its domain service.

## Runtime contract

- Listens on `GATEWAY_LISTEN_HOST:GATEWAY_PORT` (`127.0.0.1:4100` by default).
- `GATEWAY_ROUTES_JSON` is required and contains exact route objects with
  `id`, `pathPrefix`, `upstreamUrl`, `authPolicy`, and `timeoutMs`.
- Longest matching prefix wins. `API_UPSTREAM_URL` is rejected; there is no
  catch-all fallback.
- Bearer validation fails closed when JWKS cannot be initialized or refreshed
  within the configured stale window.
- `/api/v1/internal/**` is never exposed through the public Gateway.

The Operations control plane owns these additive public prefixes and they must
target `http://127.0.0.1:5200`:

- `/api/v1/admin-alerts`
- `/api/v1/messaging/admin`
- `/api/v1/telegram-bot/admin`
- `/api/v1/dev-tools/database-restores`

Gateway health is served directly at `GET /health/live`, `GET /health/ready`,
and `GET /health` (readiness alias).

## Configuration and deployment

Copy `.env.example` to `.env.production` in the Gateway directory on the VPS.
The production file stays next to this service, is ignored by Git, and must be
supplied to only the Gateway container. Replace the sample route array with the
complete production routing table; do not add a `/api/v1` Core catch-all.

Build and verify from this directory:

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run build
docker build --build-arg APP_REVISION="$(git rev-parse HEAD)" -t winwidget-api-gateway .
```

After deployment, verify both health endpoints and at least one route per
upstream. A 200 from Gateway health alone does not prove any upstream is ready.
