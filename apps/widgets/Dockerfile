# syntax=docker/dockerfile:1

FROM node:20-alpine AS base

WORKDIR /app

ENV HUSKY=0
ENV PNPM_VERSION=9.15.9

RUN apk add --no-cache openssl \
	&& corepack enable \
	&& corepack prepare pnpm@${PNPM_VERSION} --activate

FROM base AS deps

COPY apps/widgets/package.json apps/widgets/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS builder

COPY --from=deps /app/node_modules ./node_modules
COPY apps/widgets/package.json apps/widgets/tsconfig.json apps/widgets/tsconfig.build.json apps/widgets/nest-cli.json ./
COPY apps/widgets/prisma ./prisma
COPY apps/widgets/src ./src
COPY public/widgets ./public/widgets

RUN pnpm run prisma:generate \
	&& pnpm run build \
	&& pnpm prune --prod --ignore-scripts \
	&& pnpm run prisma:generate

FROM base AS runtime

ARG APP_REVISION=unknown

ENV NODE_ENV=production
ENV MODE=production
ENV APP_REVISION=${APP_REVISION}

LABEL org.opencontainers.image.revision=${APP_REVISION}

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/prisma ./prisma
COPY --from=builder --chown=node:node /app/public/widgets ./public/widgets
COPY --from=builder --chown=node:node /app/package.json ./package.json

USER node

EXPOSE 4700

CMD ["node", "dist/src/main.js"]
