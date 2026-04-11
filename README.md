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
