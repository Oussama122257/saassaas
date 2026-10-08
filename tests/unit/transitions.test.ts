import { describe, expect, it } from "vitest";
import { ALL_STATUSES } from "@/lib/orders/statuses";
import { TRANSITIONS, allowedTargets, attemptDayOf, findRuleForActor, findRules, isTransitionDefined, nextAttemptStatus, ruleAllowsActor } from "@/lib/orders/transitions";

describe("transition table", () => {
  it("every status except NOUVEAU is reachable and every non-terminal status has an exit", () => {
    const targets = new Set(TRANSITIONS.flatMap((r) => [...r.to]));
    for (const s of ALL_STATUSES) if (s !== "NOUVEAU") expect(targets.has(s), `${s} unreachable`).toBe(true);
    const sources = new Set(TRANSITIONS.flatMap((r) => [...r.from]));
    for (const s of ["NOUVEAU", "ASSIGNEE", "APPEL_1", "CONFIRMEE", "PRET_A_EXPEDIER", "EXPEDIE", "EN_LIVRAISON", "REFUSE", "RETOUR_EN_COURS", "LIVRE"] as const) {
      expect(sources.has(s), `${s} has no exit`).toBe(true);
    }
  });

  it("rejects transitions that are not in the table", () => {
    expect(isTransitionDefined("NOUVEAU", "LIVRE")).toBe(false);
    expect(isTransitionDefined("ANNULEE", "CONFIRMEE")).toBe(false);
    expect(isTransitionDefined("LIVRE", "EXPEDIE")).toBe(false);
    expect(isTransitionDefined("APPEL_1", "CONFIRMEE")).toBe(true);
    expect(isTransitionDefined("LIVRE", "ENCAISSE")).toBe(true);
  });

  it("INJOIGNABLE can only be set by the system from APPEL_3", () => {
    const rules = findRules("APPEL_3", "INJOIGNABLE");
    expect(rules).toHaveLength(1);
    expect(rules[0]!.actors).toEqual(["SYSTEM"]);
    expect(rules[0]!.requires).toContainEqual({ kind: "ATTEMPT_COUNT_EQUALS", value: 9 });
    for (const role of ["CONFIRMATION_AGENT", "FOLLOWUP_AGENT", "SUPERVISOR", "ORG_OWNER", "PLATFORM_ADMIN", "WAREHOUSE"] as const) {
      expect(findRuleForActor("APPEL_3", "INJOIGNABLE", role)).toBeUndefined();
    }
    expect(findRules("APPEL_1", "INJOIGNABLE")).toHaveLength(0);
  });

  it("FAUSSE_COMMANDE is finalized by supervisors only", () => {
    expect(findRuleForActor("APPEL_1", "FAUSSE_COMMANDE", "CONFIRMATION_AGENT")).toBeUndefined();
    expect(findRuleForActor("APPEL_1", "FAUSSE_COMMANDE", "SUPERVISOR")?.id).toBe("FAKE_ORDER");
  });

  it("platform admins never impersonate the system", () => {
    const sysOnly = TRANSITIONS.find((r) => r.id === "COURIER_SYNC")!;
    expect(ruleAllowsActor(sysOnly, "PLATFORM_ADMIN")).toBe(false);
    const confirm = TRANSITIONS.find((r) => r.id === "CONFIRM")!;
    expect(ruleAllowsActor(confirm, "PLATFORM_ADMIN")).toBe(true);
  });

  it("confirmation requires the full checklist and an answered call", () => {
    const rule = TRANSITIONS.find((r) => r.id === "CONFIRM")!;
    expect(rule.requires).toContainEqual({ kind: "ANSWERED_CALL" });
    expect(rule.schema.safeParse({ checklist: { productExplained: true, totalStated: true, addressVerified: true, variantVerified: true, explicitYes: false } }).success).toBe(false);
    expect(rule.schema.safeParse({ checklist: { productExplained: true, totalStated: true, addressVerified: true, variantVerified: true, explicitYes: true } }).success).toBe(true);
  });

  it("agents see the expected action menu from APPEL_1", () => {
    const targets = allowedTargets("APPEL_1", "CONFIRMATION_AGENT").map((t) => t.to);
    expect(targets).toEqual(expect.arrayContaining(["APPEL_1", "APPEL_2", "APPEL_3", "CONFIRMEE", "CONFIRMEE_RUPTURE", "ANNULEE", "REPORTE", "A_VERIFIER"]));
    expect(targets).not.toContain("INJOIGNABLE");
    expect(targets).not.toContain("FAUSSE_COMMANDE");
    expect(targets).not.toContain("LIVRE");
  });

  it("derives APPEL_n and the day from the attempt counter", () => {
    expect(nextAttemptStatus(0)).toBe("APPEL_1");
    expect(nextAttemptStatus(2)).toBe("APPEL_3");
    expect(nextAttemptStatus(3)).toBe("APPEL_1");
    expect(nextAttemptStatus(8)).toBe("APPEL_3");
    expect(attemptDayOf(1)).toBe(1);
    expect(attemptDayOf(4)).toBe(2);
    expect(attemptDayOf(9)).toBe(3);
  });
});
