# winwidget.ru_server

Backend_winwidget.ru

## База данных

```bash
npx prisma migrate deploy
npx prisma generate
```

## Runtime-скрипты виджетов

Браузерные скрипты, которые отдаются клиентским сайтам по адресам
`/widgets/wheel.js`, `/widgets/quiz.js`, `/widgets/callback.js` и
`/widgets/timer.js`, собираются из исходников в `widgets-src`.

Правило разработки:

- редактировать читаемые файлы в `widgets-src`;
- не править руками минифицированные файлы в `public/widgets`;
- после правок запускать сборку виджетов;
- коммитить и `widgets-src`, и обновлённые `public/widgets`.

```bash
pnpm run build:widgets
```

Команда минифицирует runtime-файлы через `esbuild`, копирует готовые
assets и запускает синтаксическую проверку generated JS через
`node --check`.

Отдельно можно запустить только проверку:

```bash
pnpm run build:widgets:check
```

Полная production-сборка backend тоже включает этот шаг:

```bash
pnpm build
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
