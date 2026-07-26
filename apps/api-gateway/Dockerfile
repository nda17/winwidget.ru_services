FROM node:20-alpine AS build

WORKDIR /app
ENV PNPM_VERSION=9.15.9
RUN corepack enable \
	&& corepack prepare pnpm@${PNPM_VERSION} --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build

FROM node:20-alpine AS runtime

ARG APP_REVISION=unknown
ENV NODE_ENV=production
ENV APP_REVISION=${APP_REVISION}
WORKDIR /app

COPY --from=build /app/dist/src ./dist/src

LABEL org.opencontainers.image.revision="${APP_REVISION}"

USER node
EXPOSE 4100

CMD ["node", "dist/src/main.js"]
