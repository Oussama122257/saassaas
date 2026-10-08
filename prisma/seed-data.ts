/** Static demo content used by prisma/seed.ts. */
export const FIRST_NAMES = ["Mohamed", "Amine", "Yacine", "Karim", "Sofiane", "Rachid", "Nassim", "Walid", "Bilal", "Hamza", "Fatima", "Amina", "Sarah", "Lina", "Yasmine", "Khadidja", "Meriem", "Nour", "Imane", "Rania", "Samira", "Houda", "Asma", "Zineb"];
export const LAST_NAMES = ["Benali", "Boudiaf", "Haddad", "Cherif", "Mansouri", "Bouzid", "Saidi", "Belkacem", "Hamidi", "Ziani", "Khelifi", "Meziane", "Rahmani", "Brahimi", "Touati", "Djaballah", "Lakhdari", "Bensalem", "Ferhat", "Guerroudj"];

/** wilaya code → weight (orders concentrate in the north) */
export const WILAYA_WEIGHTS: Array<[number, number]> = [
  [16, 22], [31, 10], [25, 6], [9, 6], [19, 5], [35, 5], [6, 4], [15, 4], [23, 4], [13, 3], [42, 3], [26, 2], [10, 2],
  [2, 2], [21, 2], [5, 2], [7, 2], [30, 2], [39, 2], [17, 1], [27, 1], [28, 1], [34, 1], [44, 1], [47, 1], [12, 1], [43, 1], [22, 1], [3, 1], [1, 1],
];

export const COMMUNES: Record<number, string[]> = {
  16: ["Bab Ezzouar", "Hydra", "Kouba", "Bir Mourad Raïs", "El Harrach", "Birkhadem", "Dar El Beïda", "Draria"],
  31: ["Oran", "Bir El Djir", "Es Senia", "Arzew"],
  25: ["Constantine", "El Khroub", "Ali Mendjeli"],
  9: ["Blida", "Boufarik", "Ouled Yaïch"],
  19: ["Sétif", "El Eulma"],
  35: ["Boumerdès", "Boudouaou", "Bordj Menaïel"],
  6: ["Béjaïa", "Akbou"],
  15: ["Tizi Ouzou", "Azazga"],
  23: ["Annaba", "El Bouni"],
  13: ["Tlemcen", "Maghnia"],
};

export const LANDMARKS = ["à côté de la mosquée", "en face de la pharmacie", "près du lycée", "derrière la poste", "à côté du marché", "près de l'arrêt de bus", "immeuble bleu, 2e étage", "en face du stade"];

export interface ProductSeed {
  key: string;
  sku: string;
  name: string;
  price: number;
  costPrice: number;
  variants?: string[];
  sheet: {
    sellingPoints: string[];
    sizeGuide?: string;
    faq: Array<{ q: string; a: string; lang: "fr" | "ar" }>;
    scriptAr: string;
    scriptFr: string;
  };
}

