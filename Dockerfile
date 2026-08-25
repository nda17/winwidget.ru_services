# syntax=docker/dockerfile:1

FROM node:20-alpine AS base

WORKDIR /app

ENV HUSKY=0
ENV PNPM_VERSION=9.15.9

RUN apk add --no-cache openssl postgresql18-client \
	&& corepack enable \
	&& corepack prepare pnpm@${PNPM_VERSION} --activate

FROM base AS deps

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS builder

COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml tsconfig.json tsconfig.build.json nest-cli.json ./
COPY prisma ./prisma
COPY src ./src
COPY apps/notification-delivery/prisma ./apps/notification-delivery/prisma
COPY apps/campaigns/prisma ./apps/campaigns/prisma
COPY apps/reporting/prisma ./apps/reporting/prisma
COPY apps/widgets/prisma ./apps/widgets/prisma
COPY apps/billing/prisma ./apps/billing/prisma
COPY apps/identity/prisma ./apps/identity/prisma
COPY apps/platform/prisma ./apps/platform/prisma
COPY apps/support/prisma ./apps/support/prisma

RUN pnpm exec prisma generate
RUN pnpm run build:app
RUN pnpm prune --prod --ignore-scripts

FROM base AS runner

ARG APP_REVISION=unknown

ENV NODE_ENV=production
ENV MODE=production
ENV PORT=4200
ENV APP_REVISION=${APP_REVISION}

LABEL org.opencontainers.image.revision=${APP_REVISION}

RUN addgroup -S -g 1001 nodejs \
	&& adduser -S -D -H -u 1001 -G nodejs nestjs

COPY --from=builder --chown=nestjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nestjs:nodejs /app/dist ./dist
COPY --from=builder --chown=nestjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nestjs:nodejs /app/package.json ./package.json
COPY --chown=nestjs:nodejs docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER nestjs

EXPOSE 4200

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/src/main.js"]

FROM runner AS maintenance-runner

ENV MAINTENANCE_HEALTH_PORT=4300

EXPOSE 4300

CMD ["node", "dist/src/maintenance-worker-main.js"]

FROM runner AS database-restore-runner

USER root

RUN apk add --no-cache flock su-exec

COPY --from=builder --chown=nestjs:nodejs /app/apps/notification-delivery/prisma ./apps/notification-delivery/prisma
COPY --from=builder --chown=nestjs:nodejs /app/apps/campaigns/prisma ./apps/campaigns/prisma
COPY --from=builder --chown=nestjs:nodejs /app/apps/reporting/prisma ./apps/reporting/prisma
COPY --from=builder --chown=nestjs:nodejs /app/apps/widgets/prisma ./apps/widgets/prisma
COPY --from=builder --chown=nestjs:nodejs /app/apps/billing/prisma ./apps/billing/prisma
COPY --from=builder --chown=nestjs:nodejs /app/apps/identity/prisma ./apps/identity/prisma
COPY --from=builder --chown=nestjs:nodejs /app/apps/platform/prisma ./apps/platform/prisma
COPY --from=builder --chown=nestjs:nodejs /app/apps/support/prisma ./apps/support/prisma
COPY database-restore-entrypoint.sh /usr/local/bin/database-restore-entrypoint.sh

RUN chmod 755 /usr/local/bin/database-restore-entrypoint.sh

ENTRYPOINT ["database-restore-entrypoint.sh"]
CMD ["node", "dist/src/database-restore-worker-main.js"]

FROM runner AS api-runner
