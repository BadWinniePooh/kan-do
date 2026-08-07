# Kan-Do web frontend: static build served by nginx, /api + /socket.io proxied
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile --filter @kan-do/web --filter @kan-do/shared
COPY packages/shared packages/shared
COPY web web
RUN pnpm --filter @kan-do/web exec vite build

FROM nginx:1.27-alpine
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=5s --retries=5 CMD wget -qO- http://127.0.0.1/ || exit 1