export const PRODUCTS: Record<"storeA" | "storeB" | "saas", ProductSeed[]> = {
  storeA: [
    {
      key: "serum",
      sku: "COS-SERUM-30",
      name: "Sérum Vitamine C 30 ml",
      price: 3900,
      costPrice: 1400,
      sheet: {
        sellingPoints: ["Peau plus lumineuse en 2 semaines", "Sans parfum, convient aux peaux sensibles", "Flacon 30 ml = 2 mois d'utilisation"],
        faq: [
          { q: "Est-ce que ça convient aux peaux grasses ?", a: "Oui, texture légère non grasse.", lang: "fr" },
          { q: "واش يصلح للبشرة الحساسة؟", a: "إيه، بلا عطر ومجرّب على البشرة الحساسة.", lang: "ar" },
        ],
        scriptAr: "السلام عليكم، معاك [الوكيل] من [المتجر]. راني نعيطلك على خاطر طلبت سيروم فيتامين سي 30 مل. السيروم يعطي إشراقة للبشرة في جوج سيمانات وبلا عطر. السعر [المجموع] مع التوصيل لـ[الولاية]. نأكدو الطلبية؟",
        scriptFr: "Bonjour, [Agent] de [Boutique]. Je vous appelle pour votre commande de Sérum Vitamine C 30 ml. Le total est de [Total] livraison comprise à [Wilaya]. Je confirme ?",
      },
    },
    {
      key: "abaya",
      sku: "CLO-ABAYA",
      name: "Abaya brodée collection Ramadan",
      price: 6500,
      costPrice: 2800,
      variants: ["S", "M", "L", "XL"],
      sheet: {
        sellingPoints: ["Tissu crêpe de Dubaï qui ne se froisse pas", "Broderie main sur les manches", "Coupe ample et longue"],
        sizeGuide: "S: 1,55–1,62 m · M: 1,62–1,68 m · L: 1,68–1,74 m · XL: 1,74–1,80 m",
        faq: [
          { q: "Quelle taille pour 1,65 m ?", a: "La taille M.", lang: "fr" },
          { q: "واش يتغسل في الماشينة؟", a: "إيه، غسيل بارد وبلا سشوار.", lang: "ar" },
        ],
        scriptAr: "السلام عليكم، معاك [الوكيل] من [المتجر]. طلبتي العباية المطرزة. نأكدو الطول باش نختارو المقاس الصحيح: شحال طولك؟ السعر [المجموع] مع التوصيل. نأكدو؟",
        scriptFr: "Bonjour, [Agent] de [Boutique]. Pour votre abaya brodée, je vérifie la taille avec vous. Le total est [Total] livraison comprise. Je confirme ?",
      },
    },
    {
      key: "earbuds",
      sku: "ELC-BUDS-PRO",
      name: "Écouteurs sans fil Buds Pro",
      price: 4500,
      costPrice: 1900,
      variants: ["Noir", "Blanc"],
      sheet: {
        sellingPoints: ["Réduction de bruit active", "24 h d'autonomie avec le boîtier", "Garantie 6 mois"],
        faq: [{ q: "Compatible iPhone ?", a: "Oui, Bluetooth 5.3 compatible iOS et Android.", lang: "fr" }],
        scriptAr: "السلام عليكم، معاك [الوكيل] من [المتجر]. طلبت السماعات Buds Pro، اللون [المتغير]. فيها عزل الضجيج وضمان 6 أشهر. السعر [المجموع] مع التوصيل. نأكدو؟",
        scriptFr: "Bonjour, [Agent] de [Boutique]. Vos écouteurs Buds Pro en [Variante], garantie 6 mois. Total [Total] livraison comprise. Je confirme ?",
      },
    },
  ],
  storeB: [
    {
      key: "chopper",
      sku: "KIT-CHOP-3L",
      name: "Hachoir électrique 3 L",
      price: 5900,
      costPrice: 2600,
      sheet: {
        sellingPoints: ["Bol en verre 3 L", "4 lames inox", "Moteur 500 W garanti 1 an"],
        faq: [{ q: "واش يقطع اللحم؟", a: "إيه، اللحم والخضرة والبصل.", lang: "ar" }],
        scriptAr: "السلام عليكم، معاك [الوكيل] من [المتجر]. طلبتي الهاشوار الكهربائي 3 لتر، بالزجاج و4 شفرات. السعر [المجموع] مع التوصيل. نأكدو؟",
        scriptFr: "Bonjour, [Agent] de [Boutique]. Votre hachoir 3 L, bol en verre, garantie 1 an. Total [Total] livraison comprise. Je confirme ?",
      },
    },
    {
      key: "playmat",
      sku: "KID-MAT-XL",
      name: "Tapis d'éveil bébé XL",
      price: 4200,
      costPrice: 1700,
      sheet: {
        sellingPoints: ["Mousse épaisse 1 cm, pliable", "Lavable", "2 faces, 180 × 150 cm"],
        faq: [{ q: "Pour quel âge ?", a: "Dès la naissance jusqu'à 4 ans.", lang: "fr" }],
        scriptAr: "السلام عليكم، معاك [الوكيل] من [المتجر]. طلبتي طابي الأطفال XL، 180 في 150، يتطوى ويتغسل. السعر [المجموع] مع التوصيل. نأكدو؟",
        scriptFr: "Bonjour, [Agent] de [Boutique]. Votre tapis d'éveil XL pliable et lavable. Total [Total] livraison comprise. Je confirme ?",
      },
    },
  ],
  saas: [
    {
      key: "carmount",
      sku: "CAR-MOUNT-MAG",
      name: "Support téléphone voiture magnétique",
      price: 1900,
      costPrice: 600,
      sheet: {
        sellingPoints: ["Aimant puissant, tient sur route", "Rotation 360°", "Pose en 10 secondes sur la grille d'aération"],
        faq: [{ q: "Ça abîme le téléphone ?", a: "Non, plaque fine à coller sur la coque.", lang: "fr" }],
        scriptAr: "السلام عليكم، معاك [الوكيل] من [المتجر]. طلبت سوبور التيليفون المغناطيسي للسيارة. السعر [المجموع] مع التوصيل. نأكدو؟",
        scriptFr: "Bonjour, [Agent] de [Boutique]. Votre support voiture magnétique. Total [Total] livraison comprise. Je confirme ?",
      },
    },
  ],
};

/** Target distribution of the 200 demo orders. */
export const STATUS_DISTRIBUTION: Array<[string, number]> = [
  ["NOUVEAU", 8],
  ["ASSIGNEE", 8],
  ["APPEL_1", 10],
  ["APPEL_2", 8],
  ["APPEL_3", 6],
  ["REPORTE", 8],
  ["A_VERIFIER", 5],
  ["CONFIRMEE", 14],
  ["CONFIRMEE_BOT", 4],
  ["CONFIRMEE_RUPTURE", 3],
  ["ANNULEE", 12],
  ["DOUBLE", 4],
  ["FAUSSE_COMMANDE", 4],
  ["INJOIGNABLE", 6],
  ["PRET_A_EXPEDIER", 8],
  ["EXPEDIE", 10],
  ["ARRIVE_WILAYA", 6],
  ["STOP_DESK", 4],
  ["EN_LIVRAISON", 6],
  ["CLIENT_INJOIGNABLE_LIVREUR", 5],
  ["REPORTE_CLIENT", 3],
  ["ADRESSE_ERRONEE", 3],
  ["TENTATIVE_ECHOUEE", 3],
  ["REFUSE", 4],
  ["ALERTE", 2],
  ["LIVRE", 20],
  ["RETOUR_EN_COURS", 6],
  ["RETOUR_RECU", 8],
  ["PERDU_ENDOMMAGE", 2],
  ["ENCAISSE", 10],
];
