import { prisma } from "@/lib/db";
import { apiHandler } from "@/lib/api/handler";

export const GET = apiHandler({}, async ({ key }) => {
  const [org, apiKey, merchants] = await Promise.all([
    prisma.organization.findUnique({ where: { id: key.orgId }, select: { id: true, name: true, type: true, timezone: true } }),
    prisma.apiKey.findUnique({ where: { keyId: key.keyId, orgId: key.orgId }, select: { name: true, createdAt: true, lastUsedAt: true } }),
    prisma.organization.findMany({ where: { id: { in: key.accessibleMerchantIds } }, select: { id: true, name: true } }),
  ]);
  return {
    data: {
      org,
      key: { key_id: key.keyId, name: apiKey?.name ?? null, scopes: key.scopes, created_at: apiKey?.createdAt ?? null },
      accessible_merchants: merchants,
    },
  };
});
