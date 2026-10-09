import type { OrderStatus, StatusGroup } from "@prisma/client";

/**
 * Status dictionary (section 7.1). Codes are fixed; labels are the UI strings.
 * Merchants may override labels through StatusLabelOverride (see statusLabel()).
 */
export type SetBy = "SYSTEM" | "AGENT" | "SUPERVISOR" | "WAREHOUSE" | "COURIER" | "FINANCE";

export interface StatusMeta {
  code: OrderStatus;
  group: StatusGroup;
  fr: string;
  ar: string;
  setBy: SetBy[];
  /** no further work expected on the order in this group */
  terminal?: boolean;
  /** tailwind color token used by <StatusBadge> */
  tone: "neutral" | "info" | "warning" | "success" | "danger" | "violet";
}

export const STATUS_META: Record<OrderStatus, StatusMeta> = {
  // ── confirmation ──
  NOUVEAU: { code: "NOUVEAU", group: "CONFIRMATION", fr: "Nouveau", ar: "جديدة", setBy: ["SYSTEM"], tone: "neutral" },
  ASSIGNEE: { code: "ASSIGNEE", group: "CONFIRMATION", fr: "Assignée", ar: "معينة", setBy: ["SYSTEM"], tone: "info" },
  EN_COURS_CONFIRMATION: { code: "EN_COURS_CONFIRMATION", group: "CONFIRMATION", fr: "En cours de confirmation", ar: "قيد التأكيد", setBy: ["SYSTEM"], tone: "info" },
  APPEL_1: { code: "APPEL_1", group: "CONFIRMATION", fr: "Appel 1", ar: "مكالمة 1", setBy: ["AGENT"], tone: "info" },
  APPEL_2: { code: "APPEL_2", group: "CONFIRMATION", fr: "Appel 2", ar: "مكالمة 2", setBy: ["AGENT"], tone: "info" },
  APPEL_3: { code: "APPEL_3", group: "CONFIRMATION", fr: "Appel 3", ar: "مكالمة 3", setBy: ["AGENT"], tone: "info" },
  REPORTE: { code: "REPORTE", group: "CONFIRMATION", fr: "Reporté non confirmé", ar: "مؤجلة قبل التأكيد", setBy: ["AGENT"], tone: "warning" },
  A_VERIFIER: { code: "A_VERIFIER", group: "CONFIRMATION", fr: "À vérifier", ar: "للتحقق", setBy: ["AGENT", "SYSTEM"], tone: "warning" },
  CONFIRMEE_REPORTEE: { code: "CONFIRMEE_REPORTEE", group: "CONFIRMATION", fr: "Confirmé – Reporté", ar: "مؤكدة مؤجلة", setBy: ["AGENT"], tone: "success" },
  CONFIRMEE: { code: "CONFIRMEE", group: "CONFIRMATION", fr: "Confirmée", ar: "مؤكدة", setBy: ["AGENT", "SYSTEM"], tone: "success" },
  CONFIRMEE_BOT: { code: "CONFIRMEE_BOT", group: "CONFIRMATION", fr: "Confirmée (Bot)", ar: "مؤكَّدة (Bot)", setBy: ["SYSTEM"], tone: "success" },
  CONFIRMEE_RUPTURE: { code: "CONFIRMEE_RUPTURE", group: "CONFIRMATION", fr: "Confirmée Rupture de stock", ar: "مؤكدة بلا مخزون", setBy: ["AGENT"], tone: "warning" },
  ANNULEE: { code: "ANNULEE", group: "CONFIRMATION", fr: "Annulée", ar: "ملغية", setBy: ["AGENT"], terminal: true, tone: "danger" },
  DOUBLE: { code: "DOUBLE", group: "CONFIRMATION", fr: "Double", ar: "مكررة", setBy: ["SYSTEM", "AGENT"], terminal: true, tone: "neutral" },
  FAUSSE_COMMANDE: { code: "FAUSSE_COMMANDE", group: "CONFIRMATION", fr: "Fausse Commande", ar: "طلبية وهمية", setBy: ["SUPERVISOR"], terminal: true, tone: "danger" },
  INJOIGNABLE: { code: "INJOIGNABLE", group: "CONFIRMATION", fr: "Injoignable", ar: "لا يمكن الوصول إليه", setBy: ["SYSTEM"], terminal: true, tone: "neutral" },
  EXPIREE: { code: "EXPIREE", group: "CONFIRMATION", fr: "Expirée", ar: "منتهية", setBy: ["SYSTEM"], terminal: true, tone: "neutral" },
  // ── shipping ──
  EN_PREPARATION: { code: "EN_PREPARATION", group: "SHIPPING", fr: "En préparation", ar: "قيد التحضير", setBy: ["SYSTEM", "WAREHOUSE"], tone: "info" },
  PRET_A_EXPEDIER: { code: "PRET_A_EXPEDIER", group: "SHIPPING", fr: "Prêt à expédier", ar: "جاهزة للشحن", setBy: ["WAREHOUSE"], tone: "info" },
  EXPEDITION_RETARDEE: { code: "EXPEDITION_RETARDEE", group: "SHIPPING", fr: "Expédition retardée", ar: "شحن متأخر", setBy: ["SYSTEM", "SUPERVISOR"], tone: "danger" },
  EXPEDIE: { code: "EXPEDIE", group: "SHIPPING", fr: "Ramassé / En transit", ar: "في الطريق", setBy: ["COURIER", "WAREHOUSE"], tone: "info" },
  // ── delivery ──
  ARRIVE_WILAYA: { code: "ARRIVE_WILAYA", group: "DELIVERY", fr: "Arrivé à la wilaya", ar: "وصلت إلى الولاية", setBy: ["COURIER"], tone: "info" },
  STOP_DESK: { code: "STOP_DESK", group: "DELIVERY", fr: "Au bureau (Stop Desk)", ar: "في المكتب", setBy: ["COURIER"], tone: "info" },
  EN_LIVRAISON: { code: "EN_LIVRAISON", group: "DELIVERY", fr: "Sorti en livraison", ar: "عند الموزع", setBy: ["COURIER"], tone: "info" },
  CLIENT_INJOIGNABLE_LIVREUR: { code: "CLIENT_INJOIGNABLE_LIVREUR", group: "DELIVERY", fr: "Client ne répond pas au livreur", ar: "الزبون لا يرد على الموزع", setBy: ["COURIER"], tone: "warning" },
  STOPDESK_SANS_REPONSE: { code: "STOPDESK_SANS_REPONSE", group: "DELIVERY", fr: "Stop desk – client ne répond pas", ar: "مكتب – الزبون لا يرد", setBy: ["COURIER"], tone: "warning" },
  EXPEDIE_REPORTE: { code: "EXPEDIE_REPORTE", group: "DELIVERY", fr: "Expédié – Reporté (courier)", ar: "شحنة مؤجلة من الشركة", setBy: ["COURIER"], tone: "warning" },
  REPORTE_CLIENT: { code: "REPORTE_CLIENT", group: "DELIVERY", fr: "Reporté par le client", ar: "مؤجلة من طرف الزبون", setBy: ["COURIER"], tone: "warning" },
  ADRESSE_ERRONEE: { code: "ADRESSE_ERRONEE", group: "DELIVERY", fr: "Adresse / numéro erroné", ar: "عنوان أو رقم خاطئ", setBy: ["COURIER"], tone: "warning" },
  TENTATIVE_ECHOUEE: { code: "TENTATIVE_ECHOUEE", group: "DELIVERY", fr: "Tentative échouée", ar: "محاولة فاشلة", setBy: ["COURIER"], tone: "warning" },
  REFUSE: { code: "REFUSE", group: "DELIVERY", fr: "Refusé", ar: "مرفوضة", setBy: ["COURIER"], tone: "danger" },
  ALERTE: { code: "ALERTE", group: "DELIVERY", fr: "Alerte", ar: "تنبيه", setBy: ["COURIER"], tone: "danger" },
  LIVRE: { code: "LIVRE", group: "DELIVERY", fr: "Livré", ar: "تم التوصيل", setBy: ["COURIER", "SYSTEM"], tone: "success" },
  // ── return ──
  RETOUR_EN_COURS: { code: "RETOUR_EN_COURS", group: "RETURN", fr: "Retour en cours", ar: "في طريق الإرجاع", setBy: ["COURIER", "SYSTEM"], tone: "warning" },
  RETOUR_RECU: { code: "RETOUR_RECU", group: "RETURN", fr: "Retour reçu", ar: "مرتجعة مستلمة", setBy: ["WAREHOUSE"], terminal: true, tone: "neutral" },
  PERDU_ENDOMMAGE: { code: "PERDU_ENDOMMAGE", group: "RETURN", fr: "Perdu / Endommagé", ar: "مفقودة / متضررة", setBy: ["SYSTEM", "SUPERVISOR"], terminal: true, tone: "danger" },
  // ── closed ──
  ENCAISSE: { code: "ENCAISSE", group: "CLOSED", fr: "Encaissé", ar: "تم التحصيل", setBy: ["FINANCE"], terminal: true, tone: "violet" },
};

