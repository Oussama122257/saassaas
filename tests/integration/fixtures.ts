import { prisma, withSystemContext } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { sha256Hex } from "@/lib/crypto";
import { resolveTenantContext, systemContext, type TenantContext } from "@/lib/tenant";
import { createOrder } from "@/lib/orders/orderTransitions";

/**
 * Minimal multi-tenant world:
 *  Agency HQ ──contract──► Merchant A (pod 1: agentA1, agentA2, followupA)
 *  Agency HQ ──contract──► Merchant B (pod 2: agentB1, followupB)
 *  Other Agency (no contract with anyone) with its own supervisor
 *  SaaS merchant with its own owner
 */
export interface World {
  agency: { id: string };
  otherAgency: { id: string };
  merchantA: { id: string; storeId: string; productId: string; variantId: string | null };
  merchantB: { id: string; storeId: string; productId: string };
  saas: { id: string; storeId: string; productId: string };
  users: Record<"admin" | "supervisor" | "agentA1" | "agentA2" | "followupA" | "agentB1" | "followupB" | "warehouse" | "clientA" | "otherSupervisor" | "saasOwner", { id: string; email: string }>;
  ctx: Record<"admin" | "supervisor" | "agentA1" | "agentA2" | "followupA" | "agentB1" | "followupB" | "warehouse" | "clientA" | "otherSupervisor" | "saasOwner", TenantContext>;
  pods: { pod1: string; pod2: string };
  apiKeys: { agency: string; merchantB: string; saas: string };
}

export const SYSTEM = systemContext("test");

export const PERMISSIVE_SETTINGS = {
  calls: { strictSlots: false, dayStartMin: 0, dayEndMin: 1440, prayerWindows: [], fridayBlock: null, minAttemptGapMin: 0, minSlotsToClose: 1, minSpacedAttemptsToClose: 1 },
};

/** Restore the spec defaults (slots, blocked windows, 30-min spacing) on the agency. */
export async function setAgencySettings(w: World, settings: Record<string, unknown>): Promise<void> {
  await withSystemContext("fixtures", () => prisma.organization.update({ where: { id: w.agency.id }, data: { settings: settings as object } }));
}

