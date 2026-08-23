# Telegram bridge

This directory is the versioned source for the foreign VPS that serves both
WinWidget Telegram directions:

```text
Telegram -> tg.winwidget.ru -> https://api.winwidget.ru
Backend -> api.telegram.org:8443 -> fixed TLS relay -> api.telegram.org:443
```

`nginx.conf` is installed as
`/etc/nginx/sites-available/tg.winwidget.ru`. It exposes only the exact Auth,
Info, Support and webhook-health routes. `telegram-api-stream.conf` is installed
as `/etc/nginx/modules-enabled/99-winwidget-telegram-api-stream.conf` and requires
the Debian `libnginx-mod-stream` package.

The stream listener is public by product decision. It is not a generic proxy:
the upstream is fixed to Telegram, TLS remains end-to-end, safe connection logs
contain no payload or token, and each source IP is limited to 32 connections.

## Release boundary

Before changing backend env or containers:

1. Install the exact reviewed stream file atomically with owner `root:root` and
   mode `0644`.
2. Run `nginx -t`, reload nginx, and allow public `8443/tcp` in UFW.
3. Verify the listener and run a no-token TLS smoke while preserving Telegram
   SNI and certificate validation:

   ```bash
   curl --noproxy '*' --resolve api.telegram.org:8443:BRIDGE_IP \
     --connect-timeout 5 --max-time 15 \
     --output /dev/null --write-out '%{http_code}\n' \
     https://api.telegram.org:8443/
   ```

An HTTP 2xx, 3xx or 4xx response proves the TCP/TLS path; timeout or TLS failure
must stop the release.

The backend production env must define the exact endpoint and bridge IP. Compose
pins `api.telegram.org` through `extra_hosts` only for `api`, `identity-api`,
`maintenance-worker` and `notification-delivery-worker`. The first switch is a
forward-only full deployment: never combine old images, which use port 443, with
the new host pin. Service-only targets and raw Compose recreation are forbidden
for the initial transition.

After deployment, verify the four runtime env/host-pin boundaries, repeat the
TLS smoke, then test one current backup document, the current daily summary and
the Support_bot operator-chat flow. Stale DLQ items must not be mass-retried.

## Observability and rollback

Monitor `/var/log/nginx/telegram-api-stream.access.log` and
`/var/log/nginx/telegram-api-stream.error.log` without logging payloads, URLs or
tokens. nginx resolves the fixed hostname during load; recurring upstream
connection errors require `nginx -t`, reload, and another TLS smoke.

For outbound rollback, keep the relay available while atomically restoring one
approved previous backend env, Compose and image set through the locked full
deployment. First verify all four runtimes work directly on Telegram port 443
and no longer have the host pin. Only then remove the stream config, validate and
reload nginx, and delete the public UFW `8443/tcp` rule. The inbound webhook
bridge can remain active independently.
