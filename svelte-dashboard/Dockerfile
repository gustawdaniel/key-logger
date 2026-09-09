# syntax=docker/dockerfile:1
# Multi-stage build — SvelteKit z adapter-node dla ClickHouse (bez SQLite)

FROM node:22-alpine AS base

# ===== deps =====
FROM base AS deps
WORKDIR /app
COPY package.json ./
# Wyklucz sqlite3 przy instalacji zależności w kontenerze (niepotrzebny w trybie ClickHouse)
RUN npm install --include=dev --ignore-scripts

# ===== builder =====
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Przepisz pliki API tak, by w obrazie produkcyjnym nie importowały natywnego modułu sqlite3
RUN sed -i "s|import sqlite3 from 'sqlite3';||g" src/routes/api/*/+server.js


# Zainstaluj adapter-node i podmień adapter-auto w vite.config.js
RUN npm install --save-dev @sveltejs/adapter-node && \
    sed -i "s|import adapter from '@sveltejs/adapter-auto'|import adapter from '@sveltejs/adapter-node'|g" vite.config.js

ENV NODE_ENV=production
RUN npm run build

# ===== runner =====
FROM node:22-alpine AS runner
WORKDIR /app

# Skopiuj zbudowaną aplikację i node_modules
COPY --from=builder /app/build ./build
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules

# Konfiguracja
ENV KEYLOGGER_BACKEND=clickhouse
ENV CLICKHOUSE_URL=http://signoz-telemetrystore-clickhouse-0-0:8123
ENV CLICKHOUSE_DB=signoz_logs
ENV PORT=3002
ENV HOST=0.0.0.0

EXPOSE 3002

CMD ["node", "build"]
