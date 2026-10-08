# COD Call Center Platform — Build Specification

> **For Claude Code.** This file is the full specification for a multi-tenant SaaS that runs cash-on-delivery (COD) order confirmation, delivery follow-up, stock and fulfillment for e-commerce stores in Algeria.
> Read the whole file before writing code. Build **phase by phase** (section 20). Stop at the end of each phase, run the acceptance checks, and summarize what was built before starting the next phase.

---

## 0. Rules for the builder (read first)

1. **Do not invent third-party APIs.** Courier APIs, telephony providers, SMS gateways and payment gateways are behind adapter interfaces (section 12). Ship a working **mock adapter** for each, and leave real adapters as stubs with `TODO` until the owner supplies API documentation and credentials.
2. **Tenant isolation is non-negotiable.** Every query on tenant data goes through a tenant-scoped helper (section 5.3). Write tests proving that one organization can never read another organization's data.
3. **The order state machine is the core.** All status changes go through one service (`orderTransitions.ts`) that checks the transition table, the actor's role and the required fields, and writes an audit log row. No direct `prisma.order.update({ status })` anywhere else.
4. **Rules that protect quality are enforced by the system, not by trust.** Example: an agent can never set `INJOIGNABLE` by hand; only the scheduler can, after 9 logged attempts (section 8).
5. **Bilingual UI from day one.** French and Arabic (RTL). No hard-coded UI strings. Status labels come from the dictionary in section 7.
6. **Prefer boring, well-documented choices.** Ask before adding a dependency that is not listed in section 3.
7. Every phase ends with: migrations applied, seed data loaded, tests passing, `pnpm lint` and `pnpm typecheck` clean.

---

## 1. Product summary

One platform, three ways to use it:

| Mode | Who | What they do |
|---|---|---|
| **Own business** | The owner (platform admin) and his own stores | His confirmation team works his own stores' orders. |
| **Managed service** | Merchants who outsource confirmation + follow-up to the owner's call center | The owner's agents work the merchant's orders. The merchant gets a **client portal**: live orders, reports, invoices, and product/script approval. |
| **SaaS self-serve** | Merchants who have their own agents | They subscribe and run their own team on the platform. |

Core promise of the managed service: **"We don't just confirm your orders, we get them delivered."** The platform measures and bills on **delivered** orders.

Reference products studied: CodPilot (custom statuses, auto-assignment, agent scheduling, courier sync, SendPilot messaging, mobile app) and WecanServices (warehouse management, order execution, shipping, customer confirmation, real-time stock and order tracking).

---

## 2. Glossary

| Term | Meaning |
|---|---|
| **Organization (org)** | A tenant. Either an `AGENCY` (runs a call center) or a `MERCHANT` (owns stores). |
| **Store** | A sales channel of a merchant (Shopify, WooCommerce, YouCan, Google Sheet, manual, API). |
| **Service contract** | A link that lets an agency's agents work a merchant's orders (managed service). |
| **Pod (خلية)** | A team unit: **2 confirmation agents + 1 follow-up agent**. Pods are assigned to one or more merchants. |
| **Confirmation agent (عون التأكيد)** | Owns an order from `ASSIGNEE` until `CONFIRMEE` or an exit status. |
| **Follow-up agent (عون المتابعة)** | Owns confirmed orders of their pod until delivered or returned. Audits the quality of their 2 confirmation agents. |
| **Supervisor (المشرف)** | Manages all pods, KPIs, escalations, couriers, blacklist and rewards. |
| **Attempt** | One call to the customer. Max 9 attempts: 3 per day × 3 days. |
| **Rescue (إنقاذ)** | Same-day intervention when a courier reports a problem (client not answering the delivery man, alert, refusal). |
| **Finished parcel** | A parcel whose final outcome is known (delivered or returned). Delivery rate uses finished parcels only. |

---

## 3. Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js (App Router) + TypeScript, strict mode |
| Database | PostgreSQL |
| ORM | Prisma |
| Auth | Auth.js (credentials + optional Google), session cookies, 2FA (TOTP) for admin/supervisor roles |
| Jobs / scheduler | BullMQ + Redis (call scheduler, courier sync, messaging, reports) |
| UI | Tailwind CSS + shadcn/ui, lucide icons |
| i18n | next-intl, locales `fr` (LTR) and `ar` (RTL) — `dir` set on `<html>` |
| Tables | TanStack Table |
| Charts | Recharts |
| Validation | Zod (shared between server actions, API routes and forms) |
| Realtime | Server-Sent Events for queue and dashboard updates (no websockets needed in v1) |
| Files | S3-compatible storage (call recordings, product images, invoices) |
| Email | Resend or SMTP adapter |
| Testing | Vitest (unit), Playwright (e2e) |
| Package manager | pnpm |
| Deploy target | Docker Compose (app, worker, postgres, redis) — a VPS is the default target |

Run the web app and the worker as **two processes** from the same codebase (`apps/web`, `apps/worker` or `src/worker` with its own entrypoint).

---

## 4. Roles and permissions

### 4.1 Platform level

| Role | Scope |
|---|---|
| `PLATFORM_ADMIN` | The owner. Manages all orgs, plans, billing, feature flags, impersonation (logged). |

### 4.2 Organization level

| Role | Org type | Can |
|---|---|---|
| `ORG_OWNER` | any | Everything in the org, billing, users, integrations |
| `SUPERVISOR` | agency / merchant with own team | Pods, assignment rules, all orders of the org and its contracted merchants, QA, blacklist approval, rewards, reports |
| `FOLLOWUP_AGENT` | agency / merchant | Orders of their pod from `CONFIRMEE` onward, delivery issues, returns, QA notes on their pod's agents, pod daily report |
| `CONFIRMATION_AGENT` | agency / merchant | Only orders assigned to them, confirmation statuses, call logging |
| `WAREHOUSE` | agency / merchant | Packing, labels, stock movements, return reception |
| `CLIENT_VIEWER` | merchant (managed service) | Read-only client portal: orders, reports, invoices; approve product sheets and scripts |
| `MARKETER` | merchant | Campaign attribution, product/campaign KPIs (read-only on orders) |

### 4.3 Hard rules

- A confirmation agent sees **only** orders assigned to them, plus customer history (previous orders and refusals) for the phone number on that order.
- A follow-up agent sees orders confirmed by the 2 agents of their pod.
- `CLIENT_VIEWER` never sees agent personal data beyond first name, and never sees other merchants.
- Only `SUPERVISOR`+ can: confirm `FAUSSE_COMMANDE` as final, add to blacklist, change assignment rules, edit scripts, issue warnings, override a status outside the transition table (override requires a reason and is flagged in the audit log).

---

## 5. Multi-tenancy

### 5.1 Model

```
Platform
 ├── Organization (AGENCY)  ── owns ── Users (agents, supervisors), Pods, PhoneNumbers
 │        └── ServiceContract ──► Organization (MERCHANT)
 └── Organization (MERCHANT) ── owns ── Stores, Products, Orders, Customers, Warehouse, Couriers config
```

- The owner's own stores = a `MERCHANT` org with a `ServiceContract` to his `AGENCY` org.
- A SaaS client with their own team = a `MERCHANT` org whose users include agents and supervisors (no contract needed).
- A managed client = a `MERCHANT` org with `CLIENT_VIEWER` users + a `ServiceContract` to the agency.

### 5.2 Access resolution

A user can act on an order if either:
1. The user belongs to the order's merchant org with a sufficient role, **or**
2. The user belongs to an agency org that has an **active** `ServiceContract` with that merchant, and (for agents) the order is assigned to them or to their pod.

### 5.3 Implementation

- `getTenantContext(session)` returns `{ userId, orgId, role, accessibleMerchantIds[] }`.
- All repository functions take this context and add `where: { merchantId: { in: accessibleMerchantIds } }`.
- Add a Prisma client extension that throws if a query on a tenant model has no tenant filter (dev/test only).
- Optional hardening later: Postgres Row-Level Security.

---

## 6. Data model (Prisma draft)

> Starting point, not final. Keep names; add fields as needed. All tables have `createdAt`, `updatedAt`. Money in DZD as integers (dinars, no decimals).

