import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { loadOpsContext } from "@/lib/orders/orderTransitions";
import { orderAccessWhere, type TenantContext } from "@/lib/tenant";
import { wilayaName } from "@/lib/wilayas";
import { formatDzd } from "@/lib/utils";
import { blockedReason, planAttempt } from "./slots";

/**
 * Everything the agent call screen (section 8.4) needs, in one read. Only orders the agent may
 * see (orderAccessWhere) are returned.
 */
const include = {
  store: { select: { id: true, name: true, channel: true } },
  merchant: { select: { id: true, name: true, timezone: true } },
  items: { include: { product: { include: { sheet: true, stockItems: { select: { onHand: true, reserved: true, variantId: true } } } }, variant: true } },
  calls: { orderBy: { startedAt: "asc" }, include: { phoneNumber: { select: { label: true } }, agent: { select: { name: true } } } },
  comments: { orderBy: { createdAt: "desc" }, take: 30, include: { author: { select: { name: true } } } },
  unmatchedLines: { where: { resolvedProductId: null } },
  customer: true,
  assignedTo: { select: { id: true, name: true } },
  lockedBy: { select: { id: true, name: true } },
} satisfies Prisma.OrderInclude;

export type CallScreenOrder = Prisma.OrderGetPayload<{ include: typeof include }>;

export function fillScript(script: string, vars: Record<string, string>): string {
  return script
    .replace(/\[المنتج\]|\{product\}|\[produit\]/g, vars.product ?? "")
    .replace(/\[المجموع\]|\{total\}|\[total\]/g, vars.total ?? "")
    .replace(/\[الاسم\]|\{customer_name\}|\[nom\]/g, vars.customer_name ?? "")
    .replace(/\[الولاية\]|\{wilaya\}|\[wilaya\]/g, vars.wilaya ?? "")
    .replace(/\[المتجر\]|\{store_name\}|\[[Bb]outique\]/g, vars.store_name ?? "")
    .replace(/\[الوكيل\]|\[العون\]|\{agent\}|\[[Aa]gent\]/g, vars.agent ?? "")
    .replace(/\[Total\]/g, vars.total ?? "")
    .replace(/\[التوصيل\]|\{shipping_fee\}|\[livraison\]/g, vars.shipping_fee ?? "");
}

export async function getCallScreenData(ctx: TenantContext, orderId: string, now = new Date()) {
  const order = await prisma.order.findFirst({ where: { AND: [{ id: orderId }, orderAccessWhere(ctx)] }, include });
  if (!order) return null;
  const ops = await loadOpsContext(prisma, order);
  const [history, numbers, products] = await Promise.all([
    prisma.order.findMany({
      where: { merchantId: order.merchantId, customerPhone: order.customerPhone, id: { not: order.id } },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, seq: true, status: true, total: true, createdAt: true, store: { select: { name: true } } },
    }),
    ops.teamOrgId
      ? prisma.outboundNumber.findMany({ where: { orgId: ops.teamOrgId, active: true, burnedAt: null }, orderBy: { label: "asc" }, select: { id: true, label: true, msisdn: true } })
      : Promise.resolve([]),
    prisma.product.findMany({ where: { merchantId: order.merchantId, active: true }, orderBy: { name: "asc" }, select: { id: true, name: true, price: true, variants: { select: { id: true, name: true, price: true } } } }),
  ]);
  const roundCalls = order.calls.filter((c) => c.round === order.recycleRound);
  const lastNumber = [...order.calls].reverse().find((c) => c.phoneNumberId)?.phoneNumberId;
  const idx = numbers.findIndex((n) => n.id === lastNumber);
  const nextNumber = numbers.length ? numbers[(idx + 1) % numbers.length] : null;
  const blocked = blockedReason(now, ops.settings.calls, ops.timezone);
  const nextAllowedAt = order.attemptCount < ops.settings.calls.maxAttemptsPerRound
    ? planAttempt({ attemptNo: order.attemptCount + 1, previous: roundCalls.map((c) => c.startedAt), orderCreatedAt: order.createdAt, cfg: ops.settings.calls, tz: ops.timezone, notBefore: now })
    : null;

  const locale = ctx.locale;
  const vars = {
    product: order.items.map((i) => `${i.product.name}${i.variant ? ` (${i.variant.name})` : ""}${i.qty > 1 ? ` ×${i.qty}` : ""}`).join("، "),
    total: formatDzd(order.total, "ar"),
    customer_name: order.customerName ?? "",
    wilaya: wilayaName(order.wilayaCode, "ar"),
    store_name: order.store.name,
    shipping_fee: formatDzd(order.shippingFee, "ar"),
    agent: ctx.userName.split(" ")[0] ?? ctx.userName,
  };
  const varsFr = { ...vars, total: formatDzd(order.total, "fr"), wilaya: wilayaName(order.wilayaCode, "fr"), shipping_fee: formatDzd(order.shippingFee, "fr") };
  const sheets = order.items
    .filter((i) => i.product.sheet)
    .map((i) => ({
      productId: i.productId,
      productName: i.product.name,
      sellingPoints: i.product.sheet!.sellingPoints,
      sizeGuide: i.product.sheet!.sizeGuide,
      faq: (i.product.sheet!.faq as Array<{ q: string; a: string; lang?: string }>) ?? [],
      scriptAr: fillScript(i.product.sheet!.scriptAr, vars),
      scriptFr: i.product.sheet!.scriptFr ? fillScript(i.product.sheet!.scriptFr, varsFr) : null,
      approved: !!i.product.sheet!.approvedByMerchantAt,
    }));
  const stockAvailable = order.items.reduce((acc, i) => {
    const rows = i.product.stockItems.filter((s) => (i.variantId ? s.variantId === i.variantId : true));
    return acc + rows.reduce((a, s) => a + s.onHand - s.reserved, 0);
  }, 0);

  return {
    order,
    history,
    numbers,
    nextNumber,
    products,
    sheets,
    stockAvailable,
    blocked,
    nextAllowedAt,
    settings: { maxAttempts: ops.settings.calls.maxAttemptsPerRound, lockTimeoutMin: ops.settings.lifecycle.lockTimeoutMin, mandatoryCancelNote: ops.settings.mandatoryCancelNote, confirmedPostponeMaxDays: ops.settings.lifecycle.confirmedPostponeMaxDays },
    timezone: ops.timezone,
    locale,
  };
}

export type CallScreenData = NonNullable<Awaited<ReturnType<typeof getCallScreenData>>>;
