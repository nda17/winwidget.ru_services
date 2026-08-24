FROM node:20-bookworm-slim AS build

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates openssl \
	&& rm -rf /var/lib/apt/lists/* \
	&& corepack enable

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY prisma ./prisma
RUN pnpm prisma:generate
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:20-bookworm-slim AS runtime

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates openssl \
	&& rm -rf /var/lib/apt/lists/* \
	&& groupadd --gid 1001 nodejs \
	&& useradd --uid 1001 --gid nodejs --create-home operations

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=operations:nodejs /app/dist ./dist
COPY --from=build --chown=operations:nodejs /app/node_modules ./node_modules
COPY --from=build --chown=operations:nodejs /app/package.json ./package.json
COPY --from=build --chown=operations:nodejs /app/prisma ./prisma
USER operations
EXPOSE 5200 5201 5202
CMD ["node", "dist/src/main.js"]