```prisma
enum OrgType { AGENCY MERCHANT }
enum Role { PLATFORM_ADMIN ORG_OWNER SUPERVISOR FOLLOWUP_AGENT CONFIRMATION_AGENT WAREHOUSE CLIENT_VIEWER MARKETER }

model Organization {
  id            String   @id @default(cuid())
  type          OrgType
  name          String
  locale        String   @default("ar")
  timezone      String   @default("Africa/Algiers")
  planId        String?
  memberships   Membership[]
  stores        Store[]
  products      Product[]
  orders        Order[]   @relation("MerchantOrders")
  pods          Pod[]
  contractsAsAgency   ServiceContract[] @relation("AgencyContracts")
  contractsAsMerchant ServiceContract[] @relation("MerchantContracts")
}

model User {
  id           String @id @default(cuid())
  email        String @unique
  phone        String?
  name         String
  passwordHash String?
  totpSecret   String?
  locale       String @default("ar")
  memberships  Membership[]
}

model Membership {
  id      String @id @default(cuid())
  userId  String
  orgId   String
  role    Role
  podId   String?          // agents belong to one pod
  active  Boolean @default(true)
  @@unique([userId, orgId])
}

model ServiceContract {
  id          String @id @default(cuid())
  agencyId    String
  merchantId  String
  package     ServicePackage   // CONFIRMATION | CONFIRMATION_FOLLOWUP | FULL_COD_OPS
  pricingModel PricingModel    // PER_DELIVERED | PER_CONFIRMED | FIXED_PLUS_BONUS | DEDICATED_POD
  unitPrice   Int?             // DZD
  fixedMonthly Int?
  minMonthly  Int?
  status      ContractStatus   // TRIAL | ACTIVE | PAUSED | ENDED
  trialEndsAt DateTime?
  startsAt    DateTime
  endsAt      DateTime?
}

model Pod {
  id        String @id @default(cuid())
  orgId     String               // agency (or merchant with own team)
  name      String               // "Pod 1"
  followUpUserId String?
  members   Membership[]
  merchants PodMerchant[]        // which merchants this pod serves
}

model PodMerchant { podId String  merchantId String  @@id([podId, merchantId]) }

model Store {
  id         String @id @default(cuid())
  merchantId String
  name       String
  channel    Channel          // SHOPIFY | WOOCOMMERCE | YOUCAN | GOOGLE_SHEET | MANUAL | API
  credentials Json?           // encrypted at rest
  webhookSecret String?
  active     Boolean @default(true)
}

model Product {
  id           String @id @default(cuid())
  merchantId   String
  sku          String?
  name         String
  price        Int
  costPrice    Int?
  variants     ProductVariant[]
  sheet        ProductSheet?        // script + FAQ + selling points
  stockItems   StockItem[]
}

model ProductVariant { id String @id @default(cuid())  productId String  name String  sku String?  price Int? }

model ProductSheet {
  id          String @id @default(cuid())
  productId   String @unique
  sellingPoints String[]           // benefits, not features
  sizeGuide   String?
  faq         Json                  // [{q, a, lang}]
  scriptAr    String                // confirmation script (Darija)
  scriptFr    String?
  approvedByMerchantAt DateTime?    // client approval (managed service)
  version     Int @default(1)
}

model Customer {
  id          String @id @default(cuid())
  merchantId  String
  phone       String                // normalized 0XXXXXXXXX
  phone2      String?
  name        String?
  ordersCount Int @default(0)
  deliveredCount Int @default(0)
  refusedCount Int @default(0)
  blacklisted Boolean @default(false)
  @@unique([merchantId, phone])
}

model Blacklist {                    // cross-merchant within an agency, approved by supervisor
  id         String @id @default(cuid())
  orgId      String
  phone      String
  reason     String
  approvedById String
}

model Order {
  id            String @id @default(cuid())
  merchantId    String
  storeId       String
  externalId    String?              // id in Shopify etc.
  customerId    String
  status        OrderStatus
  statusGroup   StatusGroup          // CONFIRMATION | SHIPPING | DELIVERY | RETURN | CLOSED
  wilayaCode    Int                  // 1..58
  commune       String?
  address       String?
  landmark      String?              // نقطة دالة
  deliveryType  DeliveryType         // HOME | STOP_DESK
  items         OrderItem[]
  subtotal      Int
  shippingFee   Int
  total         Int                  // what the customer pays at the door
  source        String?              // utm / campaign / ad id
  assignedToId  String?              // current owner (confirmation or follow-up agent)
  confirmedById String?              // who confirmed — used for delivery-rate per agent
  podId         String?
  attemptCount  Int @default(0)      // 0..9
  attemptDay    Int @default(0)      // 0..3
  nextActionAt  DateTime?            // scheduler pointer (callback, postponed date, next attempt)
  postponedUntil DateTime?
  cancelReason  CancelReason?
  returnReason  ReturnReason?
  courierId     String?
  trackingNumber String?
  shippedAt     DateTime?
  deliveredAt   DateTime?
  returnedAt    DateTime?
  cashCollectedAt DateTime?
  duplicateOfId String?
  flags         String[]             // e.g. HIGH_VALUE, REPEAT_REFUSER, BOT_CONFIRMED
  events        OrderEvent[]
  calls         CallAttempt[]
  @@index([merchantId, status])
  @@index([assignedToId, status])
  @@index([nextActionAt])
}

model OrderItem { id String @id @default(cuid())  orderId String  productId String  variantId String?  qty Int  unitPrice Int }

model OrderEvent {                    // immutable audit log of every change
  id        String @id @default(cuid())
  orderId   String
  actorId   String?                   // null = system
  type      String                    // STATUS_CHANGE | ASSIGN | REASSIGN | NOTE | FIELD_EDIT | OVERRIDE | COURIER_SYNC | MESSAGE_SENT
  fromStatus OrderStatus?
  toStatus   OrderStatus?
  payload   Json
  createdAt DateTime @default(now())
}

model CallAttempt {
  id          String @id @default(cuid())
  orderId     String
  agentId     String
  phoneNumberId String?               // which outbound number (A/B/C)
  attemptNo   Int                     // 1..9
  day         Int                     // 1..3
  slot        CallSlot                // MORNING | AFTERNOON | EVENING
  startedAt   DateTime
  durationSec Int?
  outcome     CallOutcome             // ANSWERED | NO_ANSWER | BUSY | OFF | WRONG_NUMBER | CALLBACK_REQUESTED
  proof       CallProof               // VOIP_LOG | DEVICE_LOG | NONE
  recordingUrl String?
  qaScore     Int?                    // 0..10 (section 14)
}

model OutboundNumber {                // rotating caller numbers
  id        String @id @default(cuid())
  orgId     String
  label     String                    // "A", "B", "C"
  msisdn    String
  active    Boolean @default(true)
  answerRate Float?                   // computed daily
  burnedAt  DateTime?                 // flagged as spam → retired
}

model Courier {
  id          String @id @default(cuid())
  merchantId  String
  provider    String                 // "yalidine", "ecotrack:dhd", "zr", "procolis:abex", "noest", "maystro"
  family      String                 // YALIDINE | ECOTRACK | ZR | PROCOLIS | NOEST | MAYSTRO
  baseHost    String?                // EcoTrack tenants
  credentials Json                   // encrypted
  originWilaya Int?
  autoValidate Boolean @default(false)
  active      Boolean @default(true)
}

model CourierRoute {                  // which courier for which wilaya
  id         String @id @default(cuid())
  merchantId String
  wilayaCode Int?                     // null = default
  deliveryType DeliveryType?
  courierId  String
  fallbackCourierId String?
  priority   Int @default(0)
}

model Commune { id String @id @default(cuid())  wilayaCode Int  nameFr String  nameAr String }
model ProviderCommune { id String @id @default(cuid())  provider String  communeId String  providerRef String  hasDesk Boolean @default(false)  @@unique([provider, communeId]) }
model ProviderDesk { id String @id @default(cuid())  provider String  communeId String  providerRef String  name String  address String?  phone String? }

model CodPayout {                     // courier payment statements
  id String @id @default(cuid())  courierId String  periodStart DateTime  periodEnd DateTime  fileUrl String  totalAmount Int  matchedCount Int  gapCount Int
}

model CourierEvent {                  // raw sync log
  id String @id @default(cuid())  orderId String  provider String  rawStatus String  mappedStatus OrderStatus?  payload Json  receivedAt DateTime @default(now())
}

model Task {                          // rescue / follow-up work items with SLA
  id         String @id @default(cuid())
  orderId    String
  type       TaskType                 // RESCUE_NO_ANSWER | ALERT | WRONG_ADDRESS | STOPDESK_REMINDER | PRE_RETURN_CALL | STUCK_PARCEL | QA_REVIEW
  assigneeId String?
  dueAt      DateTime
  doneAt     DateTime?
  result     String?
}

model MessageLog { id String @id @default(cuid())  orderId String?  channel MsgChannel  template String  to String  status String  sentAt DateTime @default(now()) }

model Warehouse { id String @id @default(cuid())  merchantId String  name String  wilayaCode Int }
model StockItem { id String @id @default(cuid())  warehouseId String  productId String  variantId String?  onHand Int  reserved Int  @@unique([warehouseId, productId, variantId]) }
model StockMovement { id String @id @default(cuid())  stockItemId String  type StockMoveType  qty Int  orderId String?  note String?  actorId String?  createdAt DateTime @default(now()) }

model QaReview {
  id        String @id @default(cuid())
  callId    String
  reviewerId String
  scores    Json                      // per criterion (section 14)
  total     Int
  zeroed    Boolean @default(false)   // lie / hidden fee => 0
  note      String
}

model Warning { id String @id @default(cuid())  userId String  orgId String  level Int  reason String  issuedById String  createdAt DateTime @default(now()) }

model Invoice {
  id          String @id @default(cuid())
  contractId  String
  periodStart DateTime
  periodEnd   DateTime
  lines       Json                    // delivered count × unit price, fixed fee, minimum adjustment
  total       Int
  status      InvoiceStatus           // DRAFT | SENT | PAID | OVERDUE
  pdfUrl      String?
}

model Plan { id String @id @default(cuid())  name String  monthlyPrice Int  maxOrders Int?  maxUsers Int?  maxStores Int?  features String[] }
```

Enums `OrderStatus`, `CancelReason`, `ReturnReason` are defined in section 7.

---

## 7. Order statuses

### 7.1 Status dictionary

The **codes** are fixed. Labels are the UI strings (FR / AR). The confirmation list matches the CodPilot statuses the team already uses.

**Confirmation group**

| Code | FR | AR | Set by |
|---|---|---|---|
| `NOUVEAU` | Nouveau | جديدة | System |
| `ASSIGNEE` | Assignée | معينة | System |
| `APPEL_1` | Appel 1 | مكالمة 1 | Agent (requires call log) |
| `APPEL_2` | Appel 2 | مكالمة 2 | Agent (requires call log) |
| `APPEL_3` | Appel 3 | مكالمة 3 | Agent (requires call log) |
| `REPORTE` | Reporté | مؤجلة | Agent (date + reason required, max 7 days) |
| `A_VERIFIER` | À vérifier | للتحقق | Agent (comment required) |
| `CONFIRMEE` | Confirmée | مؤكدة | Agent (checklist required) |
| `CONFIRMEE_BOT` | Confirmée (Bot) | (Bot) مؤكَّدة | System (WhatsApp button) |
| `CONFIRMEE_RUPTURE` | Confirmée Rupture de stock | مؤكدة بلا مخزون | Agent (only if stock = 0) |
| `ANNULEE` | Annulée | ملغية | Agent (reason required) |
| `DOUBLE` | Double | مكررة | System flag, agent confirms after checking with customer |
| `FAUSSE_COMMANDE` | Fausse Commande | طلبية وهمية | Agent proposes (logged call required), supervisor finalizes |
| `INJOIGNABLE` | Injoignable | لا يمكن الوصول إليه | **System only**, after 9 logged attempts |

