import "./seed-env";
import type { CancelReason, OrderStatus, ReturnReason } from "@prisma/client";
import { prisma, withSystemContext } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { sha256Hex } from "@/lib/crypto";
import { WILAYAS } from "@/lib/wilayas";
import { resolveTenantContext, systemContext, type TenantContext } from "@/lib/tenant";
import { assignOrder, createOrder, proposeFakeOrder, transitionOrder } from "@/lib/orders/orderTransitions";
import { addDays, addHours } from "@/lib/time";
import { planAttempt } from "@/lib/calls/slots";
import { topUpCredits } from "@/lib/messaging/credits";
import { DEFAULT_ORG_SETTINGS } from "@/lib/settings";
import { COMMUNES, FIRST_NAMES, LANDMARKS, LAST_NAMES, PRODUCTS, STATUS_DISTRIBUTION, WILAYA_WEIGHTS, type ProductSeed } from "./seed-data";

/**
 * Demo / test seed (section 24). Deterministic (seeded PRNG). Every order is driven to its target
 * status THROUGH the transitions service, so the audit log, call attempts and tasks are real.
 *
 * Logins (password for all: `password123`):
 *   admin@demo.local (platform admin + owner of Agency HQ), supervisor@demo.local,
 *   agent1a@/agent1b@/followup1@ (Pod 1 → Store A), agent2a@/agent2b@/followup2@ (Pod 2 → Store B),
 *   warehouse@demo.local, client-a@demo.local, client-b@demo.local,
 *   saas-owner@demo.local, saas-agent@demo.local, saas-followup@demo.local (SaaS Client, own team)
 * Demo API keys: `ck_demo_agency.demo-secret-agency-hq-change-me`, `ck_demo_saas.demo-secret-saas-client-change-me`
 */

// ─── deterministic PRNG ───
let seedState = 20261008;
function rand(): number {
  seedState = (seedState + 0x6d2b79f5) | 0;
  let t = seedState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)] as T;
const randInt = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
function weightedWilaya(): number {
  const total = WILAYA_WEIGHTS.reduce((a, [, w]) => a + w, 0);
  let r = rand() * total;
  for (const [code, w] of WILAYA_WEIGHTS) {
    r -= w;
    if (r <= 0) return code;
  }
  return 16;
}
const randomPhone = () => `0${pick(["5", "6", "7"])}${String(randInt(10_000_000, 99_999_999))}`;

const PASSWORD = "password123";
const SYSTEM = systemContext("seed");

