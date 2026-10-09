import { NextResponse, type NextRequest } from "next/server";
import { prisma, withSystemContext } from "@/lib/db";
import { safeEqual, sha256Hex } from "@/lib/crypto";
import { applyMapping, type FieldMapping } from "@/lib/ingest/fieldMapping";
import { ingestOrder, IntakeRateLimitedError } from "@/lib/ingest/pipeline";
import { IntakeRefusedError } from "@/lib/orders/orderTransitions";
import { storeSettings } from "@/lib/stores/service";
import { clientIp } from "@/lib/stores/webhookSecrets";

/**
 * Public landing-form intake (section 19b.4). Accepts JSON or form posts, authenticated with the
 * store intake token. Anti-fraud: max N successful orders per IP in H hours → 429 with a localized
 * "try later" message; blacklisted phones refused or flagged per merchant setting.
 */
const FORM_MAPPING: FieldMapping = {
  externalId: "order_id|external_id",
  customerName: "name|full_name|customer_name|nom|الاسم",
  phone: "phone|telephone|tel|الهاتف",
  phone2: "phone2",
  wilaya: "wilaya|state|الولاية",
  commune: "commune|city|البلدية",
  address: "address|adresse|العنوان",
  deliveryType: "delivery_type|livraison",
  shippingFee: "shipping_fee",
  total: "total",
  note: "note|remarque",
  source: "utm_source|source",
  itemSku: "sku|product_sku",
  itemName: "product|product_name|produit|المنتج",
  itemVariant: "variant|size|taille|color|المقاس",
  itemQty: "qty|quantity|quantite",
  itemPrice: "price|prix",
};

const MESSAGES = {
  rate: { fr: "Trop de commandes depuis cette connexion. Réessayez plus tard.", ar: "طلبات كثيرة من هذا الاتصال. حاول لاحقاً." },
  refused: { fr: "Commande refusée.", ar: "تم رفض الطلب." },
  invalid: { fr: "Commande invalide.", ar: "الطلب غير صالح." },
  ok: { fr: "Merci ! Votre commande est enregistrée, nous vous appelons pour la confirmer.", ar: "شكراً! تم تسجيل طلبك، سنتصل بك للتأكيد." },
};

function cors(res: NextResponse): NextResponse {
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type, X-Intake-Token");
  res.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  return res;
}

export function OPTIONS() {
  return cors(new NextResponse(null, { status: 204 }));
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await params;
  const lang = (req.headers.get("accept-language") ?? "").startsWith("ar") ? "ar" : "fr";
  let body: Record<string, unknown>;
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  else body = Object.fromEntries((await req.formData()).entries()) as Record<string, unknown>;

  const store = await withSystemContext("intake", () => prisma.store.findFirst({ where: { id: storeId, active: true, merchantId: { not: "" } } }));
  const tokenHash = store ? storeSettings(store).intakeToken : undefined;
  const token = req.headers.get("x-intake-token") ?? (typeof body.token === "string" ? body.token : null);
  if (!store || !tokenHash || !token || !safeEqual(sha256Hex(token), tokenHash)) return cors(NextResponse.json({ error: "unauthorized" }, { status: 401 }));

  const mapping = { ...FORM_MAPPING, ...((store.fieldMapping as FieldMapping | null) ?? {}) };
  const mapped = applyMapping(body, mapping);
  try {
    const r = await ingestOrder(store, mapped, { clientIp: clientIp(req), publicIntake: true, source: mapped.source ?? "landing_form" });
    return cors(NextResponse.json({ ok: true, message: MESSAGES.ok[lang], reference: r.order.seq }, { status: r.created ? 201 : 200 }));
  } catch (err) {
    if (err instanceof IntakeRateLimitedError) {
      const res = NextResponse.json({ ok: false, error: "rate_limited", message: MESSAGES.rate[lang], retry_after: err.retryAfterSec }, { status: 429 });
      res.headers.set("Retry-After", String(err.retryAfterSec));
      return cors(res);
    }
    if (err instanceof IntakeRefusedError) return cors(NextResponse.json({ ok: false, error: "refused", message: MESSAGES.refused[lang] }, { status: 422 }));
    return cors(NextResponse.json({ ok: false, error: "invalid", message: MESSAGES.invalid[lang], detail: (err as Error).message }, { status: 422 }));
  }
}
