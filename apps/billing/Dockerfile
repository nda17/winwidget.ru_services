FROM node:20-bookworm-slim AS base

RUN apt-get update \
	&& apt-get install --yes --no-install-recommends ca-certificates openssl \
	&& rm -rf /var/lib/apt/lists/*

FROM base AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm prisma:generate \
	&& pnpm build \
	&& pnpm prune --prod

FROM base AS runtime

ARG APP_REVISION=unknown
LABEL org.opencontainers.image.title="winwidget-billing" \
	org.opencontainers.image.revision="$APP_REVISION"

ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system --gid 1001 billing \
	&& useradd --system --uid 1001 --gid billing --home-dir /app billing

COPY --from=build --chown=billing:billing /app/dist ./dist
COPY --from=build --chown=billing:billing /app/node_modules ./node_modules
COPY --from=build --chown=billing:billing /app/package.json ./package.json
COPY --from=build --chown=billing:billing /app/prisma ./prisma

USER billing
EXPOSE 4800 4801 4802 4803
CMD ["node", "dist/src/main.js"]