export async function createWorld(): Promise<World> {
  return withSystemContext("fixtures", async () => {
    const passwordHash = hashPassword("password123");
    // Permissive call engine for the generic tests (calls at any time, no spacing); the phase-2
    // acceptance tests switch the agency back to the strict defaults with strictCallSettings().
    const agency = await prisma.organization.create({ data: { type: "AGENCY", name: "Agency HQ", slug: `agency-${Date.now()}`, settings: PERMISSIVE_SETTINGS } });
    const otherAgency = await prisma.organization.create({ data: { type: "AGENCY", name: "Other Agency", slug: `other-${Date.now()}` } });
    const merchantA = await prisma.organization.create({ data: { type: "MERCHANT", name: "Merchant A", slug: `ma-${Date.now()}` } });
    const merchantB = await prisma.organization.create({ data: { type: "MERCHANT", name: "Merchant B", slug: `mb-${Date.now()}` } });
    const saas = await prisma.organization.create({ data: { type: "MERCHANT", name: "SaaS", slug: `saas-${Date.now()}` } });
    await prisma.serviceContract.createMany({
      data: [
        { agencyId: agency.id, merchantId: merchantA.id, package: "FULL_COD_OPS", pricingModel: "PER_DELIVERED", unitPrice: 250, status: "ACTIVE", startsAt: new Date() },
        { agencyId: agency.id, merchantId: merchantB.id, package: "CONFIRMATION", pricingModel: "PER_CONFIRMED", unitPrice: 100, status: "ACTIVE", startsAt: new Date() },
      ],
    });
    const pod1 = await prisma.pod.create({ data: { orgId: agency.id, name: "Pod 1", merchants: { create: [{ merchantId: merchantA.id }] } } });
    const pod2 = await prisma.pod.create({ data: { orgId: agency.id, name: "Pod 2", merchants: { create: [{ merchantId: merchantB.id }] } } });

    const mk = async (key: string, orgId: string, role: "ORG_OWNER" | "SUPERVISOR" | "CONFIRMATION_AGENT" | "FOLLOWUP_AGENT" | "WAREHOUSE" | "CLIENT_VIEWER", podId?: string, platformAdmin = false) => {
      const email = `${key}-${Date.now()}@test.local`;
      const u = await prisma.user.create({ data: { email, name: key, passwordHash, isPlatformAdmin: platformAdmin, memberships: { create: { orgId, role, podId } } } });
      return { id: u.id, email };
    };
    const users = {
      admin: await mk("admin", agency.id, "ORG_OWNER", undefined, true),
      supervisor: await mk("supervisor", agency.id, "SUPERVISOR"),
      agentA1: await mk("agentA1", agency.id, "CONFIRMATION_AGENT", pod1.id),
      agentA2: await mk("agentA2", agency.id, "CONFIRMATION_AGENT", pod1.id),
      followupA: await mk("followupA", agency.id, "FOLLOWUP_AGENT", pod1.id),
      agentB1: await mk("agentB1", agency.id, "CONFIRMATION_AGENT", pod2.id),
      followupB: await mk("followupB", agency.id, "FOLLOWUP_AGENT", pod2.id),
      warehouse: await mk("warehouse", agency.id, "WAREHOUSE"),
      clientA: await mk("clientA", merchantA.id, "CLIENT_VIEWER"),
      otherSupervisor: await mk("otherSupervisor", otherAgency.id, "SUPERVISOR"),
      saasOwner: await mk("saasOwner", saas.id, "ORG_OWNER"),
    };
    await prisma.pod.update({ where: { id: pod1.id }, data: { followUpUserId: users.followupA.id } });
    await prisma.pod.update({ where: { id: pod2.id }, data: { followUpUserId: users.followupB.id } });

    const storeA = await prisma.store.create({ data: { merchantId: merchantA.id, name: "Store A", channel: "SHOPIFY" } });
    const storeB = await prisma.store.create({ data: { merchantId: merchantB.id, name: "Store B", channel: "DZBUILD" } });
    const storeS = await prisma.store.create({ data: { merchantId: saas.id, name: "Store S", channel: "MANUAL" } });
    const productA = await prisma.product.create({ data: { merchantId: merchantA.id, name: "Abaya", price: 6500, variants: { create: [{ name: "M" }] } }, include: { variants: true } });
    const productB = await prisma.product.create({ data: { merchantId: merchantB.id, name: "Hachoir", price: 5900 } });
    const productS = await prisma.product.create({ data: { merchantId: saas.id, name: "Support", price: 1900 } });
    const whA = await prisma.warehouse.create({ data: { merchantId: merchantA.id, name: "WH A", wilayaCode: 16 } });
    await prisma.stockItem.create({ data: { warehouseId: whA.id, productId: productA.id, variantId: productA.variants[0]!.id, onHand: 10 } });

    await prisma.apiKey.createMany({
      data: [
        { orgId: agency.id, name: "agency", keyId: "ck_test_agency", secretHash: sha256Hex("agency-secret"), scopes: ["orders:read", "orders:write"] },
        { orgId: merchantB.id, name: "merchantB", keyId: "ck_test_mb", secretHash: sha256Hex("mb-secret"), scopes: ["orders:read"] },
        { orgId: saas.id, name: "saas", keyId: "ck_test_saas", secretHash: sha256Hex("saas-secret"), scopes: ["products:read"] },
      ],
    });

    const ctxOf = async (id: string) => {
      const c = await resolveTenantContext(id);
      if (!c) throw new Error("no ctx");
      return c;
    };
    const ctx = Object.fromEntries(await Promise.all(Object.entries(users).map(async ([k, u]) => [k, await ctxOf(u.id)]))) as World["ctx"];

    return {
      agency: { id: agency.id },
      otherAgency: { id: otherAgency.id },
      merchantA: { id: merchantA.id, storeId: storeA.id, productId: productA.id, variantId: productA.variants[0]?.id ?? null },
      merchantB: { id: merchantB.id, storeId: storeB.id, productId: productB.id },
      saas: { id: saas.id, storeId: storeS.id, productId: productS.id },
      users,
      ctx,
      pods: { pod1: pod1.id, pod2: pod2.id },
      apiKeys: { agency: "ck_test_agency.agency-secret", merchantB: "ck_test_mb.mb-secret", saas: "ck_test_saas.saas-secret" },
    };
  });
}

let phoneCounter = 10_000_000;
export function nextPhone(): string {
  phoneCounter += 1;
  return `05${phoneCounter}`;
}

export async function newOrder(w: World, merchant: "A" | "B" | "S", overrides: Partial<Parameters<typeof createOrder>[1]> = {}) {
  const m = merchant === "A" ? w.merchantA : merchant === "B" ? w.merchantB : w.saas;
  return createOrder(SYSTEM, {
    merchantId: m.id,
    storeId: m.storeId,
    customer: { name: "Test Client", phone: nextPhone() },
    wilaya: 16,
    address: "Cité 200 logements, Bt C n°12",
    items: [{ productId: m.productId, variantId: merchant === "A" ? w.merchantA.variantId : null, qty: 1 }],
    shippingFee: 500,
    skipDuplicateCheck: true,
    ...overrides,
  });
}

export const CHECKLIST = { productExplained: true, totalStated: true, addressVerified: true, variantVerified: true, explicitYes: true } as const;