export const ALL_STATUSES = Object.keys(STATUS_META) as OrderStatus[];

export const STATUS_GROUPS: StatusGroup[] = ["CONFIRMATION", "SHIPPING", "DELIVERY", "RETURN", "CLOSED"];

export function statusesInGroup(group: StatusGroup): OrderStatus[] {
  return ALL_STATUSES.filter((s) => STATUS_META[s].group === group);
}

export const CONFIRMATION_STATUSES = statusesInGroup("CONFIRMATION");
export const SHIPPING_STATUSES = statusesInGroup("SHIPPING");
export const DELIVERY_STATUSES = statusesInGroup("DELIVERY");
export const RETURN_STATUSES = statusesInGroup("RETURN");
export const CLOSED_STATUSES = statusesInGroup("CLOSED");

/** Statuses where a confirmation agent is still working the order (decision not taken yet). */
export const CONFIRMATION_OPEN_STATUSES: OrderStatus[] = ["ASSIGNEE", "EN_COURS_CONFIRMATION", "APPEL_1", "APPEL_2", "APPEL_3", "REPORTE", "A_VERIFIER"];

/** Statuses an agent can claim (lock) from the queue. */
export const CLAIMABLE_STATUSES: OrderStatus[] = ["ASSIGNEE", "APPEL_1", "APPEL_2", "APPEL_3", "REPORTE", "A_VERIFIER"];

