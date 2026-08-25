# Support service

Standalone owner of the WinWidget operator chat and Support Telegram webhook.
It is a clean-break extraction: Gateway routes point to port `5100`, Core does
not admit or reconcile Support updates, and there is no legacy read/write
fallback.

## Runtime roles

- `api` (`127.0.0.1:5100`) admits raw Telegram updates, serves Support admin
  settings/manual failure controls, and calls Identity introspection with the
  scoped `IDENTITY_SUPPORT_TOKEN`.
- `worker` (`127.0.0.1:5101`) consumes the dedicated Support queue, claims
  inbox/receipt leases with CAS, and performs idempotent Telegram delivery.
- `outbox-publisher` (`127.0.0.1:5102`) polls only PostgreSQL Outbox rows and
  publishes confirmed mandatory RabbitMQ messages. It intentionally receives
  no Telegram token, webhook secret, proxy setting, or Identity token.

`SupportPrismaService` is provided only by the global `SupportPrismaModule`.
Each process uses the dedicated Support PostgreSQL 18 database and runtime
role. Migration and backup credentials are separate.

## Telegram transport

API and worker fail closed on the canonical values:

```dotenv
TELEGRAM_API_BASE_URL=https://tg.winwidget.ru/telegram-api
TELEGRAM_API_PROXY_IP=185.184.122.62
```

Production Compose pins `tg.winwidget.ru` to that public VPS with
`extra_hosts`, preserving valid TLS/SNI. Direct `api.telegram.org`, an IP URL,
or another host pin is rejected. The Outbox publisher does not access Telegram.

The webhook requires `X-Telegram-Bot-Api-Secret-Token`. Admission stores the
raw bytes, unique Telegram `update_id`, SHA-256 body hash, and the Outbox event
in one transaction before returning success. The worker uses durable
inbox/receipt/outbound-delivery leases and records a terminal outcome.

## RabbitMQ and operator recovery

The worker owns `winwidget.support.telegram-webhook.v1` plus isolated retry and
dead-letter routes. Automatic retries are bounded by the declared delay set;
the PostgreSQL Outbox itself has no irreversible transport-attempt ceiling.
DEV manual retry/close changes the failure, receipt, inbox, and audit Outbox in
one serializable transaction. Invalid poison messages cannot be replayed and
can be closed only after investigation.

## Ownership cutover and cleanup

The Core and Support cutover CLIs bind the source database system identifier,
revision, snapshot SHA-256, semantic fingerprint, mapping count, and source
high-watermark. Routine deployment never activates Support ownership: it
requires Core `ownership=SUPPORT` and target `phase=ACTIVE` with identical
anchors.

Production ownership is moved through the manual `deploy-production` workflow:

1. `deploy_target=support`, `support_action=prepare`, exact confirmation
   `PREPARE SUPPORT OWNERSHIP` prepares PostgreSQL and both revision-pinned
   cutover images without switching routes.
2. The same exact revision with `support_action=cutover`, confirmation
   `CUTOVER SUPPORT OWNERSHIP` stops Gateway/Core, fences Core admission,
   imports the snapshot, activates Support, and runs the steady deployment.

The shared production deploy lock and restore guard are held across each
mutation. An incomplete ownership phase pins the production checkout to its
exact revision; rerunning cutover continues forward from that phase.

The initial migrations are expand/target-only and do not drop Core data. The
separate post-cutover SQL contract is:

`prisma/post-cutover/support/20260824030000_remove_legacy_support_core_source.sql`

It is executable only through
`scripts/cleanup-support-core-source-production.sh` after the Core API is
stopped, all Support roles are healthy, both ownership markers match, reviewed
Support backup and its clean-restore evidence are SHA-256 pinned, and the exact
destructive confirmation is supplied. A backup of the retired monolith is not
a cleanup gate. The script removes the legacy mapping table and Core
`support_thread_id`; it is deliberately outside the normal Prisma migration
tree.

## Local checks

```bash
pnpm --dir apps/support run prisma:validate
pnpm --dir apps/support run typecheck
pnpm --dir apps/support run lint
pnpm --dir apps/support test -- --runInBand
pnpm run test:support:runtime-boundaries
bash scripts/support-cutover-production.sh --self-test
bash scripts/cleanup-support-core-source-production.sh --self-test
```

Production cutover is intentionally not performed by these local checks.
