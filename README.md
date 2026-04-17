Черновик документации

Внешний URL (Webhook)

Сервер делает POST на указанный URL после каждого лида
Данные: name, lead, phone, email, bonus, url, time
Telegram

Используется бот с токеном из TELEGRAM_BOT_TOKEN в .env сервера
Пользователь вводит свой Chat ID (узнать через @getmyid_bot)
Красивое HTML-сообщение с иконками и всеми данными лида
Яндекс Метрика

Пользователь вводит ID счётчика
При открытии виджета → ym(id, 'reachGoal', 'ip3_open')
При отправке заявки → ym(id, 'reachGoal', 'ip3_send')
VK Ретаргетинг

Пользователь вводит ID пикселя (формат VK-RTRG-...)
При открытии → VK.Goal('ip3*open')
При отправке → VK.Goal('ip3_send')
Не забудь добавить TELEGRAM_BOT_TOKEN=ваш*токен в .env на сервере и создать бота через @BotFather.

как протестировать
Тестирование интеграций

1. Внешний URL (Webhook)
   Используй webhook.site — бесплатный сервис для перехвата запросов:

Открой webhook.site → скопируй уникальный URL
Вставь его в поле «Внешний URL» в настройках виджета → сохрани
Заполни и отправь форму виджета
На сайте webhook.site увидишь POST-запрос с данными лида в реальном времени 2. Telegram
Добавь токен в .env сервера:

TELEGRAM*BOT_TOKEN=токен*от_botfather
Напиши боту /start в Telegram
Узнай свой Chat ID через @getmyid_bot
Вставь ID в поле настроек виджета → сохрани
Отправь тестовую заявку → должно прийти сообщение
Можно протестировать токен и chat_id напрямую через curl:

curl -X POST "https://api.telegram.org/botТВОЙ_ТОКЕН/sendMessage" \
 -H "Content-Type: application/json" \
 -d '{"chat_id":"ТВОЙ_ID","text":"тест"}' 3. Яндекс Метрика
Открой виджет на странице с установленным счётчиком
В Яндекс Метрике → Отчёты → Конверсии — там должны появиться цели ip3_open и ip3_send
Или в консоли браузера проверь что функция доступна:

typeof ym // должно быть "function" 4. VK Пиксель
В консоли браузера на странице с пикселем:

typeof VK !== 'undefined' && typeof VK.Goal === 'function' // должно быть true
Быстрый тест сервера локально
Если сервер запущен локально — можно вызвать API напрямую:

curl -X POST "http://localhost:4200/api/widget/ПУБЛИЧНЫЙ_КЛЮЧ/lead" \
 -H "Content-Type: application/json" \
 -d '{"phone":"+79001234567","name":"Тест","bonus":"Скидка 10%"}'

# winwidget.ru_server

Backend_winwidget.ru

## База данных

```bash
npx prisma migrate deploy
npx prisma generate
```

### Если `prisma migrate dev` падает с `P3014`

На удалённой PostgreSQL базе без права `CREATE DATABASE` команда
`prisma migrate dev` не сработает, потому что Prisma пытается создать
`shadow database`.

Типичная ошибка:

```bash
Error: P3014
Prisma Migrate could not create the shadow database
ERROR: permission denied to create database
```

В таком случае:

1. Для быстрого применения схемы на сервере использовать:

```bash
npx prisma db push
npx prisma generate
```

2. Для нормального production-flow использовать миграции так:

- локально, где есть права на `migrate dev`, создать migration;
- закоммитить папку `prisma/migrations`;
- на сервере запускать:

```bash
npx prisma migrate deploy
npx prisma generate
```

`db push` подходит как workaround для dev/staging, но не заменяет
историю миграций в git.

## reCAPTCHA v3

```env
RECAPTCHA_SECRET_KEY=your_recaptcha_v3_secret
RECAPTCHA_ENABLED=true
RECAPTCHA_MIN_SCORE=0.5
```

Фронтенд должен передавать `v3` token в заголовке `recaptcha`.

Допустимые `action`:

- `login`
- `register`
- `restore-password`
