FROM node:20.20.2-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS base

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
LABEL org.opencontainers.image.title="winwidget-crm-access" \
	org.opencontainers.image.revision="$APP_REVISION"

ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system --gid 1001 crmaccess \
	&& useradd --system --uid 1001 --gid crmaccess --home-dir /app crmaccess

COPY --from=build --chown=crmaccess:crmaccess /app/dist ./dist
COPY --from=build --chown=crmaccess:crmaccess /app/node_modules ./node_modules
COPY --from=build --chown=crmaccess:crmaccess /app/package.json ./package.json
COPY --from=build --chown=crmaccess:crmaccess /app/prisma ./prisma

USER crmaccess
EXPOSE 5300
CMD ["node", "dist/src/main.js"]
