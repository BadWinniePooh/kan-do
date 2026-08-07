# Kan-Do API server + worker image (same image, different command)
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY server/package.json server/
RUN pnpm install --frozen-lockfile --filter @kan-do/server --filter @kan-do/shared
COPY packages/shared packages/shared
COPY server server
RUN pnpm --filter @kan-do/server build

FROM node:22-alpine
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=build /app/packages/shared packages/shared
COPY --from=build /app/server/package.json server/
RUN pnpm install --frozen-lockfile --prod --filter @kan-do/server --filter @kan-do/shared
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/migrations server/migrations
WORKDIR /app/server
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3001/healthz || exit 1
# API by default; worker containers override with: node dist/worker.js
CMD ["sh", "-c", "npx node-pg-migrate up -m migrations && node dist/index.js"]