`APPEL_1/2/3` = attempt number **within the current day**. The order also stores `attemptCount` (1–9) and `attemptDay` (1–3).

**Shipping group**

| Code | FR | AR |
|---|---|---|
| `PRET_A_EXPEDIER` | Prêt à expédier | جاهزة للشحن |
| `EXPEDIE` | Ramassé / En transit | في الطريق |

**Delivery group (from courier sync)**

| Code | FR | AR |
|---|---|---|
| `ARRIVE_WILAYA` | Arrivé à la wilaya | وصلت إلى الولاية |
| `STOP_DESK` | Au bureau (Stop Desk) | في المكتب |
| `EN_LIVRAISON` | Sorti en livraison | عند الموزع |
| `CLIENT_INJOIGNABLE_LIVREUR` | Client ne répond pas au livreur | الزبون لا يرد على الموزع |
| `REPORTE_CLIENT` | Reporté par le client | مؤجلة من طرف الزبون |
| `ADRESSE_ERRONEE` | Adresse / numéro erroné | عنوان أو رقم خاطئ |
| `TENTATIVE_ECHOUEE` | Tentative échouée | محاولة فاشلة |
| `REFUSE` | Refusé | مرفوضة |
| `ALERTE` | Alerte | تنبيه |
| `LIVRE` | Livré | تم التوصيل |

**Return group**

| Code | FR | AR |
|---|---|---|
| `RETOUR_EN_COURS` | Retour en cours | في طريق الإرجاع |
| `RETOUR_RECU` | Retour reçu | مرتجعة مستلمة |
| `PERDU_ENDOMMAGE` | Perdu / Endommagé | مفقودة / متضررة |

**Closed group**

| Code | FR | AR |
|---|---|---|
| `ENCAISSE` | Encaissé | تم التحصيل |

Merchants (SaaS mode) may **rename labels** and **add custom sub-statuses**, but cannot remove or rename codes, because KPIs and rules depend on them.

### 7.2 Reason codes

```ts
CancelReason = CHANGED_MIND | PRICE_TOO_HIGH | SHIPPING_FEE | BOUGHT_ELSEWHERE | PRODUCT_DOUBT
             | WRONG_PRODUCT_OR_SIZE | DELIVERY_TOO_SLOW | DID_NOT_ORDER | OTHER
ReturnReason = PRICE_SHOCK | NOT_AS_EXPECTED | BOUGHT_ELSEWHERE | CLIENT_UNREACHABLE | WRONG_ADDRESS
             | DELIVERY_DELAY | FAKE_CONFIRMATION | CLIENT_ABSENT | DAMAGED | OTHER
```

`OTHER` always requires a free-text note.

### 7.3 Transition table

Implement as data (`transitions.ts`), not as scattered `if` statements. Each row: `from`, `to`, allowed roles, required fields, side effects.

| From | To | Who | Required | Side effects |
|---|---|---|---|---|
| — | `NOUVEAU` | system | — | duplicate + fake detection, customer upsert |
| `NOUVEAU` | `ASSIGNEE` | system | — | assignment engine (section 9) |
| `NOUVEAU` | `DOUBLE` | system | duplicateOfId | notify agent to verify |
| `ASSIGNEE`, `APPEL_n`, `REPORTE`, `A_VERIFIER` | `APPEL_n` | agent | CallAttempt with proof, slot rules OK | schedule next attempt |
| any confirmation status | `CONFIRMEE` | agent | confirmation checklist, ≥1 ANSWERED call ≥ min duration | send WhatsApp written confirmation, reserve stock, hand off to follow-up agent, set `confirmedById` |
| any confirmation status | `CONFIRMEE_RUPTURE` | agent | stock = 0, ANSWERED call | waiting-stock task, notify supervisor |
| `ASSIGNEE`, `APPEL_n` | `CONFIRMEE_BOT` | system | WhatsApp button reply | if `HIGH_VALUE` or risky wilaya → create verification call task instead of shipping |
| any confirmation status | `ANNULEE` | agent | cancelReason, ANSWERED call | add to QA sample pool |
| any confirmation status | `REPORTE` | agent | postponedUntil (≤ 7 days), reason | `nextActionAt = postponedUntil` |
| any confirmation status | `A_VERIFIER` | agent | comment | task for supervisor, SLA 24 h |
| `DOUBLE` | `ANNULEE` / `ASSIGNEE` | agent | verification note | merge or reopen |
| any confirmation status | `FAUSSE_COMMANDE` | agent proposes, supervisor approves | logged call | optional blacklist request |
| `APPEL_3` on day 3 | `INJOIGNABLE` | **system only** | attemptCount = 9 | final WhatsApp/SMS, close |
| `CONFIRMEE`, `CONFIRMEE_BOT` | `PRET_A_EXPEDIER` | warehouse | items packed | label printed |
| `CONFIRMEE_RUPTURE` | `CONFIRMEE` | system | stock back | notify customer + agent |
| `PRET_A_EXPEDIER` | `EXPEDIE` | system (courier sync) / warehouse | trackingNumber | "your order shipped" message |
| delivery statuses | delivery statuses | system (courier sync) | — | create Task per section 10 |
| any delivery status | `LIVRE` | system | — | stats, bonus credit, "did you receive?" message |
| `REFUSE`, failed after N attempts | `RETOUR_EN_COURS` | system | returnReason | link return to `confirmedById` |
| `RETOUR_EN_COURS` | `RETOUR_RECU` | warehouse | condition check | restock movement |
| `LIVRE` | `ENCAISSE` | supervisor / finance | reconciliation batch | invoice line |
| any | any | supervisor | override reason | `OVERRIDE` event, flagged |

---

## 8. Call engine (3 calls × 3 days)

### 8.1 Cadence

| Day | Attempt 1 | Attempt 2 | Attempt 3 |
|---|---|---|---|
| 1 | within 15 min of order | +2–3 h | evening 18:00–20:00 |
| 2 | morning 10:00–12:00 | afternoon 14:00–16:00 | evening |
| 3 | morning | afternoon | evening → automatic WhatsApp/SMS |
| after 9 failed | → `INJOIGNABLE` (system) | | |

All times are org-configurable. Defaults above.

### 8.2 Rules enforced by the scheduler

- **Slots are locked.** An attempt is only valid inside its slot window. Minimum gap between two attempts: 2 h (configurable).
- **Blocked windows:** before 09:00, after 21:00, prayer times (org-configurable list of daily windows), Friday midday. The dialer button is disabled in these windows.
- **Number rotation:** each attempt uses the next active `OutboundNumber` (A → B → C). Track answer rate per number daily; flag a number as **burned** when its answer rate drops below a threshold for 3 days.
- **Agent rotation:** after 3 failed attempts on day 1 by the same agent, day 2 attempts go to another agent of the pod.
- **Missed-call message:** after the first unanswered attempt, send the template `missed_call_1` (WhatsApp, fallback SMS).
- **Callback requested:** agent sets a specific time; the order returns to the agent's queue at that time; if the agent is off shift, reassign.
- **Proof required:** an attempt without a call record (`proof = NONE`) is rejected unless the org explicitly enables manual mode (and then it is flagged in KPIs).

### 8.3 Call proof (telephony adapter)

Algerian teams usually call from mobile SIMs, so support three proof sources behind one interface:

| Mode | How | Phase |
|---|---|---|
| `DEVICE_LOG` | Android companion app (or PWA + Android helper) that launches the call from the platform and syncs the device call log (number, start, duration) back to `CallAttempt` | 3 |
| `VOIP_LOG` | SIP/VoIP provider adapter with click-to-call, CDR webhook and recording URL | later, provider to be chosen by owner |
| `NONE` | manual entry, flagged | 1 (dev only) |

```ts
interface TelephonyAdapter {
  startCall(params: { agentId: string; to: string; fromNumberId: string; orderId: string }): Promise<{ callRef: string }>;
  handleWebhook(req: Request): Promise<CallRecord[]>; // duration, outcome, recordingUrl
}
```

### 8.4 Agent call screen (the most used screen)

One order at a time, served by the queue (agents do not pick orders):

- Customer: name, phone (click-to-call), phone2, history (orders, delivered, refused, blacklisted badge).
- Order: items, variants, **total to pay at the door** in large type, shipping fee, wilaya/commune/address/landmark, delivery type.
- **Product sheet panel:** selling points, size guide, FAQ, script in Darija (and French) with placeholders filled (`[المنتج]`, `[المجموع]`).
- **Confirmation checklist** (must all be ticked to enable "Confirm"): product explained · total price + delivery fee stated · wilaya + commune + landmark verified · size/color/qty verified · explicit "yes" from customer.
- Seriousness test prompts (4 questions) shown as a collapsible helper.
- Buttons: outcome of this attempt · Confirm · Postpone (date picker ≤ 7 days) · To verify (comment) · Cancel (reason) · Fake (propose) · Duplicate.
- Attempt timeline: attempts 1–9 with slot, number used, outcome.
- Keyboard shortcuts for outcomes.

---

## 9. Assignment and reassignment engine

### 9.1 Assignment

- New orders are assigned automatically to an **available** confirmation agent of a pod serving that merchant (`PodMerchant`).
- Strategy (configurable): round-robin weighted by open load; cap of open orders per agent (default 40).
- Optional rules: high-value orders or new products → top-rated agents; zone/wilaya-based routing.
- Agent availability comes from **shifts** (`Shift` table: user, day, start, end) and a live status toggle (available / break / offline).

### 9.2 Reassignment rules (run by the scheduler every minute)

