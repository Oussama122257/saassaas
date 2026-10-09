# Build log — phase by phase

Each phase ends with migrations applied, seed loaded, `pnpm lint`, `pnpm typecheck`, `pnpm test`,
`pnpm test:integration` and `pnpm test:e2e` green (section 20). This file records what each phase
delivered and how its acceptance criteria are covered.

## Phase 1 — Foundation

Scaffold, Prisma schema, tenant isolation (`src/lib/tenant.ts` + tenant-guard extension), status
dictionary and transition table, the single `orderTransitions` service with `OrderEvent` audit log,
orders table / detail, queue chips, quick actions, public API foundations (keys + scopes, envelope,
`X-Request-Id`, idempotency, cursor pagination, per-org rate limit), audit log UI, FR/AR with RTL.

## Phase 2 — Confirmation engine

**Statuses added** (section 7, 19c): `EN_COURS_CONFIRMATION`, `CONFIRMEE_REPORTEE`, `EXPIREE`,
`EN_PREPARATION`, `EXPEDITION_RETARDEE`, `STOPDESK_SANS_REPONSE`, `EXPEDIE_REPORTE`; reason codes
`CANCELLED_BY_CUSTOMER`, `WRONG_INFORMATION`, `NO_LONGER_INTERESTED`, `CUSTOMER_ABSENT`; `FakeReason`.

| Area | Where |
|---|---|
| Org settings (every threshold is configurable) | `src/lib/settings.ts` — defaults ← merchant ← team org |
| 3×3 cadence: slots, blocked windows (hours, prayer, Friday), hard spacing, caps, planning | `src/lib/calls/slots.ts` |
| Claim/lock, lock timeout, confirmed-postponed + re-confirmation, expiry, recycle, source cancel, shipping-delay rules | `src/lib/orders/transitions.ts`, `orderTransitions.ts` |
| Assignment engine (load-balanced round-robin, percentage, cap, top agents, wilaya routing, shifts) | `src/lib/assign/engine.ts`, `rules.ts` |
| Scheduler jobs (assign, 30-min reassign, agent rotation, callbacks/postponed re-queue, lock timeout, INJOIGNABLE, nightly expiry, recycle, number burn) | `src/lib/calls/scheduler.ts`, run every minute by the worker |
| Agent queue (one order at a time, priority tiers) + call screen | `src/lib/calls/agentQueue.ts`, `callScreen.ts`, `/[locale]/queue` |
| Intake validation (polluted / swapped address fields with auto-repair, commune ∈ wilaya, empty address), fake signals, blacklist, repeat badge | `src/lib/intake/validate.ts`, `createOrder()` |
| One ingestion pipeline (idempotency on store + external id, IP limit, SKU resolution, unmatched lines) | `src/lib/ingest/pipeline.ts` |
| Field mapping engine (paths, `[key=value]`, alternatives, literals, sheet columns) + preview screen | `src/lib/ingest/fieldMapping.ts`, `/settings/stores/[id]` |
| Shopify: custom-app OAuth, HMAC webhooks, idempotent ingest, 7-day backfill, status tag / cancel / fulfill / mark-paid write-back, privacy webhooks | `src/lib/adapters/stores/shopify.ts`, `/api/webhooks/shopify`, `/api/integrations/shopify/*` |
| DZBuild: key test (`whoami`), signed webhooks (`X-DZ-Signature`, 5-min window), `since=` safety polling, idempotent write-back | `src/lib/adapters/stores/dzbuild.ts`, `/api/webhooks/dzbuild/[storeId]` |
| Google Sheets polling (public CSV export), generic "webhook + field mapping" store adapter, landing-form intake with IP limit | `googleSheets.ts`, `/api/webhooks/store/[storeId]`, `/api/intake/[storeId]` |
| Public API `POST /v1/orders` | `src/app/api/v1/orders/route.ts`, schema in `src/lib/api/schemas.ts` |
| Comments with tags + Darija quick comments, upsell / cross-sell in the checklist, manual order form, CSV import, CSV + Excel export | `comments-panel.tsx`, `call-screen.tsx`, `/orders/new`, `/orders/import`, `/api/orders/export?format=xls` |
| Team: live stats per agent, availability toggle (offline releases orders), shifts editor; operations settings | `/team`, `/settings/operations` |

**Acceptance (section 20, phase 2)** — `tests/integration/phase2.test.ts`:
attempt 1 minute after the previous one rejected · FAUSSE_COMMANDE / EXPIREE need enough spaced
attempts unless the fake reason is clear · lock released after the timeout · midnight job expires
the right orders and recycle hands them to a different agent once · size text in the wilaya field →
`A_VERIFIER` + `ADDRESS_MAPPING` · Shopify order arrives as `NOUVEAU`, replayed webhook does not
duplicate, tampered HMAC rejected · 9 unanswered attempts reach `INJOIGNABLE` only via the scheduler ·
attempts outside slots rejected · order untouched 30 min reassigned · confirmation impossible
without the checklist. Plus: landing-form IP limit (429, localized), unmatched SKU mapped once and
auto-applied, confirmed-postponed re-queue + re-confirmation, `POST /v1/orders` idempotency.

**Owner inputs still needed:** DZBuild order JSON field names (defaults are editable per store,
`TODO(owner)` in `dzbuild.ts`); Shopify `webhookSubscriptionCreate` argument name and `orderCancel`
/ `orderMarkAsPaid` on the pinned API version (`TODO(owner)` comments with doc links).

**Not in this phase:** call proof is entered manually from the call screen (`proof = NONE`,
flagged `MANUAL_PROOF`); the telephony adapter and Android call-log sync arrive in phase 3.
