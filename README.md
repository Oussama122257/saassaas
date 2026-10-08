# COD Call Center Platform

Multi-tenant SaaS for cash-on-delivery order confirmation, delivery follow-up, stock and fulfillment for e-commerce stores in Algeria. Bilingual (French / Arabic RTL).

**Status: Phase 1 — Foundation** (see `SPEC` section 20). Phases 2–6 add the confirmation engine, messaging, couriers, QA/KPIs and the SaaS/client portal.

## Stack

Next.js 16 (App Router, TypeScript strict) · PostgreSQL + Prisma 6 · Auth.js v5 (credentials + TOTP) · BullMQ + Redis · Tailwind 4 + shadcn/ui · next-intl · TanStack Table · Zod · Vitest · Playwright · pnpm · Docker Compose.

## Quick start (local)

```bash
pnpm install
cp .env.example .env            # set DATABASE_URL, REDIS_URL, AUTH_SECRET, ENCRYPTION_KEY
pnpm db:migrate                 # applies prisma/migrations
pnpm db:seed                    # demo data: 1 agency, 3 merchants, 15 users, 58 wilayas, 200+ orders
pnpm dev                        # web app on http://localhost:3000
pnpm worker:dev                 # BullMQ worker (second process)
```

### Docker Compose

```bash
cp .env.example .env && docker compose up --build
```

Starts `postgres`, `redis`, runs migrations + seed (`migrate`), then `app` (port 3000) and `worker`.

## Demo logins

Password for every account: `password123`

| Account | Role | Organization |
|---|---|---|
| admin@demo.local | Owner + platform admin | Agency HQ |
| supervisor@demo.local | Supervisor | Agency HQ |
| agent1a@demo.local, agent1b@demo.local | Confirmation agents (Pod 1 → Store A) | Agency HQ |
| followup1@demo.local | Follow-up agent (Pod 1) | Agency HQ |
| agent2a@demo.local, agent2b@demo.local, followup2@demo.local | Pod 2 → Store B | Agency HQ |
| warehouse@demo.local | Warehouse | Agency HQ |
| client-a@demo.local / client-b@demo.local | Client viewer (read-only) | Store A / Store B |
| saas-owner@demo.local, saas-agent@demo.local, saas-followup@demo.local | SaaS merchant with its own team | SaaS Client |

### Demo API keys (seeded, local only)

```bash
curl -s http://localhost:3000/api/v1/whoami -H "Authorization: Bearer ck_demo_agency.demo-secret-agency-hq-change-me"
curl -s "http://localhost:3000/api/v1/orders?limit=5&status=CONFIRMEE" -H "Authorization: Bearer ck_demo_agency.demo-secret-agency-hq-change-me"
```

## Scripts

| Script | What |
|---|---|
| `pnpm dev` / `pnpm build` / `pnpm start` | Next.js |
| `pnpm worker` / `pnpm worker:dev` | BullMQ worker |
| `pnpm lint` / `pnpm typecheck` | ESLint / `tsc --noEmit` |
| `pnpm test` | Vitest unit tests |
| `pnpm test:integration` | Vitest integration tests (needs `DATABASE_URL`, resets the DB it points to — use a dedicated test DB) |
| `pnpm test:e2e` | Playwright (needs a built app + seeded DB) |
| `pnpm db:migrate` / `pnpm db:deploy` / `pnpm db:seed` / `pnpm db:studio` | Prisma |

## Architecture notes

- **Tenant isolation** — `src/lib/tenant.ts`: `resolveTenantContext()` gives `{ userId, orgId, role, accessibleMerchantIds }`; every repository function scopes queries with `tenantWhere()` / `orderAccessWhere()`. `src/lib/db.ts` installs a Prisma extension that throws (outside production) on any query against a tenant model without a tenant filter; system jobs opt out with `withSystemContext()`.
- **Order state machine** — `src/lib/orders/transitions.ts` is the transition table (data), `src/lib/orders/orderTransitions.ts` is the only code that changes `Order.status`: role check, Zod payload, declarative preconditions (answered call, attempt count, stock = 0, …), rule-specific writes, immutable `OrderEvent`, side effects enqueued after commit. `INJOIGNABLE` is system-only, even for overrides.
- **Statuses** — `src/lib/orders/statuses.ts`: fixed codes, FR/AR labels, groups; merchants can override labels (`StatusLabelOverride`) but never codes.
- **Public API** — `src/app/api/v1/*` through `src/lib/api/handler.ts`: `Authorization: Bearer <key_id>.<key_secret>` with scopes, `{ data, meta }` envelope, `X-Request-Id` echo, `X-Api-Version`, `Idempotency-Key` on mutations (24 h, replay header, 422 on reuse), cursor pagination, per-org per-minute rate limit (Redis, in-memory fallback).
- **Worker** — `src/worker/index.ts` consumes `events`, `scheduler`, `messaging`, `courier`, `reports`; side effects that need an external system are stubs marked `TODO(phase n)`.
- **Secrets at rest** — `src/lib/crypto.ts` (AES-256-GCM with `ENCRYPTION_KEY`) for store/courier credentials.

## Project layout

```
prisma/            schema, migrations, seed
src/app/[locale]   (auth) login · (app) dashboard, orders, audit, settings
src/app/api/v1     public API · src/app/api/auth Auth.js · src/app/api/orders/export CSV
src/lib            tenant, db, crypto, phone, wilayas, time, audit, orders/*, api/*, auth/*, queue
src/worker         worker entrypoint + jobs
messages/          fr.json, ar.json
tests/             unit, integration, e2e
```
