# syntax=docker/dockerfile:1

FROM node:20.20.2-alpine3.23@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS base

WORKDIR /app

ENV HUSKY=0
ENV PNPM_VERSION=9.15.9

RUN apk add --no-cache openssl \
	&& corepack enable \
	&& corepack prepare pnpm@${PNPM_VERSION} --activate

FROM base AS deps

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS builder

COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml tsconfig.json tsconfig.build.json ./
COPY prisma ./prisma
COPY src ./src

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
COPY --from=builder --chown=node:node /app/package.json ./package.json

USER node

EXPOSE 4500

CMD ["node", "dist/src/main.js"]