/** Unconfirmed statuses the nightly expiry job may move to EXPIREE. */
export const EXPIRABLE_STATUSES: OrderStatus[] = ["ASSIGNEE", "APPEL_1", "APPEL_2", "APPEL_3", "REPORTE", "A_VERIFIER"];

/** Everything before a confirmation decision (follow-up agents do not see these). */
export const PRE_CONFIRMATION_STATUSES: OrderStatus[] = ["NOUVEAU", ...CONFIRMATION_OPEN_STATUSES, "DOUBLE"];

/** All CONFIRMEE* codes (KPIs: confirmation rate numerator). */
export const CONFIRMED_STATUSES: OrderStatus[] = ["CONFIRMEE", "CONFIRMEE_BOT", "CONFIRMEE_RUPTURE", "CONFIRMEE_REPORTEE"];

/** Confirmed and waiting for the warehouse / courier (stuck-order watchdog, stock reserved). */
export const PRE_SHIPPING_STATUSES: OrderStatus[] = ["CONFIRMEE", "CONFIRMEE_BOT", "EN_PREPARATION", "PRET_A_EXPEDIER", "EXPEDITION_RETARDEE"];

/** Delivery statuses that are "in the courier's hands" and can still move. */
export const IN_TRANSIT_STATUSES: OrderStatus[] = [
  "EXPEDIE",
  "ARRIVE_WILAYA",
  "STOP_DESK",
  "EN_LIVRAISON",
  "CLIENT_INJOIGNABLE_LIVREUR",
  "STOPDESK_SANS_REPONSE",
  "EXPEDIE_REPORTE",
  "REPORTE_CLIENT",
  "ADRESSE_ERRONEE",
  "TENTATIVE_ECHOUEE",
  "ALERTE",
  "REFUSE",
];

/** Courier-reported problems that need a rescue by the follow-up agent (section 10). */
export const DELIVERY_ISSUE_STATUSES: OrderStatus[] = [
  "CLIENT_INJOIGNABLE_LIVREUR",
  "STOPDESK_SANS_REPONSE",
  "REPORTE_CLIENT",
  "ADRESSE_ERRONEE",
  "TENTATIVE_ECHOUEE",
  "REFUSE",
  "ALERTE",
];

export const RETURNED_STATUSES: OrderStatus[] = ["RETOUR_EN_COURS", "RETOUR_RECU"];
export const DELIVERED_STATUSES: OrderStatus[] = ["LIVRE", "ENCAISSE"];
/** Parcels whose final outcome is known. Delivery rate uses these only. */
export const FINISHED_PARCEL_STATUSES: OrderStatus[] = [...DELIVERED_STATUSES, ...RETURNED_STATUSES];

/** Not billed, excluded from confirmation-rate denominator. */
export const EXCLUDED_FROM_KPI_STATUSES: OrderStatus[] = ["DOUBLE", "FAUSSE_COMMANDE"];

export function statusGroupOf(status: OrderStatus): StatusGroup {
  return STATUS_META[status].group;
}

export function isTerminalStatus(status: OrderStatus): boolean {
  return STATUS_META[status].terminal === true;
}

export function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === "string" && value in STATUS_META;
}

