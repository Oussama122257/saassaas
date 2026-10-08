import { describe, expect, it } from "vitest";
import { TenantGuardError, assertTenantScoped, withSystemContext } from "@/lib/db";

describe("tenant guard (Prisma extension predicate)", () => {
  it("throws on unscoped reads of tenant models", () => {
    expect(() => assertTenantScoped("Order", "findMany", {})).toThrow(TenantGuardError);
    expect(() => assertTenantScoped("Order", "findUnique", { where: { id: "x" } })).toThrow(TenantGuardError);
    expect(() => assertTenantScoped("Customer", "count", { where: { phone: "0550" } })).toThrow(TenantGuardError);
    expect(() => assertTenantScoped("ApiKey", "findMany", { where: { revokedAt: null } })).toThrow(TenantGuardError);
    expect(() => assertTenantScoped("OrderEvent", "findMany", { where: { type: "NOTE" } })).toThrow(TenantGuardError);
  });
  it("accepts direct, compound-unique, AND/OR and relation scoping", () => {
    expect(() => assertTenantScoped("Order", "findMany", { where: { merchantId: "m1" } })).not.toThrow();
    expect(() => assertTenantScoped("Order", "findMany", { where: { merchantId: { in: ["m1", "m2"] } } })).not.toThrow();
    expect(() => assertTenantScoped("Order", "findMany", { where: { merchantId: { in: [] } } })).not.toThrow();
    expect(() => assertTenantScoped("Order", "findFirst", { where: { AND: [{ id: "x" }, { merchantId: { in: ["m1"] } }] } })).not.toThrow();
    expect(() => assertTenantScoped("Order", "findMany", { where: { OR: [{ merchantId: "m1" }, { merchantId: "m2" }] } })).not.toThrow();
    expect(() => assertTenantScoped("Order", "findMany", { where: { OR: [{ merchantId: "m1" }, { status: "LIVRE" }] } })).toThrow(TenantGuardError);
    expect(() => assertTenantScoped("Customer", "upsert", { where: { merchantId_phone: { merchantId: "m1", phone: "0550" } } })).not.toThrow();
    expect(() => assertTenantScoped("ApiKey", "update", { where: { keyId: "k", orgId: "o" } })).not.toThrow();
    expect(() => assertTenantScoped("OrderEvent", "findMany", { where: { orderId: "o1" } })).not.toThrow();
    expect(() => assertTenantScoped("OrderEvent", "findMany", { where: { order: { merchantId: { in: ["m1"] } } } })).not.toThrow();
    expect(() => assertTenantScoped("Task", "count", { where: { doneAt: null, order: { AND: [{ merchantId: { in: ["m1"] } }] } } })).not.toThrow();
  });
  it("ignores non-tenant models and create operations", () => {
    expect(() => assertTenantScoped("User", "findMany", {})).not.toThrow();
    expect(() => assertTenantScoped("Order", "create", { data: {} })).not.toThrow();
    expect(() => assertTenantScoped(undefined, "findMany", {})).not.toThrow();
  });
  it("is disabled inside withSystemContext", async () => {
    await withSystemContext("test", async () => {
      expect(() => assertTenantScoped("Order", "findMany", {})).not.toThrow();
    });
    expect(() => assertTenantScoped("Order", "findMany", {})).toThrow(TenantGuardError);
  });
});