| Trigger | Action |
|---|---|
| `NOUVEAU`/`ASSIGNEE` untouched for 30 min | reassign to another available agent |
| 3 failed attempts by the same agent in one day | next day goes to another agent of the pod |
| Callback due and agent off shift | assign to an on-shift agent of the same pod |
| `REPORTE` date reached | original agent if on shift, else any available agent |
| Delivery issue (`CLIENT_INJOIGNABLE_LIVREUR`, `ALERTE`, `ADRESSE_ERRONEE`, `REFUSE`) | rescue task to the pod's follow-up agent, SLA same day |
| Agent goes offline during shift | release all their open orders to the pool |
| Order `CONFIRMEE` | ownership moves to the pod's follow-up agent |

Every reassignment writes an `OrderEvent` (`REASSIGN`, old agent, new agent, rule id). Per-agent KPIs are computed from these events so they stay fair.

---

## 10. Delivery follow-up and rescue

### 10.1 Courier status → task mapping

| Status | Automatic message | Task for follow-up agent | SLA |
|---|---|---|---|
| `EXPEDIE` | "Your order has shipped" | — | — |
| `ARRIVE_WILAYA` | "Your order reached [wilaya], keep your phone on" | `STUCK_PARCEL` if > 48 h | 48 h |
| `STOP_DESK` | office address, hours, deadline | `STOPDESK_REMINDER` day 2 and day 4, escalate day 5 | — |
| `EN_LIVRAISON` | morning message with the exact amount to prepare | — | — |
| `CLIENT_INJOIGNABLE_LIVREUR` | message with the delivery man's number | `RESCUE_NO_ANSWER` (call from our number, request reschedule) | same day |
| `REPORTE_CLIENT` | — | call for a firm date, max 2 postponements | same day |
| `ADRESSE_ERRONEE` | — | `WRONG_ADDRESS` (correct and push to courier), link error to `confirmedById` | same day |
| `TENTATIVE_ECHOUEE` | — | call: "did the delivery man come?" → complaint if not | same day |
| `REFUSE` | — | `PRE_RETURN_CALL` (save the sale), reason required | same day |
| `ALERTE` | — | `ALERT` | same day |
| no update 72 h | — | `STUCK_PARCEL` | — |
| no update 7 days | — | mark `PERDU_ENDOMMAGE` candidate, open claim | — |
| `LIVRE` | "Did you receive your order? Rate us" | — | — |

### 10.2 Repeat refusers

A customer with ≥ 2 refusals gets the `REPEAT_REFUSER` flag. Supervisor can blacklist. Flagged customers require a second verification call or Stop Desk before shipping (configurable).

---

## 11. Messaging automations (WhatsApp / SMS)

- Adapter interface; first real adapter: **WhatsApp Business Cloud API** (template messages). SMS adapter for a local gateway (owner to choose).
- Templates are per merchant, bilingual, with variables: `{customer_name} {product} {total} {wilaya} {courier_phone} {store_name}`.
- Default templates: `missed_call_1`, `written_confirmation`, `bot_confirm_request` (button "I confirm"), `shipped`, `arrived_wilaya`, `stopdesk_info`, `delivery_day_amount`, `courier_trying_to_reach_you`, `injoignable_final`, `did_you_receive`.
- Respect quiet hours (same blocked windows as calls). Log every message in `MessageLog`.
- **Bot confirmation:** a reply on the `bot_confirm_request` button sets `CONFIRMEE_BOT` (see section 7.3 for safeguards).

---

## 12. Integrations (adapters)

All external systems use an adapter with a mock implementation for development.

### 12.1 Order sources

| Channel | Mechanism |
|---|---|
| Shopify | Full two-way integration — see section 12.5 |
| DZBuild | API v1 + outbound webhooks — see section 12.7 |
| WooCommerce | Webhook + REST API |
| YouCan | Webhook/API (owner supplies docs) |
| Google Sheets | Polling a sheet with a fixed column mapping (common for landing-page forms) |
| Public API | `POST /api/v1/orders` with API key per store |
| Manual | Order form in the app |

On ingest: normalize phone (`0XXXXXXXXX`), map wilaya name → code (1–58 table seeded), detect duplicates (same phone + same product within 48 h), detect obvious fakes (invalid phone, nonsense name), then create `NOUVEAU`.

### 12.2 Couriers

```ts
interface CourierAdapter {
  provider: string;                                 // "yalidine", "ecotrack", ...
  createParcel(order: Order): Promise<{ trackingNumber: string; labelUrl?: string }>;
  getStatus(trackingNumbers: string[]): Promise<CourierStatus[]>;
  handleWebhook?(req: Request): Promise<CourierStatus[]>;
  mapStatus(raw: string): OrderStatus | null;       // provider status → our code
  getFees?(wilayaCode: number, type: DeliveryType): Promise<number>;
}
```

- Full list of Algerian couriers, families, credentials and operations: section 12.6.
- Store every raw status in `CourierEvent`. Unmapped statuses go to an admin "unmapped statuses" screen.
- Sync: webhook when available, otherwise polling every 15–30 min for non-final parcels.

### 12.3 Payments (SaaS subscriptions and managed-service invoices)

- v1: invoices generated by the platform, payment marked manually (bank transfer / BaridiMob receipt upload).
- Later: online payment adapter (an Algerian gateway such as Chargily — owner to confirm) and Stripe for foreign clients of the HK/US entities.

### 12.4 AI (optional module, phase 6)

Use the Anthropic API (model name from env `ANTHROPIC_MODEL`):
- Draft a product sheet + Darija script + FAQ from a product page URL or description (supervisor edits, merchant approves).
- Weekly narrative for the report: top cancel/return reasons and one recommended action.
- Never auto-send AI text to customers without a human-approved template.

### 12.5 Shopify integration (two-way)

Goal: a merchant connects a Shopify store once; orders flow in automatically, our statuses flow back, and confirmed orders are fulfilled in Shopify with the courier tracking number.

**App type and access**

| Stage | App type | Why |
|---|---|---|
| v1 (own stores + first managed clients) | **Custom app per store** (custom distribution, OAuth install link per merchant) | Custom apps always have Level 2 protected customer data (name, phone, address) available, so no review is needed to start. |
| Later (SaaS self-serve) | **Public app** | Requires requesting **Protected customer data access** in the Partner Dashboard, field by field (name, address, phone, email), meeting Shopify's Level 1 + Level 2 data-protection requirements, and passing review. Fields not approved come back **redacted** — the code must handle that. |

- Use the **GraphQL Admin API** only. Pin the API version in env (`SHOPIFY_API_VERSION`) and upgrade deliberately.
- Store the offline access token per store, encrypted (`Store.credentials`).
- Respect Shopify's cost-based rate limiting (read the throttle status in responses; back off and queue).

**Access scopes** (request the minimum)

| Need | Scope |
|---|---|
| Read orders, customer and shipping address | `read_orders` |
| Write tags/notes, cancel orders | `write_orders` |
| Read products and variants for product sheets | `read_products` |
| Create fulfillments on merchant-managed locations | `write_merchant_managed_fulfillment_orders` (+ the read counterpart) |
| (Only if the agency runs the warehouse as a fulfillment service) | `write_assigned_fulfillment_orders` / fulfillment service setup |

The three fulfillment write scopes above are the ones Shopify lists for `fulfillmentCreate`; verify the rest against the current docs at build time.

**Webhooks to subscribe**

| Topic | Use |
|---|---|
| `orders/create` | Ingest the order → `NOUVEAU` |
| `orders/updated` | Address/item edits made in Shopify before shipping |
| `orders/cancelled` | Cancel in our platform if not yet shipped |
| `products/create`, `products/update` | Keep product list and prices in sync |
| `app/uninstalled` | Mark store disconnected, stop syncing |
| `customers/data_request`, `customers/redact`, `shop/redact` | Mandatory privacy webhooks for public apps |

Verify every webhook with the `X-Shopify-Hmac-Sha256` header before processing. Webhooks can arrive twice or out of order: make ingestion idempotent on `(storeId, externalId)`.

**On connect (backfill)**
- Import products and variants.
- Import open orders from the last N days (default 7) that are not fulfilled or cancelled.

**Order mapping (Shopify → platform)**

| Platform field | Shopify source |
|---|---|
| `externalId` | order GID + order name (`#1234`) |
| customer name / phone | shipping address name/phone, fallback customer, fallback billing |
| wilaya / commune / address | shipping address `province` / `city` / `address1`+`address2`. Many Algerian stores use **COD form apps** that put wilaya/commune in custom attributes or the order note — support a per-store **field mapping** screen (source path → our field) with a live preview on the last 5 orders. |
| items | line items (product, variant, qty, price) |
| shipping fee / total | shipping lines / current total price |
| source | `sourceName`, landing site, UTM in note attributes |

Normalize phone, map wilaya text → code (accept French, Arabic and numeric), flag orders where mapping failed as `A_VERIFIER` with the reason.

**Write-back (platform → Shopify)** — each action is a per-store toggle

| Platform event | Shopify action |
|---|---|
| Any status change | Replace our tag `cc:<STATUS_CODE>` on the order (one tag at a time) |
| Agent edits address/items | Order note with the change (optionally `orderEditBegin` flow later) |
| `ANNULEE`, `FAUSSE_COMMANDE`, `DOUBLE` | Cancel the order in Shopify (off by default; merchant chooses) |
| Parcel created with courier | **Fulfill**: query `order.fulfillmentOrders`, then `fulfillmentCreate` with `lineItemsByFulfillmentOrder` and `trackingInfo { company, number, url }`, `notifyCustomer` off by default |
| `LIVRE` / `ENCAISSE` | Mark the order as paid (COD payment captured) — confirm the mutation name against current docs |
| `RETOUR_RECU` | Tag `cc:RETOUR_RECU` + note; restock in Shopify inventory if the merchant enables it |

