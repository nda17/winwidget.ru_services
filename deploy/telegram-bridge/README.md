# Telegram bridge

This directory is the versioned source for the foreign VPS that serves both
WinWidget Telegram directions:

```text
Telegram -> tg.winwidget.ru -> https://api.winwidget.ru
Backend -> https://tg.winwidget.ru/telegram-api -> https://api.telegram.org
```

`nginx.conf` is installed as
`/etc/nginx/sites-available/tg.winwidget.ru`. It exposes only the exact Auth,
Info, Support and webhook-health routes plus a method allowlisted Telegram Bot
API reverse proxy. Backend Compose pins `tg.winwidget.ru` to the reviewed bridge
IP for `api`, `identity-api`, `maintenance-worker` and
`notification-delivery-worker`.

The reverse proxy terminates TLS on `tg.winwidget.ru`, then establishes a
separately verified TLS connection to `api.telegram.org`. This is required when
the backend network filters the visible Telegram SNI even for a foreign raw TLS
relay. The Telegram token remains part of Telegram's request path, so access and
error logging are disabled for `/telegram-api/*`, and request bodies
are never logged. Only methods used by WinWidget are allowed: `getMe`,
`getWebhookInfo`, `deleteWebhook`, `setWebhook`, `sendMessage`, `sendDocument`,
`getFile`, `copyMessage` and `answerCallbackQuery`. Download is separately
limited to GET requests for Telegram's generated
`documents/file_<number>[.<ext>]` paths, which allows a reviewed backup receipt
to be clean-restored without opening a general file proxy. Each source IP is
limited to 32 simultaneous Bot API connections.

`telegram-api-stream.conf` remains installed as
`/etc/nginx/modules-enabled/99-winwidget-telegram-api-stream.conf` because public
port `8443` is retained by product decision. It is an optional fixed-upstream
raw TLS relay for networks without Telegram SNI filtering; production WinWidget
runtimes do not use it. Its dynamic resolver is IPv4-only because the bridge
accepts public IPv6 connections but has no working outbound IPv6 route.

## Release boundary

Before changing backend env or containers:

1. Install the exact reviewed `nginx.conf` atomically with owner `root:root` and
   mode `0644`.
2. Run `nginx -t` and reload nginx. Keep public `443/tcp` and `8443/tcp`
   available in UFW.
3. Verify both TLS legs without a bot token by pinning the public bridge IP:

   ```bash
   curl --noproxy '*' --resolve tg.winwidget.ru:443:BRIDGE_IP \
     --connect-timeout 5 --max-time 15 \
     --output /dev/null --write-out '%{http_code}\n' \
     https://tg.winwidget.ru/telegram-api-health
   ```

The response must be 2xx, 3xx or 4xx and contain the exact
`X-WinWidget-Telegram-Proxy: active` marker. Together these prove that the new
bridge configuration handled the request, backend-to-bridge TLS validated the
pinned certificate name, and bridge-to-Telegram TLS returned a response.
Missing marker, timeout, TLS failure or 5xx must stop the release.

The backend production env must define the exact base URL
`https://tg.winwidget.ru/telegram-api` and the bridge IP. The first switch is a
forward-only full deployment: never combine old images with the new host pin.
Service-only targets and raw Compose recreation are forbidden for the initial
transition.

After deployment, verify the four runtime env/host-pin boundaries, repeat the
health smoke, then test one current backup document, the current daily summary
and the Support_bot operator-chat flow. Stale DLQ items must not be mass-retried.

## Observability and rollback

The outbound reverse-proxy path intentionally has no access log because the bot
token is present in the URL. Do not enable request-line logging for this
location, including Nginx error logging. Plain HTTP requests to this path are
rejected without redirecting or logging the token. Monitor only aggregate
application delivery outcomes and the token-free `/telegram-api-health` probe.
Stream listener connection logs remain available at
`/var/log/nginx/telegram-api-stream.access.log` and
`/var/log/nginx/telegram-api-stream.error.log` without URLs, payloads or tokens.

For outbound rollback, keep the bridge available while atomically restoring one
approved previous backend env, Compose and image set through the locked full
deployment. First verify all four runtimes use the approved previous endpoint
and no longer have the `tg.winwidget.ru` host pin. The inbound webhook bridge
and optional public `8443` listener can remain active independently.