export type LabelOverrides = Partial<Record<OrderStatus, { labelFr?: string | null; labelAr?: string | null }>>;

export function statusLabel(status: OrderStatus, locale: string, overrides?: LabelOverrides): string {
  const meta = STATUS_META[status];
  const ar = locale.startsWith("ar");
  const o = overrides?.[status];
  if (o) {
    const custom = ar ? o.labelAr : o.labelFr;
    if (custom) return custom;
  }
  return ar ? meta.ar : meta.fr;
}

export function groupLabel(group: StatusGroup, locale: string): string {
  const ar = locale.startsWith("ar");
  const labels: Record<StatusGroup, [string, string]> = {
    CONFIRMATION: ["Confirmation", "التأكيد"],
    SHIPPING: ["Expédition", "الشحن"],
    DELIVERY: ["Livraison", "التوصيل"],
    RETURN: ["Retour", "الإرجاع"],
    CLOSED: ["Clôturé", "مغلقة"],
  };
  return labels[group][ar ? 1 : 0];
}

/** Reason code dictionaries (section 7.2). */
export const CANCEL_REASON_LABELS = {
  CHANGED_MIND: { fr: "A changé d'avis", ar: "غيّر رأيه" },
  PRICE_TOO_HIGH: { fr: "Prix trop élevé", ar: "السعر مرتفع" },
  SHIPPING_FEE: { fr: "Frais de livraison", ar: "تكلفة التوصيل" },
  BOUGHT_ELSEWHERE: { fr: "Acheté ailleurs", ar: "اشترى من مكان آخر" },
  PRODUCT_DOUBT: { fr: "Doute sur le produit", ar: "شك في المنتج" },
  WRONG_PRODUCT_OR_SIZE: { fr: "Mauvais produit / taille", ar: "منتج أو مقاس خاطئ" },
  DELIVERY_TOO_SLOW: { fr: "Livraison trop lente", ar: "التوصيل بطيء" },
  DID_NOT_ORDER: { fr: "N'a pas commandé", ar: "لم يطلب" },
  CANCELLED_BY_CUSTOMER: { fr: "Annulé par le client", ar: "ألغاها الزبون" },
  WRONG_INFORMATION: { fr: "Informations erronées", ar: "معلومات خاطئة" },
  NO_LONGER_INTERESTED: { fr: "Plus intéressé", ar: "لم يعد مهتما" },
  CUSTOMER_ABSENT: { fr: "Client absent", ar: "الزبون غائب" },
  OTHER: { fr: "Autre", ar: "أخرى" },
} as const;

export const FAKE_REASON_LABELS = {
  INVALID_PHONE: { fr: "Numéro invalide", ar: "رقم غير صالح" },
  NAME_NONSENSE: { fr: "Nom fantaisiste", ar: "اسم غير منطقي" },
  DID_NOT_ORDER: { fr: "N'a pas commandé", ar: "لم يطلب" },
  PRANK: { fr: "Canular", ar: "مزحة" },
  TEST_ORDER: { fr: "Commande test", ar: "طلبية تجريبية" },
  COMPETITOR: { fr: "Concurrent", ar: "منافس" },
  REPEAT_REFUSER: { fr: "Refus répétés", ar: "رفض متكرر" },
  OTHER: { fr: "Autre", ar: "أخرى" },
} as const;

/** Fake reasons clear enough to skip the "enough spaced attempts" rule (section 19c.1). */
export const CLEAR_FAKE_REASONS = ["INVALID_PHONE", "TEST_ORDER"] as const;

export const RETURN_REASON_LABELS = {
  PRICE_SHOCK: { fr: "Choc du prix", ar: "صدمة السعر" },
  NOT_AS_EXPECTED: { fr: "Pas conforme aux attentes", ar: "ليس كما توقع" },
  BOUGHT_ELSEWHERE: { fr: "Acheté ailleurs", ar: "اشترى من مكان آخر" },
  CLIENT_UNREACHABLE: { fr: "Client injoignable", ar: "الزبون لا يرد" },
  WRONG_ADDRESS: { fr: "Adresse erronée", ar: "عنوان خاطئ" },
  DELIVERY_DELAY: { fr: "Retard de livraison", ar: "تأخر التوصيل" },
  FAKE_CONFIRMATION: { fr: "Fausse confirmation", ar: "تأكيد وهمي" },
  CLIENT_ABSENT: { fr: "Client absent", ar: "الزبون غائب" },
  DAMAGED: { fr: "Endommagé", ar: "متضرر" },
  OTHER: { fr: "Autre", ar: "أخرى" },
} as const;
