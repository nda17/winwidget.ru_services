FROM node:20.20.2-alpine3.23@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS build

WORKDIR /app
ENV PNPM_VERSION=9.15.9
RUN corepack enable \
	&& corepack prepare pnpm@${PNPM_VERSION} --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build

FROM node:20.20.2-alpine3.23@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS runtime

ARG APP_REVISION=unknown
ENV NODE_ENV=production
ENV APP_REVISION=${APP_REVISION}
WORKDIR /app

COPY --from=build /app/dist/src ./dist/src

LABEL org.opencontainers.image.revision="${APP_REVISION}"

USER node
EXPOSE 4100

CMD ["node", "dist/src/main.js"]
