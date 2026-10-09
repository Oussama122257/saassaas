import { describe, expect, it } from "vitest";
import { ALL_STATUSES, CONFIRMATION_STATUSES, FINISHED_PARCEL_STATUSES, STATUS_META, statusGroupOf, statusLabel, statusesInGroup } from "@/lib/orders/statuses";

describe("status dictionary", () => {
  it("has 37 fixed codes with FR and AR labels", () => {
    expect(ALL_STATUSES).toHaveLength(37);
    for (const code of ALL_STATUSES) {
      const m = STATUS_META[code];
      expect(m.code).toBe(code);
      expect(m.fr.length).toBeGreaterThan(0);
      expect(m.ar.length).toBeGreaterThan(0);
    }
  });

  it("groups match the spec", () => {
    expect(statusesInGroup("CONFIRMATION")).toHaveLength(17);
    expect(statusesInGroup("SHIPPING")).toEqual(["EN_PREPARATION", "PRET_A_EXPEDIER", "EXPEDITION_RETARDEE", "EXPEDIE"]);
    expect(statusesInGroup("DELIVERY")).toHaveLength(12);
    expect(STATUS_META.EXPIREE.setBy).toEqual(["SYSTEM"]);
    expect(statusesInGroup("RETURN")).toEqual(["RETOUR_EN_COURS", "RETOUR_RECU", "PERDU_ENDOMMAGE"]);
    expect(statusesInGroup("CLOSED")).toEqual(["ENCAISSE"]);
    expect(statusGroupOf("LIVRE")).toBe("DELIVERY");
    expect(CONFIRMATION_STATUSES).toContain("INJOIGNABLE");
  });

  it("INJOIGNABLE is system-only", () => {
    expect(STATUS_META.INJOIGNABLE.setBy).toEqual(["SYSTEM"]);
  });

  it("finished parcels are delivered or returned only", () => {
    expect(FINISHED_PARCEL_STATUSES.sort()).toEqual(["ENCAISSE", "LIVRE", "RETOUR_EN_COURS", "RETOUR_RECU"].sort());
    expect(FINISHED_PARCEL_STATUSES).not.toContain("EN_LIVRAISON");
  });

  it("labels follow the locale and honour merchant overrides but never codes", () => {
    expect(statusLabel("CONFIRMEE", "fr")).toBe("Confirmée");
    expect(statusLabel("CONFIRMEE", "ar")).toBe("مؤكدة");
    expect(statusLabel("CONFIRMEE", "fr", { CONFIRMEE: { labelFr: "Validée" } })).toBe("Validée");
    expect(statusLabel("CONFIRMEE", "ar", { CONFIRMEE: { labelFr: "Validée" } })).toBe("مؤكدة");
  });
});
