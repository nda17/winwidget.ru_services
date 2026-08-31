FROM node:20.20.2-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS build

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates openssl \
	&& rm -rf /var/lib/apt/lists/* \
	&& corepack enable

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY prisma ./prisma
COPY restore-manifests ./restore-manifests
RUN pnpm prisma:generate
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:20.20.2-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS runtime

ARG APP_REVISION=unknown
LABEL org.opencontainers.image.title="winwidget-operations" \
	org.opencontainers.image.revision="$APP_REVISION"

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl openssl \
	&& install -d -m 0755 /usr/share/postgresql-common/pgdg \
	&& curl --fail --show-error --silent \
		--output /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
		https://www.postgresql.org/media/keys/ACCC4CF8.asc \
	&& printf '%s\n' \
		'deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main' \
		> /etc/apt/sources.list.d/pgdg.list \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends diffutils gosu postgresql-client-18 \
	&& pg_dump --version | grep -E '^pg_dump \(PostgreSQL\) 18\.' \
	&& pg_restore --version | grep -E '^pg_restore \(PostgreSQL\) 18\.' \
	&& gosu nobody true \
	&& apt-get purge -y --auto-remove curl \
	&& rm -rf /var/lib/apt/lists/* \
	&& groupadd --gid 1001 nodejs \
	&& useradd --uid 1001 --gid nodejs --create-home operations

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=operations:nodejs /app/dist ./dist
COPY --from=build --chown=operations:nodejs /app/node_modules ./node_modules
COPY --from=build --chown=operations:nodejs /app/package.json ./package.json
COPY --from=build --chown=operations:nodejs /app/prisma ./prisma
COPY --from=build --chown=operations:nodejs /app/restore-manifests ./restore-manifests
COPY --chown=root:root --chmod=0755 docker-entrypoint.sh /usr/local/bin/operations-entrypoint.sh
USER operations
EXPOSE 5200 5201 5202 5203
ENTRYPOINT ["/usr/local/bin/operations-entrypoint.sh"]
CMD ["node", "dist/src/main.js"]