async function main() {
  console.log("Seeding…");
  const passwordHash = hashPassword(PASSWORD);

  // ─── plans ───
  const starter = await prisma.plan.create({ data: { name: "Starter", monthlyPrice: 4900, maxOrders: 1000, maxUsers: 3, maxStores: 1, features: ["orders", "api"] } });
  const pro = await prisma.plan.create({ data: { name: "Pro", monthlyPrice: 14900, maxOrders: 10000, maxUsers: 15, maxStores: 5, features: ["orders", "api", "bot_confirmation", "multi_warehouse"] } });

  // ─── organizations ───
  const agency = await prisma.organization.create({ data: { type: "AGENCY", name: "Agency HQ", slug: "agency-hq", locale: "fr", settings: { minAnsweredCallSec: 15, highValueThreshold: 15000 } } });
  const storeA = await prisma.organization.create({ data: { type: "MERCHANT", name: "Store A", slug: "store-a", locale: "fr" } });
  const storeB = await prisma.organization.create({ data: { type: "MERCHANT", name: "Store B", slug: "store-b", locale: "ar" } });
  const saas = await prisma.organization.create({ data: { type: "MERCHANT", name: "SaaS Client", slug: "saas-client", locale: "ar", planId: pro.id } });
  void starter;

  await prisma.serviceContract.createMany({
    data: [
      { agencyId: agency.id, merchantId: storeA.id, package: "FULL_COD_OPS", pricingModel: "PER_DELIVERED", unitPrice: 250, minMonthly: 20000, status: "ACTIVE", startsAt: addDays(new Date(), -90) },
      { agencyId: agency.id, merchantId: storeB.id, package: "CONFIRMATION_FOLLOWUP", pricingModel: "PER_DELIVERED", unitPrice: 200, status: "ACTIVE", startsAt: addDays(new Date(), -45) },
    ],
  });

  // ─── pods ───
  const pod1 = await prisma.pod.create({ data: { orgId: agency.id, name: "Pod 1", merchants: { create: [{ merchantId: storeA.id }] } } });
  const pod2 = await prisma.pod.create({ data: { orgId: agency.id, name: "Pod 2", merchants: { create: [{ merchantId: storeB.id }] } } });
  const saasPod = await prisma.pod.create({ data: { orgId: saas.id, name: "Équipe interne", merchants: { create: [{ merchantId: saas.id }] } } });

  // ─── users ───
  type Spec = { email: string; name: string; orgId: string; role: "PLATFORM_ADMIN" | "ORG_OWNER" | "SUPERVISOR" | "FOLLOWUP_AGENT" | "CONFIRMATION_AGENT" | "WAREHOUSE" | "CLIENT_VIEWER" | "MARKETER"; podId?: string; locale?: string; platformAdmin?: boolean };
  const specs: Spec[] = [
    { email: "admin@demo.local", name: "Oussama (Owner)", orgId: agency.id, role: "ORG_OWNER", platformAdmin: true, locale: "fr" },
    { email: "supervisor@demo.local", name: "Nadia Supervisor", orgId: agency.id, role: "SUPERVISOR", locale: "fr" },
    { email: "agent1a@demo.local", name: "Amine Agent", orgId: agency.id, role: "CONFIRMATION_AGENT", podId: pod1.id, locale: "ar" },
    { email: "agent1b@demo.local", name: "Sarah Agent", orgId: agency.id, role: "CONFIRMATION_AGENT", podId: pod1.id, locale: "ar" },
    { email: "followup1@demo.local", name: "Karim Suivi", orgId: agency.id, role: "FOLLOWUP_AGENT", podId: pod1.id, locale: "fr" },
    { email: "agent2a@demo.local", name: "Yasmine Agent", orgId: agency.id, role: "CONFIRMATION_AGENT", podId: pod2.id, locale: "ar" },
    { email: "agent2b@demo.local", name: "Bilal Agent", orgId: agency.id, role: "CONFIRMATION_AGENT", podId: pod2.id, locale: "ar" },
    { email: "followup2@demo.local", name: "Lina Suivi", orgId: agency.id, role: "FOLLOWUP_AGENT", podId: pod2.id, locale: "fr" },
    { email: "warehouse@demo.local", name: "Rachid Dépôt", orgId: agency.id, role: "WAREHOUSE", locale: "fr" },
    { email: "client-a@demo.local", name: "Client Store A", orgId: storeA.id, role: "CLIENT_VIEWER", locale: "fr" },
    { email: "client-b@demo.local", name: "Client Store B", orgId: storeB.id, role: "CLIENT_VIEWER", locale: "ar" },
    { email: "marketer-a@demo.local", name: "Marketer Store A", orgId: storeA.id, role: "MARKETER", locale: "fr" },
    { email: "saas-owner@demo.local", name: "Walid (SaaS owner)", orgId: saas.id, role: "ORG_OWNER", locale: "ar" },
    { email: "saas-agent@demo.local", name: "Imane Agent", orgId: saas.id, role: "CONFIRMATION_AGENT", podId: saasPod.id, locale: "ar" },
    { email: "saas-followup@demo.local", name: "Hamza Suivi", orgId: saas.id, role: "FOLLOWUP_AGENT", podId: saasPod.id, locale: "ar" },
  ];
  const users: Record<string, { id: string }> = {};
  for (const s of specs) {
    const u = await prisma.user.create({
      data: {
        email: s.email,
        name: s.name,
        passwordHash,
        locale: s.locale ?? "fr",
        isPlatformAdmin: s.platformAdmin ?? false,
        memberships: { create: { orgId: s.orgId, role: s.role, podId: s.podId, availability: s.role.endsWith("AGENT") ? "AVAILABLE" : "OFFLINE" } },
      },
    });
    users[s.email] = u;
  }
  await prisma.pod.update({ where: { id: pod1.id }, data: { followUpUserId: users["followup1@demo.local"]!.id } });
  await prisma.pod.update({ where: { id: pod2.id }, data: { followUpUserId: users["followup2@demo.local"]!.id } });
  await prisma.pod.update({ where: { id: saasPod.id }, data: { followUpUserId: users["saas-followup@demo.local"]!.id } });

  // shifts: Saturday→Thursday 09:00–17:00 for agents, evening team 13:00–21:00 for pod 2
  for (const s of specs.filter((x) => x.role.endsWith("AGENT"))) {
    const evening = s.podId === pod2.id;
    for (const weekday of [6, 0, 1, 2, 3, 4]) {
      await prisma.shift.create({ data: { orgId: s.orgId, userId: users[s.email]!.id, weekday, startMin: evening ? 13 * 60 : 9 * 60, endMin: evening ? 21 * 60 : 17 * 60 } });
    }
  }

  // outbound numbers A/B/C
  await prisma.outboundNumber.createMany({
    data: [
      { orgId: agency.id, label: "A", msisdn: "0550000001", answerRate: 0.62 },
      { orgId: agency.id, label: "B", msisdn: "0660000002", answerRate: 0.58 },
      { orgId: agency.id, label: "C", msisdn: "0770000003", answerRate: 0.41 },
      { orgId: saas.id, label: "A", msisdn: "0551112233" },
    ],
  });
  const numbers = await prisma.outboundNumber.findMany({ where: { orgId: agency.id }, orderBy: { label: "asc" } });

  // ─── demo API keys (fixed secrets, local development only) ───
  await prisma.apiKey.createMany({
    data: [
      { orgId: agency.id, name: "Demo key (Agency HQ)", keyId: "ck_demo_agency", secretHash: sha256Hex("demo-secret-agency-hq-change-me"), scopes: ["orders:read", "orders:write", "customers:read", "products:read"], createdById: users["admin@demo.local"]!.id },
      { orgId: saas.id, name: "Demo key (SaaS Client)", keyId: "ck_demo_saas", secretHash: sha256Hex("demo-secret-saas-client-change-me"), scopes: ["orders:read"], createdById: users["saas-owner@demo.local"]!.id },
    ],
  });

  // ─── wilayas + chef-lieu communes ───
  await prisma.wilaya.createMany({ data: WILAYAS.map((w) => ({ code: w.code, nameFr: w.nameFr, nameAr: w.nameAr })) });
  await prisma.commune.createMany({ data: WILAYAS.map((w) => ({ wilayaCode: w.code, nameFr: w.nameFr, nameAr: w.nameAr })) });
  for (const [code, names] of Object.entries(COMMUNES)) {
    const w = WILAYAS.find((x) => x.code === Number(code))!;
    await prisma.commune.createMany({ data: names.filter((n) => n !== w.nameFr).map((n) => ({ wilayaCode: w.code, nameFr: n, nameAr: n })), skipDuplicates: true });
  }

  // ─── stores ───
  const stores = {
    aShopify: await prisma.store.create({ data: { merchantId: storeA.id, name: "Store A — Shopify", channel: "SHOPIFY" } }),
    aLanding: await prisma.store.create({ data: { merchantId: storeA.id, name: "Store A — Landing pages", channel: "GOOGLE_SHEET" } }),
    bDzbuild: await prisma.store.create({ data: { merchantId: storeB.id, name: "Store B — DZBuild", channel: "DZBUILD" } }),
    saasWoo: await prisma.store.create({ data: { merchantId: saas.id, name: "SaaS — WooCommerce", channel: "WOOCOMMERCE" } }),
    saasManual: await prisma.store.create({ data: { merchantId: saas.id, name: "SaaS — Saisie manuelle", channel: "MANUAL" } }),
  };

  // ─── products + sheets + stock ───
  async function createProducts(merchantId: string, warehouseName: string, list: ProductSeed[]) {
    const wh = await prisma.warehouse.create({ data: { merchantId, name: warehouseName, wilayaCode: 16 } });
    const out: Array<{ id: string; key: string; price: number; variants: Array<{ id: string; name: string }> }> = [];
    for (const p of list) {
      const product = await prisma.product.create({
        data: {
          merchantId,
          sku: p.sku,
          name: p.name,
          price: p.price,
          costPrice: p.costPrice,
          variants: p.variants ? { create: p.variants.map((v) => ({ name: v, sku: `${p.sku}-${v}` })) } : undefined,
          sheet: {
            create: {
              sellingPoints: p.sheet.sellingPoints,
              sizeGuide: p.sheet.sizeGuide,
              faq: p.sheet.faq,
              scriptAr: p.sheet.scriptAr,
              scriptFr: p.sheet.scriptFr,
              approvedByMerchantAt: p.key === "playmat" ? null : addDays(new Date(), -20),
            },
          },
        },
        include: { variants: true },
      });
      if (p.key !== "playmat") {
        if (product.variants.length > 0) {
          for (const v of product.variants) {
            await prisma.stockItem.create({ data: { warehouseId: wh.id, productId: product.id, variantId: v.id, onHand: randInt(10, 60), reserved: 0 } });
          }
        } else {
          await prisma.stockItem.create({ data: { warehouseId: wh.id, productId: product.id, onHand: randInt(20, 120), reserved: 0 } });
        }
      }
      out.push({ id: product.id, key: p.key, price: p.price, variants: product.variants.map((v) => ({ id: v.id, name: v.name })) });
    }
    return out;
  }
  const productsA = await createProducts(storeA.id, "Dépôt Alger (Agency)", PRODUCTS.storeA);
  const productsB = await createProducts(storeB.id, "Dépôt Store B", PRODUCTS.storeB);
  const productsSaas = await createProducts(saas.id, "Dépôt SaaS Client", PRODUCTS.saas);

  // ─── couriers (mock providers; real adapters arrive in phase 4) ───
  const courierA = await prisma.courier.create({ data: { merchantId: storeA.id, provider: "mock:yalidine", family: "MOCK", name: "Yalidine (mock)", isDefault: true, originWilaya: 16 } });
  const courierB = await prisma.courier.create({ data: { merchantId: storeB.id, provider: "mock:zr", family: "MOCK", name: "ZR Express (mock)", isDefault: true, originWilaya: 16 } });
  const courierS = await prisma.courier.create({ data: { merchantId: saas.id, provider: "mock:ecotrack", family: "MOCK", name: "DHD (mock)", isDefault: true, originWilaya: 16 } });
  await prisma.courierRoute.createMany({
    data: [
      { merchantId: storeA.id, courierId: courierA.id },
      { merchantId: storeB.id, courierId: courierB.id },
      { merchantId: saas.id, courierId: courierS.id },
    ],
  });

  // ─── contexts for actors ───
  const ctxOf = async (email: string): Promise<TenantContext> => {
    const ctx = await resolveTenantContext(users[email]!.id);
    if (!ctx) throw new Error(`no context for ${email}`);
    return ctx;
  };
  const supervisor = await ctxOf("supervisor@demo.local");
  const warehouse = await ctxOf("warehouse@demo.local");
  const saasOwner = await ctxOf("saas-owner@demo.local");
  const agentCtx: Record<string, TenantContext> = {};
  for (const e of ["agent1a@demo.local", "agent1b@demo.local", "agent2a@demo.local", "agent2b@demo.local", "saas-agent@demo.local"]) agentCtx[e] = await ctxOf(e);
  const followupCtx = { pod1: await ctxOf("followup1@demo.local"), pod2: await ctxOf("followup2@demo.local") };

  type MerchantSetup = { merchantId: string; stores: string[]; products: typeof productsA; agents: string[]; courierId: string; supervisor: TenantContext; warehouse: TenantContext; shippingFee: number };
  const merchants: MerchantSetup[] = [
    { merchantId: storeA.id, stores: [stores.aShopify.id, stores.aShopify.id, stores.aLanding.id], products: productsA, agents: ["agent1a@demo.local", "agent1b@demo.local"], courierId: courierA.id, supervisor, warehouse, shippingFee: 500 },
    { merchantId: storeB.id, stores: [stores.bDzbuild.id], products: productsB, agents: ["agent2a@demo.local", "agent2b@demo.local"], courierId: courierB.id, supervisor, warehouse, shippingFee: 600 },
    { merchantId: saas.id, stores: [stores.saasWoo.id, stores.saasManual.id], products: productsSaas, agents: ["saas-agent@demo.local"], courierId: courierS.id, supervisor: saasOwner, warehouse: saasOwner, shippingFee: 400 },
  ];
  const merchantWeights = [0.55, 0.3, 0.15];
  const pickMerchant = () => {
    const r = rand();
    return r < merchantWeights[0]! ? merchants[0]! : r < merchantWeights[0]! + merchantWeights[1]! ? merchants[1]! : merchants[2]!;
  };

  // ─── helpers driving the state machine ───
  const CANCEL_REASONS: CancelReason[] = ["CHANGED_MIND", "PRICE_TOO_HIGH", "SHIPPING_FEE", "BOUGHT_ELSEWHERE", "PRODUCT_DOUBT", "WRONG_PRODUCT_OR_SIZE", "DELIVERY_TOO_SLOW"];
  const RETURN_REASONS: ReturnReason[] = ["PRICE_SHOCK", "NOT_AS_EXPECTED", "CLIENT_UNREACHABLE", "WRONG_ADDRESS", "DELIVERY_DELAY", "CLIENT_ABSENT"];
  const checklist = { productExplained: true, totalStated: true, addressVerified: true, variantVerified: true, explicitYes: true } as const;

  // Call times follow the 3×3 cadence (slots, blocked windows, spacing) like real attempts would.
  const callTimes = new Map<string, Date[]>();
  const orderCreated = new Map<string, Date>();
  async function logCall(agent: TenantContext, orderId: string, outcome: "ANSWERED" | "NO_ANSWER" | "BUSY" | "OFF" | "WRONG_NUMBER", _hint: Date, attemptCount: number) {
    const to = `APPEL_${(attemptCount % 3) + 1}` as OrderStatus;
    const previous = callTimes.get(orderId) ?? [];
    const startedAt = planAttempt({ attemptNo: attemptCount + 1, previous, orderCreatedAt: orderCreated.get(orderId) ?? addDays(new Date(), -3), cfg: DEFAULT_ORG_SETTINGS.calls, tz: "Africa/Algiers" });
    if (startedAt.getTime() > Date.now()) throw new Error(`seed: planned attempt in the future for ${orderId}`);
    callTimes.set(orderId, [...previous, startedAt]);
    const number = numbers[attemptCount % numbers.length];
    return transitionOrder(agent, {
      orderId,
      to,
      payload: { call: { outcome, proof: pick(["DEVICE_LOG", "DEVICE_LOG", "VOIP_LOG"]), startedAt, durationSec: outcome === "ANSWERED" ? randInt(25, 180) : 0, phoneNumberId: agent.orgId === agency.id ? number?.id : undefined } },
    });
  }

  async function driveToConfirmed(m: MerchantSetup, agent: TenantContext, orderId: string, createdAt: Date, bot = false) {
    if (bot) {
      await transitionOrder(SYSTEM, { orderId, to: "CONFIRMEE_BOT", payload: { messageId: `wamid.${randInt(1000, 9999)}` } });
      return;
    }
    const attempts = randInt(1, 3);
    for (let i = 0; i < attempts - 1; i++) await logCall(agent, orderId, pick(["NO_ANSWER", "BUSY"]), addHours(createdAt, 1 + i * 3), i);
    await logCall(agent, orderId, "ANSWERED", addHours(createdAt, 1 + (attempts - 1) * 3), attempts - 1);
    await transitionOrder(agent, { orderId, to: "CONFIRMEE", payload: { checklist } });
  }

  async function driveToShipped(m: MerchantSetup, orderId: string, createdAt: Date) {
    await transitionOrder(m.warehouse, { orderId, to: "PRET_A_EXPEDIER", payload: {} });
    const tracking = `${m.courierId === courierA.id ? "yal" : m.courierId === courierB.id ? "zr" : "eco"}-${randInt(100000000, 999999999)}`;
    await transitionOrder(SYSTEM, { orderId, to: "EXPEDIE", payload: { trackingNumber: tracking, courierId: m.courierId } });
    await prisma.courierEvent.create({ data: { orderId, provider: "mock", rawStatus: "Ramassé", mappedStatus: "EXPEDIE", payload: { tracking }, receivedAt: addHours(createdAt, 30) } });
  }

  async function courierSync(orderId: string, to: OrderStatus, raw: string, at: Date) {
    await prisma.courierEvent.create({ data: { orderId, provider: "mock", rawStatus: raw, mappedStatus: to, payload: {}, receivedAt: at } });
    await transitionOrder(SYSTEM, { orderId, to, payload: { provider: "mock", rawStatus: raw } });
  }

  // ─── orders ───
  const targets: OrderStatus[] = [];
  for (const [status, n] of STATUS_DISTRIBUTION) for (let i = 0; i < n; i++) targets.push(status as OrderStatus);
  // shuffle deterministically
  for (let i = targets.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [targets[i], targets[j]] = [targets[j]!, targets[i]!];
  }

  const now = new Date();
  const confirmedCallIds: Array<{ callId: string; pod: "pod1" | "pod2"; cancelled: boolean }> = [];
  let created = 0;
  const customerPool: Array<{ merchantId: string; phone: string; name: string }> = [];

  for (const target of targets) {
    const m = pickMerchant();
    const wilayaCode = weightedWilaya();
    const product = pick(m.products);
    const variant = product.variants.length > 0 ? pick(product.variants) : null;
    const qty = rand() < 0.85 ? 1 : 2;
    const name = `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
    // ~15 % repeat customers
    const repeat = customerPool.filter((c) => c.merchantId === m.merchantId);
    const cust = repeat.length > 3 && rand() < 0.15 ? pick(repeat) : { merchantId: m.merchantId, phone: randomPhone(), name };
    customerPool.push(cust);
    const ageDays =
      target === "NOUVEAU" || target === "ASSIGNEE"
        ? rand() * 0.5
        : target.startsWith("APPEL")
          ? 1.3 + rand() * 0.7
          : target === "INJOIGNABLE" || target === "EXPIREE"
            ? 6 + rand() * 20
            : rand() * 28 + 2;
    const createdAt = new Date(now.getTime() - ageDays * 86_400_000);
    const communes = COMMUNES[wilayaCode];

    const order = await createOrder(SYSTEM, {
      merchantId: m.merchantId,
      storeId: pick(m.stores),
      externalId: `${pick(["#", "DZ-", "WC-"])}${1000 + created}`,
      customer: { name: cust.name, phone: cust.phone, phone2: rand() < 0.3 ? randomPhone() : null },
      wilaya: wilayaCode,
      commune: communes ? pick(communes) : WILAYAS.find((w) => w.code === wilayaCode)?.nameFr,
      address: `Cité ${randInt(20, 1200)} logements, Bt ${String.fromCharCode(65 + randInt(0, 8))} n°${randInt(1, 40)}`,
      landmark: pick(LANDMARKS),
      deliveryType: rand() < 0.25 ? "STOP_DESK" : "HOME",
      items: [{ productId: product.id, variantId: variant?.id ?? null, qty }],
      shippingFee: m.shippingFee,
      source: pick(["facebook_ads", "tiktok_ads", "instagram", "organic", "google"]),
      createdAt,
      skipDuplicateCheck: true,
    });
    created++;
    orderCreated.set(order.id, createdAt);

    if (target === "NOUVEAU") continue;

    // DOUBLE: create a second identical order right after, without skipping detection
    if (target === "DOUBLE") {
      await createOrder(SYSTEM, {
        merchantId: m.merchantId,
        storeId: order.storeId,
        customer: { name: cust.name, phone: cust.phone },
        wilaya: wilayaCode,
        commune: order.commune,
        address: order.address,
        items: [{ productId: product.id, variantId: variant?.id ?? null, qty }],
        shippingFee: m.shippingFee,
        source: "facebook_ads",
        createdAt: addHours(createdAt, 1),
      });
      created++;
      continue;
    }

    const agentEmail = pick(m.agents);
    const agent = agentCtx[agentEmail]!;
    await assignOrder(SYSTEM, { orderId: order.id, toUserId: agent.userId, rule: "ROUND_ROBIN" });
    if (target === "ASSIGNEE") continue;

    switch (target) {
      case "APPEL_1":
      case "APPEL_2":
      case "APPEL_3": {
        const n = Number(target.slice(-1));
        for (let i = 0; i < n; i++) await logCall(agent, order.id, pick(["NO_ANSWER", "NO_ANSWER", "BUSY", "OFF"]), addHours(createdAt, 1 + i * 3), i);
        break;
      }
      case "REPORTE":
        await logCall(agent, order.id, "ANSWERED", addHours(createdAt, 1), 0);
        await transitionOrder(agent, { orderId: order.id, to: "REPORTE", payload: { postponedUntil: addDays(now, randInt(1, 6)), reason: pick(["Client en voyage", "Rappeler après le salaire", "Demande à réfléchir"]) } });
        break;
      case "A_VERIFIER":
        await logCall(agent, order.id, pick(["ANSWERED", "WRONG_NUMBER"]), addHours(createdAt, 1), 0);
        await transitionOrder(agent, { orderId: order.id, to: "A_VERIFIER", payload: { comment: pick(["Adresse incomplète, commune introuvable", "Le client dit avoir commandé 2 pièces", "Numéro 2 ne répond pas, vérifier wilaya"]) } });
        break;
      case "CONFIRMEE":
        await driveToConfirmed(m, agent, order.id, createdAt);
        break;
      case "CONFIRMEE_REPORTEE":
        await logCall(agent, order.id, "ANSWERED", createdAt, 0);
        await transitionOrder(agent, { orderId: order.id, to: "CONFIRMEE_REPORTEE", payload: { checklist, deliverOn: addDays(now, randInt(1, 5)), note: "Client en déplacement, livrer après son retour" } });
        break;
      case "EXPIREE":
        for (let i = 0; i < 4; i++) await logCall(agent, order.id, pick(["NO_ANSWER", "BUSY", "OFF"]), createdAt, i);
        await transitionOrder(SYSTEM, { orderId: order.id, to: "EXPIREE", payload: { job: "seed" } });
        break;
      case "CONFIRMEE_BOT":
        await driveToConfirmed(m, agent, order.id, createdAt, true);
        break;
      case "CONFIRMEE_RUPTURE": {
        // the kids playmat has no stock rows → available = 0
        const playmat = productsB.find((p) => p.key === "playmat");
        if (playmat && m.merchantId === storeB.id) {
          await logCall(agent, order.id, "ANSWERED", addHours(createdAt, 1), 0);
          await transitionOrder(agent, { orderId: order.id, to: "CONFIRMEE_RUPTURE", payload: { checklist } });
        } else {
          // other merchants: re-point the order's item to a zero-stock state by consuming stock
          const items = await prisma.orderItem.findMany({ where: { orderId: order.id } });
          for (const it of items) {
            await prisma.stockItem.updateMany({ where: { productId: it.productId, variantId: it.variantId ?? undefined }, data: { reserved: 999, onHand: 999 } });
          }
          await logCall(agent, order.id, "ANSWERED", addHours(createdAt, 1), 0);
          await transitionOrder(agent, { orderId: order.id, to: "CONFIRMEE_RUPTURE", payload: { checklist } });
          for (const it of items) {
            await prisma.stockItem.updateMany({ where: { productId: it.productId, variantId: it.variantId ?? undefined }, data: { reserved: 0, onHand: randInt(10, 60) } });
          }
        }
        break;
      }
      case "ANNULEE": {
        await logCall(agent, order.id, "ANSWERED", addHours(createdAt, 1), 0);
        const reason = pick(CANCEL_REASONS);
        const t = await transitionOrder(agent, { orderId: order.id, to: "ANNULEE", payload: { cancelReason: reason, reasonNote: rand() < 0.5 ? "Client a dit non après le prix" : undefined } });
        void t;
        break;
      }
      case "FAUSSE_COMMANDE":
        if (rand() < 0.5) {
          await logCall(agent, order.id, "WRONG_NUMBER", createdAt, 0);
          await proposeFakeOrder(agent, { orderId: order.id, note: "Numéro inexistant", fakeReason: "INVALID_PHONE" });
          await transitionOrder(m.supervisor, { orderId: order.id, to: "FAUSSE_COMMANDE", payload: { fakeReason: "INVALID_PHONE", note: "Vérifié: faux numéro", blacklistRequest: rand() < 0.5 } });
        } else {
          for (let i = 0; i < 4; i++) await logCall(agent, order.id, i === 3 ? "ANSWERED" : "NO_ANSWER", createdAt, i);
          await proposeFakeOrder(agent, { orderId: order.id, note: "Le client dit n'avoir rien commandé", fakeReason: "DID_NOT_ORDER" });
          await transitionOrder(m.supervisor, { orderId: order.id, to: "FAUSSE_COMMANDE", payload: { fakeReason: "DID_NOT_ORDER", note: "Confirmé par rappel" } });
        }
        break;
      case "INJOIGNABLE": {
        // 9 attempts over 3 days; day 2+ by the other agent of the pod (agent rotation)
        const other = m.agents.length > 1 ? agentCtx[m.agents.find((a) => a !== agentEmail)!]! : agent;
        for (let i = 0; i < 9; i++) {
          const day = Math.floor(i / 3);
          const who = day === 0 ? agent : other;
          if (i === 3) await assignOrder(SYSTEM, { orderId: order.id, toUserId: other.userId, rule: "AGENT_ROTATION_DAY2" });
          await logCall(who, order.id, pick(["NO_ANSWER", "NO_ANSWER", "OFF", "BUSY"]), addHours(createdAt, 2 + day * 24 + (i % 3) * 3), i);
        }
        await transitionOrder(SYSTEM, { orderId: order.id, to: "INJOIGNABLE", payload: {} });
        break;
      }
      default: {
        // everything from PRET_A_EXPEDIER onward starts with a confirmed order
        await driveToConfirmed(m, agent, order.id, createdAt, rand() < 0.1);
        if (target === "PRET_A_EXPEDIER") {
          await transitionOrder(m.warehouse, { orderId: order.id, to: "PRET_A_EXPEDIER", payload: {} });
          break;
        }
        await driveToShipped(m, order.id, createdAt);
        if (target === "EXPEDIE") break;
        await courierSync(order.id, "ARRIVE_WILAYA", "Arrivé au centre de livraison", addHours(createdAt, 48));
        if (target === "ARRIVE_WILAYA") break;
        if (target === "STOP_DESK") {
          await courierSync(order.id, "STOP_DESK", "En attente au bureau", addHours(createdAt, 60));
          break;
        }
        await courierSync(order.id, "EN_LIVRAISON", "Sorti en livraison", addHours(createdAt, 60));
        if (target === "EN_LIVRAISON") break;
        if (["CLIENT_INJOIGNABLE_LIVREUR", "REPORTE_CLIENT", "ADRESSE_ERRONEE", "TENTATIVE_ECHOUEE", "REFUSE", "ALERTE"].includes(target)) {
          await courierSync(order.id, target, `Livreur: ${target}`, addHours(createdAt, 66));
          break;
        }
        if (target === "LIVRE" || target === "ENCAISSE") {
          await courierSync(order.id, "LIVRE", "Livré", addHours(createdAt, 70));
          if (target === "ENCAISSE") await transitionOrder(m.supervisor, { orderId: order.id, to: "ENCAISSE", payload: { amount: order.total } });
          break;
        }
        // returns
        await courierSync(order.id, "REFUSE", "Refusé par le client", addHours(createdAt, 66));
        await transitionOrder(SYSTEM, { orderId: order.id, to: "RETOUR_EN_COURS", payload: { returnReason: pick(RETURN_REASONS) } });
        if (target === "RETOUR_EN_COURS") break;
        if (target === "PERDU_ENDOMMAGE") {
          await transitionOrder(SYSTEM, { orderId: order.id, to: "PERDU_ENDOMMAGE", payload: { note: "Aucune mise à jour depuis 7 jours, réclamation ouverte" } });
          break;
        }
        await transitionOrder(m.warehouse, { orderId: order.id, to: "RETOUR_RECU", payload: { condition: pick(["OK", "OK", "DAMAGED"]) } });
      }
    }

    // collect calls for QA samples
    const answered = await prisma.callAttempt.findFirst({ where: { orderId: order.id, outcome: "ANSWERED" }, select: { id: true } });
    if (answered && m.merchantId !== saas.id) {
      confirmedCallIds.push({ callId: answered.id, pod: m.merchantId === storeA.id ? "pod1" : "pod2", cancelled: target === "ANNULEE" });
    }
  }

  // ─── QA reviews (section 14) on a sample of answered calls ───
  const criteria = ["greeting", "orderReminder", "productExplanation", "priceStated", "infoVerified", "closing", "respect"];
  const maxima = [1, 1, 2, 2, 2, 1, 1];
  let reviews = 0;
  for (const c of confirmedCallIds) {
    if (rand() > 0.5) continue;
    const scores: Record<string, number> = {};
    let total = 0;
    criteria.forEach((k, i) => {
      const v = rand() < 0.8 ? maxima[i]! : Math.max(0, maxima[i]! - 1);
      scores[k] = v;
      total += v;
    });
    const zeroed = rand() < 0.04;
    const reviewer = c.pod === "pod1" ? followupCtx.pod1 : followupCtx.pod2;
    await prisma.qaReview.create({ data: { callId: c.callId, reviewerId: reviewer.userId, scores, total: zeroed ? 0 : total, zeroed, note: zeroed ? "Frais de livraison non annoncés" : pick(["Bon appel", "Doit dire le total avant de demander la confirmation", "Clôture faible (inchallah)"]) } });
    await prisma.callAttempt.update({ where: { id: c.callId, orderId: { not: "" } }, data: { qaScore: zeroed ? 0 : total } });
    reviews++;
  }

  // ─── backdate event timestamps so timelines look real ───
  const orders = await prisma.order.findMany({ select: { id: true, createdAt: true, status: true }, where: { merchantId: { not: "" } } });
  for (const o of orders) {
    const events = await prisma.orderEvent.findMany({ where: { orderId: o.id }, orderBy: { createdAt: "asc" }, select: { id: true } });
    for (let i = 0; i < events.length; i++) {
      await prisma.orderEvent.update({ where: { id: events[i]!.id, orderId: o.id }, data: { createdAt: addHours(o.createdAt, i * 5 + (i === 0 ? 0 : 1)) } });
    }
    const last = addHours(o.createdAt, Math.max(1, events.length * 5));
    const patch: Record<string, Date> = { lastActivityAt: last };
    const detail = await prisma.order.findFirst({ where: { id: o.id, merchantId: { not: "" } }, select: { confirmedAt: true, shippedAt: true, deliveredAt: true, returnedAt: true, cashCollectedAt: true } });
    if (detail?.confirmedAt) patch.confirmedAt = addHours(o.createdAt, 4);
    if (detail?.shippedAt) patch.shippedAt = addHours(o.createdAt, 28);
    if (detail?.deliveredAt) patch.deliveredAt = addHours(o.createdAt, 70);
    if (detail?.returnedAt) patch.returnedAt = addHours(o.createdAt, 120);
    if (detail?.cashCollectedAt) patch.cashCollectedAt = addHours(o.createdAt, 200);
    await prisma.order.update({ where: { id: o.id, merchantId: { not: "" } }, data: patch });
  }

  // ─── messaging credits (section 19b.1) and bot confirmation on the SaaS client ───
  for (const m of [storeA, storeB, saas]) await topUpCredits(m.id, 1000, { note: "seed" });
  await prisma.organization.update({ where: { id: saas.id }, data: { settings: { messaging: { botConfirmation: true } } } });
  // a paired demo device for agent1a (token printed below, local only)
  await prisma.deviceToken.create({ data: { userId: users["agent1a@demo.local"]!.id, orgId: agency.id, name: "Demo Android", tokenHash: sha256Hex("dev_demo_agent1a") } });

  // public tracking demo: /fr/t/demo-tracking-0001
  const shippedDemo = await prisma.order.findFirst({ where: { status: "EN_LIVRAISON", merchantId: storeA.id } });
  if (shippedDemo) await prisma.order.update({ where: { id: shippedDemo.id, merchantId: storeA.id }, data: { trackingToken: "demo-tracking-0001" } });

  const byStatus = await prisma.order.groupBy({ by: ["status"], _count: { _all: true }, where: { merchantId: { not: "" } } });
  console.log(`Seeded ${orders.length} orders, ${reviews} QA reviews.`);
  console.table(Object.fromEntries(byStatus.map((b) => [b.status, b._count._all])));
}

withSystemContext("seed", main)
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
