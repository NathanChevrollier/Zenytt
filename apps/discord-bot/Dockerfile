FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS build

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/discord-bot/package.json apps/discord-bot/package.json
RUN pnpm install --frozen-lockfile --filter zenytt-discord-bot...

COPY apps/discord-bot apps/discord-bot
RUN pnpm --filter zenytt-discord-bot build

FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS production

WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/discord-bot/package.json apps/discord-bot/package.json
RUN pnpm install --prod --frozen-lockfile --filter zenytt-discord-bot...
COPY --from=build /app/apps/discord-bot/dist apps/discord-bot/dist

RUN addgroup -S zenytt && adduser -S zenytt -G zenytt
USER zenytt

CMD ["node", "apps/discord-bot/dist/index.js"]
