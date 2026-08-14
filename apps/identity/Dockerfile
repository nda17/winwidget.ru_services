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
LABEL org.opencontainers.image.title="winwidget-identity" \
	org.opencontainers.image.revision="$APP_REVISION"

ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system --gid 1001 identity \
	&& useradd --system --uid 1001 --gid identity --home-dir /app identity

COPY --from=build --chown=identity:identity /app/dist ./dist
COPY --from=build --chown=identity:identity /app/node_modules ./node_modules
COPY --from=build --chown=identity:identity /app/package.json ./package.json
COPY --from=build --chown=identity:identity /app/prisma ./prisma

USER identity
EXPOSE 4900 4901 4902
CMD ["node", "dist/src/main.js"]
