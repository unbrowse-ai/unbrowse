FROM node:20-alpine AS build
WORKDIR /app

RUN corepack enable

# Compile-time env for Vite (optional). Prefer passing via `--build-arg`.
ARG VITE_API_BASE
ENV VITE_API_BASE=${VITE_API_BASE}

# Install deps with lockfile for reproducible CI builds + better caching.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

FROM nginx:1.27-alpine
WORKDIR /usr/share/nginx/html

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist ./

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