Notes on `fulfillmentCreate`: all fulfillment orders in one call must belong to the same order and location; omitting line items fulfills the whole fulfillment order.

**Other stores**: WooCommerce (webhooks + REST, `wc/v3`), YouCan (owner supplies docs), Google Sheets (column mapping), public API — same internal ingestion pipeline as Shopify.

### 12.6 Algerian delivery companies

**Rule for the builder:** endpoint paths and payloads must come from the courier's official API docs or from the source code of the open-source clients listed in "References" below, with the source link in a code comment above each call. Never guess an endpoint. Every provider ships with a mock and a `testCredentials()` call used on the connect screen.

**Provider families** — most Algerian couriers run on a few shared platforms, so one adapter per family covers many companies.

| Family | Companies | Credentials | Operations available (per open-source clients) | Notes |
|---|---|---|---|---|
| **Yalidine family** | Yalidine, Guepex, Yalitec, Economiqua, Easy & Speed, **WeCan** | API ID + API token (+ origin wilaya) | create, batch tracking, label (URL), stop desks, cancel, **signed webhook** | Also exposes wilayas, communes, centers (desks) and delivery fees. Rate-limit status returned in response headers. |
| **EcoTrack** (about 80 tenants) | DHD, Conexlog (UPS), Anderson, GOLIVRI, Rex Livraison, MSM Go, Chronorex, Speed Mail, and many more — full list in Appendix A | Bearer token per company | create (with validation), "Expédier" (ship/validate) step, batch tracking (up to 100), label PDF, stop desks, cancel. **No webhook** → poll | One adapter, base host per tenant (`https://<tenant>.ecotrack.dz`, DHD `platform.dhd-dz.com`, Conexlog `app.conexlog-dz.com`) + `/api/v1`. Order fields include `nom_client`, `telephone`, `telephone_2`, `adresse`, `code_wilaya`, `commune`, `montant` (total incl. shipping), `produit`, `remarque`, `reference`, `type` (1 delivery, 2 exchange), `stop_desk` (0/1), `fragile`. |
| **ZR Express (new platform)** | ZR Express | Secret API key + tenant ID (UUID) | create, tracking, label (URL), hubs/pickup points, cancel, webhook (payload to confirm) | Host `api.zrexpress.app`. Territories use **UUIDs**, not names. Stop desk = `deliveryType: "pickup-point"` + `hubId`. Description capped at 100 chars. |
| **Procolis (legacy)** | ZR Express legacy, Abex, Colilog, Flash Delivery, Leopard | Token + key | create, tracking only | Host `procolis.com`. `TypeLivraison` 1 = office, 0 = home. No labels, desks or cancel. Try ZR's new platform first, fall back to legacy. |
| **NOEST** | Noest (Nord et Ouest) | API token + user GUID | create (with validation), batch tracking, label PDF, desks, cancel. **No webhook** → poll | Fields: `montant` (total incl. shipping), `poids` (kg, integer), `can_open` (customer may open before paying), `type_id`, `stop_desk`, `station_code` (desk code, e.g. `16A`), `commune_id`. A **validated** order can no longer be edited. Throttles aggressively → pace bulk sends. |
| **Maystro Delivery** | Maystro | API token | create (requires commune ID), tracking, label PDF, cancel, create product. No desks, no webhook | Product catalog can be pushed to Maystro. |
| **Others to confirm** | EMS (Algérie Poste), Kaalixpress, IDS, local delivery men | — | — | Add when the owner gets API access; local delivery men are handled by the in-house module later. |

**Unified adapter (extends 12.2)**

```ts
interface CourierAdapter {
  provider: string;                       // "yalidine", "ecotrack:dhd", "zr", "procolis:abex", "noest", "maystro"
  family: "YALIDINE" | "ECOTRACK" | "ZR" | "PROCOLIS" | "NOEST" | "MAYSTRO";
  capabilities: { label: boolean; desks: boolean; cancel: boolean; webhook: boolean; validateStep: boolean; batchTrack: number };
  testCredentials(): Promise<boolean>;
  syncTerritories(): Promise<ProviderCommune[]>;     // wilayas, communes, provider IDs/UUIDs/codes
  syncDesks?(): Promise<ProviderDesk[]>;             // stop desks / hubs / stations
  getFees?(toWilaya: number, type: DeliveryType, fromWilaya?: number): Promise<number>;
  createParcel(order: Order, opts: { deskId?: string; fragile?: boolean; canOpen?: boolean }): Promise<{ trackingNumber: string; labelUrl?: string }>;
  validateParcel?(trackingNumber: string): Promise<void>;   // EcoTrack "Expédier", NOEST validate
  getLabel?(trackingNumber: string): Promise<{ pdfUrl: string }>;
  track(trackingNumbers: string[]): Promise<CourierStatus[]>;
  cancel?(trackingNumber: string): Promise<void>;
  handleWebhook?(req: Request): Promise<CourierStatus[]>;   // verify signature where provided
  mapStatus(raw: string): OrderStatus | null;
}
```

**Territory mapping** — each courier names places differently (names, numeric IDs, UUIDs, station codes):
- Keep one master table `Commune` (wilaya code 1–58, names FR/AR) and a `ProviderCommune` table `(provider, communeId, providerRef, hasDesk)`.
- Sync territories and desks on connect and weekly. Unmatched communes appear on an admin screen for manual mapping.

**Fulfillment flow (end to end)**

1. Order reaches `CONFIRMEE` (or `CONFIRMEE_BOT` after checks).
2. **Courier routing** picks the courier: per-merchant rules by wilaya (best delivery rate from section 15, then fee), delivery type (home / desk), and fallback courier if the first refuses the parcel. Supervisor can override per order.
3. Warehouse packs → `createParcel` → store `trackingNumber`, label.
4. If the family has a validation step (EcoTrack, NOEST), call it once the parcel is physically ready (auto-validate toggle per store).
5. Print label (courier PDF when available, otherwise our own HTML label with tracking barcode).
6. Shopify `fulfillmentCreate` with tracking (section 12.5) → order `EXPEDIE` when the courier confirms pickup.
7. Status sync: webhook (Yalidine family, ZR) or polling every 15–30 min in batches (EcoTrack ≤ 100 per call, NOEST, Maystro, Procolis). Map each raw status → our code; create follow-up tasks (section 10).
8. `LIVRE` → Shopify mark-paid (optional) → included in courier COD reconciliation.
9. Returns → `RETOUR_EN_COURS` → warehouse scan → `RETOUR_RECU` → restock.

**COD reconciliation with couriers**
- Most courier APIs do not expose payouts reliably. v1: import the courier's payment statement (CSV/Excel) per payout, match lines to orders by tracking number, show gaps (delivered but unpaid, amount mismatch, fees).
- Mark matched orders `ENCAISSE`. Gaps feed the weekly report.

**Status mapping**
- Build the raw → code mapping per family from real responses captured in `CourierEvent` during testing (start with the mock + the first real account). Unknown statuses never change the order; they appear on the "unmapped statuses" screen for the supervisor to map once.

**References for the builder** (read their source for endpoints and payloads; do not add them as dependencies — different languages)
- `dzcouriers` (Go client covering Yalidine family, EcoTrack tenants, ZR, NOEST, Procolis, Maystro): https://github.com/ZaouiAmine/dzcouriers
- `CourierDZ` (PHP client, Yalidine, Procolis/ZR, EcoTrack, Maystro): https://github.com/PiteurStudio/CourierDZ
- DZBuild courier integration notes (field-level behavior for EcoTrack, ZR, NOEST): https://dzbuild.com/docs/couriers/ecotrack · https://dzbuild.com/fr/docs/couriers/zr-express · https://dzbuild.com/docs/couriers/noest
- Shopify `fulfillmentCreate`: https://shopify.dev/docs/api/admin-graphql/latest/mutations/fulfillmentCreate
- Shopify fulfillment apps: https://shopify.dev/docs/apps/build/orders-fulfillment/fulfillment-service-apps
- Shopify protected customer data: https://shopify.dev/docs/apps/launch/protected-customer-data
- DZBuild API (auth, rate limits, idempotency, orders, webhooks): https://dzbuild.com/api-docs/intro · https://dzbuild.com/api-docs/idempotency · https://dzbuild.com/api-docs/resources/orders · https://dzbuild.com/docs/addons/webhooks
- DZBuild operations references (order management, team, couriers, WhatsApp, anti-fraud): https://dzbuild.com/docs/addons/advanced-orders · https://dzbuild.com/docs/operations/team · https://dzbuild.com/docs/couriers/overview · https://dzbuild.com/docs/addons/whatsapp-sender · https://dzbuild.com/docs/addons/limit-orders-per-ip

### 12.7 DZBuild stores (order source)

DZBuild is an Algerian store builder (COD stores, landing pages, ~100 courier integrations). Many target merchants sell on it, so it is a first-class order source alongside Shopify.

| Item | Detail |
|---|---|
| Base URL | `https://api.dzbuild.app/v1` (only supported public base; JSON, UTF-8) |
| Auth | `Authorization: Bearer <key_id>.<key_secret>`. Personal keys need the merchant's store on DZBuild's **Enterprise** plan (Settings → API); app installs use DZBuild's developer platform (dzbuild.dev) |
| Check | `GET /v1/ping`, `GET /v1/whoami` (returns scopes) → use for "Test connection" |
| Scopes we need | `orders:read`, `orders:write`, `webhooks:*`, `customers:read`, `products:read` (`delivery:send` only if the merchant wants DZBuild to ship) |
| Orders | `GET /v1/orders` (`limit` 1–200, `cursor`, `status`, `since`, `customer_phone`), `GET /v1/orders/{id}`, `PATCH /v1/orders/{id}` (status), `POST /v1/orders/{id}/cancel`, `POST /v1/orders/{id}/send-to-delivery` (two-step, merchant-approved `confirm_token`) |
| Their statuses | `pending`, `confirmed`, `processing`, `shipped`, `delivered`, `cancelled`, `returned` (+ payment `pending`/`paid`/`refunded`). `cancelled` and `returned` are terminal |
| Webhooks | `order.created`, `order.confirmed`, `order.processing`, `order.shipped`, `order.delivered`, `order.cancelled`, `order.returned` (+ `webhook.verify`, `webhook.test`). Headers `X-DZ-Token`, `X-DZ-Timestamp`, `X-DZ-Signature: t=…,v1=…` = HMAC-SHA256 of `timestamp.rawBody`; reject if older than 5 min. They retry 5 times (≈1 m, 5 m, 30 m, 2 h, 12 h) and disable an endpoint after 10 straight failures |
| Writes | Send `Idempotency-Key` on every POST/PATCH/DELETE (required). Handle `429 rate_limited` with `retry_after` (per-store, per-minute budget shared by all keys) |

