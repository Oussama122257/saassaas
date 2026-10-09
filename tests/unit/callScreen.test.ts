import { describe, expect, it } from "vitest";
import { fillScript } from "@/lib/calls/callScreen";

describe("script placeholders (section 8.4)", () => {
  it("fills Darija and French placeholders", () => {
    const vars = { product: "عباية", total: "7.000 دج", customer_name: "زينب", wilaya: "الجزائر", store_name: "Store A", shipping_fee: "500 دج", agent: "Amine" };
    expect(fillScript("السلام عليكم، معاك [الوكيل] من [المتجر]. [المنتج] بـ [المجموع]", vars)).toBe("السلام عليكم، معاك Amine من Store A. عباية بـ 7.000 دج");
    expect(fillScript("Bonjour, [Agent] de [Boutique]. Total [Total], {product}", { ...vars, total: "7 000 DA" })).toBe("Bonjour, Amine de Store A. Total 7 000 DA, عباية");
  });
});
