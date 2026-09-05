# API Gateway и авторизация

Канонический документ описывает apps-only steady-state. Tracked production Compose находится
в [`deploy/docker-compose.prod.yml`](../deploy/docker-compose.prod.yml), а
пример route manifest — в [`.env.example`](../.env.example). Production env
хранится вне Git. Репозиторий
[`winwidget.ru_infra`](https://github.com/nda17/winwidget.ru_infra) содержит
deploy controller и Nginx-конфигурации, которые проверяют этот manifest;
реализация Gateway и Identity находится в текущем репозитории.

## Production-топология

```text
Internet
  -> system Nginx :443
  -> API Gateway :4100
  -> Identity / Billing / Campaigns / Reporting / Widgets
  -> Platform / Support / Operations / Notification Delivery
```

Публичными остаются только `80/443`. Gateway, доменные HTTP API, PostgreSQL,
RabbitMQ и RabbitMQ Management не публикуются напрямую в интернет.

Публичный API работает под `/api/v1`. Статические runtime-файлы Widgets
доступны по `/widgets/*` и направляются непосредственно в Widgets. Неизвестный
API route не имеет fallback и должен завершаться `404`.

## Ответственность Gateway

Gateway:

- принимает трафик только от доверенного system Nginx;
- удаляет клиентские identity/proxy/request-ID заголовки и формирует
  доверенные заново;
- выбирает upstream по точному route manifest и границе path segment;
- проверяет Bearer access token для `required` routes;
- отклоняет любой переданный невалидный Bearer, включая optional route;
- применяет route-specific timeout и возвращает безопасные CORS-заголовки в
  собственных ошибках;
- публикует только технические liveness/readiness/deployment endpoints.

Gateway не проверяет владение объектом, тариф, роль конкретного действия или
другие бизнес-правила. Каждый upstream выполняет собственную authorization и,
когда нужна немедленная актуальность сессии, fail-closed introspection в
Identity. Заголовки Gateway не заменяют эту проверку.

## Route manifest

`GATEWAY_ROUTES_JSON` обязателен. Каждый route содержит точные:

- `id`;
- `pathPrefix`;
- `upstreamUrl`;
- `authPolicy` (`required` или `optional`);
- `timeoutMs`.

ID и prefixes уникальны. Upstream содержит только разрешённый внутренний
HTTP(S) origin без credentials, query и fragment. Конфигурация должна
отклонять неизвестные поля, дубликаты, невалидный timeout и route без owner.

Канонические владельцы route:

| Домен                                                          | Владелец   |
| -------------------------------------------------------------- | ---------- |
| Auth, users, sessions, OAuth, JWKS, Auth/Info Telegram webhook | Identity   |
| Payments, subscriptions, tariffs, affiliate, auto-renewal      | Billing    |
| Campaign management                                            | Campaigns  |
| Reporting, analytics, daily summary                            | Reporting  |
| Widget CRUD, public config/lead/telemetry                      | Widgets    |
| Site content, settings и legal pages                           | Platform   |
| Support Telegram webhook и operator messaging                  | Support    |
| Audit, queues, backup/restore control                          | Operations |

Notification Delivery предоставляет только внутренние delivery contracts и не
получает публичный catch-all.

## Access token

Access token выпускает только Identity и подписывает только `RS256`.

Обязательные header/claims:

- `alg=RS256`, versioned `kid`, `typ=at+jwt`;
- точные `iss` и `aud` окружения;
- `sub`, `sid`, `roles`, `token_use=access`, `jti`;
- `iat`, `nbf`, `exp`.

Verifier разрешает только `RS256`, выбирает public JWK по обязательному `kid` и
проверяет подпись, issuer, audience, type, token use и время. HS256, token без
`kid` и private JWK отклоняются.

JWKS публикуется через Identity:

```text
https://api.winwidget.ru/api/v1/auth/.well-known/jwks.json
```

## Refresh token

Refresh token — не JWT и не Bearer. Это opaque secret в `HttpOnly`, `Secure`
cookie. В Identity PostgreSQL хранится только стойкий hash. Refresh выполняет
атомарную CAS-ротацию; logout и revoke меняют состояние сессии только после
проверки действующего credential.

Gateway передаёт refresh cookie только Identity refresh/logout routes и удаляет
её на остальных upstream.

## Internal credentials

- Каждый service-to-service клиент получает отдельный scoped credential и
  точный service identity.
- Credentials разных scopes должны быть попарно различны и не короче принятого
  security minimum.
- Internal endpoints доступны только из приватной/loopback сети и не входят в
  публичный route manifest.
- Приватный signing key доступен только Identity runtime. Gateway и другие
  сервисы получают только JWKS URL и параметры verifier.
- Секреты не коммитятся, не передаются как Docker build args и не выводятся в
  CI/CD или диагностические логи.

## Ротация Identity keys

Ротация выполняется отдельным reviewed action:

1. добавить новый public JWK, продолжая подписывать прежним key;
2. дождаться распространения JWKS;
3. атомарно переключить active private key;
4. сохранять прежний public key не меньше `access TTL + clock tolerance +
JWKS cache TTL`;
5. проверить новый token и отказ старой подписи после окна;
6. удалить прежний public JWK.

Ручная замена части keyset и fallback к Core Auth запрещены.

## Обязательные проверки изменения маршрутов

- parser и negative contract tests route manifest;
- точный owner каждого изменённого prefix;
- public `401` для required route без Bearer;
- `401` для невалидного Bearer на required и optional routes;
- успешный direct/Gateway/public smoke;
- немедленный revoke через Identity introspection;
- отсутствие catch-all, Core upstream и listener `:4200`;
- совпадение deployment revision с выпущенным SHA.
