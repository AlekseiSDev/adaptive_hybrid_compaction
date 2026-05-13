# syntax=docker/dockerfile:1.7
# Build + run the AHC demo UI (Next.js 16, output: 'standalone').
# Two stages: build with full devDeps, then ship only the standalone bundle.

# --- Stage 1: deps + build ---
FROM node:22-alpine AS builder
RUN corepack enable && corepack prepare pnpm@10.26.1 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ui ./src/ui
COPY src/core ./src/core
COPY src/adapters ./src/adapters
COPY src/eval ./src/eval

RUN pnpm build:ui

# --- Stage 2: runtime ---
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0

RUN addgroup -g 1001 -S nodejs && adduser -S -u 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/src/ui/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/src/ui/.next/static ./src/ui/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/src/ui/public ./src/ui/public

# Next.js standalone emits a CommonJS server.js, but the monorepo root
# package.json sets "type": "module". Drop a scope-local package.json
# next to server.js so Node treats it as CJS.
RUN echo '{"type":"commonjs"}' > /app/src/ui/package.json \
 && chown nextjs:nodejs /app/src/ui/package.json

USER nextjs
EXPOSE 3000
CMD ["node", "src/ui/server.js"]
