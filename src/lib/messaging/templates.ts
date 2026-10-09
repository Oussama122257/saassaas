/**
 * Default message templates (section 11). Merchants override them per language and channel in
 * MessageTemplate; WhatsApp business-initiated messages need an approved template on Meta's side,
 * whose name / language / positional variables are listed in `wa`.
 */
export const TEMPLATE_KEYS = [
  "missed_call_1",
  "written_confirmation",
  "bot_confirm_request",
  "shipped",
  "arrived_wilaya",
  "stopdesk_info",
  "delivery_day_amount",
  "courier_trying_to_reach_you",
  "injoignable_final",
  "did_you_receive",
] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

export const TEMPLATE_VARIABLES = ["customer_name", "product", "total", "wilaya", "courier_phone", "store_name", "tracking_url", "desk_address", "agent_name"] as const;

export interface DefaultTemplate {
  fr: string;
  ar: string;
  /** positional body parameters of the approved WhatsApp template */
  waParams: Array<(typeof TEMPLATE_VARIABLES)[number]>;
  /** quick-reply button payload prefix (bot confirmation) */
  quickReply?: string;
  /** SMS fallback when WhatsApp fails */
  smsFallback: boolean;
}

export const DEFAULT_TEMPLATES: Record<TemplateKey, DefaultTemplate> = {
  missed_call_1: {
    fr: "Bonjour {customer_name}, nous avons essayé de vous appeler pour confirmer votre commande {product} chez {store_name}. Nous vous rappelons bientôt.",
    ar: "السلام عليكم {customer_name}، حاولنا الاتصال بك لتأكيد طلبيتك {product} من {store_name}. سنعاود الاتصال بك قريباً.",
    waParams: ["customer_name", "product", "store_name"],
    smsFallback: true,
  },
  written_confirmation: {
    fr: "Merci {customer_name} ! Votre commande {product} est confirmée. Total à payer à la livraison : {total}. Suivi : {tracking_url}",
    ar: "شكراً {customer_name}! تم تأكيد طلبيتك {product}. المبلغ عند الاستلام: {total}. التتبع: {tracking_url}",
    waParams: ["customer_name", "product", "total"],
    smsFallback: false,
  },
  bot_confirm_request: {
    fr: "Bonjour {customer_name}, confirmez-vous votre commande {product} ({total}, livraison à {wilaya}) ? Appuyez sur « Je confirme ».",
    ar: "السلام عليكم {customer_name}، هل تؤكد طلبيتك {product} ({total}، التوصيل إلى {wilaya})؟ اضغط «نأكد».",
    waParams: ["customer_name", "product", "total", "wilaya"],
    quickReply: "CONFIRM",
    smsFallback: false,
  },
  shipped: {
    fr: "Votre commande {product} a été expédiée. Préparez {total}. Suivi : {tracking_url}",
    ar: "تم شحن طلبيتك {product}. حضّر {total}. التتبع: {tracking_url}",
    waParams: ["product", "total"],
    smsFallback: true,
  },
  arrived_wilaya: {
    fr: "Votre commande est arrivée à {wilaya}. Gardez votre téléphone allumé, le livreur va vous appeler.",
    ar: "وصلت طلبيتك إلى {wilaya}. خلي تيليفونك مشعول، الموزع راح يعيطلك.",
    waParams: ["wilaya"],
    smsFallback: true,
  },
  stopdesk_info: {
    fr: "Votre colis vous attend au bureau : {desk_address}. Montant : {total}. Merci de le récupérer rapidement.",
    ar: "طردك في انتظارك في المكتب: {desk_address}. المبلغ: {total}. يرجى استلامه في أقرب وقت.",
    waParams: ["desk_address", "total"],
    smsFallback: true,
  },
  delivery_day_amount: {
    fr: "Bonjour {customer_name}, votre commande arrive aujourd'hui. Préparez exactement {total}.",
    ar: "صباح الخير {customer_name}، طلبيتك توصلك اليوم. حضّر المبلغ {total}.",
    waParams: ["customer_name", "total"],
    smsFallback: true,
  },
  courier_trying_to_reach_you: {
    fr: "Le livreur essaie de vous joindre pour votre commande {product}. Son numéro : {courier_phone}.",
    ar: "الموزع يحاول الاتصال بك من أجل طلبيتك {product}. رقمه: {courier_phone}.",
    waParams: ["product", "courier_phone"],
    smsFallback: true,
  },
  injoignable_final: {
    fr: "Bonjour {customer_name}, nous n'avons pas pu vous joindre pour votre commande {product}. Répondez à ce message si vous la voulez toujours.",
    ar: "السلام عليكم {customer_name}، لم نتمكن من الاتصال بك بخصوص طلبيتك {product}. رد على هذه الرسالة إذا كنت ما زلت تريدها.",
    waParams: ["customer_name", "product"],
    smsFallback: true,
  },
  did_you_receive: {
    fr: "Avez-vous bien reçu votre commande {product} ? Donnez-nous votre avis : {tracking_url}",
    ar: "هل استلمت طلبيتك {product}؟ شاركنا رأيك: {tracking_url}",
    waParams: ["product"],
    smsFallback: false,
  },
};

export function isTemplateKey(v: string): v is TemplateKey {
  return (TEMPLATE_KEYS as readonly string[]).includes(v);
}

/** Replace {variables}; unknown variables become empty strings. */
export function renderTemplate(body: string, vars: Record<string, string | undefined>): string {
  return body.replace(/\{([a-z_]+)\}/g, (_, k: string) => vars[k] ?? "").replace(/\s{2,}/g, " ").trim();
}