Mapping: `order.created` → `NOUVEAU`. Write back: our `CONFIRMEE*` → `confirmed`; `ANNULEE`/`FAUSSE_COMMANDE`/`DOUBLE` → `/cancel` (toggle); shipping via our own courier flow → `PATCH status=shipped` with tracking; `LIVRE` → `delivered`; `RETOUR_RECU` → `returned`. Poll `GET /v1/orders?since=` every 10 min as a safety net in case a webhook was missed.

---

## 13. Stock and fulfillment (WecanServices-style)

- Warehouses per merchant (or agency-run warehouse holding several merchants' stock).
- Stock: `onHand`, `reserved`. Confirmation reserves; shipping deducts; return reception restocks after a condition check.
- `CONFIRMEE_RUPTURE` is only allowed when available stock = 0; restock triggers automatic return to `CONFIRMEE` and a customer message.
- Low-stock alert when available stock < N days of average confirmed orders (warn before ads keep running).
- Packing screen: scan order → checklist of items → print label → `PRET_A_EXPEDIER`.
- Return reception: scan tracking → condition (OK / damaged / missing) → restock or write-off.
- Weekly reconciliation: courier's "returned" list vs. returns actually received.

---

## 14. Quality assurance

### 14.1 Call scoring grid (10 points)

| Criterion | Points |
|---|---|
| Greeting and introduction (name, store, reason) | 1 |
| Order reminder (confirms it is the customer's order) | 1 |
| Product explanation (at least one benefit, accurate answer) | 2 |
| Total price + delivery fee stated before asking for confirmation | 2 |
| Information verified (wilaya, commune, landmark, size/color, phone) | 2 |
| Closing (explicit "yes", not "inchallah") | 1 |
| Respect, no pressure, no false promises | 1 |

Any lie about product/price or hidden delivery fee → **score 0** for the whole call (`zeroed = true`).

### 14.2 QA workflow

- Daily sample per agent: 5 calls (3 confirmed + 2 cancelled) assigned to the pod's follow-up agent as `QA_REVIEW` tasks.
- Cancelled-order callback sample: 10% of cancelled orders per agent re-called by another agent to detect wrong cancellations.
- Calibration: supervisor and follow-up agent score the same call weekly; show the gap.
- Escalation ladder (stored as `Warning`): 1 verbal note → 2 written note + joint listening → 3 supervisor session + retraining → proven fake confirmation: bonus suspended + warning.

---

## 15. KPIs and formulas (single source of truth)

Implement once in `src/lib/kpi.ts` and reuse everywhere (dashboards, reports, invoices).

| KPI | Formula |
|---|---|
| Confirmation rate | confirmed (all `CONFIRMEE*`) ÷ (all orders − `DOUBLE` − `FAUSSE_COMMANDE`) |
| Delivery rate | `LIVRE` ÷ (`LIVRE` + returned), **finished parcels only** |
| Return rate | returned ÷ finished parcels |
| Rescue rate | delivered after a rescue task ÷ rescue tasks created |
| Proof rate | attempts with proof ≠ NONE ÷ all attempts |
| Time to first call | first `CallAttempt.startedAt` − order `createdAt` (business hours only) |
| Shipped within 24 h | confirmed orders shipped within 24 h ÷ confirmed orders |
| Agent delivery rate | delivery rate on orders where `confirmedById = agent` |
| QA average | mean of `QaReview.total` |
| Cost per delivered order | (team cost for the period) ÷ delivered orders |

### 15.1 Red flags (auto-detected, shown on supervisor dashboard)

| Pattern | Meaning |
|---|---|
| High `INJOIGNABLE` + low proof rate | fake call attempts |
| High confirmation rate + low agent delivery rate | fake or weak confirmations |
| `FAUSSE_COMMANDE` / `DOUBLE` / `A_VERIFIER` above team average | dumping hard orders |
| `REPORTE` with far dates | parking orders |
| Slow time to first call | cherry-picking or idle |
| Delivery-man "no answer" rate far above average | lazy delivery man → report to courier |
| Wilaya delivery rate < 70% | change courier or force Stop Desk |

---

## 16. Dashboards and screens

| Screen | Roles | Content |
|---|---|---|
| Agent queue / call screen | confirmation agent | section 8.4 |
| Follow-up board | follow-up agent | tasks by SLA (rescue, alerts, stop desk, pre-return), pod confirmed orders not shipped > 24 h, QA review queue |
| Supervisor dashboard | supervisor | live KPIs per pod/agent/merchant/product, red flags, queue health (orders > 30 min, tasks without owner), stuck parcels per courier |
| Orders table | supervisor, merchant | filters by status, store, agent, pod, wilaya, courier, date, product; bulk actions (reassign, export CSV) |
| Order detail | all with access | timeline of `OrderEvent`, calls, messages, courier events |
| Couriers | supervisor | delivery rate by courier × wilaya, delivery men "no answer" rate, unmapped statuses |
| Stock | warehouse, supervisor | stock, movements, low stock, returns reception |
| QA | supervisor, follow-up | scoring form with recording player, calibration, warnings |
| Team | supervisor | pods, shifts, availability, leaderboard |
| Reports | per section 17 | daily/weekly/monthly |
| Client portal | client viewer | merchant-only view: KPIs, orders (read-only), reports, invoices, product sheets to approve |
| Billing | owner | contracts, invoices, plans, SaaS subscriptions |
| Settings | owner/supervisor | slots and blocked windows, numbers A/B/C, assignment rules, templates, status label overrides, integrations |
| Platform admin | platform admin | orgs, plans, impersonation (logged), feature flags, system health |

---

## 17. Reports

Generated automatically (scheduled jobs), viewable in-app, exportable as PDF, and sendable by WhatsApp/email. Each report has a pre-send checklist and blocks with `[..]` until numbers exist.

| Report | Author | Recipient | When |
|---|---|---|---|
| Agent daily | confirmation agent (auto + note) | follow-up agent | end of shift |
| Pod daily | follow-up agent | supervisor | 17:00 |
| Team daily | supervisor | owner / merchant | 18:00 |
| Weekly | supervisor | owner + marketer / merchant | Sunday morning (week = Saturday–Friday, configurable) |
| Monthly | supervisor | owner / merchant | 1st–2nd of month |

**Pod daily** must contain: incoming orders; confirmed per agent with rate; cancelled + top reason; postponed / to verify / unreachable; proof rate per agent; yesterday's confirmed shipped vs. not shipped > 24 h with reason; delivered and returned today with reasons; alerts and "no answer" handled and rescued; parcels stuck > 72 h escalated; QA calls reviewed and main note; tomorrow's pending work and needs.

**Weekly** adds: comparison with last week (points, not just %), per-product and per-campaign confirmation and delivery, best/weakest pod and agent, warnings, courier table (delivery %, stuck, lost, weakest wilaya), top 3 cancel and return reasons with actions, financial reconciliation gaps, low-stock products, change being tested next week.

**Monthly** adds: 3-month trend, cost of returns, team cost per delivered order, products to scale or stop, agent ranking and bonuses, certifications and departures, best courier per region, reconciliation recovered/open, improvements kept or dropped, next month's targets.

---

## 18. Team management

- Pods: 2 confirmation agents + 1 follow-up agent (enforced as a soft rule with a warning, not a hard block).
- Shifts and live availability; evening team support (calls until 21:00).
- Leaderboard (weekly) by **delivered** orders and QA average, never by confirmed count.
- Bonus engine: per delivered order (confirmation agent), per rescued parcel (follow-up agent), pod bonus above a delivery-rate target; suspensions from warnings. Amounts configurable per org.
- Training/certification tracking: modules passed, QA average, first-month certification status.

---

## 19. Billing and plans

### 19.1 Managed service (agency → merchant)

- Pricing models on `ServiceContract`: `PER_DELIVERED` (default), `PER_CONFIRMED`, `FIXED_PLUS_BONUS`, `DEDICATED_POD`.
- Duplicates and obvious fakes are never billed.
- Billing period weekly or bi-weekly; delivered = `LIVRE` within period; minimum monthly applies.
- Trial: fixed number of days or orders, then auto-switch to `ACTIVE` or `ENDED`.
- Invoice PDF (FR/AR) with line details; client sees it in the portal.

### 19.2 SaaS subscription (merchant using their own team)

- Plans with limits: orders/month, users, stores, features (bot confirmation, AI, multi-warehouse).
- Usage metering on orders ingested; soft limit with warning at 80%, hard limit configurable.

---

## 19b. Business and developer features (lessons from DZBuild)

Patterns proven on an Algerian SaaS used by COD merchants. Build them in; they remove daily friction for the owner, the team, clients and integrators.

### 19b.1 Subscription and billing (SaaS)

| Feature | Rule |
|---|---|
| **Trial** | One trial per org (default 7 days, configurable), no card. Cannot be extended or restarted. |
| **Local payment** | (1) CIB/Edahabia gateway adapter (SlickPay or Chargily — owner chooses), one-off payment, manual renewal; (2) **BaridiMob/CCP receipt upload**: client transfers, uploads a screenshot, platform admin approves from a queue (target < 30 min), activation is instant on approval; (3) international card (Stripe/PayPal) in USD as auto-renewing subscription for foreign clients. |
| **Annual** | 12 months for the price of 10 (configurable). |
| **Early renewal** | Adds the new period to the remaining time. Renewal after expiry starts fresh. |
| **Plan switch** | Remaining time is converted by price ratio (e.g. 20 days of a cheaper plan → fewer days of the bigger one), never refunded as money. |
| **Expiry reminders** | Daily for the last 7 days (in-app + email + WhatsApp). |
| **After expiry** | Read-only mode: no new orders ingested, dashboard limited to billing/export, **nothing deleted**. Renewing restores everything instantly. Never auto-delete idle orgs. |
| **Seats** | Included per plan; extra seats sold by duration (1/3/6/12 months). |
| **Usage meters** | Orders/month, seats, stores, WhatsApp credits, AI credits — visible on a Usage page with progress bars. |
| **Messaging credits** | WhatsApp/SMS sent by the platform consume prepaid **credits** (top-up in DZD steps, volume discounts). Only Algerian mobiles `05/06/07` are messaged; skipped numbers are not charged. This is a revenue line for the owner. |
| **Affiliate program** | Referral links for the SaaS (commission % on first N months) and for the managed service (section on partners in the marketing plan). |

### 19b.2 Team and operations

| Feature | Rule |
|---|---|
| **Per-store roles** | A user can have a different role per merchant/store (e.g. supervisor on Store A, read-only on Store B). |
| **Read-only role** | `CLIENT_VIEWER` plus an internal `READ_ONLY` for accountants/partners. |
| **Distribution by percentage** | Alternative assignment strategy: supervisor sets a % per agent (must total 100%); applies to orders arriving after saving. |
| **Ownership lock** | When distribution is on, agents cannot change or log calls on orders assigned to others; supervisors can. |
| **Mandatory notes** | Org setting to require a written note for `ANNULEE`, `FAUSSE_COMMANDE` and customer-cancel. |
| **Queue chips** | Counters on the orders page: "Not treated", each confirmation status, "Return on the way" (returned but not yet received), "Shipped > 24 h without courier scan". |
| **Bulk actions** | Send up to 50 orders to a courier at once, print labels in bulk, bulk reassign, bulk "Return received" (restock). |
| **Quick actions per row** | Details · Call · Send to courier (before shipping) · Print label (after tracking exists). |
| **Search** | By phone, name, order id, store sequence number; store filter including "all stores" for multi-store users; page sizes 20/50/100. |
| **Agent live stats** | Today per agent: confirmations, attempts, actions, assigned, last activity time. |
| **Audit log UI** | Filter by member, action type, date. Read-only. |
| **Notifications** | Telegram bot and email for owners (new order spikes, stuck parcels, failed courier sends). |
| **Google Sheets sync** | Optional two-way export of orders to a merchant's sheet (many merchants still live in Sheets). |

### 19b.3 Couriers (operational details)

| Feature | Rule |
|---|---|
| **Test connection** | Button on every courier tile before saving credentials. |
| **Default courier + pause** | First linked courier is default; each courier can be paused (no new sends) or unlinked without touching existing parcels. |
| **Rates and desks sync** | Automatic daily sync; manual "Sync now" with a 5-minute cooldown. |
| **Desk-aware choice** | Couriers with no desk in the customer's wilaya are greyed out for desk delivery; picking a desk auto-selects its courier. |
| **Per-wilaya delivery switches** | For each wilaya: home on/off, desk on/off, price per type. |
| **Return stock rule** | Restock when the courier reports returned, when the warehouse clicks "Return received", or automatically 15 days after the return started — whichever first. |
| **Safe sync** | Unknown courier statuses never change the order. Never cancel an order because a parcel is "not found". |
| **Send failure** | Keep `lastSendFailure` on the order, show it on the row, allow retry. |

### 19b.4 Anti-fraud on order intake

| Feature | Rule |
|---|---|
| **Limit orders per IP** | For our public order API and landing forms: max N successful orders per IP in H hours (default 3 / 12 h, fixed window). Return 429 with a localized "try later" message. Suggest 10 / 12 h for mobile carrier NAT. |
| **Captcha** | Optional on public forms (headless-bot protection). |
| **Ban list at intake** | Blacklisted phones are refused at intake or flagged (merchant choice). |
| **Phone validation** | Algerian formats only by default; invalid → `A_VERIFIER`. |

### 19b.5 Customer-facing touches

| Feature | Rule |
|---|---|
| **Public tracking page** | `/{locale}/t/{token}`: status timeline in Darija/FR, courier, desk address, amount to pay. Every WhatsApp message ends with a "Track my order" button to it. |
| **One message per event per order** | Never resend the same template twice for one order. |
| **Short links** | Short tracking links for SMS. |

### 19b.6 Developer platform (our own public API)

Design our API like DZBuild's so integrators (merchants' devs, n8n/Make/Zapier users) are productive on day one.

| Feature | Rule |
|---|---|
| **Base and versioning** | `https://api.<domain>/v1`; breaking changes only in a new path prefix; changelog page. |
| **Keys** | `Authorization: Bearer <key_id>.<key_secret>`; secret shown once; keys per org with **scopes** (`orders:read`, `orders:write`, `customers:read`, `products:*`, `shipping:*`, `webhooks:*`, `reports:read`, `usage:read`, `messages:send`); `GET /v1/whoami` and `GET /v1/ping`. |
| **Envelope** | Success `{ data, meta: { request_id, api_version } }`; error `{ error: { code, message, retry_after? }, meta }`; stable error codes documented. |
| **Headers** | `X-Request-Id` on every response (accept client-sent id and echo it); `X-Api-Version`. |
| **Idempotency** | `Idempotency-Key` required on POST/PATCH/DELETE; stored 24 h; replay returns `Idempotency-Replay: 1`; same key with different body → `422 idempotency_key_reuse`; cache 4xx, never 5xx. |
| **Pagination** | Cursor-based (`limit` ≤ 200, `cursor`). |
| **Rate limits** | Per org per minute, shared by all keys; `429 rate_limited` + `retry_after`. |
| **Dangerous actions** | Two-step with a `confirm_token` (e.g. bulk send to courier, bulk cancel). |
| **Outbound webhooks** | Events: `order.created`, `order.status_changed`, `order.confirmed`, `order.cancelled`, `order.shipped`, `order.delivery_issue`, `order.delivered`, `order.returned`, `call.logged`, `report.ready`, plus `webhook.test`. Signed: `X-Signature: t=<unix>,v1=<hmac_sha256(secret, t + "." + rawBody)>`; receivers reject > 5 min old. Retries ≈ 1 m, 5 m, 30 m, 2 h, 12 h; auto-disable after 10 consecutive failures; delivery log (last 50) with replay button. |
| **Docs and tooling** | OpenAPI spec generated from Zod schemas, hosted reference page, Postman collection, typed TypeScript SDK, sandbox org with seeded data, n8n-friendly header auth. |
| **App installs (later)** | OAuth apps that other developers can publish for our merchants (scoped install tokens). |

---

## 20. Build phases and acceptance criteria

Build in order. Each phase must be usable on its own.

### Phase 1 — Foundation
- Monorepo/app scaffold, Docker Compose, Prisma schema, seed (orgs: 1 agency, 2 merchants; users per role; 58 wilayas; products; 200 sample orders across statuses).
- Auth, memberships, tenant context, role guards, i18n FR/AR with RTL.
- Order status dictionary, transition table, `orderTransitions` service, `OrderEvent` audit log.
- Orders table + order detail (read + manual status change through the service), queue chips, search, quick actions (19b.2).
- API foundations (19b.6): `/v1` router, key auth with scopes, response envelope, `X-Request-Id`, idempotency middleware, cursor pagination, per-org rate limiter. Audit log UI.
- **Accept:** tenant isolation tests pass; illegal transitions are rejected; agent cannot set `INJOIGNABLE`; UI switches FR ⇄ AR with correct direction.

### Phase 2 — Confirmation engine
- Order ingestion: manual form, public API, Google Sheets polling.
- **DZBuild (section 12.7):** key connect with `whoami` test, signed webhooks, `since=` safety polling, status write-back with idempotency keys.
- Intake anti-fraud (19b.4): IP limit, ban list, phone validation. Percentage distribution and ownership lock (19b.2).
- **Shopify (section 12.5):** OAuth install for a custom app, encrypted token, HMAC-verified webhooks, product + 7-day order backfill, per-store field mapping screen for COD form apps, status tag write-back.
- Duplicate and fake detection, customer history.
- Assignment engine, shifts, availability, reassignment rules job.
- 3×3 call scheduler with slots, blocked windows, number rotation, agent rotation.
- Agent call screen with product sheet, checklist and script.
- **Accept:** a Shopify test order (dev store) appears as `NOUVEAU` within seconds, a replayed webhook does not create a duplicate, and a tampered HMAC is rejected; an order with 9 unanswered logged attempts reaches `INJOIGNABLE` only via the scheduler; attempts outside slots are rejected; an order untouched 30 min is reassigned; confirmation is impossible without the checklist.

### Phase 3 — Call proof and messaging
- Telephony adapter interface + mock; Android call-log companion (or documented plan + API endpoint it will call).
- WhatsApp Cloud API adapter + mock, templates, quiet hours, bot confirmation, one-message-per-event rule, messaging credits ledger (19b.1), public tracking page + short links (19b.5).
- **Accept:** missed-call message sent after first failed attempt; bot reply sets `CONFIRMEE_BOT`; high-value bot orders create a verification task.

### Phase 4 — Delivery follow-up and stock
- Courier adapter interface + mock for each family (section 12.6); real adapters in this order unless the owner says otherwise: **Yalidine family → EcoTrack (one adapter, all tenants) → ZR Express (new + Procolis fallback) → NOEST → Maystro**.
- Territory and desk sync, `ProviderCommune` mapping screen, courier routing rules per wilaya, labels, validation step, batch polling + webhooks, status mapping and unmapped statuses screen.
- Shopify fulfillment write-back (`fulfillmentCreate` with tracking) and optional mark-as-paid on delivery.
- COD payout import (CSV/Excel) and reconciliation by tracking number.
- Follow-up board, tasks with SLA, rescue flow, stop-desk reminders, stuck parcels.
- Stock, reservations, packing screen, labels, return reception, low-stock alert.
- **Accept:** a confirmed order creates a parcel with the routed courier, gets a tracking number and label, and the Shopify order shows a fulfillment with that tracking; a courier's `testCredentials()` fails cleanly with a readable message on bad keys; a payout file matches orders by tracking number and lists gaps; a mock courier event `CLIENT_INJOIGNABLE_LIVREUR` creates a same-day rescue task for the right follow-up agent and sends the courier-number message; returns restock correctly; return is linked to `confirmedById`.

### Phase 5 — Quality, KPIs and reports
- QA scoring, samples, calibration, warnings.
- `kpi.ts`, supervisor dashboard with red flags, leaderboard, bonus engine.
- Daily/weekly/monthly reports (scheduled, PDF, WhatsApp/email send).
- **Accept:** KPI unit tests with fixed fixtures (known inputs → known rates); delivery rate excludes unfinished parcels; reports match dashboard numbers.

### Phase 6 — SaaS and client portal
- Service contracts, client portal (`CLIENT_VIEWER`), product sheet approval.
- Subscription rules (19b.1): one-time trial, receipt-upload approval queue, gateway adapter, annual pricing, early renewal, plan-switch time conversion, expiry reminders, read-only after expiry, seats by duration, usage page, affiliate links.
- Outbound webhooks with signing, retries, auto-disable and delivery log; OpenAPI reference, Postman collection, TypeScript SDK, sandbox org (19b.6).
- Invoicing for managed service; plans, usage metering and limits for SaaS.
- Platform admin (orgs, plans, impersonation with audit, feature flags).
- Optional AI module (section 12.4).
- **Accept:** a client viewer sees only their merchant; an invoice for a period equals delivered count × unit price (+ fixed, − excluded duplicates/fakes), respecting the minimum; plan limits warn at 80%.

---

## 21. Non-functional requirements

- **Performance:** agent queue serves the next order in < 300 ms; dashboards < 2 s for 100k orders/month per org (use materialized daily aggregates).
- **Reliability:** jobs are idempotent (courier webhooks may repeat); retries with backoff; dead-letter queue visible to admin.
- **Security:** encrypted secrets (courier/store credentials) at rest; rate-limited public API with per-store keys; audit log for overrides, impersonation, exports; 2FA for owner/supervisor.
- **Privacy:** customer phone numbers masked for `CLIENT_VIEWER` exports unless enabled; data retention setting per org; recordings access limited to supervisor/follow-up.
- **Time:** all scheduling in the org timezone (default `Africa/Algiers`).
- **Mobile:** agent and follow-up screens usable on a phone (many agents work from mobile).
- **Accessibility:** keyboard navigation on the call screen; sufficient contrast in both themes.

---

## 22. Project structure (suggested)

```
/prisma
  schema.prisma
  seed.ts
/src
  /app/[locale]/(auth) ...
  /app/[locale]/(app)/queue        # agent call screen
  /app/[locale]/(app)/followup
  /app/[locale]/(app)/orders
  /app/[locale]/(app)/supervisor
  /app/[locale]/(app)/stock
  /app/[locale]/(app)/qa
  /app/[locale]/(app)/reports
  /app/[locale]/(app)/settings
  /app/[locale]/(portal)/client    # client portal
  /app/[locale]/(admin)/platform
  /app/api/v1/...                  # public API, webhooks
  /lib
    tenant.ts  kpi.ts  phone.ts  wilayas.ts
    /orders   transitions.ts  orderTransitions.ts  statuses.ts
    /calls    scheduler.ts  slots.ts  numbers.ts
    /assign   engine.ts  rules.ts
    /adapters /couriers /telephony /messaging /stores /payments
  /worker
    index.ts  jobs/*.ts            # scheduler tick, reassignment, courier sync, messages, reports, aggregates
/messages
  fr.json  ar.json
/tests
  unit/  e2e/
```

---

## 23. Environment variables

```
DATABASE_URL=
REDIS_URL=
AUTH_SECRET=
APP_URL=
ENCRYPTION_KEY=               # for credentials at rest
S3_ENDPOINT= S3_BUCKET= S3_ACCESS_KEY= S3_SECRET_KEY=
EMAIL_PROVIDER= EMAIL_API_KEY= EMAIL_FROM=
WHATSAPP_TOKEN= WHATSAPP_PHONE_ID= WHATSAPP_VERIFY_TOKEN=
SMS_PROVIDER= SMS_API_KEY=
SHOPIFY_API_KEY= SHOPIFY_API_SECRET= SHOPIFY_API_VERSION= SHOPIFY_SCOPES=
COURIER_POLL_MINUTES=20
DZBUILD_API_BASE=https://api.dzbuild.app/v1    # per-merchant keys stored encrypted in DB
PAYMENT_GATEWAY= PAYMENT_GATEWAY_KEY= PAYMENT_GATEWAY_SECRET=   # SlickPay or Chargily (owner choice)
STRIPE_SECRET_KEY=                             # international clients
TELEGRAM_BOT_TOKEN=
PUBLIC_TRACKING_BASE_URL=
# Courier credentials are stored per merchant in the database (encrypted), never in env.
ANTHROPIC_API_KEY= ANTHROPIC_MODEL=
DEFAULT_TIMEZONE=Africa/Algiers
```

---

## 24. Seed data (for demos and tests)

- Orgs: "Agency HQ" (agency), "Store A" and "Store B" (merchants, managed), "SaaS Client" (merchant with own team).
- Users: platform admin, 1 supervisor, 2 pods (2 confirmation + 1 follow-up each), 1 warehouse user, 1 client viewer per managed merchant.
- 58 wilayas with codes and names (FR/AR).
- 6 products with sheets (cosmetics, clothing with size guide, electronics, kitchen, kids, car accessory).
- 200 orders spread across every status, with call attempts, courier events, returns and QA reviews, so dashboards and reports show real numbers on first run.

---

## 25. Out of scope for v1

- Building our own delivery fleet app (use courier integrations; local delivery-man assignment is a later module).
- Predictive dialer / auto-dialer.
- Native iOS app (web + Android companion only).
- Ads manager integration (Meta/TikTok spend import) — planned after v1 for cost per delivered order by campaign.

---

## 26. Open questions for the owner

Answer these before the phase that needs them:

1. Which couriers first, with a test account and API credentials for each (Yalidine API ID/token, EcoTrack bearer token + tenant host, ZR key + tenant ID, NOEST token + user GUID, Maystro token)? (Phase 4)
1a. Which merchants sell on DZBuild (they need DZBuild's Enterprise plan for API keys, or we register a DZBuild app on dzbuild.dev)? (Phase 2)
1c. Payment gateway for SaaS subscriptions: SlickPay or Chargily? (Phase 6)
1b. Shopify: a development store for testing, and whether v1 stays a custom app per store or goes public (needs protected-data review). Which COD form app the stores use, to prefill the field mapping. (Phase 2)
2. Telephony: mobile SIMs with the Android companion app, or a VoIP provider? Which one? (Phase 3)
3. SMS gateway provider? (Phase 3)
4. Default prices and pricing model for the managed service; billing period weekly or bi-weekly? (Phase 6)
5. SaaS plan limits and prices. (Phase 6)
6. Product name and brand (logo, colors) for the UI and client portal. (Phase 1, can be a placeholder)
7. Hosting target (VPS provider/region). (Phase 1)

---

## Appendix A — EcoTrack tenants (one adapter, different base host)

Names as listed by DZBuild's EcoTrack integration. Base host is `https://<tenant>.ecotrack.dz` except where noted; **confirm each tenant's exact host with the courier** when a merchant connects it (store it in `Courier.baseHost`).

| Known host | Company |
|---|---|
| `platform.dhd-dz.com` | DHD |
| `app.conexlog-dz.com` | Conexlog (UPS) |
| `*.ecotrack.dz` (confirm) | MSM Go, Rex Livraison, RB Livraison, Speed Delivery, Areex, Prest, Rocket Delivery, WorldExpress, BA Consult, Packers, 48Hr Livraison, Mono Hub, Anderson Delivery, GOLIVRI, Coyote Express, Salva Delivery, Distazero, FRET.Direct, TSL Express, Negmar Express, Ultra Express, OM Express, Med Express, Allo Livraison, Assil Delivery, Expedia Chrono, HHD Express, Imir Logistics, Navex Delivery, Swift Express, Univer Delivery, Colireli, FZ Delivery, Delivromail, PDEX, SI Express, Colex, OKS Box, Majorex, Chronorex, Samex, Aranex, Amana Speed, Wassim Express, One Express, AB Delivery, Royaume Delivery, Eco Rapide Express, SBL Express, Wee Wee Delivery, Jaguar Livraison, RJ 360 Express, Lynx Express, RM Express, Rihal Express, Atlas Express, Boogi Technologie, Cirta Express, Colizone, GS Ecommerce, Jo Express, On Time Express, Quick Delivery DZ, RS Express, Ruta Express, Tawsil Star, Vitrans, BFK Express, Alania Express, Champion Logistics, El Guide Delivery, Fast Horse Express, LIH LIH Express, Mazaya Logistics, Ovred, Speed Mail, Win Delivery, Zinya Tec, Sultan Colis Express, Red Ex |

The connect screen offers a searchable list of these names (pre-filling the host when known) plus a "custom EcoTrack host" option that only accepts HTTPS hosts on `*.ecotrack.dz` or the two known hosts above.
