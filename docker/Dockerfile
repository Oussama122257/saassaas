# syntax=docker/dockerfile:1.7
# Two runnable targets from one codebase:
#   --target web     Next.js standalone server (port 3000)
#   --target worker  BullMQ worker (also used for migrations + seed)

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && apk add --no-cache libc6-compat openssl
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml .npmrc ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm prisma generate && pnpm build

# ---------- worker ----------
FROM deps AS worker
COPY . .
RUN pnpm prisma generate
ENV NODE_ENV=production
CMD ["pnpm", "worker"]

# ---------- web ----------
FROM base AS web
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
